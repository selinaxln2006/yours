// G8 第三靶「中途失败自愈」数据层+服务层端到端冒烟：
// ① 构造含 history 快照（exec-fail / replan-replaced / replan-pruned）的任务树落盘
// ② 启动 server 子进程 → GET /api/tasks/:sid
// ③ 断言 healSummary 计数正确、tasks 含 history 字段
// 跑法：node paa/scripts/smoke-replan-history.ts（paa/ 下跑，无需真实 LLM/config.json）
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { SessionMgr } from '../core/session-mgr.ts';
import type { TaskTree, TaskHistoryEntry } from '../core/planner.ts';

const PAA_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 18665; // 专用端口，避开默认 8765

async function httpGet(url: string, timeoutMs = 5000): Promise<{ status: number; body: any }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const body = await res.json();
  return { status: res.status, body };
}

async function waitForServer(port: number, tries = 30): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await httpGet(`http://127.0.0.1:${port}/api/health`);
      if (r.status < 500) return;
    } catch {
      /* 未就绪，重试 */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`server 未在 ${tries * 300}ms 内就绪（端口 ${port}）`);
}

async function main() {
  // ---- ① 数据层：构造含 history 的任务树并落盘（模拟 t3 产物）----
  const session = new SessionMgr(path.join(PAA_ROOT, 'runs'));
  const sid = await session.newSession();
  const dir = session.sessionDir(sid);
  await mkdir(dir, { recursive: true });

  const now = Date.now();
  const tree: TaskTree = {
    goal: 'G8 第三靶冒烟：验证「中途失败自愈」history 快照可被 API 查证',
    createdAt: now - 60_000,
    updatedAt: now,
    tasks: [
      {
        id: 't1',
        desc: '读取 ROADMAP 并总结 G8 判定标准',
        verify: 'fs_grep 确认关键词',
        deps: [],
        status: 'done',
        rounds: 4,
        toolCalls: 6,
        note: '结论：G8 需复现中途失败自愈路径',
      },
      {
        id: 't2',
        desc: '写 docs/g8-smoke.md（写类工具失败）',
        verify: 'fs_read 确认文件存在',
        deps: ['t1'],
        status: 'failed',
        rounds: 6,
        toolCalls: 8,
        note: '写类工具失败(3次)≥成功(0次)，代码未落地',
        history: [
          { ts: now - 30_000, status: 'failed', note: '写类工具失败(3次)≥成功(0次)，代码未落地', rounds: 6, toolCalls: 8, reason: 'exec-fail' } satisfies TaskHistoryEntry,
        ],
      },
      {
        id: 't3',
        desc: '旧挂起任务（replan 前被裁剪）',
        verify: '无',
        deps: ['t2'],
        status: 'pending',
        history: [
          { ts: now - 20_000, status: 'pending', desc: '旧挂起任务（依赖 t2）', reason: 'replan-pruned' } satisfies TaskHistoryEntry,
          { ts: now - 10_000, status: 'failed', desc: '旧失败任务（replan 替换）', note: '被重规划替换', reason: 'replan-replaced' } satisfies TaskHistoryEntry,
        ],
      },
    ],
  };
  await writeFile(path.join(dir, 'task-tree.json'), JSON.stringify(tree, null, 2), 'utf8');
  console.log(`已落盘任务树 → runs/${sid}/task-tree.json（含 3 条 history 快照）`);

  // ---- ② 启动 server 子进程 ----
  console.log(`启动 server（端口 ${PORT}）…`);
  const child = spawn(process.execPath, ['--experimental-strip-types', 'server/main.ts', '--port', String(PORT)], {
    cwd: PAA_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PAA_PORT: String(PORT) },
  });
  let serverLog = '';
  child.stdout.on('data', (d) => (serverLog += d.toString()));
  child.stderr.on('data', (d) => (serverLog += d.toString()));

  try {
    await waitForServer(PORT);

    // ---- ③ 调用 GET /api/tasks/:sid ----
    const res = await httpGet(`http://127.0.0.1:${PORT}/api/tasks/${sid}`);
    console.log(`GET /api/tasks/${sid} → HTTP ${res.status}`);

    assert.equal(res.status, 200, 'API 应返回 200');
    assert.equal(res.body.ok, true, '响应 ok 应为 true');
    assert.equal(res.body.goal, tree.goal, 'goal 应回读一致');
    assert.equal(res.body.tasks.length, 3, 'tasks 应有 3 个');

    // ---- ④ 断言 healSummary 计数 ----
    const hs = res.body.healSummary;
    assert.ok(hs, '应返回 healSummary 摘要');
    assert.equal(hs.entries, 3, `history 条目应为 3（实际 ${hs.entries}）`);
    assert.equal(hs.execFail, 1, `exec-fail 应为 1（实际 ${hs.execFail}）`);
    assert.equal(hs.replanReplaced, 1, `replan-replaced 应为 1（实际 ${hs.replanReplaced}）`);
    assert.equal(hs.replanPruned, 1, `replan-pruned 应为 1（实际 ${hs.replanPruned}）`);

    // ---- ⑤ 断言任务级 history 字段可读 ----
    const t2 = res.body.tasks.find((t: any) => t.id === 't2');
    assert.ok(t2?.history?.[0]?.reason === 'exec-fail', 't2 的 history 应含 exec-fail 快照');
    const t3 = res.body.tasks.find((t: any) => t.id === 't3');
    assert.equal(t3.history.length, 2, 't3 应有 2 条 history');
    assert.ok(t3.history.some((h: any) => h.reason === 'replan-pruned'), 't3 history 应含 replan-pruned');
    assert.ok(t3.history.some((h: any) => h.reason === 'replan-replaced'), 't3 history 应含 replan-replaced');

    console.log('\n✅ smoke-replan-history 通过：');
    console.log(`   healSummary = ${JSON.stringify(hs)}`);
    console.log(`   tasks=${res.body.tasks.length} 个，history 可经 API 回读查证（G8 第三靶「中途失败自愈」验收链路通）`);
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 200));
    // 清理测试会话
    try {
      await rm(path.join(PAA_ROOT, 'runs', sid), { recursive: true, force: true });
      console.log(`已清理测试会话 runs/${sid}`);
    } catch {
      /* 忽略清理失败 */
    }
  }
}

main().catch((e) => {
  console.error('❌ smoke-replan-history 失败:', e);
  process.exit(1);
});
