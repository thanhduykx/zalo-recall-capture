# stop.ps1 - close the CDP-enabled Zalo and relaunch it normally (no debug port).
$ErrorActionPreference = "SilentlyContinue"
Get-Process -Name Zalo | Stop-Process -Force
Start-Sleep -Seconds 2
$stub = Join-Path $env:LOCALAPPDATA "Programs\Zalo\Zalo.exe"
if (Test-Path $stub) { Start-Process $stub; Write-Host "[+] Da mo lai Zalo binh thuong (khong co debug port)." -ForegroundColor Green }
else { Write-Host "[!] Khong thay $stub - mo Zalo thu cong." -ForegroundColor Yellow }
