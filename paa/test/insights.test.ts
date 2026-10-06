// v0.5：早间简报 / 晚间回顾 / 提醒效果记录 / 目标进度 / 支出对比 / 日程展开 / 回顾日记
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  normalizeConfig, freshState, shouldBrief, briefMessage, shouldRecap, recapMessage, buildRequest, ymd,
  NudgeEngine, DEFAULT_CONFIG, type NudgeConfig, type TodoLike,
} from '../server/nudge.ts';
import { resolveOutcomes, nudgeStats, nudgeInsights, slotOf, type NudgeRecord } from '../server/nudge-log.ts';
import { goalProgress, progressText, slopePerDay, spendingWeek, streak } from '../server/goal-progress.ts';
import { occursOn, scheduleLines, buildContext } from '../server/weekly.ts';
import { JournalStore, normalizeEntry, upsertEntry } from '../server/journal.ts';

const at = (h: number, m = 0, day = 2): Date => new Date(2026, 9, day, h, m);
const on = (over: Partial<NudgeConfig> = {}): NudgeConfig => normalizeConfig({ ...DEFAULT_CONFIG, enabled: true, homeDelayMin: 0, quietStart: '00:30', quietEnd: '07:00', ...over });

test('早间简报：到点后 3 小时内、今天没发过才发；没设时间 / 关掉不发', () => {
  const st = freshState(at(8));
  assert.ok(shouldBrief(on({ briefAt: '08:30' }), st, at(8, 30)));
  assert.ok(!shouldBrief(on({ briefAt: '08:30' }), st, at(8, 29)));
  assert.ok(!shouldBrief(on({ briefAt: '08:30' }), st, at(11, 31)), '过了 3 小时就不补发');
  assert.ok(!shouldBrief(on({ briefAt: '08:30' }), { ...st, briefSent: true }, at(9)));
  assert.ok(!shouldBrief(on({ briefAt: '' }), st, at(9)));
  assert.ok(!shouldBrief(on({ briefAt: '08:30', enabled: false }), st, at(9)));
  assert.equal(normalizeConfig({ briefAt: '8am' }).briefAt, '');
});

test('简报内容：今天的承诺、逾期、建议数；日程只在网页里，推送只带条数', () => {
  const today = ymd(at(8));
  const todos: TodoLike[] = [
    { id: 'a', title: '写报告', dueDate: today, priority: 'low' },
    { id: 'b', title: '复习', dueDate: today, priority: 'high' },
    { id: 'c', title: '投简历', dueDate: '2026-10-01' },
    { id: 'd', title: '读论文', dueDate: today, plan: 'suggested' },
    { id: 'e', title: '已完成', dueDate: today, done: true },
  ];
  const m = briefMessage(todos, today, ['10:00 概率论', '15:00 组会']);
  assert.equal(m.kind, 'brief');
  assert.match(m.body, /今天 2 件承诺：「复习」「写报告」/);
  assert.match(m.body, /之前还剩 1 件没做（「投简历」）/);
  assert.match(m.body, /有 1 条建议/);
  assert.match(m.body, /日程 2 项/);
  assert.doesNotMatch(m.body, /组会/);
  assert.deepEqual(m.detail, ['10:00 概率论', '15:00 组会']);
  const req = buildRequest({ type: 'webhook', url: 'https://example.com/h' }, m);
  assert.ok(req);
  const empty = briefMessage([], today);
  assert.match(empty.body, /今天还没有承诺。要不要和 Yours 聊聊/);
});

test('晚间回顾：都做完了 / 点过今天算了 → 问一句今天怎么样；还有没做完的交给晚间检查', () => {
  const st = freshState(at(21));
  const cfg = on({ eveningAt: '21:00' });
  assert.ok(shouldRecap(cfg, st, 0, at(21, 5)));
  assert.ok(!shouldRecap(cfg, st, 2, at(21, 5)));
  assert.ok(shouldRecap(cfg, { ...st, snoozed: true }, 2, at(21, 5)));
  assert.ok(!shouldRecap(cfg, { ...st, eveningSent: true }, 0, at(21, 5)));
  assert.ok(!shouldRecap(cfg, st, 0, at(20, 59)));
  assert.match(recapMessage(3).body, /今天的 3 件都做完了。一句话回顾/);
  assert.equal(recapMessage(0).body, '一句话回顾一下今天？');
});

