# PAA 全量规划 v2 — 从"能力打勾"到"长程自主"

> 2026-08-27 定稿 · 姊妹文档：`paa-host-evolution-v1.md`（宿主演进）、`paa-design-v2.md`（大脑设计）、`console-v1.md`（console 工程）
> 纪律（2026-08-25 俪宁第二次"学生级"质问后落定）：**G8（长程自主实测）通过前，任何人问"到 Codex 级了吗"答案一律"没有"。**

---

## 一、现状定位（2026-08-27 快照）

```
已完成 ─────────────────────────────────────────────────────────
G1-G7 全绿      FS/Shell/自诊断/自修改/MCP/记忆/产物    commit 7af1560
console v1.3   主客反转：chat 主区 + 8 面板附属，全部真写回   5c57979
服务健壮性      离线重试+横幅、WS 恒重连、打字机泵          c43a54e cb0a1df
范式转向        v2 承诺：长任务实测迭代为主线，打勾清单退役    8-25
─────────────────────────────────────────────────────────────
范式真相        任务型短循环(task-level) ≠ 目标型长程(goal-level)
                "一轮"=一次 run()=一个任务生命周期；模糊大目标、
                中途 re-plan、跨 run 续跑都不支持
```

**一句话**：能力都存在了，缺的是把能力串成"连续自主行为"的骨架。下一个阶段目标 = 把循环从 task-level 推到 goal-level。

---

## 二、北极星：G8 长程自主（唯一主线）

### G8 判定标准（可验证、不可糊弄）

> 给 agent 一个**模糊大目标**（不给步骤），它全程自主：
> 拆子任务 → 排执行顺序 → 连续工作 **≥ 20 轮工具调用** → 中途失败自愈（re-plan）→ 产出真实落盘结果，**全程无人插手**。

### goal-level 六件套（按依赖顺序，全是"缺了长程跑不动"的，不是锦上添花）

| # | 能力 | 为什么长程必须 | 依赖 |
|---|------|---------------|------|
| ① | **Task Decomposition** | 模糊目标 → 任务树 → 子任务调度。没有它 agent 只会对着大目标发呆或乱撞 | 核心，先做 |
| ② | **Compaction** | 长任务上下文必爆。存储不花钱，注入才花钱：原文全存、摘要进上下文 | 独立 |
| ③ | **断点续跑** | run 状态持久化，崩溃/中断后从断点恢复，不重头再来 | ① |
| ④ | **re-plan / 目标自检** | 子任务失败后自主调整计划，不卡死、不硬冲 | ① + ③ |
| ⑤ | **并行工具** | 多个独立子任务并行执行，长任务才有时效性 | ③ |
| ⑥ | **C2 完整自我更新** | 长任务中发现自己缺工具 → 现场写工具（fs__write 已具备，需规范成循环内一等动作） | ① + ④ |

### 开发方法（v2 纪律）

- **不再新增验收打勾项**。每做一个能力 = 拿到真实长任务上跑，卡点即开发清单
- 验证单位 = **真实任务完成率**，不是"这条能力测试过了"

---

## 三、六件套补满路径（实现机制，落到具体文件）

> 现状代码已确认（2026-08-27 读码）：`agent-loop.ts` 单层循环 + maxRounds=12 + prior 续跑 + 工具结果截断 8k + 记忆注入；`session-mgr.ts` JSONL 事件溯源已全量落盘。**地基已有，缺的是调度层与状态层。**

| # | 能力 | 落点（新文件/改动） | 实现机制 |
|---|------|-------------------|---------|
| ① | Task Decomposition | 新 `core/planner.ts` + `cli/main.ts` 改 | 首轮 system 加规划指令 → agent 输出任务树 JSON（子任务：描述/验证标准/依赖）→ planner 解析成队列 → **逐个子任务调 run()**（每个子任务独立 maxRounds，如 8）→ 前一个子任务的 messages 摘要作为下一个的 prior。**goal-level = planner 调度 N 个 task-level run** |
| ② | Compaction | 新 `core/compactor.ts`，挂 agent-loop 消息组装点 | 上下文预算（字符估算）：超阈值（~60k chars）→ 最早 N 轮 messages 交给 LLM 生成结构化摘要（做了什么/发现什么/当前状态/待办）→ 替换进上下文；**原文永不删**（events.jsonl 已全存，L0 层，审计/回溯用） |
| ③ | 断点续跑 | planner 产物落盘 `runs/<sid>/task-tree.json` + `resume(sid)` API | 任务树含每个子任务状态（pending/running/done/failed）→ 恢复 = 加载树 → 跳过 done → 从 pending 续跑；messages 由 events.jsonl 回放重建。CLI 加 `--resume <sid>` |
| ④ | re-plan 自检 | planner 内钩子 + 新增 replan 轮 | 子任务失败判定（toolFail/toolCalls > 30% 或无产出/验证失败）→ 触发 replan：LLM 读失败原因 → 增删改剩余任务树 → 更新 task-tree.json → 继续 |
| ⑤ | 并行工具 | `agent-loop.ts` 工具执行段（现 194-216 行顺序 for）改 | 同轮多个 toolCalls 声明 no-dep → `Promise.all` 并行；planner 层支持子任务并发 N（默认 1，逐步放开）；结果仍按 call.id 顺序注入，审计不变 |
| ⑥ | C2 自我更新 | `pkg-loader.ts` 热加载（已支持 loadAll 容错）+ 循环内一等动作 | planner 阶段检测"缺工具" → agent 用 fs__write 写新工具文件（按 pkg 规范）→ pkg-loader 热挂载 → 注册表更新 → 继续执行。权限纪律：写工具走用户确认（FORBID-less），沿用 v1 设计 |

