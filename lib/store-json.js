/**
 * JSON-file storage driver (local development / zero-setup mode).
 * Reads and writes data/data.json through on every operation — the same
 * contract as the Supabase driver, so handler behavior is identical.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { defaultUsers, defaultChannels } = require("./bootstrap");
const {
  splitDepartmentRecords,
  departmentDecision,
  normalizeDepartment,
  userProfileDecision,
  parseUserProfileDecision,
} = require("./task-system");

const DATA_DIR = process.env.TASK_HUB_DATA_DIR || path.join(__dirname, "..", "data");
const DATA_FILE = process.env.TASK_HUB_DATA_FILE || path.join(DATA_DIR, "data.json");
const SEED_FILE = path.join(__dirname, "..", "data", "seed.json");

function load() {
  if (!fs.existsSync(DATA_FILE)) {
    const seed = JSON.parse(fs.readFileSync(SEED_FILE, "utf8"));
    seed.activity = [{
      ts: new Date().toISOString(),
      taskId: null,
      by: "system",
      text: "Workspace initialized from the NEONMONKI master task sheet.",
    }];
    for (const t of seed.tasks) t.updates = t.updates || [];
    seed.users = defaultUsers();
    seed.channels = defaultChannels().map((c) => ({
      ...c,
      members: (c.members || []).map((u) => ({ username: u, muted: false, lastReadTs: null })),
      createdAt: new Date().toISOString(),
    }));
    seed.messages = [];
    seed.notifications = [];
    seed.meta = { msgSeq: 0, notifSeq: 0, taskEventSeq: 0 };
    // Reporting + Smart Reporting collections (must exist from first boot)
    seed.metrics = [];
    seed.aiReports = [];
    seed.integrations = {};
    seed.hyrosSyncRuns = [];
    seed.reportingFacts = [];
    seed.reportingDaily = [];
    save(seed);
    return seed;
  }
  const db = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  db.activity = db.activity || [];
  for (const t of db.tasks) t.updates = t.updates || [];
  // tolerate older data files created before chat existed
  db.users = db.users && db.users.length ? db.users : defaultUsers();
  db.channels = db.channels && db.channels.length ? db.channels : defaultChannels().map((c) => ({
    ...c,
    members: (c.members || []).map((u) => ({ username: u, muted: false, lastReadTs: null })),
    createdAt: new Date().toISOString(),
  }));
  db.messages = db.messages || [];
  db.notifications = db.notifications || [];
  db.meta = db.meta || { msgSeq: 0, notifSeq: 0, taskEventSeq: 0 };
  db.meta.taskEventSeq = db.meta.taskEventSeq || 0;
  // AI layer
  db.aiSettings = db.aiSettings || null;
  db.aiUserPermissions = db.aiUserPermissions || {};
  db.aiAudit = db.aiAudit || [];
  db.aiSummaries = db.aiSummaries || [];
  db.aiActions = db.aiActions || [];
  // Reporting layer
  db.metrics = db.metrics || [];
  db.aiReports = db.aiReports || [];
  // Smart Reporting layer
  db.integrations = db.integrations || {};
  db.hyrosSyncRuns = db.hyrosSyncRuns || [];
  db.reportingFacts = db.reportingFacts || [];
  db.reportingDaily = db.reportingDaily || [];
  return db;
}

function save(db) {
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
  fs.renameSync(tmp, DATA_FILE);
}

function mutate(fn) {
  const db = load();
  const result = fn(db);
  save(db);
  return result;
}

const stripHash = (u) => {
  const { passwordHash, ...rest } = u;
  return rest;
};

/* ------------------------------ interface ------------------------------ */

async function getState() {
  const db = load();
  const { departments, decisions } = splitDepartmentRecords(db.decisions);
  return {
    tasks: db.tasks,
    deliverables: db.deliverables,
    decisions,
    departments,
    recurring: db.recurring,
    team: db.team,
    links: db.links,
    activity: db.activity.slice(0, 120),
  };
}

