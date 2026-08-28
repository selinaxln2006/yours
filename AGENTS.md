# AGENTS.md — 给任何进入本仓库的 agent（Codex / WorkBuddy / PAA 内置 agent）

> 先读这个文件，再读 `docs/ROADMAP.md`（全量规划），然后动手。不要跳过。
> 本文件是协作入口：让一个从没来过这个仓库的 agent，在 3 分钟内知道"这是什么、代码在哪、怎么改、别碰什么"。

---

## 这是什么

**PAA（Personal AI Agent Framework）** —— 俪宁的本地个人 AI Agent 框架。目标形态（ROADMAP §九）：

> 本地 OpenClaw 式 agent + 任意浏览器前端 + macOS/iOS 安装包 + 人人可用。

当前阶段：**G1-G7 能力全绿，G8（长程自主）是唯一主线**（见 ROADMAP §二）。俪宁会用 **WorkBuddy（枢）+ Codex（GPT Pro）** 共同开发；框架内置 builder/reviewer 双角色（§十）。

**一句话架构**：`AgentLoop`（循环引擎）是宿主无关的核心；CLI 和 server 是两个宿主；工具全部通过 `ToolPipeline` 注入；记忆/产物/会话全部文件化落盘（`paa/memory|artifacts|runs|data`）。

---

## 目录地图

```
paa/                        # PAA 大脑层（TS ESM，Node 24 直接跑 .ts，零运行时依赖）
├── core/                   # ★ 核心引擎（改这里 = 动框架）
│   ├── agent-loop.ts       # AgentLoop：单轮循环（LLM→工具→结果→再思考），maxRounds 控制
│   ├── planner.ts          # ★ Task Decomposition：模糊目标→任务树→子任务队列（goal-level 主引擎）
│   ├── tool-pipeline.ts    # 工具管道：register/unregister/list + 权限门 + 审计
│   ├── permission.ts       # Autonomy L0-L4 + FORBID 硬名单
│   ├── llm-adapter.ts      # LLM 适配（OpenAI 兼容 + Anthropic 双协议）
│   ├── session-mgr.ts      # run 事件溯源（runs/<sid>/events.jsonl，append-only）
│   ├── chat-session-store.ts # console 会话持久化（T1 数据层种子，多会话）
│   ├── life-store.ts       # 生活数据 18 键分文件 JSON（原子写/损坏自愈/tx）
│   ├── memory-provider.ts  # 记忆（L0-L3 分层，文件即记忆）
│   ├── artifact-provider.ts# 产物（artifacts/ 真文件落盘 + index.json）
│   ├── pkg-loader.ts       # 技能包加载（ToolPkg：manifest.json + impl.mjs）
│   ├── mcp-client.ts       # MCP client（零依赖 JSON-RPC over stdio）
│   ├── types.ts            # 共享类型
│   └── ws.ts               # 零依赖 WebSocket
├── cli/                    # 宿主 1：CLI（node cli/main.ts）
│   ├── main.ts             # 入口：--once / --goal / --agent / --yes 等
│   └── render.ts           # 终端渲染
├── server/                 # 宿主 2：console server（127.0.0.1:8765）
│   └── main.ts             # HTTP 静态+REST+WS+chat
├── tools/                  # 内置工具组（注入到 pipeline）
│   ├── core-tools.ts       # fs_read/write/append/patch/list/grep + shell_run（沙箱+黑名单）
│   ├── memory-tools.ts     # memory_search/list/save/consolidate/forget
│   ├── artifact-tools.ts   # artifact_create/update/read/list/versions
│   ├── pkg-tools.ts        # pkg_list/install/uninstall/reload
│   └── web-tools.ts        # web_fetch/search/download（server 宿主用）
├── pkgs/                   # 技能包（ToolPkg 标准）
├── agents/                 # agent 角色配置（builder/reviewer JSON，见 §十）
├── data/                   # 生活数据（运行时生成，.gitignore，不入库）
├── memory/                 # 记忆 store（运行时生成，不入库）
├── artifacts/              # 产物（运行时生成，不入库）
├── runs/                   # 会话转录（运行时生成，不入库）
├── test/                   # node --test 测试
└── config.json             # 本地密钥配置（.gitignore，不入库！）
docs/                       # 规划与架构文档
├── ROADMAP.md              # ★ 全量规划（先读）
├── SUPABASE-SETUP.md       # 云同步注册教程
├── paa-design-v2.md        # 大脑设计
├── paa-host-evolution-v1.md# 宿主演进
└── console-v1.md           # console 工程
index.html 已退役（B3，2026-08-28 删除，git 历史可回滚）
console.html               # console 前端（唯一前端宿主）
```

