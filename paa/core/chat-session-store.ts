// ============================================================
// ChatSessionStore — 控制台对话会话持久化（ROADMAP T1：多会话）
// 会话（用户角度的一次连续对话）与 SessionMgr 的 run 事件流分离：
//   · SessionMgr.runs/*   — PAA 大脑层的 run 事件溯源（审计/回放）
//   · 这里的 data/sessions/* — 控制台 UI 会话（可新建/切换/重命名/删除）
// 每个会话文件：
//   {
//     id, title,                     // 标题（首条 user 自动生成）
//     messages: ChatMessage[],       // 供 AgentLoop prior 注入的对话历史（含 tool）
//     uiHistory: UiMsg[],            // 供前端切换会话时还原画布的展示数据
//     createdAt, updatedAt
//   }
// 强约束对齐 life-store：原子写（tmp→rename）/ 损坏自愈（隔离 .corrupt-<ts>）
// ============================================================

import { mkdir, readFile, writeFile, rename, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { ChatMessage, SessionEvent } from './types.ts';

/** 前端展示消息（console.html 的 S.msgs 结构序列化，切换会话可还原画布） */
export interface UiMsg {
  kind: 'user' | 'assistant' | 'tool' | 'sys';
  text?: string;
  mode?: string | null;
  ts: number;
  // tool 卡
  toolName?: string;
  risk?: number;
  args?: unknown;
  result?: unknown;
  err?: unknown;
  state?: string;
}

/** 持久化会话记录 */
export interface SessionRecord {
  id: string;
  title: string;
  messages: ChatMessage[];
  uiHistory: UiMsg[];
  createdAt: number;
  updatedAt: number;
}

export interface SessionSummary {
  id: string;
  title: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
}

const DEFAULT_TITLE = '新对话';

/** 标题生成：首条 user 文本截断（≤28 字符） */
export function makeTitle(text: string): string {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t ? (t.length > 28 ? t.slice(0, 28) + '…' : t) : DEFAULT_TITLE;
}

/** 从 AgentLoop 本轮 result.messages（ChatMessage[]）提取前端展示消息，
 *  与 console.html 的 S.msgs 结构对齐，切换会话可完整还原画布。 */
export function messagesToUiHistory(messages: ChatMessage[]): UiMsg[] {
  const out: UiMsg[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ kind: 'user', text: m.content, ts: Date.now() });
    } else if (m.role === 'assistant') {
      out.push({ kind: 'assistant', text: m.content, mode: null, ts: Date.now() });
    } else if (m.role === 'tool') {
      // ChatMessage.tool.content = JSON 字符串（可能含截断的 result）
      let result: unknown = m.content;
      try { result = JSON.parse(m.content); } catch { /* 保留原文 */ }
      const r = (typeof result === 'object' && result !== null ? result : {}) as {
        ok?: boolean;
        error?: unknown;
        data?: unknown;
      };
      out.push({
        kind: 'tool',
        toolName: m.name ?? '',
        args: undefined,
        result: r.error !== undefined ? undefined : r.data,
        err: r.error,
        state: r.error !== undefined ? 'err' : 'ok',
        ts: Date.now(),
      });
    }
  }
  return out;
}

/**
 * 会话持久化 store（原子写 / 损坏自愈 / 启动 loadAll）
 * 每个会话一个 JSON 文件，id 为唯一键
 */
export class ChatSessionStore {
  private dir: string;
  private cache = new Map<string, SessionRecord>();
  private initialized = false;

  constructor(dir: string) {
    this.dir = dir;
  }

  /** 启动：建目录 + 逐会话加载（损坏自愈隔离） */
  async init(): Promise<void> {
    if (this.initialized) return;
    await mkdir(this.dir, { recursive: true });
    let names: string[] = [];
    try {
      names = await readdir(this.dir);
    } catch {
      names = [];
    }
    for (const n of names) {
      if (!n.endsWith('.json') || n.includes('.corrupt-')) continue;
      const id = n.slice(0, -5);
      const rec = await this.load(id);
      if (rec) this.cache.set(id, rec);
    }
    this.initialized = true;
    return;
  }

  private fileOf(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  /** 读单会话（含自愈）；不存在返回 null */
  private async load(id: string): Promise<SessionRecord | null> {
    const file = this.fileOf(id);
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as SessionRecord;
      if (!parsed || typeof parsed.id !== 'string' || !Array.isArray(parsed.messages)) {
        throw new Error('结构非法');
      }
      return {
        id: parsed.id,
        title: typeof parsed.title === 'string' && parsed.title ? parsed.title : DEFAULT_TITLE,
        messages: Array.isArray(parsed.messages) ? parsed.messages : [],
        uiHistory: Array.isArray(parsed.uiHistory) ? parsed.uiHistory : [],
        createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : Date.now(),
        updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
      };
    } catch {
      // 损坏自愈：隔离（不删，保留取证），返回 null
      const quarantine = path.join(this.dir, `${id}.corrupt-${Date.now()}.json`);
      try {
        await rename(file, quarantine);
      } catch {
        /* 隔离失败不阻塞 */
      }
      return null;
    }
  }

