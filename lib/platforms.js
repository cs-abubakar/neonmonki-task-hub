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

const GSC_BASE = (process.env.GSC_BASE_URL || "https://searchconsole.googleapis.com/webmasters/v3").replace(/\/$/, "");
const GSC_SITES = (process.env.GSC_SITES_URL || "https://www.googleapis.com/webmasters/v3/sites").replace(/\/$/, "");
const GOOGLE_TOKEN = (process.env.GOOGLE_TOKEN_URL || "https://oauth2.googleapis.com/token").replace(/\/$/, "");
const GOOGLE_USERINFO = (process.env.GOOGLE_USERINFO_URL || "https://www.googleapis.com/oauth2/v2/userinfo").replace(/\/$/, "");
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
// The API budget is 10 calls/project/day and we use 7 — the full useful
// spectrum: overall + one dimension per call.
const CLARITY_SLICES = [
  { sliceType: "overall", dimensions: [] },
  { sliceType: "device", dimensions: ["Device"] },
  { sliceType: "country", dimensions: ["Country"] },
  { sliceType: "os", dimensions: ["OS"] },
  { sliceType: "browser", dimensions: ["Browser"] },
  { sliceType: "source", dimensions: ["Source"] },
  { sliceType: "url", dimensions: ["URL"] },
];

/** Platform Reports keeps a rolling six months — older rows are pruned. */
const RETENTION_DAYS = 183;

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
      err.phase = "timeout";
      throw err;
    }
    // Network/TLS/header failures carry no HTTP status — keep the real
    // reason so the UI can say what actually failed.
    if (e && e.status == null && !e.detail) {
      e.phase = "network";
      e.detail = `${e.name || "Error"}: ${String(e.message || "request failed").slice(0, 200)}`;
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

const GOOGLE_CONFIG_ID = "google_oauth";

/**
 * Google OAuth client config: the Control Panel-stored row wins when present
 * (super admin pastes client id + secret on the Platform Reports page); the
 * hosting env vars remain the fallback. Nothing key-shaped ever leaves the
 * server.
 */
async function googleOAuthConfig(store) {
  const clientId = String(process.env.GOOGLE_OAUTH_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.GOOGLE_OAUTH_CLIENT_SECRET || "").trim();
  if (clientId && clientSecret) return { clientId, clientSecret, source: "env" };
  if (store && typeof store.getIntegrationSecret === "function") {
    const row = await store.getIntegrationSecret(GOOGLE_CONFIG_ID);
    const storedId = String((row && row.meta && row.meta.clientId) || "").trim();
    // meta isn't in the secret projection — read the public row for the id
    let metaId = storedId;
    if (!metaId && typeof store.getIntegration === "function") {
      const pub = await store.getIntegration(GOOGLE_CONFIG_ID);
      metaId = String((pub && pub.meta && pub.meta.clientId) || "").trim();
    }
    const storedSecret = ai.decryptSecret(row && row.apiKeyEncrypted, CIPHER_CONTEXT);
    if (metaId && storedSecret) return { clientId: metaId, clientSecret: storedSecret, source: "control_panel" };
  }
  return null;
}

function gscCredentials(integration) {
  return {
    accessToken: ai.decryptSecret(integration && integration.oauthAccessTokenEncrypted, CIPHER_CONTEXT),
    refreshToken: ai.decryptSecret(integration && integration.oauthRefreshTokenEncrypted, CIPHER_CONTEXT),
    expiresAt: (integration && integration.oauthAccessExpiresAt) || null,
  };
}

/** Decrypt the token-style secret slot (apiKeyEncrypted) of a connection row. */
function secretValue(integration) {
  return ai.decryptSecret(integration && integration.apiKeyEncrypted, CIPHER_CONTEXT);
}

const sha256Text = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");

/* ------------------------------ GSC OAuth ------------------------------ */

async function gscAuthUrl(store, origin, state, extraScopes = []) {
  const cfg = await googleOAuthConfig(store);
  if (!cfg) return null;
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: `${origin}/api/platforms/gsc/oauth/callback`,
    response_type: "code",
    scope: [...new Set([...GSC_SCOPES, ...extraScopes])].join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `${GOOGLE_AUTHORIZE}?${params.toString()}`;
}

async function gscExchangeCode(store, origin, code) {
  const cfg = await googleOAuthConfig(store);
  if (!cfg) throw new Error("Google OAuth is not configured.");
  const redirectUri = `${origin}/api/platforms/gsc/oauth/callback`;
  const out = await httpJsonRetry(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code, client_id: cfg.clientId, client_secret: cfg.clientSecret,
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
 * rotated pair immediately — the refresh token is the long-lived secret.
 * `platform` is the connection row the refreshed token persists to. */
async function gscFreshToken(integration, store, platform = GSC_ID) {
  const creds = gscCredentials(integration);
  const fresh = creds.expiresAt && Date.parse(creds.expiresAt) > Date.now() + 60000;
  if (fresh && creds.accessToken) return creds.accessToken;
  if (!creds.refreshToken) throw new Error("The Google connection has no refresh token — reconnect it.");
  const cfg = await googleOAuthConfig(store);
  if (!cfg) throw new Error("Google OAuth is not configured.");
  const out = await httpJsonRetry(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: creds.refreshToken, client_id: cfg.clientId,
      client_secret: cfg.clientSecret, grant_type: "refresh_token",
    }).toString(),
  });
  if (!out || !out.access_token) throw new Error("Google token refresh failed.");
  const next = {
    accessToken: out.access_token,
    expiresAt: out.expires_in ? new Date(Date.now() + Number(out.expires_in) * 1000).toISOString() : null,
  };
  if (store && typeof store.putIntegration === "function") {
    await store.putIntegration(platform, {
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
    timeoutMs: 45000, // the API is slow when it answers; dimensionless calls never answer at all
  }, { retries: 2 });
}

async function clarityValidate(token) {
  try {
    // Validate with a dimensioned call — the real API hangs indefinitely on
    // dimensionless requests (that was the production failure), while
    // ?dimension1=Device answers in seconds.
    await clarityFetch(token, 1, ["Device"]);
    return { ok: true };
  } catch (e) {
    // Precise failure classes: an HTTP answer means the token/project is
    // wrong; a network-phase error means the API couldn't be reached at all
    // (DNS/TLS/timeout/invalid header); either way the admin sees which.
    if (e && e.status) {
      return { ok: false, error: `Clarity rejected the token (HTTP ${e.status})${e.status === 403 ? " — check that it is an active Data Export API token for the right project" : ""}.` };
    }
    const reason = (e && e.detail) || (e && e.message) || "unknown";
    return { ok: false, error: `Clarity could not be reached (${String(reason).slice(0, 160)}).` };
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
    const groupMetric = typeof group.metricName === "string" ? group.metricName : "";
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
          // group prefix matters: "subTotal" means a different count per
          // metricName — without it, six behaviour groups would merge.
          metric: `${groupMetric || "metric"}:${k}`, value: num,
        });
      }
    }
  }
  return rows;
}

