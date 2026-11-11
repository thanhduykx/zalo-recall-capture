# uninstall-autostart.ps1 - remove the logon task and stop the running agent.
$ErrorActionPreference = "SilentlyContinue"
Unregister-ScheduledTask -TaskName "ZaloRecallCapture" -Confirm:$false
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*capture-agent*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Write-Host "[+] Da go task 'ZaloRecallCapture' va dung agent. Zalo van chay binh thuong o lan khoi dong sau." -ForegroundColor Green
