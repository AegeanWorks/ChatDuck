@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo ChatDuck needs Node.js 20 or newer. Install it from https://nodejs.org/
  pause
  exit /b 1
)
echo Starting ChatDuck...
node scripts\serve.mjs --open
if errorlevel 1 pause