// Fields that may be summed across a dimension into an "overall" row —
// percentages and averages are excluded (they belong to their slice rows).
const CLARITY_ADDITIVE_FIELDS = new Set([
  "sessionsCount", "pagesViews", "subTotal", "totalSessionCount",
  "totalBotSessionCount", "distinctUserCount", "activeTime", "totalTime",
]);

async function syncClarity(store) {
  const integration = await store.getIntegration(CLARITY_ID);
  if (!integration || integration.status !== "connected") {
    return { ok: false, error: "Microsoft Clarity is not connected." };
  }
  const secret = await store.getIntegrationSecret(CLARITY_ID);
  const token = secretValue(secret);
  if (!token) return { ok: false, error: "The stored Clarity token could not be read — reconnect the integration." };
  const day = todayStr();
  let recordsIn = 0;
  let deviceRows = [];
  let rateLimited = false;
  for (const slice of CLARITY_SLICES) {
    // The real API hangs forever on dimensionless calls — every call carries
    // a dimension; the "overall" slice is synthesized from Device below.
    if (!slice.dimensions.length) continue;
    let payload = null;
    try {
      payload = await clarityFetch(token, CLARITY_NUM_DAYS, slice.dimensions);
    } catch (e) {
      // Clarity's 10 calls/day budget: stop calling, keep what landed.
      if (e && e.status === 429) { rateLimited = true; break; }
      throw e;
    }
    const rows = normalizeClarity(payload, slice.sliceType, day);
    if (slice.sliceType === "device") deviceRows = rows;
    if (rows.length) recordsIn += await store.platformDailyUpsert(rows);
  }
  // Synthesize the overall slice from the Device rows (additive fields only).
  if (deviceRows.length) {
    const totals = new Map();
    for (const r of deviceRows) {
      const field = String(r.metric).split(":")[1] || "";
      if (!CLARITY_ADDITIVE_FIELDS.has(field)) continue;
      totals.set(r.metric, (totals.get(r.metric) || 0) + (Number(r.value) || 0));
    }
    const overallRows = [...totals.entries()].map(([metric, value]) => ({
      platform: CLARITY_ID, day, sliceType: "overall", sliceValue: "", metric, value,
    }));
    if (overallRows.length) recordsIn += await store.platformDailyUpsert(overallRows);
  }
  const now = new Date().toISOString();
  await store.putIntegration(CLARITY_ID, {
    lastSyncAt: now,
    // a partial day is not an error state — the next daily run tops it up
    lastError: rateLimited ? "rate_limited" : "",
    updatedAt: now,
  });
  return { ok: true, recordsIn, day, numOfDays: CLARITY_NUM_DAYS, partial: rateLimited };
}