test('效果记录：60 分钟内做完 = done；改到以后 = postponed；超时 = ignored；简报不算', () => {
  const t0 = at(19).getTime();
  const log: NudgeRecord[] = [
    { id: '1', at: t0, kind: 'arrive', todoIds: ['a', 'b'] },
    { id: '2', at: t0, kind: 'evening', todoIds: ['c'] },
    { id: '3', at: t0, kind: 'follow', todoIds: ['d'] },
    { id: '4', at: t0, kind: 'brief', todoIds: [] },
    { id: '5', at: t0, kind: 'checkin', todoIds: ['a'], outcome: 'started' },
  ];
  const todos = [{ id: 'a', done: true }, { id: 'b' }, { id: 'c', dueDate: '2026-10-03' }, { id: 'd', dueDate: '2026-10-02' }];
  assert.ok(resolveOutcomes(log, todos, t0 + 20 * 60_000));
  assert.equal(log[0].outcome, 'done');
  assert.equal(log[1].outcome, 'postponed');
  assert.equal(log[2].outcome, undefined, '还在窗口内，先不下结论');
  assert.equal(log[3].outcome, undefined);
  assert.equal(log[4].outcome, 'done', '点了开始、后来又做完 → 升级成 done');
  resolveOutcomes(log, todos, t0 + 61 * 60_000);
  assert.equal(log[2].outcome, 'ignored');
  // 停机很久之后才发现做完了：不算这次提醒的功劳
  const late: NudgeRecord[] = [{ id: 'x', at: t0, kind: 'arrive', todoIds: ['a'] }];
  resolveOutcomes(late, todos, t0 + 5 * 3600_000);
  assert.equal(late[0].outcome, 'ignored');
});

test('效果统计：按时段 / 星期 / 种类；样本少就说看不出来', () => {
  const now = at(12, 0, 28).getTime();
  assert.match(nudgeInsights(nudgeStats([], now))[0], /还看不出规律/);
  const log: NudgeRecord[] = [];
  for (let d = 1; d <= 8; d++) {
    log.push({ id: `e${d}`, at: at(18, 30, d).getTime(), kind: 'arrive', todoIds: [], outcome: d % 4 ? 'done' : 'ignored' });
    log.push({ id: `n${d}`, at: at(22, 15, d).getTime(), kind: 'follow', todoIds: [], outcome: 'ignored' });
  }
  log.push({ id: 's', at: at(22, 15, 9).getTime(), kind: 'follow', todoIds: [], outcome: 'snoozed' });
  log.push({ id: 'b', at: at(8, 0, 9).getTime(), kind: 'brief', todoIds: [] });
  log.push({ id: 'o', at: at(11, 0, 28).getTime(), kind: 'arrive', todoIds: [] });
  const s = nudgeStats(log, now);
  assert.equal(s.total.n, 17);
  assert.equal(s.total.acted, 6);
  assert.equal(s.open, 1);
  assert.equal(s.bySlot.evening?.n, 8);
  assert.equal(slotOf(at(22)), 'night');
  const ins = nudgeInsights(s);
  assert.match(ins[0], /提醒 17 次，之后 1 小时内动手的 6 次（35%）/);
  assert.ok(ins.some((x) => /傍晚（17–21 点）的提醒最管用（6\/8），晚上（21 点后）的基本没用（0\/9）/.test(x)), ins.join('\n'));
  assert.ok(ins.some((x) => /跟进提醒很少起作用/.test(x)));
});

