// 到家提醒：规则判断 / 文案 / 渠道请求 / 引擎（不联网，fetch 注入）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  normalizeConfig, inQuiet, pendingForNudge, shouldSend, composeMessage, buildRequest, freshState, ymd,
  NudgeEngine, DEFAULT_CONFIG, type NudgeConfig, type TodoLike,
} from '../server/nudge.ts';

const at = (h: number, m = 0): Date => new Date(2026, 9, 2, h, m);
const on = (over: Partial<NudgeConfig> = {}): NudgeConfig => normalizeConfig({ ...DEFAULT_CONFIG, enabled: true, ...over });

test('normalizeConfig：默认关闭；非法值回落；gentle 只发一次；坏 URL 退回不推送', () => {
  assert.equal(normalizeConfig(undefined).enabled, false);
  const c = normalizeConfig({ enabled: true, level: 'gentle', maxCount: 9, intervalMin: 1, quietStart: '25:00', channel: { type: 'ntfy', url: 'javascript:alert(1)' } });
  assert.equal(c.maxCount, 1);
  assert.equal(c.intervalMin, 10);
  assert.equal(c.quietStart, DEFAULT_CONFIG.quietStart);
  assert.deepEqual(c.channel, { type: 'none', url: '' });
  assert.deepEqual(normalizeConfig({ channel: { type: 'bark', url: 'https://u:p@api.day.app/k' } }).channel.type, 'none', '带账号密码的 URL 拒绝');
  assert.equal(normalizeConfig({ level: 'nope' }).level, 'follow');
});

test('inQuiet：同日区间与跨午夜区间', () => {
  assert.ok(inQuiet(at(1), '00:30', '08:00'));
  assert.ok(!inQuiet(at(8), '00:30', '08:00'));
  assert.ok(inQuiet(at(23, 45), '23:30', '07:00'));
  assert.ok(inQuiet(at(6, 59), '23:30', '07:00'));
  assert.ok(!inQuiet(at(12), '23:30', '07:00'));
  assert.ok(!inQuiet(at(3), '08:00', '08:00'), '起止相同 = 无安静时段');
});

test('pendingForNudge：只算承诺、未完成、今天及以前到期；scope=atHome 只算到家任务；按优先级排', () => {
  const todos: TodoLike[] = [
    { title: '建议', plan: 'suggested', dueDate: '2026-10-02' },
    { title: '已完成', done: true, dueDate: '2026-10-02' },
    { title: '明天的', dueDate: '2026-10-03' },
    { title: '低', priority: 'low', dueDate: '2026-10-02' },
    { title: '逾期高', priority: 'high', dueDate: '2026-09-30', atHome: true },
    { title: '没日期' },
  ];
  assert.deepEqual(pendingForNudge(todos, '2026-10-02', 'all').map((t) => t.title), ['逾期高', '没日期', '低']);
  assert.deepEqual(pendingForNudge(todos, '2026-10-02', 'atHome').map((t) => t.title), ['逾期高']);
});

test('shouldSend：没到家 / 关闭 / 今天算了 / 没待办 / 次数满 / 安静时段 / 间隔不够 都不发', () => {
  const st = { ...freshState(at(19)), arrivedAt: at(19).getTime() };
  assert.ok(shouldSend(on(), st, 2, at(19)));
  assert.ok(!shouldSend(on(), { ...st, arrivedAt: null }, 2, at(19)));
  assert.ok(!shouldSend(on({ enabled: false }), st, 2, at(19)));
  assert.ok(!shouldSend(on(), { ...st, snoozed: true }, 2, at(19)));
  assert.ok(!shouldSend(on(), st, 0, at(19)));
  assert.ok(!shouldSend(on({ maxCount: 2 }), { ...st, sent: 2 }, 2, at(19)));
  assert.ok(!shouldSend(on({ quietStart: '18:00', quietEnd: '20:00' }), st, 2, at(19)));
  const sent = { ...st, sent: 1, lastSentAt: at(19).getTime() };
  assert.ok(!shouldSend(on({ intervalMin: 45 }), sent, 2, at(19, 30)));
  assert.ok(shouldSend(on({ intervalMin: 45 }), sent, 2, at(19, 45)));
  assert.ok(!shouldSend(on(), { ...st, day: '2026-10-01' }, 2, at(19)), '昨天的到家不算');
});

