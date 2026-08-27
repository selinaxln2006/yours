// ============================================================
// AgentLoop — PAA 循环引擎（大脑层核心）
// 循环结构自研；分层思想参考 DSH Turn/Step（不 import）
// v2 决策：选"单层循环 + abort"，不引入多层嵌套状态机
//   · abort() 中断   · inject() 注入（预留）
//   · maxRounds 可配 · 每轮自动记忆检索（P1 钩子）
// ============================================================

import type {
  ChatMessage,
  LoopResult,
  MemoryProvider,
  SessionEvent,
} from './types.ts';
import type { ToolPipeline } from './tool-pipeline.ts';
import type { LLMAdapter } from './llm-adapter.ts';
import { supportsStreaming } from './llm-adapter.ts';
import type { SessionMgr } from './session-mgr.ts';
import { Compactor } from './compactor.ts';

export interface AgentLoopDeps {
  adapter: LLMAdapter;
  pipeline: ToolPipeline;
  session: SessionMgr;
  systemPrompt: string;
  /** P1 接入记忆系统；P0 为 null */
  memoryProvider?: MemoryProvider | null;
  /** 每轮 LLM 往返上限，默认 12 */
  maxRounds?: number;
  /**
   * 上下文压缩器（A2 Compaction）。
   * undefined = 默认启用（用 adapter 自动创建）；null = 显式禁用；实例 = 自定义配置
   */
  compactor?: Compactor | null;
}

export interface AgentLoopCtx {
  sessionId: string;
  cwd: string;
  ask: (prompt: string) => Promise<boolean>;
  audit: (line: string) => void;
}

/** run() 的可选扩展（console-v1：对话历史续跑 + 事件实时回调）；完全向后兼容 */
export interface RunOptions {
  /** 跨 run 对话历史（不含 system），插入 system 之后、本轮 user 之前 */
  prior?: ChatMessage[];
  /** 事件实时回调（WS 推送用）；事件同时仍进 session 与 result.events */
  onEvent?: (ev: SessionEvent) => void;
  /** 流式回调：assistant 文本增量（工具增量经 onEvent 的 tool 事件实时推，无需在此逐字符） */
  onDelta?: (text: string) => void;
}

/** 输出模式（v1.1：agent 每轮回复首行声明，loop 解析后随事件下发给前端） */
export type OutputMode = 'plan-execute' | 'single' | 'sequential' | 'text';

const MODE_RE = /^\s*\[MODE:(plan-execute|single|sequential|text)\]\s*/;

/** 解析并剥离首行 [MODE:xxx]，返回 { mode, content } */
export function parseMode(content: string | null | undefined): { mode: OutputMode | null; content: string } {
  const raw = content ?? '';
  const m = MODE_RE.exec(raw);
  if (!m) return { mode: null, content: raw };
  return { mode: m[1] as OutputMode, content: raw.slice(m[0].length) };
}

/** 工具结果注入上下文前的长度上限（防止长输出撑爆窗口） */
const MAX_TOOL_RESULT_CHARS = 8000;

function truncateToolResult(result: unknown): string {
  const s = JSON.stringify(result);
  return s.length > MAX_TOOL_RESULT_CHARS
    ? s.slice(0, MAX_TOOL_RESULT_CHARS) + `…[已截断: 原长 ${s.length} 字符，请用参数缩小范围后重查]`
    : s;
}

export class AgentLoop {
  private abortFlag = false;
  private injectQueue: SessionEvent[] = [];
  private readonly maxRounds: number;
  private readonly memoryProvider: MemoryProvider | null;
  private readonly compactor: Compactor | null;
  private deps: AgentLoopDeps;

  constructor(deps: AgentLoopDeps) {
    this.deps = deps;
    this.maxRounds = deps.maxRounds ?? 12;
    this.memoryProvider = deps.memoryProvider ?? null;
    // A2：默认启用 Compaction（undefined → 自动创建；null → 显式禁用；实例 → 自定义）
    this.compactor = deps.compactor !== undefined ? deps.compactor : new Compactor(deps.adapter);
  }

  /** 中断当前 run（下一轮检查点生效） */
  abort(): void {
    this.abortFlag = true;
  }

  /** 注入外部事件（预留：Inbox/宿主消息） */
  inject(event: SessionEvent): void {
    this.injectQueue.push(event);
  }

  /** 组装 system prompt：人格 + 记忆注入（P1）+ 工具清单 */
  private async buildSystemPrompt(userText: string): Promise<string> {
    let memBlock = '';
    if (this.memoryProvider) {
      const mems = await this.memoryProvider.search(userText, 3);
      if (mems.length) {
        memBlock =
          '\n\n# 相关记忆（自动检索注入）\n' +
          mems.map((m) => `- [${m.type}] ${m.content}`).join('\n');
      }
    }
    const tools = this.deps.pipeline.list();
    const toolBlock =
      '\n\n# 可用工具\n' +
      tools
        .map((t) => `- ${t.name}: ${t.desc}（参数: ${Object.keys(t.params).join(', ') || '无'}）`)
        .join('\n');
    return this.deps.systemPrompt + memBlock + toolBlock;
  }

