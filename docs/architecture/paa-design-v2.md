# PAA 架构设计 v2 — 以能力支柱为中心

> Personal AI Agent Framework
> 参考：DS Harness（Cordis + ReactLoopAgent）× Operit（ToolPkg + Hook 生命周期）
> 状态：设计稿 · 待俪宁确认节奏 | 2026-08-17

---

## 〇、设计哲学

一句话：**生活工作台是 Agent 的第一个宿主，Agent 是独立于宿主的大脑。**

```
传统思路：App 里嵌一个 AI 功能     ✗
PAA 思路：一个 Agent 大脑，宿主只是它的手脚    ✓
```

### 差异化定位（俪宁 2026-08-17 拍板）

| 叙事 | 决定 | 说明 |
|------|------|------|
| **记忆主权** | ✅ 主叙事 | 开放记忆格式 + 导入导出 + 跨 Agent 迁移。市面记忆全锁死在自家生态，这是真实空白 |
| **深度个人化** | ✅ 主叙事的核心 | Personal Agent 的价值 = 越来越懂"这个宿主"。记忆积累的是关于俪宁的深度知识（目标/偏好/决策史/行为模式），不是通用知识——否则就是 ChatGPT memory 也能做的通用记忆 |
| **可携带（portable）** | ✅ 技术承诺 | 大脑零宿主依赖，任何宿主 register() 就能跑。这是**技术层的可迁移性**，与"记忆深度绑定宿主本人"不矛盾：记忆是为你定制的衣橱，搬家时可以整套搬走 |
| **兼容 Operit 生态** | ❌ 明确不做 | 技能包格式自研（可借鉴其 JSON+JS 思路，但格式是自己的）。兼容别人 = 交出设计主权 |

记忆主权是 P1 记忆系统的设计红线：**记忆格式必须不依赖任何宿主、任何 LLM Provider、任何存储实现**。

⚠️ 表述修正（2026-08-17）：v1 稿曾写"宿主无关"，易误读为"不关心你是谁"。正确表述是**可携带而非无关**——运行层解耦（可迁移），记忆层深绑（个性化）。Personal Agent 的记忆主语是俪宁这个人，不是任意用户；如果积累的是"越来越懂其它东西"，那就是通用 memory，没有护城河。

四个能力支柱（俪宁 2026-08-17 定义）：

| # | 支柱 | 一句话 | 参考来源 |
|---|------|--------|---------|
| C1 | **产物能力** | Agent 能创建文档/代码/数据，产物有存储、有视图、可被引用 | WorkBuddy 的 artifact 模式 |
| C2 | **自我更新** | Agent 能写新工具、改自己的 system prompt、装技能包 | DSH Code Mode + Operit ToolPkg |
| C3 | **外部资源** | 能动态加载 ToolPkg、连 MCP 服务器、调 HTTP API | Operit MCPManager / DSH SkillRegistry |
| C4 | **外部记忆** | 记忆独立于会话存储，可导入导出，可检索、可注入 | DSH Compaction + WorkBuddy memory 模式 |

这四个支柱不是并列的功能列表，而是有依赖顺序的：

```
C4 记忆 ──→ Agent "记得"
C1 产物 ──→ Agent "做事"
C3 资源 ──→ Agent "扩展"
C2 更新 ──→ Agent "进化"（依赖 C1：写工具就是写产物；依赖 C3：装包就是加载资源）
```

所以实现顺序天然是：**骨架 → 记忆 → 产物 → 资源 → 进化**。

---

## 一、总体架构

