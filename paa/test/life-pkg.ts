// life ToolPkg 测试：经 PkgLoader 真加载（services 注入校验）+ 13 工具 handler 行为与 index.html 语义一致
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, cpSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { PkgLoader } from '../core/pkg-loader.ts';
import { Permission } from '../core/permission.ts';
import { ToolPipeline } from '../core/tool-pipeline.ts';
import { LifeStore } from '../core/life-store.ts';
import type { ExecContext, ToolCall } from '../core/types.ts';

const PAA_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

interface Harness {
  loader: PkgLoader;
  pipeline: ToolPipeline;
  permission: Permission;
  store: LifeStore;
  dataDir: string;
}

async function makeHarness(): Promise<Harness> {
  const dir = mkdtempSync(path.join(tmpdir(), 'paa-lifepkg-'));
  const pkgsRoot = path.join(dir, 'pkgs');
  const dataDir = path.join(dir, 'data');
  mkdirSync(pkgsRoot, { recursive: true });
  // 把真实 life 包复制进 tmp（经 discover/loadAll 真加载，不走捷径）
  cpSync(path.join(PAA_ROOT, 'pkgs', 'life'), path.join(pkgsRoot, 'life'), { recursive: true });

  const store = new LifeStore(dataDir);
  await store.init();

  const permission = new Permission(2);
  const pipeline = new ToolPipeline(permission);
  const loader = new PkgLoader({
    pkgsRoot,
    pipeline,
    permission,
    env: {
      root: dir,
      pkgDir: pkgsRoot,
      audit: () => {},
      services: { lifeStore: store },
    },
  });
  const loaded = await loader.loadAll();
  assert.equal(loaded.length, 1, 'life 包应加载成功');
  return { loader, pipeline, permission, store, dataDir };
}

function ctxOf(h: Harness, autoApprove = true): ExecContext {
  return {
    sessionId: 'test',
    cwd: h.dataDir,
    ask: async () => autoApprove,
    audit: () => {},
  };
}

async function call(h: Harness, tool: string, args: Record<string, unknown>, autoApprove = true) {
  return h.pipeline.run({ id: `c-${Math.random().toString(36).slice(2, 8)}`, name: `life_${tool}`, arguments: args }, ctxOf(h, autoApprove));
}

test('life 包真加载：14 工具注册为 life_*，query_summary 为 risk1 读工具', async () => {
  const h = await makeHarness();
  const names = h.pipeline.list().map((t) => t.name).filter((n) => n.startsWith('life_'));
  assert.equal(names.length, 14);
  assert.equal(h.pipeline.get('life_suggest_plan')?.risk, 2, '建议计划不产生外部影响：L2 免确认');
  // manifest 没写 required 的参数是可选的
  const todo = h.pipeline.get('life_add_todo');
  assert.equal(todo?.params.title.required, true);
  assert.equal(todo?.params.priority.required, false);
  assert.equal(h.pipeline.get('life_query_summary')?.risk, 1);
  assert.equal(h.pipeline.get('life_create_goal')?.risk, 3);
  assert.equal(h.pipeline.get('life_add_weight')?.risk, 3);
});

test('services 缺失时加载失败（声明式 DI 校验）', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'paa-lifepkg-nosvc-'));
  const pkgsRoot = path.join(dir, 'pkgs');
  mkdirSync(pkgsRoot, { recursive: true });
  cpSync(path.join(PAA_ROOT, 'pkgs', 'life'), path.join(pkgsRoot, 'life'), { recursive: true });
  const loader = new PkgLoader({
    pkgsRoot,
    pipeline: new ToolPipeline(new Permission(2)),
    permission: new Permission(2),
    env: { root: dir, pkgDir: pkgsRoot, audit: () => {} }, // 不注入 services
  });
  await assert.rejects(() => loader.load('life'), /lifeStore.*未由宿主注入/);
});

test('query_summary：返回今日摘要 JSON（含 profile/目标/待办统计）', async () => {
  const h = await makeHarness();
  const r = await call(h, 'query_summary', {});
  assert.equal(r.ok, true);
  const s = JSON.parse(r.data as string);
  assert.ok(s.today);
  assert.equal(s.latestWeight, null);
  assert.ok('profile' in s && 'activeGoals' in s && 'totalAssets' in s);
});

test('create_goal(weight)：跨键事务写 goals+todos，里程碑分解符合 index.html 算法', async () => {
  const h = await makeHarness();
  // 先放基线体重 60kg
  await call(h, 'add_weight', { weight: 60 });
  const r = await call(h, 'create_goal', { title: '减重15斤', type: 'weight', target: 52.5 });
  assert.equal(r.ok, true);
  const goal = (h.store.get('goals') as Array<Record<string, unknown>>)[0];
  assert.equal(goal.startVal, 60);
  assert.equal(goal.type, 'weight');
  const ms = goal.milestones as Array<{ title: string; target: number }>;
  // 60→52.5 差 7.5kg → steps=min(ceil(7.5),5)=5，首里程碑 ≈ 58.5
  assert.equal(ms.length, 5);
  assert.ok(Math.abs(ms[0].target - 58.5) < 0.01);
  // 配套待办 3 条（weight 类）
  const todos = h.store.get('todos') as unknown[];
  assert.equal(todos.length, 3);
});

