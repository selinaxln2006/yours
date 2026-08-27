// ============================================================
// Planner — Task Decomposition 调度层（goal-level 主引擎）
// 模糊大目标 → LLM 生成任务树 → 拓扑排序 → 逐个子任务独立 run()
// 任务树落盘 runs/<sid>/task-tree.json（= 断点续跑的状态地基）
//
// v0 范围：任务树生成/解析/排序/顺序执行/落盘
// 后续挂载点：re-plan 钩子（④）、并行子任务（⑤）、--resume 续跑（③）
// ============================================================

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ChatMessage, MemoryProvider, SessionEvent } from './types.ts';
import type { LLMAdapter } from './llm-adapter.ts';
import type { ToolPipeline } from './tool-pipeline.ts';
import type { SessionMgr } from './session-mgr.ts';
import { AgentLoop, type AgentLoopCtx } from './agent-loop.ts';

/** 任务树节点 */
export interface TaskNode {
  id: string;
  desc: string;
  verify: string;
  deps: string[];
  status: 'pending' | 'running' | 'done' | 'failed';
  rounds?: number;
  toolCalls?: number;
  note?: string;
}

/** 任务树（落盘结构 = 断点续跑的状态文件） */
export interface TaskTree {
  goal: string;
  createdAt: number;
  updatedAt: number;
  tasks: TaskNode[];
}

export interface PlannerOptions {
  /** 子任务数量上限，默认 6 */
  maxTasks?: number;
  /** 每个子任务独立 maxRounds，默认 8 */
  subtaskRounds?: number;
  /** 任务树生成调用 maxTokens，默认 2048 */
  planMaxTokens?: number;
}

export interface PlannerDeps {
  adapter: LLMAdapter;
  pipeline: ToolPipeline;
  session: SessionMgr;
  baseSystemPrompt: string;
  memoryProvider?: MemoryProvider | null;
  options?: PlannerOptions;
  /** 过程回调：子任务事件实时透出（CLI 用它打印 toolCard） */
  onEvent?: (taskId: string, ev: SessionEvent) => void;
}

/** 单子任务执行结果 */
export interface TaskOutcome {
  status: TaskNode['status'];
  rounds: number;
  toolCalls: number;
  note?: string;
}

/** 整个 goal 的执行结果 */
export interface PlannerResult {
  tree: TaskTree;
  outcomes: Record<string, TaskOutcome>;
  doneCount: number;
  totalCount: number;
  summary: string;
}

/** 任务树生成指令（追加在 base system prompt 之后） */
function planSystemPrompt(opts: Required<PlannerOptions>): string {
  return `你是任务规划器（Planner）。用户将给一个模糊的大目标，你的职责是把它拆解成可顺序执行的子任务队列。

输出要求：只输出一个 JSON 对象，不要任何多余文字、不要 markdown 代码块标记。

JSON 格式：
{"tasks":[{"id":"t1","desc":"子任务描述：具体做什么，涉及哪些文件/接口","verify":"完成标准：如何验证（可执行的检查）","deps":[]}]}

约束：
- 3~${opts.maxTasks} 个子任务
- 每个子任务必须能在 ${opts.subtaskRounds} 轮工具调用内独立完成——只做一件事，宁可拆细
- 顺序：先探索理解 → 再分层实现（数据层→API→UI）→ 再验证
- deps 只写直接依赖（如 t2 依赖 t1 → "deps":["t1"]）
- id 从 t1 开始连续编号
- 目标已包含明确约束（对象/范围/输出形式）时，禁止拆"确认需求/与用户确认"类子任务——直接进入实现
- 只有真正缺失关键参数时才拆"明确口径"子任务，且该子任务必须自主选择最合理默认值并注明假设，不允许设计成"要求用户回答"
- 【K7-③ 拆解锚定】目标包含前端/UI 需求（如"多会话""前端界面""页面交互"）时，必须有一个子任务明确写『修改 console.html』（仓库唯一前端文件）；禁止用 CLI 脚本/命令行客户端替代前端 UI 的实现——前端 UI 与 CLI 是两个独立交付物
- 【K8 可执行 verify】verify 必须是 agent 自己能执行的检查（fs_grep 搜引用 / node --check / HTTP 请求 / 跑脚本）；禁止写"浏览器打开能看到/人工确认"这类需要人类在场或没有工具可执行的验证方式`;
}

