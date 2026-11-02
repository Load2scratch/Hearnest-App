# Start the local HEARNEST backend and serve the app from one origin.
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$runtimePath = if ($nodeCommand) { $nodeCommand.Source } else { 'C:\Program Files\Adobe\Adobe Creative Cloud Experience\libs\node.exe' }
if (-not (Test-Path -LiteralPath $runtimePath)) { throw 'Install Node.js 24 or newer, then run this script again.' }
& $runtimePath backend/server.cjs