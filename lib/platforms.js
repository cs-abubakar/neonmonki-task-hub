/**
 * Platform Reports connectors — Google Search Console (OAuth) + Microsoft
 * Clarity (API token). Plain-HTTPS, zero dependencies, read-only scopes.
 *
 * Ported from the Knowgistic Reporting integration framework into the Task
 * Hub storage model: connections live in integration_connections (ids "gsc"
 * and "clarity", per-platform extras in `meta`), normalized rows land in
 * platform_daily (migration 014), run history in hyros_sync_runs under the
 * platform's integration id.
 */
"use strict";

const crypto = require("crypto");
const ai = require("./ai");

const CIPHER_CONTEXT = "neonmonki-task-hub:platform-reports:v1";
const GSC_ID = "gsc";
const CLARITY_ID = "clarity";

const GSC_BASE = "https://searchconsole.googleapis.com/webmasters/v3";
const GSC_SITES = "https://www.googleapis.com/webmasters/v3/sites";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO = "https://www.googleapis.com/oauth2/v2/userinfo";
const GOOGLE_AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
const GSC_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/webmasters.readonly",
];

const CLARITY_BASE = (process.env.CLARITY_BASE_URL || "https://www.clarity.ms/export-data/api/v1/project-live-insights").replace(/\/$/, "");
// Clarity Data Export API: Bearer token only, aggregated metrics only, max 3
// days back, max 10 calls/project/day. We snapshot daily and accumulate our
// own history in platform_daily.
const CLARITY_NUM_DAYS = 3;
const CLARITY_SLICES = [
  { sliceType: "overall", dimensions: [] },
  { sliceType: "device", dimensions: ["Device"] },
  { sliceType: "source", dimensions: ["Source"] },
  { sliceType: "url", dimensions: ["URL"] },
];

const GSC_SLICES = [
  { sliceType: "date", dimensions: ["date"] },
  { sliceType: "query", dimensions: ["date", "query"] },
  { sliceType: "page", dimensions: ["date", "page"] },
];
const GSC_ROW_LIMIT = 25000;
const GSC_MAX_ROWS_PER_SLICE = 75000;
const GSC_HISTORY_DAYS = 90;      // initial backfill window
const GSC_INCREMENTAL_DAYS = 7;   // trailing re-read (data settles with lag)
const GSC_DATA_LAG_DAYS = 3;      // GSC final data lags ~2–3 days

/* ------------------------------ http helper ------------------------------ */

