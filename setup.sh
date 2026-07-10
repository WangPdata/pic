#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Cannot find Node.js. Please install Node.js 20+ first: https://nodejs.org/"
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "Cannot find npm. Please install Node.js 20+ with npm first: https://nodejs.org/"
  exit 1
fi

echo "Installing npm dependencies..."
npm install --ignore-scripts

if [ -d "/Applications/Google Chrome.app" ] || command -v google-chrome >/dev/null 2>&1 || command -v google-chrome-stable >/dev/null 2>&1; then
  echo "Detected Google Chrome. Skipping Playwright Chromium download."
else
  echo "Google Chrome was not detected. Trying to download Playwright Chromium..."
  PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT="${PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT:-120000}" npx playwright install chromium || {
    echo ""
    echo "Could not download Playwright Chromium."
    echo "You can still run this tool after installing Google Chrome, or retry:"
    echo "  PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT=120000 npm run install-browser"
    exit 1
  }
fi

echo ""
echo "Setup complete."
echo "Try: ./taobao-image-search --image /path/to/image.png"
