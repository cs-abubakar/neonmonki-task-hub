/**
 * HYROS connector — the only module that talks to Hyros.
 *
 * Verified against official docs (docs/hyros-integration-spec.md, Aug 2026):
 * - Base: https://api.hyros.com/v1  (+ paths /api/v1.0/<resource>)
 * - Auth header: `API-Key: <key>` (NOT Bearer)
 * - Pagination: pageSize (max 250) + pageId ← nextPageId
 * - Rate limits: 30/s + 1000/min; 429 carries Retry-After
 * - Webhooks: X-Hyros-Signature: t=...,v1=HMAC_SHA256(secret, `${t}.${rawBody}`)
 *
 * The API key is never logged, never returned, never sent to the browser.
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

// Central mapping — extend here, never scatter classification logic.
const PLATFORM_MAP = {
  GOOGLE: { channel: "Paid Search", platform: "Google Ads" },
  BING: { channel: "Paid Search", platform: "Microsoft / Bing Ads" },
  FACEBOOK: { channel: "Paid Social", platform: "Meta / Facebook Ads" },
  INSTAGRAM: { channel: "Paid Social", platform: "Meta / Facebook Ads" },
  TIKTOK: { channel: "Paid Social", platform: "TikTok Ads" },
  PINTEREST: { channel: "Paid Social", platform: "Pinterest Ads" },
  LINKEDIN: { channel: "Paid Social", platform: "LinkedIn Ads" },
  TWITTER: { channel: "Paid Social", platform: "Twitter / X Ads" },
  SNAPCHAT: { channel: "Paid Social", platform: "Snapchat Ads" },
  YOUTUBE: { channel: "Paid Social", platform: "YouTube Ads" },
};

function classifyOrganic(trafficSourceName) {
  const n = String(trafficSourceName || "").toLowerCase();
  if (/google|bing|duckduckgo|search/.test(n)) return { channel: "Organic Search / SEO", platform: "Organic Google" };
  if (/facebook|instagram|tiktok|pinterest|linkedin|twitter|snapchat|social/.test(n)) return { channel: "Organic Social", platform: "Organic Social" };
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
  const organic = att.organic === true;
  const platformRaw = att.adSource && att.adSource.platform;
  const sourceName = (att.trafficSource && att.trafficSource.name) || att.name || "";
  const campaign = (att.category && att.category.name) || "";
  const goal = (att.goal && att.goal.name) || "";
  const adAccount = (att.adSource && att.adSource.adAccountId) || "";
  let cls;
  if (organic) {
    cls = classifyOrganic(sourceName);
  } else if (platformRaw && PLATFORM_MAP[platformRaw]) {
    cls = PLATFORM_MAP[platformRaw];
  } else if (platformRaw) {
    cls = { channel: "Other", platform: `${platformRaw.charAt(0)}${platformRaw.slice(1).toLowerCase()} Ads` };
  } else {
    cls = classifyOrganic(sourceName);
    if (!organic && cls.channel !== "Direct") cls = { ...cls }; // paid-without-platform keeps organic-ish classification
  }
  return {
    channel: cls.channel,
    platform: cls.platform,
    isOrganic: organic,
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

function sanitizeError(status, bodyText) {
  // never include response bodies in errors — they may echo request params
  const map = { 400: "Hyros rejected the request (check parameters)", 401: "Hyros rejected the API key", 403: "API key lacks the required Hyros role", 404: "Hyros endpoint not found", 429: "Hyros rate limit reached" };
  return map[status] || `Hyros request failed (HTTP ${status})`;
}

async function hyrosGet(cfg, path, params = {}, _attempt = 1) {
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
  for (let page = 0; page < maxPages; page++) {
    const data = await hyrosGet(cfg, path, { ...params, pageSize: CONFIG.pageSize, ...(pageId ? { pageId } : {}) });
    const rows = Array.isArray(data && data.result) ? data.result : [];
    out.push(...rows);
    pageId = data && data.nextPageId;
    if (!pageId || !rows.length) break;
  }
  return out;
}

/* ------------------------------ connection ------------------------------ */

// Accepts either a bare key string or a cfg object {apiKey, baseUrl?}.
function cfgOf(cfgOrKey) {
  const cfg = typeof cfgOrKey === "string" ? { apiKey: cfgOrKey } : { ...(cfgOrKey || {}) };
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

function pickAttribution(entity) {
  // convention: prefer lastSource (last click), else last attribution entry
  const att = entity.lastSource || entity.firstSource
    || (Array.isArray(entity.attribution) && entity.attribution.length ? entity.attribution[entity.attribution.length - 1] : null);
  return att || null;
}

function factBase(sourceSystem, eventType, externalId, eventAt, entity, att) {
  const norm = normalizeAttribution(att);
  return {
    sourceSystem, integrationId: "hyros", externalId: String(externalId),
    eventType, eventAt: new Date(eventAt).toISOString(),
    channel: norm.channel, platform: norm.platform,
    sourceName: norm.sourceName, campaign: norm.campaign, adAccount: norm.adAccount,
    goal: norm.goal,
    tags: [].concat((entity.tags || []), entity.product && entity.product.tag ? [entity.product.tag] : []).filter(Boolean).join(","),
    isOrganic: norm.isOrganic,
    isQualified: typeof entity.qualified === "boolean" ? entity.qualified : null,
    value: 0, currency: (entity.price && entity.price.currency) || (entity.product && entity.product.price && entity.product.price.currency) || "EUR",
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
  const price = (sale.product && (sale.product.USDPrice || sale.product.price)) || sale.price || {};
  f.value = Number(price.price) || 0;
  f.saleId = String(sale.id);
  f.isQualified = typeof sale.qualified === "boolean" ? sale.qualified : null;
  f.raw = { orderId: sale.orderId, product: sale.product && sale.product.name, category: sale.product && sale.product.category && sale.product.category.name, recurring: !!sale.recurring, refunded: Number(price.refunded) || 0 };
  return f;
}

function normalizeRefund(sale) {
  const f = normalizeSale(sale);
  const price = (sale.product && (sale.product.USDPrice || sale.product.price)) || sale.price || {};
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
  const fromDate = new Date(from).toISOString();
  const toDate = new Date(to).toISOString();
  const [sales, leads, calls] = await Promise.all([
    hyrosList(cfg, "sales", { fromDate, toDate }),
    hyrosList(cfg, "leads", { fromDate, toDate }),
    hyrosList(cfg, "calls", { fromDate, toDate }),
  ]);
  const facts = [
    ...sales.map(normalizeSale),
    ...leads.map(normalizeLead),
    ...calls.map(normalizeCall),
  ];
  return facts;
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
  normalizeAttribution, verifyWebhookSignature,
};
