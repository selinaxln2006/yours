/* memory-tools.js — C4 记忆系统工具集（G6）
   memory_search（只读，搜索记忆文件）/ memory_append（低风险，追加日志）
   memory_update（中风险，更新 MEMORY.md/goals.md）
   安全模型：
   - 作用域限定在 paa/memory/ 目录
   - MEMORY.md 双重上限：200 行 / 25KB（索引层防膨胀）
   - append-only：daily log 只追加不回改
   - update 限白名单文件（MEMORY.md / goals.md）
   检索层为可插拔 RetrievalBackend 接口（v1 = GrepBackend，为 A/B/C embedding 预留）。 */
import fs from 'node:fs';
import path from 'node:path';
import { today } from '../util.js';

const MEM_INDEX_MAX_LINES = 200;
const MEM_INDEX_MAX_BYTES = 25 * 1024;
const MEM_ENTRY_MAX_CHARS = 150;
const SEARCH_MAX_HITS = 50;

export function registerMemoryTools(skills, opts) {
  const pkgRoot = opts.pkgRoot;
  const memDir = path.join(pkgRoot, 'memory');
  fs.mkdirSync(memDir, { recursive: true });
  fs.mkdirSync(path.join(memDir, 'details'), { recursive: true });

  const memPath = (name) => path.join(memDir, name);
  const dailyFile = () => memPath(today() + '.md');

  skills.register({
    id: 'memory',
    name: '记忆系统',
    desc: '跨会话记忆：搜索历史决策/已知 bug/上次结论，追加会话日志，更新长期记忆索引',
    tools: [
      {
        name: 'search',
        desc: '搜索记忆文件（MEMORY.md / goals.md / 每日日志 / details/）。用于查找历史决策、已知 bug、上次会话结论等。返回 文件:行号:内容 格式。',
        readOnly: true,
        risk: 'read',
        params: { type: 'object', properties: {
          pattern: { type: 'string', description: '搜索关键词或正则表达式，如 "rruleDays" 或 "expandRecurring.*bug"' }
        }, required: ['pattern'] },
        handler(a) {
          const pattern = String(a.pattern || '');
          if (!pattern) throw new Error('pattern 为空');
          let re = null, literal = null;
          try { re = new RegExp(pattern); } catch (e) { literal = pattern; }

          /* 收集记忆目录下所有 .md 文件 */
          const files = [];
          (function walk(dir) {
            for (const name of fs.readdirSync(dir)) {
              const fp = path.join(dir, name);
              let st; try { st = fs.statSync(fp); } catch (e) { continue; }
              if (st.isDirectory()) walk(fp);
              else if (name.endsWith('.md')) files.push({ rel: path.relative(memDir, fp).replace(/\\/g, '/'), abs: fp });
            }
          })(memDir);

          const hits = [];
          for (const f of files) {
            if (hits.length >= SEARCH_MAX_HITS) break;
            const ls = fs.readFileSync(f.abs, 'utf8').split('\n');
            for (let i = 0; i < ls.length; i++) {
              if (hits.length >= SEARCH_MAX_HITS) break;
              const matched = re ? re.test(ls[i]) : ls[i].includes(literal);
              if (matched) hits.push(f.rel + ':' + (i + 1) + ' ' + ls[i].slice(0, 200));
            }
          }
          if (!hits.length) return '未在记忆中找到匹配「' + pattern + '」（搜索 ' + files.length + ' 个记忆文件）';
          return '记忆搜索「' + pattern + '」命中 ' + hits.length + ' 处（' + files.length + ' 个文件）：\n' + hits.join('\n');
        }
      },
      {
        name: 'append',
        desc: '追加内容到当日记忆日志（append-only，低风险自动执行）。用于记录本次会话的关键发现、决策、未完成事项。每条自动加时间戳。只记录不可从代码/日志推导的信息。',
        readOnly: false,
        risk: 'low',
        params: { type: 'object', properties: {
          content: { type: 'string', description: '要记录的内容（会自动加时间戳前缀）。只记不可推导信息：决策背景、方法论、外部链接。代码位置不存（grep 一次就有）。' }
        }, required: ['content'] },
        handler(a) {
          const content = String(a.content || '').trim();
          if (!content) throw new Error('content 为空');
          const ts = new Date().toTimeString().slice(0, 8);
          const fp = dailyFile();
          if (!fs.existsSync(fp)) {
            fs.writeFileSync(fp, '# PAA 会话日志 — ' + today() + '\n', 'utf8');
          }
          fs.appendFileSync(fp, '\n- [' + ts + '] ' + content + '\n', 'utf8');
          return '已记录到 ' + today() + '.md';
        }
      },
      {
        name: 'update',
        desc: '更新长期记忆文件（MEMORY.md 索引或 goals.md）。MEMORY.md 是索引层（≤200行/25KB），每条格式：- [标题](details/xxx.md) -- 钩子描述。修改前先 memory__search 检查是否已有相关条目，避免重复。',
        readOnly: false,
        risk: 'medium',
        params: { type: 'object', properties: {
          file: { type: 'string', description: '文件名：MEMORY.md 或 goals.md' },
          content: { type: 'string', description: '完整新内容（整体替换）' }
        }, required: ['file', 'content'] },
        handler(a) {
          const file = String(a.file || '');
          if (file !== 'MEMORY.md' && file !== 'goals.md') throw new Error('仅允许更新 MEMORY.md 或 goals.md');
          const content = String(a.content || '');
          if (file === 'MEMORY.md') {
            const lines = content.split('\n');
            if (lines.length > MEM_INDEX_MAX_LINES) throw new Error('MEMORY.md 超过 ' + MEM_INDEX_MAX_LINES + ' 行上限（当前 ' + lines.length + ' 行），请精简');
            if (Buffer.byteLength(content, 'utf8') > MEM_INDEX_MAX_BYTES) throw new Error('MEMORY.md 超过 25KB 上限');
          }
          const fp = memPath(file);
          fs.writeFileSync(fp, content, 'utf8');
          return '已更新 ' + file;
        }
      }
    ]
  });
}

