// ============================================================
// PAA CLI 入口
// 用法：node cli/main.ts [--root <沙箱根>] [--level <0-4>]
// 命令：/quit /tools /level N /replay
// ============================================================

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import type { LLMConfig } from '../core/types.ts';
import { createAdapter } from '../core/llm-adapter.ts';
import { ToolPipeline } from '../core/tool-pipeline.ts';
import { AgentLoop } from '../core/agent-loop.ts';
import { SessionMgr } from '../core/session-mgr.ts';
import { Permission, type AutonomyLevel } from '../core/permission.ts';
import { JsonMemoryProvider, createDefaultPersonaSeed } from '../core/memory-provider.ts';
import { FileArtifactProvider } from '../core/artifact-provider.ts';
import { PkgLoader } from '../core/pkg-loader.ts';
import { McpClient, createMcpToolDefinitions, type McpServerConfig } from '../core/mcp-client.ts';
import { createCoreTools } from '../tools/core-tools.ts';
import { createMemoryTools } from '../tools/memory-tools.ts';
import { createArtifactTools } from '../tools/artifact-tools.ts';
import { createPkgTools } from '../tools/pkg-tools.ts';
import { Planner } from '../core/planner.ts';
import { render } from './render.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAA_ROOT = path.resolve(__dirname, '..');
const WORKSPACE_ROOT = path.resolve(PAA_ROOT, '..');

const SYSTEM_PROMPT = `你是枢（Shū），俪宁的跨界 AI 搭档。锐利、直接、不谄媚；长内容用分级标题；默认简体中文；不说废话客套。

操作硬纪律（必须遵守）：
1. 定位：先用 fs_list / fs_grep / fs_read 找到目标文件和上下文，不要瞎猜路径
2. 读：fs_read 支持 offset/limit 行切片，先读关键区段
3. 交叉验证：动手改之前，用 fs_grep 核对你的理解准确
4. 最小修改：只改必要处，不顺手重构
5. 改后必验：修改后读回验证结果
6. 不确定先问：模糊场景先向用户说明再动手
7. 大文件写纪律（>200 行）：禁止一次性写完整个文件（单轮输出会截断）。必须分段：第一轮 fs_write 写文件头+骨架（含注释/导入/类型定义），后续每轮用 fs_append 追加一段（每段 ≤150 行）；全部写完后再 fs_read 验证行数与关键锚点

平台纪律（当前是 Windows/cmd 环境，必须遵守）：
- pwd / ls / cat / grep / head / which / touch / rm / mv / wc 等 Unix 命令不存在，不要用
- 文件检索用 fs_grep（正则），列目录用 fs_list，读文件用 fs_read（行切片）
- shell_run 只用于真实需要的命令（node / npm / git / tsc）；命令输出已自动做 GBK/UTF-8 编码转换，但解析输出仍以英文/结构化内容为准
- 路径分隔符正反斜杠均可，fs 工具自动处理
- 下方"仓库结构快照"标出了文件真实位置，直接按它定位路径，不要对未知目录反复 fs_list 试错

任务聚焦纪律：
- 一次只做一件事；动手前先明确完成标准（做什么、做到什么程度算完成）
- 指令模糊/方向性（缺明确目标或完成标准，如"优化一下""你看着办"）时：第 1 轮用一句话反问澄清目标+完成标准，不要先烧探索预算；用户明确授权"先看再定"才进入探索
- 探索类任务先定步数预算（如"最多 5 步"），到预算即给阶段性结论，不无限扩散
- 每轮工具调用必须朝完成标准推进；与目标无关的发现先记录不执行

记忆纪律（P1）：
- 对话中发现的重要事实/偏好/决策，用 memory_save 主动固化（选好 type 和 tags；默认存 L1 事实层）
- 相关记忆已自动注入本提示（分层：L3 画像 → L2 场景块 → L1 事实；L0 原文永不注入）
- 零散事实积累多了，用 memory_consolidate 聚合为 L2 场景块 / 更新 L3 画像（agent 生成摘要）
- 不确定是否该存的：先存（记忆是内部动作，宁多勿漏，错误可 memory_forget）

所有写操作（fs_write/fs_append/fs_patch）和 shell_run 会请求用户确认（y/n/a：a=本会话不再询问该工具）；被拒绝就换方案。`;