**关键洞察**：六件套不全是"新造"，① 是核心引擎（planner 调度层），③ 的地基（JSONL 事件溯源）已存在，⑤ 是局部重构，② ④ ⑥ 是挂在 ① 上的钩子。**做 ① 就能同时激活 ③ ④ 的骨架**。

### A0 基线录制结果（2026-08-27 实测，T1 首跑）

**跑法**：CLI 直接给模糊任务（"console 需要多会话：新建/列表/切换/重命名/删除，历史持久化，自主完成"），`--yes` 全自动，无人插手。commit `c72d47d`。

**表现（比预期强）**：自主探索（读 agent-loop/life-store/前端 handleEvent）→ 独立发现"前端 S.msgs 与后端 ChatMessage 是两套数据、tool 卡无法从 ChatMessage 重建" → 自研 uiHistory 方案 → **完整写出 299 行 `chat-session-store.ts`**（原子写/损坏自愈/loadAll/uiHistory/320 条上限，质量可直接用，已作为 T1 数据层种子提交）。

**卡点清单（真实数据，比纸面分析值钱）**：

| # | 卡点 | 现象 | 解法方向 |
|---|------|------|---------|
| K1 | **单轮输出长度截断** | 写大文件时"回复达到长度上限已截断"，文件半写；agent 自己发现并重写成功 | ① CLI 层调大 max_tokens（现有硬编码 1500 已改？待确认）② system prompt 强制">200 行文件分段写（fs__write 骨架 + fs__append 续写）" |
| K2 | **单 run 轮数不够** | 探索(3)+设计(2)+实现数据层(3) 已耗尽 maxRounds=12；server API + 前端 UI 完全没跑到 | Task Decomposition：把"探索/设计/实现数据层/实现API/实现UI/验证"拆成子任务队列，每子任务独立 run |
| K3 | **无进度状态** | 中途无任务树、无 checkpoint，无法续跑也无法中途 replan | 任务树落盘（③ 断点续跑直接解决） |
| K4 | 上下文累积（预判） | 探索阶段多次重复读文件区域 | Compaction（②） |

**对六件套顺序的修正**：K1（输出截断）是 A1 实现时会立刻撞的墙，**先于 ① 处理**（半小时改动）；① planner 是主引擎；③ 是 ① 的自然产物（任务树即状态）；② 长任务中后段才需要。

**A0 副产品**：agent 已证明"给规划指令 → 输出可执行方案"的假设成立，planner 层（prompt 引导 + 任务树解析）可行性获实测背书。

### A1 实现与三次实测（2026-08-27，commit `2d0117b`）

**实现**：`core/planner.ts`（322 行）——任务树生成（LLM 低温单次调用→容错 JSON 解析→归一化）→ Kahn 拓扑排序 → 子任务队列逐个独立 `run()`（每个子任务独立 maxRounds=10）→ 任务树落盘 `runs/<sid>/task-tree.json`（= ③断点续跑的状态地基）→ 失败判定（中断/工具失败率>30%/无产出反问）。CLI 新增 `--goal "模糊目标" [--yes]` 模式。

**三次实测曲线（真实数据）**：

| 次 | 目标 | 结果 | 暴露的卡点 |
|----|------|------|-----------|
| 1 | "统计 paa/core 的 .ts 总行数写入 artifacts/core-lines.txt" | 5/5 done 但**实际零产出** | **K5：子任务产出不传递**——t1"确认统计目标"的结论没传给 t2-t5，agent 反复说"t1 确认的内容丢失了"；且"指令模糊先反问"纪律在无人值守模式下发疯，5 个子任务全在反问澄清 |
| 2 | 同上（K5 修复后） | **4/5 done，产物真实** | t3 `terminated` 0 轮 = undici 网络瞬断（DeepSeek 连接重置），非逻辑 bug → 加瞬断自动重试 1 次；agent 自主写 stats.cjs 并解决 ESM 兼容（type:module → .cjs） |
| 3 | "统计 paa/core .ts 数量写入 artifacts/core-count.txt"（约束明确） | **4/4 done，100% 完成率**，报告落盘 docs/STATS-REPORT.md，交叉验证误差 0 | 轻微 scope 漂移：agent 自选输出到 docs/STATS-REPORT.md 而非指定文件（verify 未强制执行的已知局限） |

**K5 修复方案（已落地）**：① 前序 done 子任务的 note（最终回答摘要）注入后续子任务的 system prompt（"已完成子任务的产出，直接引用，不要重新调查"）；② 无人值守纪律（禁止反问澄清、歧义选最合理假设并注明、结论必须落盘）；③ 任务树生成 prompt 禁止拆"确认需求"类子任务；④ 无产出反问判定（低轮次+无写类工具+反问特征 → failed）。

