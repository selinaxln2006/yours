# Yours · PAA（Personal AI Agent）

> a personal ai agent on your desktop —— 跑在你自己电脑上的个人 AI agent。数据在你手里。

Yours 是一个本地运行的 AI agent：它能读写你的文件、执行命令、记住关于你的事、管理你的生活数据（记账 / 体重饮食 / 养生打卡 / 日程 / 待办 / 目标），并能把一个模糊的大目标拆成任务树自主执行。你可以在终端里用它，也可以在任意浏览器（包括局域网里的手机）打开控制台用它。

## 组成

```
paa/core/      大脑层（宿主无关）：AgentLoop 循环、Planner 任务树、工具管道 + 权限、
               记忆（L0–L3 分层）、产物、会话事件溯源、生活数据 LifeStore、云同步
paa/tools/     内置工具：fs_* / shell_run / memory_* / artifact_* / pkg_* / web_*
paa/pkgs/      技能包（ToolPkg：manifest.json + impl.mjs），如 life 生活数据包
paa/cli/       宿主 1：终端（交互 / --once / --goal 长任务 / --resume 续跑）
paa/server/    宿主 2：控制台服务（HTTP + REST + WebSocket），默认 127.0.0.1:8765
console.html   控制台前端（chat 主区 + 生活面板，唯一前端）
fonts/         控制台字体（本地打包，离线可用）
```

- **零运行时依赖**：Node 直接运行 `.ts`（类型剥离），不需要构建；只有 `typescript` / `@types/node` 两个开发依赖。
- **文件即数据**：记忆、产物、会话、生活数据都是 `paa/` 下的 JSON / JSONL 文件，全部在 `.gitignore` 里，不会进仓库。
- **可选云同步**：登录 GitHub（Supabase 托管）后多设备同步生活数据，见 [docs/SUPABASE-SETUP.md](docs/SUPABASE-SETUP.md)。

## 快速开始

需要 Node 24（22.18+ 也可以）。

**先试试（不需要 API key）：**

```bash
cd paa
npm run demo          # 然后打开 http://127.0.0.1:8765
```

演示模式用脚本化的回复代替模型，能听懂「午饭吃了饭团和拿铁」「喝了 500ml 水」「明天下午 3 点开组会」这类话，并走真实的确认流程和数据写回。数据放在临时目录并预置了示例，不会碰你的 `paa/data`。

**正式使用：**

```bash
cd paa
npm install                     # 只装类型检查用的开发依赖
cp config.example.json config.json
# 编辑 config.json：apiUrl / apiKey / model（任意 OpenAI 兼容接口）
```

终端：

```bash
node cli/main.ts                                  # 交互
node cli/main.ts --once "今天的待办有哪些？"         # 问一次就退出
node cli/main.ts --goal "整理 docs 目录并写一份索引"  # 长任务：拆任务树后自主执行
node cli/main.ts --resume <sessionId>             # 从断点续跑长任务
node cli/main.ts --agent reviewer --once "审查 core/planner.ts"   # 只读评审角色
```

控制台：

```bash
node server/main.ts             # 然后浏览器打开 http://127.0.0.1:8765
```

Windows 开机自启与崩溃看门狗脚本在 `tools/`（`register-startup.ps1` / `register-tasks.ps1`）。

## 安全模型

| 机制 | 说明 |
| --- | --- |
| 权限分级 | 工具按风险 1–4 分级；Autonomy L0–L4 决定哪些自动放行。写操作默认要你确认，`shell_run` 与 `memory_forget` **永远**要确认 |
| 沙箱 | 文件工具只能访问沙箱根目录（CLI 用 `--root` 指定）；越界路径和指向外部的符号链接都会被拒 |
| 命令黑名单 | `rm -rf`、`format`、`shutdown` 等直接拒绝（只是减速带，真正的防线是确认） |
| 本机 server | 只接受同源请求：其他网站不能调用 API，也不能连 WebSocket 替你点"允许" |
| 静态文件 | server 只提供前端文件；`config.json`、生活数据、登录会话不会通过 HTTP 暴露 |
| 手机访问 | `paa/data/lan.json` 设 `{"lan": true}` 后绑定局域网；必须有访问令牌，未配置时启动会自动生成并打印 |
| 密钥 | `paa/config.json`、`paa/data/` 都不入库 |

## 开发

```bash
cd paa
npm run check    # 类型检查（改完必跑）
npm test         # 单元测试
```

协作约定见 [AGENTS.md](AGENTS.md)，全量规划与进度见 [docs/ROADMAP.md](docs/ROADMAP.md)，架构文档在 [docs/architecture/](docs/architecture/)。

## 许可

MIT © 2026 Lining Xu
