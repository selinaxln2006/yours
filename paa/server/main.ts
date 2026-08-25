// ============================================================
// PAA Console Server — 主客反转架构的服务层（console-v1 路线 2）
// 控制台（console.html）为主体：HTTP 静态 + REST + WS 推送 + chat
// index.html（冻结的生活工作台 PWA）同源提供 → localStorage 一键迁移
// 强约束落实：
//   · 正确 API 分层（静态/数据/对话/迁移四层）
//   · WS 从零实现（core/ws.ts，零 npm 依赖）
//   · risk≥3 写操作经 ctx.ask → WS 确认卡 → 浏览器应答（60s 超时拒）
//   · 数据主权在 Node：浏览器不落 localStorage，全部经 LifeStore
// ============================================================

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { LLMConfig, ChatMessage } from '../core/types.ts';
import { createAdapter } from '../core/llm-adapter.ts';
import { ToolPipeline } from '../core/tool-pipeline.ts';
import { AgentLoop } from '../core/agent-loop.ts';
import { SessionMgr } from '../core/session-mgr.ts';
import { Permission, type AutonomyLevel } from '../core/permission.ts';
import { JsonMemoryProvider, createDefaultPersonaSeed } from '../core/memory-provider.ts';
import { FileArtifactProvider } from '../core/artifact-provider.ts';
import { PkgLoader } from '../core/pkg-loader.ts';
import { LifeStore, LIFE_KEYS, type LifeKey } from '../core/life-store.ts';
import { acceptUpgrade, type WsConnection, type WsMessage } from '../core/ws.ts';
import { createCoreTools } from '../tools/core-tools.ts';
import { createMemoryTools } from '../tools/memory-tools.ts';
import { createArtifactTools } from '../tools/artifact-tools.ts';
import { createPkgTools } from '../tools/pkg-tools.ts';
import { createWebTools } from '../tools/web-tools.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAA_ROOT = path.resolve(__dirname, '..');
const WORKSPACE_ROOT = path.resolve(PAA_ROOT, '..');

// ---- 参数：--port N / PAA_PORT（默认 8765 = 旧 serve.cjs 同源端口） ----
function resolvePort(): number {
  const argv = process.argv;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port' && argv[i + 1]) {
      const n = Number(argv[i + 1]);
      if (n > 0 && n < 65536) return n;
    }
  }
  const env = Number(process.env.PAA_PORT);
  return env > 0 && env < 65536 ? env : 8765;
}
const PORT = resolvePort();
const HOST = '127.0.0.1';

/** 每轮 LLM 往返上限（做大项目；PAA_MAX_ROUNDS 环境变量可调） */
const MAX_ROUNDS = (() => {
  const n = Number(process.env.PAA_MAX_ROUNDS);
  return Number.isInteger(n) && n > 0 && n <= 200 ? n : 24;
})();

