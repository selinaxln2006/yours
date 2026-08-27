// ============================================================
// 内置工具集（P0 验证用，覆盖 G1 读 / G2 写 / G3 自诊断）
// 沙箱：所有 fs 路径限制在 root 内；shell 带黑名单
// 对齐此前 G3/G4 闭环验证过的能力（行切片读、唯一匹配 patch）
// ============================================================

import { readFile, writeFile, appendFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import type { ExecContext, ToolDefinition } from '../core/types.ts';

/** ENOENT 时给出同目录候选，避免 agent 反复 fs_list 猜路径 */
async function missingHint(absRoot: string, rel: string, file: string): Promise<string> {
  const parent = path.dirname(file);
  const base = path.basename(rel).split('.')[0].toLowerCase();
  try {
    const entries = await readdir(parent, { withFileTypes: true });
    const names = entries.map((e) => (e.isDirectory() ? e.name + '/' : e.name));
    const similar = names.filter((n) => n.toLowerCase().includes(base)).slice(0, 5);
    const shown = names.length > 20 ? names.slice(0, 20).join(', ') + ' …' : names.join(', ');
    const hint = `。目录 ${path.relative(absRoot, parent) || '.'} 下现有 ${names.length} 项: ${shown}`;
    return similar.length ? hint + `。疑似目标: ${similar.join(', ')}` : hint;
  } catch {
    const relParent = path.relative(absRoot, path.dirname(parent)) || '.';
    return `。目录 ${path.relative(absRoot, parent) || '.'} 也不存在（请检查层级，最近存在的层: ${relParent}）`;
  }
}

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
      desc: '读取文件内容，支持行切片（offset/limit，1 起）。返回的行带"行号:"前缀（如 42:code），仅用于定位；构造 fs_patch 的 old 时必须去掉前缀',
      params: {
        path: { type: 'string', desc: '相对沙箱根的文件路径' },
        offset: { type: 'number', desc: '起始行（1 起），可选', required: false },
        limit: { type: 'number', desc: '读取行数，可选', required: false },
      },
      risk: 1,
      handler: async (args: Record<string, unknown>) => {
        const rel = String(args.path);
        const file = resolve(rel);
        let raw: string;
        try {
          raw = await readFile(file, 'utf8');
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'ENOENT' || code === 'EISDIR') {
            const hint = await missingHint(absRoot, rel, file);
            throw new Error(code === 'EISDIR' ? `目标是目录，请用 fs_list 查看: ${rel}${hint}` : `文件不存在: ${rel}${hint}`);
          }
          throw err;
        }
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
      desc: '精确字符串替换。old 必须在文件中唯一出现，否则拒绝（防误伤）。old 必须是不带行号前缀的原文；CRLF/LF 行尾差异自动容错',
      params: {
        path: { type: 'string', desc: '文件路径' },
        old: { type: 'string', desc: '被替换的原文（必须唯一，禁止带"行号:"前缀）' },
        new: { type: 'string', desc: '替换后的内容' },
      },
      risk: 3,
      handler: async (args: Record<string, unknown>) => {
        const file = resolve(String(args.path));
        const old = String(args.old);
        const fresh = String(args.new);
        const raw = await readFile(file, 'utf8');
        if (!old.trim()) throw new Error('old 为空，无法替换');
        // CRLF 容错：old 的 \n 匹配时容忍 \r\n（Windows 行尾差异），替换按实际匹配长度截断
        const esc = old.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\n/g, '\r?\n');
        const matches = [...raw.matchAll(new RegExp(esc, 'g'))];
        if (matches.length === 0) {
          // K6 诊断增强：失败时给出最接近位置 + 附近内容预览，帮助 agent 自愈
          const firstLine = old.split('\n')[0].trim().slice(0, 60);
          if (firstLine) {
            const lines = raw.split('\n');
            const hit = lines.findIndex((l) => l.includes(firstLine));
            if (hit >= 0) {
              const lo = Math.max(0, hit - 2);
              const hi = Math.min(lines.length, hit + 3);
              const preview = lines.slice(lo, hi).map((l, i) => `${lo + i + 1}:${l}`).join('\n');
              throw new Error(
                `未找到匹配原文。诊断：old 首行"${firstLine}"出现在第 ${hit + 1} 行附近，附近内容：\n${preview}\n` +
                  `请核对：① old 是否误带"行号:"前缀 ② 空白/缩进是否与文件一致 ③ 内容是否来自其他文件（串扰）`,
              );
            }
          }
          throw new Error(`未找到匹配原文${firstLine ? `：old 首行"${firstLine}"在文件中不存在（内容可能来自其他文件或已过时）` : ''}`);
        }
        if (matches.length > 1) throw new Error(`匹配 ${matches.length} 处，必须唯一（防误伤）`);
        const m = matches[0];
        await writeFile(file, raw.slice(0, m.index) + fresh + raw.slice(m.index + m[0].length), 'utf8');
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
        // Windows cmd 默认 GBK 输出：切 UTF-8 代码页 + buffer 解码（UTF-8 失败回退 GBK），消除中文乱码
        const isWin = process.platform === 'win32';
        const fullCmd = isWin && !/^chcp\b/i.test(cmd) ? `chcp 65001 >nul & ${cmd}` : cmd;
        const utf8 = new TextDecoder('utf-8', { fatal: true });
        const gbk = new TextDecoder('gbk');
        const decode = (buf: Buffer | null): string => {
          if (!buf || buf.length === 0) return '';
          try {
            return utf8.decode(buf);
          } catch {
            return gbk.decode(buf);
          }
        };
        const out = await new Promise<string>((res) => {
          exec(
            fullCmd,
            { cwd: absRoot, timeout: 30_000, windowsHide: true, encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 },
            (err, stdout, stderr) => {
              const so = decode(stdout as Buffer);
              const se = decode(stderr as Buffer);
              if (err) res(`(exit ${err.code ?? '?'}) ${se.trim() || so.trim()}`);
              else res(so.trim() + (se.trim() ? `\n[stderr] ${se.trim().slice(0, 1000)}` : ''));
            },
          );
        });
        return { stdout: out.slice(0, 4000) };
      },
    },
  ];
}
