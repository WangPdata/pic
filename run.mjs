#!/usr/bin/env node
import { access, chmod, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { fileURLToPath } from "node:url";

import {
  buildBatchItemsCsv,
  buildItemsCsv,
  buildComparisonReport,
  classifyImageSearchSubmitState,
  computeBatchPauseMs,
  constants,
  cookiesForPlaywrightFromCurl,
  curlFromCapturedRequest,
  diagnoseResponse,
  earlyCaptureWaitMsForMode,
  isSupportedImageFile,
  parseCurlText,
  summarizeResponse,
} from "./lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultOutDir = path.resolve(__dirname, "outputs");
const defaultProfileDir = path.resolve(__dirname, "profile");
const defaultSessionCookiesPath = path.resolve(__dirname, "session-cookies.json");
const searchUrl = "https://s.taobao.com/search?ie=utf8&search_type=item&tab=all";

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const outDir = path.resolve(args.out ?? defaultOutDir);
  const profileDir = path.resolve(args.profile ?? defaultProfileDir);
  const sessionCookiesPath = path.resolve(args["session-cookies"] ?? defaultSessionCookiesPath);
  const timeoutMs = Number(args.timeout ?? 180_000);
  const batchDelayMs = Number(args["batch-delay-ms"] ?? constants.DEFAULT_BATCH_DELAY_MS);
  const batchJitterMs = Number(args["batch-jitter-ms"] ?? constants.DEFAULT_BATCH_JITTER_MS);
  const headless = Boolean(args.headless);
  const keepBrowserOpen = Boolean(args["keep-browser-open"]);
  const verbose = Boolean(args.verbose);
  const log = createLogger(verbose);
  const input = await resolveInput(args);

  await mkdir(outDir, { recursive: true });
  await mkdir(profileDir, { recursive: true });

  let cookiesToInject = await loadInitialCookies({
    cookieFromCurlPath: args["cookie-from-curl"],
    sessionCookiesPath,
    log,
  });

  if (input.mode === "batch") {
    await runBatchImages({
      imagePaths: input.imagePaths,
      outDir,
      profileDir,
      sessionCookiesPath,
      cookiesToInject,
      timeoutMs,
      batchDelayMs,
      batchJitterMs,
      headless,
      keepBrowserOpen,
      log,
    });
    return;
  }

  const imagePath = input.imagePaths[0];
  const captured = await captureWithBrowser({
    imagePath,
    profileDir,
    cookiesToInject,
    outDir,
    timeoutMs,
    headless,
    keepBrowserOpen,
    interactiveOnFailure: true,
    earlyCaptureWaitMs: earlyCaptureWaitMsForMode("single"),
    log,
  });

  const curlText = curlFromCapturedRequest({
    url: captured.request.url,
    headers: captured.request.headers,
    postData: captured.request.postData,
  });
  const curlPath = path.join(outDir, "taobao-image-search-latest.curl.sh");
  const responsePath = path.join(outDir, "taobao-image-search-latest-response.json");
  const reportPath = path.join(outDir, "taobao-image-search-latest-report.md");
  const csvPath = path.join(outDir, "taobao-image-search-latest-items.csv");

  log("写入 curl / response / report / csv");
  await writeFile(curlPath, curlText, "utf8");
  await chmod(curlPath, 0o700);
  await writeFile(responsePath, captured.responseText, "utf8");
  if (captured.cookies?.length) {
    await saveSessionCookies(sessionCookiesPath, captured.cookies);
    log(`已更新 session cookies：${sessionCookiesPath}`);
  }

  const responseJson = parseResponseText(captured.responseText);

  const report = buildComparisonReport(responseJson, {
    title: "淘宝图搜同款比价结果",
  });
  const csv = buildItemsCsv(responseJson);
  await writeFile(reportPath, report, "utf8");
  await writeFile(csvPath, csv, "utf8");

  const parsedCurl = safeParseCurl(curlText);
  const diagnosis = diagnoseResponse(responseJson);

  console.log(`curl: ${curlPath}`);
  console.log(`response: ${responsePath}`);
  console.log(`report: ${reportPath}`);
  console.log(`items_csv: ${csvPath}`);
  console.log(`status: ${diagnosis.status} - ${diagnosis.reason}`);
  if (parsedCurl) {
    console.log(`sign_match: ${parsedCurl.signMatches}`);
    console.log(`imgFrom: ${parsedCurl.params.imgFrom ?? ""}`);
  }
  printTerminalSummary(responseJson);

  if (diagnosis.status !== "success") {
    if (!keepBrowserOpen && captured.closeBrowser && stdin.isTTY) {
      console.log("接口未成功，浏览器窗口暂时保留。处理完登录/验证或查看页面后按 Enter 关闭。");
      await waitForEnter("按 Enter 关闭浏览器：");
    }
    await maybeCloseBrowser(captured, keepBrowserOpen);
    process.exitCode = 2;
  } else {
    await maybeCloseBrowser(captured, keepBrowserOpen);
  }
}

