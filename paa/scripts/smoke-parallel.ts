// ⑤ 并行工具真实 API 冒烟（config.json 需有效）：
// 1) AgentLoop 工具并行：引导 agent 同一轮发多个 fs_grep/fs_read → 并行执行、结果正常注入
// 2) Planner 子任务并发：concurrency=2 跑独立子任务 → 全成功
// 跑法：node paa/scripts/smoke-parallel.ts（paa/ 下跑）
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentLoop } from '../core/agent-loop.ts';
import { Planner } from '../core/planner.ts';
import { createAdapter } from '../core/llm-adapter.ts';
import { SessionMgr } from '../core/session-mgr.ts';
import { ToolPipeline } from '../core/tool-pipeline.ts';
import { Permission } from '../core/permission.ts';
import { createCoreTools } from '../tools/core-tools.ts';
import type { AgentLoopCtx } from '../core/agent-loop.ts';

const PAA_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACE = path.resolve(PAA_ROOT, '..');

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
  const adapter = createAdapter(llm);
  const session = new SessionMgr(path.join(PAA_ROOT, 'runs'));

  // ── 冒烟 1：工具并行（单 AgentLoop，同轮多调用 Promise.all）──
  {
    const sid = await session.newSession();
    const pipeline = new ToolPipeline(new Permission(4));
    for (const t of createCoreTools(WORKSPACE)) pipeline.register(t);
    const ctx: AgentLoopCtx = { sessionId: sid, cwd: WORKSPACE, ask: async () => true, audit: () => {} };
    const loop = new AgentLoop({
      adapter,
      pipeline,
      session,
      systemPrompt: '你是 PAA 内置 agent。能并行收集的信息一轮内同时发出，减少轮数。',
      maxRounds: 6,
    });
    console.log(`[冒烟1] 会话 ${sid}：引导同轮多工具调用…`);
    const res = await loop.run(
      '请用 fs_grep 在 docs/ 目录下分别搜索 "re-plan"、"compaction"、"resume" 三个关键词，并读取 docs/ROADMAP.md 前 40 行。一轮内尽可能同时发出多个工具调用。',
      ctx,
    );
    const toolCount = res.events.filter((e) => e.type === 'tool').length;
    console.log(`[冒烟1] 完成：${res.rounds} 轮 / ${res.toolCalls} 次工具调用`);
    console.log(`[冒烟1] 回答摘要：${(res.answer ?? '').slice(0, 200)}`);
    assert.ok(res.toolCalls >= 3, `应至少 3 次工具调用（实际 ${res.toolCalls}）`);
    console.log(`✅ 冒烟1 工具并行通过（会话 ${sid}，${res.rounds} 轮完成 ${res.toolCalls} 次调用）`);
  }

  // ── 冒烟 2：planner 子任务并发（concurrency=2）──
  {
    const sid = await session.newSession();
    const pipeline = new ToolPipeline(new Permission(4));
    for (const t of createCoreTools(WORKSPACE)) pipeline.register(t);
    const ctx: AgentLoopCtx = { sessionId: sid, cwd: WORKSPACE, ask: async () => true, audit: () => {} };
    const planner = new Planner({
      adapter,
      pipeline,
      session,
      baseSystemPrompt: '你是 PAA 内置 agent，具备文件读写、搜索能力。',
      memoryProvider: null,
      options: { maxTasks: 4, subtaskRounds: 6, subtaskConcurrency: 2 },
      onEvent: (taskId, ev) => {
        if (ev.type === 'tool') {
          const p = ev.payload as { name: string };
          console.log(`  [${taskId}] ${p.name}`);
        }
      },
    });
    console.log(`[冒烟2] 会话 ${sid}：planner concurrency=2 跑独立子任务…`);
    const result = await planner.run(
      '读取 README.md 与 AGENTS.md 各前 30 行，并在 docs/ 下分别搜索 "G8" 与 "OpenClaw" 的出现次数。每个文件/关键词拆为独立子任务，互相无依赖。',
      ctx,
    );
    console.log(`[冒烟2] 结果：${result.doneCount}/${result.totalCount}`);
    for (const [id, oc] of Object.entries(result.outcomes)) {
      console.log(`  ${id}: ${oc.status}（${oc.rounds} 轮 / ${oc.toolCalls} 次工具）`);
    }
    assert.equal(result.doneCount, result.totalCount, '并发下所有子任务应成功');
    console.log(`✅ 冒烟2 planner 子任务并发通过（会话 ${sid}，${result.doneCount}/${result.totalCount}）`);
  }
}

main().catch((e) => {
  console.error('❌ smoke-parallel 失败:', e);
  process.exit(1);
});
