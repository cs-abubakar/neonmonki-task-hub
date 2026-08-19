/**
 * HYROS connector — the only module that talks to Hyros.
 *
 * Verified against the live Hyros MCP server (Aug 2026):
 * - Base: https://api.hyros.com/v1  (+ paths /api/v1.0/<resource>)
 * - Auth header: `API-Key: <key>` (NOT Bearer)
 * - Pagination: pageSize (max 250) + pageId ← nextPageId
 * - MCP list tools take ALL filters inside a `request` object
 *   ({request:{fromDate,toDate,pageSize,pageId}}) — flat arguments are
 *   silently ignored and the server returns its unfiltered first page (50).
 * - Hyros date params are account-timezone YYYY-MM-DD.
 * - Rate limits: 30/s + 1000/min; 429 carries Retry-After
 * - Webhooks: X-Hyros-Signature: t=...,v1=HMAC_SHA256(secret, `${t}.${rawBody}`)
 *
 * Two auth transports, both READ-ONLY by construction:
 * - `apikey`: REST GETs with the API-Key header (legacy/manual path).
 * - `oauth`: the official Hyros MCP sign-in (OAuth 2.1 + PKCE, see
 *   lib/hyros-mcp.js). MCP tool calls are whitelisted to hyros_get_* only —
 *   this connector can never write to Hyros regardless of stored tokens.
 *
 * Credentials are never logged, never returned, never sent to the browser.
 */
"use strict";

const crypto = require("crypto");

const CONFIG = {
  baseUrl: (process.env.HYROS_BASE_URL || "https://api.hyros.com/v1").replace(/\/$/, ""),
  pageSize: 250,
  timeoutMs: 20000,
  maxAttempts: 4,
};

/* ------------------------------ channel normalization ------------------------------ */

// Central mapping (adSource.platform → user-facing names) — extend here,
// never scatter classification logic. Raw values like GOOGLE_V2 must never
// reach the main UI.
const PLATFORM_MAP = {
  GOOGLE: { channel: "Paid Search", platform: "Google Ads" },
  GOOGLE_V2: { channel: "Paid Search", platform: "Google Ads" },
  BING: { channel: "Paid Search", platform: "Microsoft / Bing Ads" },
  FACEBOOK: { channel: "Paid Social", platform: "Meta Ads" },
  INSTAGRAM: { channel: "Paid Social", platform: "Meta Ads" },
  TIKTOK: { channel: "Paid Social", platform: "TikTok Ads" },
  PINTEREST: { channel: "Paid Social", platform: "Pinterest Ads" },
  LINKEDIN: { channel: "Paid Social", platform: "LinkedIn Ads" },
  TWITTER: { channel: "Paid Social", platform: "Twitter / X Ads" },
  SNAPCHAT: { channel: "Paid Social", platform: "Snapchat Ads" },
  REDDIT: { channel: "Paid Social", platform: "Reddit Ads" },
  YOUTUBE: { channel: "Paid Social", platform: "YouTube Ads" },
  APPLOVIN: { channel: "Other", platform: "AppLovin" },
  WHOP_ADS: { channel: "Other", platform: "Whop Ads" },
};

function classifyOrganic(trafficSourceName) {
  const n = String(trafficSourceName || "").toLowerCase();
  if (/google/.test(n)) return { channel: "Organic Search / SEO", platform: "Organic Google" };
  if (/bing/.test(n)) return { channel: "Organic Search / SEO", platform: "Organic Bing" };
  if (/duckduckgo|search/.test(n)) return { channel: "Organic Search / SEO", platform: "Organic Search" };
  const social = /instagram|facebook|tiktok|pinterest|linkedin|twitter|snapchat/.exec(n);
  if (social) {
    const name = social[0];
    return { channel: "Organic Social", platform: `Organic ${name.charAt(0).toUpperCase()}${name.slice(1)}` };
  }
  if (/social/.test(n)) return { channel: "Organic Social", platform: "Organic Social" };
  if (/mail|newsletter|brevo|instantly/.test(n)) return { channel: "Email", platform: "Email" };
  if (/referral|partner|affiliate/.test(n)) return { channel: "Referral", platform: "Referral" };
  if (/direct|none|^$/.test(n)) return { channel: "Direct", platform: "Direct" };
  return { channel: "Other", platform: "Other" };
}

