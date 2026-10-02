// ============================================================
// 到家提醒（PRD §5.3）：用户定规则，server 按规则推
// - 触发：用户说"我到家了"（console 按钮 / iPhone 快捷指令 POST /api/home）
// - 内容：今天还没完成的「承诺」待办（建议不算）
// - 力度：gentle 一次 / follow 每 N 分钟最多 M 次 / strong 同 follow 但用最高优先级推送
// - 安静时段内不发；用户点"今天算了"或全部完成即停
// 纯函数做判断（可测），NudgeEngine 只负责持久化、定时与投递
// ============================================================

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export type NudgeLevel = 'gentle' | 'follow' | 'strong';
export type ChannelType = 'none' | 'ntfy' | 'bark' | 'webhook';

export interface NudgeConfig {
  enabled: boolean;
  level: NudgeLevel;
  /** 跟进间隔（分钟） */
  intervalMin: number;
  /** 一天最多几次（gentle 恒为 1） */
  maxCount: number;
  /** all = 今天所有没完成的承诺；atHome = 只算标了「到家后」的 */
  scope: 'all' | 'atHome';
  quietStart: string; // HH:MM
  quietEnd: string; // HH:MM
  channel: { type: ChannelType; url: string };
}

export interface NudgeState {
  day: string; // YYYY-MM-DD，跨天自动清零
  arrivedAt: number | null;
  sent: number;
  lastSentAt: number | null;
  snoozed: boolean;
}

export interface TodoLike {
  id?: string;
  title?: string;
  done?: boolean;
  dueDate?: string;
  plan?: string;
  atHome?: boolean;
  priority?: string;
}

export interface NudgeMessage {
  title: string;
  body: string;
  urgent: boolean;
  todos: string[];
}

export const DEFAULT_CONFIG: NudgeConfig = {
  enabled: false,
  level: 'follow',
  intervalMin: 45,
  maxCount: 3,
  scope: 'all',
  quietStart: '00:30',
  quietEnd: '08:00',
  channel: { type: 'none', url: '' },
};

const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const clamp = (n: unknown, lo: number, hi: number, d: number): number => {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
};

/** 渠道 URL：只接受 http(s)，不带账号密码 */
export function validChannelUrl(u: string): boolean {
  try {
    const x = new URL(u);
    return (x.protocol === 'https:' || x.protocol === 'http:') && !x.username && !x.password && x.hostname.length > 0;
  } catch {
    return false;
  }
}

export function normalizeConfig(raw: unknown): NudgeConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const ch = (r.channel && typeof r.channel === 'object' ? r.channel : {}) as Record<string, unknown>;
  const type = (['none', 'ntfy', 'bark', 'webhook'] as const).find((t) => t === ch.type) ?? 'none';
  const url = typeof ch.url === 'string' ? ch.url.trim().slice(0, 500) : '';
  const level = (['gentle', 'follow', 'strong'] as const).find((l) => l === r.level) ?? DEFAULT_CONFIG.level;
  return {
    enabled: r.enabled === true,
    level,
    intervalMin: clamp(r.intervalMin, 10, 240, DEFAULT_CONFIG.intervalMin),
    maxCount: level === 'gentle' ? 1 : clamp(r.maxCount, 1, 10, DEFAULT_CONFIG.maxCount),
    scope: r.scope === 'atHome' ? 'atHome' : 'all',
    quietStart: typeof r.quietStart === 'string' && HM.test(r.quietStart) ? r.quietStart : DEFAULT_CONFIG.quietStart,
    quietEnd: typeof r.quietEnd === 'string' && HM.test(r.quietEnd) ? r.quietEnd : DEFAULT_CONFIG.quietEnd,
    channel: type !== 'none' && validChannelUrl(url) ? { type, url } : { type: 'none', url: '' },
  };
}

export function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function freshState(now: Date): NudgeState {
  return { day: ymd(now), arrivedAt: null, sent: 0, lastSentAt: null, snoozed: false };
}

/** 是否在安静时段（支持跨午夜，如 23:30–08:00）；start == end 视为没有安静时段 */
export function inQuiet(now: Date, start: string, end: string): boolean {
  const m = now.getHours() * 60 + now.getMinutes();
  const toM = (s: string): number => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  const a = toM(start), b = toM(end);
  if (a === b) return false;
  return a < b ? m >= a && m < b : m >= a || m < b;
}

