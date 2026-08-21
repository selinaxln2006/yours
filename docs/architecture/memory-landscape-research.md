# Memory 实现方案调研 — 面向 PAA C4 落地

> 状态：**v2（2026-08-21，合并俪宁范例）**。v1 结论被强化：v1 仍维持文件 + grep，但蒸馏管线升级为 L0→L3 多 pass、记忆条目加治理元数据、procedural memory 考虑外接 MCP 而非自建。
> 结论先行：**维护 > 检索；蒸馏要多 pass 不是一次性的；procedural memory 不该存 prose 应该存结构化索引。**

---

## 一、市面三大流派（专用记忆框架）

| 维度 | Letta（前 MemGPT） | Mem0 | Zep |
|---|---|---|---|
| 流派 | 操作系统派 | 记忆中间件派 | 知识图谱派 |
| 核心抽象 | Agent OS，上下文窗口 = 主内存，外存间做 paging，agent 自主决定换入换出 | Memory API：单 pass 分层提取 + 语义/关键词/实体**三路并行检索** | Temporal KG（Graphiti）：事实带时间戳存成图，"我换工作了"不覆盖旧记录而是加新边 |
| 热度 | 22.4k stars | 55.7k stars，14M+ 下载 | Graphiti 20k stars |
| Benchmark | — | LoCoMo 91.6（~7k token，full-context 要 26k+ 还更差）；temporal reasoning +29.6 | DMR 94.8%；LongMemEval +18.5%，延迟 -90% |
| 最强场景 | agent 自主学习/自我改进 | 快速集成、大规模部署 | 时序推理、合规审计 |
| 最大风险 | 框架锁定（要求整个 agent 跑在它的 runtime 上，与 PAA 自研路线冲突） | 被基础模型厂商内化（ChatGPT memory 就是征兆） | 重：图谱构建成本高、冷启动慢 |

**行业共识（Futurum 四层模型）**：Working Memory（上下文窗口）→ Session Memory（会话检查点）→ Long-term Semantic（事实库）→ Episodic/Procedural（时序/程序性）。这个分层与建议书第八章的五类型基本同构，互相印证。

## 二、文件派（与 PAA 同路线的参考系）

### Claude Code Auto Memory（拆解自 claude-code-book）

这是对我们最有价值的参考，因为它证明了**纯文件路线在工业级 agent 上成立**：

| 机制 | 设计 | 对 PAA 的启示 |
|---|---|---|
| **索引与内容分离** | MEMORY.md 只是索引（每条 `- [Title](file.md) -- 钩子描述`），内容在独立文件 | ✅ 直接采纳：MEMORY.md 做索引，细节外置 |
| **索引双重上限** | 200 行 + 25KB + 单条 ≤150 字符，超限截断并警告 | ✅ 直接采纳，防索引膨胀 |
| **闭合类型系统** | 仅 4 类：user / feedback / project / reference；开放类型会类型爆炸、分类模糊、索引膨胀 | ✅ 采纳哲学"约束即自由"，PAA 用既定五类型，不开放自定义 |
| **只存不可推导信息** | 代码模式/git 历史/调试方案一律不存（agent 重读代码只要几百 token，记忆价值≈0）；只存偏好、决策背景、外部链接 | ✅ **这是最重要的一条**，写进写入纪律 |
| **记忆是线索不是事实** | 信任层级 Level 1：记忆指方向，行动前独立验证（路径存在？grep 得到？） | ✅ 与六步硬纪律的"交叉验证"天然契合 |
| **相对日期禁令** | "下周二"会腐烂成误导，必须转绝对日期 | ✅ 写入纪律加一条 |
| **互斥写入** | 主 agent 已存 → 后台提取跳过，避免重复 | △ 单进程 PAA 暂不需要，记入 v2 |
| **没有自动过期** | 明确是缺陷：记忆质量靠 agent 判断力 + 用户手动清理 | ⚠️ **PAA 要做得比它好**——蒸馏纪律自动化 |

### WorkBuddy 自身模式

纯 Markdown + 注入 + 蒸馏纪律（daily 超 30 天提炼进 MEMORY.md 再删）。**没做 embedding**，能用是因为注入量被蒸馏压得很小。它验证了一件事：**维护纪律可以替代检索技术，直到记忆量上一个数量级**。

## 三、两个关键判断

### 判断 1：维护 > 检索（回应"个人项目记忆长期会变大"）

