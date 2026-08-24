// AgentLoop 编排链路测试：mock LLM（零 token）验证循环逻辑
// 场景：LLM 第一轮要求调 fs.write → 管道执行 → 第二轮返回最终回答
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { AgentLoop } from '../core/agent-loop.ts';
import { ToolPipeline } from '../core/tool-pipeline.ts';
import { SessionMgr } from '../core/session-mgr.ts';
import { Permission } from '../core/permission.ts';
import { createCoreTools } from '../tools/core-tools.ts';
import type { ChatMessage } from '../core/types.ts';
import type { LLMAdapter } from '../core/llm-adapter.ts';

class MockAdapter implements LLMAdapter {
  provider = 'mock';
  private script: Array<(msgs: ChatMessage[]) => ChatMessage>;

  constructor(script: Array<(msgs: ChatMessage[]) => ChatMessage>) {
    this.script = script;
  }

  async chat(messages: ChatMessage[]): Promise<ChatMessage> {
    const fn = this.script.shift();
    if (!fn) throw new Error('mock script 耗尽');
    return fn(messages);
  }
}

async function main() {
  const root = mkdtempSync(path.join(tmpdir(), 'paa-loop-'));
  const permission = new Permission(2);
  const pipeline = new ToolPipeline(permission);
  for (const t of createCoreTools(root)) pipeline.register(t);

  const session = new SessionMgr(path.join(root, 'runs'));
  const sessionId = await session.newSession();

  const adapter = new MockAdapter([
    // 第一轮：要求写文件
    () => ({
      role: 'assistant',
      content: '我来写文件',
      toolCalls: [{ id: 'c1', name: 'fs_write', arguments: { path: 'x.txt', content: 'hello' } }],
    }),
    // 第二轮：收尾
    () => ({ role: 'assistant', content: '文件已写入' }),
  ]);

  const loop = new AgentLoop({
    adapter,
    pipeline,
    session,
    systemPrompt: '测试',
    maxRounds: 5,
  });

  let asked = 0;
  const result = await loop.run('写个文件', {
    sessionId,
    cwd: root,
    ask: async () => {
      asked++;
      return true;
    },
    audit: () => {},
  });

  assert.equal(asked, 1, 'fs.write risk3 在 L2 应触发一次确认');
  assert.equal(result.rounds, 2, '应两轮收敛');
  assert.equal(result.toolCalls, 1);
  assert.equal(result.answer, '文件已写入');
  assert.equal(result.aborted, false);

  // 事件溯源：user / assistant / tool / assistant
  const events = await session.load(sessionId);
  assert.equal(events.length, 4);
  assert.deepEqual(events.map((e) => e.type), ['user', 'assistant', 'tool', 'assistant']);

  // 文件真的写了
  const { readFile } = await import('node:fs/promises');
  const content = await readFile(path.join(root, 'x.txt'), 'utf8');
  assert.equal(content, 'hello');

  console.log('✅ AgentLoop 编排测试通过（2 轮收敛 / 1 次工具 / 事件溯源 4 条）');
}

main().catch((e) => {
  console.error('❌ 编排测试失败:', e);
  process.exit(1);
});
