@echo off
title Safeguard Cleaning - local preview
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js is not installed on this computer.
  echo Opening the download page. Install the "LTS" version, then double-click this file again.
  start https://nodejs.org/
  pause
  exit /b
)
node -e "const [a,b]=process.versions.node.split('.').map(Number); process.exit(a>22||(a===22&&b>=5)?0:1)"
if errorlevel 1 (
  echo.
  echo Your Node.js is too old for the preview. Please install the current "LTS" version from nodejs.org.
  start https://nodejs.org/
  pause
  exit /b
)
start "" http://localhost:8788
node --no-warnings tests\preview-server.js
pause
