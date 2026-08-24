#!/usr/bin/env node
/* cli.js — PAA Phase B CLI 宿主：本地文件系统上的 agent 入口
   用法：
     node paa/src/cli.js "<需求描述>" [--yes] [--root DIR] [--max-rounds N]
       [--provider openai|anthropic] [--api-url URL] [--api-key KEY] [--model M] [--config PATH]
   配置优先级：命令行 flags > 环境变量 PAA_* > config.json（--config 指定或 ./config.json）
   写操作默认逐条确认（Enter=y / n 拒绝）；--yes 全自动执行。 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';
import { createSkills } from './core/skills.js';
import { createToolPipeline } from './core/tool-pipeline.js';
import { createLLMAdapter } from './core/llm-adapter.js';
import { createAgentLoop } from './core/agent-loop.js';
import { registerFsTools } from './tools/fs-tools.js';
import { registerMemoryTools, loadMemoryForInjection, writeAuditLog } from './tools/memory-tools.js';
import { today } from './util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, '..');

/* ---------- 参数与配置 ---------- */
function parseArgs(argv) {
  const a = { query: '', yes: false, level: null, root: process.cwd(), maxRounds: 10, timeoutMs: 90000, config: null, provider: null, apiUrl: null, apiKey: null, model: null };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--yes') a.yes = true;
    else if (t === '--level') a.level = parseInt(argv[++i], 10);
    else if (t === '--root') a.root = argv[++i];
    else if (t === '--max-rounds') a.maxRounds = parseInt(argv[++i], 10) || 10;
    else if (t === '--timeout-ms') a.timeoutMs = parseInt(argv[++i], 10) || 90000;
    else if (t === '--config') a.config = argv[++i];
    else if (t === '--provider') a.provider = argv[++i];
    else if (t === '--api-url') a.apiUrl = argv[++i];
    else if (t === '--api-key') a.apiKey = argv[++i];
    else if (t === '--model') a.model = argv[++i];
    else positional.push(t);
  }
  a.query = positional.join(' ');
  return a;
}

function loadConfig(a) {
  const cfg = { provider: 'openai', apiUrl: '', apiKey: '', model: '', autonomy: { level: 1, tools: {} } };
  /* 1) config 文件（最低优先级） */
  const candidates = [a.config, path.join(PKG_ROOT, 'config.json'), path.join(process.cwd(), 'paa.config.json')].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      try { Object.assign(cfg, JSON.parse(fs.readFileSync(c, 'utf8'))); } catch (e) { console.error('⚠ 读取配置文件失败（忽略）：' + c + ' — ' + e.message); }
      break;
    }
  }
  /* 2) 环境变量 PAA_* */
  if (process.env.PAA_PROVIDER) cfg.provider = process.env.PAA_PROVIDER;
  if (process.env.PAA_API_URL) cfg.apiUrl = process.env.PAA_API_URL;
  if (process.env.PAA_API_KEY) cfg.apiKey = process.env.PAA_API_KEY;
  if (process.env.PAA_MODEL) cfg.model = process.env.PAA_MODEL;
  /* 3) 命令行 flags（最高优先级） */
  if (a.provider) cfg.provider = a.provider;
  if (a.apiUrl) cfg.apiUrl = a.apiUrl;
  if (a.apiKey) cfg.apiKey = a.apiKey;
  if (a.model) cfg.model = a.model;
  /* 默认 URL */
  if (!cfg.apiUrl) cfg.apiUrl = cfg.provider === 'anthropic' ? 'https://api.anthropic.com/v1/messages' : 'https://api.openai.com/v1/chat/completions';
  /* Autonomy：config.json 为基础，--yes = L3，--level N 覆盖 */
  cfg.autonomy = cfg.autonomy || { level: 1, tools: {} };
  cfg.autonomy.level = a.level != null ? a.level : (a.yes ? 3 : (cfg.autonomy.level || 1));
  cfg.autonomy.tools = cfg.autonomy.tools || {};
  return cfg;
}

