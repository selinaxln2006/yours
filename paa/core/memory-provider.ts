// ============================================================
// JsonMemoryProvider — P1 v1.1 记忆系统实现（C4 支柱）
// 设计自研；分层思想吸收 Graphiti/Zep 三层架构 + 俪宁人脑直觉（分层+巩固+稀疏激活）
// 关键纪律：
//   · L0 永不注入（只溯源/审计）
//   · save 自动失效同 tag+type 旧记录（Graphiti 边失效轻量版）
//   · 原子写（tmp+rename）防损坏；parse 失败自动备份自愈
//   · 检索 0 LLM 成本（本地关键词+标签），写侧除 consolidate 外 0 LLM
// ============================================================

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  MemoryLayer,
  MemoryProvider,
  MemoryRecord,
  MemoryType,
} from './types.ts';

export interface JsonMemoryProviderOptions {
  /** store.json 绝对路径 */
  filePath: string;
  /** 首次初始化写入的 L3 画像种子（默认 createDefaultPersonaSeed） */
  seed?: MemoryRecord[];
  /** 是否允许存 L0 原文（默认 true；关闭后 L0 记录被拒绝） */
  persistL0?: boolean;
}

/** L3 画像种子：从 WorkBuddy MEMORY.md / USER.md 编译的俪宁长期画像（记忆主权起点） */
export function createDefaultPersonaSeed(): MemoryRecord[] {
  const now = Date.now();
  const mk = (id: string, content: string, tags: string[]): MemoryRecord => ({
    id,
    layer: 'L3',
    type: 'persona',
    content,
    tags,
    source: 'import',
    validAt: now,
    invalidAt: null,
    createdAt: now,
    updatedAt: now,
  });
  return [
    mk(
      'seed_persona_base',
      '俪宁：NUS BBA 大二升大三，ENTP，架构师/产品思维，重视系统设计与产品直觉，注重"有方向感的成长叙事"。',
      ['persona', 'user'],
    ),
    mk(
      'seed_persona_comm',
      '俪宁沟通偏好：简体中文、结构化输出（表格+分级标题+P0-P4 优先级）、批量执行、格式化任务零内容改动、高审美、分步增量预览。深夜型。',
      ['persona', 'preference'],
    ),
    mk(
      'seed_persona_priority',
      '俪宁优先级：P0 学业/DDP > P1 RA 套磁 > P2 工具链(pandas/SQL/Git) > P3 Numerai > P4 个人项目。',
      ['persona', 'priority'],
    ),
    mk(
      'seed_persona_career',
      '俪宁职业方向：量化研究(QR)，WorldQuant Consultant（Top 5%，30+ alpha），腾讯 AI Agent 产品/运营实习，Numerai 参赛（shu-v1-ling），目标 MFE（CMU/Berkeley/Baruch/NUS/NYU/Columbia）。',
      ['persona', 'career'],
    ),
    mk(
      'seed_persona_project',
      '俪宁核心项目：PAA（Personal AI Agent Framework）——终极形态为 Codex 式入口型 agent（自主循环+技能下载+跨场景执行），生活工作台 PWA 只是其第一个宿主；记忆主权是主叙事。',
      ['persona', 'project'],
    ),
    mk(
      'seed_persona_paa',
      'PAA 技术路线：TS 自研大脑层（AgentLoop/ToolPipeline/LLMAdapter/SessionMgr），CLI 宿主 Node 24 直接跑 TS；开发者日志与代码同生；俪宁亲自验收每次闭环（验收标准见 paa/docs）。',
      ['persona', 'paa'],
    ),
  ];
}

export class JsonMemoryProvider implements MemoryProvider {
  private filePath: string;
  private persistL0: boolean;
  private records: MemoryRecord[] = [];
  private seq = 0;
  private initialized = false;

  constructor(opts: JsonMemoryProviderOptions) {
    this.filePath = opts.filePath;
    this.persistL0 = opts.persistL0 ?? true;
    this.initialized = false;
    this.seed = opts.seed;
  }

  private seed?: MemoryRecord[];

