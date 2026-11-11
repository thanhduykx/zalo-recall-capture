# lock-data.ps1 - restrict the data/ folder (plaintext captured messages + media)
# so only the current Windows user (and SYSTEM) can read it. Protects against other
# local accounts. NOTE: this is access control, not at-rest encryption against disk theft
# - for that, store the folder on a BitLocker/encrypted volume.
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$data = Join-Path $here "data"
New-Item -ItemType Directory -Force -Path $data | Out-Null
$me = "$env:USERDOMAIN\$env:USERNAME"
& icacls $data /inheritance:r /grant:r "${me}:(OI)(CI)F" "SYSTEM:(OI)(CI)F" | Out-Null
Write-Host "[+] Da khoa '$data' chi cho: $me + SYSTEM." -ForegroundColor Green
