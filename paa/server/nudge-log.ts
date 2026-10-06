// ============================================================
// 提醒效果记录（PRD v0.5「学会怎么拉你」）
// - 每发一次提醒记一笔：什么时候、哪种、当时有哪些没做完的承诺
// - 结果自动判断：60 分钟内做完了其中一件 = done；改到了以后 = postponed；
//   点了「今天算了」= snoozed；点了「开始了」= started；都没有 = ignored
// - nudgeStats / nudgeInsights：按时段、星期、种类统计哪种提醒对你有用
// 纯函数，便于测试；存储在 NudgeEngine 里（data/nudge-log.json）
// ============================================================

import { ymd } from './weekly.ts';

export type NudgeKind = 'arrive' | 'follow' | 'evening' | 'checkin' | 'brief' | 'recap';
export type NudgeOutcome = 'done' | 'started' | 'postponed' | 'snoozed' | 'ignored';

export interface NudgeRecord {
  id: string;
  at: number;
  kind: NudgeKind;
  todoIds: string[];
  outcome?: NudgeOutcome;
  outcomeAt?: number;
}

export interface TodoState { id?: string; done?: boolean; dueDate?: string; plan?: string }

/** 这些种类不衡量效果（简报和回顾只是告诉你一声） */
export const UNTRACKED: NudgeKind[] = ['brief', 'recap'];
export const WINDOW_MIN = 60;
const WIN = WINDOW_MIN * 60_000;

/** 判断还没有结果的记录；返回是否有变化 */
export function resolveOutcomes(log: NudgeRecord[], todos: TodoState[], now: number): boolean {
  const byId = new Map(todos.filter((t) => t && t.id).map((t) => [String(t.id), t]));
  let changed = false;
  for (const r of log) {
    if (UNTRACKED.includes(r.kind)) continue;
    if (r.outcome && r.outcome !== 'started') continue;
    const age = now - r.at;
    const ts = r.todoIds.map((id) => byId.get(id)).filter((t): t is TodoState => !!t);
    const day = ymd(new Date(r.at));
    // 停机过久（超出窗口很多）才发现的完成不算这次提醒的功劳
    if (age <= WIN + 5 * 60_000 && ts.some((t) => t.done)) {
      r.outcome = 'done'; r.outcomeAt = now; changed = true; continue;
    }
    if (r.outcome === 'started') continue;
    const moved = (t: TodoState): boolean => !t.done && !!t.dueDate && t.dueDate > day;
    if (ts.some(moved) && ts.every((t) => t.done || moved(t))) {
      r.outcome = 'postponed'; r.outcomeAt = now; changed = true; continue;
    }
    if (age > WIN) { r.outcome = 'ignored'; r.outcomeAt = now; changed = true; }
  }
  return changed;
}

export type Slot = 'morning' | 'afternoon' | 'evening' | 'night';
const WD_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function slotOf(d: Date): Slot {
  const h = d.getHours();
  if (h >= 5 && h < 11) return 'morning';
  if (h >= 11 && h < 17) return 'afternoon';
  if (h >= 17 && h < 21) return 'evening';
  return 'night';
}

export interface Bucket { n: number; acted: number; postponed: number; snoozed: number }
const empty = (): Bucket => ({ n: 0, acted: 0, postponed: 0, snoozed: 0 });

export interface NudgeStats {
  days: number;
  total: Bucket;
  byKind: Partial<Record<NudgeKind, Bucket>>;
  bySlot: Partial<Record<Slot, Bucket>>;
  byWeekday: Record<string, Bucket>;
  /** 还在等结果的 */
  open: number;
}

/** 最近 days 天的提醒效果；acted = 做完了或点了开始 */
export function nudgeStats(log: NudgeRecord[], now: number, days = 28): NudgeStats {
  const since = now - days * 86_400_000;
  const s: NudgeStats = { days, total: empty(), byKind: {}, bySlot: {}, byWeekday: {}, open: 0 };
  for (const r of log) {
    if (r.at < since || UNTRACKED.includes(r.kind)) continue;
    if (!r.outcome) { s.open++; continue; }
    const d = new Date(r.at);
    const bs = [s.total, (s.byKind[r.kind] ??= empty()), (s.bySlot[slotOf(d)] ??= empty()), (s.byWeekday[WD_ZH[d.getDay()]] ??= empty())];
    for (const b of bs) {
      b.n++;
      if (r.outcome === 'done' || r.outcome === 'started') b.acted++;
      else if (r.outcome === 'postponed') b.postponed++;
      else if (r.outcome === 'snoozed') b.snoozed++;
    }
  }
  return s;
}

const times = (b: Bucket): string => (b.acted === b.n ? `${b.n} 次都去做了` : b.acted === 0 ? `${b.n} 次一次都没去做` : `${b.n} 次里有 ${b.acted} 次去做了`);
const SLOT_SAY: Record<Slot, string> = { morning: '上午', afternoon: '下午', evening: '傍晚', night: '晚上 9 点以后' };

/** 给人看、也给模型看的几句话；样本不够就直说 */
export function nudgeInsights(s: NudgeStats, minN = 3): string[] {
  if (s.total.n < 5) return [`提醒记录还太少（${s.total.n} 次），再用一两周才看得出哪种提醒对你管用。`];
  const out = [`最近四周提醒了你 ${s.total.n} 次，其中 ${s.total.acted} 次你在一小时内去做了。`];
  const ranked = (m: Partial<Record<string, Bucket>>) =>
    Object.entries(m).filter(([, b]) => b && b.n >= minN).map(([k, b]) => ({ k, b: b!, r: b!.acted / b!.n })).sort((a, b) => b.r - a.r);
  const slots = ranked(s.bySlot);
  if (slots.length >= 2 && slots[0].r - slots[slots.length - 1].r >= 0.25) {
    const hi = slots[0], lo = slots[slots.length - 1];
    out.push(`${SLOT_SAY[hi.k as Slot]}的提醒最管用，${times(hi.b)}；${SLOT_SAY[lo.k as Slot]}的提醒，${lo.b.acted ? `${lo.b.n} 次里只有 ${lo.b.acted} 次` : `${lo.b.n} 次都没起作用`}。`);
  }
  const bad = ranked(s.byWeekday).filter((w) => w.r === 0).map((w) => w.k);
  if (bad.length) out.push(`${bad.join('、')}的提醒一次都没起作用。`);
  const fol = s.byKind.follow;
  if (fol && fol.n >= minN && fol.acted / fol.n < 0.15) out.push(`第一次提醒之后的跟进提醒，${fol.acted ? `${fol.n} 次里只有 ${fol.acted} 次有用` : `${fol.n} 次都没用`}，可以考虑少发几次。`);
  const ck = s.byKind.checkin;
  if (ck && ck.n >= minN) out.push(`你在对话里约的回访，${times(ck)}。`);
  if (s.total.snoozed >= Math.max(3, s.total.n * 0.4)) out.push(`「今天算了」点了 ${s.total.snoozed} 次，可能是提醒太多，或者一天排得太满。`);
  return out;
}
