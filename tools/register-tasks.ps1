# 一次性：注册 PAA Console 的开机自启 + 看门狗计划任务（幂等，重复执行安全）
$ErrorActionPreference = 'Stop'
$script = 'C:\Users\selin\WorkBuddy\20260812100418\tools\start-server.ps1'
$tr = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$script`""

schtasks /Create /TN 'PAA-Console-Boot' /TR $tr /SC ONLOGON /RL LIMITED /F
schtasks /Create /TN 'PAA-Console-Watchdog' /TR $tr /SC MINUTE /MO 5 /RL LIMITED /F

Write-Host '=== registered tasks ==='
schtasks /Query /TN 'PAA-Console-Boot','PAA-Console-Watchdog' /FO LIST | Select-String 'TaskName|Status|Next Run Time|Schedule Type'