**A1 结论**：planner 调度层验证通过，goal-level 骨架（①+③地基）就位。下一卡点大概率在 T1 真靶子（会话管理）——子任务规模大、依赖真实 server/UI，届时测 Compaction（②）。

### T1 二次实测（S3，2026-08-27）——假阳性暴露与 K6 闭环

**跑法**：`--goal "console 多会话：server 接入 ChatSessionStore + 会话 API + 前端 UI + 验证全链路（含重启持久化）" --yes`，数据层种子（chat-session-store.ts）已就位。

**结果：5/5 标 done，实际 1/5（假阳性）**——真实数据：
- t1 探索 ✅ 真实完成；t2（server 接入）❌ t3（前端 UI）❌ t4（切换同步）❌ t5（验证）❌ 全部假 done
- git diff 铁证：server/main.ts 仅 +1 行（import ChatSessionStore），console.html **0 改动**
- agent 自己在 t3/t5 就看穿"t2 未真正落地，仍用内存 Map"，但 planner 依然全标 done——**agent 看得到问题，判定机制看不见**

**K6 卡点（三个根因，全从真实失败里挖出来的）**：

| # | 根因 | 现象 | 修复 |
|---|------|------|------|
| 1 | **fs_patch 零诊断** | 失败只抛"未找到匹配原文"，agent 无法定位差异 → 盲试 → 放弃（6+ 次连续失败） | fs_patch 失败时返回**最接近位置 + 附近内容预览 + 三种可能原因**（行号前缀/空白/串扰） |
| 2 | **行号前缀陷阱** | fs_read 返回 `42:code` 带行号，agent 构造 old 时串入行号 → 必然匹配失败 | fs_read desc 明示"返回带行号前缀，构造 fs_patch 的 old 必须去掉"；fs_patch 兼容 CRLF（\r?\n） |
| 3 | **done 判定不可信** | 失败率阈值 >30% 对"写类工具全失败但总失败率仅 15%"不敏感 → 假 done | planner 新增：**写类工具（write/append/patch）成败单独统计**（写失败≥成功 → failed）+ **写了未读回验证 → failed**（verify 强制执行） |

**verify 纪律进入提示词**：子任务收尾必须 fs_grep/fs_read 读回验证修改已在磁盘生效并报告行号证据，只写不验视为未完成。

**对六件套顺序的修正**：done 判定 = goal-level 的"验收仪表盘"，假阳性 = 仪表盘坏了——**K6 比 Compaction（②）更优先**。A2 顺延到下次 T1 重跑通过后。下次实测目标：K6 修复后 T1 重跑，期望真实完成率显著提升（不再假 done）。

### T1 三次实测（S4，2026-08-27）——K6 验证通过，新卡点 K7

**跑法**：同目标（会话管理全链路），每跑前 `git checkout` 恢复基线，三跑横向可比。判定口径 = planner 标 done/failed；真实口径 = git diff 人工核查。

| 跑次 | 判定 done | 真实完成度（git diff 铁证） | 观察 |
|------|----------|---------------------------|------|
| 1 | 3/5（t2/t4 failed） | server 接入✅ 会话 API✅ t5 自修 /api/chat ReferenceError✅ CLI 部分✅；console.html 0 改动 | **0 假 done**（K6 生效）；t3 曾删 getChatSession 破坏 /api/chat，t5 自主发现并修复 |
| 2 | 2/5（t2/t3/t5 failed） | server 接入 + 全部会话端点（GET/POST/rename/remove/append）✅ 但**判定误杀**；t4 假 done（t5 grep 看穿"CLI 无 fetch"）；CLI 0 改动 | 误杀 t2/t3（写了未自验但代码真实完整）；t4 半成品骗过 verify |
| 3 | 4/5（t2 failed） | server 接入✅ 会话 API✅ **sessions-client.ts 高质量 CLI 客户端✅** 类型债 13→7✅；t5 验证遇端口 EADDRINUSE 未完整跑通 | 最高完成率；产出已保留（测试 55/55 通过） |

**结论**：
- **K6 主目标达成**：假 done 从 S3 的 5/5 → 三跑平均 ≤1/跑，且 agent 每跑都能自主发现上游假 done（t5 的 grep 验证），判定机制在追赶 agent 的感知。
- **K7 新卡点（四根因）**：
  1. **verify 时序误伤**：agent 自然工作流 = "多次写 → 最后统一验证"，10 轮内写 5-6 次后轮次耗尽 → 判 failed，但代码真实完整（t2 三跑全 failed、store 接入三跑全落地）。修法方向：区分"写失败"（真失败）与"写了未自验"（降级 warning + 依赖全局 verify 子任务兜底）。
  2. **verify 语义不足**：读回自己写的内容 ≠ 功能完成（t4 半成品读过回骗过验证）。修法方向：verify 要求**语义断言**（grep 关键调用点/跑最小测试），不只读回。
  3. **任务树拆解漂移**：三跑 t4 全拆成"CLI 交互"而非 console.html 前端——T1 定义里的前端 UI 从未被正确拆解。修法方向：planner prompt 锚定"前端 UI = 改 console.html"。
  4. **Windows 跨平台**：`cat` 不存在（shell_run 报"不是内部或外部命令"）、端口冲突 EADDRINUSE。修法方向：提示词加 Windows 命令对照。
