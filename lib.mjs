import { createHash } from "node:crypto";

const API_NAME = "mtop.relationrecommend.wirelessrecommend.recommend";
const supportedImageExtensions = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".heic", ".heif"]);
const DEFAULT_BATCH_DELAY_MS = 12_000;
const DEFAULT_BATCH_JITTER_MS = 8_000;

export function parseCurlText(text) {
  const tokens = shellSplitFromCurl(text);
  const curlIndex = tokens.indexOf("curl");
  if (curlIndex === -1 || !tokens[curlIndex + 1]) {
    throw new Error("No curl command found");
  }

  const url = decodeAnsiEscapes(tokens[curlIndex + 1]);
  const headers = {};
  let cookie = "";
  let rawBody = "";

  for (let i = curlIndex + 2; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "-H" || token === "--header") {
      const header = tokens[i + 1] ?? "";
      const splitAt = header.indexOf(":");
      if (splitAt !== -1) {
        headers[header.slice(0, splitAt).toLowerCase()] = header.slice(splitAt + 1).trim();
      }
      i += 1;
    } else if (token === "-b" || token === "--cookie") {
      cookie = tokens[i + 1] ?? "";
      i += 1;
    } else if (token === "--data-raw" || token === "--data" || token === "--data-binary") {
      rawBody = tokens[i + 1] ?? "";
      i += 1;
    }
  }

  const parsedUrl = new URL(url);
  const query = Object.fromEntries(parsedUrl.searchParams.entries());
  const bodyParams = new URLSearchParams(rawBody);
  const data = bodyParams.get("data") ?? "";
  const dataObject = data ? JSON.parse(data) : {};
  const params = dataObject.params ? JSON.parse(dataObject.params) : {};
  const cookies = parseCookieHeader(cookie);
  const token = (cookies._m_h5_tk ?? "").split("_")[0];
  const expectedSign = token && query.t && query.appKey && data
    ? md5(`${token}&${query.t}&${query.appKey}&${data}`)
    : "";

  return {
    api: query.api,
    url,
    query,
    headers,
    cookie,
    cookies,
    rawBody,
    data,
    dataObject,
    params,
    expectedSign,
    signMatches: Boolean(expectedSign && query.sign === expectedSign),
  };
}

export function diagnoseResponse(responseJson) {
  const ret = Array.isArray(responseJson?.ret) ? responseJson.ret.join(" | ") : String(responseJson?.ret ?? "");
  const url = String(responseJson?.data?.url ?? "");
  const text = `${ret} ${url}`;

  if (/RGV587|punish|deny|bixi|验证码|验证|风控|FAIL_SYS_TOKEN|TOKEN_EXPIRED|TOKEN_EXOIRED/i.test(text)) {
    return {
      status: "blocked",
      reason: `淘宝风控或登录态拦截：${ret || url}`,
    };
  }

  if (/SUCCESS/.test(ret)) {
    return { status: "success", reason: ret };
  }

  return {
    status: "error",
    reason: ret || "接口没有返回 SUCCESS，也没有可识别的风控标记",
  };
}

export function summarizeResponse(responseJson) {
  const diagnosis = diagnoseResponse(responseJson);
  const data = responseJson?.data ?? {};
  const items = Array.isArray(data.itemsArray) ? data.itemsArray : [];
  const rows = items.map(normalizeItem);
  const prices = rows.map((item) => item.price).filter((price) => Number.isFinite(price));
  const sortedPrices = [...prices].sort((a, b) => a - b);

  return {
    status: diagnosis.status,
    reason: diagnosis.reason,
    itemCount: items.length,
    resultCount: Array.isArray(data.result) ? data.result.length : 0,
    costMs: typeof data._cost === "number" ? data._cost : null,
    hasInfinite: Boolean(data.cardStyle?.hasInfinite),
    price: {
      count: prices.length,
      min: sortedPrices[0] ?? null,
      max: sortedPrices.at(-1) ?? null,
      median: median(sortedPrices),
      average: prices.length ? round2(prices.reduce((sum, price) => sum + price, 0) / prices.length) : null,
      bands: priceBands(prices),
    },
    priorityItems: pickPriorityItems(rows),
    cheapRiskItems: rows
      .filter((item) => Number.isFinite(item.price) && item.price < 20)
      .sort((a, b) => a.price - b.price)
      .slice(0, 8),
    highRiskItems: rows
      .filter((item) => Number.isFinite(item.price) && item.price >= 500)
      .sort((a, b) => b.price - a.price)
      .slice(0, 6),
    shops: topCounts(rows.map((item) => item.shop).filter(Boolean), 8),
    locations: topCounts(rows.map((item) => item.location).filter(Boolean), 8),
    rows,
  };
}

