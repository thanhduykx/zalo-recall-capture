# start.ps1 - relaunch YOUR Zalo with CDP enabled, then run the capture agent.
# Scope: your own signed-in account on this machine. Violates Zalo ToS (account risk).
#
# 9222 is Chromium's default remote-debugging port and every other Chrome/Edge/Electron app
# may squat it. A status-200 probe alone is not proof: if a foreign app owns the port the
# probe still succeeds and the hook lands in the wrong app. So probes also check the
# User-Agent for "Zalo/", and a busy-but-foreign port falls through to the next free port.
param(
  [int]$CdpPort = 9222,
  [int]$ViewerPort = 9333
)
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$portFile = Join-Path $here "data\cdp-port.txt"
$PortRange = @(9222..9250)

function Test-PortBusy([int]$p) {
  $c = New-Object System.Net.Sockets.TcpClient
  try { $c.Connect("127.0.0.1", $p); $c.Close(); return $true } catch { return $false }
}
# 'zalo' | 'other' | 'closed'
function Test-Cdp([int]$p) {
  if (-not (Test-PortBusy $p)) { return "closed" }
  try {
    $r = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$p/json/version" -TimeoutSec 2
    if ($r.StatusCode -eq 200) { if ($r.Content -match 'Zalo/') { return "zalo" }; return "other" }
  } catch {}
  return "other"
}

# 1. Resolve the latest installed Zalo Electron executable (proper version sort)
$base = Join-Path $env:LOCALAPPDATA "Programs\Zalo"
$verDir = Get-ChildItem $base -Directory |
  Where-Object { $_.Name -match '^Zalo-(\d+)\.(\d+)\.(\d+)$' } |
  Sort-Object { [version]($_.Name -replace '^Zalo-','') } -Descending |
  Select-Object -First 1
if (-not $verDir) { throw "Khong tim thay thu muc Zalo-x.y.z trong $base" }
$exe = Join-Path $verDir.FullName "Zalo.exe"
if (-not (Test-Path $exe)) { throw "Khong tim thay $exe" }
Write-Host "[*] Zalo: $exe" -ForegroundColor Cyan

# 2. Reuse an already-exposed Zalo CDP port, else choose a free one.
$port = 0
foreach ($p in (@($CdpPort) + $PortRange | Select-Object -Unique)) {
  if ((Test-Cdp $p) -eq "zalo") { $port = $p; break }
}
$cdpUp = [bool]$port
if (-not $cdpUp) {
  foreach ($p in (@($CdpPort) + $PortRange | Select-Object -Unique)) {
    if (-not (Test-PortBusy $p)) { $port = $p; break }
  }
  if (-not $port) { throw "Khong con port CDP trong $($PortRange[0])..$($PortRange[-1])" }
  if ($port -ne $CdpPort) {
    $squatter = ""
    if (Test-PortBusy $CdpPort) { try { $squatter = (Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$CdpPort/json/version" -TimeoutSec 2).Content; $squatter = $squatter.Substring(0, [Math]::Min(80, $squatter.Length)) } catch {} }
    Write-Host "[!] Port $CdpPort dang bi app khac chiem ($squatter) -> dung port $port" -ForegroundColor Yellow
  }

  # 3. Close any running Zalo (so the CDP flag takes effect; single-instance lock otherwise)
  $running = Get-Process -Name Zalo -ErrorAction SilentlyContinue
  if ($running) {
    Write-Host "[*] Dong Zalo dang chay ($($running.Count) tien trinh)..." -ForegroundColor Yellow
    $running | Stop-Process -Force
    Start-Sleep -Seconds 2
  }

  # 4. Relaunch with remote debugging. --remote-allow-origins=* is REQUIRED for a
  #    non-browser WebSocket client (Node) to attach on modern Chromium/Electron.
  Write-Host "[*] Mo lai Zalo voi CDP port $port ..." -ForegroundColor Cyan
  Start-Process -FilePath $exe -ArgumentList @("--remote-debugging-port=$port", "--remote-allow-origins=*")

  # 5. Wait for the CDP endpoint to come up as Zalo
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 800
    if ((Test-Cdp $port) -eq "zalo") { $cdpUp = $true; break }
  }
  if (-not $cdpUp) { Write-Host "[!] CDP chua phan hoi tren $port. Dang nhap Zalo xong roi thu lai, hoac kiem tra firewall." -ForegroundColor Red }
  else { Write-Host "[+] CDP san sang." -ForegroundColor Green }
} else {
  Write-Host "[*] Dung lai CDP dang co tren port $port." -ForegroundColor Cyan
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $portFile) | Out-Null
"$port" | Out-File -FilePath $portFile -Encoding ascii

# 6. Start the capture agent (foreground). Ctrl+C to stop.
$env:ZCAP_CDP_PORT = $port
$env:ZCAP_VIEWER_PORT = $ViewerPort
Write-Host "[*] Chay agent... Trang xem: http://localhost:$ViewerPort" -ForegroundColor Cyan
Start-Process "http://localhost:$ViewerPort"
node (Join-Path $here "capture-agent.mjs")
