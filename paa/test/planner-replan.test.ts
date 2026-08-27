// Planner A4 re-plan 测试：失败自愈（LLM 重规划未完成任务）/ 非法输出 / 无效 replan 防死循环
// / maxReplans 禁用 / 依赖 failed 的挂起 / id 冲突重命名
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

/** 按调用序号返回预设回复；子任务失败用"我需要澄清"（命中 noOutput + idleFakeDone） */
class MockAdapter implements LLMAdapter {
  provider = 'mock';
  calls: Array<{ messages: ChatMessage[] }> = [];
  replies: string[];
  constructor(replies: string[]) {
    this.replies = replies;
  }
  async chat(messages: ChatMessage[], _opts?: ChatOptions): Promise<ChatMessage> {
    this.calls.push({ messages });
    const content = this.replies[this.calls.length - 1] ?? '完成：目标已满足，无需改动';
    return { role: 'assistant', content };
  }
}

async function setup(opts?: {
  maxReplans?: number;
}): Promise<{
  base: string;
  session: SessionMgr;
  adapter: MockAdapter;
  planner: Planner;
  sid: string;
  ctx: AgentLoopCtx;
}> {
  const base = await mkdtemp(path.join(tmpdir(), 'paa-replan-'));
  const session = new SessionMgr(base);
  const sid = await session.newSession();
  const adapter = new MockAdapter([]);
  const planner = new Planner({
    adapter,
    pipeline: new ToolPipeline(new Permission(4)),
    session,
    baseSystemPrompt: 'test system',
    memoryProvider: null,
    options: { maxTasks: 6, subtaskRounds: 10, maxReplans: opts?.maxReplans ?? 2 },
  });
  const ctx: AgentLoopCtx = { sessionId: sid, cwd: base, ask: async () => true, audit: () => {} };
  return { base, session, adapter, planner, sid, ctx };
}

/** 直接落盘一棵任务树（t1 done 作为产出锚点） */
async function seedTree(session: SessionMgr, sid: string, tree: TaskTree): Promise<void> {
  await writeFile(path.join(session.sessionDir(sid), 'task-tree.json'), JSON.stringify(tree, null, 2), 'utf8');
}

/** 判定某次调用是否为 replan（system prompt 含 Replanner） */
function isReplanCall(c: { messages: ChatMessage[] }): boolean {
  return (c.messages[0]?.content ?? '').includes('Replanner');
}