const LABELS = {
  'fs__read': '📖 读取文件',
  'fs__grep': '🔍 搜索代码',
  'fs__check': '✔️ 验证语法',
  'fs__patch': '🔧 精确替换',
  'fs__write': '✏️ 写入文件',
  'fs__shell': '⚙️ 执行命令',
  'memory__search': '🔎 搜索记忆',
  'memory__append': '📝 记录日志',
  'memory__update': '📋 更新记忆'
};
const labelFn = fn => LABELS[fn] || fn;

function fmtArgs(args) {
  const flat = {};
  for (const [k, v] of Object.entries(args || {})) {
    flat[k] = typeof v === 'string' && v.length > 120 ? v.slice(0, 120) + '…(' + v.length + '字)' : v;
  }
  return Object.entries(flat).map(([k, v]) => k + '=' + JSON.stringify(v)).join(' · ').slice(0, 400);
}

/* 进度行：工具调用实时可见（解决「静默执行」） */
function fmtStep(s) {
  return '  [' + s.round + '] ' + labelFn(s.tool) + (s.args ? '  ' + fmtArgs(s.args) : '');
}

/* 终端展示上限：超长回复截断显示，全文进转录文件（解决「不可读/被截断」） */
const MAX_REPLY_DISPLAY = 5000;

/* 会话转录：工具轨迹 + 模型文本 + 最终回复 + 待确认操作，全部落盘不丢 */
function writeTranscript(file, query, r) {
  const L = [];
  L.push('# PAA 会话转录 · ' + new Date().toLocaleString('zh-CN'));
  L.push('');
  L.push('**需求**：' + query);
  L.push('');
  L.push('## 工具轨迹');
  if (!(r.trace || []).length) L.push('（无工具调用）');
  for (const t of (r.trace || [])) {
    L.push('- [轮' + t.round + '] `' + t.tool + '` ' + JSON.stringify(t.args));
    L.push('  - ' + (t.pending ? '⏸ 待确认' : (t.ok ? '✅ ' + String(t.result).slice(0, 600) : '❌ ' + String(t.result).slice(0, 600))));
  }
  L.push('');
  L.push('## 模型过程文本');
  for (const tx of (r.texts || [])) L.push(tx + '\n');
  L.push('## 最终回复');
  L.push(r.reply || '（无）');
  L.push('');
  L.push('## 待确认操作');
  if (!(r.actions || []).length) L.push('（无）');
  (r.actions || []).forEach((x, i) => L.push((i + 1) + '. `' + x.tool + '` ' + JSON.stringify(x.args)));
  fs.writeFileSync(file, L.join('\n'), 'utf8');
}

