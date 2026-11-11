# autostart.ps1 - non-interactive launcher used by the Scheduled Task at logon.
# Relaunches Zalo with CDP and starts the capture agent hidden (no browser, no console).
#
# Port 9222 is Chromium's default remote-debugging port, so another Chrome/Edge/Electron
# app can already hold it. A plain "status 200" probe is not enough: if a foreign app owns
# the port the probe still succeeds and the agent would hook the WRONG app. So every probe
# also checks the User-Agent for "Zalo/", and a busy-but-foreign port makes us fall through
# to the next free port instead of silently mis-attaching.
$ErrorActionPreference = "SilentlyContinue"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = Join-Path $here "data\autostart.log"
$portFile = Join-Path $here "data\cdp-port.txt"
function L($m){ "{0}  {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $m | Out-File -FilePath $log -Append -Encoding utf8 }

New-Item -ItemType Directory -Force -Path (Join-Path $here "data") | Out-Null
L "autostart triggered"
try { & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $here "lock-data.ps1") | Out-Null; L "data folder ACL locked" } catch { L ("lock-data failed: " + $_.Exception.Message) }

# --- CDP port helpers -------------------------------------------------------
$PortRange = @(9222..9250)

# Is a listener bound on this loopback port at all?
function Test-PortBusy([int]$p) {
  $c = New-Object System.Net.Sockets.TcpClient
  try { $c.Connect("127.0.0.1", $p); $c.Close(); return $true } catch { return $false }
}

# 'zalo'   -> CDP answers AND belongs to Zalo (safe to attach)
# 'other'  -> something answers but it is not Zalo (wrong app, do not attach)
# 'closed' -> nothing answers
function Test-Cdp([int]$p) {
  if (-not (Test-PortBusy $p)) { return "closed" }
  try {
    $r = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$p/json/version" -TimeoutSec 2
    if ($r.StatusCode -eq 200) {
      if ($r.Content -match 'Zalo/') { return "zalo" }
      return "other"
    }
  } catch {}
  return "other"
}

# Resolve latest Zalo exe
$base = Join-Path $env:LOCALAPPDATA "Programs\Zalo"
$verDir = Get-ChildItem $base -Directory | Where-Object { $_.Name -match '^Zalo-(\d+)\.(\d+)\.(\d+)$' } |
  Sort-Object { [version]($_.Name -replace '^Zalo-','') } -Descending | Select-Object -First 1
if (-not $verDir) { L "no Zalo version dir; abort"; exit 0 }
$exe = Join-Path $verDir.FullName "Zalo.exe"

# 1. Reuse a running Zalo that already exposes CDP (on any port we know about).
$cdpUp = $false
$port = 0
$preferred = @()
if ($env:ZCAP_CDP_PORT) { $preferred += [int]$env:ZCAP_CDP_PORT }
$preferred += $PortRange
$preferred = $preferred | Select-Object -Unique

foreach ($p in $preferred) {
  if ((Test-Cdp $p) -eq "zalo") { $port = $p; $cdpUp = $true; break }
}

# 2. Otherwise pick a port that is genuinely free (skips foreign apps squatting 9222).
if (-not $cdpUp) {
  foreach ($p in $PortRange) {
    if (-not (Test-PortBusy $p)) { $port = $p; break }
  }
  if (-not $port) { L "no free CDP port in $($PortRange[0])..$($PortRange[-1]); abort"; exit 0 }
  if ($port -ne 9222) {
    $squatter = ''
    if (Test-PortBusy 9222) { try { $squatter = (Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:9222/json/version" -TimeoutSec 2).Content; $squatter = $squatter.Substring(0, [Math]::Min(80, $squatter.Length)) } catch {} }
    L "port 9222 busy by another app ($squatter) -> using $port"
  }

  # Relaunch with the flag. Backoff: if the first attempt does not come up as Zalo,
  # try once more before giving up (slow start / single-instance lock race).
  for ($attempt = 1; $attempt -le 2; $attempt++) {
    Get-Process -Name Zalo -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds $(2 * $attempt)
    Start-Process -FilePath $exe -ArgumentList @("--remote-debugging-port=$port","--remote-allow-origins=*")
    L "relaunched Zalo with CDP on $port (attempt $attempt): $exe"
    for ($i = 0; $i -lt 40; $i++) {
      Start-Sleep -Milliseconds 800
      if ((Test-Cdp $port) -eq "zalo") { $cdpUp = $true; break }
    }
    if ($cdpUp) { break }
    $state = Test-Cdp $port
    L "attempt $attempt failed (port $port = $state)"
    if ($state -eq "other") { L "port $port got taken by another app; abort"; exit 0 }
  }
}
L ("CDP up: " + $cdpUp + " on port " + $port)
if (-not $cdpUp) { L "Zalo never exposed CDP; agent will keep polling" }

# Publish the port so start.ps1 / manual tools reuse the same one.
"$port" | Out-File -FilePath $portFile -Encoding ascii

# 3. Ensure a single agent instance
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*capture-agent*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { L "node not found on PATH; abort"; exit 0 }
$env:ZCAP_CDP_PORT = $port
if ($env:ZCAP_VIEWER_PORT) { $env:ZCAP_VIEWER_PORT = $env:ZCAP_VIEWER_PORT }
Start-Process -FilePath $node -ArgumentList "capture-agent.mjs" -WorkingDirectory $here -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $here "data\agent.log") -RedirectStandardError (Join-Path $here "data\agent.err.log")
L "agent started (hidden) on port $port"
