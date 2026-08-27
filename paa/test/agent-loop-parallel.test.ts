// AgentLoop ⑤ 并行工具测试：
// 同轮多工具调用并行执行（Promise.all）/ ask 类串行（不并发弹确认框）/ deny 类并行拒绝
// / 结果按 call.id 顺序注入（messages 与事件顺序稳定）
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { AgentLoop } from '../core/agent-loop.ts';
import { ToolPipeline } from '../core/tool-pipeline.ts';
import { SessionMgr } from '../core/session-mgr.ts';
import { Permission } from '../core/permission.ts';
import type { ChatMessage } from '../core/types.ts';
import type { LLMAdapter } from '../core/llm-adapter.ts';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
  // ── 用例 1：同轮 3 个无依赖调用并行执行（L1：risk1 读工具 allow，参与并行）──
  {
    const root = mkdtempSync(path.join(tmpdir(), 'paa-ploop-'));
    const session = new SessionMgr(path.join(root, 'runs'));
    const sessionId = await session.newSession();
    const ctx = { sessionId, cwd: root, ask: async () => true, audit: () => {} };

    const active = { n: 0, max: 0 };
    const pipeline = new ToolPipeline(new Permission(1));
    pipeline.register({
      name: 't_read',
      desc: '读测试',
      params: { key: { type: 'string', desc: 'key' } },
      risk: 1,
      handler: async (args) => {
        active.n++;
        if (active.n > active.max) active.max = active.n;
        await sleep(50);
        active.n--;
        return { echo: String(args.key) };
      },
    });

    const adapter = new MockAdapter([
      () => ({
        role: 'assistant',
        content: '并行读三个',
        toolCalls: [
          { id: 'c1', name: 't_read', arguments: { key: 'a' } },
          { id: 'c2', name: 't_read', arguments: { key: 'b' } },
          { id: 'c3', name: 't_read', arguments: { key: 'c' } },
        ],
      }),
      () => ({ role: 'assistant', content: '读完了' }),
    ]);

    const loop = new AgentLoop({ adapter, pipeline, session, systemPrompt: '测试', maxRounds: 5 });
    const result = await loop.run('并行读', ctx);
    assert.equal(result.toolCalls, 3);
    assert.ok(active.max >= 2, `应并行执行（最大同时运行 ${active.max}，期望 ≥2）`);
    // 结果按 call.id 顺序注入：tool 事件 arguments.key 顺序 = a,b,c
    const toolEvents = result.events.filter((e) => e.type === 'tool');
    assert.equal(toolEvents.length, 3);
    const keys = toolEvents.map((e) => (e.payload as { arguments?: { key?: string } }).arguments?.key);
    assert.deepEqual(keys, ['a', 'b', 'c']);
    assert.equal(result.rounds, 2);
    console.log('✅ 并行工具: 同轮 3 调用并行 + 结果按 call.id 顺序注入');
  }

  // ── 用例 2：ask 类工具串行（不并发弹确认框）──
  {
    const root = mkdtempSync(path.join(tmpdir(), 'paa-ploop-'));
    const session = new SessionMgr(path.join(root, 'runs'));
    const sessionId = await session.newSession();

    const active = { n: 0, max: 0 };
    const pipeline = new ToolPipeline(new Permission(2)); // risk3 写工具 → ask
    pipeline.register({
      name: 't_write',
      desc: '写测试',
      params: { key: { type: 'string', desc: 'key' } },
      risk: 3,
      handler: async (args) => {
        active.n++;
        if (active.n > active.max) active.max = active.n;
        await sleep(50);
        active.n--;
        return { ok: true, key: String(args.key) };
      },
    });

    let asked = 0;
    const adapter = new MockAdapter([
      () => ({
        role: 'assistant',
        content: '串行写两个',
        toolCalls: [
          { id: 'c1', name: 't_write', arguments: { key: 'x' } },
          { id: 'c2', name: 't_write', arguments: { key: 'y' } },
        ],
      }),
      () => ({ role: 'assistant', content: '写完了' }),
    ]);

    const loop = new AgentLoop({ adapter, pipeline, session, systemPrompt: '测试', maxRounds: 5 });
    const result = await loop.run('串行写', {
      sessionId,
      cwd: root,
      ask: async () => {
        asked++;
        return true;
      },
      audit: () => {},
    });
    assert.equal(asked, 2, '每个 ask 工具都应各确认一次');
    assert.equal(active.max, 1, `ask 类应串行（最大同时运行 ${active.max}，期望 1）`);
    assert.equal(result.toolCalls, 2);
    console.log('✅ 并行工具: ask 类串行（不并发弹确认框）');
  }

  // ── 用例 3：deny 类并行返回拒绝（FORBID 硬拒绝，无用户交互）──
  {
    const root = mkdtempSync(path.join(tmpdir(), 'paa-ploop-'));
    const session = new SessionMgr(path.join(root, 'runs'));
    const sessionId = await session.newSession();
    const ctx = { sessionId, cwd: root, ask: async () => true, audit: () => {} };

    const permission = new Permission(4);
    permission.forbid('t_read');
    const pipeline = new ToolPipeline(permission);
    pipeline.register({
      name: 't_read',
      desc: '读测试',
      params: {},
      risk: 1,
      handler: async () => ({ ok: true }),
    });

    const adapter = new MockAdapter([
      () => ({
        role: 'assistant',
        content: '尝试被禁工具',
        toolCalls: [
          { id: 'c1', name: 't_read', arguments: {} },
          { id: 'c2', name: 't_read', arguments: {} },
        ],
      }),
      () => ({ role: 'assistant', content: '完成' }),
    ]);

    const loop = new AgentLoop({ adapter, pipeline, session, systemPrompt: '测试', maxRounds: 5 });
    const result = await loop.run('禁调用', ctx);
    const toolEvents = result.events.filter((e) => e.type === 'tool') as Array<{
      payload: { result?: { ok?: boolean } };
    }>;
    assert.equal(toolEvents.length, 2);
    assert.ok(toolEvents.every((e) => e.payload?.result?.ok === false), 'FORBID 应全部拒绝');
    console.log('✅ 并行工具: deny 类并行拒绝（FORBID）');
  }
}

main().catch((e) => {
  console.error('❌ 并行工具测试失败:', e);
  process.exit(1);
});
