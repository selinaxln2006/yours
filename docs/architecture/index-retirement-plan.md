# index.html 退役迁移侦察报告

> 状态：侦察完成（只读分析，未改动任何代码）
> 日期：2026-08-28
> 范围：index.html（已冻结旧 PWA，112KB / 1653 行）→ console.html（新前端宿主）迁移评估

---

## 1. 背景与结论摘要

`index.html` 是已冻结的旧版 PWA 前端（单文件应用，内嵌 CSS/JS，标题「枢 · 生活工作台」），不再开发。`console.html` 是新的主线前端宿主，承载自治代理（autonomy）能力。本报告目标：完整盘点 index.html 功能、与 console.html 逐项对比、评估未迁移项工作量与优先级，最终给出退役步骤与风险清单。

**核心结论（摘要）**：

| 维度 | 结论 |
|---|---|
| index.html 总功能模块 | 8 大模块（dashboard / finance / fitness / wellness / schedule / goals / todos / settings） |
| 已迁移到 console | **7/8 业务模块已由 console 面板完整承接**（finance/fitness/wellness/schedule/goals/todos/settings），数据经 API 落盘 |
| console 不再需要 | 旧单文件架构、旧模块导航、localStorage 直读（由 `migBtn` 迁移能力取代） |
| 未迁移（少量） | dashboard「今日概览」聚合面板、图表可视化、待办进度环、主题切换（均属体验增强） |
| 退役可行性 | **可行**，且退役硬前置条件（业务面板 + 数据迁移能力）已基本满足；仅需同步处理 sw/manifest/serve 三处耦合 |

---

## 2. index.html 完整功能清单

> 依据：对 index.html 全部 1653 行分段通读 + fs_grep 交叉验证关键符号。以下为完整功能模块盘点。

### 2.1 页面架构与全局机制

| 功能点 | 说明 | 关键实现 |
|---|---|---|
| 单文件应用 | 内嵌 CSS + JS，无外部构建 | 全部在 index.html 内 |
| 主题切换 | `data-theme` 属性，light/dark 双主题 | 全局 CSS 变量 + 切换逻辑 |
| 侧边栏导航 | `#sidebar`（logo + 导航项），8 大模块切换 | 页面切换逻辑 |
| 数据存储 | localStorage（`shu_wb_v1` 为主键）+ 可能 IndexedDB | 读/写/版本迁移 |
| API 调用 | fetch 到后端（生活数据 CRUD） | `fetch('/api/...')` |
| PWA | Service Worker 注册 + manifest | 见 §4 耦合点 |
| 时间/日期处理 | 日程、日历、图表的时间维度 | 内联实现 |

### 2.2 八大功能模块

#### A. dashboard（今日 / 概览）

| 功能点 | 说明 |
|---|---|
| 生活指数 lifeIndex | 综合评分展示 |
| 今日日程 | 当日日程列表 |
| 待办进度环 | 环形进度图展示待办完成率 |
| 最新体重 | 最近一次体重记录 |
| 支出/收入 | 当日收支概览 |
| 图表 | donut（环形）/ line（折线）/ bars（柱状）三种图表 |

#### B. finance（记账）

| 功能点 | 说明 |
|---|---|
| 交易列表 | 全部收支流水 |
| 分类汇总 | 按分类聚合统计 |
| 投资分配 | 投资配置展示 |
| 月度收支 | 按月收支统计 |
| 账户流水 | 分账户流水 |
| 记一笔 | 新增交易 |
| 删除 | 删除交易 |

#### C. fitness（健身）

| 功能点 | 说明 |
|---|---|
| 体重跟踪 | 体重记录与趋势 |
| 饮食卡路里 | 每日卡路里摄入 |
| 运动 | 运动记录 |
| 日历 | meals / exerciseLog 日历视图 |
| 编辑日 | 按日编辑记录 |

#### D. wellness（养生 / 习惯）

| 功能点 | 说明 |
|---|---|
| 习惯打卡 | 睡眠 / 护肤 / 拉伸 / 饮水 / 冥想 五类习惯 |
| 喝水 | 饮水记录 |
| 睡眠 | 睡眠记录 |
| 冥想 | 冥想记录 |
| 养生日历 | 养生维度日历 |

#### E. schedule（日程）

| 功能点 | 说明 |
|---|---|
| 日程管理 | 日程 CRUD |
| 日历视图 | 按日/月展示日程 |

#### F. goals（目标）

| 功能点 | 说明 |
|---|---|
| 目标列表 | 目标展示 |
| 目标进度 | streakDays / goalProgress 进度追踪 |

#### G. todos（待办）

| 功能点 | 说明 |
|---|---|
| 待办列表 | 待办 CRUD |
| 完成状态 | 勾选完成 |

#### H. settings（设置）