const PR: Record<string, number> = { high: 0, mid: 1, low: 2 };

/** 需要提醒的待办：承诺（非建议）、未完成、今天或更早到期；按优先级排 */
export function pendingForNudge(todos: TodoLike[], today: string, scope: NudgeConfig['scope']): TodoLike[] {
  return todos
    .filter((t) => t && !t.done && t.plan !== 'suggested' && (!t.dueDate || t.dueDate <= today))
    .filter((t) => scope === 'all' || t.atHome === true)
    .sort((a, b) => (PR[a.priority ?? 'mid'] ?? 1) - (PR[b.priority ?? 'mid'] ?? 1));
}

/** 这一刻该不该发（不含"有没有待办"以外的业务判断） */
export function shouldSend(cfg: NudgeConfig, st: NudgeState, pendingCount: number, now: Date): boolean {
  if (!cfg.enabled || st.snoozed || st.arrivedAt === null || pendingCount === 0) return false;
  if (st.day !== ymd(now)) return false;
  if (st.sent >= cfg.maxCount) return false;
  if (inQuiet(now, cfg.quietStart, cfg.quietEnd)) return false;
  if (st.lastSentAt !== null && now.getTime() - st.lastSentAt < cfg.intervalMin * 60_000) return false;
  return true;
}

/** 文案：中性、具体、只说一件事；最后一次说明之后不再打扰 */
export function composeMessage(cfg: NudgeConfig, sentSoFar: number, pending: TodoLike[]): NudgeMessage {
  const titles = pending.map((t) => String(t.title ?? '').slice(0, 40)).filter(Boolean);
  const first = titles[0] ?? '待办';
  const rest = titles.length > 1 ? `（还有${titles.slice(1, 3).map((s) => `「${s}」`).join('、')}${titles.length > 3 ? ` 等 ${titles.length - 1} 件` : ''}）` : '';
  const last = sentSoFar + 1 >= cfg.maxCount;
  const tail = last && cfg.maxCount > 1 ? '这是今天最后一次提醒。' : '';
  if (sentSoFar === 0) {
    return {
      title: '到家了',
      body: `今天还有 ${titles.length} 件没做。先做「${first}」，25 分钟就好？${rest}${tail ? ' ' + tail : ''}`,
      urgent: cfg.level === 'strong',
      todos: titles,
    };
  }
  return {
    title: '「' + first + '」还没动',
    body: `先开个头，10 分钟也算数。${rest}${tail ? ' ' + tail : ''}`,
    urgent: cfg.level === 'strong',
    todos: titles,
  };
}

/** 渠道 → 一个 HTTP 请求（纯函数，便于测试；投递由调用方 fetch） */
export function buildRequest(ch: NudgeConfig['channel'], msg: NudgeMessage): { url: string; init: { method: string; headers: Record<string, string>; body: string } } | null {
  if (ch.type === 'none' || !validChannelUrl(ch.url)) return null;
  const json = (url: string, body: unknown) => ({ url, init: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } });
  if (ch.type === 'ntfy') {
    // https://ntfy.sh/<topic> → POST 到服务根，JSON 里带 topic（中文标题不能放 HTTP 头）
    const u = new URL(ch.url);
    const parts = u.pathname.split('/').filter(Boolean);
    const topic = parts.pop();
    if (!topic) return null;
    const base = `${u.origin}/${parts.map((x) => x + '/').join('')}`;
    return json(base, { topic, title: msg.title, message: msg.body, priority: msg.urgent ? 5 : 4, tags: ['house'] });
  }
  if (ch.type === 'bark') {
    // https://api.day.app/<key>
    return json(ch.url, { title: msg.title, body: msg.body, group: 'Yours', level: msg.urgent ? 'critical' : 'timeSensitive', ...(msg.urgent ? { volume: 5 } : {}) });
  }
  return json(ch.url, { source: 'yours', kind: 'nudge', title: msg.title, body: msg.body, urgent: msg.urgent, todos: msg.todos });
}

export interface NudgeDeps {
  dataDir: string;
  getTodos: () => TodoLike[];
  /** 网页内投递（WS 广播） */
  broadcast: (msg: NudgeMessage & { type: 'nudge'; sent: number; max: number }) => void;
  /** 外部投递，默认全局 fetch */
  fetchImpl?: (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number }>;
  log?: (line: string) => void;
}

