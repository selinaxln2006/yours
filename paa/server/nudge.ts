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
import { resolveOutcomes, nudgeStats, nudgeInsights, type NudgeKind, type NudgeOutcome, type NudgeRecord, type NudgeStats } from './nudge-log.ts';

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
  /** 到家后先等几分钟再问（给你一点缓冲；0 = 立刻） */
  homeDelayMin: number;
  /** 晚间检查：到这个时间还有没完成的承诺就问一句（'' = 不检查） */
  eveningAt: string;
  /** 早间简报：到这个时间推一条"今天要做什么"（'' = 不发） */
  briefAt: string;
  channel: { type: ChannelType; url: string };
}

/** 对话里约好的回访（"我先躺会儿" → 30 分钟后问一句） */
export interface Checkin {
  id: string;
  dueAt: number;
  message: string;
  createdAt: number;
}

export interface NudgeState {
  day: string; // YYYY-MM-DD，跨天自动清零
  arrivedAt: number | null;
  sent: number;
  lastSentAt: number | null;
  snoozed: boolean;
  eveningSent?: boolean;
  briefSent?: boolean;
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
  /** 种类和记录 id（网页卡片用来回报结果） */
  kind?: NudgeKind;
  id?: string;
  /** 只在网页里显示的补充（如今天的日程），不发到手机渠道 */
  detail?: string[];
}

export const DEFAULT_CONFIG: NudgeConfig = {
  enabled: false,
  level: 'follow',
  intervalMin: 45,
  maxCount: 3,
  scope: 'all',
  quietStart: '00:30',
  quietEnd: '08:00',
  homeDelayMin: 15,
  eveningAt: '',
  briefAt: '',
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
    homeDelayMin: clamp(r.homeDelayMin, 0, 120, DEFAULT_CONFIG.homeDelayMin),
    eveningAt: typeof r.eveningAt === 'string' && HM.test(r.eveningAt) ? r.eveningAt : '',
    briefAt: typeof r.briefAt === 'string' && HM.test(r.briefAt) ? r.briefAt : '',
    channel: type !== 'none' && validChannelUrl(url) ? { type, url } : { type: 'none', url: '' },
  };
}

export function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function freshState(now: Date): NudgeState {
  return { day: ymd(now), arrivedAt: null, sent: 0, lastSentAt: null, snoozed: false, eveningSent: false, briefSent: false };
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
  if (st.sent === 0 && now.getTime() - st.arrivedAt < cfg.homeDelayMin * 60_000) return false;
  if (st.lastSentAt !== null && now.getTime() - st.lastSentAt < cfg.intervalMin * 60_000) return false;
  return true;
}

/** 晚间检查：开着、到点、今天没发过、没"今天算了"、有没完成的承诺、不在安静时段 */
export function shouldEvening(cfg: NudgeConfig, st: NudgeState, pendingCount: number, now: Date): boolean {
  if (!cfg.enabled || !cfg.eveningAt || st.snoozed || st.eveningSent || pendingCount === 0) return false;
  if (st.day !== ymd(now)) return false;
  if (inQuiet(now, cfg.quietStart, cfg.quietEnd)) return false;
  const m = now.getHours() * 60 + now.getMinutes();
  const at = Number(cfg.eveningAt.slice(0, 2)) * 60 + Number(cfg.eveningAt.slice(3, 5));
  return m >= at;
}

const minutesOf = (hm: string): number => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));

/** 晚间回顾：到了晚间时间，但没有要催的（都做完了 / 点过今天算了）→ 只问一句今天怎么样 */
export function shouldRecap(cfg: NudgeConfig, st: NudgeState, pendingCount: number, now: Date): boolean {
  if (!cfg.enabled || !cfg.eveningAt || st.eveningSent) return false;
  if (pendingCount > 0 && !st.snoozed) return false;
  if (st.day !== ymd(now)) return false;
  if (inQuiet(now, cfg.quietStart, cfg.quietEnd)) return false;
  return now.getHours() * 60 + now.getMinutes() >= minutesOf(cfg.eveningAt);
}

export function recapMessage(doneToday: number): NudgeMessage {
  return {
    title: '今天怎么样',
    body: (doneToday ? `今天的 ${doneToday} 件都做完了。` : '') + '一句话回顾一下今天？',
    urgent: false,
    todos: [],
    kind: 'recap',
  };
}

/** 早间简报：开着、到点后 3 小时内、今天没发过、不在安静时段 */
export function shouldBrief(cfg: NudgeConfig, st: NudgeState, now: Date): boolean {
  if (!cfg.enabled || !cfg.briefAt || st.briefSent) return false;
  if (st.day !== ymd(now)) return false;
  if (inQuiet(now, cfg.quietStart, cfg.quietEnd)) return false;
  const m = now.getHours() * 60 + now.getMinutes(), at = minutesOf(cfg.briefAt);
  return m >= at && m < at + 180;
}