async function runBatchImages({ imagePaths, outDir, profileDir, sessionCookiesPath, cookiesToInject, timeoutMs, batchDelayMs, batchJitterMs, headless, keepBrowserOpen, log }) {
  const batchCsvPath = path.join(outDir, "taobao-image-search-batch-items.csv");
  const batchDir = path.join(outDir, "taobao-image-search-batch");
  const results = [];
  let browser;

  await mkdir(batchDir, { recursive: true });
  console.log(`批量图片数: ${imagePaths.length}`);
  console.log(`batch_csv: ${batchCsvPath}`);
  console.log(`批量限速: 每张图后等待 ${batchDelayMs}-${batchDelayMs + batchJitterMs}ms，可用 --batch-delay-ms / --batch-jitter-ms 调整。`);
  if (keepBrowserOpen) {
    console.log("批量模式会复用同一个浏览器，并在整批结束后关闭，避免 profile 被锁住。");
  }

  try {
    browser = await openBrowser({ profileDir, cookiesToInject, headless, log });

    for (let index = 0; index < imagePaths.length; index += 1) {
      const imagePath = imagePaths[index];
      const baseName = `${String(index + 1).padStart(3, "0")}-${safeFileStem(path.basename(imagePath))}`;
      const curlPath = path.join(batchDir, `${baseName}.curl.sh`);
      const responsePath = path.join(batchDir, `${baseName}-response.json`);
      const reportPath = path.join(batchDir, `${baseName}-report.md`);

      console.log("");
      console.log(`[${index + 1}/${imagePaths.length}] ${imagePath}`);

      let shouldStopBatch = false;
      try {
        const captured = await captureWithOpenBrowser({
          context: browser.context,
          page: browser.page,
          imagePath,
          outDir,
          timeoutMs,
          headless,
          keepBrowserOpen: true,
          interactiveOnFailure: false,
          earlyCaptureWaitMs: earlyCaptureWaitMsForMode("batch"),
          log,
        });
        const curlText = curlFromCapturedRequest({
          url: captured.request.url,
          headers: captured.request.headers,
          postData: captured.request.postData,
        });
        const responseJson = parseResponseText(captured.responseText);
        const diagnosis = diagnoseResponse(responseJson);

        await writeFile(curlPath, curlText, "utf8");
        await chmod(curlPath, 0o700);
        await writeFile(responsePath, captured.responseText, "utf8");
        await writeFile(reportPath, buildComparisonReport(responseJson, {
          title: `淘宝图搜同款比价结果 - ${path.basename(imagePath)}`,
        }), "utf8");

        if (captured.cookies?.length) {
          cookiesToInject = captured.cookies;
          await saveSessionCookies(sessionCookiesPath, captured.cookies);
        }
        results.push({ imagePath, responseJson });

        const summary = summarizeResponse(responseJson);
        console.log(`状态: ${diagnosis.status} - ${diagnosis.reason}`);
        console.log(`商品数: ${summary.itemCount}，价格中位数: ${summary.price.median ?? "未知"}`);
        if (diagnosis.status === "blocked") {
          shouldStopBatch = true;
          console.log("检测到淘宝风控，已保存当前结果并停止剩余任务。建议等一段时间后用更大的 --batch-delay-ms 重跑。");
        }
      } catch (error) {
        const message = error?.message || String(error);
        results.push({
          imagePath,
          error: message,
          responseJson: {
            ret: ["CAPTURE_ERROR"],
            data: {},
          },
        });
        console.log(`状态: error - ${message}`);
      }

      await writeFile(batchCsvPath, buildBatchItemsCsv(results), "utf8");
      console.log(`已更新批量 CSV: ${batchCsvPath}`);
      if (shouldStopBatch) break;
      if (index < imagePaths.length - 1) {
        const pauseMs = computeBatchPauseMs({ delayMs: batchDelayMs, jitterMs: batchJitterMs });
        if (pauseMs > 0) {
          console.log(`防风控等待 ${Math.round(pauseMs / 1000)}s 后处理下一张...`);
          await delay(pauseMs);
        }
      }
    }
  } finally {
    if (browser?.context) {
      await browser.context.close();
    }
  }

  const successCount = results.filter((result) => diagnoseResponse(result.responseJson).status === "success" && !result.error).length;
  console.log("");
  console.log(`批量完成: ${successCount}/${imagePaths.length} 张成功`);
  console.log(`batch_csv: ${batchCsvPath}`);
  if (successCount !== imagePaths.length) process.exitCode = 2;
}

