# HANDOFF-CODEX — Codex 交接单

> 日期：2026-09-04 ｜ 作者：枢（WorkBuddy）
> 读者：Codex（GPT Pro 会话），或任何接手 PAA 仓库的 agent / 人类。
> 前置阅读：`AGENTS.md`（协作入口）→ `docs/ROADMAP.md`（全量规划）。本文是补充交接，不重复其内容。

---

## 一、仓库当前快照（截至 2026-09-04）

| 项 | 状态 |
|---|---|
| G8（长程自主） | ✅ 已通过（第三靶"今日概览"：8/8 子任务 + re-plan 自愈真实触发 + 0 人工插手） |
| 测试基线 | **76/76 全过**（`cd paa && npm test`） |
| 类型债 | **9 处 pre-existing 错误**（详见第四节 P0 任务） |
| 最新 commits | `4fed469`（svc_restart 工具+证据纪律）← `34c9a85`（mobile.html v2 重写）← `f07a6df`（M7 路径+maxRounds 自检） |
| 前端 | console.html（PC 宿主，唯一全功能端）+ mobile.html（v2 刚重写，见下） |
| M7 云大脑 | BLOCKED：等俪宁注册 Oracle Cloud（Always Free ARM），**不要替她点注册流程** |
| Codex 专属 Azure VM | moomoo-research-sg2（Windows Server 2025 / B2as_v2）——已评估**不适合**跑 PAA 24×7，闲置 |

### mobile.html v2（本次重写，供你接手维护）

2026-09-04 由枢从 518 行"指挥官视角"版**整体重写**（上一版被用户判定不可用）。v2 原则：**所有功能接真实 API，零假按钮**。

- 三 Tab：对话（SSE 流式 + 会话切换/新建/删除 + uiHistory 还原）/ 日程（7 天视图 + rrule 重复展开 + 添加/删除）/ 待办（勾选/添加/删除/priority）
- 顶部概览卡（`GET /api/overview`）+ 手动云同步（`POST /api/sync`）
- 令牌门禁与 console.html 同机制（`x-access-token` header / HttpOnly cookie / 403 全屏 gate）
- 已验证：`GET /mobile.html` 200（43KB）、内嵌 JS 语法校验通过、三个关键 API 200
- 已知未做（有意）：工具卡历史还原（省流量）、WS 实时推送（SSE 足够）、超过 7 天的日程视图

---

## 二、红线（违反 = 返工）

1. **`paa/core/` 是 WorkBuddy 领地**。改 core/ 前先在群里说一声 + 看 `git log --oneline -5`。你改 core/ 会和 G8 主线撞车。
2. `paa/config.json` 含 API key，**只读、不入库**（已在 .gitignore，别 `git add -f`）。
3. `paa/runs|memory|artifacts|data` 全部不入库。
4. index.html 已退役删除（B3），**不要恢复**。
5. commit message 用中文；作者邮箱已设 noreply，别动 git config。
6. G8 纪律：长程自主实测通过前，"到 Codex 级了吗"的答案永远是"没有"。
7. **验收 = `npm run check` + `npm test` 双绿**。类型债允许暂存（见 P0），但不允许净增。

---

## 三、你的任务清单（按优先级）

### P0 · 类型债清零（预计半天）

`tsc --noEmit` 当前 9 处错误（输出落盘验证，别信终端回显，PowerShell 会吞）：

| 文件 | 错误 | 提示 |
|---|---|---|
| `core/chat-session-store.ts:67,69,73` | `string \| null` 不能赋给 `string \| undefined`（×3） | 看上下文，大概率是 `?? undefined` 或改类型定义。**注意这是 core/，改动最小化，改前知会** |
| `core/pkg-loader.ts:153-158` | `mm.tools` 是 `unknown`（×3） | manifest 的 tools 字段缺类型收窄，加一个 type guard |
| `core/realtime.ts:145` | 对象字面量多余属性 `config` | 消息类型定义缺字段，补类型或收敛 |
| `core/ws.ts:193` | `Duplex` 上没有 `setNoDelay` | cast 成 `net.Socket` 或改用类型断言 |
| `test/chat-session-persist.ts:23,58` | `ChatMessage` 不认识 `refs`（×2） | 要么 `ChatMessage` 加可选 `refs` 字段，要么测试改用合法字段——先看 refs 是不是历史遗留 |
| `test/realtime.test.ts:58` | `Promise<string \| null \| undefined>` ≠ `Promise<string \| null>` | 补 `?? null` |

