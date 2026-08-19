/**
 * NEONMONKI Task Hub — API route handler, shared by:
 *   - server.js          (local dev, zero-setup JSON storage)
 *   - api/[...all].js    (Vercel serverless function, Supabase storage)
 *
 * Auth: database users (see lib/bootstrap.js for the seeded set; the super
 * admin creates more from the Admin page). Login issues a stateless
 * HMAC-signed httpOnly cookie carrying the username; role/name/active are
 * re-read from the store on every request, so admin changes apply instantly.
 */
"use strict";

require("./env");
const crypto = require("crypto");
const { getStore } = require("./store");
const { hashPassword } = require("./bootstrap");
const {
  memberOf,
  canAccessChannel,
  accessibleChannels,
  canSeeTask,
  visibleTasks,
  visibleLinks,
  reportingAccess,
  canUseSmartReporting,
} = require("./permissions");
const {
  departmentId,
  normalizeDepartment,
  encodeDepartmentIds,
  decodeDepartmentIds,
  ownerNames,
  encodeTaskSource,
  enrichTask,
  composeTaskEvents,
  encodeTaskEvent,
  encodeFileMeta,
  parseFileMeta,
} = require("./task-system");
const {
  encodeChatText,
  hydrateChatMessage,
  encodedChatMessageText,
} = require("./chat-system");
const ai = require("./ai");

const rec = (type, id, text) => `<record type="${type}" id="${id}">${text}</record>`;

/** Resolve global + per-user AI policy into one backend authorization decision. */
async function aiPolicy(store, me, feature, { enforceLimit = true } = {}) {
  const [settings, permission, callsToday] = await Promise.all([
    store.getAiSettings(),
    store.getAiUserPermission(me.username),
    store.aiCallsToday(me.username),
  ]);
  const dailyLimit = permission.dailyLimit == null ? settings.dailyLimit : permission.dailyLimit;
  const allowedTools = ai.allowedToolNames(permission.tools, me.role, {
    smartReporting: canUseSmartReporting(me, permission),
  });
  let blocked = null;
  if (!settings.enabled) blocked = { status: 503, error: "AI is currently disabled by the super admin." };
  else if (me.role === "client" && !settings.allowClient) blocked = { status: 403, error: "AI is not enabled for Adika's NEONMONKI account." };
  else if (permission.enabled === false) blocked = { status: 403, error: "AI access is disabled for this user." };
  else if (feature && settings.features && settings.features[feature] === false) blocked = { status: 403, error: "This AI feature is disabled." };
  else if (enforceLimit && callsToday >= dailyLimit) {
    blocked = { status: 429, error: `Daily AI limit reached (${dailyLimit}). Ask the super admin to raise it.` };
  }
  return {
    allowed: !blocked,
    blocked,
    settings,
    permission,
    callsToday,
    dailyLimit,
    allowedTools,
  };
}

const STATUSES = [
  "New Request", "Backlog", "Planned", "In Progress", "Ready / Waiting",
  "Waiting on Client", "Waiting on Internal", "Waiting on External",
  "Ready for Review", "Revision Required", "Completed", "Cancelled",
];
const PRIORITIES = ["Critical", "High", "Medium", "Low"];
const ROLES = ["super_admin", "team", "client"];

const SESSION_TTL = 14 * 24 * 3600 * 1000;
const SECRET = () =>
  process.env.SESSION_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || "nm-task-hub-dev-secret";

if (!process.env.SESSION_SECRET && !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.warn(
    "[task-hub] WARNING: SESSION_SECRET is not set — signing sessions with the built-in " +
    "development secret. Set SESSION_SECRET (a long random string) before deploying."
  );
}

const isTeamRole = (role) => role === "team" || role === "super_admin";
const isAssignableUser = (user) => user && user.username !== "advertidea" && isTeamRole(user.role);

// The client (Adika) drives the review handshake only.
const CLIENT_TRANSITIONS = {
  "Ready for Review": ["Completed", "Revision Required"],
  "Waiting on Client": ["In Progress"],
};
const clientStatusAllowed = (task, next) =>
  (CLIENT_TRANSITIONS[task.status] || []).includes(next);

/* ------------------------------ stateless sessions ------------------------------ */

const b64u = (buf) => Buffer.from(buf).toString("base64url");

function sign(payload) {
  return crypto.createHmac("sha256", SECRET()).update(payload).digest("base64url");
}

function makeToken(username) {
  const payload = b64u(JSON.stringify({ u: username, exp: Date.now() + SESSION_TTL }));
  return `${payload}.${sign(payload)}`;
}

function readToken(token) {
  if (!token || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return null;
  const [payload, sig] = token.split(".");
  const expected = sign(payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return null;
  }
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!data.exp || data.exp < Date.now()) return null;
    return data.u || null;
  } catch {
    return null;
  }
}

/** Resolve the session cookie to a fresh, active user record (or null). */
async function getAuth(req, store) {
  const cookie = req.headers.cookie || "";
  const m = cookie.match(/(?:^|;\s*)nm_session=([A-Za-z0-9_.-]+)/);
  const username = m && readToken(m[1]);
  if (!username) return null;
  const user = await store.getUser(username);
  if (!user || !user.active) return null;
  return user;
}

function secureCookie(req) {
  const proto = req.headers["x-forwarded-proto"];
  const https = proto ? proto === "https" : !!process.env.VERCEL;
  return https ? "; Secure" : "";
}

/* ------------------------------ http helpers ------------------------------ */

