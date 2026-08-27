// A4 re-plan 真实 API 冒烟：真实 LLM（config.json）+ 手工构造失败树 → planner.replan()
// 验证：replan prompt 能产出合法 JSON → 合并到任务树（done 保留、failed/pending 被替换）→ 落盘
// 跑法：node paa/scripts/smoke-replan.ts（paa/ 下跑，config.json 需有效）
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Planner, type TaskTree } from '../core/planner.ts';
import { createAdapter } from '../core/llm-adapter.ts';
import { SessionMgr } from '../core/session-mgr.ts';
import { ToolPipeline } from '../core/tool-pipeline.ts';
import { Permission } from '../core/permission.ts';
import type { AgentLoopCtx } from '../core/agent-loop.ts';

const PAA_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function main() {
  const config = JSON.parse(await readFile(path.join(PAA_ROOT, 'config.json'), 'utf8')) as {
    apiUrl?: string;
    baseUrl?: string;
    apiKey?: string;
    model?: string;
  };
  const apiUrl = String(config.apiUrl ?? config.baseUrl ?? '');
  if (!apiUrl || !config.apiKey) throw new Error('config.json 缺少 apiUrl/apiKey');
  const llm = {
    provider: 'openai-compatible' as const,
    baseUrl: apiUrl.endsWith('/chat/completions') ? apiUrl.replace(/\/chat\/completions$/, '') : apiUrl,
    apiKey: config.apiKey,
    model: config.model ?? 'deepseek-chat',
  };

  const session = new SessionMgr(path.join(PAA_ROOT, 'runs'));
  const sid = await session.newSession();
  const planner = new Planner({
    adapter: createAdapter(llm),
    pipeline: new ToolPipeline(new Permission(4)),
    session,
    baseSystemPrompt: '你是 PAA 内置 agent，具备文件读写、搜索、shell 执行能力。',
    memoryProvider: null,
    options: { maxTasks: 6, subtaskRounds: 10, maxReplans: 2 },
  });
  const ctx: AgentLoopCtx = { sessionId: sid, cwd: PAA_ROOT, ask: async () => true, audit: () => {} };

  // 手工构造"跑挂"的任务树：t1 产出保留，t2 失败，t3 依赖 t2 挂起
  const tree: TaskTree = {
    goal: '冒烟目标：在 docs/ 下生成 replan-smoke.md，总结 PAA 的 A4 re-plan 功能',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    tasks: [
      { id: 't1', desc: '读取 ROADMAP.md 的 A4 章节并总结 re-plan 设计', verify: 'fs_grep 确认总结了 re-plan 关键词', deps: [], status: 'done', rounds: 4, toolCalls: 6, note: '结论：A4 = 子任务失败后 LLM 重规划未完成部分（增删改）后继续' },
      { id: 't2', desc: '生成 docs/replan-smoke.md 内容（含 re-plan 设计要点）', verify: 'fs_read 确认文件存在且有内容', deps: ['t1'], status: 'failed', note: '写类工具失败(3次)≥成功(0次)，代码未落地 | 尝试写入 docs/ 下不存在的子目录失败', rounds: 6, toolCalls: 8 },
      { id: 't3', desc: '校验 replan-smoke.md 与 ROADMAP 一致性', verify: 'fs_grep 对比关键词', deps: ['t2'], status: 'pending' },
    ],
  };

  console.log(`会话: ${sid}`);
  console.log('调用 replan（真实 LLM）…');
  const ok = await planner.replan(tree, ctx);
  console.log(`replan 返回: ${ok}`);
  console.log('');
  console.log('重规划后的任务树：');
  for (const t of tree.tasks) {
    console.log(`  [${t.status}] ${t.id} ${t.desc}`);
    if (t.deps.length) console.log(`        deps: [${t.deps.join(', ')}]`);
  }

  assert.ok(ok, '真实 LLM replan 应成功');
  assert.ok(tree.tasks.some((t) => t.id === 't1' && t.status === 'done'), 'done 任务 t1 必须保留');
  assert.ok(!tree.tasks.some((t) => t.id === 't2' || t.id === 't3'), '失败/挂起任务应被替换（不在新树中）');
  assert.ok(tree.tasks.filter((t) => t.status === 'pending').length > 0, '应有新的 pending 任务');

  // 落盘校验（断点状态文件）
  const saved = JSON.parse(
    await readFile(path.join(session.sessionDir(sid), 'task-tree.json'), 'utf8'),
  ) as TaskTree;
  assert.equal(saved.tasks.length, tree.tasks.length, '落盘树与内存树一致');
  console.log(`\n✅ 真实 API replan 通过（会话 ${sid}，新任务 ${saved.tasks.length} 个，落盘成功）`);
  console.log(`\n下一步可实测续跑：node cli/main.ts --resume ${sid}`);
}

main().catch((e) => {
  console.error('❌ smoke-replan 失败:', e);
  process.exit(1);
});