注意：chat-session-store / pkg-loader / realtime / ws 都是 core/。如果走"改类型定义"路线，属于低风险机械改动，可以做，但 **commit 单独提交**（`类型债: xxx`），不要和其他工作混。

### P1 · 前端共享库抽取（预计 1 天，G8 后启动）

mobile.html v2 和 console.html 有五段几乎相同的逻辑（各写了一份）：

1. **fetch 包装器**：token 注入（localStorage → `x-access-token` header）+ 403 拦截 + cookie 记忆
2. **SSE 解析器**：`/api/chat/stream` 的事件切分（`data:` 行 + `\n\n` 分帧 + JSON parse）
3. **SSE 事件处理**：meta/delta/event(tool|tool_result)/done/error 协议
4. **rrule 事件展开**：`expandInWindow`（weekly/biweekly/monthly/weekday/daily + rruleUntil）
5. **数据数组操作**：`arrAdd/arrDel/arrSet` → `PUT /api/data/:key`

建议形态：`paa/public/shared.js`（或 `console-assets/shared.js`，ES module），两端 `<script type="module">` 引入。**约束：不引入构建步骤**（本仓库零构建纪律，Node 24 直跑 .ts、前端纯静态）。先出方案再动手，俪宁偏好"多选项列清 → 确认 → 批量执行"。

### P2 · /api/overview 异常路径加固（半天）

G8 第三靶的产物，已知短板（ROADMAP 局限清单 L3）：
- 登录态/未登录、数据文件损坏、空 schedule 时的异常路径没覆盖
- 没有单元测试
- 建议：server 侧加 try/catch 分层 + `test/overview.test.ts`

### P3 · M6 壳 App（等时机，现在别动）

Capacitor 包 console/mobile 成 iOS/Android/macOS 安装包。前置条件：前端打磨完成 + 俪宁发令。ROADMAP §九有决策表，等她勾选。

---

## 四、环境坑（Windows + PowerShell 专属，全是血泪）

| 坑 | 解法 |
|---|---|
| `npx` 输出被 CLIXML 吞掉 | `node node_modules\typescript\bin\tsc --noEmit > out.txt 2>&1` 落文件读 |
| `curl.exe -d` 传 JSON 引号被 PowerShell 剥 | 用 `Invoke-RestMethod`，或引号转义地狱 |
| `Start-Process` 传含空格参数 | 必须单字符串 + 内嵌引号，数组含空格元素会被拆断 |
| npm 命令 | 必须在 `paa/` 目录下跑（package.json 在那） |
| `Get-Content` 无编码参数会被拦 | 用 `-Encoding UTF8` 或直接读文件工具 |
| Node 24 type stripping | 不支持 constructor 参数属性（`constructor(private x)` 会炸），写普通字段 |

## 五、验证命令速查

```powershell
cd c:\Users\selin\WorkBuddy\20260812100418\paa
npm run check   # 类型检查（当前 9 错，你清零后应为 0）
npm test        # 76/76 是基线，别让它掉
# server 冒烟（如果改了 server 代码，改完必须重启 8765/18765 旧进程再测）
curl.exe -s -o NUL -w "%{http_code}" -H "x-access-token: <见 paa/data/lan.json>" http://127.0.0.1:18765/mobile.html
```

> LAN 令牌在 `paa/data/lan.json` 的 accessToken（不入库）。手机端入口 `http://<设备名>.<tailnet>.ts.net:18765/mobile.html`（Tailscale MagicDNS）。
