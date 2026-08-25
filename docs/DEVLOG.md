# PAA 开发者日志（DEVLOG）

> Personal AI Agent Framework — 从生活工作台 v0.6.1 生长出的 Agent 大脑
>
> 纪律：日志与代码同生，不是事后补写。每个 Phase 的设计、实现、踩坑、反思都在这里。

---

## Phase 0.0 — 方向确立与架构蓝图（2026-08-17）

### 做了什么

确定了 PAA 的终极形态和实现节奏。不是"给生活工作台加个 AI 功能"，而是**设计一个独立的 Agent 大脑，生活工作台只是它的第一个宿主**。

参考了两个开源 Agent 框架的深度拆解（完整对比见设计文档附录）：

- **DS Harness**（DeepSeek 开源，TypeScript）：Cordis IoC 插件架构 + ReactLoopAgent（Turn/Step 双层循环 + Inbox 消息注入）+ Waterfall 工具管道 + Event-Sourced 会话
- **Operit**（Android，Kotlin）：PluginRegistry + ToolPkg（JSON+JS 工具包，社区生态钥匙）+ 三级权限（ALLOW/ASK/FORBID）+ 20+ LLM Provider + MCP 支持

### 设计决策

**1. 四大能力支柱作为架构中心（而非功能清单）**

| 支柱 | 内容 | 来源 |
|------|------|------|
| C1 产物 | Agent 创建文档/代码/数据，有存储有视图有版本 | WorkBuddy 的 artifact 体验 |
| C2 自我更新 | Agent 写新工具、改自己 prompt、装技能包 | DSH Code Mode + Operit ToolPkg |
| C3 外部资源 | ToolPkg 动态加载、MCP、HTTP | Operit MCPManager |
| C4 外部记忆 | 记忆独立存储、导入导出、检索注入 | WorkBuddy memory + DSH Compaction |

依赖关系决定了实现顺序：记忆 → 产物 → 资源 → 进化。

**2. 单层循环而非 Turn/Step 双层**

DSH 的 Turn/Step 双层 + Inbox 很优雅，但那是为多用户 CLI 服务设计的。PAA 是个人 Agent，选 Operit 式单层循环（LLM → 工具 → LLM 直到无工具调用）+ abort 接口预留。复杂度留给真正需要的时候。

**3. 权限分级而非一刀切**

现在（v0.6.1）所有写操作都要确认，太烦。改为：内置 life 包 13 个记录类工具 ALLOW；产物创建/更新走确认；外部 ToolPkg 首次 ASK 可"总是允许"；memory.forget 和自我更新永远确认不可降级。参考 Operit 三级权限但砍掉 FORBID（个人 Agent 用不到）。

**4. 差异化定位（Phase 0.1 后追加，俪宁拍板）**

- 主叙事：**记忆主权**——开放记忆格式 + 导入导出 + 跨 Agent 迁移。市面记忆锁死在自家生态，这是真实空白
- 推论：**可携带（portable）而非"宿主无关"**——大脑零宿主依赖是技术承诺（任何宿主 register() 就能跑，记忆随宿主迁移），但记忆内容深度绑定宿主本人（见决策 7 修正注记）
- 明确不做：兼容 Operit 技能包生态（格式自研，参考思路不兼容格式）

**5. 记忆检索 v1 用关键词，不用向量**

PWA 环境跑 embedding 太重（要么上 WebGPU 模型要么调 API）。关键词检索（分词 + 标签匹配）对几百条记忆的个人场景完全够用。向量检索留 v2 接口。注意：记忆格式本身要为向量检索预留字段空间（id/type/tags/content 结构本身就是 v2 友好的）。

**6. 三文件分界维持单文件物理形态**

大脑层与宿主层在概念上分离（注释分界 + 命名空间），物理上仍是 index.html 单文件。到代码超过 ~300KB 或需要 import() 动态加载 ToolPkg handler 时再拆。

