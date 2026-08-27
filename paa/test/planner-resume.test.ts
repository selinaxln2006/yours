// Planner A3 断点续跑测试：loadTree 校验 / run(resumeTree) 跳过 done、重跑 failed、running 降级、幂等
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Planner, type TaskTree } from '../core/planner.ts';
import type { AgentLoopCtx } from '../core/agent-loop.ts';
import { SessionMgr } from '../core/session-mgr.ts';
import { ToolPipeline } from '../core/tool-pipeline.ts';
import { Permission } from '../core/permission.ts';
import type { LLMAdapter, ChatOptions } from '../core/llm-adapter.ts';
import type { ChatMessage } from '../core/types.ts';

class MockAdapter implements LLMAdapter {
  provider = 'mock';
  calls: Array<{ messages: ChatMessage[]; opts?: ChatOptions }> = [];
  async chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatMessage> {
    this.calls.push({ messages, opts });
    // 子任务 mock 回复：带"已满足"证据词 → K8 idleFakeDone 不误杀（实现类 desc 也安全）
    return { role: 'assistant', content: '完成：目标已满足，无需改动' };
  }
}

async function setup(): Promise<{
  base: string;
  session: SessionMgr;
  adapter: MockAdapter;
  planner: Planner;
  sid: string;
  ctx: AgentLoopCtx;
}> {
  const base = await mkdtemp(path.join(tmpdir(), 'paa-resume-'));
  const session = new SessionMgr(base);
  const sid = await session.newSession();
  const adapter = new MockAdapter();
  const planner = new Planner({
    adapter,
    pipeline: new ToolPipeline(new Permission(4)),
    session,
    baseSystemPrompt: 'test system',
    memoryProvider: null,
    options: { maxTasks: 6, subtaskRounds: 10 },
  });
  const ctx: AgentLoopCtx = { sessionId: sid, cwd: base, ask: async () => true, audit: () => {} };
  return { base, session, adapter, planner, sid, ctx };
}

/** 直接落盘一棵任务树（模拟"跑到一半被杀"的现场） */
async function seedTree(session: SessionMgr, sid: string, tree: TaskTree): Promise<void> {
  await writeFile(path.join(session.sessionDir(sid), 'task-tree.json'), JSON.stringify(tree, null, 2), 'utf8');
}

async function main() {
  // ── 用例 1：resume 跳过 done、重跑 failed、跑 pending（依赖链 t1→t2→t3）──
  {
    const { base, session, adapter, planner, sid, ctx } = await setup();
    const tree: TaskTree = {
      goal: '断点测试目标',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      tasks: [
        { id: 't1', desc: '第一步', verify: '检查 t1', deps: [], status: 'done', rounds: 3, toolCalls: 5, note: '结论：t1 产出' },
        { id: 't2', desc: '第二步', verify: '检查 t2', deps: ['t1'], status: 'failed', note: '旧失败原因（应被重跑覆盖）' },
        { id: 't3', desc: '第三步', verify: '检查 t3', deps: ['t2'], status: 'pending' },
      ],
    };
    await seedTree(session, sid, tree);

    const result = await planner.run(tree.goal, ctx, tree);

    assert.equal(adapter.calls.length, 2, 't1 应被跳过，只跑 t2/t3');
    assert.equal(result.doneCount, 3, '续跑后 3/3 成功');
    assert.equal(result.outcomes.t1?.note, '结论：t1 产出', 'done 子任务原 note 应保留');
    assert.equal(tree.tasks[1]?.status, 'done', 'failed 子任务重跑后应为 done');
    assert.equal(tree.tasks[2]?.status, 'done', 'pending 子任务应执行');
    // 没有 plan 调用：所有 LLM 调用都是子任务（system 含任务树上下文，不含规划器 prompt）
    for (const c of adapter.calls) {
      assert.ok(!(c.messages[0]?.content ?? '').includes('任务规划器'), 'resume 不应重新规划任务树');
      assert.ok((c.messages[0]?.content ?? '').includes('任务树'), '子任务上下文应含任务树块');
    }
    // 落盘可回读（同路径 = 断点状态文件）
    const reloaded = await planner.loadTree(sid);
    assert.ok(reloaded, 'loadTree 应能读回更新后的任务树');
    assert.ok(reloaded.tasks.every((t) => t.status === 'done'), '回读的任务树应全 done');
    await rm(base, { recursive: true, force: true });
  }

  // ── 用例 2：running 降级 pending 重跑（进程死前未完成）──
  {
    const { base, adapter, planner, session, sid, ctx } = await setup();
    const tree: TaskTree = {
      goal: 'running 恢复',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      tasks: [{ id: 't1', desc: '实现一个功能', verify: '检查 t1', deps: [], status: 'running' }],
    };
    await seedTree(session, sid, tree);

    const result = await planner.run(tree.goal, ctx, tree);

    assert.equal(adapter.calls.length, 1, 'running 应降级重跑一次');
    assert.equal(result.doneCount, 1);
    assert.equal(tree.tasks[0]?.status, 'done', 'running → 重跑 → done');
    assert.ok(tree.tasks[0]?.rounds !== undefined, '重跑应记录 rounds');
    await rm(base, { recursive: true, force: true });
  }

  // ── 用例 3：全部 done → 幂等秒完成（零 LLM 调用）──
  {
    const { base, adapter, planner, session, sid, ctx } = await setup();
    const tree: TaskTree = {
      goal: '幂等测试',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      tasks: [
        { id: 't1', desc: '一', verify: 'v', deps: [], status: 'done', rounds: 2, toolCalls: 1, note: 'n1' },
        { id: 't2', desc: '二', verify: 'v', deps: [], status: 'done', rounds: 2, toolCalls: 1, note: 'n2' },
      ],
    };
    await seedTree(session, sid, tree);

    const result = await planner.run(tree.goal, ctx, tree);

    assert.equal(adapter.calls.length, 0, '全 done 不应有任何 LLM 调用');
    assert.equal(result.doneCount, 2);
    assert.ok(result.summary.includes('断点续跑'), 'summary 应标注续跑');
    await rm(base, { recursive: true, force: true });
  }

  // ── 用例 4：loadTree 校验（不存在/损坏 → null；非法 status 归一化 pending）──
  {
    const { base, session, planner, sid } = await setup();
    assert.equal(await planner.loadTree(sid), null, '无 task-tree.json → null');

    await writeFile(path.join(session.sessionDir(sid), 'task-tree.json'), '{ 坏 json', 'utf8');
    assert.equal(await planner.loadTree(sid), null, '损坏 JSON → null');

    const tree: TaskTree = {
      goal: '归一化',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      tasks: [
        { id: 't1', desc: 'a', verify: 'v', deps: [], status: 'wat' as never },
        { id: 't2', desc: 'b', verify: 'v', deps: [], status: 'done' },
        { id: 't3', desc: 'c', verify: 'v', deps: [], status: 'running' },
      ],
    };
    await seedTree(session, sid, tree);
    const loaded = await planner.loadTree(sid);
    assert.ok(loaded, '合法结构应加载');
    assert.equal(loaded.tasks[0]?.status, 'pending', '非法 status → pending');
    assert.equal(loaded.tasks[1]?.status, 'done', 'done 保留');
    assert.equal(loaded.tasks[2]?.status, 'running', 'running 保留（降级发生在 run 时）');
    await rm(base, { recursive: true, force: true });
  }

  console.log('✅ planner-resume: 4 用例全过（skip done / running 降级 / 幂等 / loadTree 校验）');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