const SYSTEM_PROMPT = `你是枢（Shū），俪宁的跨界 AI 搭档，现在运行在生活工作台控制台里。锐利、直接、不谄媚；长内容用分级标题；默认简体中文；不说废话客套。

当前已注册工具（回答"你能做什么/能上网吗"时以此清单为准，逐项如实陈述；不夸大能力，也不自我设限——有 shell 和 web 工具就能联网，不要说"我没有网络"）：
__TOOLS__

能力要点：
- life_* 直接读写生活数据（目标/健身/养生/日程/待办/记账），写入实时推送用户界面；做规划前先 life_query_summary 了解现状
- 重复提醒用 add_schedule 的 rrule/rruleDays：每周一 → rrule:"weekly"+rruleDays:[1]，持续N周传 count:N
- web_fetch / web_search 可直接联网查资料、抓网页、搜 GitHub；web_download 下载文件到沙箱 downloads/（skill 包、PDF 模板等）
- shell_run（risk4 需签收）可执行任意非黑名单命令：curl / Invoke-WebRequest 也能联网，npm install 可装库（如 pdfkit 渲染 PDF）；需要时向用户说明用途并等待签收
- memory_save 固化事实；artifact_create 产出正式文件（报告/计划/代码）

操作硬纪律（必须遵守）：
1. 定位：先用 fs_list / fs_grep / fs_read 找到目标文件和上下文，不要瞎猜路径
2. 读：fs_read 支持 offset/limit 行切片，先读关键区段
3. 交叉验证：动手改之前，用 fs_grep 核对你的理解准确
4. 最小修改：只改必要处，不顺手重构
5. 改后必验：修改后读回验证结果
6. 不确定先问：模糊场景先向用户说明再动手

原文优先纪律：
- 用户要求"读出来 / 打开文件 / 看原文 / read out"时，直接逐字输出完整原文，禁止用摘要或转述替代
- 仅当文件超长（>200 行）才先给结构概览，同时说明"全文太长，要哪段我给你"

任务聚焦纪律：
- 一次只做一件事；动手前先明确完成标准
- 指令模糊/方向性时：第 1 轮用一句话反问澄清目标+完成标准，不要先烧探索预算
- 探索类任务先定步数预算，到预算即给阶段性结论
- 每轮工具调用必须朝完成标准推进

输出模式纪律（每次回复首行必须以 [MODE:xxx] 开头，一行，随后空一行再写正文；按任务形态选型）：
- [MODE:text]：纯咨询/闲聊/不需要工具的回答。直接写正文，不调用任何工具
- [MODE:single]：单个明确操作（如"记录睡眠 7.5 小时"）。直接调工具 → 一句简短确认结果，不展开
- [MODE:sequential]：多个独立小步骤（如"记录今天饮食+运动"）。先一行列出执行顺序（"将依次：…"），逐个执行，每步一句话确认，最后一句汇总
- [MODE:plan-execute]：复杂多步/大任务（改代码、写报告、跨模块调研）。先输出 2-4 行简明计划（以"计划："开头），然后逐步执行；每步一句过程说明（不超过 2 行）；全部完成后给结构化总结
- 关键：不要一上来就堆一大段文字；执行类任务每轮中间说明保持简短（≤3 行），把篇幅留给最终总结

记忆纪律（P1）：
- 对话中发现的重要事实/偏好/决策，用 memory_save 主动固化（选好 type 和 tags；默认存 L1 事实层）
- 零散事实积累多了，用 memory_consolidate 聚合为 L2 场景块 / 更新 L3 画像

平台纪律（Windows 环境）：
- 文件检索用 fs_grep（正则），列目录用 fs_list，读文件用 fs_read（行切片）

写操作（life_* 的 risk3 工具 / fs_write / shell_run 等）会推确认卡到用户界面，用户允许后才执行。`;

// ---- 配置 ----
async function loadLlmConfig(): Promise<LLMConfig | null> {
  try {
    const raw = JSON.parse(await readFile(path.join(PAA_ROOT, 'config.json'), 'utf8')) as Record<string, unknown>;
    const apiUrl = String(raw.apiUrl ?? raw.baseUrl ?? '');
    const baseUrl = apiUrl.endsWith('/chat/completions') ? apiUrl.replace(/\/chat\/completions$/, '') : apiUrl;
    if (baseUrl && raw.apiKey) {
      return {
        provider: 'openai-compatible',
        baseUrl,
        apiKey: String(raw.apiKey),
        model: String(raw.model ?? 'deepseek-chat'),
      };
    }
  } catch {
    // 无配置
  }
  return null;
}

// ---- WS 连接管理与确认卡 ----
const connections = new Set<WsConnection>();
interface PendingConfirm {
  resolve: (ok: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}
const pendingConfirms = new Map<string, PendingConfirm>();
/** 会话级放行（所有连接共享；单用户本地场景） */
const trustedTools = new Set<string>();

function broadcast(obj: unknown): void {
  for (const c of connections) c.sendJson(obj);
}

const CONFIRM_TIMEOUT_MS = 60_000;

/** ctx.ask 实现：推确认卡到控制台，等待应答；超时/无连接 = 拒绝 */
function askOverWs(prompt: string, toolName?: string): Promise<boolean> {
  if (toolName && trustedTools.has(toolName)) return Promise.resolve(true);
  const id = randomUUID().slice(0, 8);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingConfirms.delete(id);
      broadcast({ type: 'confirm_timeout', id });
      resolve(false);
    }, CONFIRM_TIMEOUT_MS);
    pendingConfirms.set(id, { resolve, timer });
    broadcast({ type: 'confirm', id, tool: toolName ?? '?', prompt, connections: connections.size });
    if (connections.size === 0) {
      // 没有控制台连着：直接拒绝（安全默认）
      clearTimeout(timer);
      pendingConfirms.delete(id);
      resolve(false);
    }
  });
}

function handleWsMessage(conn: WsConnection, msg: WsMessage): void {
  if (msg.type === 'confirm' && typeof msg.id === 'string') {
    const p = pendingConfirms.get(msg.id);
    if (!p) return;
    pendingConfirms.delete(msg.id);
    clearTimeout(p.timer);
    const ok = msg.ok === true;
    if (ok && msg.always === true && typeof msg.tool === 'string') {
      trustedTools.add(msg.tool);
      broadcast({ type: 'trusted', tool: msg.tool });
    }
    p.resolve(ok);
    return;
  }
  if (msg.type === 'ping') {
    conn.sendJson({ type: 'pong', t: Date.now() });
  }
  // 其余客户端消息暂不需要（预留）
}

