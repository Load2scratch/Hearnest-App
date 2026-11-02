@echo off
setlocal
rem Start the app without relying on PowerShell execution policy.
set "runtimePath=node"
where node >nul 2>nul
if errorlevel 1 set "runtimePath=%ProgramFiles%\Adobe\Adobe Creative Cloud Experience\libs\node.exe"
if not "%runtimePath%"=="node" if not exist "%runtimePath%" (
  echo Node.js was not found. Install Node.js 24 or newer, then try again.
  pause
  exit /b 1
)
echo Starting HEARNEST at http://localhost:3000
echo Keep this window open while using the app. Press Ctrl+C to stop.
"%runtimePath%" "%~dp0backend\server.cjs"
if errorlevel 1 pause