/* ------------------------------ shared ------------------------------ */

async function syncPlatform(store, platform) {
  const syncer = SYNCERS[platform];
  if (!syncer) return { ok: false, error: "Unknown platform." };
  const run = typeof store.syncRunInsert === "function"
    ? await store.syncRunInsert({ integrationId: platform, kind: "sync", status: "running", startedAt: new Date().toISOString() })
    : null;
  let result;
  try {
    result = await syncer(store);
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
  // Rolling six-month retention: every sync prunes rows older than the window.
  let pruned = 0;
  if (result.ok && typeof store.platformDailyPrune === "function") {
    try {
      pruned = await store.platformDailyPrune({ beforeDay: shiftDays(todayStr(), -RETENTION_DAYS) });
    } catch { /* retention must never fail a sync */ }
  }
  return { ...result, pruned };
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
  gscAuthUrl, gscExchangeCode, gscUserEmail, gscListSites,
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
  "Traffic:totalSessionCount", "Traffic:distinctUserCount", "Traffic:pagesPerSessionPercentage",
  "DeadClickCount:subTotal", "RageClickCount:subTotal", "QuickbackClick:subTotal",
  "ErrorClickCount:subTotal", "ScriptErrorCount:subTotal", "ExcessiveScroll:subTotal",
  "ScrollDepth:averageScrollDepth", "EngagementTime:activeTime",
];

/** Dimension tables for the latest snapshot day: per slice, the values with
 * every recorded metric (top 25 by session volume). */
function clarityDimensionTables(rows, day) {
  const tables = {};
  for (const sliceType of ["device", "country", "os", "browser", "source", "url"]) {
    const sliceRows = rows.filter((r) => r.day === day && r.sliceType === sliceType);
    const byValue = new Map();
    for (const r of sliceRows) {
      const key = r.sliceValue || "(not set)";
      if (!byValue.has(key)) byValue.set(key, {});
      const g = byValue.get(key);
      g[r.metric] = (g[r.metric] || 0) + (Number(r.value) || 0);
    }
    const sessionMetricOf = (metrics) =>
      metrics["Traffic:totalSessionCount"] ?? metrics.sessions ?? metrics.totalSessions ?? 0;
    tables[sliceType] = [...byValue.entries()]
      .map(([value, metrics]) => ({ value, metrics, _sessions: sessionMetricOf(metrics) }))
      .sort((a, b) => b._sessions - a._sessions)
      .slice(0, 25)
      .map(({ value, metrics }) => ({ value, metrics }));
  }
  return tables;
}

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
  // every metric name observed, most-used first
  const catalog = [...new Set(rows.filter((r) => r.sliceType === "overall").map((r) => r.metric))];
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
    metricCatalog: catalog,
    trend,
    topUrls,
    devices,
    dimensions: latestDay ? clarityDimensionTables(rows, latestDay) : {},
  };
}

/**
 * The Clarity explorer: one metric over one dimension across a day range —
 * per day, the top values for that dimension. This powers the "analyze the
 * data by any filter" view.
 */