// ---- 对话会话（跨 run 历史） ----
interface ChatSession {
  id: string;
  messages: ChatMessage[];
  createdAt: number;
}
const chatSessions = new Map<string, ChatSession>();
const MAX_HISTORY = 60;

function getChatSession(id?: unknown): ChatSession {
  const sid = typeof id === 'string' && id.trim() ? id.trim() : `s-${randomUUID().slice(0, 8)}`;
  let s = chatSessions.get(sid);
  if (!s) {
    s = { id: sid, messages: [], createdAt: Date.now() };
    chatSessions.set(sid, s);
    // 只保留最近 20 个会话（内存防膨胀）
    if (chatSessions.size > 20) {
      const oldest = [...chatSessions.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
      if (oldest) chatSessions.delete(oldest.id);
    }
  }
  return s;
}

// ---- HTTP 工具 ----
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.md': 'text/markdown; charset=utf-8',
};

function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

async function readBody(req: IncomingMessage, limit = 5 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

/** aiConfig.apiKey 脱敏（不发给浏览器） */
function sanitize(key: string, value: unknown): unknown {
  if (key === 'aiConfig' && typeof value === 'object' && value !== null) {
    const c = { ...(value as Record<string, unknown>) };
    if (typeof c.apiKey === 'string' && c.apiKey) c.apiKey = '***';
    return c;
  }
  return value;
}

async function serveStatic(res: ServerResponse, urlPath: string): Promise<void> {
  let rel = urlPath === '/' || urlPath === '' ? 'console.html' : urlPath.slice(1);
  if (rel === 'app') rel = 'index.html'; // 旧 PWA 入口保留
  const file = path.resolve(WORKSPACE_ROOT, rel);
  if (!file.startsWith(WORKSPACE_ROOT + path.sep) && file !== WORKSPACE_ROOT) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  try {
    const s = await stat(file);
    if (!s.isFile()) throw new Error('not file');
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
}

// ---- 主流程 ----
async function main(): Promise<void> {
  const llmConfig = await loadLlmConfig();
  if (!llmConfig) {
    console.error('❌ 未找到有效 paa/config.json（需要 apiUrl + apiKey）');
    process.exit(1);
  }

  // 数据层
  const lifeStore = new LifeStore(path.join(PAA_ROOT, 'data', 'life'));
  await lifeStore.init();

  // 大脑层
  const memory = new JsonMemoryProvider({
    filePath: path.join(PAA_ROOT, 'memory', 'store.json'),
    seed: createDefaultPersonaSeed(),
  });
  await memory.init();
  const artifacts = new FileArtifactProvider(path.join(PAA_ROOT, 'artifacts'));

  const session = new SessionMgr(path.join(PAA_ROOT, 'runs'));
  const serverSessionId = await session.newSession();

  const audit = (line: string): void => {
    console.log(line);
    broadcast({ type: 'audit', line });
  };
  const permission = new Permission(2); // 默认 L2：读自动，写确认（控制台可视调节）
  const pipeline = new ToolPipeline(permission);
  for (const t of createCoreTools(WORKSPACE_ROOT)) pipeline.register(t);
  for (const t of createMemoryTools(memory)) pipeline.register(t);
  for (const t of createArtifactTools(artifacts)) pipeline.register(t);
  for (const t of createWebTools()) pipeline.register(t);

  // ToolPkg：life 包经真加载（services 注入 LifeStore 单例）
  const pkgLoader = new PkgLoader({
    pkgsRoot: path.join(PAA_ROOT, 'pkgs'),
    pipeline,
    permission,
    env: {
      root: WORKSPACE_ROOT,
      pkgDir: path.join(PAA_ROOT, 'pkgs'),
      audit,
      services: { lifeStore },
    },
  });
  for (const t of createPkgTools(pkgLoader)) pipeline.register(t);
  const loadedPkgs = await pkgLoader.loadAll();
  const pkgErrors = pkgLoader.getErrors();
  for (const [name, why] of Object.entries(pkgErrors)) {
    console.error(`工具包 ${name} 加载失败: ${why}`);
  }

  const adapter = createAdapter(llmConfig);
  const toolsDesc = pipeline
    .list()
    .map((t) => `- ${t.name}：${t.desc}（risk ${t.risk}）`)
    .join('\n');
  const loop = new AgentLoop({
    adapter,
    pipeline,
    session,
    systemPrompt: SYSTEM_PROMPT.replace('__TOOLS__', toolsDesc),
    memoryProvider: memory,
    maxRounds: MAX_ROUNDS,
  });

  // 数据变更 → WS 推送
  lifeStore.on('change', (ev: { key: string; source: string; ts: number }) => {
    broadcast({ type: 'change', key: ev.key, source: ev.source, ts: ev.ts });
  });
  lifeStore.on('heal', (ev: { key: string; quarantine: string }) => {
    broadcast({ type: 'heal', key: ev.key, quarantine: ev.quarantine });
  });

  // chat 串行队列（同一时刻只跑一个 run）
  let chatQueue: Promise<unknown> = Promise.resolve();

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
    const p = url.pathname;

    try {
      // ---- REST：健康 ----
      if (p === '/api/health' && req.method === 'GET') {
        sendJson(res, 200, {
          ok: true,
          port: PORT,
          level: permission.level,
          tools: pipeline.list().map((t) => ({ name: t.name, risk: t.risk })),
          pkgs: loadedPkgs.map((lp) => `${lp.manifest.name}@${lp.manifest.version}`),
          memory: (await memory.list()).length,
          sessionId: serverSessionId,
        });
        return;
      }

      // ---- REST：数据读 ----
      if (p === '/api/data' && req.method === 'GET') {
        const all = lifeStore.getAll();
        const out: Record<string, unknown> = {};
        for (const k of LIFE_KEYS) out[k] = sanitize(k, (all as Record<string, unknown>)[k]);
        sendJson(res, 200, out);
        return;
      }
      const dataKeyMatch = /^\/api\/data\/([a-zA-Z]+)$/.exec(p);
      if (dataKeyMatch) {
        const key = dataKeyMatch[1];
        if (!(LIFE_KEYS as readonly string[]).includes(key)) {
          sendJson(res, 404, { error: `未知键: ${key}` });
          return;
        }
        if (req.method === 'GET') {
          sendJson(res, 200, { key, value: sanitize(key, lifeStore.get(key as LifeKey)) });
          return;
        }
        if (req.method === 'PUT') {
          const body = JSON.parse((await readBody(req)).toString('utf8')) as { value?: unknown };
          if (!('value' in body)) {
            sendJson(res, 400, { error: 'body 需要 {value}' });
            return;
          }
          try {
            await lifeStore.tx((d) => {
              (d as Record<string, unknown>)[key] = body.value;
            }, { source: 'ui' });
            sendJson(res, 200, { ok: true, key });
          } catch (e) {
            sendJson(res, 422, { error: e instanceof Error ? e.message : String(e) });
          }
          return;
        }
      }

      // ---- REST：迁移导入 ----
      if (p === '/api/import' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString('utf8')) as { data?: Record<string, unknown>; mode?: string };
        if (!body.data || typeof body.data !== 'object') {
          sendJson(res, 400, { error: 'body 需要 {data}' });
          return;
        }
        const mode = body.mode === 'merge' ? 'merge' : 'replace';
        const { changed } = await lifeStore.importBlob(body.data, mode);
        sendJson(res, 200, { ok: true, mode, changed });
        return;
      }

      // ---- REST：会话列表 ----
      if (p === '/api/sessions' && req.method === 'GET') {
        sendJson(res, 200, [...chatSessions.values()].map((s) => ({ id: s.id, messages: s.messages.length, createdAt: s.createdAt })));
        return;
      }

      // ---- REST：chat ----
      if (p === '/api/chat' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString('utf8')) as { message?: string; sessionId?: string };
        const message = typeof body.message === 'string' ? body.message.trim() : '';
        if (!message) {
          sendJson(res, 400, { error: 'message 必填' });
          return;
        }
        const chatSession = getChatSession(body.sessionId);
        const ctx = {
          sessionId: serverSessionId,
          cwd: WORKSPACE_ROOT,
          ask: askOverWs,
          audit,
        };
        // 串行执行（同一 loop 不可并发）
        const runP = chatQueue.then(async () => {
          const result = await loop.run(message, ctx, {
            prior: chatSession.messages.slice(-MAX_HISTORY),
            onEvent: (ev) => broadcast({ type: 'event', ev }),
          });
          // 更新会话历史（去 system 的完整轨迹）
          chatSession.messages = (chatSession.messages ?? []).concat(result.messages ?? []).slice(-MAX_HISTORY);
          return {
            ok: true,
            sessionId: chatSession.id,
            answer: result.answer,
            rounds: result.rounds,
            toolCalls: result.toolCalls,
          };
        });
        chatQueue = runP.catch(() => undefined); // 队列不因单次失败中断
        try {
          sendJson(res, 200, await runP);
        } catch (e) {
          sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
        }
        return;
      }

      // ---- REST：chat 流式（SSE，v1.1 打字机） ----
      if (p === '/api/chat/stream' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString('utf8')) as { message?: string; sessionId?: string };
        const message = typeof body.message === 'string' ? body.message.trim() : '';
        if (!message) {
          sendJson(res, 400, { error: 'message 必填' });
          return;
        }
        const chatSession = getChatSession(body.sessionId);
        const ctx = {
          sessionId: serverSessionId,
          cwd: WORKSPACE_ROOT,
          ask: askOverWs,
          audit,
        };

        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        const sse = (obj: unknown): void => {
          try {
            res.write(`data: ${JSON.stringify(obj)}\n\n`);
          } catch {
            /* 客户端已断 */
          }
        };
        sse({ type: 'meta', sessionId: chatSession.id });

        let closed = false;
        res.on('close', () => {
          closed = true;
          loop.abort();
        });

        const runP = chatQueue.then(async () => {
          const result = await loop.run(message, ctx, {
            prior: chatSession.messages.slice(-MAX_HISTORY),
            onDelta: (text) => {
              if (!closed) sse({ type: 'delta', text });
            },
            onEvent: (ev) => {
              if (!closed) sse({ type: 'event', ev });
              broadcast({ type: 'event', ev });
            },
          });
          chatSession.messages = (chatSession.messages ?? []).concat(result.messages ?? []).slice(-MAX_HISTORY);
          return result;
        });
        chatQueue = runP.catch(() => undefined);
        try {
          const result = await runP;
          if (!closed) {
            sse({ type: 'done', sessionId: chatSession.id, answer: result.answer, rounds: result.rounds, toolCalls: result.toolCalls });
            res.end();
          }
        } catch (e) {
          if (!closed) {
            sse({ type: 'error', error: e instanceof Error ? e.message : String(e) });
            res.end();
          }
        }
        return;
      }

      // ---- REST：autonomy 级别 ----
      if (p === '/api/level' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString('utf8')) as { level?: number };
        const n = Number(body.level);
        if (!Number.isNaN(n) && n >= 0 && n <= 4) {
          permission.setLevel(n as AutonomyLevel);
          broadcast({ type: 'level', level: n });
          sendJson(res, 200, { ok: true, level: n });
        } else {
          sendJson(res, 400, { error: 'level 需为 0-4' });
        }
        return;
      }

      // ---- 静态 ----
      if (req.method === 'GET' || req.method === 'HEAD') {
        await serveStatic(res, p);
        return;
      }
      sendJson(res, 405, { error: 'method not allowed' });
    } catch (e) {
      sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  });

  // ---- WS upgrade ----
  httpServer.on('upgrade', (req, socket, head) => {
    if (new URL(req.url ?? '/', `http://${HOST}:${PORT}`).pathname !== '/ws') {
      socket.destroy();
      return;
    }
    const conn = acceptUpgrade(req, socket);
    if (!conn) return;
    if (head.length > 0) {
      // upgrade 后残留数据：作为首帧输入（acceptUpgrade 内部未消费 head，这里补喂）
      // WsConnection 构造后 data 事件已监听；head 直接触发一次处理
      (socket as unknown as { emit: (ev: string, d: Buffer) => void }).emit('data', head);
    }
    connections.add(conn);
    conn.onMessage = (msg) => handleWsMessage(conn, msg);
    conn.onClose = () => connections.delete(conn);
    conn.sendJson({
      type: 'welcome',
      sessionId: serverSessionId,
      tools: pipeline.list().map((t) => t.name),
      pkgs: loadedPkgs.map((lp) => lp.manifest.name),
    });
    console.log(`[ws] 控制台已连接（${connections.size} 个）`);
  });

  // 保活：30s ping，2 次无响应踢掉
  const heartbeat = setInterval(() => {
    for (const c of connections) {
      if (!c.isAlive) continue;
      c.ping();
    }
  }, 30_000);
  httpServer.on('close', () => clearInterval(heartbeat));

  httpServer.listen(PORT, HOST, () => {
    console.log('╭──────────────────────────────────────────────╮');
    console.log('│  PAA Console Server                          │');
    console.log(`│  入口     http://${HOST}:${PORT}/            │`);
    console.log(`│  旧 PWA   http://${HOST}:${PORT}/app          │`);
    console.log(`│  Autonomy L2（risk3 写操作推确认卡）          │`);
    console.log(`│  工具 ${pipeline.list().length} 个 · 包 ${loadedPkgs.map((l) => l.manifest.name).join(',') || '无'}              `);
    console.log('╰──────────────────────────────────────────────╯');
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
