# Start feishu-bridge from the user Startup folder and restart it if it exits.
# No administrator rights: a logon shortcut plus a restart loop.
# A Task Scheduler task with "run at startup before login" needs an elevated account.
$ErrorActionPreference = "Stop"
$Bridge = Split-Path -Parent $PSScriptRoot
$Node = (Get-Command node -ErrorAction Stop).Source

Write-Host "Building $Bridge"
Push-Location $Bridge
npm run build
if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }
Pop-Location

Get-CimInstance Win32_Process | Where-Object {
  $_.CommandLine -and $_.CommandLine -match 'feishu_bridge' -and ($_.CommandLine -match 'tsx' -or $_.CommandLine -match 'dist\\index.js' -or $_.CommandLine -match 'dist/index.js')
} | ForEach-Object {
  Write-Host "Stopping previous bridge pid $($_.ProcessId)"
  Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}

$startup = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup"
$cmd = Join-Path $startup "FeishuBridge.cmd"
@(
  "@echo off",
  "cd /d `"$Bridge`"",
  ":loop",
  "`"$Node`" dist\index.js",
  "timeout /t 5 /nobreak >nul",
  "goto loop"
) | Set-Content -Path $cmd -Encoding ASCII

Start-Process -FilePath $cmd -WindowStyle Hidden
Write-Host "Supervisor started: $cmd"
Write-Host "It runs at each logon and restarts the bridge 5 seconds after an exit."
