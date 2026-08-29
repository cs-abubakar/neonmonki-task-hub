/**
 * Discord notification layer — the single place that talks to Discord.
 *
 * The Task Hub database stays the source of truth; Discord only receives
 * near-real-time pings about things that already happened here:
 *
 *   TMS event (assign / mention / comment / overdue)
 *     → deliver() / runOverdueSweep()      (this module)
 *       → board channel for the task's board (clients registry)
 *         → <@discord-user-id> mention + safe task summary + link back
 *
 * Configuration is admin-managed, never hard-coded:
 *   - integration_connections row id "discord": bot token (AES-256-GCM in
 *     api_key_encrypted, write-only like every other connector), enabled flag,
 *     guild id, default channel id and per-type toggles in `meta`.
 *   - clients.discord_channel_id / discord_enabled: per-board channel routing.
 *   - users.discord_user_id: who a mention points at.
 *
 * Privacy mirrors the in-app rules: targets are always re-checked with
 * canSeeTask(), and tasks that are not client-shared send only a minimal
 * "something needs you" message + link — never titles or comment text.
 *
 * Failure philosophy: Discord is best-effort. Every public entry point
 * resolves instead of throwing, so an outage, a bad token or a missing
 * Discord ID can never break a Task Hub action.
 */
"use strict";

const ai = require("./ai");
const { canSeeTask } = require("./permissions");
const { enrichTask } = require("./task-system");

const INTEGRATION_ID = "discord";
const CIPHER_CONTEXT = "neonmonki-task-hub:discord:v1";
const API_BASE = () => (process.env.DISCORD_API_BASE || "https://discord.com/api/v10").replace(/\/$/, "");
const DEFAULT_BOARD_ID = "neonmonki";
const MAX_CONTENT = 1900; // Discord hard limit is 2000 — keep headroom.

const NOTIFICATION_TYPES = ["assigned", "mention", "comment", "overdue"];

const KIND_ICON = { assigned: "🔔", mention: "💬", comment: "💬", overdue: "⏰", test: "✅" };

/* ------------------------------ configuration ------------------------------ */

function normalizeNotifications(meta) {
  const n = (meta && meta.notifications) || {};
  const out = {};
  for (const type of NOTIFICATION_TYPES) out[type] = n[type] !== false;
  return out;
}

/**
 * Resolved Discord config. `token` is present for server-side sending only —
 * shape API responses with publicConfig(), never hand this object to a client.
 */
async function getConfig(store) {
  const row = typeof store.getIntegration === "function" ? await store.getIntegration(INTEGRATION_ID) : null;
  const secret = typeof store.getIntegrationSecret === "function" ? await store.getIntegrationSecret(INTEGRATION_ID) : null;
  const meta = (row && row.meta) || (secret && secret.meta) || {};
  const token =
    ai.decryptSecret(secret && secret.apiKeyEncrypted, CIPHER_CONTEXT) ||
    String(process.env.DISCORD_BOT_TOKEN || "").trim();
  return {
    configured: !!(row || token),
    enabled: meta.enabled === true && !!token,
    hasToken: !!token,
    token,
    guildId: String(meta.guildId || process.env.DISCORD_GUILD_ID || "").trim(),
    defaultChannelId: String(meta.defaultChannelId || process.env.DISCORD_DEFAULT_CHANNEL_ID || "").trim(),
    notifications: normalizeNotifications(meta),
    status: (row && row.status) || "disconnected",
    accountName: (row && row.accountName) || "",
    lastError: (row && row.lastError) || "",
    lastTestAt: meta.lastTestAt || null,
  };
}

/** Client-safe view of the config — never includes the token. */
function publicConfig(cfg) {
  return {
    configured: cfg.configured,
    enabled: cfg.enabled,
    hasToken: cfg.hasToken,
    guildId: cfg.guildId,
    defaultChannelId: cfg.defaultChannelId,
    notifications: cfg.notifications,
    status: cfg.status,
    accountName: cfg.accountName,
    lastError: cfg.lastError,
    lastTestAt: cfg.lastTestAt,
  };
}

