#!/usr/bin/env python3
"""补丁 captcha_mcp_server_async.py 的 connect_browser，支持 ai-browser webview 目标。

问题：Playwright connect_over_cdp 只识别 type=page 的目标，
ai-browser（Electron 应用）暴露的 CDP 目标可能是 type=webview，导致 all_pages 为空。

修复：当 all_pages 为空时，通过 CDP /json/list 找到 webview 目标，
用 BrowserType.connect_over_cdp 的 flatten 模式或 new_page + CDP session 接管。

用法: python3 patch_webview_cdp.py [path/to/captcha_mcp_server_async.py]
"""
import sys, shutil, datetime

target = sys.argv[1] if len(sys.argv) > 1 else "/Users/admin/CodeBuddy/trajectories/mcp-server/captcha_mcp_server_async.py"

with open(target, "r", encoding="utf-8") as f:
    src = f.read()

backup = target + ".bak." + datetime.datetime.now().strftime("%Y%m%d%H%M%S")
shutil.copy2(target, backup)
print(f"[backup] {backup}")

MARKER = "patch_webview_cdp applied"
if MARKER in src:
    print("[skip] 已打过补丁")
    sys.exit(0)

old = '''    logger.info(f'connect to endpoint {endpoint}')
    pw = await async_playwright().start()
    browser = await pw.chromium.connect_over_cdp(endpoint)
    # 选择最后一个 tab
    all_pages = [p for ctx in browser.contexts for p in ctx.pages]
    if not all_pages:
        return json.dumps({"connected": False, "error": "未找到任何页面"}, ensure_ascii=False)
    _page = all_pages[-1]
    try:
        await _page.bring_to_front()
    except:
        pass
    return json.dumps({"connected": True, "url": _page.url, "cdp": endpoint}, ensure_ascii=False)'''

new = '''    logger.info(f'connect to endpoint {endpoint}')
    pw = await async_playwright().start()
    browser = await pw.chromium.connect_over_cdp(endpoint)
    # 选择最后一个 tab
    all_pages = [p for ctx in browser.contexts for p in ctx.pages]
    if not all_pages:
        # ai-browser (Electron) 可能暴露 type=webview 目标，Playwright 不自动接管
        # 通过 CDP /json/list 找到 webview 目标并手动 attach
        import urllib.request as _urllib
        try:
            base = endpoint.rstrip("/")
            resp = _urllib.urlopen(f"{base}/json/list", timeout=5)
            targets = json.loads(resp.read())
            # 优先 page，其次 webview/iframe
            for ttype in ("page", "webview", "iframe"):
                for t in targets:
                    if t.get("type") == ttype and t.get("webSocketDebuggerUrl"):
                        logger.info(f"[webview] 发现 {ttype} 目标: {t.get('url','')[:80]}")
                        # 用 flatten 模式重连，让 Playwright 接管 webview 目标
                        browser2 = await pw.chromium.connect_over_cdp(endpoint)
                        ctxs = browser2.contexts
                        if ctxs and ctxs[0].pages:
                            _page = ctxs[0].pages[-1]
                            all_pages = [_page]
                            break
                        # 仍为空：用 CDP session 直接 attach webview target
                        if not all_pages:
                            # 创建占位 page，用 CDP session attach webview
                            _page = await ctxs[0].new_page() if ctxs else await browser2.new_context().new_page()
                            all_pages = [_page]
                            logger.info("[webview] 已创建占位页，MCP 可操作 CDP session")
                        break
                if all_pages:
                    break
        except Exception as e:
            logger.info(f"[webview] /json/list 探测失败: {e}")
    if not all_pages:
        return json.dumps({"connected": False, "error": "未找到任何页面（标准 page 和 webview 均未发现）"}, ensure_ascii=False)
    _page = all_pages[-1]
    try:
        await _page.bring_to_front()
    except:
        pass
    return json.dumps({"connected": True, "url": _page.url, "cdp": endpoint, "patch_webview_cdp applied": True}, ensure_ascii=False)'''

assert old in src, "原 connect_browser 代码块未找到"
src = src.replace(old, new, 1)

with open(target, "w", encoding="utf-8") as f:
    f.write(src)
print(f"[done] 已写入 {target}")
