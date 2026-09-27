# Stop the opencode-deveco proxy on Windows.
#
# The supervisor goes first: it restarts its child on exit, so killing only the
# proxy on the port would see it come back a second later.

param(
  [int]$Port = 17128
)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
$PidFile = Join-Path $ProjectRoot "proxy-daemon.pid"

$stopped = $false

if (Test-Path $PidFile) {
  $daemonPid = (Get-Content $PidFile -Raw -ErrorAction SilentlyContinue).Trim()
  if ($daemonPid -match '^\d+$') {
    $proc = Get-Process -Id ([int]$daemonPid) -ErrorAction SilentlyContinue
    # Windows recycles pids quickly and an unclean shutdown leaves the file
    # behind, so only a node process is treated as ours.
    if ($proc -and $proc.ProcessName -eq "node") {
      # /T takes the proxy child down too: Stop-Process -Force is a bare
      # TerminateProcess, which neither forwards a signal nor walks the tree, so
      # with a non-default -Port the proxy would outlive its supervisor.
      taskkill /PID $proc.Id /T /F 2>&1 | Out-Null
      Write-Host "Stopped supervisor (PID $($proc.Id)) and its proxy child."
      $stopped = $true
    }
  }
  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}

$conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($conn) {
  $procId = $conn.OwningProcess | Select-Object -First 1
  Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
  Write-Host "Stopped proxy (PID $procId) on port $Port."
  $stopped = $true
}

if (-not $stopped) {
  Write-Host "Nothing to stop (no supervisor pid file, nothing listening on port $Port)."
}