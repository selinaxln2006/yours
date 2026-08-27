// S2 云同步引擎测试（无网络，mock 传输层 + 临时目录）：
// rev 增量拉取/推送 / 键级 LWW 冲突（时间戳裁决，双向）/ 会话事件游标续传 / 幂等
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { LifeStore, LIFE_KEYS } from '../core/life-store.ts';
import { SessionMgr } from '../core/session-mgr.ts';
import { SyncEngine, SyncState, type LifeSyncRow, type SessionEventRow, type SyncTransport } from '../core/sync.ts';
import type { SessionEvent } from '../core/types.ts';

const UID = 'test-user-1';

/** 内存 mock 传输层：云端 = 两张 Map 表 */
class MemoryTransport implements SyncTransport {
  life = new Map<string, LifeSyncRow>(); // `${key}` → row
  events = new Map<string, SessionEventRow[]>(); // `${sid}` → rows（按 seq 升序）

  fetchLife(): Promise<LifeSyncRow[]> {
    return Promise.resolve([...this.life.values()]);
  }
  upsertLife(_uid: string, rows: LifeSyncRow[]): Promise<void> {
    for (const r of rows) this.life.set(r.key, r);
    return Promise.resolve();
  }
  fetchSessionEvents(_uid: string, sid: string, afterSeq: number): Promise<SessionEventRow[]> {
    return Promise.resolve((this.events.get(sid) ?? []).filter((r) => r.seq > afterSeq));
  }
  appendSessionEvents(_uid: string, sid: string, rows: SessionEventRow[]): Promise<void> {
    const list = this.events.get(sid) ?? [];
    for (const r of rows) if (!list.some((x) => x.seq === r.seq)) list.push(r);
    list.sort((a, b) => a.seq - b.seq);
    this.events.set(sid, list);
    return Promise.resolve();
  }
}

interface Harness {
  life: LifeStore;
  sessions: SessionMgr;
  state: SyncState;
  transport: MemoryTransport;
  engine: SyncEngine;
  sid: string;
  dir: string;
}

async function makeHarness(): Promise<Harness> {
  const dir = mkdtempSync(path.join(tmpdir(), 'paa-sync-'));
  const life = new LifeStore(path.join(dir, 'life'));
  await life.init();
  const sessions = new SessionMgr(path.join(dir, 'runs'));
  const sid = await sessions.newSession();
  const state = new SyncState(path.join(dir, 'sync'));
  await state.init();
  const transport = new MemoryTransport();
  const engine = new SyncEngine({ lifeStore: life, sessionMgr: sessions, transport, state, userId: UID });
  return { life, sessions, state, transport, engine, sid, dir };
}

function ev(ts: number, type: SessionEvent['type'] = 'system', payload: unknown = {}): SessionEvent {
  return { ts, type, payload };
}

/** 云端预置 N 条会话事件（模拟另一设备已推送） */
function seedCloudEvents(t: MemoryTransport, sid: string, n: number, startTs = 1000): void {
  const rows: SessionEventRow[] = [];
  for (let i = 1; i <= n; i++) rows.push({ sid, seq: i, payload: ev(startTs + i, 'system', { seed: i }), createdAt: startTs + i });
  t.events.set(sid, rows);
}

test('首次 pull：云端 3 键全量应用到本地 + revs 记录', async () => {
  const h = await makeHarness();
  h.transport.life.set('todos', { key: 'todos', rev: 1, data: [{ id: 'a', text: '买菜' }], updatedAt: 100 });
  h.transport.life.set('schedule', { key: 'schedule', rev: 2, data: [{ id: 'b', title: '上课' }], updatedAt: 200 });
  h.transport.life.set('water', { key: 'water', rev: 1, data: [], updatedAt: 300 });

  const r = await h.engine.syncOnce();

  assert.deepEqual(r.pulledLife.sort(), ['schedule', 'todos', 'water']);
  assert.deepEqual(r.pushedLife, []);
  assert.equal((h.life.get('todos') as unknown[]).length, 1, 'todos 应被应用');
  assert.equal((h.life.get('schedule') as unknown[]).length, 1, 'schedule 应被应用');
  assert.equal(h.state.snapshot.lifeRevs['todos'], 1);
  assert.equal(h.state.snapshot.lifeRevs['schedule'], 2);
  assert.equal(h.state.snapshot.lastSync > 0, true);
});

test('push：本地 markDirty 的键 rev=1 上传 → 云端 upsert → dirty 清空', async () => {
  const h = await makeHarness();
  h.state.markDirty('todos', 500);
  await h.life.tx((d) => { (d as Record<string, unknown>)['todos'] = [{ id: 'x', text: '本地新待办' }]; }, { source: 'ui' });

  const r = await h.engine.syncOnce();

  assert.deepEqual(r.pushedLife, ['todos']);
  assert.deepEqual(r.pulledLife, []);
  const cloud = h.transport.life.get('todos')!;
  assert.equal(cloud.rev, 1, '首次推送 rev 应为 1');
  const firstTodo = (cloud.data as unknown[])[0] as Record<string, unknown> | undefined;
  assert.equal(firstTodo?.id, 'x');
  assert.equal(h.state.snapshot.lifeRevs['todos'], 1);
  assert.equal(h.state.snapshot.dirty['todos'], undefined, 'dirty 应被清空');
});

