#!/usr/bin/env node
import http from "node:http";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, readdir, stat, access, unlink, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { summarizeResponse, diagnoseResponse, isSupportedImageFile } from "../lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const imagesDir = path.join(projectRoot, "images");
const runsDir = path.join(__dirname, "runs");
const crawlRunsDir = path.join(__dirname, "crawl-runs");
const sessionCookiesPath = path.join(projectRoot, "session-cookies.json");
const uploadsDir = path.join(__dirname, "uploads");
const PORT = Number(process.env.PORT) || 8787;
const crawlScript = path.join(__dirname, "crawl.mjs");

await mkdir(runsDir, { recursive: true });
await mkdir(crawlRunsDir, { recursive: true });
await mkdir(uploadsDir, { recursive: true });

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
};

function send(res, code, type, body) {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

function sendJson(res, code, obj) {
  send(res, code, "application/json; charset=utf-8", JSON.stringify(obj));
}

async function listImages() {
  try {
    const entries = await readdir(imagesDir, { withFileTypes: true });
    const files = entries
      .filter((e) => e.isFile() && isSupportedImageFile(e.name))
      .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"))
      .map((e) => ({ name: e.name, source: "images", url: `/images/${encodeURIComponent(e.name)}` }));
    return files;
  } catch {
    return [];
  }
}

async function listUploads() {
  try {
    const entries = await readdir(uploadsDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && isSupportedImageFile(e.name))
      .sort((a, b) => b.name.localeCompare(a.name))
      .map((e) => ({ name: e.name, source: "upload", url: `/uploads/${encodeURIComponent(e.name)}` }));
  } catch {
    return [];
  }
}

async function listRuns() {
  try {
    const entries = await readdir(runsDir, { withFileTypes: true });
    const runs = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = path.join(runsDir, e.name);
      const metaPath = path.join(dir, "run-meta.json");
      let meta = {};
      try { meta = JSON.parse(await readFile(metaPath, "utf8")); } catch {}
      const respPath = path.join(dir, "taobao-image-search-latest-response.json");
      let hasResult = false;
      try { await access(respPath); hasResult = true; } catch {}
      runs.push({
        runId: e.name,
        createdAt: meta.createdAt || e.name,
        imageName: meta.imageName || "",
        status: meta.status || (hasResult ? "done" : "unknown"),
        hasResult,
      });
    }
    runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return runs;
  } catch {
    return [];
  }
}

function priceStats(prices) {
  const sorted = [...prices].sort((a, b) => a - b);
  const n = sorted.length;
  if (!n) return { count: 0, min: null, max: null, median: null, average: null, std: null, cv: null, p25: null, p75: null, mainRange: null };
  const sum = sorted.reduce((a, b) => a + b, 0);
  const avg = sum / n;
  const variance = sorted.reduce((a, b) => a + (b - avg) ** 2, 0) / n;
  const std = Math.sqrt(variance);
  const pct = (p) => sorted[Math.min(n - 1, Math.floor((p / 100) * n))];
  const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  return {
    count: n,
    min: round2(sorted[0]),
    max: round2(sorted.at(-1)),
    median: round2(median),
    average: round2(avg),
    std: round2(std),
    cv: avg ? round2((std / avg) * 100) : null,
    p25: round2(pct(25)),
    p75: round2(pct(75)),
    mainRange: `¥${round2(pct(25))}-¥${round2(pct(75))}`,
  };
}

function round2(v) { return Math.round(v * 100) / 100; }

function topKeywords(rows, limit = 15) {
  const stop = new Set("的了和与及或就也都还又才再是被在到把给对从向往对于这那之等等我你他她它们个为以而但且如然则");
  const freq = new Map();
  for (const row of rows) {
    const text = row.title || "";
    const segs = text.match(/[\u4e00-\u9fa5]{2,}/g) || [];
    for (const seg of segs) {
      for (let i = 0; i + 1 < seg.length; i += 1) {
        const pair = seg.slice(i, i + 2);
        if (stop.has(pair[0]) || stop.has(pair[1])) continue;
        freq.set(pair, (freq.get(pair) || 0) + 1);
      }
    }
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([word, count]) => ({ word, count }));
}

