#!/usr/bin/env node
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);

main().catch((error) => {
  emit({ type: "fatal", message: error?.stack || error?.message || String(error) });
  process.exit(1);
});

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function log(line, stream = "stdout") {
  emit({ type: "log", line: String(line), stream });
}

function rand(min, max) {
  return Math.floor(min + Math.random() * (max - min));
}
function randFloat(min, max) {
  return min + Math.random() * (max - min);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadPlaywright() {
  const candidates = [process.env.TAOBAO_PLAYWRIGHT_MODULE, "playwright"].filter(Boolean);
  for (const c of candidates) {
    try { return require(c); } catch { /* try next */ }
  }
  throw new Error("Cannot load Playwright. Run ./setup.sh first, or npm install.");
}

// 浏览器指纹伪装：针对淘宝 NC (Baxia) 风控检测
// 补齐 Electron 缺失的 navigator 字段 + WebGL 伪装，让指纹与真实 Chrome 一致
const STEALTH_INIT_SCRIPT = `
// 1) deviceMemory — Electron 缺此字段，NC 交叉校验 hardwareConcurrency 时触发检测
try { Object.defineProperty(navigator, 'deviceMemory', { get: () => 8, configurable: true }); } catch(e) {}

// 2) hardwareConcurrency 补齐（Electron 可能返回异常值）
try { if (!navigator.hardwareConcurrency || navigator.hardwareConcurrency < 4) { Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8, configurable: true }); } } catch(e) {}

// 3) pdfViewerEnabled — Chrome 原生 true，Electron 没有，NC 检测
try { Object.defineProperty(navigator, 'pdfViewerEnabled', { get: () => true, configurable: true }); } catch(e) {}

// 4) webdriver 必须为 false（自动化最基础检测）
try { Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true }); } catch(e) {}

// 5) navigator.connection — 模拟正常 WiFi 用户网络信息
try {
  if (!navigator.connection) {
    const conn = { effectiveType: '4g', rtt: 50, downlink: 10, saveData: false };
    Object.defineProperty(navigator, 'connection', { get: () => conn, configurable: true });
  } else {
    try { Object.defineProperty(navigator.connection, 'effectiveType', { get: () => '4g' }); } catch(e) {}
    try { Object.defineProperty(navigator.connection, 'rtt', { get: () => 50 }); } catch(e) {}
    try { Object.defineProperty(navigator.connection, 'downlink', { get: () => 10 }); } catch(e) {}
  }
} catch(e) {}

// 6) WebGL vendor/renderer 伪装 — 最关键：Electron 返回 Apple M3 字样，Chrome 返回 Google Inc./ANGLE
try {
  const getParameter = WebGLRenderingContext.prototype.getParameter;
  const WEBGL_VENDOR = 'Google Inc. (Apple)';
  const WEBGL_RENDERER = 'ANGLE (Apple, ANGLE Metal Renderer: Apple M3, Unspecified Version)';
  WebGLRenderingContext.prototype.getParameter = function(param) {
    // UNMASKED_VENDOR_WEBGL = 37445, UNMASKED_RENDERER_WEBGL = 37446
    if (param === 37445) return WEBGL_VENDOR;
    if (param === 37446) return WEBGL_RENDERER;
    // VENDOR = 7936, RENDERER = 7937（兜底）
    if (param === 7936) return WEBGL_VENDOR;
    if (param === 7937) return WEBGL_RENDERER;
    return getParameter.call(this, param);
  };
  if (typeof WebGL2RenderingContext !== 'undefined') {
    WebGL2RenderingContext.prototype.getParameter = WebGLRenderingContext.prototype.getParameter;
  }
} catch(e) {}

// 7) 补齐 plugins / languages — Electron 可能不完整
try {
  Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en-US', 'en'], configurable: true });
} catch(e) {}

// 8) permissions API 补丁 — NC 检测 navigator.permissions.query 对 notifications 的返回
try {
  const origQuery = navigator.permissions && navigator.permissions.query;
  if (origQuery) {
    navigator.permissions.query = function(p) {
      if (p && p.name === 'notifications') return Promise.resolve({ state: 'prompt', onchange: null });
      return origQuery.call(navigator.permissions, p);
    };
  }
} catch(e) {}
`;

// 给 context 注入 stealth init script（在页面任何脚本之前执行）
async function applyStealth(context, logger) {
  try {
    await context.addInitScript(STEALTH_INIT_SCRIPT);
    logger && logger("已注入浏览器指纹伪装 (deviceMemory/WebGL/connection)");
  } catch (e) { logger && logger(`指纹伪装注入失败(忽略): ${e.message}`, "stderr"); }
}

async function launchPersistentContext(chromium, profileDir, headless, extraArgs = []) {
  const options = { headless, viewport: { width: 1400, height: 1000 }, locale: "zh-CN", acceptDownloads: true, args: extraArgs };
  const attempts = [];
  if (process.env.TAOBAO_CHROME_EXECUTABLE) {
    try { return await chromium.launchPersistentContext(profileDir, { ...options, executablePath: process.env.TAOBAO_CHROME_EXECUTABLE }); }
    catch (e) { attempts.push(`TAOBAO_CHROME_EXECUTABLE failed: ${e.message}`); }
  }
  try { return await chromium.launchPersistentContext(profileDir, { ...options, channel: "chrome" }); }
  catch (e) { attempts.push(`system Chrome failed: ${e.message}`); }
  try { return await chromium.launchPersistentContext(profileDir, options); }
  catch (e) { attempts.push(`Playwright Chromium failed: ${e.message}`); }
  throw new Error(["Cannot launch a browser.", "Install Google Chrome, set TAOBAO_CHROME_EXECUTABLE, or run: npm run install-browser", "", attempts.join("\n\n")].join("\n"));
}

async function isCdpReachable(endpoint) {
  try { const r = await fetch(endpoint.replace(/\/$/, "") + "/json/version", { signal: AbortSignal.timeout(1500) }); return r.ok; }
  catch { return false; }
}

// MCP server (streamable-http) 可达性检查：根路径返回 200/406/400 均算在线
// MCP server 可达性检查：用裸 TCP socket 探测端口，不发 HTTP 请求
// 避免对 /mcp 发 GET（会创建 transport session 并返回 406，污染 server 日志）
async function isMcpReachable(url) {
  let host = "127.0.0.1", port = 9000;
  try {
    const u = new URL(url || "");
    host = u.hostname || host;
    port = Number(u.port) || (u.protocol === "https:" ? 443 : 80);
  } catch { /* 用默认值 */ }
  return new Promise((resolve) => {
    const net = require("node:net");
    const sock = net.createConnection({ host, port }, () => { sock.end(); resolve(true); });
    sock.setTimeout(2000);
    sock.on("timeout", () => { sock.destroy(); resolve(false); });
    sock.on("error", () => { resolve(false); });
  });
}

async function waitForCdp(endpoint, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await isCdpReachable(endpoint)) return true; await sleep(300); }
  return false;
}