async function clarityExplore(store, { from, to, dim, metric }) {
  const sliceType = ["device", "country", "os", "browser", "source", "url"].includes(dim) ? dim : "url";
  const metricName = String(metric || "totalSessionCount").slice(0, 120);
  const rows = await store.platformDailyQuery({ platform: CLARITY_ID, from, to, sliceType, limit: 50000 });
  const filtered = rows.filter((r) => r.metric === metricName);
  // top 10 values by total across the range
  const totals = new Map();
  for (const r of filtered) totals.set(r.sliceValue, (totals.get(r.sliceValue) || 0) + (Number(r.value) || 0));
  const topValues = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([v]) => v);
  const byDay = new Map();
  for (const r of filtered) {
    if (!topValues.includes(r.sliceValue)) continue;
    if (!byDay.has(r.day)) byDay.set(r.day, {});
    byDay.get(r.day)[r.sliceValue] = (byDay.get(r.day)[r.sliceValue] || 0) + (Number(r.value) || 0);
  }
  const series = [...byDay.keys()].sort().map((day) => ({ day, values: byDay.get(day) }));
  return { from, to, dim: sliceType, metric: metricName, values: topValues, series };
}

module.exports.gscReport = gscReport;
module.exports.clarityReport = clarityReport;
module.exports.clarityExplore = clarityExplore;
module.exports.shiftDays = shiftDays;
module.exports.todayStr = todayStr;

/* ============================== GA4 ============================== */

const GA4_ID = "ga4";
const GA4_SCOPE = "https://www.googleapis.com/auth/analytics.readonly";
const GA4_ADMIN_BASE = (process.env.GA4_ADMIN_BASE_URL || "https://analyticsadmin.googleapis.com/v1beta").replace(/\/$/, "");
const GA4_DATA_BASE = (process.env.GA4_DATA_BASE_URL || "https://analyticsdata.googleapis.com/v1beta").replace(/\/$/, "");
const GA4_METRICS = ["sessions", "totalUsers", "conversions", "newUsers"];

async function ga4ListProperties(accessToken) {
  const out = await httpJsonRetry(`${GA4_ADMIN_BASE}/accountSummaries?pageSize=200`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const props = [];
  for (const acc of (out && out.accountSummaries) || []) {
    for (const p of acc.propertySummaries || []) {
      if (p && p.property && p.displayName) {
        props.push({ propertyId: String(p.property).replace(/^properties\//, ""), displayName: p.displayName, account: acc.displayName || "" });
      }
    }
  }
  return props;
}

async function ga4RunReport(accessToken, propertyId, { from, to, dimensions = [], metrics = GA4_METRICS }) {
  const out = await httpJsonRetry(`${GA4_DATA_BASE}/properties/${encodeURIComponent(propertyId)}:runReport`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      dateRanges: [{ startDate: from, endDate: to }],
      dimensions: dimensions.map((name) => ({ name })),
      metrics: metrics.map((name) => ({ name })),
    }),
    timeoutMs: 30000,
  });
  return out || {};
}

/** GA4 → platform_daily. Slices: date (totals) + channel (sessionDefaultChannelGroup). */
async function syncGa4(store) {
  const integration = await store.getIntegration(GA4_ID);
  if (!integration || integration.status !== "connected") {
    return { ok: false, error: "Google Analytics 4 is not connected." };
  }
  const secret = await store.getIntegrationSecret(GA4_ID);
  const accessToken = await gscFreshToken({ ...integration, ...secret }, store, GA4_ID);
  const propertyId = (integration.meta && integration.meta.propertyId) || "";
  if (!propertyId) return { ok: false, error: "No GA4 property selected for this connection." };

  const to = todayStr();
  const initial = !integration.lastSyncAt;
  const from = initial ? shiftDays(to, -(GSC_HISTORY_DAYS - 1)) : shiftDays(to, -6);
  let recordsIn = 0;

  const rows = [];
  const daily = await ga4RunReport(accessToken, propertyId, { from, to, dimensions: ["date"] });
  for (const r of daily.rows || []) {
    const day = String((((r.dimensionValues || [])[0] || {}).value) || "");
    const iso = day.length === 8 ? `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}` : "";
    if (!iso) continue;
    (r.metricValues || []).forEach((m, i) => {
      rows.push({
        platform: GA4_ID, day: iso, sliceType: "date", sliceValue: "",
        metric: GA4_METRICS[i], value: Number(m.value) || 0,
      });
    });
  }
  const byChannel = await ga4RunReport(accessToken, propertyId, {
    from, to, dimensions: ["date", "sessionDefaultChannelGroup"],
  });
  for (const r of byChannel.rows || []) {
    const day = String((((r.dimensionValues || [])[0] || {}).value) || "");
    const iso = day.length === 8 ? `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}` : "";
    const channel = String((((r.dimensionValues || [])[1] || {}).value) || "Other");
    if (!iso) continue;
    (r.metricValues || []).forEach((m, i) => {
      rows.push({
        platform: GA4_ID, day: iso, sliceType: "channel", sliceValue: channel,
        metric: GA4_METRICS[i], value: Number(m.value) || 0,
      });
    });
  }
  if (rows.length) recordsIn = await store.platformDailyUpsert(rows);
  const now = new Date().toISOString();
  await store.putIntegration(GA4_ID, { lastSyncAt: now, lastError: "", updatedAt: now });
  return { ok: true, recordsIn, window: { from, to }, initial };
}

/* ============================== Google Ads ============================== */

const GOOGLE_ADS_ID = "google_ads";
const GOOGLE_ADS_SCOPE = "https://www.googleapis.com/auth/adwords";
const GOOGLE_ADS_BASE = (process.env.GOOGLE_ADS_BASE_URL || "https://googleads.googleapis.com/v19").replace(/\/$/, "");
const ADS_METRICS = ["spend", "clicks", "impressions", "conversions", "conversionsValue"];

async function googleAdsQuery(accessToken, developerToken, customerId, query) {
  const out = await httpJsonRetry(
    `${GOOGLE_ADS_BASE}/customers/${encodeURIComponent(customerId)}/googleAds:searchStream`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "developer-token": developerToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
      timeoutMs: 30000,
    }
  );
  // searchStream answers an array of batches, each with results[]
  const results = [];
  for (const batch of Array.isArray(out) ? out : []) {
    for (const r of batch.results || []) results.push(r);
  }
  return results;
}