### 代码地图

本 entry 无代码改动。产出：

- `docs/architecture/paa-design-v2.md` — 架构设计 v2（四支柱 + 节奏表 + 差异化定位）
- `docs/DEVLOG.md` — 本文件

### 踩坑

（无）

### 反思 / 下一步

节奏表定为 P0 骨架（AgentLoop/ToolPipeline/LLMAdapter）→ P1 记忆 → P2 产物 → P3 资源 → P4 进化 → P5 流式（可选）。每个 Phase 走"设计讲解 → 实现 → 联测 → 收尾"四小步。

下一步：Phase 0.1 —— 给俪宁讲清楚 Agent 循环的本质设计，确认后开始重构 v0.6.1 的编排层。

---

## Phase 0.1 — Agent 循环设计讲解与方向拍板（2026-08-17）

### 做了什么

给俪宁讲清了 Agent 循环的三层理解（Level 0 心脏循环 → Level 1 三个隐藏难点 → Level 2 DSH Inbox 预告），并收到她的方向拍板。

俪宁自学补充（元宝对话记录）：Agent 循环的层次划分（常识级/工程经验级/巧思/先进）、Inbox 与各家插话方案对比（AutoGPT 打断重来 / Cursor 等轮结束 / DSH Inbox / Claude Code Plan-Execute / LangGraph 中断点 / Swarm 多 Agent）、while 循环 vs 图框架的成本取舍、混合架构路由（简单走循环、复杂上图）的可行性。

### 设计决策

**7. 差异化叙事确定为"记忆主权 + 深度个人化 + 可携带"，不做 Operit 兼容**

俪宁原话："记忆主权的话自然而然可以构建一些宿主无关系统，不需要兼容 openrit"。

⚠️ 修正注记（2026-08-17 Phase 0.2 前）：俪宁纠正了"宿主无关"的表述——**Personal Agent 应该是越来越懂宿主的**（记忆内容深度绑定俪宁本人：目标/偏好/决策史/行为模式），如果积累的是"越来越懂其它东西"的通用知识，那就是通用 memory，没有护城河。技术层的解耦只是"可携带"（记忆随宿主迁移），不等于价值层的"无关"。正确表述：**可携带而非无关——运行层解耦（可迁移），记忆层深绑（个性化）**。

推论：
- 记忆格式设计红线：不依赖任何宿主、LLM Provider、存储实现（但内容主语是俪宁这个人）
- 记忆主权 = 你拥有你的记忆（可导出、可迁移）+ 你的记忆深度是关于你的（别人拿不走也复制不了）
- 技能包格式自研（参考 Operit JSON+JS 思路，但不做生态兼容）
- 主叙事单一性：兼容别人 = 交出设计主权

**8. 三个循环难点方案获确认**

- 协议差异封装在 LLMAdapter 内（循环协议无关，差异推到边缘）
- 中断用合成结果喂回消息流（DSH 思路简化版）
- 终止条件三重保险：maxRounds + maxTokens + 重复调用指纹检测

**9. 混合路由（简单/复杂）暂缓，留作后续观察**

俪宁提出"复杂度判断做成 tool 让 Agent 自己决定"，元宝建议 P0 不做。共识：等积累"循环搞不定"的真实案例再上。现有 PLAN_RE 路由是其雏形。

### 代码地图

无代码改动。产出：

- `docs/architecture/paa-design-v2.md` — 新增"差异化定位"小节，ToolPkg 格式标注为自研
- `docs/DEVLOG.md` — 本 entry

### 踩坑

（无）

### 反思 / 下一步

创新性讨论的种子已埋下（元宝对话中的"真正先进"层级）：多 Agent 协作、自动规划分解、自我纠错闭环。P4 自我更新是自我纠错闭环的第一步。

下一步：Phase 0.2 —— 开始重构 v0.6.1 编排层（LLMAdapter + ToolPipeline + AgentLoop 三件套）。

