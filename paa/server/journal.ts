// ============================================================
// 晚间回顾的回答：每天一条（心情 + 一句话），data/journal.json
// 用在周复盘（上周哪几天累）和每轮注入的现状里
// ============================================================

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';

export type Mood = 'good' | 'ok' | 'bad';
export interface JournalEntry { date: string; mood: Mood; note: string; at: number }

export const MOOD_ZH: Record<Mood, string> = { good: '顺', ok: '一般', bad: '累' };
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function normalizeEntry(raw: unknown, date: string, now: number): JournalEntry | null {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const mood = (['good', 'ok', 'bad'] as const).find((m) => m === r.mood);
  if (!mood || !DATE.test(date)) return null;
  return { date, mood, note: typeof r.note === 'string' ? r.note.trim().slice(0, 300) : '', at: now };
}

/** 同一天再答一次 = 覆盖；只留最近 400 天 */
export function upsertEntry(list: JournalEntry[], e: JournalEntry): JournalEntry[] {
  return [...list.filter((x) => x.date !== e.date), e].sort((a, b) => a.date.localeCompare(b.date)).slice(-400);
}

export class JournalStore {
  entries: JournalEntry[] = [];
  private file: string;
  private chain: Promise<void> = Promise.resolve();
  constructor(dataDir: string) { this.file = path.join(dataDir, 'journal.json'); }

  async init(): Promise<void> {
    try {
      const j = JSON.parse(await readFile(this.file, 'utf8')) as JournalEntry[];
      if (Array.isArray(j)) this.entries = j.filter((e) => e && DATE.test(e.date) && MOOD_ZH[e.mood]);
    } catch { /* 还没有 */ }
  }

  async add(e: JournalEntry): Promise<void> {
    this.entries = upsertEntry(this.entries, e);
    const data = JSON.stringify(this.entries) + '\n';
    this.chain = this.chain.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, data, 'utf8');
      await rename(tmp, this.file);
    });
    await this.chain;
  }

  range(from: string, to: string): JournalEntry[] {
    return this.entries.filter((e) => e.date >= from && e.date <= to);
  }
}