/** Persist admin settings. The bot token is write-only: blank keeps the saved one. */
async function saveSettings(store, { enabled, guildId, defaultChannelId, notifications, botToken, clearToken }, actorName) {
  const current = await getConfig(store);
  const meta = {
    enabled: enabled === true,
    guildId: String(guildId || "").trim(),
    defaultChannelId: String(defaultChannelId || "").trim(),
    // Toggles not included in this save keep their current values.
    notifications: notifications ? normalizeNotifications({ notifications }) : current.notifications,
    lastTestAt: current.lastTestAt,
  };
  const fields = { name: "Discord", meta };
  if (botToken) fields.apiKeyEncrypted = ai.encryptSecret(botToken, CIPHER_CONTEXT);
  if (clearToken === true) {
    fields.apiKeyEncrypted = "";
    fields.status = "disconnected";
    fields.accountName = "";
  } else if (meta.enabled && (botToken || current.hasToken) && current.status === "disconnected") {
    fields.status = "connected"; // verified for real by the next test/send
  }
  await store.putIntegration(INTEGRATION_ID, fields);
  if (actorName) {
    await store.logActivity({
      ts: new Date().toISOString(), taskId: null, by: actorName,
      text: `updated Discord integration (enabled: ${meta.enabled}, token ${botToken ? "replaced" : clearToken ? "cleared" : "unchanged"})`,
    });
  }
  return getConfig(store);
}

/** Boards = the client registry; each may route to its own Discord channel. */
async function boardsWithDiscord(store) {
  const clients = typeof store.clientsList === "function" ? await store.clientsList() : [];
  return clients.map((c) => ({
    id: c.id,
    name: c.name,
    active: c.active !== false,
    discordChannelId: String(c.discordChannelId || "").trim(),
    discordEnabled: c.discordEnabled !== false,
  }));
}

/**
 * Board channel first, workspace default second; "" means "cannot deliver".
 * An existing board with discord explicitly disabled NEVER sends — not even
 * to the default channel. Unknown/unregistered board ids fall back to the
 * default deliberately: an unregistered clientId is a data anomaly, and the
 * workspace default is the safest place to surface it.
 */
function channelForTask(task, boards, cfg) {
  const boardId = task.clientId || DEFAULT_BOARD_ID;
  const board = boards.find((b) => b.id === boardId);
  if (board && board.discordEnabled === false) return "";
  if (board && board.discordChannelId) return board.discordChannelId;
  return cfg.defaultChannelId || "";
}

/* ------------------------------ discord api ------------------------------ */

function sanitizedError(err) {
  // Never leak the token: Discord error bodies don't contain it, but the
  // request headers do — only status + Discord's own message survive here.
  const detail = String((err && err.detail) || "");
  let msg = "";
  try { msg = JSON.parse(detail).message || ""; } catch { /* plain text */ }
  return `Discord API error ${err && err.status ? err.status : "—"}${msg ? `: ${msg.slice(0, 160)}` : ""}`.trim();
}