---

## Phase 0.2 — 编排层三件套重构（2026-08-17）

### 做了什么

把 v0.6.1 的 Agent 编排层（6 轮硬循环 + 裸 dispatch）重构为三件套：**LLMAdapter（协议封装）+ ToolPipeline（工具管道）+ AgentLoop（健壮循环）**。Agent 变薄壳，行为对齐现状（readOnly 自动执行、写操作入计划卡），但内核支持 abort、重复检测、可配轮数。SW v9 → v10。

### 设计决策

**10. 记忆价值分层：领域知识层 + 宿主画像层（俪宁 Phase 0.2 前澄清）**

俪宁原话："如果它关注的是某个特定领域 它也可以是某领域通用agent的通用memory"。这纠正了我对"越来越懂宿主"的单一理解——记忆的价值是分层的：

- **领域知识层**（可跨用户复用）：如生活管理领域的沉淀（减重方法论、睡眠科学、习惯养成），一个特定领域的 agent 记忆库本身就是该领域通用 memory——这是可复用性/商业化潜力的来源
- **宿主画像层**（深度个人化）：俪宁的目标/偏好/决策史/行为模式，不可替代
- 两层不矛盾：P1 记忆 schema 的 type 字段按此设计（计划新增 `domain-knowledge` 类型，区别于 `fact`/`preference`）

**11. LLMAdapter 吸收 _toolMsg**：工具结果消息格式（OpenAI `tool` / Anthropic `tool_result`）本质是协议差异，从 Agent 移入 `LLMAdapter.toolMsg`。Agent 彻底不碰协议。

**12. ToolPipeline P0 只分读写，顺带修复隐性 bug**：v0.6.1 中 `tool&&tool.readOnly` 为 false 时（含未注册工具）会误入计划卡，执行时才报错。现在未注册工具直接返回错误喂回模型——模型能立刻自我纠正，不污染计划卡。

**13. AgentLoop 三重终止保险落代码**：maxRounds（默认 10，原 6 轮硬编码）+ 连续 3 次相同 tool+args 指纹强制终止 + abort()（AbortController）。中断语义：LLM 请求中断返回 aborted=true；已入队的写操作保留给用户确认，未执行的不会被幻觉成"已执行"（DSH 合成结果思路的简化版）。

### 代码地图

- `index.html`（单文件内，仍为一个物理文件）：
  - 新增 `LLMAdapter`（chat / toolMsg / _openai / _anthropic，从 Agent 平移 + signal 透传 + maxTokens 可配）
  - 新增 `ToolPipeline.run(fn,args)`（before 读写分权 → execute dispatch → after 统一返回）
  - 新增 `AgentLoop`（run / abort，重复指纹检测 + AbortController，active 实例暴露给 abort()）
  - `Agent.plan` 改为委托 `AgentLoop.run(text,{sys,maxTokens})`；`callLLM/_openai/_anthropic/_toolMsg` 删除；`executePlan/dropPlan/isPlanning/_refreshMods` 原样保留
- `sw.js`：CACHE v9 → v10
- 语法验证：提取内联 JS（186003 字符，2 个 script 块）`node --check` 0 错误

### 踩坑

（无新坑。注：v0.6.1 的"未注册工具误入计划卡"是本次重构顺带修复的存量 bug，记录在决策 12。）

### 反思 / 下一步

P0 骨架三件套就位，行为对齐现状。真正的考验在 X.3 联测：配好 API 实测"帮我减重 15 斤"规划链路，重点观察：① 重复检测不误伤正常的多参数 add_todo 调用；② abort 后计划卡状态正确；③ Anthropic / OpenAI 双协议都通。

下一步：X.3 联测（俪宁配 API 实测）→ X.4 收尾（DEVLOG 反思 + git commit + push）。

---

## P0 v2 — 骨架四件套 TypeScript 重写（2026-08-24）

