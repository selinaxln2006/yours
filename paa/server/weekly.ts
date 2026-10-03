// ============================================================
// 周复盘与对话上下文（PRD v0.3）
// - weeklyStats：上周（周一~周日）承诺完成度，按目标拆开；本周已有建议
// - buildContext：每轮对话前注入给模型的"现状"（时间、今天的承诺/建议、目标进度、上周完成度）
// 都是纯函数，便于测试；数据来自 LifeStore 的 todos / goals
// ============================================================

export interface TodoLike {
  id?: string;
  title?: string;
  done?: boolean;
  doneAt?: number;
  dueDate?: string;
  plan?: string;
  goalId?: string;
  atHome?: boolean;
  priority?: string;
}

export interface GoalLike {
  id?: string;
  title?: string;
  status?: string;
  endDate?: string;
  type?: string;
  target?: number;
  unit?: string;
}

export const ymd = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** 本周一（本地时间）；weekStart: 1=周一 … 0=周日 */
export function weekStartOf(now: Date, weekStart = 1): Date {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const back = (d.getDay() - weekStart + 7) % 7;
  d.setDate(d.getDate() - back);
  return d;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

export interface GoalWeek {
  goalId: string;
  title: string;
  lastWeek: { committed: number; done: number };
  thisWeek: { committed: number; done: number; suggested: number };
}

export interface WeeklyStats {
  lastWeek: { from: string; to: string; committed: number; done: number; rate: number | null };
  thisWeek: { from: string; to: string };
  goals: GoalWeek[];
  /** 没挂目标的承诺 */
  other: { lastWeek: { committed: number; done: number } };
}

const inRange = (d: string | undefined, a: string, b: string): boolean => !!d && d >= a && d <= b;
const committed = (t: TodoLike): boolean => t.plan !== 'suggested';

export function weeklyStats(todos: TodoLike[], goals: GoalLike[], now: Date, weekStart = 1): WeeklyStats {
  const ws = weekStartOf(now, weekStart);
  const lwFrom = ymd(addDays(ws, -7)), lwTo = ymd(addDays(ws, -1));
  const twFrom = ymd(ws), twTo = ymd(addDays(ws, 6));
  const lw = todos.filter((t) => committed(t) && inRange(t.dueDate, lwFrom, lwTo));
  const tw = todos.filter((t) => inRange(t.dueDate, twFrom, twTo));
  const active = goals.filter((g) => g.id && g.status !== 'done');
  const goalRows: GoalWeek[] = active.map((g) => ({
    goalId: String(g.id),
    title: String(g.title ?? ''),
    lastWeek: {
      committed: lw.filter((t) => t.goalId === g.id).length,
      done: lw.filter((t) => t.goalId === g.id && t.done).length,
    },
    thisWeek: {
      committed: tw.filter((t) => t.goalId === g.id && committed(t)).length,
      done: tw.filter((t) => t.goalId === g.id && committed(t) && t.done).length,
      suggested: tw.filter((t) => t.goalId === g.id && t.plan === 'suggested' && !t.done).length,
    },
  }));
  const ids = new Set(active.map((g) => g.id));
  const other = lw.filter((t) => !t.goalId || !ids.has(t.goalId));
  const doneN = lw.filter((t) => t.done).length;
  return {
    lastWeek: { from: lwFrom, to: lwTo, committed: lw.length, done: doneN, rate: lw.length ? doneN / lw.length : null },
    thisWeek: { from: twFrom, to: twTo },
    goals: goalRows,
    other: { lastWeek: { committed: other.length, done: other.filter((t) => t.done).length } },
  };
}

const WD = ['日', '一', '二', '三', '四', '五', '六'];

/** 每轮对话前注入的现状块：简短、事实性，不含历史流水 */
export function buildContext(todos: TodoLike[], goals: GoalLike[], now: Date, extra: string[] = []): string {
  const t = ymd(now);
  const hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const due = todos.filter((x) => committed(x) && !x.done && (!x.dueDate || x.dueDate <= t));
  const doneToday = todos.filter((x) => committed(x) && x.done && x.dueDate === t);
  const sug = todos.filter((x) => x.plan === 'suggested' && !x.done && x.dueDate === t);
  const st = weeklyStats(todos, goals, now);
  const goalTitle = new Map(goals.map((g) => [g.id, g.title]));
  const lines: string[] = [];
  lines.push(`现在：${t}（周${WD[now.getDay()]}）${hm}`);
  lines.push(
    `今天的承诺：${due.length ? due.slice(0, 8).map((x) => `「${x.title}」${x.dueDate && x.dueDate < t ? '（逾期）' : ''}${x.atHome ? '（到家后）' : ''}`).join('、') : '没有未完成的'}` +
      (doneToday.length ? `；已完成 ${doneToday.length} 件` : ''),
  );
  if (sug.length) lines.push(`今天的建议（还没被采纳）：${sug.slice(0, 5).map((x) => `「${x.title}」${x.goalId && goalTitle.get(x.goalId) ? `←${goalTitle.get(x.goalId)}` : ''}`).join('、')}`);
  if (st.goals.length) {
    lines.push('进行中的目标：');
    for (const g of st.goals.slice(0, 6)) {
      lines.push(`- ${g.title}（id ${g.goalId}）：本周承诺 ${g.thisWeek.committed} 完成 ${g.thisWeek.done}，待采纳建议 ${g.thisWeek.suggested}；上周 ${g.lastWeek.done}/${g.lastWeek.committed}`);
    }
  }
  if (st.lastWeek.rate !== null) lines.push(`上周承诺完成率：${Math.round(st.lastWeek.rate * 100)}%（${st.lastWeek.done}/${st.lastWeek.committed}）`);
  lines.push(...extra);
  return '\n\n# 现状（每轮自动更新，以此为准）\n' + lines.join('\n');
}