  /** 原子写：tmp → rename */
  private async persist(rec: SessionRecord): Promise<void> {
    const file = this.fileOf(rec.id);
    const tmp = file + '.tmp';
    await writeFile(tmp, JSON.stringify(rec, null, 2), 'utf8');
    await rename(tmp, file);
  }

  /** 新建会话，返回记录（默认标题） */
  async create(title?: string): Promise<SessionRecord> {
    await this.init();
    const id = `c-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const rec: SessionRecord = {
      id,
      title: title && String(title).trim() ? String(title).trim().slice(0, 40) : DEFAULT_TITLE,
      messages: [],
      uiHistory: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.cache.set(id, rec);
    await this.persist(rec);
    this.trimCache();
    return rec;
  }

  /**
   * 取会话：有 id 且内存/磁盘有 → 返回该会话；否则新建。
   * 服务器重启后会话仍可从磁盘恢复。
   */
  async getOrCreate(id?: unknown): Promise<SessionRecord> {
    await this.init();
    let sid = typeof id === 'string' && id.trim() ? id.trim() : '';
    if (sid) {
      let rec = this.cache.get(sid);
      if (!rec) {
        const disk = await this.load(sid);
        if (disk) {
          rec = disk;
          this.cache.set(sid, rec);
        }
      }
      if (rec) return rec;
    }
    return this.create();
  }

  /** 读取单个会话（含从盘恢复）；不存在返回 null */
  async get(id: string): Promise<SessionRecord | null> {
    await this.init();
    let rec = this.cache.get(id);
    if (!rec) {
      const disk = await this.load(id);
      if (disk) {
        rec = disk;
        this.cache.set(id, rec);
      }
    }
    return rec ?? null;
  }

  /** 追加对话：追加 messages + uiHistory，更新 updatedAt（首条 user 自动设标题） */
  async append(id: string, messages: ChatMessage[], uiHistory: UiMsg[]): Promise<SessionRecord | null> {
    const rec = await this.get(id);
    if (!rec) return null;
    if ((rec.title === DEFAULT_TITLE || !rec.title) && uiHistory.length) {
      const firstUser = uiHistory.find((m) => m.kind === 'user');
      if (firstUser?.text) rec.title = makeTitle(firstUser.text);
    }
    rec.messages = (rec.messages ?? []).concat(messages);
    rec.uiHistory = (rec.uiHistory ?? []).concat(uiHistory);
    // 每会话最多保留 320 条（防 UI 卡顿，内存/磁盘双收口）
    if (rec.uiHistory.length > 320) rec.uiHistory = rec.uiHistory.slice(-320);
    if (rec.messages.length > 320) rec.messages = rec.messages.slice(-320);
    rec.updatedAt = Date.now();
    await this.persist(rec);
    return rec;
  }

  /** 重命名 */
  async rename(id: string, title: string): Promise<SessionRecord | null> {
    const rec = await this.get(id);
    if (!rec) return null;
    rec.title = title && String(title).trim() ? String(title).trim().slice(0, 40) : DEFAULT_TITLE;
    rec.updatedAt = Date.now();
    await this.persist(rec);
    return rec;
  }

  /** 删除会话（删文件 + 移除内存）；返回是否删除成功 */
  async remove(id: string): Promise<boolean> {
    await this.init();
    if (!this.cache.has(id)) {
      // 可能未加载过，先尝试删文件
      try {
        await import('node:fs/promises').then((m) =>
          m.rm(this.fileOf(id), { force: true }),
        );
      } catch {
        /* 忽略 */
      }
      return true;
    }
    this.cache.delete(id);
    try {
      await import('node:fs/promises').then((m) =>
        m.rm(this.fileOf(id), { force: true }),
      );
    } catch {
      /* 忽略 */
    }
    return true;
  }

  /** 全部会话摘要（按 created 升序；最近在最上由前端排） */
  list(): SessionSummary[] {
    return [...this.cache.values()]
      .map((s) => ({
        id: s.id,
        title: s.title || DEFAULT_TITLE,
        messageCount: s.uiHistory.length,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private trimCache(): void {
    // 内存缓存只保留最近 60 个；磁盘文件保留（历史不丢）
    if (this.cache.size > 60) {
      const sorted = [...this.cache.values()].sort((a, b) => b.updatedAt - a.updatedAt);
      for (const rec of sorted.slice(60)) this.cache.delete(rec.id);
    }
  }
}
