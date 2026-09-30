# 一次性：在用户启动文件夹创建 PAA Console 开机自启快捷方式（免管理员）
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$startup = [Environment]::GetFolderPath('Startup')
$lnk = Join-Path $startup 'PAA-Console.lnk'

$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($lnk)
$sc.TargetPath = 'powershell.exe'
$sc.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$root\tools\start-server.ps1`""
$sc.WorkingDirectory = $root
$sc.Description = 'PAA Console server auto-start (idempotent)'
$sc.Save()

Write-Host "shortcut created: $lnk"
Write-Host '=== scheduled tasks ==='
schtasks /Query /TN 'PAA-Console-Watchdog' /FO LIST | Select-String 'TaskName|Status|Next Run Time|Schedule Type'
