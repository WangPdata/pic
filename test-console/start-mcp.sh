#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
# MCP 验证码自动解决（需先在 trajectories 项目启动 captcha_mcp_server_async.py）
export MCP_SERVER_URL="${MCP_SERVER_URL:-http://127.0.0.1:9000/mcp}"
# 共享浏览器 CDP 端点（与 MCP server 的 config.cdp_endpoint 一致，默认 ai-browser 19222）
export CDP_ENDPOINT="${CDP_ENDPOINT:-http://127.0.0.1:19222}"
# 调用 mcp_client.py 的 Python（conda yolo 环境，已安装 mcp）
export MCP_PYTHON="${MCP_PYTHON:-/opt/anaconda3/envs/yolo/bin/python}"
echo "启动网站巡检台（含 MCP 验证码自动解决）…"
echo "  MCP_SERVER_URL=$MCP_SERVER_URL"
echo "  CDP_ENDPOINT=$CDP_ENDPOINT"
echo "  浏览器打开: http://localhost:8787  （切到「网站巡检台」Tab）"
echo "按 Ctrl+C 停止"
exec node server.mjs