| 功能点 | 说明 |
|---|---|
| 主题切换 | light/dark（见 §2.1） |
| 数据导出/备份 | 本地数据管理 |

### 2.3 事件与交互机制

- 事件绑定：模块切换、表单提交、打卡交互、图表渲染
- WebSocket：handleWs / handleEvent 处理实时推送（tool 分支）
- confirm 弹窗：删除等危险操作的确认框
- 数据版本迁移：localStorage 结构升级逻辑

---

## 3. index.html 与 console.html 功能逐项对比

> 三态标注：✅ 已迁移 / ⏳ 未迁移 / ➖ console 不再需要（附理由）
> 依据：console.html 全量分段通读（含 1284-2180 行面板实现区段）+ fs_grep 交叉验证。console 面板路由 `renderers = { schedule, fitness, wellness, finance, todos, goals, memory, settings }`（line 1237），已覆盖 index 的 8 大业务模块。

### 3.1 全局机制对比

| index.html 功能 | 状态 | console.html 对应/理由 |
|---|---|---|
| 单文件应用 | ➖ 不再需要 | console.html 是独立新宿主，有自己的架构 |
| 主题切换（light/dark） | ⏳ 未迁移 | console 无 `data-theme` 主题切换（grep 确认 0 命中），仅硬底线/自治级别等设置 |
| 侧边栏导航（8 模块） | ➖ 不再需要 | console 以 tab 面板体系（schedule/fitness/wellness/finance/todos/goals/memory/settings）组织 |
| localStorage 直读（`shu_wb_v1`） | ➖ 不再需要 | console 走 API + 自治代理；但设置面板提供 `migBtn` 一键迁移旧数据（line 2049-2052） |
| API 调用 | ✅ 已迁移 | console 全面走 REST API（`/api/...`），数据经 `putData`/`arrAdd`/`arrSet`/`arrDel` 落盘 |
| PWA（sw/manifest） | ⏳ 未迁移 | console 无 `serviceWorker.register`/`manifest` 引用（grep 确认 0 命中），尚未接入 PWA |
| WebSocket 实时推送 | ✅ 已迁移 | console 有 `new WebSocket(.../ws)` 客户端（line 784），对接自治代理事件流 |

### 3.2 功能模块对比

| index 模块/功能 | 状态 | console 对应/理由 |
|---|---|---|
| **dashboard（今日概览）**：生活指数 lifeIndex | ⏳ 未迁移 | console 无独立「今日概览」面板，各数据分散在对应 tab 面板中 |
| dashboard：今日日程 | ✅ 已迁移 | pSchedule 默认展示当日日程（含「today」高亮） |
| dashboard：待办进度环 | ⏳ 未迁移 | 无待办完成率环形图；pTodos 有「待完成 N 项」计数但非环形进度 |
| dashboard：最新体重 | ✅ 已迁移 | pFitness 顶部 mini3 展示最新体重 |
| dashboard：支出/收入概览 | ✅ 已迁移 | pFinance 顶部 mini3 展示收入/支出/结余 |
| dashboard：图表（donut/line/bars） | ⏳ 未迁移 | console 无 canvas/chart 图表渲染（grep 确认 0 命中），以 mini3/月历/列表替代 |
| **finance（记账）**：交易列表 | ✅ 已迁移 | pFinance 按日/月/年周期过滤展示交易 |
| finance：分类汇总 | ✅ 已迁移 | pFinance 含 9 类分类（TX_CATS）+ 分类颜色映射 |
| finance：投资分配 | ✅ 已迁移 | pFinance 处理 `investments`（goals 的 saving 目标也引用） |
| finance：月度收支 | ✅ 已迁移 | pFinance 支持 day/month/year 三档周期切换 |
| finance：账户流水 | ✅ 已迁移 | pFinance 交易流水含收入/支出类型过滤 |
| finance：记一笔/删除 | ✅ 已迁移 | pFinance `openModal('记一笔')`（类型/金额/分类/备注）+ 删除 |
| **fitness（健身）**：体重跟踪 | ✅ 已迁移 | pFitness 记录体重 + 最新体重展示 |
| fitness：饮食卡路里 | ✅ 已迁移 | pFitness 记录饮食（餐次/热量）+ 今日摄入汇总对比目标 |
| fitness：运动 | ✅ 已迁移 | pFitness 记录运动 + 今日运动时长 |
| fitness：日历（meals/exerciseLog） | ✅ 已迁移 | pFitness 双月历（weight/calorie 视图切换） |
| fitness：编辑日 | ✅ 已迁移 | pFitness 按日记录/修改体重、饮食 |
| **wellness（养生）**：习惯打卡（睡眠/护肤/拉伸/饮水/冥想） | ✅ 已迁移 | pWellness 五打卡聚合月历 + 快捷打卡（饮水/拉伸/睡眠/美容/冥想） |
| wellness：喝水/睡眠/冥想 | ✅ 已迁移 | pWellness 快捷 +250ml 饮水、记录睡眠（时长/质量）、冥想 |
| wellness：养生日历 | ✅ 已迁移 | pWellness 五打卡聚合月历视图 |
| **schedule（日程）**：日程 CRUD + 日历 | ✅ 已迁移 | pSchedule 日/周/月视图 + rrule 展开（daily/weekly/biweekly/monthly/weekday） |
| **goals（目标）**：目标列表 + 进度 | ✅ 已迁移 | pGoals `streakDays`/`goalProgress`（weight/saving/habit）/`genMilestones` |
| **todos（待办）**：待办 CRUD | ✅ 已迁移 | pTodos 添加/完成/删除 + P高/中/低优先级排序 |
| **settings（设置）**：主题切换 | ⏳ 未迁移 | console 无主题切换 |
| settings：数据迁移 | ✅ 已迁移 | pSettings 含 `migBtn`（localStorage `shu_wb_v1` → `/api/import` merge 模式） |

