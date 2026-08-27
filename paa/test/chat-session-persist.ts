// t4 重启持久化验证：ChatSessionStore 落盘(data/sessions/*.json) + 重启后会话数据仍在
// 用两个独立 store 实例模拟"启动→写入→重启→读回"，不依赖真实 LLM。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { ChatSessionStore } from '../core/chat-session-store.ts';
import type { ChatMessage } from '../core/types.ts';
import type { UiMsg } from '../core/chat-session-store.ts';

test('t4 重启持久化：会话与消息在重启后仍可从磁盘恢复', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'paa-sessions-'));

  // ---- 第一次启动：新建会话 + 追加消息（模拟一次对话） ----
  const storeA = new ChatSessionStore(dir);
  await storeA.init();
  const rec = await storeA.create();
  assert.ok(rec.id, 'create 应返回带 id 的会话');

  const msgs: ChatMessage[] = [
    { role: 'user', content: '你好，帮我记录今天的体重' },
    { role: 'assistant', content: '好的，请告诉我今天的体重数值。', refs: [] },
  ];
  const ui: UiMsg[] = [
    { kind: 'user', text: '你好，帮我记录今天的体重', ts: Date.now() },
    { kind: 'assistant', text: '好的，请告诉我今天的体重数值。', mode: null, ts: Date.now() },
  ];
  const updated = await storeA.append(rec.id, msgs, ui);
  assert.ok(updated, 'append 应返回更新后的会话');
  assert.equal(updated!.messages.length, 2, 'messages 应含 2 条');
  assert.notEqual(updated!.title, '新对话', '首条 user 应自动生成标题');

  // 落盘文件存在
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.ok(files.includes(`${rec.id}.json`), `data/sessions 应落盘 ${rec.id}.json`);

  // ---- 模拟重启：全新 store 实例（等价 server 重启后重新 init） ----
  const storeB = new ChatSessionStore(dir);
  await storeB.init();

  // 列表能读回
  const list = storeB.list();
  assert.equal(list.length, 1, '重启后 list 应恢复 1 个会话');
  assert.equal(list[0].id, rec.id, '重启后会话 id 应一致');
  assert.equal(list[0].messageCount, 2, '重启后消息数应为 2');

  // 详情能读回完整消息
  const restored = await storeB.get(rec.id);
  assert.ok(restored, '重启后 get 应恢复会话');
  assert.equal(restored!.messages.length, 2, '重启后 messages 应完整保留');
  assert.equal(restored!.uiHistory.length, 2, '重启后 uiHistory 应完整保留');
  assert.equal(restored!.messages[0].content, '你好，帮我记录今天的体重');
  assert.equal(restored!.title, updated!.title, '重启后标题应保留');

  // 重启后还能继续追加（数据不丢也不冲突）
  const again = await storeB.append(rec.id, [
    { role: 'user', content: '57.5kg', refs: [] },
  ], [{ kind: 'user', text: '57.5kg', ts: Date.now() }]);
  assert.equal(again!.messages.length, 3, '重启后追加应生效');

  // 落盘文件无 .tmp 残留（原子写完成）
  assert.ok(!existsSync(path.join(dir, `${rec.id}.json.tmp`)), '不应有 .tmp 残留');
});
