# Start the opencode-deveco proxy as a hidden background process on Windows.
#
# By default the proxy runs under its supervisor (dist/daemon.js), so a crash
# is restarted automatically; -NoWatchdog runs dist/proxy.js directly (the same
# as `npm run start:proxy`).
#
# Usage (from the project root, or pass the entry path):
#   powershell -ExecutionPolicy Bypass -File scripts\start-windows.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\start-windows.ps1 -NoWatchdog
#   powershell -ExecutionPolicy Bypass -File scripts\start-windows.ps1 -EntryJs dist\proxy.js
#
# The process runs with no visible window (WindowStyle Hidden). Logs go to
# proxy.log in the project root (or -LogFile). Stop it with stop-windows.ps1,
# which kills the supervisor first — killing only the proxy would have the
# supervisor restart it.

param(
  [string]$EntryJs = "",
  [string]$LogFile = "proxy.log",
  [int]$Port = 17128,
  [switch]$NoWatchdog
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir

if (-not $EntryJs) {
  $EntryJs = if ($NoWatchdog) { "dist\proxy.js" } else { "dist\daemon.js" }
}
$EntryPath = Join-Path $ProjectRoot $EntryJs
$LogPath = Join-Path $ProjectRoot $LogFile

if (-not (Test-Path $EntryPath)) {
  Write-Error "Entry point not found at $EntryPath. Run 'npm run build' first."
  exit 1
}

# Already running? Check the port.
$existing = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($existing) {
  $procId = $existing.OwningProcess | Select-Object -First 1
  Write-Host "Proxy already running on port $Port (PID $procId). Nothing to do."
  Write-Host "Status: $(Invoke-RestMethod "http://127.0.0.1:$Port/v2/status" -ErrorAction SilentlyContinue)"
  exit 0
}

# Start hidden. -WindowStyle Hidden = no window at all.
$env:DEVECO_PROXY_PORT = "$Port"
# The argument is quoted by hand: Start-Process does not quote a single
# -ArgumentList value, so a project path containing a space would be split and
# node would be handed a truncated module path.
$proc = Start-Process -FilePath "node" `
  -ArgumentList "`"$EntryPath`"" `
  -WorkingDirectory $ProjectRoot `
  -WindowStyle Hidden `
  -RedirectStandardOutput $LogPath `
  -RedirectStandardError "$LogPath.err" `
  -PassThru

Start-Sleep -Seconds 2

# Verify it came up.
$check = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($check) {
  $mode = if ($NoWatchdog) { "no watchdog" } else { "supervised" }
  Write-Host "Proxy started (PID $($proc.Id), $mode, no window)."
  Write-Host "  Port: $Port"
  Write-Host "  Logs: $LogPath  (and $LogPath.err)"
  $status = Invoke-RestMethod "http://127.0.0.1:$Port/v2/status" -ErrorAction SilentlyContinue
  Write-Host "  Status: $($status | ConvertTo-Json -Compress)"
} else {
  Write-Error "Proxy failed to start. Check $LogPath.err"
  exit 1
}