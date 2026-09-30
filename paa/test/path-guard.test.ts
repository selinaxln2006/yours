// 沙箱路径解析：../ 越界、绝对路径越界、符号链接指向外部、悬空符号链接
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { resolveInside } from '../core/path-guard.ts';
import { createCoreTools } from '../tools/core-tools.ts';

const canSymlink = process.platform !== 'win32'; // Windows 建符号链接需要管理员/开发者模式

function setup() {
  const base = mkdtempSync(path.join(tmpdir(), 'paa-guard-'));
  const root = path.join(base, 'root');
  const outside = path.join(base, 'outside');
  mkdirSync(path.join(root, 'sub'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  writeFileSync(path.join(root, 'sub', 'ok.txt'), 'ok');
  return { root, outside };
}

test('沙箱内路径（含尚不存在的新文件）正常解析', () => {
  const { root } = setup();
  assert.equal(resolveInside(root, 'sub/ok.txt'), path.join(root, 'sub', 'ok.txt'));
  assert.equal(resolveInside(root, 'new/deep/file.md'), path.join(root, 'new', 'deep', 'file.md'));
  assert.equal(resolveInside(root, '.'), root);
});

test('../ 与绝对路径越界被拒', () => {
  const { root, outside } = setup();
  assert.throws(() => resolveInside(root, '../outside/secret.txt'), /超出沙箱/);
  assert.throws(() => resolveInside(root, path.join(outside, 'secret.txt')), /超出沙箱/);
});

test('符号链接指向沙箱外被拒（读、写、经链接目录写新文件）', { skip: !canSymlink }, () => {
  const { root, outside } = setup();
  symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
  symlinkSync(outside, path.join(root, 'linkdir'));
  assert.throws(() => resolveInside(root, 'link.txt'), /符号链接/);
  assert.throws(() => resolveInside(root, 'linkdir/secret.txt'), /符号链接/);
  assert.throws(() => resolveInside(root, 'linkdir/new.txt'), /符号链接/);
});

test('悬空符号链接被拒（写入会穿透到外部）', { skip: !canSymlink }, () => {
  const { root, outside } = setup();
  symlinkSync(path.join(outside, 'not-yet.txt'), path.join(root, 'dangling.txt'));
  assert.throws(() => resolveInside(root, 'dangling.txt'), /符号链接/);
});

test('沙箱内部的符号链接允许', { skip: !canSymlink }, () => {
  const { root } = setup();
  symlinkSync(path.join(root, 'sub'), path.join(root, 'alias'));
  assert.equal(resolveInside(root, 'alias/ok.txt'), path.join(root, 'alias', 'ok.txt'));
});

test('fs_read / fs_grep 不经符号链接读到沙箱外', { skip: !canSymlink }, async () => {
  const { root, outside } = setup();
  symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'leak.md'));
  const tools = createCoreTools(root);
  const read = tools.find((t) => t.name === 'fs_read')!;
  const grep = tools.find((t) => t.name === 'fs_grep')!;
  const ctx = { sessionId: 't', cwd: root, ask: async () => true, audit: () => {} };
  await assert.rejects(read.handler({ path: 'leak.md' }, ctx), /符号链接/);
  const res = (await grep.handler({ pattern: 'secret' }, ctx)) as { count: number };
  assert.equal(res.count, 0);
});
