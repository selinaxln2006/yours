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
import type { SessionMgr } from './session-mgr.ts';

export interface AgentLoopDeps {
  adapter: LLMAdapter;
  pipeline: ToolPipeline;
  session: SessionMgr;
  systemPrompt: string;
  /** P1 接入记忆系统；P0 为 null */
  memoryProvider?: MemoryProvider | null;
  /** 每轮 LLM 往返上限，默认 12 */
  maxRounds?: number;
}

export interface AgentLoopCtx {
  sessionId: string;
  cwd: string;
  ask: (prompt: string) => Promise<boolean>;
  audit: (line: string) => void;
}

export class AgentLoop {
  private abortFlag = false;
  private injectQueue: SessionEvent[] = [];
  private readonly maxRounds: number;
  private readonly memoryProvider: MemoryProvider | null;
  private deps: AgentLoopDeps;

  constructor(deps: AgentLoopDeps) {
    this.deps = deps;
    this.maxRounds = deps.maxRounds ?? 12;
    this.memoryProvider = deps.memoryProvider ?? null;
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

  async run(userText: string, ctx: AgentLoopCtx): Promise<LoopResult> {
    this.abortFlag = false;
    const events: SessionEvent[] = [];

    events.push({ ts: Date.now(), type: 'user', payload: { text: userText } });
    await this.deps.session.append(ctx.sessionId, events[events.length - 1]);

    const sys = await this.buildSystemPrompt(userText);
    const messages: ChatMessage[] = [{ role: 'system', content: sys }];

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
      const assistant = await this.deps.adapter.chat(messages, {
        tools: this.deps.pipeline.list(),
      });
      messages.push(assistant);

      const ev: SessionEvent = {
        ts: Date.now(),
        type: 'assistant',
        payload: { content: assistant.content, toolCalls: assistant.toolCalls?.length ?? 0 },
      };
      events.push(ev);
      await this.deps.session.append(ctx.sessionId, ev);

      // 记录本轮中间说明（截断防刷屏）
      if (assistant.content?.trim()) {
        const note = assistant.content.trim().replace(/\s+/g, ' ');
        if (note.length > 3) assistantNotes.push(`第${rounds}轮: ${note.slice(0, 160)}`);
      }

      // 没有工具调用 → 本轮完成
      if (!assistant.toolCalls?.length) {
        return {
          answer: assistant.content ?? '',
          rounds,
          toolCalls,
          events,
          aborted: false,
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
          content: JSON.stringify(result),
        });
        const toolEv: SessionEvent = {
          ts: Date.now(),
          type: 'tool',
          payload: { name: call.name, arguments: call.arguments, result },
        };
        events.push(toolEv);
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
    };
  }
}
