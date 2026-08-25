// G5 pkg 加载器测试：合法加载 / forbid 硬拒绝 / 工具可调 / 冲突回滚 / 校验失败 / 卸载重装
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, cpSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { PkgLoader } from '../core/pkg-loader.ts';
import { Permission } from '../core/permission.ts';
import { ToolPipeline } from '../core/tool-pipeline.ts';
import type { ExecContext, ToolCall } from '../core/types.ts';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

interface Harness {
  loader: PkgLoader;
  pipeline: ToolPipeline;
  permission: Permission;
  asked: string[];
  audited: string[];
  dir: string;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(path.join(tmpdir(), 'paa-pkg-'));
  const pkgsRoot = path.join(dir, 'pkgs');
  const permission = new Permission(2); // L2：risk1/2 自动，risk3 确认
  const pipeline = new ToolPipeline(permission);
  const asked: string[] = [];
  const audited: string[] = [];
  const loader = new PkgLoader({
    pkgsRoot,
    pipeline,
    permission,
    env: { root: dir, pkgDir: pkgsRoot, audit: (l) => audited.push(l) },
  });
  return { loader, pipeline, permission, asked, audited, dir };
}

/** 把 fixtures/pkgs/hello 复制进 tmp 的 pkgs 目录 */
function installFixtureHello(h: Harness): void {
  cpSync(path.join(FIXTURES, 'pkgs', 'hello'), path.join(h.dir, 'pkgs', 'hello'), { recursive: true });
}

function runTool(h: Harness, call: ToolCall): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const ctx: ExecContext = {
    sessionId: 'test',
    cwd: h.dir,
    ask: async (p, toolName) => {
      h.asked.push(toolName ?? '?');
      return true;
    },
    audit: (l) => h.audited.push(l),
  };
  return h.pipeline.run(call, ctx);
}

test('合法包加载：3 工具注册 + forbid 灌入 + 工具可调', async () => {
  const h = makeHarness();
  installFixtureHello(h);
  const lp = await h.loader.load('hello');
  assert.equal(lp.toolNames.length, 3);
  assert.ok(h.pipeline.get('hello_greet'));
  assert.ok(h.pipeline.get('hello_write_note'));
  assert.ok(h.pipeline.get('hello_boom'));
  assert.ok(h.permission.isForbidden('hello_boom'), 'manifest.permissions.forbid 应灌入 Permission');

  // risk1 读工具：L2 下自动放行，不询问
  const r = await runTool(h, { id: '1', name: 'hello_greet', arguments: { who: '俪宁' } });
  assert.equal(r.ok, true);
  assert.equal(r.data, '你好，俪宁！来自 pkg hello@0.1.0');
  assert.equal(h.asked.length, 0, 'risk1 不应触发确认');
});

test('forbid 硬拒绝：hello_boom 在任何 Autonomy 级别都不可调（L4 也不行）', async () => {
  const h = makeHarness();
  installFixtureHello(h);
  await h.loader.load('hello');
  h.permission.setLevel(4); // 最高自治级
  const r = await runTool(h, { id: '1', name: 'hello_boom', arguments: {} });
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /FORBID/);
  assert.equal(h.asked.length, 0, 'FORBID 不应触发询问');
});

test('risk3 写工具：L2 下需确认，确认后执行并审计', async () => {
  const h = makeHarness();
  installFixtureHello(h);
  await h.loader.load('hello');
  const r = await runTool(h, { id: '1', name: 'hello_write_note', arguments: { text: 'G5 测试笔记' } });
  assert.equal(r.ok, true);
  assert.equal(h.asked.length, 1, 'risk3 应触发一次确认');
  assert.ok(existsSync(path.join(h.dir, 'pkgs', 'hello', 'notes.txt')), '笔记应落盘在 pkgDir');
});

test('工具名冲突：预注册同名工具 → 加载失败且回滚干净', async () => {
  const h = makeHarness();
  installFixtureHello(h);
  // 预注册一个占用 hello_greet 的工具
  h.pipeline.register({
    name: 'hello_greet',
    desc: '占位',
    params: {},
    risk: 1,
    handler: async () => '占位',
  });
  await assert.rejects(() => h.loader.load('hello'), /冲突/);
  assert.equal(h.loader.isLoaded('hello'), false);
  assert.equal(h.pipeline.get('hello_write_note'), undefined, '冲突失败后不应残留部分注册');
  assert.equal(h.permission.isForbidden('hello_boom'), false, '回滚应解除 forbid');
});