async function apiRequest(path, { method = "GET", token, body = null, timeoutMs = 6000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_BASE()}${path}`, {
      method,
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "neonmonki-task-hub (task notifications)",
      },
      body: body == null ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      err.detail = String(text || "").slice(0, 400);
      throw err;
    }
    try { return JSON.parse(text); } catch { return {}; }
  } catch (e) {
    if (e.name === "AbortError") {
      const err = new Error("Discord request timed out");
      err.code = "timeout";
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** Post a channel message. One bounded retry on 429 (honors retry_after) / 5xx. */
async function postMessage(token, channelId, content, { attempt = 0 } = {}) {
  try {
    await apiRequest(`/channels/${encodeURIComponent(channelId)}/messages`, {
      method: "POST",
      token,
      body: { content: String(content || "").slice(0, MAX_CONTENT) },
    });
    return { ok: true };
  } catch (e) {
    const transient = e.code === "timeout" || e.status === 429 || (e.status >= 500 && e.status < 600);
    if (transient && attempt < 1) {
      let waitMs = 900 + Math.floor(Math.random() * 400);
      if (e.status === 429) {
        try {
          const retryAfter = Number(JSON.parse(e.detail || "{}").retry_after);
          if (Number.isFinite(retryAfter) && retryAfter > 0) waitMs = Math.min(3000, Math.ceil(retryAfter * 1000));
        } catch { /* keep default wait */ }
      }
      await new Promise((r) => setTimeout(r, waitMs));
      return postMessage(token, channelId, content, { attempt: attempt + 1 });
    }
    return { ok: false, error: e.code === "timeout" ? "Discord request timed out" : sanitizedError(e) };
  }
}

/** Meta payload for putIntegration — built explicitly so the token can never leak into it. */
function metaPayload(cfg, lastTestAt) {
  return {
    // A connection test verifies the token; it must never flip the admin's
    // enable switch (testing a deliberately-disabled integration used to
    // silently re-enable it via the old status-derived fallback).
    enabled: cfg.enabled === true,
    guildId: cfg.guildId,
    defaultChannelId: cfg.defaultChannelId,
    notifications: cfg.notifications,
    lastTestAt: lastTestAt || cfg.lastTestAt || null,
  };
}

/** Verify the saved token (GET /users/@me) and optionally post a test message. */
async function testConnection(store, { channelId = "" } = {}) {
  const cfg = await getConfig(store);
  if (!cfg.token) return { ok: false, error: "No bot token saved yet — paste one and save first." };
  const target = String(channelId || cfg.defaultChannelId || "").trim();
  try {
    const me = await apiRequest("/users/@me", { token: cfg.token });
    const botName = me.username ? `${me.username}${me.discriminator && me.discriminator !== "0" ? "#" + me.discriminator : ""}` : "Discord bot";
    if (target) {
      const posted = await postMessage(
        cfg.token,
        target,
        "✅ Task Hub connected — Discord notifications for this board will arrive in this channel."
      );
      if (!posted.ok) {
        await store.putIntegration(INTEGRATION_ID, {
          status: "error", accountName: botName,
          lastError: `Token works, but posting to the channel failed — ${posted.error}`,
          meta: metaPayload(cfg, new Date().toISOString()),
        }).catch(() => {});
        return { ok: false, bot: botName, error: `Bot verified as ${botName}, but it could not post in channel ${target}. Check the bot is in the server and has Send Messages permission there. (${posted.error})` };
      }
      await store.putIntegration(INTEGRATION_ID, {
        status: "connected",
        accountName: botName,
        lastError: "",
        meta: metaPayload(cfg, new Date().toISOString()),
      }).catch(() => {});
      return { ok: true, bot: botName, messageSent: true };
    }
    await store.putIntegration(INTEGRATION_ID, {
      status: "connected",
      accountName: botName,
      lastError: "",
      meta: metaPayload(cfg, new Date().toISOString()),
    }).catch(() => {});
    return { ok: true, bot: botName, messageSent: false };
  } catch (e) {
    const error = e.status === 401
      ? "Discord rejected the bot token (401) — generate a fresh token in the Developer Portal and save it here."
      : sanitizedError(e);
    await store.putIntegration(INTEGRATION_ID, {
      status: "error",
      lastError: error,
      meta: metaPayload(cfg, new Date().toISOString()),
    }).catch(() => {});
    return { ok: false, error };
  }
}

/* ------------------------------ message building ------------------------------ */

function taskUrl(origin, taskId) {
  return `${origin}/#/tasks/${encodeURIComponent(taskId)}`;
}

