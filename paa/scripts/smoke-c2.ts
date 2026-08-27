// ⑥ C2 现场造工具 真实 API 冒烟（config.json 需有效）：
// planner goal：让 agent 发现"没有计算工具" → 现场写 ToolPkg（manifest.json + impl.mjs）→ pkg_install 热加载
// → 调用新工具计算 → 结果落盘。全程无人插手，验证"长任务中缺工具 → 现场造 → 继续执行"闭环。
// 跑法：node paa/scripts/smoke-c2.ts（paa/ 下跑）
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Planner } from '../core/planner.ts';
import { createAdapter } from '../core/llm-adapter.ts';
import { SessionMgr } from '../core/session-mgr.ts';
import { ToolPipeline } from '../core/tool-pipeline.ts';
import { Permission } from '../core/permission.ts';
import { createCoreTools } from '../tools/core-tools.ts';
import { PkgLoader } from '../core/pkg-loader.ts';
import { createPkgTools } from '../tools/pkg-tools.ts';
import type { AgentLoopCtx } from '../core/agent-loop.ts';

const PAA_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACE = path.resolve(PAA_ROOT, '..');

// 可重复跑：清掉上一轮冒烟装进 pkgs/ 的 mycalc（pkg_install 对已存在同名包会报错）
await rm(path.join(PAA_ROOT, 'pkgs', 'mycalc'), { recursive: true, force: true });
await rm(path.join(PAA_ROOT, 'artifacts', 'mycalc'), { recursive: true, force: true });

async function main() {
  const config = JSON.parse(await readFile(path.join(PAA_ROOT, 'config.json'), 'utf8')) as {
    apiUrl?: string;
    baseUrl?: string;
    apiKey?: string;
    model?: string;
  };
  const apiUrl = String(config.apiUrl ?? config.baseUrl ?? '');
  if (!apiUrl || !config.apiKey) throw new Error('config.json 缺少 apiUrl/apiKey');
  const adapter = createAdapter({
    provider: 'openai-compatible',
    baseUrl: apiUrl.endsWith('/chat/completions') ? apiUrl.replace(/\/chat\/completions$/, '') : apiUrl,
    apiKey: config.apiKey,
    model: config.model ?? 'deepseek-chat',
  });
  const session = new SessionMgr(path.join(PAA_ROOT, 'runs'));

  const sid = await session.newSession();
  const pipeline = new ToolPipeline(new Permission(4)); // L4 全自动（无人值守）
  for (const t of createCoreTools(WORKSPACE)) pipeline.register(t);
  const pkgLoader = new PkgLoader({
    pkgsRoot: path.join(PAA_ROOT, 'pkgs'),
    pipeline,
    permission: new Permission(4),
    env: { root: WORKSPACE, pkgDir: path.join(PAA_ROOT, 'pkgs'), audit: () => {} },
  });
  for (const t of createPkgTools(pkgLoader)) pipeline.register(t);
  const ctx: AgentLoopCtx = { sessionId: sid, cwd: WORKSPACE, ask: async () => true, audit: () => {} };

  const planner = new Planner({
    adapter,
    pipeline,
    session,
    baseSystemPrompt: '你是 PAA 内置 agent，具备文件读写、搜索、包管理（pkg_install/pkg_list）能力。',
    memoryProvider: null,
    options: { maxTasks: 4, subtaskRounds: 10 },
    onEvent: (taskId, ev) => {
      if (ev.type === 'tool') {
        const p = ev.payload as { name: string };
        console.log(`  [${taskId}] ${p.name}`);
      }
    },
  });

  const goal =
    '现场创建 ToolPkg 计算包（包名 mycalc，提供工具 add 计算两数之和），并用它计算 123+456，把结果写入 paa/artifacts/c2-result.txt。' +
    '必须真实创建工具包：先 shell_run 建目录（New-Item -ItemType Directory -Force），再 fs_write 写 manifest.json 和 impl.mjs，' +
    '再用 pkg_install 安装（src 指向包目录），最后调用 pkg_mycalc_add 计算。禁止用 shell 的 node -e / powershell 计算代替造包。';

  console.log(`[冒烟] 会话 ${sid}：C2 现场造工具 goal 启动…`);
  console.log(`[冒烟] 目标：${goal}`);
  const result = await planner.run(goal, ctx);

  console.log(`[冒烟] 结果：${result.doneCount}/${result.totalCount}`);
  for (const [id, oc] of Object.entries(result.outcomes)) {
    console.log(`  ${id}: ${oc.status}（${oc.rounds} 轮 / ${oc.toolCalls} 次工具）— ${oc.note ?? ''}`);
  }

  // 真实验证：包已装、结果已落盘、内容正确
  const pkgsLoaded = pkgLoader.listLoaded().map((lp) => lp.manifest.name);
  console.log(`[冒烟] 已加载包：${pkgsLoaded.join(', ')}`);
  const outPath = path.join(WORKSPACE, 'paa', 'artifacts', 'c2-result.txt');
  let outText = '';
  try {
    outText = await readFile(outPath, 'utf8');
  } catch {
    /* 下面断言会报 */
  }

  assert.equal(result.doneCount, result.totalCount, '所有子任务应成功');
  assert.ok(pkgsLoaded.includes('mycalc'), `mycalc 应被加载（实际: ${pkgsLoaded.join(', ')}）`);
  assert.match(outText, /579/, `结果文件应包含 579（实际内容: ${outText || '(空)'}）`);
  console.log(`✅ 冒烟 C2 现场造工具通过（会话 ${sid}：${result.doneCount}/${result.totalCount}，结果 ${outText.trim()}）`);
}

main().catch((e) => {
  console.error('❌ smoke-c2 失败:', e);
  process.exit(1);
});