test('重复加载：同包二次 load 报错', async () => {
  const h = makeHarness();
  installFixtureHello(h);
  await h.loader.load('hello');
  await assert.rejects(() => h.loader.load('hello'), /已加载/);
});

test('卸载：工具移除 + forbid 解除 + 可重装', async () => {
  const h = makeHarness();
  installFixtureHello(h);
  await h.loader.load('hello');
  assert.equal(h.loader.unload('hello'), true);
  assert.equal(h.pipeline.get('hello_greet'), undefined);
  assert.equal(h.permission.isForbidden('hello_boom'), false);
  // 目录还在，可重新加载（pkg_reload 场景）
  const lp = await h.loader.load('hello');
  assert.equal(lp.toolNames.length, 3);
});

test('校验失败矩阵：非法 manifest 一律拒绝且不残留', async () => {
  const cases: Array<{ name: string; mutate: (m: Record<string, unknown>) => void }> = [
    { name: '名字不合法（大写）', mutate: (m) => { m.name = 'Hello'; } },
    { name: '目录名与 name 不一致', mutate: (m) => { m.name = 'other'; } },
    { name: '版本非法', mutate: (m) => { m.version = 'v1'; } },
    { name: '工具重名', mutate: (m) => { (m.tools as unknown[]).push((m.tools as unknown[])[0]); } },
    { name: 'risk 越界', mutate: (m) => { ((m.tools as unknown[])[0] as Record<string, unknown>).risk = 5; } },
    { name: 'forbid 引用不存在工具', mutate: (m) => { m.permissions = { forbid: ['ghost'] }; } },
    { name: 'tools 为空', mutate: (m) => { m.tools = []; } },
  ];
  for (const c of cases) {
    const h = makeHarness();
    const pkgDir = path.join(h.dir, 'pkgs', 'hello');
    cpSync(path.join(FIXTURES, 'pkgs', 'hello'), pkgDir, { recursive: true });
    const manifestPath = path.join(pkgDir, 'manifest.json');
    const { readFileSync } = await import('node:fs');
    const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    c.mutate(m);
    writeFileSync(manifestPath, JSON.stringify(m, null, 2), 'utf8');
    await assert.rejects(() => h.loader.load('hello'), undefined, c.name);
    assert.equal(h.loader.isLoaded('hello'), false, `${c.name}: 不应标记已加载`);
    assert.equal(h.pipeline.list().length, 0, `${c.name}: 不应残留工具`);
  }
});

test('impl 缺失或工厂缺失：明确报错', async () => {
  const h = makeHarness();
  const pkgDir = path.join(h.dir, 'pkgs', 'noimpl');
  cpSync(path.join(FIXTURES, 'pkgs', 'hello'), pkgDir, { recursive: true });
  // 同步改名（目录名 = manifest.name 校验需通过，才能走到 impl 加载分支）
  const manifestPath = path.join(pkgDir, 'manifest.json');
  const { readFileSync } = await import('node:fs');
  const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name: string };
  m.name = 'noimpl';
  writeFileSync(manifestPath, JSON.stringify(m, null, 2), 'utf8');
  // 删 impl.mjs
  const { rmSync } = await import('node:fs');
  rmSync(path.join(pkgDir, 'impl.mjs'));
  await assert.rejects(() => h.loader.load('noimpl'), /impl\.mjs 加载失败|缺失/);
});

test('loadAll：坏包不阻塞好包，错误记入 getErrors', async () => {
  const h = makeHarness();
  installFixtureHello(h);
  // 放一个坏包（名字非法）
  cpSync(path.join(FIXTURES, 'pkgs', 'hello'), path.join(h.dir, 'pkgs', 'BAD_NAME'), { recursive: true });
  const loaded = await h.loader.loadAll();
  assert.equal(loaded.length, 1, '只有 hello 加载成功');
  assert.equal(loaded[0].manifest.name, 'hello');
  const errors = h.loader.getErrors();
  assert.ok(errors['BAD_NAME'], '坏包错误应被记录');
});