- **T1 现状**：server 数据层+API+CLI 客户端已真实可用（第三跑产出保留），**console.html 前端 UI 是唯一缺口**（三跑都没拆对）。

**下一步**：① K7 修复（verify 时序/语义 + 拆解锚定 + Windows 提示）→ ② console.html 前端补全（人类/agent 皆可，T1 收口）→ ③ 之后 A2 Compaction。

### T1 四五六次实测（S5，2026-08-27）——K7/K8 修复 + UI 人类补写，T1 收口

**K7 四根因修复落地**（`core/planner.ts`）：① verify 时序——"写了未自验"从直接 failed 降级为 warning（区分真失败=写失败）；② verify 语义——提示词要求语义断言（grep 引用点/跑最小检查），读回不算；③ 拆解锚定——prompt 强制前端 UI=改 console.html；④ Windows 提示——cat→fs_read/fs_grep、EADDRINUSE 处理。

| 跑次 | 判定 | 真实完成度 | 观察 |
|------|------|-----------|------|
| 4 | 5/5 done | 3.5/5（t1/t2/t4 真，t5 半，**t3 假**） | K7-① 生效（t5 降级 warning 未误杀）；t3 拆解锚定成功（改 console.html）但**探索过深零产出** → 新卡点 **K8 空转假阳性**（实现类子任务无写操作无证据仍判 done） |
| 5 | 1/5 done | t2/t3/t5 被 **K8 误杀**（核对确认型证据词不全 + 验证类被"创建"触发） | K8 v1 矫枉过正，3/4 误杀；t4 正确抓出空转 |
| 6 | 6/6 done | **console.html 依旧 0 改动**（t4 逃逸：verify 含"确认"命中验证豁免） | K8 v3 修正（VERIFY 只查 desc）；判定机制已收敛但 agent 对 112KB 大文件的行为模式固化（通读→轮次耗尽→零产出） |

**K8 v3 规则**（最终版）：实现类子任务（desc 含实现词）零写操作且无"功能已就位"证据（已满足/已完整实现/无需改动等）→ failed；验证类任务豁免只看 desc（验证/走通/回归是动作，"确认 XXX 存在"是验收措辞不算）。

**决策：console.html UI 人类补写（ROADMAP §三 预设路径"人类/agent 皆可"）**。已实现：会话栏（`#sessionBar`）——「会话」按钮展开/收起、会话列表（高亮当前/消息数/✕ 删除）、＋新建、点击切换（GET /api/sessions/:id 取 uiHistory 还原画布）、删除当前会话自动切第一个。JS 语法验证通过，server 会话 API 全链路 curl 验证通过（POST 创建 c-mtbc6cw75904）。**T1 至此收口**：数据层（chat-session-store）+ server 会话 API + CLI 客户端（sessions-client.ts）+ console.html 前端 UI 全部就位。

**下一步**：A2 Compaction（上下文预算 + 摘要替换，50+ 轮不爆）→ A3 断点续跑。S 线：S2 云同步（18 键增量 + 会话游标）。

### A2 Compaction 完成（S5 尾，2026-08-27，commit 待定）

**实现**：新 `core/compactor.ts`（210 行）+ 挂载 `agent-loop.ts` 消息组装点（每轮 LLM 调用前检查预算）。

| 设计点 | 决策 | 理由 |
|--------|------|------|
| 预算 | 默认 60k 字符（可配 `budgetChars`） | 超阈值才触发，短任务零开销（真实实测确认不误伤） |
| 轮次边界 | assistant + 后续连续 tool；user 指令永不压缩 | prior 交错场景实测（轮间夹 user 消息保留） |
| 尾部保留 | 最新 minTailRounds=4 轮不压缩 | agent 需要近期上下文 |
| 摘要消息 | role:'user' + `[早期上下文摘要]` 标记 | 不碰 system 首位约束，跨 API 兼容；二次压缩自动识别已有摘要 |
| 预算循环 | 一批不够继续压（≤3 pass/轮） | 缩到预算内为止 |
| 降级 | 摘要 LLM 失败 → 原样返回，只 warn | 宁可爆上下文不破坏执行链 |
| 原文保留 | events.jsonl 逐轮全存（session.append 既有） | 摘要仅影响注入，可回放/审计；compaction 事件本身也入溯源 |

**验证（三层）**：
- 单测 6 用例（`test/compactor.test.ts`）：未超不触发/摘要替换/user 保留/轮间 user/摘要累积/失败降级
- 集成（`scripts/smoke-compaction.ts`）：真实 AgentLoop + mock 30 轮 fs_read（每轮 8k）→ **31 轮收敛，14 次压缩，消息量 240k→17k（压 93%）**，事件流 14 条 `[compaction]` 记录
- 真实 API：`--goal` 短任务 3/3 done（默认预算不触发，无回归）；全量测试 57/57

