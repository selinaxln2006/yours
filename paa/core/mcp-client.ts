// ============================================================
// McpClient — 轻量 MCP client（G5 / C3 资源支柱，第二资源源）
// 自研 JSON-RPC 2.0 over stdio（newline-delimited），零依赖，不 import SDK
// 对齐 Codex MCP 体验：config 挂 server → 启动时连接 → 工具动态暴露给 agent
// 参考协议: https://modelcontextprotocol.io/specification (2024-11-05)
// ============================================================

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline/promises';
import type { ParamSpec, ToolDefinition } from './types.ts';

/** config.json 里 mcpServers 数组的一项 */
export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** 工具 risk 覆盖（默认 2 = 普通操作）。per-server 级别，v1 不做 per-tool */
  risk?: 1 | 2 | 3;
}

/** MCP server 暴露的工具描述（tools/list 结果项） */
export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const REQUEST_TIMEOUT_MS = 30_000;

/** 把任意 server 名合法化成工具名前缀（mcp_<合法名>_<tool>） */
export function sanitizeServerName(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^[^a-z]+/, '').replace(/_+$/, '');
  return s || 'server';
}

/** MCP 工具 → PAA ToolDefinition 映射。全名 = mcp_<server>_<tool>，默认 risk 2（普通操作） */
export function createMcpToolDefinitions(client: McpClient, opts?: { risk?: 1 | 2 | 3 }): ToolDefinition[] {
  const prefix = `mcp_${sanitizeServerName(client.name)}`;
  const risk = opts?.risk ?? 2;
  return client.tools.map((t) => ({
    name: `${prefix}_${t.name}`,
    desc: `[MCP:${client.name}] ${t.description ?? t.name}`,
    params: mcpSchemaToParams(t.inputSchema),
    risk,
    handler: async (args) => client.callTool(t.name, args as Record<string, unknown>),
  }));
}

/** inputSchema（JSON Schema 子集）→ ParamSpec（只认 properties + required，其他忽略） */
function mcpSchemaToParams(schema?: Record<string, unknown>): Record<string, ParamSpec> {
  if (!schema || typeof schema.properties !== 'object' || schema.properties === null) return {};
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  const props = schema.properties as Record<string, { type?: string; description?: string }>;
  const out: Record<string, ParamSpec> = {};
  for (const [k, v] of Object.entries(props)) {
    out[k] = { type: mapSchemaType(v.type), desc: v.description ?? '', required: required.has(k) };
  }
  return out;
}

function mapSchemaType(t?: string): ParamSpec['type'] {
  switch (t) {
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'array':
      return 'array';
    case 'object':
      return 'object';
    default:
      return 'string';
  }
}

export class McpClient {
  private config: McpServerConfig;
  private proc: ChildProcess | null = null;
  private rl: Interface | null = null;
  private idSeq = 0;
  private pending = new Map<number, PendingRequest>();
  private _tools: McpToolInfo[] = [];
  private closed = false;

  constructor(config: McpServerConfig) {
    this.config = config;
  }

  get name(): string {
    return this.config.name;
  }

  get tools(): McpToolInfo[] {
    return this._tools;
  }

  get isConnected(): boolean {
    return this.proc !== null && !this.closed && this.proc.exitCode === null;
  }

  /** 连接 + 握手 + 拉取工具清单。失败抛错（调用方决定是否阻塞启动） */
  async connect(): Promise<void> {
    if (this.closed) throw new Error('client 已关闭');
    let command = this.config.command;
    // Windows 上 npx 等只有 .cmd 存根，spawn 不带 shell 时需显式补扩展名
    if (process.platform === 'win32' && !command.includes('.') && !command.includes('\\') && !command.includes('/')) {
      command = `${command}.cmd`;
    }
    this.proc = spawn(command, this.config.args ?? [], {
      env: { ...process.env, ...(this.config.env ?? {}) },
      stdio: ['pipe', 'pipe', 'inherit'],
      shell: false,
    });
    this.proc.on('error', (e) => {
      this.rejectAll(new Error(`MCP server ${this.config.name} 进程错误: ${e.message}`));
    });
    this.proc.on('exit', (code, signal) => {
      this.rejectAll(new Error(`MCP server ${this.config.name} 进程退出 (code=${code}, signal=${signal})`));
    });

    const stdout = this.proc.stdout;
    if (!stdout) throw new Error('MCP server 无 stdout');
    this.rl = createInterface({ input: stdout });
    this.rl.on('line', (line) => this.handleLine(line));

    // 握手：initialize → notifications/initialized → tools/list
    try {
      await this.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'paa-shu', version: '0.1.0' },
      });
      this.notify('notifications/initialized', {});
      const res = (await this.request('tools/list', {})) as { tools?: McpToolInfo[] };
      this._tools = Array.isArray(res.tools) ? res.tools : [];
    } catch (e) {
      this.close();
      throw new Error(`MCP 握手失败（${this.config.name}）: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      msg = JSON.parse(trimmed) as { id?: number; result?: unknown; error?: { message?: string } };
    } catch {
      return; // 非 JSON 行（如 banner 输出）忽略
    }
    if (typeof msg.id !== 'number') return; // notification，忽略
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) {
      p.reject(new Error(`MCP ${this.config.name} 返回错误: ${msg.error.message ?? JSON.stringify(msg.error)}`));
    } else {
      p.resolve(msg.result);
    }
  }

  private request(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++this.idSeq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP 请求超时（${method}, ${REQUEST_TIMEOUT_MS}ms）: ${this.config.name}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      const line = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      if (!this.proc || !this.proc.stdin || !this.proc.stdin.writable) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('MCP stdin 不可写（server 未就绪）'));
        return;
      }
      this.proc.stdin.write(`${line}\n`);
    });
  }

  private notify(method: string, params: unknown): void {
    if (!this.proc?.stdin?.writable) return;
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  private rejectAll(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }

  /** 调用 server 工具，返回文本内容（content[] 拼接） */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    if (!this.isConnected) throw new Error(`MCP server 未连接: ${this.config.name}`);
    const res = (await this.request('tools/call', { name, arguments: args })) as {
      content?: Array<{ type?: string; text?: string }>;
      isError?: boolean;
    };
    const text = (res.content ?? []).map((c) => c.text ?? '').join('\n');
    if (res.isError) throw new Error(`MCP 工具 ${name} 执行错误: ${text || '(无内容)'}`);
    return text;
  }

  /** 关闭：终止子进程，清 pending */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectAll(new Error(`MCP server ${this.config.name} 已关闭`));
    this.rl?.close();
    if (this.proc && this.proc.exitCode === null) {
      try {
        this.proc.kill();
      } catch {
        // 进程已退出则忽略
      }
    }
    this.proc = null;
  }
}
