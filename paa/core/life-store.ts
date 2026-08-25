// ============================================================
// LifeStore — 生活工作台数据 provider（console-v1 路线 2）
// 数据主权在 Node 侧：18 键分文件 JSON，localStorage 只作迁移源
// 强约束落实：
//   · 原子写：tmp + rename（同卷原子，断电不留半文件）
//   · 损坏自愈：解析失败 → 隔离 .corrupt-<ts> → 重建默认 → heal 事件
//   · schema 校验：写入前结构校验，非法即拒绝（tx 整体回滚，不落盘）
//   · tx 事务：多键跨模块写入一次提交，diff 变更键逐键发 change 事件
// 对齐 memory-provider 的 provider 标准（init/get/save + 事件）
// ============================================================

import { EventEmitter } from 'node:events';
import { readFile, writeFile, rename, readdir, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** 18 个顶层键（与 index.html Store schema 完全一致，VERSION 2） */
export const LIFE_KEYS = [
  'profile', 'transactions', 'investments', 'weights', 'meals', 'water',
  'exerciseLog', 'exercisePlan', 'sleep', 'beauty', 'stretching', 'meditation',
  'schedule', 'todos', 'goals', 'aiConfig', 'chatHistory', 'settings', 'cloudSync',
] as const;

export type LifeKey = (typeof LIFE_KEYS)[number];

export type LifeData = Record<LifeKey, unknown>;

/** change 事件负载 */
export interface LifeChangeEvent {
  key: LifeKey;
  source: string; // 'agent' | 'ui' | 'import' | 'heal'
  ts: number;
}

/** 数组型键（校验用） */
const ARRAY_KEYS = new Set<string>([
  'transactions', 'investments', 'weights', 'meals', 'water', 'exerciseLog',
  'exercisePlan', 'sleep', 'beauty', 'stretching', 'meditation', 'schedule',
  'todos', 'goals', 'chatHistory',
]);

/** 对象型键 */
const OBJECT_KEYS = new Set<string>(['profile', 'aiConfig', 'settings', 'cloudSync']);

/** 默认值（对齐 index.html validate() 语义；profile 保默认体征，数组全空） */
export function defaultLifeData(): LifeData {
  return {
    profile: {
      name: '', height: 165, age: 20, targetWeight: 55, targetBodyFat: 24,
      activityLevel: 1.4, dailyCalorieTarget: 1600, dailyBudget: 45, targetWater: 2000,
    },
    transactions: [], investments: [], weights: [], meals: [], water: [],
    exerciseLog: [], exercisePlan: [], sleep: [], beauty: [], stretching: [],
    meditation: [], schedule: [], todos: [], goals: [],
    aiConfig: {}, chatHistory: [],
    settings: { theme: 'light' },
    cloudSync: { url: '', key: '', enabled: false },
  };
}

/** 单键结构校验：非法抛 Error（带原因），合法返回归一化值 */
export function validateLifeValue(key: string, value: unknown): unknown {
  if (ARRAY_KEYS.has(key)) {
    if (!Array.isArray(value)) throw new Error(`键 ${key} 必须是数组，收到 ${typeof value}`);
    // 数组项必须是对象（id 在工具层生成，这里只做结构门槛）
    for (const [i, item] of value.entries()) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        throw new Error(`键 ${key}[${i}] 必须是对象`);
      }
    }
    return value;
  }
  if (OBJECT_KEYS.has(key)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`键 ${key} 必须是对象`);
    }
    return value;
  }
  throw new Error(`未知生活数据键: ${key}`);
}

/** 工具方法：短 uid（对齐 index.html U.uid() 语义） */
export function uid(): string {
  return randomUUID().replace(/-/g, '').slice(0, 8);
}

