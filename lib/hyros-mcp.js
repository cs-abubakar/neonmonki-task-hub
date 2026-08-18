/**
 * HYROS OAuth + MCP client — the "Connect with Hyros" flow.
 *
 * Implements exactly what the official Hyros MCP documentation specifies
 * (https://mcp.hyros.com/mcp, see docs/hyros-integration-spec.md §4):
 *
 * - OAuth 2.1 authorization-code grant with PKCE (S256)
 * - Dynamic client registration (RFC 7591), discovered via RFC 9728
 *   protected-resource metadata + RFC 8414 authorization-server metadata
 * - Scope: `mcp`; tokens via `Authorization: Bearer` header only
 * - Access tokens live 15 minutes; clients registered WITH credentials
 *   (client_secret_basic) receive a 30-day refresh token, rotated on each use
 *   — we persist every rotation immediately, so the daily sync keeps the
 *   connection alive indefinitely without the user signing in again
 * - Transport: Streamable HTTP (JSON-RPC POST, JSON or SSE responses),
 *   initialize → notifications/initialized → tools/call, Mcp-Session-Id
 *   tracked per process
 *
 * READ-ONLY GUARANTEE
 * -------------------
 * This module physically cannot mutate Hyros data: `callTool` throws unless
 * the tool is in READ_ONLY_TOOLS below. Every write tool (create/update/
 * delete/refund) is excluded, so neither the sync pipeline nor Monki can ever
 * alter the Hyros account through this connection. The whitelist is the
 * enforcement point — do not add write tools here.
 *
 * Nothing in this module logs or returns tokens; errors are sanitized.
 */
"use strict";

const crypto = require("crypto");

const MCP_URL = (process.env.HYROS_MCP_URL || "https://mcp.hyros.com/mcp").replace(/\/+$/, "");
const MCP_ORIGIN = MCP_URL.replace(/\/mcp$/, "");
const TIMEOUT_MS = 20000;
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const CLIENT_NAME = "NEONMONKI Task Hub";

/* The 29 read-only tools from the official MCP reference. Anything not in
 * this set is refused before a request is ever made. */
const READ_ONLY_TOOLS = new Set([
  "hyros_get_leads", "hyros_get_lead_journey", "hyros_get_lead_clicks",
  "hyros_get_sales", "hyros_get_carts", "hyros_get_subscriptions",
  "hyros_get_calls", "hyros_get_products", "hyros_get_sources",
  "hyros_get_ads", "hyros_get_keywords", "hyros_get_tags_count",
  "hyros_get_tags", "hyros_get_stages", "hyros_get_custom_costs",
  "hyros_get_conversion_definitions", "hyros_get_roas_report",
  "hyros_get_attribution_report", "hyros_get_ad_account_report",
  "hyros_get_ad_accounts", "hyros_get_account_tracking_script",
  "hyros_get_tracking_script_with_custom_domain", "hyros_get_domains",
  "hyros_assert_script_presence_on_domain", "hyros_get_integrations_types",
  "hyros_get_active_external_integrations",
  "hyros_check_tracking_parameters_for_integrations",
  "hyros_search_hyros_docs", "hyros_get_user_info",
]);

/* ------------------------------ small helpers ------------------------------ */

const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const randomToken = (bytes = 48) => b64url(crypto.randomBytes(bytes));
const sha256B64Url = (text) => b64url(crypto.createHash("sha256").update(text).digest());

function sanitizedError(prefix, status) {
  // response bodies may echo request data — status codes only
  const e = new Error(status ? `${prefix} (HTTP ${status})` : prefix);
  e.status = status || 0;
  return e;
}