/** 简报正文只含待办标题和日程条数；日程内容放 detail（只在网页里显示） */
export function briefMessage(todos: TodoLike[], today: string, events: string[] = []): NudgeMessage {
  const open = todos.filter((t) => t && !t.done);
  const committed = open.filter((t) => t.plan !== 'suggested');
  const todayC = pendingForNudge(committed.filter((t) => !t.dueDate || t.dueDate === today), today, 'all');
  const overdue = committed.filter((t) => t.dueDate && t.dueDate < today);
  const sug = open.filter((t) => t.plan === 'suggested' && t.dueDate === today);
  const q = (xs: TodoLike[], n: number): string => xs.slice(0, n).map((t) => `「${String(t.title ?? '').slice(0, 30)}」`).join('');
  const parts: string[] = [];
  parts.push(todayC.length ? `今天 ${todayC.length} 件承诺：${q(todayC, 3)}${todayC.length > 3 ? ' 等' : ''}。` : '今天还没有承诺。');
  if (overdue.length) parts.push(`之前还剩 ${overdue.length} 件没做（${q(overdue, 1)}）。`);
  if (sug.length) parts.push(`有 ${sug.length} 条建议可以挑，点 + 加入。`);
  else if (!todayC.length) parts.push('要不要和 Yours 聊聊今天做什么？');
  if (events.length) parts.push(`日程 ${events.length} 项。`);
  return {
    title: '今天',
    body: parts.join(''),
    urgent: false,
    todos: [...todayC, ...overdue].map((t) => String(t.title ?? '')).filter(Boolean).slice(0, 5),
    kind: 'brief',
    detail: events.slice(0, 8),
  };
}

export function eveningMessage(pending: TodoLike[]): NudgeMessage {
  const titles = pending.map((t) => String(t.title ?? '').slice(0, 40)).filter(Boolean);
  return {
    title: '今天还剩 ' + titles.length + ' 件',
    body: `「${titles[0] ?? ''}」${titles.length > 1 ? ` 等 ${titles.length} 件` : ''}还没做。现在做一件，还是挪到明天？`,
    urgent: false,
    todos: titles,
    kind: 'evening',
  };
}

