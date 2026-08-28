// ============================================================
// PAA Console Server — 主客反转架构的服务层（console-v1 路线 2）
// 控制台（console.html）为主体：HTTP 静态 + REST + WS 推送 + chat
// index.html 已于 B3 退役（2026-08-28），console.html 是唯一前端宿主
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
import { ChatSessionStore } from '../core/chat-session-store.ts';
import { acceptUpgrade, type WsConnection, type WsMessage } from '../core/ws.ts';
import { createCoreTools } from '../tools/core-tools.ts';
import { createMemoryTools } from '../tools/memory-tools.ts';
import { createArtifactTools } from '../tools/artifact-tools.ts';
import { createPkgTools } from '../tools/pkg-tools.ts';
import { createWebTools } from '../tools/web-tools.ts';
import { SupabaseAuth, AuthError, type AuthSession } from './auth.ts';
import { SyncEngine, SyncState } from '../core/sync.ts';
import { SupabaseSyncTransport } from './sync-rest.ts';
import { SupabaseRealtime, type RealtimeState } from '../core/realtime.ts';

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

interface SupabaseConfig {
  url: string;
  publishableKey: string;
}

async function loadSupabaseConfig(): Promise<SupabaseConfig | null> {
  try {
    const raw = JSON.parse(await readFile(path.join(PAA_ROOT, 'config.json'), 'utf8')) as {
      supabase?: { url?: string; publishableKey?: string };
    };
    const url = raw.supabase?.url;
    const publishableKey = raw.supabase?.publishableKey;
    if (url && publishableKey) return { url, publishableKey };
  } catch {
    // 无配置
  }
  return null;
}

/** 从 Cookie 头解析指定 cookie（无则返回 null） */
function getCookie(req: IncomingMessage, name: string): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === name && v) return decodeURIComponent(v);
  }
  return null;
}

const SESSION_COOKIE = 'paa_session';
const SESSION_COOKIE_MAX_AGE = 30 * 24 * 3600; // 30 天
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

// ---- 对话会话（跨 run 历史，经 ChatSessionStore 持久化到 data/sessions/*） ----
let chatStore: ChatSessionStore;
interface ChatSession {
  id: string;
  messages: ChatMessage[];
  createdAt: number;
}
const MAX_HISTORY = 60;