/** 仓库结构快照：会话初始注入，省去 agent 反复 fs_list 探索目录树 */
const TREE_IGNORE = new Set(['node_modules', '.git', 'dist', 'build', 'runs', 'artifacts', 'generated-images', '.codebuddy']);

async function buildRepoTree(root: string, maxDepth = 3, maxLines = 100): Promise<string> {
  const { readdir } = await import('node:fs/promises');
  const lines: string[] = ['.'];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (lines.length >= maxLines || depth > maxDepth) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const dirs = entries.filter((e) => e.isDirectory() && !TREE_IGNORE.has(e.name));
    const files = entries.filter((e) => e.isFile());
    for (const e of [...dirs, ...files]) {
      if (lines.length >= maxLines) return;
      const rel = path.relative(root, path.join(dir, e.name)) || e.name;
      lines.push(`${rel}${e.isDirectory() ? '/' : ''}`);
      if (e.isDirectory()) await walk(path.join(dir, e.name), depth + 1);
    }
  };
  await walk(root, 1);
  return lines.join('\n');
}

/** CLI 配置聚合：LLM + MCP servers + 全局 FORBID 名单 */
interface CliConfig {
  llm: LLMConfig | null;
  mcpServers: McpServerConfig[];
  forbiddenTools: string[];
}

async function loadConfig(): Promise<CliConfig> {
  const empty: CliConfig = { llm: null, mcpServers: [], forbiddenTools: [] };
  try {
    const raw = JSON.parse(
      await readFile(path.join(PAA_ROOT, 'config.json'), 'utf8'),
    ) as Record<string, unknown>;
    const apiUrl = String(raw.apiUrl ?? raw.baseUrl ?? '');
    const baseUrl = apiUrl.endsWith('/chat/completions')
      ? apiUrl.replace(/\/chat\/completions$/, '')
      : apiUrl;
    let llm: LLMConfig | null = null;
    if (baseUrl && raw.apiKey) {
      llm = {
        provider: 'openai-compatible',
        baseUrl,
        apiKey: String(raw.apiKey),
        model: String(raw.model ?? 'deepseek-chat'),
      };
    }
    // G5：MCP servers（数组；单项不合法跳过并提示，不整体失败）
    const mcpServers: McpServerConfig[] = [];
    if (Array.isArray(raw.mcpServers)) {
      for (const s of raw.mcpServers as Array<Record<string, unknown>>) {
        if (typeof s !== 'object' || s === null) continue;
        if (typeof s.name !== 'string' || !s.name.trim()) continue;
        if (typeof s.command !== 'string' || !s.command.trim()) continue;
        mcpServers.push({
          name: s.name,
          command: s.command,
          args: Array.isArray(s.args) ? (s.args as string[]) : undefined,
          env: typeof s.env === 'object' && s.env !== null ? (s.env as Record<string, string>) : undefined,
          risk: s.risk === 1 || s.risk === 2 || s.risk === 3 ? s.risk : undefined,
        });
      }
    }
    // G5：全局 FORBID 名单（config.forbiddenTools，硬拒绝任何工具）
    const forbiddenTools: string[] = Array.isArray(raw.forbiddenTools)
      ? (raw.forbiddenTools as unknown[]).filter((x): x is string => typeof x === 'string')
      : [];
    return { llm, mcpServers, forbiddenTools };
  } catch {
    return empty;
  }
}