const clip = (value, max) => {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/**
 * Visibility-aware message. Shared tasks can show the title and a comment
 * excerpt (that content is client-visible anyway); anything restricted sends
 * only "you are needed" + the task id + link.
 */
function buildMessage({ kind, task, actor, mentionId, excerpt, boardName, origin, reassigned }) {
  const icon = KIND_ICON[kind] || "🔔";
  const shared = (task.visibility || "shared") === "shared";
  const headline = {
    assigned: reassigned ? "Task reassigned to you" : "New task assigned to you",
    mention: "You were mentioned",
    comment: "New update on your task",
    overdue: "Task is overdue",
  }[kind] || "Task notification";

  const lines = [`${icon} <@${mentionId}> — ${headline}`, ""];
  if (shared) {
    lines.push(`**Task:** ${clip(task.title, 140)}`);
  } else {
    lines.push(`**Task:** ${task.id} (restricted — open the Task Hub to view)`);
  }
  if (boardName) lines.push(`**Board:** ${clip(boardName, 60)}`);
  if (kind === "assigned" || kind === "overdue") {
    if (task.dueDate) lines.push(`**Due:** ${clip(task.dueDate, 30)}`);
    if (task.priority) lines.push(`**Priority:** ${clip(task.priority, 20)}`);
  }
  if (kind === "assigned" && actor && actor.name) lines.push(`**Assigned by:** ${clip(actor.name, 60)}`);
  if (shared && excerpt && (kind === "mention" || kind === "comment")) {
    lines.push("", `**${clip((actor && actor.name) || "Someone", 60)}:** “${clip(excerpt, 180)}”`);
  }
  lines.push("", `Open task: ${taskUrl(origin, task.id)}`);
  return lines.join("\n").slice(0, MAX_CONTENT);
}

/* ------------------------------ delivery ------------------------------ */

async function writeLog(store, entry) {
  if (typeof store.discordLogWrite !== "function") return;
  try { await store.discordLogWrite(entry); } catch { /* logging must never break sending */ }
}

/**
 * Send one notification to one user. Resolves the channel, builds the message,
 * posts, and records the outcome. Always resolves — never throws.
 */
async function sendToUser(store, cfg, boards, { kind, task, actor, user, excerpt, origin, eventKey, reassigned }) {
  const base = {
    eventKey: eventKey || `${kind}:${task.id}:${user.username}:${Date.now().toString(36)}`,
    kind,
    username: user.username,
    discordUserId: user.discordUserId,
    taskId: task.id,
    boardId: task.clientId || DEFAULT_BOARD_ID,
  };
  if (!/^\d{5,25}$/.test(String(user.discordUserId || ""))) {
    await writeLog(store, { ...base, channelId: "", status: "skipped", error: "no Discord user id" });
    return { delivered: false, reason: "no-discord-id" };
  }
  // Central privacy gate: the same rule as in-app notifications. If this user
  // may not see the task, Discord must not hint that it exists.
  if (!canSeeTask(user, task)) {
    await writeLog(store, { ...base, channelId: "", status: "skipped", error: "task not visible to user" });
    return { delivered: false, reason: "not-visible" };
  }
  const channelId = channelForTask(task, boards, cfg);
  if (!channelId) {
    const board = boards.find((b) => b.id === (task.clientId || DEFAULT_BOARD_ID));
    const reason = board && board.discordEnabled === false ? "board Discord disabled" : "no channel configured";
    await writeLog(store, { ...base, channelId: "", status: "skipped", error: reason });
    return { delivered: false, reason: board && board.discordEnabled === false ? "board-disabled" : "no-channel" };
  }
  const board = boards.find((b) => b.id === (task.clientId || DEFAULT_BOARD_ID));
  const content = buildMessage({
    kind, task, actor, mentionId: user.discordUserId, excerpt, origin,
    boardName: board ? board.name : "", reassigned,
  });
  const posted = await postMessage(cfg.token, channelId, content);
  await writeLog(store, {
    ...base, channelId,
    status: posted.ok ? "sent" : "failed",
    error: posted.ok ? "" : posted.error,
  });
  if (!posted.ok) {
    // Surface persistent failures once on the integration row for admin
    // diagnostics (sanitized — never the token, never message content).
    store.putIntegration(INTEGRATION_ID, { lastError: posted.error }).catch(() => {});
  }
  return { delivered: posted.ok, reason: posted.ok ? "sent" : "send-failed", error: posted.error };
}

/**
 * Fan out a task event to Discord. `targets` = [{ username, kind }] computed by
 * the caller with the same rules as in-app notifications; this module decides
 * IF (enabled? configured? Discord ID? visible?) and HOW (channel + format).
 * Returns a small summary; never throws, so callers can fire-and-forget.
 */
async function deliver(store, { task, actor, targets, excerpt = "", origin, eventId = "", reassigned = false }) {
  const summary = { attempted: 0, sent: 0, skipped: 0, failed: 0 };
  try {
    const cfg = await getConfig(store);
    if (!cfg.configured || !cfg.enabled) return summary;
    const boards = await boardsWithDiscord(store);
    const users = await store.listUsers();
    const seen = new Set();
    const jobs = [];
    for (const target of targets || []) {
      const kind = NOTIFICATION_TYPES.includes(target.kind) ? target.kind : "comment";
      if (!cfg.notifications[kind]) continue;
      const dedupe = `${target.username}:${kind}`;
      if (seen.has(dedupe)) continue; // one message per user per action
      seen.add(dedupe);
      const user = users.find((u) => u.username === target.username && u.active);
      if (!user) continue;
      if (actor && user.username === actor.username) continue; // never ping yourself
      jobs.push({ kind, user, eventKey: eventId ? `${kind}:${eventId}:${user.username}` : "" });
    }
    summary.attempted = jobs.length;
    // Sends are independent and run in parallel: deliver() is awaited inside
    // request handlers, so a Discord outage must never multiply the per-send
    // timeout by the recipient count and stall the TMS action that triggered
    // it. Each send still carries its own timeout + single 429/5xx retry.
    const results = await Promise.all(jobs.map((job) => sendToUser(store, cfg, boards, {
      kind: job.kind, task, actor, user: job.user, excerpt, origin, reassigned, eventKey: job.eventKey,
    })));
    for (const result of results) {
      if (result.delivered) summary.sent += 1;
      else if (result.reason === "send-failed") summary.failed += 1;
      else summary.skipped += 1;
    }
  } catch (err) {
    console.error("[discord] deliver failed:", String((err && err.message) || err).slice(0, 200));
  }
  return summary;
}

/* ------------------------------ overdue sweep ------------------------------ */

/** Today's date in the business timezone (Asia/Karachi), YYYY-MM-DD. */
function businessToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi" }).format(new Date());
}