**启用方式**：AgentLoop 默认自动创建 Compactor（deps.compactor undefined=启用 / null=禁用 / 实例=自定义）。planner 子任务、console chat、CLI 全部自动继承，宿主零改动。

---

## 四、G8 第一靶子（候选，待俪宁选）

选真实模糊任务，让 agent 全程自主跑，卡点即下一轮开发清单。三个候选：

| 候选 | 任务描述 | 为什么合适 | 外部依赖 | 我的倾向 |
|------|---------|-----------|---------|---------|
| **T1 会话管理模块** | "console 加多会话功能：列表/切换/重命名/删除，历史持久化" | 纯本地闭环；数据层+API+前端+验证全链路；任务量刚好卡在"短循环跑不完"阈值 | 无 | ✅ **推荐** |
| T2 index.html 退役 | "把 index 剩余功能全部迁完，验证后删除 index.html" | 规模明确；但偏清理、拆解深度浅 | 无 | 可作 T1 后的热身 |
| T3 记账月报生成器 | "根据记账数据自动生成上月分析报告（分类占比/趋势/建议），落盘 md" | 产物类任务；但偏单线，拆解不够深 | 无 | 可作辅助验证 |

**选择标准**：任务必须有真实多步依赖（数据层→接口→UI→验证），单次 run() 跑不完、必须拆子任务——否则测不出 goal-level。

---

## 五、三条工作线

### A 线 · G8 长程自主（P0 主线）——唯一主线

| 阶段 | 内容 | 里程碑 |
|------|------|--------|
| A0 | 靶子任务定稿 + run 基线录制（当前 agent 跑 T1 的失败/卡点录像） | 卡点清单 |
| A1 | **Task Decomposition**（planner 层）+ 任务树落盘 | 能拆 + 能按序执行 |
| A2 | **Compaction**（上下文预算 + 摘要替换） | ✅ **完成**（2026-08-27，50+ 轮不爆实测通过，§三） |
| A3 | **断点续跑**（resume API + CLI flag） | 杀进程重启接着干 |
| A4 | **re-plan 自检** + 并行工具 | 中途失败不自爆 |
| A5 | **C2 自我更新**收口 | G8 实测通过 |

> 注：A1-A5 是**按卡点自适应**的顺序草案，不是死计划。每个阶段做完立刻拿 T1 实测，实测决定下一步。

### B 线 · console 宿主产品化（P1，与 A 线并行，可随时插队）

| # | 事项 | 说明 |
|---|------|------|
| B1 | **服务自启 + 崩溃拉起** | Windows 计划任务，开机自启；进程死亡自动重启。彻底告别手动拉起 |
| B2 | **会话持久化/多会话** | chatHistory 已落盘，多会话管理（新建/切换）未做——**与 T1 合并** |
| B3 | **index.html 退役** | 俪宁实测 console 功能完备后删除，仓库瘦身 |
| B4 | **push GitHub** | 本地已领先 origin 5 commits |
| B5 | **前端美化** | design tokens 体系（高级感风格，待 A 线空档期做） |

### C 线 · 技能生态、多 agent 协作与量化交汇（P2，A 线 G8 通过后启动；reviewer 只读配置可提前）

| # | 事项 | 说明 |
|---|------|------|
| C1 | 技能包规范固化 | life 包为样板，沉淀 pkg 开发文档 |
| C1.5 | **reviewer 只读配置**（代码审查 agent） | 引擎已支持，半天可做（§十）；"评审→修改闭环"等 A1 后并入 planner |
| C2 | **多因子交易 Agent**（个人北极星项目） | 在 PAA 之上构建：WorldQuant/Numerai 数据 → 因子库 → 组合 → 回测 → 报告。**依赖 A 线**（需要长程自主 + 并行 + 产物） |
| C3 | 更多 MCP 接入 | 按需（如 Google Calendar OAuth 双向） |
| C4 | **多 agent 协作收口** | builder/reviewer 双角色跑 T1 级任务，审查报告 JSON 闭环（§十） |

### D 线 · 产品化与分发（P3，G8 后启动；D0 profile 设计可与 S 线并行）

| # | 事项 | 说明 |
|---|------|------|
| D0 | 多用户 profile 设计 | 本地数据按 `data/users/<uid>/` 分区；与 S 线云端身份打通（§九柱 4） |
| D1 | **Tauri 桌面壳** | console 前端 + Node agent 服务（sidecar）打包：macOS `.app/.dmg` + Windows + Linux（§九柱 3） |
| D2 | **iOS 壳** | Capacitor 包 console → iOS app；手机远程访问本地 agent |
| D3 | 安装向导 + 分发 | 一键安装、首次配置引导（API key / 模型 / 云端登录可选），开源分发 |

---

## 六、数据层多端打通（OAuth 登录 + 云同步）—— 俪宁 2026-08-27 明确需求

**目标**：不同浏览器 / 不同设备，登录同一个 OAuth 账号后，看到的是同一份数据 + 同一份会话历史。

### 现状（读码确认）

