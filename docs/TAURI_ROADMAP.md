# Tauri 桌面化路线图（第二阶段）

> 目标：将 PWA 工作台包装为 Windows / macOS 原生桌面应用。前置条件：PWA + 云端同步（v0.3）稳定后再启动本阶段。

## 为什么用 Tauri 而不是 Electron

| 维度 | Tauri | Electron |
|------|-------|----------|
| 安装包体积 | 3–10 MB | 100 MB+ |
| 内存占用 | 低（复用系统 WebView） | 高（捆绑 Chromium） |
| 技术栈 | Rust + 系统 WebView | Node + Chromium |
| 适合场景 | 轻量工具、个人应用 | 重量级桌面应用 |
| 对你 | ✅ 与「克制、高效」的产品观一致 | ❌ 重、慢 |

## 前置条件（在 Rust 侧）

1. 安装 Rust 工具链：`https://rustup.rs`
2. Windows 需 WebView2 Runtime（Win10/11 一般已内置）；macOS 用系统 WKWebView

## 实施步骤

```bash
# 1. 在项目根安装 tauri CLI
npm create tauri-app@latest
# 或：npx @tauri-apps/cli init

# 2. 配置 src-tauri/tauri.conf.json
#    - productName: "Shu Workbench"
#    - frontendDist: 指向构建产物（当前为 index.html 及静态资源）
#    - identifier: com.shu.workbench（可自定义）

# 3. 数据层复用：桌面端仍走 StorageAdapter
#    - 本地后端从 localStorage 切换为 Tauri 的 fs 插件（存到用户数据目录 JSON）
#    - 云端后端不变（Supabase），实现三端（Web/手机/桌面）数据一致

# 4. 打包分发
npm run tauri build
# 产出：Windows .msi/.exe，macOS .dmg/.app
```

## 关键设计决策

- **数据不动**：桌面端不引入新数据库，用 `JSON 文件 + 内存缓存`，保持与 Web 端同一套 StorageAdapter 接口。
- **离线优先**：桌面端天然离线，云端同步改为「手动 / 定时拉取」，不做实时长连接，减少复杂度。
- **自动更新**：后期可接 tauri-updater，走 GitHub Releases 分发。
- **AI 助手**：桌面端可用 Tauri 的 shell 能力（可选），但默认仍走浏览器 fetch 调大模型 API，保持同构。

## 验收标准

- [ ] 三端（Web / 手机 PWA / 桌面）打开同一份数据
- [ ] 桌面端安装包 < 12 MB
- [ ] 桌面端离线启动 < 2s
- [ ] 与 Web 端 UI 完全一致（同一套前端代码）

## 风险与对策

| 风险 | 对策 |
|------|------|
| Rust 工具链安装受网络影响 | 使用镜像源或离线安装包 |
| WebView2 兼容性问题 | 目标平台限定 Win10+ / macOS 11+ |
| 双端维护成本 | 前端代码单源（PWA 即桌面 UI），差异仅在数据层适配器 |
