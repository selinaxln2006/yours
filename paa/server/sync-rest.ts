// ============================================================
// S2 — Supabase REST 传输层（SyncTransport 的生产实现）
// 直连 PostgREST（零依赖 fetch）：
//   · 表 life_sync（user_id, key, rev, data jsonb, updated_at）
//   · 表 session_events（user_id, sid, seq, payload jsonb, created_at）
// 鉴权：apikey（publishableKey）+ Bearer 用户 access_token → RLS 按 auth.uid() 隔离
// ============================================================

import type { LifeSyncRow, SessionEventRow, SyncTransport } from '../core/sync.ts';

export class SupabaseSyncTransport implements SyncTransport {
  private projectUrl: string;
  private publishableKey: string;
  private accessToken: string;

  constructor(opts: { projectUrl: string; publishableKey: string; accessToken: string }) {
    this.projectUrl = opts.projectUrl;
    this.publishableKey = opts.publishableKey;
    this.accessToken = opts.accessToken;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      apikey: this.publishableKey,
      Authorization: `Bearer ${this.accessToken}`,
      'Content-Type': 'application/json',
      ...extra,
    };
  }

  private async req(url: string, init?: RequestInit): Promise<unknown> {
    const res = await fetch(url, init);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Supabase REST ${res.status}: ${body.slice(0, 200)}`);
    }
    if (res.status === 204) return null;
    return res.json().catch(() => null);
  }

  async fetchLife(userId: string): Promise<LifeSyncRow[]> {
    const url =
      `${this.projectUrl}/rest/v1/life_sync?user_id=eq.${encodeURIComponent(userId)}` +
      `&select=key,rev,data,updated_at&order=key.asc`;
    const data = (await this.req(url, { headers: this.headers() })) as Array<{
      key: string;
      rev: number;
      data: unknown;
      updated_at: number;
    }> | null;
    return (data ?? []).map((r) => ({ key: r.key, rev: r.rev, data: r.data, updatedAt: r.updated_at }));
  }

  async upsertLife(userId: string, rows: LifeSyncRow[]): Promise<void> {
    if (rows.length === 0) return;
    const body = rows.map((r) => ({
      user_id: userId,
      key: r.key,
      rev: r.rev,
      data: r.data,
      updated_at: r.updatedAt,
    }));
    await this.req(`${this.projectUrl}/rest/v1/life_sync`, {
      method: 'POST',
      headers: this.headers({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify(body),
    });
  }

  async fetchSessionEvents(userId: string, sid: string, afterSeq: number): Promise<SessionEventRow[]> {
    const url =
      `${this.projectUrl}/rest/v1/session_events` +
      `?user_id=eq.${encodeURIComponent(userId)}&sid=eq.${encodeURIComponent(sid)}` +
      `&seq=gt.${afterSeq}&select=seq,payload,created_at&order=seq.asc`;
    const data = (await this.req(url, { headers: this.headers() })) as Array<{
      seq: number;
      payload: SessionEventRow['payload'];
      created_at: number;
    }> | null;
    return (data ?? []).map((r) => ({ sid, seq: r.seq, payload: r.payload, createdAt: r.created_at }));
  }

  async appendSessionEvents(userId: string, sid: string, rows: SessionEventRow[]): Promise<void> {
    if (rows.length === 0) return;
    const body = rows.map((r) => ({
      user_id: userId,
      sid: r.sid,
      seq: r.seq,
      payload: r.payload,
      created_at: r.createdAt,
    }));
    await this.req(`${this.projectUrl}/rest/v1/session_events`, {
      method: 'POST',
      headers: this.headers({ Prefer: 'resolution=ignore-duplicates,return=minimal' }),
      body: JSON.stringify(body),
    });
  }
}
