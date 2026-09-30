# PAA Console server 启动脚本 — 幂等：端口已监听则直接退出
# 用途：开机自启（计划任务 ONLOGON）+ 崩溃看门狗（计划任务每 5 分钟）
$ErrorActionPreference = 'Stop'

$root = 'C:\Users\selin\WorkBuddy\20260812100418'
# 默认 18765 — 避开 8765 端口冲突（127.0.0.1:8765 已被另一项目占用）。
# 想换端口：设环境变量 PAA_PORT=N（如 $env:PAA_PORT='8766'），然后跑本脚本。
if ($env:PAA_PORT -and $env:PAA_PORT -match '^\d+$' -and ([int]$env:PAA_PORT -gt 0) -and ([int]$env:PAA_PORT -lt 65536)) { $port = [int]$env:PAA_PORT } else { $port = 18765 }

# 已在跑 → 无事发生。但杀进程后 socket 可能短暂残留（僵尸 Listen），
# owner 进程已死则不算"在跑"，继续走启动分支（先等 2s 让 socket 清理）
$listening = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($listening) {
  $aliveOwners = $listening | Where-Object { Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue }
  if ($aliveOwners) { exit 0 }
  Add-Content -Path $bootlog -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] 检测到僵尸 socket（owner 已死），等 2s 清理后启动"
  Start-Sleep -Seconds 2
}

$node = 'C:\Program Files\nodejs\node.exe'
if (-not (Test-Path $node)) { $node = 'node' }

$stdout = Join-Path $root 'paa\server.log'
$stderr = Join-Path $root 'paa\server.err.log'
# 启动器自己的日志：不能写 server.log（被 server 进程 stdout 独占，Add-Content 必崩）
$bootlog = Join-Path $root 'paa\server-boot.log'

# 注意：不用 Start-Process -Environment（PowerShell 7+ only，5.1 会崩）
# 设父进程 env → Start-Process 默认继承给子进程
# Redirect 目标 server.log 可能被刚被杀进程残留句柄占用 → 重试最多 5 次×2s
$procStarted = $false
for ($attempt = 0; $attempt -lt 5 -and -not $procStarted; $attempt++) {
  try {
    $env:PAA_PORT = "$port"
    Start-Process -FilePath $node -ArgumentList "$root\paa\server\main.ts" `
      -WorkingDirectory $root -WindowStyle Hidden `
      -RedirectStandardOutput $stdout -RedirectStandardError $stderr `
      -ErrorAction Stop
    $procStarted = $true
  } catch {
    if ($attempt -lt 4) {
      Add-Content -Path $bootlog -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Start-Process 撞锁($attempt)，2s 后重试"
      Start-Sleep -Seconds 2
    } else {
      Add-Content -Path $bootlog -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] FATAL: Start-Process 5 次仍失败: $($_.Exception.Message)"
    }
  }
}
if (-not $procStarted) { exit 1 }

# 等待端口起来（最多 60s——Node 冷启动实测 ~30s，10s 等不及会误报失败）
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Milliseconds 1000
  if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
    Add-Content -Path $bootlog -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] server up (boot, ${i}s)"
    exit 0
  }
}
Add-Content -Path $bootlog -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] WARNING: server failed to start"
exit 1
