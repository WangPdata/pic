#!/usr/bin/env python3
"""Captcha MCP client (streamable-http transport).

连接运行中的 captcha_mcp_server (默认 http://127.0.0.1:9000/mcp)，
通过 MCP streamable-http 协议调用工具，供自动化脚本 / Node 侧 crawl.mjs spawn 调用。

依赖：conda yolo 环境（已安装 mcp）。

用法:
  python mcp_client.py solve   [--mcp-url URL] [--cdp CDP_ENDPOINT]
  python mcp_client.py tools   [--mcp-url URL]
  python mcp_client.py call <tool> [key=val ...] [--mcp-url URL]
  python mcp_client.py status  [--mcp-url URL]

solve 子命令输出单行 JSON：
  {"ok": true,  "connected": true, "solved": true,  "type":"A","attempts":2,"method":"mcp:auto_solve"}
  {"ok": true,  "connected": true, "solved": false, "type":"A","message":"..."}
  {"ok": false, "error": "..."}
退出码：0=已解决，1=未解决，2=调用异常。
"""
import argparse
import asyncio
import json
import sys

from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

DEFAULT_MCP_URL = "http://127.0.0.1:9000/mcp"
DEFAULT_CDP = "http://127.0.0.1:19222"
# auto_solve_captcha 内部含 AI 分类 + 多次拖拽重试，给足超时
CALL_TIMEOUT = 300


def _emit(obj):
    """输出单行 JSON 到 stdout（crawl.mjs 解析最后一行 JSON）。"""
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _leaf_msg(e):
    """展开异常组（TaskGroup/BaseExceptionGroup），提取最内层真实错误信息。"""
    if isinstance(e, BaseExceptionGroup):
        for sub in getattr(e, "exceptions", []):
            m = _leaf_msg(sub)
            if m and "sub-exception" not in m and m != "unhandled errors in a TaskGroup":
                return m
    return str(e) or type(e).__name__


def _parse_kv(items):
    out = {}
    for it in items:
        if "=" not in it:
            continue
        k, v = it.split("=", 1)
        for caster in (int, float):
            try:
                v = caster(v)
                break
            except ValueError:
                continue
        out[k] = v
    return out


def _extract(result):
    """从 CallToolResult 提取文本内容，尝试 JSON 解析。"""
    if result is None:
        return None
    text = ""
    for c in getattr(result, "content", []) or []:
        t = getattr(c, "text", None)
        if isinstance(t, str):
            text += t
    parsed = getattr(result, "structuredContent", None)
    if not isinstance(parsed, dict) and text:
        try:
            parsed = json.loads(text)
        except Exception:
            parsed = text
    return {"isError": bool(getattr(result, "isError", False)), "text": text, "parsed": parsed}


async def _run(mcp_url, fn, timeout=CALL_TIMEOUT):
    """建立 MCP 会话并执行 fn(session)，返回 fn 的结果。"""
    async with streamablehttp_client(mcp_url, timeout=timeout, sse_read_timeout=timeout) as (read, write, _get_sid):
        async with ClientSession(read, write) as session:
            await session.initialize()
            return await fn(session)


async def cmd_solve(args):
    async def work(session):
        # 1) 连接浏览器（让 MCP server 通过 CDP 接管本浏览器）
        cb = _extract(await session.call_tool("connect_browser", {"cdp_endpoint": args.cdp} if args.cdp else {}))
        conn = (cb or {}).get("parsed")
        if isinstance(conn, dict) and conn.get("connected") is False:
            _emit({"ok": False, "stage": "connect_browser", "error": conn.get("error", "连接失败")})
            return 1
        # 2) 自动解决（auto_solve_captcha 内部会自行截图做 AI 分类）
        r = _extract(await session.call_tool("auto_solve_captcha", {}))
        sol = (r or {}).get("parsed")
        if isinstance(sol, dict):
            solved = bool(sol.get("success"))
            _emit({"ok": True, "connected": True, "solved": solved, "type": sol.get("type"),
                   "attempts": sol.get("attempts"), "message": sol.get("message"),
                   "method": "mcp:auto_solve"})
            return 0 if solved else 1
        _emit({"ok": bool(r and not r.get("isError")), "solved": False, "raw": (r or {}).get("text", "")})
        return 1
    try:
        return await _run(args.mcp_url, work)
    except Exception as e:
        _emit({"ok": False, "error": "solve 异常: " + _leaf_msg(e)})
        return 2


async def cmd_tools(args):
    async def work(session):
        r = await session.list_tools()
        tools = [{"name": t.name, "description": (t.description or "")[:90]} for t in (r.tools or [])]
        _emit({"tools": tools})
        return 0
    try:
        return await _run(args.mcp_url, work)
    except Exception as e:
        _emit({"ok": False, "error": "list_tools 异常: " + _leaf_msg(e)})
        return 2


async def cmd_call(args):
    async def work(session):
        r = _extract(await session.call_tool(args.tool_name, _parse_kv(args.kv)))
        _emit(r or {"ok": False, "error": "无结果"})
        return 0 if (r and not r.get("isError")) else 1
    try:
        return await _run(args.mcp_url, work)
    except Exception as e:
        _emit({"ok": False, "error": "call 异常: " + _leaf_msg(e)})
        return 2


async def cmd_status(args):
    async def work(session):
        r = await session.list_tools()
        _emit({"ok": True, "server": args.mcp_url, "tools": len(r.tools or [])})
        return 0
    try:
        return await _run(args.mcp_url, work, timeout=15)
    except Exception as e:
        _emit({"ok": False, "server": args.mcp_url, "error": _leaf_msg(e)})
        return 2


def main():
    # 共享参数 parser：--mcp-url 同时挂到主 parser 和各子命令，支持任意顺序
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--mcp-url", default=DEFAULT_MCP_URL, help=f"MCP server 地址，默认 {DEFAULT_MCP_URL}")
    p = argparse.ArgumentParser(description="Captcha MCP client (streamable-http)", parents=[common])
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("solve", help="connect_browser + auto_solve_captcha 一键解决", parents=[common])
    s.add_argument("--cdp", default=DEFAULT_CDP, help=f"浏览器 CDP 端点，默认 {DEFAULT_CDP}")
    s.set_defaults(func=cmd_solve)
    sub.add_parser("tools", help="列出 MCP 工具", parents=[common]).set_defaults(func=cmd_tools)
    c = sub.add_parser("call", help="调用任意工具", parents=[common])
    c.add_argument("tool_name")
    c.add_argument("kv", nargs="*")
    c.set_defaults(func=cmd_call)
    sub.add_parser("status", help="探测 MCP server 是否在线", parents=[common]).set_defaults(func=cmd_status)
    a = p.parse_args()
    try:
        sys.exit(asyncio.run(a.func(a)))
    except KeyboardInterrupt:
        sys.exit(130)


if __name__ == "__main__":
    main()
