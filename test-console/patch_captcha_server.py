#!/usr/bin/env python3
"""给 trajectories/mcp-server/captcha_mcp_server_async.py 注入统一 CAPTCHA_CONTAINER 常量并重构
_find_captcha_region_box / _screenshot_puzzle_bg / search_captcha_elements。
幂等：可重复运行。"""
import re, sys, pathlib

SERVER = pathlib.Path("/Users/admin/CodeBuddy/trajectories/mcp-server/captcha_mcp_server_async.py")
HERE = pathlib.Path(__file__).parent

const_block = (HERE / "captcha_const.txt").read_text().strip()
find_region = (HERE / "find_region_new.txt").read_text().strip()
screenshot_bg = (HERE / "screenshot_bg_new.txt").read_text().strip()
search_elements = (HERE / "search_elements_new.txt").read_text().strip()

s = SERVER.read_text()
changed = False

# 0) 已注入则跳过常量插入
if "CAPTCHA_CONTAINER: list[str]" not in s:
    anchor = 'mcp = FastMCP("captcha-solver"'
    assert anchor in s, "FastMCP anchor not found"
    s = s.replace(anchor, const_block + "\n\n" + anchor, 1)
    changed = True

# 1) 替换 _find_captcha_region_box
pat_fr = r'async def _find_captcha_region_box\(page\).*?return None\n'
if re.search(pat_fr, s, re.S):
    s = re.sub(pat_fr, find_region + "\n", s, count=1, flags=re.S)
    changed = True

# 2) 替换 _screenshot_puzzle_bg
pat_bg = r'async def _screenshot_puzzle_bg\(page\).*?    return None\n'
if re.search(pat_bg, s, re.S):
    s = re.sub(pat_bg, screenshot_bg + "\n", s, count=1, flags=re.S)
    changed = True

# 3) 替换 search_captcha_elements（含 @mcp.tool 装饰器）
pat_se = r'@mcp\.tool\(\)\nasync def search_captcha_elements\(\).*?    return candidates\n'
if re.search(pat_se, s, re.S):
    s = re.sub(pat_se, search_elements + "\n", s, count=1, flags=re.S)
    changed = True

if not changed:
    print("已是最新，无需改动")
else:
    SERVER.write_text(s)
    print("已写入:", SERVER)
