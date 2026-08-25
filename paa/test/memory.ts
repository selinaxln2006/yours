// P1 记忆系统测试：种子初始化 / save / 自动失效 / 分层检索 / forget / consolidate / 导入导出 / 损坏自愈
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  JsonMemoryProvider,
  createDefaultPersonaSeed,
} from '../core/memory-provider.ts';
import type { MemoryRecord } from '../core/types.ts';

function makeProvider(): { p: JsonMemoryProvider; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'paa-mem-'));
  const p = new JsonMemoryProvider({
    filePath: path.join(dir, 'store.json'),
    seed: createDefaultPersonaSeed(),
  });
  return { p, dir };
}

test('种子初始化：空库写入 6 条 L3 画像，且可检索', async () => {
  const { p } = makeProvider();
  const all = await p.list();
  assert.equal(all.length, 6, '种子应为 6 条');
  assert.ok(all.every((r) => r.layer === 'L3' && r.type === 'persona'));

  // L3 常驻：无关 query 也能召回（画像总是带着）
  const mems = await p.search('zzz_无关词', 5);
  assert.ok(mems.length >= 1, 'L3 画像应常驻返回');
  assert.ok(mems.every((r) => r.layer === 'L3'));
});

test('save：默认 L1，可检索命中', async () => {
  const { p } = makeProvider();
  const rec = await p.save({
    layer: 'L1',
    type: 'fact',
    content: '俪宁减重目标 15 斤，截止 12 月',
    tags: ['fitness', 'goal'],
    source: 'agent',
  });
  assert.equal(rec.layer, 'L1');
  assert.equal(rec.invalidAt, null);

  const hit = await p.search('减重 15 斤', 5);
  assert.ok(hit.some((r) => r.id === rec.id), '关键词应命中');
});

test('自动失效：同 tag+type 内容不同的旧记录被 invalidAt', async () => {
  const { p } = makeProvider();
  const a = await p.save({
    layer: 'L1',
    type: 'fact',
    content: '俪宁在美团实习',
    tags: ['career', 'job'],
    source: 'agent',
  });
  const b = await p.save({
    layer: 'L1',
    type: 'fact',
    content: '俪宁在腾讯实习',
    tags: ['career', 'job'],
    source: 'agent',
  });
  const all = await p.list({ type: 'fact' });
  const old = all.find((r) => r.id === a.id);
  assert.ok(old && old.invalidAt, '旧记录应被自动失效');

  const hit = await p.search('美团', 10);
  assert.ok(!hit.some((r) => r.id === a.id), '失效记录不应被检索到');
  const hit2 = await p.search('腾讯', 10);
  assert.ok(hit2.some((r) => r.id === b.id), '新记录应可检索');
  assert.ok(!hit2.some((r) => r.id === a.id), '失效的旧记录不应被新词检索到');
});

test('分层检索：L3 常驻 + L2 命中 + L1 补足 + L0 永不返回', async () => {
  const { p } = makeProvider();
  // L0 原文（永不注入）
  await p.save({
    layer: 'L0',
    type: 'episodic',
    content: '原始对话全文……俪宁说她周三开会',
    tags: ['raw'],
    source: 'agent',
  });
  // L2 场景块
  await p.consolidate('俪宁的健身体系：减重目标 + 每周三练 + 养生茶', {
    layer: 'L2',
    type: 'fact',
    tags: ['fitness'],
    sourceIds: [],
  });
  // L1 事实
  await p.save({
    layer: 'L1',
    type: 'fact',
    content: '俪宁周三上午有例会',
    tags: ['work', 'meeting'],
    source: 'agent',
  });

  const mems = await p.search('健身', 5);
  assert.ok(!mems.some((r) => r.layer === 'L0'), 'L0 永不返回');
  assert.ok(mems.some((r) => r.layer === 'L2' && r.tags.includes('fitness')), 'L2 命中');

  const mems2 = await p.search('周三', 10);
  assert.ok(mems2.some((r) => r.layer === 'L1' && r.tags.includes('meeting')), 'L1 补足');
  assert.ok(mems2.some((r) => r.layer === 'L3'), 'L3 常驻');
});