> 背景：俪宁 08-24 裁决——PAA 按 v2 设计文档自研实现（循环/状态/格式自研），DSH/Operit/TencentDB 只在"设计思想"位被参考，不得 import 其 core。旧 `paa/src/*.js`（学生级轮子）冻结留档。流程宪法 `docs/architecture/paa-dev-process.md` 同日生效（X.1→X.4 四审核点）。

### 做了什么

- `paa/core/` 四件套（TS，零运行时依赖，Node 24 原生 type-stripping 直接跑）：
  - `types.ts`：核心类型（ChatMessage/ToolCall/ToolDefinition/ExecContext/MemoryRecord/SessionEvent/LoopResult）
  - `permission.ts`：risk 1-4 分级 × Autonomy L0-L4；risk 4（危险）永远 ask 不可降级
  - `llm-adapter.ts`：LLMAdapter 接口 + OpenAICompatibleAdapter（DeepSeek 实测连通）+ tools schema 转换 + 工厂
  - `tool-pipeline.ts`：注册表 + before(权限门+审计) → execute → after(审计) 管道
  - `session-mgr.ts`：JSONL 事件溯源（append/load/list）
  - `agent-loop.ts`：单层循环 + abort() + inject()（预留）+ maxRounds + 每轮记忆检索钩子（P1 接入）
- `paa/tools/core-tools.ts`：6 工具（fs_read/fs_write/fs_append/fs_patch/fs_list/shell_run），root 沙箱 + shell 黑名单
- `paa/cli/`：render.ts（ANSI 卡片渲染）+ main.ts（交互循环 + `--once` 非交互单次执行）
- `paa/test/`：smoke.ts（8 项：权限门/唯一匹配/黑名单/越界/会话/拒绝）+ agent-loop.ts（mock LLM 编排 2 轮收敛）

### 设计决策

- **工具名去点号**（fs.read → fs_read）：DeepSeek/OpenAI 兼容 tools API 的 function.name 只允许 `^[a-zA-Z0-9_-]+$`，实测 400。这是对标时该想到的：Operit/DSH 工具名均无点。
- **handler 契约 = 纯数据 + throw**：pipeline 统一 catch 转 `{ok:false}`。曾出现双层包装 bug（handler 返回 `{ok:false}` 被外层又包成 `{ok:true}`），冒烟测试当场抓住——单测的价值实证。
- **Node 24 strip-only 限制**：不支持 TS parameter property（`constructor(private x)`），全部改显式字段声明。这是运行时约束，typecheck 层面看不出来，只有跑起来才知道。
- **CLI 输入用 for-await 迭代器**：question() 在异步初始化（读 config）后调用时 stdin 已 EOF 会丢输入；迭代器在 readline 创建时即缓冲。附赠 `--once` 模式（Codex CLI 同款非交互执行，未来脚本/集成可用）。
- **循环选单层 + abort**（v2 决策）：不引入 DSH 式多层 Turn/Step 状态机，保持"一轮 = LLM 往返 + 若干工具 step"，abort 在下一检查点生效。

### 代码地图

```
paa/
  core/{types,permission,llm-adapter,tool-pipeline,session-mgr,agent-loop}.ts
  tools/core-tools.ts          # 6 内置工具
  cli/{main,render}.ts         # 入口 + 渲染
  test/{smoke,agent-loop}.ts   # 8+1 项测试
  config.json                  # 复用旧 DeepSeek key（apiUrl/apiKey/model）
  runs/<sessionId>/events.jsonl
```

### 踩坑（真实记录）

1. strip-only 不支持 parameter property → 显式字段
2. tools function.name 带点 → 400 → 去点号
3. handler 双层 ok 包装 → 契约统一为 throw
4. PowerShell 管道 stdin 在异步初始化期间 EOF → for-await + --once
5. render.ts 卡片曾取不到工具参数（事件 payload 缺 arguments）→ agent-loop 补存

