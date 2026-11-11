# install-autostart.ps1 - register a per-user Scheduled Task that runs autostart.ps1
# at logon (no admin needed). Re-run this if you MOVE the project folder.
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$script = Join-Path $here "autostart.ps1"
$taskName = "ZaloRecallCapture"

$action = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
try { $trigger.Delay = "PT20S" } catch {}
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
  -Principal $principal -Description "Zalo recall capture: relaunch Zalo with CDP + run capture agent at logon." -Force | Out-Null

Write-Host "[+] Da dang ky task '$taskName' (chay luc dang nhap)." -ForegroundColor Green
Write-Host "    Script: $script"
Write-Host "    Go bo: .\uninstall-autostart.ps1   |   Chay thu ngay: Start-ScheduledTask -TaskName $taskName"