/** 子任务执行时的任务树状态块（追加在 base system prompt 之后，替代跨 run prior） */
function taskContextBlock(tree: TaskTree, current: TaskNode): string {
  const lines = tree.tasks.map((t) => {
    const mark =
      t.id === current.id ? '▶' : t.status === 'done' ? '✓' : t.status === 'failed' ? '✗' : '○';
    return `${mark} ${t.id} ${t.desc}`;
  });
  // K5：前序 done 子任务的产出（note = 该子任务最终回答摘要）注入当前子任务上下文
  const doneNotes = tree.tasks
    .filter((t) => t.status === 'done' && t.note && t.id !== current.id)
    .map((t) => `✓ ${t.id}: ${t.note}`)
    .join('\n');
  return [
    '',
    '# 任务树（总目标）',
    tree.goal,
    lines.join('\n'),
    ...(doneNotes ? ['', '# 已完成子任务的产出（前序子任务的结论，直接引用，不要重新调查）', doneNotes] : []),
    '',
    '# 当前子任务',
    `${current.id}: ${current.desc}`,
    '',
    '# 完成标准（验证）',
    current.verify,
    '',
    '收尾验证必须是语义验证，不是读回：用 fs_grep 在依赖方文件中搜索你新增符号的引用（如 server/main.ts 中 grep 新 store 类名、console.html 中 grep 新函数名），或运行最小检查（node --check 语法 / node --test 单文件 / npm run check）。只读回自己刚写的内容不算完成验证。',
    '执行当前子任务，完成后用一句话报告结果。',
  ].join('\n');
}

/** 无人值守纪律（goal 模式 = 全自动执行，无人在场回答澄清） */
const UNATTENDED_RULE = `
# 无人值守执行纪律（本任务在 planner 自动模式下运行，无人在场回答澄清问题）
- 目标描述即最终决策；禁止反问澄清（"请确认""你选一个""我需要澄清"这类行为视为失败）
- 有歧义时选择最合理假设，直接执行，在最终回答里注明"假设：xxx"
- 每个子任务的最终结论必须写入回答（会传给后续子任务），格式：结论：xxx
- 子任务需要产出落盘文件（写代码/报告）时，用 fs_write/fs_append 真实写入，不要只在回答里描述
- 【K7-② 语义验证】收尾验证 = 语义断言：用 fs_grep 在依赖方文件搜新增符号的引用，或跑最小检查（node --check / node --test / npm run check）。只读回自己刚写的内容 ≠ 完成验证
- 【K7-④ Windows 跨平台】本机是 Windows：无 cat/grep 命令——文本查看/搜索一律用内置 fs_read/fs_grep 工具，不要用 shell 的 cat/grep；shell 命令用 PowerShell 语法；端口被占用（EADDRINUSE）时先查占用进程杀掉或换端口，不要卡死
- 【K8 动手纪律】实现类子任务（要修改/新增文件）：先用 ≤4 轮理解（用 fs_grep 定位关键符号/挂载点，不要通读大文件），然后立即写第一版代码，再迭代补全。禁止把全部轮次用于阅读理解、最后因轮次耗尽而零产出——只读不写 = 未完成
- 【K8 脚手架策略】修改大文件（如 console.html 100KB+）：不要追求一次改完美——先实现最小可用版本（如一个会话列表 + 切换按钮），用 fs_patch 精确插入，再花剩余轮次迭代补全；宁可用 fs_grep 定位挂载点后小步多次改，不要"完全理解后才动手"`;

/** 提取并解析 JSON（容忍 ```json 包裹与前后废话） */
function parseJsonLoose(raw: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const target = fenced ? fenced[1] : raw;
  const start = target.indexOf('{');
  const end = target.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('输出中未找到 JSON 对象');
  return JSON.parse(target.slice(start, end + 1));
}