const adsCustomerId = (value) => String(value || "").replace(/[^\d]/g, "");

/** Google Ads → platform_daily. Slices: date (account totals) + campaign. */
async function syncGoogleAds(store) {
  const integration = await store.getIntegration(GOOGLE_ADS_ID);
  if (!integration || integration.status !== "connected") {
    return { ok: false, error: "Google Ads is not connected." };
  }
  const secret = await store.getIntegrationSecret(GOOGLE_ADS_ID);
  const developerToken = secretValue(secret);
  if (!developerToken) return { ok: false, error: "The stored developer token could not be read — reconnect Google Ads." };
  const customerId = adsCustomerId(integration.meta && integration.meta.customerId);
  if (!customerId) return { ok: false, error: "No Google Ads customer ID stored — reconnect Google Ads." };
  const accessToken = await gscFreshToken({ ...integration, ...secret }, store, GOOGLE_ADS_ID);

  const to = todayStr();
  const initial = !integration.lastSyncAt;
  const from = initial ? shiftDays(to, -(GSC_HISTORY_DAYS - 1)) : shiftDays(to, -6);
  const results = await googleAdsQuery(accessToken, developerToken, customerId, `
    SELECT segments.date, campaign.name, metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions, metrics.conversions_value
    FROM campaign WHERE segments.date BETWEEN '${from}' AND '${to}'
  `);

  const rows = [];
  const perDay = new Map();
  for (const r of results) {
    const day = String(r.segments && r.segments.date || "");
    const campaign = String(r.campaign && r.campaign.name || "(unknown)");
    if (!day) continue;
    const m = r.metrics || {};
    const vals = {
      spend: (Number(m.cost_micros) || 0) / 1e6,
      clicks: Number(m.clicks) || 0,
      impressions: Number(m.impressions) || 0,
      conversions: Number(m.conversions) || 0,
      conversionsValue: Number(m.conversions_value) || 0,
    };
    for (const [metric, value] of Object.entries(vals)) {
      rows.push({ platform: GOOGLE_ADS_ID, day, sliceType: "campaign", sliceValue: campaign, metric, value });
    }
    if (!perDay.has(day)) perDay.set(day, { spend: 0, clicks: 0, impressions: 0, conversions: 0, conversionsValue: 0 });
    const agg = perDay.get(day);
    for (const k of Object.keys(agg)) agg[k] += vals[k];
  }
  for (const [day, vals] of perDay) {
    for (const [metric, value] of Object.entries(vals)) {
      rows.push({ platform: GOOGLE_ADS_ID, day, sliceType: "date", sliceValue: "", metric, value });
    }
  }
  let recordsIn = 0;
  if (rows.length) recordsIn = await store.platformDailyUpsert(rows);
  const now = new Date().toISOString();
  await store.putIntegration(GOOGLE_ADS_ID, { lastSyncAt: now, lastError: "", updatedAt: now });
  return { ok: true, recordsIn, window: { from, to }, initial };
}

