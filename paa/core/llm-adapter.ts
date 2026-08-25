// ============================================================
// LLMAdapter — 多 provider 统一接口
// 参考：Operit 20+ provider 适配模式（接口分层思想，不抄实现）
// P0 实现 OpenAI 兼容协议（DeepSeek/OpenAI/Moonshot 等同一协议族）
// ============================================================

import type { ChatMessage, LLMConfig, ToolDefinition } from './types.ts';

export interface ChatOptions {
  maxTokens?: number;
  temperature?: number;
  tools?: ToolDefinition[];
}

/** 流式回调：text=文本增量；toolArgs=工具参数增量（index 对应第几个工具调用） */
export interface StreamCallbacks {
  onText?: (delta: string) => void;
  onToolArgs?: (index: number, name: string | null, argsDelta: string) => void;
}

export interface LLMAdapter {
  readonly provider: string;
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatMessage>;
  /** 可选能力：流式 chat。返回与 chat() 相同的完整消息；实现方必须调 cb 推送增量 */
  chatStream?(messages: ChatMessage[], opts: ChatOptions, cb: StreamCallbacks): Promise<ChatMessage>;
}

/** 判断适配器是否支持流式 */
export function supportsStreaming(adapter: LLMAdapter): adapter is LLMAdapter & {
  chatStream(messages: ChatMessage[], opts: ChatOptions, cb: StreamCallbacks): Promise<ChatMessage>;
} {
  return typeof (adapter as LLMAdapter & { chatStream?: unknown }).chatStream === 'function';
}

/** OpenAI 兼容协议适配器 */
export class OpenAICompatibleAdapter implements LLMAdapter {
  readonly provider = 'openai-compatible';

  private cfg: LLMConfig;

  constructor(cfg: LLMConfig) {
    this.cfg = cfg;
  }

  /** ToolDefinition → OpenAI tools schema */
  private toToolsSchema(tools: ToolDefinition[]): unknown[] {
    return tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.desc,
        parameters: {
          type: 'object',
          properties: Object.fromEntries(
            Object.entries(t.params).map(([k, v]) => [
              k,
              { type: v.type, description: v.desc },
            ]),
          ),
          required: Object.entries(t.params)
            .filter(([, v]) => v.required !== false)
            .map(([k]) => k),
        },
      },
    }));
  }

  /** OpenAI wire 消息 → 内部 ChatMessage */
  private fromWire(msg: {
    role: string;
    content?: string | null;
    tool_calls?: Array<{
      id: string;
      function: { name: string; arguments: string };
    }>;
  }): ChatMessage {
    return {
      role: 'assistant',
      content: msg.content ?? null,
      toolCalls: msg.tool_calls?.map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: JSON.parse(tc.function.arguments || '{}'),
      })),
    };
  }

  /** 内部 ChatMessage → OpenAI wire 消息 */
  private toWire(m: ChatMessage): Record<string, unknown> {
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return {
        role: 'assistant',
        content: m.content,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        })),
      };
    }
    if (m.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: m.toolCallId,
        content: m.content,
      };
    }
    return { role: m.role, content: m.content };
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatMessage> {
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages: messages.map((m) => this.toWire(m)),
      max_tokens: opts.maxTokens ?? this.cfg.maxTokens ?? 4096,
      temperature: opts.temperature ?? this.cfg.temperature ?? 0.7,
    };
    if (opts.tools?.length) body.tools = this.toToolsSchema(opts.tools);

    const res = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.cfg.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`LLM ${res.status}: ${text.slice(0, 300)}`);
    }

    const data = (await res.json()) as {
      choices: Array<{ message: { role: string; content?: string | null; tool_calls?: never } }>;
    };
    return this.fromWire(data.choices[0]?.message ?? { role: 'assistant' });
  }

  /** 流式 chat（OpenAI SSE 协议）。边读边调 cb，最后返回拼装好的完整消息 */
  async chatStream(
    messages: ChatMessage[],
    opts: ChatOptions = {},
    cb: StreamCallbacks = {},
  ): Promise<ChatMessage> {
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages: messages.map((m) => this.toWire(m)),
      max_tokens: opts.maxTokens ?? this.cfg.maxTokens ?? 4096,
      temperature: opts.temperature ?? this.cfg.temperature ?? 0.7,
      stream: true,
    };
    if (opts.tools?.length) body.tools = this.toToolsSchema(opts.tools);

    const res = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.cfg.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`LLM ${res.status}: ${text.slice(0, 300)}`);
    }
    if (!res.body) throw new Error('LLM 响应无 body（不支持流式）');

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '';
    let content = '';
    // 工具调用按 index 累积（OpenAI delta 分片）
    const toolAcc: Array<{ id: string; name: string; args: string }> = [];

    const flushLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) return;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') return;
      let chunk: {
        choices?: Array<{
          delta?: { content?: string | null; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> };
        }>;
      };
      try {
        chunk = JSON.parse(payload);
      } catch {
        return;
      }
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) return;
      if (typeof delta.content === 'string') {
        content += delta.content;
        cb.onText?.(delta.content);
      }
      if (delta.tool_calls?.length) {
        for (const tc of delta.tool_calls) {
          const acc = (toolAcc[tc.index] ??= { id: '', name: '', args: '' });
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name += tc.function.name;
          if (tc.function?.arguments) {
            acc.args += tc.function.arguments;
            cb.onToolArgs?.(tc.index, tc.function.name || null, tc.function.arguments);
          }
        }
      }
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        flushLine(line);
      }
    }
    // 尾部残留
    if (buf.trim()) flushLine(buf);

    const toolCalls = toolAcc
      .filter((t) => t.name || t.args)
      .map((t) => ({
        id: t.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: t.name,
        arguments: (() => {
          try {
            return JSON.parse(t.args || '{}');
          } catch {
            return { _raw: t.args };
          }
        })(),
      }));

    return {
      role: 'assistant',
      content: content || null,
      toolCalls: toolCalls.length ? toolCalls : undefined,
    };
  }
}

/** 工厂：按 provider 名创建适配器（P0 仅 openai-compatible；P3 扩展） */
export function createAdapter(cfg: LLMConfig): LLMAdapter {
  switch (cfg.provider) {
    case 'openai-compatible':
    case 'deepseek':
      return new OpenAICompatibleAdapter(cfg);
    default:
      throw new Error(`未知 provider: ${cfg.provider}`);
  }
}