function keywordHitRate(rows, keywordsRaw) {
  const keywords = String(keywordsRaw || "").split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
  if (!keywords.length) return { enabled: false, overall: null, top5: null, top10: null, matched: 0, total: rows.length, keywords: [] };
  const hit = (title) => keywords.some((kw) => title.includes(kw));
  const total = rows.length;
  const matched = rows.filter((r) => hit(r.title || "")).length;
  const top5 = rows.slice(0, 5);
  const top10 = rows.slice(0, 10);
  return {
    enabled: true,
    keywords,
    total,
    matched,
    overall: total ? round2((matched / total) * 100) : 0,
    top5: top5.length ? round2((top5.filter((r) => hit(r.title || "")).length / top5.length) * 100) : 0,
    top10: top10.length ? round2((top10.filter((r) => hit(r.title || "")).length / top10.length) * 100) : 0,
  };
}

function computeMetrics(responseJson, keywordsRaw) {
  const summary = summarizeResponse(responseJson);
  const rows = summary.rows || [];
  const prices = rows.map((r) => r.price).filter((p) => Number.isFinite(p));
  const ps = priceStats(prices);
  const freeShip = rows.filter((r) => (r.icons || []).some((i) => /包邮/.test(i))).length;
  const retGuard = rows.filter((r) => (r.icons || []).some((i) => /退货/.test(i))).length;
  const hasSales = rows.filter((r) => r.sales && !/^0人付款/.test(r.sales)).length;
  const top5Prices = rows.slice(0, 5).map((r) => r.price).filter((p) => Number.isFinite(p));
  const top5Stats = priceStats(top5Prices);
  const shopCounts = new Map();
  for (const r of rows) shopCounts.set(r.shop, (shopCounts.get(r.shop) || 0) + 1);
  const dupShops = [...shopCounts.entries()].filter(([, c]) => c > 1).sort((a, b) => b[1] - a[1]);
  return {
    status: summary.status,
    reason: summary.reason,
    itemCount: summary.itemCount,
    resultCount: summary.resultCount,
    costMs: summary.costMs,
    price: ps,
    freeShippingRate: rows.length ? round2((freeShip / rows.length) * 100) : 0,
    returnGuardRate: rows.length ? round2((retGuard / rows.length) * 100) : 0,
    hasSalesRate: rows.length ? round2((hasSales / rows.length) * 100) : 0,
    top5PriceCv: top5Stats.cv,
    priceBands: summary.price.bands,
    keywords: keywordHitRate(rows, keywordsRaw),
    topKeywords: topKeywords(rows),
    dupShops: dupShops.slice(0, 8).map(([shop, count]) => ({ shop, count })),
    locations: summary.locations,
    priorityItems: summary.priorityItems,
    cheapRisk: summary.cheapRiskItems,
    highRisk: summary.highRiskItems,
    rows,
  };
}

async function getResults(runId) {
  const dir = path.join(runsDir, runId);
  try { await access(dir); } catch { return null; }
  const respPath = path.join(dir, "taobao-image-search-latest-response.json");
  let responseJson = null;
  try { responseJson = JSON.parse(await readFile(respPath, "utf8")); } catch {}
  const metaPath = path.join(dir, "run-meta.json");
  let meta = {};
  try { meta = JSON.parse(await readFile(metaPath, "utf8")); } catch {}
  let report = "";
  try { report = await readFile(path.join(dir, "taobao-image-search-latest-report.md"), "utf8"); } catch {}
  let csv = "";
  try { csv = await readFile(path.join(dir, "taobao-image-search-latest-items.csv"), "utf8"); } catch {}
  const metrics = responseJson ? computeMetrics(responseJson, meta.keywords || "") : null;
  const originalImageUrl = meta.imagePath ? deriveOriginalImageUrl(meta.imagePath) : "";
  return { runId, meta: { ...meta, originalImageUrl }, responseJson: responseJson ? { ret: responseJson.ret, costMs: responseJson?.data?._cost ?? null } : null, metrics, report, csv };
}

function deriveOriginalImageUrl(imagePath) {
  const base = encodeURIComponent(path.basename(imagePath));
  if (imagePath.includes("images")) return "/images/" + base;
  if (imagePath.includes("uploads")) return "/uploads/" + base;
  return "";
}

async function getMarks(runId) {
  const marksPath = path.join(runsDir, runId, "marks.json");
  try {
    return JSON.parse(await readFile(marksPath, "utf8"));
  } catch {
    return { runId, marks: {}, updatedAt: null };
  }
}

