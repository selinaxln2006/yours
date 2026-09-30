// 演示 / 测试用的日历 MCP server（JSON-RPC 2.0 over stdio，零依赖）
// 工具名、annotations、返回结构对齐 @cocal/google-calendar-mcp 的子集：
//   list-events（只读）/ create-event（写）/ delete-event（破坏性）
// 事件只在内存里，进程退出即消失
import { createInterface } from 'node:readline';

const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const plusDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return ymd(d); };

let seq = 0;
const ev = (date, start, end, summary, location) => ({
  id: `demo${++seq}`,
  summary,
  location,
  status: 'confirmed',
  start: start ? { dateTime: `${date}T${start}:00` } : { date },
  end: end ? { dateTime: `${date}T${end}:00` } : { date },
  htmlLink: 'https://calendar.google.com/',
});
const events = [
  ev(plusDays(0), '09:00', '10:00', 'Office hours', 'S17 #04-06'),
  ev(plusDays(0), '17:30', '18:30', 'Swim', 'UTown pool'),
  ev(plusDays(1), '11:00', '12:00', 'Case interview prep', 'Zoom'),
  ev(plusDays(2), null, null, 'Recess week'),
];

const TOOLS = [
  {
    name: 'list-events',
    description: 'List events in a time range',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: { type: 'object', properties: { calendarId: { type: 'string' }, timeMin: { type: 'string' }, timeMax: { type: 'string' }, timeZone: { type: 'string' } }, required: ['calendarId'] },
  },
  {
    name: 'create-event',
    description: 'Create an event',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    inputSchema: { type: 'object', properties: { calendarId: { type: 'string' }, summary: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, location: { type: 'string' } }, required: ['summary', 'start', 'end'] },
  },
  {
    name: 'delete-event',
    description: 'Delete an event',
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    inputSchema: { type: 'object', properties: { calendarId: { type: 'string' }, eventId: { type: 'string' } }, required: ['eventId'] },
  },
];

const text = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });
const startKey = (e) => e.start.dateTime || e.start.date;

function call(name, a = {}) {
  if (name === 'list-events') {
    const lo = String(a.timeMin || '0000').slice(0, 19), hi = String(a.timeMax || '9999').slice(0, 19);
    const hit = events.filter((e) => { const s = startKey(e); return s >= lo.slice(0, s.length) && s <= hi.slice(0, s.length); })
      .sort((x, y) => startKey(x).localeCompare(startKey(y)));
    return text({ events: hit, totalCount: hit.length });
  }
  if (name === 'create-event') {
    const date = String(a.start || '').slice(0, 10);
    const e = ev(date, String(a.start).slice(11, 16) || null, String(a.end).slice(11, 16) || null, String(a.summary || ''), a.location);
    events.push(e);
    return text({ event: e });
  }
  if (name === 'delete-event') {
    const i = events.findIndex((e) => e.id === a.eventId);
    if (i < 0) return { content: [{ type: 'text', text: `not found: ${a.eventId}` }], isError: true };
    events.splice(i, 1);
    return text({ success: true });
  }
  return null;
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (id === undefined) return;
  if (method === 'initialize') return send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'demo-calendar', version: '1.0.0' } } });
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  if (method === 'tools/call') {
    const r = call(params?.name, params?.arguments);
    return r ? send({ jsonrpc: '2.0', id, result: r }) : send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown tool: ${params?.name}` } });
  }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method: ${method}` } });
});