- LifeStore：18 键分文件 JSON（`paa/data/life/*.json`），原子写 + 损坏自愈 + tx 事务；`cloudSync` 键已预留 `{url, key, enabled}`
- SessionMgr：`runs/<sid>/events.jsonl` 事件溯源，append-only（天然适合增量同步）
- **缺口**：无身份概念（单用户本地服务）、无云端、无同步协议

### 架构（推荐：本地为主 + 云端镜像 + 本地 server 代理）

```
浏览器A ──┐
浏览器B ──┼─ 127.0.0.1:8765（本地 server，数据主权仍在此）
手机/他机 ─┘        │
                    ├─ Supabase Auth（OAuth：Google/GitHub 登录 → user_id）
                    ├─ Postgres 云端镜像（按 user_id 分区）
                    └─ Realtime 变更订阅 → 本地 WS 广播给所有已连端
```

| 层 | 方案 | 理由 |
|----|------|------|
| 身份 | Supabase Auth OAuth（Google 登录） | 免费档、零自建、OAuth 原生支持；浏览器弹窗授权 → server 换 token |
| 云端存储 | Supabase Postgres：`life/<uid>/<key>`（rev 修订号）+ `sessions/<uid>/<sid>`（append-only） | 与本地 JSON/JSONL 一一对应，迁移成本低 |
| 同步单元 | **18 键逐键增量同步**（每键一个 rev，拉取/推送/合并）+ **会话事件游标增量**（events.jsonl 从 lastCursor 续传） | 复用 LifeStore 现有 tx/事件机制；append-only 会话天然无冲突 |
| 冲突策略 | 键级 LWW（rev + 时间戳） | 单人单键同时写概率极低；不做文档级 diff（过度设计） |
| 实时 | Supabase Realtime → server 收到云端变更 → 本地 WS 推给所有浏览器 | 本地 WS 基础设施已存在（v1.3 已用） |
| 离线 | 本地 JSON 仍为 source of truth；云端断连不阻塞本地写，恢复后后台补同步 | 符合"数据主权在 Node 侧"既有架构 |

### 里程碑（依赖：一个 Supabase 项目，免费档即可——俪宁注册或本地 CLI 自建）

| 阶段 | 内容 | 工作量 |
|------|------|--------|
| S1 | Supabase 项目 + Auth OAuth 配置 + server 登录端点（`/api/auth/login|callback|me`）+ 前端登录按钮 + user_id 落盘 | 2-3 天 |
| S2 | 18 键增量同步（rev + 拉取/推送/合并）+ 会话事件游标同步 + 冲突 LWW | ~1 周 |
| S3 | Realtime 跨端推送（云端变更 → 本地 WS 广播）+ 离线补同步 + 多浏览器实测 | ~1 周 |
| S4 | （可选）移动端访问 / 密码登录 / 多账号切换 | 按需 |

**排期建议**：S1 与 A 线 W1 并行（不阻塞、独立工作线）；S2-S3 在 T1 验收后集中做。**前置依赖唯一：Supabase 账号**。

---

## 七、节奏表（按会话数，慢速节奏——俪宁 2026-08-27 定：单轮执行多任务、线并行）

> 拍板记录：靶子 = T1 ✅｜push 立即 ✅（commit `08370e0`）｜节奏 = 慢速但单轮多任务并行 ✅｜S 线并行 ✅

| 会话 | A 线（主线） | B 线（并行） | S 线（云同步） |
|------|------------|------------|--------------|
| **S1（今天）** | ✅ **A0 基线录制完成**（卡点 K1-K4，见 §三） | ✅ B1 服务自启+看门狗、✅ B4 push | Supabase 账号准备（俪宁注册，给我 key） |
| **S2** | ✅ **K1 修复**（maxTokens 8192 + 分段写纪律）→ ✅ **A1 planner 实现**（`core/planner.ts`，`--goal` 模式，三次实测 100% 完成率，新卡点 K5 已闭环，commit `2d0117b`） | B2 会话管理 API（agent 种子已就位，人类补齐 server 端） | **S1 OAuth 登录**（server 登录端点 + 前端按钮 + user_id 落盘） |
| **S3** | ✅ **T1 二次实测**（暴露 K6 假阳性：5/5 标 done 实际 1/5，三根因已修复）→ A2 Compaction 顺延至 T1 重跑后 | B2 前端会话管理器 UI（T1 假 done，待重跑） | ✅ 教程已交付（docs/SUPABASE-SETUP.md）；✅ **俪宁已注册给 key（已验证有效）** |
| **S4** | ✅ **T1 三次实测**（K6 验证通过：假 done 5/5→≤1/跑；第三跑产出保留：server 会话 API + sessions-client.ts + 类型债 13→7；新卡点 K7 四根因）→ **K7 修复**（verify 时序/语义 + 拆解锚定 console.html + Windows 提示） | B2 console.html 前端 UI 收口（T1 唯一缺口） | **S1 OAuth 联调**（俪宁 dashboard 配置中 → server 登录端点 + 前端按钮 + user_id 落盘） |
| **S5** | ✅ **A2 Compaction 完成**（2026-08-27：compactor.ts + agent-loop 挂载，单测 6 用例 + 集成 31 轮压 93% + 真实 API 回归 3/3）→ **A3 断点续跑**（任务树落盘+resume）→ A4 re-plan | B3 index 退役 | S2 收尾 + S3 Realtime |
| **S5** | T1 三次实测（完成率 → 100% 冲刺）→ A5 C2 收口 | B5 美化（可选） | S3 多浏览器实测 |
| **S6** | **G8 验收**：T1 全流程 0 插手完成 = 绿灯 | — | 全端打通验收 |
| **S7（Phase C 起）** | 多 agent 协作：reviewer 只读配置 → 评审→修改闭环 → C2 交易 Agent | D0 profile 设计（与 S 线打通） | 云端身份 → 多用户 profile 映射 |
| **S8（Phase D 起）** | — | **D1 Tauri 打包**（macOS .app/.dmg）→ D2 iOS 壳 → D3 分发 | 多设备实测 |