### 3.3 对比小结

- **已迁移（主体）**：8 大业务模块中 7 个已由 console 面板完整承接（finance/fitness/wellness/schedule/goals/todos/settings），数据经 API 落盘 + 自治代理接管。
- **未迁移（少量）**：dashboard「今日概览」独立面板、待办进度环、图表渲染（donut/line/bars）、主题切换。
- **不再需要**：旧单文件架构、旧模块侧边栏导航、localStorage 直读（被 `migBtn` 迁移能力取代）。

> ✅ 关键判断（修正）：**index.html 的业务功能绝大部分已迁移到 console**。真正的缺口集中在「今日概览聚合面板 + 图表可视化 + 主题切换」三处，均属体验增强而非功能阻断。这与初版评估（误判大部分业务 UI 未复刻）不同——console 的 1284-2180 行面板实现区段已涵盖全部业务模块。

---

## 4. 未迁移项工作量与优先级评估

> 约束：console 是主线宿主、index 已冻结不再开发；数据域已由 console 自治代理接管。
> 优先级：🔴 高（退役硬阻塞）/ 🟡 中（建议补齐）/ 🟢 低（可延后或放弃）。

### 4.1 评估表

> 修正说明：初版评估基于「大部分业务 UI 未复刻」的误判，将 8 大类功能标为未迁移。实际 console 已实现 8 面板中的 7 个业务面板，**真正未迁移的仅 4 个小项**（见下表）。

| 未迁移项 | 工作量 | 优先级 | 评估理由 |
|---|---|---|---|
| dashboard「今日概览」聚合面板（生活指数/待办进度/收支/体重聚合） | 中 | 🟡 中 | 数据全在 console 各面板已有，仅需一个聚合视图；非退役硬阻塞，作 console 首屏增强 |
| 图表可视化（donut/line/bars） | 中 | 🟢 低 | console 现以 mini3/月历/列表替代图表，功能已覆盖；图表是纯可视化增强，可延后 |
| 待办进度环（环形图） | 小 | 🟢 低 | pTodos 已有「待完成 N 项」计数，环形图仅视觉升级 |
| 主题切换（light/dark） | 小 | 🟢 低 | 纯体验项，非功能阻塞，可延后 |

### 4.2 优先级分组建议

**第一梯队（无硬阻塞项）**：修正后未迁移项均不构成退役硬阻塞——7 大业务面板已就绪，数据迁移能力（`migBtn`）已具备。**退役硬前置条件实际已满足**。

**第二梯队（建议补齐，🟡）**：dashboard「今日概览」聚合面板 —— 数据已分散在各面板就绪，聚合视图收益高、成本中，建议随 console 迭代补齐。

**第三梯队（可延后/放弃，🟢）**：图表渲染、待办进度环、主题切换 —— 纯可视化/体验增强，不构成退役阻塞。

### 4.3 迁移策略建议

- 数据层：**已就绪**。console 的 `migBtn` 已能一键迁移 localStorage `shu_wb_v1` → `/api/import`（merge 模式）。注意：console 设置面板文案标注该数据为「开发期假数据，可忽略」，实际迁移价值有限，但机制完整。
- UI 层：**主体已迁移**。8 面板中 7 个业务面板已完整承接 index 功能，且 console 面板走 API 数据流（`putData`/`arrAdd`/`arrSet`/`arrDel`），比 index 的 localStorage 直读更健壮。
- 行为层：自治代理接管后，部分「手动录入」可升级为「代理自动记录 + 用户确认」，这是 console 相比 index 的价值增量（如「对枢说添加待办」）。

---

## 5. index.html 退役步骤建议

> 依据：t3 确认的关联文件耦合点（sw.js 强耦合 index.html、manifest.json 引用、serve 静态路由）。

