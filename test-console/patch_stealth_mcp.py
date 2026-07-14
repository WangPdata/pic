#!/usr/bin/env python3
"""补丁 captcha_mcp_server_async.py：在 connect_browser 后注入浏览器指纹伪装 init script。

MCP server 通过 CDP 连接浏览器后，其操作的是自己的 Page 对象，
crawl.mjs 注入的 stealth init script 不会传递过来。需要在 Python 侧也注入。

用法: python3 patch_stealth_mcp.py [path/to/captcha_mcp_server_async.py]
"""
import sys, shutil, datetime

target = sys.argv[1] if len(sys.argv) > 1 else "/Users/admin/CodeBuddy/trajectories/mcp-server/captcha_mcp_server_async.py"

with open(target, "r", encoding="utf-8") as f:
    src = f.read()

backup = target + ".bak." + datetime.datetime.now().strftime("%Y%m%d%H%M%S")
shutil.copy2(target, backup)
print(f"[backup] {backup}")

MARKER = "patch_stealth_mcp applied"
if MARKER in src:
    print("[skip] 已打过 stealth 补丁")
    sys.exit(0)

# 1) 在 _page 定义后插入 STEALTH_INIT_SCRIPT 常量
anchor = "_last_slider_pos: Dict[str, Any] = {}"
stealth_const = anchor + '''

# 浏览器指纹伪装脚本（针对淘宝 NC/Baxia 风控）
STEALTH_INIT_SCRIPT = """
try { Object.defineProperty(navigator, 'deviceMemory', { get: () => 8, configurable: true }); } catch(e) {}
try { if (!navigator.hardwareConcurrency || navigator.hardwareConcurrency < 4) { Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8, configurable: true }); } } catch(e) {}
try { Object.defineProperty(navigator, 'pdfViewerEnabled', { get: () => true, configurable: true }); } catch(e) {}
try { Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true }); } catch(e) {}
try {
  if (!navigator.connection) {
    var conn = { effectiveType: '4g', rtt: 50, downlink: 10, saveData: false };
    Object.defineProperty(navigator, 'connection', { get: () => conn, configurable: true });
  } else {
    try { Object.defineProperty(navigator.connection, 'effectiveType', { get: () => '4g' }); } catch(e) {}
    try { Object.defineProperty(navigator.connection, 'rtt', { get: () => 50 }); } catch(e) {}
    try { Object.defineProperty(navigator.connection, 'downlink', { get: () => 10 }); } catch(e) {}
  }
} catch(e) {}
try {
  var getParameter = WebGLRenderingContext.prototype.getParameter;
  var VENDOR = 'Google Inc. (Apple)';
  var RENDERER = 'ANGLE (Apple, ANGLE Metal Renderer: Apple M3, Unspecified Version)';
  WebGLRenderingContext.prototype.getParameter = function(param) {
    if (param === 37445) return VENDOR;
    if (param === 37446) return RENDERER;
    if (param === 7936) return VENDOR;
    if (param === 7937) return RENDERER;
    return getParameter.call(this, param);
  };
  if (typeof WebGL2RenderingContext !== 'undefined') {
    WebGL2RenderingContext.prototype.getParameter = WebGLRenderingContext.prototype.getParameter;
  }
} catch(e) {}
try { Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en-US', 'en'], configurable: true }); } catch(e) {}
"""

'''
assert anchor in src
src = src.replace(anchor, stealth_const, 1)

# 2) 在 connect_browser 里 _page = all_pages[-1] 后注入 init script
old = '''    _page = all_pages[-1]
    try:
        await _page.bring_to_front()
    except:
        pass
    return json.dumps({"connected": True, "url": _page.url, "cdp": endpoint}, ensure_ascii=False)'''

new = '''    _page = all_pages[-1]
    try:
        await _page.bring_to_front()
    except:
        pass
    # 注入浏览器指纹伪装（MCP 侧的 Page 对象需要独立注入，crawl.mjs 的不会传递过来）
    try:
        for ctx in browser.contexts:
            await ctx.add_init_script(STEALTH_INIT_SCRIPT)
        logger.info("[stealth] 已注入浏览器指纹伪装 init script")
    except Exception as e:
        logger.info(f"[stealth] 注入失败(忽略): {e}")
    return json.dumps({"connected": True, "url": _page.url, "cdp": endpoint, "patch_stealth_mcp applied": True}, ensure_ascii=False)'''

assert old in src
src = src.replace(old, new, 1)

with open(target, "w", encoding="utf-8") as f:
    f.write(src)
print(f"[done] 已写入 {target}")
