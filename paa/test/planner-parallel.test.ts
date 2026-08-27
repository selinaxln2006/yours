// Planner ⑤ 子任务并发测试：
// concurrency=2 独立任务并行 / 默认 1 严格顺序（行为不变）/ 依赖链在并发下不被破坏
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Planner, type TaskTree } from '../core/planner.ts';
import type { AgentLoopCtx } from '../core/agent-loop.ts';
import { SessionMgr } from '../core/session-mgr.ts';
import { ToolPipeline } from '../core/tool-pipeline.ts';
import { Permission } from '../core/permission.ts';
import type { LLMAdapter, ChatOptions } from '../core/llm-adapter.ts';
import type { ChatMessage } from '../core/types.ts';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 记录每次 chat 调用起止；以 resumeTree 续跑 → 无 plan 调用，全部调用 = 子任务执行 */
class MockAdapter implements LLMAdapter {
  provider = 'mock';
  calls = 0;
  starts: number[] = [];
  ends: number[] = [];
  async chat(_messages: ChatMessage[], _opts?: ChatOptions): Promise<ChatMessage> {
    this.calls++;
    this.starts.push(Date.now());
    await sleep(60);
    this.ends.push(Date.now());
    // 无 toolCalls → AgentLoop 一轮收敛；note 含"已完成"（DONE_EVIDENCE）→ 不触发 idleFakeDone
    return { role: 'assistant', content: '结论：已完成' };
  }
}

async function setup(concurrency: number | undefined, tree: TaskTree) {
  const base = await mkdtemp(path.join(tmpdir(), 'paa-ppar-'));
  const session = new SessionMgr(base);
  const sid = await session.newSession();
  await writeFile(path.join(session.sessionDir(sid), 'task-tree.json'), JSON.stringify(tree, null, 2), 'utf8');
  const adapter = new MockAdapter();
  const planner = new Planner({
    adapter,
    pipeline: new ToolPipeline(new Permission(4)),
    session,
    baseSystemPrompt: 'test system',
    memoryProvider: null,
    options: { maxTasks: 6, subtaskRounds: 5, subtaskConcurrency: concurrency },
  });
  const ctx: AgentLoopCtx = { sessionId: sid, cwd: base, ask: async () => true, audit: () => {} };
  return { adapter, planner, ctx, tree };
}

async function main() {
  // ── 用例 1：concurrency=2 → t1/t2 并行，t3 等两者完成 ──
  {
    const tree: TaskTree = {
      goal: '并发测试',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      tasks: [
        { id: 't1', desc: '准备数据 A', verify: 'v1', deps: [], status: 'pending' },
        { id: 't2', desc: '准备数据 B', verify: 'v2', deps: [], status: 'pending' },
        { id: 't3', desc: '汇总合并 A 与 B', verify: 'v3', deps: ['t1', 't2'], status: 'pending' },
      ],
    };
    const { adapter, planner, ctx, tree: t } = await setup(2, tree);
    const result = await planner.run('并发测试', ctx, t);
    assert.equal(result.doneCount, 3, '三个子任务应全部成功');
    assert.equal(adapter.calls, 3, '应恰好 3 次子任务调用（无 replan）');
    assert.ok(adapter.starts[1] < adapter.ends[0], 't1 未完成时 t2 已开始（并行执行）');
    assert.ok(adapter.starts[2] >= adapter.ends[1], 't3 应等 t1/t2 都完成再开始');
    console.log('✅ planner 并发: concurrency=2 独立任务并行 + 依赖任务等待');
  }

  // ── 用例 2：默认 concurrency=1 → 严格顺序（行为不变）──
  {
    const tree: TaskTree = {
      goal: '顺序测试',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      tasks: [
        { id: 't1', desc: '准备数据 A', verify: 'v1', deps: [], status: 'pending' },
        { id: 't2', desc: '准备数据 B', verify: 'v2', deps: [], status: 'pending' },
      ],
    };
    const { adapter, planner, ctx, tree: t } = await setup(undefined, tree);
    const result = await planner.run('顺序测试', ctx, t);
    assert.equal(result.doneCount, 2);
    assert.ok(adapter.starts[1] >= adapter.ends[0], '默认并发 1：t2 应在 t1 完成后开始');
    console.log('✅ planner 并发: 默认 1 = 顺序执行（行为不变）');
  }

  // ── 用例 3：链式依赖 t1→t2→t3 在 concurrency=3 下也不越级 ──
  {
    const tree: TaskTree = {
      goal: '链式测试',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      tasks: [
        { id: 't1', desc: '阶段一', verify: 'v1', deps: [], status: 'pending' },
        { id: 't2', desc: '阶段二', verify: 'v2', deps: ['t1'], status: 'pending' },
        { id: 't3', desc: '阶段三', verify: 'v3', deps: ['t2'], status: 'pending' },
      ],
    };
    const { adapter, planner, ctx, tree: t } = await setup(3, tree);
    const result = await planner.run('链式测试', ctx, t);
    assert.equal(result.doneCount, 3);
    assert.ok(adapter.starts[1] >= adapter.ends[0], 't2 不能与 t1 并行（依赖）');
    assert.ok(adapter.starts[2] >= adapter.ends[1], 't3 不能与 t2 并行（依赖）');
    console.log('✅ planner 并发: 依赖链在并发下不被破坏');
  }
}

main().catch((e) => {
  console.error('❌ planner 并发测试失败:', e);
  process.exit(1);
});
