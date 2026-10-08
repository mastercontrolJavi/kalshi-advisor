# One-click launcher (used by the desktop shortcut).
# If the dashboard is already up, just opens it. Otherwise starts `npm run trade` in its own minimized
# window (close that window to stop the app), waits until the dashboard answers, then opens Chrome.
param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$url = 'http://localhost:3000'
$Host.UI.RawUI.WindowTitle = 'Kalshi Advisor launcher'

function Test-Dashboard {
  # Probe 127.0.0.1, not localhost: the app binds IPv4 loopback and Windows tries ::1 first.
  # Any HTTP answer counts as up; the dashboard replies 401 until you log in.
  try { Invoke-WebRequest -Uri 'http://127.0.0.1:3000' -UseBasicParsing -TimeoutSec 2 | Out-Null; return $true }
  catch { return $null -ne $_.Exception.Response }
}
function Test-Starting {
  # A launch already in progress (tests/build running, port not open yet).
  $null -ne (Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'scripts[\\/]trade\.mjs' } | Select-Object -First 1)
}

function Open-Dashboard {
  if ($NoBrowser) { return }
  $chrome = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  ) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
  # The dashboard opens in its own Chrome profile started with autoplay allowed, so sound alerts play without a
  # click first. Chrome only applies that flag to an instance it starts, hence the separate profile; your normal
  # Chrome profile is untouched. Log in once there (Chrome can remember it).
  $chromeProfile = Join-Path $env:LOCALAPPDATA 'KalshiAdvisor\Chrome'
  if ($chrome) { Start-Process -FilePath $chrome -ArgumentList "--user-data-dir=`"$chromeProfile`"", '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--no-default-browser-check', '--new-window', $url }
  else { Write-Host 'Chrome not found; opening your default browser.'; Start-Process $url }
}

if (Test-Dashboard) {
  Write-Host 'Kalshi Advisor is already running.'
  Open-Dashboard
  exit 0
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Write-Host 'npm was not found. Install Node.js 22+ from nodejs.org, then try again.' -ForegroundColor Red
  Read-Host 'Press Enter to close'
  exit 1
}

if (Test-Starting) {
  Write-Host 'Kalshi Advisor is already starting; waiting for it...'
} else {
  Write-Host 'Starting Kalshi Advisor (tests + production build first, usually 1-2 minutes)...'
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/k', 'title Kalshi Advisor (close this window to stop) && npm run trade' `
    -WorkingDirectory $root -WindowStyle Minimized
}

$deadline = (Get-Date).AddMinutes(6)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 2
  if (Test-Dashboard) {
    Write-Host 'Ready.' -ForegroundColor Green
    Open-Dashboard
    exit 0
  }
  Write-Host -NoNewline '.'
}
Write-Host ''
Write-Host 'The dashboard did not come up within 6 minutes. Open the minimized "Kalshi Advisor" window to see why.' -ForegroundColor Yellow
Read-Host 'Press Enter to close'
exit 1