/** 校验并归一化任务树（过滤空描述、消除缺失/自环依赖、截断字段） */
function normalizeTree(goal: string, raw: unknown, maxTasks: number): TaskTree {
  const obj = raw as { tasks?: unknown };
  if (!obj || !Array.isArray(obj.tasks) || obj.tasks.length === 0) {
    throw new Error('任务树缺少 tasks 数组');
  }
  const tasks: TaskNode[] = obj.tasks
    .slice(0, maxTasks)
    .map((t, i): TaskNode => {
      const node = t as Partial<TaskNode>;
      const id = String(node.id ?? `t${i + 1}`);
      return {
        id,
        desc: String(node.desc ?? '').slice(0, 300),
        verify: String(node.verify ?? '').slice(0, 300),
        deps: Array.isArray(node.deps) ? node.deps.map((d) => String(d)) : [],
        status: 'pending',
      };
    })
    .filter((t) => t.desc);
  if (tasks.length === 0) throw new Error('任务树解析后为空');
  const ids = new Set(tasks.map((t) => t.id));
  for (const t of tasks) t.deps = t.deps.filter((d) => ids.has(d) && d !== t.id);
  return { goal, createdAt: Date.now(), updatedAt: Date.now(), tasks };
}

/** Kahn 拓扑排序（环/缺失依赖已由 normalize 消除） */
function topoSort(tasks: TaskNode[]): TaskNode[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const indeg = new Map(tasks.map((t) => [t.id, t.deps.length]));
  const adj = new Map<string, string[]>();
  for (const t of tasks) {
    for (const d of t.deps) {
      if (!adj.has(d)) adj.set(d, []);
      adj.get(d)!.push(t.id);
    }
  }
  const queue = tasks.filter((t) => indeg.get(t.id) === 0).map((t) => t.id);
  const order: TaskNode[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(byId.get(id)!);
    for (const next of adj.get(id) ?? []) {
      indeg.set(next, (indeg.get(next) ?? 0) - 1);
      if (indeg.get(next) === 0) queue.push(next);
    }
  }
  if (order.length !== tasks.length) throw new Error('任务树存在依赖环，无法排序');
  return order;
}

export class Planner {
  private deps: PlannerDeps;
  private opts: Required<PlannerOptions>;

  constructor(deps: PlannerDeps) {
    this.deps = deps;
    this.opts = {
      maxTasks: deps.options?.maxTasks ?? 6,
      subtaskRounds: deps.options?.subtaskRounds ?? 8,
      planMaxTokens: deps.options?.planMaxTokens ?? 2048,
    };
  }

  /** 阶段一：LLM 生成任务树（无工具、单次调用、低温） */
  async plan(goal: string, ctx: AgentLoopCtx): Promise<TaskTree> {
    const messages: ChatMessage[] = [
      { role: 'system', content: this.deps.baseSystemPrompt + '\n\n' + planSystemPrompt(this.opts) },
      { role: 'user', content: `【规划】请为以下目标生成任务树：\n${goal}` },
    ];
    const res = await this.deps.adapter.chat(messages, {
      maxTokens: this.opts.planMaxTokens,
      temperature: 0.2,
    });
    const tree = normalizeTree(goal, parseJsonLoose(res.content ?? ''), this.opts.maxTasks);
    await this.saveTree(tree, ctx);
    return tree;
  }

  /** 任务树落盘（断点续跑的状态文件） */
  private async saveTree(tree: TaskTree, ctx: AgentLoopCtx): Promise<void> {
    const dir = this.deps.session.sessionDir(ctx.sessionId);
    await mkdir(dir, { recursive: true });
    tree.updatedAt = Date.now();
    await writeFile(path.join(dir, 'task-tree.json'), JSON.stringify(tree, null, 2), 'utf8');
  }

