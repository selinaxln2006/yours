// C2 现场造工具闭环测试（无 LLM）：
// 模拟 agent 在长任务中"发现缺工具 → 现场写 ToolPkg（manifest.json + impl.mjs）→ pkg_install 热加载 → 下一轮直接调用"的完整链路。
// 验证对象：pkg_install（pkg-tools）+ PkgLoader 热挂载 + 新工具立即可用（C2 的机制底座）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { PkgLoader } from '../core/pkg-loader.ts';
import { Permission } from '../core/permission.ts';
import { ToolPipeline } from '../core/tool-pipeline.ts';
import { createPkgTools } from '../tools/pkg-tools.ts';
import type { ExecContext, ToolCall } from '../core/types.ts';

interface Harness {
  sandboxRoot: string; // 沙箱根（fs 工具的 root，CLI 默认 = 仓库根）
  pipeline: ToolPipeline;
  loader: PkgLoader;
  audited: string[];
}

function makeHarness(): Harness {
  const dir = mkdtempSync(path.join(tmpdir(), 'paa-c2-'));
  const permission = new Permission(4); // L4 全自动（--yes 语义：无人值守不询问）
  const pipeline = new ToolPipeline(permission);
  const audited: string[] = [];
  const loader = new PkgLoader({
    pkgsRoot: path.join(dir, 'pkgs'),
    pipeline,
    permission,
    env: { root: dir, pkgDir: path.join(dir, 'pkgs'), audit: (l) => audited.push(l) },
  });
  for (const t of createPkgTools(loader)) pipeline.register(t);
  return { sandboxRoot: dir, pipeline, loader, audited };
}

function runTool(h: Harness, call: ToolCall): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const ctx: ExecContext = {
    sessionId: 'c2-test',
    cwd: h.sandboxRoot, // CLI 的 ctx.cwd = 沙箱根，pkg_install src 相对它解析
    ask: async () => true,
    audit: (l) => h.audited.push(l),
  };
  return h.pipeline.run(call, ctx);
}