async function saveMarks(runId, marks) {
  const dir = path.join(runsDir, runId);
  try { await access(dir); } catch { await mkdir(dir, { recursive: true }); }
  const data = { runId, marks: marks || {}, updatedAt: new Date().toISOString() };
  await writeFile(path.join(dir, "marks.json"), JSON.stringify(data, null, 2), "utf8");
  return data;
}

function parseCookieString(raw, domain) {
  const dom = (domain || ".taobao.com").trim();
  // 同时注入到主域和登录子域，确保 login.taobao.com 也有登录态
  const domains = dom.startsWith(".") ? [dom, dom.slice(1), "login." + dom.slice(1)] : [dom, "." + dom, "login." + dom];
  const uniqDomains = [...new Set(domains)];
  return String(raw || "").split(";").map((p) => p.trim()).filter(Boolean).flatMap((pair) => {
    const idx = pair.indexOf("=");
    if (idx === -1) return [];
    const item = {
      name: pair.slice(0, idx),
      value: pair.slice(idx + 1),
      path: "/",
      secure: true,
      httpOnly: false,
      sameSite: "Lax",
    };
    return uniqDomains.map((d) => ({ ...item, domain: d }));
  });
}

async function importCookies(cookieString, domain) {
  const cookies = parseCookieString(cookieString, domain);
  if (!cookies.length) throw new Error("cookie 字符串解析出 0 条，请检查格式");
  try {
    const bak = await readFile(sessionCookiesPath, "utf8");
    await writeFile(sessionCookiesPath + ".bak." + Date.now(), bak, "utf8");
  } catch {}
  await writeFile(sessionCookiesPath, JSON.stringify(cookies, null, 2), "utf8");
  try { await (await import("node:fs/promises")).chmod(sessionCookiesPath, 0o600); } catch {}
  const names = cookies.map((c) => c.name);
  const must = ["_m_h5_tk", "cookie2", "t", "unb", "_tb_token_", "cna"];
  const missing = domain ? [] : must.filter((k) => !names.includes(k));
  return { count: cookies.length, names, missing };
}

async function deleteRun(runId) {
  if (!runId || /[\/]/.test(runId) || runId.includes("..")) {
    throw new Error("invalid runId");
  }
  const dir = path.join(runsDir, runId);
  try { await access(dir); } catch { return { runId, deleted: false, reason: "not found" }; }
  await rm(dir, { recursive: true, force: true });
  return { runId, deleted: true };
}

async function listCrawlRuns() {
  try {
    const entries = await readdir(crawlRunsDir, { withFileTypes: true });
    const runs = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = path.join(crawlRunsDir, e.name);
      let result = null;
      try { result = JSON.parse(await readFile(path.join(dir, "crawl-result.json"), "utf8")); } catch {}
      const meta = result ? {
        runId: e.name,
        searchName: result.searchName || "",
        websiteUrl: result.websiteUrl || "",
        pageCount: result.pageCount || 0,
        captchaCount: result.captchaCount || 0,
        autoPassed: result.autoPassed,
        status: result.error ? "failed" : "done",
        costMs: result.costMs || 0,
        finishedAt: result.finishedAt || "",
      } : { runId: e.name, status: "running", searchName: "", websiteUrl: "", pageCount: 0, captchaCount: 0, autoPassed: null, costMs: 0, finishedAt: "" };
      runs.push({ ...meta, hasResult: Boolean(result) });
    }
    runs.sort((a, b) => (b.finishedAt || b.runId).localeCompare(a.finishedAt || a.runId));
    return runs;
  } catch { return []; }
}

async function getCrawlResults(runId) {
  if (!runId || /[\/]/.test(runId) || runId.includes("..")) return null;
  const dir = path.join(crawlRunsDir, runId);
  try { await access(dir); } catch { return null; }
  try { return JSON.parse(await readFile(path.join(dir, "crawl-result.json"), "utf8")); }
  catch { return { runId, status: "running" }; }
}

async function deleteCrawlRun(runId) {
  if (!runId || /[\/]/.test(runId) || runId.includes("..")) {
    throw new Error("invalid runId");
  }
  const dir = path.join(crawlRunsDir, runId);
  try { await access(dir); } catch { return { runId, deleted: false, reason: "not found" }; }
  await rm(dir, { recursive: true, force: true });
  return { runId, deleted: true };
}

