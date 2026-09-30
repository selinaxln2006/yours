// server 宿主的 MCP 接入：配置解析 / 按 annotations 定风险 / 日历读取（真实 spawn 演示日历 server）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseMcpServers, mcpToolRisk, mcpToolDefinitions, connectMcpServers, findCalendarClient,
  fetchCalendarEvents, parseCalendarEvents, isValidRange, isValidTimeZone,
} from '../server/mcp.ts';

const DEMO_CAL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server', 'demo-calendar.mjs');
const pad = (n: number): string => String(n).padStart(2, '0');
const today = (): string => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

test('parseMcpServers：跳过不合法项与 enabled:false，risk 只认 1-3', () => {
  const out = parseMcpServers([
    { name: 'ok', command: 'npx', args: ['-y', 'x', 1], risk: 2 },
    { name: '', command: 'npx' },
    { name: 'nocmd' },
    { name: 'off', command: 'npx', enabled: false },
    { name: 'badrisk', command: 'node', risk: 9 },
    null,
  ]);
  assert.deepEqual(out.map((s) => s.name), ['ok', 'badrisk']);
  assert.deepEqual(out[0].args, ['-y', 'x', '1']);
  assert.equal(out[1].risk, undefined);
  assert.deepEqual(parseMcpServers('nope'), []);
});

test('mcpToolRisk：只读 1 / 非破坏写 3 / 破坏性或未声明 destructiveHint 4 / 无 annotations 3', () => {
  const t = (annotations?: object) => ({ name: 'x', annotations }) as never;
  assert.equal(mcpToolRisk(t({ readOnlyHint: true })), 1);
  assert.equal(mcpToolRisk(t({ readOnlyHint: false, destructiveHint: false })), 3);
  assert.equal(mcpToolRisk(t({ readOnlyHint: false, destructiveHint: true })), 4);
  assert.equal(mcpToolRisk(t({ readOnlyHint: false })), 4);
  assert.equal(mcpToolRisk(t()), 3);
  // config.risk 只能调高
  assert.equal(mcpToolRisk(t({ readOnlyHint: true }), 3), 3);
  assert.equal(mcpToolRisk(t({ readOnlyHint: false }), 1), 4);
});

test('parseCalendarEvents：定时/全天/取消/坏数据', () => {
  const text = JSON.stringify({ events: [
    { id: 'a', summary: '组会', start: { dateTime: '2026-10-01T15:00:00+08:00' }, end: { dateTime: '2026-10-01T16:00:00+08:00' }, htmlLink: 'https://calendar.google.com/x', location: 'COM1' },
    { id: 'b', summary: 'Recess', start: { date: '2026-10-02' }, end: { date: '2026-10-03' } },
    { id: 'c', summary: 'gone', status: 'cancelled', start: { date: '2026-10-02' } },
    { id: 'd', start: { dateTime: '2026-10-01T23:00:00+08:00' }, end: { dateTime: '2026-10-02T01:00:00+08:00' }, htmlLink: 'javascript:alert(1)' },
    { id: 'e', start: {} },
  ] });
  const ev = parseCalendarEvents(text, 'cal');
  assert.equal(ev.length, 3);
  assert.deepEqual(ev[0], { id: 'a', title: '组会', date: '2026-10-01', allDay: false, source: 'cal', startTime: '15:00', endTime: '16:00', location: 'COM1', link: 'https://calendar.google.com/x' });
  assert.deepEqual(ev[1], { id: 'b', title: 'Recess', date: '2026-10-02', allDay: true, source: 'cal' });
  assert.equal(ev[2].title, '（无标题）');
  assert.equal(ev[2].endTime, undefined, '跨天结束时间不写');
  assert.equal(ev[2].link, undefined, '非 https 链接丢掉');
  assert.deepEqual(parseCalendarEvents('not json', 'cal'), []);
});

test('isValidRange / isValidTimeZone', () => {
  assert.ok(isValidRange('2026-09-01', '2026-09-30'));
  assert.ok(!isValidRange('2026-09-30', '2026-09-01'));
  assert.ok(!isValidRange('2026-01-01', '2026-06-01'));
  assert.ok(!isValidRange('2026-9-1', '2026-09-02'));
  assert.ok(isValidTimeZone('Asia/Singapore'));
  assert.ok(!isValidTimeZone('Not/AZone'));
  assert.ok(!isValidTimeZone('../../etc'));
});

test('演示日历 server：连接、逐工具风险、读今天的事件、坏 server 不影响其他', async () => {
  const { clients, errors } = await connectMcpServers([
    { name: 'calendar', command: process.execPath, args: [DEMO_CAL] },
    { name: 'broken', command: process.execPath, args: ['-e', 'process.exit(3)'] },
  ]);
  try {
    assert.equal(clients.length, 1);
    assert.ok(errors.broken);
    const cal = findCalendarClient(clients);
    assert.ok(cal);
    const risks = Object.fromEntries(mcpToolDefinitions(cal).map((d) => [d.name, d.risk]));
    assert.deepEqual(risks, { 'mcp_calendar_list-events': 1, 'mcp_calendar_create-event': 3, 'mcp_calendar_delete-event': 4 });
    const ev = await fetchCalendarEvents(cal, today(), today(), 'Asia/Singapore');
    assert.deepEqual(ev.map((e) => [e.startTime, e.title]), [['09:00', 'Office hours'], ['17:30', 'Swim']]);
  } finally {
    for (const c of clients) c.close();
  }
});