function send(res, status, body, headers = {}) {
  const isObj = typeof body === "object" && body !== null;
  res.writeHead(status, {
    "Content-Type": isObj ? "application/json; charset=utf-8" : "text/plain; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(isObj ? JSON.stringify(body) : body);
}

function sharedLink(value) {
  const raw = clean(value, 1500);
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "https:" ? parsed.toString() : "";
  } catch {
    return "";
  }
}

function sendLegacyDownload(res, dataUrl, filename) {
  const match = String(dataUrl || "").match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/);
  if (!match) return false;
  const safeName = String(filename || "download").replace(/[\r\n"\\/]/g, "_").slice(0, 180);
  const data = Buffer.from(match[2], "base64");
  res.writeHead(200, {
    "Content-Type": match[1],
    "Content-Length": data.length,
    "Content-Disposition": `attachment; filename="${safeName}"`,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
  });
  res.end(data);
  return true;
}

function readBody(req) {
  // Vercel pre-parses JSON bodies into req.body (the getter throws on malformed
  // JSON); local server gives a stream.
  let pre;
  try { pre = req.body; } catch { return Promise.reject(new Error("invalid JSON")); }
  if (pre && typeof pre === "object") return Promise.resolve(pre);
  if (typeof pre === "string") {
    try { return Promise.resolve(JSON.parse(pre)); }
    catch { return Promise.reject(new Error("invalid JSON")); }
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    const fail = (e) => { if (!settled) { settled = true; reject(e); } };
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    req.on("data", (c) => {
      size += c.length;
      if (size > 4_000_000) {
        // Reject once, then keep draining (without buffering) so the 400
        // response is delivered on a live socket. Do NOT req.destroy() here.
        fail(new Error("body too large"));
        return;
      }
      if (!settled) chunks.push(c);
    });
    req.on("end", () => {
      if (settled) return;
      if (!chunks.length) return done({});
      try { done(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { fail(new Error("invalid JSON")); }
    });
    req.on("error", () => fail(new Error("request failed")));
  });
}

const clean = (v, max = 2000) => String(v == null ? "" : v).trim().slice(0, max);
const oneOf = (v, list, fallback) => (list.includes(v) ? v : fallback);
const uniqueStrings = (values, max = 50) => [...new Set(
  (Array.isArray(values) ? values : []).map((v) => clean(v, max)).filter(Boolean)
)];

/* ------------------------------ reporting helpers ------------------------------ */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const todayStr = () => new Date().toISOString().slice(0, 10);

function shiftDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Strict YYYY-MM-DD calendar-day check (rejects 2026-13-99 and friends). */
function validDay(d) {
  if (!DATE_RE.test(d)) return false;
  const t = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
}

const dayCount = (from, to) =>
  Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000);

/** Sum metric values per channel + metric name. */
function aggregateMetrics(entries) {
  const channels = {};
  for (const e of entries) {
    const channel = (channels[e.channel] = channels[e.channel] || {});
    channel[e.metric] = (channel[e.metric] || 0) + e.value;
  }
  return channels;
}

/**
 * Compare two entry sets: { channels: { name: { metric: { current, previous, deltaPct } } } }.
 * deltaPct is null when there is no previous baseline to compare against.
 */
function metricsSummary(currentEntries, previousEntries) {
  const current = aggregateMetrics(currentEntries);
  const previous = aggregateMetrics(previousEntries);
  const channels = {};
  for (const name of new Set([...Object.keys(current), ...Object.keys(previous)])) {
    const cur = current[name] || {};
    const prev = previous[name] || {};
    const out = {};
    for (const metric of new Set([...Object.keys(cur), ...Object.keys(prev)])) {
      const c = cur[metric] || 0;
      const p = prev[metric] || 0;
      out[metric] = {
        current: c,
        previous: p,
        deltaPct: p === 0 ? (c === 0 ? 0 : null) : Math.round(((c - p) / Math.abs(p)) * 1000) / 10,
      };
    }
    channels[name] = out;
  }
  return channels;
}

/* ------------------------------ smart reporting ------------------------------ */

const HYROS_INTEGRATION_ID = "hyros";
const HYROS_CIPHER_CONTEXT = "neonmonki-task-hub:hyros-api-key:v1";
const SMART_REPORTING_ERROR = "Smart Reporting is currently limited to the workspace owner.";

// lib/reporting.js + lib/hyros.js are the reporting data layer. Loaded lazily
// so the rest of the API keeps working on deployments where that layer is not
// merged yet — reporting routes answer 503 in that case.
function reportingModule() {
  try { return require("./reporting"); } catch { return null; }
}

function hyrosModule() {
  try { return require("./hyros"); } catch { return null; }
}

/**
 * Smart Reporting gate for HTTP routes: 401 signed out, 403 for everyone who
 * is not the workspace owner (or an explicitly granted future user). Returns
 * the authed user when allowed; otherwise the response is already sent.
 */
async function smartReportingUser(req, res, store) {
  const me = await getAuth(req, store);
  if (!me) { send(res, 401, { error: "Not signed in." }); return null; }
  const permission = typeof store.getAiUserPermission === "function"
    ? await store.getAiUserPermission(me.username)
    : null;
  if (!canUseSmartReporting(me, permission)) {
    send(res, 403, { error: SMART_REPORTING_ERROR });
    return null;
  }
  return me;
}

/**
 * Performance (basic reporting) gate for HTTP routes: 401 signed out, 403 only
 * when the user's reporting tier is "none" — both "basic" and "full" tiers may
 * read the calm, client-safe payload. Returns the authed user when allowed;
 * otherwise the response is already sent.
 */
async function basicReportingUser(req, res, store) {
  const me = await getAuth(req, store);
  if (!me) { send(res, 401, { error: "Not signed in." }); return null; }
  const permission = typeof store.getAiUserPermission === "function"
    ? await store.getAiUserPermission(me.username)
    : null;
  if (reportingAccess(me, permission) === "none") {
    send(res, 403, { error: "Reporting is not enabled for this account." });
    return null;
  }
  return me;
}

/** Strict YYYY-MM-DD range parsing for reporting queries (defaults: last 30d). */
function parseReportingRange(url, { comparison = false } = {}) {
  const raw = {};
  for (const name of ["from", "to", ...(comparison ? ["cmpfrom", "cmpto"] : [])]) {
    raw[name] = clean(url.searchParams.get(name), 10);
    if (raw[name] && !validDay(raw[name])) return { error: "Dates must be YYYY-MM-DD." };
  }
  const to = raw.to || todayStr();
  const from = raw.from || shiftDays(to, -29);
  if (from > to) return { error: "Range start must not be after range end." };
  const out = { from, to };
  if (comparison) {
    const cmpto = raw.cmpto || shiftDays(from, -1);
    const cmpfrom = raw.cmpfrom || shiftDays(cmpto, -dayCount(from, to));
    if (cmpfrom > cmpto) return { error: "Comparison range start must not be after range end." };
    out.cmpfrom = cmpfrom;
    out.cmpto = cmpto;
  }
  return out;
}

function reportingFiltersFrom(url) {
  const out = {};
  for (const key of ["channel", "platform", "source", "campaign"]) {
    const value = clean(url.searchParams.get(key), 120);
    if (value) out[key] = value;
  }
  return out;
}

const sha256Text = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");

/** Public origin of this deployment — for OAuth redirect URIs. */
function requestOrigin(req) {
  const proto = clean(req.headers["x-forwarded-proto"], 10) || (process.env.VERCEL ? "https" : "http");
  const host = clean(req.headers["x-forwarded-host"] || req.headers.host, 200) || "localhost";
  return `${proto}://${host}`;
}

/** Connector errors can embed request URLs — never let credentials through. */
function sanitizeHyrosError(message, apiKey) {
  let s = String(message || "unknown error").slice(0, 240);
  if (apiKey) s = s.split(apiKey).join("***");
  return s.replace(/([?&](?:api[-_]?key|apikey|key|token)=)[^&\s]+/gi, "$1***");
}

/**
 * A Hyros 429 is transient throttling, not a connection failure — the MCP
 * layer has already retried it by the time it surfaces here. Sync code marks
 * it with the exact string "rate_limited" so the UI can show a neutral state
 * instead of an error (and never offers a reconnect). The connector signals
 * it via err.rateLimited / err.status 429; the REST path and the connector's
 * caught-error results only keep the sanitized message, so match that too.
 */
function isHyrosRateLimited(err) {
  if (!err) return false;
  if (err.rateLimited === true || err.status === 429) return true;
  return /rate limit/i.test(String(err.message || err.error || err));
}

/** Decrypt stored Hyros credentials server-side; nothing key-shaped ever leaves. */
function hyrosConfig(integration, store) {
  if (integration && integration.authMethod === "oauth") {
    const dec = (v) => ai.decryptSecret(v, HYROS_CIPHER_CONTEXT);
    const cfg = {
      authMethod: "oauth",
      clientId: integration.oauthClientId || "",
      clientSecret: dec(integration.oauthClientSecretEncrypted),
      accessToken: dec(integration.oauthAccessTokenEncrypted),
      accessExpiresAt: integration.oauthAccessExpiresAt || null,
      refreshToken: dec(integration.oauthRefreshTokenEncrypted),
    };
    // Rotated refresh tokens must be persisted immediately — they are the only
    // thing keeping the 30-day window alive between sync runs.
    cfg.persistTokens = async (tokens) => {
      if (!store || typeof store.putIntegration !== "function") return;
      await store.putIntegration(HYROS_INTEGRATION_ID, {
        oauthAccessTokenEncrypted: ai.encryptSecret(tokens.accessToken, HYROS_CIPHER_CONTEXT),
        oauthAccessExpiresAt: tokens.accessExpiresAt,
        ...(tokens.refreshToken
          ? { oauthRefreshTokenEncrypted: ai.encryptSecret(tokens.refreshToken, HYROS_CIPHER_CONTEXT) }
          : {}),
        updatedAt: new Date().toISOString(),
      });
    };
    return cfg;
  }
  const cfg = { apiKey: ai.decryptSecret(integration && integration.apiKeyEncrypted, HYROS_CIPHER_CONTEXT) };
  if (process.env.HYROS_BASE_URL) cfg.baseUrl = clean(process.env.HYROS_BASE_URL, 200);
  return cfg;
}

/**
 * Public integration status — no secrets, no live Hyros calls. Diagnostics
 * (recordsImported / snapshotsImported / dataFrom / dataTo / historyComplete)
 * come from the local stores only; the daily read is guarded because a
 * deployment may not have migration 009 applied yet.
 */
async function hyrosPublicStatus(store, integration) {
  const connected = !!(integration && integration.status === "connected");
  const lastError = connected ? clean(integration.lastError, 240) : "";
  const recordsImported = typeof store.reportingFactsCount === "function"
    ? await store.reportingFactsCount({ integrationId: HYROS_INTEGRATION_ID })
    : 0;
  let snapshotsImported = 0;
  let dataFrom = null;
  let dataTo = null;
  if (typeof store.reportingDailyQuery === "function") {
    try {
      const rows = await store.reportingDailyQuery({ from: "1970-01-01", to: "2999-12-31", sourceSystem: "hyros" });
      snapshotsImported = rows.length;
      for (const r of rows) {
        const day = r && r.day;
        if (!day) continue;
        if (!dataFrom || day < dataFrom) dataFrom = day;
        if (!dataTo || day > dataTo) dataTo = day;
      }
    } catch { /* reporting_daily not migrated on this deployment yet */ }
  }
  return {
    connected,
    authMethod: connected ? (integration.authMethod || "apikey") : "",
    accountName: connected ? clean(integration.accountName, 120) : "",
    lastSyncAt: (integration && integration.lastSyncAt) || null,
    lastWebhookAt: (integration && integration.lastWebhookAt) || null,
    lastError,
    rateLimited: lastError === "rate_limited",
    backfillPending: !!(integration && integration.backfill && integration.backfill.done === false),
    historicalDays: (integration && integration.historicalDays) || null,
    recordCount: recordsImported,
    recordsImported,
    snapshotsImported,
    dataFrom,
    dataTo,
    historyComplete: !!(integration && integration.backfill && integration.backfill.done === true),
  };
}

/**
 * Ad-account type → user-facing channel/platform (Smart Reporting taxonomy).
 * Mirrors the connector's attribution classification so account-level daily
 * rows never leak raw Hyros enums (GOOGLE_V2, ...) into the UI.
 */
const AD_ACCOUNT_CLASS = {
  GOOGLE_V2: { channel: "Paid Search", platform: "Google Ads" },
  GOOGLE: { channel: "Paid Search", platform: "Google Ads" },
  BING: { channel: "Paid Search", platform: "Microsoft / Bing Ads" },
  FACEBOOK: { channel: "Paid Social", platform: "Meta Ads" },
  PINTEREST: { channel: "Paid Social", platform: "Pinterest Ads" },
  TIKTOK: { channel: "Paid Social", platform: "TikTok Ads" },
  LINKEDIN: { channel: "Paid Social", platform: "LinkedIn Ads" },
  SNAPCHAT: { channel: "Paid Social", platform: "Snapchat Ads" },
  TWITTER: { channel: "Paid Social", platform: "Twitter / X Ads" },
  REDDIT: { channel: "Paid Social", platform: "Reddit Ads" },
  APPLOVIN: { channel: "Other", platform: "AppLovin" },
  WHOP_ADS: { channel: "Other", platform: "Whop Ads" },
};

function classifyAdAccount(type) {
  const key = String(type || "").toUpperCase();
  if (AD_ACCOUNT_CLASS[key]) return AD_ACCOUNT_CLASS[key];
  if (!key) return { channel: "Other", platform: "Other" };
  const pretty = key.charAt(0) + key.slice(1).toLowerCase().replace(/_/g, " ");
  return { channel: "Other", platform: `${pretty} Ads` };
}

/** Aggregate days processed per bounded-call iteration. */
const AGG_CHUNK_DAYS = 14;

/**
 * Shared context for the daily-aggregate sync: ad accounts, per-account
 * adSourceIds, a source→campaign name map, and a whole-range activity probe
 * so accounts with zero spend AND zero revenue over the range are skipped
 * instead of flooding reporting_daily with empty rows. Connector failures
 * propagate — the caller records them as the run error and retries later.
 */
async function newHyrosAggContext(hyros, cfg, { from, to }) {
  const ctx = { accounts: [], sourcesByAccount: {}, nameByAdSourceId: {}, active: {} };
  if (typeof hyros.listAdAccounts !== "function" || typeof hyros.roasForRange !== "function") return ctx;
  const accounts = await hyros.listAdAccounts(cfg);
  ctx.accounts = (Array.isArray(accounts) ? accounts : []).filter((a) => a && a.id != null && a.id !== "");
  if (typeof hyros.listSources === "function") {
    const sources = await hyros.listSources(cfg);
    for (const s of Array.isArray(sources) ? sources : []) {
      if (!s || s.adSourceId == null || s.adSourceId === "") continue;
      const sid = String(s.adSourceId);
      const accId = s.adAccountId == null ? "" : String(s.adAccountId);
      if (accId) (ctx.sourcesByAccount[accId] = ctx.sourcesByAccount[accId] || []).push(sid);
      const category = s.category && typeof s.category === "object" ? s.category.name : s.category;
      ctx.nameByAdSourceId[sid] = clean(s.name || category || "", 200);
    }
  }
  // Hyros rejects report ranges beyond 90 days — clamp the probe window.
  const probeFrom = dayCount(from, to) > 89 ? shiftDays(to, -89) : from;
  for (const acc of ctx.accounts) {
    const accId = String(acc.id);
    const t = await hyros.roasForRange(cfg, { id: accId, level: "ACCOUNT", from: probeFrom, to });
    ctx.active[accId] = (Number(t && t.cost) || 0) + (Number(t && t.revenue) || 0) > 0;
  }
  return ctx;
}

/**
 * Build + upsert all daily rows for one account-tz day:
 * - scope "account": per-day ROAS report totals for every active ad account
 * - scope "campaign": DAY-grouped attribution rows for that account's sources
 * - scope "channel": rollup of the stored facts (organic + paid) for the day
 * Returns rows written.
 */
async function syncHyrosDailyForDay(store, hyros, cfg, ctx, day) {
  if (typeof store.reportingDailyUpsert !== "function") return 0;
  const rows = [];
  for (const acc of ctx.accounts) {
    const accId = String(acc.id);
    if (!ctx.active[accId]) continue;
    const cls = classifyAdAccount(acc.type);
    const t = await hyros.roasForRange(cfg, { id: accId, level: "ACCOUNT", from: day, to: day });
    const spend = Number(t && t.cost) || 0;
    const revenue = Number(t && t.revenue) || 0;
    const sales = Number(t && t.uniqueSales) || 0;
    rows.push({
      sourceSystem: "hyros", day, scope: "account",
      channel: cls.channel, platform: cls.platform,
      adAccount: accId, campaignId: "", campaignName: "",
      spend, clicks: null, impressions: null, leads: 0, sales, revenue,
      aov: t && t.aov != null && !isNaN(Number(t.aov)) ? Number(t.aov) : sales ? revenue / sales : null,
    });
    const ids = ctx.sourcesByAccount[accId] || [];
    if (ids.length && typeof hyros.attributionDaily === "function") {
      const level = `${String(acc.type || "").toUpperCase()}_CAMPAIGN`;
      const camps = await hyros.attributionDaily(cfg, { level, ids, from: day, to: day });
      for (const c of Array.isArray(camps) ? camps : []) {
        const cid = c && c.campaignId != null ? String(c.campaignId) : "";
        const cSales = Number(c && c.sales) || 0;
        const cRevenue = Number(c && c.revenue) || 0;
        rows.push({
          sourceSystem: "hyros", day: clean(c && c.day, 10) || day, scope: "campaign",
          channel: cls.channel, platform: cls.platform,
          adAccount: accId, campaignId: cid,
          campaignName: ctx.nameByAdSourceId[cid] || "",
          spend: Number(c && c.cost) || 0,
          clicks: c && c.clicks != null ? Number(c.clicks) : null,
          impressions: c && c.impressions != null ? Number(c.impressions) : null,
          leads: Number(c && c.leads) || 0, sales: cSales, revenue: cRevenue,
          aov: cSales ? cRevenue / cSales : null,
        });
      }
    }
  }
  if (typeof store.reportingFactsList === "function") {
    const facts = await store.reportingFactsList({ integrationId: HYROS_INTEGRATION_ID, from: day, to: day });
    const roll = new Map();
    for (const f of Array.isArray(facts) ? facts : []) {
      const channel = f.channel || "Unknown";
      const platform = f.platform || "Other";
      const key = `${channel}|${platform}`;
      if (!roll.has(key)) roll.set(key, { channel, platform, leads: 0, sales: 0, revenue: 0 });
      const g = roll.get(key);
      if (f.eventType === "lead") g.leads += 1;
      else if (f.eventType === "sale") { g.sales += 1; g.revenue += Number(f.value) || 0; }
      else if (f.eventType === "refund") g.revenue += Number(f.value) || 0; // negative
    }
    for (const g of roll.values()) {
      rows.push({
        sourceSystem: "hyros", day, scope: "channel",
        channel: g.channel, platform: g.platform,
        adAccount: "", campaignId: "", campaignName: "",
        spend: 0, clicks: null, impressions: null,
        leads: g.leads, sales: g.sales, revenue: g.revenue,
        aov: g.sales ? g.revenue / g.sales : null,
      });
    }
  }
  if (!rows.length) return 0;
  const written = await store.reportingDailyUpsert(rows);
  return typeof written === "number" ? written : rows.length;
}

/**
 * Incremental-path aggregates: rebuild reporting_daily for the trailing
 * window (newest-first, capped per call — older history belongs to the
 * backfill phase, or to a resync). Returns rows written.
 */
async function syncHyrosRecentAggregates(store, hyros, cfg, { from, to, deadline }) {
  if (typeof store.reportingDailyUpsert !== "function") return 0;
  const days = [];
  for (let d = to; d >= from && days.length < AGG_CHUNK_DAYS; d = shiftDays(d, -1)) days.push(d);
  if (!days.length) return 0;
  const ctx = await newHyrosAggContext(hyros, cfg, { from, to });
  let snapshotsIn = 0;
  for (const day of days) {
    if (deadline && Date.now() >= deadline) break;
    snapshotsIn += await syncHyrosDailyForDay(store, hyros, cfg, ctx, day);
  }
  return snapshotsIn;
}

/**
 * Bounded historical backfill, two resumable phases persisted on
 * `integration.backfill` as { cursor, done, aggDay }:
 *
 *   Phase 1 (aggDay === null): entity facts — one 7-day window per iteration
 *     via the connector's cursor; when it reports done, the phase flips by
 *     stamping aggDay = today.
 *   Phase 2 (aggDay set): daily aggregates — newest-first, one account-tz day
 *     at a time (persisted per day, ≤ AGG_CHUNK_DAYS per iteration); when
 *     aggDay walks past the window start the backfill is done.
 *
 * Every state transition is persisted before the next network call, so a
 * Vercel budget cutoff (or a 429) resumes exactly where this call stopped.
 * All writes are upserts — re-running any window is free.
 */
async function runHyrosBackfill(store, hyros, cfg, days) {
  const integration = typeof store.getIntegration === "function"
    ? await store.getIntegration(HYROS_INTEGRATION_ID)
    : null;
  const saved = (integration && integration.backfill) || {};
  let cursor = saved.cursor || null;
  let aggDay = saved.aggDay || null;
  const historyDays = Math.max(1, Number(days) || 90);
  const today = todayStr();
  const windowStart = shiftDays(today, -(historyDays - 1));
  const deadline = Date.now() + (process.env.VERCEL ? 9000 : 30000);
  let recordsIn = 0;
  let snapshotsIn = 0;
  let done = false;
  let error = "";
  let aggCtx = null;
  const startedAt = new Date().toISOString();
  const run = await store.syncRunInsert({
    integrationId: HYROS_INTEGRATION_ID, kind: "backfill", status: "running", startedAt,
  });
  const persist = (doneFlag = false) => store.putIntegration(HYROS_INTEGRATION_ID, {
    backfill: { cursor, done: doneFlag, aggDay }, updatedAt: new Date().toISOString(),
  });
  while (!done && Date.now() < deadline) {
    if (aggDay === null) {
      // Phase 1 — entity facts, one historical window per iteration.
      let batch = null;
      try {
        batch = await hyros.syncBackfill(cfg, { days: historyDays, cursor, deadlineMs: Math.max(0, deadline - Date.now()) });
      } catch (e) {
        // Exhausted 429 retries surface as a thrown error on the OAuth path.
        // The persisted cursor already resumes the history on the next run.
        if (isHyrosRateLimited(e)) { error = "rate_limited"; break; }
        throw e;
      }
      if (!batch || !batch.ok) {
        error = isHyrosRateLimited(batch) ? "rate_limited" : sanitizeHyrosError(batch && batch.error, cfg.apiKey);
        break;
      }
      recordsIn += Number(batch.recordsIn) || 0;
      cursor = batch.nextCursor || null;
      if (batch.done === true || !cursor) {
        // Entity history complete → roll into the aggregate phase at today.
        // Aggregates use the MCP report tools, which exist only on the OAuth
        // transport — an api-key connection finishes after the entity phase.
        cursor = null;
        if (cfg.authMethod === "oauth") {
          aggDay = today;
        } else {
          done = true;
        }
      }
      await persist();
      continue;
    }
    // Phase 2 — daily aggregates, newest-first, ≤ AGG_CHUNK_DAYS per iteration.
    if (aggDay < windowStart) { done = true; break; }
    if (!aggCtx) {
      try {
        aggCtx = await newHyrosAggContext(hyros, cfg, { from: windowStart, to: today });
      } catch (e) {
        error = isHyrosRateLimited(e) ? "rate_limited" : sanitizeHyrosError(e && e.message, cfg.apiKey);
        break;
      }
    }
    let chunk = 0;
    while (aggDay !== null && !done && chunk < AGG_CHUNK_DAYS && Date.now() < deadline) {
      let written = 0;
      try {
        written = await syncHyrosDailyForDay(store, hyros, cfg, aggCtx, aggDay);
      } catch (e) {
        error = isHyrosRateLimited(e) ? "rate_limited" : sanitizeHyrosError(e && e.message, cfg.apiKey);
        break;
      }
      snapshotsIn += written;
      // Completing the window's first day finishes the backfill; the done
      // flag is persisted atomically with the cleared aggDay so a crash here
      // can never resume into the phase-1 entity backfill by mistake.
      if (aggDay === windowStart) { aggDay = null; done = true; }
      else aggDay = shiftDays(aggDay, -1);
      chunk++;
      await persist(done);
    }
    if (error) break;
    // Chunk exhausted but time remains → the next outer iteration continues.
  }
  const now = new Date().toISOString();
  if (run && run.id != null) {
    await store.syncRunUpdate(run.id, {
      status: error === "rate_limited" ? "rate_limited" : error ? "error" : done ? "ok" : "partial",
      recordsIn, error, finishedAt: now,
    });
  }
  await store.putIntegration(HYROS_INTEGRATION_ID, {
    lastSyncAt: now,
    lastError: error,
    updatedAt: now,
    backfill: done ? { cursor: null, done: true, aggDay: null } : { cursor, done: false, aggDay },
  });
  return { recordsIn, snapshotsIn, done, error };
}

/**
 * Shared sync core for the Admin "Sync now" route and the Vercel Cron
 * reconciliation route. An unfinished historical backfill always continues
 * first (idempotent); otherwise a trailing-window incremental runs. Returns
 * `{ status, body }` so callers only differ in authentication.
 */
async function performHyrosSync(store, { days = null } = {}) {
  const hyros = hyrosModule();
  if (!hyros) return { status: 503, body: { error: "The Hyros connector is not available on this deployment yet." } };
  const integration = typeof store.getIntegration === "function"
    ? await store.getIntegration(HYROS_INTEGRATION_ID)
    : null;
  if (!integration || integration.status !== "connected") return { status: 400, body: { error: "Hyros is not connected." } };
  const cfg = hyrosConfig(await store.getIntegrationSecret(HYROS_INTEGRATION_ID), store);
  if (!cfg.apiKey && cfg.authMethod !== "oauth") return { status: 500, body: { error: "The stored Hyros credentials could not be read — reconnect the integration." } };

  if (integration.backfill && integration.backfill.done === false) {
    const r = await runHyrosBackfill(store, hyros, cfg, integration.historicalDays || 90);
    const recordCount = typeof store.reportingFactsCount === "function"
      ? await store.reportingFactsCount({ integrationId: HYROS_INTEGRATION_ID })
      : 0;
    // Rate limiting is transient: 200 + a marker, never a 502 alarm.
    const rateLimited = r.error === "rate_limited";
    return {
      status: r.error && !rateLimited ? 502 : 200,
      body: {
        ok: !r.error, kind: "backfill", recordsIn: r.recordsIn,
        snapshotsIn: r.snapshotsIn || 0,
        complete: r.done, error: r.error || "", recordCount,
        ...(rateLimited ? { rateLimited: true } : {}),
      },
    };
  }

  const to = todayStr();
  // Incremental re-reads one extra day for late-arriving attribution;
  // upserts make the overlap free.
  const from = days
    ? shiftDays(to, -(days - 1))
    : integration.lastSyncAt
      ? shiftDays(String(integration.lastSyncAt).slice(0, 10), -1)
      : shiftDays(to, -1);
  const startMs = Date.now();
  const startedAt = new Date().toISOString();
  const run = await store.syncRunInsert({
    integrationId: HYROS_INTEGRATION_ID, kind: "incremental", status: "running", startedAt,
  });
  let result = null;
  try {
    result = await hyros.syncIncremental(cfg, { from, to });
  } catch (e) {
    if (!isHyrosRateLimited(e)) throw e;
    result = { ok: false, recordsIn: 0, error: "rate_limited" };
  }
  const ok = !!(result && result.ok);
  const rateLimited = !ok && isHyrosRateLimited(result);
  const error = ok ? "" : rateLimited ? "rate_limited" : sanitizeHyrosError(result && result.error, cfg.apiKey);
  let snapshotsIn = 0;
  let aggregateError = "";
  if (ok && cfg.authMethod === "oauth") {
    // Rebuild reporting_daily for the same trailing window — spend and
    // attribution settle with a delay, so the overlap rewrites the last
    // couple of days on every sync (upserts make that free). Aggregate
    // failures never fail the entity sync; the next run rewrites the window.
    // OAuth-only: the report tools do not exist on the api-key transport.
    try {
      snapshotsIn = await syncHyrosRecentAggregates(store, hyros, cfg, {
        from, to, deadline: startMs + (process.env.VERCEL ? 9000 : 30000),
      });
    } catch (e) {
      aggregateError = isHyrosRateLimited(e) ? "rate_limited" : sanitizeHyrosError(e && e.message, cfg.apiKey);
    }
  }
  const now = new Date().toISOString();
  if (run && run.id != null) {
    await store.syncRunUpdate(run.id, {
      status: ok ? "ok" : rateLimited ? "rate_limited" : "error",
      recordsIn: ok ? Number(result.recordsIn) || 0 : 0,
      error, finishedAt: now,
    });
  }
  await store.putIntegration(HYROS_INTEGRATION_ID, {
    ...(ok ? { lastSyncAt: now } : {}), lastError: error, updatedAt: now,
  });
  const recordCount = typeof store.reportingFactsCount === "function"
    ? await store.reportingFactsCount({ integrationId: HYROS_INTEGRATION_ID })
    : 0;
  return {
    status: ok || rateLimited ? 200 : 502,
    body: {
      ok, kind: "incremental", recordsIn: ok ? Number(result.recordsIn) || 0 : 0,
      snapshotsIn,
      from, to, error, recordCount,
      ...(aggregateError ? { aggregateError } : {}),
      ...(rateLimited ? { rateLimited: true } : {}),
    },
  };
}

function safeAvatar(value) {
  const raw = String(value || "");
  if (!raw) return "";
  const match = raw.match(/^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/i);
  if (!match) return null;
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.length > 250 * 1024) return null;
  return raw;
}

function validEmail(value) {
  const email = clean(value, 254).toLowerCase();
  return !email || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

async function publicWithProfile(store, user) {
  return { ...publicOf(user), profile: await store.getUserProfile(user.username) };
}

function taskModel(task, users, departments) {
  return composeTaskEvents(enrichTask(task, users, departments));
}

async function loadTaskContext(store, id) {
  const [rawTask, users, workspace] = await Promise.all([
    store.getTask(id), store.listUsers(), store.getState(),
  ]);
  return {
    rawTask,
    users,
    workspace,
    task: rawTask ? taskModel(rawTask, users, workspace.departments) : null,
  };
}

function commentVisibleTo(comment, user) {
  return user.role !== "client" || comment.clientVisible === true;
}

function taskForUser(task, user) {
  if (user.role !== "client") return task;
  return {
    ...task,
    comments: (task.comments || []).filter((c) => commentVisibleTo(c, user)),
    subtasks: (task.subtasks || []).filter((s) => s.clientVisible === true),
  };
}

function attachmentForUser(link, user) {
  const meta = parseFileMeta(link.note);
  if (!meta) return null;
  if (user.role === "client" && meta.deliveredToClient !== true && meta.uploadedBy !== user.username) return null;
  return {
    id: link.id,
    taskId: link.taskId,
    name: link.title,
    workstream: link.workstream || "",
    openUrl: `/api/files/${encodeURIComponent(link.id)}/download`,
    downloadUrl: `/api/files/${encodeURIComponent(link.id)}/download`,
    ...meta,
  };
}

function canReviewTask(user, task) {
  if (user.role === "super_admin") return true;
  if (user.role !== "team") return false;
  if ((task.ownerUsernames || []).includes(user.username)) return true;
  if (!(task.ownerUsernames || []).length) {
    const mine = new Set(decodeDepartmentIds(user.departments || []));
    return (task.departmentIds || []).some((id) => mine.has(id));
  }
  return false;
}

function generatedEntityId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
}

function parseMentionUsernames(text) {
  const names = [];
  const re = /(^|\s)@([a-z0-9_.-]{2,30})\b/gi;
  let match;
  while ((match = re.exec(String(text || "")))) names.push(match[2].toLowerCase());
  return [...new Set(names)];
}

/* ------------------------------ workspace search ------------------------------ */

const searchNorm = (value) => String(value == null ? "" : value)
  .normalize("NFKD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLowerCase();

function parseSearchQuery(value) {
  const raw = clean(value, 300);
  const takeModifier = (name) => {
    const re = new RegExp(`(?:^|\\s)${name}:(?:\"([^\"]+)\"|(@?[^\\s]+))`, "i");
    const match = raw.match(re);
    return match ? clean(match[1] || match[2] || "", 100).replace(/^[@#]/, "") : "";
  };
  const inChannel = takeModifier("in");
  const from = takeModifier("from");
  const requestedType = takeModifier("type").toLowerCase();
  const typeAliases = {
    task: "tasks", tasks: "tasks", file: "files", files: "files", link: "files", links: "files",
    message: "messages", messages: "messages", chat: "messages", communication: "messages",
  };
  const phrases = [...raw.matchAll(/"([^"]+)"/g)].map((match) => searchNorm(match[1])).filter(Boolean);
  const text = raw
    .replace(/(?:^|\s)(?:in|from|type):(?:"[^"]+"|@?[^\s]+)/gi, " ")
    .replace(/"([^"]+)"/g, "$1")
    .trim();
  return {
    raw,
    text,
    terms: searchNorm(text).split(/[^a-z0-9]+/).filter((term) => term.length > 1),
    phrases,
    inChannel: searchNorm(inChannel),
    from: searchNorm(from),
    requestedType: typeAliases[requestedType] || "",
  };
}

function searchScore(query, title, body, boosts = []) {
  const titleText = searchNorm(title);
  const allText = searchNorm([title, body, ...boosts].filter(Boolean).join(" \n"));
  if (query.phrases.some((phrase) => !allText.includes(phrase))) return 0;
  if (!query.terms.length && !query.phrases.length) return 1;
  const allTokens = allText.split(/[^a-z0-9]+/).filter(Boolean);
  const termMatches = (term) => allTokens.some((word) => word === term || (term.length >= 3 && word.startsWith(term)));
  // Workspace search follows the predictable "all words" rule. This avoids a
  // common bad-search failure where an ID query such as NM-AI-001 matches every
  // NM task just because one tiny fragment is shared.
  if (query.terms.some((term) => !termMatches(term))) return 0;
  let score = 0;
  const exact = searchNorm(query.text);
  if (exact && titleText === exact) score += 120;
  else if (exact && titleText.includes(exact)) score += 70;
  else if (exact && allText.includes(exact)) score += 45;
  for (const term of query.terms) {
    if (titleText.split(/[^a-z0-9]+/).some((word) => word === term)) score += 18;
    else if (titleText.includes(term)) score += 11;
    else if (termMatches(term)) score += 5;
  }
  return score;
}

function searchExcerpt(text, query, max = 210) {
  const plain = String(text || "").replace(/\s+/g, " ").trim();
  if (plain.length <= max) return plain;
  const lower = searchNorm(plain);
  const needle = query.terms.find((term) => lower.includes(term)) || "";
  const at = needle ? lower.indexOf(needle) : 0;
  const start = Math.max(0, at - 55);
  return `${start ? "…" : ""}${plain.slice(start, start + max)}…`;
}

async function notifyCommentRecipients(store, task, actor, comment, users) {
  const recipients = new Set();
  const explicit = parseMentionUsernames(comment.text);
  const everyone = /(^|\s)@everyone\b/i.test(comment.text);
  if (everyone) {
    for (const u of users) {
      if (u.active && u.username !== actor.username && canSeeTask(u, task) &&
          (comment.clientVisible || u.role !== "client")) recipients.add(u.username);
    }
  } else {
    for (const username of explicit) recipients.add(username);
    for (const username of task.ownerUsernames || []) recipients.add(username);
    if (task.createdByUsername) recipients.add(task.createdByUsername);
  }
  recipients.delete(actor.username);
  for (const username of recipients) {
    const user = users.find((u) => u.username === username && u.active);
    if (!user || !canSeeTask(user, task)) continue;
    if (user.role === "client" && !comment.clientVisible) continue;
    await store.notify({
      username,
      kind: explicit.includes(username) || everyone ? "mention" : "task_comment",
      text: `${actor.name} commented on “${task.title}”: ${comment.text.slice(0, 140)}`,
      taskId: task.id,
      channelId: `comment:${comment.id}`,
    });
  }
}

async function nextId(store, collection, prefix) {
  const max = await store.maxIdSuffix(collection, prefix);
  return `${prefix}-${String(max + 1).padStart(3, "0")}`;
}

const isDuplicateId = (err) => /duplicate|23505|\(409\)/i.test(String((err && err.message) || err));

async function insertWithFreshId(store, collection, prefix, insert) {
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const id = await nextId(store, collection, prefix);
    try {
      return await insert(id);
    } catch (err) {
      if (!isDuplicateId(err)) throw err;
      lastErr = err;
    }
  }
  throw lastErr || new Error("Could not allocate a unique id.");
}

/* ------------------------------ chat helpers ------------------------------ */

/** Users who should receive chat notifications for a channel message. */
async function channelRecipients(store, channel, excludeUsername) {
  const users = await store.listUsers();
  return users.filter((u) => {
    if (!u.active || u.username === excludeUsername) return false;
    if (u.role === "super_admin") return false; // admins watch everything anyway; no spam
    if (u.role === "client" && !channel.clientAllowed) return false;
    if (channel.autoAll) {
      const m = memberOf(channel, u.username);
      return !(m && m.muted);
    }
    const m = memberOf(channel, u.username);
    return !!m && !m.muted;
  });
}

function unreadCount(channel, messages, username) {
  const m = memberOf(channel, username);
  const since = m && m.lastReadTs ? new Date(m.lastReadTs).getTime() : 0;
  return messages.filter(
    (msg) => new Date(msg.ts).getTime() > since && msg.authorId !== username
  ).length;
}

/** Map free-text owner/requester strings ("Taha / Abu Bakar") to usernames. */
function resolveUsernames(users, text) {
  const out = [];
  const hay = String(text || "").toLowerCase();
  for (const u of users) {
    if (u.name && hay.includes(u.name.toLowerCase())) out.push(u.username);
  }
  return out;
}

async function notifyTaskFollowers(store, task, actor, text) {
  const users = await store.listUsers();
  const targets = new Set([
    ...resolveUsernames(users, task.owner),
    ...resolveUsernames(users, task.requestedBy),
  ]);
  targets.delete(actor.username);
  for (const username of targets) {
    const u = users.find((x) => x.username === username);
    if (!u || !u.active) continue;
    if (!canSeeTask(u, task)) continue; // internal/private tasks never notify outsiders
    await store.notify({ username, kind: "task", text, taskId: task.id });
  }
}

/* ------------------------------ routes ------------------------------ */

async function route(req, res, key, parts) {
  const store = getStore();
  switch (key) {
    case "POST /api/login": {
      const body = await readBody(req);
      const username = clean(body.username, 100).toLowerCase();
      const user = await store.getUserWithHash(username);
      // Always run scrypt so timing doesn't reveal valid usernames.
      const hash = crypto.scryptSync(
        String(body.password || ""), "nm-task-hub:" + (user ? user.username : "~no-such-user~"), 32
      );
      const ok =
        !!user && user.active &&
        crypto.timingSafeEqual(hash, Buffer.from(user.passwordHash, "hex"));
      if (!ok) {
        await new Promise((r) => setTimeout(r, 400));
        return send(res, 401, { error: "Invalid username or password." });
      }
      const token = makeToken(user.username);
      return send(res, 200, { user: await publicWithProfile(store, user) }, {
        "Set-Cookie": `nm_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}${secureCookie(req)}`,
      });
    }

    case "POST /api/logout":
      return send(res, 200, { ok: true }, {
        "Set-Cookie": `nm_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secureCookie(req)}`,
      });

    case "GET /api/me": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      return send(res, 200, { user: await publicWithProfile(store, me) });
    }

    case "GET /api/users/basic": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      // Client accounts never receive the internal team directory or department
      // memberships. Their task form routes work to a department or whole team.
      const profiles = new Map((await store.listUserProfiles()).map((profile) => [profile.username, profile]));
      const users = (await store.listUsers())
        .filter((u) => u.active)
        .filter((u) => me.role !== "client" || u.username === me.username)
        .map((u) => ({
          username: u.username, name: u.name, role: u.role,
          departments: decodeDepartmentIds(u.departments || []),
          profile: profiles.get(u.username) || { availability: "away", bio: "", contact: "", email: "", avatar: "" },
        }));
      return send(res, 200, { users });
    }

    case "GET /api/me/profile": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      return send(res, 200, { profile: await store.getUserProfile(me.username) });
    }

    case "PATCH /api/me/profile": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      const body = await readBody(req);
      const fields = {};
      if ("bio" in body) fields.bio = clean(body.bio, 500);
      if ("contact" in body) fields.contact = clean(body.contact, 120);
      if ("email" in body) {
        const email = validEmail(body.email);
        if (email === null) return send(res, 400, { error: "Enter a valid email address." });
        fields.email = email;
      }
      if ("availability" in body) fields.availability = oneOf(body.availability, ["online", "away"], "away");
      if ("avatar" in body) {
        const avatar = safeAvatar(body.avatar);
        if (avatar === null) return send(res, 400, { error: "Profile picture must be PNG, JPG, WEBP or GIF and smaller than 250 KB." });
        fields.avatar = avatar;
      }
      const profile = await store.putUserProfile(me.username, fields);
      return send(res, 200, { profile });
    }

    case "GET /api/search": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      const url = new URL(req.url, "http://localhost");
      const query = parseSearchQuery(url.searchParams.get("q") || "");
      const requested = clean(url.searchParams.get("type"), 20).toLowerCase();
      const type = query.requestedType || (["all", "tasks", "files", "messages"].includes(requested)
        ? requested
        : "all");
      const limit = Math.min(100, Math.max(10, Number(url.searchParams.get("limit")) || 60));
      if (!query.raw) {
        return send(res, 200, {
          query: "", type, modifiers: { in: "", from: "" },
          counts: { tasks: 0, files: 0, messages: 0 }, total: 0, results: [],
        });
      }

      const [workspace, users, allChannels] = await Promise.all([
        store.getState(), store.listUsers(), store.listChannels(),
      ]);
      const modeledTasks = workspace.tasks.map((task) => taskModel(task, users, workspace.departments));
      const allowedTasks = visibleTasks(modeledTasks, me);
      const allowedTaskIds = new Set(allowedTasks.map((task) => task.id));
      const channels = accessibleChannels(allChannels, me);
      const channelById = new Map(channels.map((channel) => [channel.id, channel]));
      const results = [];

      if (type === "all" || type === "tasks") {
        for (const task of allowedTasks) {
          const departmentNames = (task.departmentIds || []).map((id) => {
            const department = workspace.departments.find((item) => item.id === id);
            return department ? department.name : id;
          });
          const searchable = [
            task.description, task.project, task.owner, task.requestedBy, task.status, task.priority,
            task.update, task.nextAction, task.blocker, task.deliverable, departmentNames.join(" "),
            task.dueDate && !["Completed", "Cancelled"].includes(task.status)
              && new Date(`${task.dueDate}T23:59:59`).getTime() < Date.now() ? "overdue" : "",
            ...(task.comments || []).filter((comment) => commentVisibleTo(comment, me)).map((comment) => `${comment.author} ${comment.text}`),
            ...(task.subtasks || []).filter((subtask) => me.role !== "client" || subtask.clientVisible).map((subtask) => subtask.title),
          ].join(" \n");
          if (query.inChannel && !searchNorm([task.project, task.department, departmentNames.join(" ")].join(" ")).includes(query.inChannel)) continue;
          if (query.from && !searchNorm([task.requestedBy, task.createdByUsername].join(" ")).includes(query.from)) continue;
          const score = searchScore(query, `${task.id} ${task.title}`, searchable, [task.id]);
          if (!score) continue;
          const lastUpdate = task.updates && task.updates.length ? task.updates[task.updates.length - 1].ts : task.dateRequested;
          results.push({
            kind: "task", id: task.id, title: task.title,
            excerpt: searchExcerpt(task.description || task.update || task.nextAction, query),
            status: task.status, priority: task.priority, owner: task.owner,
            departments: departmentNames, updatedAt: lastUpdate || "", score,
          });
        }
      }

      if (type === "all" || type === "files") {
        const allowedLinks = visibleLinks(workspace.links, me, { tasks: modeledTasks, channels: allChannels });
        for (const link of allowedLinks) {
          let urlOut = link.url || "";
          let note = link.note || "";
          if (link.type === "task_file") {
            if (!allowedTaskIds.has(link.taskId)) continue;
            const attachment = attachmentForUser(link, me);
            if (!attachment) continue;
            urlOut = attachment.openUrl;
            note = [attachment.feedback, attachment.status, attachment.clientStatus].filter(Boolean).join(" ");
          }
          const channel = link.channelId ? channelById.get(link.channelId) : null;
          if (query.inChannel && !searchNorm([link.channelId, channel && channel.name, link.workstream].join(" ")).includes(query.inChannel)) continue;
          if (query.from && !searchNorm(link.owner).includes(query.from)) continue;
          const score = searchScore(query, link.title, [note, link.owner, link.workstream, link.taskId, channel && channel.name].join(" \n"));
          if (!score) continue;
          results.push({
            kind: "file", id: link.id, title: link.title || "Shared link",
            excerpt: searchExcerpt(note || link.workstream || link.url, query), url: urlOut,
            taskId: link.taskId || "", channelId: link.channelId || "",
            channelName: channel ? channel.name : "", workstream: link.workstream || "",
            owner: link.owner || "", updatedAt: link.date || "", score,
          });
        }
      }

      if (type === "all" || type === "messages") {
        const batches = await Promise.all(channels.map(async (channel) => ({
          channel,
          messages: (await store.listMessages(channel.id, null, 500)).map(hydrateChatMessage),
        })));
        for (const { channel, messages } of batches) {
          if (query.inChannel && !searchNorm(`${channel.id} ${channel.name}`).includes(query.inChannel)) continue;
          for (const message of messages) {
            if (query.from && !searchNorm(`${message.authorId} ${message.author}`).includes(query.from)) continue;
            const score = searchScore(query, message.linkTitle || "", [message.text, message.author, message.linkUrl, message.taskId].join(" \n"));
            if (!score) continue;
            results.push({
              kind: "message", id: message.id, channelId: channel.id, channelName: channel.name,
              author: message.author, authorId: message.authorId,
              text: message.text || "", excerpt: searchExcerpt(message.text || message.linkTitle || message.linkUrl, query),
              linkUrl: message.linkUrl || "", linkTitle: message.linkTitle || "",
              taskId: message.taskId && allowedTaskIds.has(message.taskId) ? message.taskId : "",
              replyToId: message.replyToId || null, updatedAt: message.ts || "", score,
            });
          }
        }
      }

      results.sort((a, b) => b.score - a.score || new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
      const counts = { tasks: 0, files: 0, messages: 0 };
      for (const result of results) counts[result.kind === "task" ? "tasks" : result.kind === "file" ? "files" : "messages"]++;
      return send(res, 200, {
        query: query.raw, type, modifiers: { in: query.inChannel, from: query.from },
        counts, total: results.length, results: results.slice(0, limit).map(({ score, ...result }) => result),
      });
    }

    case "POST /api/search/answer": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      const body = await readBody(req);
      const question = clean(body.query, 300);
      if (!question) return send(res, 400, { error: "Search query is required." });
      const access = await aiPolicy(store, me, "ask");
      const provider = ai.providerConfig(access.settings);
      if (!access.allowed || !provider.apiKey) {
        return send(res, 200, { available: false, answer: "", citations: [] });
      }
      try {
        const result = await ai.runAsk(store, me,
          `Answer this workspace search clearly and concisely: ${question}. Find the most relevant tasks, shared files/links, and communication. State when the records do not contain enough information.`,
          { allowedTools: access.allowedTools.filter((name) => ai.READ_TOOL_NAMES.includes(name)) });
        await store.aiLog({
          username: me.username, kind: "search", question,
          tools: result.tools, citations: result.citations, model: result.model,
          promptTokens: result.usage.prompt_tokens, completionTokens: result.usage.completion_tokens,
          latencyMs: result.latencyMs, status: "ok",
        });
        return send(res, 200, { available: true, answer: result.answer, citations: result.citations });
      } catch (error) {
        await store.aiLog({ username: me.username, kind: "search", question, status: "error", error: error.code || "provider" });
        return send(res, 200, { available: false, answer: "", citations: [] });
      }
    }

    case "POST /api/me/password": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      const body = await readBody(req);
      const current = String(body.current || "");
      const next = String(body.next || "");
      if (next.length < 6) return send(res, 400, { error: "New password must be at least 6 characters." });
      const full = await store.getUserWithHash(me.username);
      const hash = crypto.scryptSync(current, "nm-task-hub:" + me.username, 32);
      if (!crypto.timingSafeEqual(hash, Buffer.from(full.passwordHash, "hex"))) {
        return send(res, 403, { error: "Current password is wrong." });
      }
      await store.updateUser(me.username, { passwordHash: hashPassword(me.username, next) });
      return send(res, 200, { ok: true });
    }

    case "GET /api/state": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      // "What changed since my last visit": the previous stamp goes out with
      // this response, then the visit is re-stamped. Best-effort until
      // migration 006 lands (users.last_seen_at).
      const lastVisit = me.lastSeenAt || null;
      try { await store.touchLastSeen(me.username); } catch { /* pre-006 */ }
      const state = await store.getState();
      const users = await store.listUsers();
      const modeledTasks = state.tasks.map((task) => taskModel(task, users, state.departments));
      // Task visibility boundary is applied before comments, subtasks and files
      // are attached to the response. Internal records never reach a client.
      const tasks = visibleTasks(modeledTasks, me).map((task) => taskForUser(task, me));
      const visibleIds = new Set(tasks.map((t) => t.id));
      const activity = me.role === "super_admin"
        ? state.activity.filter((a) => !a.taskId || visibleIds.has(a.taskId))
        : [];
      const channels = await store.listChannels();
      const normalLinks = state.links.filter((link) => link.type !== "task_file");
      const fileLinks = state.links.filter((link) => link.type === "task_file");
      const links = visibleLinks(normalLinks, me, { tasks: modeledTasks, channels });
      const attachmentsByTask = {};
      for (const link of fileLinks) {
        if (!visibleIds.has(link.taskId)) continue;
        const attachment = attachmentForUser(link, me);
        if (attachment) (attachmentsByTask[link.taskId] = attachmentsByTask[link.taskId] || []).push(attachment);
      }
      for (const task of tasks) task.attachments = attachmentsByTask[task.id] || [];
      return send(res, 200, {
        ...state,
        tasks,
        links,
        activity,
        lastVisit,
        team: me.role === "client" ? [] : state.team,
        departments: state.departments.filter((d) => d.active || me.role === "super_admin"),
        meta: { statuses: STATUSES, priorities: PRIORITIES },
      });
    }

    case "POST /api/tasks": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      const body = await readBody(req);
      const title = clean(body.title, 300);
      if (!title) return send(res, 400, { error: "Task title is required." });
      const workspace = await store.getState();
      const users = await store.listUsers();
      const departmentIds = uniqueStrings(body.departmentIds || [], 60)
        .map((value) => departmentId(value, workspace.departments))
        .filter((id) => workspace.departments.some((d) => d.id === id && d.active));
      if (!departmentIds.length && (body.assignedDept || body.department)) {
        departmentIds.push(...decodeDepartmentIds(body.assignedDept, body.department, workspace.departments));
      }
      if (!departmentIds.length) departmentIds.push("project-management");
      const assignmentMode = oneOf(body.assignmentMode, ["users", "departments", "whole_team"],
        (Array.isArray(body.ownerUsernames) && body.ownerUsernames.length) || body.privateFor ? "users" : "departments");
      let ownerUsernames = uniqueStrings(body.ownerUsernames || [], 30)
        .filter((username) => users.some((u) => u.username === username && u.active && isAssignableUser(u)));
      if (!ownerUsernames.length && body.privateFor) {
        const legacyTarget = users.find((u) => u.username === clean(body.privateFor, 30).toLowerCase() && u.active && isAssignableUser(u));
        if (legacyTarget) ownerUsernames.push(legacyTarget.username);
      }
      // NEONMONKI routes work to the team or department. Internal individual
      // assignment and the team directory stay on the delivery side.
      if (me.role === "client" || assignmentMode !== "users") ownerUsernames = [];

      let visibility = oneOf(body.visibility, ["shared", "team", "department", "private", "internal"],
        me.role === "client" ? "team" : "team");
      if (visibility === "internal") visibility = "team";
      if (me.role === "client" && !["team", "department"].includes(visibility)) visibility = "team";
      if (visibility === "private" && !ownerUsernames.length) {
        return send(res, 400, { error: "A private task needs at least one named owner." });
      }
      const primaryDepartment = workspace.departments.find((d) => d.id === departmentIds[0]);
      const owner = ownerNames(ownerUsernames, users);
      const privateFor = visibility === "private" ? (ownerUsernames[0] || "") : "";
      const now = new Date().toISOString();
      const task = await insertWithFreshId(store, "tasks", "NM-NEW", async (id) => {
        const t = {
          id,
          title,
          dateRequested: now.slice(0, 10),
          department: primaryDepartment ? primaryDepartment.name : "Project Management",
          project: clean(body.project, 150),
          description: clean(body.description, 4000),
          requestedBy: me.role === "client" ? me.name : clean(body.requestedBy, 100) || me.name,
          owner,
          supporting: clean(body.supporting, 150),
          priority: oneOf(body.priority, PRIORITIES, "Medium"),
          status: me.role === "client" ? "New Request" : oneOf(body.status, STATUSES, "Planned"),
          evidence: "Current",
          update: "",
          blocker: clean(body.blocker, 300),
          deliverable: clean(body.deliverable, 300),
          deliverableLink: clean(body.deliverableLink, 500),
          nextAction: clean(body.nextAction, 300),
          dueDate: clean(body.dueDate, 20),
          impact: clean(body.impact, 500),
          source: encodeTaskSource({
            label: body.fromChannel ? "Task Hub chat" : "Task Hub",
            assignmentMode,
            createdByUsername: me.username,
            createdByType: me.role === "client" ? "client" : "team",
          }),
          visibility,
          privateFor,
          assignedDept: encodeDepartmentIds(departmentIds, workspace.departments),
          updates: [{
            ts: now,
            by: me.name,
            text: me.role === "client"
              ? "Task requested from NEONMONKI. Waiting for the team to accept."
              : "Task created by the team.",
          }],
        };
        await store.insertTask(t);
        return t;
      });
      await store.logActivity({ ts: now, taskId: task.id, by: me.name, text: `created task “${task.title}”` });
      const modeled = taskModel(task, users, workspace.departments);
      for (const user of users) {
        if (!user.active || user.username === me.username || !isTeamRole(user.role)) continue;
        if (!canSeeTask(user, modeled)) continue;
        if (assignmentMode === "users" && !ownerUsernames.includes(user.username) && user.role !== "super_admin") continue;
        await store.notify({
          username: user.username,
          kind: "new_task",
          text: me.role === "client" ? `New NEONMONKI request: ${task.title}` : `${me.name} created task “${task.title}”`,
          taskId: task.id,
        });
      }
      return send(res, 201, { task: taskForUser(modeled, me) });
    }

    case "PATCH /api/tasks/:id": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      const id = parts[0];
      const context = await loadTaskContext(store, id);
      const task = context.task;
      if (!task || !canSeeTask(me, task)) return send(res, 404, { error: "Task not found." });
      const body = await readBody(req);
      const now = new Date().toISOString();

      const textFields = [
        "title", "project", "description", "supporting", "blocker", "deliverable",
        "deliverableLink", "nextAction", "dueDate", "update", "impact",
      ];
      const wantsFields = textFields.some((f) => f in body) || "priority" in body ||
        "ownerUsernames" in body || "departmentIds" in body || "assignmentMode" in body || "visibility" in body;
      const wantsStatus = "status" in body && body.status !== task.status;

      if (me.role === "client") {
        if (wantsFields && !(task.status === "New Request" && task.requestedBy === me.name)) {
          return send(res, 403, {
            error: "Task details are managed by the team. Post a comment if something needs to change.",
          });
        }
        if (wantsStatus && !clientStatusAllowed(task, body.status)) {
          return send(res, 403, {
            error: "As the client you can confirm work that's ready for review, send it back for revision, or hand a waiting task back to the team.",
          });
        }
      }

      const fields = {};
      for (const f of textFields) {
        if (f in body) fields[f] = clean(body[f], f === "description" ? 4000 : 500);
      }
      if ("priority" in body) fields.priority = oneOf(body.priority, PRIORITIES, task.priority);
      let patchedOwnerUsernames = task.ownerUsernames || [];
      if ("ownerUsernames" in body && me.role !== "client") {
        const ownerUsernames = uniqueStrings(body.ownerUsernames, 30).filter((username) =>
          context.users.some((u) => u.username === username && u.active && isAssignableUser(u))
        );
        patchedOwnerUsernames = ownerUsernames;
        fields.owner = ownerNames(ownerUsernames, context.users);
        fields.privateFor = task.visibility === "private" ? (ownerUsernames[0] || "") : task.privateFor;
      }
      if ("departmentIds" in body) {
        const ids = uniqueStrings(body.departmentIds, 60)
          .map((value) => departmentId(value, context.workspace.departments))
          .filter((deptId) => context.workspace.departments.some((d) => d.id === deptId && d.active));
        if (!ids.length) return send(res, 400, { error: "Choose at least one active department." });
        fields.assignedDept = encodeDepartmentIds(ids, context.workspace.departments);
        fields.department = context.workspace.departments.find((d) => d.id === ids[0]).name;
      }
      if ("assignmentMode" in body && me.role !== "client") {
        const assignmentMode = oneOf(body.assignmentMode, ["users", "departments", "whole_team"], task.assignmentMode);
        if (assignmentMode === "users" && !patchedOwnerUsernames.length) {
          return send(res, 400, { error: "Named-owner assignment needs at least one owner." });
        }
        if (assignmentMode !== "users") {
          patchedOwnerUsernames = [];
          fields.owner = "";
          fields.privateFor = "";
        }
        fields.source = encodeTaskSource({
          label: task.source || "Task Hub",
          assignmentMode,
          createdByUsername: task.createdByUsername,
          createdByType: task.createdByType,
        });
      }
      if ("visibility" in body) {
        let visibility = oneOf(body.visibility, ["shared", "team", "department", "private"], task.visibility);
        if (me.role === "client" && !["team", "department"].includes(visibility)) visibility = task.visibility;
        if (visibility === "private") {
          const owners = patchedOwnerUsernames;
          if (!owners.length) return send(res, 400, { error: "A private task needs at least one named owner." });
          fields.privateFor = owners[0];
        } else fields.privateFor = "";
        fields.visibility = visibility;
      }
      if ("status" in body) {
        const next = oneOf(body.status, STATUSES, null);
        if (!next) return send(res, 400, { error: "Unknown status." });
        if (next !== task.status) {
          const from = task.status;
          fields.status = next;
          await store.pushTaskUpdate(id, {
            ts: now, by: me.name,
            text: `Status changed from “${from}” to “${next}”.`,
            statusFrom: from, statusTo: next,
          });
          await store.logActivity({ ts: now, taskId: id, by: me.name, text: `moved “${task.title}” to ${next}` });
          await notifyTaskFollowers(store, task, me, `${me.name} moved “${task.title}” to ${next}`);
        }
      }
      const edited = Object.keys(fields).filter((f) => f !== "status");
      if (edited.length) {
        await store.pushTaskUpdate(id, {
          ts: now, by: me.name, text: `Edited task details: ${edited.join(", ")}.`,
        });
        await store.logActivity({ ts: now, taskId: id, by: me.name, text: `edited “${task.title}” (${edited.join(", ")})` });
        await notifyTaskFollowers(store, task, me, `${me.name} edited “${task.title}” (${edited.join(", ")})`);
      }
      if (Object.keys(fields).length) await store.updateTask(id, fields);
      const updated = await store.getTask(id);
      return send(res, 200, { task: taskForUser(taskModel(updated, context.users, context.workspace.departments), me) });
    }

    case "POST /api/tasks/:id/accept": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      if (!isTeamRole(me.role)) return send(res, 403, { error: "Only the team can accept requests." });
      const id = parts[0];
      const context = await loadTaskContext(store, id);
      const task = context.task;
      if (!task || !canSeeTask(me, task)) return send(res, 404, { error: "Task not found." });
      if (task.status !== "New Request") return send(res, 409, { error: "Task is not a new request." });
      const body = await readBody(req);
      const now = new Date().toISOString();
      const fields = { status: "In Progress" };
      const ownerUsernames = uniqueStrings(body.ownerUsernames || [], 30).filter((username) =>
        context.users.some((u) => u.username === username && u.active && isAssignableUser(u))
      );
      if (!ownerUsernames.length && body.owner) {
        const legacyOwner = context.users.find((u) => u.name === clean(body.owner, 150) && u.active && isAssignableUser(u));
        if (legacyOwner) ownerUsernames.push(legacyOwner.username);
      }
      if (!ownerUsernames.length) ownerUsernames.push(me.username);
      fields.owner = ownerNames(ownerUsernames, context.users);
      await store.updateTask(id, fields);
      await store.pushTaskUpdate(id, {
        ts: now, by: me.name,
        text: `Accepted by ${me.name}${fields.owner ? ` — owners: ${fields.owner}` : ""}. Work started.`,
        statusFrom: "New Request", statusTo: "In Progress",
      });
      await store.logActivity({ ts: now, taskId: id, by: me.name, text: `accepted “${task.title}”` });
      await notifyTaskFollowers(store, task, me, `${me.name} accepted “${task.title}”`);
      const updated = await store.getTask(id);
      return send(res, 200, { task: taskModel(updated, context.users, context.workspace.departments) });
    }

    case "DELETE /api/tasks/:id": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      const context = await loadTaskContext(store, parts[0]);
      const task = context.task;
      if (!task || !canSeeTask(me, task)) return send(res, 404, { error: "Task not found." });
      const ownUnacceptedRequest = me.role === "client" && task.status === "New Request"
        && (task.createdByUsername === me.username || task.requestedBy === me.name);
      const allowed = me.role === "super_admin" || ownUnacceptedRequest ||
        (isTeamRole(me.role) && (task.createdByUsername === me.username || canReviewTask(me, task)));
      if (!allowed) return send(res, 403, { error: "Only the task creator, an assigned owner, or the super admin can delete this task." });
      for (const link of context.workspace.links.filter((item) => item.taskId === task.id && item.type === "task_file")) {
        const meta = parseFileMeta(link.note);
        if (meta && meta.deliverableId) await store.deleteRow("deliverables", meta.deliverableId);
      }
      await store.deleteTask(task.id);
      await store.logActivity({ ts: new Date().toISOString(), taskId: null, by: me.name, text: `deleted task ${task.id} “${task.title}”` });
      return send(res, 200, { ok: true });
    }

    case "POST /api/tasks/:id/review": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      const context = await loadTaskContext(store, parts[0]);
      const task = context.task;
      if (!task || !canSeeTask(me, task)) return send(res, 404, { error: "Task not found." });
      const body = await readBody(req);
      const action = oneOf(body.action, ["send", "approve", "request_changes"], null);
      if (!action) return send(res, 400, { error: "Unknown approval action." });
      const now = new Date().toISOString();
      const links = context.workspace.links.filter((link) => link.taskId === task.id && link.type === "task_file");

      if (action === "send") {
        if (!canReviewTask(me, task)) return send(res, 403, { error: "Only a task owner or super admin can send work for client approval." });
        if (task.visibility !== "shared") return send(res, 409, { error: "Change task visibility to NEONMONKI + team before sending it for approval." });
        const deliverableLinks = links.map((link) => ({ link, meta: parseFileMeta(link.note) })).filter((item) => item.meta);
        if (!deliverableLinks.length) return send(res, 409, { error: "Add at least one deliverable link before requesting approval." });
        const notApproved = deliverableLinks.filter(({ meta }) => !["approved", "delivered"].includes(meta.status));
        if (notApproved.length) return send(res, 409, { error: "Approve every deliverable link before sending the task to the client." });
        for (const { link, meta } of deliverableLinks) {
          const next = {
            ...meta,
            status: "delivered",
            deliveredToClient: true,
            deliveredAt: now,
            deliveredBy: me.username,
            clientStatus: "awaiting_review",
            feedback: "",
          };
          if (!next.deliverableId) {
            const deliverable = await insertWithFreshId(store, "deliverables", "DEL", async (id) => {
              const item = {
                id, date: now.slice(0, 10), title: `${task.id} — ${link.title}`,
                workstream: task.department, owner: me.name, recipient: "NEONMONKI",
                status: "Delivered · awaiting approval", link: `/api/files/${encodeURIComponent(link.id)}/download`,
              };
              await store.insertRow("deliverables", item);
              return item;
            });
            next.deliverableId = deliverable.id;
          } else {
            await store.updateRow("deliverables", next.deliverableId, { status: "Delivered · awaiting approval" });
          }
          await store.updateLink(link.id, { note: encodeFileMeta(next) });
        }
        if (task.status !== "Waiting on Client") {
          await store.pushTaskUpdate(task.id, { ts: now, by: me.name, text: `Status changed from “${task.status}” to “Waiting on Client”.`, statusFrom: task.status, statusTo: "Waiting on Client" });
          await store.updateTask(task.id, { status: "Waiting on Client" });
        }
        await store.pushTaskUpdate(task.id, {
          ts: now, by: me.name,
          text: encodeTaskEvent("approval", { status: "awaiting_review", feedback: "", requestedBy: me.username, ts: now, by: me.name }),
        });
        for (const user of context.users.filter((user) => user.active && user.role === "client" && canSeeTask(user, task))) {
          await store.notify({ username: user.username, kind: "approval", text: `${me.name} sent “${task.title}” for your approval`, taskId: task.id });
        }
      } else {
        if (me.role !== "client" || !task.approval || task.approval.status !== "awaiting_review") {
          return send(res, 403, { error: "This task is not waiting for your approval." });
        }
        const feedback = clean(body.feedback, 1200);
        if (action === "request_changes" && !feedback) return send(res, 400, { error: "Tell the team what needs to change." });
        const approved = action === "approve";
        for (const link of links) {
          const meta = parseFileMeta(link.note);
          if (!meta || !meta.deliveredToClient) continue;
          const next = { ...meta, clientStatus: approved ? "approved" : "changes_requested", clientReviewedAt: now, clientReviewedBy: me.username, feedback: feedback || meta.feedback || "" };
          await store.updateLink(link.id, { note: encodeFileMeta(next) });
          if (next.deliverableId) await store.updateRow("deliverables", next.deliverableId, { status: approved ? "Delivered · approved" : "Delivered · changes requested" });
        }
        const nextStatus = approved ? "Completed" : "Revision Required";
        await store.pushTaskUpdate(task.id, { ts: now, by: me.name, text: `Status changed from “${task.status}” to “${nextStatus}”.`, statusFrom: task.status, statusTo: nextStatus });
        await store.pushTaskUpdate(task.id, {
          ts: now, by: me.name,
          text: encodeTaskEvent("approval", { status: approved ? "approved" : "changes_requested", feedback, decidedBy: me.username, ts: now, by: me.name }),
        });
        await store.updateTask(task.id, { status: nextStatus });
        for (const username of task.ownerUsernames || []) {
          if (username !== me.username) await store.notify({ username, kind: "approval", text: `${me.name} ${approved ? "approved" : "requested changes to"} “${task.title}”`, taskId: task.id });
        }
      }
      await store.logActivity({ ts: now, taskId: task.id, by: me.name, text: `${action.replace(/_/g, " ")} approval for “${task.title}”` });
      const updated = await store.getTask(task.id);
      return send(res, 200, { task: taskForUser(taskModel(updated, context.users, context.workspace.departments), me) });
    }

    case "POST /api/tasks/:id/updates": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      const id = parts[0];
      const context = await loadTaskContext(store, id);
      const task = context.task;
      if (!task || !canSeeTask(me, task)) return send(res, 404, { error: "Task not found." });
      const body = await readBody(req);
      const text = clean(body.text, 2000);
      const wantsStatus =
        body.status && STATUSES.includes(body.status) && body.status !== task.status;
      if (!text && !wantsStatus) {
        return send(res, 400, { error: "Write an update or choose a new status." });
      }
      if (me.role === "client" && wantsStatus && !clientStatusAllowed(task, body.status)) {
        return send(res, 403, {
          error: "As the client you can confirm work that's ready for review, send it back for revision, or hand a waiting task back to the team.",
        });
      }
      const now = new Date().toISOString();
      if (text) {
        await store.pushTaskUpdate(id, { ts: now, by: me.name, text });
        await store.updateTask(id, { update: text });
        await store.logActivity({ ts: now, taskId: id, by: me.name, text: `updated “${task.title}”` });
        await notifyTaskFollowers(store, task, me, `${me.name} commented on “${task.title}”`);
      }
      if (wantsStatus) {
        await store.pushTaskUpdate(id, {
          ts: now, by: me.name,
          text: `Status changed from “${task.status}” to “${body.status}”.`,
          statusFrom: task.status, statusTo: body.status,
        });
        await store.updateTask(id, { status: body.status });
        await store.logActivity({ ts: now, taskId: id, by: me.name, text: `moved “${task.title}” to ${body.status}` });
        await notifyTaskFollowers(store, task, me, `${me.name} moved “${task.title}” to ${body.status}`);
      }
      const updated = await store.getTask(id);
      return send(res, 200, { task: taskForUser(taskModel(updated, context.users, context.workspace.departments), me) });
    }

    case "POST /api/tasks/:id/comments": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      const context = await loadTaskContext(store, parts[0]);
      const task = context.task;
      if (!task || !canSeeTask(me, task)) return send(res, 404, { error: "Task not found." });
      const body = await readBody(req);
      const text = clean(body.text, 3000);
      if (!text) return send(res, 400, { error: "Write a comment first." });
      const now = new Date().toISOString();
      const comment = {
        id: generatedEntityId("CMT"),
        text,
        authorUsername: me.username,
        by: me.name,
        ts: now,
        clientVisible: me.role === "client" ? true : (task.visibility === "shared" && body.clientVisible === true),
        mentions: parseMentionUsernames(text),
      };
      await store.pushTaskUpdate(task.id, {
        ts: now, by: me.name, text: encodeTaskEvent("comment", comment),
      });
      await store.updateTask(task.id, { update: text });
      await store.logActivity({ ts: now, taskId: task.id, by: me.name, text: `commented on “${task.title}”` });
      await notifyCommentRecipients(store, task, me, comment, context.users);
      return send(res, 201, { comment });
    }

    case "DELETE /api/tasks/:id/comments/:commentId": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      const context = await loadTaskContext(store, parts[0]);
      const task = context.task;
      if (!task || !canSeeTask(me, task)) return send(res, 404, { error: "Task not found." });
      const comment = (task.comments || []).find((c) => c.id === parts[1]);
      if (!comment || comment.deleted) return send(res, 404, { error: "Comment not found." });
      if (comment.authorUsername !== me.username) {
        return send(res, 403, { error: "You can only delete your own comments." });
      }
      const now = new Date().toISOString();
      await store.pushTaskUpdate(task.id, {
        ts: now, by: me.name,
        text: encodeTaskEvent("comment_delete", { commentId: comment.id, ts: now, by: me.name }),
      });
      return send(res, 200, { ok: true });
    }

    case "POST /api/tasks/:id/subtasks": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      const context = await loadTaskContext(store, parts[0]);
      const task = context.task;
      if (!task || !canSeeTask(me, task)) return send(res, 404, { error: "Task not found." });
      const clientCanPlan = me.role === "client" && task.status === "New Request"
        && (task.createdByUsername === me.username || task.requestedBy === me.name);
      if (!isTeamRole(me.role) && !clientCanPlan) {
        return send(res, 403, { error: "Subtasks can only be added by the team or while preparing your own new request." });
      }
      const body = await readBody(req);
      const title = clean(body.title, 300);
      if (!title) return send(res, 400, { error: "Subtask title is required." });
      const ownerUsernames = (me.role === "client" ? [] : uniqueStrings(body.ownerUsernames, 30)).filter((username) =>
        context.users.some((u) => u.username === username && u.active && isAssignableUser(u))
      );
      const departmentIds = uniqueStrings(body.departmentIds, 60)
        .map((value) => departmentId(value, context.workspace.departments))
        .filter((id) => context.workspace.departments.some((d) => d.id === id && d.active));
      const now = new Date().toISOString();
      const subtask = {
        id: generatedEntityId("ST"),
        title,
        description: clean(body.description, 2000),
        status: oneOf(body.status, STATUSES, "Planned"),
        priority: oneOf(body.priority, PRIORITIES, task.priority || "Medium"),
        dueDate: clean(body.dueDate, 20),
        ownerUsernames,
        departmentIds: departmentIds.length ? departmentIds : task.departmentIds,
        clientVisible: me.role === "client" || (task.visibility === "shared" && body.clientVisible === true),
        createdBy: me.username,
        createdByName: me.name,
        createdAt: now,
        updatedAt: now,
      };
      await store.pushTaskUpdate(task.id, {
        ts: now, by: me.name, text: encodeTaskEvent("subtask_upsert", { subtask }),
      });
      for (const username of ownerUsernames) {
        if (username !== me.username) {
          await store.notify({ username, kind: "subtask", text: `${me.name} assigned you subtask “${title}”`, taskId: task.id });
        }
      }
      return send(res, 201, { subtask });
    }

    case "PATCH /api/tasks/:id/subtasks/:subtaskId": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      if (!isTeamRole(me.role)) return send(res, 403, { error: "Subtasks are managed by the delivery team." });
      const context = await loadTaskContext(store, parts[0]);
      const task = context.task;
      if (!task || !canSeeTask(me, task)) return send(res, 404, { error: "Task not found." });
      const current = (task.subtasks || []).find((s) => s.id === parts[1]);
      if (!current) return send(res, 404, { error: "Subtask not found." });
      const body = await readBody(req);
      const next = { ...current, updatedAt: new Date().toISOString(), updatedBy: me.username };
      for (const field of ["title", "description", "dueDate"]) {
        if (field in body) next[field] = clean(body[field], field === "description" ? 2000 : 300);
      }
      if ("status" in body) next.status = oneOf(body.status, STATUSES, current.status);
      if ("priority" in body) next.priority = oneOf(body.priority, PRIORITIES, current.priority);
      if ("clientVisible" in body) next.clientVisible = task.visibility === "shared" && body.clientVisible === true;
      if ("ownerUsernames" in body) next.ownerUsernames = uniqueStrings(body.ownerUsernames, 30).filter((username) =>
        context.users.some((u) => u.username === username && u.active && isAssignableUser(u))
      );
      if ("departmentIds" in body) next.departmentIds = uniqueStrings(body.departmentIds, 60)
        .map((value) => departmentId(value, context.workspace.departments))
        .filter((id) => context.workspace.departments.some((d) => d.id === id && d.active));
      await store.pushTaskUpdate(task.id, {
        ts: next.updatedAt, by: me.name, text: encodeTaskEvent("subtask_upsert", { subtask: next }),
      });
      return send(res, 200, { subtask: next });
    }

    case "DELETE /api/tasks/:id/subtasks/:subtaskId": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      if (!isTeamRole(me.role)) return send(res, 403, { error: "Subtasks are managed by the delivery team." });
      const context = await loadTaskContext(store, parts[0]);
      const task = context.task;
      if (!task || !canSeeTask(me, task)) return send(res, 404, { error: "Task not found." });
      if (!(task.subtasks || []).some((s) => s.id === parts[1])) return send(res, 404, { error: "Subtask not found." });
      await store.pushTaskUpdate(task.id, {
        ts: new Date().toISOString(), by: me.name,
        text: encodeTaskEvent("subtask_delete", { subtaskId: parts[1] }),
      });
      return send(res, 200, { ok: true });
    }

    case "POST /api/tasks/:id/files": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      const context = await loadTaskContext(store, parts[0]);
      const task = context.task;
      if (!task || !canSeeTask(me, task)) return send(res, 404, { error: "Task not found." });
      const body = await readBody(req);
      const name = clean(body.name || body.title, 180);
      const url = sharedLink(body.url);
      if (!name) return send(res, 400, { error: "Link title is required." });
      if (!url) return send(res, 400, { error: "Enter a valid HTTPS sharing link." });
      const subtaskId = clean(body.subtaskId, 80);
      if (subtaskId && !(task.subtasks || []).some((s) => s.id === subtaskId)) {
        return send(res, 400, { error: "Subtask not found." });
      }
      const now = new Date().toISOString();
      const meta = {
        mime: "link",
        size: 0,
        subtaskId,
        status: me.role === "client" ? "submitted_by_client" : "pending_review",
        uploadedBy: me.username,
        uploadedByName: me.name,
        uploadedByType: me.role === "client" ? "client" : "team",
        uploadedAt: now,
        deliveredToClient: me.role === "client",
        deliveredAt: me.role === "client" ? now : null,
        clientStatus: me.role === "client" ? "submitted" : "not_sent",
        feedback: "",
      };
      const link = await insertWithFreshId(store, "links", "FILE", async (id) => {
        const record = {
          id, taskId: task.id, date: now.slice(0, 10), workstream: subtaskId || task.id,
          title: name, url, type: "task_file", owner: me.name, note: encodeFileMeta(meta),
        };
        await store.insertRow("links", record);
        return record;
      });
      await store.logActivity({ ts: now, taskId: task.id, by: me.name, text: `shared link “${name}”` });
      await notifyTaskFollowers(store, task, me, `${me.name} shared “${name}” on “${task.title}”`);
      return send(res, 201, { attachment: attachmentForUser(link, me) });
    }

    case "PATCH /api/tasks/:id/files/:fileId": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      const context = await loadTaskContext(store, parts[0]);
      const task = context.task;
      if (!task || !canSeeTask(me, task)) return send(res, 404, { error: "Task not found." });
      const link = await store.getLink(parts[1]);
      if (!link || link.taskId !== task.id || link.type !== "task_file") return send(res, 404, { error: "Shared link not found." });
      const meta = parseFileMeta(link.note);
      if (!meta) return send(res, 409, { error: "Link review information is unavailable." });
      const body = await readBody(req);
      const action = oneOf(body.action, ["approve", "reject", "deliver", "client_approve", "client_changes"], null);
      if (!action) return send(res, 400, { error: "Unknown file action." });
      const now = new Date().toISOString();
      const next = { ...meta, feedback: clean(body.feedback, 1000) || meta.feedback || "" };
      if (["approve", "reject", "deliver"].includes(action)) {
        if (!canReviewTask(me, task)) return send(res, 403, { error: "Only a task owner or super admin can review and deliver links." });
        if (action === "approve") {
          next.status = "approved"; next.reviewedBy = me.username; next.reviewedByName = me.name; next.reviewedAt = now;
        }
        if (action === "reject") {
          next.status = "rejected"; next.reviewedBy = me.username; next.reviewedByName = me.name; next.reviewedAt = now;
        }
        if (action === "deliver") {
          if (next.status !== "approved") return send(res, 409, { error: "Approve the link before delivering it." });
          const clientCanSee = context.users.some((u) => u.active && u.role === "client" && canSeeTask(u, task));
          if (!clientCanSee) return send(res, 409, { error: "Share this task with NEONMONKI before delivering its link." });
          next.status = "delivered"; next.deliveredToClient = true; next.deliveredAt = now; next.deliveredBy = me.username;
          next.clientStatus = "awaiting_review";
          const deliverable = await insertWithFreshId(store, "deliverables", "DEL", async (id) => {
            const item = {
              id, date: now.slice(0, 10), title: `${task.id} — ${link.title}`,
              workstream: task.department, owner: me.name, recipient: "NEONMONKI",
              status: "Delivered · awaiting approval", link: `/api/files/${encodeURIComponent(link.id)}/download`,
            };
            await store.insertRow("deliverables", item);
            return item;
          });
          next.deliverableId = deliverable.id;
          for (const user of context.users.filter((u) => u.active && u.role === "client" && canSeeTask(u, task))) {
            await store.notify({ username: user.username, kind: "delivery", text: `${me.name} delivered “${link.title}” for review`, taskId: task.id });
          }
        }
      } else {
        if (me.role !== "client" || !next.deliveredToClient) return send(res, 403, { error: "This link has not been delivered to you." });
        next.clientStatus = action === "client_approve" ? "approved" : "changes_requested";
        next.clientReviewedAt = now; next.clientReviewedBy = me.username;
        if (next.deliverableId) {
          await store.updateRow("deliverables", next.deliverableId, {
            status: action === "client_approve" ? "Delivered · approved" : "Delivered · changes requested",
          });
        }
        for (const username of task.ownerUsernames || []) {
          if (username !== me.username) await store.notify({
            username, kind: "delivery_review",
            text: `${me.name} ${action === "client_approve" ? "approved" : "requested changes to"} “${link.title}”`,
            taskId: task.id,
          });
        }
      }
      const updated = await store.updateLink(link.id, { note: encodeFileMeta(next) });
      await store.logActivity({ ts: now, taskId: task.id, by: me.name, text: `${action.replace(/_/g, " ")} link “${link.title}”` });
      return send(res, 200, { attachment: attachmentForUser(updated, me) });
    }

    case "GET /api/files/:fileId/download": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      const link = await store.getLink(parts[0]);
      if (!link || link.type !== "task_file") return send(res, 404, { error: "Shared link not found." });
      const context = await loadTaskContext(store, link.taskId);
      if (!context.task || !canSeeTask(me, context.task)) return send(res, 404, { error: "Shared link not found." });
      const meta = parseFileMeta(link.note);
      if (!meta || (me.role === "client" && !meta.deliveredToClient && meta.uploadedBy !== me.username)) {
        return send(res, 404, { error: "Shared link not found." });
      }
      const url = sharedLink(link.url);
      if (!url) {
        if (sendLegacyDownload(res, link.url, link.title)) return;
        return send(res, 404, { error: "Shared link is unavailable." });
      }
      res.writeHead(302, {
        Location: url,
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      });
      return res.end();
    }

    case "POST /api/deliverables": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      if (!isTeamRole(me.role)) return send(res, 403, { error: "Only the team can log deliverables." });
      const body = await readBody(req);
      const title = clean(body.title, 300);
      if (!title) return send(res, 400, { error: "Deliverable title is required." });
      const now = new Date().toISOString();
      const item = await insertWithFreshId(store, "deliverables", "DEL", async (id) => {
        const it = {
          id,
          date: clean(body.date, 20) || now.slice(0, 10),
          title,
          workstream: clean(body.workstream, 100),
          owner: clean(body.owner, 100),
          recipient: clean(body.recipient, 100) || "Adika",
          status: clean(body.status, 100) || "Shared",
          link: clean(body.link, 500),
        };
        await store.insertRow("deliverables", it);
        return it;
      });
      await store.logActivity({ ts: now, taskId: null, by: me.name, text: `logged deliverable “${item.title}”` });
      return send(res, 201, { item });
    }

    case "POST /api/decisions": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      const body = await readBody(req);
      const rule = clean(body.rule, 1000);
      if (!rule) return send(res, 400, { error: "Decision text is required." });
      const now = new Date().toISOString();
      const item = await insertWithFreshId(store, "decisions", "DEC", async (id) => {
        const it = {
          id,
          date: clean(body.date, 20) || now.slice(0, 10),
          topic: clean(body.topic, 200),
          rule,
          workstream: clean(body.workstream, 100),
          owner: clean(body.owner, 100),
        };
        await store.insertRow("decisions", it);
        return it;
      });
      await store.logActivity({ ts: now, taskId: null, by: me.name, text: `recorded decision “${item.topic || item.rule.slice(0, 40)}”` });
      return send(res, 201, { item });
    }

    case "POST /api/links": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      const body = await readBody(req);
      const title = clean(body.title, 300);
      if (!title) return send(res, 400, { error: "Title is required." });
      if (body.taskId && !/^[\w-]+$/.test(String(body.taskId))) return send(res, 400, { error: "Invalid task id." });
      const taskId = clean(body.taskId, 30);
      const channelId = clean(body.channelId, 60);
      if (taskId) {
        const task = await store.getTask(taskId);
        if (!task || !canSeeTask(me, task)) return send(res, 404, { error: "Task not found." });
      }
      if (channelId) {
        const channel = await store.getChannel(channelId);
        if (!channel) return send(res, 404, { error: "Channel not found." });
        if (!canAccessChannel(channel, me)) return send(res, 403, { error: "Not a member of this channel." });
      }
      const item = await insertWithFreshId(store, "links", "LNK", async (id) => {
        const it = {
          id,
          taskId,
          channelId,
          date: clean(body.date, 20) || new Date().toISOString().slice(0, 10),
          workstream: clean(body.workstream, 100),
          title,
          url: clean(body.url, 500),
          type: clean(body.type, 60),
          owner: clean(body.owner, 100) || me.name,
          note: clean(body.note, 300),
        };
        await store.insertRow("links", it);
        return it;
      });
      return send(res, 201, { item });
    }

    /* ------------------------------ metrics (results tracking) ------------------------------ */

    case "GET /api/metrics": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      // Metrics are shared business results — every signed-in role may read them.
      const url = new URL(req.url, "http://localhost");
      const from = clean(url.searchParams.get("from"), 10);
      const to = clean(url.searchParams.get("to"), 10);
      if ((from && !validDay(from)) || (to && !validDay(to))) {
        return send(res, 400, { error: "Dates must be YYYY-MM-DD." });
      }
      return send(res, 200, { entries: await store.metricsList(from || null, to || null) });
    }

    case "POST /api/metrics": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      if (!isTeamRole(me.role)) return send(res, 403, { error: "Only the team can record results." });
      const body = await readBody(req);
      const date = clean(body.date, 10) || todayStr();
      if (!validDay(date)) return send(res, 400, { error: "Date must be YYYY-MM-DD." });
      const channel = clean(body.channel, 60);
      const metric = clean(body.metric, 80);
      if (!channel || !metric) return send(res, 400, { error: "Channel and metric are required." });
      if (body.value === undefined || body.value === null || body.value === "") {
        return send(res, 400, { error: "Value must be a number." });
      }
      const value = Number(body.value);
      if (!Number.isFinite(value)) return send(res, 400, { error: "Value must be a number." });
      const entry = await store.metricInsert({
        date, channel, metric, value,
        note: clean(body.note, 500),
        createdBy: me.username,
      });
      await store.logActivity({
        ts: new Date().toISOString(), taskId: null, by: me.name,
        text: `recorded result: ${channel} ${metric} = ${value} (${date})`,
      });
      return send(res, 201, { entry });
    }

    case "DELETE /api/metrics/:id": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      if (me.role !== "super_admin") return send(res, 403, { error: "Super admin only." });
      await store.metricDelete(parts[0]);
      return send(res, 200, { ok: true });
    }

    case "GET /api/metrics/summary": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      const url = new URL(req.url, "http://localhost");
      const rawFrom = clean(url.searchParams.get("from"), 10);
      const rawTo = clean(url.searchParams.get("to"), 10);
      const rawCmpFrom = clean(url.searchParams.get("cmpfrom"), 10);
      const rawCmpTo = clean(url.searchParams.get("cmpto"), 10);
      for (const d of [rawFrom, rawTo, rawCmpFrom, rawCmpTo]) {
        if (d && !validDay(d)) return send(res, 400, { error: "Dates must be YYYY-MM-DD." });
      }
      const to = rawTo || todayStr();
      const from = rawFrom || shiftDays(to, -6);
      const cmpto = rawCmpTo || shiftDays(from, -1);
      const cmpfrom = rawCmpFrom || shiftDays(cmpto, -dayCount(from, to));
      if (from > to || cmpfrom > cmpto) {
        return send(res, 400, { error: "Range start must not be after range end." });
      }
      const [current, previous] = await Promise.all([
        store.metricsList(from, to),
        store.metricsList(cmpfrom, cmpto),
      ]);
      return send(res, 200, {
        from, to, cmpfrom, cmpto,
        channels: metricsSummary(current, previous),
      });
    }

    /* ------------------------------ smart reporting ------------------------------ */
    // Dashboards NEVER call Hyros live — every read below is served from the
    // synced reporting facts store via lib/reporting.js. Syncing (backfill +
    // incremental + webhooks) is the only path that talks to Hyros.

    // Client-safe "Performance" payload: real marketing results with no
    // data-quality diagnostics. Open to both reporting tiers ("basic" and
    // "full"); 403 only when reportingAccess resolves to "none".
    case "GET /api/reporting/basic": {
      const me = await basicReportingUser(req, res, store);
      if (!me) return;
      const url = new URL(req.url, "http://localhost");
      const range = parseReportingRange(url);
      if (range.error) return send(res, 400, { error: range.error });
      const reporting = reportingModule();
      if (!reporting || typeof reporting.reportingBasic !== "function") {
        return send(res, 503, { error: "Reporting is not available on this deployment yet." });
      }
      return send(res, 200, await reporting.reportingBasic(range));
    }

    case "GET /api/reporting/status": {
      const me = await smartReportingUser(req, res, store);
      if (!me) return;
      const reporting = reportingModule();
      if (!reporting) return send(res, 503, { error: "Smart Reporting is not available on this deployment yet." });
      const integration = typeof store.getIntegration === "function"
        ? await store.getIntegration(HYROS_INTEGRATION_ID)
        : null;
      const recordCount = typeof store.reportingFactsCount === "function"
        ? await store.reportingFactsCount({ integrationId: HYROS_INTEGRATION_ID })
        : 0;
      let latestEventAt = null;
      try {
        const activity = await reporting.reportingActivity({ limit: 1 });
        const rows = Array.isArray(activity)
          ? activity
          : (activity && (activity.rows || activity.events || activity.items)) || [];
        if (rows[0]) {
          const stamp = rows[0].occurredAt || rows[0].date || rows[0].ts || rows[0].eventAt || "";
          latestEventAt = String(stamp).slice(0, 25) || null;
        }
      } catch { /* activity feed is optional for status */ }
      return send(res, 200, {
        connected: !!(integration && integration.status === "connected"),
        lastSyncAt: (integration && integration.lastSyncAt) || null,
        lastWebhookAt: (integration && integration.lastWebhookAt) || null,
        rateLimited: !!(integration && integration.lastError === "rate_limited"),
        backfillPending: !!(integration && integration.backfill && integration.backfill.done === false),
        recordCount,
        latestEventAt,
        filters: typeof reporting.reportingFilterValues === "function"
          ? await reporting.reportingFilterValues()
          : {},
      });
    }

    case "GET /api/reporting/overview": {
      const me = await smartReportingUser(req, res, store);
      if (!me) return;
      const url = new URL(req.url, "http://localhost");
      const range = parseReportingRange(url, { comparison: true });
      if (range.error) return send(res, 400, { error: range.error });
      const reporting = reportingModule();
      if (!reporting) return send(res, 503, { error: "Smart Reporting is not available on this deployment yet." });
      const result = await reporting.reportingOverview({ ...range, ...reportingFiltersFrom(url) });
      return send(res, 200, result);
    }

    case "GET /api/reporting/trend": {
      const me = await smartReportingUser(req, res, store);
      if (!me) return;
      const url = new URL(req.url, "http://localhost");
      const range = parseReportingRange(url);
      if (range.error) return send(res, 400, { error: range.error });
      const granularity = oneOf(clean(url.searchParams.get("granularity"), 10) || "day", ["hour", "day", "week", "month"], null);
      if (!granularity) return send(res, 400, { error: "Granularity must be hour, day, week or month." });
      if (granularity === "hour" && dayCount(range.from, range.to) > 14) {
        return send(res, 400, { error: "Hour granularity is limited to ranges of 14 days or less." });
      }
      const reporting = reportingModule();
      if (!reporting) return send(res, 503, { error: "Smart Reporting is not available on this deployment yet." });
      const opts = { ...range, granularity, ...reportingFiltersFrom(url) };
      const metric = clean(url.searchParams.get("metric"), 40);
      if (metric) opts.metric = metric;
      return send(res, 200, await reporting.reportingTrend(opts));
    }

    case "GET /api/reporting/breakdown": {
      const me = await smartReportingUser(req, res, store);
      if (!me) return;
      const url = new URL(req.url, "http://localhost");
      const range = parseReportingRange(url);
      if (range.error) return send(res, 400, { error: range.error });
      const dimension = oneOf(clean(url.searchParams.get("dimension"), 20) || "channel", ["channel", "platform", "source", "campaign"], null);
      if (!dimension) return send(res, 400, { error: "Dimension must be channel, platform, source or campaign." });
      const reporting = reportingModule();
      if (!reporting) return send(res, 503, { error: "Smart Reporting is not available on this deployment yet." });
      const opts = { ...range, dimension, ...reportingFiltersFrom(url) };
      return send(res, 200, await reporting.reportingBreakdown(opts));
    }

    case "GET /api/reporting/activity": {
      const me = await smartReportingUser(req, res, store);
      if (!me) return;
      const url = new URL(req.url, "http://localhost");
      const opts = reportingFiltersFrom(url);
      for (const name of ["from", "to"]) {
        const value = clean(url.searchParams.get(name), 10);
        if (value && !validDay(value)) return send(res, 400, { error: "Dates must be YYYY-MM-DD." });
        if (value) opts[name] = value;
      }
      opts.limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit")) || 20));
      const reporting = reportingModule();
      if (!reporting) return send(res, 503, { error: "Smart Reporting is not available on this deployment yet." });
      return send(res, 200, await reporting.reportingActivity(opts));
    }

    case "GET /api/reporting/filters": {
      const me = await smartReportingUser(req, res, store);
      if (!me) return;
      const reporting = reportingModule();
      if (!reporting) return send(res, 503, { error: "Smart Reporting is not available on this deployment yet." });
      return send(res, 200, await reporting.reportingFilterValues());
    }

    /* ------------------------------ hyros integration ------------------------------ */

    case "GET /api/integrations/hyros/status": {
      const me = await smartReportingUser(req, res, store);
      if (!me) return;
      const integration = typeof store.getIntegration === "function"
        ? await store.getIntegration(HYROS_INTEGRATION_ID)
        : null;
      // Public view only — the encrypted key and the webhook token never leave.
      return send(res, 200, await hyrosPublicStatus(store, integration));
    }

    /* --- Hyros OAuth (official MCP "Connect" flow: OAuth 2.1 + PKCE + DCR) --- */

    case "GET /api/integrations/hyros/oauth/start": {
      const me = await smartReportingUser(req, res, store);
      if (!me) return;
      const mcp = require("./hyros-mcp");
      try {
        const meta = await mcp.discoverOAuth();
        const redirectUri = `${requestOrigin(req)}/api/integrations/hyros/oauth/callback`;
        const client = await mcp.registerClient(meta, redirectUri);
        const state = crypto.randomBytes(24).toString("base64url");
        const { verifier, challenge } = mcp.newPkcePair();
        await store.putIntegration(HYROS_INTEGRATION_ID, {
          oauthPending: {
            stateHash: sha256Text(state),
            verifier,
            redirectUri,
            clientId: client.clientId,
            clientSecretEncrypted: client.clientSecret
              ? ai.encryptSecret(client.clientSecret, HYROS_CIPHER_CONTEXT)
              : "",
            createdAt: new Date().toISOString(),
          },
          updatedAt: new Date().toISOString(),
        });
        const url = mcp.buildAuthorizationUrl(meta, {
          clientId: client.clientId, redirectUri, state, codeChallenge: challenge,
        });
        res.writeHead(302, { Location: url, "Cache-Control": "private, no-store" });
        return res.end();
      } catch (e) {
        console.error("[hyros-oauth] start failed:", e && e.status ? `HTTP ${e.status}` : "unreachable");
        res.writeHead(302, { Location: "/?hyros=oauth-start-failed#/admin" });
        return res.end();
      }
    }

    case "GET /api/integrations/hyros/oauth/callback": {
      // The browser returns here after the Hyros sign-in. SameSite=Lax session
      // cookie rides along, so the normal super-admin gate still applies.
      const me = await smartReportingUser(req, res, store);
      if (!me) return;
      const mcp = require("./hyros-mcp");
      const fail = (reason) => {
        res.writeHead(302, { Location: `/?hyros=${encodeURIComponent(reason)}#/admin` });
        return res.end();
      };
      try {
        const url = new URL(req.url, "http://localhost");
        const q = url.searchParams;
        if (q.get("error")) return fail("oauth-denied");
        const code = clean(q.get("code"), 500);
        const state = clean(q.get("state"), 200);
        if (!code || !state) return fail("oauth-invalid");
        const secrets = await store.getIntegrationSecret(HYROS_INTEGRATION_ID);
        const pending = (secrets && secrets.oauthPending) || {};
        const fresh = pending.createdAt && (Date.now() - Date.parse(pending.createdAt)) < 10 * 60 * 1000;
        if (!fresh || !pending.stateHash || sha256Text(state) !== pending.stateHash) return fail("oauth-state");
        const meta = await mcp.discoverOAuth();
        const client = {
          clientId: pending.clientId,
          clientSecret: ai.decryptSecret(pending.clientSecretEncrypted, HYROS_CIPHER_CONTEXT),
        };
        const tokens = await mcp.exchangeCode(meta, client, { code, redirectUri: pending.redirectUri, verifier: pending.verifier });

        // Prove the whole chain with a real read-only call BEFORE persisting.
        // Exception: a 429 means the tokens are valid and Hyros is just
        // throttling — connect anyway and let the daily cron / next manual
        // sync run the backfill once the limit lifts.
        const hyros = hyrosModule();
        const testCfg = {
          authMethod: "oauth", clientId: client.clientId, clientSecret: client.clientSecret,
          accessToken: tokens.accessToken, accessExpiresAt: tokens.accessExpiresAt,
          refreshToken: tokens.refreshToken,
        };
        let test = null;
        let testRateLimited = false;
        if (hyros) {
          try {
            test = await hyros.testConnection(testCfg);
          } catch (e) {
            if (!isHyrosRateLimited(e)) throw e;
            testRateLimited = true;
          }
        }
        if (!testRateLimited && (!test || !test.ok)) return fail("oauth-test");

        const now = new Date().toISOString();
        const webhookToken = crypto.randomBytes(24).toString("base64url");
        const existing = await store.getIntegration(HYROS_INTEGRATION_ID);
        await store.putIntegration(HYROS_INTEGRATION_ID, {
          status: "connected",
          authMethod: "oauth",
          accountName: testRateLimited ? "NEONMONKI" : (clean(test.accountName || "", 120) || "NEONMONKI"),
          oauthClientId: client.clientId,
          oauthClientSecretEncrypted: pending.clientSecretEncrypted || "",
          oauthAccessTokenEncrypted: ai.encryptSecret(tokens.accessToken, HYROS_CIPHER_CONTEXT),
          oauthAccessExpiresAt: tokens.accessExpiresAt,
          oauthRefreshTokenEncrypted: tokens.refreshToken
            ? ai.encryptSecret(tokens.refreshToken, HYROS_CIPHER_CONTEXT)
            : "",
          oauthPending: {},
          // an oauth connection replaces any stale api-key credential
          apiKeyEncrypted: "",
          ...(existing && existing.hasWebhookToken ? {} : { webhookTokenHash: sha256Text(webhookToken) }),
          lastError: testRateLimited ? "rate_limited" : "",
          backfill: { cursor: null, done: false, aggDay: null },
          connectedBy: me.username,
          connectedAt: now,
          updatedAt: now,
        });
        // Kick the historical backfill with the live tokens; remaining windows
        // resume via POST /sync or the daily cron (both refresh tokens first).
        // Skipped while rate-limited — those same paths pick it up later.
        const cfg = hyrosConfig(await store.getIntegrationSecret(HYROS_INTEGRATION_ID), store);
        const backfill = testRateLimited || !hyros
          ? { recordsIn: 0, done: false }
          : await runHyrosBackfill(store, hyros, cfg, (existing && existing.historicalDays) || 90);
        await store.logActivity({
          ts: new Date().toISOString(), taskId: null, by: me.name,
          text: testRateLimited
            ? "connected Hyros via OAuth (sync rate-limited — retries automatically)"
            : `connected Hyros via OAuth (${backfill.recordsIn} records synced${backfill.done ? "" : ", history continues in background"})`,
        });
        res.writeHead(302, { Location: "/?hyros=connected#/admin" });
        return res.end();
      } catch (e) {
        console.error("[hyros-oauth] callback failed:", e && e.status ? `HTTP ${e.status}` : "error");
        return fail(e && e.reconnectRequired ? "oauth-expired" : "oauth-failed");
      }
    }

    case "POST /api/integrations/hyros/connect": {
      const me = await smartReportingUser(req, res, store);
      if (!me) return;
      const hyros = hyrosModule();
      if (!hyros) return send(res, 503, { error: "The Hyros connector is not available on this deployment yet." });
      const body = await readBody(req);
      const apiKey = String(body.apiKey || "").trim();
      if (apiKey.length < 12 || apiKey.length > 500 || /\s/.test(apiKey)) {
        return send(res, 400, { error: "The Hyros API key must be 12–500 characters with no spaces." });
      }
      const historicalDays = body.historicalDays == null ? 90 : Number(body.historicalDays);
      if (![30, 90, 180, 365].includes(historicalDays)) {
        return send(res, 400, { error: "Historical days must be one of 30, 90, 180 or 365." });
      }
      const cfg = { apiKey };
      if (process.env.HYROS_BASE_URL) cfg.baseUrl = clean(process.env.HYROS_BASE_URL, 200);
      // Real connection check BEFORE anything is stored.
      const test = await hyros.testConnection(cfg);
      if (!test || !test.ok) {
        return send(res, 400, { error: `Hyros rejected the connection: ${sanitizeHyrosError(test && test.error, apiKey)}` });
      }
      const webhookToken = crypto.randomBytes(24).toString("base64url");
      const now = new Date().toISOString();
      await store.putIntegration(HYROS_INTEGRATION_ID, {
        status: "connected",
        authMethod: "apikey",
        accountName: clean(test.accountName || test.account || "", 120),
        apiKeyEncrypted: ai.encryptSecret(apiKey, HYROS_CIPHER_CONTEXT),
        // an api-key connection replaces any stale oauth credential
        oauthClientSecretEncrypted: "",
        oauthAccessTokenEncrypted: "",
        oauthRefreshTokenEncrypted: "",
        oauthAccessExpiresAt: null,
        oauthPending: {},
        webhookTokenHash: sha256Text(webhookToken),
        historicalDays,
        lastError: "",
        backfill: { cursor: null, done: false, aggDay: null },
        connectedBy: me.username,
        connectedAt: now,
        updatedAt: now,
      });
      // Initial backfill runs synchronously but time-capped; if history remains,
      // the stored continue cursor lets POST /sync finish it on later calls.
      const backfill = await runHyrosBackfill(store, hyros, cfg, historicalDays);
      const recordCount = typeof store.reportingFactsCount === "function"
        ? await store.reportingFactsCount({ integrationId: HYROS_INTEGRATION_ID })
        : 0;
      await store.logActivity({
        ts: new Date().toISOString(), taskId: null, by: me.name,
        text: `connected Hyros (${historicalDays}d history, ${backfill.recordsIn} records synced)`,
      });
      return send(res, 200, {
        ok: !backfill.error,
        connected: true,
        accountName: clean(test.accountName || test.account || "", 120),
        recordCount,
        backfill: { recordsIn: backfill.recordsIn, complete: backfill.done, error: backfill.error || "" },
        // Shown exactly once — only the hash is stored. Configure it in Hyros now.
        webhookToken,
        webhookUrl: `/api/integrations/hyros/webhook?token=${webhookToken}`,
      });
    }

    case "POST /api/integrations/hyros/test": {
      const me = await smartReportingUser(req, res, store);
      if (!me) return;
      const hyros = hyrosModule();
      if (!hyros) return send(res, 503, { error: "The Hyros connector is not available on this deployment yet." });
      const integration = typeof store.getIntegration === "function"
        ? await store.getIntegration(HYROS_INTEGRATION_ID)
        : null;
      if (!integration || integration.status !== "connected") return send(res, 400, { error: "Hyros is not connected." });
      const cfg = hyrosConfig(await store.getIntegrationSecret(HYROS_INTEGRATION_ID), store);
      if (!cfg.apiKey && cfg.authMethod !== "oauth") return send(res, 500, { error: "The stored Hyros credentials could not be read — reconnect the integration." });
      const result = await hyros.testConnection(cfg);
      return send(res, 200, result && result.ok
        ? { ok: true, accountName: clean(result.accountName || result.account || "", 120) }
        : { ok: false, error: sanitizeHyrosError(result && result.error, cfg.apiKey) });
    }

    case "POST /api/integrations/hyros/sync": {
      const me = await smartReportingUser(req, res, store);
      if (!me) return;
      const body = await readBody(req);
      const days = body.days == null ? null : Math.max(1, Math.min(365, Number(body.days) || 0));
      const out = await performHyrosSync(store, { days });
      return send(res, out.status, out.body);
    }

    case "POST /api/integrations/hyros/resync": {
      // "Reset & re-import": wipes ONLY this integration's reporting rows
      // (facts + daily aggregates), resets the resumable backfill state, then
      // runs the normal bounded sync, which starts at phase 1 again.
      const me = await smartReportingUser(req, res, store);
      if (!me) return;
      const integration = typeof store.getIntegration === "function"
        ? await store.getIntegration(HYROS_INTEGRATION_ID)
        : null;
      if (!integration || integration.status !== "connected") return send(res, 400, { error: "Hyros is not connected." });
      const countOf = (v) => (typeof v === "number" ? v : (v && (v.deleted ?? v.count)) || 0);
      const facts = typeof store.reportingFactsDelete === "function"
        ? countOf(await store.reportingFactsDelete({ integrationId: HYROS_INTEGRATION_ID }))
        : 0;
      const daily = typeof store.reportingDailyDelete === "function"
        ? countOf(await store.reportingDailyDelete({ sourceSystem: "hyros" }))
        : 0;
      await store.putIntegration(HYROS_INTEGRATION_ID, {
        backfill: { cursor: null, done: false, aggDay: null },
        lastError: "",
        updatedAt: new Date().toISOString(),
      });
      await store.logActivity({
        ts: new Date().toISOString(), taskId: null, by: me.name,
        text: `reset Hyros reporting data (${facts} facts, ${daily} daily rows) and restarted the import`,
      });
      const out = await performHyrosSync(store, {});
      return send(res, out.status, { ok: false, deleted: { facts, daily }, ...out.body });
    }

    // Vercel Cron entry — daily reconciliation so webhook gaps and
    // late-arriving attribution heal without anyone opening the Admin page.
    // Vercel sends Authorization: Bearer $CRON_SECRET; without the env var the
    // route stays closed.
    case "GET /api/cron/hyros-sync": {
      const secret = process.env.CRON_SECRET || "";
      const auth = String(req.headers.authorization || "");
      if (!secret || auth !== `Bearer ${secret}`) return send(res, 401, { error: "Unauthorized." });
      const out = await performHyrosSync(store, {});
      return send(res, out.status, out.body);
    }

    case "POST /api/integrations/hyros/disconnect": {
      const me = await smartReportingUser(req, res, store);
      if (!me) return;
      let deleted = null;
      if (typeof store.reportingFactsDelete === "function") {
        deleted = await store.reportingFactsDelete({ integrationId: HYROS_INTEGRATION_ID });
      }
      let deletedDaily = null;
      if (typeof store.reportingDailyDelete === "function") {
        deletedDaily = await store.reportingDailyDelete({ sourceSystem: "hyros" });
      }
      await store.putIntegration(HYROS_INTEGRATION_ID, {
        status: "disconnected",
        accountName: "",
        apiKeyEncrypted: "",
        webhookTokenHash: "",
        authMethod: "",
        oauthClientId: "",
        oauthClientSecretEncrypted: "",
        oauthAccessTokenEncrypted: "",
        oauthAccessExpiresAt: null,
        oauthRefreshTokenEncrypted: "",
        oauthPending: {},
        historicalDays: null,
        lastSyncAt: null,
        lastWebhookAt: null,
        lastError: "",
        backfill: null,
        disconnectedBy: me.username,
        disconnectedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      await store.logActivity({
        ts: new Date().toISOString(), taskId: null, by: me.name,
        text: "disconnected Hyros and deleted its synced reporting facts",
      });
      return send(res, 200, {
        ok: true,
        deleted: typeof deleted === "number" ? deleted : (deleted && (deleted.deleted ?? deleted.count)) || null,
        deletedDaily: typeof deletedDaily === "number" ? deletedDaily : (deletedDaily && (deletedDaily.deleted ?? deletedDaily.count)) || null,
      });
    }

    case "POST /api/integrations/hyros/webhook": {
      // No session — Hyros calls this. Auth is the one-time webhook token from
      // connect, compared as a hash; the handler always answers quickly.
      const url = new URL(req.url, "http://localhost");
      const token = clean(url.searchParams.get("token"), 200);
      const integration = typeof store.getIntegrationSecret === "function"
        ? await store.getIntegrationSecret(HYROS_INTEGRATION_ID)
        : await store.getIntegration(HYROS_INTEGRATION_ID);
      const storedHash = (integration && integration.webhookTokenHash) || "";
      const providedHash = token ? sha256Text(token) : "";
      const valid = storedHash.length > 0 && storedHash.length === providedHash.length
        && crypto.timingSafeEqual(Buffer.from(storedHash), Buffer.from(providedHash));
      if (!valid) return send(res, 401, { error: "Invalid webhook token." });

      let body = {};
      try { body = await readBody(req); } catch { return send(res, 200, { ok: true, stored: 0 }); }
      const hyros = hyrosModule();
      const normalize = hyros && (hyros.normalizeWebhookEvent || hyros.normalizeWebhook || hyros.normalizeEvent);
      let rows = [];
      if (typeof normalize === "function") {
        try {
          const out = await normalize(body);
          rows = Array.isArray(out) ? out : out ? [out] : [];
        } catch { rows = []; }
      }
      let stored = 0;
      if (rows.length && typeof store.reportingFactsUpsert === "function") {
        // Upsert dedupes by source + external id — replayed events are free.
        const result = await store.reportingFactsUpsert(
          rows.map((row) => ({ ...row, integrationId: HYROS_INTEGRATION_ID }))
        );
        stored = typeof result === "number" ? result : (result && (result.upserted ?? result.count)) || rows.length;
      }
      const now = new Date().toISOString();
      if (typeof store.syncRunInsert === "function") {
        await store.syncRunInsert({
          integrationId: HYROS_INTEGRATION_ID, kind: "webhook", status: "ok",
          recordsIn: rows.length, startedAt: now, finishedAt: now,
        });
      }
      await store.putIntegration(HYROS_INTEGRATION_ID, { lastWebhookAt: now, updatedAt: now });
      return send(res, 200, { ok: true, stored });
    }

    /* ------------------------------ chat ------------------------------ */

    case "GET /api/chat/channels": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      const channels = await store.listChannels();
      const out = [];
      for (const c of channels) {
        if (!canAccessChannel(c, me)) continue;
        const msgs = await store.listMessages(c.id, null, 50);
        const mine = memberOf(c, me.username);
        out.push({
          id: c.id, name: c.name, description: c.description, department: c.department,
          clientAllowed: c.clientAllowed, autoAll: c.autoAll,
          memberCount: c.autoAll ? (await store.listUsers()).filter((u) => u.active && (u.role !== "client" || c.clientAllowed)).length : c.members.length,
          muted: !!(mine && mine.muted),
          unread: unreadCount(c, msgs, me.username),
          lastMessage: msgs.length ? msgs[msgs.length - 1] : null,
        });
      }
      return send(res, 200, { channels: out });
    }

    case "GET /api/chat/pulse": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      const channels = await store.listChannels();
      const unread = {};
      let chatTotal = 0;
      for (const c of channels) {
        if (!canAccessChannel(c, me)) continue;
        const msgs = await store.listMessages(c.id, null, 50);
        const n = unreadCount(c, msgs, me.username);
        unread[c.id] = n;
        const mine = memberOf(c, me.username);
        if (!(mine && mine.muted)) chatTotal += n;
      }
      const notifs = await store.listNotifications(me.username, 30);
      const unreadNotifications = notifs.filter((n) => !n.read);
      return send(res, 200, {
        unread,
        chatTotal,
        notifications: unreadNotifications.length,
        notificationSignals: unreadNotifications.slice(0, 12).map((notification) => ({
          id: notification.id,
          kind: notification.kind || "task",
        })),
      });
    }

    case "GET /api/chat/channels/:cid/messages": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      const channel = await store.getChannel(parts[0]);
      if (!channel) return send(res, 404, { error: "Channel not found." });
      if (!canAccessChannel(channel, me)) return send(res, 403, { error: "Not a member of this channel." });
      const before = new URL(req.url, "http://localhost").searchParams.get("before");
      const rawMessages = await store.listMessages(channel.id, before ? Number(before) : null, 50);
      const messages = await Promise.all(rawMessages.map(async (message) => {
        const hydrated = hydrateChatMessage(message);
        if (!hydrated.taskId) return hydrated;
        const task = await store.getTask(hydrated.taskId);
        // Historical/broken task cards fail closed. The surrounding message
        // remains visible, but no inaccessible record identifier is exposed.
        return task && canSeeTask(me, task) ? hydrated : { ...hydrated, taskId: "" };
      }));
      const profiles = new Map((await store.listUserProfiles()).map((profile) => [profile.username, profile]));
      const people = (await store.listUsers())
        .filter((user) => user.active && canAccessChannel(channel, user))
        .map((user) => ({ username: user.username, name: user.name, profile: profiles.get(user.username) || { availability: "away", avatar: "" } }));
      return send(res, 200, {
        messages,
        channel: {
          id: channel.id, name: channel.name, description: channel.description,
          department: channel.department, clientAllowed: channel.clientAllowed,
          autoAll: channel.autoAll,
          members: channel.members.map((m) => ({ username: m.username, muted: m.muted })),
          people,
        },
      });
    }

    case "POST /api/chat/channels/:cid/messages": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      const channel = await store.getChannel(parts[0]);
      if (!channel) return send(res, 404, { error: "Channel not found." });
      if (!canAccessChannel(channel, me)) return send(res, 403, { error: "Not a member of this channel." });
      const body = await readBody(req);
      const text = clean(body.text, 2000);
      const requestedLink = clean(body.linkUrl, 1500);
      const linkUrl = requestedLink ? sharedLink(requestedLink) : "";
      if (requestedLink && !linkUrl) return send(res, 400, { error: "Enter a valid HTTPS sharing link." });
      const taskId = clean(body.taskId, 30);
      const replyToId = Number(body.replyToId) || null;
      if (taskId && !/^[\w-]+$/.test(taskId)) return send(res, 400, { error: "Invalid task id." });
      if (!text && !linkUrl && !taskId) return send(res, 400, { error: "Message is empty." });
      if (replyToId) {
        const parent = await store.getMessage(replyToId);
        if (!parent || parent.channelId !== channel.id) return send(res, 400, { error: "The message you are replying to is unavailable." });
      }
      if (taskId) {
        const task = await store.getTask(taskId);
        if (!task || !canSeeTask(me, task)) return send(res, 404, { error: "Task not found." });
        const audience = (await store.listUsers()).filter((u) => u.active && canAccessChannel(channel, u));
        if (audience.some((u) => !canSeeTask(u, task))) {
          return send(res, 400, { error: "That task is not visible to everyone in this channel." });
        }
      }
      const storedMessage = await store.postMessage({
        channelId: channel.id,
        author: me.name,
        authorId: me.username,
        text: encodeChatText({ text, replyToId, reactions: {} }),
        linkUrl,
        linkTitle: clean(body.linkTitle, 300),
        taskId,
      });
      const message = hydrateChatMessage(storedMessage);
      // file the link into the channel folder
      if (linkUrl) {
        const id = await nextId(store, "links", "LNK");
        await store.insertRow("links", {
          id, taskId: "", channelId: channel.id,
          date: new Date().toISOString().slice(0, 10),
          workstream: channel.department || "", title: clean(body.linkTitle, 300) || linkUrl,
          url: linkUrl, type: "Link", owner: me.name, note: "",
        });
      }
      // notify members
      const recipients = await channelRecipients(store, channel, me.username);
      const allUsers = await store.listUsers();
      const explicit = parseMentionUsernames(text);
      const everyone = /(^|\s)@everyone\b/i.test(text);
      const targets = new Map(recipients.map((user) => [user.username, { user, mention: everyone || explicit.includes(user.username) }]));
      for (const username of explicit) {
        const user = allUsers.find((candidate) => candidate.username === username && candidate.active);
        if (user && user.username !== me.username && canAccessChannel(channel, user)) targets.set(username, { user, mention: true });
      }
      if (everyone) {
        for (const user of allUsers) {
          if (user.active && user.username !== me.username && canAccessChannel(channel, user)) targets.set(user.username, { user, mention: true });
        }
      }
      const preview = text ? (text.length > 80 ? text.slice(0, 80) + "…" : text) : (linkUrl ? "shared a link" : "created a task");
      for (const { user: u, mention } of targets.values()) {
        await store.notify({
          username: u.username, kind: mention ? "mention" : "chat",
          text: `${me.name} in #${channel.name}: ${preview}`,
          channelId: `message:${channel.id}:${message.id}`,
        });
      }
      return send(res, 201, { message });
    }

    case "POST /api/chat/messages/:messageId/reactions": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      const rawMessage = await store.getMessage(parts[0]);
      if (!rawMessage) return send(res, 404, { error: "Message not found." });
      const channel = await store.getChannel(rawMessage.channelId);
      if (!channel || !canAccessChannel(channel, me)) return send(res, 404, { error: "Message not found." });
      const body = await readBody(req);
      const emoji = clean(body.emoji, 8);
      const allowed = ["👍", "✅", "❤️", "👀", "🎉"];
      if (!allowed.includes(emoji)) return send(res, 400, { error: "Unsupported reaction." });
      const message = hydrateChatMessage(rawMessage);
      const reactions = { ...(message.reactions || {}) };
      const people = new Set(reactions[emoji] || []);
      if (people.has(me.username)) people.delete(me.username);
      else people.add(me.username);
      if (people.size) reactions[emoji] = [...people];
      else delete reactions[emoji];
      const updated = await store.updateMessage(rawMessage.id, {
        text: encodedChatMessageText(rawMessage, { reactions }),
      });
      return send(res, 200, { message: hydrateChatMessage(updated) });
    }

    case "DELETE /api/chat/messages/:messageId": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      const message = await store.getMessage(parts[0]);
      if (!message) return send(res, 404, { error: "Message not found." });
      const channel = await store.getChannel(message.channelId);
      if (!channel || !canAccessChannel(channel, me)) return send(res, 404, { error: "Message not found." });
      if (message.authorId !== me.username) {
        return send(res, 403, { error: "You can only delete your own messages." });
      }
      await store.deleteMessage(message.id);
      return send(res, 200, { ok: true });
    }

    case "POST /api/chat/channels/:cid/read": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      const channel = await store.getChannel(parts[0]);
      if (!channel) return send(res, 404, { error: "Channel not found." });
      if (!canAccessChannel(channel, me)) return send(res, 403, { error: "Not a member of this channel." });
      await store.setMemberFlags(channel.id, me.username, { lastReadTs: new Date().toISOString() });
      return send(res, 200, { ok: true });
    }

    case "POST /api/chat/channels/:cid/mute": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      const channel = await store.getChannel(parts[0]);
      if (!channel) return send(res, 404, { error: "Channel not found." });
      if (!canAccessChannel(channel, me)) return send(res, 403, { error: "Not a member of this channel." });
      const body = await readBody(req);
      await store.setMemberFlags(channel.id, me.username, { muted: !!body.muted });
      return send(res, 200, { ok: true });
    }

    case "GET /api/notifications": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      const items = (await store.listNotifications(me.username, 30)).map((item) => {
        const target = String(item.channelId || "");
        if (target.startsWith("comment:")) return { ...item, commentId: target.slice("comment:".length), channelId: "" };
        if (target.startsWith("message:")) {
          const [, channelId, messageId] = target.split(":");
          return { ...item, channelId, messageId: Number(messageId) || null };
        }
        return item;
      });
      return send(res, 200, { items });
    }

    case "POST /api/notifications/read": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      await store.markNotificationsRead(me.username);
      return send(res, 200, { ok: true });
    }

    /* ------------------------------ super admin ------------------------------ */

    case "GET /api/admin/overview": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      if (me.role !== "super_admin") return send(res, 403, { error: "Super admin only." });
      const [rawUsers, channels, workspace, rawProfiles] = await Promise.all([
        store.listUsers(), store.listChannels(), store.getState(), store.listUserProfiles(),
      ]);
      const profiles = new Map(rawProfiles.map((profile) => [profile.username, profile]));
      const users = rawUsers.map((u) => adminUserOf(u, workspace.departments, profiles.get(u.username)));
      return send(res, 200, { users, channels, departments: workspace.departments });
    }

    case "POST /api/admin/users": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      if (me.role !== "super_admin") return send(res, 403, { error: "Super admin only." });
      const body = await readBody(req);
      const username = clean(body.username, 30).toLowerCase();
      const name = clean(body.name, 100);
      const role = oneOf(body.role, ROLES, null);
      const password = String(body.password || "");
      if (!/^[a-z0-9_.-]{2,30}$/.test(username)) {
        return send(res, 400, { error: "Username: 2–30 chars, lowercase letters, numbers, . _ - only." });
      }
      if (!name) return send(res, 400, { error: "Name is required." });
      if (!role) return send(res, 400, { error: "Unknown role." });
      if (password.length < 6) return send(res, 400, { error: "Password must be at least 6 characters." });
      if (await store.getUser(username)) return send(res, 409, { error: "Username already exists." });
      const workspace = await store.getState();
      const user = await store.createUser({
        username, name, role, org: clean(body.org, 60) || (role === "client" ? "NEONMONKI" : "Advertidea"),
        active: true,
        departments: role === "client" ? [] : uniqueStrings(body.departments || [], 60)
          .map((value) => departmentId(value, workspace.departments))
          .filter((id) => workspace.departments.some((d) => d.id === id && d.active)),
        passwordHash: hashPassword(username, password),
      });
      await store.putUserProfile(username, { availability: "away" });
      await store.logActivity({ ts: new Date().toISOString(), taskId: null, by: me.name, text: `added user ${name} (${username}, ${role})` });
      return send(res, 201, { user: adminUserOf(user, workspace.departments, await store.getUserProfile(username)) });
    }

    case "PATCH /api/admin/users/:username": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      if (me.role !== "super_admin") return send(res, 403, { error: "Super admin only." });
      const target = await store.getUser(parts[0]);
      if (!target) return send(res, 404, { error: "User not found." });
      const body = await readBody(req);
      const fields = {};
      const nextUsername = "username" in body ? clean(body.username, 30).toLowerCase() : target.username;
      if (!/^[a-z0-9_.-]{2,30}$/.test(nextUsername)) {
        return send(res, 400, { error: "Username: 2–30 chars, lowercase letters, numbers, . _ - only." });
      }
      if (nextUsername !== target.username) {
        if (target.username === me.username) return send(res, 400, { error: "Create another super admin before changing your own username." });
        if (!body.password || String(body.password).length < 6) {
          return send(res, 400, { error: "Set a new password when changing a username." });
        }
        if (await store.getUser(nextUsername)) return send(res, 409, { error: "Username already exists." });
      }
      if ("name" in body) fields.name = clean(body.name, 100) || target.name;
      if ("role" in body) fields.role = oneOf(body.role, ROLES, target.role);
      if ("active" in body) fields.active = !!body.active;
      if ("org" in body) fields.org = clean(body.org, 60) || target.org;
      if ("departments" in body) {
        const workspace = await store.getState();
        fields.departments = uniqueStrings(body.departments, 60)
          .map((value) => departmentId(value, workspace.departments))
          .filter((id) => workspace.departments.some((d) => d.id === id && d.active));
      }
      if (fields.role === "client") fields.departments = [];
      if (body.password) {
        if (String(body.password).length < 6) return send(res, 400, { error: "Password must be at least 6 characters." });
        fields.passwordHash = hashPassword(nextUsername, String(body.password));
      }
      // lockout guards
      if (target.username === me.username && (fields.active === false || (fields.role && fields.role !== "super_admin"))) {
        return send(res, 400, { error: "You can't deactivate or demote your own account." });
      }
      if (target.role === "super_admin" && (fields.active === false || (fields.role && fields.role !== "super_admin"))) {
        const admins = (await store.listUsers()).filter((u) => u.role === "super_admin" && u.active);
        if (admins.length <= 1) return send(res, 400, { error: "At least one active super admin is required." });
      }
      const user = nextUsername === target.username
        ? await store.updateUser(target.username, fields)
        : await store.renameUser(target.username, { ...fields, username: nextUsername });
      await store.logActivity({ ts: new Date().toISOString(), taskId: null, by: me.name, text: `updated user ${target.name} (${Object.keys(fields).map((k) => (k === "passwordHash" ? "password" : k)).join(", ")})` });
      return send(res, 200, { user: adminUserOf(user, (await store.getState()).departments, await store.getUserProfile(nextUsername)) });
    }

    case "DELETE /api/admin/users/:username": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      if (me.role !== "super_admin") return send(res, 403, { error: "Super admin only." });
      const target = await store.getUser(parts[0]);
      if (!target) return send(res, 404, { error: "User not found." });
      if (target.username === me.username) return send(res, 400, { error: "You can't delete your own account." });
      if (target.role === "super_admin") {
        const admins = (await store.listUsers()).filter((user) => user.role === "super_admin" && user.active);
        if (admins.length <= 1) return send(res, 400, { error: "At least one active super admin is required." });
      }
      await store.deleteUser(target.username);
      await store.logActivity({ ts: new Date().toISOString(), taskId: null, by: me.name, text: `deleted user ${target.name} (${target.username})` });
      return send(res, 200, { ok: true });
    }

    case "POST /api/admin/departments": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      if (me.role !== "super_admin") return send(res, 403, { error: "Super admin only." });
      const body = await readBody(req);
      const workspace = await store.getState();
      const department = normalizeDepartment({
        id: body.id || body.name,
        name: clean(body.name, 60),
        color: clean(body.color, 20),
        icon: clean(body.icon, 8),
        active: true,
        order: Number(body.order) || (workspace.departments.length + 1) * 10,
      });
      if (!department.id || !department.name) return send(res, 400, { error: "Department name is required." });
      if (workspace.departments.some((d) => d.id === department.id || d.name.toLowerCase() === department.name.toLowerCase())) {
        return send(res, 409, { error: "That department already exists." });
      }
      await store.putDepartment(department);
      await store.logActivity({ ts: new Date().toISOString(), taskId: null, by: me.name, text: `created department ${department.name}` });
      return send(res, 201, { department });
    }

    case "PATCH /api/admin/departments/:deptId": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      if (me.role !== "super_admin") return send(res, 403, { error: "Super admin only." });
      const workspace = await store.getState();
      const current = workspace.departments.find((d) => d.id === parts[0]);
      if (!current) return send(res, 404, { error: "Department not found." });
      const body = await readBody(req);
      const department = normalizeDepartment({
        ...current,
        name: "name" in body ? clean(body.name, 60) : current.name,
        color: "color" in body ? clean(body.color, 20) : current.color,
        icon: "icon" in body ? clean(body.icon, 8) : current.icon,
        active: "active" in body ? !!body.active : current.active,
        order: "order" in body ? Number(body.order) : current.order,
      });
      await store.putDepartment(department);
      return send(res, 200, { department });
    }

    case "DELETE /api/admin/departments/:deptId": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      if (me.role !== "super_admin") return send(res, 403, { error: "Super admin only." });
      const department = await store.disableDepartment(parts[0]);
      if (!department) return send(res, 404, { error: "Department not found." });
      await store.logActivity({ ts: new Date().toISOString(), taskId: null, by: me.name, text: `archived department ${department.name}` });
      return send(res, 200, { department });
    }

    case "POST /api/admin/channels": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      if (me.role !== "super_admin") return send(res, 403, { error: "Super admin only." });
      const body = await readBody(req);
      const name = clean(body.name, 60);
      if (!name) return send(res, 400, { error: "Channel name is required." });
      const id = clean(body.id, 60).toLowerCase() ||
        name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
      if (!/^[a-z0-9][a-z0-9-]{1,59}$/.test(id)) {
        return send(res, 400, { error: "Channel id must be a slug like 'google-ads'." });
      }
      if (await store.getChannel(id)) return send(res, 409, { error: "A channel with that id already exists." });
      const members = Array.isArray(body.members) ? body.members.map((u) => clean(u, 30)).filter(Boolean) : [];
      const channel = await store.createChannel({
        id, name,
        description: clean(body.description, 200),
        department: clean(body.department, 100),
        clientAllowed: !!body.clientAllowed,
        autoAll: false,
        createdBy: me.username,
        members: [],
      });
      for (const username of members) {
        const u = await store.getUser(username);
        if (u && (u.role !== "client" || channel.clientAllowed)) {
          await store.addMember(id, username);
        }
      }
      await store.logActivity({ ts: new Date().toISOString(), taskId: null, by: me.name, text: `created channel #${name}` });
      return send(res, 201, { channel: await store.getChannel(id) });
    }

    case "PATCH /api/admin/channels/:cid": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      if (me.role !== "super_admin") return send(res, 403, { error: "Super admin only." });
      const channel = await store.getChannel(parts[0]);
      if (!channel) return send(res, 404, { error: "Channel not found." });
      const body = await readBody(req);
      const fields = {};
      if ("name" in body) fields.name = clean(body.name, 60) || channel.name;
      if ("description" in body) fields.description = clean(body.description, 200);
      if ("department" in body) fields.department = clean(body.department, 100);
      if ("clientAllowed" in body) fields.clientAllowed = !!body.clientAllowed;
      const updated = await store.updateChannel(channel.id, fields);
      return send(res, 200, { channel: updated });
    }

    case "DELETE /api/admin/channels/:cid": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      if (me.role !== "super_admin") return send(res, 403, { error: "Super admin only." });
      const channel = await store.getChannel(parts[0]);
      if (!channel) return send(res, 404, { error: "Channel not found." });
      if (channel.autoAll) return send(res, 400, { error: "The General channel can't be deleted." });
      await store.deleteChannel(channel.id);
      await store.logActivity({ ts: new Date().toISOString(), taskId: null, by: me.name, text: `deleted channel #${channel.name}` });
      return send(res, 200, { ok: true });
    }

    case "POST /api/admin/channels/:cid/members": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      if (me.role !== "super_admin") return send(res, 403, { error: "Super admin only." });
      const channel = await store.getChannel(parts[0]);
      if (!channel) return send(res, 404, { error: "Channel not found." });
      const body = await readBody(req);
      const target = await store.getUser(clean(body.username, 30).toLowerCase());
      if (!target) return send(res, 404, { error: "User not found." });
      if (target.role === "client" && !channel.clientAllowed) {
        if (body.confirmClientAccess !== true) {
          return send(res, 409, { error: "Adding a client makes the full channel history visible to client members. Confirm client access first.", code: "confirm_client_access" });
        }
        await store.updateChannel(channel.id, { clientAllowed: true });
      }
      await store.addMember(channel.id, target.username);
      return send(res, 200, { channel: await store.getChannel(channel.id) });
    }

    case "DELETE /api/admin/channels/:cid/members/:username": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      if (me.role !== "super_admin") return send(res, 403, { error: "Super admin only." });
      const channel = await store.getChannel(parts[0]);
      if (!channel) return send(res, 404, { error: "Channel not found." });
      await store.removeMember(channel.id, parts[1]);
      return send(res, 200, { channel: await store.getChannel(channel.id) });
    }

    /* ------------------------------ AI ------------------------------ */

    case "GET /api/ai/status": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      // Status reports account-level availability. The browser combines this
      // with the individual feature flags for Ask, Chat, Brief and Summaries.
      const access = await aiPolicy(store, me, null, { enforceLimit: false });
      const s = access.settings;
      const provider = ai.providerConfig(s);
      return send(res, 200, {
        enabled: s.enabled,
        configured: !!provider.apiKey,
        features: s.features,
        allowClient: s.allowClient,
        dailyLimit: access.dailyLimit,
        callsToday: access.callsToday,
        allowedTools: access.allowedTools,
        allowedForMe: access.allowed,
        unavailableReason: access.blocked ? access.blocked.error : "",
      });
    }

    case "POST /api/ai/ask": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      const body = await readBody(req);
      const access = await aiPolicy(store, me, body.channelId ? "chat" : "ask");
      if (!access.allowed) return send(res, access.blocked.status, { error: access.blocked.error });
      const question = clean(body.question, 1000);
      if (!question) return send(res, 400, { error: "Question is required." });

      // Smart Reporting view context from the reporting page: validated and
      // capped here; Monki uses it as the default reporting-tool filters.
      let reportingContext = null;
      if (body.reportingContext != null) {
        if (typeof body.reportingContext !== "object" || Array.isArray(body.reportingContext)) {
          return send(res, 400, { error: "reportingContext must be an object." });
        }
        reportingContext = {};
        for (const key of ["from", "to"]) {
          const value = clean(body.reportingContext[key], 10);
          if (value) {
            if (!validDay(value)) return send(res, 400, { error: "reportingContext dates must be YYYY-MM-DD." });
            reportingContext[key] = value;
          }
        }
        for (const key of ["channel", "platform", "source", "campaign"]) {
          const value = clean(body.reportingContext[key], 120);
          if (value) reportingContext[key] = value;
        }
        if (!Object.keys(reportingContext).length) reportingContext = null;
      }

      // in-channel ask: verify access; the answer is posted into the channel
      let channel = null;
      if (body.channelId) {
        channel = await store.getChannel(clean(body.channelId, 60));
        if (!channel) return send(res, 404, { error: "Channel not found." });
        if (!canAccessChannel(channel, me)) return send(res, 403, { error: "Not a member of this channel." });
      }

      try {
        const r = await ai.runAsk(store, me, question, {
          channelId: channel ? channel.id : null,
          channelName: channel ? channel.name : null,
          // deep=true routes to the advanced reasoning model (super-admin configurable)
          deep: body.deep === true,
          // lets Monki answer "what changed since my last visit" precisely
          lastVisit: clean(body.lastVisit, 40) || null,
          // Smart Reporting page the user is looking at (default tool filters)
          reportingContext,
          // Chat does not render proposal/draft cards, so only read tools are useful there.
          allowedTools: channel
            ? access.allowedTools.filter((name) => ai.READ_TOOL_NAMES.includes(name))
            : access.allowedTools,
        });
        const proposals = [];
        for (const proposal of r.proposals || []) {
          const action = await store.aiActionInsert({
            username: me.username,
            actionType: proposal.type,
            payload: proposal,
            status: "pending",
          });
          proposals.push({ ...proposal, id: action.id });
        }
        await store.aiLog({
          username: me.username, kind: "ask", question,
          tools: r.tools, citations: r.citations, model: r.model,
          promptTokens: r.usage.prompt_tokens, completionTokens: r.usage.completion_tokens,
          latencyMs: r.latencyMs, status: "ok",
        });
        if (channel) {
          await store.postMessage({
            channelId: channel.id, author: "Monki", authorId: "ai",
            text: encodeChatText({ text: r.answer || "(no answer)" }),
          });
        }
        return send(res, 200, {
          answer: r.answer,
          citations: r.citations,
          drafts: r.drafts,
          replyDrafts: r.replyDrafts,
          proposals,
          suggestions: r.suggestions || [],
        });
      } catch (e) {
        await store.aiLog({
          username: me.username, kind: "ask", question, status: "error",
          error: e.code === "unconfigured" ? "unconfigured" : "provider",
        });
        const msg = e.code === "unconfigured"
          ? "Monki is not connected yet — the super admin needs to save the private access key."
          : "Monki couldn't answer right now. Try again in a moment.";
        return send(res, 502, { error: msg });
      }
    }

    case "POST /api/ai/summarize/task/:id": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      const access = await aiPolicy(store, me, "summaries");
      if (!access.allowed) return send(res, access.blocked.status, { error: access.blocked.error });
      const context = await loadTaskContext(store, parts[0]);
      const task = context.task ? taskForUser(context.task, me) : null;
      if (!task || !canSeeTask(me, task)) return send(res, 404, { error: "Task not found." });

      const citations = [{ type: "task", id: task.id, title: task.title }];
      let ctx = rec("task", task.id,
        `${task.title}\ndepartment: ${task.department} | project: ${task.project}\nowner: ${task.owner} | status: ${task.status} | priority: ${task.priority}\nrequested: ${task.dateRequested} by ${task.requestedBy}${task.dueDate ? " | due " + task.dueDate : ""}\ndescription: ${task.description}\nlatest: ${task.update}\nblocker: ${task.blocker}\ndeliverable: ${task.deliverable} ${task.deliverableLink}\nnext action: ${task.nextAction}\nhistory:\n` +
        (task.updates || []).map((u) => `  - [${String(u.ts).slice(0, 10)}] ${u.by}: ${u.text}`).join("\n") +
        `\ncomments visible to this user:\n` +
        ((task.comments || []).filter((c) => !c.deleted).map((c) => `  - [${String(c.ts).slice(0, 10)}] ${c.by}: ${c.text}`).join("\n") || "  -"));
      // related discussions: messages mentioning this task id, in channels the user can see
      const channels = accessibleChannels(await store.listChannels(), me);
      for (const c of channels) {
        const msgs = (await store.listMessages(c.id, null, 50)).map(hydrateChatMessage);
        for (const m of msgs) {
          if (m.taskId === task.id || (m.text && m.text.includes(task.id))) {
            citations.push({ type: "message", id: m.id, title: `#${c.name}`, channelId: c.id });
            ctx += `\n` + rec("message", m.id, `#${c.name} [${String(m.ts).slice(0, 10)}] ${m.author}: ${m.text.slice(0, 200)}`);
          }
        }
      }
      const linkState = await store.getState();
      const linkChannels = await store.listChannels();
      const links = visibleLinks(linkState.links, me, { tasks: linkState.tasks, channels: linkChannels })
        .filter((l) => l.taskId === task.id)
        .filter((l) => {
          if (l.type !== "task_file") return true;
          const meta = parseFileMeta(l.note);
          return meta && (me.role !== "client" || meta.deliveredToClient || meta.uploadedBy === me.username);
        });
      for (const l of links) {
        citations.push({
          type: "link", id: l.id, title: l.title,
          ...( /^https:\/\//i.test(l.url || "") ? { url: l.url } : {}),
          ...(l.taskId ? { taskId: l.taskId } : {}),
        });
        const meta = l.type === "task_file" ? parseFileMeta(l.note) : null;
        const safeUrl = /^https:\/\//i.test(l.url || "") ? l.url : (l.type === "task_file" ? "legacy uploaded file" : "no url");
        ctx += `\n` + rec("file", l.id, `${l.title} — ${safeUrl}${meta ? ` | review ${meta.status} | client ${meta.clientStatus}` : ""}`);
      }
      try {
        const r = await ai.runSummarize(store, me, "task", `${task.id} — ${task.title}`, ctx, citations);
        await store.aiSummaryInsert({
          scopeType: "task", scopeId: task.id, text: r.answer,
          citations: r.citations, model: r.model, createdBy: me.username,
        });
        await store.aiLog({
          username: me.username, kind: "task_summary", question: task.id,
          citations: r.citations, model: r.model,
          promptTokens: r.usage.prompt_tokens, completionTokens: r.usage.completion_tokens,
          latencyMs: r.latencyMs, status: "ok",
        });
        return send(res, 200, {
          answer: r.answer,
          citations: r.citations,
          generatedAt: new Date().toISOString(),
          task: {
            id: task.id,
            title: task.title,
            status: task.status,
            priority: task.priority,
            dueDate: task.dueDate,
            owners: task.owner,
            departments: task.departmentIds || [],
          },
        });
      } catch (e) {
        await store.aiLog({ username: me.username, kind: "task_summary", question: task.id, status: "error", error: e.code || "provider" });
        return send(res, 502, { error: e.code === "unconfigured" ? "Monki is not connected yet." : "Monki couldn't answer right now." });
      }
    }

    case "POST /api/ai/summarize/channel/:cid": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      const access = await aiPolicy(store, me, "summaries");
      if (!access.allowed) return send(res, access.blocked.status, { error: access.blocked.error });
      const channel = await store.getChannel(parts[0]);
      if (!channel) return send(res, 404, { error: "Channel not found." });
      if (!canAccessChannel(channel, me)) return send(res, 403, { error: "Not a member of this channel." });

      const msgs = (await store.listMessages(channel.id, null, 40)).map(hydrateChatMessage);
      const citations = [];
      const ctx = msgs.map((m) => {
        citations.push({ type: "message", id: m.id, title: `#${channel.name}`, channelId: channel.id });
        return rec("message", m.id, `[${String(m.ts).slice(0, 10)}] ${m.author}: ${m.text.slice(0, 300)}`);
      }).join("\n");
      try {
        const r = await ai.runSummarize(store, me, "channel", `#${channel.name}`,
          `Channel: #${channel.name} — ${channel.description}\nRecent messages:\n${ctx || "(none)"}`, citations);
        await store.aiSummaryInsert({
          scopeType: "channel", scopeId: channel.id, text: r.answer,
          citations: r.citations, model: r.model, createdBy: me.username,
        });
        await store.aiLog({
          username: me.username, kind: "channel_summary", question: channel.id,
          citations: r.citations, model: r.model,
          promptTokens: r.usage.prompt_tokens, completionTokens: r.usage.completion_tokens,
          latencyMs: r.latencyMs, status: "ok",
        });
        return send(res, 200, { answer: r.answer, citations: r.citations, generatedAt: new Date().toISOString(), channel: { id: channel.id, name: channel.name } });
      } catch (e) {
        await store.aiLog({ username: me.username, kind: "channel_summary", question: channel.id, status: "error", error: e.code || "provider" });
        return send(res, 502, { error: e.code === "unconfigured" ? "Monki is not connected yet." : "Monki couldn't answer right now." });
      }
    }

    case "POST /api/ai/brief": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      const access = await aiPolicy(store, me, "brief");
      if (!access.allowed) return send(res, access.blocked.status, { error: access.blocked.error });
      const snapshot = await ai.stateSnapshot(store, me);
      const { tasks: allTasks, decisions, activity: rawActivity } = await store.getState();
      // Raw activity is an audit surface reserved for the super admin, including
      // when composing AI briefs. Everyone else receives task-state context only.
      const visibleIds = new Set(visibleTasks(allTasks, me).map((t) => t.id));
      const activity = me.role === "super_admin"
        ? rawActivity.filter((a) => !a.taskId || visibleIds.has(a.taskId))
        : [];
      const recentDecisions = decisions.slice(0, 5)
        .map((d) => rec("decision", d.id, `[${d.date}] ${d.topic}: ${d.rule.slice(0, 150)}`)).join("\n");
      const recentActivity = activity.slice(0, 10).map((a) => `- [${String(a.ts).slice(0, 10)}] ${a.by} ${a.text}`).join("\n");
      const activityContext = me.role === "super_admin" ? `\n\nRecent activity:\n${recentActivity}` : "";
      const audience = me.role === "client"
        ? "Write Adika's NEONMONKI morning brief directly to him: what moved, what is done, and what needs his decision or review. Plain business language, no internal team noise. Never call him a client or refer to his client role."
        : "Write this person's morning brief: what needs their attention first, what's blocked, what changed recently. Be operational.";
      try {
        const r = await ai.runSummarize(store, me, "daily brief", me.name,
          `${audience}\n\n${snapshot}\n\nRecent decisions:\n${recentDecisions}${activityContext}`,
          []);
        await store.aiSummaryInsert({
          scopeType: "brief", scopeId: me.username, text: r.answer,
          citations: [], model: r.model, createdBy: me.username,
        });
        await store.aiLog({
          username: me.username, kind: "brief", model: r.model,
          promptTokens: r.usage.prompt_tokens, completionTokens: r.usage.completion_tokens,
          latencyMs: r.latencyMs, status: "ok",
        });
        return send(res, 200, { answer: r.answer });
      } catch (e) {
        await store.aiLog({ username: me.username, kind: "brief", status: "error", error: e.code || "provider" });
        return send(res, 502, { error: e.code === "unconfigured" ? "Monki is not connected yet." : "Monki couldn't answer right now." });
      }
    }

    /* ------------------------------ Monki period reports ------------------------------ */

    case "GET /api/ai/report/latest": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      const url = new URL(req.url, "http://localhost");
      // The client account can only ever read the client-audience report:
      // team reports may reference internal work and stay on the team side.
      const audience = me.role === "client"
        ? "client"
        : oneOf(clean(url.searchParams.get("audience"), 10), ["team", "client"], "team");
      const report = await store.aiReportLatest(audience);
      if (!report) return send(res, 200, { text: null, citations: [], audience });
      return send(res, 200, {
        text: report.text,
        citations: report.citations,
        audience: report.audience,
        from: report.periodFrom,
        to: report.periodTo,
        generatedAt: report.ts,
        createdBy: report.createdBy,
      });
    }

    case "POST /api/ai/report": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      const access = await aiPolicy(store, me, "brief");
      if (!access.allowed) return send(res, access.blocked.status, { error: access.blocked.error });
      const body = await readBody(req);
      const period = oneOf(body.period, ["week", "month", "custom"], null);
      if (!period) return send(res, 400, { error: "Period must be week, month or custom." });
      let from;
      let to;
      if (period === "custom") {
        from = clean(body.from, 10);
        to = clean(body.to, 10);
        if (!validDay(from) || !validDay(to)) {
          return send(res, 400, { error: "Custom reports need from and to as YYYY-MM-DD." });
        }
        if (from > to) return send(res, 400, { error: "Range start must not be after range end." });
        if (dayCount(from, to) > 93) return send(res, 400, { error: "Report range is limited to 93 days." });
      } else {
        to = todayStr();
        from = shiftDays(to, period === "week" ? -6 : -29);
      }
      const audience = me.role === "client" ? "client" : "team";

      // Everything below is filtered through the same visibility boundary as
      // the rest of the app before it reaches the model. A client report is
      // built from shared records only — internal/private work never enters
      // the prompt, so it can never leak into stored client reports either.
      const [workspace, users] = await Promise.all([store.getState(), store.listUsers()]);
      const modeled = workspace.tasks.map((t) => taskModel(t, users, workspace.departments));
      const visible = visibleTasks(modeled, me);
      const inRange = (value) => {
        const d = String(value || "").slice(0, 10);
        return d >= from && d <= to;
      };
      const completionDay = (t) => {
        const event = (t.updates || []).filter((u) => u.statusTo === "Completed").pop();
        const last = (t.updates || []).slice(-1)[0];
        return String((event && event.ts) || (last && last.ts) || t.dateRequested || "").slice(0, 10);
      };
      const completed = visible.filter((t) => t.status === "Completed" && inRange(completionDay(t)));
      const decisions = workspace.decisions.filter((d) => inRange(d.date));
      const deliverables = workspace.deliverables.filter((d) => inRange(d.date));
      const span = dayCount(from, to);
      const cmpToDate = shiftDays(from, -1);
      const cmpFromDate = shiftDays(cmpToDate, -span);
      const [currentMetrics, previousMetrics] = await Promise.all([
        store.metricsList(from, to),
        store.metricsList(cmpFromDate, cmpToDate),
      ]);

      const citations = [];
      const cite = (type, id, title) => citations.push({ type, id, title: title || id, channelId: "" });
      const sections = [];

      // Reports are platform-metrics reports: the measured headline numbers
      // lead, then a brief "what drove it" from visible work, decisions and
      // deliverables. Team workload/capacity is never report content — for
      // either audience.
      const summary = metricsSummary(currentMetrics, previousMetrics);
      const metricLines = [];
      for (const [channel, metrics] of Object.entries(summary)) {
        for (const [metric, s] of Object.entries(metrics)) {
          cite("metric", `${channel}/${metric}`, `${channel} — ${metric}`);
          metricLines.push(rec("metric", `${channel}/${metric}`,
            `${channel} / ${metric}: ${s.current} this period (previous period ${s.previous}${s.deltaPct == null ? "" : `, ${s.deltaPct > 0 ? "+" : ""}${s.deltaPct}%`})`));
        }
      }
      sections.push(`Measured results this period vs the previous ${span + 1} days — the headline numbers:\n${metricLines.join("\n") || "- no metrics recorded for this period yet"}`);

      const completedLines = completed.slice(0, 15).map((t) => {
        cite("task", t.id, t.title);
        return rec("task", t.id,
          `COMPLETED ${completionDay(t)} | "${clean(t.title, 140)}" | ${t.department}${t.impact ? ` | business impact: ${clean(t.impact, 200)}` : ""}`);
      });
      sections.push(`What drove it — work completed in this period (${completed.length}):\n${completedLines.join("\n") || "- none recorded"}`);

      if (decisions.length) {
        sections.push("Decisions made:\n" + decisions.slice(0, 8).map((d) => {
          cite("decision", d.id, d.topic || d.id);
          return rec("decision", d.id, `[${d.date}] ${clean(d.topic, 100)}: ${clean(d.rule, 220)}`);
        }).join("\n"));
      }
      if (deliverables.length) {
        sections.push("Deliverables moved:\n" + deliverables.slice(0, 10).map((d) => {
          cite("deliverable", d.id, d.title);
          return rec("deliverable", d.id, `[${d.date}] ${clean(d.title, 140)} | ${d.status} | ${d.workstream}`);
        }).join("\n"));
      }

      const framing = audience === "client"
        ? `Write NEONMONKI's ${period === "month" ? "monthly" : "weekly"} performance report (${from} to ${to}) for Adika. Lead with the measured platform results per channel — spend, CTR, CPC, leads, revenue — and whether each improved versus the previous period. Then explain briefly what drove the numbers, using the completed work, decisions and deliverables above. If no metrics are recorded for the period, say so plainly and suggest logging them on the Results page. Whenever a number is down, pair it immediately with what is being done about it. This report covers platform results and delivered work only — never team capacity, staffing or who is busy.`
        : `Write the ${period === "month" ? "monthly" : "weekly"} performance report (${from} to ${to}) for the Advertidea delivery team. Numbers first: per-channel measured results with period-over-period deltas, what moved and why. Then the work that drove the numbers (completed tasks, decisions, deliverables — reference task ids) and where the next period's leverage is. If no metrics are recorded for the period, say so plainly and suggest logging them on the Results page. This report covers platform results and delivered work only — never team capacity, staffing or who is busy.`;

      try {
        const r = await ai.runSummarize(
          store, me,
          `${period} report`, `${from} → ${to} (${audience} audience)`,
          `${framing}\n\n${sections.join("\n\n")}`,
          citations,
          { maxTokens: 1600 }
        );
        const report = await store.aiReportInsert({
          audience, periodFrom: from, periodTo: to,
          text: r.answer, citations: r.citations, createdBy: me.username,
        });
        await store.aiLog({
          username: me.username, kind: "report",
          question: `${period} report ${from}..${to} (${audience})`,
          citations: r.citations, model: r.model,
          promptTokens: r.usage.prompt_tokens, completionTokens: r.usage.completion_tokens,
          latencyMs: r.latencyMs, status: "ok",
        });
        return send(res, 200, {
          text: r.answer,
          citations: r.citations,
          audience,
          from,
          to,
          generatedAt: report.ts,
        });
      } catch (e) {
        await store.aiLog({
          username: me.username, kind: "report",
          question: `${period} report ${from}..${to} (${audience})`,
          status: "error", error: e.code || "provider",
        });
        return send(res, 502, { error: e.code === "unconfigured" ? "Monki is not connected yet." : "Monki couldn't write the report right now. Try again in a moment." });
      }
    }

    /* ------------------------------ AI action approval ------------------------------ */

    case "POST /api/ai/actions/execute": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      const body = await readBody(req);
      const proposalId = Number(body.proposalId) || 0;
      const action = await store.aiActionGet(proposalId);
      if (!action) return send(res, 404, { error: "AI proposal not found." });
      if (action.username !== me.username && me.role !== "super_admin") {
        return send(res, 403, { error: "This proposal belongs to another user." });
      }
      if (action.status !== "pending") return send(res, 409, { error: "This proposal has already been decided." });

      // Deciding an already-generated proposal is not another provider call,
      // so the daily inference limit must not block the human approval step.
      const access = await aiPolicy(store, me, "ask", { enforceLimit: false });
      if (!access.allowed) return send(res, access.blocked.status, { error: access.blocked.error });
      const requiredTool = action.actionType === "task_update" ? "propose_task_update" : "propose_decision";
      if (!access.allowedTools.includes(requiredTool)) {
        return send(res, 403, { error: "This AI action type is not enabled for your account." });
      }

      const original = action.payload && typeof action.payload === "object" ? action.payload : {};
      const requested = body.payload && typeof body.payload === "object" ? body.payload : original;
      const type = action.actionType;
      const now = new Date().toISOString();

      if (type === "task_update") {
        // The target task is immutable: modification may change fields, never the record being targeted.
        const task = await store.getTask(clean(original.taskId, 30));
        if (!task || !canSeeTask(me, task)) return send(res, 404, { error: "Task not found." });
        const src = requested.fields && typeof requested.fields === "object" ? requested.fields : {};
        const fields = {};
        const textLimits = { title: 300, owner: 500, dueDate: 30, nextAction: 500, description: 4000, update: 2000 };
        for (const [f, max] of Object.entries(textLimits)) {
          if (f in src) fields[f] = clean(src[f], max);
        }
        if ("title" in fields && !fields.title) return send(res, 400, { error: "Task title cannot be empty." });
        if ("priority" in src) fields.priority = oneOf(src.priority, PRIORITIES, task.priority);
        if ("status" in src) {
          const next = oneOf(src.status, STATUSES, null);
          if (!next) return send(res, 400, { error: "Unknown status." });
          fields.status = next;
        }
        // Keep the mutation and audit focused on values that actually change.
        for (const key of Object.keys(fields)) {
          const current = key === "update" ? task.update : task[key];
          if (String(fields[key] == null ? "" : fields[key]) === String(current == null ? "" : current)) delete fields[key];
        }
        if (!Object.keys(fields).length) return send(res, 400, { error: "Nothing to change." });

        // Same role rules as manual PATCH: AI proposals never gain extra privileges.
        if (me.role === "client") {
          const textChanges = Object.keys(fields).filter((f) => f !== "status");
          if (textChanges.length && !(task.status === "New Request" && task.requestedBy === me.name)) {
            return send(res, 403, { error: "Task details are managed by the team after handover." });
          }
          if (fields.status && !clientStatusAllowed(task, fields.status)) {
            return send(res, 403, { error: "That status change is outside the client review workflow." });
          }
        }

        const finalPayload = {
          type: "task_update",
          taskId: task.id,
          title: task.title,
          fields,
          reason: clean(requested.reason || original.reason, 200),
        };
        const modified = JSON.stringify(finalPayload.fields) !== JSON.stringify(original.fields || {})
          || finalPayload.reason !== clean(original.reason, 200);
        const provenance = modified ? "via modified AI proposal" : "via AI proposal";
        if (fields.status) {
          await store.pushTaskUpdate(task.id, {
            ts: now, by: `${me.name} (${provenance})`,
            text: `Status changed from “${task.status}” to “${fields.status}”.`,
            statusFrom: task.status, statusTo: fields.status,
          });
          await store.logActivity({ ts: now, taskId: task.id, by: me.name, text: `moved “${task.title}” to ${fields.status} (${provenance})` });
          await notifyTaskFollowers(store, task, me, `${me.name} moved “${task.title}” to ${fields.status}`);
        }
        const edited = Object.keys(fields).filter((f) => f !== "status");
        if (edited.length) {
          await store.pushTaskUpdate(task.id, {
            ts: now, by: `${me.name} (${provenance})`,
            text: `Edited task details: ${edited.join(", ")}.`,
          });
          await store.logActivity({ ts: now, taskId: task.id, by: me.name, text: `edited “${task.title}” (${edited.join(", ")}) (${provenance})` });
        }
        await store.updateTask(task.id, fields);
        const updatedTask = await store.getTask(task.id);
        const updatedAction = await store.aiActionUpdate(action.id, {
          status: "executed",
          modifiedPayload: modified ? finalPayload : {},
          executionResult: { taskId: task.id, status: updatedTask.status },
          decidedBy: me.username,
          decidedAt: now,
          note: finalPayload.reason,
        });
        return send(res, 200, { ok: true, task: updatedTask, action: updatedAction });
      }

      if (type === "decision") {
        const rule = clean(requested.rule, 1000);
        if (!rule) return send(res, 400, { error: "Decision text is required." });
        const finalPayload = {
          type: "decision",
          topic: clean(requested.topic, 200),
          rule,
          workstream: clean(requested.workstream, 100),
          owner: clean(requested.owner, 100),
        };
        const comparableOriginal = {
          type: "decision",
          topic: clean(original.topic, 200),
          rule: clean(original.rule, 1000),
          workstream: clean(original.workstream, 100),
          owner: clean(original.owner, 100),
        };
        const modified = JSON.stringify(finalPayload) !== JSON.stringify(comparableOriginal);
        const provenance = modified ? "modified AI proposal" : "AI proposal";
        const item = await insertWithFreshId(store, "decisions", "DEC", async (id) => {
          const it = {
            id, date: now.slice(0, 10),
            topic: finalPayload.topic, rule,
            workstream: finalPayload.workstream,
            owner: finalPayload.owner,
          };
          await store.insertRow("decisions", it);
          return it;
        });
        await store.logActivity({ ts: now, taskId: null, by: me.name, text: `recorded decision “${item.topic || item.rule.slice(0, 40)}” (${provenance})` });
        const updatedAction = await store.aiActionUpdate(action.id, {
          status: "executed",
          modifiedPayload: modified ? finalPayload : {},
          executionResult: { decisionId: item.id },
          decidedBy: me.username,
          decidedAt: now,
        });
        return send(res, 200, { ok: true, item, action: updatedAction });
      }

      return send(res, 400, { error: "Unknown action type." });
    }

    case "POST /api/ai/actions/decline": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      const body = await readBody(req);
      const action = await store.aiActionGet(Number(body.proposalId) || 0);
      if (!action) return send(res, 404, { error: "AI proposal not found." });
      if (action.username !== me.username && me.role !== "super_admin") {
        return send(res, 403, { error: "This proposal belongs to another user." });
      }
      if (action.status !== "pending") return send(res, 409, { error: "This proposal has already been decided." });
      const updatedAction = await store.aiActionUpdate(action.id, {
        status: "rejected",
        decidedBy: me.username,
        decidedAt: new Date().toISOString(),
        note: clean(body.note, 200),
      });
      return send(res, 200, { ok: true, action: updatedAction });
    }

    case "GET /api/ai/actions": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      if (me.role !== "super_admin") return send(res, 403, { error: "Super admin only." });
      return send(res, 200, { actions: await store.aiActionList(100) });
    }

    /* ------------------------------ AI control center (super admin) ------------------------------ */

    case "GET /api/ai/admin": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      if (me.role !== "super_admin") return send(res, 403, { error: "Super admin only." });
      const [s, audit, users, savedPermissions] = await Promise.all([
        store.getAiSettings(),
        store.aiAuditList(500),
        store.listUsers(),
        store.listAiUserPermissions(),
      ]);
      const today = new Date().toISOString().slice(0, 10);
      const todayRows = audit.filter((a) => String(a.ts).slice(0, 10) === today && a.kind !== "test");
      const permissionMap = new Map(savedPermissions.map((p) => [p.username, p]));
      const userAccess = users.map((u) => {
        const p = permissionMap.get(u.username) || {
          username: u.username, enabled: true, tools: null, dailyLimit: null,
        };
        const usage = todayRows.filter((a) => a.username === u.username);
        return {
          username: u.username,
          name: u.name,
          role: u.role,
          active: u.active,
          enabled: p.enabled !== false,
          tools: ai.allowedToolNames(p.tools, u.role, { smartReporting: canUseSmartReporting(u, p) }),
          inheritsTools: !Array.isArray(p.tools),
          dailyLimit: p.dailyLimit,
          smartReporting: canUseSmartReporting(u, p),
          reporting: p.reporting || "",
          usage: {
            calls: usage.length,
            tokens: usage.reduce((n, a) => n + (a.promptTokens || 0) + (a.completionTokens || 0), 0),
            errors: usage.filter((a) => a.status === "error").length,
          },
        };
      });
      const providerConfig = ai.providerConfig(s);
      const configured = !!providerConfig.apiKey;
      return send(res, 200, {
        settings: {
          enabled: s.enabled,
          features: s.features,
          allowClient: s.allowClient,
          dailyLimit: s.dailyLimit,
          models: (s.provider && s.provider.models) || { basic: s.model, advanced: s.model },
        },
        configured,
        connectionType: ai.connectionTypeForBaseUrl(providerConfig.baseUrl),
        provider: {
          name: "Private intelligence engine",
          status: !s.enabled ? "disabled" : configured ? "configured" : "unconfigured",
          keySource: providerConfig.source,
          keyUpdatedAt: providerConfig.keyUpdatedAt,
          storedKeyUnreadable: providerConfig.storedKeyUnreadable,
        },
        tools: ai.toolCatalog(),
        userAccess,
        stats: {
          callsToday: todayRows.length,
          tokensToday: todayRows.reduce((n, a) => n + (a.promptTokens || 0) + (a.completionTokens || 0), 0),
          errorsToday: todayRows.filter((a) => a.status === "error").length,
          totalLogged: audit.length,
        },
        audit: audit.slice(0, 100).map(({ model, ...entry }) => entry),
      });
    }

    case "PATCH /api/ai/admin/users/:username": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      if (me.role !== "super_admin") return send(res, 403, { error: "Super admin only." });
      const target = await store.getUser(parts[0]);
      if (!target) return send(res, 404, { error: "User not found." });
      const body = await readBody(req);
      const fields = { updatedBy: me.username };
      if ("enabled" in body) fields.enabled = !!body.enabled;
      if ("smartReporting" in body) fields.smartReporting = !!body.smartReporting;
      if ("reporting" in body) {
        // "" = inherit the role default; explicit tier wins over it (see
        // permissions.reportingAccess). Anything else is rejected, never
        // silently coerced.
        const reporting = oneOf(clean(body.reporting, 10), ["", "full", "basic", "none"], null);
        if (reporting === null) {
          return send(res, 400, { error: 'Reporting access must be "full", "basic", "none" or empty.' });
        }
        fields.reporting = reporting;
      }
      if ("tools" in body) {
        if (!Array.isArray(body.tools)) return send(res, 400, { error: "Tools must be an array." });
        // Validate names against the full catalog ("super_admin" keeps admin
        // tool names valid here). The role gate strips them again downstream
        // for any non-admin target, so saving one for a team member is inert.
        const tools = ai.allowedToolNames(body.tools, "super_admin", { smartReporting: true });
        if (tools.length !== body.tools.length) return send(res, 400, { error: "Unknown AI tool." });
        fields.tools = tools;
      }
      if ("dailyLimit" in body) {
        fields.dailyLimit = body.dailyLimit == null || body.dailyLimit === ""
          ? null
          : Math.max(1, Math.min(1000, Number(body.dailyLimit) || 1));
      }
      const permission = await store.putAiUserPermission(target.username, fields);
      await store.logActivity({
        ts: new Date().toISOString(), taskId: null, by: me.name,
        text: `updated AI access for ${target.name}`,
      });
      return send(res, 200, { permission });
    }

    case "PATCH /api/ai/admin": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      if (me.role !== "super_admin") return send(res, 403, { error: "Super admin only." });
      const body = await readBody(req);
      const fields = { updatedBy: me.username };
      if ("enabled" in body) fields.enabled = !!body.enabled;
      if ("model" in body) fields.model = clean(body.model, 80) || undefined;
      if ("allowClient" in body) fields.allowClient = !!body.allowClient;
      if ("dailyLimit" in body) fields.dailyLimit = Number(body.dailyLimit) || undefined;
      if (body.features && typeof body.features === "object") {
        const cur = (await store.getAiSettings()).features;
        fields.features = {
          ask: !!body.features.ask,
          chat: !!body.features.chat,
          brief: !!body.features.brief,
          summaries: !!body.features.summaries,
        };
        fields.features = { ...cur, ...fields.features };
      }
      if ("apiKey" in body && String(body.apiKey || "").trim()) {
        const apiKey = String(body.apiKey).trim();
        if (apiKey.length < 12 || apiKey.length > 500) {
          return send(res, 400, { error: "The private access key must be between 12 and 500 characters." });
        }
        const current = await store.getAiSettings();
        fields.provider = {
          ...(current.provider || {}),
          apiKeyEncrypted: ai.encryptApiKey(apiKey),
          keyUpdatedAt: new Date().toISOString(),
          keyUpdatedBy: me.username,
        };
      } else if (body.clearApiKey === true) {
        const current = await store.getAiSettings();
        fields.provider = {
          ...(current.provider || {}),
          apiKeyEncrypted: "",
          keyUpdatedAt: new Date().toISOString(),
          keyUpdatedBy: me.username,
        };
      }
      if ("connectionType" in body) {
        const connectionType = clean(body.connectionType, 30);
        const baseUrl = ai.baseUrlForConnectionType(connectionType);
        if (!baseUrl) return send(res, 400, { error: "Choose a valid private access route." });
        const current = await store.getAiSettings();
        fields.model = ai.modelForConnectionType(connectionType);
        fields.provider = { ...(current.provider || {}), ...(fields.provider || {}), baseUrl };
      }
      // two-tier model routing: basic (everyday) + advanced (deep reasoning)
      if (body.models && typeof body.models === "object") {
        const current = await store.getAiSettings();
        const cur = (current.provider && current.provider.models) || {};
        const basic = "basic" in body.models ? clean(body.models.basic, 80) : cur.basic;
        const advanced = "advanced" in body.models ? clean(body.models.advanced, 80) : cur.advanced;
        fields.provider = {
          ...(current.provider || {}), ...(fields.provider || {}),
          models: {
            basic: basic || "kimi-k2.6",
            advanced: advanced || "kimi-k3",
          },
        };
      }
      if ("baseUrl" in body) {
        const baseUrl = String(body.baseUrl || "").replace(/\/$/, "");
        if (!ai.ALLOWED_KIMI_BASE_URLS.includes(baseUrl)) {
          return send(res, 400, { error: "Choose a valid private access route." });
        }
        const current = await store.getAiSettings();
        fields.provider = { ...(current.provider || {}), ...(fields.provider || {}), baseUrl };
      }
      const settings = await store.putAiSettings(fields);
      await store.logActivity({ ts: new Date().toISOString(), taskId: null, by: me.name, text: `updated AI settings (${Object.keys(fields).filter((k) => k !== "updatedBy").join(", ") || "none"})` });
      // Provider credentials are write-only. Return only public configuration,
      // never the encrypted payload or any future reserved server metadata.
      return send(res, 200, { settings: {
        enabled: settings.enabled,
        features: settings.features,
        allowClient: settings.allowClient,
        dailyLimit: settings.dailyLimit,
      } });
    }

    case "POST /api/ai/admin/test": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      if (me.role !== "super_admin") return send(res, 403, { error: "Super admin only." });
      const result = await ai.testConnection(store);
      if (result.ok && result.autoDetected && result.baseUrl) {
        const current = await store.getAiSettings();
        await store.putAiSettings({
          model: result.recommendedModel || current.model,
          provider: { ...(current.provider || {}), baseUrl: result.baseUrl },
          updatedBy: me.username,
        });
        result.configurationUpdated = true;
      }
      await store.aiLog({ username: me.username, kind: "test", status: result.ok ? "ok" : "error", error: result.ok ? "" : result.error });
      return send(res, 200, result.ok
        ? { ok: true, configurationUpdated: !!result.configurationUpdated }
        : { ok: false, error: "The private connection could not be verified. Check the access route, key, and available quota." });
    }

    default:
      return send(res, 404, { error: "Unknown endpoint." });
  }
}