test('LWW 云端胜：本地 dirty 但云端 updatedAt 更新 → 云端覆盖本地、dirty 清除', async () => {
  const h = await makeHarness();
  // 本地改过（dirty 时刻 500）但从未推送
  h.state.markDirty('schedule', 500);
  await h.life.tx((d) => { (d as Record<string, unknown>)['schedule'] = [{ id: 'l', title: '本地版' }]; }, { source: 'ui' });
  // 云端 rev=3、updatedAt=900（晚于本地修改 500）→ 云端胜
  h.transport.life.set('schedule', { key: 'schedule', rev: 3, data: [{ id: 'c', title: '云端版' }], updatedAt: 900 });

  const r = await h.engine.syncOnce();

  assert.deepEqual(r.pulledLife, ['schedule']);
  assert.deepEqual(r.pushedLife, [], '云端胜时本地不应回推');
  assert.equal((h.life.get('schedule') as Array<{ title: string }>)[0]?.title, '云端版');
  assert.equal(h.state.snapshot.lifeRevs['schedule'], 3);
  assert.equal(h.state.snapshot.dirty['schedule'], undefined, 'dirty 应被清除');
});

test('LWW 本地胜：本地 dirty 且更新 → 保留本地 + push 覆盖云端（rev 递增）', async () => {
  const h = await makeHarness();
  // 本地改过（dirty 时刻 900）
  h.state.markDirty('schedule', 900);
  await h.life.tx((d) => { (d as Record<string, unknown>)['schedule'] = [{ id: 'l', title: '本地新版' }]; }, { source: 'ui' });
  // 云端 rev=3 但 updatedAt=500（早于本地修改）→ 本地胜
  h.transport.life.set('schedule', { key: 'schedule', rev: 3, data: [{ id: 'c', title: '云端旧版' }], updatedAt: 500 });

  const r = await h.engine.syncOnce();

  assert.deepEqual(r.pushedLife, ['schedule']);
  assert.deepEqual(r.pulledLife, [], '本地胜时不应应用云端旧版');
  assert.equal((h.life.get('schedule') as Array<{ title: string }>)[0]?.title, '本地新版', '本地数据不应被覆盖');
  const cloud = h.transport.life.get('schedule')!;
  assert.equal(cloud.rev, 4, '本地胜时应以 max(本地,云端)+1 覆盖：3+1=4');
  assert.equal((cloud.data as Array<{ title: string }>)[0]?.title, '本地新版');
  assert.equal(h.state.snapshot.dirty['schedule'], undefined);
});

test('事件游标：本地 3 事件推送 → 再追加 2 条只推增量 → 云端事件 pull 到本地', async () => {
  const h = await makeHarness();
  // 本地会话先有 3 条事件
  for (let i = 1; i <= 3; i++) await h.sessions.append(h.sid, ev(100 + i, 'system', { local: i }));

  const r1 = await h.engine.syncOnce();
  assert.equal(r1.pushedEvents, 3, '首次应推全部 3 条');
  assert.equal((h.transport.events.get(h.sid) ?? []).length, 3);
  assert.equal(h.state.snapshot.sessionCursors[h.sid], 3);

  // 本地再追加 2 条 → 只推 seq 4-5
  for (let i = 4; i <= 5; i++) await h.sessions.append(h.sid, ev(200 + i, 'system', { local: i }));
  const r2 = await h.engine.syncOnce();
  assert.equal(r2.pushedEvents, 2, '增量应只推 2 条');
  assert.equal(r2.pulledEvents, 0);
  assert.equal((h.transport.events.get(h.sid) ?? []).length, 5);
  assert.equal(h.state.snapshot.sessionCursors[h.sid], 5);

  // 云端有额外事件（另一设备推的 seq 6-7）→ pull 到本地
  h.transport.events.get(h.sid)!.push({ sid: h.sid, seq: 6, payload: ev(300, 'system', { cloud: 6 }), createdAt: 300 });
  h.transport.events.get(h.sid)!.push({ sid: h.sid, seq: 7, payload: ev(301, 'system', { cloud: 7 }), createdAt: 301 });
  const r3 = await h.engine.syncOnce();
  assert.equal(r3.pulledEvents, 2, '云端 seq>5 的事件应被拉取');
  const local = await h.sessions.load(h.sid);
  assert.equal(local.length, 7, '本地事件数应为 7');
  assert.equal((local[6].payload as { cloud: number }).cloud, 7);
  assert.equal(h.state.snapshot.sessionCursors[h.sid], 7);
});

test('幂等：无新变更时二次 syncOnce 零传输', async () => {
  const h = await makeHarness();
  h.state.markDirty('todos', 100);
  await h.life.tx((d) => { (d as Record<string, unknown>)['todos'] = []; }, { source: 'ui' });
  await h.sessions.append(h.sid, ev(1, 'system', {}));

  const r1 = await h.engine.syncOnce();
  assert.equal(r1.pushedLife.length, 1);
  assert.equal(r1.pushedEvents, 1);

  const r2 = await h.engine.syncOnce();
  assert.deepEqual(r2.pushedLife, []);
  assert.deepEqual(r2.pulledLife, []);
  assert.equal(r2.pushedEvents, 0);
  assert.equal(r2.pulledEvents, 0);
});

test('错误路径：传输层抛错 → lastError 记录 + 状态不丢', async () => {
  const h = await makeHarness();
  h.state.markDirty('todos', 100);
  h.transport.fetchLife = async () => { throw new Error('网络中断'); };

  await assert.rejects(() => h.engine.syncOnce(), /网络中断/);
  assert.match(h.state.snapshot.lastError ?? '', /网络中断/);
  // dirty 保留（下次重试还能推）
  assert.ok(h.state.snapshot.dirty['todos'] !== undefined, '失败后 dirty 应保留');
  // 生命周期：LIFE_KEYS 完整性不被破坏
  assert.equal(LIFE_KEYS.includes('todos'), true);
});
