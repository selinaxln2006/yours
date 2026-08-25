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

/** 记忆层级（P1 v1.1：L0 原文 / L1 事实 / L2 场景块 / L3 画像） */
export type MemoryLayer = 'L0' | 'L1' | 'L2' | 'L3';

/** 记忆类型（v1.1 加 persona） */
export type MemoryType = 'fact' | 'preference' | 'episodic' | 'skill-note' | 'persona';

/** 记忆记录（P1 v1.1 完整实现；向后兼容 P0 字段） */
export interface MemoryRecord {
  id: string;
  /** v1.1：层级。默认 L1 */
  layer?: MemoryLayer;
  type: MemoryType;
  content: string;
  tags: string[];
  source: 'user' | 'agent' | 'import';
  /** v1.1：来源引用（可追溯/纠错） */
  sourceRef?: { sessionId: string; eventId?: number };
  /** v1.1：事实开始为真的时间（Graphiti 同款） */
  validAt?: number;
  /** v1.1：失效时间。null/缺省 = 有效；已失效记录不参与检索 */
  invalidAt?: number | null;
  createdAt: number;
  updatedAt: number;
}

/** 记忆提供者接口（P1 实现；P0 AgentLoop 只用了 search，其余 P1 补齐） */
export interface MemoryProvider {
  /** 分层检索：L3 常驻优先 → L2 标签匹配 → L1 关键词补足；L0 永不返回 */
  search(query: string, topN?: number): Promise<MemoryRecord[]>;
  /** 保存记忆：默认 L1；同 tag+type 内容不同的活跃记录自动失效（Graphiti 边失效轻量版） */
  save(record: Omit<MemoryRecord, 'id' | 'createdAt' | 'updatedAt'>): Promise<MemoryRecord>;
  /** 按类型/层级列出（含已失效，可加 limit） */
  list(opts?: { type?: MemoryType; layer?: MemoryLayer; limit?: number }): Promise<MemoryRecord[]>;
  /** 遗忘：软删（invalidAt=now），永远确认的工具 */
  forget(id: string): Promise<boolean>;
  /** 聚合精炼：把 sourceIds 的 L1 聚合为一条 L2/L3（agent 生成 summary，provider 记账） */
  consolidate(
    summary: string,
    opts: { layer: 'L2' | 'L3'; type?: MemoryType; tags?: string[]; sourceIds?: string[] },
  ): Promise<MemoryRecord>;
  /** 全量导出（记忆主权：跨 Agent 迁移） */
  exportAll(): Promise<MemoryRecord[]>;
  /** 全量导入（幂等：按 id 覆盖） */
  importAll(records: MemoryRecord[]): Promise<number>;
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
  /** 本轮完整消息轨迹（不含 system；含 tool 消息）——宿主可作为下一轮的 prior 续跑对话 */
  messages?: ChatMessage[];
}

/** 工具注册表（P0 先用 Map 内置于 Pipeline；P3 扩展为 Skill Registry） */
export type ToolRegistry = Map<string, ToolDefinition>;
