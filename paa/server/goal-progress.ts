// ============================================================
// 目标自己会动：从数据里算目标进度（PRD v0.5）
// - weight：体重记录；saving：资产总额（折算成主币种）；habit：连续打卡天数；custom：手动填的当前值
// - 和"按时间应到的进度"比，给出 领先 / 正常 / 落后；按最近的速度估一个到达日期
// - spendingWeek：上周支出和前 4 周平均比，哪几类多花了
// 都是纯函数；数据由调用方从 LifeStore / AssetsStore 取
// ============================================================

import { ymd, weekStartOf } from './weekly.ts';

export interface GoalInput {
  id?: string;
  title?: string;
  type?: string;
  target?: number;
  unit?: string;
  startVal?: number | null;
  startDate?: string;
  endDate?: string;
  createdAt?: number;
  habitField?: string;
  status?: string;
  /** custom 目标：手动填的当前值 */
  current?: number;
}

export interface Point { date: string; value: number }

export interface GoalData {
  weights?: Array<{ date?: string; weight?: number }>;
  /** 资产总额序列（按日期升序，已折算到同一币种），最后一个点是"现在" */
  saving?: Point[];
  savingUnit?: string;
  /** 没接资产时的兜底：旧的 investments 合计 */
  investmentsTotal?: number;
  /** 习惯打卡字段 → 打卡日期列表 */
  habits?: Record<string, string[]>;
}

export type GoalStatus = 'done' | 'ahead' | 'on' | 'behind' | 'unknown';

export interface GoalProgress {
  goalId: string;
  source: string;
  cur: number | null;
  start: number | null;
  target: number;
  unit: string;
  /** 0 ~ 1.2 */
  pct: number | null;
  /** 按时间线性应到的进度 0 ~ 1 */
  expectedPct: number | null;
  status: GoalStatus;
  /** 每周朝目标方向前进多少（负数 = 在倒退） */
  pacePerWeek: number | null;
  /** 照最近速度，预计哪天到 */
  eta: string | null;
  /** 给人看的话：now = 现在到哪了；plan = 和计划比；eta = 照这个速度哪天到 */
  say?: { now: string; plan: string; eta: string };
}

const DAY = 86_400_000;
const r2 = (n: number): number => Math.round(n * 100) / 100;
const dayNum = (s: string): number => Date.parse(s + 'T00:00:00Z') / DAY;

/** 最小二乘斜率（每天变化量）；点数 < 2 或时间跨度 < minSpanDays 返回 null */
export function slopePerDay(pts: Point[], minSpanDays = 7): number | null {
  const xs = pts.map((p) => dayNum(p.date)).filter((x) => Number.isFinite(x));
  if (xs.length < 2 || xs.length !== pts.length) return null;
  if (Math.max(...xs) - Math.min(...xs) < minSpanDays) return null;
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = pts.reduce((a, p) => a + p.value, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (pts[i].value - my);
    den += (xs[i] - mx) ** 2;
  }
  return den > 0 ? num / den : null;
}

function addDaysStr(base: Date, n: number): string {
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  d.setDate(d.getDate() + Math.round(n));
  return ymd(d);
}

export function streak(dates: string[], now: Date): number {
  const set = new Set(dates);
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // 今天还没打卡不算断：从昨天开始数
  if (!set.has(ymd(d))) d.setDate(d.getDate() - 1);
  let n = 0;
  while (set.has(ymd(d))) { n++; d.setDate(d.getDate() - 1); }
  return n;
}

function startDay(g: GoalInput): string | null {
  if (g.startDate && /^\d{4}-\d{2}-\d{2}$/.test(g.startDate)) return g.startDate;
  if (typeof g.createdAt === 'number' && Number.isFinite(g.createdAt)) return ymd(new Date(g.createdAt));
  return null;
}

function expected(g: GoalInput, now: Date): number | null {
  const a = startDay(g), b = g.endDate;
  if (!a || !b || !/^\d{4}-\d{2}-\d{2}$/.test(b)) return null;
  const span = dayNum(b) - dayNum(a);
  if (!(span > 0)) return null;
  return Math.min(1, Math.max(0, (dayNum(ymd(now)) - dayNum(a)) / span));
}

function judge(pct: number | null, exp: number | null, trend?: { pace: number | null; eta: string | null; end?: string }): GoalStatus {
  if (pct === null) return 'unknown';
  if (pct >= 1) return 'done';
  if (exp === null) return 'unknown';
  // 照最近的速度到不了截止日（或在倒退）→ 落后，即使眼下的百分比还差不多
  if (trend && trend.pace !== null && trend.end && (trend.eta === null || trend.eta > trend.end) && exp > 0.05) return 'behind';
  if (pct >= exp + 0.05) return 'ahead';
  if (pct >= exp - 0.1) return 'on';
  return 'behind';
}

/** 起点 / 当前 / 目标 → 进度；方向自动判断（减重是往下，存钱是往上） */
function frac(start: number, cur: number, target: number): number | null {
  if (target === start) return cur === target ? 1 : null;
  return Math.min(1.2, Math.max(0, (cur - start) / (target - start)));
}

