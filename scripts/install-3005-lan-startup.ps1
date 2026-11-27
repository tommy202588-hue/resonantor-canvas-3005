$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$startup = [Environment]::GetFolderPath('Startup')
$startupFile = Join-Path $startup 'ResonanceCanvas-3005-LAN.vbs'
$launcher = Join-Path $PSScriptRoot 'start-3005-lan.vbs'

if (-not (Test-Path $launcher -PathType Leaf)) {
  throw "Launcher not found: $launcher"
}

Copy-Item -LiteralPath $launcher -Destination $startupFile -Force
Write-Output "Installed per-user startup launcher: $startupFile"
Write-Output "Project: $projectRoot"