/** 工具方法：本地时区今天 YYYY-MM-DD（对齐 U.today()） */
export function today(): string {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/** 工具方法：N 天后的日期（对齐 M.goals._addDays） */
export function addDays(base: string, n: number): string {
  const d = new Date(base + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

export class LifeStore extends EventEmitter {
  private dir: string;
  private cache = new Map<string, unknown>();
  private initialized = false;

  constructor(dir: string) {
    super();
    this.dir = dir;
  }

  /** 启动：建目录 + 逐键加载（缺失补默认 / 损坏自愈） */
  async init(): Promise<void> {
    if (this.initialized) return;
    await mkdir(this.dir, { recursive: true });
    const existing = new Set(await readdir(this.dir));
    for (const key of LIFE_KEYS) {
      if (!existing.has(`${key}.json`)) {
        // 首次：写默认值（原子写）
        this.cache.set(key, (defaultLifeData() as Record<string, unknown>)[key]);
        await this.persist(key);
        continue;
      }
      this.cache.set(key, await this.loadKey(key));
    }
    this.initialized = true;
  }

  /** 读单键（含自愈）；损坏 → 隔离 + 默认值 + heal 事件 */
  private async loadKey(key: LifeKey): Promise<unknown> {
    const file = this.fileOf(key);
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch {
      return (defaultLifeData() as Record<string, unknown>)[key];
    }
    try {
      const parsed = JSON.parse(raw);
      // 落盘前的历史数据做一次宽松校验：结构错也走自愈
      return validateLifeValue(key, parsed);
    } catch {
      // 损坏自愈：隔离原文件（不删，保留取证），重建默认
      const quarantine = path.join(this.dir, `${key}.corrupt-${Date.now()}.json`);
      try {
        await rename(file, quarantine);
      } catch {
        // rename 失败（如被占用）：覆盖写也走原子路径，原文件将被替换
      }
      const def = (defaultLifeData() as Record<string, unknown>)[key];
      this.cache.set(key, def);
      await this.persist(key);
      this.emit('heal', { key, quarantine });
      return def;
    }
  }

  private fileOf(key: string): string {
    return path.join(this.dir, `${key}.json`);
  }

  /** 原子写：tmp → rename */
  private async persist(key: string): Promise<void> {
    const file = this.fileOf(key);
    const tmp = file + '.tmp';
    const value = this.cache.get(key);
    await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
    await rename(tmp, file);
  }

  /** 读单键（内存缓存，init 后零 IO） */
  get(key: LifeKey): unknown {
    this.assertInit();
    const v = this.cache.get(key);
    if (v === undefined) throw new Error(`未知生活数据键: ${key}`);
    return v;
  }

  /** 读全部（浅拷贝顶层） */
  getAll(): LifeData {
    this.assertInit();
    const out = {} as LifeData;
    for (const k of LIFE_KEYS) (out as Record<string, unknown>)[k] = this.cache.get(k);
    return out;
  }

  /**
   * 事务写入：fn 收到全量数据的深拷贝，随意改多键；
   * 结束后 diff 出变更键 → 逐键校验 → 逐键原子落盘 → 逐键发 change 事件。
   * 任一键校验失败：整体抛错，不落盘不发包（事务性）。
   */
  async tx(fn: (data: LifeData) => void, meta: { source: string }): Promise<{ changed: LifeKey[] }> {
    this.assertInit();
    const before = this.getAll();
    const working = deepClone(before);
    fn(working);

    const changed: LifeKey[] = [];
    for (const k of LIFE_KEYS) {
      if (JSON.stringify((working as Record<string, unknown>)[k]) !== JSON.stringify((before as Record<string, unknown>)[k])) {
        changed.push(k);
      }
    }
    if (changed.length === 0) return { changed };

    // 先全量校验（事务性：任何非法即整体失败）
    for (const k of changed) {
      validateLifeValue(k, (working as Record<string, unknown>)[k]);
    }
    // 再逐键落盘 + 发事件
    for (const k of changed) {
      this.cache.set(k, (working as Record<string, unknown>)[k]);
      await this.persist(k);
      const ev: LifeChangeEvent = { key: k, source: meta.source, ts: Date.now() };
      this.emit('change', ev);
    }
    return { changed };
  }

  /** 整包导入（localStorage 迁移）。mode: replace=替换 / merge=数组合并+对象覆盖 */
  async importBlob(data: Record<string, unknown>, mode: 'replace' | 'merge'): Promise<{ changed: LifeKey[] }> {
    const defaults = defaultLifeData();
    const incoming: Record<string, unknown> = {};
    for (const k of LIFE_KEYS) {
      const v = (data as Record<string, unknown>)[k];
      incoming[k] = v === undefined ? (defaults as Record<string, unknown>)[k] : v;
    }
    if (mode === 'replace') {
      return this.tx((d) => {
        for (const k of LIFE_KEYS) (d as Record<string, unknown>)[k] = incoming[k];
      }, { source: 'import' });
    }
    return this.tx((d) => {
      const dst = d as Record<string, unknown>;
      for (const k of LIFE_KEYS) {
        if (Array.isArray(incoming[k]) && Array.isArray(dst[k])) {
          dst[k] = [...(dst[k] as unknown[]), ...(incoming[k] as unknown[])];
        } else if (
          typeof incoming[k] === 'object' && incoming[k] !== null && !Array.isArray(incoming[k]) &&
          typeof dst[k] === 'object' && dst[k] !== null && !Array.isArray(dst[k])
        ) {
          // 对象键合并语义对齐 index.html Store.import：Object.assign 浅合并
          dst[k] = { ...(dst[k] as Record<string, unknown>), ...(incoming[k] as Record<string, unknown>) };
        } else {
          dst[k] = incoming[k];
        }
      }
    }, { source: 'import' });
  }

  private assertInit(): void {
    if (!this.initialized) throw new Error('LifeStore 未 init()');
  }
}

function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