function publicOf(user) {
  return { username: user.username, role: user.role, name: user.name, org: user.org, departments: decodeDepartmentIds(user.departments || []) };
}

function adminUserOf(user, departments, profile) {
  return {
    username: user.username,
    role: user.role,
    name: user.name,
    org: user.org,
    active: user.active !== false,
    departments: decodeDepartmentIds(user.departments || [], "", departments),
    profile: profile || { availability: "away", bio: "", contact: "", email: "", avatar: "" },
  };
}

// path patterns that hit route() with dynamic segments; key = the switch label
const ROUTE_PATTERNS = [
  { re: /^\/api\/files\/([\w-]+)\/download$/, key: "GET /api/files/:fileId/download", methods: ["GET"] },
  { re: /^\/api\/tasks\/([\w-]+)\/comments$/, key: "POST /api/tasks/:id/comments", methods: ["POST"] },
  { re: /^\/api\/tasks\/([\w-]+)\/comments\/([\w-]+)$/, key: "DELETE /api/tasks/:id/comments/:commentId", methods: ["DELETE"] },
  { re: /^\/api\/tasks\/([\w-]+)\/subtasks$/, key: "POST /api/tasks/:id/subtasks", methods: ["POST"] },
  { re: /^\/api\/tasks\/([\w-]+)\/subtasks\/([\w-]+)$/, key: "PATCH /api/tasks/:id/subtasks/:subtaskId", methods: ["PATCH"] },
  { re: /^\/api\/tasks\/([\w-]+)\/subtasks\/([\w-]+)$/, key: "DELETE /api/tasks/:id/subtasks/:subtaskId", methods: ["DELETE"] },
  { re: /^\/api\/tasks\/([\w-]+)\/files$/, key: "POST /api/tasks/:id/files", methods: ["POST"] },
  { re: /^\/api\/tasks\/([\w-]+)\/files\/([\w-]+)$/, key: "PATCH /api/tasks/:id/files/:fileId", methods: ["PATCH"] },
  { re: /^\/api\/tasks\/([\w-]+)\/accept$/, key: "POST /api/tasks/:id/accept", methods: ["POST"] },
  { re: /^\/api\/tasks\/([\w-]+)\/review$/, key: "POST /api/tasks/:id/review", methods: ["POST"] },
  { re: /^\/api\/tasks\/([\w-]+)\/updates$/, key: "POST /api/tasks/:id/updates", methods: ["POST"] },
  { re: /^\/api\/tasks\/([\w-]+)$/, key: "PATCH /api/tasks/:id", methods: ["PATCH"] },
  { re: /^\/api\/tasks\/([\w-]+)$/, key: "DELETE /api/tasks/:id", methods: ["DELETE"] },
  { re: /^\/api\/chat\/channels\/([\w-]+)\/messages$/, key: "GET /api/chat/channels/:cid/messages", methods: ["GET"] },
  { re: /^\/api\/chat\/channels\/([\w-]+)\/messages$/, key: "POST /api/chat/channels/:cid/messages", methods: ["POST"] },
  { re: /^\/api\/chat\/messages\/(\d+)\/reactions$/, key: "POST /api/chat/messages/:messageId/reactions", methods: ["POST"] },
  { re: /^\/api\/chat\/messages\/(\d+)$/, key: "DELETE /api/chat/messages/:messageId", methods: ["DELETE"] },
  { re: /^\/api\/chat\/channels\/([\w-]+)\/read$/, key: "POST /api/chat/channels/:cid/read", methods: ["POST"] },
  { re: /^\/api\/chat\/channels\/([\w-]+)\/mute$/, key: "POST /api/chat/channels/:cid/mute", methods: ["POST"] },
  { re: /^\/api\/ai\/summarize\/task\/([\w-]+)$/, key: "POST /api/ai/summarize/task/:id", methods: ["POST"] },
  { re: /^\/api\/metrics\/(\d+)$/, key: "DELETE /api/metrics/:id", methods: ["DELETE"] },
  { re: /^\/api\/ai\/summarize\/channel\/([\w-]+)$/, key: "POST /api/ai/summarize/channel/:cid", methods: ["POST"] },
  { re: /^\/api\/ai\/admin\/users\/([\w.-]+)$/, key: "PATCH /api/ai/admin/users/:username", methods: ["PATCH"] },
  { re: /^\/api\/admin\/users\/([\w.-]+)$/, key: "PATCH /api/admin/users/:username", methods: ["PATCH"] },
  { re: /^\/api\/admin\/users\/([\w.-]+)$/, key: "DELETE /api/admin/users/:username", methods: ["DELETE"] },
  { re: /^\/api\/admin\/departments\/([\w-]+)$/, key: "PATCH /api/admin/departments/:deptId", methods: ["PATCH"] },
  { re: /^\/api\/admin\/departments\/([\w-]+)$/, key: "DELETE /api/admin/departments/:deptId", methods: ["DELETE"] },
  { re: /^\/api\/admin\/channels\/([\w-]+)$/, key: "PATCH /api/admin/channels/:cid", methods: ["PATCH"] },
  { re: /^\/api\/admin\/channels\/([\w-]+)$/, key: "DELETE /api/admin/channels/:cid", methods: ["DELETE"] },
  { re: /^\/api\/admin\/channels\/([\w-]+)\/members$/, key: "POST /api/admin/channels/:cid/members", methods: ["POST"] },
  { re: /^\/api\/admin\/channels\/([\w-]+)\/members\/([\w.-]+)$/, key: "DELETE /api/admin/channels/:cid/members/:username", methods: ["DELETE"] },
];

/**
 * Entry point for both local server and Vercel function.
 * Handles any /api/* request; everything else returns false (caller serves static).
 */
async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  const pathname = url.pathname.replace(/\/$/, "") || "/";
  if (!pathname.startsWith("/api/")) return false;

  try {
    for (const p of ROUTE_PATTERNS) {
      const m = pathname.match(p.re);
      if (m && p.methods.includes(req.method)) {
        await route(req, res, p.key, m.slice(1));
        return true;
      }
    }
    await route(req, res, `${req.method} ${pathname}`, []);
  } catch (err) {
    const msg = (err && err.message) || "";
    if (msg === "invalid JSON") {
      send(res, 400, { error: "Request body is not valid JSON." });
      return true;
    }
    if (msg === "body too large") {
      send(res, 400, { error: "Request body too large (limit 4 MB)." }, { Connection: "close" });
      return true;
    }
    console.error(`[task-hub] ${req.method} ${pathname} failed:`, err);
    send(res, 500, { error: "Server error." });
  }
  return true;
}

module.exports = { handle };