/** 用序列算速度和预计到达日（只看最近 windowDays 天） */
function paceAndEta(series: Point[], cur: number, target: number, start: number, now: Date, windowDays: number, minSpan: number): { pace: number | null; eta: string | null } {
  const from = ymd(new Date(now.getTime() - windowDays * DAY));
  const s = slopePerDay(series.filter((p) => p.date >= from), minSpan);
  if (s === null) return { pace: null, eta: null };
  const dir = Math.sign(target - start) || 1;
  const pace = r2(s * 7 * dir);
  const remain = (target - cur) * dir;
  if (remain <= 0) return { pace, eta: ymd(now) };
  if (s * dir <= 0) return { pace, eta: null };
  const days = remain / Math.abs(s);
  return { pace, eta: days <= 3 * 365 ? addDaysStr(now, days) : null };
}

function rawProgress(g: GoalInput, d: GoalData, now: Date): GoalProgress {
  const target = Number(g.target) || 0;
  const base: GoalProgress = { goalId: String(g.id ?? ''), source: '手动记录', cur: null, start: null, target, unit: g.unit ?? '', pct: null, expectedPct: expected(g, now), status: 'unknown', pacePerWeek: null, eta: null };
  const sd = startDay(g);

  if (g.type === 'weight') {
    const pts: Point[] = (d.weights ?? [])
      .filter((w) => w && typeof w.date === 'string' && Number.isFinite(Number(w.weight)) && Number(w.weight) > 0)
      .map((w) => ({ date: String(w.date), value: Number(w.weight) }))
      .sort((a, b) => a.date.localeCompare(b.date));
    if (!pts.length || !(target > 0)) return { ...base, source: '体重记录', unit: g.unit || 'kg' };
    const cur = pts[pts.length - 1].value;
    const start = g.startVal != null && Number(g.startVal) > 0 ? Number(g.startVal) : (pts.find((p) => !sd || p.date >= sd) ?? pts[0]).value;
    const pct = frac(start, cur, target);
    const { pace, eta } = paceAndEta(pts, cur, target, start, now, 28, 7);
    return { ...base, source: '体重记录', unit: g.unit || 'kg', cur, start, pct, status: judge(pct, base.expectedPct, { pace, eta, end: g.endDate }), pacePerWeek: pace, eta };
  }

  if (g.type === 'saving') {
    const series = (d.saving ?? []).filter((p) => Number.isFinite(p.value)).sort((a, b) => a.date.localeCompare(b.date));
    if (!(target > 0)) return { ...base, source: '资产总额' };
    if (!series.length) {
      // 没建资产账户：兜底用旧的「投资」记录合计，起点 0
      const cur = Number(d.investmentsTotal ?? 0);
      const pct = frac(0, cur, target);
      return { ...base, source: '投资记录', cur, start: 0, pct, status: judge(pct, base.expectedPct) };
    }
    const cur = series[series.length - 1].value;
    const before = sd ? series.filter((p) => p.date <= sd) : [];
    const start = g.startVal != null && Number.isFinite(Number(g.startVal)) ? Number(g.startVal) : (before.length ? before[before.length - 1] : series[0]).value;
    const pct = frac(start, cur, target);
    const { pace, eta } = paceAndEta(series, cur, target, start, now, 120, 20);
    return { ...base, source: '资产总额', unit: g.unit || d.savingUnit || '', cur: Math.round(cur), start: Math.round(start), pct, status: judge(pct, base.expectedPct, { pace, eta, end: g.endDate }), pacePerWeek: pace === null ? null : Math.round(pace), eta };
  }

  if (g.type === 'habit') {
    const field = g.habitField ?? '';
    const n = streak(d.habits?.[field] ?? [], now);
    const pct = target > 0 ? Math.min(1.2, n / target) : null;
    return { ...base, source: field ? '连续打卡' : '手动记录', unit: g.unit || '天', cur: n, start: 0, pct, status: pct !== null && pct >= 1 ? 'done' : 'unknown' };
  }

  // custom：手动填的当前值
  if (typeof g.current === 'number' && Number.isFinite(g.current)) {
    const start = g.startVal != null && Number.isFinite(Number(g.startVal)) ? Number(g.startVal) : 0;
    const pct = frac(start, g.current, target);
    return { ...base, cur: g.current, start, pct, status: judge(pct, base.expectedPct) };
  }
  return base;
}

// ---- 说人话 ----

export const CCY_SYM: Record<string, string> = { SGD: 'S$', USD: '$', CNY: '¥', HKD: 'HK$', EUR: '€', GBP: '£', JPY: '¥', AUD: 'A$', MYR: 'RM' };

/** 数值 + 单位：S$34,447 / 56.8 kg / 18 道 */
export function fmtVal(v: number, unit: string): string {
  const n = Math.abs(v) >= 1000 ? Math.round(v).toLocaleString('en-US') : Math.abs(v) < 1 ? String(Math.round(v * 100) / 100) : String(Math.round(v * 10) / 10);
  if (CCY_SYM[unit]) return (v < 0 ? '-' : '') + CCY_SYM[unit] + n.replace(/^-/, '');
  return unit ? `${n} ${unit}` : n;
}

