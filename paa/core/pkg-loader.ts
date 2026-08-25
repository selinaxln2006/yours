// ============================================================
// PkgLoader — ToolPkg 动态加载器（G5 / C3 资源支柱）
// ToolPkg = 目录包：manifest.json（声明式元数据）+ impl.mjs（ESM 实现）
// 体验对齐 Codex Skills：包放进 pkgs/ 目录 → 加载器扫描注册 → agent 立即能用
// 参考：Operit ToolPkg JSON/JS 双格式思想（不 import）
// ============================================================

import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ParamSpec, RiskLevel, ToolDefinition } from './types.ts';
import type { ToolPipeline } from './tool-pipeline.ts';
import type { Permission } from './permission.ts';

/** ToolPkg manifest（声明式元数据，与实现分离） */
export interface PkgManifest {
  name: string;
  version: string;
  desc: string;
  /** 作者（可选，仅元数据） */
  author?: string;
  /** 工具声明：name（短名）/ desc / params / risk（1-4） */
  tools: Array<{
    name: string;
    desc: string;
    params: Record<string, ParamSpec>;
    risk: RiskLevel;
  }>;
  /** 权限声明：forbid = 本包内默认禁用的工具短名（加载时灌入 Permission，任何级别不可放行） */
  permissions?: { forbid?: string[] };
}

/** 已加载包的状态 */
export interface LoadedPkg {
  manifest: PkgManifest;
  dir: string;
  toolNames: string[]; // 全名（pkg_tool）
  loadedAt: number;
}

/** impl.mjs 的 env（加载器注入，包作者不需要感知宿主细节） */
export interface PkgEnv {
  root: string; // 沙箱根（fs 工具的 root）
  pkgDir: string; // 包目录（可读包内资源）
  audit: (line: string) => void;
}

/** impl.mjs 必须默认导出工厂；返回短名 → handler 的映射 */
export type PkgHandler = (args: Record<string, unknown>, ctx: Parameters<ToolDefinition['handler']>[1]) => Promise<unknown>;
export interface PkgImpl {
  createPkgTools: (env: PkgEnv) => Record<string, PkgHandler>;
}

const PKG_NAME_RE = /^[a-z][a-z0-9_]*$/; // 小写字母开头，仅小写/数字/下划线（保证全名无歧义）
const TOOL_NAME_RE = /^[a-z][a-z0-9_]*$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;

export class PkgLoader {
  private pkgsRoot: string;
  private pipeline: ToolPipeline;
  private permission: Permission;
  private env: PkgEnv;
  private loaded = new Map<string, LoadedPkg>();
  private loadErrors = new Map<string, string>(); // pkgName → 加载失败原因

  constructor(opts: { pkgsRoot: string; pipeline: ToolPipeline; permission: Permission; env: PkgEnv }) {
    this.pkgsRoot = opts.pkgsRoot;
    this.pipeline = opts.pipeline;
    this.permission = opts.permission;
    this.env = opts.env;
  }

  get root(): string {
    return this.pkgsRoot;
  }

  /** 已加载包列表（按名字排序） */
  listLoaded(): LoadedPkg[] {
    return [...this.loaded.values()].sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
  }

  /** 最近一次加载失败的原因（调试用） */
  getErrors(): Record<string, string> {
    return Object.fromEntries(this.loadErrors);
  }

  isLoaded(name: string): boolean {
    return this.loaded.has(name);
  }

  /** 扫描 pkgs 根目录，返回所有含合法 manifest 的目录名（未加载） */
  async discover(): Promise<string[]> {
    let entries: string[] = [];
    try {
      entries = await readdir(this.pkgsRoot);
    } catch {
      return []; // 目录不存在 = 无包
    }
    const dirs: string[] = [];
    for (const e of entries) {
      try {
        const s = await stat(path.join(this.pkgsRoot, e));
        if (s.isDirectory()) dirs.push(e);
      } catch {
        // 跳过无法 stat 的条目
      }
    }
    return dirs;
  }

  /** 读取并校验一个目录下的 manifest.json；失败抛带原因的 Error */
  async readManifest(dirName: string): Promise<PkgManifest> {
    const manifestPath = path.join(this.pkgsRoot, dirName, 'manifest.json');
    let raw: string;
    try {
      raw = await readFile(manifestPath, 'utf8');
    } catch {
      throw new Error(`manifest.json 缺失或不可读: ${manifestPath}`);
    }
    let m: unknown;
    try {
      m = JSON.parse(raw);
    } catch {
      throw new Error(`manifest.json 不是合法 JSON: ${manifestPath}`);
    }
    this.validateManifest(m, dirName);
    return m as PkgManifest;
  }