/** 模拟 agent 用 fs_write 写包文件（父目录先经 shell_run 创建——fs 工具无 mkdir） */
function writePkgFiles(h: Harness, pkgName: string, manifest: unknown, impl: string): string {
  const src = path.join(h.sandboxRoot, 'artifacts', 'c2', pkgName);
  mkdirSync(src, { recursive: true }); // = shell_run New-Item
  writeFileSync(path.join(src, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  writeFileSync(path.join(src, 'impl.mjs'), impl, 'utf8');
  return path.relative(h.sandboxRoot, src).replace(/\\/g, '/'); // pkg_install 的 src（相对沙箱根）
}

test('C2 现场造包闭环：写包 → pkg_install → 新工具立即可用 → 已拷入 pkgs/', async () => {
  const h = makeHarness();
  const src = writePkgFiles(
    h,
    'mycalc',
    {
      name: 'mycalc',
      version: '0.1.0',
      desc: '现场造的计算包',
      tools: [
        { name: 'add', desc: '两数相加', params: { a: { type: 'number', required: true }, b: { type: 'number', required: true } }, risk: 1 },
        { name: 'mul', desc: '两数相乘', params: { a: { type: 'number', required: true }, b: { type: 'number', required: true } }, risk: 1 },
      ],
    },
    `export function createPkgTools(env) {
  return {
    add: async (args) => ({ sum: Number(args.a) + Number(args.b) }),
    mul: async (args) => ({ product: Number(args.a) * Number(args.b) }),
  };
}`,
  );

  // agent 行为 ①：pkg_install 安装现场写的包（相对沙箱根路径）
  const install = await runTool(h, { id: '1', name: 'pkg_install', arguments: { src } });
  assert.equal(install.ok, true, `pkg_install 应成功: ${install.error}`);
  assert.ok(h.loader.isLoaded('mycalc'), '加载器应标记已加载');
  assert.ok(h.pipeline.get('mycalc_add'), 'add 应已注册');
  assert.ok(h.pipeline.get('mycalc_mul'), 'mul 应已注册');
  assert.ok(existsSync(path.join(h.sandboxRoot, 'pkgs', 'mycalc', 'impl.mjs')), '包应已拷入 pkgs/');

  // agent 行为 ②：下一轮直接调用新工具（同一 pipeline 实例 → 立即可用）
  const use = await runTool(h, { id: '2', name: 'mycalc_add', arguments: { a: 123, b: 456 } });
  assert.equal(use.ok, true);
  assert.equal((use.data as { sum: number }).sum, 579);
  const mul = await runTool(h, { id: '3', name: 'mycalc_mul', arguments: { a: 12, b: 7 } });
  assert.equal(mul.ok, true);
  assert.equal((mul.data as { product: number }).product, 84);

  // agent 行为 ③：pkg_list 能看到加载状态
  const list = await runTool(h, { id: '4', name: 'pkg_list', arguments: {} });
  assert.equal(list.ok, true);
  assert.match(JSON.stringify(list.data), /mycalc/);
  assert.doesNotMatch(JSON.stringify(list.data), /"error":\s*"[^"]+"/, 'mycalc 不应有加载错误');
});

test('C2 坏包反馈：impl 语法错误 → pkg_install 失败回滚 → 修复后重装成功', async () => {
  const h = makeHarness();
  const src = writePkgFiles(
    h,
    'badpkg',
    {
      name: 'badpkg',
      version: '0.1.0',
      desc: '坏包',
      tools: [{ name: 'boom', desc: '坏实现', params: {}, risk: 1 }],
    },
    `export function createPkgTools(env) { return { boom: async () => { return { broken: 1 }`, // 括号不闭合 → import 时 SyntaxError
  );

  const first = await runTool(h, { id: '1', name: 'pkg_install', arguments: { src } });
  assert.equal(first.ok, false, '语法错误的 impl 应加载失败');
  assert.ok(!h.loader.isLoaded('badpkg'), '失败后不应标记已加载');
  assert.equal(h.pipeline.get('badpkg_boom'), undefined, '失败后不应残留注册');
  assert.ok(!existsSync(path.join(h.sandboxRoot, 'pkgs', 'badpkg')), '失败后 pkgs/ 应回滚删除');

  // 修复 impl（agent 重写文件后重装）
  writeFileSync(
    path.join(h.sandboxRoot, 'artifacts', 'c2', 'badpkg', 'impl.mjs'),
    `export function createPkgTools(env) { return { boom: async () => ({ ok: true }) }; }`,
    'utf8',
  );
  const second = await runTool(h, { id: '2', name: 'pkg_install', arguments: { src } });
  assert.equal(second.ok, true, `修复后重装应成功: ${second.error}`);
  assert.ok(h.loader.isLoaded('badpkg'));
  const use = await runTool(h, { id: '3', name: 'badpkg_boom', arguments: {} });
  assert.equal(use.ok, true);
});

test('C2 同名冲突反馈：pkg_install 已存在 → 明确报错提示先卸载', async () => {
  const h = makeHarness();
  const src = writePkgFiles(
    h,
    'dup',
    {
      name: 'dup',
      version: '0.1.0',
      desc: '重复包',
      tools: [{ name: 'ping', desc: '测试', params: {}, risk: 1 }],
    },
    `export function createPkgTools(env) { return { ping: async () => ({ pong: true }) }; }`,
  );
  const first = await runTool(h, { id: '1', name: 'pkg_install', arguments: { src } });
  assert.equal(first.ok, true);
  const second = await runTool(h, { id: '2', name: 'pkg_install', arguments: { src } });
  assert.equal(second.ok, false);
  assert.match(second.error ?? '', /已加载|同名/, '重复安装应明确报错');
});
