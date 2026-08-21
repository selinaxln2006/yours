/* fs-tools.js — Phase B G3 自诊断闭环工具集（v0.2：grep + 切片读 + check）
   fs_read（只读自动执行，支持行区间切片）/ fs_grep（只读，正则定位）
   fs_check（只读，node --check 语法验证）/ fs_write（写，待确认）/ shell_run（写，待确认）
   安全模型：
   - root 沙箱：所有路径解析到 root 内，越界直接拒绝
   - 大小上限：读 300KB / 写 500KB，防上下文爆炸；grep 跳过超限大文件
   - 黑名单：shell 危险命令前缀拒绝（rm -rf / Remove-Item -Recurse / format 等）
   确认时机不在 handler 内：pending 动作由宿主（CLI 交互 / UI 计划卡）统一确认。 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync, execFileSync } from 'node:child_process';

const READ_MAX = 300 * 1024;   /* 300KB */
const WRITE_MAX = 500 * 1024;  /* 500KB */
const SHELL_TIMEOUT = 30000;   /* 30s */
const GREP_MAX_HITS = 50;      /* grep 最多返回 50 处匹配 */
const GREP_MAX_FILES = 300;    /* grep 递归搜索的文件数上限 */

/* grep 递归搜索时忽略的目录 */
const GREP_IGNORE_DIRS = new Set(['node_modules', '.git', '.workbuddy', 'dist', 'build', '.vscode', '.idea']);

/* 危险命令黑名单（大小写不敏感，前缀匹配）—— 禁止破坏性/系统级操作 */
const BANNED = [
  'rm -rf', 'rm -fr', 'rm -r -f', 'rmdir /s', 'del /s', 'del /f', 'del /q',
  'remove-item -recurse', 'remove-item -force', 'rm -recursive', 'rmdir -recurse',
  'format ', 'shutdown', 'taskkill /f', 'taskkill -f', 'diskpart', 'mkfs',
  'fdisk', 'reg delete', 'del -recurse', 'kill -9', 'pkill', 'deltree'
];

