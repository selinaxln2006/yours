# PAA Core — Phase B 本地宿主（CLI）

Personal AI Agent Framework 的宿主无关大脑层 + 本地文件系统宿主。
从生活工作台 PWA（`index.html`）中抽取的 AgentLoop / LLMAdapter / ToolPipeline / Skills 注册表，
改造成依赖注入形态——同一个大脑，换宿主（CLI / 未来 Tauri / 未来云端）不用改循环本体。

## 目录结构

```
paa/
  package.json          # ESM 包，bin: paa
  config.example.json   # LLM 配置模板（复制为 config.json 填真实 key）
  src/
    cli.js              # CLI 宿主入口
    util.js             # today/now/uid 纯函数（Node 版 U）
    core/
      skills.js         # Skill 注册表（注册/查询/派发/tools 协议转换）
      tool-pipeline.js  # 工具执行管道（readOnly 自动 / 写操作 pending）
      llm-adapter.js    # OpenAI + Anthropic 协议封装（config 注入）
      agent-loop.js     # 健壮循环引擎（maxRounds/重复检测/abort/超时）
    tools/
      fs-tools.js       # fs.read(切片) / fs.grep(正则定位) / fs.check(语法验证) / fs.write / shell.run
```

## 用法

```bash
# 配置（三选一，优先级 flags > env > config.json）
copy config.example.json config.json   # 或
set PAA_API_KEY=sk-xxx                 # 或命令行 --api-key

# 运行
node paa/src/cli.js "读取 index.html 并总结 AgentLoop 的实现"
node paa/src/cli.js --yes "修复 paa/src/core/agent-loop.js 语法错误并用 node --check 验证"
node paa/src/cli.js --yes --root c:\Users\selin\WorkBuddy\20260812100418 "检查 git status"
```

写操作（`fs__write` / `fs__shell`）默认逐条 y/n 确认；`--yes` 全自动。

只读工具（`fs__read` / `fs__grep` / `fs__check`）自动执行不确认。推荐工作流：`fs__grep` 定位行号 → `fs__read` offset/limit 切片精读 → 修改 → `fs__check` 验证。

## 安全模型

| 机制 | 说明 |
|------|------|
| root 沙箱 | 所有路径解析到 root 内，越界拒绝（EPERM） |
| 大小上限 | 读 300KB / 写 500KB，防上下文爆炸 |
| 命令黑名单 | rm -rf / Remove-Item -Recurse / format / shutdown / taskkill /f 等拒绝 |
| 写操作确认 | CLI 逐条询问；`--yes` 显式授权 |

## 与前端的关系

- 前端 `index.html` 中的 AgentLoop/LLMAdapter 为**冻结基线**（v18），此包是其宿主无关重构
- 未来 Tauri 宿主可复用 `core/` 全部代码，只替换 `tools/` 与宿主入口
- life skill（工作台 13 工具）属 PWA 工具集，未迁移；Phase C 按需抽离