function parseArgs(argv: string[]): {
  root: string;
  level: AutonomyLevel;
  once: string | null;
  goal: string | null;
  resume: string | null;
  yes: boolean;
  agent: string | null;
  exportMemory: string | null;
  importMemory: string | null;
  concurrency: number;
  subtaskRounds: number;
} {
  let root = WORKSPACE_ROOT;
  let level: AutonomyLevel = 2;
  let once: string | null = null;
  let goal: string | null = null;
  let resume: string | null = null;
  let yes = false;
  let agent: string | null = null;
  let exportMemory: string | null = null;
  let importMemory: string | null = null;
  let concurrency = 1;
  let subtaskRounds = 24;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root' && argv[i + 1]) root = path.resolve(argv[++i]);
    if (argv[i] === '--level') {
      const n = Number(argv[i + 1]);
      if (!Number.isNaN(n) && n >= 0 && n <= 4) level = n as AutonomyLevel;
      i++;
    }
    if (argv[i] === '--once' && argv[i + 1]) once = argv[++i];
    if (argv[i] === '--goal' && argv[i + 1]) goal = argv[++i];
    if (argv[i] === '--resume' && argv[i + 1]) resume = argv[++i];
    if (argv[i] === '--concurrency') {
      const n = Number(argv[i + 1]);
      if (!Number.isNaN(n) && n >= 1 && n <= 6) concurrency = Math.floor(n);
      i++;
    }
    if (argv[i] === '--subtask-rounds') {
      const n = Number(argv[i + 1]);
      if (!Number.isNaN(n) && n >= 4 && n <= 60) subtaskRounds = Math.floor(n);
      i++;
    }
    if (argv[i] === '--yes') yes = true;
    if (argv[i] === '--agent' && argv[i + 1]) agent = argv[++i];
    if (argv[i] === '--export-memory' && argv[i + 1]) exportMemory = path.resolve(argv[++i]);
    if (argv[i] === '--import-memory' && argv[i + 1]) importMemory = path.resolve(argv[++i]);
  }
  return { root, level, once, goal, resume, yes, agent, exportMemory, importMemory, concurrency, subtaskRounds };
}

/** agent 角色配置（paa/agents/*.json）：工具白名单 + 人格 prompt + 默认 Autonomy */
interface AgentConfig {
  name: string;
  title: string;
  description?: string;
  tools?: string[];
  autonomy?: number;
  systemPrompt: string;
}

