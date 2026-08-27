// ============================================================
// Compactor — 上下文预算 + 结构化摘要替换（goal-level 六件套 ②）
// 长任务上下文必爆：存储不花钱，注入才花钱——原文全存（events.jsonl L0 层
// 已逐轮落盘，可回放/审计），摘要进上下文。
//
// 设计要点：
// · 挂载点 = AgentLoop run() 每轮 LLM 调用前（messages 数组组装点）
// · 轮次边界 = assistant 消息 + 后续连续 tool 消息；user 指令永不压缩
// · 尾部保留 = 最新 minTailRounds 轮永不压缩（agent 需要近期上下文）
// · 摘要消息 = role:'user' + 固定标记（不碰 system 首位约束，跨 API 兼容）
// · 预算循环 = 一批不够继续压下一批（最多 MAX_PASSES），缩到预算内为止
// · 摘要失败 = 保守降级：原样返回，宁可爆上下文也不破坏执行
// ============================================================

import type { ChatMessage } from './types.ts';
import type { LLMAdapter } from './llm-adapter.ts';

/** 摘要消息的固定内容前缀（识别"已压缩轮"的标记） */
export const SUMMARY_MARKER = '[早期上下文摘要]';

export interface CompactionOptions {
  /** 上下文预算（字符），超过才触发压缩。默认 60000 */
  budgetChars?: number;
  /** 尾部保留的最新轮数（永不压缩）。默认 4 */
  minTailRounds?: number;
  /** 单批压缩的轮数。默认 3 */
  batchRounds?: number;
  /** 摘要生成调用的 maxTokens。默认 1024 */
  summaryMaxTokens?: number;
}

export interface CompactionStats {
  triggered: boolean;
  totalChars: number;
  afterChars: number;
  compactedRounds: number;
  summaryChars: number;
}

/** 单轮在 messages 中的范围 [start, end) */
interface Round {
  start: number;
  end: number;
}

const DEFAULT_OPTS: Required<CompactionOptions> = {
  budgetChars: 60000,
  minTailRounds: 4,
  batchRounds: 3,
  summaryMaxTokens: 1024,
};

/** 单次 maybeCompact 内最多压缩几批（防御死循环） */
const MAX_PASSES = 3;

/** 粗略字符估算：content + toolCalls 参数序列化 */
function estimateChars(m: ChatMessage): number {
  let n = (m.content ?? '').length;
  if (m.toolCalls?.length) {
    for (const tc of m.toolCalls) {
      n += tc.name.length + 32;
      try {
        n += JSON.stringify(tc.arguments).length;
      } catch {
        n += 64;
      }
    }
  }
  return n;
}

function totalChars(messages: ChatMessage[]): number {
  let n = 0;
  for (const m of messages) n += estimateChars(m);
  return n;
}

/** 提取轮次边界：assistant 消息 + 其后连续 tool 消息；user 消息被自然跳过（不属任何轮） */
function findRounds(messages: ChatMessage[], fromIndex: number): Round[] {
  const rounds: Round[] = [];
  let i = fromIndex;
  while (i < messages.length) {
    if (messages[i].role === 'assistant') {
      let j = i + 1;
      while (j < messages.length && messages[j].role === 'tool') j++;
      rounds.push({ start: i, end: j });
      i = j;
    } else {
      i++;
    }
  }
  return rounds;
}

const SUMMARY_PROMPT = `你是 PAA 智能体的上下文压缩器。把以下早期对话轮次压缩为结构化摘要，目标是让智能体仅凭摘要即可继续执行任务，不丢失关键信息。

输出（简体中文，紧凑，四段，不要其它格式）：
【做了什么】关键动作与产物
【发现】关键事实：文件路径、符号名、决策、工具结果要点
【当前状态】进行到哪一步
【待办/关键数据】后续仍需要的数值、id、路径、命令原文

要求：
- 保留所有具体标识符（文件路径、类名/函数名、端口号、id、命令），一字不改
- 丢弃客套、重复、探索性过程
- 总长度控制在 400 字以内`;

export class Compactor {
  private adapter: LLMAdapter;
  private opts: Required<CompactionOptions>;