async function captureWithBrowser({ imagePath, profileDir, cookiesToInject, outDir, timeoutMs, headless, keepBrowserOpen, interactiveOnFailure, earlyCaptureWaitMs, log }) {
  const browser = await openBrowser({ profileDir, cookiesToInject, headless, log });

  try {
    const captured = await captureWithOpenBrowser({
      context: browser.context,
      page: browser.page,
      imagePath,
      outDir,
      timeoutMs,
      headless,
      keepBrowserOpen,
      interactiveOnFailure,
      earlyCaptureWaitMs,
      log,
    });
    captured.closeBrowser = () => browser.context.close();
    return captured;
  } catch (error) {
    if (!keepBrowserOpen) await browser.context.close();
    throw error;
  }
}

async function openBrowser({ profileDir, cookiesToInject, headless, log }) {
  const { chromium } = loadPlaywright();
  log("启动浏览器");
  const context = await launchPersistentContext(chromium, profileDir, headless);
  const page = context.pages()[0] ?? await context.newPage();

  if (cookiesToInject.length) {
    await context.addCookies(cookiesToInject);
    log(`注入 ${cookiesToInject.length} 个 cookies`);
  }

  return { context, page };
}

async function captureWithOpenBrowser({ context, page, imagePath, outDir, timeoutMs, headless, keepBrowserOpen, interactiveOnFailure, earlyCaptureWaitMs, log }) {
  try {
    log("开始监听淘宝图片搜索接口");
    const capturePromise = waitForTaobaoMtopResponse(context, timeoutMs);
    log("打开淘宝搜索页");
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await waitForSearchPageReady(page);

    log("上传图片");
    await prepareImageForSearch(page, imagePath, log);

    const earlyCapture = await waitForEarlyCapture(capturePromise, earlyCaptureWaitMs);
    if (earlyCapture) {
      earlyCapture.cookies = await context.cookies();
      log("图片上传后自动触发了搜索接口");
      return earlyCapture;
    }

    log("上传后暂未触发接口，尝试点击搜索/确认");
    await clickSearchSubmit(page, log);
    log("等待图片搜索接口返回");
    const captured = await capturePromise;
    captured.cookies = await context.cookies();
    log("已捕获图片搜索接口");
    return captured;
  } catch (error) {
    await saveFailureDebug(page, outDir, log);
    if (interactiveOnFailure && stdin.isTTY && !headless) {
      console.log("这次没有捕获到图搜接口，浏览器窗口先保留，方便检查登录、验证或页面状态。");
      await waitForEnter("看完后按 Enter 关闭浏览器：");
    }
    if (!keepBrowserOpen) await context.close();
    throw error;
  }
}

async function waitForSearchPageReady(page) {
  try {
    await page.locator('input[type="file"]').first().waitFor({ state: "attached", timeout: 5_000 });
  } catch {
    await page.waitForTimeout(1_000);
  }
}

