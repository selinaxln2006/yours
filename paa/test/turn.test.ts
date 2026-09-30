// 会话持久化只存本轮新增：run() 返回的 messages 含 prior，整段 append 会让历史每轮翻倍
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { turnMessages } from '../server/turn.ts';
import type { ChatMessage } from '../core/types.ts';

test('prior 原样在前 → 只取本轮', () => {
  const prior: ChatMessage[] = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }];
  const turn: ChatMessage[] = [{ role: 'user', content: 'c' }, { role: 'assistant', content: 'd' }];
  assert.deepEqual(turnMessages([...prior, ...turn], prior, 'c'), turn);
});

test('compaction 改写了前段 → 从本轮用户消息开始切', () => {
  const prior: ChatMessage[] = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }];
  const all: ChatMessage[] = [{ role: 'system', content: '[摘要]' }, { role: 'user', content: 'c' }, { role: 'assistant', content: 'd' }];
  assert.deepEqual(turnMessages(all, prior, 'c'), all.slice(1));
});

test('同一句话说两次时取最后一次', () => {
  const all: ChatMessage[] = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: '1' }, { role: 'user', content: 'hi' }, { role: 'assistant', content: '2' }];
  assert.deepEqual(turnMessages(all, [{ role: 'user', content: 'x' }], 'hi'), all.slice(2));
});
