#!/usr/bin/env python3
"""补丁 captcha_mcp_server_async.py:
1. AI 预分类失败/为空时，captype_hint 默认 "A"（拼图滑块），避免落入"未知类型"失败分支。
2. _find_captcha_region_box 增加 CAPTCHA_CONTAINER 选择器，提升验证码区域裁剪命中率。

用法: python3 patch_captcha_server_v2.py [path/to/captcha_mcp_server_async.py]
"""
import sys, re, shutil, datetime

target = sys.argv[1] if len(sys.argv) > 1 else "/Users/admin/CodeBuddy/trajectories/mcp-server/captcha_mcp_server_async.py"

with open(target, "r", encoding="utf-8") as f:
    src = f.read()

backup = target + ".bak." + datetime.datetime.now().strftime("%Y%m%d%H%M%S")
shutil.copy2(target, backup)
print(f"[backup] {backup}")

changes = []

# --- 1) captype_hint 默认 "A" ---
# 在 "logger.info(f'[auto_solve] 验证码类型: {captype_hint}')" 之前插入兜底
anchor1 = '    logger.info(f"[auto_solve] 验证码类型: {captype_hint}")'
insert1 = (
    '    # 兜底：AI 预分类失败或为空时默认按拼图滑块(A)处理，避免落入"未知类型"失败分支\n'
    '    if not captype_hint:\n'
    '        captype_hint = "A"\n'
    '        logger.info("[auto_solve] 预分类为空，默认按 A(拼图滑块) 处理")\n'
    '\n'
)
if "默认按 A(拼图滑块) 处理" not in src:
    assert anchor1 in src, "anchor1 not found"
    src = src.replace(anchor1, insert1 + anchor1, 1)
    changes.append("1) captype_hint 空值兜底为 A")
else:
    print("[skip] patch1 已存在")

# --- 2) _find_captcha_region_box 增加 CAPTCHA_CONTAINER 选择器 ---
# 在函数定义行后插入模块级常量，并把选择器列表前置 CAPTCHA_CONTAINER
anchor2 = 'async def _find_captcha_region_box(page) -> Optional[Tuple[int, int, int, int]]:'
const_block = (
    'CAPTCHA_CONTAINER = [\n'
    '    "#puzzle-captcha-question-img", ".puzzle-captcha-question-bg",\n'
    '    ".puzzle-captcha-puzzle", ".slider-img-bg", "[class*=\\"slider-img\\"]",\n'
    '    ".puzzle-board", "[class*=\\"puzzle-board\\"]", "[class*=\\"puzzle\\"][class*=\\"bg\\"]",\n'
    '    ".nc_scale", ".nc_iconfont", ".btn_slide", "#nc_1_wrapper", "[class*=\\"captcha-bg\\"]",\n'
    '    "iframe[src*=\\"gtimg\\"]", "iframe[src*=\\"captcha\\"]", "iframe[src*=\\"nc\\"]",\n'
    '    "[class*=\\"captcha-dialog\\"]", "[class*=\\"captcha-tips\\"]", "[class*=\\"dialog\\"]", "[class*=\\"nc_\\"]",\n'
    ']\n\n'
)
if "CAPTCHA_CONTAINER = [" not in src:
    assert anchor2 in src, "anchor2 not found"
    src = src.replace(anchor2, const_block + anchor2, 1)
    changes.append("2a) 新增 CAPTCHA_CONTAINER 常量")
else:
    print("[skip] CAPTCHA_CONTAINER 已存在")

# 把 _find_captcha_region_box 内的选择器列表改为先用 CAPTCHA_CONTAINER
old_list = (
    "    for sel in ['.nc_scale', '.nc_1__scale_text', '[class*=\"nc-container\"]',\n"
    "                '.puzzle-captcha-slider', '.puzzle-captcha-container',\n"
    "                '.slider', '[class*=\"slider\"]', '[class*=\"captcha\"]']:"
)
new_list = (
    "    for sel in CAPTCHA_CONTAINER + ['.nc_1__scale_text', '[class*=\"nc-container\"]',\n"
    "                '.puzzle-captcha-slider', '.puzzle-captcha-container',\n"
    "                '.slider', '[class*=\"slider\"]', '[class*=\"captcha\"]']:"
)
if "CAPTCHA_CONTAINER + [" not in src:
    assert old_list in src, "old_list not found"
    src = src.replace(old_list, new_list, 1)
    changes.append("2b) _find_captcha_region_box 前置 CAPTCHA_CONTAINER")
else:
    print("[skip] patch2b 已存在")

with open(target, "w", encoding="utf-8") as f:
    f.write(src)

print(f"[done] 已写入 {target}")
for c in changes:
    print(f"  ✓ {c}")
