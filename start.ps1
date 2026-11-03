$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "Node.js is required. Install it, then run this script again."
}
Write-Host "Checking local model and runtime files..."
node (Join-Path $PSScriptRoot "setup.mjs")
if ($LASTEXITCODE -ne 0) {
  Write-Error "Setup failed. Check your connection and run again."
}
Write-Host "Starting Cutout at http://127.0.0.1:8765"
Start-Process "http://127.0.0.1:8765/"
node (Join-Path $PSScriptRoot "serve.mjs")