俪宁的直觉是对的，而且调研证实这是主次要关系：

- Claude Code 的已知缺陷就是**没有自动过期**，记忆只进不出；
- Mem0 论文里真正拉开分差的不是向量检索，而是**提取质量**（什么值得记）；
- 记忆膨胀伤的是**注入侧**（每次会话都变贵变噪），检索再好也救不回注入侧的污染。

所以 PAA 的记忆生命周期必须自动转：

```
daily log（热）──7天──> 蒸馏进 MEMORY.md/goals.md（温）──30天──> 归档或删除（冷）
                                        ↑
                          每次蒸馏过"删除测试"：这条记忆删掉后，agent 行为会变差吗？
                          不会 → 不值得进长期记忆
```

外加：绝对日期、去重（同主题合并）、索引上限（200 行/25KB）、**只存不可推导信息**（代码能 grep 到的不存）。

### 判断 2：A/B 是对的，但接口要先留好

**A/B 设计（落地时执行）**：

| | A：grep 基线 | B：embedding |
|---|---|---|
| 实现 | `memory__search` = fs__grep 限定记忆目录 | 本地轻量向量库（如 sqlite-vec），启动时对记忆文件建索引 |
| 依赖 | 零 | +1 轻依赖 + embedding API 调用成本 |
| 适合量级 | ≤ 千条 | 千条以上 |
| 评测指标 | ① 检索命中率（该找到的能不能找到）② 任务完成质量（带记忆任务 vs 无记忆）③ token 成本 ④ 维护成本 | 同左 |

**前提是 C4 的检索层做成可插拔**：

```
memory__search(query)
      ↓
  RetrievalBackend（接口）
   ├── GrepBackend      ← v1 默认
   └── VecBackend       ← A/B 时挂上，换配置不换代码
```

这样 A/B 只换 backend 配置，agent 侧行为零改动，测试才干净。

## 四、对 c4-memory-and-autonomy-design.md 的修订点

| # | 修订 | 来源 |
|---|---|---|
| 1 | MEMORY.md 改为**索引层**，细节外置独立文件，200 行/25KB 双重上限 | Claude Code |
| 2 | 写入纪律加三条：只存不可推导信息 / 绝对日期 / 删除测试 | Claude Code |
| 3 | 检索层抽 `RetrievalBackend` 接口，grep 为默认实现 | A/B 预留 |
| 4 | 记忆生命周期：热(7d)→蒸馏→温→归档/删除，蒸馏自动化 | 俪宁 + Claude Code 缺陷反推 |
| 5 | 互斥写入、后台提取：记入 v2，v1 不做 | Claude Code |

## 五、待补（等俪宁的范例）

- [ ] 范例合并与对照（哪些设计被印证/推翻）
- [ ] Quant domain 的记忆是否需要独立分区（Research Memory）
- [ ] 记忆与 Autonomy 审计日志的合并形态

## 附：信源

- FuturePicker：Letta vs Mem0 vs Zep 深度对比（benchmark、融资、风险），2026-05 数据
- claude-code-book（GitHub）：Claude Code 记忆系统拆解（索引机制/闭合类型/生命周期状态机）
- Mem0 论文 arXiv:2504.19413（ECAI 2025）、Zep 论文 arXiv:2501.13956（待精读，A/B 前读）

---

## 六、俪宁范例合并（v2 新增）

### 范例 A：TencentDB Agent Memory（23.6k stars, MIT）

**定位**：团队级 AI Agent 记忆中枢——把对话/文档/代码沉淀为四类可复用记忆资产。

**最有价值的设计**：

| 设计 | 细节 | 对 PAA 的启示 |
|---|---|---|
| **L0→L3 多 pass 蒸馏** | L0 原始对话 → L1 Atom（事实/偏好/约束）→ L2 Scenario（项目上下文块）→ L3 Core/Persona（长期画像） | ⭐ **直接采纳**：我们原来是 daily log → MEMORY.md 一步蒸馏，太粗。应改多 pass：daily（L0）→ atoms（L1 事实条目）→ scenario（L2 项目上下文）→ core（L3 长期画像）。每 pass 是一次 LLM 提炼，不是简单搬运 |
| **四类资产** | Chat Memory / Skill / Wiki / CodeGraph | 映射我们的五类型：Chat Memory = episodic+semantic，Skill = procedural，Wiki+CodeGraph = 外部知识索引（不由 PAA 自建，见范例 B） |
| **资产治理元数据** | 每条记忆带 owner / version / status / usage_count / agent_binding | ⭐ **采纳**：我们的记忆条目加 `version` + `last_used` + `source`（哪次会话产生的）。Claude Code 没有这个，所以它没法做淘汰——有 usage_count 才能算"这条记忆还活着吗" |
| **混合检索** | BM25 + 向量 + RRF 融合回退到 L1/L0 | ⭐ **修正 A/B 设计**：不是 grep vs embedding 二选一，而是 **grep(BM25 近似) → embedding → RRF 融合** 的三层。A/B 变成 A/B/C：grep 基线 / embedding 单路 / 融合 |
| **团队 + Agent 装备** | 不同 Agent 装备不同记忆资产集 | 个人项目暂时不需要团队，但"不同任务域装备不同记忆子集"有借鉴——Quant domain 和 Life domain 的记忆可以分区 |