test('add_weight + change 事件：写入触发 lifeStore change(source=agent)', async () => {
  const h = await makeHarness();
  const events: Array<{ key: string; source: string }> = [];
  h.store.on('change', (ev: { key: string; source: string }) => events.push(ev));
  const r = await call(h, 'add_weight', { weight: 57.5 });
  assert.equal(r.ok, true);
  assert.equal(events.length, 1);
  assert.equal(events[0].key, 'weights');
  assert.equal(events[0].source, 'agent');
  const w = h.store.get('weights') as Array<{ weight: number }>;
  assert.equal(w.length, 1);
  assert.equal(w[0].weight, 57.5);
});

test('add_sleep：同日重复记录 upsert 而非追加', async () => {
  const h = await makeHarness();
  await call(h, 'add_sleep', { hours: 7, quality: 3 });
  await call(h, 'add_sleep', { hours: 8, quality: 5 });
  const sleep = h.store.get('sleep') as Array<{ hours: number; quality: number }>;
  assert.equal(sleep.length, 1, '同一天应覆盖');
  assert.equal(sleep[0].hours, 8);
  assert.equal(sleep[0].quality, 5);
});

test('add_schedule：weekly + count=10 → rruleUntil = 首次日期+9周', async () => {
  const h = await makeHarness();
  const r = await call(h, 'add_schedule', {
    title: '每周一运动', date: '2026-08-25', startTime: '18:00',
    rrule: 'weekly', rruleDays: [1], count: 10,
  });
  assert.equal(r.ok, true);
  const data = r.data as { rruleUntil: string };
  // 2026-08-25 是周二；weekly+count=10 → until = 8/25 + 9*7 = 2026-10-27
  assert.equal(data.rruleUntil, '2026-10-27');
  const ev = (h.store.get('schedule') as Array<Record<string, unknown>>)[0];
  assert.equal(ev.rrule, 'weekly');
  assert.deepEqual(ev.rruleDays, [1]);
});

test('参数校验：缺必填参数抛错（工具结果 ok=false）', async () => {
  const h = await makeHarness();
  const r = await call(h, 'add_weight', {});
  assert.equal(r.ok, false);
  assert.match(String(r.error), /weight/);
});

test('L2 下 risk3 写工具触发 ask（权限门照常生效）', async () => {
  const h = await makeHarness();
  let asked = 0;
  const ctx: ExecContext = {
    sessionId: 'test', cwd: h.dataDir,
    ask: async () => { asked++; return false; }, // 拒绝
    audit: () => {},
  };
  const r = await h.pipeline.run({ id: '1', name: 'life_add_water', arguments: { amount: 300 } }, ctx);
  assert.equal(asked, 1, 'risk3 在 L2 应触发确认');
  assert.equal(r.ok, false, '用户拒绝后工具应失败');
  assert.equal((h.store.get('water') as unknown[]).length, 0, '数据不应被写入');
});

test('suggest_plan：写入「建议」待办；同一目标重拆替换未承诺的旧建议，已承诺的保留', async () => {
  const h = await makeHarness();
  const today = new Date();
  const ymd = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
  const r1 = await call(h, 'suggest_plan', { goalId: 'g1', items: [
    { title: '刷 2 道概率题', dueDate: ymd(today), priority: 'high' },
    { title: '整理错题', dueDate: ymd(tomorrow) },
    { title: '   ' },
    { title: '过去的日期挪到今天', dueDate: '2000-01-01' },
  ] });
  assert.equal(r1.ok, true);
  let todos = h.store.get('todos') as Array<Record<string, unknown>>;
  assert.equal(todos.length, 3, '空标题跳过');
  assert.ok(todos.every((x) => x.plan === 'suggested' && x.goalId === 'g1' && x.done === false));
  assert.equal(todos.find((x) => x.title === '过去的日期挪到今天')?.dueDate, ymd(today));
  // 用户把第一条点成「今天做」
  todos[0].plan = 'committed';
  await h.store.tx((d) => { (d as Record<string, unknown>).todos = todos; }, { source: 'ui' });
  const r2 = await call(h, 'suggest_plan', { goalId: 'g1', items: [{ title: '新建议', dueDate: ymd(tomorrow) }] });
  assert.equal(r2.ok, true);
  assert.equal((r2.data as { replaced: number }).replaced, 2);
  todos = h.store.get('todos') as Array<Record<string, unknown>>;
  assert.deepEqual(todos.map((x) => [x.title, x.plan]), [['刷 2 道概率题', 'committed'], ['新建议', 'suggested']]);
  await assert.ok((await call(h, 'suggest_plan', { items: [] })).ok === false);
});

test('query_summary：承诺和建议分开统计', async () => {
  const h = await makeHarness();
  await call(h, 'add_todo', { title: '交作业', atHome: true });
  await call(h, 'suggest_plan', { items: [{ title: '参考：看书', dueDate: '2999-01-01' }] });
  const s = JSON.parse((await call(h, 'query_summary', {})).data as string);
  assert.equal(s.pendingTodoCount, 1);
  assert.equal(s.pendingTodos[0].atHome, true);
  assert.equal(s.suggestedTodos.length, 1);
});