test('NudgeEngine：发提醒时记一笔、卡片回报结果、今天算了批量记 snoozed、记录落盘', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'paa-nlog-'));
  const today = ymd(new Date());
  const todos: TodoLike[] = [{ id: 'a', title: '写报告', dueDate: today }];
  const got: Array<{ kind?: string; id?: string; detail?: string[] }> = [];
  const sent: string[] = [];
  const e = new NudgeEngine({
    dataDir: dir, getTodos: () => todos, broadcast: (m) => got.push(m),
    fetchImpl: async (_u, init) => { sent.push(init.body); return { ok: true, status: 200 }; },
    todayEvents: async () => ['15:00 组会'],
  });
  await e.init();
  await e.setConfig({ enabled: true, homeDelayMin: 0, briefAt: '08:00', quietStart: '00:00', quietEnd: '00:00', channel: { type: 'webhook', url: 'https://example.com/h' } });
  const t8 = new Date(); t8.setHours(8, 5, 0, 0);
  assert.equal(await e.tick(t8), true);
  assert.equal(got[0].kind, 'brief');
  assert.deepEqual(got[0].detail, ['15:00 组会']);
  assert.doesNotMatch(sent[0], /组会/, '日程内容不发到外部渠道');
  const t19 = new Date(); t19.setHours(19, 0, 0, 0);
  await e.arrive(t19);
  const rec = got[1];
  assert.equal(rec.kind, 'arrive');
  assert.ok(rec.id);
  assert.equal(e.log.find((r) => r.id === rec.id)?.todoIds[0], 'a');
  assert.equal(await e.setOutcome(rec.id!, 'started', t19.getTime()), true);
  await e.tick(new Date(t19.getTime() + 45 * 60_000)); // 跟进
  await e.snooze(new Date(t19.getTime() + 50 * 60_000));
  assert.equal(e.log.filter((r) => r.outcome === 'snoozed').length, 1);
  const e2 = new NudgeEngine({ dataDir: dir, getTodos: () => todos, broadcast: () => {} });
  await e2.init();
  assert.equal(e2.log.length, 3);
  assert.equal(e2.stats().total.n, 2);
});

test('目标进度：体重（方向自动）、速度、预计到达、落后判断', () => {
  const now = new Date(2026, 9, 30);
  const g = { id: 'w', type: 'weight', target: 55, startDate: '2026-10-01', endDate: '2026-12-30' };
  const weights = [{ date: '2026-10-01', weight: 58 }, { date: '2026-10-09', weight: 57.6 }, { date: '2026-10-16', weight: 57.4 }, { date: '2026-10-23', weight: 57.1 }, { date: '2026-10-30', weight: 56.8 }];
  const p = goalProgress(g, { weights }, now);
  assert.equal(p.start, 58);
  assert.equal(p.cur, 56.8);
  assert.equal(Math.round(p.pct! * 100), 40);
  assert.equal(Math.round(p.expectedPct! * 100), 32);
  assert.equal(p.status, 'ahead');
  assert.ok(p.pacePerWeek! > 0.2 && p.pacePerWeek! < 0.4, String(p.pacePerWeek));
  assert.ok(p.eta && p.eta > '2026-11-30' && p.eta < '2027-01-31', String(p.eta));
  assert.match(progressText(p), /体重记录 56.8kg，目标 55kg，进度 40%，按时间应到 32%，领先于计划，最近每周前进/);
  // 增重目标方向反过来
  const up = goalProgress({ id: 'u', type: 'weight', target: 60, startVal: 50 }, { weights: [{ date: '2026-10-30', weight: 55 }] }, now);
  assert.equal(up.pct, 0.5);
  // 没数据
  assert.equal(goalProgress(g, {}, now).pct, null);
});

test('目标进度：储蓄读资产总额序列（起点取开始日之前最近一个点），落后时标出来', () => {
  const now = new Date(2026, 9, 30);
  const saving = [{ date: '2026-07-28', value: 30000 }, { date: '2026-08-28', value: 30500 }, { date: '2026-09-28', value: 31000 }, { date: '2026-10-30', value: 31500 }];
  const p = goalProgress({ id: 's', type: 'saving', target: 40000, startDate: '2026-08-01', endDate: '2027-01-31' }, { saving, savingUnit: 'SGD' }, now);
  assert.equal(p.start, 30000);
  assert.equal(p.cur, 31500);
  assert.equal(p.unit, 'SGD');
  assert.equal(p.status, 'behind');
  assert.ok(p.pacePerWeek! > 100 && p.pacePerWeek! < 130);
  // 没建资产账户 → 兜底用投资记录
  const fb = goalProgress({ id: 's', type: 'saving', target: 1000 }, { investmentsTotal: 250 }, now);
  assert.equal(fb.source, '投资记录');
  assert.equal(fb.pct, 0.25);
});