async function httpJson(url, { method = "GET", headers = {}, body = null, timeoutMs = 20000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body == null ? undefined : body,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON body */ }
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      err.detail = String(text || "").slice(0, 240);
      throw err;
    }
    return json;
  } catch (e) {
    if (e.name === "AbortError") {
      const err = new Error("Request timed out");
      err.code = "timeout";
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** One retry on 429/5xx with a short backoff; everything else surfaces. */
async function httpJsonRetry(url, opts, { retries = 1 } = {}) {
  try {
    return await httpJson(url, opts);
  } catch (e) {
    const transient = e.code === "timeout" || e.status === 429 || (e.status >= 500 && e.status < 600);
    if (!transient || retries <= 0) throw e;
    await new Promise((r) => setTimeout(r, 1200 + Math.floor(Math.random() * 600)));
    return httpJsonRetry(url, opts, { retries: retries - 1 });
  }
}

/* ------------------------------ credentials ------------------------------ */

function gscOAuthEnv() {
  const clientId = String(process.env.GOOGLE_OAUTH_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.GOOGLE_OAUTH_CLIENT_SECRET || "").trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

function gscCredentials(integration) {
  return {
    accessToken: ai.decryptSecret(integration && integration.oauthAccessTokenEncrypted, CIPHER_CONTEXT),
    refreshToken: ai.decryptSecret(integration && integration.oauthRefreshTokenEncrypted, CIPHER_CONTEXT),
    expiresAt: (integration && integration.oauthAccessExpiresAt) || null,
  };
}

function clarityToken(integration) {
  return ai.decryptSecret(integration && integration.apiKeyEncrypted, CIPHER_CONTEXT);
}

const sha256Text = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");

/* ------------------------------ GSC OAuth ------------------------------ */

function gscAuthUrl(origin, state) {
  const env = gscOAuthEnv();
  if (!env) return null;
  const params = new URLSearchParams({
    client_id: env.clientId,
    redirect_uri: `${origin}/api/platforms/gsc/oauth/callback`,
    response_type: "code",
    scope: GSC_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `${GOOGLE_AUTHORIZE}?${params.toString()}`;
}

async function gscExchangeCode(origin, code) {
  const env = gscOAuthEnv();
  if (!env) throw new Error("Google OAuth is not configured.");
  const redirectUri = `${origin}/api/platforms/gsc/oauth/callback`;
  const out = await httpJsonRetry(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code, client_id: env.clientId, client_secret: env.clientSecret,
      redirect_uri: redirectUri, grant_type: "authorization_code",
    }).toString(),
  });
  if (!out || !out.access_token) throw new Error("Google did not return an access token.");
  return {
    accessToken: out.access_token,
    refreshToken: out.refresh_token || "",
    expiresAt: out.expires_in ? new Date(Date.now() + Number(out.expires_in) * 1000).toISOString() : null,
  };
}

async function gscUserEmail(accessToken) {
  try {
    const info = await httpJsonRetry(GOOGLE_USERINFO, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return (info && info.email) || "";
  } catch {
    return ""; // email scope may be absent — non-fatal
  }
}

async function gscListSites(accessToken) {
  const out = await httpJsonRetry(GSC_SITES, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return ((out && out.siteEntry) || [])
    .filter((s) => s && s.siteUrl)
    .map((s) => ({ siteUrl: s.siteUrl, permissionLevel: s.permissionLevel || "" }));
}

/** Refresh the access token when it expires within a minute. Persists the
 * rotated pair immediately — the refresh token is the long-lived secret. */
async function gscFreshToken(integration, store) {
  const creds = gscCredentials(integration);
  const fresh = creds.expiresAt && Date.parse(creds.expiresAt) > Date.now() + 60000;
  if (fresh && creds.accessToken) return creds.accessToken;
  if (!creds.refreshToken) throw new Error("The GSC connection has no refresh token — reconnect it.");
  const env = gscOAuthEnv();
  if (!env) throw new Error("Google OAuth is not configured.");
  const out = await httpJsonRetry(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: creds.refreshToken, client_id: env.clientId,
      client_secret: env.clientSecret, grant_type: "refresh_token",
    }).toString(),
  });
  if (!out || !out.access_token) throw new Error("Google token refresh failed.");
  const next = {
    accessToken: out.access_token,
    expiresAt: out.expires_in ? new Date(Date.now() + Number(out.expires_in) * 1000).toISOString() : null,
  };
  if (store && typeof store.putIntegration === "function") {
    await store.putIntegration(GSC_ID, {
      oauthAccessTokenEncrypted: ai.encryptSecret(next.accessToken, CIPHER_CONTEXT),
      oauthAccessExpiresAt: next.expiresAt,
      updatedAt: new Date().toISOString(),
    });
  }
  return next.accessToken;
}

/* ------------------------------ GSC sync ------------------------------ */

async function gscQueryRows(accessToken, siteUrl, { startDate, endDate, dimensions, startRow }) {
  const out = await httpJsonRetry(
    `${GSC_BASE}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        startDate, endDate, dimensions,
        rowLimit: GSC_ROW_LIMIT,
        startRow: startRow || 0,
        type: "web",
        dataState: "final",
      }),
      timeoutMs: 30000,
    }
  );
  return (out && out.rows) || [];
}

const shiftDays = (dateStr, days) => {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const todayStr = () => new Date().toISOString().slice(0, 10);

/**
 * Sync GSC search analytics into platform_daily. `initial` backfills
 * GSC_HISTORY_DAYS; otherwise a trailing GSC_INCREMENTAL_DAYS window is
 * re-read (late-settling data). Returns { recordsIn, window }.
 */
async function syncGsc(store) {
  const integration = await store.getIntegration(GSC_ID);
  if (!integration || integration.status !== "connected") {
    return { ok: false, error: "Google Search Console is not connected." };
  }
  const secret = await store.getIntegrationSecret(GSC_ID);
  const accessToken = await gscFreshToken({ ...integration, ...secret }, store);
  const siteUrl = (integration.meta && integration.meta.siteUrl) || "";
  if (!siteUrl) return { ok: false, error: "No GSC property selected for this connection." };

  const to = shiftDays(todayStr(), -GSC_DATA_LAG_DAYS);
  const initial = !integration.lastSyncAt;
  const from = initial
    ? shiftDays(to, -(GSC_HISTORY_DAYS - 1))
    : shiftDays(to, -(GSC_INCREMENTAL_DAYS - 1));

  let recordsIn = 0;
  for (const slice of GSC_SLICES) {
    let startRow = 0;
    for (;;) {
      const rows = await gscQueryRows(accessToken, siteUrl, {
        startDate: from, endDate: to, dimensions: slice.dimensions, startRow,
      });
      const mapped = rows.map((r) => {
        const keys = r.keys || [];
        return {
          platform: GSC_ID,
          day: String(keys[0] || "").slice(0, 10),
          sliceType: slice.sliceType,
          sliceValue: slice.dimensions.length > 1 ? String(keys[1] || "") : "",
          metric: "",
          clicks: Number(r.clicks) || 0,
          impressions: Number(r.impressions) || 0,
          ctr: r.ctr == null ? null : Number(r.ctr),
          position: r.position == null ? null : Number(r.position),
        };
      }).filter((r) => r.day);
      if (mapped.length) recordsIn += await store.platformDailyUpsert(mapped);
      if (rows.length < GSC_ROW_LIMIT || startRow + GSC_ROW_LIMIT >= GSC_MAX_ROWS_PER_SLICE) break;
      startRow += GSC_ROW_LIMIT;
    }
  }
  const now = new Date().toISOString();
  await store.putIntegration(GSC_ID, { lastSyncAt: now, lastError: "", updatedAt: now });
  return { ok: true, recordsIn, window: { from, to }, initial };
}

/* ------------------------------ Clarity ------------------------------ */

async function clarityFetch(token, numOfDays, dimensions) {
  const params = new URLSearchParams({ numOfDays: String(numOfDays) });
  (dimensions || []).forEach((d, i) => params.set(`dimension${i + 1}`, d));
  return httpJsonRetry(`${CLARITY_BASE}?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function clarityValidate(token) {
  try {
    await clarityFetch(token, 1, []);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.detail ? `Clarity rejected the token (HTTP ${e.status || "?"}).` : "Clarity could not be reached." };
  }
}

const CLARITY_KNOWN_DIMS = new Set([
  "device", "country", "os", "browser", "source", "medium", "campaign", "channel", "url", "page title", "pagetitle",
]);

const toNum = (v) => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
};

/** Clarity's variable response → long-form metric rows for platform_daily. */
function normalizeClarity(payload, sliceType, day) {
  if (!Array.isArray(payload)) return [];
  const rows = [];
  for (const group of payload) {
    if (!group || typeof group !== "object") continue;
    const info = Array.isArray(group.information) ? group.information : [];
    for (const row of info) {
      if (!row || typeof row !== "object") continue;
      // the dimension value = the row's string field that is a known dimension
      let sliceValue = "";
      for (const [k, v] of Object.entries(row)) {
        if (typeof v === "string" && (CLARITY_KNOWN_DIMS.has(k.toLowerCase()) || /^dimension[123]$/i.test(k))) {
          sliceValue = v;
          break;
        }
      }
      for (const [k, v] of Object.entries(row)) {
        const num = toNum(v);
        if (num === null) continue;
        if (CLARITY_KNOWN_DIMS.has(k.toLowerCase()) || /^dimension[123]$/i.test(k)) continue;
        rows.push({
          platform: CLARITY_ID, day, sliceType,
          sliceValue: sliceType === "overall" ? "" : sliceValue,
          metric: k, value: num,
        });
      }
    }
  }
  return rows;
}

async function syncClarity(store) {
  const integration = await store.getIntegration(CLARITY_ID);
  if (!integration || integration.status !== "connected") {
    return { ok: false, error: "Microsoft Clarity is not connected." };
  }
  const secret = await store.getIntegrationSecret(CLARITY_ID);
  const token = clarityToken(secret);
  if (!token) return { ok: false, error: "The stored Clarity token could not be read — reconnect the integration." };
  const day = todayStr();
  let recordsIn = 0;
  for (const slice of CLARITY_SLICES) {
    const payload = await clarityFetch(token, CLARITY_NUM_DAYS, slice.dimensions);
    const rows = normalizeClarity(payload, slice.sliceType, day);
    if (rows.length) recordsIn += await store.platformDailyUpsert(rows);
  }
  const now = new Date().toISOString();
  await store.putIntegration(CLARITY_ID, { lastSyncAt: now, lastError: "", updatedAt: now });
  return { ok: true, recordsIn, day, numOfDays: CLARITY_NUM_DAYS };
}

/* ------------------------------ shared ------------------------------ */

async function syncPlatform(store, platform) {
  const run = typeof store.syncRunInsert === "function"
    ? await store.syncRunInsert({ integrationId: platform, kind: "sync", status: "running", startedAt: new Date().toISOString() })
    : null;
  let result;
  try {
    result = platform === GSC_ID ? await syncGsc(store) : await syncClarity(store);
  } catch (e) {
    result = { ok: false, error: String((e && e.detail) || (e && e.message) || "sync failed").slice(0, 240) };
  }
  const now = new Date().toISOString();
  if (run && run.id != null && typeof store.syncRunUpdate === "function") {
    await store.syncRunUpdate(run.id, {
      status: result.ok ? "ok" : "error",
      recordsIn: result.recordsIn || 0,
      error: result.ok ? "" : result.error,
      finishedAt: now,
    });
  }
  if (!result.ok && typeof store.putIntegration === "function") {
    await store.putIntegration(platform, { lastError: result.error || "", updatedAt: now });
  }
  return result;
}

/** Public per-platform status — no secrets, no live external calls. */
async function platformStatus(store, platform) {
  const integration = typeof store.getIntegration === "function"
    ? await store.getIntegration(platform)
    : null;
  const connected = !!(integration && integration.status === "connected");
  let recordCount = 0;
  let dataFrom = null;
  let dataTo = null;
  if (connected && typeof store.platformDailyCount === "function") {
    recordCount = await store.platformDailyCount({ platform });
    try {
      const rows = await store.platformDailyQuery({ platform, limit: 50000 });
      for (const r of rows) {
        if (!dataFrom || r.day < dataFrom) dataFrom = r.day;
        if (!dataTo || r.day > dataTo) dataTo = r.day;
      }
    } catch { /* platform_daily not migrated on this deployment yet */ }
  }
  return {
    platform,
    connected,
    accountName: connected ? String(integration.accountName || "") : "",
    property: connected ? String((integration.meta && (integration.meta.siteUrl || integration.meta.propertyLabel)) || "") : "",
    lastSyncAt: (integration && integration.lastSyncAt) || null,
    lastError: connected ? String(integration.lastError || "") : "",
    recordCount,
    dataFrom,
    dataTo,
  };
}

module.exports = {
  GSC_ID, CLARITY_ID,
  GSC_SCOPES, GSC_HISTORY_DAYS,
  gscOAuthEnv, gscAuthUrl, gscExchangeCode, gscUserEmail, gscListSites,
  gscFreshToken, gscQueryRows, syncGsc,
  clarityValidate, clarityFetch, normalizeClarity, syncClarity,
  syncPlatform, platformStatus,
  sha256Text,
};

/* ------------------------------ report reads ------------------------------ */

const dayCount = (from, to) =>
  Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000);