/* ============================== Meta Ads ============================== */

const META_ADS_ID = "meta_ads";
const META_BASE = (process.env.META_GRAPH_BASE_URL || "https://graph.facebook.com/v21.0").replace(/\/$/, "");
const META_METRICS = ["spend", "clicks", "impressions", "purchases"];

const metaAdAccount = (value) => String(value || "").trim().replace(/^act_?/i, "");

async function metaGet(accessToken, path) {
  const sep = path.includes("?") ? "&" : "?";
  return httpJsonRetry(`${META_BASE}${path}${sep}access_token=${encodeURIComponent(accessToken)}`, { timeoutMs: 30000 });
}

async function metaValidate(token, adAccountId) {
  try {
    await metaGet(token, `/act_${adAccountId}?fields=name,currency`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `Meta rejected the token or ad account (HTTP ${e.status || "?"}).` };
  }
}

/** Meta Ads → platform_daily. Slices: date (account totals) + campaign. */
async function syncMetaAds(store) {
  const integration = await store.getIntegration(META_ADS_ID);
  if (!integration || integration.status !== "connected") {
    return { ok: false, error: "Meta Ads is not connected." };
  }
  const secret = await store.getIntegrationSecret(META_ADS_ID);
  const token = secretValue({ apiKeyEncrypted: secret && secret.apiKeyEncrypted });
  if (!token) return { ok: false, error: "The stored Meta token could not be read — reconnect Meta Ads." };
  const adAccountId = metaAdAccount(integration.meta && integration.meta.adAccountId);
  if (!adAccountId) return { ok: false, error: "No Meta ad account stored — reconnect Meta Ads." };

  const to = todayStr();
  const initial = !integration.lastSyncAt;
  const from = initial ? shiftDays(to, -(GSC_HISTORY_DAYS - 1)) : shiftDays(to, -6);
  const out = await metaGet(token,
    `/act_${adAccountId}/insights?level=campaign&time_increment=1`
    + `&time_range=${encodeURIComponent(JSON.stringify({ since: from, until: to }))}`
    + `&fields=spend,impressions,clicks,actions,campaign_name&limit=500`);

  const rows = [];
  const perDay = new Map();
  for (const r of (out && out.data) || []) {
    const day = String(r.date_start || "");
    if (!day) continue;
    const campaign = String(r.campaign_name || "(unknown)");
    const purchases = ((r.actions || []).find((a) => a.action_type === "purchase" || a.action_type === "omni_purchase") || {}).value;
    const vals = {
      spend: Number(r.spend) || 0,
      clicks: Number(r.clicks) || 0,
      impressions: Number(r.impressions) || 0,
      purchases: Number(purchases) || 0,
    };
    for (const [metric, value] of Object.entries(vals)) {
      rows.push({ platform: META_ADS_ID, day, sliceType: "campaign", sliceValue: campaign, metric, value });
    }
    if (!perDay.has(day)) perDay.set(day, { spend: 0, clicks: 0, impressions: 0, purchases: 0 });
    const agg = perDay.get(day);
    for (const k of Object.keys(agg)) agg[k] += vals[k];
  }
  for (const [day, vals] of perDay) {
    for (const [metric, value] of Object.entries(vals)) {
      rows.push({ platform: META_ADS_ID, day, sliceType: "date", sliceValue: "", metric, value });
    }
  }
  let recordsIn = 0;
  if (rows.length) recordsIn = await store.platformDailyUpsert(rows);
  const now = new Date().toISOString();
  await store.putIntegration(META_ADS_ID, { lastSyncAt: now, lastError: "", updatedAt: now });
  return { ok: true, recordsIn, window: { from, to }, initial };
}

/* ============================== Salesforce ============================== */

const SALESFORCE_ID = "salesforce";
const SF_API_VERSION = "v61.0";
// Test hook: route Salesforce calls at a stub when set (never set in prod).
const SF_BASE_OVERRIDE = (process.env.SALESFORCE_BASE_URL || "").replace(/\/$/, "");

