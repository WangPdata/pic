@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Cannot find Node.js. Please install Node.js 20+ first: https://nodejs.org/
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo Cannot find npm. Please install Node.js 20+ with npm first: https://nodejs.org/
  exit /b 1
)

echo Installing npm dependencies...
call npm install --ignore-scripts
if errorlevel 1 exit /b 1

if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" goto chrome_found
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" goto chrome_found
echo Google Chrome was not detected. Trying to download Playwright Chromium...
set PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT=120000
call npx playwright install chromium
if errorlevel 1 (
  echo.
  echo Could not download Playwright Chromium.
  echo You can still run this tool after installing Google Chrome, or retry:
  echo   set PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT=120000
  echo   npm run install-browser
  exit /b 1
)
goto setup_done

:chrome_found
echo Detected Google Chrome. Skipping Playwright Chromium download.

:setup_done
echo.
echo Setup complete.
echo Try: taobao-image-search.cmd --image C:\path\to\image.png
