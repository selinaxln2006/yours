// messagesToUiHistory：还原会话时工具卡要带参数（"记了什么"），纯工具调用轮不产生空气泡
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messagesToUiHistory } from '../core/chat-session-store.ts';
import type { ChatMessage } from '../core/types.ts';

test('工具结果按 toolCallId 找回参数；空 assistant 轮跳过；MODE 标记剥离', () => {
  const msgs: ChatMessage[] = [
    { role: 'user', content: '午饭吃了饭团' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'life_add_meal', arguments: { name: '饭团', calories: 420 } }] },
    { role: 'tool', toolCallId: 'c1', name: 'life_add_meal', content: JSON.stringify({ ok: true, data: { id: 'm1' } }) },
    { role: 'assistant', content: '[MODE:single]\n记好了' },
  ];
  const ui = messagesToUiHistory(msgs) as unknown as Array<Record<string, unknown>>;
  assert.deepEqual(ui.map((m) => m.kind), ['user', 'tool', 'assistant']);
  assert.deepEqual(ui[1].args, { name: '饭团', calories: 420 });
  assert.equal(ui[1].state, 'ok');
  assert.equal(ui[2].text, '记好了');
});

test('工具失败保留错误；找不到对应调用时参数为空', () => {
  const ui = messagesToUiHistory([
    { role: 'tool', toolCallId: 'x', name: 'fs_write', content: JSON.stringify({ ok: false, error: '用户拒绝执行' }) },
  ]) as unknown as Array<Record<string, unknown>>;
  assert.equal(ui[0].state, 'err');
  assert.equal(ui[0].err, '用户拒绝执行');
  assert.equal(ui[0].args, undefined);
});