/* ---------- 主流程 ---------- */
function buildSys(cfg, memInjection) {
  return '你是「枢」，运行在本地文件系统上的 AI 编程助手（Phase B，G3 自诊断 + G4 自修改 + G6 记忆闭环）。今天是 ' + today() + '。' +
    (memInjection ? '\n\n' + memInjection + '\n\n' : '\n（暂无历史记忆，这是首次会话。）\n\n') +
    '工作流程（严格遵守，这是硬纪律）：' +
    '1) **定位优先**：先用 fs__grep 搜索关键词/正则定位相关代码行号，禁止上来就整读大文件（浪费上下文且容易漏细节）；' +
    '2) **按需精读**：用 fs__read 的 offset/limit 参数只读 grep 命中行号附近的片段（如 offset=1195 limit=30）；要了解全貌时可整读小文件；' +
    '3) **交叉验证**：结论必须引用具体「文件:行号」证据；下结论前主动检查相邻分支和调用方（grep 相关函数名/字段名确认没有遗漏场景）；' +
    '4) **最小修改**：修改已有文件优先用 fs__patch（手术刀精确替换，只改变目标片段不碰全文件）；仅新建文件用 fs__write。patch 前 fs__read 确认原文，old_str 必须唯一匹配；' +
    '5) **改后必验**：.js 文件修改后立即用 fs__check 验证语法；HTML/CSS 等文件用 fs__shell 跑 git diff -- <file> 确认改动范围正确且无意外行被改；' +
    '6) **回滚纪律**：若验证失败或改动有误，立即用 fs__shell 执行 git restore -- <file> 恢复原文件，报告失败原因——绝不留破代码在仓库里；' +
    '7) 结束时用中文总结：发现什么（附文件:行号证据）、改了什么、验证结果、是否回滚。**输出纪律**：总结用要点列表，控制在 20 行左右；除非用户明确要求，不要转贴大段代码，引用代码一律用「文件:行号」；先给结论后给过程。' +
    '8) **记忆固化**（硬纪律）：总结前必须调用 memory__append 记录本次关键发现和结论（只记不可推导信息：决策背景/方法论/外部链接，代码位置不存）；' +
    '若发现值得长期保留的约定/事实，用 memory__search 检查是否已有，再提议更新 MEMORY.md（需确认）。' +
    '记忆是线索不是事实——行动前用 fs__grep/fs__read 独立验证记忆中的断言。' +
    '写操作（fs__write / fs__patch / fs__shell / memory__update）会先经用户确认再执行（当前自主级 L' + cfg.autonomy.level +
    '，memory__append 自动执行），你只管返回工具调用。';
}

