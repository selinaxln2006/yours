// ============================================================
// server 宿主的 MCP 接入：读 config.mcpServers → 连接 → 工具注册进 pipeline
// 风险按 MCP tool annotations 定（不信任工具名）：
//   readOnlyHint=true → 1（自动）；destructiveHint!==false → 4（每次确认，不可"总是允许"）；
//   其余写操作 → 3（确认）；server 没给 annotations → 3
// 另外提供日历读取（list-events），给"今天"和日程面板用
// ============================================================

import { McpClient, createMcpToolDefinitions, type McpServerConfig, type McpToolInfo } from '../core/mcp-client.ts';
import type { RiskLevel, ToolDefinition } from '../core/types.ts';

interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
}

/** config.json 的 mcpServers → 合法项（单项不合法跳过，不整体失败） */
export function parseMcpServers(raw: unknown): McpServerConfig[] {
  const out: McpServerConfig[] = [];
  if (!Array.isArray(raw)) return out;
  for (const s of raw as Array<Record<string, unknown>>) {
    if (typeof s !== 'object' || s === null) continue;
    if (typeof s.name !== 'string' || !s.name.trim()) continue;
    if (typeof s.command !== 'string' || !s.command.trim()) continue;
    if (s.enabled === false) continue;
    out.push({
      name: s.name,
      command: s.command,
      args: Array.isArray(s.args) ? s.args.map(String) : undefined,
      env: typeof s.env === 'object' && s.env !== null ? (s.env as Record<string, string>) : undefined,
      risk: s.risk === 1 || s.risk === 2 || s.risk === 3 ? s.risk : undefined,
    });
  }
  return out;
}

/** 单个 MCP 工具的风险等级；config.risk 只能调高，不能调低 */
export function mcpToolRisk(tool: McpToolInfo, configRisk?: number): RiskLevel {
  const a = (tool as McpToolInfo & { annotations?: ToolAnnotations }).annotations;
  let r: RiskLevel;
  if (!a || typeof a !== 'object') r = 3;
  else if (a.readOnlyHint === true) r = 1;
  else if (a.destructiveHint !== false) r = 4; // MCP 规范：非只读时 destructiveHint 默认 true
  else r = 3;
  return Math.max(r, configRisk ?? 0) as RiskLevel;
}

/** client → 带逐工具风险的 ToolDefinition */
export function mcpToolDefinitions(client: McpClient, configRisk?: number): ToolDefinition[] {
  const defs = createMcpToolDefinitions(client);
  return defs.map((d, i) => ({ ...d, risk: mcpToolRisk(client.tools[i], configRisk) }));
}

export interface McpConnectResult {
  clients: McpClient[];
  errors: Record<string, string>;
}

/** 并行连接所有 server；失败的记进 errors，不阻塞其他 */
export async function connectMcpServers(configs: McpServerConfig[]): Promise<McpConnectResult> {
  const clients: McpClient[] = [];
  const errors: Record<string, string> = {};
  await Promise.all(configs.map(async (cfg) => {
    const c = new McpClient(cfg);
    try {
      await c.connect();
      clients.push(c);
    } catch (e) {
      errors[cfg.name] = e instanceof Error ? e.message : String(e);
      c.close();
    }
  }));
  return { clients, errors };
}

// ---- 日历 ----

/** console 用的日历事件（和本地 schedule 的字段对齐） */
export interface CalendarEvent {
  id: string;
  title: string;
  date: string; // YYYY-MM-DD
  startTime?: string; // HH:MM；全天事件没有
  endTime?: string;
  allDay: boolean;
  location?: string;
  link?: string;
  source: string; // MCP server 名
}

/** 暴露 list-events 的第一个 server 视为日历源 */
export function findCalendarClient(clients: McpClient[]): McpClient | null {
  return clients.find((c) => c.isConnected && c.tools.some((t) => t.name === 'list-events')) ?? null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TZ_RE = /^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/;

export function isValidRange(from: string, to: string): boolean {
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) return false;
  const a = Date.parse(from + 'T00:00:00Z'), b = Date.parse(to + 'T00:00:00Z');
  return Number.isFinite(a) && Number.isFinite(b) && b >= a && b - a <= 62 * 86_400_000;
}

export function isValidTimeZone(tz: string): boolean {
  if (!TZ_RE.test(tz)) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** list-events 的 JSON 文本 → CalendarEvent[]（取消的事件丢掉；解析不了返回空） */
export function parseCalendarEvents(text: string, source: string): CalendarEvent[] {
  let data: { events?: Array<Record<string, unknown>> };
  try {
    data = JSON.parse(text) as typeof data;
  } catch {
    return [];
  }
  const out: CalendarEvent[] = [];
  for (const e of data.events ?? []) {
    if (e.status === 'cancelled') continue;
    const start = (e.start ?? {}) as { dateTime?: string; date?: string };
    const end = (e.end ?? {}) as { dateTime?: string; date?: string };
    const dt = typeof start.dateTime === 'string' ? start.dateTime : '';
    const d = dt ? dt.slice(0, 10) : typeof start.date === 'string' ? start.date : '';
    if (!DATE_RE.test(d)) continue;
    const ev: CalendarEvent = {
      id: String(e.id ?? ''),
      title: typeof e.summary === 'string' && e.summary ? e.summary : '（无标题）',
      date: d,
      allDay: !dt,
      source,
    };
    if (dt) ev.startTime = dt.slice(11, 16);
    if (typeof end.dateTime === 'string' && end.dateTime.slice(0, 10) === d) ev.endTime = end.dateTime.slice(11, 16);
    if (typeof e.location === 'string' && e.location) ev.location = e.location;
    if (typeof e.htmlLink === 'string' && /^https:\/\//.test(e.htmlLink)) ev.link = e.htmlLink;
    out.push(ev);
  }
  return out;
}

/** 读 [from, to] 的日历事件（含两端） */
export async function fetchCalendarEvents(client: McpClient, from: string, to: string, timeZone?: string): Promise<CalendarEvent[]> {
  const args: Record<string, unknown> = {
    calendarId: 'primary',
    timeMin: `${from}T00:00:00`,
    timeMax: `${to}T23:59:59`,
  };
  if (timeZone) args.timeZone = timeZone;
  const text = await client.callTool('list-events', args);
  return parseCalendarEvents(text, client.name);
}