```
┌─────────────────────────────────────────────────────────────────┐
│                          宿主层（Hosts）                          │
│                                                                 │
│   生活工作台 PWA          Tauri 桌面          WeCom / 未来场景     │
│   （第一个宿主）          （第二宿主）         （更多手脚）           │
│                                                                 │
│   宿主的职责：提供 UI、提供工具实现、提供存储后端                    │
│   宿主不知道 Agent 的内部逻辑                                     │
└────────────────────────────┬────────────────────────────────────┘
                             │ Skills.register() / Storage API
┌────────────────────────────▼────────────────────────────────────┐
│                        PAA 大脑层（Brain）                        │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                    AgentLoop（循环引擎）                     │  │
│  │                                                           │  │
│  │   user text → build msgs → LLM call → parse               │  │
│  │      ↑                                    ↓               │  │
│  │      └── tool result ← ToolPipeline ← tool calls           │  │
│  │                                                           │  │
│  │   · abort() 中断      · inject() 注入（预留）               │  │
│  │   · maxRounds 可配    · 每轮自动记忆检索                    │  │
│  └──────┬──────────────┬──────────────┬─────────────────────┘  │
│         │              │              │                        │
│  ┌──────▼─────┐ ┌──────▼─────┐ ┌─────▼────────┐               │
│  │ LLMAdapter │ │ ToolPipe-  │ │ SessionMgr   │               │
│  │            │ │ line       │ │ + Compactor  │               │
│  │ openai     │ │ before     │ │              │               │
│  │ anthropic  │ │ execute    │ │ chatHistory  │               │
│  │ (stream 预 │ │ after      │ │ + 压缩       │               │
│  │  留)       │ │ + 权限      │ │ + 摘要       │               │
│  └────────────┘ └──────┬─────┘ └──────────────┘               │
│                        │                                        │
│  ┌─────────────────────▼────────────────────────────────────┐  │
│  │                 Memory（C4 记忆支柱）                       │  │
│  │                                                          │  │
│  │  memories: [{id, type, content, tags, createdAt, ...}]    │  │
│  │  · type: fact / preference / episodic / skill-note        │  │
│  │  · import() / export()  ← 外部记忆导入导出                  │  │
│  │  · search(query)        ← 关键词检索（v1）向量（v2 预留）    │  │
│  │  · inject to system prompt ← 每轮对话自动携带相关记忆       │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                 Workspace（C1 产物支柱）                     │  │
│  │                                                           │  │
│  │  artifacts: [{id, title, path, type, content, version}]    │  │
│  │  · type: md / code / json / html / data                   │  │
│  │  · create / update / read / list 工具                      │  │
│  │  · 版本链（每次 update 留 snapshot）                         │  │
│  │  · UI：产物面板，Markdown/代码渲染                            │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │              Skill Registry（C2+C3 资源与进化支柱）           │  │
│  │                                                           │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐ │  │
│  │  │ 内置 life │ │ 宿主注入  │ │ToolPkg   │ │ MCP Bridge   │ │  │
│  │  │ 13 tools │ │ 工具      │ │ 动态加载  │ │ 远程工具      │ │  │
│  │  │(hardcode)│ │(host api)│ │(C3)      │ │ (C3, 预留)    │ │  │
│  │  └──────────┘ └──────────┘ └──────────┘ └──────────────┘ │  │
│  │                                                           │  │
│  │  ┌──────────────────────────────────────────────────┐     │  │
│  │  │  write_skill 工具（C2 核心）：Agent 运行时写新工具    │     │  │
│  │  │  edit_prompt 工具（C2）：Agent 改自己的 system prompt │     │  │
│  │  │  两者都走 FORBID-less 权限：必须用户确认              │     │  │
│  │  └──────────────────────────────────────────────────┘     │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### 与 v1 设计的差异

| 维度 | v1 设计 | v2 设计 |
|------|--------|--------|
| 出发点 | 修 v0.6.1 的缺口 | 围绕 4 支柱的完整蓝图 |
| 记忆 | 无 | 独立 Memory 系统 + 自动注入 |
| 产物 | 无 | Workspace + 版本链 + UI |
| 自我更新 | P2 提了一句 | C2 支柱，write_skill/edit_prompt 一等公民 |
| Agent 与宿主 | 混在 index.html 里 | 大脑层与宿主层概念分离，代码用注释分界 |
| 开发过程 | 直接改代码 | DEVLOG 同步记录，设计-实现-反思一一对应 |

---

## 二、能力支柱详细设计

### C4 · 记忆系统（先做，因为其他都依赖“记得”）

**为什么先做**：产物的引用需要记忆（“上次的计划”）；技能包的偏好需要记忆；自我更新需要记住改了什么。

**数据模型**：

```javascript
Store.data.memories = [{
  id: 'mem_001',
  type: 'fact' | 'preference' | 'episodic' | 'skill-note',
  content: '俪宁的减重目标是 15 斤，截止 12 月',
  tags: ['fitness', 'goal'],
  source: 'user' | 'agent' | 'import',
  createdAt: 1723872000000,
  updatedAt: ...
}]
```

**记忆工具**（注册进 Skill Registry）：

| 工具 | 读写 | 说明 |
|------|------|------|
| `memory.save(type, content, tags)` | 写 | Agent 对话中发现的重要事实自动存 |
| `memory.search(query)` | 读 | 关键词检索（v1），返回 top-N |
| `memory.list(type)` | 读 | 按类型列记忆 |
| `memory.forget(id)` | 写 | 删除（永远走确认） |

**自动注入机制**（关键设计）：每次 AgentLoop.run() 构建消息时：

```
system prompt = 人格 prompt + 相关记忆（memory.search(用户输入) top 3）+ 可用工具说明
```

参考：WorkBuddy 的 memory 注入模式（我就是这么“记得”俪宁的事的）+ DSH 的 systemPrompt 服务动态组装。

**导入导出**：设置页 `memory.import(JSON)` / `memory.export()` —— 可以把 WorkBuddy 的 MEMORY.md、其他 Agent 的记忆文件导进来（格式转换层）。

### C4 修订 · P1 v1.1（2026-08-25，吸收 Graphiti/Zep 三层架构 + 俪宁人脑直觉）

**背景**：俪宁提出两个质疑——① 每条会话都存原文，维护成本 + 回忆 token 会不会爆炸；② 大模型认知与人脑架构相似，memory 是否可模仿 CNN 存储。研究结论：

- CNN = 权重即记忆 → 本质是模型训练，黑盒不可审计不可导出，违反记忆主权 → **不做**
- 人脑正确类比 = **分层 + 巩固 + 稀疏激活**（Atkinson-Shiffrin 感觉/工作/长期记忆 ≈ L0-L3；海马体重放固化 ≈ consolidate；回忆稀疏激活 ≈ top-K 注入）——恰好验证本修订
- Graphiti（Zep 底层，30k+ stars）三层：Episodic 原文层 / Semantic 实体事实层 / Community 摘要层。**关键洞察：存储不花钱，注入才花钱**——原文全量存但永不进 LLM 上下文

**v1.1 数据模型**（v1 基础上扩展，向后兼容）：

```javascript
Store.data.memories = [{
  id: 'mem_001',
  layer: 'L0' | 'L1' | 'L2' | 'L3',     // 原文/事实/场景/画像
  type: 'fact' | 'preference' | 'episodic' | 'skill-note' | 'persona',
  content: '俪宁的减重目标是 15 斤，截止 12 月',
  tags: ['fitness', 'goal'],
  source: 'user' | 'agent' | 'import',
  sourceRef: { sessionId, eventId },    // 可追溯（审计/纠错前提）
  validAt: 1723872000000,               // 事实开始为真的时间
  invalidAt: null,                      // 失效时间（Graphiti 同款：不硬删，标记失效）
  createdAt, updatedAt
}]
```

**分层定义与注入策略**：

| 层 | 存什么 | 注入策略 |
|----|--------|---------|
| L0 | 原始交互记录（可选开关） | **永不注入**，只溯源/审计（后悔药） |
| L1 | 原子事实（save 默认层） | 关键词匹配，补足 top-N |
| L2 | 场景知识块（consolidate 聚合） | 标签匹配 top 2 |
| L3 | 长期画像 persona（种子 + consolidate） | 每轮常驻 1-2 条 |

**token 预算硬上限**：每轮记忆注入 ≤ ~510 tokens（L3 2×~80 + L2 2×~100 + L1 3×~50）。本地关键词检索 0 API 成本。注入账本写入审计日志（俪宁要求 token 明细可见）。

**新增 memory.consolidate**：agent 生成摘要、provider 记账——把 N 条 L1 聚合为 L2 场景块 / 更新 L3 画像，被聚合的 L1 标记失效。增量局部更新（只重算受影响的块），不刷新全局。写侧除 consolidate 外零 LLM。

**save 自动失效规则**：同 tag+type 且内容不同的活跃记录 → 旧记录自动 invalidAt（Graphiti 边失效的轻量版，解决"自信地记住了过期信息"）。

**升级路径（何时上真图）**：任一信号触发——① 记忆量 >500 且关键词误检 ② 关系密集需求 ③ 时间线追溯需求。届时引入 Graphiti 风格时序图谱，数据模型已预留 validAt/invalidAt/sourceRef，迁移成本 ≈ 零。

---

### C1 · 产物系统（Workspace + Artifacts）

**为什么像 WorkBuddy**：WB 的核心体验是“AI 的产出是持久的文件，不是聊天记录里的一段话”。聊天会滚走，产物会留下。

**数据模型**：

```javascript
Store.data.artifacts = [{
  id: 'art_001',
  title: '减重 15 斤作战计划',
  path: 'plans/fat-loss-plan.md',   // 虚拟路径（树形组织的展示用）
  type: 'md' | 'code' | 'json' | 'html' | 'data',
  content: '# 减重计划\n...',
  version: 3,                        // 版本号
  history: [ {v:1, content, at}, {v:2, ...} ],  // 最近 N 版快照
  createdAt, updatedAt
}]
```

**产物工具**：

| 工具 | 权限 | 说明 |
|------|------|------|
| `artifact.create(title, type, content, path)` | 确认 | 新建产物 |
| `artifact.update(id, content)` | 确认 | 更新（自动存版本快照） |
| `artifact.read(id)` | 自动 | 读内容（LLM 引用旧产物） |
| `artifact.list()` | 自动 | 列出所有产物（标题+路径） |

**UI**：工作台新增“产物”模块（M.artifacts），列表 + 详情视图；Markdown 用轻量渲染（现有 chat 里如果已有 md 渲染逻辑则复用，没有就写个 ~50 行的 mini renderer）；代码块等宽字体 + 简单高亮。

**产物与聊天的连接**：chat 消息里可以引用产物（`[产物:art_001]`），点击跳转。Agent 说“我把计划写好了”时附带产物卡片。

---

### C3 · 外部资源（ToolPkg + MCP + HTTP）

**ToolPkg 格式**（自研，P2 实现；参考 Operit JSON+JS 思路但不做生态兼容）：

```json
{
  "id": "stock",
  "name": "股票查询",
  "version": "1.0.0",
  "desc": "查询股票实时行情",
  "permissions": ["network"],
  "tools": [{
    "name": "quote",
    "desc": "查某只股票的实时报价",
    "params": { "symbol": { "type": "string", "desc": "股票代码" } },
    "handler": "async (args) => { const r = await fetch(...); return ... }"
  }]
}
```

加载方式 v1：设置页粘贴 JSON → 注册进 Registry（handler 用 `new Function` 受限执行）。
加载方式 v2：URL 导入 / 技能市场。

**安全模型**（Operit 三级权限的简化）：

| 来源 | 默认权限 | 说明 |
|------|---------|------|
| 内置 life 包 | ALLOW | 记录类操作，已验证 |
| 宿主注入工具 | ALLOW | 宿主自己负责 |
| 产物工具 | CREATE/UPDATE 走确认 | 写产物要用户点头 |
| ToolPkg 工具 | ASK 首次 | 首次调用确认，可“总是允许” |
| memory.forget / 自更新 | 永远确认 | 不可降级 |

**MCP**：P3 预留 `MCPBridge.connect(url)` 接口，把远程 MCP server 的 tools 转换成本地 ToolDefinition。PWA 环境的限制是 CORS 和无长连接，真正跑 MCP 可能要等 Tauri 宿主——接口先留。

**HTTP fetch 工具**：`net.fetch(url)` 走确认（或白名单域自动），让 Agent 能查网页/API。

---

### C2 · 自我更新（最高级能力，最后做）

**三条自更新路径**：

| 路径 | 工具 | 流程 |
|------|------|------|
| 写新工具 | `skill.write(spec)` | Agent 生成 ToolPkg JSON → 用户预览代码 → 确认 → 注册进 Registry → 立即可用 |
| 改人格 | `prompt.edit(section, newContent)` | Agent 提议修改自己的 system prompt → diff 展示 → 确认 → 生效 |
| 装技能包 | `skill.install(pkg)` | 从 URL/粘贴导入 ToolPkg → 安全检查（预览 handler 代码）→ 确认 → 加载 |

**为什么这可行（而不危险）**：

1. DSH 的 Code Mode 证明：LLM 写代码调用已知 API 比让它自由发挥更可控
2. Operit 的 ToolPkg 证明：JSON 声明 + JS handler 的格式 LLM 写起来准确率很高
3. 所有自更新走“预览 + 确认”，人始终在环上（human-in-the-loop）
4. 版本快照：system prompt 修改保留历史，工具包可卸载回滚

**记忆与自更新的联动**：每次自更新自动写一条 `skill-note` 记忆（“我给自己装了股票查询技能，因为俪宁在看行情”），下次对话 Agent 知道自己有什么新能力。

---

## 三、实现节奏（Step by Step）

> 原则：每个 Phase 都是可运行的完整版本，做完就能用；DEVLOG 同步写；每个 Phase 开始前先给俪宁讲清楚设计逻辑。

| Phase | 主题 | 核心交付 | 依赖 | 预计深度对话轮 |
|-------|------|---------|------|--------------|
| **P0** | 骨架重整 | AgentLoop + ToolPipeline + LLMAdapter 三件套，行为对齐 v0.6.1 | — | 2-3 |
| **P1** | 记忆系统 | Memory 数据模型 + 4 工具 + 自动注入 + 导入导出 | P0 | 2 |
| **P2** | 产物系统 | Workspace + 4 工具 + M.artifacts UI + 版本链 | P0 | 2-3 |
| **P3** | 外部资源 | ToolPkg 格式 + 动态加载 + 权限分级 + net.fetch | P1, P2 | 2-3 |
| **P4** | 自我更新 | skill.write + prompt.edit + skill.install + 安全审查 UI | P3 | 3 |
| **P5**（可选） | 流式 + 并行 | LLM stream + 工具并行执行 + Inbox 注入 | P0-P4 | 2 |

每个 Phase 内部的小步：

```
Phase X.1  设计讲解（我给俪宁讲清楚这个 Phase 的设计逻辑，确认）
Phase X.2  实现（我写代码，DEVLOG 记录设计-代码对应）
Phase X.3  联测（俪宁实测，反馈，修）
Phase X.4  收尾（DEVLOG 完成本 Phase 反思，git commit）
```

**P0 详细拆解**（下一个马上做的事）：

1. **X.1 设计讲解**：Agent 的本质是什么——`while (LLM 还想调工具) { 调 LLM → 执行工具 → 结果喂回去 }`。v0.6.1 的 6 轮循环为什么是这个形状，DSH 的 Turn/Step 和 Operit 的单层循环差别在哪，我们为什么选单层 + abort。
2. **X.2 实现**：
   - `LLMAdapter`（从 Agent.callLLM 提取，接口不变）
   - `ToolPipeline`（before 权限 → execute → after 格式化）
   - `AgentLoop`（替代 plan 的 6 轮循环，maxRounds 可配）
   - `Agent` 对象变薄壳，委托给 AgentLoop（兼容层）
   - SW v9 → v10
3. **X.3 联测**：配好 API 实测“帮我减重 15 斤”规划链路 + 简单记录链路
4. **X.4 收尾**：DEVLOG Phase 0 完整篇 + commit

---

## 四、DEVLOG 约定

位置：`docs/DEVLOG.md`，最终随仓库公开。

格式（每个 entry）：

```markdown
## Phase X.Y — 标题（日期）

### 做了什么
（一两句人话）

### 设计决策
- 决策 1：为什么 A 不选 B（参考：DSH xxx / Operit xxx）
- ...

### 代码地图
（改了哪些地方，关键函数，方便未来自己回看）

### 踩坑
（真实的问题，不粉饰）

### 反思 / 下一步
```

**核心纪律：日志与代码同生，不是事后补写。** 每个 X.2 实现完立刻写对应 entry。

---

## 五、待俪宁确认

| # | 事项 | 默认方案 |
|---|------|---------|
| 1 | 节奏表（P0→P5）OK？ | 按 P0 骨架 → P1 记忆 → P2 产物 → P3 资源 → P4 进化 |
| 2 | 每个 Phase 的 X.1 设计讲解形式？ | 我先讲逻辑（像上课），你确认了再动手 |
| 3 | DEVLOG 放 `docs/DEVLOG.md` 随仓库公开？ | 是 |
| 4 | 记忆检索 v1 用关键词（不用向量）？ | 是（PWA 环境向量太重，关键词够用） |
| 5 | P0 现在就开始 X.1 讲解？ | 确认后我开讲 |
