#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "需要先安装 Node.js 20+: https://nodejs.org/"
  exit 1
fi
echo "启动淘宝图搜测试台…"
echo "浏览器打开: http://localhost:8787"
echo "按 Ctrl+C 停止"
exec node server.mjs
