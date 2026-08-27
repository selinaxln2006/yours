# PAA Console server 启动脚本 — 幂等：端口已监听则直接退出
# 用途：开机自启（计划任务 ONLOGON）+ 崩溃看门狗（计划任务每 5 分钟）
$ErrorActionPreference = 'Stop'

$root = 'C:\Users\selin\WorkBuddy\20260812100418'
$port = 8765

# 已在跑 → 无事发生
$listening = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($listening) { exit 0 }

$node = 'C:\Program Files\nodejs\node.exe'
if (-not (Test-Path $node)) { $node = 'node' }

$stdout = Join-Path $root 'paa\server.log'
$stderr = Join-Path $root 'paa\server.err.log'

Start-Process -FilePath $node -ArgumentList "$root\paa\server\main.ts" `
  -WorkingDirectory $root -WindowStyle Hidden `
  -RedirectStandardOutput $stdout -RedirectStandardError $stderr

# 等待端口起来（最多 10s）
for ($i = 0; $i -lt 10; $i++) {
  Start-Sleep -Milliseconds 1000
  if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
    Add-Content -Path $stdout -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] server up (watchdog boot)"
    exit 0
  }
}
Add-Content -Path $stdout -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] WARNING: server failed to start"
exit 1