> **最终形态验收（§九）**：任何人在自己电脑装好安装包 → 双击打开 → 本地 agent 上线 → 任意浏览器打开前端可用 → （可选）登录云账号多端同步 → 这就是"OpenClaw 式 + 浏览器前端 + 苹果安装包 + 人人可用"的完整闭环。

**验收纪律**：每次 T1 实测记录完成率（子任务完成数/总数）与卡点，完成率决定下一会话做哪个能力。G8 通过 = 完成率 100% + 中途 0 人工插手 + 产物真实可用。慢速 = 会话间隔随意（1-7 天），每会话内多线并行推进。

---

## 八、决策点（2026-08-27 已拍板：1/2/4/5）

| # | 决策 | 选项 | 结果 |
|---|------|------|------|
| 1 | G8 第一靶子 | T1 会话管理 / T2 index 退役 / T3 月报生成器 | ✅ **T1**（A0 已跑，种子就位） |
| 2 | B4 push 时机 | 现在推 / 等 B3 一起推 | ✅ **现在推**（commit `08370e0`，已推送） |
| 3 | B1 服务自启 | 计划任务现在配 / 等 W1 | ✅ **已配**：启动文件夹快捷方式（开机）+ schtasks 看门狗（每 5 分钟，`PAA-Console-Watchdog`） |
| 4 | A 线节奏 | 密集 / 慢速 | ✅ **慢速但单轮多任务并行**（按会话推进，见 §七） |
| 5 | 云同步 S 线 | W1 并行 / G8 后 | ✅ **并行启动** |
| 6 | Supabase 账号 | 俪宁注册 / 本地 CLI / 先不做 | ⏳ **待俪宁注册**（唯一前置阻塞项） |

---

## 九、最终形态愿景（2026-08-27 俪宁定调）——PAA 不是玩具，是产品

> 俪宁原话：**"这个项目我希望最终形态是 agent 活在本地（类似 OpenClaw 的能力）；有一个任何浏览器都能打开的前端；和电脑软件/手机程序适配苹果的安装包；并且对于所有用户都能使用。"**

### 产品形态定义（四根柱子）

| # | 柱子 | 含义 | 对应现状 | 差距 |
|---|------|------|---------|------|
| 1 | **本地 agent 核心（OpenClaw 式）** | agent 以常驻守护进程活在用户自己电脑上：自主循环 + 技能系统 + 记忆 + 多模型 + 无云依赖 | PAA CLI/console（大脑层已具备） | 长驻 daemon 化（守护 + 任务队列 + 崩溃自愈，服务自启已配一半） |
| 2 | **任意浏览器前端** | 打开 `http://localhost:8765` 即可用，不装任何东西；远程访问时走隧道 | console v1.3（chat + 8 面板，已可用） | 会话管理（T1）、美化（B5） |
| 3 | **苹果安装包** | macOS `.app/.dmg` + iOS 应用（适配手机），一键安装 | 无 | **Tauri 桌面壳**（Phase D1）+ **iOS 壳**（Phase D2） |
| 4 | **对所有用户可用** | 开源分发：任何人装好即用（自己的本地 agent），非仅俪宁个人工具 | 单机单用户 | 多用户 profile（Phase D3）+ 安装向导 + 分发 |

### 形态演进路线（补进节奏表）

- **Phase C 内嵌**：D0 多用户 profile 设计（云端身份已有 Supabase Auth 铺垫；本地数据按 profile 分区 `data/users/<uid>/`）——不阻塞 A 线
- **Phase D1 · Tauri 桌面壳**（G8 后）：console 前端包进 Tauri（Rust 壳 + WebView），产出 macOS `.app/.dmg` + Windows `.exe` + Linux；**Tauri 壳里直接跑 Node agent 服务**（sidecar 进程），用户双击图标 = agent 上线
- **Phase D2 · iOS 壳**（D1 后）：Capacitor 包 console WebView 成 iOS app（App Store 分发或 TestFlight）；手机访问本地 agent 走局域网/隧道
- **Phase D3 · 多用户**：本地单实例多 profile（每用户独立数据/记忆/会话），与 S 线云端身份打通（登录 = 选 profile）

> 注意：① 多端同步（S 线 §六）与"多用户"是两件事——S 线是**同一个人**多设备同步；D3 是**不同人**在同一台/不同机器上各自独立使用。② 本地 agent 的产品哲学 = 数据主权在用户（OpenClaw 同款），云端只做可选的同步与身份，永远不是必要依赖。