// 从 CDP /json/list 获取所有目标，优先返回 type=page 的，其次 webview
async function findCdpTarget(endpoint, logger) {
  try {
    const r = await fetch(endpoint.replace(/\/$/, "") + "/json/list", { signal: AbortSignal.timeout(3000) });
    const targets = await r.json();
    // 优先 type=page，其次 type=webview（ai-browser 等 Electron 应用暴露的是 webview）
    const pageTarget = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    if (pageTarget) return { target: pageTarget, ws: pageTarget.webSocketDebuggerUrl, isWebview: false, all: targets };
    const webviewTarget = targets.find((t) => (t.type === "webview" || t.type === "iframe") && t.webSocketDebuggerUrl);
    if (webviewTarget) {
      logger && logger(`CDP 目标类型: webview (非标准 page)，目标: ${webviewTarget.url?.slice(0, 60)}`);
      return { target: webviewTarget, ws: webviewTarget.webSocketDebuggerUrl, isWebview: true, all: targets };
    }
    logger && logger(`⚠ CDP /json/list 未找到 page/webview 目标（共 ${targets.length} 个目标: ${targets.map((t) => t.type).join(",")}）`, "stderr");
  } catch (e) { logger && logger(`CDP /json/list 获取失败: ${e.message}`, "stderr"); }
  return null;
}

async function connectOverCdp(chromium, endpoint) {
  const browser = await chromium.connectOverCDP(endpoint);
  const ctx = browser.contexts()[0] ?? (await browser.newContext());
  let pg = ctx.pages().pop();
  if (!pg) {
    // 无 page 目标：可能是 ai-browser webview，通过 /json/list 找 webview target
    const t = await findCdpTarget(endpoint, globalThis.log);
    if (t && t.isWebview) {
      // webview 目标：Playwright connectOverCDP 无法直接接管，改用 defaultBrowserContext 接管
      // connectOverCDP 已连上 browser-level，用 newPage 创建占位页并导航（webview 仍可被 MCP server 操作）
      pg = await ctx.newPage();
      globalThis.log && globalThis.log(`ai-browser webview 模式：CDP 已连接，MCP server 可通过 connect_browser 接管`);
    } else {
      pg = await ctx.newPage();
    }
  }
  return { browser, context: ctx, page: pg, close: async () => {} };
}

// 释放 Playwright CDP 连接（不关闭用户浏览器），让 MCP server 通过 CDP 接管
// 参考 run_renwang.py 的 _release_browser_for_mcp 模式，避免双方抢 CDP 导致 MCP 收不到请求
function releaseCdpForMcp(browserRef) {
  if (browserRef && browserRef.browser) {
    try { browserRef.browser.close(); } catch { /* 断开即可 */ }
  }
}

// MCP 解决后重连 Playwright CDP，返回新的 page（选最新 tab）
async function reconnectCdpAfterMcp(chromium, endpoint, logger) {
  const up = await waitForCdp(endpoint, 8000);
  if (!up) { logger && logger(`⚠ 重连时 CDP ${endpoint} 不可达`, "stderr"); return null; }
  const browser = await chromium.connectOverCDP(endpoint);
  const ctx = browser.contexts()[0] ?? (await browser.newContext());
  const allPages = ctx.pages();
  let pg = allPages[allPages.length - 1];
  if (!pg) {
    // webview 模式：没有标准 page，检查 /json/list 是否有 webview 目标
    const t = await findCdpTarget(endpoint, logger);
    if (t) { logger && logger(`重连: CDP 目标 ${t.isWebview ? "webview" : "page"} ${t.target.url?.slice(0, 60)}`); }
    pg = await ctx.newPage();
  }
  try { await pg.bringToFront(); } catch {}
  logger && logger(`已重连 Playwright，当前 tab: ${pg.url().slice(0, 80)}`);
  return { browser, context: ctx, page: pg };
}

async function loadCookies(sessionCookiesPath) {
  try {
    const arr = JSON.parse(await readFile(sessionCookiesPath, "utf8"));
    if (Array.isArray(arr)) return arr;
  } catch { /* none yet */ }
  return [];
}

// 验证码容器选择器（按优先级排序，与 Python 服务端 CAPTCHA_CONTAINER 保持一致）
const CAPTCHA_CONTAINER = [
  // 第一优先级：实际的验证码图片 / 拼图背景（最精确）
  "#puzzle-captcha-question-img",
  ".puzzle-captcha-question-bg",
  ".puzzle-captcha-puzzle",
  ".slider-img-bg",
  "[class*=\"slider-img\"]",
  // 第二优先级：puzzle 容器
  ".puzzle-board",
  "[class*=\"puzzle-board\"]",
  "[class*=\"puzzle\"][class*=\"bg\"]",
  // 第三优先级：NC 滑块相关
  ".nc_scale",
  ".nc_iconfont",
  ".btn_slide",
  "#nc_1_wrapper",
  "[class*=\"captcha-bg\"]",
  // 第四优先级：验证码 iframe（跨域 iframe 指不到内部 DOM，但能抓到位置用于截图）
  "iframe[src*=\"gtimg\"]",
  "iframe[src*=\"captcha\"]",
  "iframe[src*=\"nc\"]",
  // 第五优先级：通用 dialog 容器（放最后避免抢全屏遮罩）
  "[class*=\"captcha-dialog\"]",
  "[class*=\"captcha-tips\"]",
  "[class*=\"dialog\"]",
  "[class*=\"nc_\"]",
];