**不适合直接用**：它是完整服务（Docker 三组件），与 PAA 零依赖原则冲突。但其**架构思想**可以提炼进 PAA 的文件实现。

### 范例 B：Codebase-Memory-MCP（39.8k stars, MIT）

**定位**：高性能代码知识图谱 MCP 服务器——把代码库索引成可查询的图结构。

**核心洞察**：**procedural memory 不应该存 prose，应该存结构化索引。**

| 设计 | 细节 | 对 PAA 的启示 |
|---|---|---|
| **代码 → 知识图谱** | tree-sitter 158 语言 → SQLite 图（节点：函数/类/文件，边：调用/包含/使用/实现），15 个 MCP 工具查询 | PAA 的 procedural memory 不该在 MEMORY.md 里写"expandRecurring 在 981 行"——这种信息 grep 一次就有。应该存的是**方法论**（"修 rrule 类 bug 先查 schema→handler→UI 三处编码一致性"） |
| **99.2% token 节省** | 5 次结构化查询 ~3.4k token vs 文件遍历 412k token | 验证我们的 fs__grep 路线方向对，但结构化索引能再省一个量级 |
| **作为 MCP 外挂** | 单二进制，MCP 协议接入，零依赖 | ⭐ **PAA 的 procedural memory 可走 MCP 外接路线**：PAA 自己不建代码图谱（太重），但 PAA 的 skills 注册表预留 MCP 接口（路线图已有），未来挂上 codebase-memory-mcp 就获得了代码级 procedural memory |
| **三层代理** | Scout（快速发现）/ Verify（默认验证）/ Auditor（深度审计） | 对 PAA 的启示：agent 可以按任务复杂度选不同深度的工具组合（简单 grep vs 完整图查询） |

**不适合现在集成**：它是 native 二进制 + SQLite，PAA 是零依赖 Node。但作为 **PAA procedural memory 层的可选外挂**记入路线图——等 PAA 的 MCP 支持落地后，挂上即可。

### v2 新增修订点

| # | 新增修订 | 来源 |
|---|---|---|
| 6 | 蒸馏从一步升级为 L0→L3 多 pass（daily → atoms → scenario → core） | TencentDB |
| 7 | 记忆条目加治理元数据：version / last_used / source | TencentDB |
| 8 | A/B 扩展为 A/B/C：grep → embedding → RRF 融合 | TencentDB 混合检索 |
| 9 | Procedural memory 存方法论不存代码位置（代码位置 grep 一次就有） | Codebase-Memory + Claude Code "只存不可推导信息" |
| 10 | Procedural memory 的终极形态 = MCP 外接代码图谱，不自建 | Codebase-Memory-MCP |
| 11 | 按任务域分区记忆（Life / Quant / Study），不同域装备不同记忆子集 | TencentDB Agent 装备机制 |

### 回应"Claude Code 不好用"

调研印证了你的体感。Claude Code 的记忆有三个结构性缺陷：

1. **没有自动过期**——记忆只进不出，时间长了注入侧全是噪声，agent 反而被记忆干扰；
2. **索引与内容不分层**——虽然有索引上限，但没有 TencentDB 那种 L0→L3 多 pass 蒸馏，低质量记忆和高质量记忆混在一起；
3. **没有检索回退**——只有 grep，没有向量/语义检索，查不到就是查不到（"我记得说过但搜不到"的体感）。

PAA 的 C4 如果把上面 11 条修订全落地，理论上会比 Claude Code 的记忆更好用——因为我们有自动蒸馏 + 过期 + 混合检索，这三个它都没有。