/** Normalize one Hyros attribution object into {channel, platform, isOrganic, sourceName, campaign...}. */
function normalizeAttribution(att) {
  if (!att || typeof att !== "object") {
    return { channel: "Unknown", platform: "Other", isOrganic: false, sourceName: "", campaign: "", adAccount: "", goal: "" };
  }
  const sourceName = (att.trafficSource && att.trafficSource.name) || att.name || "";
  const campaign = (att.category && att.category.name) || "";
  const goal = typeof att.goal === "string" ? att.goal : ((att.goal && att.goal.name) || "");
  const adAccount = (att.adSource && att.adSource.adAccountId) || "";
  const platformRaw = att.adSource && att.adSource.platform;
  // No adSource means organic — regardless of the `organic` flag. Hyros has
  // misconfigured rows in the wild (e.g. "@google-organic" with organic:false
  // but adSource:null and trafficSource "google organic").
  const isOrganic = att.organic === true || !att.adSource;
  let cls;
  if (isOrganic) {
    cls = classifyOrganic(sourceName);
  } else if (platformRaw && PLATFORM_MAP[platformRaw]) {
    cls = PLATFORM_MAP[platformRaw];
  } else if (platformRaw) {
    cls = { channel: "Other", platform: `${platformRaw.charAt(0)}${platformRaw.slice(1).toLowerCase()} Ads` };
  } else {
    cls = { channel: "Other", platform: "Other" };
  }
  return {
    channel: cls.channel,
    platform: cls.platform,
    isOrganic,
    sourceName,
    campaign,
    adAccount: String(adAccount || ""),
    goal,
  };
}

/* ------------------------------ HTTP ------------------------------ */

function authHeaders(apiKey) {
  return { "API-Key": apiKey, "Content-Type": "application/json" };
}

/* REST resource path → read-only MCP tool (OAuth transport). Anything not in
 * this map has no read-only equivalent and must not be called. */
const MCP_TOOL_MAP = {
  "user-info": "hyros_get_user_info",
  sales: "hyros_get_sales",
  leads: "hyros_get_leads",
  calls: "hyros_get_calls",
  subscriptions: "hyros_get_subscriptions",
  sources: "hyros_get_sources",
  "ad-accounts": "hyros_get_ad_accounts",
  ads: "hyros_get_ads",
  tags: "hyros_get_tags_count",
};

/** Normalize an MCP tool payload into the REST {result, nextPageId} shape. */
function mcpToRestShape(payload) {
  if (Array.isArray(payload)) return { result: payload };
  if (payload && typeof payload === "object") {
    if (Array.isArray(payload.result)) return payload;
    if (payload.result && typeof payload.result === "object") return payload;
    if (Array.isArray(payload.data)) return { result: payload.data };
  }
  return payload && typeof payload === "object" ? payload : { result: [] };
}

async function hyrosMcpGet(cfg, path, params) {
  const tool = MCP_TOOL_MAP[path];
  if (!tool) {
    const e = new Error(`No read-only MCP equivalent for "${path}"`);
    e.status = 400;
    throw e;
  }
  const mcp = require("./hyros-mcp");
  const payload = await mcp.callTool(cfg, tool, params);
  return mcpToRestShape(payload);
}

function sanitizeError(status, bodyText) {
  // never include response bodies in errors — they may echo request params
  const map = { 400: "Hyros rejected the request (check parameters)", 401: "Hyros rejected the API key", 403: "API key lacks the required Hyros role", 404: "Hyros endpoint not found", 429: "Hyros rate limit reached" };
  return map[status] || `Hyros request failed (HTTP ${status})`;
}

