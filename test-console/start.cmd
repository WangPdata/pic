@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 需要先安装 Node.js 20+: https://nodejs.org/
  exit /b 1
)
echo 启动淘宝图搜测试台…
echo 浏览器打开: http://localhost:8787
node server.mjs
