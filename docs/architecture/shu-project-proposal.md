# Shu Personal Agent 项目建议书

> 来源：俪宁 2026-08-21 提供的外部建议文档（原文存档）
> 关系：与 `paa-design-v2.md`（大脑设计）、`paa-host-evolution-v1.md`（宿主演进）互为印证。
> 本文件为**原始文档存档**；我们的路线映射与差异分析见对话记录与 MEMORY.md。

---

## 一、项目定位

### 项目名称

**Shu**（暂用名，后续可重新品牌命名）

### 核心定位

> **Shu 是一个持续存在、逐渐了解用户、能够调用用户工具与数据并自主完成任务的 Personal Agent。**

当前的「生活工作台」不是最终产品，而是 Shu 的**第一个应用界面与能力载体**。

```text
当前：
Shu Life Workbench
        ↓
未来：
Shu Personal Agent
        ↓
       Core
   ┌────┼────┐
Memory Skills Tools
   └────┼────┘
      Agent
        ↓
      Action
```

项目不应长期停留在"AI 记账/待办/健身 App"的产品定位。

---

## 二、产品愿景

Shu 最终希望解决的问题不是：

> "帮用户记录生活。"

而是：

> **让一个 Agent 持续理解用户的状态、目标、偏好和历史，并在授权范围内帮助用户规划、执行、观察和调整。**

与传统 Productivity App 的核心区别：

| 传统 App | Shu |
| -------- | --- |
| 用户操作功能 | 用户与 Agent 协作 |
| 用户主动记录 | Agent 可以理解自然语言并记录 |
| 数据孤立 | 数据形成长期 Context |
| Todo 是静态列表 | Todo 是目标的一部分 |
| Calendar 是日程表 | Calendar 是 Agent 的执行工具 |
| Goal 是用户填写的目标 | Goal 可以被 Agent 分解、追踪、复盘 |
| Chat 是附加功能 | Agent 是核心交互层 |
| Memory ≈ 历史记录 | Memory 是 Agent 的长期状态 |

---

## 三、当前版本定位：Prototype，而不是 MVP

3 天冷启动版本已具备相当完整的产品原型：

```text
Life Index / Finance / Fitness / Wellness / Calendar / Todo / Goal
AI Assistant / PWA / Local Storage / Import-Export
BroadcastChannel / Hybrid Parser
```

目前最重要的不是继续疯狂加功能。当前版本的主要价值是验证：

1. 用户数据模型是否合理
2. 各模块之间能否互相联动
3. 自然语言能否进入结构化操作
4. Goal → Milestone → Todo 是否成立
5. Agent 作为统一入口是否比传统 UI 更自然
6. Local-first 产品形态是否适合长期使用

**这部分已经完成了第一轮验证。**

---

## 四、产品架构建议

从现在的单文件：

```text
index.html
 ├─ UI
 ├─ Business Logic
 ├─ Storage
 ├─ Agent Parser
 └─ PWA
```

逐步演化成：

```text
                    Shu
                     │
              ┌──────┴──────┐
              │  Agent Core │
              └──────┬──────┘
                     │
     ┌───────────────┼────────────────┐
     │               │                │
  Context          Memory           Policy
     │               │                │
     └───────────────┼────────────────┘
                     │
                  Planner
                     │
              Skill / Tool Registry
                     │
        ┌────────────┼────────────┐
        ↓            ↓            ↓
      Life         Calendar     External
      Skills        Skills        Tools
        │
        ↓
   Execution Layer
        │
        ↓
      Storage
```

其中最重要的是：

> **UI 不应该成为 Shu 的核心。** UI 是 Agent 的一个 interface。

未来可以有 Web / Desktop / Mobile / Chat / Voice UI，而底层仍然是同一个 Shu Core。

---

## 五、Agent Core 是整个项目的下一阶段核心

目前 `agentParse()` 更接近 Natural Language → Intent。未来应升级为：

> Natural Language → Agent Context → Reasoning → Planning → Execution → Observation → Memory

```text
User → Perception → Context Assembly → Reasoning → Planning
→ Policy / Permission → Tool Execution → Observation
→ Evaluation → Memory Update → Replanning
```

**特别重要：不要把 LLM 当成整个 Agent。** LLM 应该是 reasoning / planning 的重要组件，而不是"所有输入 → GPT → 直接改数据库"。

---

## 六、自然语言理解：保留 Hybrid，但升级目标

当前 Regex → Intent → Action 是合理的 prototype。

未来：

```text
Input → Fast deterministic parser → LLM reasoning / parsing
→ Structured Intent / Plan → Validation → Execution
```

- **Deterministic layer**：日期、时间、数字、单位、明确关键词、已知结构、Schema validation
- **LLM layer**：模糊表达、同义表达、多轮上下文、跨模块理解、复杂目标、用户约束、规划

避免把所有简单操作都交给 LLM。

---

## 七、Goal System 应升级为真正的 Planning System

现有 Goal → Milestone → Todo 能力不要删，应作为 Agent 的**确定性执行基础设施**。

未来：用户说"我想三个月减 5kg，最近工作比较忙，帮我安排一下" → Agent 读取（当前体重/历史运动/日程/饮食/Todo/偏好）→ Planning → Goal Engine → Goal/Milestones/Todos/Schedule/Review points。

> **LLM 负责理解和规划。确定性代码负责可靠执行。** 这是非常重要的架构边界。

---

## 八、Memory 应成为核心研发方向

不要把 `chatHistory` 直接等同于 Memory。至少逐步区分：