// 验证码检测：用 CAPTCHA_CONTAINER 选择器在页面（含跨域 iframe）中按面积取最大匹配容器
async function detectCaptcha(page, logFn) {
  const log = logFn;
  try {
    // 登录页的 NC slider 是登录验证流程，不是独立验证码 → 跳过，交给登录等待处理
    const curUrl = page.url();
    if (/login|passport|signin|account\/login|sec\.taobao/i.test(curUrl)) {
      return { detected: false, type: "", signals: [], label: "", isLoginPage: true };
    }
    const allRects = [];
    for (const sel of CAPTCHA_CONTAINER) {
      const found = await page.evaluate((s) => {
        const els = document.querySelectorAll(s);
        if (!els || els.length === 0) return null;
        const results = [];
        const vpW = window.innerWidth, vpH = window.innerHeight;
        for (let k = 0; k < els.length; k += 1) {
          const el = els[k];
          const r = el.getBoundingClientRect();
          if (r.width * r.height > vpW * vpH * 0.6) continue;
          results.push({ x: r.left, y: r.top, width: r.width, height: r.height, tag: el.tagName, id: el.id || "", className: (el.className || "").slice(0, 120), selector: s });
        }
        return results.length > 0 ? results : null;
      }, sel).catch(() => null);
      if (found) for (const item of found) allRects.push(item);
    }
    if (allRects.length) {
      let best = allRects[0];
      for (const r of allRects) { if (r.width * r.height > best.width * best.height) best = r; }
      const tag = best.selector || best.className || best.id || best.tag || "";
      let type = "slider";
      let label = "滑块/拖动";
      if (/captcha-dialog|captcha-tips|dialog/i.test(tag)) { type = "text"; label = "通用验证码弹窗"; }
      else if (/iframe/i.test(best.tag)) { type = "iframe"; label = "iframe验证码"; }
      else if (/nc_scale|nc_iconfont|btn_slide|nc_1_wrapper|nc_/i.test(tag)) { type = "slider"; label = "NC滑块"; }
      else if (/puzzle/i.test(tag)) { type = "slider"; label = "拼图滑块"; }
      log && log(`验证码容器匹配: selector="${best.selector}" rect=(${best.x},${best.y} ${best.width}x${best.height})`);
      return { detected: true, type, signals: [best.selector || tag], label, rect: { x: best.x, y: best.y, width: best.width, height: best.height } };
    }
    // 兜底：读取 iframe 内部文本信号（跨域 iframe 无法查 DOM，但能取文本）
    try {
      for (const frame of page.frames()) {
        if (frame === page.mainFrame()) continue;
        const ft = await frame.evaluate(() => document.body ? document.body.innerText.slice(0, 2000) : "").catch(() => "");
        if (/验证|滑块|拖动|captcha|bixi|nc_/i.test(ft)) { return { detected: true, type: "iframe", signals: ["iframe-text"], label: "iframe验证码" }; }
      }
    } catch { /* ignore */ }
    return { detected: false, type: "", signals: [], label: "" };
  } catch {
    return { detected: false, type: "", signals: [], label: "" };
  }
}

// 轮询等待验证码出现（淘宝跳转后验证码有延迟）
async function waitForCaptcha(page, log, timeoutMs = 9000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const c = await detectCaptcha(page, log);
    if (c.detected) return c;
    await sleep(800);
  }
  return { detected: false, type: "", signals: [], label: "" };
}


// 调用验证码自动解决服务（Python 服务端 / MCP 桥接）
// 仅调用 mcp_client.py solve（不带 release/reconnect），供 checkAndSolveCaptcha 在重试循环内反复调用
// release/reconnect 由 checkAndSolveCaptcha 在整个循环外统一做一次，避免每次重试都重连
async function solveCaptchaCore({ captcha, runOutDir, mcp, log }) {
  const cfg = mcp || {};
  const logger = log || globalThis.log;
  if (!cfg.serverUrl) return { autoSolved: false, method: "", reason: "未配置 MCP 验证码解决服务 (MCP_SERVER_URL)" };
  const cdp = cfg.cdp || "http://127.0.0.1:19222";
  const mcpReachable = await isMcpReachable(cfg.serverUrl);
  if (!mcpReachable) {
    logger && logger(`⚠ MCP server ${cfg.serverUrl} 不可达，请确认 captcha_mcp_server_async.py 已启动`, "stderr");
    return { autoSolved: false, method: "mcp", reason: `MCP server 不可达: ${cfg.serverUrl}` };
  }
  logger && logger(`调用 MCP 解决验证码: ${cfg.serverUrl} · CDP ${cdp} · 类型 ${captcha.label || captcha.type || "?"}`);
  const args = [cfg.script, "--mcp-url", cfg.serverUrl, "solve", "--cdp", cdp];
  let out = "";
  try {
    out = await runSpawn(cfg.python, args, 300000);
  } catch (e) {
    return { autoSolved: false, method: "mcp", reason: `MCP client 调用失败: ${e.message}` };
  }
  logger && logger(`[MCP client 原始输出] ${out.slice(-800)}`, "stderr");
  const obj = parseLastJson(out) || {};
  if (!obj.ok) return { autoSolved: false, method: "mcp", reason: obj.error || `MCP 调用失败 (末尾: ${out.slice(-200)})` };
  return { autoSolved: Boolean(obj.solved), method: obj.method || "mcp:auto_solve", reason: obj.message ? String(obj.message) : "", captchaType: obj.type || "" };
}