/** 2026-11-27 → 11月27日；跨年带上年份 */
export function fmtDay(s: string, now: Date): string {
  const [y, m, d] = s.split('-').map(Number);
  return `${y !== now.getFullYear() ? y + '年' : ''}${m}月${d}日`;
}

function say(p: GoalProgress, g: GoalInput, now: Date): GoalProgress['say'] {
  if (p.pct === null || p.cur === null) return undefined;
  const u = p.unit, v = (x: number) => fmtVal(x, u);
  const kind = g.type ?? 'custom';
  if (p.status === 'done') return { now: `已经到了：${v(p.cur)}，目标是 ${v(p.target)}`, plan: '已达成', eta: '' };
  let nowS: string;
  if (kind === 'habit') nowS = `已经连续 ${p.cur} 天，目标 ${p.target} 天`;
  else if (kind === 'custom') nowS = `做到 ${Math.round(p.cur * 10) / 10} / ${v(p.target)}`;
  else nowS = `现在 ${v(p.cur)}，还差 ${v(Math.abs(p.target - p.cur))}`;
  let plan = '';
  if (p.status === 'on') plan = '进度正常';
  else if (p.status === 'ahead') plan = '比计划快';
  else if (p.status === 'behind') {
    plan = '比计划慢';
    if (p.expectedPct !== null && p.start !== null && kind !== 'habit') {
      const exp = p.start + (p.target - p.start) * p.expectedPct;
      plan += `，按截止日算，这时候该到 ${v(exp)} 左右`;
    }
  }
  let eta = '';
  if (p.pacePerWeek !== null) {
    const down = p.target < (p.start ?? p.target);
    const verb = kind === 'saving' ? (p.pacePerWeek >= 0 ? '多存' : '少了') : down ? (p.pacePerWeek >= 0 ? '减' : '涨') : (p.pacePerWeek >= 0 ? '增加' : '减少');
    const pace = `最近每周${verb} ${v(Math.abs(p.pacePerWeek))}`;
    if (p.pacePerWeek <= 0) eta = `${pace}，照这样到不了`;
    else if (p.eta) {
      const late = g.endDate && p.eta > g.endDate;
      eta = `${pace}，照这个速度${late ? '要到' : ''} ${fmtDay(p.eta, now)}${late ? ` 才能到，比截止日（${fmtDay(g.endDate!, now)}）晚` : ' 前后能到'}`;
    } else eta = `${pace}，照这个速度三年内到不了`;
  }
  return { now: nowS, plan, eta };
}

export function goalProgress(g: GoalInput, d: GoalData, now: Date): GoalProgress {
  const p = rawProgress(g, d, now);
  const s = say(p, g, now);
  return s ? { ...p, say: s } : p;
}

/** 给模型看的一句话 */
export function progressText(p: GoalProgress): string {
  if (!p.say) return '';
  return [`${p.source}：${p.say.now}`, p.say.plan, p.say.eta].filter(Boolean).join('；');
}

// ---- 支出：上周 vs 前 4 周平均 ----

export interface TxLike { date?: string; type?: string; amount?: number; category?: string }

export interface SpendingWeek {
  from: string;
  to: string;
  total: number;
  /** 前 4 周的周均；没有足够历史时为 null */
  avg: number | null;
  /** 比平时多花的类别（按多出的金额降序，最多 3 个） */
  up: Array<{ category: string; amount: number; avg: number; delta: number }>;
}

export function spendingWeek(txs: TxLike[], now: Date, weekStart = 1): SpendingWeek {
  const ws = weekStartOf(now, weekStart);
  const day = (n: number): string => { const x = new Date(ws); x.setDate(x.getDate() + n); return ymd(x); };
  const from = day(-7), to = day(-1), histFrom = day(-35), histTo = day(-8);
  const exp = txs.filter((t) => t && t.type === 'expense' && typeof t.date === 'string' && Number(t.amount) > 0);
  const last = exp.filter((t) => t.date! >= from && t.date! <= to);
  const hist = exp.filter((t) => t.date! >= histFrom && t.date! <= histTo);
  const sum = (a: TxLike[]): number => r2(a.reduce((s, t) => s + Number(t.amount), 0));
  const byCat = (a: TxLike[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const t of a) m.set(t.category || '其他', (m.get(t.category || '其他') ?? 0) + Number(t.amount));
    return m;
  };
  // 历史至少要有一笔在两周以前，才算有"平时"
  const hasHist = hist.some((t) => t.date! <= day(-15));
  const avg = hasHist ? r2(sum(hist) / 4) : null;
  const up: SpendingWeek['up'] = [];
  if (hasHist) {
    const lc = byCat(last), hc = byCat(hist);
    for (const [c, amt] of lc) {
      const a = r2((hc.get(c) ?? 0) / 4);
      const delta = r2(amt - a);
      if (delta > 0 && delta >= Math.max(10, a * 0.3)) up.push({ category: c, amount: r2(amt), avg: a, delta });
    }
    up.sort((a, b) => b.delta - a.delta);
  }
  return { from, to, total: sum(last), avg, up: up.slice(0, 3) };
}
