// ============================================================
// 自动记忆：每隔几轮对话，让模型从最近的对话里挑出"关于用户的、值得长期记住的事"
// - 只记用户本人的稳定事实 / 偏好 / 习惯，不记一次性的事（今天吃了什么由生活数据管）
// - 与已有记忆重复的跳过；最多 3 条；解析失败就什么都不记
// - 记下的条目在「它眼中的你」里可看可改可删
// ============================================================

import type { ChatMessage } from '../core/types.ts';
import type { LLMAdapter } from '../core/llm-adapter.ts';

export interface ExtractedMemory {
  content: string;
  type: 'fact' | 'preference';
  tags: string[];
}

const PROMPT = `你在帮一个个人助手整理"关于用户的长期记忆"。下面是最近的对话。

只挑出关于用户本人、以后还会有用的稳定信息：习惯（"一到家就容易躺平"）、偏好（"不喜欢被催睡觉"）、长期安排（"周三晚上有课"）、处境（"在准备量化实习面试"）。
不要记：一次性的事（今天吃了什么、花了多少钱、某个待办）、助手说的话、猜测。

已经记住的（不要重复）：
__KNOWN__

只输出 JSON 数组，最多 3 条，没有就输出 []：
[{"content":"一句话，第三人称，如：用户一到家就容易躺平","type":"fact 或 preference","tags":["habit"]}]`;

/** 从模型输出里取出 JSON 数组并校验 */
export function parseExtracted(text: string, known: string[]): ExtractedMemory[] {
  const m = /\[[\s\S]*\]/.exec(text ?? '');
  if (!m) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(m[0]);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const norm = (s: string): string => s.replace(/\s+/g, '').replace(/[，。,.！!？?]/g, '');
  const seen = new Set(known.map(norm));
  const out: ExtractedMemory[] = [];
  for (const x of raw) {
    const content = typeof x?.content === 'string' ? x.content.trim().slice(0, 200) : '';
    if (content.length < 4) continue;
    const key = norm(content);
    if (seen.has(key) || [...seen].some((k) => k.includes(key) || key.includes(k))) continue;
    seen.add(key);
    const tags = Array.isArray(x.tags) ? x.tags.filter((t: unknown) => typeof t === 'string').slice(0, 4) : [];
    out.push({ content, type: x.type === 'preference' ? 'preference' : 'fact', tags: [...tags, 'auto'] });
    if (out.length >= 3) break;
  }
  return out;
}

/** 最近对话 → 文本（只要用户和助手的正文，工具调用不进） */
export function transcript(messages: ChatMessage[], maxChars = 4000): string {
  const lines = messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map((m) => `${m.role === 'user' ? '用户' : '助手'}：${String(m.content).replace(/^\[MODE:\w[\w-]*\]\s*/, '').trim()}`);
  let out = lines.join('\n');
  if (out.length > maxChars) out = out.slice(out.length - maxChars);
  return out;
}

export async function extractMemories(adapter: LLMAdapter, messages: ChatMessage[], known: string[]): Promise<ExtractedMemory[]> {
  const text = transcript(messages);
  if (!text) return [];
  const res = await adapter.chat([
    { role: 'system', content: PROMPT.replace('__KNOWN__', known.slice(-40).map((k) => `- ${k}`).join('\n') || '（暂无）') },
    { role: 'user', content: text },
  ], {});
  return parseExtracted(res.content ?? '', known);
}
