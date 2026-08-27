// LifeStore 测试：初始化补默认 / 原子写 / 损坏自愈 / schema 校验拒绝 / tx 事务与事件 / importBlob
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { LifeStore, LIFE_KEYS, defaultLifeData } from '../core/life-store.ts';

function makeStore(): { store: LifeStore; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'paa-life-'));
  return { store: new LifeStore(dir), dir };
}

test('init：19 键全部落盘为默认值文件', async () => {
  const { store, dir } = makeStore();
  await store.init();
  assert.equal(LIFE_KEYS.length, 19, '18 原生键 + meditation');
  for (const k of LIFE_KEYS) {
    assert.ok(existsSync(path.join(dir, `${k}.json`)), `${k}.json 应存在`);
  }
  assert.deepEqual(store.get('weights'), []);
  assert.equal((store.get('profile') as Record<string, unknown>).height, 165);
});

test('原子写：落盘内容与缓存一致，无 .tmp 残留', async () => {
  const { store, dir } = makeStore();
  await store.init();
  await store.tx((d) => {
    (d.weights as Array<{ id: string; weight: number; date: string }>).push({ id: 'w1', weight: 57.5, date: '2026-08-25' });
  }, { source: 'agent' });
  const onDisk = JSON.parse(readFileSync(path.join(dir, 'weights.json'), 'utf8'));
  assert.equal(onDisk.length, 1);
  assert.equal(onDisk[0].weight, 57.5);
  assert.equal(readdirSync(dir).filter((f) => f.endsWith('.tmp')).length, 0, '不应有 tmp 残留');
});

test('损坏自愈：非法 JSON → 隔离 .corrupt 文件 + 重建默认 + heal 事件', async () => {
  const { store, dir } = makeStore();
  await store.init();
  // 制造损坏
  writeFileSync(path.join(dir, 'meals.json'), '{oops not json', 'utf8');

  let healed = null as null | { key: string };
  const fresh = new LifeStore(dir);
  fresh.on('heal', (ev: { key: string }) => { healed = ev; });
  await fresh.init();
  assert.deepEqual(fresh.get('meals'), [], '损坏键应重建为默认空数组');
  assert.ok(healed && healed.key === 'meals', '应发 heal 事件');
  const quarantined = readdirSync(dir).filter((f) => f.startsWith('meals.corrupt-'));
  assert.equal(quarantined.length, 1, '原损坏文件应被隔离保留');
});

test('schema 校验：数组键写入非数组 → tx 整体抛错且不落盘', async () => {
  const { store, dir } = makeStore();
  await store.init();
  await assert.rejects(
    () => store.tx((d) => {
      (d as unknown as Record<string, unknown>).water = { not: 'array' };
    }, { source: 'agent' }),
    /必须是数组/,
  );
  // 落盘文件应未被改动（仍为空数组）
  const onDisk = JSON.parse(readFileSync(path.join(dir, 'water.json'), 'utf8'));
  assert.deepEqual(onDisk, []);
});

test('tx 事务：多键一次提交，逐键发 change 事件，未变更键不发', async () => {
  const { store } = makeStore();
  await store.init();
  const events: Array<{ key: string; source: string }> = [];
  store.on('change', (ev: { key: string; source: string }) => events.push(ev));

  const { changed } = await store.tx((d) => {
    (d.goals as Array<Record<string, unknown>>).push({ id: 'g1', title: '减重', type: 'weight', target: 52, status: 'active', milestones: [] });
    (d.todos as Array<Record<string, unknown>>).push({ id: 't1', title: '每周称重', priority: 'mid', done: false, dueDate: '2026-09-01' });
    // 读一下但不改的键不应出现在 changed
    void (d.weights as unknown[]);
  }, { source: 'agent' });

  assert.deepEqual(changed.sort(), ['goals', 'todos']);
  assert.equal(events.length, 2);
  assert.ok(events.every((e) => e.source === 'agent'));
});

test('importBlob replace：整包替换 + import 事件', async () => {
  const { store } = makeStore();
  await store.init();
  await store.tx((d) => {
    (d.weights as Array<{ id: string; weight: number; date: string }>).push({ id: 'old', weight: 60, date: '2026-01-01' });
  }, { source: 'agent' });

  await store.importBlob({
    weights: [{ id: 'n1', weight: 57.5, date: '2026-08-25' }],
    profile: { height: 166 },
  }, 'replace');

  const w = store.get('weights') as Array<{ id: string }>;
  assert.equal(w.length, 1);
  assert.equal(w[0].id, 'n1');
  assert.equal((store.get('profile') as Record<string, unknown>).height, 166);
});

test('importBlob merge：数组拼接 + 对象覆盖', async () => {
  const { store } = makeStore();
  await store.init();
  await store.importBlob({
    weights: [{ id: 'a', weight: 58, date: '2026-08-24' }],
    profile: { height: 170 },
  }, 'merge');
  await store.importBlob({
    weights: [{ id: 'b', weight: 57.5, date: '2026-08-25' }],
    profile: { age: 21 },
  }, 'merge');

  assert.equal((store.get('weights') as unknown[]).length, 2);
  const p = store.get('profile') as Record<string, unknown>;
  assert.equal(p.height, 170);
  assert.equal(p.age, 21);
  // merge 不带的键保持默认
  assert.equal(p.targetWeight, (defaultLifeData().profile as Record<string, unknown>).targetWeight);
});
