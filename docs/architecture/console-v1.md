# Console v1 — 主客反转：PAA 控制台 + 生活工作台附属面板

> **日期**：2026-08-25
> **状态**：已拍板（路线 2：数据文件化终态）
> **强约束**：**不许为跑通而降级实现质量**
> 主客反转：控制台（agent 对话）为主体，index.html 的生活工作台功能降级为控制台的附属面板。

## 1. 架构总览

```
浏览器（壳）                        Node 侧（大脑 + 数据主权）
┌─────────────────────┐            ┌──────────────────────────────────┐
│ console.html        │   HTTP     │ paa/server/main.ts               │
│  ├ 对话主区          │ ─────────▶ │  ├ 静态服务（console/index.html） │
│  │  (chat + 工具卡    │   REST    │  ├ /api/data/*  /api/chat        │
│  │   + 确认卡)        │           │  └ /api/import（localStorage 迁移）│
│  └ 附属面板 tabs      │   WS      │ paa/core/*（大脑四件套不动）        │
│     日程/健身/养生/    │ ◀───────▶ │  ├ AgentLoop（扩展 prior+onEvent） │
│     目标/待办/资产     │  变更推送   │  └ ToolPipeline + Permission       │
└─────────────────────┘            │ paa/pkgs/life/（真 ToolPkg）       │
                                   │  ├ manifest.json（13 工具声明）     │
  index.html（冻结，不动）            │  └ impl.mjs（走 pkg-loader 加载）   │
  同源提供 → 一键迁移 localStorage    │ paa/core/life-store.ts（数据 provider）│
                                   │  └ paa/data/life/*.json（18 键分文件）│
                                   └──────────────────────────────────┘
```

## 2. 模块清单与强约束落实

| # | 模块 | 文件 | 强约束落实（非最简实现） |
|---|------|------|------------------------|
| 1 | LifeStore 数据 provider | `paa/core/life-store.ts` | 每键一文件；**原子写**（tmp+rename）；**损坏自愈**（解析失败→隔离 `.corrupt-<ts>`→重建默认+heal 事件）；**schema 校验**（写入前结构校验，非法即拒绝）；**tx 事务**（多键跨模块写入一次提交，diff 出变更键逐键发事件） |
| 2 | pkg-loader services 注入 | `paa/core/pkg-loader.ts`（扩展） | PkgEnv 增 `services?`；manifest 增 `services?: string[]` 声明依赖，加载时校验宿主已注入，缺依赖即加载失败（声明式 DI，不是隐式全局） |
| 3 | life ToolPkg | `paa/pkgs/life/{manifest.json, impl.mjs}` | **真 ToolPkg**：manifest 声明 13 工具（含 ParamSpec/risk），impl.mjs 默认导出 `createPkgTools(env)`，经 `pkgLoader.loadAll()` 动态加载注册为 `life_*`；业务逻辑从 index.html 逐条移植（create_goal 的 _decompose/_genTodos、add_schedule 的 count→rruleUntil、add_sleep 的按日期 upsert） |
| 4 | 服务层 | `paa/server/main.ts` + `paa/core/ws.ts` | 正确 API 分层：静态 + REST + WS；**WS 从零实现 RFC6455**（握手 sha1、帧编解码、ping/pong、close），零 npm 依赖；risk≥3 写操作经 `ctx.ask` → WS 确认卡 → 浏览器点允许/拒绝（60s 超时拒），支持 always-allow 会话级放行 |
| 5 | AgentLoop 微扩展 | `paa/core/agent-loop.ts`（扩展） | `run(input, ctx, opts?: {prior?, onEvent?})`：prior 注入跨 run 对话历史；onEvent 实时回调（WS 推工具卡/确认卡）；完全向后兼容，CLI 不改 |
| 6 | console 前端 | `console.html`（工作区根） | 状态驱动渲染：REST 拉全量 + WS change 事件局部刷新；确认卡/工具卡/对话三态；不写 localStorage（数据主权在 Node 侧） |
| 7 | 数据迁移 | console 迁移面板 + `/api/import` | 服务层与旧 serve.cjs 同端口 8765 → **同源**，console 直接读旧 `localStorage.shu_wb_v1` 一键导入（replace/merge）；index.html 一字不动 |

## 3. REST API

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/health` | {ok, level, tools, pkgs, memory} |
| GET | `/api/data` | 全部 18 键（aiConfig.apiKey 脱敏） |
| GET | `/api/data/:key` | 单键 |
| PUT | `/api/data/:key` | body=value，source='ui'，走 tx+校验+事件 |
| POST | `/api/import` | {data, mode:'replace'\|'merge'}，localStorage 迁移入口 |
| POST | `/api/chat` | {message, sessionId?} → {answer, rounds, toolCalls, sessionId}；过程事件经 WS 实时推 |

## 4. WS 协议（JSON 文本帧）

服务端→客户端：
- `{type:'change', key, source}` — 数据变更（agent/ui/import），前端局部刷新
- `{type:'tool', payload:{name, arguments, result}}` — 工具卡实时推送
- `{type:'confirm', id, tool, args}` — risk≥3 写操作确认卡
- `{type:'heal', key}` — 数据文件损坏自愈通知
- `{type:'welcome', sessionId, level, tools}` — 连接建立

客户端→服务端：
- `{type:'confirm', id, ok, always?}` — 确认卡应答（always=会话级放行该工具）

## 5. 数据布局

- `paa/data/life/<key>.json` — 18 键各一文件（profile/transactions/investments/weights/meals/water/exerciseLog/exercisePlan/sleep/beauty/stretching/meditation/schedule/todos/goals/aiConfig/chatHistory/settings/cloudSync）
- 写入路径：`<key>.json.tmp` → `rename` 覆盖（同卷原子）
- 损坏路径：解析失败 → rename 为 `<key>.corrupt-<ts>.json` → 重建默认值 → heal 事件

## 6. 验收（e2e）

1. `node --test`（paa/）全绿：life-store（原子写/自愈/校验/tx）、life pkg（经 PkgLoader 真加载、13 工具 handler 行为与 index.html 语义一致）
2. `node paa/server/main.ts` 起服 → console 打开 → 迁移旧数据 → 附属面板显示真实数据
3. chat「帮我记录今天体重 57.5」→ WS 推确认卡 → 点允许 → 体重面板实时出现新记录（change 事件）
4. index.html 冻结验证：git diff 无变化

## 7. 非目标（本轮不做）

- Google Calendar / Supabase 云同步（沿用既有路线图）
- agent 流式 token 输出（onEvent 已预留接口，后续接 adapter 流式）
- index.html 的任何修改