test('目标进度：习惯算连续天数（今天没打卡不算断）；自定义读手动值', () => {
  const now = new Date(2026, 9, 30, 9);
  const dates = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29'];
  assert.equal(streak(dates, now), 4);
  assert.equal(streak([...dates, '2026-10-30'], now), 5);
  const h = goalProgress({ id: 'h', type: 'habit', target: 8, habitField: 'meditation' }, { habits: { meditation: dates } }, now);
  assert.equal(h.cur, 4);
  assert.equal(h.pct, 0.5);
  const c = goalProgress({ id: 'c', type: 'custom', target: 60, current: 18, startDate: '2026-10-09', endDate: '2026-12-18' }, {}, now);
  assert.equal(c.pct, 0.3);
  assert.equal(c.status, 'on');
  assert.equal(goalProgress({ id: 'c', type: 'custom', target: 60 }, {}, now).pct, null);
  assert.equal(slopePerDay([{ date: '2026-10-01', value: 1 }, { date: '2026-10-03', value: 2 }]), null, '跨度不够');
});

test('支出：上周比前 4 周平均多花的类别', () => {
  const now = new Date(2026, 9, 28); // 周三；上周 = 10-19 ~ 10-25
  const tx = [
    ...['2026-09-22', '2026-09-29', '2026-10-06', '2026-10-13'].map((date) => ({ date, type: 'expense', amount: 60, category: '餐饮' })),
    { date: '2026-10-20', type: 'expense', amount: 60, category: '餐饮' },
    { date: '2026-10-21', type: 'expense', amount: 90, category: '外卖' },
    { date: '2026-10-22', type: 'income', amount: 500, category: '工资' },
  ];
  const s = spendingWeek(tx, now);
  assert.equal(s.from, '2026-10-19');
  assert.equal(s.to, '2026-10-25');
  assert.equal(s.total, 150);
  assert.equal(s.avg, 60);
  assert.deepEqual(s.up.map((u) => [u.category, u.delta]), [['外卖', 90]]);
  assert.equal(spendingWeek(tx.slice(4), now).avg, null, '没有历史就不比');
});

test('本地日程展开：每天 / 工作日 / 每周几 / 双周 / 每月 / 截止日', () => {
  const ev = (o: object) => ({ title: 'x', date: '2026-10-05', ...o });
  assert.ok(occursOn(ev({}), '2026-10-05'));
  assert.ok(!occursOn(ev({}), '2026-10-06'));
  assert.ok(occursOn(ev({ rrule: 'daily' }), '2026-10-09'));
  assert.ok(!occursOn(ev({ rrule: 'daily' }), '2026-10-04'));
  assert.ok(!occursOn(ev({ rrule: 'weekday' }), '2026-10-10'));
  assert.ok(occursOn(ev({ rrule: 'weekly', rruleDays: [1, 3] }), '2026-10-07'));
  assert.ok(occursOn(ev({ rrule: 'weekly' }), '2026-10-12'));
  assert.ok(!occursOn(ev({ rrule: 'biweekly' }), '2026-10-12'));
  assert.ok(occursOn(ev({ rrule: 'monthly' }), '2026-11-05'));
  assert.ok(!occursOn(ev({ rrule: 'daily', rruleUntil: '2026-10-06' }), '2026-10-07'));
  assert.deepEqual(scheduleLines([ev({ title: '组会', startTime: '15:00' }), ev({ title: '课', startTime: '10:00' })], '2026-10-05'), ['10:00 课', '15:00 组会']);
});

test('现状注入带上目标进度', () => {
  const ctx = buildContext([], [{ id: 'g', title: '减重', status: 'active' }], new Date(2026, 9, 30), [], new Map([['g', '体重记录 56.8kg，进度 40%']]));
  assert.match(ctx, /减重（id g）.*；体重记录 56.8kg，进度 40%/);
});

test('回顾日记：心情必填、同一天覆盖、落盘', async () => {
  assert.equal(normalizeEntry({ mood: 'meh' }, '2026-10-02', 1), null);
  const e = normalizeEntry({ mood: 'bad', note: '  累  ' }, '2026-10-02', 1)!;
  assert.equal(e.note, '累');
  const l = upsertEntry(upsertEntry([], e), { ...e, mood: 'good' });
  assert.equal(l.length, 1);
  assert.equal(l[0].mood, 'good');
  const dir = mkdtempSync(path.join(tmpdir(), 'paa-j-'));
  const j = new JournalStore(dir);
  await j.add(e);
  const j2 = new JournalStore(dir);
  await j2.init();
  assert.equal(j2.range('2026-10-01', '2026-10-03').length, 1);
});