async function resolveInput(args) {
  const imageArg = args.image ? path.resolve(args.image) : "";
  const imageDirArg = args["image-dir"] || args.folder ? path.resolve(args["image-dir"] ?? args.folder) : "";
  if (imageArg && imageDirArg) {
    throw new Error("Use either --image or --image-dir, not both");
  }
  if (!imageArg && !imageDirArg) {
    throw new Error("Missing --image /path/to/image or --image-dir /path/to/folder");
  }

  const target = imageDirArg || imageArg;
  const targetStat = await stat(target);
  if (targetStat.isDirectory()) {
    const imagePaths = await collectImageFiles(target, Boolean(args.recursive));
    if (!imagePaths.length) {
      throw new Error(`No supported image files found in ${target}`);
    }
    return { mode: "batch", imagePaths };
  }

  if (!isSupportedImageFile(target)) {
    throw new Error(`Unsupported image file: ${target}`);
  }
  await access(target);
  return { mode: "single", imagePaths: [target] };
}

async function collectImageFiles(dirPath, recursive) {
  const entries = await readdir(dirPath, { withFileTypes: true });
  const files = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"))) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (recursive && !entry.name.startsWith(".")) {
        files.push(...await collectImageFiles(fullPath, recursive));
      }
      continue;
    }
    if (entry.isFile() && isSupportedImageFile(fullPath)) {
      files.push(fullPath);
    }
  }

  return files;
}

function parseResponseText(responseText) {
  try {
    return JSON.parse(responseText);
  } catch {
    return {
      ret: ["NON_JSON_RESPONSE"],
      data: { preview: String(responseText).slice(0, 1000) },
    };
  }
}

function safeFileStem(filename) {
  const parsed = path.parse(filename);
  const stem = parsed.name || "image";
  return stem.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "image";
}

async function launchPersistentContext(chromium, profileDir, headless) {
  const options = {
    headless,
    viewport: { width: 1400, height: 1000 },
    locale: "zh-CN",
    acceptDownloads: true,
  };
  const attempts = [];

  if (process.env.TAOBAO_CHROME_EXECUTABLE) {
    try {
      return await chromium.launchPersistentContext(profileDir, {
        ...options,
        executablePath: process.env.TAOBAO_CHROME_EXECUTABLE,
      });
    } catch (error) {
      attempts.push(`TAOBAO_CHROME_EXECUTABLE failed: ${error.message}`);
    }
  }

  try {
    return await chromium.launchPersistentContext(profileDir, {
      ...options,
      channel: "chrome",
    });
  } catch (error) {
    attempts.push(`system Chrome failed: ${error.message}`);
  }

  try {
    return await chromium.launchPersistentContext(profileDir, options);
  } catch (error) {
    attempts.push(`Playwright Chromium failed: ${error.message}`);
  }

  throw new Error([
    "Cannot launch a browser.",
    "Install Google Chrome, set TAOBAO_CHROME_EXECUTABLE to a Chrome/Chromium executable, or run: npm run install-browser",
    "",
    attempts.join("\n\n"),
  ].join("\n"));
}