  /** 加载存储；文件不存在 → 初始化（写种子）；JSON 损坏 → 备份自愈 */
  async init(): Promise<void> {
    if (this.initialized) return;
    let raw: string | null = null;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch {
      raw = null; // 不存在
    }
    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw) as { seq: number; records: MemoryRecord[] };
        this.seq = parsed.seq ?? 0;
        this.records = Array.isArray(parsed.records) ? parsed.records : [];
      } catch {
        // 损坏自愈：备份后从种子重建
        const bak = `${this.filePath}.bak-${Date.now()}`;
        try {
          await rename(this.filePath, bak);
        } catch {
          /* 备份失败不阻塞 */
        }
        this.records = [];
        this.seq = 0;
      }
    }
    // 空库 → 写种子
    if (this.records.length === 0 && this.seed) {
      for (const r of this.seed) {
        this.records.push({ ...r });
        const n = Number(r.id.replace(/\D/g, ''));
        if (!Number.isNaN(n) && n > this.seq) this.seq = n;
      }
      await this.persist();
    }
    this.initialized = true;
  }

  /** 原子写：tmp + rename（防半写损坏） */
  private async persist(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, JSON.stringify({ seq: this.seq, records: this.records }, null, 2), 'utf8');
    await rename(tmp, this.filePath);
  }

  private nextId(): string {
    this.seq++;
    return `mem_${String(this.seq).padStart(4, '0')}`;
  }

  private active(): MemoryRecord[] {
    return this.records.filter((r) => !r.invalidAt);
  }

  private layerOf(r: MemoryRecord): MemoryLayer {
    return r.layer ?? 'L1';
  }

  /** 分层检索：L3 常驻 → L2 标签匹配 → L1 关键词补足；L0 永不返回 */
  async search(query: string, topN = 5): Promise<MemoryRecord[]> {
    await this.init();
    const words = query
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 1);
    const scored = this.active().map((r) => {
      let score = 0;
      const tagsText = r.tags.join(' ').toLowerCase();
      const content = r.content.toLowerCase();
      for (const w of words) {
        if (tagsText.includes(w)) score += 2; // 标签命中权重高
        if (content.includes(w)) score += 1;
      }
      return { r, score };
    });
    const byLayer: Record<MemoryLayer, typeof scored> = { L0: [], L1: [], L2: [], L3: [] };
    for (const s of scored) {
      const layer = this.layerOf(s.r);
      if (layer === 'L0') continue; // 硬纪律：L0 永不注入
      byLayer[layer].push(s);
    }
    const sortDesc = (arr: typeof scored): typeof scored =>
      arr.sort((a, b) => b.score - a.score);

    const result: MemoryRecord[] = [];
    // L3：常驻，最多 2 条（score 高的优先，score 0 也带）
    result.push(...sortDesc(byLayer.L3).slice(0, 2).map((s) => s.r));
    // L2：标签/关键词命中 top 2
    result.push(...sortDesc(byLayer.L2).filter((s) => s.score > 0).slice(0, 2).map((s) => s.r));
    // L1：命中补足到 topN
    const budget = Math.max(0, topN - result.length);
    result.push(
      ...sortDesc(byLayer.L1).filter((s) => s.score > 0).slice(0, budget).map((s) => s.r),
    );
    return result;
  }

  /** 保存：默认 L1；同 tag+type 内容不同的活跃旧记录自动失效 */
  async save(
    record: Omit<MemoryRecord, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<MemoryRecord> {
    await this.init();
    const layer = record.layer ?? 'L1';
    const LAYERS = ['L0', 'L1', 'L2', 'L3'];
    const TYPES = ['fact', 'preference', 'episodic', 'skill-note', 'persona'];
    if (!LAYERS.includes(layer)) throw new Error(`非法层级: ${layer}`);
    if (!TYPES.includes(record.type)) throw new Error(`非法类型: ${record.type}`);
    if (layer === 'L0' && !this.persistL0) {
      throw new Error('L0 原文存储已关闭（persistL0=false）');
    }
    const now = Date.now();
    // 自动失效（L0/L3 除外：L0 是原文快照不失效，L3 画像由 consolidate 管）
    if (layer !== 'L0' && layer !== 'L3') {
      for (const r of this.active()) {
        if (
          this.layerOf(r) === layer &&
          r.type === record.type &&
          r.content !== record.content &&
          r.tags.some((t) => record.tags.includes(t))
        ) {
          r.invalidAt = now;
          r.updatedAt = now;
        }
      }
    }
    const rec: MemoryRecord = {
      id: this.nextId(),
      layer,
      type: record.type,
      content: record.content,
      tags: record.tags ?? [],
      source: record.source,
      sourceRef: record.sourceRef,
      validAt: record.validAt ?? now,
      invalidAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.records.push(rec);
    await this.persist();
    return rec;
  }

  /** 按类型/层级列出（含已失效；limit 取最新 N 条） */
  async list(opts?: {
    type?: MemoryType;
    layer?: MemoryLayer;
    limit?: number;
  }): Promise<MemoryRecord[]> {
    await this.init();
    let out = this.records;
    if (opts?.type) out = out.filter((r) => r.type === opts.type);
    if (opts?.layer) out = out.filter((r) => this.layerOf(r) === opts.layer);
    if (opts?.limit) out = out.slice(-opts.limit);
    return out;
  }

  /** 遗忘：软删（invalidAt=now），永远确认的工具 */
  async forget(id: string): Promise<boolean> {
    await this.init();
    const rec = this.records.find((r) => r.id === id);
    if (!rec) return false;
    rec.invalidAt = Date.now();
    rec.updatedAt = Date.now();
    await this.persist();
    return true;
  }

  /** 聚合精炼：sourceIds 的 L1 失效 + 写入一条 L2/L3（agent 生成 summary，provider 记账） */
  async consolidate(
    summary: string,
    opts: { layer: 'L2' | 'L3'; type?: MemoryType; tags?: string[]; sourceIds?: string[] },
  ): Promise<MemoryRecord> {
    await this.init();
    const now = Date.now();
    for (const sid of opts.sourceIds ?? []) {
      const r = this.records.find((x) => x.id === sid);
      if (r && !r.invalidAt) {
        r.invalidAt = now;
        r.updatedAt = now;
      }
    }
    const rec: MemoryRecord = {
      id: this.nextId(),
      layer: opts.layer,
      type: opts.type ?? 'episodic',
      content: summary,
      tags: opts.tags ?? [],
      source: 'agent',
      validAt: now,
      invalidAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.records.push(rec);
    await this.persist();
    return rec;
  }

  /** 全量导出（记忆主权） */
  async exportAll(): Promise<MemoryRecord[]> {
    await this.init();
    return this.records.map((r) => ({ ...r }));
  }

  /** 全量导入（幂等：按 id 覆盖） */
  async importAll(records: MemoryRecord[]): Promise<number> {
    await this.init();
    let imported = 0;
    for (const r of records) {
      const idx = this.records.findIndex((x) => x.id === r.id);
      if (idx >= 0) this.records[idx] = { ...r };
      else this.records.push({ ...r });
      imported++;
    }
    for (const r of this.records) {
      const n = Number(r.id.replace(/\D/g, ''));
      if (!Number.isNaN(n) && n > this.seq) this.seq = n;
    }
    await this.persist();
    return imported;
  }
}