test('forget：软删后不再检索到', async () => {
  const { p } = makeProvider();
  const rec = await p.save({
    layer: 'L1',
    type: 'fact',
    content: '俪宁喜欢喝奶茶',
    tags: ['food'],
    source: 'agent',
  });
  assert.equal(await p.forget(rec.id), true);
  assert.equal(await p.forget('mem_nonexist'), false, '不存在返回 false');

  const hit = await p.search('奶茶', 10);
  assert.ok(!hit.some((r) => r.id === rec.id));
});

test('consolidate：聚合 L2 并失效源记忆', async () => {
  const { p } = makeProvider();
  const a = await p.save({ layer: 'L1', type: 'fact', content: '减重目标 15 斤', tags: ['fitness'], source: 'agent' });
  const b = await p.save({ layer: 'L1', type: 'fact', content: '每周三练', tags: ['fitness'], source: 'agent' });

  const l2 = await p.consolidate('俪宁健身体系：减重 15 斤 + 每周三练', {
    layer: 'L2',
    type: 'episodic',
    tags: ['fitness'],
    sourceIds: [a.id, b.id],
  });
  assert.equal(l2.layer, 'L2');

  const all = await p.list({ layer: 'L1' });
  const oldA = all.find((r) => r.id === a.id);
  const oldB = all.find((r) => r.id === b.id);
  assert.ok(oldA && oldA.invalidAt, '源记忆 a 应失效');
  assert.ok(oldB && oldB.invalidAt, '源记忆 b 应失效');

  const hit = await p.search('每周三练', 10);
  assert.ok(hit.some((r) => r.id === l2.id), '聚合块应可检索');
});

test('export/import：幂等往返', async () => {
  const { p: p1 } = makeProvider();
  const before = await p1.exportAll();
  assert.equal(before.length, 6, '种子 6 条');

  const rec = await p1.save({ layer: 'L1', type: 'fact', content: 'PAA v1.1 记忆系统上线', tags: ['paa'], source: 'agent' });
  const exported = await p1.exportAll();
  assert.equal(exported.length, 7);

  // 导入到新库
  const { p: p2 } = makeProvider();
  const n = await p2.importAll(exported);
  assert.equal(n, 7);
  const all2 = await p2.list();
  assert.ok(all2.some((r) => r.id === rec.id), '导入后应可检索到新记录');

  // 幂等：重复导入覆盖
  const n2 = await p2.importAll(exported);
  assert.equal(n2, 7, '重复导入按 id 覆盖，不重复');
  assert.equal((await p2.list()).length, 7);
});

test('损坏自愈：非法 JSON 备份后从种子重建', async () => {
  const { p, dir } = makeProvider();
  const file = path.join(dir, 'store.json');
  await p.save({ layer: 'L1', type: 'fact', content: 'x', tags: ['t'], source: 'agent' });
  // 写坏文件
  writeFileSync(file, '{ broken json !!!', 'utf8');

  const p2 = new JsonMemoryProvider({ filePath: file, seed: createDefaultPersonaSeed() });
  await p2.init();
  const all = await p2.list();
  assert.ok(all.length >= 6, '损坏后应从种子重建');
  // 备份文件应存在
  const { readdirSync } = await import('node:fs');
  const files = readdirSync(dir);
  assert.ok(files.some((f) => f.startsWith('store.json.bak-')), '应有备份文件');
});

test('L0 关闭时 save L0 被拒绝', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'paa-mem-no-l0-'));
  const p = new JsonMemoryProvider({
    filePath: path.join(dir, 'store.json'),
    seed: [],
    persistL0: false,
  });
  await assert.rejects(
    p.save({ layer: 'L0', type: 'episodic', content: 'raw', tags: [], source: 'agent' }),
    /L0/,
  );
});

test('非法 layer/type 校验', async () => {
  const { p } = makeProvider();
  await assert.rejects(
    p.save({ layer: 'L9' as never, type: 'fact', content: 'x', tags: [], source: 'agent' }),
    /非法层级/,
  );
  await assert.rejects(
    p.save({ layer: 'L1', type: 'hack' as never, content: 'x', tags: [], source: 'agent' }),
    /非法类型/,
  );
});
