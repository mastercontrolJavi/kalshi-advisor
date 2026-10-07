# Creates "Kalshi Advisor" on the Windows desktop pointing at scripts/launch.ps1 with the app icon.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$desktop = [Environment]::GetFolderPath('Desktop')   # resolves OneDrive-redirected desktops too
$path = Join-Path $desktop 'Kalshi Advisor.lnk'
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($path)
$link.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$link.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$root\scripts\launch.ps1`""
$link.WorkingDirectory = $root
$link.IconLocation = "$root\assets\kalshi-advisor.ico,0"
$link.Description = 'Start Kalshi Advisor and open it in Chrome'
$link.Save()
Write-Host "Shortcut created: $path"