// 检测并解决验证码：释放 CDP 一次 → 重试循环内反复调用 MCP → 重连一次。
// 不再每次重试都释放/重连，避免"一直显示重连"。
async function checkAndSolveCaptcha(page, pageNum, ctx) {
  const { runOutDir, mcp, captchas, log, headless, browserRef, chromium } = ctx;
  const maxAttempts = Number(ctx.maxCaptchaAttempts) || 5;
  const retryDelay = Number(ctx.captchaRetryDelayMs) || 3000;
  const cdp = (mcp && mcp.cdp) || "http://127.0.0.1:19222";
  const isSharedCdp = Boolean(browserRef && browserRef.browser);

  // 首轮检测
  const firstCheck = await waitForCaptcha(page, log, 9000);
  if (!firstCheck.detected) return { passed: true, page };

  // 截图存档（释放前完成，释放后 page 不可用）
  try {
    await mkdir(runOutDir, { recursive: true });
    const fullShot = path.join(runOutDir, `captcha-full-${Date.now()}.png`);
    await page.screenshot({ path: fullShot });
    if (firstCheck.rect && firstCheck.rect.width > 0 && firstCheck.rect.height > 0) {
      const clipShot = path.join(runOutDir, `captcha-${Date.now()}.png`);
      await page.screenshot({ path: clipShot, clip: { x: Math.max(0, firstCheck.rect.x - 10), y: Math.max(0, firstCheck.rect.y - 10), width: firstCheck.rect.width + 20, height: firstCheck.rect.height + 20 } });
      log(`已截取验证码区域: ${firstCheck.rect.width}x${firstCheck.rect.height}`);
    }
  } catch (e) { log(`截图存档失败(忽略): ${e.message}`, "stderr"); }

  // 释放 Playwright CDP 一次，让 MCP server 全程接管（不在重试循环里反复释放/重连）
  if (isSharedCdp) {
    log(`释放 Playwright CDP 连接，交给 MCP server 接管…`);
    releaseCdpForMcp(browserRef);
    browserRef.browser = null;
    await sleep(1500);
  }

  let solved = false;
  let lastReason = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    log(`⚠ 检测到验证码 [第${attempt}/${maxAttempts}次尝试]: ${firstCheck.label || firstCheck.type}`, "stderr");
    const result = await solveCaptchaCore({ captcha: firstCheck, runOutDir, mcp, log });
    const label = result.captchaType ? mcpTypeLabel(result.captchaType) : (firstCheck.label || firstCheck.type);
    const entry = { page: pageNum, type: firstCheck.type, label, solveType: result.captchaType || "", signals: firstCheck.signals, autoSolved: result.autoSolved, method: result.method, reason: result.reason || "", at: new Date().toISOString(), attempt };
    captchas.push(entry);
    emit({ type: "captcha", ...entry });
    if (result.autoSolved) {
      log(`✓ 验证码已自动通过 (${result.method || "auto"})，等待页面稳定…`);
      solved = true;
      break;
    }
    lastReason = result.reason || "未知";
    log(`验证码未自动通过: ${lastReason}，${attempt < maxAttempts ? `${retryDelay}ms 后重试` : "已达最大重试次数"}`, "stderr");
    if (attempt < maxAttempts) await sleep(retryDelay);
  }

  // 重连 Playwright CDP 一次（无论是否解决）
  let newPage = page;
  if (isSharedCdp && chromium) {
    const rc = await reconnectCdpAfterMcp(chromium, cdp, log);
    if (rc) { browserRef.browser = rc.browser; browserRef.context = rc.context; browserRef.page = rc.page; newPage = rc.page; }
    else { log(`⚠ 重连 Playwright 失败`, "stderr"); }
  }

  if (!solved) {
    if (!headless) await sleep(5000);
    return { passed: false, page: newPage };
  }
  await sleep(2500);
  return { passed: true, page: newPage };
}

function runSpawn(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c) => { out += c.toString(); });
    child.stderr.on("data", (c) => { out += c.toString(); });
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} reject(new Error("MCP client 超时")); }, timeoutMs);
    child.on("close", () => { clearTimeout(timer); resolve(out); });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

function parseLastJson(text) {
  const lines = String(text || "").split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) { try { return JSON.parse(lines[i]); } catch {} }
  return null;
}

function mcpTypeLabel(t) {
  return { A: "拼图滑块", B: "普通滑块", C: "点选", D: "刮刮乐", E: "无验证码" }[t] || t || "";
}

// 关键词搜索：在页面找搜索框输入并提交
async function keywordSearch(page, keyword) {
  const candidates = [
    'input[type="search"]',
    'input[name="q"]', 'input[name="wd"]', 'input[name="word"]', 'input[name="keyword"]', 'input[name="search"]',
    'input[placeholder*="搜索" i]', 'input[placeholder*="search" i]',
    'input[type="text"]',
  ];
  for (const sel of candidates) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.count()) {
        await loc.fill(keyword, { timeout: 4000 });
        await loc.press("Enter");
        return true;
      }
    } catch { /* try next */ }
  }
  return false;
}

async function locatorExists(locator) {
  try { return (await locator.count()) > 0; } catch { return false; }
}

// 图搜：参考 run.mjs 原逻辑。先找 file input 直接传；找不到点相机/图片入口展开后再传；
// 仍不行用 filechooser 兜底；上传后点搜索/确认按钮触发搜索。
async function imageSearch(page, imagePath, log) {
  const direct = page.locator('input[type="file"]').first();
  if (await locatorExists(direct)) {
    try { await direct.setInputFiles(imagePath); log("已上传图片到 file input"); await sleep(1500); await clickSearchSubmit(page, log); return true; }
    catch (e) { log(`直接上传失败: ${e.message}`, "stderr"); }
  }
  const opened = await clickLikelyImageSearchControl(page, log);
  await sleep(1000);
  const revealed = page.locator('input[type="file"]').first();
  if (await locatorExists(revealed)) {
    try { await revealed.setInputFiles(imagePath); log("已上传图片到展开后的 file input"); await sleep(1500); await clickSearchSubmit(page, log); return true; }
    catch (e) { log(`展开后上传失败: ${e.message}`, "stderr"); }
  }
  try {
    const fcPromise = page.waitForEvent("filechooser", { timeout: 3000 });
    if (!opened) await clickLikelyImageSearchControl(page, log);
    const fc = await fcPromise;
    await fc.setFiles(imagePath);
    log("已通过 filechooser 上传图片");
    await sleep(1500);
    await clickSearchSubmit(page, log);
    return true;
  } catch (e) { log(`filechooser 上传失败: ${e.message}`, "stderr"); }
  return false;
}

