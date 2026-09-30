# 接入 Google 日历

Yours 通过 MCP 接 Google 日历：用的是开源的 [`@cocal/google-calendar-mcp`](https://github.com/nspady/google-calendar-mcp)（MIT）。接好以后：

- 「今天」和日程面板会显示日历里的事件（标 `◦ cal`，只读；点一下在 Google 日历里打开）
- 可以对 Yours 说「明天下午有空吗」「把周五的会挪到 4 点」，它会调用日历工具

先想试一下效果：`npm run demo` 自带一个假的演示日历，不需要 Google 账号。

## 权限

每个日历工具的风险等级按它自己声明的 MCP annotations 定，不看工具名：

| 工具 | 等级 | 行为（默认 L2） |
| --- | --- | --- |
| list-events / search-events / get-event / get-freebusy 等只读 | 1 | 自动执行 |
| create-event / create-events / respond-to-event | 3 | 推确认卡，可"总是允许" |
| update-event / delete-event / manage-accounts | 4 | 每次都确认，不能"总是允许" |

## 步骤（约 15 分钟，只做一次）

### 1. 在 Google Cloud 建一个 OAuth 客户端

1. 打开 <https://console.cloud.google.com/>，新建一个项目（名字随意，比如 `yours-calendar`）
2. 「API 和服务 → 库」，搜索 **Google Calendar API**，启用
3. 「API 和服务 → OAuth 权限请求页面」：用户类型选 **外部**，填应用名和你的邮箱；在「测试用户」里 **把你自己的 Gmail 加进去**
4. 「API 和服务 → 凭据 → 创建凭据 → OAuth 客户端 ID」，应用类型选 **桌面应用**
5. 下载 JSON，保存为 `paa/data/gcp-oauth.keys.json`

`paa/data/` 在 `.gitignore` 里，这个文件不会进仓库。**不要把它发给任何人，也不要贴进对话。**

### 2. 登录一次

PowerShell（在仓库根目录）：

```powershell
$env:GOOGLE_OAUTH_CREDENTIALS = "$PWD\paa\data\gcp-oauth.keys.json"
npx -y @cocal/google-calendar-mcp auth
```

macOS / Linux：

```bash
GOOGLE_OAUTH_CREDENTIALS="$PWD/paa/data/gcp-oauth.keys.json" npx -y @cocal/google-calendar-mcp auth
```

浏览器会弹出 Google 登录，允许访问日历即可。令牌存在你本机用户目录（`~/.config/google-calendar-mcp/`），不在仓库里。

> 应用处于「测试」状态时，Google 的刷新令牌 **7 天过期**。过期后重跑上面的 auth 命令；或者在 OAuth 权限请求页面把应用「发布」为正式版（个人自用不需要 Google 审核也能用，只是登录时会提示"未经验证"）。

### 3. 写进 config.json

在 `paa/config.json` 里加 `mcpServers`（路径换成你自己的绝对路径）：

```json
{
  "apiUrl": "...",
  "apiKey": "...",
  "model": "...",
  "mcpServers": [
    {
      "name": "gcal",
      "command": "npx",
      "args": ["-y", "@cocal/google-calendar-mcp"],
      "env": { "GOOGLE_OAUTH_CREDENTIALS": "C:\\Users\\<你>\\...\\yours\\paa\\data\\gcp-oauth.keys.json" }
    }
  ]
}
```

- 想临时关掉：这一项加 `"enabled": false`
- `risk`（1–3）只能把整个 server 的等级**调高**，不能调低

### 4. 重启 server

```bash
cd paa
node server/main.ts
```

启动信息里出现 `MCP gcal(13) · 日历：gcal` 就接好了。第一次用 `npx` 会下载包，可能要几十秒；连不上不会挡住 server 启动，只会在终端打印原因。

## 常见问题

- **「今天」没有日历事件**：看 server 终端有没有 `MCP server gcal 连接失败`；多半是 JSON 路径不对或令牌过期（重跑第 2 步）
- **时区不对**：前端会把浏览器时区传给日历，确认电脑时区是 Asia/Singapore
- **想接别的 MCP**：同样写进 `mcpServers`，工具会以 `mcp_<name>_<tool>` 出现在对话里，并显示在「今天 → Capabilities」
