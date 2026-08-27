// A2 Compaction 集成验证：真实 AgentLoop + mock 30 轮大工具结果
// 验证：上下文超预算 → 自动压缩 → 事件流记录 → 消息量被限制 → 正常收敛
// 跑法：node paa/scripts/smoke-compaction.ts
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentLoop } from '../core/agent-loop.ts';
import { Compactor } from '../core/compactor.ts';
import { ToolPipeline } from '../core/tool-pipeline.ts';
import { SessionMgr } from '../core/session-mgr.ts';
import { Permission } from '../core/permission.ts';
import { createCoreTools } from '../tools/core-tools.ts';
import type { ChatMessage } from '../core/types.ts';
import type { LLMAdapter, ChatOptions } from '../core/llm-adapter.ts';

/** 摘要调用走独立分支，其余按脚本走 */
class MockAdapter implements LLMAdapter {
  provider = 'mock';
  summarizeCalls = 0;
  private script: Array<(msgs: ChatMessage[]) => ChatMessage>;

  constructor(script: Array<(msgs: ChatMessage[]) => ChatMessage>) {
    this.script = script;
  }

  async chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatMessage> {
    const sys = messages[0]?.content ?? '';
    if (sys.includes('上下文压缩器')) {
      this.summarizeCalls++;
      return {
        role: 'assistant',
        content: '【做了什么】持续读取 big.txt【发现】内容为重复文本【当前状态】读取中【待办/关键数据】继续执行直到轮次结束',
      };
    }
    const fn = this.script.shift();
    if (!fn) throw new Error(`mock script 耗尽（剩余消息 ${messages.length} 条，无工具调用？）`);
    return fn(messages);
  }
}

function charsOf(msgs: ChatMessage[]): number {
  return msgs.reduce((n, m) => n + (m.content ?? '').length, 0);
}

async function main() {
  const root = mkdtempSync(path.join(tmpdir(), 'paa-compact-'));
  // 大文件：fs_read 每轮返回 ~20k 字符（截断 8k）→ 30 轮轻松超预算
  writeFileSync(path.join(root, 'big.txt'), Array.from({ length: 200 }, (_, i) => `第 ${i} 行 ` + 'x'.repeat(90)).join('\n'), 'utf8');

  const permission = new Permission(2);
  const pipeline = new ToolPipeline(permission);
  for (const t of createCoreTools(root)) pipeline.register(t);

  const session = new SessionMgr(path.join(root, 'runs'));
  const sessionId = await session.newSession();

  // 30 轮 fs_read + 1 收尾轮
  const script: Array<(msgs: ChatMessage[]) => ChatMessage> = [];
  for (let i = 0; i < 30; i++) {
    script.push(() => ({
      role: 'assistant',
      content: `第 ${i} 轮：继续读取 big.txt`,
      toolCalls: [{ id: `c${i}`, name: 'fs_read', arguments: { path: 'big.txt' } }],
    }));
  }
  script.push(() => ({ role: 'assistant', content: '读取完成，任务收敛' }));

  const adapter = new MockAdapter(script);
  const loop = new AgentLoop({
    adapter,
    pipeline,
    session,
    systemPrompt: '测试长任务：反复读取 big.txt 直到完成',
    maxRounds: 40,
    // 预算压小（30k），确保 30 轮 × 8k 必然触发压缩
    compactor: new Compactor(adapter, { budgetChars: 30000, minTailRounds: 2, batchRounds: 3 }),
  });

  let asked = 0;
  const result = await loop.run('反复读取 big.txt', {
    sessionId,
    cwd: root,
    ask: async () => {
      asked++;
      return true;
    },
    audit: () => {},
  });

  assert.equal(result.rounds, 31, '30 工具轮 + 1 收尾轮');
  assert.ok(adapter.summarizeCalls >= 1, `应触发至少 1 次摘要调用（实际 ${adapter.summarizeCalls}）`);

  // 事件流应含 compaction system 事件
  const events = await session.load(sessionId);
  const compactEvents = events.filter((e) => e.type === 'system' && String((e.payload as { text?: string }).text ?? '').includes('[compaction]'));
  assert.ok(compactEvents.length >= 1, '事件流应有 [compaction] 记录');

  // 消息量被压缩限制（30 轮 × 8k = 240k 不压会爆；压后应远小于）
  const finalChars = charsOf(result.messages ?? []);
  assert.ok(finalChars < 120000, `压缩后消息量应显著低于 240k（实际 ${finalChars}）`);
  assert.equal(result.answer, '读取完成，任务收敛');

  console.log(`✅ Compaction 集成验证通过：${result.rounds} 轮 / ${adapter.summarizeCalls} 次摘要 / ${compactEvents.length} 条 [compaction] 事件 / 消息 ${finalChars} 字符（未压估算 ~240k）`);
  console.log(`   事件样例: ${String((compactEvents[0].payload as { text?: string }).text ?? '').slice(0, 80)}...`);
}

main().catch((e) => {
  console.error('❌ Compaction 集成验证失败:', e);
  process.exit(1);
});