/** 到期、且不在安静时段的回访（安静时段里到期的，等安静时段结束再发） */
export function dueCheckins(list: Checkin[], cfg: NudgeConfig, now: Date): Checkin[] {
  if (inQuiet(now, cfg.quietStart, cfg.quietEnd)) return [];
  return list.filter((c) => c.dueAt <= now.getTime());
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
      kind: 'arrive',
    };
  }
  return {
    title: '「' + first + '」还没动',
    body: `先开个头，10 分钟也算数。${rest}${tail ? ' ' + tail : ''}`,
    urgent: cfg.level === 'strong',
    todos: titles,
    kind: 'follow',
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
  /** 今天的日程（"14:00 组会"），早间简报用；只在网页里显示 */
  todayEvents?: (now: Date) => Promise<string[]>;
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
  private get checkinFile(): string { return path.join(this.deps.dataDir, 'nudge-checkins.json'); }
  private get logFile(): string { return path.join(this.deps.dataDir, 'nudge-log.json'); }
  checkins: Checkin[] = [];
  /** 提醒效果记录（最多 500 条） */
  log: NudgeRecord[] = [];

  async init(): Promise<void> {
    try { this.config = normalizeConfig(JSON.parse(await readFile(this.cfgFile, 'utf8'))); } catch { this.config = { ...DEFAULT_CONFIG }; }
    try {
      const s = JSON.parse(await readFile(this.stateFile, 'utf8')) as NudgeState;
      if (s && s.day === ymd(new Date())) this.state = { ...freshState(new Date()), ...s };
    } catch { /* 无状态 */ }
    try {
      const c = JSON.parse(await readFile(this.checkinFile, 'utf8')) as Checkin[];
      // 过期超过 12 小时的回访不再补发
      if (Array.isArray(c)) this.checkins = c.filter((x) => x && typeof x.dueAt === 'number' && Date.now() - x.dueAt < 12 * 3600_000);
    } catch { /* 无回访 */ }
    try {
      const l = JSON.parse(await readFile(this.logFile, 'utf8')) as NudgeRecord[];
      if (Array.isArray(l)) this.log = l.filter((r) => r && typeof r.id === 'string' && typeof r.at === 'number' && Array.isArray(r.todoIds));
    } catch { /* 无记录 */ }
  }

  private async saveLog(): Promise<void> {
    await mkdir(this.deps.dataDir, { recursive: true });
    await writeFile(this.logFile, JSON.stringify(this.log) + '\n', 'utf8');
  }

  /** 网页卡片回报：开始了 / 挪到明天 / 今天算了 */
  async setOutcome(id: string, outcome: NudgeOutcome, now = Date.now()): Promise<boolean> {
    const r = this.log.find((x) => x.id === id);
    if (!r || (r.outcome && r.outcome !== 'started' && r.outcome !== 'ignored')) return false;
    r.outcome = outcome;
    r.outcomeAt = now;
    await this.saveLog();
    return true;
  }

  stats(now = Date.now(), days = 28): NudgeStats & { insights: string[] } {
    const s = nudgeStats(this.log, now, days);
    return { ...s, insights: nudgeInsights(s) };
  }

  private async saveCheckins(): Promise<void> {
    await mkdir(this.deps.dataDir, { recursive: true });
    await writeFile(this.checkinFile, JSON.stringify(this.checkins) + '\n', 'utf8');
  }

  /** 约一个回访：afterMin 分钟后按 message 问一句（最多同时 10 个） */
  async scheduleCheckin(afterMin: number, message: string, now: Date): Promise<Checkin> {
    const min = Math.min(720, Math.max(1, Math.round(Number(afterMin) || 30)));
    const msg = String(message ?? '').trim().slice(0, 200) || '说好的回访：现在怎么样了？';
    const c: Checkin = { id: Math.random().toString(36).slice(2, 10), dueAt: now.getTime() + min * 60_000, message: msg, createdAt: now.getTime() };
    this.checkins = [...this.checkins, c].sort((a, b) => a.dueAt - b.dueAt).slice(-10);
    await this.saveCheckins();
    return c;
  }

  async cancelCheckin(id: string): Promise<boolean> {
    const n = this.checkins.length;
    this.checkins = this.checkins.filter((c) => c.id !== id);
    if (this.checkins.length !== n) await this.saveCheckins();
    return this.checkins.length !== n;
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
    // 今天还在等结果的提醒，都记成"今天算了"
    let changed = false;
    for (const r of this.log) {
      if (!r.outcome && ymd(new Date(r.at)) === ymd(now) && r.kind !== 'brief' && r.kind !== 'recap') { r.outcome = 'snoozed'; r.outcomeAt = now.getTime(); changed = true; }
    }
    if (changed) await this.saveLog();
  }

  /** 每分钟一次；返回这次是否发了 */
  async tick(now: Date): Promise<boolean> {
    this.rollover(now);
    if (resolveOutcomes(this.log, this.deps.getTodos(), now.getTime())) await this.saveLog();
    // 对话里约好的回访：用户自己要求的，不受总开关限制（只受安静时段）
    const due = dueCheckins(this.checkins, this.config, now);
    if (due.length) {
      const ids = new Set(due.map((c) => c.id));
      this.checkins = this.checkins.filter((c) => !ids.has(c.id));
      await this.saveCheckins();
      const p = this.pending(now);
      for (const c of due) await this.deliver({ title: '回访', body: c.message, urgent: false, todos: p.map((x) => String(x.title ?? '')).slice(0, 5), kind: 'checkin' }, p, now.getTime());
    }
    if (shouldBrief(this.config, this.state, now)) {
      this.state.briefSent = true;
      await this.persist();
      let events: string[] = [];
      try { events = (await this.deps.todayEvents?.(now)) ?? []; } catch { /* 日程读不到就不带 */ }
      await this.deliver(briefMessage(this.deps.getTodos(), ymd(now), events), [], now.getTime());
      return true;
    }
    const pending = this.pending(now);
    if (shouldEvening(this.config, this.state, pending.length, now)) {
      this.state.eveningSent = true;
      await this.persist();
      await this.deliver(eveningMessage(pending), pending, now.getTime());
      return true;
    }
    if (shouldRecap(this.config, this.state, pending.length, now)) {
      this.state.eveningSent = true;
      await this.persist();
      const today = ymd(now);
      const doneToday = this.deps.getTodos().filter((t) => t && t.done && t.plan !== 'suggested' && t.dueDate === today).length;
      await this.deliver(recapMessage(doneToday), [], now.getTime());
      return true;
    }
    if (!shouldSend(this.config, this.state, pending.length, now)) return false;
    const msg = composeMessage(this.config, this.state.sent, pending);
    this.state.sent += 1;
    this.state.lastSentAt = now.getTime();
    await this.persist();
    await this.deliver(msg, pending, now.getTime());
    return true;
  }

  /** 投递：网页内一定发；外部渠道失败只记日志。带 kind 的提醒记进效果记录 */
  async deliver(msg: NudgeMessage, pending: TodoLike[] = [], at = Date.now()): Promise<{ external: 'skipped' | 'ok' | string }> {
    if (msg.kind) {
      const rec: NudgeRecord = { id: Math.random().toString(36).slice(2, 10), at, kind: msg.kind, todoIds: pending.map((t) => String(t.id ?? '')).filter(Boolean).slice(0, 20) };
      this.log = [...this.log, rec].slice(-500);
      msg = { ...msg, id: rec.id };
      await this.saveLog();
    }
    this.deps.broadcast({ type: 'nudge', ...msg, sent: this.state.sent, max: this.config.maxCount });
    const { detail: _web, ...ext } = msg;
    const req = buildRequest(this.config.channel, ext);
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

  summary(now: Date): { config: NudgeConfig; state: NudgeState; pending: number; quiet: boolean; checkins: Checkin[] } {
    this.rollover(now);
    return { config: this.config, state: this.state, pending: this.pending(now).length, quiet: inQuiet(now, this.config.quietStart, this.config.quietEnd), checkins: this.checkins };
  }
}
