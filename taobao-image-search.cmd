@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Cannot find Node.js. Please install Node.js 20+ first: https://nodejs.org/
  exit /b 1
)

if "%~1"=="--help" goto run_tool
if "%~1"=="-h" goto run_tool

if not exist node_modules\playwright (
  echo Dependencies are not installed yet.
  echo Run setup.cmd once, then run this command again.
  exit /b 1
)

:run_tool
node run.mjs %*