export function cookiesForPlaywrightFromCurl(curlText) {
  const parsed = parseCurlText(curlText);
  return cookiesForPlaywright(parsed.cookies);
}

export function cookiesForPlaywright(cookieMap) {
  return Object.entries(cookieMap)
    .filter(([name, value]) => name && typeof value === "string")
    .map(([name, value]) => ({
      name,
      value,
      domain: ".taobao.com",
      path: "/",
      secure: true,
      httpOnly: false,
      sameSite: "Lax",
    }));
}

export function normalizeTaobaoUrl(value) {
  if (!value) return "";
  if (value.startsWith("//")) return `https:${value}`;
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith("/")) return `https://s.taobao.com${value}`;
  return value;
}

export function isSupportedImageFile(filePath) {
  const filename = String(filePath ?? "").split(/[\\/]/).at(-1) ?? "";
  if (!filename || filename.startsWith(".")) return false;
  const dotAt = filename.lastIndexOf(".");
  if (dotAt === -1) return false;
  return supportedImageExtensions.has(filename.slice(dotAt).toLowerCase());
}

export function earlyCaptureWaitMsForMode(mode) {
  return mode === "batch" ? 500 : 5_000;
}

export function classifyImageSearchSubmitState({ text = "", className = "", hasPreview = false } = {}) {
  const normalizedText = String(text).replace(/\s+/g, "").trim();
  const normalizedClass = String(className);
  if (normalizedText.includes("搜索") || /upload-button-active/.test(normalizedClass)) {
    return "search-ready";
  }
  if (hasPreview && normalizedText.includes("上传图片")) {
    return "stale-upload-with-preview";
  }
  if (normalizedText.includes("上传图片")) {
    return "upload-empty";
  }
  if (hasPreview) {
    return "preview-without-submit";
  }
  return "unknown";
}

export function computeBatchPauseMs({ delayMs = DEFAULT_BATCH_DELAY_MS, jitterMs = DEFAULT_BATCH_JITTER_MS, randomValue = Math.random() } = {}) {
  const delay = Math.max(0, Number.isFinite(Number(delayMs)) ? Number(delayMs) : DEFAULT_BATCH_DELAY_MS);
  const jitter = Math.max(0, Number.isFinite(Number(jitterMs)) ? Number(jitterMs) : DEFAULT_BATCH_JITTER_MS);
  const random = Math.min(1, Math.max(0, Number.isFinite(Number(randomValue)) ? Number(randomValue) : 0));
  return Math.round(delay + jitter * random);
}

