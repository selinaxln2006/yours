// ============================================================
// PAA 核心类型定义（v2 架构图 — 大脑层）
// 设计自研；类型分层参考 DSH 的 Turn/Step 消息模型思想（不 import）
// ============================================================

/** 对话角色 */
export type Role = 'system' | 'user' | 'assistant' | 'tool';

/** 对话消息（wire 层与内部统一） */
export interface ChatMessage {
  role: Role;
  content: string | null;
  /** assistant 消息携带的工具调用 */
  toolCalls?: ToolCall[];
  /** tool 结果消息回指调用 id */
  toolCallId?: string;
  name?: string;
}

/** 工具调用（LLM 输出解析后） */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** 风险等级：1 读 / 2 普通 / 3 写 / 4 危险执行（永远确认，不可降级） */
export type RiskLevel = 1 | 2 | 3 | 4;

/** 参数描述（v2 ToolPkg 的 params 风格，P0 仅用于 schema 生成） */
export interface ParamSpec {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  desc: string;
  required?: boolean;
}

/** 工具定义（注册进 ToolPipeline） */
export interface ToolDefinition {
  name: string;
  desc: string;
  params: Record<string, ParamSpec>;
  risk: RiskLevel;
  handler: (args: Record<string, unknown>, ctx: ExecContext) => Promise<unknown>;
}

/** 执行上下文（宿主注入，PAA 大脑不负责实现） */
export interface ExecContext {
  sessionId: string;
  cwd: string;
  /** 权限确认回调（由 CLI/宿主实现，人机交互）；toolName 供宿主做会话级放行（如 "a"=always allow） */
  ask: (prompt: string, toolName?: string) => Promise<boolean>;
  /** 审计日志（[AUTO] 行） */
  audit: (line: string) => void;
}

/** 工具执行结果 */
export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

/** 记忆记录（P1 完整实现；P0 仅定义类型） */
export interface MemoryRecord {
  id: string;
  type: 'fact' | 'preference' | 'episodic' | 'skill-note';
  content: string;
  tags: string[];
  source: 'user' | 'agent' | 'import';
  createdAt: number;
  updatedAt: number;
}

/** 记忆提供者接口（P1 实现；P0 AgentLoop 预留钩子） */
export interface MemoryProvider {
  search(query: string, topN?: number): Promise<MemoryRecord[]>;
}

/** LLM 配置 */
export interface LLMConfig {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
}

/** 会话事件（SessionMgr 事件溯源） */
export interface SessionEvent {
  ts: number;
  type: 'user' | 'assistant' | 'tool' | 'error' | 'system';
  payload: unknown;
}

/** 一次 AgentLoop.run() 的结果 */
export interface LoopResult {
  answer: string;
  rounds: number;
  toolCalls: number;
  events: SessionEvent[];
  aborted: boolean;
}

/** 工具注册表（P0 先用 Map 内置于 Pipeline；P3 扩展为 Skill Registry） */
export type ToolRegistry = Map<string, ToolDefinition>;