async function fetchJson(url, { method = "GET", headers = {}, body } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      headers: { Accept: "application/json", ...headers },
      ...(body !== undefined ? { body } : {}),
      signal: ctrl.signal,
      redirect: "manual", // never follow redirects with Authorization headers attached
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    return { status: res.status, json, headers: res.headers, raw: text };
  } catch (e) {
    if (e.name === "AbortError") throw sanitizedError("Hyros request timed out");
    throw sanitizedError("Hyros is unreachable right now");
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------ OAuth discovery ------------------------------ */

let discoveryCache = null;

/**
 * RFC 9728 + RFC 8414 discovery. Result cached per process; call with
 * `refresh: true` to bypass (used by tests and after a 401 surprise).
 */
async function discoverOAuth({ refresh = false } = {}) {
  if (discoveryCache && !refresh) return discoveryCache;
  const pr = await fetchJson(`${MCP_ORIGIN}/.well-known/oauth-protected-resource/mcp`);
  if (pr.status !== 200 || !pr.json) throw sanitizedError("Hyros OAuth discovery failed", pr.status);
  const servers = Array.isArray(pr.json.authorization_servers) ? pr.json.authorization_servers : [];
  if (!servers.length) throw sanitizedError("Hyros did not publish an authorization server");
  const issuer = String(servers[0]).replace(/\/+$/, "");

  // RFC 8414 path-aware metadata, with the OIDC variant as fallback.
  const candidates = [
    `${issuer}/.well-known/oauth-authorization-server`,
    `${issuer}/.well-known/openid-configuration`,
  ];
  let meta = null;
  for (const url of candidates) {
    const r = await fetchJson(url);
    if (r.status === 200 && r.json && r.json.authorization_endpoint) { meta = r.json; break; }
  }
  if (!meta || !meta.token_endpoint) throw sanitizedError("Hyros authorization-server metadata is incomplete");
  discoveryCache = {
    issuer,
    authorizationEndpoint: meta.authorization_endpoint,
    tokenEndpoint: meta.token_endpoint,
    registrationEndpoint: meta.registration_endpoint || "",
  };
  return discoveryCache;
}

/* ------------------------------ dynamic client registration ------------------------------ */

/**
 * RFC 7591. We ask for `client_secret_basic` first because only confidential
 * clients receive the 30-day rotating refresh token; if the server refuses we
 * fall back to a public client (`none`) — which works but means the browser
 * sign-in must be repeated when the 15-minute access token expires.
 */
async function registerClient(meta, redirectUri) {
  if (!meta.registrationEndpoint) throw sanitizedError("Hyros does not offer dynamic client registration");
  const base = {
    client_name: CLIENT_NAME,
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    scope: "mcp",
  };
  for (const authMethod of ["client_secret_basic", "none"]) {
    const r = await fetchJson(meta.registrationEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...base, token_endpoint_auth_method: authMethod }),
    });
    if ((r.status === 200 || r.status === 201) && r.json && r.json.client_id) {
      return {
        clientId: String(r.json.client_id),
        clientSecret: r.json.client_secret ? String(r.json.client_secret) : "",
        authMethod: r.json.client_secret ? "client_secret_basic" : "none",
      };
    }
    if (r.status === 400 && authMethod === "client_secret_basic") continue; // retry as public client
    throw sanitizedError("Hyros client registration failed", r.status);
  }
  throw sanitizedError("Hyros client registration failed");
}

/* ------------------------------ authorization flow ------------------------------ */

function buildAuthorizationUrl(meta, { clientId, redirectUri, state, codeChallenge }) {
  const u = new URL(meta.authorizationEndpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("scope", "mcp");
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", codeChallenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

function newPkcePair() {
  const verifier = randomToken(48);
  return { verifier, challenge: sha256B64Url(verifier) };
}

function tokenRequestHeaders(client) {
  const headers = { "Content-Type": "application/x-www-form-urlencoded" };
  if (client.clientSecret) {
    headers.Authorization = `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString("base64")}`;
  }
  return headers;
}

async function exchangeCode(meta, client, { code, redirectUri, verifier }) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: String(code || ""),
    redirect_uri: redirectUri,
    code_verifier: verifier,
    client_id: client.clientId,
  });
  const r = await fetchJson(meta.tokenEndpoint, {
    method: "POST", headers: tokenRequestHeaders(client), body: body.toString(),
  });
  if (r.status !== 200 || !r.json || !r.json.access_token) {
    throw sanitizedError("Hyros token exchange failed", r.status);
  }
  return normalizeTokens(r.json);
}