async function handleCrawlRun(req, res, body) {
  let payload;
  try { payload = JSON.parse(body); } catch { return sendJson(res, 400, { error: "invalid json" }); }
  const { websiteUrl, searchName, imageUrl, pageCount, dwellMinMs, dwellMaxMs, humanScroll, crawlPageInfo, headless, timeout, keepBrowserOpen } = payload;
  if (!websiteUrl || !/^https?:\/\//i.test(websiteUrl)) {
    return sendJson(res, 400, { error: "请输入有效的网站链接 (http/https)" });
  }

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const runOutDir = path.join(crawlRunsDir, runId);
  await mkdir(runOutDir, { recursive: true });

  let imagePath = "";
  if (imageUrl) {
    if (imageUrl.startsWith("/images/")) imagePath = path.join(imagesDir, decodeURIComponent(imageUrl.replace(/^\/images\//, "")));
    else if (imageUrl.startsWith("/uploads/")) imagePath = path.join(uploadsDir, decodeURIComponent(imageUrl.replace(/^\/uploads\//, "")));
    else imagePath = path.resolve(imageUrl);
    try { await access(imagePath); } catch { return sendJson(res, 400, { error: "图搜图片不存在: " + imagePath }); }
  }

  const config = {
    websiteUrl, searchName: searchName || "",
    imageUrl: imagePath || "",
    pageCount: Math.max(1, Number(pageCount) || 1),
    dwellMinMs: Math.max(800, Number(dwellMinMs) || 1000),
    dwellMaxMs: Math.max(Number(dwellMinMs) || 1000, Number(dwellMaxMs) || 3000),
    humanScroll: Boolean(humanScroll),
    crawlPageInfo: Boolean(crawlPageInfo),
    headless: Boolean(headless),
    timeout: Number(timeout) || 300000,
    keepBrowserOpen: Boolean(keepBrowserOpen),
    profileDir: path.join(projectRoot, "profile"),
    sessionCookiesPath,
    mcpServerUrl: process.env.MCP_SERVER_URL || "http://127.0.0.1:9000/mcp",
    cdpEndpoint: process.env.CDP_ENDPOINT || "http://127.0.0.1:19222",
    mcpPython: process.env.MCP_PYTHON || "/opt/anaconda3/envs/yolo/bin/python",
    mcpClientScript: process.env.MCP_CLIENT_SCRIPT || path.join(__dirname, "mcp_client.py"),
    cdpDebugPort: process.env.CDP_DEBUG_PORT || 9222,
  };
  const configPath = path.join(runOutDir, "crawl-config.json");
  await writeFile(configPath, JSON.stringify(config, null, 2), "utf8");

  const args = ["--config", configPath, "--out", runOutDir];
  const child = spawn("node", [crawlScript, ...args], { cwd: projectRoot });

  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
  const writeLine = (obj) => res.write(JSON.stringify(obj) + "\n");
  writeLine({ type: "start", runId, websiteUrl, searchName: searchName || "", pageCount: config.pageCount });

  let stdoutBuf = "";
  child.stdout.on("data", (chunk) => {
    stdoutBuf += chunk.toString();
    const lines = stdoutBuf.split(/\r?\n/);
    stdoutBuf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try { const ev = JSON.parse(line); writeLine(ev); }
      catch { writeLine({ type: "log", line, stream: "stdout" }); }
    }
  });
  let stderrBuf = "";
  child.stderr.on("data", (chunk) => {
    stderrBuf += chunk.toString();
    const lines = stderrBuf.split(/\r?\n/);
    stderrBuf = lines.pop();
    for (const line of lines) writeLine({ type: "log", line, stream: "stderr" });
  });

  child.on("close", async () => {
    const results = await getCrawlResults(runId);
    writeLine({ type: "done", runId, status: results?.error ? "failed" : "done", result: results });
    res.end();
  });
}


function buildRunArgs({ imagePath, runOutDir, params }) {
  const args = ["--image", imagePath, "--out", runOutDir];
  if (params.headless) args.push("--headless");
  if (params.verbose) args.push("--verbose");
  if (params["keep-browser-open"]) args.push("--keep-browser-open");
  if (params.timeout) args.push("--timeout", String(params.timeout));
  return args;
}

async function handleRun(req, res, body) {
  let payload;
  try { payload = JSON.parse(body); } catch { return sendJson(res, 400, { error: "invalid json" }); }
  const { imageUrl, imageName, params = {}, keywords = "" } = payload;
  let imagePath = "";
  if (imageUrl && imageUrl.startsWith("/images/")) {
    imagePath = path.join(imagesDir, decodeURIComponent(imageUrl.replace(/^\/images\//, "")));
  } else if (imageUrl && imageUrl.startsWith("/uploads/")) {
    imagePath = path.join(uploadsDir, decodeURIComponent(imageUrl.replace(/^\/uploads\//, "")));
  } else if (imageName) {
    imagePath = path.join(imagesDir, imageName);
  }
  try { await access(imagePath); } catch { return sendJson(res, 400, { error: "image not found: " + imagePath }); }

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const runOutDir = path.join(runsDir, runId);
  await mkdir(runOutDir, { recursive: true });
  const meta = { runId, createdAt: runId, imageName: path.basename(imagePath), imagePath, keywords, params, status: "running" };
  await writeFile(path.join(runOutDir, "run-meta.json"), JSON.stringify(meta, null, 2));

  const args = buildRunArgs({ imagePath, runOutDir, params });
  const child = spawn("node", [path.join(projectRoot, "run.mjs"), ...args], { cwd: projectRoot });

  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });

  const writeLine = (obj) => res.write(JSON.stringify(obj) + "\n");
  writeLine({ type: "start", runId, imagePath, args });

  let stdoutBuf = "";
  child.stdout.on("data", (chunk) => {
    stdoutBuf += chunk.toString();
    const lines = stdoutBuf.split(/\r?\n/);
    stdoutBuf = lines.pop();
    for (const line of lines) writeLine({ type: "log", line });
  });
  let stderrBuf = "";
  child.stderr.on("data", (chunk) => {
    stderrBuf += chunk.toString();
    const lines = stderrBuf.split(/\r?\n/);
    stderrBuf = lines.pop();
    for (const line of lines) writeLine({ type: "log", line, stream: "stderr" });
  });

  child.on("close", async (code) => {
    meta.status = code === 0 ? "done" : "failed";
    meta.exitCode = code;
    await writeFile(path.join(runOutDir, "run-meta.json"), JSON.stringify(meta, null, 2));
    const results = await getResults(runId);
    writeLine({ type: "done", runId, exitCode: code, status: meta.status, metrics: results?.metrics || null, hasResult: Boolean(results?.metrics) });
    res.end();
  });
}

async function handleUpload(req, res, body) {
  let payload;
  try { payload = JSON.parse(body); } catch { return sendJson(res, 400, { error: "invalid json" }); }
  const { name, dataUrl } = payload;
  if (!dataUrl || !name) return sendJson(res, 400, { error: "missing dataUrl or name" });
  const match = String(dataUrl).match(/^data:(.+);base64,(.+)$/);
  if (!match) return sendJson(res, 400, { error: "invalid dataUrl" });
  const ext = path.extname(name).toLowerCase();
  if (!isSupportedImageFile(name)) return sendJson(res, 400, { error: "unsupported file type" });
  const safeName = `upload-${Date.now()}${ext}`;
  const filePath = path.join(uploadsDir, safeName);
  await writeFile(filePath, Buffer.from(match[2], "base64"));
  sendJson(res, 200, { name: safeName, url: `/uploads/${encodeURIComponent(safeName)}` });
}

async function serveStatic(req, res, urlPath) {
  let filePath;
  if (urlPath === "/" || urlPath === "/index.html") {
    filePath = path.join(__dirname, "index.html");
  } else if (urlPath.startsWith("/images/")) {
    filePath = path.join(imagesDir, decodeURIComponent(urlPath.replace(/^\/images\//, "")));
  } else if (urlPath.startsWith("/uploads/")) {
    filePath = path.join(uploadsDir, decodeURIComponent(urlPath.replace(/^\/uploads\//, "")));
  } else if (urlPath === "/batch.html" || urlPath === "/analyze.html") {
    filePath = path.join(__dirname, urlPath.slice(1));
  } else if (urlPath === "/crawl.html") {
    filePath = path.join(__dirname, "crawl.html");
  } else {
    return send(res, 404, "text/plain", "not found");
  }
  try {
    const data = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    send(res, 200, MIME[ext] || "application/octet-stream", data);
  } catch {
    send(res, 404, "text/plain", "not found");
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  try {
    if (p === "/api/images") return sendJson(res, 200, { images: await listImages(), uploads: await listUploads() });
    if (p === "/api/runs") return sendJson(res, 200, { runs: await listRuns() });
    if (p === "/api/results" && url.searchParams.get("runId")) {
      const r = await getResults(url.searchParams.get("runId"));
      return r ? sendJson(res, 200, r) : sendJson(res, 404, { error: "run not found" });
    }
    if (p === "/api/marks" && req.method === "GET" && url.searchParams.get("runId")) {
      return sendJson(res, 200, await getMarks(url.searchParams.get("runId")));
    }
    if (p === "/api/marks" && req.method === "POST") {
      let payload;
      try { payload = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: "invalid json" }); }
      const runId = url.searchParams.get("runId") || payload.runId;
      if (!runId) return sendJson(res, 400, { error: "missing runId" });
      return sendJson(res, 200, await saveMarks(runId, payload.marks));
    }
    if (p === "/api/upload" && req.method === "POST") return handleUpload(req, res, await readBody(req));
    if (p === "/api/run" && req.method === "POST") return handleRun(req, res, await readBody(req));
    if (p === "/api/crawl-runs") return sendJson(res, 200, { runs: await listCrawlRuns() });
    if (p === "/api/mcp-config") {
      const mcpServerUrl = process.env.MCP_SERVER_URL || "http://127.0.0.1:9000/mcp";
      return sendJson(res, 200, {
        enabled: Boolean(mcpServerUrl),
        mcpServerUrl,
        cdpEndpoint: process.env.CDP_ENDPOINT || "",
        mcpPython: process.env.MCP_PYTHON || "/opt/anaconda3/envs/yolo/bin/python",
        mcpClientScript: process.env.MCP_CLIENT_SCRIPT || path.join(__dirname, "mcp_client.py"),
        cdpDebugPort: process.env.CDP_DEBUG_PORT || 9222,
      });
    }
    if (p === "/api/crawl-results" && url.searchParams.get("runId")) {
      const r = await getCrawlResults(url.searchParams.get("runId"));
      return r ? sendJson(res, 200, r) : sendJson(res, 404, { error: "run not found" });
    }
    if (p === "/api/crawl" && req.method === "POST") return handleCrawlRun(req, res, await readBody(req));
    if (p.startsWith("/api/crawl-runs/") && req.method === "DELETE") {
      const runId = decodeURIComponent(p.replace(/^\/api\/crawl-runs\//, ""));
      try { return sendJson(res, 200, await deleteCrawlRun(runId)); }
      catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
    if (p === "/api/cookies" && req.method === "POST") {
      let payload;
      try { payload = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: "invalid json" }); }
      try { return sendJson(res, 200, await importCookies(payload.cookie || "", payload.domain)); }
      catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
    if (p === "/api/cookies" && req.method === "GET") {
      try {
        const raw = await readFile(sessionCookiesPath, "utf8");
        const arr = JSON.parse(raw);
        const names = (Array.isArray(arr) ? arr : []).map((c) => c.name);
        const must = ["_m_h5_tk", "cookie2", "t", "unb", "_tb_token_", "cna"];
        return sendJson(res, 200, { count: arr.length, names, missing: must.filter((k) => !names.includes(k)), saved: arr.length > 0 });
      } catch { return sendJson(res, 200, { count: 0, names: [], missing: [], saved: false }); }
    }
    if (p.startsWith("/api/runs/") && req.method === "DELETE") {
      const runId = decodeURIComponent(p.replace(/^\/api\/runs\//, ""));
      try { return sendJson(res, 200, await deleteRun(runId)); }
      catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
    if (req.method === "GET") return serveStatic(req, res, p);
    sendJson(res, 404, { error: "not found" });
  } catch (err) {
    sendJson(res, 500, { error: err?.message || String(err) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`淘宝图搜测试台已启动: http://localhost:${PORT}`);
  console.log(`项目根目录: ${projectRoot}`);
});