export function buildComparisonReport(responseJson, options = {}) {
  const summary = summarizeResponse(responseJson);
  const title = options.title ?? "图搜同款比价结果";

  if (summary.status !== "success") {
    return [
      `# ${title}`,
      "",
      "## 调用结果",
      summary.reason,
      "",
      "这不是无结果，而是请求态、登录态或风控拦截。需要用浏览器重新生成完整请求态后再调用。",
      "",
    ].join("\n");
  }

  const mainRange = inferMainRange(summary.rows);
  const first = summary.priorityItems[0];
  const lines = [
    `# ${title}`,
    "",
    "## 一眼结论",
    `这次图搜返回 ${summary.itemCount} 条有效商品，真正结果在 \`itemsArray\`，不是空的 \`result\`。价格中位数约 ${formatMoney(summary.price.median)}，最低 ${formatMoney(summary.price.min)}，最高 ${formatMoney(summary.price.max)}。主流可比价区间集中在 ${mainRange}。`,
  ];

  if (first) {
    lines.push(`最值得先看的是「${first.title}」，${formatMoney(first.price)}，${first.shop || "未知店铺"}，${first.sales || "销量未知"}。`);
  }

  lines.push(
    "",
    "## 优先看",
    "| 判断 | 商品 | 价格 | 店铺/销量 | 理由 |",
    "|---|---:|---:|---|---|",
  );

  for (const item of summary.priorityItems.slice(0, 8)) {
    lines.push(`| ${item.bucket} | ${escapeTable(item.title)} | ${formatMoney(item.price)} | ${escapeTable(compactShop(item))} | ${escapeTable(item.reason || "标题/价格/销量综合更适合先比")} |`);
  }

  lines.push("", "## 低价避坑");
  if (summary.cheapRiskItems.length === 0) {
    lines.push("- 暂无明显低价异常项。");
  } else {
    for (const item of summary.cheapRiskItems.slice(0, 6)) {
      lines.push(`- ${formatMoney(item.price)}｜${item.title}｜${item.shop || "未知店铺"}：${item.reason || "低价需要核验是否同款、是否整表、是否有售后"}`);
    }
  }

  lines.push("", "## 高价/不相关剔除");
  if (summary.highRiskItems.length === 0) {
    lines.push("- 暂无明显高价或不相关项。");
  } else {
    for (const item of summary.highRiskItems.slice(0, 5)) {
      lines.push(`- ${formatMoney(item.price)}｜${item.title}｜${item.shop || "未知店铺"}：${item.reason || "价格明显偏离主流区间，建议单独核验"}`);
    }
  }

  lines.push(
    "",
    "## 用户决策建议",
    "- 想找最像原图：先看排名靠前、标题命中原图风格、且有付款人数的款。",
    "- 想省钱：看主流价格区间内的低价项，优先保留包邮、退货宝、店铺年限或付款人数更好的商品。",
    "- 想捡超低价：低于主流区间很多的结果单独放进风险区，不直接推荐。",
    "- 想做产品展示：默认按“最像/性价比/低价风险/高价剔除”四组展示，别按最低价一刀切。",
    "",
    "## 本次处理说明",
    `- 接口状态：${summary.reason}`,
    `- 服务端耗时：${summary.costMs == null ? "未知" : `${round2(summary.costMs)}ms`}`,
    "- 报告已隐藏登录凭据、用户标识、链路追踪、实验桶和埋点日志。",
    "",
    "## 全量商品",
    "| # | 商品 | 价格 | 店铺 | 销量 | 发货地 | 标签/服务 | 判断 | 商品链接 | 店铺链接 | 图片 |",
    "|---:|---|---:|---|---|---|---|---|---|---|---|",
    "",
  );

  for (const item of summary.rows) {
    lines.push([
      item.rank,
      escapeTable(item.title),
      formatMoney(item.price),
      escapeTable(item.shop),
      escapeTable(item.sales),
      escapeTable(item.location),
      escapeTable(item.icons.join("、")),
      escapeTable(item.reason || item.bucket),
      markdownLink("商品", item.itemUrl),
      markdownLink("店铺", item.shopUrl),
      markdownLink("图片", item.imageUrl),
    ].join(" | ").replace(/^/, "| ").replace(/$/, " |"));
  }

  return lines.join("\n");
}