/* 单次任务：跑循环 → 转录落盘 → 打印结果 → 确认并执行写操作 */
async function runOnce(cfg, a, skills, pipeline, llm, loop, memInjection, query) {
  const sys = buildSys(cfg, memInjection);
  let r;
  try {
    r = await loop.run(query, {
      sys,
      maxTokens: 3000,
      timeoutMs: a.timeoutMs,
      config: { maxRounds: a.maxRounds },
      /* 第七步硬纪律的机械强制：提示词模型可能跳过，循环层兜底（G3 第三轮实测触发过跳过） */
      requiredTool: 'memory__append',
      requiredReminder: '系统提醒：你尚未调用 memory__append 固化本次会话记忆（工作流程第 8 步硬纪律，不可跳过）。请立即调用 memory__append 记录本次关键发现与结论（只记不可推导信息），然后再给出最终总结。',
      /* 进度实时可见：每调一个工具打一行（解决「静默执行」） */
      onStep: (s) => console.log(fmtStep(s))
    });
  } catch (e) {
    console.error('❌ 规划失败：' + e.message);
    return 1;
  }

  /* 转录落盘：终端截断不丢信息 */
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const slug = (query.slice(0, 16).replace(/[^\w\u4e00-\u9fa5]/g, '') || 'session');
  const runsDir = path.join(PKG_ROOT, 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  const transFile = path.join(runsDir, ts + '-' + slug + '.md');
  writeTranscript(transFile, query, r);

  console.log('\n🧠 规划完成（' + r.rounds + ' 轮' + (r.aborted ? '，中断' : '') + '）：\n');
  if (r.reply) {
    let disp = r.reply;
    if (disp.length > MAX_REPLY_DISPLAY) disp = disp.slice(0, MAX_REPLY_DISPLAY) + '\n\n…（回复过长已截断，完整内容见转录文件）';
    console.log(disp + '\n');
  }
  console.log('📄 转录：' + path.relative(PKG_ROOT, transFile));

  /* 待确认动作 */
  const acts = r.actions || [];
  if (!acts.length) {
    console.log('（无待执行操作）\n');
    return 0;
  }
  console.log('📋 待确认操作（' + acts.length + ' 项）：');
  acts.forEach((x, i) => console.log('  [' + (i + 1) + '] ' + labelFn(x.tool) + '  ' + fmtArgs(x.args)));

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const results = [];
  try {
    for (let i = 0; i < acts.length; i++) {
      const x = acts[i];
      let go = a.yes;
      if (!go) {
        const ans = (await rl.question('执行 [' + (i + 1) + '] ' + labelFn(x.tool) + '？(y/n，Enter=y) ')).trim().toLowerCase();
        go = ans === '' || ans === 'y' || ans === 'yes';
      }
      if (!go) { results.push('⏭ 跳过'); console.log('  ⏭ 已跳过\n'); continue; }
      const res = skills.dispatch(x.tool, x.args);
      if (res.ok) { results.push('✅'); console.log('  ✅ ' + String(res.result).split('\n')[0] + '\n'); }
      else { results.push('❌ ' + res.error); console.log('  ❌ ' + res.error + '\n'); }
    }
  } finally {
    rl.close();
  }

  const nFail = results.filter(x => x.startsWith('❌')).length;
  const nSkip = results.filter(x => x.startsWith('⏭')).length;
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('完成：' + results.length + ' 项操作 · ' + (results.length - nFail - nSkip) + ' 成功 · ' + nFail + ' 失败 · ' + nSkip + ' 跳过');
  return nFail ? 1 : 0;
}

/* REPL 对话模式：无参数启动，连续问答，跨话记忆由 memory 系统保证 */
async function repl(cfg, a, skills, pipeline, llm, loop, memInjection) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on('SIGINT', () => { console.log('\n👋 再见'); process.exit(0); });
  console.log('💬 对话模式（每条对话 = 一次带记忆的会话；输入 exit 退出，Ctrl+C 中断）\n');
  for (;;) {
    let q;
    try { q = await rl.question('paa> '); } catch (e) { console.log('\n👋 再见'); break; }
    const t = q.trim();
    if (!t) continue;
    if (/^(exit|quit|q|\/exit)$/i.test(t)) { console.log('👋 再见'); break; }
    await runOnce(cfg, a, skills, pipeline, llm, loop, memInjection, t);
    console.log('');
  }
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const cfg = loadConfig(a);
  if (!cfg.apiKey || cfg.apiKey === 'PASTE_YOUR_API_KEY_HERE') {
    console.error('❌ 未配置 LLM API Key。请先设置环境变量 PAA_API_KEY，或创建 paa/config.json（参考 config.example.json）。');
    process.exit(1);
  }

  /* 组装宿主：skills + fs 工具 + memory 工具 + pipeline(autonomy) + llm + loop */
  const skills = createSkills();
  registerFsTools(skills, { root: a.root });
  registerMemoryTools(skills, { pkgRoot: PKG_ROOT });
  const onAudit = (entry) => writeAuditLog(PKG_ROOT, entry);
  const pipeline = createToolPipeline(skills, { autonomy: cfg.autonomy, onAudit });
  const llm = createLLMAdapter(cfg, skills);
  const loop = createAgentLoop({ llm, pipeline, today, labelFn });

  /* 启动注入记忆 */
  const memInjection = loadMemoryForInjection(PKG_ROOT);

  console.log('🧠 枢（Phase B CLI）— provider: ' + cfg.provider + ' · model: ' + (cfg.model || '默认') + ' · root: ' + a.root);
  console.log('   自主级：L' + cfg.autonomy.level + (a.yes && a.level == null ? ' (--yes)' : ''));
  console.log('   工具：' + skills.allTools().map(t => t.id).join(', '));
  console.log('   记忆：' + (memInjection ? '✅ 已注入' : '⬜ 空（首次使用）'));

  /* 无参数 → 对话模式（此前是打印用法，交互体验差） */
  if (!a.query) {
    await repl(cfg, a, skills, pipeline, llm, loop, memInjection);
    return;
  }

  console.log('   需求：' + a.query + '\n');
  const code = await runOnce(cfg, a, skills, pipeline, llm, loop, memInjection, a.query);
  if (code) process.exit(code);
}

main().catch(e => { console.error('❌ ' + e.message); process.exit(1); });