function inside(root, p) {
  const rel = path.relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function resolvePath(root, rel) {
  const abs = path.resolve(root, String(rel || '').replace(/^["']|["']$/g, ''));
  if (!inside(root, abs)) {
    const err = new Error('路径越界：' + rel + '（仅允许 ' + root + ' 内）');
    err.code = 'EPERM';
    throw err;
  }
  return abs;
}

export function registerFsTools(skills, opts) {
  const root = path.resolve(opts.root || process.cwd());
  if (!fs.existsSync(root)) throw new Error('root 不存在：' + root);

  skills.register({
    id: 'fs',
    name: '文件系统',
    desc: '本地文件读写与 shell 执行（G3 自诊断闭环）',
    tools: [
      {
        name: 'read',
        desc: '读取文件内容（UTF-8）。路径相对工作区根目录。大文件先 fs__grep 定位行号，再用 offset/limit 只读需要的片段（切片模式带行号前缀）。全文件读取返回内容+行数；超过 300KB 截断。目录则返回前 100 项列表。',
        readOnly: true,
        risk: 'read',
        params: { type: 'object', properties: {
          path: { type: 'string', description: '相对工作区根目录的文件路径，如 index.html 或 paa/src/core/agent-loop.js' },
          offset: { type: 'integer', description: '起始行号（1-based，与 fs__grep 返回的行号对应）。不传则整读' },
          limit: { type: 'integer', description: '读取行数（默认 80）。仅 offset 提供时生效' }
        }, required: ['path'] },
        handler(a) {
          const p = resolvePath(root, a.path);
          if (!fs.existsSync(p)) throw new Error('文件不存在：' + a.path);
          const stat = fs.statSync(p);
          if (stat.isDirectory()) {
            const names = fs.readdirSync(p).slice(0, 100);
            return '目录 ' + a.path + ' 内容（前100项）：\n' + names.join('\n');
          }
          const content = fs.readFileSync(p, 'utf8');
          const lines = content.split('\n');
          const total = lines.length;
          /* 切片模式：offset 提供时按行区间读，带行号前缀（与 grep 输出对齐） */
          if (a.offset != null) {
            let start = Math.max(1, parseInt(a.offset, 10) || 1);
            const n = Math.min(400, Math.max(1, parseInt(a.limit, 10) || 80));
            const end = Math.min(total, start + n - 1);
            if (start > total) return '⚠ 起始行 ' + start + ' 超出文件总行数 ' + total + '（' + a.path + '）';
            const slice = lines.slice(start - 1, end).map((l, i) => (start + i) + ': ' + l).join('\n');
            return '文件 ' + a.path + ' 第 ' + start + '-' + end + ' 行（共 ' + total + ' 行）：\n```\n' + slice + '\n```';
          }
          if (stat.size > READ_MAX) {
            return '⚠ 文件 ' + a.path + ' 共 ' + stat.size + ' 字节（' + total + ' 行），超过 300KB，仅返回前 300KB。建议先 fs__grep 定位再切片读：\n```\n' + content.slice(0, READ_MAX) + '\n…（截断）```';
          }
          return '文件 ' + a.path + '（' + stat.size + ' 字节，' + total + ' 行）：\n```\n' + content + '\n```';
        }
      },
      {
        name: 'grep',
        desc: '在文件或目录中搜索文本/正则，返回「文件:行号:内容」。定位代码优先用它而不是整读大文件；搜到行号后用 fs__read 的 offset 参数读上下文。支持正则（非法正则自动降级为字面文本）。递归目录搜索自动忽略 node_modules/.git/.workbuddy 等。',
        readOnly: true,
        risk: 'read',
        params: { type: 'object', properties: {
          pattern: { type: 'string', description: '搜索文本或正则表达式，如 "expandRecurring" 或 "rruleDays.*\\\\d"' },
          path: { type: 'string', description: '相对根目录的文件或目录，默认整个根目录递归搜索' },
          context: { type: 'integer', description: '每处匹配额外显示的上下文行数（0-3，默认 0）' }
        }, required: ['pattern'] },
        handler(a) {
          const pattern = String(a.pattern || '');
          if (!pattern) throw new Error('pattern 为空');
          /* 编译正则：失败则降级为字面文本搜索 */
          let re = null, literal = null;
          try { re = new RegExp(pattern); } catch (e) { literal = pattern; }
          const ctx = Math.min(3, Math.max(0, parseInt(a.context, 10) || 0));
          /* 收集目标文件 */
          const files = [];
          const target = a.path ? resolvePath(root, a.path) : root;
          if (!fs.existsSync(target)) throw new Error('路径不存在：' + (a.path || root));
          const st = fs.statSync(target);
          if (st.isFile()) files.push({ rel: a.path, abs: target });
          else {
            (function walk(dir) {
              if (files.length >= GREP_MAX_FILES) return;
              for (const name of fs.readdirSync(dir)) {
                if (files.length >= GREP_MAX_FILES) break;
                if (GREP_IGNORE_DIRS.has(name)) continue;
                const fp = path.join(dir, name);
                let s; try { s = fs.statSync(fp); } catch (e) { continue; }
                if (s.isDirectory()) walk(fp);
                else if (s.size <= READ_MAX) files.push({ rel: path.relative(root, fp).replace(/\\/g, '/'), abs: fp });
              }
            })(target);
          }
          /* 逐文件逐行匹配 */
          const hits = [];
          let truncated = false;
          for (const f of files) {
            if (hits.length >= GREP_MAX_HITS) { truncated = true; break; }
            const ls = fs.readFileSync(f.abs, 'utf8').split('\n');
            for (let i = 0; i < ls.length; i++) {
              if (hits.length >= GREP_MAX_HITS) { truncated = true; break; }
              const matched = re ? re.test(ls[i]) : ls[i].includes(literal);
              if (matched) {
                const from = Math.max(0, i - ctx), to = Math.min(ls.length - 1, i + ctx);
                let block = '';
                for (let j = from; j <= to; j++) {
                  const mark = j === i ? '>' : ' ';
                  block += f.rel + ':' + (j + 1) + mark + ' ' + ls[j] + '\n';
                }
                hits.push(block.trimEnd());
              }
            }
          }
          if (!hits.length) return '未找到匹配「' + pattern + '」（搜索范围：' + (a.path || '根目录递归') + '，' + files.length + ' 个文件）';
          return '搜索「' + pattern + '」命中 ' + hits.length + ' 处（范围：' + (a.path || '根目录递归') + '，' + files.length + ' 个文件' + (truncated ? '，已达上限仅显示前 ' + GREP_MAX_HITS + ' 处' : '') + '）：\n' + hits.join('\n---\n');
        }
      },
      {
        name: 'check',
        desc: '用 node --check 验证 JS 文件语法（只读安全，不执行文件内容）。每次用 fs__write 修改 .js/.mjs/.cjs 文件后必须调用它验证，语法错误会返回精确的行号和原因。',
        readOnly: true,
        risk: 'read',
        params: { type: 'object', properties: {
          path: { type: 'string', description: '相对根目录的 .js/.mjs/.cjs 文件路径' }
        }, required: ['path'] },
        handler(a) {
          const p = resolvePath(root, a.path);
          if (!fs.existsSync(p)) throw new Error('文件不存在：' + a.path);
          const ext = path.extname(p).toLowerCase();
          if (ext !== '.js' && ext !== '.mjs' && ext !== '.cjs') {
            return '⚠ ' + a.path + ' 不是 JS 文件（' + ext + '），node --check 不适用。HTML 文件改动建议用 fs__shell 跑 git diff 人工复核。';
          }
          try {
            execFileSync('node', ['--check', p], { timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
            return '✅ 语法验证通过：' + a.path;
          } catch (e) {
            const err = ((e.stderr || '') + (e.message || '')).split('\n').slice(0, 6).join('\n');
            return '❌ 语法错误：' + a.path + '\n' + err;
          }
        }
      },
      {
        name: 'write',
        desc: '写入/覆盖文件内容（UTF-8，整体替换）。修改代码前先用 fs_read 读取原文件，只改动必要部分。新建文件路径需在根目录内。',
        readOnly: false,
        risk: 'high',
        params: { type: 'object', properties: { path: { type: 'string', description: '相对工作区根目录的文件路径' }, content: { type: 'string', description: '完整新内容（整体替换）' } }, required: ['path', 'content'] },
        handler(a) {
          const content = String(a.content || '');
          if (content.length > WRITE_MAX) throw new Error('写入内容超过 500KB 上限');
          const p = resolvePath(root, a.path);
          fs.mkdirSync(path.dirname(p), { recursive: true });
          fs.writeFileSync(p, content, 'utf8');
          return '已写入 ' + a.path + '（' + Buffer.byteLength(content, 'utf8') + ' 字节）。如需验证语法可调用 shell_run 执行 node --check。';
        }
      },
      {
        name: 'shell',
        desc: '在根目录执行 shell 命令（Windows PowerShell，超时 30s）。用于语法验证/运行测试/查看状态。禁止破坏性命令（rm -rf、格式化、关机等，已做黑名单拦截）。',
        readOnly: false,
        risk: 'high',
        params: { type: 'object', properties: { cmd: { type: 'string', description: '要执行的命令，如 node --check paa/src/cli.js 或 git status' } }, required: ['cmd'] },
        handler(a) {
          const cmd = String(a.cmd || '').trim();
          if (!cmd) throw new Error('命令为空');
          const lower = cmd.toLowerCase();
          for (const b of BANNED) {
            if (lower.includes(b)) throw new Error('命令被黑名单拦截（' + b + '）：不允许破坏性操作');
          }
          let out = '';
          try {
            out = execSync(cmd, { cwd: root, shell: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command'], encoding: 'utf8', timeout: SHELL_TIMEOUT, maxBuffer: 2 * 1024 * 1024 });
          } catch (e) {
            const errOut = (e.stdout || '') + (e.stderr || '') + (e.message || '');
            return '❌ 命令执行失败（exit ' + (e.status != null ? e.status : '?') + '）：\n' + errOut.slice(0, 4000);
          }
          return '✅ 命令执行成功：\n' + String(out).slice(0, 8000);
        }
      }
    ]
  });
}
