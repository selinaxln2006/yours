# PAA Core — 宿主无关大脑层（TS v2 + CLI 宿主）

Personal AI Agent Framework 的宿主无关大脑层 + 本地文件系统宿主。
自研核心四件套（AgentLoop / ToolPipeline / LLMAdapter / SessionMgr）+ C4 记忆系统。
同一个大脑，换宿主（CLI / 未来 Tauri / 未来云端）不用改循环本体。

## 目录结构

```
paa/
  package.json          # ESM；npm run check (tsc) / test (node --test) / cli
  config.json           # LLM 配置（apiUrl + apiKey + model；勿提交真实 key）
  core/
    types.ts            # 核心类型（ChatMessage/ToolCall/MemoryRecord/MemoryProvider）
    agent-loop.ts       # 循环引擎（maxRounds/abort/inject/P1 记忆注入钩子）
    tool-pipeline.ts    # 工具管道（权限门 → 执行 → 审计）
    llm-adapter.ts      # OpenAI 兼容协议封装
    session-mgr.ts      # 会话事件溯源（JSONL）
    permission.ts       # Autonomy L0-L4 + risk 分级（risk4 永远确认）
    memory-provider.ts  # C4 记忆系统：JsonMemoryProvider（分层 L0-L3 + 自动失效 + consolidate）
  tools/
    core-tools.ts       # fs_read/fs_write/fs_append/fs_patch/fs_list/fs_grep/shell_run
    memory-tools.ts     # memory_search/list/save/consolidate/forget
  cli/
    main.ts             # CLI 宿主（交互 + --once + --export/--import-memory）
    render.ts           # 终端渲染
  test/
    smoke.ts            # P0 冒烟 8/8
    agent-loop.ts       # 循环收敛
    memory.ts           # P1 记忆系统 10/10
  memory/
    store.json          # 记忆存储（自动生成，L3 画像种子初始化）
```

## 用法

```bash
# 检查 / 测试
npm run check          # tsc --noEmit
npm run test           # node --test test/

# 运行（交互）
node cli/main.ts                          # 默认 L2，沙箱根=工作区
node cli/main.ts --root <dir> --level 3   # 指定沙箱根与 Autonomy

# 单次执行
node cli/main.ts --once "用 fs_grep 搜索 docs/DEVLOG.md 里的 P1 v1.1"

# 记忆主权：导出 / 导入
node cli/main.ts --export-memory backup.json
node cli/main.ts --import-memory backup.json
```

## 记忆系统（C4，P1 v1.1）

| 项 | 设计 |
|---|---|
| 分层 | L0 原文（永不注入，只溯源）/ L1 事实（save 默认）/ L2 场景块（consolidate）/ L3 画像（常驻） |
| 注入预算 | 每轮 ≤ ~510 tokens：L3 常驻 2 条 → L2 命中 top2 → L1 补足；L0 永不进上下文 |
| 自动失效 | save 同 tag+type 内容不同的旧记录 → invalidAt（Graphiti 边失效轻量版） |
| 遗忘 | memory_forget 软删（invalidAt），risk 4 永远确认 |
| 精炼 | memory_consolidate：agent 生成摘要，provider 记账，源记忆失效 |
| 持久化 | JSON 原子写（tmp+rename）+ 损坏自愈（备份重建）+ 导入导出 |
| 种子 | 首次启动注入 6 条 L3 画像（createDefaultPersonaSeed） |

设计参考：Graphiti/Zep 三层架构（Episodic/Semantic/Community）+ 人脑分层-巩固-稀疏激活类比。完整设计见 `docs/architecture/paa-design-v2.md` C4 章节。

## 安全模型

| 机制 | 说明 |
|------|------|
| root 沙箱 | 所有 fs 路径限制在 root 内，越界拒绝 |
| 工具名硬约束 | `[a-zA-Z0-9_-]`（LLM function calling 要求；点号会 400） |
| 命令黑名单 | rm -rf / del /s / format / shutdown / diskpart 等拒绝 |
| 权限分级 | risk1 读自动 / risk2 普通 L2+ 自动 / risk3 写确认 / risk4 永远确认（memory_forget、shell_run） |
| Autonomy | L0 全问 → L4 全放行（除 risk4）；`/level N` 切换；`/trust` 会话级放行 |

## 与前端的关系

- 前端 `index.html` 冻结基线 v18 是**临时宿主/产品验证载体**，不是 agent 运行载体（浏览器沙箱够不到 FS/shell）
- 本包（`paa/`）是宿主无关大脑层：CLI 宿主已跑通 G3 自诊断 / G4 自修改闭环 / P1 记忆
- 未来 Tauri 宿主可复用 `core/` 全部代码，只替换宿主入口与工具集
