/**
 * JSON-file storage driver (local development / zero-setup mode).
 * Reads and writes data/data.json through on every operation — the same
 * contract as the Supabase driver, so handler behavior is identical.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { defaultUsers, defaultChannels } = require("./bootstrap");

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
    seed.meta = { msgSeq: 0, notifSeq: 0 };
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
  db.meta = db.meta || { msgSeq: 0, notifSeq: 0 };
  // AI layer
  db.aiSettings = db.aiSettings || null;
  db.aiUserPermissions = db.aiUserPermissions || {};
  db.aiAudit = db.aiAudit || [];
  db.aiSummaries = db.aiSummaries || [];
  db.aiActions = db.aiActions || [];
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
  return {
    tasks: db.tasks,
    deliverables: db.deliverables,
    decisions: db.decisions,
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

async function pushTaskUpdate(id, update) {
  return mutate((db) => {
    const t = db.tasks.find((x) => x.id === id);
    if (!t) return null;
    t.updates.push(update);
    return t;
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

module.exports = {
  getState, getTask, insertTask, updateTask, pushTaskUpdate,
  insertRow, logActivity, maxIdSuffix,
  getUserWithHash, getUser, listUsers, createUser, updateUser,
  listChannels, getChannel, createChannel, updateChannel, deleteChannel,
  addMember, removeMember, setMemberFlags,
  listMessages, postMessage,
  notify, listNotifications, markNotificationsRead,
  getAiSettings, putAiSettings,
  getAiUserPermission, listAiUserPermissions, putAiUserPermission,
  aiLog, aiAuditList, aiCallsToday,
  aiSummaryInsert, aiSummaryLatest,
  aiActionInsert, aiActionList, aiActionGet, aiActionUpdate,
};