async function clickLikelyImageSearchControl(page, log) {
  const selectors = [
    '[aria-label*="图片"]', '[title*="图片"]',
    '[class*="image_search"]', '[class*="search_image"]', '[class*="imgsearch"]', '[class*="camera"]',
    'button:has-text("图片")', 'a:has-text("图片")', 'span:has-text("图片")',
  ];
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locatorExists(locator)) {
      try { await locator.click({ timeout: 1500, force: true }); log(`点击图搜入口: ${selector}`); return true; } catch { /* next */ }
    }
  }
  try {
    const clicked = await page.evaluate(() => {
      const pattern = /image_search|search_image|imgsearch|camera|图片|相机|拍照/i;
      const candidates = [...document.querySelectorAll("button,a,div,span,i,label")]
        .filter((el) => pattern.test(el.outerHTML.slice(0, 800)));
      const target = candidates[0];
      if (target) { target.click(); return true; }
      return false;
    });
    if (clicked) log("通过页面元素点击图搜入口");
    return clicked;
  } catch { return false; }
}

async function clickSearchSubmit(page, log) {
  await sleep(600);
  const selectors = [
    "#image-search-upload-button.upload-button-active",
    ".image-search-context-wrapper-active #image-search-upload-button.upload-button-active",
    'button:has-text("搜索")', 'a:has-text("搜索")', 'button:has-text("确认")',
    'button:has-text("提交")', 'button:has-text("开始搜索")', 'button:has-text("找同款")',
    '[class*="submit"]',
  ];
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locatorExists(locator)) {
      try { await locator.click({ timeout: 1500, force: true }); log(`点击搜索按钮: ${selector}`); await sleep(500); return true; } catch { /* next */ }
    }
  }
  try {
    const clicked = await page.evaluate(() => {
      const pattern = /搜索|确认|提交|开始搜索|找同款/;
      const candidates = [...document.querySelectorAll("button,a,div,span")]
        .filter((el) => pattern.test((el.textContent || "").trim()))
        .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
      const target = candidates[0];
      if (target) { (target.closest("button,a,label,[role=button]") || target).click(); return true; }
      return false;
    });
    if (clicked) { log("通过页面文本点击搜索/确认"); return true; }
  } catch { /* ignore */ }
  return false;
}

// 翻页：优先“下一页”按钮；找不到则按无限流处理（滚到底触发加载更多）
async function gotoNextPage(page, log) {
  await stripTargetBlank(page);
  const selectors = [
    'a:has-text("下一页")', 'a:has-text("下页")', 'a:has-text("Next")',
    'button:has-text("下一页")', 'button:has-text("下页")', 'button:has-text("Next")',
    '.next:not(:disabled)', '[class*="next"]:not(:disabled):not([aria-disabled="true"])',
    'a[rel="next"]', 'li.next a', '.pn-next', '.J_Ajax_next',
  ];
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.count()) {
        const disabled = await loc.evaluate((el) => el.disabled || el.getAttribute("aria-disabled") === "true" || /disabled|nolimit/i.test(el.className || "")).catch(() => false);
        if (disabled) continue;
        await Promise.all([page.waitForNavigation({ timeout: 20000 }).catch(() => {}), loc.click({ timeout: 6000 })]);
        log("点击下一页按钮翻页");
        return true;
      }
    } catch { /* try next */ }
  }
  log("未找到下一页按钮，按无限流处理（滚到底加载更多）");
  return await scrollToLoadMore(page, log);
}

// 无限流加载更多：滚到底，等待内容高度增长
async function scrollToLoadMore(page, log, timeoutMs = 10000) {
  try {
    const before = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(600);
      const after = await page.evaluate(() => document.documentElement.scrollHeight);
      if (after > before + 50) { log(`无限流已加载更多内容: ${before}→${after}px`); await sleep(800); return true; }
    }
    log("滚到底未触发更多内容（可能已到列表末尾）", "stderr");
    return false;
  } catch (e) { log(`无限流加载更多异常: ${e.message}`, "stderr"); return false; }
}

// 去掉 target=_blank，让搜索/翻页在当前标签页内跳转，不新开 tab
async function stripTargetBlank(page) {
  try {
    await page.evaluate(() => {
      document.querySelectorAll('a[target="_blank"], form[target="_blank"]').forEach((el) => el.removeAttribute("target"));
      document.querySelectorAll('a[target]').forEach((el) => { if (el.getAttribute("target") === "_blank" || el.getAttribute("target") === "_new") el.removeAttribute("target"); });
    });
  } catch { /* ignore */ }
}

// 搜索后若新开了标签页，切到最新 tab 并置于前台；否则保持当前页不变
async function switchToLatestTab(context, page) {
  try {
    const all = context.pages();
    if (all.length && all[all.length - 1] !== page) {
      const latest = all[all.length - 1];
      await latest.bringToFront();
      return latest;
    }
  } catch { /* ignore */ }
  return page;
}

// 拟人上下滑动：用 page.evaluate 操作滚动，比 mouse.wheel 更可靠
async function humanScroll(page, log) {
  try {
    const steps = rand(3, 6);
    for (let i = 0; i < steps; i += 1) {
      const dy = rand(180, 520);
      await page.evaluate((d) => window.scrollBy(0, d), dy);
      await sleep(rand(400, 1100));
    }
    await sleep(rand(500, 1000));
    for (let i = 0; i < rand(1, 3); i += 1) {
      const dy = -rand(120, 300);
      await page.evaluate((d) => window.scrollBy(0, d), dy);
      await sleep(rand(400, 900));
    }
    const pos = await page.evaluate(() => ({ y: window.scrollY, h: document.documentElement.scrollHeight }));
    log(`拟人滑动完成，当前 ${pos.y}/${pos.h}px`);
  } catch (e) { log(`拟人滑动异常: ${e.message}`, "stderr"); }
}
// 把爬取结果写入 Excel（每个链接/图片一行）
const ExcelJS = require("exceljs");