/** 加载角色配置；不存在/非法返回 null */
async function loadAgent(name: string): Promise<AgentConfig | null> {
  try {
    const raw = JSON.parse(
      await readFile(path.join(PAA_ROOT, 'agents', `${name}.json`), 'utf8'),
    ) as AgentConfig;
    if (typeof raw.name !== 'string' || typeof raw.systemPrompt !== 'string') return null;
    return raw;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const { root, level, once, goal, resume, yes, agent: agentName, exportMemory, importMemory, concurrency, subtaskRounds } = parseArgs(process.argv.slice(2));

  // --agent <name>：角色配置（工具白名单 + 人格 prompt + 默认 Autonomy）
  const agentCfg = agentName ? await loadAgent(agentName) : null;
  if (agentName && !agentCfg) {
    console.error(`❌ agent 角色 "${agentName}" 未找到（应在 paa/agents/${agentName}.json）`);
    process.exit(1);
  }
  const effectiveLevel: AutonomyLevel =
    agentCfg && typeof agentCfg.autonomy === 'number' ? (agentCfg.autonomy as AutonomyLevel) : level;
  const baseSystem =
    (agentCfg?.systemPrompt ?? SYSTEM_PROMPT) +
    '\n\n# 仓库结构快照（会话初始注入，直接据此定位路径，不要对未知目录反复 fs_list 试错）\n' +
    await buildRepoTree(root);

  // 记忆系统（C4）：JSON 文件存储 + L3 画像种子（首次自动初始化）
  const memory = new JsonMemoryProvider({
    filePath: path.join(PAA_ROOT, 'memory', 'store.json'),
    seed: createDefaultPersonaSeed(),
  });
  await memory.init();

  // 产物系统（C1/G7）：真实文件落盘 artifacts/<path>，index.json 管元数据
  const artifacts = new FileArtifactProvider(path.join(PAA_ROOT, 'artifacts'));

  // 非交互记忆命令：--export-memory <path> / --import-memory <path>（记忆主权）
  if (exportMemory || importMemory) {
    if (exportMemory) {
      const records = await memory.exportAll();
      const { writeFile } = await import('node:fs/promises');
      await writeFile(exportMemory, JSON.stringify({ version: 'paa-memory-v1.1', exportedAt: Date.now(), records }, null, 2), 'utf8');
      console.log(`✅ 已导出 ${records.length} 条记忆 → ${exportMemory}`);
    }
    if (importMemory) {
      const { readFile: readFile2 } = await import('node:fs/promises');
      const raw = JSON.parse(await readFile2(importMemory, 'utf8')) as {
        records: Parameters<typeof memory.importAll>[0];
      };
      if (!Array.isArray(raw.records)) {
        console.error('❌ 导入文件格式错误：缺少 records 数组');
        process.exit(1);
      }
      const n = await memory.importAll(raw.records);
      console.log(`✅ 已导入/覆盖 ${n} 条记忆`);
    }
    process.exit(0);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // 会话级放行集合：a=always allow 加入，重启清除
  const trustedTools = new Set<string>();
  const ask = async (p: string, toolName?: string): Promise<boolean> => {
    if (yes) return true; // --yes：非交互全自动（脚本/测试/长任务实测）
    if (toolName && trustedTools.has(toolName)) return true;
    const a = (await rl.question(render.ask(p) + ' (y/n/a) ')).trim().toLowerCase();
    if (a === 'a' && toolName) {
      trustedTools.add(toolName);
      console.log(render.status(`会话级放行 ${toolName}，本次不再询问（/trust 查看，重启清除）`));
      return true;
    }
    return a.startsWith('y');
  };

  console.log(render.banner());
  const config = await loadConfig();
  if (!config.llm) {
    console.log(render.error('未找到有效 config.json（需要 apiUrl + apiKey），请先配置。'));
    process.exit(1);
  }

  const session = new SessionMgr(path.join(PAA_ROOT, 'runs'));
  // --resume：复用指定会话目录（断点续跑，事件续写同一 events.jsonl）；否则新建
  let sessionId: string;
  if (resume) {
    if (!/^\d{10,}$/.test(resume)) {
      console.error(`❌ resume 会话 ID 非法: "${resume}"（应为 runs/ 下的数字目录名，如 runs/1785432100000）`);
      process.exit(1);
    }
    sessionId = resume;
  } else {
    sessionId = await session.newSession();
  }

  const audit = (line: string): void => console.log(render.audit(line));
  const permission = new Permission(effectiveLevel);
  // G5：全局 FORBID 名单（config.forbiddenTools，硬拒绝，任何 Autonomy 不可放行）
  for (const f of config.forbiddenTools) permission.forbid(f);
  const pipeline = new ToolPipeline(permission);
  for (const t of createCoreTools(root)) pipeline.register(t);
  for (const t of createMemoryTools(memory)) pipeline.register(t);
  for (const t of createArtifactTools(artifacts)) pipeline.register(t);

  // G5：ToolPkg 动态加载（paa/pkgs/ 目录，manifest.json + impl.mjs）
  const pkgLoader = new PkgLoader({
    pkgsRoot: path.join(PAA_ROOT, 'pkgs'),
    pipeline,
    permission,
    env: { root, pkgDir: path.join(PAA_ROOT, 'pkgs'), audit },
  });
  for (const t of createPkgTools(pkgLoader)) pipeline.register(t);
  const loadedPkgs = await pkgLoader.loadAll();
  const pkgErrors = pkgLoader.getErrors();
  if (Object.keys(pkgErrors).length > 0) {
    for (const [name, why] of Object.entries(pkgErrors)) {
      console.log(render.error(`工具包 ${name} 加载失败（已跳过）: ${why}`));
    }
  }

  // G5：MCP servers（config.mcpServers；单个连接失败不阻塞启动）
  const mcpClients: McpClient[] = [];
  for (const srv of config.mcpServers) {
    const client = new McpClient(srv);
    try {
      await client.connect();
      for (const t of createMcpToolDefinitions(client, { risk: srv.risk })) pipeline.register(t);
      mcpClients.push(client);
    } catch (e) {
      console.log(render.error(`MCP server ${srv.name} 连接失败（已跳过）: ${e instanceof Error ? e.message : String(e)}`));
    }
  }
  const closeMcp = (): void => {
    for (const c of mcpClients) c.close();
  };

  // --agent 白名单过滤：物理移除白名单外的工具（reviewer 因此"改不了代码"）
  if (agentCfg?.tools?.length) {
    const allowed = new Set(agentCfg.tools);
    const removed: string[] = [];
    for (const t of pipeline.list()) {
      if (!allowed.has(t.name)) {
        pipeline.unregister(t.name);
        removed.push(t.name);
      }
    }
    console.log(render.status(`角色 ${agentCfg.name}: 仅保留 ${pipeline.list().length} 个工具（移除 ${removed.length} 个: ${removed.join(', ')}）`));
  }

  const adapter = createAdapter(config.llm);
  const loop = new AgentLoop({
    adapter,
    pipeline,
    session,
    systemPrompt: baseSystem,
    memoryProvider: memory,
    maxRounds: 12,
  });

  const ctx = { sessionId, cwd: root, ask, audit };

  console.log(render.status(`沙箱根: ${root} | Autonomy: L${effectiveLevel}${agentCfg ? ` | 角色: ${agentCfg.name}(${agentCfg.title})` : ''} | 会话: ${sessionId}`));
  const memCount = (await memory.list()).length;
  console.log(render.status(`记忆: ${memCount} 条（paa/memory/store.json，L3 画像种子已注入）`));
  const artCount = (await artifacts.list()).length;
  console.log(render.status(`产物: ${artCount} 个（paa/artifacts/，真文件落盘+版本快照）`));
  console.log(render.status(`工具包: ${loadedPkgs.length} 个已加载（${loadedPkgs.map((p) => p.manifest.name).join(', ') || '无'}）`));
  console.log(render.status(`MCP: ${mcpClients.length} 个已连接（${mcpClients.map((c) => c.name).join(', ') || '无'}）`));
  const toolNames = pipeline.list().map((t) => t.name);
  console.log(render.status(`工具: ${toolNames.length} 个（${toolNames.join(', ')}）`));
  console.log('');

  // goal 模式（A1 planner）：模糊大目标 → 任务树 → 子任务队列自动执行
  // resume 模式（A3 planner）：--resume <sid> 从已落盘任务树断点续跑
  // 用法：node cli/main.ts --goal "给 console 加多会话功能" [--level N] [--root <dir>] [--concurrency N] [--subtask-rounds N]
  //      node cli/main.ts --resume 1785432100000 [--level N] [--root <dir>] [--concurrency N] [--subtask-rounds N]
  if (goal !== null || resume !== null) {
    const planner = new Planner({
      adapter,
      pipeline,
      session,
      baseSystemPrompt: baseSystem,
      memoryProvider: memory,
      options: { maxTasks: 10, subtaskRounds, subtaskConcurrency: concurrency },
      onEvent: (taskId, ev) => {
        if (ev.type === 'tool') {
          const p = ev.payload as { name: string; arguments: Record<string, unknown>; result: { ok: boolean; data?: unknown; error?: string } };
          console.log(render.toolCard(`[${taskId}] ${p.name}`, p.arguments ?? {}, p.result));
        }
      },
    });
    console.log(render.banner());
    console.log(render.status(`沙箱根: ${root} | Autonomy: L${effectiveLevel} | 并发: ${concurrency} | 会话: ${sessionId}`));

    // 【A3 断点续跑】优先于 --goal：加载已落盘任务树，跳过已完成子任务继续执行
    if (resume !== null) {
      const tree = await planner.loadTree(resume);
      if (!tree) {
        console.log(render.error(`❌ 会话 ${resume} 无可用任务树（runs/${resume}/task-tree.json 不存在或损坏），无法续跑`));
        rl.close();
        closeMcp();
        return;
      }
      const doneCount = tree.tasks.filter((t) => t.status === 'done').length;
      console.log(render.status(`🔄 续跑模式: 恢复会话 ${resume}（已完成 ${doneCount}/${tree.tasks.length}，跳过已完成，未完成继续执行）`));
      console.log(render.status(`🎯 目标: ${tree.goal}`));
      try {
        const result = await planner.run(tree.goal, ctx, tree);
        console.log('');
        for (const [id, oc] of Object.entries(result.outcomes)) {
          const icon = oc.status === 'done' ? '✅' : '❌';
          console.log(render.status(`${icon} 子任务 ${id}: ${oc.status}（${oc.rounds} 轮 / ${oc.toolCalls} 次工具调用）`));
          if (oc.note) console.log(`   ${oc.note}`);
        }
        console.log('');
        console.log(render.assistant(result.summary));
        console.log(render.status(`任务树已更新: runs/${sessionId}/task-tree.json`));
      } catch (e) {
        console.log(render.error(e instanceof Error ? e.message : String(e)));
      }
      rl.close();
      closeMcp();
      return;
    }

    console.log(render.status(`🎯 目标模式（planner）: ${goal}`));
    console.log(render.status('…生成任务树'));
    try {
      const result = await planner.run(goal!, ctx);
      console.log('');
      for (const [id, oc] of Object.entries(result.outcomes)) {
        const icon = oc.status === 'done' ? '✅' : '❌';
        console.log(render.status(`${icon} 子任务 ${id}: ${oc.status}（${oc.rounds} 轮 / ${oc.toolCalls} 次工具调用）`));
        if (oc.note) console.log(`   ${oc.note}`);
      }
      console.log('');
      console.log(render.assistant(result.summary));
      console.log(render.status(`任务树已落盘: runs/${sessionId}/task-tree.json`));
    } catch (e) {
      console.log(render.error(e instanceof Error ? e.message : String(e)));
    }
    rl.close();
    closeMcp();
    return;
  }

  // 非交互单次执行（--once "指令"）：脚本/自动化/测试场景
  if (once !== null) {
    const run = async (input: string): Promise<void> => {
      console.log(render.status('…思考中'));
      try {
        const result = await loop.run(input, ctx);
        for (const ev of result.events) {
          if (ev.type === 'tool') {
            const p = ev.payload as { name: string; arguments: Record<string, unknown>; result: { ok: boolean; data?: unknown; error?: string } };
            console.log(render.toolCard(p.name, p.arguments ?? {}, p.result));
          }
        }
        console.log(render.assistant(result.answer || '(空回复)'));
        console.log('');
      } catch (e) {
        console.log(render.error(e instanceof Error ? e.message : String(e)));
      }
    };
    await run(once);
    rl.close();
    closeMcp();
    return;
  }

  // for-await 迭代器：readline 在创建时即缓冲 stdin，不受异步初始化时序影响（管道/终端都稳）
  for await (const raw of rl) {
    process.stdout.write(render.prompt());
    const input = raw.trim();
    if (!input) continue;
    if (input === '/quit' || input === '/exit') break;
    if (input === '/tools') {
      pipeline.list().forEach((t) => console.log(`  - ${t.name} [risk ${t.risk}] ${t.desc}`));
      continue;
    }
    if (input.startsWith('/level')) {
      const n = Number(input.split(/\s+/)[1]);
      if (!Number.isNaN(n) && n >= 0 && n <= 4) {
        permission.setLevel(n as AutonomyLevel);
        console.log(render.status(`Autonomy 级别 → L${n}`));
      } else {
        console.log(render.error('级别需为 0-4'));
      }
      continue;
    }
    if (input === '/replay') {
      const events = await session.load(sessionId);
      for (const ev of events) {
        console.log(render.status(`[${new Date(ev.ts).toLocaleTimeString()}] ${ev.type}`));
      }
      continue;
    }
    if (input === '/trust') {
      if (trustedTools.size === 0) console.log(render.status('当前无会话级放行的工具（/trust clear 清空，重启自动清除）'));
      else {
        console.log(render.status('会话级放行的工具:'));
        for (const t of trustedTools) console.log(`  - ${t}`);
      }
      continue;
    }
    if (input === '/trust clear') {
      trustedTools.clear();
      console.log(render.status('已清空会话级放行'));
      continue;
    }

    console.log(render.status('…思考中'));
    try {
      const result = await loop.run(input, ctx);
      for (const ev of result.events) {
        if (ev.type === 'tool') {
          const p = ev.payload as { name: string; arguments: Record<string, unknown>; result: { ok: boolean; data?: unknown; error?: string } };
          console.log(render.toolCard(p.name, p.arguments ?? {}, p.result));
        }
      }
      console.log(render.assistant(result.answer || '(空回复)'));
      if (result.rounds > 1) {
        console.log(render.status(`（${result.rounds} 轮 / ${result.toolCalls} 次工具调用）`));
      }
      console.log('');
    } catch (e) {
      console.log(render.error(e instanceof Error ? e.message : String(e)));
      console.log('');
    }
  }
  rl.close();
  closeMcp();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
