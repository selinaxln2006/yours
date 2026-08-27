# Supabase 注册教程（PAA 云同步 S 线）

> 目标：注册一个 Supabase 项目，把 **Project URL + anon key** 给枢，PAA 的云同步（S 线）就能开工。
> 全程约 10 分钟，免费档（Free tier）完全够用。**不需要信用卡。**

---

## 你要准备的东西

| 项 | 说明 |
|----|------|
| 一个 GitHub 或 Google 账号 | 登录用，GitHub 最快（一个按钮） |
| 2 分钟耐心 | 项目创建要等 1-2 分钟 |

---

## Step 1 — 注册 / 登录

1. 浏览器打开 **https://supabase.com**
2. 右上角点 **Start your project**（或 **Sign in**）
3. 选 **Continue with GitHub**（推荐，最省事；没有 GitHub 就选 Google 或邮箱注册）
4. 授权后进入 Dashboard（管理台）

---

## Step 2 — 创建项目

1. 如果提示创建 Organization：起个名（如 `lining`）或直接用默认的，继续
2. 点 **New project**（或左侧项目列表的 **+**）
3. 填三样：

| 字段 | 填什么 |
|------|--------|
| **Name** | `paa-sync`（随便起，标识用） |
| **Database Password** | 点 **Generate a password** 自动生成并**复制保存好**（后面恢复用，忘了要重置） |
| **Region** | **Southeast Asia (Singapore)** —— 离你最近，延迟最低 |

4. 确认 **Free plan**（免费档）已选中
5. 点 **Create new project** → 等 **1-2 分钟**，状态变 **Project is ready**

---

## Step 3 — 拿两个 key（给我）

项目建好后：

1. 左侧边栏点 **⚙️ Project Settings**（最底下齿轮）→ **API**（或直接看 **Settings → API**）
2. 找到这三样，**复制**：

| 名称 | 示例 | 用途 |
|------|------|------|
| **Project URL** | `https://abcdefgh.supabase.co` | 云端地址 |
| **anon public key**（`anon` / `public` 那个） | `eyJhbGciOi...` 或新格式 `sb_publishable_...` | **给我，S1 用** |
| **service_role key** | `eyJhbGciOi...` 或新格式 `sb_secret_...` | **自己留好，放本地，别外传** |

> ⚠️ **新旧格式说明**：2025 年后新项目改用新前缀——**publishable key（`sb_publishable_` 开头）= 旧 anon key**，公开安全；**secret key（`sb_secret_` 开头）= 旧 service_role key**，超级权限绝密。看到 `sb_publishable_` 别慌，就是给枢的那个。

3. 把 **Project URL + anon key** 直接发到对话里给枢 → 枢写进 `paa/config.json`，S1（OAuth 登录 + 数据同步）立即启动

> 找不到 API 页？新版本 Dashboard 可能在 **Project Settings → API Keys**（标签页形式），内容一样。

---

## Step 4 — 验证（可选，30 秒）

1. 左侧 **SQL Editor**
2. 跑一行：`select now();`
3. 看到返回时间戳 = 数据库活着，一切就绪 ✅

---

## 安全提醒（重要）

| ⚠️ | 说明 |
|----|------|
| **anon key 不是秘密** | 它就是给前端/公开场景用的，可以发给我 |
| **service_role key 是超级权限** | 能读写你数据库里所有数据。只放本地 `paa/config.json`（已 .gitignore 不会进 GitHub），**别贴到任何公开渠道/仓库** |
| 免费档额度 | 500MB 数据库 + 50MB 存储 + 2 并发连接 —— 个人生活数据同步绰绰有余 |

---

## 之后的事（枢来做，你不用管）

1. **S1**：建表（`life/` + `sessions/`）+ Auth 登录端点 + console 前端登录按钮
2. **S2**：18 键增量同步 + 会话事件游标同步
3. **S3**：Realtime 跨端实时推送 + 多浏览器实测

> Google OAuth 登录按钮（用 Google 账号登录 PAA）到 S1 时会再给你一份 **Google Cloud Console 配置教程**——那一步稍繁琐（要建 OAuth Client），但也是免费、一次性的。当前这步只需要注册 Supabase。

---

## 常见问题

| 问题 | 解答 |
|------|------|
| 免费档会过期吗？ | 不会，无限期免费（用量超限会暂停，个人同步不会触发） |
| 可以多设备用一个账号吗？ | 可以，S 线设计就是同账号多端同步 |
| 我忘了数据库密码 | 项目设置里可以重置（Reset database password），不影响已有数据 |