/** Impression-weighted average position across a row set. */
function weightedPosition(rows) {
  let wi = 0;
  let imps = 0;
  for (const r of rows) {
    const imp = Number(r.impressions) || 0;
    if (r.position != null && imp > 0) { wi += Number(r.position) * imp; imps += imp; }
  }
  return imps ? wi / imps : null;
}

function gscTotals(rows) {
  let clicks = 0;
  let impressions = 0;
  for (const r of rows) {
    clicks += Number(r.clicks) || 0;
    impressions += Number(r.impressions) || 0;
  }
  return {
    clicks,
    impressions,
    ctr: impressions ? clicks / impressions : null,
    position: weightedPosition(rows),
  };
}

const pctDelta = (cur, prev) =>
  prev === 0 || prev == null ? (cur ? null : 0) : Math.round(((cur - prev) / Math.abs(prev)) * 1000) / 10;

/**
 * The GSC report for a range: totals + previous-period deltas + daily trend +
 * top queries/pages. All aggregation is server-side over platform_daily.
 */
async function gscReport(store, { from, to }) {
  const span = dayCount(from, to);
  const cmpTo = shiftDays(from, -1);
  const cmpFrom = shiftDays(cmpTo, -span);
  const [daily, prevDaily, queries, pages] = await Promise.all([
    store.platformDailyQuery({ platform: GSC_ID, from, to, sliceType: "date" }),
    store.platformDailyQuery({ platform: GSC_ID, from: cmpFrom, to: cmpTo, sliceType: "date" }),
    store.platformDailyQuery({ platform: GSC_ID, from, to, sliceType: "query" }),
    store.platformDailyQuery({ platform: GSC_ID, from, to, sliceType: "page" }),
  ]);
  const current = gscTotals(daily);
  const previous = gscTotals(prevDaily);
  const deltas = {
    clicks: pctDelta(current.clicks, previous.clicks),
    impressions: pctDelta(current.impressions, previous.impressions),
    ctr: current.ctr != null && previous.ctr != null && previous.ctr !== 0
      ? pctDelta(current.ctr, previous.ctr) : null,
    position: current.position != null && previous.position != null && previous.position !== 0
      ? pctDelta(current.position, previous.position) : null,
  };
  const trend = daily.map((r) => ({
    day: r.day,
    clicks: Number(r.clicks) || 0,
    impressions: Number(r.impressions) || 0,
    ctr: Number(r.impressions) ? (Number(r.clicks) || 0) / Number(r.impressions) : null,
    position: r.position,
  }));
  const rank = (rows) => {
    const byValue = new Map();
    for (const r of rows) {
      const key = r.sliceValue || "(not set)";
      if (!byValue.has(key)) byValue.set(key, []);
      byValue.get(key).push(r);
    }
    return [...byValue.entries()].map(([value, rs]) => {
      const t = gscTotals(rs);
      return { value, ...t };
    }).sort((a, b) => b.clicks - a.clicks).slice(0, 25);
  };
  return {
    from, to, cmpFrom, cmpTo,
    current, previous, deltas, trend,
    topQueries: rank(queries),
    topPages: rank(pages),
  };
}

