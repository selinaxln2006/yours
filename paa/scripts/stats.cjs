// 仓库统计脚本 v2：文件数 + 总行数 + 净代码行数 + 测试用例数 + TODO/FIXME 数
// 按 t1 口径：主范围 paa/，扩展参考 docs/（文档规模，不混入代码统计）
// 用法: node scripts/stats.cjs [root] [--json]
const fs = require('fs');
const path = require('path');

const root = path.resolve(process.argv[2] || '.');
const JSON_OUT = process.argv.includes('--json');

const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'runs', 'artifacts']);
const EXCLUDE_EXT = new Set(['.log', '.txt', '.lock']);
const EXCLUDE_FILES = new Set(['package-lock.json']);
// 代码文件扩展名（用于净代码行数统计）
const CODE_EXT = new Set(['.js', '.cjs', '.mjs', '.ts', '.tsx', '.jsx', '.json', '.html', '.css']);
// 测试文件所在目录（用于测试用例统计）
const TEST_DIRS = new Set(['test', 'tests', '__tests__']);

let fileCount = 0, lineCount = 0, codeLineCount = 0;
let todoCount = 0, fixmeCount = 0, testCount = 0;
const byDir = new Map();   // 顶层目录 -> {files, lines}
const byExt = new Map();   // 扩展名 -> {files, lines}
const bigFiles = [];       // 行数最多的文件

function countCodeLines(content) {
  let n = 0;
  const lines = content.split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;                 // 空行
    if (line.startsWith('//')) continue; // 整行注释
    if (line.startsWith('/*') || line.startsWith('*') || line.startsWith('*/')) continue;
    n++;
  }
  return n;
}

function walk(dir, top) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (e) { return; }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (EXCLUDE_DIRS.has(ent.name)) continue;
      const childTop = top === null ? ent.name : top;
      walk(full, childTop);
    } else if (ent.isFile()) {
      const ext = path.extname(ent.name).toLowerCase();
      if (EXCLUDE_EXT.has(ext)) continue;
      if (EXCLUDE_FILES.has(ent.name)) continue;
      if (path.basename(full) === 'stats.cjs') continue; // 排除脚本自身（正则字面量会误报 TODO/FIXME）
      let content = '';
      try { content = fs.readFileSync(full, 'utf8'); }
      catch (e) { return; }
      const lines = content.split('\n').length;
      fileCount++;
      lineCount += lines;
      if (CODE_EXT.has(ext)) codeLineCount += countCodeLines(content);

      // TODO / FIXME 统计
      const todoMatches = content.match(/TODO/g) || [];
      const fixmeMatches = content.match(/FIXME/g) || [];
      todoCount += todoMatches.length;
      fixmeCount += fixmeMatches.length;

      // 测试用例统计：test('...', 或 it('...',
      const isTestDir = TEST_DIRS.has(path.basename(path.dirname(full)));
      if (isTestDir) {
        const testMatches = content.match(/\b(?:test|it)\s*\(\s*['"`]/g) || [];
        testCount += testMatches.length;
      }

      const key = top || '(root)';
      if (!byDir.has(key)) byDir.set(key, { files: 0, lines: 0 });
      const d = byDir.get(key);
      d.files++; d.lines += lines;
      const ekey = ext || '(none)';
      if (!byExt.has(ekey)) byExt.set(ekey, { files: 0, lines: 0 });
      const e = byExt.get(ekey);
      e.files++; e.lines += lines;
      bigFiles.push({ file: full.replace(root + path.sep, ''), lines });
    }
  }
}

walk(root, path.basename(root));

const dirs = [...byDir.entries()].sort((a, b) => b[1].lines - a[1].lines);
const exts = [...byExt.entries()].sort((a, b) => b[1].lines - a[1].lines);
bigFiles.sort((a, b) => b.lines - a.lines);

if (JSON_OUT) {
  const json = {
    root,
    total: { files: fileCount, lines: lineCount, codeLines: codeLineCount },
    markers: { todo: todoCount, fixme: fixmeCount },
    tests: { count: testCount },
    byDir: Object.fromEntries(dirs.map(([k, v]) => [k, v])),
    byExt: Object.fromEntries(exts.map(([k, v]) => [k, v])),
    topFiles: bigFiles.slice(0, 15),
  };
  console.log(JSON.stringify(json, null, 2));
  fs.writeFileSync(path.join(__dirname, '..', '..', 'artifacts', 'repo-stats.json'), JSON.stringify(json, null, 2));
  console.log('\nJSON 已写入 artifacts/repo-stats.json');
  return;
}

const out = [];
out.push('='.repeat(60));
out.push(`仓库统计报告  root=${root}`);
out.push('='.repeat(60));
out.push(`文件总数:      ${fileCount}`);
out.push(`总行数:        ${lineCount}`);
out.push(`净代码行数:    ${codeLineCount}  (去空行/整行注释, 仅代码文件)`);
out.push(`测试用例数:    ${testCount}  (test/it 声明)`);
out.push(`TODO 数量:     ${todoCount}`);
out.push(`FIXME 数量:    ${fixmeCount}`);
out.push('');

out.push('--- 按顶层目录分布 ---');
for (const [k, v] of dirs) {
  out.push(`${k.padEnd(20)} files=${String(v.files).padStart(4)}  lines=${String(v.lines).padStart(7)}`);
}
out.push('');

out.push('--- 按文件类型分布 ---');
for (const [k, v] of exts) {
  out.push(`${(k || '(none)').padEnd(12)} files=${String(v.files).padStart(4)}  lines=${String(v.lines).padStart(7)}`);
}
out.push('');

out.push('--- 行数 Top 15 文件 ---');
for (const f of bigFiles.slice(0, 15)) {
  out.push(`${String(f.lines).padStart(7)}  ${f.file}`);
}

const report = out.join('\n');
console.log(report);
fs.writeFileSync(path.join(__dirname, '..', '..', 'artifacts', 'repo-stats.txt'), report);
console.log('\n报告已写入 artifacts/repo-stats.txt');