export function buildItemsCsv(responseJson) {
  const summary = summarizeResponse(responseJson);
  const headers = ["序号", "商品标题", "价格", "店铺", "销量", "发货地", "标签/服务", "判断", "商品链接", "店铺链接", "图片链接"];
  const rows = summary.rows.map((item) => [
    item.rank,
    item.title,
    Number.isFinite(item.price) ? item.price : "",
    item.shop,
    item.sales,
    item.location,
    item.icons.join("、"),
    item.reason || item.bucket,
    item.itemUrl,
    item.shopUrl,
    item.imageUrl,
  ]);
  return [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\n") + "\n";
}

export function buildBatchItemsCsv(results) {
  const headers = [
    "图片序号",
    "图片文件名",
    "图片路径",
    "调用状态",
    "调用原因",
    "商品序号",
    "商品标题",
    "价格",
    "店铺",
    "销量",
    "发货地",
    "标签/服务",
    "判断",
    "商品链接",
    "店铺链接",
    "图片链接",
  ];
  const rows = [];

  for (const [imageIndex, result] of results.entries()) {
    const imagePath = result.imagePath ?? "";
    const imageName = imagePath ? imagePath.split(/[\\/]/).at(-1) : "";
    const responseJson = result.responseJson ?? {};
    const summary = summarizeResponse(responseJson);
    const status = result.error ? "error" : summary.status;
    const reason = result.error ? result.error : summary.reason;

    if (!summary.rows.length) {
      rows.push([
        imageIndex + 1,
        imageName,
        imagePath,
        status,
        reason,
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
      ]);
      continue;
    }

    for (const item of summary.rows) {
      rows.push([
        imageIndex + 1,
        imageName,
        imagePath,
        status,
        reason,
        item.rank,
        item.title,
        Number.isFinite(item.price) ? item.price : "",
        item.shop,
        item.sales,
        item.location,
        item.icons.join("、"),
        item.reason || item.bucket,
        item.itemUrl,
        item.shopUrl,
        item.imageUrl,
      ]);
    }
  }

  return [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\n") + "\n";
}

export function curlFromCapturedRequest({ url, headers = {}, postData = "" }) {
  const normalizedHeaders = Object.entries(headers)
    .filter(([name]) => !["cookie", "content-length", "host", "accept-encoding"].includes(name.toLowerCase()))
    .sort(([a], [b]) => a.localeCompare(b));
  const cookie = headers.cookie ?? headers.Cookie ?? "";
  const lines = ["#!/usr/bin/env bash", "set -euo pipefail", "", `curl ${shellQuote(url)} \\`];

  for (const [name, value] of normalizedHeaders) {
    lines.push(`  -H ${shellQuote(`${name}: ${value}`)} \\`);
  }
  if (cookie) {
    lines.push(`  -b ${shellQuote(cookie)} \\`);
  }
  lines.push(`  --data-raw ${shellQuote(postData)}`);
  lines.push("");
  return lines.join("\n");
}

function normalizeItem(item, index) {
  const props = Object.fromEntries(
    (Array.isArray(item.structuredUSPInfo) ? item.structuredUSPInfo : [])
      .filter((prop) => prop?.propertyName)
      .map((prop) => [prop.propertyName, prop.propertyValueName]),
  );
  const title = String(item.title ?? "");
  const price = parsePrice(item.priceShow?.price ?? item.price);
  const icons = (Array.isArray(item.icons) ? item.icons : [])
    .map((icon) => icon.text?.trim() || (["tmall", "tmallPC"].includes(icon.alias) ? "天猫" : ""))
    .filter(Boolean);
  const reasonParts = [];

  if (/电池|表带|贴膜|配件|挂绳|保护套|奖牌|支架|眼罩|纸巾|杯/.test(title)) {
    reasonParts.push("疑似配件或非同款");
  }
  if (/儿童|小孩|卡通|宝宝|玩具|发光|音乐|手串|亚克力|装饰/.test(title)) {
    reasonParts.push("标题命中图中卡通/装饰属性");
  }
  if (Number.isFinite(price) && price < 20) {
    reasonParts.push("价格明显低，需核验是否同款");
  }
  if (Number.isFinite(price) && price >= 500) {
    reasonParts.push("价格明显高，可能是品牌款或不相关");
  }
  if (icons.includes("退货宝")) {
    reasonParts.push("有退货保障");
  }
  if (icons.includes("包邮")) {
    reasonParts.push("包邮");
  }

  return {
    rank: index + 1,
    id: item.item_id,
    title,
    price,
    sales: item.realSales ?? "",
    shop: item.shopInfo?.title ?? item.nick ?? "",
    shopTag: item.shopTag ?? "",
    location: item.procity ?? "",
    brand: props.品牌 ?? "",
    movement: props.机芯类型 ?? "",
    type: props.手表种类 ?? "",
    waterproof: props.防水 ?? props.防水深度 ?? "",
    mirror: props.手表镜面材质 ?? "",
    icons,
    reason: reasonParts.join("；"),
    bucket: bucketForItem({ title, price, index, sales: item.realSales ?? "", reasonParts }),
    itemUrl: normalizeTaobaoUrl(item.auctionURL ?? ""),
    shopUrl: normalizeTaobaoUrl(item.shopInfo?.url ?? ""),
    imageUrl: normalizeTaobaoUrl(item.pic_path ?? ""),
  };
}

function bucketForItem({ title, price, index, sales, reasonParts }) {
  if (reasonParts.some((reason) => reason.includes("低")) || (Number.isFinite(price) && price < 20)) return "低价风险";
  if (Number.isFinite(price) && price >= 500) return "高价参考";
  if (index < 3 || /原创|同款|笑脸|苹果|亚克力|装饰/.test(title)) return "优先比价";
  if (/儿童|卡通|玩具/.test(title)) return "近似玩具款";
  if (/\d+\+人付款|[1-9]\d{2,}人付款/.test(sales)) return "销量参考";
  return "备选";
}

function pickPriorityItems(rows) {
  return [...rows]
    .filter((item) => !(Number.isFinite(item.price) && item.price < 20))
    .sort((a, b) => priorityScore(b) - priorityScore(a) || a.price - b.price || a.rank - b.rank)
    .slice(0, 10);
}

function priorityScore(item) {
  let score = 0;
  if (/原创|笑脸|苹果|亚克力|装饰|手串表|手表手环/.test(item.title)) score += 30;
  if (Number.isFinite(item.price) && item.price >= 20 && item.price <= 120) score += 20;
  if (/100\+|[2-9]\d{2,}\+?|[1-9]\d{3,}\+?/.test(item.sales)) score += 12;
  if (/包邮|退货宝/.test(item.icons.join(","))) score += 5;
  if (item.rank <= 10) score += 10 - item.rank;
  if (/配件|奖牌|支架|眼罩|纸巾|杯/.test(item.reason)) score -= 30;
  if (Number.isFinite(item.price) && item.price >= 500) score -= 20;
  return score;
}

function parsePrice(value) {
  const number = Number.parseFloat(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(number) ? number : null;
}

function median(sortedNumbers) {
  if (!sortedNumbers.length) return null;
  const mid = Math.floor(sortedNumbers.length / 2);
  const value = sortedNumbers.length % 2
    ? sortedNumbers[mid]
    : (sortedNumbers[mid - 1] + sortedNumbers[mid]) / 2;
  return round3(value);
}

function priceBands(prices) {
  const bands = {
    "<20": 0,
    "20-49": 0,
    "50-99": 0,
    "100-199": 0,
    "200-499": 0,
    "500-999": 0,
    "1000+": 0,
  };
  for (const price of prices) {
    if (price < 20) bands["<20"] += 1;
    else if (price < 50) bands["20-49"] += 1;
    else if (price < 100) bands["50-99"] += 1;
    else if (price < 200) bands["100-199"] += 1;
    else if (price < 500) bands["200-499"] += 1;
    else if (price < 1000) bands["500-999"] += 1;
    else bands["1000+"] += 1;
  }
  return bands;
}

function inferMainRange(rows) {
  const candidates = rows
    .map((item) => item.price)
    .filter((price) => Number.isFinite(price) && price >= 20 && price < 500)
    .sort((a, b) => a - b);
  if (!candidates.length) return "暂无稳定区间";
  const lower = candidates[Math.floor(candidates.length * 0.25)];
  const upper = candidates[Math.floor(candidates.length * 0.75)];
  return `${formatMoney(lower)}-${formatMoney(upper)}`;
}

function topCounts(values, limit) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }));
}

