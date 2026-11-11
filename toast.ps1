# toast.ps1 - show a tray balloon notification. Args: -Title "..." -Message "..."
param([string]$Title = "Zalo", [string]$Message = "")
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$ni = New-Object System.Windows.Forms.NotifyIcon
$ni.Icon = [System.Drawing.SystemIcons]::Information
$ni.Visible = $true
$ni.BalloonTipTitle = $Title
$ni.BalloonTipText = $Message
$ni.ShowBalloonTip(6000)
Start-Sleep -Seconds 6
$ni.Dispose()