function waitForTaobaoMtopResponse(context, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for ${constants.API_NAME}`));
      }
    }, timeoutMs);

    context.on("response", async (response) => {
      if (settled) return;
      const request = response.request();
      const url = request.url();
      if (!url.includes(constants.API_NAME)) return;
      const postData = request.postData() ?? "";
      if (!isPictureSearchPost(url, postData)) return;

      settled = true;
      clearTimeout(timer);
      try {
        const headers = typeof request.allHeaders === "function"
          ? await request.allHeaders()
          : request.headers();
        if (!headers.cookie) {
          const cookies = await context.cookies(url);
          const cookieHeader = cookiesToHeader(cookies);
          if (cookieHeader) headers.cookie = cookieHeader;
        }
        resolve({
          request: {
            url,
            headers,
            postData,
          },
          responseStatus: response.status(),
          responseText: await response.text(),
        });
      } catch (error) {
        reject(error);
      }
    });
  });
}

function cookiesToHeader(cookies) {
  return cookies
    .filter((cookie) => cookie.name && typeof cookie.value === "string")
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

function isPictureSearchPost(url, postData) {
  if (!url.includes("/2.0/")) return false;
  if (!postData.includes("data=")) return false;
  try {
    const dataText = new URLSearchParams(postData).get("data");
    if (!dataText) return false;
    const data = JSON.parse(dataText);
    const params = JSON.parse(data.params ?? "{}");
    return params.m === "pc_picture_search" && typeof params.strimg === "string" && params.strimg.length > 1000;
  } catch {
    return false;
  }
}

async function tryUploadImage(page, imagePath, log) {
  const directInput = page.locator('input[type="file"]').first();
  if (await locatorExists(directInput)) {
    await directInput.setInputFiles(imagePath);
    log("已设置文件到上传控件");
    return true;
  }

  await clickLikelyImageSearchControl(page);
  await page.waitForTimeout(1_000);

  const revealedInput = page.locator('input[type="file"]').first();
  if (await locatorExists(revealedInput)) {
    await revealedInput.setInputFiles(imagePath);
    log("已设置文件到展开后的上传控件");
    return true;
  }

  return false;
}

async function prepareImageForSearch(page, imagePath, log) {
  const uploaded = await tryUploadImage(page, imagePath, log);
  if (!uploaded) {
    await promptForManualUpload(page, imagePath);
  }

  let state = await waitForImageSearchSubmitState(page, 8_000);
  if (state === "search-ready") return true;

  if (state === "stale-upload-with-preview" || state === "preview-without-submit") {
    log(`图片上传进入半完成状态：${state}，自动重开图搜弹窗`);
    await resetImageSearchPanel(page, log);
    const retried = await tryUploadImage(page, imagePath, log);
    if (!retried) {
      await promptForManualUpload(page, imagePath);
    }
    state = await waitForImageSearchSubmitState(page, 10_000);
    if (state === "search-ready") return true;
  }

  throw new Error(`Image uploaded but Taobao submit button is not ready: ${state}`);
}

async function waitForImageSearchSubmitState(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastState = "unknown";
  while (Date.now() < deadline) {
    lastState = await getImageSearchSubmitState(page);
    if (lastState === "search-ready" || lastState === "stale-upload-with-preview" || lastState === "preview-without-submit") {
      return lastState;
    }
    await page.waitForTimeout(250);
  }
  return lastState;
}

async function getImageSearchSubmitState(page) {
  const snapshot = await page.evaluate(() => {
    const button = document.querySelector("#image-search-upload-button");
    const preview = document.querySelector(".image-search-success-img, .image-search-success-img-wrapper img");
    return {
      text: button?.textContent || "",
      className: button?.className || "",
      hasPreview: Boolean(preview),
    };
  });
  return classifyImageSearchSubmitState(snapshot);
}

async function resetImageSearchPanel(page, log) {
  await closeImageSearchPanel(page, log);
  await page.waitForTimeout(500);
  await clickLikelyImageSearchControl(page);
  await page.waitForTimeout(800);
}

async function closeImageSearchPanel(page, log) {
  const selectors = [
    ".image-search-context-wrapper-active .back-button",
    ".image-search-context-wrapper-active [class*=close]",
    ".image-search-context-wrapper-active [aria-label*=关闭]",
    ".image-search-context-wrapper-active [aria-label*=close]",
  ];
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locatorExists(locator)) {
      try {
        await locator.click({ timeout: 1_000, force: true });
        log(`已关闭异常图搜弹窗：${selector}`);
        return true;
      } catch {
        // Try the next close control.
      }
    }
  }

  await page.keyboard.press("Escape");
  log("未找到明确关闭按钮，已尝试按 Escape");
  return true;
}

async function waitForEarlyCapture(capturePromise, waitMs) {
  const result = await Promise.race([
    capturePromise.then((capture) => ({ capture }), () => ({ capture: null })),
    delay(waitMs).then(() => ({ capture: null })),
  ]);
  return result.capture;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function clickSearchSubmit(page, log = () => {}) {
  await page.waitForTimeout(800);
  const selectors = [
    "#image-search-upload-button.upload-button-active",
    ".image-search-context-wrapper-active #image-search-upload-button.upload-button-active",
    ".image-search-success-wrapper-active .upload-button-active",
    'button:has-text("搜索")',
    'a:has-text("搜索")',
    'span:has-text("搜索")',
    'button:has-text("确认")',
    'button:has-text("提交")',
    'button:has-text("开始搜索")',
    '[class*="search"]:has-text("搜索")',
    '[class*="submit"]',
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locatorExists(locator)) {
      try {
        await locator.click({ timeout: 1_500, force: true });
        log(`已点击搜索候选：${selector}`);
        await page.waitForTimeout(500);
        return true;
      } catch {
        // Try the next candidate.
      }
    }
  }

  const clicked = await page.evaluate(() => {
    const pattern = /搜索|确认|提交|开始搜索|找同款/;
    const candidates = [...document.querySelectorAll("button,a,div,span")]
      .filter((element) => pattern.test((element.textContent || "").trim()))
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
    const target = candidates[0];
    if (target) {
      const clickable = target.closest("button,a,label,[role=button]") || target;
      clickable.click();
      return true;
    }
    return false;
  });
  if (clicked) {
    log("已通过页面文本点击搜索/确认");
    await page.waitForTimeout(500);
    return true;
  }

  try {
    await page.keyboard.press("Enter");
    log("未找到明确按钮，已尝试按 Enter");
    await page.waitForTimeout(500);
    return true;
  } catch {
    return false;
  }
}

async function saveFailureDebug(page, outDir, log) {
  try {
    const debugDir = path.join(outDir, "taobao-image-search-debug");
    await mkdir(debugDir, { recursive: true });
    const screenshotPath = path.join(debugDir, "latest-failure.png");
    const domPath = path.join(debugDir, "latest-visible-controls.json");
    await page.screenshot({ path: screenshotPath, fullPage: true });
    const controls = await page.evaluate(() => {
      return [...document.querySelectorAll("button,a,label,[role=button],input,span,div")]
        .map((element, index) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          const text = (
            element.innerText ||
            element.textContent ||
            element.getAttribute("aria-label") ||
            element.getAttribute("title") ||
            element.getAttribute("placeholder") ||
            ""
          ).replace(/\s+/g, " ").trim();
          return {
            index,
            tag: element.tagName,
            id: element.id,
            className: String(element.className || "").slice(0, 180),
            type: element.getAttribute("type"),
            role: element.getAttribute("role"),
            text: text.slice(0, 160),
            visible: rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden",
            rect: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            },
          };
        })
        .filter((control) => control.visible && (control.text || /search|image|upload|file|camera|submit|button/i.test(`${control.id} ${control.className} ${control.type}`)))
        .slice(0, 240);
    });
    await writeFile(domPath, JSON.stringify({
      url: page.url(),
      title: await page.title(),
      controls,
    }, null, 2), "utf8");
    log(`失败调试截图：${screenshotPath}`);
    log(`失败控件快照：${domPath}`);
  } catch (debugError) {
    log(`保存失败调试信息失败：${debugError.message}`);
  }
}

async function locatorExists(locator) {
  try {
    return (await locator.count()) > 0;
  } catch {
    return false;
  }
}

async function clickLikelyImageSearchControl(page) {
  const selectors = [
    '[aria-label*="图片"]',
    '[title*="图片"]',
    '[class*="image_search"]',
    '[class*="search_image"]',
    '[class*="imgsearch"]',
    '[class*="camera"]',
    'button:has-text("图片")',
    'a:has-text("图片")',
    'span:has-text("图片")',
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locatorExists(locator)) {
      try {
        await locator.click({ timeout: 1_500, force: true });
        return true;
      } catch {
        // Try the next selector.
      }
    }
  }

  return page.evaluate(() => {
    const pattern = /image_search|search_image|imgsearch|camera|图片|相机|拍照/i;
    const candidates = [...document.querySelectorAll("button,a,div,span,i,label")]
      .filter((element) => pattern.test(element.outerHTML.slice(0, 800)));
    const target = candidates[0];
    if (target) {
      target.click();
      return true;
    }
    return false;
  });
}

async function promptForManualUpload(page, imagePath) {
  const message = [
    "",
    "没有自动找到淘宝图片上传控件。",
    `请在打开的浏览器里手动上传这张图：${imagePath}`,
    "如果页面要求登录或验证，也请先完成。",
    "上传后工具会继续监听接口；回到终端按 Enter 继续等待。",
    "",
  ].join("\n");
  console.log(message);

  if (stdin.isTTY) {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    try {
      await rl.question("手动处理完成后按 Enter：");
    } finally {
      rl.close();
    }
  } else {
    await page.waitForTimeout(10_000);
  }
}

function loadPlaywright() {
  const require = createRequire(import.meta.url);
  const candidates = [
    process.env.TAOBAO_PLAYWRIGHT_MODULE,
    "playwright",
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {
      // Try the next candidate.
    }
  }

  throw new Error("Cannot load Playwright. Run ./setup.sh first, or install dependencies with npm install.");
}

function safeParseCurl(curlText) {
  try {
    return parseCurlText(curlText);
  } catch (error) {
    console.warn(`curl parse warning: ${error.message}`);
    return null;
  }
}

async function loadInitialCookies({ cookieFromCurlPath, sessionCookiesPath, log }) {
  if (cookieFromCurlPath) {
    const curlText = await readFile(path.resolve(cookieFromCurlPath), "utf8");
    const cookies = cookiesForPlaywrightFromCurl(curlText);
    await saveSessionCookies(sessionCookiesPath, cookies);
    log(`已从 curl 导入 ${cookies.length} 个 cookies`);
    return cookies;
  }

  try {
    const cookies = JSON.parse(await readFile(sessionCookiesPath, "utf8"));
    if (Array.isArray(cookies)) {
      log(`读取 session cookies：${sessionCookiesPath}`);
      return cookies;
    }
  } catch {
    // No saved session yet.
  }
  return [];
}

async function saveSessionCookies(sessionCookiesPath, cookies) {
  await mkdir(path.dirname(sessionCookiesPath), { recursive: true });
  await writeFile(sessionCookiesPath, JSON.stringify(cookies, null, 2), "utf8");
  await chmod(sessionCookiesPath, 0o600);
}

async function maybeCloseBrowser(captured, keepBrowserOpen) {
  if (keepBrowserOpen) {
    console.log("按 --keep-browser-open 要求保留浏览器窗口。结束进程时可手动关闭。");
    return;
  }
  if (captured.closeBrowser) {
    await captured.closeBrowser();
  }
}

function printTerminalSummary(responseJson) {
  const summary = summarizeResponse(responseJson);
  if (summary.status !== "success") return;
  console.log("");
  console.log(`商品数: ${summary.itemCount}`);
  console.log(`价格: 最低 ${summary.price.min} / 中位数 ${summary.price.median} / 最高 ${summary.price.max}`);
  console.log("优先看:");
  for (const item of summary.priorityItems.slice(0, 5)) {
    console.log(`- ¥${item.price} | ${item.title} | ${item.shop} | ${item.itemUrl}`);
  }
}

function createLogger(verbose) {
  return (message) => {
    const prefix = verbose ? `[${new Date().toLocaleTimeString("zh-CN", { hour12: false })}] ` : "";
    console.log(`${prefix}${message}`);
  };
}

async function waitForEnter(prompt) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    await rl.question(prompt);
  } finally {
    rl.close();
  }
}

function parseArgs(argv) {
  const args = {};
  const booleanFlags = new Set(["headless", "keep-browser-open", "recursive", "verbose", "help"]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg.startsWith("--") && booleanFlags.has(arg.slice(2))) {
      args[arg.slice(2)] = true;
    } else if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`Missing value for ${arg}`);
      }
      args[key] = value;
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage:
  ./taobao-image-search --image /path/to/image.png [--out outputs]
  ./taobao-image-search --image-dir /path/to/folder [--out outputs]
  node run.mjs --image /path/to/image.png
  node run.mjs --image-dir /path/to/folder

Options:
  --image     Single image to upload to Taobao image search.
  --image-dir Folder of images to search one by one and combine into one CSV.
  --folder    Alias for --image-dir.
  --recursive Include nested folders in --image-dir mode.
  --out       Output directory. Defaults to ${defaultOutDir}
  --profile   Persistent browser profile. Defaults to ${defaultProfileDir}
  --cookie-from-curl  Import fresh Taobao cookies from a copied curl text file.
  --session-cookies   Cookie cache path. Defaults to ${defaultSessionCookiesPath}
  --timeout   Wait time in milliseconds. Defaults to 180000.
  --batch-delay-ms   Batch delay after each image. Defaults to ${constants.DEFAULT_BATCH_DELAY_MS}.
  --batch-jitter-ms  Random extra batch delay. Defaults to ${constants.DEFAULT_BATCH_JITTER_MS}.
  --headless  Run browser headless. Not recommended for first login.
  --keep-browser-open Keep browser open after capture.
  --verbose   Print timestamped progress logs.
`);
}
