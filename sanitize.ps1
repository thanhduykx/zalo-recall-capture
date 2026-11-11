# sanitize.ps1 - Wipe all personal chat logs, media, and cache from data/
# Keeps the folder structure clean and anonymous.
$ErrorActionPreference = "SilentlyContinue"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$dataDir = Join-Path $here "data"

Write-Host "[*] Dang don dep va xoa toan bo du lieu ca nhan trong data/..." -ForegroundColor Yellow

if (Test-Path $dataDir) {
    # Remove logs
    Remove-Item (Join-Path $dataDir "*.log") -Force -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $dataDir "cdp-port.txt") -Force -ErrorAction SilentlyContinue

    # Remove personal chat databases
    Remove-Item (Join-Path $dataDir "messages.jsonl") -Force -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $dataDir "recalls.jsonl") -Force -ErrorAction SilentlyContinue

    # Clean media cache
    $mediaDir = Join-Path $dataDir "media"
    if (Test-Path $mediaDir) {
        Get-ChildItem -Path $mediaDir -File | Where-Object { $_.Name -ne ".gitkeep" } | Remove-Item -Force -ErrorAction SilentlyContinue
    }

    # Clean png cache
    $pngCache = Join-Path $dataDir "_pngcache"
    if (Test-Path $pngCache) {
        Get-ChildItem -Path $pngCache -File | Where-Object { $_.Name -ne ".gitkeep" } | Remove-Item -Force -ErrorAction SilentlyContinue
    }
}

# Ensure folders and .gitkeep exist
$dirs = @($dataDir, (Join-Path $dataDir "media"), (Join-Path $dataDir "_pngcache"))
foreach ($d in $dirs) {
    New-Item -ItemType Directory -Force -Path $d | Out-Null
    $keep = Join-Path $d ".gitkeep"
    if (-not (Test-Path $keep)) {
        New-Item -ItemType File -Force -Path $keep | Out-Null
    }
}

Write-Host "[+] Don dep thanh cong! Thu muc data/ da sach se, khong con du lieu ca nhan." -ForegroundColor Green