async function main() {
  // ── 用例 1：失败 → replan（删除挂起任务）→ 新任务执行 → 全 done 收敛 ──
  {
    const { base, session, adapter, planner, sid, ctx } = await setup();
    const tree: TaskTree = {
      goal: '自愈测试',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      tasks: [
        { id: 't1', desc: '完成前置', verify: 'v1', deps: [], status: 'done', rounds: 2, toolCalls: 1, note: '结论：t1 产出' },
        { id: 't2', desc: '实现核心功能', verify: 'grep 验证', deps: ['t1'], status: 'pending' },
        { id: 't3', desc: '实现附加功能', verify: 'grep 验证', deps: ['t2'], status: 'pending' },
      ],
    };
    adapter.replies = [
      '我需要澄清具体需求', // t2 执行 → 失败（无产出反问）；t3 依赖 t2 → 挂起
      '{"tasks":[{"id":"r1","desc":"换一种方式实现核心功能","verify":"grep 验证新符号引用","deps":["t1"]}]}', // replan：只保留核心功能，删除 t3
      '完成：目标已满足，无需改动', // r1 执行 → done
    ];
    await seedTree(session, sid, tree);

    const result = await planner.run(tree.goal, ctx, tree);

    assert.equal(adapter.calls.length, 3, 't2失败 + replan + r1执行 = 3 次 LLM 调用');
    assert.ok(isReplanCall(adapter.calls[1]!), '第 2 次调用应为 replan');
    assert.equal(result.doneCount, 2, 't1 + r1 成功');
    assert.equal(tree.tasks[0]?.id, 't1', 'done 任务保留');
    assert.equal(tree.tasks[0]?.status, 'done');
    assert.equal(tree.tasks[1]?.id, 'r1', '失败任务被 replan 替换为 r1');
    assert.equal(tree.tasks[1]?.status, 'done');
    assert.ok(!tree.tasks.some((t) => t.id === 't2' || t.id === 't3'), 't2 被改写、挂起的 t3 被 replan 删除');
    assert.ok(result.summary.includes('re-plan 1 次'), 'summary 应标注 re-plan 次数');
    // 落盘状态同步（断点文件可回读）
    const reloaded = await planner.loadTree(sid);
    assert.ok(reloaded?.tasks.every((t) => t.status === 'done'), '落盘树应全 done');
    await rm(base, { recursive: true, force: true });
  }

  // ── 用例 2：replan 输出非法 JSON → 停止自愈，failed 保留、挂起任务不跑 ──
  {
    const { base, session, adapter, planner, sid, ctx } = await setup();
    const tree: TaskTree = {
      goal: '非法输出测试',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      tasks: [
        { id: 't1', desc: '实现功能', verify: 'v', deps: [], status: 'pending' },
        { id: 't2', desc: '依赖功能', verify: 'v2', deps: ['t1'], status: 'pending' },
      ],
    };
    adapter.replies = [
      '我需要澄清具体需求', // t1 失败（t2 挂起）
      '抱歉，我无法生成规划 JSON', // replan 非法 → 解析失败 → false
    ];
    await seedTree(session, sid, tree);

    const result = await planner.run(tree.goal, ctx, tree);

    assert.equal(adapter.calls.length, 2, '执行失败 + 1 次非法 replan 后停止');
    assert.equal(tree.tasks[0]?.status, 'failed', 'failed 保留，不硬冲');
    assert.equal(tree.tasks[1]?.status, 'pending', '挂起任务保持原状');
    assert.equal(result.doneCount, 0);
    await rm(base, { recursive: true, force: true });
  }

  // ── 用例 3：replan 输出与现状完全一致 → 无效 replan → 防死循环 ──
  {
    const { base, session, adapter, planner, sid, ctx } = await setup();
    const tree: TaskTree = {
      goal: '无效 replan 测试',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      tasks: [
        { id: 't1', desc: '原样任务', verify: '原样验证', deps: [], status: 'pending' },
        { id: 't2', desc: '依赖任务', verify: 'v2', deps: ['t1'], status: 'pending' },
      ],
    };
    adapter.replies = [
      '我需要澄清具体需求', // t1 失败（t2 挂起）
      '{"tasks":[{"id":"t1","desc":"原样任务","verify":"原样验证","deps":[]},{"id":"t2","desc":"依赖任务","verify":"v2","deps":["t1"]}]}', // 与现状完全一致 → null
    ];
    await seedTree(session, sid, tree);

    const result = await planner.run(tree.goal, ctx, tree);

    assert.equal(adapter.calls.length, 2, '无效 replan 后不重试（防死循环）');
    assert.equal(tree.tasks[0]?.status, 'failed');
    assert.equal(tree.tasks[1]?.status, 'pending');
    assert.ok(result.summary.includes('0/2'), 'summary 应显示 0/2 成功');
    assert.ok(!result.summary.includes('re-plan'), '无效 replan 不应计入次数');
    await rm(base, { recursive: true, force: true });
  }

  // ── 用例 4：maxReplans=0 → 失败即止，挂起任务不跑 ──
  {
    const { base, session, adapter, planner, sid, ctx } = await setup({ maxReplans: 0 });
    const tree: TaskTree = {
      goal: '禁用自愈测试',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      tasks: [
        { id: 't1', desc: '会失败的任务', verify: 'v1', deps: [], status: 'pending' },
        { id: 't2', desc: '依赖 t1 的任务', verify: 'v2', deps: ['t1'], status: 'pending' },
      ],
    };
    adapter.replies = ['我需要澄清具体需求'];
    await seedTree(session, sid, tree);

    const result = await planner.run(tree.goal, ctx, tree);

    assert.equal(adapter.calls.length, 1, 'maxReplans=0 → 只执行一次就停');
    assert.equal(tree.tasks[0]?.status, 'failed');
    assert.equal(tree.tasks[1]?.status, 'pending', '挂起任务保留不执行');
    assert.equal(result.doneCount, 0);
    await rm(base, { recursive: true, force: true });
  }

  // ── 用例 5：依赖 failed 的 pending 挂起 → replan 重构后继续 → 全 done ──
  {
    const { base, session, adapter, planner, sid, ctx } = await setup();
    const tree: TaskTree = {
      goal: '挂起任务测试',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      tasks: [
        { id: 't1', desc: '完成前置', verify: 'v1', deps: [], status: 'done', rounds: 2, toolCalls: 1, note: '结论：t1 产出' },
        { id: 't2', desc: '实现功能 A', verify: 'vA', deps: ['t1'], status: 'pending' },
        { id: 't3', desc: '实现功能 B', verify: 'vB', deps: ['t2'], status: 'pending' },
      ],
    };
    adapter.replies = [
      '我需要澄清具体需求', // t2 失败（t3 依赖 t2 → 本轮挂起不执行）
      '{"tasks":[{"id":"r1","desc":"换个方案实现功能 A","verify":"grep 验证 A 引用","deps":["t1"]},{"id":"r2","desc":"实现功能 B","verify":"grep 验证 B 引用","deps":["r1"]}]}', // replan 重构
      '完成：目标已满足，无需改动', // r1 done
      '完成：目标已满足，无需改动', // r2 done
    ];
    await seedTree(session, sid, tree);

    const result = await planner.run(tree.goal, ctx, tree);

    assert.equal(adapter.calls.length, 4, 't2失败 + replan + r1 + r2 = 4 次调用');
    assert.equal(result.doneCount, 3, 't1 + r1 + r2 全成功');
    const r1 = tree.tasks.find((t) => t.id === 'r1');
    const r2 = tree.tasks.find((t) => t.id === 'r2');
    assert.ok(r1 && r2, 'r1/r2 应存在');
    assert.deepEqual(r1.deps, ['t1'], 'r1 应保留对 done 任务 t1 的依赖');
    assert.deepEqual(r2.deps, ['r1'], 'r2 依赖 r1');
    assert.equal(r1.status, 'done');
    assert.equal(r2.status, 'done');
    assert.ok(result.summary.includes('re-plan 1 次'));
    await rm(base, { recursive: true, force: true });
  }

  // ── 用例 6：replan 输出 id 与 done 任务冲突 → 自动重命名 ──
  {
    const { base, session, adapter, planner, sid, ctx } = await setup();
    const tree: TaskTree = {
      goal: 'id 冲突测试',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      tasks: [
        { id: 't1', desc: '已有产出', verify: 'v1', deps: [], status: 'done', rounds: 1, toolCalls: 0, note: '结论：已有' },
        { id: 't2', desc: '实现功能', verify: 'v2', deps: ['t1'], status: 'pending' },
        { id: 't3', desc: '后续功能', verify: 'v3', deps: ['t2'], status: 'pending' },
      ],
    };
    adapter.replies = [
      '我需要澄清具体需求', // t2 失败（t3 挂起）
      '{"tasks":[{"id":"t1","desc":"新规划的任务","verify":"vNew","deps":[]}]}', // 与 done t1 冲突 → 重命名 r1
      '完成：目标已满足，无需改动', // r1 done
    ];
    await seedTree(session, sid, tree);

    const result = await planner.run(tree.goal, ctx, tree);

    const ids = tree.tasks.map((t) => t.id);
    assert.ok(ids.filter((i) => i === 't1').length === 1, '不应出现重复 t1');
    assert.ok(ids.includes('r1'), '冲突 id 应重命名为 r1');
    assert.equal(tree.tasks.find((t) => t.id === 'r1')?.status, 'done');
    assert.equal(result.doneCount, 2, 't1 + r1 成功（t3 被 replan 删除）');
    await rm(base, { recursive: true, force: true });
  }

  console.log('✅ planner-replan: 6 用例全过（失败自愈 / 非法输出 / 无效 replan / 禁用 / 挂起 / id 冲突）');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
