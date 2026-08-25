// ============================================================
// pkg 管理工具（G5 / C3 资源支柱）
// pkg_list / pkg_install / pkg_uninstall / pkg_reload
// 体验：agent 现场装一个 ToolPkg 目录 → 立即注册 → 当前会话就能用
// ============================================================

import { cp, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ExecContext, ToolDefinition } from '../core/types.ts';
import type { PkgLoader } from '../core/pkg-loader.ts';

const PKG_NAME_RE = /^[a-z][a-z0-9_]*$/;

export function createPkgTools(loader: PkgLoader): ToolDefinition[] {
  return [
    {
      name: 'pkg_list',
      desc: '列出已发现/已加载的工具包（pkgs 目录扫描结果 + 加载状态 + 错误）',
      params: {},
      risk: 1,
      handler: async () => {
        const dirs = await loader.discover();
        const loaded = loader.listLoaded();
        const errors = loader.getErrors();
        const rows = dirs.map((d) => {
          const lp = loaded.find((x) => x.manifest.name === d);
          return {
            name: d,
            loaded: Boolean(lp),
            tools: lp ? lp.toolNames.length : 0,
            version: lp?.manifest.version ?? null,
            error: errors[d] ?? null,
          };
        });
        return { packages: rows, loadedCount: loaded.length, errorCount: Object.keys(errors).length };
      },
    },
    {
      name: 'pkg_install',
      desc: '从本地目录安装 ToolPkg 并立即加载（拷贝到 pkgs/ 后注册，无需重启）。src 必须含 manifest.json + impl.mjs',
      params: {
        src: { type: 'string', desc: '包源码目录（绝对路径）', required: true },
      },
      risk: 3,
      handler: async (args: Record<string, unknown>, ctx: ExecContext): Promise<unknown> => {
        const srcRaw = String(args.src ?? '');
        if (!srcRaw) throw new Error('src 必填');
        const src = path.resolve(ctx.cwd, srcRaw);
        let statResult;
        try {
          statResult = await stat(src);
        } catch {
          throw new Error(`源目录不存在: ${src}`);
        }
        if (!statResult.isDirectory()) throw new Error(`源不是目录: ${src}`);

        // 先读 manifest 拿名字并粗校验（loader.load 会做完整校验，这里提前挡明显错误）
        let manifest: { name?: unknown };
        try {
          manifest = JSON.parse(await readFile(path.join(src, 'manifest.json'), 'utf8')) as { name?: unknown };
        } catch {
          throw new Error(`源目录缺少合法 manifest.json: ${src}`);
        }
        const name = typeof manifest.name === 'string' ? manifest.name : '';
        if (!PKG_NAME_RE.test(name)) throw new Error(`manifest.name 非法（需 ^[a-z][a-z0-9_]*$）: ${String(manifest.name)}`);
        if (loader.isLoaded(name)) throw new Error(`包已加载（${name}），请先 pkg_uninstall 再装`);

        const dest = path.join(loader.root, name);
        try {
          await stat(dest);
          throw new Error(`pkgs 目录已存在同名包: ${dest}`);
        } catch (e) {
          if (e instanceof Error && e.message.includes('pkgs 目录已存在同名包')) throw e;
          // ENOENT = 目标不存在，正常
        }

        // 拷贝（递归，含 impl.mjs 与包内资源）→ 加载；失败回滚删除
        await cp(src, dest, { recursive: true });
        try {
          const lp = await loader.load(name);
          ctx.audit(`[AUTO] pkg_install ${name}@${lp.manifest.version} → ${lp.toolNames.length} 工具已注册`);
          return { installed: name, version: lp.manifest.version, tools: lp.toolNames, dir: lp.dir };
        } catch (e) {
          await rm(dest, { recursive: true, force: true });
          throw e;
        }
      },
    },
    {
      name: 'pkg_uninstall',
      desc: '卸载并删除一个 ToolPkg（从 pipeline 移除 + 解除 forbid + 删除 pkgs 目录）',
      params: {
        name: { type: 'string', desc: '包名（pkg_list 里 name）', required: true },
      },
      risk: 3,
      handler: async (args: Record<string, unknown>, ctx: ExecContext): Promise<unknown> => {
        const name = String(args.name ?? '');
        if (!PKG_NAME_RE.test(name)) throw new Error(`包名非法: ${String(args.name)}`);
        const ok = loader.unload(name);
        if (!ok) {
          // 未加载也允许删除目录（清理残留）
          const dir = path.join(loader.root, name);
          try {
            await rm(dir, { recursive: true, force: true });
            return { removed: name, wasLoaded: false };
          } catch (e) {
            throw new Error(`包不存在且目录删除失败: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        await rm(path.join(loader.root, name), { recursive: true, force: true });
        ctx.audit(`[AUTO] pkg_uninstall ${name}`);
        return { removed: name, wasLoaded: true };
      },
    },
    {
      name: 'pkg_reload',
      desc: '重扫 pkgs 目录并加载新增的合法包（已加载的跳过；加载失败记入 pkg_list 错误）',
      params: {},
      risk: 2,
      handler: async (): Promise<unknown> => {
        const loaded = await loader.loadAll();
        return { loaded: loaded.map((lp) => `${lp.manifest.name}@${lp.manifest.version} (${lp.toolNames.length} 工具)`), errors: loader.getErrors() };
      },
    },
  ];
}