async function getChatSession(id?: unknown): Promise<ChatSession> {
  const rec = await chatStore.getOrCreate(id);
  return { id: rec.id, messages: rec.messages, createdAt: rec.createdAt };
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

  // ---- S1：Supabase Auth（GitHub OAuth，PKCE）----
  const supabaseConfig = await loadSupabaseConfig();
  const auth = supabaseConfig
    ? new SupabaseAuth({
        projectUrl: supabaseConfig.url,
        publishableKey: supabaseConfig.publishableKey,
        callbackUrl: `http://${HOST}:${PORT}/api/auth/callback`,
        sessionDir: path.join(PAA_ROOT, 'data', 'auth', 'sessions'),
        userDir: path.join(PAA_ROOT, 'data', 'auth', 'users'),
      })
    : null;
  await auth?.init();

  // 数据层
  const lifeStore = new LifeStore(path.join(PAA_ROOT, 'data', 'life'));
  await lifeStore.init();

  // ---- S2：云同步状态（登录后按用户启用；本地为 source of truth，云端镜像）----
  let syncState: SyncState | null = null;
  let syncEngine: SyncEngine | null = null;
  let syncUserId = '';

  // ---- S3：Realtime 订阅 + 后台补同步 ----
  let latestAuthSession: AuthSession | null = null; // ensureSync 每次都会刷新（登录/me/sync 三路径）
  let realtime: SupabaseRealtime | null = null;
  let realtimeState: RealtimeState | 'off' = 'off';
  let syncBusy = false;
  let syncQueued = false;
  let cloudSyncTimer: ReturnType<typeof setTimeout> | null = null;

  /** 同步引擎状态摘要（health/me/sync 端点共用） */
  function syncInfo(): {
    enabled: boolean;
    lastSync: number;
    lastError?: string;
    dirty: number;
    realtime: RealtimeState | 'off';
  } {
    return {
      enabled: !!syncEngine,
      lastSync: syncState?.snapshot.lastSync ?? 0,
      lastError: syncState?.snapshot.lastError,
      dirty: syncState ? Object.keys(syncState.snapshot.dirty).length : 0,
      realtime: realtimeState,
    };
  }

  /** token 快过期时刷新（Realtime 重连 / 后台同步前调用；失败返回 false） */
  async function refreshTokenIfNeeded(): Promise<boolean> {
    if (!auth || !latestAuthSession) return false;
    if (Date.now() < latestAuthSession.expiresAt - 120_000) return true;
    const r = await auth.refreshIfNeeded(latestAuthSession).catch(() => null);
    if (r) {
      latestAuthSession = r;
      return true;
    }
    return false;
  }

  /** 串行化后台同步：并发请求排队，跑完补跑一轮（防止 syncOnce 交错写状态文件） */
  async function runBackgroundSync(reason: string): Promise<void> {
    if (!syncEngine || !latestAuthSession) return;
    if (syncBusy) {
      syncQueued = true;
      return;
    }
    syncBusy = true;
    try {
      // token 可能已过期（长时间无人访问 me）→ 刷新并重建引擎/Realtime
      if (await refreshTokenIfNeeded()) {
        await ensureSync(latestAuthSession);
      } else {
        return; // 登录态失效（refresh 失败）→ 等下一次登录
      }
      const r = await syncEngine!.syncOnce();
      console.log(
        `[sync] 后台同步（${reason}）：pull life ${r.pulledLife.length} / push life ${r.pushedLife.length} / 事件 +${r.pulledEvents} -${r.pushedEvents}`,
      );
    } catch (e) {
      console.error(`[sync] 后台同步失败（${reason}）: ${e instanceof Error ? e.message : e}`);
    } finally {
      syncBusy = false;
      if (syncQueued) {
        syncQueued = false;
        void runBackgroundSync(`${reason}+queued`);
      }
    }
  }

  /** 去抖触发一次后台同步（云端事件 1.5s 合并 / 本地改动 4s 批处理窗口） */
  function scheduleCloudSync(reason: 'realtime' | 'reconnect' | 'local'): void {
    const delay = reason === 'local' ? 4_000 : 1_500;
    if (cloudSyncTimer) return;
    cloudSyncTimer = setTimeout(() => {
      cloudSyncTimer = null;
      void runBackgroundSync(reason);
    }, delay);
  }

  /** 启动/换用户时重建 Realtime 订阅（云端变更 → 本地感知 → 拉取合并） */
  function ensureRealtime(): void {
    if (!supabaseConfig || !syncEngine) return;
    if (realtime && syncUserId === latestAuthSession?.user.id) return; // 同用户已订阅
    realtime?.stop(); // 换用户 → 旧订阅作废
    realtime = new SupabaseRealtime({
      projectUrl: supabaseConfig.url,
      publishableKey: supabaseConfig.publishableKey,
      tables: ['life_sync', 'session_events'],
      getAccessToken: async () => {
        if (!(await refreshTokenIfNeeded())) return null;
        return latestAuthSession?.accessToken ?? null;
      },
      onServerChange: (why) => {
        if (why === 'reconnect') void runBackgroundSync('realtime-reconnect'); // 断线期间的变更立即补拉
        else scheduleCloudSync('realtime');
      },
      onStateChange: (s, detail) => {
        realtimeState = s;
        if (s === 'reconnecting') console.log(`[realtime] ${s}: ${detail ?? ''}`);
        else console.log(`[realtime] ${s}`);
      },
    });
    realtime.start();
  }

  /** 按登录会话启用/复用同步引擎（幂等：同用户且 token 未过期则复用） */
  async function ensureSync(authSession: AuthSession): Promise<void> {
    if (!supabaseConfig) return;
    latestAuthSession = authSession; // 最新会话（后续 token 刷新/Realtime 取 token 用）
    const tokenStillValid = Date.now() < authSession.expiresAt - 60_000;
    if (syncEngine && syncUserId === authSession.user.id && tokenStillValid) {
      ensureRealtime(); // 引擎可复用，但 Realtime 可能还没起（如 server 重启后第一次 me）
      return;
    }
    const state = new SyncState(path.join(PAA_ROOT, 'data', 'sync'));
    await state.init();
    const transport = new SupabaseSyncTransport({
      projectUrl: supabaseConfig.url,
      publishableKey: supabaseConfig.publishableKey,
      accessToken: authSession.accessToken,
    });
    syncState = state;
    syncEngine = new SyncEngine({ lifeStore, sessionMgr: session, transport, state, userId: authSession.user.id });
    syncUserId = authSession.user.id;
    console.log(`[sync] 同步引擎就绪（user ${authSession.user.id.slice(0, 8)}…）`);
    ensureRealtime();
  }

  /** 登录态下的初始后台同步（fire-and-forget，失败只记 lastError 不打断请求） */
  async function initialSync(): Promise<void> {
    if (!syncEngine) return;
    try {
      const r = await syncEngine.syncOnce();
      console.log(`[sync] 首次同步完成：pull life ${r.pulledLife.length} / push life ${r.pushedLife.length} / 事件 +${r.pulledEvents} -${r.pushedEvents}`);
    } catch (e) {
      console.error(`[sync] 首次同步失败（可稍后手动触发 /api/sync）: ${e instanceof Error ? e.message : e}`);
    }
  }

  // 对话会话 store（data/sessions/*，启动加载 + 原子写持久化 + 损坏自愈）
  chatStore = new ChatSessionStore(path.join(PAA_ROOT, 'data', 'sessions'));
  await chatStore.init();

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

  // 数据变更 → WS 推送 + S2：本地非同步来源的修改标记 dirty（下次 syncOnce 推送）
  // S3：本地改动 → 4s 去抖后台推送（云端镜像准实时更新，其他端经 Realtime 感知）
  lifeStore.on('change', (ev: { key: string; source: string; ts: number }) => {
    broadcast({ type: 'change', key: ev.key, source: ev.source, ts: ev.ts });
    if (ev.source !== 'sync' && syncState) {
      syncState.markDirty(ev.key);
      void syncState.save();
      scheduleCloudSync('local');
    }
  });
  lifeStore.on('heal', (ev: { key: string; quarantine: string }) => {
    broadcast({ type: 'heal', key: ev.key, quarantine: ev.quarantine });
  });

  // chat 串行队列（同一时刻只跑一个 run）
  let chatQueue: Promise<unknown> = Promise.resolve();

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
    const p = url.pathname;
    console.log(`[http] ${req.method} ${p}${url.search ? '?' + url.search.slice(0, 80) : ''}`);

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
          auth: auth ? 'ready' : 'disabled',
          sync: syncInfo(),
        });
        return;
      }

      // ---- REST：Auth（S1 GitHub OAuth，Supabase 托管）----
      // 登录：302 → Supabase authorize（PKCE）
      if (p === '/api/auth/login' && req.method === 'GET') {
        if (!auth) {
          sendJson(res, 503, { error: '未配置 supabase（paa/config.json 缺 supabase 字段）' });
          return;
        }
        res.writeHead(302, { Location: auth.buildLoginUrl() });
        res.end();
        return;
      }
      // 回调：code + state → 换 token → 落盘 → 种 cookie → 回首页
      if (p === '/api/auth/callback' && req.method === 'GET') {
        if (!auth) {
          sendJson(res, 503, { error: '未配置 supabase' });
          return;
        }
        const code = url.searchParams.get('code') ?? '';
        // state 是 GoTrue 自己的 flow_state UUID（我们不传 state），无需也不应校验
        if (!code) {
          sendJson(res, 400, { error: '缺少 code 参数' });
          return;
        }
        try {
          const authSession = await auth.exchangeCode(code);
          await auth.save(authSession);
          console.log(`[auth] 登录成功: ${authSession.user.name} (${authSession.user.id})`);
          broadcast({ type: 'auth', event: 'login', user: authSession.user });
          // S2：登录即启用同步引擎并做首次后台同步（云端镜像 → 本地）
          ensureSync(authSession).then(initialSync).catch((e) => console.error(`[sync] 引擎启动失败: ${e instanceof Error ? e.message : e}`));
          res.writeHead(302, {
            Location: '/?st=' + authSession.sid,
            'Set-Cookie': `${SESSION_COOKIE}=${authSession.sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_COOKIE_MAX_AGE}`,
          });
          res.end();
        } catch (e) {
          const status = e instanceof AuthError ? e.status : 500;
          console.error(`[auth] 登录失败: ${e instanceof Error ? e.message : e}`);
          res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(
            `<html><body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h2>登录失败</h2><p>${(e instanceof Error ? e.message : String(e)).replace(/[<>&]/g, '')}</p><a href="/">返回</a></div></body></html>`,
          );
        }
        return;
      }
      // 当前用户：读 cookie → 会话文件 → （必要时 refresh）→ 用户信息
      if (p === '/api/auth/me' && req.method === 'GET') {
        if (!auth) {
          sendJson(res, 503, { error: '未配置 supabase' });
          return;
        }
        const sid = getCookie(req, SESSION_COOKIE);
        if (!sid) {
          sendJson(res, 401, { error: '未登录' });
          return;
        }
        let session = await auth.get(sid);
        if (!session) {
          sendJson(res, 401, { error: '会话不存在或已失效，请重新登录' });
          return;
        }
        const refreshed = await auth.refreshIfNeeded(session);
        if (refreshed) {
          session = refreshed;
          console.log(`[auth] 已刷新 token: ${session.user.name}`);
        }
        const rec = await auth.getUserRec(session.user.id);
        // S2：me 即触发引擎就绪（token 续期后重建），响应附同步状态
        await ensureSync(session).catch(() => {});
        sendJson(res, 200, {
          ok: true,
          user: session.user,
          firstSeen: rec?.firstSeen ?? session.createdAt,
          lastSeen: rec?.lastSeen ?? session.createdAt,
          logins: rec?.logins ?? 1,
          tokenExpiresAt: session.expiresAt,
          sync: syncInfo(),
        });
        return;
      }
      // 登出：删会话文件 + 清 cookie + 停用同步引擎 + 停 Realtime
      if (p === '/api/auth/logout' && req.method === 'POST') {
        realtime?.stop();
        realtime = null;
        realtimeState = 'off';
        if (cloudSyncTimer) clearTimeout(cloudSyncTimer);
        cloudSyncTimer = null;
        syncEngine = null;
        syncState = null;
        syncUserId = '';
        latestAuthSession = null;
        if (auth) {
          const sid = getCookie(req, SESSION_COOKIE);
          if (sid) {
            await auth.remove(sid);
            console.log('[auth] 登出（同步引擎已停用）');
          }
        }
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Set-Cookie': `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
        });
        res.end('{"ok":true}');
        return;
      }

      // ---- REST：S2 云同步（手动触发一次 syncOnce：pull 云端 → push 本地 dirty）----
      if (p === '/api/sync' && req.method === 'POST') {
        if (!auth || !supabaseConfig) {
          sendJson(res, 503, { error: '未配置 supabase（paa/config.json 缺 supabase 字段）' });
          return;
        }
        const sid = getCookie(req, SESSION_COOKIE);
        if (!sid) {
          sendJson(res, 401, { error: '未登录' });
          return;
        }
        let authSession = await auth.get(sid);
        if (!authSession) {
          sendJson(res, 401, { error: '会话不存在或已失效，请重新登录' });
          return;
        }
        const refreshed = await auth.refreshIfNeeded(authSession);
        if (refreshed) authSession = refreshed;
        try {
          await ensureSync(authSession);
          if (!syncEngine || !syncState) {
            sendJson(res, 503, { error: '同步引擎未就绪' });
            return;
          }
          const result = await syncEngine.syncOnce();
          console.log(`[sync] 手动同步完成：pull life ${result.pulledLife.length} / push life ${result.pushedLife.length} / 事件 +${result.pulledEvents} -${result.pushedEvents}`);
          sendJson(res, 200, { ok: true, result, sync: syncInfo() });
        } catch (e) {
          sendJson(res, 502, { ok: false, error: e instanceof Error ? e.message : String(e), sync: syncInfo() });
        }
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

      // ---- REST：会话 CRUD（多会话，经 ChatSessionStore 持久化到 data/sessions/*） ----
      // 列表
      if (p === '/api/sessions' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, sessions: chatStore.list() });
        return;
      }
      // 创建
      if (p === '/api/sessions' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString('utf8')) as { title?: string };
        const rec = await chatStore.create(typeof body.title === 'string' ? body.title : undefined);
        sendJson(res, 201, { ok: true, session: rec });
        return;
      }
      // 单个会话详情（含消息历史）
      const sessionIdMatch = /^\/api\/sessions\/([a-zA-Z0-9-]+)$/.exec(p);
      if (sessionIdMatch) {
        const sid = sessionIdMatch[1];
        const rec = await chatStore.get(sid);
        if (!rec) {
          sendJson(res, 404, { error: `会话不存在: ${sid}` });
          return;
        }
        if (req.method === 'GET') {
          sendJson(res, 200, { ok: true, session: rec });
          return;
        }
        if (req.method === 'DELETE') {
          await chatStore.remove(sid);
          sendJson(res, 200, { ok: true, removed: sid });
          return;
        }
      }
      // ---- REST：Planner 任务树（G8 第三靶验收：查证「中途失败自愈」路径）----
      // GET /api/tasks/:sid → 读取 runs/<sid>/task-tree.json（含 t3 的 history 字段），
      // 并返回失败自愈追踪摘要（exec-fail / replan-replaced / replan-pruned 计数）
      const taskIdMatch = /^\/api\/tasks\/([a-zA-Z0-9-]+)$/.exec(p);
      if (taskIdMatch && req.method === 'GET') {
        const tid = taskIdMatch[1];
        try {
          const raw = await readFile(
            path.join(session.sessionDir(tid), 'task-tree.json'),
            'utf8',
          );
          const tree = JSON.parse(raw) as {
            goal?: string;
            createdAt?: number;
            updatedAt?: number;
            tasks?: Array<{
              id?: string;
              desc?: string;
              status?: string;
              history?: Array<{ reason?: string; status?: string; ts?: number }>;
            }>;
          };
          // 失败自愈追踪摘要（t3 数据层暴露给验收/前端）
          const healSummary = {
            execFail: 0,
            replanReplaced: 0,
            replanPruned: 0,
            entries: 0,
          };
          for (const t of tree.tasks ?? []) {
            for (const h of t.history ?? []) {
              healSummary.entries++;
              if (h.reason === 'exec-fail') healSummary.execFail++;
              else if (h.reason === 'replan-replaced') healSummary.replanReplaced++;
              else if (h.reason === 'replan-pruned') healSummary.replanPruned++;
            }
          }
          sendJson(res, 200, { ok: true, goal: tree.goal, createdAt: tree.createdAt, updatedAt: tree.updatedAt, tasks: tree.tasks, healSummary });
        } catch {
          sendJson(res, 404, { error: `任务树不存在: ${tid}（runs/${tid}/task-tree.json）` });
        }
        return;
      }
      // 单会话发消息（写入 store 并返回回复）
      const sessionMsgMatch = /^\/api\/sessions\/([a-zA-Z0-9-]+)\/messages$/.exec(p);
      if (sessionMsgMatch && req.method === 'POST') {
        const sid = sessionMsgMatch[1];
        const rec = await chatStore.get(sid);
        if (!rec) {
          sendJson(res, 404, { error: `会话不存在: ${sid}` });
          return;
        }
        const body = JSON.parse((await readBody(req)).toString('utf8')) as { message?: string };
        const message = typeof body.message === 'string' ? body.message.trim() : '';
        if (!message) {
          sendJson(res, 400, { error: 'message 必填' });
          return;
        }
        const ctx = {
          sessionId: serverSessionId,
          cwd: WORKSPACE_ROOT,
          ask: askOverWs,
          audit,
        };
        const runP = chatQueue.then(async () => {
          const result = await loop.run(message, ctx, {
            prior: rec.messages.slice(-MAX_HISTORY),
            onEvent: (ev) => broadcast({ type: 'event', ev }),
          });
          const uiHistory = messagesToUiHistory(result.messages ?? []);
          const updated = await chatStore.append(sid, result.messages ?? [], uiHistory);
          return {
            ok: true,
            sessionId: sid,
            answer: result.answer,
            rounds: result.rounds,
            toolCalls: result.toolCalls,
            session: updated,
          };
        });
        chatQueue = runP.catch(() => undefined);
        try {
          sendJson(res, 200, await runP);
        } catch (e) {
          sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
        }
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
        const chatSession = await getChatSession(body.sessionId);
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
          // 更新会话历史（去 system 的完整轨迹）→ 持久化到 store
          const uiHistory = messagesToUiHistory(result.messages ?? []);
          await chatStore.append(chatSession.id, result.messages ?? [], uiHistory);
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
        const chatSession = await getChatSession(body.sessionId);
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

  // S3：定时后台同步（Realtime 挂掉时的兜底通道；登录后才有会话，未登录时 no-op）
  setInterval(() => void runBackgroundSync('periodic'), 5 * 60_000).unref?.();

  httpServer.listen(PORT, HOST, () => {
    console.log('╭──────────────────────────────────────────────╮');
    console.log('│  PAA Console Server                          │');
  console.log(`│  入口     http://${HOST}:${PORT}/            │`);
    console.log(`│  Autonomy L2（risk3 写操作推确认卡）          │`);
    console.log(`│  工具 ${pipeline.list().length} 个 · 包 ${loadedPkgs.map((l) => l.manifest.name).join(',') || '无'}              `);
    console.log('╰──────────────────────────────────────────────╯');
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