  /** manifest 结构校验（失败即抛；字段级严格，防注入半吊子包） */
  private validateManifest(m: unknown, dirName: string): void {
    const fail = (why: string): never => {
      throw new Error(`包 ${dirName} manifest 校验失败: ${why}`);
    };
    if (typeof m !== 'object' || m === null) fail('不是对象');
    const mm = m as Record<string, unknown>;
    if (typeof mm.name !== 'string' || !PKG_NAME_RE.test(mm.name)) fail(`name 非法（需 ^[a-z][a-z0-9_]*$）: ${String(mm.name)}`);
    if (mm.name !== dirName) fail(`目录名 ${dirName} 与 manifest.name ${mm.name} 不一致`);
    if (typeof mm.version !== 'string' || !VERSION_RE.test(mm.version)) fail(`version 非法（需 x.y.z）: ${String(mm.version)}`);
    if (typeof mm.desc !== 'string' || !mm.desc.trim()) fail('desc 缺失');
    if (!Array.isArray(mm.tools) || mm.tools.length === 0) fail('tools 必须是非空数组');
    const seen = new Set<string>();
    for (const t of mm.tools) {
      if (typeof t !== 'object' || t === null) fail('tools 项不是对象');
      const tt = t as Record<string, unknown>;
      if (typeof tt.name !== 'string' || !TOOL_NAME_RE.test(tt.name)) fail(`工具名非法（需 ^[a-z][a-z0-9_]*$）: ${String(tt.name)}`);
      if (seen.has(tt.name)) fail(`工具名重复: ${String(tt.name)}`);
      seen.add(tt.name);
      if (typeof tt.desc !== 'string' || !tt.desc.trim()) fail(`工具 ${String(tt.name)} desc 缺失`);
      const risk = Number(tt.risk);
      if (![1, 2, 3, 4].includes(risk)) fail(`工具 ${String(tt.name)} risk 非法（需 1-4）: ${String(tt.risk)}`);
      if (typeof tt.params !== 'object' || tt.params === null) fail(`工具 ${String(tt.name)} params 缺失`);
    }
    if (mm.permissions !== undefined) {
      const perms = mm.permissions as Record<string, unknown>;
      if (typeof perms !== 'object' || perms === null) fail('permissions 不是对象');
      const forbid = perms.forbid;
      if (forbid !== undefined) {
        if (!Array.isArray(forbid) || forbid.some((f) => typeof f !== 'string')) fail('permissions.forbid 必须是字符串数组');
        for (const f of forbid as string[]) {
          if (!seen.has(f)) fail(`permissions.forbid 引用了不存在的工具: ${f}`);
        }
      }
    }
  }

  /** 加载单个包：校验 → import impl → 逐工具注册（全名 = pkg_tool）→ forbid 声明灌入权限 */
  async load(name: string): Promise<LoadedPkg> {
    if (this.loaded.has(name)) throw new Error(`包已加载: ${name}`);
    const dir = path.join(this.pkgsRoot, name);
    const manifest = await this.readManifest(name);

    // impl.mjs 必须存在（ESM 实现）
    const implPath = path.join(dir, 'impl.mjs');
    let impl: PkgImpl;
    try {
      impl = (await import(pathToFileURL(implPath).href)) as PkgImpl;
    } catch (e) {
      throw new Error(`impl.mjs 加载失败: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (typeof impl.createPkgTools !== 'function') {
      throw new Error(`impl.mjs 必须默认导出 createPkgTools(env) 工厂函数`);
    }

    // 调用工厂拿到 handler map，逐工具注册（冲突/缺实现则整体失败回滚）
    let handlers: Record<string, PkgHandler>;
    try {
      handlers = impl.createPkgTools({ root: this.env.root, pkgDir: dir, audit: this.env.audit });
    } catch (e) {
      throw new Error(`createPkgTools 执行失败: ${e instanceof Error ? e.message : String(e)}`);
    }

    const registered: string[] = [];
    const forbidden: string[] = [];
    try {
      for (const t of manifest.tools) {
        const full = `${manifest.name}_${t.name}`;
        const handler = handlers[t.name];
        if (typeof handler !== 'function') throw new Error(`impl 未实现工具 ${t.name}（缺 createPkgTools 返回的 handler）`);
        if (this.pipeline.get(full)) throw new Error(`工具全名冲突: ${full} 已存在`);
        const def: ToolDefinition = {
          name: full,
          desc: `${t.desc}（来自 pkg ${manifest.name}@${manifest.version}）`,
          params: t.params,
          risk: t.risk,
          handler,
        };
        this.pipeline.register(def);
        registered.push(full);
      }
      // forbid 声明：仅限本包工具短名（校验已在 readManifest 做），灌入 Permission（硬拒绝）
      for (const f of manifest.permissions?.forbid ?? []) {
        const full = `${manifest.name}_${f}`;
        this.permission.forbid(full);
        forbidden.push(full);
      }
    } catch (e) {
      // 回滚已注册的工具，保持加载失败后状态干净
      for (const full of registered) this.pipeline.unregister(full);
      for (const full of forbidden) this.permission.unforbid(full);
      throw e;
    }

    const lp: LoadedPkg = { manifest, dir, toolNames: registered, loadedAt: Date.now() };
    this.loaded.set(name, lp);
    this.loadErrors.delete(name);
    return lp;
  }

  /** 卸载包：移除工具 + 解除 forbid + 从已加载表删除 */
  unload(name: string): boolean {
    const lp = this.loaded.get(name);
    if (!lp) return false;
    for (const full of lp.toolNames) this.pipeline.unregister(full);
    for (const f of lp.manifest.permissions?.forbid ?? []) this.permission.unforbid(`${name}_${f}`);
    this.loaded.delete(name);
    return true;
  }

  /** 加载目录下所有合法包（单个失败不阻塞其余，记入 loadErrors） */
  async loadAll(): Promise<LoadedPkg[]> {
    const dirs = await this.discover();
    const out: LoadedPkg[] = [];
    for (const d of dirs) {
      try {
        out.push(await this.load(d));
      } catch (e) {
        this.loadErrors.set(d, e instanceof Error ? e.message : String(e));
      }
    }
    return out;
  }
}
