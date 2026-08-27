// ============================================================
// 多会话 CLI 前端 — 经 HTTP 调用 server 的会话 API（不直连 store）
// 用法：node cli/sessions-client.ts [--port N] [--base http://127.0.0.1:8765]
// 交互命令：
//   /sessions          列出全部会话
//   /open <id>         切换/查看某会话（显示历史消息）
//   /new [标题]        新建会话并切换到它
//   /del <id>          删除会话
//   /cur               显示当前会话 id
//   其他输入           当作消息发送到当前会话（POST /api/sessions/:id/messages）
//   /quit              退出
// 所有读写均走 HTTP，不 import ChatSessionStore。
// ============================================================

import { createInterface } from 'node:readline/promises';
import { render } from './render.ts';

/** server 会话 API 返回的摘要结构（对齐 chat-session-store.ts） */
interface SessionSummary {
  id: string;
  title: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
}

/** 前端展示消息（对齐 UiMsg） */
interface UiMsg {
  kind: 'user' | 'assistant' | 'tool' | 'sys';
  text?: string;
  toolName?: string;
  state?: string;
  err?: unknown;
  ts: number;
}

/** 会话详情（GET /api/sessions/:id 返回） */
interface SessionRecord {
  id: string;
  title: string;
  messages: unknown[];
  uiHistory: UiMsg[];
  createdAt: number;
  updatedAt: number;
}

/** 发消息响应（POST /api/sessions/:id/messages 返回） */
interface SendReply {
  ok: boolean;
  sessionId: string;
  answer: string;
  rounds?: number;
  toolCalls?: number;
  session?: SessionRecord;
}

/** 解析 --port / --base 参数 */
function parseArgs(argv: string[]): { base: string } {
  let base = 'http://127.0.0.1:8765';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port' && argv[i + 1]) {
      const n = Number(argv[i + 1]);
      if (n > 0 && n < 65536) base = `http://127.0.0.1:${n}`;
    }
    if (argv[i] === '--base' && argv[i + 1]) base = argv[++i];
  }
  return { base };
}