### 5.1 分阶段退役流程

**阶段一：冻结确认（当前已满足）**
- index.html 已冻结，不再接收新功能开发。
- 确认所有 index 独有数据已可被 console 的 `migBtn` 迁移（localStorage `shu_wb_v1` → `/api/import`）。

**阶段二：缺口补齐与数据验证（退役建议前置）**
- 按 §4.2 建议补齐 dashboard「今日概览」聚合面板（🟡），作为 console 首屏增强，可复用各面板已有数据。
- 图表/待办进度环/主题切换（🟢）可选，不阻塞退役。
- 数据迁移验证：用 `migBtn` 迁移 localStorage `shu_wb_v1` → `/api/import`，抽查关键字段（体重/交易/日程/习惯）是否完整落入 console 数据域。

**阶段三：切换与并行验证**
- console 作为唯一入口，设置新用户默认进入 console。
- 保留 index.html 并行运行一段观察期（如 1-2 周），监控 console 无功能缺口、数据无丢失。
- 期间收集用户反馈，补齐遗漏的 🟡 项（dashboard 今日概览聚合面板）。

**阶段四：删除 index.html 及关联文件**
- 删除 index.html 主文件。
- 同步清理/更新关联文件（见 §6 风险清单）。
- 更新 serve 静态路由，移除对 index.html 的默认首页指向。

### 5.2 删除时的关联文件处理

| 关联文件 | 耦合点 | 退役处理 |
|---|---|---|
| sw.js | Service Worker `ASSETS` 数组里缓存 index.html 及相关静态资源 | 更新 `ASSETS` 移除 index.html；或随退役一并下线 sw 缓存策略 |
| manifest.json | PWA 清单（名称/图标/起始页可能指向 index.html） | 更新起始页指向 console.html，或整体迁移 manifest 到 console |
| serve.cjs | 静态文件服务，可能将 index.html 设为默认首页 | 改默认首页为 console.html；确认 MIME 表含 sw.js/manifest 特殊处理是否仍需保留 |

---

## 6. 风险清单

| 风险 | 等级 | 说明与缓解 |
|---|---|---|
| 数据迁移丢失 | 🔴 高 | `migBtn` 走 merge 模式，若 index 的 `shu_wb_v1` 结构与 `/api/import` 期望格式不一致可能丢字段。缓解：迁移前做 schema 校验 + 备份 localStorage；迁移后抽查关键字段（体重/交易/日程/习惯）。 |
| 高频功能缺口 | 🔴 高 | 若 console 面板存在功能缺口（如 dashboard 概览缺失影响使用体验），删除 index 会让用户失去对应入口。缓解：退役前确认 7 大业务面板已就绪 + dashboard 概览补齐或明确放弃。 |
| sw.js 缓存残留 | 🟡 中 | 若 sw 缓存了 index.html，删除文件后旧缓存可能仍被加载。缓解：退役时更新 sw `ASSETS` 并主动 `cache.delete` 旧键。 |
| manifest 指向失效 | 🟡 中 | 若 manifest 起始页指向已删除的 index.html，PWA 安装会失效。缓解：退役同步更新 manifest。 |
| serve 默认首页 404 | 🟡 中 | 删除 index.html 后若 serve 仍指向它，访问根路径 404。缓解：退役时改默认首页为 console.html。 |
| 用户习惯迁移 | 🟢 低 | 旧用户习惯 index 布局。缓解：console 面板尽量复用 index 的交互隐喻（打卡/记一笔/日历）。 |
| 回滚方案 | 🟢 低 | 退役前对 index.html 及关联文件做版本备份（git 或快照），如 console 出现严重问题可临时恢复 index。 |

### 6.1 回滚方案

- 删除前：确认 index.html、sw.js、manifest.json、serve.cjs 均已纳入版本控制（git）。
- 回滚触发条件：console 出现数据丢失、高频功能不可用且短期无法修复。
- 回滚动作：恢复 index.html + 还原 serve 默认首页 + 更新 sw 缓存策略，即可临时切回旧入口。

---

## 7. 结论

index.html 退役**可行**，且退役硬前置条件已基本满足：8 大业务模块中 7 个已由 console 面板完整承接（finance/fitness/wellness/schedule/goals/todos/settings），数据经 API 落盘 + 自治代理接管，`migBtn` 提供旧数据迁移能力。真正未迁移的仅 dashboard「今日概览」聚合面板、图表可视化、待办进度环、主题切换 4 个小项，均属体验增强而非功能阻断。严格按「阶段一冻结确认 → 阶段二缺口补齐与数据验证 → 阶段三并行验证 → 阶段四删除」执行，并同步处理 sw.js / manifest.json / serve.cjs 三处耦合，即可安全退役。建议退役前对关联文件做版本备份以支持回滚。