  /** 阶段二：按拓扑序执行子任务队列（瞬时网络错误自动重试 1 次） */
  async run(goal: string, ctx: AgentLoopCtx): Promise<PlannerResult> {
    const tree = await this.plan(goal, ctx);
    const order = topoSort(tree.tasks);
    const outcomes: Record<string, TaskOutcome> = {};
    let doneCount = 0;

    subtaskLoop: for (const task of order) {
      task.status = 'running';
      await this.saveTree(tree, ctx);

      const subLoop = new AgentLoop({
        adapter: this.deps.adapter,
        pipeline: this.deps.pipeline,
        session: this.deps.session,
        systemPrompt: this.deps.baseSystemPrompt + '\n\n' + taskContextBlock(tree, task) + UNATTENDED_RULE,
        memoryProvider: this.deps.memoryProvider,
        maxRounds: this.opts.subtaskRounds,
      });

      let res;
      let attempts = 0;
      for (;;) {
        attempts++;
        try {
          res = await subLoop.run(`子任务 ${task.id}：${task.desc}`, ctx, {
            onEvent: (ev) => this.deps.onEvent?.(task.id, ev),
          });
          break;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          // 瞬断（undici terminated / fetch failed / ECONNRESET / timeout）→ 重试 1 次
          const transient = /terminated|fetch failed|ECONNRESET|socket|timed ?out|timeout/i.test(msg);
          if (attempts < 2 && transient) continue;
          task.status = 'failed';
          task.note = msg.slice(0, 200);
          outcomes[task.id] = { status: 'failed', rounds: 0, toolCalls: 0, note: task.note };
          await this.saveTree(tree, ctx);
          continue subtaskLoop;
        }
      }

      task.rounds = res.rounds;
      task.toolCalls = res.toolCalls;

      // 失败判定：中断 / 工具失败率 > 30% / 写类工具成败 / 无产出反问 / verify 分层（K6 + K7）
      const toolEvents = res.events.filter((ev) => ev.type === 'tool') as Array<{
        payload: { name?: string; result?: { ok?: boolean }; arguments?: unknown };
      }>;
      const fails = toolEvents.filter((ev) => ev.payload?.result?.ok === false).length;
      const failRate = toolEvents.length ? fails / toolEvents.length : 0;
      const note = res.answer?.slice(0, 400) ?? '';
      // K6：写类工具（fs_write/fs_append/fs_patch）单独统计成败——T1 实测暴露：
      // 写操作全失败但总失败率 < 30% 时会被误判 done（假阳性）
      let writeOk = 0;
      let writeFail = 0;
      let lastWriteIdx = -1;
      toolEvents.forEach((ev, idx) => {
        const n = ev.payload?.name;
        if (n === 'fs_write' || n === 'fs_append' || n === 'fs_patch') {
          if (ev.payload?.result?.ok === false) writeFail++;
          else {
            writeOk++;
            lastWriteIdx = idx;
          }
        }
      });
      // 【K7-①/②】verify 分层判定（最后一次成功写之后的验证动作）：
      // - strong = 语义验证（fs_grep 搜引用点 / shell 跑 node --check|--test|npm test）
      // - weak = 仅 fs_read 读回（读回自己刚写的内容 ≠ 功能完成）
      // - none = 无任何验证
      // 写失败（writeFailed）→ 真失败（K6 保留）；写了但未自验 → 降级 warning 仍判 done——
      // 误杀真实产出（写了 5-6 次完整代码仅因轮次耗尽没自验）代价 > 放过半成品；
      // 半成品由任务树中"全局验证"子任务（如 t5 全链路验证）兜底抓出
      const afterWrites = lastWriteIdx >= 0 ? toolEvents.slice(lastWriteIdx + 1) : [];
      const verifyStrong = afterWrites.some((ev) => {
        const n = ev.payload?.name;
        if (n === 'fs_grep') return true;
        if (n === 'shell_run') {
          const args = ev.payload?.arguments as { command?: string; cmd?: string } | undefined;
          const cmd = String(args?.command ?? args?.cmd ?? '');
          return /node .*--check|node .*--test|npm test|npm run check/i.test(cmd);
        }
        return false;
      });
      const verifyWeak = afterWrites.some((ev) => ev.payload?.name === 'fs_read');
      const verifyLevel = verifyStrong ? 'strong' : verifyWeak ? 'weak' : 'none';
      const writeFailed = (writeFail > 0 && writeOk === 0) || writeFail > writeOk;
      const wrote = writeOk > 0 || res.events.some((ev) => {
        if (ev.type !== 'tool') return false;
        const p = ev.payload as { name?: string };
        return p.name === 'artifact_create' || p.name === 'memory_save';
      });
      const clarify = /(请确认|你选一个|我需要澄清|无法确定|需要你来决定)/.test(note);
      const noOutput = !wrote && clarify && res.rounds <= 4;
      // 【K8 v3】空转假阳性：实现类子任务（desc 含实现关键词）零写操作且无"功能已就位"证据 → failed
      // （t4 型：全程只读探索后轮次耗尽零产出；核对确认型例外：功能本已存在，note 含"已满足/已完整实现"等证据）
      // v2 修正（第五跑 3 误杀）：证据词扩充 + 验证类豁免 + 去"创建"
      // v3 修正（第六跑 t4 逃逸）：VERIFY 豁免只查 desc 不查 verify——"fs_grep 确认 XXX 存在"是实现类
      // 任务的验收措辞（verify），不是验证类任务特征；验证类任务的标志在 desc（"验证/走通/回归"是动作）
      const IMPL_RE = /(修改|新增|实现|写入|生成|添加|增加|落地|改造|接入|挂载|编写)/;
      const DONE_EVIDENCE_RE =
        /(已完成|已存在|已实现|已经完成|已由|前序|已落地|已经具备|已有|已对接|已满足|无需改动|无需修改|已完整|已齐全|已就绪|已经接入)/;
      const VERIFY_TASK_RE = /(验证|测试|检查|走通|回归|核实|复核|审查)/;
      const idleFakeDone =
        !VERIFY_TASK_RE.test(task.desc) &&
        (IMPL_RE.test(task.desc) || IMPL_RE.test(task.verify)) &&
        writeOk === 0 &&
        writeFail === 0 &&
        !DONE_EVIDENCE_RE.test(note);

      if (res.aborted || failRate > 0.3 || writeFailed || noOutput || idleFakeDone) {
        const why = res.aborted
          ? '被中断'
          : writeFailed
            ? `写类工具失败(${writeFail}次)≥成功(${writeOk}次)，代码未落地`
            : idleFakeDone
              ? '实现类子任务零写操作且无"功能已就位"证据（空转假阳性，只读不写=未完成）'
              : failRate > 0.3
                ? `工具失败率过高(${(failRate * 100).toFixed(0)}%)`
                : '无产出反问（违反无人值守纪律）';
        task.status = 'failed';
        task.note = `${why} | ${note}`.slice(0, 300);
        outcomes[task.id] = { status: 'failed', rounds: res.rounds, toolCalls: res.toolCalls, note: task.note };
      } else {
        task.status = 'done';
        const verifyWarn =
          writeOk > 0 && verifyLevel === 'none'
            ? `⚠️ 写了 ${writeOk} 次但无任何读回/grep 验证（降级 warning，由全局验证子任务兜底）| `
            : writeOk > 0 && verifyLevel === 'weak'
              ? `⚠️ 仅读回未做语义验证（应 grep 引用点/跑最小检查）| `
              : '';
        task.note = (verifyWarn + note).slice(0, 300);
        outcomes[task.id] = { status: 'done', rounds: res.rounds, toolCalls: res.toolCalls, note: task.note };
        doneCount++;
      }
      await this.saveTree(tree, ctx);
    }

    const summary = [
      `✅ 目标执行完成：${doneCount}/${order.length} 个子任务成功`,
      ...order.map(
        (t) => `- ${t.id} [${t.status}] ${t.desc}${t.note ? ` — ${t.note}` : ''}`,
      ),
    ].join('\n');

    return { tree, outcomes, doneCount, totalCount: order.length, summary };
  }
}