---

## 十、多 agent 协作（代码审查 / 优化 / 功能拓展）—— 2026-08-27 俪宁规划

> 俪宁原话：**"我后续会引入其它 agent 做代码审查与优化、功能拓展。这个在哪个 phase 怎么实现？"**

### 定位：这不需要新引擎，是现有引擎的"角色复用"

PAA 的循环引擎（AgentLoop）本身就是**宿主无关 + 工具注入**的。评审 agent 和开发 agent 是**同一个引擎、不同配置**：

```
同一 AgentLoop 引擎
├─ builder agent（主）：工具白名单 = 全量（读/写/shell/记忆/产物）
└─ reviewer agent（评审）：工具白名单 = 只读集（fs_list/fs_grep/fs_read/fs_check）
     + system prompt = "你是代码审查员：只读代码、输出问题清单 JSON，禁止修改任何文件"
```

| 维度 | builder（主 agent） | reviewer（评审 agent） |
|------|--------------------|-----------------------|
| 工具 | 全量（含写） | **只读**（无 fs_write/patch/shell） |
| system prompt | 执行者人格 + 硬纪律 | 审查者人格 + 输出规范（问题清单 JSON：严重度/位置/理由/修法） |
| 产出 | 代码/产物 | **审查报告**（结构化 JSON，落 artifacts/） |
| 权限 | Autonomy 分级照常 | **L0（永远询问）+ 写工具不存在**——物理上改不了代码 |

### Phase 归属：Phase C（G8 之后第一批），但有一半可以先做

| 子能力 | 依赖 | 最早可做 | 说明 |
|--------|------|---------|------|
| reviewer 只读配置 | 无（引擎已支持） | **现在就能做**（半天：一个 agent 配置文件 + 只读工具白名单） | 但"评审结果喂回 builder 再修改"闭环依赖 A 线（跨 run 传递评审意见） |
| 评审→修改闭环 | ① planner（跨任务传 prior） | **A1 完成后** | planner 的子任务队列天然支持：t_n 实现 → t_{n+1} 评审 → t_{n+2} 修改 |
| 独立 agent 进程协作 | G8 + 进程间通信 | Phase C | 多 agent 并发跑（如 2 个 reviewer 分模块审），结果聚合 |
| 社区贡献（他人写 agent/技能） | D 线开源后 | Phase C-D | pkg-loader 已是标准接口：外部 agent = 标准 ToolPkg + 标准只读配置 |

### 落地形态（Phase C 具体方案）

1. **agent 角色配置化**：`paa/agents/reviewer.json`（工具白名单 + system prompt 模板 + Autonomy=0），与 builder 同引擎、同 CLI——`node cli/main.ts --agent reviewer --once "审查 core/planner.ts"`。**一个 CLI flag 就是新角色**，不需要新代码
2. **评审循环**：planner 任务树里加 `type: "review"` 节点 → 该子任务用 reviewer 配置跑 → 产出审查报告 JSON → 后续子任务（builder）把它作为 prior 输入 → 修改 → 再评审（≤2 轮收敛）
3. **功能拓展 agent**：本质同 reviewer——外部开发者按 `paa/agents/*.json` 规范声明角色即可，pkg-loader 加载技能，agent 角色加载"人格+白名单+输出规范"。**"引入其它 agent" = 写一个 JSON + 一个工具包，不是改框架**

### 外部 agent 协作（2026-08-27 俪宁追加：Codex 入场）

> 俪宁原话：**"这个项目我后面会让你和 Codex 一起做，因为我有 GPT Pro 了。不过原本 agent 的代码审查也是需要的，agent 能力也要强化。"**

- **协作模式定调**：WorkBuddy（枢）负责 core/ 大脑层与 G8 主线（上下文连续、实测迭代）；**Codex（GPT Pro）负责独立功能模块/大规模重构/类型债清理**（大上下文适合整块交付）。分工细则见仓库根 `AGENTS.md`
- **交接入口**：`AGENTS.md` 是给任何 agent 的协作入口（架构地图/运行命令/纪律/分工表），Codex 进项目先读它 + `docs/ROADMAP.md`
- **内置 reviewer 仍是刚需**：独立于外部 Codex——它是 PAA 产品自身能力（agent 能审自己的代码），也是"评审→修改闭环"的一部分。**已于 S3 提前落地**（见 §三 A1 之后记录）
- **冲突防线**：core/ 是框架心脏，两个 agent 同时动会踩——改 core/ 前看 `git log --oneline -5` 与 ROADMAP 最新进度，或先问俪宁

---

## 十一、一句话总结

> 能力清单（G1–G7）打完了，从今天起 PAA 只有一件事：**让 agent 把一个模糊大目标从头到尾自己干完**（G8）。靶子已就位（T1），缺什么就造什么（六件套补满路径见 §三），造完立刻再跑。数据层多端打通（§六）独立并行。**最终形态 = 本地 OpenClaw 式 agent + 任意浏览器前端 + 苹果安装包 + 人人可用**（§九），多 agent 协作是现有引擎的角色复用（§十）。G8 绿灯之前，不谈"Codex 级"。