/** Anything not closed is actionable — matches the STATUSES list in handler.js. */
const CLOSED_STATUSES = new Set(["Completed", "Cancelled"]);

function parseDueDate(value) {
  const m = String(value || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : "";
}

/**
 * Daily cron sweep: one Discord ping per overdue task per assignee per due
 * date. The dedupe key includes the due date, so extending the deadline and
 * lapsing again notifies again — but the same overdue task never spams twice.
 */
async function runOverdueSweep(store, { origin } = {}) {
  const summary = { ok: true, checked: 0, sent: 0, alreadyNotified: 0, skipped: 0, failed: 0 };
  try {
    const cfg = await getConfig(store);
    if (!cfg.configured || !cfg.enabled || !cfg.notifications.overdue) return { ...summary, disabled: true };
    if (typeof store.discordLogSent !== "function") return { ...summary, ok: false, error: "delivery log unavailable" };

    const today = businessToday();
    const [workspace, users, boards] = await Promise.all([
      store.getState(), store.listUsers(), boardsWithDiscord(store),
    ]);
    const active = users.filter((u) => u.active && /^\d{5,25}$/.test(String(u.discordUserId || "")));
    if (!active.length) return { ...summary, note: "no users with Discord IDs" };

    for (const raw of workspace.tasks || []) {
      const due = parseDueDate(raw.dueDate);
      if (!due || due >= today) continue;
      if (CLOSED_STATUSES.has(raw.status)) continue;
      const task = enrichTask(raw, users, workspace.departments || []);
      for (const username of task.ownerUsernames || []) {
        const user = active.find((u) => u.username === username);
        if (!user) continue;
        summary.checked += 1;
        const eventKey = `overdue:${task.id}:${user.username}:${due}`;
        let already = false;
        try { already = await store.discordLogSent(eventKey); } catch (e) {
          return { ...summary, ok: false, error: "delivery log unavailable" };
        }
        if (already) { summary.alreadyNotified += 1; continue; }
        const result = await sendToUser(store, cfg, boards, {
          kind: "overdue", task, actor: null, user, origin, eventKey,
        });
        if (result.delivered) summary.sent += 1;
        else if (result.reason === "send-failed") summary.failed += 1;
        else summary.skipped += 1;
      }
    }
  } catch (err) {
    console.error("[discord] overdue sweep failed:", String((err && err.message) || err).slice(0, 200));
    return { ...summary, ok: false, error: "sweep failed" };
  }
  return summary;
}

module.exports = {
  INTEGRATION_ID,
  NOTIFICATION_TYPES,
  getConfig,
  publicConfig,
  saveSettings,
  boardsWithDiscord,
  testConnection,
  deliver,
  runOverdueSweep,
  buildMessage,   // exported for tests
  taskUrl,        // exported for tests
  parseDueDate,   // exported for tests
  channelForTask, // exported for tests
};
