// ============================================================
// 产物系统（C1 支柱，G7：产物持久）
// 核心思想：产物 = 磁盘上的真实文件，不是聊天文本。
//   - 落盘在 artifacts/<path>，路径即主键（fs_read 可直接读同一文件）
//   - index.json 记录元数据（title/type/version/history/时间戳）
//   - 更新自动版本化：旧版快照存 <path>.v<N>（保留最近 MAX_HISTORY 版）
//   - 原子写：内容文件 → index.json（临时文件 + rename，防写一半损坏）
// 依赖顺序（C 支柱）：C4 记忆 → C1 产物 → C3 资源 → C2 进化
// ============================================================

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';

/** 产物元数据（index.json 的 value） */
export interface ArtifactMeta {
  title: string;
  /** md | code | json | html | data | 其他（agent 自定义） */
  type: string;
  /** 相对 artifacts 根的路径（主键） */
  path: string;
  /** 当前版本号（从 1 起，update 递增） */
  version: number;
  /** 版本历史（最近 MAX_HISTORY 条，v 为被快照的版本号） */
  history: { v: number; at: number; file: string }[];
  createdAt: number;
  updatedAt: number;
}

/** 产物提供者接口（与 MemoryProvider 同哲学：接口隔离，实现可换） */
export interface ArtifactProvider {
  create(input: { title: string; type: string; path: string; content: string }): Promise<ArtifactMeta>;
  update(relPath: string, content: string): Promise<ArtifactMeta>;
  read(relPath: string): Promise<{ meta: ArtifactMeta; content: string }>;
  list(): Promise<ArtifactMeta[]>;
  versions(relPath: string): Promise<ArtifactMeta['history']>;
}

/** 版本历史保留上限（防 index 膨胀；旧快照文件仍在磁盘上） */
const MAX_HISTORY = 5;

export class FileArtifactProvider implements ArtifactProvider {
  private root: string;
  private indexPath: string;
  private index: Record<string, ArtifactMeta> = {};

  constructor(root: string) {
    // 注：不用 constructor(private root) 参数属性——Node 原生 TS strip-only 模式不支持
    this.root = root;
    this.indexPath = path.join(root, '.index.json');
  }

  /** 路径校验：产物必须落在 root 内（防 ../ 逃逸） */
  private resolve(rel: string): string {
    const abs = path.resolve(this.root, rel);
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) {
      throw new Error(`产物路径超出根目录: ${rel}`);
    }
    return abs;
  }

  private async loadIndex(): Promise<void> {
    try {
      const raw = await readFile(this.indexPath, 'utf8');
      this.index = (JSON.parse(raw) as { artifacts: Record<string, ArtifactMeta> }).artifacts ?? {};
    } catch {
      this.index = {}; // 首次运行或损坏时从空重建（自愈）
    }
  }

  private async saveIndex(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const tmp = this.indexPath + '.tmp';
    await writeFile(tmp, JSON.stringify({ version: 1, artifacts: this.index }, null, 2), 'utf8');
    await rename(tmp, this.indexPath); // 原子替换
  }

  async create(input: { title: string; type: string; path: string; content: string }): Promise<ArtifactMeta> {
    await this.loadIndex();
    const rel = input.path.replace(/^\/+/, '');
    if (!rel) throw new Error('path 不能为空');
    if (this.index[rel]) throw new Error(`产物已存在: ${rel}（请用 artifact_update）`);
    const file = this.resolve(rel);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, input.content, 'utf8');
    const now = Date.now();
    const meta: ArtifactMeta = {
      title: input.title,
      type: input.type || 'md',
      path: rel,
      version: 1,
      history: [],
      createdAt: now,
      updatedAt: now,
    };
    this.index[rel] = meta;
    await this.saveIndex();
    return meta;
  }

  async update(relPath: string, content: string): Promise<ArtifactMeta> {
    await this.loadIndex();
    const rel = relPath.replace(/^\/+/, '');
    this.resolve(rel); // 纵深防御：越界路径在任何阶段都先拒绝（不依赖 index 内容）
    const meta = this.index[rel];
    if (!meta) throw new Error(`产物不存在: ${rel}（请用 artifact_create）`);
    const file = this.resolve(rel);
    // 旧版快照（保留最近 MAX_HISTORY 个）
    const old = await readFile(file, 'utf8').catch(() => '');
    if (old) {
      const snap = this.resolve(`${rel}.v${meta.version}`);
      await mkdir(path.dirname(snap), { recursive: true });
      await writeFile(snap, old, 'utf8');
    }
    meta.history.unshift({ v: meta.version, at: Date.now(), file: `${rel}.v${meta.version}` });
    if (meta.history.length > MAX_HISTORY) meta.history.length = MAX_HISTORY;
    meta.version += 1;
    meta.updatedAt = Date.now();
    await writeFile(file, content, 'utf8');
    await this.saveIndex();
    return meta;
  }

  async read(relPath: string): Promise<{ meta: ArtifactMeta; content: string }> {
    await this.loadIndex();
    const rel = relPath.replace(/^\/+/, '');
    this.resolve(rel);
    const meta = this.index[rel];
    if (!meta) throw new Error(`产物不存在: ${rel}`);
    const content = await readFile(this.resolve(rel), 'utf8');
    return { meta, content };
  }

  async list(): Promise<ArtifactMeta[]> {
    await this.loadIndex();
    return Object.values(this.index).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async versions(relPath: string): Promise<ArtifactMeta['history']> {
    await this.loadIndex();
    const rel = relPath.replace(/^\/+/, '');
    this.resolve(rel);
    const meta = this.index[rel];
    if (!meta) throw new Error(`产物不存在: ${rel}`);
    return meta.history;
  }
}
