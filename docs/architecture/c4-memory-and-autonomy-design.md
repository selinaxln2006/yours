# C4 Memory + Autonomy 分级 — 设计文档

> 对应 G6（记忆主权）与建议书第九章（Agent Autonomy）。
> 状态：v2（融入调研报告 11 条修订），实施中。前置：fs-tools v0.2（已落地）。
> v2 修订来源：`memory-landscape-research.md`（Letta/Mem0/Zep 三流派 + Claude Code 文件派 + TencentDB/Codebase-Memory 两范例）

---

## 一、C4 记忆系统（G6）

### 1.1 设计原则

1. **文件即记忆**：纯 Markdown，零依赖，人可读可改。不引入数据库/embedding（v1）。
2. **仿 WorkBuddy 模式**：我自己（枢）就是用 MEMORY.md + 每日日志维持跨会话连续性的，这套模式已被验证可行——PAA 直接复用同构设计。
3. **写有纪律，读有预算**：写入走 append-only + 确认门；注入进 system prompt 的记忆有 token 上限，不无限膨胀。
4. **[v2] 索引与内容分离**：MEMORY.md 只是索引层（≤200 行 / ≤25KB / 单条 ≤150 字符），细节外置独立文件。来源：Claude Code。
5. **[v2] 只存不可推导信息**：代码位置/模式/git 历史 agent 重读只要几百 token，不存。只存偏好、决策背景、方法论、外部链接。来源：Claude Code。
6. **[v2] 记忆是线索不是事实**：记忆指方向，行动前独立验证（grep 得到？路径存在？）。来源：Claude Code。
7. **[v2] 绝对日期禁令**：禁止"下周二"等相对日期，必须转绝对日期（否则腐烂成误导）。来源：Claude Code。

### 1.2 存储布局

```
paa/memory/
├── MEMORY.md          # 索引层（≤200行/25KB）：长期事实索引，细节外置
├── goals.md           # 目标层：当前进行中的事项与状态
├── YYYY-MM-DD.md      # 情景层：每日会话日志（append-only，不回改）
├── details/           # [v2] 索引指向的细节文件
│   ├── rrule-bug.md   #   如：rruleDays 编码 bug 的完整诊断记录
│   └── ...
└── sessions/          # 可选：完整会话转录（供 resume / 审计）
```

### 1.3 记忆生命周期 [v2]

```
daily log（热，L0）
    │ 7天
    ▼
蒸馏（L0→L1→L2→L3，多 pass）
    │
    ├─ L1 atoms：原子事实条目（"rruleDays schema 用 1-7"）
    ├─ L2 scenario：项目上下文（"前端冻结基线 v18 已知 bug 清单"）
    └─ L3 core：长期画像（"用户偏好结构化输出"）
    │
    ▼
MEMORY.md 索引（温）──30天──> 归档或删除（冷）
```

**蒸馏纪律**（写入选三条硬规则）：
1. **删除测试**：这条记忆删掉后，agent 行为会变差吗？不会 → 不值得进长期记忆。
2. **绝对日期**：禁止相对日期（"下周二"→ "2026-08-26"）。
3. **不可推导**：代码能 grep 到的不存；只存偏好、决策背景、方法论、外部链接。

### 1.3 五类记忆的落地映射

| 建议书第八章类型 | 落地文件 | 读写时机 |
|---|---|---|
| Episodic（发生过什么） | `YYYY-MM-DD.md` | 每次会话结束 append |
| Semantic（关于用户的长期事实） | `MEMORY.md` | 会话结束时**提炼**后更新（需确认） |
| Goal State（用户想实现什么） | `goals.md` | 新目标/里程碑完成时更新 |
| Procedural（agent 知道怎么做） | `playbook.md`（方法论，不是代码位置）[v2] | 沉淀新方法论时写入；终极形态 = MCP 外接代码图谱 |
| Working Memory（当前任务上下文） | AgentLoop 进程内上下文 | 会话内天然存在，不落盘 |

### 1.4 机制

**注入（启动时）**

```
AgentLoop 启动
  → 读 paa/memory/MEMORY.md（截断至 ~2000 token / ~8000 字符）
  → 读今日 daily log 尾部（~2000 字符）
  → 拼入 system prompt
```

不占工具调用轮次，agent "生来就知道" 已知约定与历史结论——
例如下次它一启动就知道"rruleDays 编码 bug 已诊断、修复方案是 handler 处 7→0 归一化"。

**检索（运行中）**

`memory__search`：可插拔检索后端（`RetrievalBackend` 接口）。

```
memory__search(query)
      ↓
  RetrievalBackend（接口）
   ├── GrepBackend      ← v1 默认（fs__grep 限定记忆目录）
   └── VecBackend       ← A/B/C 时挂上（embedding 向量检索）
```

v1 用 GrepBackend（零依赖）；落地时做 A/B/C 测试（grep → embedding → RRF 融合），评测指标：检索命中率 / 任务完成质量 / token 成本 / 维护成本。

**写入（会话结束时，硬纪律）**

system prompt 六步纪律追加第七步：

> **结束前必须固化记忆**：本次结论、新发现、未完成事项写入当日日志；
> 若出现值得长期保留的约定/事实，提议更新 MEMORY.md（需确认）。
> 只记录不可从代码/日志推导的信息（v2 写入纪律）。

