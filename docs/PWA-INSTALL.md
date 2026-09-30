# PAA 手机端 — 加主屏 / PWA 指南

> 把 `http://<设备名>.<tailnet>.ts.net:18765/mobile.html` 加到手机主屏幕，
> 看起来像 App，全屏打开，**和电脑 console.html 共用同一台 server**。

---

## 前置条件

- Tailscale 已登录手机（同账号 `selinaxln2006@github`）
- 电脑已开机、PAA server 在 18765 跑着
- 首次访问输令牌 `24126fd7adc8feaa`（写 cookie 后 7 天免输）

---

## iOS（iPhone）— 30 秒

1. Safari 打开 **`http://<设备名>.<tailnet>.ts.net:18765/mobile.html`**（首次会要令牌）
2. 进 <设备名>.<tailnet>.ts.net 后**等 5 秒**确认页面加载完
3. 点底部 **分享按钮**（方框+向上箭头）
4. 滚到「**添加到主屏幕**」
5. 名字默认 `PAA`，点「添加」
6. 主屏出现 **PAA 图标**（黄铜色罗盘）
7. 点图标打开 → **全屏、无 Safari 地址栏** → 像 App 一样用

> 注意：必须用 **Safari**，Chrome/Edge 加主屏 iOS 不认 manifest。

## Android — 30 秒

1. Chrome / Edge 打开 **`http://<设备名>.<tailnet>.ts.net:18765/mobile.html`**
2. 等加载完
3. Chrome 通常会自动弹「添加到主屏幕」提示 → 点「安装」
4. 没有自动弹：右上角 ⋮ → 「添加到主屏幕」/「安装应用」
5. 主屏出现 PAA 图标

---

## 加完之后

| 在主屏点 PAA | 效果 |
|---|---|
| 直接进 mobile.html | 全屏、不显示 Safari 工具栏 |
| 后台 30 秒 | 状态自动刷新（可见性事件） |
| 完全关闭再开 | 重新连 WS、重新拉数据 |
| 电脑关机 | 打开是空白（依赖电脑在线，详见 ROADMAP §九） |

---

## 两个版本，选哪个

| | console.html | mobile.html |
|---|---|---|
| 何时用 | 电脑端 | 手机端 |
| 布局 | 桌面双栏（聊天 + 数据） | 移动三 Tab（对话/任务/日程） |
| Token | 输一次写 cookie | 输一次写 cookie |
| 数据 | 同 18 键 life store | 同 18 键 life store |

**手机端强制用 mobile.html**——console.html 在手机屏幕上布局崩，体验差。

---

## 常见问题

**Q：加完图标但打开是空白？**
A：电脑关了/不在 Tailscale 隧道里。手机 Tailscale App 看 `agent` 是不是 Connected。

**Q：图标显示名字是「PAA」还是「枢 · PAA Console」？**
A：iOS 用 `apple-mobile-web-app-title`（短名 `PAA`）；Android 用 manifest.short_name。

**Q：能离线用吗？**
A：不能。PAA 是云端 / 电脑端架构，不引入 Service Worker（防 401 缓存泥潭）。
真正的"出门也能用"需要云大脑（迷你主机 / VPS），那是 ROADMAP D 线的事。

---

## 想做"真正 App"

| 阶段 | 怎么做 | 体验 |
|---|---|---|
| 现在（已完成） | mobile.html + PWA 加主屏 | 像 App，但本质是网页 |
| 中期（1-2 周） | Capacitor 把 mobile.html 包成 iOS/Android 安装包 | 真 App，能上架 |
| 长期（待规划） | 加壳 App + 云大脑（VPS/迷你主机） | 真 App + 出门在外也能用 |

---

_文档生成于 2026-09-04（mobile.html v0.1）_
