import type { ChatMessage } from '../core/types.ts';

/**
 * 本轮新增的消息。AgentLoop.run() 返回的 messages 含传入的 prior 历史 + 本轮；
 * 直接整段 append 会让历史每轮翻倍（并作为 prior 喂回模型）。
 * 正常情况下 prior 以原对象引用排在最前 → 按长度切；若 compaction 改写了前段，
 * 退回到从本轮用户消息（最后一条同文 user 消息）开始切。
 */
export function turnMessages(all: ChatMessage[], prior: ChatMessage[], userText: string): ChatMessage[] {
  if (all.length >= prior.length && prior.every((m, i) => all[i] === m)) return all.slice(prior.length);
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i].role === 'user' && all[i].content === userText) return all.slice(i);
  }
  return all;
}