  constructor(adapter: LLMAdapter, options?: CompactionOptions) {
    this.adapter = adapter;
    this.opts = { ...DEFAULT_OPTS, ...options };
  }

  /** 预算检查 + 压缩。messages 超预算时返回压缩后的新数组；否则原样返回 */
  async maybeCompact(messages: ChatMessage[]): Promise<{ messages: ChatMessage[]; stats: CompactionStats }> {
    const startTotal = totalChars(messages);
    if (startTotal <= this.opts.budgetChars) {
      return { messages, stats: { triggered: false, totalChars: startTotal, afterChars: startTotal, compactedRounds: 0, summaryChars: 0 } };
    }

    let current = messages;
    let compactedRounds = 0;
    let summaryChars = 0;
    let passes = 0;

    while (totalChars(current) > this.opts.budgetChars && passes < MAX_PASSES) {
      const batch = await this.compactOneBatch(current);
      passes++;
      if (batch.compacted === 0) break; // 无可压缩轮（已全是尾部）→ 止损
      current = batch.messages;
      compactedRounds += batch.compacted;
      summaryChars += batch.summaryChars;
    }

    return {
      messages: current,
      stats: {
        triggered: true,
        totalChars: startTotal,
        afterChars: totalChars(current),
        compactedRounds,
        summaryChars,
      },
    };
  }

  /** 压缩最早一批轮次：摘要替换，user 指令与尾部保留 */
  private async compactOneBatch(messages: ChatMessage[]): Promise<{ messages: ChatMessage[]; compacted: number; summaryChars: number }> {
    const rounds = findRounds(messages, 0);
    const compressible = rounds.length - this.opts.minTailRounds;
    if (compressible <= 0) return { messages, compacted: 0, summaryChars: 0 };

    const batch = Math.min(this.opts.batchRounds, compressible);
    const batchRounds = rounds.slice(0, batch);

    // 待压缩内容 = 本轮次内消息（assistant + tool），不含夹在轮间的 user 指令
    const target: ChatMessage[] = [];
    for (const r of batchRounds) {
      for (let i = r.start; i < r.end; i++) target.push(messages[i]);
    }
    const summary = await this.summarize(target);
    if (!summary) return { messages, compacted: 0, summaryChars: 0 }; // 摘要失败 → 本次不压缩

    const summaryMsg: ChatMessage = { role: 'user', content: SUMMARY_MARKER + '\n' + summary };
    // 遍历重建：轮内消息 → 摘要（插在第一批起点）；其余（system/user/已有摘要/未压缩轮）原样保留
    const next: ChatMessage[] = [];
    let inserted = false;
    for (let i = 0; i < messages.length; i++) {
      const isBatch = batchRounds.some((r) => i >= r.start && i < r.end);
      if (isBatch) {
        if (!inserted) {
          next.push(summaryMsg);
          inserted = true;
        }
        continue;
      }
      next.push(messages[i]);
    }
    return { messages: next, compacted: batch, summaryChars: summary.length };
  }

  /** 调 LLM 生成结构化摘要；失败返回 null（调用方止损，不破坏执行） */
  private async summarize(target: ChatMessage[]): Promise<string | null> {
    try {
      const content = target
        .map((m) => {
          const head = m.role === 'assistant' ? 'AI' : m.role === 'tool' ? `工具结果(${m.name})` : '用户';
          return `【${head}】${(m.content ?? '').slice(0, 2000)}`;
        })
        .join('\n');
      const res = await this.adapter.chat(
        [
          { role: 'system', content: SUMMARY_PROMPT },
          { role: 'user', content: `以下是待压缩的对话轮次：\n${content}` },
        ],
        { maxTokens: this.opts.summaryMaxTokens, temperature: 0.1 },
      );
      const text = (res.content ?? '').trim();
      return text.length >= 20 ? text : null;
    } catch (e) {
      // 摘要失败 → 保守降级：本次不压缩（宁可超预算也不破坏执行链）
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[compactor] 摘要生成失败，跳过本次压缩: ${msg.slice(0, 120)}`);
      return null;
    }
  }
}
