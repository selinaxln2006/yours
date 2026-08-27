// ============================================================
// S2 — 云同步引擎（18 键增量同步 + 会话事件游标同步）
// 架构：本地为 source of truth，云端为镜像（Supabase Postgres）。
//   · 每键一个 rev（单调递增修订号）：拉取/推送/合并都基于 rev 增量
//   · 冲突策略：键级 LWW——本地未推送修改（dirty）与云端更高 rev 冲突时，
//     用时间戳裁决（updated_at vs 本地修改时刻），不做文档级 diff（过度设计）
//   · 会话事件：append-only JSONL 天然无冲突，游标（seq）续传增量
// 传输层抽象（SyncTransport）：测试用内存 mock，生产用 Supabase REST（server/sync-rest.ts）
// ============================================================

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { LifeKey, LifeStore } from './life-store.ts';
import type { SessionMgr } from './session-mgr.ts';
import type { SessionEvent } from './types.ts';

/** 云端 life 同步行（对应表 life_sync） */
export interface LifeSyncRow {
  key: string;
  rev: number;
  data: unknown;
  updatedAt: number;
}

/** 云端会话事件行（对应表 session_events） */
export interface SessionEventRow {
  sid: string;
  seq: number;
  payload: SessionEvent;
  createdAt: number;
}

/** 传输层抽象：本地引擎不感知 REST 细节，测试用内存实现 */
export interface SyncTransport {
  /** 拉取某用户全部 life 键（云端无该键的记录不返回） */
  fetchLife(userId: string): Promise<LifeSyncRow[]>;
  /** upsert 一组 life 键（按主键 user_id+key 合并） */
  upsertLife(userId: string, rows: LifeSyncRow[]): Promise<void>;
  /** 拉取某会话 seq 之后的事件（升序） */
  fetchSessionEvents(userId: string, sid: string, afterSeq: number): Promise<SessionEventRow[]>;
  /** 追加一组会话事件 */
  appendSessionEvents(userId: string, sid: string, rows: SessionEventRow[]): Promise<void>;
}

/** 同步状态（data/sync/state.json，本地） */
export interface SyncStateFile {
  /** 本地已知的每键 rev（= max(本地推送, 云端拉取)） */
  lifeRevs: Record<string, number>;
  /** 本地修改过但未推送的键 → 本地修改时间戳（LWW 裁决用） */
  dirty: Record<string, number>;
  /** 会话已推送事件数（seq 游标） */
  sessionCursors: Record<string, number>;
  lastSync: number;
  lastError?: string;
}

function defaultState(): SyncStateFile {
  return { lifeRevs: {}, dirty: {}, sessionCursors: {}, lastSync: 0 };
}

/** 同步状态管理器（原子写 data/sync/state.json） */
export class SyncState {
  private file: string;
  private data: SyncStateFile;
  private saveChain: Promise<void> = Promise.resolve();

  constructor(dir: string) {
    this.file = path.join(dir, 'state.json');
    this.data = defaultState();
  }

  async init(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as Partial<SyncStateFile>;
      this.data = {
        lifeRevs: raw.lifeRevs && typeof raw.lifeRevs === 'object' ? raw.lifeRevs : {},
        dirty: raw.dirty && typeof raw.dirty === 'object' ? raw.dirty : {},
        sessionCursors: raw.sessionCursors && typeof raw.sessionCursors === 'object' ? raw.sessionCursors : {},
        lastSync: Number(raw.lastSync) || 0,
        lastError: typeof raw.lastError === 'string' ? raw.lastError : undefined,
      };
    } catch {
      // 不存在/损坏 → 默认（重新全量拉取）
    }
  }

  get snapshot(): SyncStateFile {
    return this.data;
  }

  /** 本地键被修改（lifeStore change 事件，source !== 'sync' 时调用） */
  markDirty(key: string, ts = Date.now()): void {
    this.data.dirty[key] = ts;
  }

  markError(msg: string): void {
    this.data.lastError = msg;
  }

  /** 持久化（串行写队列防交错） */
  save(): Promise<void> {
    const content = JSON.stringify(this.data, null, 2);
    const p = this.saveChain.then(async () => {
      const tmp = this.file + '.tmp';
      await writeFile(tmp, content, 'utf8');
      await import('node:fs/promises').then(({ rename }) => rename(tmp, this.file));
    });
    this.saveChain = p.catch(() => {});
    return p;
  }
}

export interface SyncEngineDeps {
  lifeStore: LifeStore;
  sessionMgr: SessionMgr;
  transport: SyncTransport;
  state: SyncState;
  userId: string;
}

export interface SyncOnceResult {
  pulledLife: string[];
  pushedLife: string[];
  pulledEvents: number;
  pushedEvents: number;
}

/** 云同步引擎：一次 syncOnce = pull（云端→本地）+ push（本地→云端） */
export class SyncEngine {
  private deps: SyncEngineDeps;

  constructor(deps: SyncEngineDeps) {
    this.deps = deps;
  }