async function refreshTokens(meta, client, refreshToken) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: client.clientId,
  });
  const r = await fetchJson(meta.tokenEndpoint, {
    method: "POST", headers: tokenRequestHeaders(client), body: body.toString(),
  });
  if (r.status !== 200 || !r.json || !r.json.access_token) {
    const e = sanitizedError("Hyros token refresh failed", r.status);
    e.reconnectRequired = r.status === 400 || r.status === 401; // dead refresh token → sign in again
    throw e;
  }
  return normalizeTokens(r.json);
}

function normalizeTokens(json) {
  const expiresIn = Number(json.expires_in) || 900;
  return {
    accessToken: String(json.access_token),
    refreshToken: json.refresh_token ? String(json.refresh_token) : "",
    // 30s skew so we never hand out a token that dies mid-request
    accessExpiresAt: new Date(Date.now() + expiresIn * 1000 - 30000).toISOString(),
  };
}

/**
 * Return a usable access token for the cfg, refreshing + persisting via
 * `cfg.persistTokens` when expired. cfg is mutated in place so a sync run
 * reuses the fresh token.
 */
async function ensureAccessToken(cfg) {
  if (cfg.accessToken && cfg.accessExpiresAt && Date.parse(cfg.accessExpiresAt) > Date.now() + 60000) {
    return cfg.accessToken;
  }
  if (!cfg.refreshToken) {
    const e = new Error("The Hyros sign-in has expired — reconnect from Admin → Integrations.");
    e.reconnectRequired = true;
    throw e;
  }
  const meta = await discoverOAuth();
  const tokens = await refreshTokens(meta, { clientId: cfg.clientId, clientSecret: cfg.clientSecret }, cfg.refreshToken);
  cfg.accessToken = tokens.accessToken;
  cfg.accessExpiresAt = tokens.accessExpiresAt;
  if (tokens.refreshToken) cfg.refreshToken = tokens.refreshToken; // rotated — persist below
  if (typeof cfg.persistTokens === "function") await cfg.persistTokens(tokens);
  return cfg.accessToken;
}

/* ------------------------------ MCP transport ------------------------------ */

// Per-process session: initialize once per access token, reuse Mcp-Session-Id.
let mcpSession = { sessionId: "", tokenHash: "", ready: false };

async function mcpPost(token, payload, sessionId) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (sessionId) headers["Mcp-Session-Id"] = sessionId;
    const res = await fetch(MCP_URL, { method: "POST", headers, body: JSON.stringify(payload), signal: ctrl.signal });
    const text = await res.text();
    return { status: res.status, text, sessionId: res.headers.get("mcp-session-id") || sessionId || "" };
  } catch (e) {
    if (e.name === "AbortError") throw sanitizedError("Hyros MCP request timed out");
    if (e.status) throw e;
    throw sanitizedError("Hyros MCP is unreachable right now");
  } finally {
    clearTimeout(timer);
  }
}

/** Parse a Streamable-HTTP response body (JSON or SSE) into the JSON-RPC message. */
function parseRpcPayload(text) {
  if (!text) return null;
  const trimmed = String(text).trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try { return JSON.parse(trimmed); } catch { /* fall through to SSE */ }
  }
  // SSE: collect data: lines, the JSON-RPC response is the last complete one
  let last = null;
  for (const line of trimmed.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try { last = JSON.parse(data); } catch { /* skip */ }
  }
  return last;
}