function parseCookieHeader(cookieHeader) {
  const cookies = {};
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    const splitAt = trimmed.indexOf("=");
    if (splitAt !== -1) cookies[trimmed.slice(0, splitAt)] = trimmed.slice(splitAt + 1);
  }
  return cookies;
}

function shellSplitFromCurl(text) {
  const start = text.search(/\bcurl\b/);
  if (start === -1) return [];
  const source = text.slice(start).replace(/\\\r?\n/g, " ");
  const tokens = [];
  let token = "";
  let quote = null;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (!quote && /\s/.test(char)) {
      if (token) tokens.push(token);
      token = "";
      continue;
    }
    if (!quote && char === "#") break;
    if (!quote && char === "$" && source[i + 1] === "'") {
      quote = "'";
      i += 1;
      continue;
    }
    if (!quote && (char === "'" || char === '"')) {
      quote = char;
      continue;
    }
    if (quote && char === quote) {
      quote = null;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      i += 1;
      token += source[i] ?? "";
      continue;
    }
    token += char;
  }
  if (token) tokens.push(token);
  return tokens;
}

function decodeAnsiEscapes(value) {
  return value.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function md5(value) {
  return createHash("md5").update(value).digest("hex");
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function csvCell(value) {
  const text = String(value ?? "");
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function markdownLink(label, url) {
  if (!url) return "";
  return `[${label}](${url.replace(/\)/g, "%29")})`;
}

function formatMoney(value) {
  if (!Number.isFinite(value)) return "未知";
  return `¥${Number(value.toFixed(3)).toString()}`;
}

function compactShop(item) {
  return [item.shop, item.sales, item.shopTag].filter(Boolean).join("，");
}

function escapeTable(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

export const constants = { API_NAME, DEFAULT_BATCH_DELAY_MS, DEFAULT_BATCH_JITTER_MS };