async function hyrosGet(cfg, path, params = {}, _attempt = 1) {
  if (cfg && cfg.authMethod === "oauth") return hyrosMcpGet(cfg, path, params);
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  }
  const url = `${baseUrlFor(cfg)}/api/v1.0/${path}${qs.size ? "?" + qs.toString() : ""}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CONFIG.timeoutMs);
  try {
    const res = await fetch(url, { headers: authHeaders(cfg.apiKey), signal: ctrl.signal });
    if (res.status === 429 && _attempt < CONFIG.maxAttempts) {
      const retryAfter = Number(res.headers.get("Retry-After") || 2 * _attempt);
      await new Promise((r) => setTimeout(r, Math.min(30000, retryAfter * 1000)));
      return hyrosGet(cfg, path, params, _attempt + 1);
    }
    if (res.status >= 500 && _attempt < CONFIG.maxAttempts) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** (_attempt - 1) + Math.random() * 250));
      return hyrosGet(cfg, path, params, _attempt + 1);
    }
    if (!res.ok) {
      const e = new Error(sanitizeError(res.status));
      e.status = res.status;
      throw e;
    }
    return await res.json();
  } catch (e) {
    if (e.name === "AbortError") {
      const t = new Error("Hyros request timed out");
      t.status = 0;
      throw t;
    }
    if (e.status) throw e;
    if (_attempt < CONFIG.maxAttempts) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** (_attempt - 1) + Math.random() * 250));
      return hyrosGet(cfg, path, params, _attempt + 1);
    }
    const t = new Error("Hyros is unreachable right now");
    t.status = 0;
    throw t;
  } finally {
    clearTimeout(timer);
  }
}

/** Page through a list endpoint. Returns all rows (bounded by maxPages). */
async function hyrosList(cfg, path, params = {}, maxPages = 200) {
  const out = [];
  let pageId = undefined;
  const seenCursors = new Set();
  // MCP list tools take their filters inside a `request` OBJECT — flat
  // arguments are silently ignored and the server returns its DEFAULT first
  // page (pageSize 50, unfiltered). The REST transport keeps flat params.
  const viaMcp = !!(cfg && cfg.authMethod === "oauth");
  for (let page = 0; page < maxPages; page++) {
    const p = { ...params, pageSize: CONFIG.pageSize, ...(pageId ? { pageId } : {}) };
    const data = await hyrosGet(cfg, path, viaMcp ? { request: p } : p);
    const rows = Array.isArray(data && data.result) ? data.result : [];
    const next = data && data.nextPageId;
    // Termination guards: a cursor identical to the one just sent, or one
    // already seen, means the transport did not advance (the MCP tools mirror
    // REST params loosely) — the page is a replay of the previous one, so
    // drop it and stop instead of looping 200× through the rate-limit budget.
    const repeated = !!next && (next === pageId || seenCursors.has(next));
    if (!repeated) out.push(...rows);
    if (!next || !rows.length || repeated) break;
    seenCursors.add(next);
    pageId = next;
  }
  return out;
}

/* ------------------------------ connection ------------------------------ */

// Accepts either a bare key string or a cfg object
// {apiKey} (REST) or {authMethod:"oauth", accessToken, refreshToken, ...} (MCP).
function cfgOf(cfgOrKey) {
  const cfg = typeof cfgOrKey === "string" ? { apiKey: cfgOrKey } : { ...(cfgOrKey || {}) };
  if (cfg.authMethod === "oauth") {
    if (!cfg.accessToken && !cfg.refreshToken) {
      const e = new Error("The Hyros sign-in is missing — reconnect from Admin → Integrations");
      e.status = 401;
      e.reconnectRequired = true;
      throw e;
    }
    return cfg;
  }
  if (!cfg.apiKey) {
    const e = new Error("The Hyros API key is missing");
    e.status = 401;
    throw e;
  }
  return cfg;
}

function baseUrlFor(cfg) {
  return String((cfg && cfg.baseUrl) || CONFIG.baseUrl).replace(/\/$/, "");
}

async function testConnection(cfgOrKey) {
  const cfg = cfgOf(cfgOrKey);
  if (cfg.authMethod === "oauth") {
    // MCP path: hyros_get_user_info exercises the whole OAuth + MCP chain.
    const data = await hyrosMcpGet(cfg, "user-info", {});
    const profile = (data && data.result && data.result.userProfile) || (data && data.userProfile) || {};
    return {
      ok: true,
      accountName: profile.companyName || [profile.firstName, profile.lastName].filter(Boolean).join(" ") || "NEONMONKI",
    };
  }
  const url = `${baseUrlFor(cfg)}/api/v1.0/user-info`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CONFIG.timeoutMs);
  try {
    const res = await fetch(url, { headers: authHeaders(cfg.apiKey), signal: ctrl.signal });
    if (!res.ok) {
      const e = new Error(sanitizeError(res.status));
      e.status = res.status;
      throw e;
    }
    const data = await res.json();
    const profile = data && data.result && (data.result.userProfile || {});
    return {
      ok: true,
      accountName: profile.companyName || [profile.firstName, profile.lastName].filter(Boolean).join(" ") || "NEONMONKI",
    };
  } catch (e) {
    if (e.status) throw e;
    if (e.name === "AbortError") {
      const t = new Error("Hyros request timed out");
      t.status = 0;
      throw t;
    }
    const t = new Error("Hyros is unreachable right now");
    t.status = 0;
    throw t;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------ normalization → reporting_facts ------------------------------ */

const DAY = 86400000;

const MONTH_IDX = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/**
 * Parse the date shapes Hyros actually emits:
 * - ISO with offset on leads ("2026-08-19T00:08:46+02:00")
 * - Java Date.toString() on sales ("Tue Aug 18 14:16:42 UTC 2026")
 * - epoch ms / Date objects from our own windowing code
 * Returns a Date or null when unparseable.
 */
function parseHyrosDate(value) {
  if (value == null || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number" && Number.isFinite(value)) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const s = String(value).trim();
  if (!s) return null;
  // V8 parses both live string shapes directly; the regex below is a fallback
  // for engines/environments where the Java toString form is not recognized.
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d;
  const m = /^[A-Za-z]{3} ([A-Za-z]{3}) (\d{1,2}) (\d{2}):(\d{2}):(\d{2}) ([A-Za-z]+) (\d{4})$/.exec(s);
  if (m) {
    const month = MONTH_IDX[m[1].toLowerCase()];
    if (month !== undefined) {
      const dt = new Date(Date.UTC(Number(m[7]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])));
      if (!Number.isNaN(dt.getTime())) return dt;
    }
  }
  return null;
}

/** Hyros date params are account-timezone YYYY-MM-DD strings. */
function dayParam(v) {
  if (v == null || v === "") return undefined;
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const d = parseHyrosDate(v);
  return d ? d.toISOString().slice(0, 10) : undefined;
}

function pickAttribution(entity) {
  // convention: prefer lastSource (last click), else last attribution entry
  const att = entity.lastSource || entity.firstSource
    || (Array.isArray(entity.attribution) && entity.attribution.length ? entity.attribution[entity.attribution.length - 1] : null);
  return att || null;
}

function factBase(sourceSystem, eventType, externalId, eventAt, entity, att) {
  const norm = normalizeAttribution(att);
  const parsed = parseHyrosDate(eventAt);
  return {
    sourceSystem, integrationId: "hyros", externalId: String(externalId),
    eventType, eventAt: (parsed || new Date()).toISOString(),
    channel: norm.channel, platform: norm.platform,
    sourceName: norm.sourceName, campaign: norm.campaign, adAccount: norm.adAccount,
    goal: norm.goal,
    tags: [].concat((entity.tags || []), entity.product && entity.product.tag ? [entity.product.tag] : []).filter(Boolean).join(","),
    isOrganic: norm.isOrganic,
    isQualified: typeof entity.qualified === "boolean" ? entity.qualified : null,
    value: 0, currency: (entity.price && entity.price.currency) || "EUR",
    leadId: String((entity.lead && entity.lead.id) || entity.leadId || ""),
    saleId: "", orderId: String(entity.orderId || ""),
    raw: null,
  };
}

function normalizeLead(lead) {
  const f = factBase("hyros", "lead", lead.id, lead.creationDate || lead.joinDate || lead.UTCJoinDate, lead, pickAttribution(lead));
  return f;
}

function normalizeSale(sale) {
  const f = factBase("hyros", "sale", sale.id, sale.creationDate || sale.UTCDate || sale.date, sale, pickAttribution(sale));
  // Money lives at the TOP level: sale.price is in account currency (EUR).
  // product.USDPrice is USD-converted — using it is a currency bug.
  const price = sale.price && typeof sale.price === "object" ? sale.price : {};
  f.value = Number(price.price) || 0;
  f.saleId = String(sale.id);
  f.isQualified = typeof sale.qualified === "boolean" ? sale.qualified : null;
  f.raw = { orderId: sale.orderId, product: sale.product && sale.product.name, category: sale.product && sale.product.category && sale.product.category.name, recurring: !!sale.recurring, refunded: Number(price.refunded) || 0 };
  return f;
}

function normalizeRefund(sale) {
  const f = normalizeSale(sale);
  const price = sale.price && typeof sale.price === "object" ? sale.price : {};
  f.eventType = "refund";
  f.externalId = String(sale.id) + ":refund";
  f.value = -Math.abs(Number(price.refunded) || Number(price.price) || 0);
  return f;
}

function normalizeCall(call) {
  const f = factBase("hyros", "call", call.id, call.creationDate || call.UTCDate || call.date, call, pickAttribution(call));
  f.isQualified = call.state ? call.state === "QUALIFIED" : (typeof call.qualified === "boolean" ? call.qualified : null);
  return f;
}

/** Webhook envelope → fact row(s). Returns null when the event type isn't reportable. */
function normalizeWebhookEvent(envelope) {
  const type = envelope.type;
  const body = envelope.body || {};
  const evtId = envelope.eventId;
  if (!evtId || !type) return null;
  if (type === "sale.attributed") {
    const f = normalizeSale({ ...body, creationDate: body.UTCDate || body.date });
    f.externalId = body.id ? String(body.id) : `evt:${evtId}`;
    return f;
  }
  if (type === "sale.refunded") {
    const f = normalizeRefund({ ...body, creationDate: body.UTCDate || body.date });
    f.externalId = body.id ? `${body.id}:refund` : `evt:${evtId}`;
    return f;
  }
  if (type === "call.attributed") {
    const f = normalizeCall({ ...body, creationDate: body.UTCDate || body.date });
    f.externalId = body.id ? String(body.id) : `evt:${evtId}`;
    return f;
  }
  if (type === "lead.opted.in" || type === "lead.opted.in.first.time") {
    const lead = { ...(body.lead || {}), id: body.id, creationDate: body.UTCDate || body.date, attribution: body.attribution, lastSource: body.lastSource, firstSource: body.firstSource };
    const f = normalizeLead(lead);
    f.externalId = body.id ? String(body.id) : `evt:${evtId}`;
    return f;
  }
  return null;
}

/* ------------------------------ sync ------------------------------ */

/** Pull a date range of leads+sales+calls → normalized fact rows (not yet stored). */
async function fetchFacts(cfg, { from, to }) {
  const params = {};
  const fromDate = dayParam(from);
  const toDate = dayParam(to);
  if (fromDate) params.fromDate = fromDate;
  if (toDate) params.toDate = toDate;
  const [sales, leads, calls] = await Promise.all([
    hyrosList(cfg, "sales", params),
    hyrosList(cfg, "leads", params),
    hyrosList(cfg, "calls", params),
  ]);
  const facts = [
    ...sales.map(normalizeSale),
    ...leads.map(normalizeLead),
    ...calls.map(normalizeCall),
  ];
  return facts;
}

/* ------------------------------ report tools (MCP) ------------------------------ */

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/**
 * Thin wrapper for the report-style MCP tools (roas/attribution). These exist
 * only on the OAuth/MCP transport — the legacy REST API-key path has no
 * equivalent wired up here. All report tools take a `request` object.
 */
async function mcpReport(cfg, tool, request) {
  const c = cfgOf(cfg);
  if (c.authMethod !== "oauth") {
    const e = new Error("Hyros reports need the OAuth sign-in (Admin → Integrations)");
    e.status = 400;
    throw e;
  }
  return require("./hyros-mcp").callTool(c, tool, { request: request || {} });
}

/** Paginate a report tool that answers {result:[...], nextPageId}. */
async function pagedReport(cfg, tool, request, maxPages = 200) {
  const out = [];
  let pageId = undefined;
  const seenCursors = new Set();
  for (let page = 0; page < maxPages; page++) {
    const payload = await mcpReport(cfg, tool, { ...request, ...(pageId ? { pageId } : {}) });
    const rows = Array.isArray(payload && payload.result) ? payload.result : [];
    const next = payload && payload.nextPageId;
    const repeated = !!next && (next === pageId || seenCursors.has(next));
    if (!repeated) out.push(...rows);
    if (!next || !rows.length || repeated) break;
    seenCursors.add(next);
    pageId = next;
  }
  return out;
}

/** Connected ad accounts → [{id, name, type}] (type e.g. GOOGLE_V2|FACEBOOK|PINTEREST). */
async function listAdAccounts(cfg) {
  const c = cfgOf(cfg);
  let rows = [];
  if (c.authMethod === "oauth") {
    const payload = await mcpReport(c, "hyros_get_ad_accounts", {});
    rows = Array.isArray(payload && payload.result) ? payload.result : [];
  } else {
    const data = await hyrosGet(c, "ad-accounts", {});
    rows = Array.isArray(data && data.result) ? data.result : [];
  }
  return rows
    .map((r) => ({
      id: String(r && (r.id != null ? r.id : r.adAccountId) || ""),
      name: String((r && r.name) || ""),
      type: String((r && r.type) || ""),
    }))
    .filter((r) => r.id);
}

/**
 * Sources list (includeOrganic:true) → normalized rows:
 * [{name, tag, organic, disregarded, trafficSource, platform, adSourceId, adAccountId, category, goal}]
 */
async function listSources(cfg) {
  const rows = await hyrosList(cfgOf(cfg), "sources", { includeOrganic: true });
  return rows.map((r) => ({
    name: String(r && r.name || ""),
    tag: String(r && r.tag || ""),
    organic: !!(r && r.organic === true),
    disregarded: !!(r && r.disregarded === true),
    trafficSource: String((r && r.trafficSource && r.trafficSource.name) || ""),
    platform: String((r && r.adSource && r.adSource.platform) || ""),
    adSourceId: r && r.adSource && r.adSource.adSourceId != null ? String(r.adSource.adSourceId) : "",
    adAccountId: r && r.adSource && r.adSource.adAccountId != null ? String(r.adSource.adAccountId) : "",
    category: String((r && r.category && r.category.name) || ""),
    goal: typeof (r && r.goal) === "string" ? r.goal : String((r && r.goal && r.goal.name) || ""),
  }));
}

/**
 * ROAS report for one ad account over a range (basis SALE_DATE). The tool
 * answers with a FLAT object (no result wrapper). Works with from===to for a
 * single day — that is the authoritative daily account series.
 * → {revenue, cost, roas, uniqueSales, aov}
 */
async function roasForRange(cfg, { id, level = "ACCOUNT", from, to } = {}) {
  const payload = await mcpReport(cfg, "hyros_get_roas_report", {
    id, level, startDate: dayParam(from), endDate: dayParam(to), basis: "SALE_DATE",
  });
  const r = payload && typeof payload === "object" ? payload : {};
  return {
    revenue: num(r.revenue != null ? r.revenue : r.totalRevenue),
    cost: num(r.cost),
    roas: num(r.roas),
    uniqueSales: num(r.uniqueSales),
    aov: num(r.averageOrderValue),
  };
}

/**
 * One roas call per day, from..to inclusive (account-tz days). Batching is the
 * caller's concern (deadline budgeting lives in the sync pipeline).
 * → [{day, cost, revenue, sales, aov}]
 */
async function roasDailySeries(cfg, { id, level = "ACCOUNT", from, to } = {}) {
  const startDay = dayParam(from);
  const endDay = dayParam(to);
  if (!startDay || !endDay) return [];
  const out = [];
  for (let t = Date.parse(`${startDay}T00:00:00Z`); t <= Date.parse(`${endDay}T00:00:00Z`); t += DAY) {
    const day = new Date(t).toISOString().slice(0, 10);
    const r = await roasForRange(cfg, { id, level, from: day, to: day });
    out.push({ day, cost: r.cost, revenue: r.revenue, sales: r.uniqueSales, aov: r.aov });
  }
  return out;
}

const ATTRIBUTION_FIELDS = ["SALES", "LEADS", "REVENUE", "COST", "ROAS", "CLICKS", "IMPRESSIONS"];

/**
 * DAY-grouped attribution report (one row per day for the given adSourceIds
 * combined; campaignId identifies the campaign, display names come from the
 * sources list). → [{day, cost, revenue, sales, leads, clicks, impressions, campaignId}]
 */
async function attributionDaily(cfg, { level, ids, from, to } = {}) {
  const rows = await pagedReport(cfg, "hyros_get_attribution_report", {
    attributionModel: "LAST_CLICK",
    level,
    ids: Array.isArray(ids) ? ids.map(String) : [],
    startDate: dayParam(from),
    endDate: dayParam(to),
    timeGroupingOption: "DAY",
    fields: ATTRIBUTION_FIELDS,
    pageSize: CONFIG.pageSize,
  });
  return rows.map((r) => ({
    day: String(r && r.startDate || ""),
    cost: num(r && r.cost),
    revenue: num(r && r.revenue),
    sales: num(r && r.sales),
    leads: num(r && r.leads),
    clicks: num(r && r.clicks),
    impressions: num(r && r.impressions),
    campaignId: r && r.campaignId != null ? String(r.campaignId) : "",
  }));
}

/**
 * Attribution totals per entity (no time grouping; rows keyed by `id`).
 * → [{id, cost, revenue, sales, leads, roas}]
 */
async function attributionTotals(cfg, { level, ids, from, to } = {}) {
  const rows = await pagedReport(cfg, "hyros_get_attribution_report", {
    attributionModel: "LAST_CLICK",
    level,
    ids: Array.isArray(ids) ? ids.map(String) : [],
    startDate: dayParam(from),
    endDate: dayParam(to),
    fields: ATTRIBUTION_FIELDS,
    pageSize: CONFIG.pageSize,
  });
  return rows.map((r) => ({
    id: r && r.id != null ? String(r.id) : "",
    cost: num(r && r.cost),
    revenue: num(r && r.revenue),
    sales: num(r && r.sales),
    leads: num(r && r.leads),
    roas: num(r && r.roas),
  }));
}

const { getStore } = require("./store");

async function upsertFacts(facts) {
  if (!facts.length) return 0;
  const store = getStore();
  const r = await store.reportingFactsUpsert(facts);
  return typeof r === "number" ? r : facts.length;
}

/**
 * Resumable backfill: works backwards in 7-day windows. cursor = ISO timestamp
 * of the NEXT window's end. Each call processes one window and returns
 * { ok, recordsIn, nextCursor, done }. Facts are upserted per window.
 */
async function syncBackfill(cfg, { days = 90, cursor = null, deadlineMs = 0 } = {}) {
  cfgOf(cfg);
  const startBoundary = Date.now() - days * DAY;
  const windowEnd = cursor ? Date.parse(cursor) : Date.now();
  if (!windowEnd || windowEnd <= startBoundary) return { ok: true, recordsIn: 0, nextCursor: null, done: true };
  if (deadlineMs && deadlineMs < 3000) return { ok: true, recordsIn: 0, nextCursor: cursor, done: false };
  const windowStart = Math.max(startBoundary, windowEnd - 7 * DAY);
  try {
    const facts = await fetchFacts(cfg, { from: windowStart, to: windowEnd });
    await upsertFacts(facts);
    const nextCursor = windowStart <= startBoundary ? null : new Date(windowStart).toISOString();
    return { ok: true, recordsIn: facts.length, nextCursor, done: nextCursor === null };
  } catch (e) {
    return { ok: false, recordsIn: 0, error: e.message, nextCursor: cursor, done: false };
  }
}

/** Incremental sync with overlap (late Hyros writes) — upserts internally. */
async function syncIncremental(cfg, { from, to } = {}) {
  cfgOf(cfg);
  const end = to || new Date().toISOString().slice(0, 10);
  const start = from || new Date(Date.now() - DAY).toISOString().slice(0, 10);
  try {
    const facts = await fetchFacts(cfg, { from: start, to: end });
    await upsertFacts(facts);
    return { ok: true, recordsIn: facts.length };
  } catch (e) {
    return { ok: false, recordsIn: 0, error: e.message };
  }
}

/* ------------------------------ webhook signature ------------------------------ */

function verifyWebhookSignature(rawBody, signatureHeader, secretKey) {
  if (!signatureHeader || !secretKey) return false;
  const m = String(signatureHeader).match(/t=(\d+),v1=([a-f0-9]+)/i);
  if (!m) return false;
  const t = Number(m[1]);
  if (Math.abs(Date.now() - t * 1000) > 300000) return false; // 5-min replay tolerance
  const expected = crypto.createHmac("sha256", secretKey).update(`${t}.${rawBody}`).digest("hex");
  const got = m[2];
  return expected.length === got.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(got));
}

module.exports = {
  CONFIG, testConnection, fetchFacts, syncBackfill, syncIncremental,
  normalizeSale, normalizeLead, normalizeCall, normalizeRefund, normalizeWebhookEvent,
  normalizeAttribution, verifyWebhookSignature, parseHyrosDate,
  listAdAccounts, listSources, roasForRange, roasDailySeries,
  attributionDaily, attributionTotals,
};
