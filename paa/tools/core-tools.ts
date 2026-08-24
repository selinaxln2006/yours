// ============================================================
// 内置工具集（P0 验证用，覆盖 G1 读 / G2 写 / G3 自诊断）
// 沙箱：所有 fs 路径限制在 root 内；shell 带黑名单
// 对齐此前 G3/G4 闭环验证过的能力（行切片读、唯一匹配 patch）
// ============================================================

import { readFile, writeFile, appendFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { ExecContext, ToolDefinition } from '../core/types.ts';

const SHELL_BLACKLIST = [
  'rm -rf', 'rmdir /s', 'del /s', 'format ', 'shutdown', 'diskpart',
  'reg delete', 'cipher /w', 'remove-item -recurse', '-recurse -force',
];

export function createCoreTools(root: string): ToolDefinition[] {
  const absRoot = path.resolve(root);

  const resolve = (rel: string): string => {
    const abs = path.resolve(absRoot, rel);
    if (abs !== absRoot && !abs.startsWith(absRoot + path.sep)) {
      throw new Error(`路径超出沙箱: ${rel}`);
    }
    return abs;
  };

  return [
    {
      name: 'fs_read',
      desc: '读取文件内容，支持行切片（offset/limit，1 起）',
      params: {
        path: { type: 'string', desc: '相对沙箱根的文件路径' },
        offset: { type: 'number', desc: '起始行（1 起），可选', required: false },
        limit: { type: 'number', desc: '读取行数，可选', required: false },
      },
      risk: 1,
      handler: async (args: Record<string, unknown>) => {
        const file = resolve(String(args.path));
        const raw = await readFile(file, 'utf8');
        const lines = raw.split('\n');
        const offset = Number(args.offset ?? 1);
        const limit = args.limit === undefined ? undefined : Number(args.limit);
        const slice = limit === undefined ? lines.slice(offset - 1) : lines.slice(offset - 1, offset - 1 + limit);
        return {
          path: file,
          totalLines: lines.length,
          offset,
          lines: slice.map((l, i) => `${offset + i}:${l}`),
        };
      },
    },
    {
      name: 'fs_write',
      desc: '写入文件（覆盖）。内容可为字符串',
      params: {
        path: { type: 'string', desc: '文件路径' },
        content: { type: 'string', desc: '文件内容' },
      },
      risk: 3,
      handler: async (args: Record<string, unknown>) => {
        const file = resolve(String(args.path));
        await writeFile(file, String(args.content ?? ''), 'utf8');
        return { wrote: file, bytes: String(args.content ?? '').length };
      },
    },
    {
      name: 'fs_append',
      desc: '追加内容到文件末尾',
      params: {
        path: { type: 'string', desc: '文件路径' },
        content: { type: 'string', desc: '追加内容' },
      },
      risk: 3,
      handler: async (args: Record<string, unknown>) => {
        const file = resolve(String(args.path));
        await appendFile(file, String(args.content ?? ''), 'utf8');
        return { appended: file };
      },
    },
    {
      name: 'fs_patch',
      desc: '精确字符串替换。old 必须在文件中唯一出现，否则拒绝（防误伤）',
      params: {
        path: { type: 'string', desc: '文件路径' },
        old: { type: 'string', desc: '被替换的原文（必须唯一）' },
        new: { type: 'string', desc: '替换后的内容' },
      },
      risk: 3,
      handler: async (args: Record<string, unknown>) => {
        const file = resolve(String(args.path));
        const old = String(args.old);
        const fresh = String(args.new);
        const raw = await readFile(file, 'utf8');
        const count = raw.split(old).length - 1;
        if (count === 0) throw new Error('未找到匹配原文');
        if (count > 1) throw new Error(`匹配 ${count} 处，必须唯一（防误伤）`);
        await writeFile(file, raw.replace(old, fresh), 'utf8');
        return { patched: file, occurrences: 1 };
      },
    },
    {
      name: 'fs_list',
      desc: '列出目录内容',
      params: {
        path: { type: 'string', desc: '目录路径，默认根', required: false },
      },
      risk: 1,
      handler: async (args: Record<string, unknown>) => {
        const dir = args.path ? resolve(String(args.path)) : absRoot;
        const entries = await readdir(dir, { withFileTypes: true });
        return entries.map((e) => ({
          name: e.name,
          type: e.isDirectory() ? 'dir' : 'file',
        }));
      },
    },
    {
      name: 'fs_grep',
      desc: '正则搜索文件/目录内容，返回匹配行号与文本（JS 正则语法，忽略 node_modules/.git）',
      params: {
        pattern: { type: 'string', desc: '正则表达式（JS 语法）' },
        path: { type: 'string', desc: '文件或目录路径，默认根' },
        maxLines: { type: 'number', desc: '最多返回匹配数，默认 50', required: false },
      },
      risk: 1,
      handler: async (args: Record<string, unknown>) => {
        const target = args.path ? resolve(String(args.path)) : absRoot;
        const re = new RegExp(String(args.pattern));
        const max = Number(args.maxLines ?? 50);
        const matches: { line: number; text: string }[] = [];
        const IGNORE = new Set(['node_modules', '.git', 'dist', 'build', 'runs']);

        const searchFile = async (file: string): Promise<void> => {
          if (matches.length >= max) return;
          const raw = await readFile(file, 'utf8');
          const lines = raw.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (matches.length >= max) break;
            if (re.test(lines[i])) {
              matches.push({ line: i + 1, text: lines[i].slice(0, 200) });
            }
          }
        };
        const searchDir = async (dir: string): Promise<void> => {
          if (matches.length >= max) return;
          const entries = await readdir(dir, { withFileTypes: true });
          for (const e of entries) {
            if (matches.length >= max) break;
            if (IGNORE.has(e.name)) continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) await searchDir(full);
            else if (/\.(ts|js|json|md|html|css|cjs|mjs)$/.test(e.name)) await searchFile(full);
          }
        };

        const stat = await import('node:fs/promises').then((m) => m.stat(target));
        if (stat.isDirectory()) await searchDir(target);
        else await searchFile(target);

        return { path: target, pattern: String(args.pattern), count: matches.length, matches };
      },
    },
    {
      name: 'shell_run',
      desc: '在沙箱根执行 shell 命令（有黑名单，执行前必确认）',
      params: {
        command: { type: 'string', desc: '要执行的命令' },
      },
      risk: 4,
      handler: async (args: Record<string, unknown>, ctx: ExecContext) => {
        const cmd = String(args.command);
        const hit = SHELL_BLACKLIST.find((b) => cmd.toLowerCase().includes(b));
        if (hit) {
          ctx.audit(`[AUTO] shell 黑名单命中: ${hit}`);
          throw new Error(`命令命中黑名单: ${hit}`);
        }
        const { exec } = await import('node:child_process');
        // 注：cmd 输出在中文 Windows 上是 GBK，utf8 解码可能乱码 → 系统提示已要求避免中文输出（P0 已知限制）
        const out = await new Promise<string>((res) => {
          exec(cmd, { cwd: absRoot, timeout: 30_000, windowsHide: true }, (err, stdout, stderr) => {
            if (err) res(`(exit ${err.code ?? '?'}) ${stderr.trim() || stdout.trim()}`);
            else res(stdout.trim() + (stderr.trim() ? `\n[stderr] ${stderr.trim().slice(0, 1000)}` : ''));
          });
        });
        return { stdout: out.slice(0, 4000) };
      },
    },
  ];
}
