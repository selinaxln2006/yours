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
