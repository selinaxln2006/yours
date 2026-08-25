// G7 产物系统测试：真文件落盘 / 版本快照 / 元数据索引 / 路径逃逸防护 / 读自动写确认权限
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { FileArtifactProvider } from '../core/artifact-provider.ts';

function makeProvider(): { p: FileArtifactProvider; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'paa-art-'));
  return { p: new FileArtifactProvider(dir), dir };
}

test('create：产物落盘为真实文件 + index 注册 + version 1', async () => {
  const { p, dir } = makeProvider();
  const meta = await p.create({
    title: '减重作战计划',
    type: 'md',
    path: 'plans/fat-loss-plan.md',
    content: '# 减重计划\n- 目标 15 斤',
  });
  assert.equal(meta.version, 1);
  assert.equal(meta.path, 'plans/fat-loss-plan.md');

  // 磁盘上必须有真文件（G7 核心：产物 = 文件，不是聊天文本）
  const file = path.join(dir, 'plans', 'fat-loss-plan.md');
  assert.ok(existsSync(file), '产物文件应落盘');
  assert.match(readFileSync(file, 'utf8'), /减重计划/);

  // index.json 已生成
  assert.ok(existsSync(path.join(dir, '.index.json')));
});

test('update：版本递增 + 旧版快照文件生成 + history 记录', async () => {
  const { p, dir } = makeProvider();
  await p.create({ title: 't', type: 'md', path: 'a.md', content: 'v1 内容' });
  const meta = await p.update('a.md', 'v2 内容');
  assert.equal(meta.version, 2);
  assert.equal(meta.history.length, 1);
  assert.equal(meta.history[0].v, 1);

  // 快照文件在磁盘上
  assert.ok(existsSync(path.join(dir, 'a.md.v1')), '旧版快照应落盘');
  assert.match(readFileSync(path.join(dir, 'a.md.v1'), 'utf8'), /v1 内容/);
  // 主文件是最新版
  assert.match(readFileSync(path.join(dir, 'a.md'), 'utf8'), /v2 内容/);

  // 第三次更新：版本 3，history 2 条
  await p.update('a.md', 'v3 内容');
  const m3 = await p.read('a.md');
  assert.equal(m3.meta.version, 3);
  assert.equal(m3.meta.history.length, 2);
});

test('read：返回当前内容 + 元数据', async () => {
  const { p } = makeProvider();
  await p.create({ title: '报告', type: 'md', path: 'r.md', content: '正文' });
  const { meta, content } = await p.read('r.md');
  assert.equal(meta.title, '报告');
  assert.equal(meta.type, 'md');
  assert.equal(content, '正文');
});

test('list：按更新时间倒序 + 字段精简', async () => {
  const { p } = makeProvider();
  await p.create({ title: 'a', type: 'md', path: 'a.md', content: '1' });
  await p.create({ title: 'b', type: 'code', path: 'src/b.py', content: '2' });
  const list = await p.list();
  assert.equal(list.length, 2);
  assert.ok(list[0].updatedAt >= list[1].updatedAt, '倒序');
  assert.ok(list.some((x) => x.path === 'src/b.py' && x.type === 'code'));
});

test('路径逃逸防护：../ 越界被拒绝', async () => {
  const { p } = makeProvider();
  await assert.rejects(
    p.create({ title: 'x', type: 'md', path: '../evil.md', content: 'x' }),
    /超出根目录/,
  );
  // 创建合法产物后 update 逃逸也应拒绝
  await p.create({ title: 'x', type: 'md', path: 'ok.md', content: 'x' });
  await assert.rejects(p.update('../evil.md', 'y'), /超出根目录/);
});

test('重复 create 拒绝；versions 返回快照历史', async () => {
  const { p } = makeProvider();
  await p.create({ title: 't', type: 'md', path: 'd.md', content: 'v1' });
  await assert.rejects(p.create({ title: 't2', type: 'md', path: 'd.md', content: 'v1' }), /已存在/);
  await p.update('d.md', 'v2');
  const hist = await p.versions('d.md');
  assert.equal(hist.length, 1);
  assert.equal(hist[0].file, 'd.md.v1');
});

test('不存在的产物 read/update/versions 抛错', async () => {
  const { p } = makeProvider();
  await assert.rejects(p.read('nope.md'), /不存在/);
  await assert.rejects(p.update('nope.md', 'x'), /不存在/);
  await assert.rejects(p.versions('nope.md'), /不存在/);
});

test('index.json 损坏自愈：从空重建（真文件不受影响）', async () => {
  const { p, dir } = makeProvider();
  await p.create({ title: 't', type: 'md', path: 'keep.md', content: '重要内容' });
  // 写坏 index
  const { writeFileSync } = await import('node:fs');
  writeFileSync(path.join(dir, '.index.json'), '{ broken !!!', 'utf8');

  // 新实例重读：自愈为空，但产物文件仍在磁盘上
  const p2 = new FileArtifactProvider(dir);
  const list = await p2.list();
  assert.equal(list.length, 0, 'index 损坏自愈为空');
  assert.ok(existsSync(path.join(dir, 'keep.md')), '磁盘文件不受 index 损坏影响');

  // 重新注册后可以继续用
  await p2.create({ title: 't', type: 'md', path: 'keep.md', content: '重要内容' });
  assert.equal((await p2.list()).length, 1);
});

test('产物目录结构：嵌套目录自动创建', async () => {
  const { p, dir } = makeProvider();
  await p.create({ title: 'model', type: 'code', path: 'quant/src/model.py', content: 'print(1)' });
  assert.ok(existsSync(path.join(dir, 'quant', 'src', 'model.py')));
  const files = readdirSync(dir, { recursive: true });
  assert.ok(files.length >= 3, '应包含 index.json + 嵌套文件');
});