  async syncOnce(): Promise<SyncOnceResult> {
    const r = { pulledLife: [] as string[], pushedLife: [] as string[], pulledEvents: 0, pushedEvents: 0 };
    try {
      r.pulledLife = await this.pullLife();
      r.pushedLife = await this.pushLife();
      const ev = await this.syncEvents();
      r.pulledEvents = ev.pulled;
      r.pushedEvents = ev.pushed;
      this.deps.state.snapshot.lastSync = Date.now();
      delete this.deps.state.snapshot.lastError;
    } catch (e) {
      this.deps.state.markError(e instanceof Error ? e.message : String(e));
      throw e;
    } finally {
      await this.deps.state.save();
    }
    return r;
  }

  /** pull：云端 rev > 本地 rev 的键应用进 LifeStore（source='sync' 不触发 dirty）；冲突走 LWW */
  private async pullLife(): Promise<string[]> {
    const { transport, state, userId, lifeStore } = this.deps;
    const cloud = await transport.fetchLife(userId);
    if (cloud.length === 0) return [];
    const revs = state.snapshot.lifeRevs;
    const dirty = state.snapshot.dirty;
    const changes: Record<string, unknown> = {};
    const applied: string[] = [];

    for (const row of cloud) {
      const localRev = revs[row.key] ?? 0;
      if (row.rev <= localRev) continue; // 已同步或本地更新
      const localDirtyAt = dirty[row.key];
      if (localDirtyAt !== undefined) {
        // 冲突：本地改过未推 + 云端 rev 更高 → 时间戳 LWW
        if (row.updatedAt > localDirtyAt) {
          // 云端更新 → 云端胜：应用云端 + 清 dirty
          changes[row.key] = row.data;
          applied.push(row.key);
          revs[row.key] = row.rev;
          delete dirty[row.key];
        } else {
          // 本地更新 → 本地胜：保留 dirty（push 时 rev = max+1 覆盖云端），记住云端 rev
          revs[row.key] = row.rev;
        }
      } else {
        changes[row.key] = row.data;
        applied.push(row.key);
        revs[row.key] = row.rev;
      }
    }
    if (Object.keys(changes).length > 0) {
      await lifeStore.tx((d) => {
        for (const [k, v] of Object.entries(changes)) (d as Record<string, unknown>)[k] = v;
      }, { source: 'sync' });
    }
    return applied;
  }

  /** push：dirty 键本地 rev = max(本地,云端)+1 → upsert 云端 → 清 dirty */
  private async pushLife(): Promise<string[]> {
    const { transport, state, userId, lifeStore } = this.deps;
    const dirty = state.snapshot.dirty;
    const keys = Object.keys(dirty);
    if (keys.length === 0) return [];
    const rows: LifeSyncRow[] = [];
    for (const key of keys) {
      const revs = state.snapshot.lifeRevs;
      const newRev = (revs[key] ?? 0) + 1;
      rows.push({
        key,
        rev: newRev,
        data: lifeStore.get(key as LifeKey),
        updatedAt: dirty[key] ?? Date.now(),
      });
      revs[key] = newRev;
    }
    await transport.upsertLife(userId, rows);
    for (const r of rows) delete dirty[r.key];
    return rows.map((r) => r.key);
  }

  /** 会话事件：pull（云端游标后事件 → 本地追加）+ push（本地游标后事件 → 云端追加） */
  private async syncEvents(): Promise<{ pulled: number; pushed: number }> {
    const { transport, state, userId, sessionMgr } = this.deps;
    let pulled = 0;
    let pushed = 0;
    const cursors = state.snapshot.sessionCursors;
    const sids = await sessionMgr.list();

    for (const sid of sids) {
      // pull：云端 seq > 本地游标 → 追加到本地 events.jsonl
      const cursor = cursors[sid] ?? 0;
      const cloudRows = await transport.fetchSessionEvents(userId, sid, cursor);
      let newCursor = cursor;
      for (const row of cloudRows) {
        await sessionMgr.append(sid, row.payload);
        if (row.seq > newCursor) newCursor = row.seq;
      }
      if (cloudRows.length > 0) cursors[sid] = newCursor;
      pulled += cloudRows.length;

      // push：本地事件行数 > 游标 → 增量上传（append-only 天然无冲突）
      // 新会话可能尚无 events.jsonl（load 抛 ENOENT）→ 视为零事件
      let events: SessionEvent[] = [];
      try {
        events = await sessionMgr.load(sid);
      } catch {
        events = [];
      }
      const localCursor = cursors[sid] ?? 0;
      if (events.length > localCursor) {
        const rows: SessionEventRow[] = events.slice(localCursor).map((payload, i) => ({
          sid,
          seq: localCursor + i + 1,
          payload,
          createdAt: Date.now(),
        }));
        await transport.appendSessionEvents(userId, sid, rows);
        cursors[sid] = events.length;
        pushed += rows.length;
      }
    }
    return { pulled, pushed };
  }
}