---

## 运行命令

```bash
npm run check              # tsc --noEmit 类型检查（改完必跑）
npm test                   # node --test（test/ 目录，超时 15s 兜底）
npm run cli                # 进入交互 CLI

# 常用 CLI 模式
node cli/main.ts --once "一句话指令"                 # 单次执行
node cli/main.ts --goal "模糊大目标" --yes            # planner 长任务（全自动）
node cli/main.ts --agent reviewer --once "审查 xx"    # 评审角色（只读）
```

---

## 关键设计决策（改代码前必须知道）

| 决策 | 内容 | 为什么 |
|------|------|--------|
| **零运行时依赖** | 核心无 npm 依赖（自研 WS/MCP/存储），只有 devDeps（typescript/@types/node） | 可移植、可打包、可信 |
| **TS ESM 直跑** | Node 24 type stripping，`.ts` 直接 `node` 跑，不编译 | 无构建步骤 |
| **文件即数据** | 记忆/产物/会话/生活数据全是文件（JSON/JSONL），无数据库 | 数据主权在用户、易备份迁移 |
| **宿主无关大脑** | 大脑层不 import CLI/server 任何东西；宿主只负责注入工具+ctx | 同一个引擎跑 CLI/server/reviewer |
| **工具即能力** | 所有外部能力 = ToolPipeline 注册的工具；角色 = 白名单 + prompt 模板 | "引入新 agent"=写 JSON，不改框架 |
| **权限物理隔离** | reviewer 白名单里根本没有写工具 → 物理上改不了代码（不是靠自觉） | 安全不用信任 |
| **config.json 不入库** | 含 API key；`.gitignore` 已排除 | 密钥安全 |

---

## 协作纪律（所有 agent 必须遵守）

1. **先读再改**：`docs/ROADMAP.md` 是唯一真理；动手前 `grep` 定位，不要瞎猜路径
2. **最小修改**：只改必要处，不顺手重构；一次只做一件事
3. **改后必验**：`npm run check` + 相关 `npm test` 必须过；大文件（>200 行）分段写（fs 骨架 + 追加）
4. **长任务先建任务树**：模糊目标一律走 `--goal`（planner），不手动硬啃
5. **冻结文件别碰**：`index.html` 已退役删除（别恢复，别 git add -f）；`paa/config.json`（含密钥，只读）
6. **不入库**：`paa/runs|memory|artifacts|data`、`config.json` 都在 .gitignore，别 `git add -f`
7. **提交规范**：commit message 用中文，作者邮箱 `182077080+selinaxln2006@users.noreply.github.com`（本地 git config 已设，别改）
8. **G8 纪律**：没到"长程自主实测通过"前，任何人问"到 Codex 级了吗"，答案一律"没有"——包括 Codex 自己

---

## 分工建议（WorkBuddy ↔ Codex）

| 工作类型 | 谁来做 | 原因 |
|----------|--------|------|
| 大脑层/循环引擎（core/） | **WorkBuddy（枢）** | 全程参与架构，上下文最全；动框架要连续演进 |
| 长程自主主线（G8/planner/compaction） | **WorkBuddy** | 这是核心主线，需要实测迭代闭环 |
| 独立功能模块（新工具/新技能包/前端 UI） | **Codex** | 边界清晰、可独立完成、Codex 大上下文适合整块交付 |
| 大规模重构 / 类型债清理 | **Codex** | 一次性的机械工作，Codex 擅长 |
| 代码审查（内置 reviewer 跑） | **PAA 自身** | 用 `--agent reviewer`，正好验证框架能力 |
| 跨模块联调 / 冲突解决 | **WorkBuddy** | 需要全局视角 |

> 黄金法则：**谁改 core/，谁先说话**——core/ 是框架的心脏，两个 agent 同时动会踩；改之前看 `git log --oneline -5` 和 ROADMAP 最新进度，或先问俪宁。