async function salesforceToken(instanceUrl, clientId, clientSecret) {
  const base = SF_BASE_OVERRIDE || instanceUrl.replace(/\/$/, "");
  const out = await httpJsonRetry(`${base}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret,
    }).toString(),
  });
  if (!out || !out.access_token) throw new Error("Salesforce did not return an access token.");
  return out;
}

async function salesforceQuery(instanceUrl, accessToken, soql) {
  const base = SF_BASE_OVERRIDE || instanceUrl.replace(/\/$/, "");
  return httpJsonRetry(
    `${base}/services/data/${SF_API_VERSION}/query?q=${encodeURIComponent(soql)}`,
    { headers: { Authorization: `Bearer ${accessToken}` }, timeoutMs: 30000 }
  );
}

/** Salesforce → platform_daily. Slice: date — leads created, opportunities
 * closing, pipeline + won value. */
async function syncSalesforce(store) {
  const integration = await store.getIntegration(SALESFORCE_ID);
  if (!integration || integration.status !== "connected") {
    return { ok: false, error: "Salesforce is not connected." };
  }
  const secret = await store.getIntegrationSecret(SALESFORCE_ID);
  const clientSecret = secretValue({ apiKeyEncrypted: secret && secret.apiKeyEncrypted });
  const instanceUrl = String((integration.meta && integration.meta.instanceUrl) || "");
  const clientId = String((integration.meta && integration.meta.clientId) || "");
  if (!clientSecret || !instanceUrl || !clientId) {
    return { ok: false, error: "The stored Salesforce credentials could not be read — reconnect Salesforce." };
  }
  const token = await salesforceToken(instanceUrl, clientId, clientSecret);

  const to = todayStr();
  const initial = !integration.lastSyncAt;
  const from = initial ? shiftDays(to, -(GSC_HISTORY_DAYS - 1)) : shiftDays(to, -6);
  const rows = [];
  const push = (day, metric, value) => {
    if (day) rows.push({ platform: SALESFORCE_ID, day, sliceType: "date", sliceValue: "", metric, value: Number(value) || 0 });
  };

  const leads = await salesforceQuery(instanceUrl, token.access_token,
    `SELECT DAY_ONLY(CreatedDate) d, COUNT(Id) c FROM Lead WHERE CreatedDate >= ${from}T00:00:00Z AND CreatedDate <= ${to}T23:59:59Z GROUP BY DAY_ONLY(CreatedDate)`);
  for (const r of (leads && leads.records) || []) push(r.d, "leads", r.c);

  const opps = await salesforceQuery(instanceUrl, token.access_token,
    `SELECT CloseDate, Amount, IsWon FROM Opportunity WHERE CloseDate >= ${from} AND CloseDate <= ${to}`);
  const perDay = new Map();
  for (const r of (opps && opps.records) || []) {
    const day = String(r.CloseDate || "");
    if (!day) continue;
    if (!perDay.has(day)) perDay.set(day, { opportunities: 0, pipelineValue: 0, wonValue: 0 });
    const agg = perDay.get(day);
    agg.opportunities += 1;
    if (r.IsWon) agg.wonValue += Number(r.Amount) || 0;
    else agg.pipelineValue += Number(r.Amount) || 0;
  }
  for (const [day, agg] of perDay) {
    push(day, "opportunities", agg.opportunities);
    push(day, "pipelineValue", agg.pipelineValue);
    push(day, "wonValue", agg.wonValue);
  }

  let recordsIn = 0;
  if (rows.length) recordsIn = await store.platformDailyUpsert(rows);
  const now = new Date().toISOString();
  await store.putIntegration(SALESFORCE_ID, { lastSyncAt: now, lastError: "", updatedAt: now });
  return { ok: true, recordsIn, window: { from, to }, initial };
}

/* ============================== generic metric reports ============================== */

/**
 * Pivot metric-based platforms (ga4, google_ads, meta_ads, salesforce) into a
 * report: per-metric totals + previous-period deltas, daily trend, and a
 * breakdown by the given slice type (channel/campaign). All aggregation is
 * server-side; ratio metrics are computed from totals at read time.
 */
async function metricReport(store, platform, { from, to }, { metrics, breakdown = "channel", primary = null, money = [] }) {
  const span = dayCount(from, to);
  const cmpTo = shiftDays(from, -1);
  const cmpFrom = shiftDays(cmpTo, -span);
  const [daily, prevDaily, breakdownRows] = await Promise.all([
    store.platformDailyQuery({ platform, from, to, sliceType: "date" }),
    store.platformDailyQuery({ platform, from: cmpFrom, to: cmpTo, sliceType: "date" }),
    store.platformDailyQuery({ platform, from, to, sliceType: breakdown }),
  ]);

  const pivot = (rows) => {
    const byDay = new Map();
    for (const r of rows) {
      if (!byDay.has(r.day)) byDay.set(r.day, {});
      const d = byDay.get(r.day);
      d[r.metric] = (d[r.metric] || 0) + (Number(r.value) || 0);
    }
    return byDay;
  };
  const totals = (byDay) => {
    const out = {};
    for (const m of metrics) out[m] = 0;
    for (const d of byDay.values()) for (const m of metrics) out[m] += d[m] || 0;
    return out;
  };

  const curByDay = pivot(daily);
  const prevByDay = pivot(prevDaily);
  const current = totals(curByDay);
  const previous = totals(prevByDay);
  const deltas = {};
  for (const m of metrics) deltas[m] = pctDelta(current[m], previous[m]);

  const days = [...curByDay.keys()].sort();
  const trend = days.map((day) => ({ day, ...curByDay.get(day) }));

  const byValue = new Map();
  for (const r of breakdownRows) {
    const key = r.sliceValue || "(not set)";
    if (!byValue.has(key)) byValue.set(key, {});
    const g = byValue.get(key);
    g[r.metric] = (g[r.metric] || 0) + (Number(r.value) || 0);
  }
  const primaryMetric = primary || metrics[0];
  const breakdownTable = [...byValue.entries()]
    .map(([value, vals]) => ({ value, ...vals }))
    .sort((a, b) => (b[primaryMetric] || 0) - (a[primaryMetric] || 0))
    .slice(0, 25);

  return {
    from, to, cmpFrom, cmpTo, metrics, money,
    current, previous, deltas, trend, breakdown: breakdownTable,
    primary: primaryMetric,
  };
}

const PLATFORM_REPORT_SPECS = {
  [GA4_ID]: { metrics: GA4_METRICS, breakdown: "channel", primary: "sessions" },
  [GOOGLE_ADS_ID]: { metrics: ADS_METRICS, breakdown: "campaign", primary: "spend", money: ["spend", "conversionsValue"] },
  [META_ADS_ID]: { metrics: META_METRICS, breakdown: "campaign", primary: "spend", money: ["spend"] },
  [SALESFORCE_ID]: { metrics: ["leads", "opportunities", "pipelineValue", "wonValue"], breakdown: "date", primary: "leads", money: ["pipelineValue", "wonValue"] },
};

function platformReportSpec(platform) {
  return PLATFORM_REPORT_SPECS[platform] || null;
}

/* ============================== dispatcher ============================== */

const SYNCERS = {
  [GSC_ID]: syncGsc,
  [CLARITY_ID]: syncClarity,
  [GA4_ID]: syncGa4,
  [GOOGLE_ADS_ID]: syncGoogleAds,
  [META_ADS_ID]: syncMetaAds,
  [SALESFORCE_ID]: syncSalesforce,
};

const PLATFORM_IDS = Object.keys(SYNCERS);

module.exports.GA4_ID = GA4_ID;
module.exports.GOOGLE_ADS_ID = GOOGLE_ADS_ID;
module.exports.META_ADS_ID = META_ADS_ID;
module.exports.SALESFORCE_ID = SALESFORCE_ID;
module.exports.GOOGLE_CONFIG_ID = GOOGLE_CONFIG_ID;
module.exports.GA4_SCOPE = GA4_SCOPE;
module.exports.GOOGLE_ADS_SCOPE = GOOGLE_ADS_SCOPE;
module.exports.PLATFORM_IDS = PLATFORM_IDS;
module.exports.SYNCERS = SYNCERS;
module.exports.googleOAuthConfig = googleOAuthConfig;
module.exports.ga4ListProperties = ga4ListProperties;
module.exports.ga4RunReport = ga4RunReport;
module.exports.syncGa4 = syncGa4;
module.exports.syncGoogleAds = syncGoogleAds;
module.exports.googleAdsQuery = googleAdsQuery;
module.exports.adsCustomerId = adsCustomerId;
module.exports.syncMetaAds = syncMetaAds;
module.exports.metaValidate = metaValidate;
module.exports.metaAdAccount = metaAdAccount;
module.exports.salesforceToken = salesforceToken;
module.exports.salesforceQuery = salesforceQuery;
module.exports.syncSalesforce = syncSalesforce;
module.exports.metricReport = metricReport;
module.exports.platformReportSpec = platformReportSpec;
module.exports.secretValue = secretValue;

module.exports.RETENTION_DAYS = RETENTION_DAYS;