export class NudgeEngine {
  config: NudgeConfig = { ...DEFAULT_CONFIG };
  state: NudgeState = freshState(new Date());
  private deps: NudgeDeps;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: NudgeDeps) {
    this.deps = deps;
  }

  private get cfgFile(): string { return path.join(this.deps.dataDir, 'nudge.json'); }
  private get stateFile(): string { return path.join(this.deps.dataDir, 'nudge-state.json'); }

  async init(): Promise<void> {
    try { this.config = normalizeConfig(JSON.parse(await readFile(this.cfgFile, 'utf8'))); } catch { this.config = { ...DEFAULT_CONFIG }; }
    try {
      const s = JSON.parse(await readFile(this.stateFile, 'utf8')) as NudgeState;
      if (s && s.day === ymd(new Date())) this.state = { ...freshState(new Date()), ...s };
    } catch { /* 无状态 */ }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(new Date()), 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async persist(): Promise<void> {
    await mkdir(this.deps.dataDir, { recursive: true });
    await writeFile(this.stateFile, JSON.stringify(this.state) + '\n', 'utf8');
  }

  async setConfig(raw: unknown): Promise<NudgeConfig> {
    this.config = normalizeConfig(raw);
    await mkdir(this.deps.dataDir, { recursive: true });
    await writeFile(this.cfgFile, JSON.stringify(this.config, null, 2) + '\n', 'utf8');
    return this.config;
  }

  private rollover(now: Date): void {
    if (this.state.day !== ymd(now)) this.state = freshState(now);
  }

  pending(now: Date): TodoLike[] {
    return pendingForNudge(this.deps.getTodos(), ymd(now), this.config.scope);
  }

  /** 用户到家：重置今天的提醒计数，并立即判断一次 */
  async arrive(now: Date): Promise<{ pending: TodoLike[]; sent: boolean }> {
    this.rollover(now);
    this.state = { ...this.state, arrivedAt: now.getTime(), sent: 0, lastSentAt: null, snoozed: false };
    await this.persist();
    const sent = await this.tick(now);
    return { pending: this.pending(now), sent };
  }

  async snooze(now: Date): Promise<void> {
    this.rollover(now);
    this.state.snoozed = true;
    await this.persist();
  }

  /** 每分钟一次；返回这次是否发了 */
  async tick(now: Date): Promise<boolean> {
    this.rollover(now);
    const pending = this.pending(now);
    if (!shouldSend(this.config, this.state, pending.length, now)) return false;
    const msg = composeMessage(this.config, this.state.sent, pending);
    this.state.sent += 1;
    this.state.lastSentAt = now.getTime();
    await this.persist();
    await this.deliver(msg);
    return true;
  }

  /** 投递：网页内一定发；外部渠道失败只记日志 */
  async deliver(msg: NudgeMessage): Promise<{ external: 'skipped' | 'ok' | string }> {
    this.deps.broadcast({ type: 'nudge', ...msg, sent: this.state.sent, max: this.config.maxCount });
    const req = buildRequest(this.config.channel, msg);
    if (!req) return { external: 'skipped' };
    const f = this.deps.fetchImpl ?? ((url, init) => fetch(url, init));
    try {
      const r = await f(req.url, { ...req.init, signal: AbortSignal.timeout(8000) });
      if (!r.ok) {
        this.deps.log?.(`[nudge] 推送失败 HTTP ${r.status}`);
        return { external: `HTTP ${r.status}` };
      }
      return { external: 'ok' };
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      this.deps.log?.(`[nudge] 推送失败 ${m}`);
      return { external: m };
    }
  }

  /** 设置页的"发一条测试" */
  async test(): Promise<{ external: string }> {
    return this.deliver({ title: 'Yours 测试提醒', body: '能看到这条，说明提醒渠道接好了。', urgent: false, todos: [] });
  }

  summary(now: Date): { config: NudgeConfig; state: NudgeState; pending: number; quiet: boolean } {
    this.rollover(now);
    return { config: this.config, state: this.state, pending: this.pending(now).length, quiet: inQuiet(now, this.config.quietStart, this.config.quietEnd) };
  }
}
