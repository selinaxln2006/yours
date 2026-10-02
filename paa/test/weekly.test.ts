// 周复盘统计 / 现状注入 / 自动记忆解析
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weeklyStats, weekStartOf, buildContext, ymd } from '../server/weekly.ts';
import { parseExtracted, transcript } from '../server/memory-extract.ts';

// 2026-10-07 是周三；本周一 10-05，上周 09-28 ~ 10-04
const NOW = new Date(2026, 9, 7, 20, 30);

test('weekStartOf：周一开头；周日算上一周的最后一天', () => {
  assert.equal(ymd(weekStartOf(NOW)), '2026-10-05');
  assert.equal(ymd(weekStartOf(new Date(2026, 9, 11))), '2026-10-05');
  assert.equal(ymd(weekStartOf(new Date(2026, 9, 12))), '2026-10-12');
  assert.equal(ymd(weekStartOf(NOW, 0)), '2026-10-04', '周日开头');
});

test('weeklyStats：上周承诺完成率、按目标拆分、本周建议；建议不算进完成率', () => {
  const todos = [
    { title: 'a', goalId: 'g1', dueDate: '2026-09-29', done: true },
    { title: 'b', goalId: 'g1', dueDate: '2026-10-02', done: false },
    { title: 'c', dueDate: '2026-10-01', done: true },
    { title: '建议不算', goalId: 'g1', dueDate: '2026-10-01', plan: 'suggested' },
    { title: '本周', goalId: 'g1', dueDate: '2026-10-06', done: true },
    { title: '本周建议', goalId: 'g1', dueDate: '2026-10-08', plan: 'suggested' },
    { title: '太早', dueDate: '2026-09-20', done: true },
  ];
  const goals = [{ id: 'g1', title: '面试' }, { id: 'g2', title: '已完成', status: 'done' }];
  const s = weeklyStats(todos, goals, NOW);
  assert.deepEqual(s.lastWeek, { from: '2026-09-28', to: '2026-10-04', committed: 3, done: 2, rate: 2 / 3 });
  assert.deepEqual(s.goals, [{ goalId: 'g1', title: '面试', lastWeek: { committed: 2, done: 1 }, thisWeek: { committed: 1, done: 1, suggested: 1 } }]);
  assert.deepEqual(s.other.lastWeek, { committed: 1, done: 1 });
  assert.equal(weeklyStats([], [], NOW).lastWeek.rate, null);
});

test('buildContext：时间、今天的承诺（逾期 / 到家标注）、建议、目标进度、额外信息', () => {
  const ctx = buildContext([
    { title: '写报告', dueDate: '2026-10-07', atHome: true },
    { title: '交表', dueDate: '2026-10-05' },
    { title: '已完成', dueDate: '2026-10-07', done: true },
    { title: '看书', dueDate: '2026-10-07', plan: 'suggested', goalId: 'g1' },
  ], [{ id: 'g1', title: '面试' }], NOW, ['已约的回访：21:00「x」']);
  assert.match(ctx, /2026-10-07（周三）20:30/);
  assert.match(ctx, /「写报告」（到家后）/);
  assert.match(ctx, /「交表」（逾期）/);
  assert.match(ctx, /已完成 1 件/);
  assert.match(ctx, /「看书」←面试/);
  assert.match(ctx, /面试（id g1）/);
  assert.match(ctx, /已约的回访/);
});

test('parseExtracted：只收合法条目，去重（含包含关系），最多 3 条，带 auto 标签', () => {
  const out = parseExtracted('好的：[{"content":"用户一到家就容易躺平","type":"fact","tags":["habit"]},' +
    '{"content":"用户不喜欢被催睡觉。","type":"preference"},{"content":"短"},{"content":"用户周三晚上有课"},' +
    '{"content":"用户在准备量化面试"},{"content":"再多一条"}]', ['用户不喜欢被催睡觉']);
  assert.deepEqual(out.map((x) => x.content), ['用户一到家就容易躺平', '用户周三晚上有课', '用户在准备量化面试']);
  assert.deepEqual(out[0].tags, ['habit', 'auto']);
  assert.deepEqual(parseExtracted('没有', []), []);
  assert.deepEqual(parseExtracted('[not json', []), []);
});

test('transcript：只保留用户与助手正文，去掉 [MODE:x] 前缀，超长截尾部', () => {
  const t = transcript([
    { role: 'user', content: '我到家了' },
    { role: 'assistant', content: '[MODE:text]\n\n好，先歇 15 分钟' },
    { role: 'tool', content: '{"ok":true}' },
  ]);
  assert.equal(t, '用户：我到家了\n助手：好，先歇 15 分钟');
  assert.equal(transcript([{ role: 'user', content: 'x'.repeat(50) }], 10).length, 10);
});