| 类型 | 内容 | 例子 |
|------|------|------|
| 1. Episodic | 发生过什么 | 8/16 完成 gym、花费 $20、创建某 Todo |
| 2. Semantic | 关于用户的长期事实 | 用户偏好晚上运动 |
| 3. Goal State | 用户目前想实现什么 | 减脂、储蓄、学习、项目 |
| 4. Working | 当前任务上下文 | 当前任务/计划/约束/工具结果 |
| 5. Procedural/Skill | Agent 知道怎么完成什么事 | — |

---

## 九、Human-in-the-loop 不只是"确认按钮"

发展成 **Agent Autonomy**：

```text
Level 0 只回答
Level 1 给建议，不执行
Level 2 低风险操作自动执行，重要操作确认
Level 3 Agent 可以自主规划并执行大部分任务
Level 4 高度自主运行
```

并且按照工具分别配置：Calendar → 自动创建；Finance → 必须确认；Delete data → 永远确认；Todo → 自动执行。

---

## 十、Skills 应成为核心抽象

生活模块（Finance/Fitness/Wellness/Calendar/Todo/Goal）未来抽象成 Skill Registry：

```text
life.log_meal / life.log_exercise / life.create_goal / life.create_todo
calendar.create_event / finance.record_transaction / wellness.log_habit
```

Agent 不再直接操作数据库，而是 Agent → Skill → Validation → Tool/Data Layer。

未来可加入 Research / Study / Travel / Work / Quant Skill 而不会破坏 Core。

---

## 十一、Quant Agent 可以作为第二个实验场

> **Quant Research Agent** 可以验证同一套 Agent Core 在另一个高复杂度 domain 中是否成立。

```text
Research Question → Hypothesis → Data → Feature → Model → Backtest
→ Evaluation → Research Memory → Next Experiment
```

重点不是模型有多 fancy，而是 **Agent 能不能持续进行 research，而不是只生成一次结果**。LightGBM 可作为第一版 model backend。

---

## 十二、Local-first → Cloud → Desktop 的路线

Phase 1 LocalStorage（继续验证产品）→ Phase 2 StorageAdapter（Local/Cloud）→ Phase 3 Supabase（Auth/DB/Sync/Backup）→ Phase 4 OAuth（Google Calendar 等）→ Phase 5 Tauri。

**但不要现在同时做 Supabase + OAuth + Tauri**——否则容易从 Agent 项目变成"先解决登录、数据库、OAuth、桌面打包"，Agent 反而没做出来。

---

## 十三、建议的版本路线

| 版本 | 主题 | 目标 |
|------|------|------|
| v0.5.x | Prototype（现在） | 验证生活工作台 + Agent interaction |
| v0.6 | Architecture Refactor | 拆文件 → Domain modules → Storage abstraction → Skill abstraction → Agent abstraction；把 190KB 单文件拆开 |
| v0.7 | Agent Core | Context / Planner / Tool Registry / Skill Registry / Execution / Permission |
| v0.8 | Memory | Episodic / Semantic / Goal / Working / Procedural + retrieval/write/update |
| v0.9 | Agentic Goal Planning | NL Goal → Context → Reasoning → Plan → Goal → Milestone → Todo → Schedule → Review → Replan |
| v1.0 | Cloud + Desktop | Supabase + OAuth + Tauri，开箱即用 + 多设备同步 |

---

## 十四、最重要的产品原则

1. **Agent > UI**：UI 是 interface，不是产品核心
2. **LLM ≠ Agent**：Agent = Model + Context + Memory + Tools + Planning + Execution + Policy + Evaluation
3. **Deterministic code ≠ 过时**：能可靠确定执行的事情交给代码
4. **Memory ≠ Chat History**：Memory 是 Agent 的长期 state
5. **Autonomy 必须可控**：用户拥有最终的 permission / autonomy control
6. **Skills 应该可扩展**：生活只是第一个 domain
7. **先 dogfood，再 generalize**：自己是第一个用户，但不是架构上的特殊用户

---

## 十五、当前最值得做的事情（按优先级）

| 优先级 | 工作 | 原因 |
|--------|------|------|
| P0 | 把当前版本完整跑通、验证 README 功能 | 确认实际功能与描述一致 |
| P0 | 拆分前端文件 | 给 Agent Core 留空间 |
| P0 | 定义 Skill Schema | 未来 Agent 的基础接口 |
| P1 | 定义 Agent Core architecture | 从 App → Agent |
| P1 | Memory architecture | 长期核心壁垒 |
| P1 | Planner / execution loop | 真正 Agentic |
| P1 | Autonomy / permission system | HITL |
| P2 | Quant Agent | 第二个 domain / architecture stress test |
| P2 | Supabase / OAuth | 多设备 / 外部工具 |
| P3 | Tauri / UI polish | 产品化交付（Agent core 稳定之后） |

---

## 十六、最终项目形态

```text
                         SHU
                  Personal Agent
                         │
        ┌────────────────┼────────────────┐
        │                │                │
      Memory           Skills           Tools
        │                │                │
        │       ┌────────┼────────┐       │
        │       │        │        │       │
        │      Life     Work    Quant   External
        │
        ↓
   User Context → Reasoning → Planning → Execution
   → Observation → Evaluation → Memory ↺
```

Web / Desktop / Mobile / Chat / Voice 都只是它的不同 interface。

---

## 一句话总结

**Shu 当前是一个"生活工作台"，但项目真正值得继续投入的方向，是把它演化成一个以 Memory、Skills、Tools、Planning、Autonomy 和长期 User Context 为核心的 Personal Agent Harness。**

3 天版本不需要被推翻，它最好的定位是：**一个已经能工作的 vertical prototype**。接下来不是无限堆"生活功能"，而是从这个 prototype 里抽象出 Agent Core。等 Core 成熟以后，Life、Quant、Study、Work 都可以变成它的不同 Skill/domain。Shu 和 Quant Agent 实际上是在用两个完全不同的 domain，验证同一个 Agent harness 是否真的成立。
