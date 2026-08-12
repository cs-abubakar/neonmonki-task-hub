/**
 * Supabase (PostgREST) storage driver — zero-dependency, uses global fetch.
 *
 * Talks to the project's REST API with the service role key, which lives
 * ONLY in server-side env vars (never shipped to the browser).
 *
 * Env required: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */
"use strict";

const { defaultUsers, defaultChannels } = require("./bootstrap");

const BASE = () => `${process.env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1`;
const KEY = () => process.env.SUPABASE_SERVICE_ROLE_KEY;

function headers(extra = {}) {
  return {
    apikey: KEY(),
    Authorization: `Bearer ${KEY()}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function req(method, table, { query = "", body, prefer } = {}) {
  const res = await fetch(`${BASE()}/${table}${query ? "?" + query : ""}`, {
    method,
    headers: headers(prefer ? { Prefer: prefer } : {}),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Supabase ${method} ${table} failed (${res.status}): ${text.slice(0, 300)}`);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const select = (table, query) => req("GET", table, { query });
const insert = (table, row) =>
  req("POST", table, { body: row, prefer: "return=representation" }).then((r) => r[0]);
const update = (table, matchQuery, fields) =>
  req("PATCH", table, { query: matchQuery, body: fields, prefer: "return=representation" })
    .then((r) => (r && r.length ? r[0] : null));
const remove = (table, matchQuery) => req("DELETE", table, { query: matchQuery });

/* ------------------------------ row mapping ------------------------------ */

// PATCH bodies must contain ONLY the fields being changed — PostgREST writes
// every key it receives, and defaults/nulls would wipe untouched columns.
const TASK_FIELD_MAP = {
  title: "title", department: "department", project: "project", description: "description",
  owner: "owner", supporting: "supporting", blocker: "blocker", deliverable: "deliverable",
  deliverableLink: "deliverable_link", nextAction: "next_action", dueDate: "due_date",
  update: "latest_update", priority: "priority", status: "status", evidence: "evidence",
  requestedBy: "requested_by", dateRequested: "date_requested", source: "source",
  visibility: "visibility", privateFor: "private_for", assignedDept: "assigned_department",
};

function fieldsToRow(fields) {
  const row = {};
  for (const [jsKey, col] of Object.entries(TASK_FIELD_MAP)) {
    if (jsKey in fields) {
      let v = fields[jsKey];
      // date-ish columns get null instead of "" (date_requested is a real date
      // column that rejects empty strings; keep due_date clean too)
      if ((col === "date_requested" || col === "due_date") && v === "") v = null;
      row[col] = v;
    }
  }
  return row;
}

function rowToTask(r) {
  return {
    id: r.id,
    title: r.title,
    dateRequested: r.date_requested || "",
    department: r.department || "",
    project: r.project || "",
    description: r.description || "",
    requestedBy: r.requested_by || "",
    owner: r.owner || "",
    supporting: r.supporting || "",
    priority: r.priority || "Medium",
    status: r.status || "Planned",
    evidence: r.evidence || "",
    update: r.latest_update || "",
    blocker: r.blocker || "",
    deliverable: r.deliverable || "",
    deliverableLink: r.deliverable_link || "",
    nextAction: r.next_action || "",
    dueDate: r.due_date || "",
    source: r.source || "",
    visibility: r.visibility || "shared",
    privateFor: r.private_for || "",
    assignedDept: r.assigned_department || "",
    updates: [],
  };
}

function taskToRow(t) {
  const row = fieldsToRow(t);
  row.id = t.id;
  return row;
}

const rowToUpdate = (r) => ({
  ts: r.ts,
  by: r.author || "",
  text: r.text || "",
  ...(r.status_from ? { statusFrom: r.status_from } : {}),
  ...(r.status_to ? { statusTo: r.status_to } : {}),
});

const rowToLink = (r) => ({
  id: r.id, taskId: r.task_id || "", channelId: r.channel_id || "",
  date: r.date || "", workstream: r.workstream || "", title: r.title,
  url: r.url || "", type: r.type || "", owner: r.owner || "", note: r.note || "",
});

const rowToUser = (r) => ({
  username: r.username, name: r.name, role: r.role, org: r.org || "", active: r.active !== false,
  departments: Array.isArray(r.departments) ? r.departments : [],
});

const rowToMember = (r) => ({
  username: r.username, muted: r.muted === true, lastReadTs: r.last_read_ts || null,
});

const rowToChannel = (r, members) => ({
  id: r.id, name: r.name, description: r.description || "", department: r.department || "",
  clientAllowed: r.client_allowed === true, autoAll: r.auto_all === true,
  createdBy: r.created_by || "", members: members || [],
});

const rowToMessage = (r) => ({
  id: r.id, channelId: r.channel_id, author: r.author || "", authorId: r.author_id || "",
  text: r.text || "", linkUrl: r.link_url || "", linkTitle: r.link_title || "",
  taskId: r.task_id || "", ts: r.ts,
});

const rowToNotif = (r) => ({
  id: r.id, username: r.username, kind: r.kind || "", text: r.text || "",
  channelId: r.channel_id || "", taskId: r.task_id || "",
  read: r.read === true, ts: r.ts,
});

/* ------------------------------ bootstrap ------------------------------ */

let seeded = false;
async function ensureSeeded() {
  if (seeded) return;
  seeded = true;
  try {
    const users = await select("users", "select=username&limit=1");
    if (users.length) return;
  } catch {
    return; // tables not created yet — surface the real error on the actual call
  }
  // empty workspace → insert default users + channels + memberships
  for (const u of defaultUsers()) {
    await req("POST", "users", {
      body: {
        username: u.username, name: u.name, role: u.role, org: u.org,
        active: true, password_hash: u.passwordHash,
      },
      prefer: "resolution=merge-duplicates,return=minimal",
    });
  }
  for (const c of defaultChannels()) {
    await req("POST", "channels", {
      body: {
        id: c.id, name: c.name, description: c.description, department: c.department,
        client_allowed: c.clientAllowed, auto_all: c.autoAll, created_by: "system",
      },
      prefer: "resolution=merge-duplicates,return=minimal",
    });
    for (const username of c.members || []) {
      await req("POST", "channel_members", {
        body: { channel_id: c.id, username, muted: false },
        prefer: "resolution=merge-duplicates,return=minimal",
      });
    }
  }
}

/* ------------------------------ tasks interface ------------------------------ */

async function getState() {
  await ensureSeeded();
  const [tasks, updates, deliverables, decisions, recurring, team, links, activity] =
    await Promise.all([
      select("tasks", "select=*&order=created_at.desc,id.asc"),
      select("task_updates", "select=*&order=ts.asc,id.asc"),
      select("deliverables", "select=*&order=id.asc"),
      select("decisions", "select=*&order=id.asc"),
      select("recurring", "select=*"),
      select("team", "select=*&order=id.asc"),
      select("links", "select=*&order=id.asc"),
      select("activity", "select=*&order=ts.desc,id.desc&limit=120"),
    ]);

  const byTask = {};
  for (const u of updates) {
    (byTask[u.task_id] = byTask[u.task_id] || []).push(rowToUpdate(u));
  }
  const taskList = tasks.map(rowToTask);
  for (const t of taskList) t.updates = byTask[t.id] || [];

  return {
    tasks: taskList,
    deliverables,
    decisions,
    recurring,
    team,
    links: links.map(rowToLink),
    activity: activity.map((a) => ({ ts: a.ts, taskId: a.task_id, by: a.author, text: a.text })),
  };
}

async function getTask(id) {
  await ensureSeeded();
  const rows = await select("tasks", `select=*&id=eq.${encodeURIComponent(id)}`);
  if (!rows.length) return null;
  const t = rowToTask(rows[0]);
  const ups = await select(
    "task_updates",
    `select=*&task_id=eq.${encodeURIComponent(id)}&order=ts.asc,id.asc`
  );
  t.updates = ups.map(rowToUpdate);
  return t;
}

async function insertTask(task) {
  const row = await insert("tasks", taskToRow(task));
  const t = rowToTask(row);
  for (const u of task.updates || []) {
    await pushTaskUpdate(task.id, u);
    t.updates.push(u);
  }
  return t;
}

async function updateTask(id, fields) {
  const row = await update("tasks", `id=eq.${encodeURIComponent(id)}`, fieldsToRow(fields));
  if (!row) return null;
  return getTask(id);
}

async function pushTaskUpdate(id, update) {
  await insert("task_updates", {
    task_id: id,
    ts: update.ts || new Date().toISOString(),
    author: update.by || "",
    text: update.text || "",
    status_from: update.statusFrom || null,
    status_to: update.statusTo || null,
  });
  return true;
}

async function insertRow(collection, item) {
  const map = {
    deliverables: (i) => ({
      id: i.id, date: i.date || null, title: i.title, workstream: i.workstream || "",
      owner: i.owner || "", recipient: i.recipient || "", status: i.status || "", link: i.link || "",
    }),
    decisions: (i) => ({
      id: i.id, date: i.date || null, topic: i.topic || "", rule: i.rule,
      workstream: i.workstream || "", owner: i.owner || "",
    }),
    links: (i) => ({
      id: i.id, task_id: i.taskId || "", channel_id: i.channelId || "",
      date: i.date || null, workstream: i.workstream || "",
      title: i.title, url: i.url || "", type: i.type || "", owner: i.owner || "", note: i.note || "",
    }),
  };
  if (!map[collection]) throw new Error(`insertRow: unknown collection ${collection}`);
  return insert(collection, map[collection](item));
}

async function logActivity(entry) {
  await insert("activity", {
    ts: entry.ts || new Date().toISOString(),
    task_id: entry.taskId || null,
    author: entry.by || "",
    text: entry.text || "",
  });
  return entry;
}

async function maxIdSuffix(collection, prefix) {
  const rows = await select(
    collection,
    `select=id&id=like.${encodeURIComponent(prefix + "-")}*`
  );
  let max = 0;
  for (const r of rows) {
    const m = String(r.id).match(/(\d+)$/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

/* ------------------------------ users ------------------------------ */

async function getUserWithHash(username) {
  await ensureSeeded();
  const rows = await select("users", `select=*&username=eq.${encodeURIComponent(username)}`);
  if (!rows.length) return null;
  const r = rows[0];
  return { ...rowToUser(r), passwordHash: r.password_hash };
}

async function getUser(username) {
  const u = await getUserWithHash(username);
  if (!u) return null;
  const { passwordHash, ...rest } = u;
  return rest;
}

async function listUsers() {
  await ensureSeeded();
  const rows = await select("users", "select=*&order=username.asc");
  return rows.map(rowToUser);
}

async function createUser(user) {
  const r = await insert("users", {
    username: user.username, name: user.name, role: user.role, org: user.org || "",
    active: user.active !== false, password_hash: user.passwordHash,
    departments: user.departments || [],
  });
  return rowToUser(r);
}

async function updateUser(username, fields) {
  const row = {};
  if ("name" in fields) row.name = fields.name;
  if ("role" in fields) row.role = fields.role;
  if ("org" in fields) row.org = fields.org;
  if ("active" in fields) row.active = fields.active;
  if ("departments" in fields) row.departments = fields.departments;
  if ("passwordHash" in fields) row.password_hash = fields.passwordHash;
  const r = await update("users", `username=eq.${encodeURIComponent(username)}`, row);
  return r ? rowToUser(r) : null;
}

/* ------------------------------ channels ------------------------------ */

async function listChannels() {
  await ensureSeeded();
  const [channels, members] = await Promise.all([
    select("channels", "select=*&order=id.asc"),
    select("channel_members", "select=*"),
  ]);
  const byChannel = {};
  for (const m of members) {
    (byChannel[m.channel_id] = byChannel[m.channel_id] || []).push(rowToMember(m));
  }
  return channels.map((c) => rowToChannel(c, byChannel[c.id] || []));
}

async function getChannel(id) {
  await ensureSeeded();
  const rows = await select("channels", `select=*&id=eq.${encodeURIComponent(id)}`);
  if (!rows.length) return null;
  const members = await select(
    "channel_members",
    `select=*&channel_id=eq.${encodeURIComponent(id)}`
  );
  return rowToChannel(rows[0], members.map(rowToMember));
}

async function createChannel(ch) {
  const r = await insert("channels", {
    id: ch.id, name: ch.name, description: ch.description || "",
    department: ch.department || "", client_allowed: !!ch.clientAllowed,
    auto_all: !!ch.autoAll, created_by: ch.createdBy || "",
  });
  for (const m of ch.members || []) {
    await insert("channel_members", { channel_id: ch.id, username: m.username, muted: !!m.muted });
  }
  return rowToChannel(r, ch.members || []);
}

async function updateChannel(id, fields) {
  const row = {};
  if ("name" in fields) row.name = fields.name;
  if ("description" in fields) row.description = fields.description;
  if ("department" in fields) row.department = fields.department;
  if ("clientAllowed" in fields) row.client_allowed = fields.clientAllowed;
  const r = await update("channels", `id=eq.${encodeURIComponent(id)}`, row);
  return r ? getChannel(id) : null;
}

async function deleteChannel(id) {
  await remove("messages", `channel_id=eq.${encodeURIComponent(id)}`);
  await remove("channel_members", `channel_id=eq.${encodeURIComponent(id)}`);
  await remove("notifications", `channel_id=eq.${encodeURIComponent(id)}`);
  await remove("channels", `id=eq.${encodeURIComponent(id)}`);
  return true;
}

async function addMember(channelId, username) {
  await req("POST", "channel_members", {
    body: { channel_id: channelId, username, muted: false },
    prefer: "resolution=merge-duplicates,return=minimal",
  });
  return getChannel(channelId);
}

async function removeMember(channelId, username) {
  await remove(
    "channel_members",
    `channel_id=eq.${encodeURIComponent(channelId)}&username=eq.${encodeURIComponent(username)}`
  );
  return getChannel(channelId);
}

async function setMemberFlags(channelId, username, flags) {
  // upsert: auto-all channel members may not have a row yet
  const row = { channel_id: channelId, username };
  if ("muted" in flags) row.muted = flags.muted;
  if ("lastReadTs" in flags) row.last_read_ts = flags.lastReadTs;
  await req("POST", "channel_members", {
    body: row,
    prefer: "resolution=merge-duplicates,return=minimal",
  });
  return getChannel(channelId);
}

/* ------------------------------ messages ------------------------------ */

async function listMessages(channelId, beforeId, limit = 50) {
  let q = `select=*&channel_id=eq.${encodeURIComponent(channelId)}&order=id.desc&limit=${limit}`;
  if (beforeId) q += `&id=lt.${Number(beforeId) || 0}`;
  const rows = await select("messages", q);
  return rows.map(rowToMessage).reverse(); // ascending for display
}

async function postMessage(msg) {
  const r = await insert("messages", {
    channel_id: msg.channelId, author: msg.author || "", author_id: msg.authorId || "",
    text: msg.text || "", link_url: msg.linkUrl || "", link_title: msg.linkTitle || "",
    task_id: msg.taskId || "",
  });
  return rowToMessage(r);
}

/* ------------------------------ notifications ------------------------------ */

async function notify(entry) {
  const r = await insert("notifications", {
    username: entry.username, kind: entry.kind || "", text: entry.text || "",
    channel_id: entry.channelId || "", task_id: entry.taskId || "", read: false,
  });
  return rowToNotif(r);
}

async function listNotifications(username, limit = 30) {
  const rows = await select(
    "notifications",
    `select=*&username=eq.${encodeURIComponent(username)}&order=id.desc&limit=${limit}`
  );
  return rows.map(rowToNotif);
}

async function markNotificationsRead(username) {
  await update("notifications", `username=eq.${encodeURIComponent(username)}&read=eq.false`, { read: true });
  return true;
}

/* ------------------------------ AI layer ------------------------------ */

const AI_DEFAULT_SETTINGS = {
  enabled: false,
  model: "kimi-k2.6",
  features: { ask: true, chat: true, brief: true, summaries: true },
  allowClient: true,
  dailyLimit: 60,
};

async function getAiSettings() {
  await ensureSeeded();
  try {
    const rows = await select("ai_settings", "select=*&id=eq.1");
    if (!rows.length) return { ...AI_DEFAULT_SETTINGS };
    const r = rows[0];
    return {
      enabled: r.enabled === true,
      model: r.model || AI_DEFAULT_SETTINGS.model,
      features: { ...AI_DEFAULT_SETTINGS.features, ...(r.features || {}) },
      allowClient: r.allow_client !== false,
      dailyLimit: r.daily_limit || AI_DEFAULT_SETTINGS.dailyLimit,
    };
  } catch {
    return { ...AI_DEFAULT_SETTINGS }; // table not migrated yet
  }
}

async function putAiSettings(fields) {
  const row = { id: 1, updated_at: new Date().toISOString() };
  if ("enabled" in fields) row.enabled = !!fields.enabled;
  if ("model" in fields) row.model = String(fields.model || AI_DEFAULT_SETTINGS.model).slice(0, 80);
  if ("features" in fields) row.features = fields.features;
  if ("allowClient" in fields) row.allow_client = !!fields.allowClient;
  if ("dailyLimit" in fields) row.daily_limit = Math.max(1, Math.min(1000, Number(fields.dailyLimit) || 60));
  if ("updatedBy" in fields) row.updated_by = fields.updatedBy;
  await req("POST", "ai_settings", {
    body: row,
    prefer: "resolution=merge-duplicates,return=minimal",
  });
  return getAiSettings();
}

async function aiLog(entry) {
  const r = await insert("ai_audit", {
    username: entry.username || "", kind: entry.kind || "ask",
    question: (entry.question || "").slice(0, 500),
    tools: entry.tools || [], citations: entry.citations || [],
    model: entry.model || "", prompt_tokens: entry.promptTokens || 0,
    completion_tokens: entry.completionTokens || 0, latency_ms: entry.latencyMs || 0,
    status: entry.status || "ok", error: (entry.error || "").slice(0, 300),
  });
  return r;
}

async function aiAuditList(limit = 100) {
  const rows = await select("ai_audit", `select=*&order=id.desc&limit=${limit}`);
  return rows.map((r) => ({
    id: r.id, ts: r.ts, username: r.username, kind: r.kind, question: r.question,
    tools: r.tools, citations: r.citations, model: r.model,
    promptTokens: r.prompt_tokens, completionTokens: r.completion_tokens,
    latencyMs: r.latency_ms, status: r.status, error: r.error,
  }));
}

async function aiCallsToday(username) {
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const rows = await select(
    "ai_audit",
    `select=id&username=eq.${encodeURIComponent(username)}&kind=neq.test&ts=gte.${dayStart.toISOString()}`
  );
  return rows.length;
}

async function aiSummaryInsert(entry) {
  const r = await insert("ai_summaries", {
    scope_type: entry.scopeType, scope_id: entry.scopeId,
    text: entry.text, citations: entry.citations || [],
    model: entry.model || "", created_by: entry.createdBy || "",
  });
  return {
    id: r.id, ts: r.ts, scopeType: r.scope_type, scopeId: r.scope_id,
    text: r.text, citations: r.citations, model: r.model, createdBy: r.created_by,
  };
}

async function aiSummaryLatest(scopeType, scopeId) {
  const rows = await select(
    "ai_summaries",
    `select=*&scope_type=eq.${encodeURIComponent(scopeType)}&scope_id=eq.${encodeURIComponent(scopeId)}&order=id.desc&limit=1`
  );
  if (!rows.length) return null;
  const r = rows[0];
  return {
    id: r.id, ts: r.ts, scopeType: r.scope_type, scopeId: r.scope_id,
    text: r.text, citations: r.citations, model: r.model, createdBy: r.created_by,
  };
}

/* ------------------------------ AI action requests (approval trail) ------------------------------ */

async function aiActionInsert(entry) {
  const r = await insert("ai_action_requests", {
    agent_id: entry.agentId || "", username: entry.username || "",
    action_type: entry.actionType, payload: entry.payload || {},
    status: entry.status || "pending",
    decided_by: entry.decidedBy || "", decided_at: entry.decidedAt || null,
    note: entry.note || "",
  });
  return {
    id: r.id, ts: r.ts, agentId: r.agent_id, username: r.username,
    actionType: r.action_type, payload: r.payload, status: r.status,
    decidedBy: r.decided_by, decidedAt: r.decided_at, note: r.note,
  };
}

async function aiActionList(limit = 100) {
  const rows = await select("ai_action_requests", `select=*&order=id.desc&limit=${limit}`);
  return rows.map((r) => ({
    id: r.id, ts: r.ts, agentId: r.agent_id, username: r.username,
    actionType: r.action_type, payload: r.payload, status: r.status,
    decidedBy: r.decided_by, decidedAt: r.decided_at, note: r.note,
  }));
}

module.exports = {
  getState, getTask, insertTask, updateTask, pushTaskUpdate,
  insertRow, logActivity, maxIdSuffix,
  getUserWithHash, getUser, listUsers, createUser, updateUser,
  listChannels, getChannel, createChannel, updateChannel, deleteChannel,
  addMember, removeMember, setMemberFlags,
  listMessages, postMessage,
  notify, listNotifications, markNotificationsRead,
  getAiSettings, putAiSettings, aiLog, aiAuditList, aiCallsToday,
  aiSummaryInsert, aiSummaryLatest, aiActionInsert, aiActionList,
  // exposed for scripts/seed_supabase.js
  _internals: { req, taskToRow, rowToTask, fieldsToRow },
};
