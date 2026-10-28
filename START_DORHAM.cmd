@echo off
setlocal
cd /d "%~dp0"
if exist ".tools\node\node-v24.22.1-win-x64\node.exe" set "PATH=%CD%\.tools\node\node-v24.22.1-win-x64;%PATH%"
node -e "const v=process.versions.node.split('.').map(Number);process.exit(v[0]===24&&(v[1]>22||(v[1]===22&&v[2]>=1))?0:1)"
if errorlevel 1 (
  echo Install a patched Node.js 24 LTS release, version 24.22.1 or newer.
  pause
  exit /b 1
)
if not exist node_modules (
  call npm ci
  if errorlevel 1 exit /b 1
)
if not exist .env copy .env.example .env >nul
if not exist apps\api\dist\index.js (
  call npm run build
  if errorlevel 1 exit /b 1
)
set "PUBLIC_URL=http://localhost:3001"
echo Open http://localhost:3001 in your browser. Press Ctrl+C here to stop.
call npm start
pause
