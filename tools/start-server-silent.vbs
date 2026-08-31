' start-server-silent.vbs - launch start-server.ps1 with NO console window
' Why: powershell.exe always flashes a console; wscript.exe is a GUI host and shows nothing.
' Used by: Startup shortcut + PAA-Console-Boot + PAA-Console-Watchdog scheduled tasks
CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""C:\Users\selin\WorkBuddy\20260812100418\tools\start-server.ps1""", 0, False
