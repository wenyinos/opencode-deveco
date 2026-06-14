# Stop the opencode-deveco proxy on Windows (kills the node process on the port).

param(
  [int]$Port = 17128
)

$conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if (-not $conn) {
  Write-Host "No proxy listening on port $Port."
  exit 0
}
$procId = $conn.OwningProcess | Select-Object -First 1
Stop-Process -Id $procId -Force
Write-Host "Stopped proxy (PID $procId) on port $Port."
