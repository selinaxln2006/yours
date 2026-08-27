# S1 OAuth 配置指南（俪宁操作，约 5 分钟）

> 目标：让 console 支持 **GitHub 登录**（Supabase Auth 托管 OAuth）。
> 你只需要做下面两步 dashboard/GitHub 操作，server 代码由枢写。
> 做完后告诉枢"配置好了"，枢联调验证。

---

## ① 创建 GitHub OAuth App（github.com，2 分钟）

1. 打开 https://github.com/settings/developers → **OAuth Apps** → **New OAuth App**
2. 填写：
   | 字段 | 填什么 |
   |------|--------|
   | Application name | `PAA Console`（随意） |
   | Homepage URL | `http://127.0.0.1:8765` |
   | Authorization callback URL | **`https://rgrgnhkiodnsthtbdxch.supabase.co/auth/v1/callback`** |
3. 创建后拿到 **Client ID** + 点 **Generate a new client secret** 拿 **Client Secret**（只显示一次，先复制好）

> ⚠️ 回调地址必须指向 Supabase 的 `/auth/v1/callback`（不是本地地址）——GitHub 只认这个，Supabase 拿到后再转给本地。

---

## ② 填进 Supabase（supabase.com，3 分钟）

1. 打开项目 `rgrgnhkiodnsthtbdxch` → **Authentication** → **Providers** → **GitHub**
2. 打开 **Enable Sign in with GitHub**，填入：
   - **Client ID** ← 上一步的 Client ID
   - **Client Secret** ← 上一步的 Client Secret
   - Save
3. **Authentication → URL Configuration**：
   - **Site URL**: `http://127.0.0.1:8765`
   - **Redirect URLs** 添加：`http://127.0.0.1:8765/api/auth/callback`
   - Save

---

## 完成标准（全绿）

- [ ] GitHub OAuth App 已创建，Client ID/Secret 已填进 Supabase Provider
- [ ] Site URL + Redirect URLs 已配
- [ ] 告诉枢"配置好了"

之后枢会：实现 server `/api/auth/login|callback|me` + 前端登录按钮 + user_id 落盘，然后联调验证。

---

## 排错速查

| 现象 | 原因 |
|------|------|
| 登录后跳回 Supabase 报 `redirect_to` 不允许 | Redirect URLs 没加 `http://127.0.0.1:8765/api/auth/callback` |
| GitHub 报 redirect_uri mismatch | ① 步的 callback URL 抄错了（必须是 supabase.co/auth/v1/callback） |
| 登录按钮点了没反应 | server 还没起 / 端口不是 8765 |
