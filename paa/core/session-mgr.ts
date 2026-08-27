// ============================================================
// SessionMgr — 会话事件溯源
// 参考：DSH session 事件溯源思想；存储格式自研（JSONL）
// ============================================================

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { SessionEvent } from './types.ts';

export class SessionMgr {
  private baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  private async ensureDir(dir: string): Promise<void> {
    await mkdir(dir, { recursive: true });
  }

  /** 新建会话，返回 sessionId（时间戳） */
  async newSession(): Promise<string> {
    const id = `${Date.now()}`;
    await this.ensureDir(path.join(this.baseDir, id));
    return id;
  }

  /** 追加事件 */
  async append(sessionId: string, event: SessionEvent): Promise<void> {
    const file = path.join(this.baseDir, sessionId, 'events.jsonl');
    await this.ensureDir(path.join(this.baseDir, sessionId));
    await appendFile(file, JSON.stringify(event) + '\n', 'utf8');
  }

  /** 加载全部事件（回放/审计） */
  async load(sessionId: string): Promise<SessionEvent[]> {
    const file = path.join(this.baseDir, sessionId, 'events.jsonl');
    const raw = await readFile(file, 'utf8');
    return raw
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as SessionEvent);
  }

  /** 列出所有会话 */
  async list(): Promise<string[]> {
    const { readdir } = await import('node:fs/promises');
    await this.ensureDir(this.baseDir);
    const entries = await readdir(this.baseDir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  }

  /** 会话目录绝对路径（planner 任务树、checkpoint 等状态落盘用） */
  sessionDir(sessionId: string): string {
    return path.join(this.baseDir, sessionId);
  }
}