/** 通用 JSON 请求；非 2xx 抛错 */
async function req<T>(base: string, path: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${res.status}（非 JSON 响应）: ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const err = (data as { error?: string })?.error;
    throw new Error(err ? `HTTP ${res.status}: ${err}` : `HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return data as T;
}

/** API：列出全部会话 */
async function apiList(base: string): Promise<SessionSummary[]> {
  const r = await req<{ ok: boolean; sessions: SessionSummary[] }>(base, '/api/sessions', 'GET');
  return r.sessions ?? [];
}

/** API：新建会话 */
async function apiCreate(base: string, title?: string): Promise<SessionRecord> {
  const r = await req<{ ok: boolean; session: SessionRecord }>(
    base,
    '/api/sessions',
    'POST',
    title ? { title } : undefined,
  );
  return r.session;
}

/** API：取单会话详情（含历史） */
async function apiGet(base: string, id: string): Promise<SessionRecord> {
  const r = await req<{ ok: boolean; session: SessionRecord }>(base, `/api/sessions/${id}`, 'GET');
  return r.session;
}

/** API：删除会话 */
async function apiDelete(base: string, id: string): Promise<void> {
  await req<{ ok: boolean }>(base, `/api/sessions/${id}`, 'DELETE');
}

/** API：发消息（写入 store 并返回回复） */
async function apiSend(base: string, id: string, message: string): Promise<SendReply> {
  return req<SendReply>(base, `/api/sessions/${id}/messages`, 'POST', { message });
}

/** 渲染会话列表（含当前标记） */
function renderList(sessions: SessionSummary[], cur: string | null): void {
  if (sessions.length === 0) {
    console.log(render.status('暂无会话，用 /new 新建'));
    return;
  }
  console.log(render.status(`共 ${sessions.length} 个会话：`));
  for (const s of sessions) {
    const mark = s.id === cur ? '◀' : ' ';
    const time = new Date(s.updatedAt).toLocaleString();
    console.log(`${mark} ${C_cyan}${s.id}${C_reset} ${s.title}  [${s.messageCount} 条]  ${time}`);
  }
}

/** 渲染单条历史消息 */
function renderMsg(m: UiMsg): void {
  if (m.kind === 'user') {
    console.log(render.user(m.text ?? ''));
  } else if (m.kind === 'assistant') {
    console.log(render.assistant(m.text ?? ''));
  } else if (m.kind === 'tool') {
    const st = m.state === 'err' ? '❌' : '✅';
    const errTxt = m.err !== undefined ? ` ${String(m.err).slice(0, 120)}` : '';
    console.log(render.audit(`  ${st} ⚙ ${m.toolName ?? ''}${errTxt}`));
  } else {
    console.log(render.audit(`  [${m.kind}] ${m.text ?? ''}`));
  }
}

const C_cyan = '\x1b[38;5;81m';
const C_reset = '\x1b[0m';

/** 主入口：多会话交互循环（所有读写走 HTTP） */
async function main(): Promise<void> {
  const { base } = parseArgs(process.argv.slice(2));
  console.log(render.banner());
  console.log(render.status(`多会话 CLI — server: ${base}（所有读写经 HTTP）`));

  let currentId: string | null = null;
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  // 连通性检查
  try {
    const sessions = await apiList(base);
    console.log(render.status(`已连接 server，现有 ${sessions.length} 个会话`));
  } catch (e) {
    console.log(render.error(`无法连接 server（${base}）：${e instanceof Error ? e.message : String(e)}`));
    console.log(render.error('请先启动 server：node server/main.ts [--port N]'));
    rl.close();
    return;
  }

  for await (const raw of rl) {
    process.stdout.write(render.prompt());
    const input = raw.trim();
    if (!input) continue;
    if (input === '/quit' || input === '/exit') break;

    try {
      if (input === '/sessions') {
        const sessions = await apiList(base);
        renderList(sessions, currentId);
        continue;
      }
      if (input === '/cur') {
        if (currentId) console.log(render.status(`当前会话: ${currentId}`));
        else console.log(render.status('当前未选择会话（/open <id> 或 /new）'));
        continue;
      }
      if (input.startsWith('/new')) {
        const title = input.slice(4).trim() || undefined;
        const rec = await apiCreate(base, title);
        currentId = rec.id;
        console.log(render.status(`已新建并切换到会话: ${rec.id}（${rec.title}）`));
        continue;
      }
      if (input.startsWith('/open')) {
        const id = input.split(/\s+/)[1];
        if (!id) {
          console.log(render.error('用法: /open <会话id>'));
          continue;
        }
        const rec = await apiGet(base, id);
        currentId = rec.id;
        console.log(render.status(`会话 ${rec.id}（${rec.title}），${rec.uiHistory.length} 条历史:`));
        for (const m of rec.uiHistory) renderMsg(m);
        continue;
      }
      if (input.startsWith('/del')) {
        const id = input.split(/\s+/)[1];
        if (!id) {
          console.log(render.error('用法: /del <会话id>'));
          continue;
        }
        await apiDelete(base, id);
        if (currentId === id) currentId = null;
        console.log(render.status(`已删除会话: ${id}`));
        continue;
      }
      // 兜底：发消息
      if (!currentId) {
        console.log(render.error('尚未选择会话，先 /open <id> 或 /new 新建'));
        continue;
      }
      console.log(render.status('…等待 server 回复'));
      const reply = await apiSend(base, currentId, input);
      console.log(render.assistant(reply.answer || '(空回复)'));
      if (reply.rounds && reply.rounds > 1) {
        console.log(render.status(`（${reply.rounds} 轮 / ${reply.toolCalls} 次工具调用）`));
      }
    } catch (e) {
      console.log(render.error(e instanceof Error ? e.message : String(e)));
    }
  }
  rl.close();
}

main().catch((e) => {
  console.error(render.error(e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