/* 启动时注入记忆到 system prompt（不占工具调用轮次） */
export function loadMemoryForInjection(pkgRoot) {
  const memDir = path.join(pkgRoot, 'memory');
  const parts = [];

  /* MEMORY.md（索引层，截断至 ~8000 字符 ≈ ~2000 token） */
  const memFile = path.join(memDir, 'MEMORY.md');
  if (fs.existsSync(memFile)) {
    let content = fs.readFileSync(memFile, 'utf8').trim();
    if (content) {
      if (content.length > 8000) content = content.slice(0, 8000) + '\n…（截断，完整内容用 memory__search 查询）';
      parts.push('=== 长期记忆（MEMORY.md）===\n' + content);
    }
  }

  /* 今日 daily log（尾部 ~2000 字符） */
  const todayLog = path.join(memDir, today() + '.md');
  if (fs.existsSync(todayLog)) {
    let content = fs.readFileSync(todayLog, 'utf8').trim();
    if (content) {
      if (content.length > 2000) content = '…（前文省略）\n' + content.slice(-2000);
      parts.push('=== 今日日志（' + today() + ' 尾部）===\n' + content);
    }
  }

  return parts.length ? parts.join('\n\n') : null;
}

/* 审计日志：auto 执行的写操作写入 daily log */
export function writeAuditLog(pkgRoot, entry) {
  const memDir = path.join(pkgRoot, 'memory');
  fs.mkdirSync(memDir, { recursive: true });
  const fp = path.join(memDir, today() + '.md');
  if (!fs.existsSync(fp)) fs.writeFileSync(fp, '# PAA 会话日志 — ' + today() + '\n', 'utf8');
  const ts = new Date().toTimeString().slice(0, 8);
  const argSummary = JSON.stringify(entry.args || {}).slice(0, 200);
  const resultSummary = String(entry.result || '').split('\n')[0].slice(0, 100);
  fs.appendFileSync(fp, '\n- [' + ts + '][AUTO] ' + entry.tool + ' ' + argSummary + ' → ' + resultSummary + '\n', 'utf8');
}