test('composeMessage：第一条点名最重要的一件；最后一次说明之后不再打扰；strong 标紧急', () => {
  const p: TodoLike[] = [{ title: '交概率论作业' }, { title: '背单词' }];
  const m1 = composeMessage(on({ maxCount: 3 }), 0, p);
  assert.equal(m1.title, '到家了');
  assert.match(m1.body, /2 件/);
  assert.match(m1.body, /「交概率论作业」/);
  assert.match(m1.body, /「背单词」/);
  assert.equal(m1.urgent, false);
  const m3 = composeMessage(on({ maxCount: 3, level: 'strong' }), 2, p);
  assert.match(m3.title, /交概率论作业/);
  assert.match(m3.body, /最后一次/);
  assert.equal(m3.urgent, true);
  assert.doesNotMatch(composeMessage(on({ level: 'gentle' }), 0, p).body, /最后一次/, '只发一次时不说"最后一次"');
});

test('buildRequest：ntfy 用 JSON 发到服务根（中文不进 HTTP 头）；Bark 时效/紧急；webhook 带待办；none 不发', () => {
  const msg = { title: '到家了', body: '先做一件', urgent: true, todos: ['a'] };
  const n = buildRequest({ type: 'ntfy', url: 'https://ntfy.sh/yours-abc123' }, msg)!;
  assert.equal(n.url, 'https://ntfy.sh/');
  assert.deepEqual(JSON.parse(n.init.body), { topic: 'yours-abc123', title: '到家了', message: '先做一件', priority: 5, tags: ['house'] });
  assert.ok(Object.values(n.init.headers).every((v) => /^[\x20-\x7e]*$/.test(v)), '头部全 ASCII');
  const self = buildRequest({ type: 'ntfy', url: 'https://ntfy.example.com/sub/topic' }, msg)!;
  assert.equal(self.url, 'https://ntfy.example.com/sub/');
  const b = JSON.parse(buildRequest({ type: 'bark', url: 'https://api.day.app/KEY' }, { ...msg, urgent: false })!.init.body);
  assert.equal(b.level, 'timeSensitive');
  const w = JSON.parse(buildRequest({ type: 'webhook', url: 'https://example.com/hook' }, msg)!.init.body);
  assert.deepEqual(w.todos, ['a']);
  assert.equal(buildRequest({ type: 'none', url: '' }, msg), null);
});

test('NudgeEngine：到家立即发第一条；间隔后跟进；次数满停止；今天算了停止；外部推送失败不影响网页内', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'paa-nudge-'));
  const today = ymd(new Date());
  let todos: TodoLike[] = [{ title: '写报告', dueDate: today }, { title: '建议的', plan: 'suggested', dueDate: today }];
  const got: string[] = [];
  const calls: string[] = [];
  const e = new NudgeEngine({
    dataDir: dir,
    getTodos: () => todos,
    broadcast: (m) => got.push(m.title),
    fetchImpl: async (url) => { calls.push(url); return { ok: false, status: 500 }; },
  });
  await e.init();
  await e.setConfig({ enabled: true, level: 'follow', intervalMin: 30, maxCount: 2, quietStart: '00:00', quietEnd: '00:00', channel: { type: 'ntfy', url: 'https://ntfy.sh/t' } });
  const t0 = new Date(); t0.setHours(19, 0, 0, 0);
  const r = await e.arrive(t0);
  assert.equal(r.sent, true);
  assert.deepEqual(r.pending.map((x) => x.title), ['写报告'], '建议不算');
  assert.deepEqual(got, ['到家了']);
  assert.deepEqual(calls, ['https://ntfy.sh/']);
  assert.equal(await e.tick(new Date(t0.getTime() + 10 * 60_000)), false, '间隔不够');
  assert.equal(await e.tick(new Date(t0.getTime() + 30 * 60_000)), true);
  assert.equal(await e.tick(new Date(t0.getTime() + 90 * 60_000)), false, '次数满');
  // 重新到家会重置；今天算了之后不再发
  await e.arrive(t0);
  await e.snooze(t0);
  assert.equal(await e.tick(new Date(t0.getTime() + 60 * 60_000)), false);
  // 状态落盘：新引擎读回
  const e2 = new NudgeEngine({ dataDir: dir, getTodos: () => todos, broadcast: () => {} });
  await e2.init();
  assert.equal(e2.config.enabled, true);
  assert.equal(e2.state.snoozed, true);
  // 全部完成 → 不发
  todos = [{ title: '写报告', dueDate: today, done: true }];
  await e2.arrive(t0);
  assert.equal(e2.state.sent, 0);
});