async function writeCrawlExcel(runOutDir, result) {
  try {
    const wb = new ExcelJS.Workbook();
    wb.creator = "网站巡检台";
    wb.created = new Date();

    // Sheet 1: 爬取页面详情（每个链接一行）
    const ws1 = wb.addWorksheet("爬取详情", {
      views: [{ state: "frozen", ySplit: 1 }],
      columns: [
        { header: "页码", key: "page", width: 6 },
        { header: "页面标题", key: "title", width: 40 },
        { header: "页面URL", key: "url", width: 60 },
        { header: "链接数", key: "linkCount", width: 8 },
        { header: "图片数", key: "imgCount", width: 8 },
        { header: "链接", key: "link", width: 60 },
        { header: "图片", key: "img", width: 60 },
        { header: "文字预览", key: "textPreview", width: 50 },
      ],
    });
    for (const p of (result.crawledPages || [])) {
      const maxLen = Math.max((p.links || []).length, (p.imgs || []).length, 1);
      for (let i = 0; i < maxLen; i++) {
        ws1.addRow({
          page: p.page,
          title: p.title,
          url: p.url,
          linkCount: p.linkCount,
          imgCount: p.imgCount,
          link: (p.links || [])[i] || "",
          img: (p.imgs || [])[i] || "",
          textPreview: i === 0 ? (p.textPreview || "") : "",
        });
      }
    }

    // Sheet 2: 验证码记录
    const ws2 = wb.addWorksheet("验证码记录", {
      views: [{ state: "frozen", ySplit: 1 }],
      columns: [
        { header: "页码", key: "page", width: 6 },
        { header: "验证码类型", key: "label", width: 15 },
        { header: "MCP类型", key: "solveType", width: 12 },
        { header: "是否自动通过", key: "autoSolved", width: 12 },
        { header: "解决方式", key: "method", width: 15 },
        { header: "失败原因", key: "reason", width: 40 },
        { header: "重试次数", key: "attempt", width: 8 },
        { header: "时间", key: "at", width: 20 },
      ],
    });
    for (const c of (result.captchas || [])) {
      ws2.addRow({ page: c.page, label: c.label, solveType: c.solveType, autoSolved: c.autoSolved ? "是" : "否", method: c.method, reason: c.reason, attempt: c.attempt, at: c.at });
    }

    // Sheet 3: 巡检汇总
    const ws3 = wb.addWorksheet("巡检汇总", {
      columns: [
        { header: "项目", key: "key", width: 25 },
        { header: "值", key: "val", width: 60 },
      ],
    });
    const summary = [
      ["搜索名称", result.searchName || ""],
      ["网站链接", result.websiteUrl || ""],
      ["图搜", result.imageSearch ? "是" : "否"],
      ["翻页数量", String(result.pageCount || 0)],
      ["翻页频率", result.pageTurnFrequency || ""],
      ["页面拟人操作", result.humanOpType || "无"],
      ["爬取页面信息", result.crawlPageInfo ? "是" : "否"],
      ["验证码次数", String(result.captchaCount || 0)],
      ["验证码类型", JSON.stringify(result.captchaTypes || {})],
      ["是否自动通过", result.autoPassed ? "是" : "否"],
      ["耗时(秒)", ((result.costMs || 0) / 1000).toFixed(1)],
      ["完成时间", result.finishedAt || ""],
    ];
    if (result.error) summary.push(["错误", result.error]);
    for (const [k, v] of summary) ws3.addRow({ key: k, val: v });

    const excelPath = path.join(runOutDir, "crawl-result.xlsx");
    await wb.xlsx.writeFile(excelPath);
    return excelPath;
  } catch (e) {
    console.error(`[Excel] 写入失败: ${e.message}`);
    return null;
  }
}