/** Headline Clarity metrics we surface first when present (raw API keys). */
const CLARITY_HEADLINE = [
  "totalSessionCount", "totalPageViews", "avgSessionDuration", "pagesPerSession",
  "scrollDepth", "engagementTime", "rageClickCount", "deadClickCount", "quickBacks",
  "scriptErrorCount", "errorClickCount",
];

async function clarityReport(store) {
  const rows = await store.platformDailyQuery({ platform: CLARITY_ID, limit: 50000 });
  const days = [...new Set(rows.map((r) => r.day))].sort();
  const latestDay = days.length ? days[days.length - 1] : null;
  const metricMap = (day, sliceType) => {
    const out = {};
    for (const r of rows) {
      if (r.day !== day || r.sliceType !== sliceType) continue;
      out[r.metric] = (out[r.metric] || 0) + (Number(r.value) || 0);
    }
    return out;
  };
  const trend = days.map((day) => ({ day, metrics: metricMap(day, "overall") }));
  const urlRows = rows.filter((r) => r.day === latestDay && r.sliceType === "url" && /session/i.test(r.metric));
  const byUrl = new Map();
  for (const r of urlRows) {
    byUrl.set(r.sliceValue, (byUrl.get(r.sliceValue) || 0) + (Number(r.value) || 0));
  }
  const topUrls = [...byUrl.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([url, sessions]) => ({ url, sessions }));
  const deviceRows = rows.filter((r) => r.day === latestDay && r.sliceType === "device" && /session/i.test(r.metric));
  const byDevice = new Map();
  for (const r of deviceRows) {
    byDevice.set(r.sliceValue, (byDevice.get(r.sliceValue) || 0) + (Number(r.value) || 0));
  }
  const devices = [...byDevice.entries()].sort((a, b) => b[1] - a[1])
    .map(([device, sessions]) => ({ device, sessions }));
  return {
    latestDay,
    latest: latestDay ? metricMap(latestDay, "overall") : {},
    headline: CLARITY_HEADLINE,
    trend,
    topUrls,
    devices,
  };
}

module.exports.gscReport = gscReport;
module.exports.clarityReport = clarityReport;
module.exports.shiftDays = shiftDays;
module.exports.todayStr = todayStr;