async function getTask(id) {
  return load().tasks.find((t) => t.id === id) || null;
}

async function insertTask(task) {
  return mutate((db) => {
    if (db.tasks.some((t) => t.id === task.id)) throw new Error(`duplicate id ${task.id}`);
    db.tasks.unshift(task);
    return task;
  });
}

async function updateTask(id, fields) {
  return mutate((db) => {
    const t = db.tasks.find((x) => x.id === id);
    if (!t) return null;
    Object.assign(t, fields);
    return t;
  });
}

async function deleteTask(id) {
  return mutate((db) => {
    const before = db.tasks.length;
    db.tasks = db.tasks.filter((task) => task.id !== id);
    db.links = db.links.filter((link) => link.taskId !== id);
    db.notifications = db.notifications.filter((item) => item.taskId !== id);
    db.activity = db.activity.filter((item) => item.taskId !== id);
    return db.tasks.length !== before;
  });
}

async function pushTaskUpdate(id, update) {
  return mutate((db) => {
    const t = db.tasks.find((x) => x.id === id);
    if (!t) return null;
    db.meta.taskEventSeq = (db.meta.taskEventSeq || 0) + 1;
    const full = { id: update.id || db.meta.taskEventSeq, ...update };
    t.updates.push(full);
    return full;
  });
}

async function insertRow(collection, item) {
  return mutate((db) => {
    if (item.id && db[collection].some((x) => x.id === item.id)) {
      throw new Error(`duplicate id ${item.id}`);
    }
    db[collection].unshift(item);
    return item;
  });
}

async function updateRow(collection, id, fields) {
  return mutate((db) => {
    const item = (db[collection] || []).find((x) => x.id === id);
    if (!item) return null;
    Object.assign(item, fields);
    return item;
  });
}

async function deleteRow(collection, id) {
  return mutate((db) => {
    if (!Array.isArray(db[collection])) return false;
    const before = db[collection].length;
    db[collection] = db[collection].filter((item) => String(item.id) !== String(id));
    return db[collection].length !== before;
  });
}

async function getLink(id) {
  return load().links.find((l) => l.id === id) || null;
}

async function updateLink(id, fields) {
  return mutate((db) => {
    const link = db.links.find((l) => l.id === id);
    if (!link) return null;
    Object.assign(link, fields);
    return link;
  });
}

async function putDepartment(input) {
  const department = normalizeDepartment(input);
  const record = departmentDecision(department);
  return mutate((db) => {
    const existing = db.decisions.find((d) => d.id === record.id);
    if (existing) Object.assign(existing, record);
    else db.decisions.unshift(record);
    return department;
  });
}

async function disableDepartment(id) {
  const current = (await getState()).departments.find((d) => d.id === id);
  return current ? putDepartment({ ...current, active: false }) : null;
}

async function logActivity(entry) {
  return mutate((db) => {
    db.activity.unshift(entry);
    if (db.activity.length > 500) db.activity.length = 500;
    return entry;
  });
}

