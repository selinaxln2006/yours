// P0 冒烟测试：验证核心链路（权限门/工具管道/会话/黑名单），不依赖 LLM
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Permission } from '../core/permission.ts';
import { ToolPipeline } from '../core/tool-pipeline.ts';
import { SessionMgr } from '../core/session-mgr.ts';
import { createCoreTools } from '../tools/core-tools.ts';
import type { ExecContext } from '../core/types.ts';

async function main() {
  const root = mkdtempSync(path.join(tmpdir(), 'paa-smoke-'));
  const permission = new Permission(2); // L2：读/普通自动放行，写需要确认
  const pipeline = new ToolPipeline(permission);
  for (const t of createCoreTools(root)) pipeline.register(t);

  let asked = 0;
  const ctx: ExecContext = {
    sessionId: 'smoke',
    cwd: root,
    ask: async () => {
      asked++;
      return true; // 模拟用户确认
    },
    audit: () => {},
  };

  // 1. fs.write（risk 3，L2 → 应触发 ask）
  const w = await pipeline.run(
    { id: 't1', name: 'fs_write', arguments: { path: 'a.txt', content: 'hello\nworld\n' } },
    ctx,
  );
  assert.ok(w.ok, `fs.write 失败: ${w.error}`);
  assert.equal(asked, 1, 'L2 下 risk3 应触发一次确认');

  // 2. fs.read（risk 1，自动放行，不触发 ask）
  const r = await pipeline.run(
    { id: 't2', name: 'fs_read', arguments: { path: 'a.txt', limit: 1 } },
    ctx,
  );
  assert.ok(r.ok && (r.data as { lines: string[] }).lines[0] === '1:hello');
  assert.equal(asked, 1, 'risk1 不应触发确认');

  // 3. fs.patch 唯一匹配（risk 3，触发 ask）
  const p = await pipeline.run(
    { id: 't3', name: 'fs_patch', arguments: { path: 'a.txt', old: 'world', new: 'PAA' } },
    ctx,
  );
  assert.ok(p.ok, `fs.patch 失败: ${p.error}`);

  // 4. fs.patch 非唯一 → 拒绝（防误伤）
  const w2 = await pipeline.run(
    { id: 't4', name: 'fs_write', arguments: { path: 'b.txt', content: 'x\nx\n' } },
    ctx,
  );
  assert.ok(w2.ok);
  const dup = await pipeline.run(
    { id: 't5', name: 'fs_patch', arguments: { path: 'b.txt', old: 'x', new: 'y' } },
    ctx,
  );
  assert.equal(dup.ok, false, '非唯一匹配必须拒绝');

  // 5. shell 黑名单命中 → 拒绝
  const shell = await pipeline.run(
    { id: 't6', name: 'shell_run', arguments: { command: 'rm -rf /' } },
    ctx,
  );
  assert.equal(shell.ok, false, '黑名单命令必须拒绝');
  assert.match(shell.error ?? '', /黑名单/);

  // 6. 沙箱越界 → 拒绝
  const escape = await pipeline.run(
    { id: 't7', name: 'fs.read', arguments: { path: '..\\..\\Windows\\win.ini' } },
    ctx,
  );
  assert.equal(escape.ok, false, '越界路径必须拒绝');

  // 7. SessionMgr 事件溯源
  const sess = new SessionMgr(path.join(root, 'runs'));
  const sid = await sess.newSession();
  await sess.append(sid, { ts: 1, type: 'user', payload: { text: 'hi' } });
  await sess.append(sid, { ts: 2, type: 'assistant', payload: { content: 'hello' } });
  const events = await sess.load(sid);
  assert.equal(events.length, 2);
  assert.equal(events[1].type, 'assistant');

  // 8. 用户拒绝 → 工具不执行
  const deniedCtx: ExecContext = { ...ctx, ask: async () => false };
  const denied = await pipeline.run(
    { id: 't8', name: 'fs_write', arguments: { path: 'c.txt', content: 'x' } },
    deniedCtx,
  );
  assert.equal(denied.ok, false);
  assert.match(denied.error ?? '', /拒绝/);

  console.log('✅ P0 冒烟测试 8/8 通过');
}

main().catch((e) => {
  console.error('❌ 冒烟失败:', e);
  process.exit(1);
});
