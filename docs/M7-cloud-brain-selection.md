# M7 云大脑（Azure VM 路径）

**核心需求**：电脑关机/离线时，手机 PAA 仍能跑 → 必须有一个**常开**的 agent host。

## 决策（2026-09-04 重写）

**Path A：Codex 配的 Azure VM**（推荐）✅
- 俪宁和 Codex 共用一个 VM（多租户？or 分开？待定）
- 月费：Azure B1s $7-10/月
- 俪宁出 SSH 凭证，WorkBuddy 接管部署
- 路径：复用 Code 的 VM 部署清单（系统、用户、端口、Tailscale）

**Path B：自建 N100 迷你主机**
- ¥500-800 一次性，断电 = 死
- 等"自部署"需求明确再买

**已淘汰**：萤光云/LightNode/Vultr/DO（不需重复花钱，Codex 已有 VM）

## Azure VM 上要装

| 组件 | 用途 |
|------|------|
| Node 24 LTS | 跑 PAA agent |
| systemd 服务 | 开机自启 + 进程守护 |
| Tailscale | 加入俪宁的 tailnet，避免暴露公网 |
| Caddy | HTTPS 终结（手机 PWA） |
| 防火墙 | 只开 443 + Tailscale UDP |
| 备份 | 每天 rsync 到 Backblaze B2 / 本地电脑 |

## PAA 部署到 VM 后的形态

```
手机 PWA  ── HTTPS ──▶  Azure VM (Caddy :443)  ──▶  PAA server (Node :18765)
                                              │
                                              ├── Tailscale  ◀── 家里电脑（拉取任务 / 同步数据）
                                              ├── S2/S3 双向同步（Supabase 兜底）
                                              └── DeepSeek API（VM 持 key）
```

## 部署脚本清单（待开发）

| # | 脚本 | 作用 |
|---|------|------|
| 1 | `tools/deploy-azure-vm.sh` | VM 初始化（Node + systemd + Tailscale + Caddy） |
| 2 | `tools/sync-to-vm.sh` | 本地 → VM 增量同步（rsync over Tailscale） |
| 3 | `paa/server/main.ts` | 加 `PAA_MODE=cloud` 常驻适配 |
| 4 | `tools/backup-vm.sh` | 每天打包 `data/memory/runs` 到 B2 |
| 5 | `tools/mobile-tailscale-setup.md` | 手机 Tailscale 接入指南 |

## 数据流

- **写**：手机 → VM → 落盘 `data/`
- **读**：VM → S2/S3 增量 → 家里电脑（反之亦然）
- **LWW**：两边都能改，S2 18 键增量同步已实现

## 安全

- VM 443 只对 Tailscale 节点开放（或公网 Caddy + Cloudflare）
- DeepSeek API key 留 VM（不复用本地）
- 家里电脑通过 Tailscale → VM 拉取任务结果

## 时间线

| # | 动作 | 时长 |
|---|------|------|
| 1 | Codex 配好 Azure VM + 给俪宁 SSH | 由 Codex |
| 2 | 俪宁给 WorkBuddy IP+SSH | 1 分钟 |
| 3 | WorkBuddy 部署脚本初版 | 半天 |
| 4 | 数据双向同步联调 | 1 天 |
| 5 | mobile.html 改连 VM | 半天（依赖 mobile 重做） |
| 6 | 手机断网测试 | 半天 |

## 成本

- Azure B1s：~$10/月（Linux，1 vCPU / 1GB RAM / 30GB SSD）
- 流量：手机走 Tailscale/MagicDNS，几乎 0
- Codex/俪宁分摊：月费减半 = ~$5/月

---

**等俪宁拍**：Codex VM 配好 → 把 IP+SSH 丢过来。我接管部署。