| 工具 | 动作 | 风险级 | 自主级 |
|---|---|---|---|
| `memory__search` | 搜索记忆 | read | auto（任何 Level） |
| `memory__append` | 追加当日日志 | low | auto（L1+） |
| `memory__update` | 修改 MEMORY.md / goals.md | medium | L2+ auto / L1 confirm |

### 1.5 为什么 v1 不做 embedding

1. 个人项目记忆体量（百条级）grep 检索完全够用；
2. 零依赖是 PAA 的架构优势，能不加就不加；
3. 检索质量不够时再升级——这是优化项不是功能项。
4. **[v2] 但检索层做成可插拔接口**（`RetrievalBackend`），A/B/C 时只换配置不换代码。

---

## 二、Autonomy 分级

### 2.1 两级结构

```
有效自主级 = min( 全局 Level, 该工具的风险上限 )
硬底线：黑名单命令 / 大范围覆盖 永远 block 或 confirm，L4 也不放行
```

配置放 `paa/config.json` 的 `autonomy` 段：

```json
{
  "autonomy": {
    "level": 2,
    "tools": {
      "fs__write": "confirm",
      "shell__run": "confirm",
      "memory__append": "auto"
    }
  }
}
```

### 2.2 Level 0–4 定义（对齐建议书第九章）

| Level | 含义 | 触发确认的操作 |
|---|---|---|
| 0 | 只回答，不执行任何工具 | 全部（连 read 都不执行） |
| 1 | 只读自动，写全确认 | 所有写操作 |
| 2 | 低风险写自动 | 中/高风险写操作 |
| 3 | 自主规划执行大部分任务 | 仅高危操作 |
| 4 | 高度自主（实验用） | 仅硬底线操作 |

CLI 默认 Level 1（当前行为）；`--yes` 等价于临时 Level 3。

### 2.3 工具风险矩阵

| 工具 | 风险级 | L1 | L2+ | 硬底线 |
|---|---|---|---|---|
| `fs__read` / `fs__grep` / `fs__check` | read | auto | auto | — |
| `memory__append` / `memory__search` | low | auto | auto | — |
| `fs__write`（新建文件 / ≤20 行局部改） | medium | confirm | auto | — |
| `fs__write`（大范围替换 / 改核心文件） | high | confirm | confirm | — |
| `shell__run`（白名单：node --check / git status / git diff） | low | auto | auto | — |
| `shell__run`（白名单外） | high | confirm | confirm | — |
| 黑名单命令命中 | blocked | block | block | **任何 Level 都不放行** |

### 2.4 实现位置

改两处：

1. **skill 定义**：每个工具声明 `risk: 'read' | 'low' | 'medium' | 'high' | 'blocked'` 字段；
2. **ToolPipeline**：dispatch 前加 gate——
   `gate(skill, config.autonomy) → auto | confirm | block`，
   替代现有的全局 `--yes` 布尔判断。

### 2.5 审计（自动执行但不失控的答案）

每次 **auto 执行**的写操作，强制写入当日 daily log：

```
[AUTO] 2026-08-21 18:40 fs__write index.html L1201-1204 (rruleDays 归一化) → ok
```

事后可完整追溯：agent 自己动了什么、何时动的、结果如何。
面试被问"你怎么保证 agent 不失控"时，这就是答案。

---

## 三、实施顺序

| 步骤 | 内容 | 预估 | 依赖 |
|---|---|---|---|
| ① | Autonomy gate（risk 字段 + pipeline gate + config 段 + 审计行） | 半天 | 无 |
| ② | memory 三工具 + 启动注入 + 第七步硬纪律 + L0→L3 蒸馏纪律 | 一天 | ①（append 的 auto 权限走 gate） |
| ③ | 验收：同一 G4 任务（修 rruleDays）带记忆跑，验证"知道上次诊断结果" | — | ② |

①先做：改动小、集中、且 ② 的 memory__append 权限要靠 gate 判定，先有闸门再有记忆。

---

## 四、v2 修订汇总（来源：memory-landscape-research.md）

| # | 修订 | 来源 |
|---|---|---|
| 1 | MEMORY.md 改为索引层，细节外置独立文件，200 行 + 25KB 双重上限 | Claude Code |
| 2 | 写入纪律：只存不可推导信息 / 绝对日期 / 删除测试 | Claude Code |
| 3 | 检索层抽 `RetrievalBackend` 接口，grep 为默认实现，为 A/B/C 预留 | A/B 预留 |
| 4 | 记忆生命周期：热(7d)→多 pass 蒸馏(L0→L1→L2→L3)→温→归档/删除 | 俪宁 + TencentDB + Claude Code 缺陷反推 |
| 5 | 互斥写入、后台提取：记入 v2，v1 不做 | Claude Code |
| 6 | 蒸馏从一步升级为 L0→L3 多 pass（atoms→scenario→core） | TencentDB |
| 7 | 记忆条目加治理元数据（version / last_used / source） | TencentDB |
| 8 | A/B 扩展为 A/B/C（grep→embedding→RRF 融合） | TencentDB 混合检索 |
| 9 | procedural memory 存方法论不存代码位置 | Codebase-Memory + Claude Code |
| 10 | procedural 终极形态 = MCP 外接代码图谱，不自建 | Codebase-Memory |
| 11 | 按任务域分区记忆（Life / Quant / Study） | 建议书第十一章 |