### 验证结果（X.3 自测段）

- `tsc --noEmit`：0 错误
- `test/smoke.ts`：8/8 ✅（权限门 L2/risk3 触发 ask、非唯一 patch 拒绝、黑名单拒绝、越界拒绝、会话溯源、用户拒绝）
- `test/agent-loop.ts`：2 轮收敛 / 1 次工具 / 事件溯源 4 条 ✅
- 真实 LLM：`--once "Say hi"` → DeepSeek 回复 ✅
- 真实工具闭环：`--once "读 package.json"` → LLM 自主调 fs_list → 回喂 → 收敛回答（并纠正"根目录无 package.json"的前提）✅

### 反思 / 下一步

- 这是第一次"设计文档 → 流程宪法 → 逐部件实现"的完整闭环。与旧 CLI 的本质区别：每个部件都有对标依据（写在文件头注释），不再是从零拍脑袋。
- 记忆系统（P1）是下一步：Memory 数据模型 + 4 工具 + 自动注入 + 导入导出（记忆主权红线）。AgentLoop 的记忆检索钩子已留好（memoryProvider 接口）。
- 待俪宁实测验收（X.3 正式段）：交互模式跑真实任务，验收 G1/G2/G3 + 权限确认体验。

---

## P0 v2.1 — X.3 正式段实测后修订（2026-08-24）

> 背景：俪宁实测"测试你的能力上限和下限"——真实验证到 G1 fs 闭环 ✅ + 测试 8/8 ✅ + 自诊断闭环（agent 从 findstr 失败自学习、node -e 绕行）✅；同时暴露 shell 在 Windows 基本废（pwd/head/grep/which 全挂、GBK 乱码）、12 轮耗尽裸停、任务漂移、确认疲劳。

### 修订（5 项）

- **P0-A fs_grep 加回**：正则搜索（JS 语法），文件/目录通用，自动忽略 node_modules/.git/dist/build/runs，risk 1 自动放行。旧 CLI 有此工具（G3 验证过），v2 重写时遗漏——流程失误，认。
- **P0-B 系统提示注入平台纪律**："Windows/cmd：pwd/ls/cat/grep/head 不存在；文件操作走 fs 工具；shell 只跑 node/npm/git/tsc；避免中文输出（GBK 乱码）"+ 任务聚焦纪律（一次一目标、先定义完成标准、探索定步数预算）。
- **P0-C 耗尽给阶段总结**：AgentLoop 每轮收集中间说明 + 工具成败统计，maxRounds 耗尽/中断时输出摘要（过程/失败项/未完成项），替代裸停。
- **P1-D ask 支持 a=always allow**：`ExecContext.ask(prompt, toolName?)` 加可选参数（测试 mock 天然兼容），CLI 维护 trustedTools 会话级集合，新增 `/trust`、`/trust clear` 命令。
- **P1-E shell_run 合并 stderr**：成功时 stderr 也返回（`[stderr]` 段）；编码已知限制标注。

### 验证（X.3 修订自测段）

- `tsc --noEmit`：0 错误
- `test/smoke.ts`：8/8 ✅（ask 签名兼容性无破坏）
- `test/agent-loop.ts`：2 轮收敛 ✅
- 真实 LLM：`--once "用 fs_grep 在 docs/DEVLOG.md 搜索 P0 v2"` → agent 自主调 fs_grep → 准确报告第 169 行，1 轮收敛 ✅

### 反思

- 这次修订的价值：**G3 闭环用在了自己身上**——实测暴露的问题全部来自"agent 在 Windows 上按 Unix 习惯操作"，而修复方案（fs_grep + 平台纪律）正是旧版验证过的能力，属于"该复用未复用"。教训：工具集迁移时逐项对照旧清单，不凭记忆。
- 待俪宁重测同指令：验收标准 = fs_grep 检索 / shell 只碰 node-npm-git / 耗尽有总结 / 确认 ≤3 次。

