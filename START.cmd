@echo off
setlocal
set "BRIDGE_ROOT=%~dp0"
set "BRIDGE_NODE=%~dp0runtime\node\node.exe"
if exist "%BRIDGE_NODE%" goto node_found
set "BRIDGE_NODE="
for /f "delims=" %%N in ('where node.exe 2^>nul') do if not defined BRIDGE_NODE set "BRIDGE_NODE=%%N"
if not defined BRIDGE_NODE (
  echo Node.js 22.13+ was not found. Use the complete Windows release package.
  if /i not "%~1"=="--hidden" pause
  exit /b 1
)
:node_found
"%BRIDGE_NODE%" -e "const fs=require('fs'),path=require('path');const p=fs.realpathSync(process.argv[1]);const [a,b]=process.versions.node.split('.').map(Number);for(let q of [p,path.join(p,'runtime','temp'),path.join(p,'logs')]){while(!fs.existsSync(q)){const next=path.dirname(q);if(next===q)break;q=next}if(!/^[A-BD-Z]:[\\/]/i.test(fs.realpathSync(q))){console.error('The project and runtime folders must be on a non-C local drive.');process.exit(1)}}if(a<22||(a===22&&b<13)){console.error('Node.js 22.13+ is required.');process.exit(1)}" "%BRIDGE_ROOT%."
if errorlevel 1 (
  if /i not "%~1"=="--hidden" pause
  exit /b 1
)
set "TEMP=%BRIDGE_ROOT%runtime\temp"
set "TMP=%BRIDGE_ROOT%runtime\temp"
if not exist "%TEMP%" mkdir "%TEMP%"
if not exist "%BRIDGE_ROOT%logs" mkdir "%BRIDGE_ROOT%logs"
cd /d "%BRIDGE_ROOT%"
echo Starting ChatWorkBridge. Log: %BRIDGE_ROOT%logs\start.log
"%BRIDGE_NODE%" "%BRIDGE_ROOT%scripts\start.mjs" >> "%BRIDGE_ROOT%logs\start.log" 2>&1
set "BRIDGE_EXIT=%ERRORLEVEL%"
if not "%BRIDGE_EXIT%"=="0" (
  echo Startup failed. Please read logs\start.log in this folder.
  if /i not "%~1"=="--hidden" pause
)
exit /b %BRIDGE_EXIT%