async function ensureSession(token) {
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex").slice(0, 16);
  if (mcpSession.ready && mcpSession.tokenHash === tokenHash && mcpSession.sessionId) return mcpSession.sessionId;
  for (const version of PROTOCOL_VERSIONS) {
    const r = await mcpPost(token, {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: {
        protocolVersion: version,
        capabilities: {},
        clientInfo: { name: "neonmonki-task-hub", version: "1.0" },
      },
    }, mcpSession.sessionId);
    if (r.status === 200) {
      const msg = parseRpcPayload(r.text);
      if (!msg || msg.error) throw sanitizedError("Hyros MCP initialize failed");
      mcpSession = { sessionId: r.sessionId, tokenHash, ready: true };
      // fire-and-forget initialized notification (204 expected)
      mcpPost(token, { jsonrpc: "2.0", method: "notifications/initialized" }, mcpSession.sessionId).catch(() => {});
      return mcpSession.sessionId;
    }
    if (r.status === 400) continue; // try the next protocol version
    if (r.status === 401) { const e = sanitizedError("Hyros MCP rejected the access token", 401); e.reconnectRequired = true; throw e; }
    throw sanitizedError("Hyros MCP initialize failed", r.status);
  }
  throw sanitizedError("Hyros MCP protocol version negotiation failed", 400);
}

/**
 * Call a READ-ONLY Hyros MCP tool. Throws before any network activity when the
 * tool is not whitelisted — this is the read-only enforcement point for the
 * whole integration.
 */
async function callTool(cfg, name, args = {}, _retried = false) {
  if (!READ_ONLY_TOOLS.has(name)) {
    throw new Error(`Refused: "${name}" is not a read-only Hyros tool. This connection never writes to Hyros.`);
  }
  const token = await ensureAccessToken(cfg);
  const sessionId = await ensureSession(token);
  const r = await mcpPost(token, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }, sessionId);
  if (r.status === 429 && !_retried) {
    await new Promise((res) => setTimeout(res, 2000));
    return callTool(cfg, name, args, true);
  }
  if ((r.status === 404 || r.status === 400) && !_retried) {
    // session likely expired — re-initialize once and retry
    mcpSession = { sessionId: "", tokenHash: "", ready: false };
    return callTool(cfg, name, args, true);
  }
  if (r.status === 401) {
    const e = sanitizedError("Hyros MCP rejected the access token", 401);
    e.reconnectRequired = true;
    throw e;
  }
  if (r.status !== 200) throw sanitizedError("Hyros MCP tool call failed", r.status);
  const msg = parseRpcPayload(r.text);
  if (!msg) throw sanitizedError("Hyros MCP returned an unreadable response");
  if (msg.error) throw sanitizedError(`Hyros MCP error ${msg.error.code || ""}`.trim());
  const result = msg.result || {};
  if (result.isError) throw sanitizedError("Hyros tool reported an error");
  if (result.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
  const content = Array.isArray(result.content) ? result.content : [];
  const textBlock = content.find((c) => c && c.type === "text" && typeof c.text === "string");
  if (textBlock) {
    try { return JSON.parse(textBlock.text); } catch { return { text: textBlock.text }; }
  }
  return result;
}

/** tools/list — used by tests and diagnostics; names only, no schemas stored. */
async function listToolNames(cfg) {
  const token = await ensureAccessToken(cfg);
  const sessionId = await ensureSession(token);
  const r = await mcpPost(token, { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }, sessionId);
  if (r.status !== 200) throw sanitizedError("Hyros MCP tools/list failed", r.status);
  const msg = parseRpcPayload(r.text);
  const tools = (msg && msg.result && Array.isArray(msg.result.tools)) ? msg.result.tools : [];
  return tools.map((t) => String(t && t.name || "")).filter(Boolean);
}

function resetSessionCacheForTests() {
  mcpSession = { sessionId: "", tokenHash: "", ready: false };
  discoveryCache = null;
}

module.exports = {
  MCP_URL, READ_ONLY_TOOLS,
  discoverOAuth, registerClient, buildAuthorizationUrl, newPkcePair,
  exchangeCode, refreshTokens, ensureAccessToken, callTool, listToolNames,
  resetSessionCacheForTests,
};