---

## P1 v1.1 — C4 记忆系统正式落地（2026-08-25）

> 背景：俪宁提出两个设计质疑——① 每条会话都存原文，维护成本 + 回忆 token 会不会爆炸；② 大模型认知与人脑架构相似，memory 是否可模仿 CNN。三轮研究结论：
> - **CNN 不做**：权重即记忆 = 模型训练，黑盒不可审计不可导出，违反记忆主权
> - **人脑正确类比**：分层 + 巩固 + 稀疏激活（Atkinson-Shiffrin / 海马体巩固 / 稀疏检索）——恰好验证分层设计
> - **Graphiti（Zep 底层）三层**：Episodic 原文 / Semantic 实体事实 / Community 摘要。关键洞察：**存储不花钱，注入才花钱**——原文全量存但永不进上下文

### 做了什么

- **types.ts**：MemoryRecord 扩展（layer L0-L3 / type 加 persona / sourceRef / validAt / invalidAt，向后兼容）；MemoryProvider 接口扩展为 search+save+list+forget+consolidate+exportAll+importAll
- **core/memory-provider.ts**（新）：JsonMemoryProvider——JSON 文件存储（paa/memory/store.json）+ 原子写（tmp+rename）+ 损坏自愈（备份后重建）+ 分层检索（L3 常驻 2 条 → L2 标签匹配 top2 → L1 关键词补足，**L0 永不注入**）+ save 自动失效（同 tag+type 内容不同旧记录 invalidAt）+ consolidate（agent 摘要、provider 记账、源记忆失效）+ export/import（记忆主权）+ L3 画像种子（createDefaultPersonaSeed，6 条从 WorkBuddy MEMORY.md 编译）
- **tools/memory-tools.ts**（新）：5 工具注册——memory_search/list（risk 1 自动）/ memory_save（risk 2）/ memory_consolidate（risk 3）/ memory_forget（risk 4 永远确认）
- **cli/main.ts**：provider 构造注入 AgentLoop（P0 预埋钩子接通）+ 记忆纪律入 system prompt + 启动显示记忆条数 + `--export-memory` / `--import-memory` 独立命令
- **paa-design-v2.md**：C4 章节加 P1 v1.1 修订段（分层模型 + token 预算 + 升级路径）

### 设计决策

- **工具名用下划线不用点号**：LLM function calling 硬约束 `^[a-zA-Z0-9_-]+$`——`memory.search` 直接 400，`fs_read` 用下划线所以 P0 一直没踩到。这是端到端实测才暴露的（单元测试全过）。
- **save 是 risk 2 不是 risk 3**：记忆是内部动作（大胆），结构变化（consolidate）才确认，遗忘永远确认。
- **provider 层也做 layer/type 校验**：纵深防御，tools 层与 provider 层双保险。

### 验证结果

- `tsc --noEmit`：0 错误
- `test/memory.ts`：10/10 ✅（种子/save/自动失效/分层检索/L0 永不返回/forget/consolidate/export-import 幂等/损坏自愈/L0 开关/非法输入）
- 真实 LLM 端到端：`--once "用 memory_search 检索俪宁职业方向"` → agent 自主调 memory_search → 返回 2 条 L3 画像 → 结构化总结（量化主线/产品支线/MFE 出口）✅
- `--export-memory`：格式完整（version/exportedAt/records）

### 反思

- **单元测试通过 ≠ API 兼容**：工具名带点号是 10 个单测全过后端到端 400 才暴露的。教训：注册进真实 LLM 链路的工具命名必须从一开始就按 provider 约束设计（下划线），测试要覆盖"发往真实 API 的 schema"。
- 分层检索的 L3 常驻策略效果明显：agent 第一轮对话就"懂你"（画像种子），不需要从零积累。
- 上图信号（>500 条/关系密集/时间线追溯）未触发，v1 不背图数据库成本。

---