  async run(userText: string, ctx: AgentLoopCtx, opts?: RunOptions): Promise<LoopResult> {
    this.abortFlag = false;
    const events: SessionEvent[] = [];
    const emit = (ev: SessionEvent): void => {
      events.push(ev);
      opts?.onEvent?.(ev);
    };

    emit({ ts: Date.now(), type: 'user', payload: { text: userText } });
    await this.deps.session.append(ctx.sessionId, events[events.length - 1]);

    const sys = await this.buildSystemPrompt(userText);
    let messages: ChatMessage[] = [{ role: 'system', content: sys }];

    // console-v1：注入跨 run 对话历史（不含 system）
    if (opts?.prior?.length) {
      messages.push(...opts.prior);
    }

    // 处理注入队列（预留）
    for (const ev of this.injectQueue.splice(0)) {
      if (ev.type === 'user') {
        messages.push({ role: 'user', content: String(ev.payload) });
      }
    }

    messages.push({ role: 'user', content: userText });

    let rounds = 0;
    let toolCalls = 0;
    // P0-C：收集过程摘要，maxRounds 耗尽/中断时给阶段总结（不裸停）
    const assistantNotes: string[] = [];
    const toolFailures: string[] = [];
    let toolOkCount = 0;
    let toolFailCount = 0;

    while (rounds < this.maxRounds && !this.abortFlag) {
      rounds++;
      // A2 Compaction：LLM 调用前检查上下文预算，超阈值 → 早期轮压缩为摘要
      // （原文已在 events.jsonl 全量落盘，压缩仅影响注入上下文，可回放/审计）
      if (this.compactor) {
        const compacted = await this.compactor.maybeCompact(messages);
        if (compacted.stats.triggered) {
          messages = compacted.messages;
          const ev: SessionEvent = {
            ts: Date.now(),
            type: 'system',
            payload: {
              text: `[compaction] 上下文 ${compacted.stats.totalChars}→${compacted.stats.afterChars} 字符，早期 ${compacted.stats.compactedRounds} 轮已压缩为摘要（原文在 events.jsonl）`,
            },
          };
          emit(ev);
          await this.deps.session.append(ctx.sessionId, ev);
        }
      }
      const toolDefs = this.deps.pipeline.list();
      let assistant: ChatMessage;
      // 流式优先（v1.1）：适配器支持则逐块回调 onDelta，前端打字机
      if (supportsStreaming(this.deps.adapter)) {
        assistant = await this.deps.adapter.chatStream(messages, { tools: toolDefs }, {
          onText: (d) => opts?.onDelta?.(d),
        });
      } else {
        assistant = await this.deps.adapter.chat(messages, { tools: toolDefs });
      }
      messages.push(assistant);

      // 解析输出模式（首行 [MODE:xxx]，从展示内容中剥离）
      const { mode, content } = parseMode(assistant.content);

      const ev: SessionEvent = {
        ts: Date.now(),
        type: 'assistant',
        payload: { content, mode, toolCalls: assistant.toolCalls?.length ?? 0 },
      };
      emit(ev);
      await this.deps.session.append(ctx.sessionId, ev);

      // 记录本轮中间说明（截断防刷屏）
      if (content.trim()) {
        const note = content.trim().replace(/\s+/g, ' ');
        if (note.length > 3) assistantNotes.push(`第${rounds}轮: ${note.slice(0, 160)}`);
      }

      // 没有工具调用 → 本轮完成
      if (!assistant.toolCalls?.length) {
        return {
          answer: content,
          rounds,
          toolCalls,
          events,
          aborted: false,
          messages: messages.slice(1), // 去 system：宿主续跑用
        };
      }

      // 执行工具调用（Step 层）
      for (const call of assistant.toolCalls) {
        if (this.abortFlag) break;
        toolCalls++;
        const result = await this.deps.pipeline.run(call, ctx);
        if (result.ok) toolOkCount++;
        else {
          toolFailCount++;
          toolFailures.push(`${call.name}: ${String(result.error).slice(0, 120)}`);
        }
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          content: truncateToolResult(result),
        });
        const toolEv: SessionEvent = {
          ts: Date.now(),
          type: 'tool',
          payload: { name: call.name, arguments: call.arguments, result },
        };
        emit(toolEv);
        await this.deps.session.append(ctx.sessionId, toolEv);
      }
    }

    // 阶段总结：做了什么 / 发现什么 / 未完成什么（替代裸停）
    const head = this.abortFlag ? `（用户中断，已执行 ${rounds} 轮）` : `已达到最大轮数 ${this.maxRounds}，已停止。本次执行摘要：`;
    const summary = [
      head,
      `- 已执行 ${rounds} 轮 / ${toolCalls} 次工具调用（成功 ${toolOkCount} / 失败 ${toolFailCount}）`,
      ...(assistantNotes.length ? ['- 过程：', ...assistantNotes.slice(-6)] : ['- 过程：无中间说明']),
      ...(toolFailures.length ? ['- 失败项：', ...toolFailures.slice(-6).map((f) => `  · ${f}`)] : []),
      `- 未完成：${userText.slice(0, 80)}。可继续提问，或调大 maxRounds / 收敛任务范围。`,
    ].join('\n');

    return {
      answer: summary,
      rounds,
      toolCalls,
      events,
      aborted: this.abortFlag,
      messages: messages.slice(1), // 去 system：宿主续跑用
    };
  }
}
