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
import { createCoreTools } from '../tools/core-tools.ts';
import { createMemoryTools } from '../tools/memory-tools.ts';
import { createArtifactTools } from '../tools/artifact-tools.ts';
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

平台纪律（当前是 Windows/cmd 环境，必须遵守）：
- pwd / ls / cat / grep / head / which / touch / rm / mv 等 Unix 命令不存在，不要用
- 文件检索用 fs_grep（正则），列目录用 fs_list，读文件用 fs_read（行切片）
- shell_run 只用于真实需要的命令（node / npm / git / tsc），命令避免输出中文（cmd 编码 GBK 会乱码）
- 路径分隔符正反斜杠均可，fs 工具自动处理

任务聚焦纪律：
- 一次只做一件事；动手前先明确完成标准（做什么、做到什么程度算完成）
- 探索类任务先定步数预算（如"最多 5 步"），到预算即给阶段性结论，不无限扩散
- 每轮工具调用必须朝完成标准推进；与目标无关的发现先记录不执行

记忆纪律（P1）：
- 对话中发现的重要事实/偏好/决策，用 memory_save 主动固化（选好 type 和 tags；默认存 L1 事实层）
- 相关记忆已自动注入本提示（分层：L3 画像 → L2 场景块 → L1 事实；L0 原文永不注入）
- 零散事实积累多了，用 memory_consolidate 聚合为 L2 场景块 / 更新 L3 画像（agent 生成摘要）
- 不确定是否该存的：先存（记忆是内部动作，宁多勿漏，错误可 memory_forget）

所有写操作（fs_write/fs_append/fs_patch）和 shell_run 会请求用户确认（y/n/a：a=本会话不再询问该工具）；被拒绝就换方案。`;

async function loadConfig(): Promise<LLMConfig | null> {
  try {
    const raw = JSON.parse(
      await readFile(path.join(PAA_ROOT, 'config.json'), 'utf8'),
    ) as Record<string, unknown>;
    const apiUrl = String(raw.apiUrl ?? raw.baseUrl ?? '');
    const baseUrl = apiUrl.endsWith('/chat/completions')
      ? apiUrl.replace(/\/chat\/completions$/, '')
      : apiUrl;
    if (!baseUrl || !raw.apiKey) return null;
    return {
      provider: 'openai-compatible',
      baseUrl,
      apiKey: String(raw.apiKey),
      model: String(raw.model ?? 'deepseek-chat'),
    };
  } catch {
    return null;
  }
}

function parseArgs(argv: string[]): {
  root: string;
  level: AutonomyLevel;
  once: string | null;
  exportMemory: string | null;
  importMemory: string | null;
} {
  let root = WORKSPACE_ROOT;
  let level: AutonomyLevel = 2;
  let once: string | null = null;
  let exportMemory: string | null = null;
  let importMemory: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root' && argv[i + 1]) root = path.resolve(argv[++i]);
    if (argv[i] === '--level') {
      const n = Number(argv[i + 1]);
      if (!Number.isNaN(n) && n >= 0 && n <= 4) level = n as AutonomyLevel;
      i++;
    }
    if (argv[i] === '--once' && argv[i + 1]) once = argv[++i];
    if (argv[i] === '--export-memory' && argv[i + 1]) exportMemory = path.resolve(argv[++i]);
    if (argv[i] === '--import-memory' && argv[i + 1]) importMemory = path.resolve(argv[++i]);
  }
  return { root, level, once, exportMemory, importMemory };
}

async function main(): Promise<void> {
  const { root, level, once, exportMemory, importMemory } = parseArgs(process.argv.slice(2));

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
  if (!config) {
    console.log(render.error('未找到有效 config.json（需要 apiUrl + apiKey），请先配置。'));
    process.exit(1);
  }

  const session = new SessionMgr(path.join(PAA_ROOT, 'runs'));
  const sessionId = await session.newSession();

  const permission = new Permission(level);
  const pipeline = new ToolPipeline(permission);
  for (const t of createCoreTools(root)) pipeline.register(t);
  for (const t of createMemoryTools(memory)) pipeline.register(t);
  for (const t of createArtifactTools(artifacts)) pipeline.register(t);

  const adapter = createAdapter(config);
  const loop = new AgentLoop({
    adapter,
    pipeline,
    session,
    systemPrompt: SYSTEM_PROMPT,
    memoryProvider: memory,
    maxRounds: 12,
  });

  const audit = (line: string): void => console.log(render.audit(line));
  const ctx = { sessionId, cwd: root, ask, audit };

  console.log(render.status(`沙箱根: ${root} | Autonomy: L${level} | 会话: ${sessionId}`));
  const memCount = (await memory.list()).length;
  console.log(render.status(`记忆: ${memCount} 条（paa/memory/store.json，L3 画像种子已注入）`));
  const artCount = (await artifacts.list()).length;
  console.log(render.status(`产物: ${artCount} 个（paa/artifacts/，真文件落盘+版本快照）`));
  console.log(render.status(`工具: ${pipeline.list().map((t) => t.name).join(', ')}`));
  console.log('');

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
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
