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

export interface LLMAdapter {
  readonly provider: string;
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatMessage>;
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
