# Start the opencode-deveco proxy as a hidden background process on Windows.
#
# Usage (from the project root, or pass the dist path):
#   powershell -ExecutionPolicy Bypass -File scripts\start-windows.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\start-windows.ps1 -ProxyJs dist\proxy.js
#
# The process runs with no visible window (WindowStyle Hidden). Logs go to
# proxy.log in the project root (or -LogFile). To stop it, kill the node
# process listening on the proxy port (see stop-windows.ps1).

param(
  [string]$ProxyJs = "dist\proxy.js",
  [string]$LogFile = "proxy.log",
  [int]$Port = 17128
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
$ProxyPath = Join-Path $ProjectRoot $ProxyJs
$LogPath = Join-Path $ProjectRoot $LogFile

if (-not (Test-Path $ProxyPath)) {
  Write-Error "Proxy not found at $ProxyPath. Run 'npm run build' first."
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
$proc = Start-Process -FilePath "node" `
  -ArgumentList $ProxyPath `
  -WorkingDirectory $ProjectRoot `
  -WindowStyle Hidden `
  -RedirectStandardOutput $LogPath `
  -RedirectStandardError "$LogPath.err" `
  -PassThru

Start-Sleep -Seconds 2

# Verify it came up.
$check = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($check) {
  Write-Host "Proxy started (PID $($proc.Id), no window)."
  Write-Host "  Port: $Port"
  Write-Host "  Logs: $LogPath  (and $LogPath.err)"
  $status = Invoke-RestMethod "http://127.0.0.1:$Port/v2/status" -ErrorAction SilentlyContinue
  Write-Host "  Status: $($status | ConvertTo-Json -Compress)"
} else {
  Write-Error "Proxy failed to start. Check $LogPath.err"
  exit 1
}