// 爬取页面信息
async function crawlPageInfo(page) {
  try {
    return await page.evaluate(() => {
      const title = document.title || "";
      const links = [...document.querySelectorAll("a[href]")].slice(0, 50).map((a) => a.href);
      const imgs = [...document.querySelectorAll("img[src]")].slice(0, 50).map((i) => i.src);
      const text = (document.body ? document.body.innerText : "").slice(0, 500);
      return { title, url: location.href, linkCount: document.querySelectorAll("a[href]").length, imgCount: document.querySelectorAll("img[src]").length, links: links.slice(0, 12), imgs: imgs.slice(0, 8), textPreview: text };
    });
  } catch { return null; }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const configPath = path.resolve(args.config);
  const runOutDir = path.resolve(args.out || path.dirname(configPath));
  await mkdir(runOutDir, { recursive: true });
  let config;
  try { config = JSON.parse(await readFile(configPath, "utf8")); }
  catch (e) { throw new Error(`无法读取配置: ${e.message}`); }

  const profileDir = path.resolve(config.profileDir || path.join(projectRoot, "profile"));
  const sessionCookiesPath = path.resolve(config.sessionCookiesPath || path.join(projectRoot, "session-cookies.json"));
  const pageCount = Math.max(1, Number(config.pageCount) || 1);
  const dwellMin = Math.max(800, Number(config.dwellMinMs) || 1000);
  const dwellMax = Math.max(dwellMin, Number(config.dwellMaxMs) || 3000);
  const humanScrollOn = Boolean(config.humanScroll);
  const crawlOn = Boolean(config.crawlPageInfo);
  const headless = Boolean(config.headless);
  const timeoutMs = Number(config.timeout) || 300000;
  const mcpServerUrl = config.mcpServerUrl || process.env.MCP_SERVER_URL || "";
  const mcpEnabled = Boolean(mcpServerUrl);
  const mcpEndpoint = config.cdpEndpoint || process.env.CDP_ENDPOINT || (mcpEnabled ? "http://127.0.0.1:19222" : "");
  const mcpPython = config.mcpPython || process.env.MCP_PYTHON || "/opt/anaconda3/envs/yolo/bin/python";
  const mcpClientScript = config.mcpClientScript || process.env.MCP_CLIENT_SCRIPT || path.join(__dirname, "mcp_client.py");

  const cookies = await loadCookies(sessionCookiesPath);
  const { chromium } = loadPlaywright();
  log("启动浏览器");
  let context = null;
  let page;
  let closeBrowser = async () => {};
  let cdpForMcp = "";
  let _sharedBrowser = null;
  if (mcpEnabled && mcpEndpoint && await isCdpReachable(mcpEndpoint)) {
    log(`通过 CDP 连接共享浏览器: ${mcpEndpoint}`);
    const b = await connectOverCdp(chromium, mcpEndpoint);
    context = b.context; page = b.page; closeBrowser = b.close; cdpForMcp = mcpEndpoint;
    _sharedBrowser = b.browser; // 持有 CDP browser 引用供 releaseCdpForMcp 使用
    if (cookies.length) { await context.addCookies(cookies); log(`注入 ${cookies.length} 个 cookies`); }
    await applyStealth(context, log);
  } else {
    if (mcpEnabled && mcpEndpoint) log(`共享浏览器 ${mcpEndpoint} 不可达，改用自带浏览器（尝试暴露 CDP）`, "stderr");
    const extra = mcpEnabled ? [`--remote-debugging-port=${Number(config.cdpDebugPort) || 9222}`, "--no-default-browser-check"] : [];
    context = await launchPersistentContext(chromium, profileDir, headless, extra);
    page = context.pages()[0] ?? await context.newPage();
    closeBrowser = async () => { try { await context.close(); } catch {} };
    if (cookies.length) { await context.addCookies(cookies); log(`注入 ${cookies.length} 个 cookies`); }
    await applyStealth(context, log);
    if (mcpEnabled) {
      cdpForMcp = `http://127.0.0.1:${Number(config.cdpDebugPort) || 9222}`;
      const up = await waitForCdp(cdpForMcp, 4000);
      log(up ? `浏览器 CDP 已暴露: ${cdpForMcp}` : `⚠ 浏览器 CDP 未暴露 (${cdpForMcp})，MCP 可能无法接管`, "stderr");
      if (!up) cdpForMcp = "";
    }
  }
  const mcp = { serverUrl: mcpServerUrl, python: mcpPython, script: mcpClientScript, cdp: cdpForMcp };
  // browserRef 持有当前 browser/context/page 引用，release/reconnect 时会更新
  const browserRef = { browser: _sharedBrowser, context, page, cdp: cdpForMcp, close: closeBrowser };

  const captchas = [];
  const crawledPages = [];
  const pageTimings = [];
  let autoPassedAll = true;

  emit({
    type: "phase",
    phase: "started",
    websiteUrl: config.websiteUrl,
    searchName: config.searchName || "",
    pageCount,
    dwellMin, dwellMax,
    humanScroll: humanScrollOn,
    crawlPageInfo: crawlOn,
    imageSearch: Boolean(config.imageUrl),
  });

  const startedAt = Date.now();
  try {
    log(`打开网站: ${config.websiteUrl}`);
    await page.goto(config.websiteUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await sleep(1500);

    // 登录检测：若跳到登录页，轮询等待用户完成登录（最多 5 分钟），不直接进入采集
    const cur0 = page.url();
    if (/login|passport|signin|account\/login/i.test(cur0)) {
      log("⚠ 页面跳转到登录页，请在浏览器中完成登录（最多等待 5 分钟）…", "stderr");
      let waited = 0;
      while (waited < 300000) {
        await sleep(10000);
        waited += 10000;
        const cur = page.url();
        if (!/login|passport|signin|account\/login/i.test(cur)) { log(`✓ 登录完成 (${Math.round(waited/1000)}s) -> ${cur.slice(0, 80)}`); break; }
        if (waited % 15000 === 0) log(`  等待登录… ${Math.round(waited/1000)}s (当前: ${cur.slice(0, 60)})`);
      }
      // 登录后把最新 cookies 持久化，下次免登录
      try {
        const freshCookies = await (browserRef.context || context).cookies();
        if (freshCookies.length) { await writeFile(sessionCookiesPath, JSON.stringify(freshCookies, null, 2), "utf8"); log(`✓ 登录后已保存 ${freshCookies.length} 个 cookies 到本地`); }
      } catch {}
      // 登录等待超时后若仍在登录页 → 跳过验证码检测（登录页 NC slider 非独立验证码）
      if (/login|passport|signin|account\/login/i.test(page.url())) {
        log("⚠ 登录超时，仍在登录页，跳过验证码检测", "stderr");
      } else {
        // 登录完成，检测验证码
        { const r = await checkAndSolveCaptcha(page, 0, { runOutDir, mcp, captchas, log, headless, browserRef, chromium }); page = r.page; if (!r.passed) autoPassedAll = false; }
      }
    } else {
      // 非登录页，正常检测验证码
      { const r = await checkAndSolveCaptcha(page, 0, { runOutDir, mcp, captchas, log, headless, browserRef, chromium }); page = r.page; if (!r.passed) autoPassedAll = false; }
    }

    // 搜索：图搜优先，否则关键词
    if (config.imageUrl) {
      // server 已把 imageUrl 解析成绝对文件路径；兼容直接传 URL 路径的情况
      let imgPath = config.imageUrl;
      if (imgPath.startsWith("/images/")) imgPath = path.join(projectRoot, "images", decodeURIComponent(imgPath.replace(/^\/images\//, "")));
      else if (imgPath.startsWith("/uploads/")) imgPath = path.join(__dirname, "uploads", decodeURIComponent(imgPath.replace(/^\/uploads\//, "")));
      try { await access(imgPath); } catch { throw new Error(`图搜图片不存在: ${imgPath}`); }
      log("执行图搜上传");
      await stripTargetBlank(page);
      await imageSearch(page, imgPath, log);
      await sleep(2500);
      page = await switchToLatestTab(context, page);
      { const r = await checkAndSolveCaptcha(page, 0, { runOutDir, mcp, captchas, log, headless, browserRef, chromium }); page = r.page; if (!r.passed) autoPassedAll = false; }
    } else if (config.searchName) {
      log(`输入搜索关键词: ${config.searchName}`);
      await stripTargetBlank(page);
      await keywordSearch(page, config.searchName);
      await sleep(2500);
      page = await switchToLatestTab(context, page);
      { const r = await checkAndSolveCaptcha(page, 0, { runOutDir, mcp, captchas, log, headless, browserRef, chromium }); page = r.page; if (!r.passed) autoPassedAll = false; }
    }

    for (let i = 1; i <= pageCount; i += 1) {
      const pageStart = Date.now();
      emit({ type: "page", page: i, url: page.url() });
      // 实时写进度文件，供历史列表显示"当前第N页/共M页"
      try { await writeFile(path.join(runOutDir, "progress.json"), JSON.stringify({ currentPage: i, totalPages: pageCount, url: page.url(), at: new Date().toISOString() }), "utf8"); } catch {}
      const dwell = rand(dwellMin, dwellMax);
      log(`第 ${i}/${pageCount} 页 · 停留 ${dwell}ms`);

      // 验证码检测优先（同步等待解决，最多重试 5 次）
      const captchaRes = await checkAndSolveCaptcha(page, i, { runOutDir, mcp, captchas, log, headless, browserRef, chromium });
      page = captchaRes.page;
      if (!captchaRes.passed) {
        autoPassedAll = false;
        log("验证码未能解决，停止翻页", "stderr");
        break;
      }

      if (humanScrollOn) { await humanScroll(page, log); }

      if (crawlOn) {
        const info = await crawlPageInfo(page);
        if (info) { crawledPages.push({ page: i, ...info }); log(`爬取: ${info.title || info.url} · ${info.linkCount}链接/${info.imgCount}图`); }
      }

      await sleep(Math.max(0, dwell - (Date.now() - pageStart)));
      pageTimings.push(Date.now() - pageStart);

      if (i < pageCount) {
        log("翻到下一页");
        const ok = await gotoNextPage(page, log);
        page = await switchToLatestTab(context, page);
        if (!ok) { log("无法继续翻页，提前结束", "stderr"); break; }
        await sleep(rand(800, 1800));
      }
    }

    try {
      // 重连后 context 可能已失效，用 browserRef 里最新的；持久上下文用原 context
      const cookieCtx = (browserRef && browserRef.context) ? browserRef.context : context;
      const finalCookies = await cookieCtx.cookies();
      if (finalCookies.length) { await writeFile(sessionCookiesPath, JSON.stringify(finalCookies, null, 2), "utf8"); log(`已保存 ${finalCookies.length} 个 cookies 到本地 → ${sessionCookiesPath}`); }
    } catch (e) { log(`保存 cookies 失败(忽略): ${e.message}`, "stderr"); }

    const captchaTypes = {};
    for (const c of captchas) captchaTypes[c.label || c.type || "unknown"] = (captchaTypes[c.label || c.type || "unknown"] || 0) + 1;
    const avgDwell = pageTimings.length ? Math.round(pageTimings.reduce((a, b) => a + b, 0) / pageTimings.length) : 0;
    const result = {
      runId: path.basename(runOutDir),
      searchName: config.searchName || "",
      websiteUrl: config.websiteUrl,
      imageSearch: Boolean(config.imageUrl),
      pageCount: pageTimings.length,
      requestedPages: pageCount,
      pageTurnFrequency: `${pageTimings.length} 页 · 平均 ${(avgDwell / 1000).toFixed(1)}s/页`,
      avgDwellMs: avgDwell,
      dwellRange: `${dwellMin}-${dwellMax}ms`,
      humanScroll: humanScrollOn,
      humanOpType: humanScrollOn ? "上下滑动" : "无",
      crawlPageInfo: crawlOn,
      captchaCount: captchas.length,
      captchaTypes,
      captchas,
      autoPassed: captchas.length ? autoPassedAll : true,
      allPassedNoCaptcha: captchas.length === 0,
      crawledPages,
      pageTimings,
      costMs: Date.now() - startedAt,
      finishedAt: new Date().toISOString(),
    };
    await writeFile(path.join(runOutDir, "crawl-result.json"), JSON.stringify(result, null, 2), "utf8");
    const excelPath = await writeCrawlExcel(runOutDir, result);
    if (excelPath) log(`已导出 Excel → ${excelPath}`);
    emit({ type: "done", status: "done", result });
  } catch (e) {
    const captchaTypes = {};
    for (const c of captchas) captchaTypes[c.label || c.type || "unknown"] = (captchaTypes[c.label || c.type || "unknown"] || 0) + 1;
    const result = {
      runId: path.basename(runOutDir),
      searchName: config.searchName || "",
      websiteUrl: config.websiteUrl,
      imageSearch: Boolean(config.imageUrl),
      pageCount: pageTimings.length,
      requestedPages: pageCount,
      pageTurnFrequency: `${pageTimings.length} 页 · 平均 ${pageTimings.length ? (pageTimings.reduce((a, b) => a + b, 0) / pageTimings.length / 1000).toFixed(1) : 0}s/页`,
      humanScroll: humanScrollOn,
      humanOpType: humanScrollOn ? "上下滑动" : "无",
      crawlPageInfo: crawlOn,
      captchaCount: captchas.length,
      captchaTypes,
      captchas,
      autoPassed: captchas.length ? autoPassedAll : false,
      error: e.message,
      crawledPages,
      costMs: Date.now() - startedAt,
      finishedAt: new Date().toISOString(),
    };
    await writeFile(path.join(runOutDir, "crawl-result.json"), JSON.stringify(result, null, 2), "utf8");
    const excelPath2 = await writeCrawlExcel(runOutDir, result);
    if (excelPath2) log(`已导出 Excel → ${excelPath2}`);
    emit({ type: "done", status: "failed", error: e.message, result });
  } finally {
    // 共享 CDP 模式：断开连接不关浏览器；自带浏览器：关闭 context
    try {
      if (browserRef && browserRef.close) await browserRef.close();
      else await closeBrowser();
    } catch {}
  }
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--")) { args[a.slice(2)] = argv[i + 1]; i += 1; }
  }
  return args;
}