async function maxIdSuffix(collection, prefix) {
  let max = 0;
  for (const item of load()[collection]) {
    const id = String(item.id || "");
    if (prefix && !id.startsWith(prefix + "-")) continue;
    const m = id.match(/(\d+)$/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

/* ------------------------------ users ------------------------------ */

async function getUserWithHash(username) {
  return load().users.find((u) => u.username === username) || null;
}

async function getUser(username) {
  const u = await getUserWithHash(username);
  return u ? stripHash(u) : null;
}

async function listUsers() {
  return load().users.map(stripHash);
}

async function createUser(user) {
  return mutate((db) => {
    if (db.users.some((u) => u.username === user.username)) {
      throw new Error(`duplicate user ${user.username}`);
    }
    db.users.push(user);
    return stripHash(user);
  });
}

async function updateUser(username, fields) {
  return mutate((db) => {
    const u = db.users.find((x) => x.username === username);
    if (!u) return null;
    Object.assign(u, fields);
    return stripHash(u);
  });
}

async function deleteUser(username) {
  return mutate((db) => {
    const before = db.users.length;
    db.users = db.users.filter((user) => user.username !== username);
    for (const channel of db.channels) {
      channel.members = (channel.members || []).filter((member) => member.username !== username);
    }
    db.notifications = db.notifications.filter((item) => item.username !== username);
    db.decisions = db.decisions.filter((item) => item.id !== `SYS-PROFILE-${username}`);
    delete db.aiUserPermissions[username];
    return db.users.length !== before;
  });
}

async function renameUser(username, next) {
  return mutate((db) => {
    const user = db.users.find((item) => item.username === username);
    if (!user) return null;
    if (db.users.some((item) => item.username === next.username && item.username !== username)) {
      throw new Error(`duplicate user ${next.username}`);
    }
    const old = username;
    Object.assign(user, next);
    for (const channel of db.channels) {
      for (const member of channel.members || []) {
        if (member.username === old) member.username = next.username;
      }
    }
    for (const item of db.notifications) if (item.username === old) item.username = next.username;
    for (const message of db.messages) if (message.authorId === old) message.authorId = next.username;
    if (db.aiUserPermissions[old]) {
      db.aiUserPermissions[next.username] = db.aiUserPermissions[old];
      delete db.aiUserPermissions[old];
    }
    const replaceExactJsonString = (value) => String(value || "").replaceAll(`\"${old}\"`, `\"${next.username}\"`);
    for (const task of db.tasks) {
      task.source = replaceExactJsonString(task.source);
      for (const update of task.updates || []) update.text = replaceExactJsonString(update.text);
    }
    const profile = db.decisions.find((row) => row.id === `SYS-PROFILE-${old}`);
    if (profile) Object.assign(profile, userProfileDecision({ ...parseUserProfileDecision(profile), username: next.username }));
    return stripHash(user);
  });
}

async function getUserProfile(username) {
  const row = load().decisions.find((item) => item.id === `SYS-PROFILE-${username}`);
  return row ? parseUserProfileDecision(row) : parseUserProfileDecision(userProfileDecision({ username }));
}

async function listUserProfiles() {
  return load().decisions.map(parseUserProfileDecision).filter(Boolean);
}

async function putUserProfile(username, fields) {
  const current = await getUserProfile(username);
  const record = userProfileDecision({ ...current, ...fields, username, updatedAt: new Date().toISOString() });
  return mutate((db) => {
    const row = db.decisions.find((item) => item.id === record.id);
    if (row) Object.assign(row, record);
    else db.decisions.push(record);
    return parseUserProfileDecision(record);
  });
}

/* ------------------------------ channels ------------------------------ */

async function listChannels() {
  return load().channels;
}

async function getChannel(id) {
  return load().channels.find((c) => c.id === id) || null;
}

async function createChannel(ch) {
  return mutate((db) => {
    if (db.channels.some((c) => c.id === ch.id)) throw new Error(`duplicate channel ${ch.id}`);
    db.channels.push(ch);
    return ch;
  });
}

async function updateChannel(id, fields) {
  return mutate((db) => {
    const c = db.channels.find((x) => x.id === id);
    if (!c) return null;
    Object.assign(c, fields);
    return c;
  });
}

async function deleteChannel(id) {
  return mutate((db) => {
    db.channels = db.channels.filter((c) => c.id !== id);
    db.messages = db.messages.filter((m) => m.channelId !== id);
    db.notifications = db.notifications.filter((n) => n.channelId !== id);
    return true;
  });
}

async function addMember(channelId, username) {
  return mutate((db) => {
    const c = db.channels.find((x) => x.id === channelId);
    if (!c) return null;
    if (!c.members.some((m) => m.username === username)) {
      c.members.push({ username, muted: false, lastReadTs: null });
    }
    return c;
  });
}

async function removeMember(channelId, username) {
  return mutate((db) => {
    const c = db.channels.find((x) => x.id === channelId);
    if (!c) return null;
    c.members = c.members.filter((m) => m.username !== username);
    return c;
  });
}

async function setMemberFlags(channelId, username, flags) {
  return mutate((db) => {
    const c = db.channels.find((x) => x.id === channelId);
    if (!c) return null;
    const m = c.members.find((x) => x.username === username);
    if (m) Object.assign(m, flags);
    else if (c.autoAll) c.members.push({ username, muted: false, lastReadTs: null, ...flags });
    else return null;
    return c;
  });
}

/* ------------------------------ messages ------------------------------ */

async function listMessages(channelId, beforeId, limit = 50) {
  let msgs = load().messages.filter((m) => m.channelId === channelId);
  if (beforeId) msgs = msgs.filter((m) => m.id < beforeId);
  return msgs.slice(-limit); // ascending order for display
}

async function postMessage(msg) {
  return mutate((db) => {
    db.meta.msgSeq = (db.meta.msgSeq || 0) + 1;
    const full = { id: db.meta.msgSeq, ts: new Date().toISOString(), ...msg };
    db.messages.push(full);
    if (db.messages.length > 5000) db.messages = db.messages.slice(-5000);
    return full;
  });
}

async function getMessage(id) {
  return load().messages.find((m) => Number(m.id) === Number(id)) || null;
}

async function updateMessage(id, fields) {
  return mutate((db) => {
    const message = db.messages.find((m) => Number(m.id) === Number(id));
    if (!message) return null;
    Object.assign(message, fields);
    return message;
  });
}

async function deleteMessage(id) {
  return mutate((db) => {
    const before = db.messages.length;
    db.messages = db.messages.filter((m) => Number(m.id) !== Number(id));
    return db.messages.length !== before;
  });
}

/* ------------------------------ notifications ------------------------------ */

async function notify(entry) {
  return mutate((db) => {
    db.meta.notifSeq = (db.meta.notifSeq || 0) + 1;
    const full = { id: db.meta.notifSeq, ts: new Date().toISOString(), read: false, ...entry };
    db.notifications.push(full);
    if (db.notifications.length > 2000) db.notifications = db.notifications.slice(-2000);
    return full;
  });
}

async function listNotifications(username, limit = 30) {
  return load()
    .notifications.filter((n) => n.username === username)
    .slice(-limit)
    .reverse();
}

async function markNotificationsRead(username) {
  return mutate((db) => {
    for (const n of db.notifications) {
      if (n.username === username) n.read = true;
    }
    return true;
  });
}

/* ------------------------------ AI layer ------------------------------ */

const AI_DEFAULT_SETTINGS = {
  enabled: false,
  model: "kimi-k2.6",
  features: { ask: true, chat: true, brief: true, summaries: true },
  allowClient: true,
  dailyLimit: 60,
  provider: {},
};

async function getAiSettings() {
  const s = load().aiSettings;
  return {
    ...AI_DEFAULT_SETTINGS,
    ...(s || {}),
    features: { ...AI_DEFAULT_SETTINGS.features, ...((s && s.features) || {}) },
    provider: { ...((s && s.provider) || {}) },
  };
}

async function putAiSettings(fields) {
  return mutate((db) => {
    const current = { ...AI_DEFAULT_SETTINGS, ...(db.aiSettings || {}) };
    db.aiSettings = {
      ...current,
      ...fields,
      features: { ...AI_DEFAULT_SETTINGS.features, ...(current.features || {}), ...(fields.features || {}) },
      provider: { ...(current.provider || {}), ...(fields.provider || {}) },
    };
    return db.aiSettings;
  });
}

const defaultAiUserPermission = (username) => ({
  username,
  enabled: true,
  tools: null,
  dailyLimit: null,
  updatedBy: "",
  updatedAt: null,
});

async function getAiUserPermission(username) {
  const p = load().aiUserPermissions[username];
  return { ...defaultAiUserPermission(username), ...(p || {}) };
}

async function listAiUserPermissions() {
  return Object.values(load().aiUserPermissions);
}

async function putAiUserPermission(username, fields) {
  return mutate((db) => {
    const current = db.aiUserPermissions[username] || defaultAiUserPermission(username);
    const next = {
      ...current,
      ...fields,
      username,
      updatedAt: new Date().toISOString(),
    };
    db.aiUserPermissions[username] = next;
    return next;
  });
}

async function aiLog(entry) {
  return mutate((db) => {
    db.meta.aiSeq = (db.meta.aiSeq || 0) + 1;
    const full = { id: db.meta.aiSeq, ts: new Date().toISOString(), ...entry };
    db.aiAudit.unshift(full);
    if (db.aiAudit.length > 2000) db.aiAudit.length = 2000;
    return full;
  });
}

async function aiAuditList(limit = 100) {
  return load().aiAudit.slice(0, limit);
}

async function aiCallsToday(username) {
  const day = new Date().toISOString().slice(0, 10);
  return load().aiAudit.filter(
    (e) => e.username === username && e.kind !== "test" && String(e.ts).slice(0, 10) === day
  ).length;
}

async function aiSummaryInsert(entry) {
  return mutate((db) => {
    db.meta.sumSeq = (db.meta.sumSeq || 0) + 1;
    const full = { id: db.meta.sumSeq, ts: new Date().toISOString(), ...entry };
    db.aiSummaries.unshift(full);
    if (db.aiSummaries.length > 1000) db.aiSummaries.length = 1000;
    return full;
  });
}

async function aiSummaryLatest(scopeType, scopeId) {
  return load().aiSummaries.find((s) => s.scopeType === scopeType && s.scopeId === scopeId) || null;
}

/* ------------------------------ AI action requests (approval trail) ------------------------------ */

async function aiActionInsert(entry) {
  return mutate((db) => {
    db.meta.actSeq = (db.meta.actSeq || 0) + 1;
    const full = {
      id: db.meta.actSeq,
      ts: new Date().toISOString(),
      status: "pending",
      agentId: "",
      note: "",
      ...entry,
    };
    db.aiActions.unshift(full);
    if (db.aiActions.length > 500) db.aiActions.length = 500;
    return full;
  });
}

async function aiActionList(limit = 100) {
  return load().aiActions.slice(0, limit);
}

async function aiActionGet(id) {
  return load().aiActions.find((a) => Number(a.id) === Number(id)) || null;
}

async function aiActionUpdate(id, fields) {
  return mutate((db) => {
    const action = db.aiActions.find((a) => Number(a.id) === Number(id));
    if (!action) return null;
    Object.assign(action, fields, { updatedAt: new Date().toISOString() });
    return action;
  });
}

/* ------------------------------ reporting layer ------------------------------ */

const rowToMetricEntry = (r) => ({
  id: r.id, date: r.date || "", channel: r.channel || "", metric: r.metric || "",
  value: Number(r.value) || 0, note: r.note || "", createdBy: r.createdBy || "", ts: r.ts,
});

async function metricsList(from, to) {
  return load()
    .metrics.filter((e) => (!from || e.date >= from) && (!to || e.date <= to))
    .map(rowToMetricEntry)
    .sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
}

async function metricInsert(entry) {
  return mutate((db) => {
    db.meta.metricSeq = (db.meta.metricSeq || 0) + 1;
    const full = { id: db.meta.metricSeq, ts: new Date().toISOString(), ...entry };
    db.metrics.push(full);
    if (db.metrics.length > 10000) db.metrics = db.metrics.slice(-10000);
    return rowToMetricEntry(full);
  });
}

async function metricDelete(id) {
  return mutate((db) => {
    const before = db.metrics.length;
    db.metrics = db.metrics.filter((e) => Number(e.id) !== Number(id));
    return db.metrics.length !== before;
  });
}

const rowToAiReport = (r) => ({
  id: r.id, ts: r.ts, audience: r.audience || "team",
  periodFrom: r.periodFrom || "", periodTo: r.periodTo || "",
  text: r.text || "", citations: Array.isArray(r.citations) ? r.citations : [],
  createdBy: r.createdBy || "",
});

async function aiReportInsert(entry) {
  return mutate((db) => {
    db.meta.reportSeq = (db.meta.reportSeq || 0) + 1;
    const full = { id: db.meta.reportSeq, ts: new Date().toISOString(), ...entry };
    db.aiReports.unshift(full);
    if (db.aiReports.length > 500) db.aiReports.length = 500;
    return rowToAiReport(full);
  });
}

async function aiReportLatest(audience) {
  const row = load().aiReports.find((r) => (r.audience || "team") === audience);
  return row ? rowToAiReport(row) : null;
}

/* --------------------------- smart reporting layer --------------------------- */

// Integrations are stored in the app shape (camelCase). The credential fields
// (apiKeyEncrypted, webhookTokenHash) are write-only: they are accepted by
// putIntegration but never returned by getIntegration/listIntegrations — only
// getIntegrationSecret exposes them, and it is for server-side sync code only.

const sanitizeIntegration = (row) => ({
  id: row.id,
  name: row.name || "",
  status: row.status || "disconnected",
  accountName: row.accountName || "",
  hasApiKey: !!row.apiKeyEncrypted,
  hasWebhookToken: !!row.webhookTokenHash,
  lastSyncAt: row.lastSyncAt || null,
  lastWebhookAt: row.lastWebhookAt || null,
  lastError: row.lastError || "",
  historicalDays: Number(row.historicalDays) || 90,
  backfill: row.backfill || {},
  createdAt: row.createdAt || null,
  updatedAt: row.updatedAt || null,
});

const INTEGRATION_FIELDS = [
  "name", "status", "accountName", "lastSyncAt", "lastWebhookAt", "lastError",
  "historicalDays", "apiKeyEncrypted", "webhookTokenHash",
  "backfill", "connectedBy", "connectedAt", "disconnectedBy", "disconnectedAt",
];

async function getIntegration(id) {
  const row = load().integrations[id];
  return row ? sanitizeIntegration(row) : null;
}

async function listIntegrations() {
  return Object.values(load().integrations)
    .map(sanitizeIntegration)
    .sort((a, b) => a.id.localeCompare(b.id));
}

async function getIntegrationSecret(id) {
  const row = load().integrations[id];
  return row
    ? { id: row.id, apiKeyEncrypted: row.apiKeyEncrypted || "", webhookTokenHash: row.webhookTokenHash || "" }
    : null;
}

async function putIntegration(id, fields) {
  return mutate((db) => {
    const now = new Date().toISOString();
    const current = db.integrations[id] || {
      id, name: "", status: "disconnected", accountName: "",
      apiKeyEncrypted: "", webhookTokenHash: "",
      lastSyncAt: null, lastWebhookAt: null, lastError: "",
      historicalDays: 90, createdAt: now,
    };
    const next = { ...current, updatedAt: now };
    for (const field of INTEGRATION_FIELDS) {
      if (field in fields) next[field] = fields[field];
    }
    db.integrations[id] = next;
    return sanitizeIntegration(next);
  });
}

async function clearIntegrationSecret(id) {
  return mutate((db) => {
    const row = db.integrations[id];
    if (!row) return null;
    row.apiKeyEncrypted = "";
    row.webhookTokenHash = "";
    row.updatedAt = new Date().toISOString();
    return sanitizeIntegration(row);
  });
}

const rowToSyncRun = (r) => ({
  id: r.id, integrationId: r.integrationId || "", kind: r.kind || "",
  rangeFrom: r.rangeFrom || null, rangeTo: r.rangeTo || null,
  status: r.status || "running", recordsIn: Number(r.recordsIn) || 0,
  error: r.error || "", startedAt: r.startedAt || null, finishedAt: r.finishedAt || null,
});

async function syncRunInsert(entry) {
  return mutate((db) => {
    db.meta.syncRunSeq = (db.meta.syncRunSeq || 0) + 1;
    const full = {
      id: db.meta.syncRunSeq,
      integrationId: entry.integrationId || "hyros",
      kind: entry.kind || "incremental",
      rangeFrom: entry.rangeFrom || null,
      rangeTo: entry.rangeTo || null,
      status: entry.status || "running",
      recordsIn: Number(entry.recordsIn) || 0,
      error: entry.error || "",
      startedAt: entry.startedAt || new Date().toISOString(),
      finishedAt: entry.finishedAt || null,
    };
    db.hyrosSyncRuns.unshift(full);
    if (db.hyrosSyncRuns.length > 500) db.hyrosSyncRuns.length = 500;
    return rowToSyncRun(full);
  });
}

async function syncRunUpdate(id, fields) {
  return mutate((db) => {
    const run = db.hyrosSyncRuns.find((r) => Number(r.id) === Number(id));
    if (!run) return null;
    for (const field of ["status", "recordsIn", "error", "finishedAt", "rangeFrom", "rangeTo"]) {
      if (field in fields) run[field] = fields[field];
    }
    return rowToSyncRun(run);
  });
}

async function syncRunLatest(integrationId) {
  const run = load().hyrosSyncRuns.find((r) => r.integrationId === integrationId);
  return run ? rowToSyncRun(run) : null;
}

async function syncRunList(integrationId, limit = 20) {
  return load()
    .hyrosSyncRuns.filter((r) => !integrationId || r.integrationId === integrationId)
    .slice(0, limit)
    .map(rowToSyncRun);
}

const rowToFact = (r, withRaw) => ({
  id: r.id,
  sourceSystem: r.sourceSystem || "", integrationId: r.integrationId || "",
  externalId: r.externalId || "", eventType: r.eventType || "",
  eventAt: r.eventAt || null,
  channel: r.channel || "", platform: r.platform || "", sourceName: r.sourceName || "",
  campaign: r.campaign || "", adAccount: r.adAccount || "", goal: r.goal || "",
  tags: r.tags || "",
  isOrganic: r.isOrganic == null ? null : r.isOrganic === true,
  isQualified: r.isQualified == null ? null : r.isQualified === true,
  value: r.value == null ? null : Number(r.value),
  currency: r.currency || "", leadId: r.leadId || "", saleId: r.saleId || "",
  createdAt: r.createdAt || null, updatedAt: r.updatedAt || null,
  ...(withRaw ? { raw: r.raw || {} } : {}),
});

const factKey = (f) => JSON.stringify([f.sourceSystem, f.eventType, f.externalId]);

/**
 * Idempotent ingest: a row whose (sourceSystem, eventType, externalId) already
 * exists — in storage or earlier in the same batch — is skipped, never updated.
 * Returns { inserted, skipped, invalid } (invalid = missing required fields).
 * To refresh mutated source records (e.g. refunds), reportingFactsDelete the
 * integration's facts and re-run the backfill.
 */
async function reportingFactsUpsert(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return mutate((db) => {
    const seen = new Set(db.reportingFacts.map(factKey));
    let inserted = 0, skipped = 0, invalid = 0;
    for (const row of list) {
      if (!row || !row.sourceSystem || !row.eventType || !row.externalId || !row.eventAt) {
        invalid++;
        continue;
      }
      const key = factKey(row);
      if (seen.has(key)) { skipped++; continue; }
      seen.add(key);
      db.meta.factSeq = (db.meta.factSeq || 0) + 1;
      const now = new Date().toISOString();
      db.reportingFacts.push({
        id: db.meta.factSeq,
        sourceSystem: String(row.sourceSystem), integrationId: row.integrationId || "",
        externalId: String(row.externalId), eventType: String(row.eventType),
        eventAt: row.eventAt,
        channel: row.channel || "", platform: row.platform || "",
        sourceName: row.sourceName || "", campaign: row.campaign || "",
        adAccount: row.adAccount || "", goal: row.goal || "", tags: row.tags || "",
        isOrganic: row.isOrganic == null ? null : !!row.isOrganic,
        isQualified: row.isQualified == null ? null : !!row.isQualified,
        value: row.value == null ? null : Number(row.value),
        currency: row.currency || "", leadId: row.leadId || "", saleId: row.saleId || "",
        raw: row.raw && typeof row.raw === "object" ? row.raw : {},
        createdAt: now, updatedAt: now,
      });
      inserted++;
    }
    return { inserted, skipped, invalid };
  });
}

async function reportingFactsList(query = {}) {
  const {
    from, to, sourceSystem, integrationId, eventType,
    channel, platform, source, campaign,
    order = "asc", limit = 20000, withRaw = false,
  } = query || {};
  let rows = load().reportingFacts.filter((f) => {
    const day = String(f.eventAt || "").slice(0, 10);
    return (!from || day >= from) && (!to || day <= to)
      && (!sourceSystem || f.sourceSystem === sourceSystem)
      && (!integrationId || f.integrationId === integrationId)
      && (!eventType || f.eventType === eventType)
      && (!channel || f.channel === channel)
      && (!platform || f.platform === platform)
      && (!source || f.sourceName === source)
      && (!campaign || f.campaign === campaign);
  });
  rows = rows.sort((a, b) => String(a.eventAt).localeCompare(String(b.eventAt)) || a.id - b.id);
  if (order === "desc") rows = rows.reverse();
  return rows.slice(0, limit).map((r) => rowToFact(r, withRaw));
}

async function reportingFactsDelete({ integrationId, sourceSystem } = {}) {
  if (!integrationId) throw new Error("reportingFactsDelete: integrationId is required");
  return mutate((db) => {
    const before = db.reportingFacts.length;
    db.reportingFacts = db.reportingFacts.filter(
      (f) => !(f.integrationId === integrationId && (!sourceSystem || f.sourceSystem === sourceSystem))
    );
    return before - db.reportingFacts.length;
  });
}

async function reportingFactsCount() {
  return load().reportingFacts.length;
}

/** Stamp the user's current visit; returns the previous stamp (or null). */
async function touchLastSeen(username) {
  return mutate((db) => {
    const u = db.users.find((x) => x.username === username);
    if (!u) return null;
    const previous = u.lastSeenAt || null;
    u.lastSeenAt = new Date().toISOString();
    return previous;
  });
}

module.exports = {
  getState, getTask, insertTask, updateTask, deleteTask, pushTaskUpdate,
  insertRow, updateRow, deleteRow, getLink, updateLink, putDepartment, disableDepartment,
  logActivity, maxIdSuffix,
  getUserWithHash, getUser, listUsers, createUser, updateUser, deleteUser, renameUser,
  getUserProfile, listUserProfiles, putUserProfile,
  listChannels, getChannel, createChannel, updateChannel, deleteChannel,
  addMember, removeMember, setMemberFlags,
  listMessages, postMessage, getMessage, updateMessage, deleteMessage,
  notify, listNotifications, markNotificationsRead,
  getAiSettings, putAiSettings,
  getAiUserPermission, listAiUserPermissions, putAiUserPermission,
  aiLog, aiAuditList, aiCallsToday,
  aiSummaryInsert, aiSummaryLatest,
  aiActionInsert, aiActionList, aiActionGet, aiActionUpdate,
  metricsList, metricInsert, metricDelete,
  aiReportInsert, aiReportLatest, touchLastSeen,
  getIntegration, listIntegrations, getIntegrationSecret, putIntegration, clearIntegrationSecret,
  syncRunInsert, syncRunUpdate, syncRunLatest, syncRunList,
  reportingFactsUpsert, reportingFactsList, reportingFactsDelete, reportingFactsCount,
};
