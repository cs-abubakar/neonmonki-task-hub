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
const {
  splitDepartmentRecords,
  departmentDecision,
  normalizeDepartment,
  userProfileDecision,
  parseUserProfileDecision,
} = require("./task-system");

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
  impact: "impact", clientId: "client_id",
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
    impact: r.impact || "",
    clientId: r.client_id || "neonmonki",
    updates: [],
  };
}

function taskToRow(t) {
  const row = fieldsToRow(t);
  row.id = t.id;
  return row;
}

const rowToUpdate = (r) => ({
  id: r.id,
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
  clientId: r.client_id || "",
  lastSeenAt: r.last_seen_at || null,
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
        active: true, password_hash: u.passwordHash, departments: u.departments || [],
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

  const departmentState = splitDepartmentRecords(decisions);
  return {
    tasks: taskList,
    deliverables,
    decisions: departmentState.decisions,
    departments: withExternalDepartmentFlags(departmentState.departments, decisions),
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

async function deleteTask(id) {
  const encoded = encodeURIComponent(id);
  await Promise.all([
    remove("links", `task_id=eq.${encoded}`),
    remove("notifications", `task_id=eq.${encoded}`),
    remove("activity", `task_id=eq.${encoded}`),
  ]);
  await remove("tasks", `id=eq.${encoded}`);
  return true;
}

async function pushTaskUpdate(id, update) {
  const row = await insert("task_updates", {
    task_id: id,
    ts: update.ts || new Date().toISOString(),
    author: update.by || "",
    text: update.text || "",
    status_from: update.statusFrom || null,
    status_to: update.statusTo || null,
  });
  return rowToUpdate(row);
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

async function updateRow(collection, id, fields) {
  if (collection !== "deliverables") throw new Error(`updateRow: unknown collection ${collection}`);
  const row = {};
  for (const field of ["date", "title", "workstream", "owner", "recipient", "status", "link"]) {
    if (field in fields) row[field] = fields[field] || (field === "date" ? null : "");
  }
  return update("deliverables", `id=eq.${encodeURIComponent(id)}`, row);
}

async function deleteRow(collection, id) {
  if (!['deliverables', 'decisions', 'links'].includes(collection)) throw new Error(`deleteRow: unknown collection ${collection}`);
  await remove(collection, `id=eq.${encodeURIComponent(id)}`);
  return true;
}

async function getLink(id) {
  const rows = await select("links", `select=*&id=eq.${encodeURIComponent(id)}`);
  return rows.length ? rowToLink(rows[0]) : null;
}

async function updateLink(id, fields) {
  const row = {};
  if ("title" in fields) row.title = fields.title;
  if ("url" in fields) row.url = fields.url;
  if ("type" in fields) row.type = fields.type;
  if ("owner" in fields) row.owner = fields.owner;
  if ("note" in fields) row.note = fields.note;
  if ("workstream" in fields) row.workstream = fields.workstream;
  const updated = await update("links", `id=eq.${encodeURIComponent(id)}`, row);
  return updated ? rowToLink(updated) : null;
}

// The department `external` flag (012) rides in the decision row's rule JSON —
// task-system's normalizeDepartment predates the field.
function withExternalDepartmentFlags(departments, rows) {
  const flags = new Map();
  for (const row of rows || []) {
    const m = String((row && row.id) || "").match(/^SYS-DEPT-(.+)$/);
    if (!m) continue;
    try { flags.set(m[1], JSON.parse(row.rule || "{}").external === true); } catch { /* tolerate bad JSON */ }
  }
  return departments.map((d) => ({ ...d, external: d.external === true || flags.get(d.id) === true }));
}

async function putDepartment(input) {
  const department = normalizeDepartment(input);
  const record = departmentDecision(department);
  const meta = JSON.parse(record.rule || "{}");
  meta.external = input.external === true;
  record.rule = JSON.stringify(meta);
  const rows = await select("decisions", `select=id&id=eq.${encodeURIComponent(record.id)}`);
  if (rows.length) {
    await update("decisions", `id=eq.${encodeURIComponent(record.id)}`, {
      topic: record.topic, rule: record.rule, workstream: record.workstream, owner: record.owner,
    });
  } else {
    await insertRow("decisions", record);
  }
  return { ...department, external: meta.external };
}

async function disableDepartment(id) {
  const state = await getState();
  const current = state.departments.find((d) => d.id === id);
  return current ? putDepartment({ ...current, active: false }) : null;
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
    // Written only when set: "" matches the 012 column default, and omitting it
    // keeps user creation working on a database that predates the migration.
    ...(user.clientId ? { client_id: user.clientId } : {}),
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
  if ("clientId" in fields) row.client_id = fields.clientId || "";
  if ("passwordHash" in fields) row.password_hash = fields.passwordHash;
  const r = await update("users", `username=eq.${encodeURIComponent(username)}`, row);
  return r ? rowToUser(r) : null;
}

async function deleteUser(username) {
  const encoded = encodeURIComponent(username);
  await remove("notifications", `username=eq.${encoded}`);
  await remove("decisions", `id=eq.${encodeURIComponent(`SYS-PROFILE-${username}`)}`);
  await remove("users", `username=eq.${encoded}`);
  return true;
}

async function renameUser(username, next) {
  const current = await getUserWithHash(username);
  if (!current) return null;
  const profile = await getUserProfile(username);
  const created = await createUser({
    ...current,
    ...next,
    username: next.username,
    passwordHash: next.passwordHash,
  });
  const oldEncoded = encodeURIComponent(username);
  const memberships = await select("channel_members", `select=*&username=eq.${oldEncoded}`);
  for (const member of memberships) {
    await req("POST", "channel_members", {
      body: { ...member, username: next.username },
      prefer: "resolution=merge-duplicates,return=minimal",
    });
  }
  await remove("channel_members", `username=eq.${oldEncoded}`);
  await update("messages", `author_id=eq.${oldEncoded}`, { author_id: next.username, author: next.name || current.name });
  await update("notifications", `username=eq.${oldEncoded}`, { username: next.username });

  const replaceExactJsonString = (value) => String(value || "").replaceAll(`\"${username}\"`, `\"${next.username}\"`);
  const matchingTasks = await select("tasks", `select=id,source&source=like.${encodeURIComponent(`*${username}*`)}`);
  for (const task of matchingTasks) {
    await update("tasks", `id=eq.${encodeURIComponent(task.id)}`, { source: replaceExactJsonString(task.source) });
  }
  const matchingEvents = await select("task_updates", `select=id,text&text=like.${encodeURIComponent(`*${username}*`)}`);
  for (const event of matchingEvents) {
    await update("task_updates", `id=eq.${event.id}`, { text: replaceExactJsonString(event.text) });
  }

  for (const table of ["ai_audit", "ai_action_requests"]) {
    try { await update(table, `username=eq.${oldEncoded}`, { username: next.username }); } catch { /* optional migration */ }
  }
  try {
    const permissions = await select("ai_user_permissions", `select=*&username=eq.${oldEncoded}`);
    if (permissions[0]) {
      await req("POST", "ai_user_permissions", {
        body: { ...permissions[0], username: next.username },
        prefer: "resolution=merge-duplicates,return=minimal",
      });
    }
    await remove("ai_user_permissions", `username=eq.${oldEncoded}`);
  } catch { /* optional migration */ }
  await putUserProfile(next.username, { ...profile, username: next.username });
  await remove("decisions", `id=eq.${encodeURIComponent(`SYS-PROFILE-${username}`)}`);
  await remove("users", `username=eq.${oldEncoded}`);
  return created;
}

async function getUserProfile(username) {
  const rows = await select("decisions", `select=*&id=eq.${encodeURIComponent(`SYS-PROFILE-${username}`)}&limit=1`);
  return rows.length
    ? parseUserProfileDecision(rows[0])
    : parseUserProfileDecision(userProfileDecision({ username }));
}

async function listUserProfiles() {
  const rows = await select("decisions", `select=*&workstream=eq.${encodeURIComponent("__SYSTEM_USER_PROFILE__")}`);
  return rows.map(parseUserProfileDecision).filter(Boolean);
}

async function putUserProfile(username, fields) {
  const current = await getUserProfile(username);
  const record = userProfileDecision({ ...current, ...fields, username, updatedAt: new Date().toISOString() });
  await req("POST", "decisions", {
    body: record,
    prefer: "resolution=merge-duplicates,return=minimal",
  });
  return parseUserProfileDecision(record);
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

async function getMessage(id) {
  const rows = await select("messages", `select=*&id=eq.${Number(id) || 0}`);
  return rows.length ? rowToMessage(rows[0]) : null;
}

async function updateMessage(id, fields) {
  const row = {};
  if ("text" in fields) row.text = fields.text || "";
  if ("linkUrl" in fields) row.link_url = fields.linkUrl || "";
  if ("linkTitle" in fields) row.link_title = fields.linkTitle || "";
  if ("taskId" in fields) row.task_id = fields.taskId || "";
  const updated = await update("messages", `id=eq.${Number(id) || 0}`, row);
  return updated ? rowToMessage(updated) : null;
}

async function deleteMessage(id) {
  await remove("messages", `id=eq.${Number(id) || 0}`);
  return true;
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
  provider: {},
};

async function getAiSettings() {
  await ensureSeeded();
  try {
    const rows = await select("ai_settings", "select=*&id=eq.1");
    if (!rows.length) return { ...AI_DEFAULT_SETTINGS, userPermissions: {} };
    const r = rows[0];
    const storedFeatures = r.features || {};
    return {
      enabled: r.enabled === true,
      model: r.model || AI_DEFAULT_SETTINGS.model,
      features: {
        ask: storedFeatures.ask !== false,
        chat: storedFeatures.chat !== false,
        brief: storedFeatures.brief !== false,
        summaries: storedFeatures.summaries !== false,
      },
      allowClient: r.allow_client !== false,
      dailyLimit: r.daily_limit || AI_DEFAULT_SETTINGS.dailyLimit,
      // Encrypted provider credentials live in this reserved server-only JSON
      // object so existing production databases do not need a schema repair.
      provider: storedFeatures.__provider || {},
      // Reserved compatibility storage for projects that have not applied 005.
      // HTTP responses expose only the named feature flags, never this map.
      userPermissions: storedFeatures.__userPermissions || {},
    };
  } catch {
    return { ...AI_DEFAULT_SETTINGS, userPermissions: {} }; // table not migrated yet
  }
}

async function putAiSettings(fields) {
  const row = { id: 1, updated_at: new Date().toISOString() };
  if ("enabled" in fields) row.enabled = !!fields.enabled;
  if ("model" in fields) row.model = String(fields.model || AI_DEFAULT_SETTINGS.model).slice(0, 80);
  if ("features" in fields || "provider" in fields || "userPermissions" in fields) {
    const current = await getAiSettings();
    row.features = {
      ...(fields.features || current.features || AI_DEFAULT_SETTINGS.features),
      __userPermissions: fields.userPermissions || current.userPermissions || {},
      __provider: fields.provider || current.provider || {},
    };
  }
  if ("allowClient" in fields) row.allow_client = !!fields.allowClient;
  if ("dailyLimit" in fields) row.daily_limit = Math.max(1, Math.min(1000, Number(fields.dailyLimit) || 60));
  if ("updatedBy" in fields) row.updated_by = fields.updatedBy;
  await req("POST", "ai_settings", {
    body: row,
    prefer: "resolution=merge-duplicates,return=minimal",
  });
  return getAiSettings();
}

// Per-user reporting access tier: "" = inherit role default, else explicit grant/deny.
const REPORTING_ACCESS_VALUES = ["", "none", "basic", "advanced", "super"];

const sanitizeReportingAccess = (value) =>
  REPORTING_ACCESS_VALUES.includes(value) ? value : "";

// Legacy rows may still store the pre-rename tier "full" — it reads as
// "advanced" (writes always use the new vocabulary).
const readReportingAccess = (value) =>
  sanitizeReportingAccess(value === "full" ? "advanced" : value || "");

const defaultAiUserPermission = (username) => ({
  username,
  enabled: true,
  tools: null,
  dailyLimit: null,
  reporting: "",
  updatedBy: "",
  updatedAt: null,
});

const rowToAiUserPermission = (r) => ({
  username: r.username,
  enabled: r.enabled !== false,
  tools: Array.isArray(r.tools) ? r.tools : null,
  dailyLimit: r.daily_limit == null ? null : Number(r.daily_limit),
  reporting: readReportingAccess(r.reporting || ""),
  updatedBy: r.updated_by || "",
  updatedAt: r.updated_at || null,
});

async function getAiUserPermission(username) {
  try {
    const rows = await select(
      "ai_user_permissions",
      `select=*&username=eq.${encodeURIComponent(username)}`
    );
    return rows.length ? rowToAiUserPermission(rows[0]) : defaultAiUserPermission(username);
  } catch {
    const settings = await getAiSettings();
    const stored = (settings.userPermissions || {})[username] || {};
    return {
      ...defaultAiUserPermission(username),
      ...stored,
      username,
      reporting: readReportingAccess(stored.reporting),
    };
  }
}

async function listAiUserPermissions() {
  try {
    const rows = await select("ai_user_permissions", "select=*&order=username.asc");
    return rows.map(rowToAiUserPermission);
  } catch {
    const settings = await getAiSettings();
    return Object.entries(settings.userPermissions || {}).map(([username, fields]) => ({
      ...defaultAiUserPermission(username), ...fields, username,
      reporting: readReportingAccess(fields && fields.reporting),
    }));
  }
}

async function putAiUserPermission(username, fields) {
  const row = { username, updated_at: new Date().toISOString() };
  if ("enabled" in fields) row.enabled = !!fields.enabled;
  if ("tools" in fields) row.tools = fields.tools;
  if ("dailyLimit" in fields) {
    row.daily_limit = fields.dailyLimit == null
      ? null
      : Math.max(1, Math.min(1000, Number(fields.dailyLimit) || 1));
  }
  if ("reporting" in fields) row.reporting = sanitizeReportingAccess(fields.reporting);
  if ("updatedBy" in fields) row.updated_by = fields.updatedBy;
  try {
    const rows = await req("POST", "ai_user_permissions", {
      body: row,
      prefer: "resolution=merge-duplicates,return=representation",
    });
    return rowToAiUserPermission(rows[0]);
  } catch {
    // Compatibility path for an existing production database awaiting 005.
    // The settings table already exists, is server-only, and safely stores the
    // same policy map inside its JSON feature document.
    const settings = await getAiSettings();
    const current = (settings.userPermissions || {})[username] || defaultAiUserPermission(username);
    const next = {
      ...current,
      ...(Object.prototype.hasOwnProperty.call(fields, "enabled") ? { enabled: !!fields.enabled } : {}),
      ...(Object.prototype.hasOwnProperty.call(fields, "tools") ? { tools: fields.tools } : {}),
      ...(Object.prototype.hasOwnProperty.call(fields, "dailyLimit") ? { dailyLimit: fields.dailyLimit } : {}),
      ...(Object.prototype.hasOwnProperty.call(fields, "reporting") ? { reporting: sanitizeReportingAccess(fields.reporting) } : {}),
      ...(Object.prototype.hasOwnProperty.call(fields, "updatedBy") ? { updatedBy: fields.updatedBy } : {}),
      username,
      updatedAt: new Date().toISOString(),
    };
    const userPermissions = { ...(settings.userPermissions || {}), [username]: next };
    await putAiSettings({ features: settings.features, userPermissions });
    return next;
  }
}

async function aiLog(entry) {
  const r = await insert("ai_audit", {
    username: entry.username || "", kind: entry.kind || "ask",
    question: (entry.question || "").slice(0, 500),
    answer: (entry.answer || "").slice(0, 4000),
    tools: entry.tools || [], citations: entry.citations || [],
    model: entry.model || "", prompt_tokens: entry.promptTokens || 0,
    completion_tokens: entry.completionTokens || 0, latency_ms: entry.latencyMs || 0,
    status: entry.status || "ok", error: (entry.error || "").slice(0, 300),
  });
  return r;
}

function aiAuditRow(r) {
  return {
    id: r.id, ts: r.ts, username: r.username, kind: r.kind, question: r.question,
    answer: r.answer || "",
    tools: r.tools, citations: r.citations, model: r.model,
    promptTokens: r.prompt_tokens, completionTokens: r.completion_tokens,
    latencyMs: r.latency_ms, status: r.status, error: r.error,
  };
}

async function aiAuditList(limit = 100) {
  const rows = await select("ai_audit", `select=*&order=id.desc&limit=${limit}`);
  return rows.map(aiAuditRow);
}

/**
 * Date-windowed audit read for the Control Panel's AI History view. `from`/`to`
 * are ISO timestamps (the caller computes the day's bounds); either may be
 * omitted. Newest first, capped at `limit`.
 */
async function aiAuditQuery({ from = null, to = null, username = "", limit = 500 } = {}) {
  const parts = ["select=*", "order=id.desc", `limit=${Math.max(1, Math.min(1000, limit))}`];
  if (from) parts.push(`ts=gte.${encodeURIComponent(from)}`);
  if (to) parts.push(`ts=lt.${encodeURIComponent(to)}`);
  if (username) parts.push(`username=eq.${encodeURIComponent(username)}`);
  const rows = await select("ai_audit", parts.join("&"));
  return rows.map(aiAuditRow);
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

const ACTION_META_PREFIX = "__nm_action_meta__:";

function actionMeta(r) {
  if (!String(r.note || "").startsWith(ACTION_META_PREFIX)) return { note: r.note || "" };
  try { return JSON.parse(String(r.note).slice(ACTION_META_PREFIX.length)); }
  catch { return { note: "" }; }
}

function rowToAiAction(r) {
  const meta = actionMeta(r);
  return {
    id: r.id, ts: r.ts, agentId: r.agent_id, username: r.username,
    actionType: r.action_type, payload: r.payload,
    modifiedPayload: r.modified_payload || meta.modifiedPayload || {},
    executionResult: r.execution_result || meta.executionResult || {}, status: r.status,
    decidedBy: r.decided_by, decidedAt: r.decided_at,
    note: meta.note !== undefined ? meta.note : (r.note || ""),
    updatedAt: r.updated_at || meta.updatedAt || r.decided_at || r.ts,
  };
}

async function aiActionInsert(entry) {
  const base = {
    agent_id: entry.agentId || "", username: entry.username || "",
    action_type: entry.actionType, payload: entry.payload || {},
    status: entry.status || "pending",
    decided_by: entry.decidedBy || "", decided_at: entry.decidedAt || null,
    note: entry.note || "",
  };
  try {
    return rowToAiAction(await insert("ai_action_requests", {
      ...base,
      modified_payload: entry.modifiedPayload || {}, execution_result: entry.executionResult || {},
    }));
  } catch {
    return rowToAiAction(await insert("ai_action_requests", base));
  }
}

async function aiActionList(limit = 100) {
  const rows = await select("ai_action_requests", `select=*&order=id.desc&limit=${limit}`);
  return rows.map(rowToAiAction);
}

async function aiActionGet(id) {
  const rows = await select("ai_action_requests", `select=*&id=eq.${Number(id) || 0}`);
  if (!rows.length) return null;
  return rowToAiAction(rows[0]);
}

async function aiActionUpdate(id, fields) {
  const row = { updated_at: new Date().toISOString() };
  if ("status" in fields) row.status = fields.status;
  if ("modifiedPayload" in fields) row.modified_payload = fields.modifiedPayload || {};
  if ("executionResult" in fields) row.execution_result = fields.executionResult || {};
  if ("decidedBy" in fields) row.decided_by = fields.decidedBy || "";
  if ("decidedAt" in fields) row.decided_at = fields.decidedAt || null;
  if ("note" in fields) row.note = fields.note || "";
  try {
    const r = await update("ai_action_requests", `id=eq.${Number(id) || 0}`, row);
    return r ? aiActionGet(r.id) : null;
  } catch {
    // Migration-003 compatibility: preserve provenance as structured JSON in
    // the existing note field until 005 adds dedicated columns.
    const fallback = {};
    if ("status" in fields) fallback.status = fields.status;
    if ("decidedBy" in fields) fallback.decided_by = fields.decidedBy || "";
    if ("decidedAt" in fields) fallback.decided_at = fields.decidedAt || null;
    fallback.note = ACTION_META_PREFIX + JSON.stringify({
      note: fields.note || "",
      modifiedPayload: fields.modifiedPayload || {},
      executionResult: fields.executionResult || {},
      updatedAt: new Date().toISOString(),
    });
    const r = await update("ai_action_requests", `id=eq.${Number(id) || 0}`, fallback);
    return r ? aiActionGet(r.id) : null;
  }
}

/* ------------------------------ reporting layer ------------------------------ */

const rowToMetricEntry = (r) => ({
  id: r.id, date: r.date || "", channel: r.channel || "", metric: r.metric || "",
  value: Number(r.value) || 0, note: r.note || "", createdBy: r.created_by || "", ts: r.ts,
});

async function metricsList(from, to) {
  let query = "select=*&order=date.asc,id.asc";
  if (from) query += `&date=gte.${encodeURIComponent(from)}`;
  if (to) query += `&date=lte.${encodeURIComponent(to)}`;
  return (await select("metrics", query)).map(rowToMetricEntry);
}

async function metricInsert(entry) {
  const r = await insert("metrics", {
    date: entry.date, channel: entry.channel, metric: entry.metric,
    value: entry.value, note: entry.note || "", created_by: entry.createdBy || "",
  });
  return rowToMetricEntry(r);
}

async function metricDelete(id) {
  await remove("metrics", `id=eq.${Number(id) || 0}`);
  return true;
}

const rowToAiReport = (r) => ({
  id: r.id, ts: r.ts, audience: r.audience || "team",
  periodFrom: r.period_from || "", periodTo: r.period_to || "",
  text: r.text || "", citations: Array.isArray(r.citations) ? r.citations : [],
  createdBy: r.created_by || "",
});

async function aiReportInsert(entry) {
  const r = await insert("ai_reports", {
    audience: entry.audience || "team",
    period_from: entry.periodFrom || "", period_to: entry.periodTo || "",
    text: entry.text || "", citations: entry.citations || [],
    created_by: entry.createdBy || "",
  });
  return rowToAiReport(r);
}

async function aiReportLatest(audience) {
  const rows = await select(
    "ai_reports",
    `select=*&audience=eq.${encodeURIComponent(audience)}&order=id.desc&limit=1`
  );
  return rows.length ? rowToAiReport(rows[0]) : null;
}

/* --------------------------- smart reporting layer --------------------------- */

// Credentials (api_key_encrypted, webhook_token_hash) are write-only: accepted
// by putIntegration, never selected back into an integration response. Only
// getIntegrationSecret reads them, and it is for server-side sync code only.

const rowToIntegration = (r) => ({
  id: r.id,
  name: r.name || "",
  status: r.status || "disconnected",
  accountName: r.account_name || "",
  hasApiKey: !!r.api_key_encrypted,
  hasWebhookToken: !!r.webhook_token_hash,
  authMethod: r.auth_method || "",
  oauthClientId: r.oauth_client_id || "",
  oauthAccessExpiresAt: r.oauth_access_expires_at || null,
  lastSyncAt: r.last_sync_at || null,
  lastWebhookAt: r.last_webhook_at || null,
  lastError: r.last_error || "",
  historicalDays: Number(r.historical_days) || 90,
  backfill: r.backfill || {},
  meta: r.meta || {},
  createdAt: r.created_at || null,
  updatedAt: r.updated_at || null,
});

const INTEGRATION_FIELD_MAP = {
  name: "name", status: "status", accountName: "account_name",
  apiKeyEncrypted: "api_key_encrypted", webhookTokenHash: "webhook_token_hash",
  authMethod: "auth_method", oauthClientId: "oauth_client_id",
  oauthClientSecretEncrypted: "oauth_client_secret_encrypted",
  oauthAccessTokenEncrypted: "oauth_access_token_encrypted",
  oauthAccessExpiresAt: "oauth_access_expires_at",
  oauthRefreshTokenEncrypted: "oauth_refresh_token_encrypted",
  oauthPending: "oauth_pending",
  lastSyncAt: "last_sync_at", lastWebhookAt: "last_webhook_at",
  lastError: "last_error", historicalDays: "historical_days",
  backfill: "backfill", meta: "meta", connectedBy: "connected_by", connectedAt: "connected_at",
  disconnectedBy: "disconnected_by", disconnectedAt: "disconnected_at",
};

async function getIntegration(id) {
  const rows = await select("integration_connections", `select=*&id=eq.${encodeURIComponent(id)}`);
  return rows.length ? rowToIntegration(rows[0]) : null;
}

async function listIntegrations() {
  const rows = await select("integration_connections", "select=*&order=id.asc");
  return rows.map(rowToIntegration);
}

async function getIntegrationSecret(id) {
  const rows = await select(
    "integration_connections",
    `select=id,api_key_encrypted,webhook_token_hash,oauth_client_secret_encrypted,oauth_access_token_encrypted,oauth_refresh_token_encrypted,oauth_pending,oauth_client_id,oauth_access_expires_at,auth_method&id=eq.${encodeURIComponent(id)}`
  );
  if (!rows.length) return null;
  return {
    id: rows[0].id,
    apiKeyEncrypted: rows[0].api_key_encrypted || "",
    webhookTokenHash: rows[0].webhook_token_hash || "",
    authMethod: rows[0].auth_method || "",
    oauthClientId: rows[0].oauth_client_id || "",
    oauthClientSecretEncrypted: rows[0].oauth_client_secret_encrypted || "",
    oauthAccessTokenEncrypted: rows[0].oauth_access_token_encrypted || "",
    oauthAccessExpiresAt: rows[0].oauth_access_expires_at || null,
    oauthRefreshTokenEncrypted: rows[0].oauth_refresh_token_encrypted || "",
    oauthPending: rows[0].oauth_pending || {},
  };
}

async function putIntegration(id, fields) {
  const row = { id, updated_at: new Date().toISOString() };
  for (const [jsKey, col] of Object.entries(INTEGRATION_FIELD_MAP)) {
    if (jsKey in fields) row[col] = fields[jsKey];
  }
  const rows = await req("POST", "integration_connections", {
    body: row,
    prefer: "resolution=merge-duplicates,return=representation",
  });
  return rows && rows.length ? rowToIntegration(rows[0]) : getIntegration(id);
}

async function clearIntegrationSecret(id) {
  const row = await update("integration_connections", `id=eq.${encodeURIComponent(id)}`, {
    api_key_encrypted: "",
    webhook_token_hash: "",
    updated_at: new Date().toISOString(),
  });
  return row ? rowToIntegration(row) : null;
}

const rowToSyncRun = (r) => ({
  id: r.id, integrationId: r.integration_id || "", kind: r.kind || "",
  rangeFrom: r.range_from || null, rangeTo: r.range_to || null,
  status: r.status || "running", recordsIn: Number(r.records_in) || 0,
  error: r.error || "", startedAt: r.started_at || null, finishedAt: r.finished_at || null,
});

async function syncRunInsert(entry) {
  const r = await insert("hyros_sync_runs", {
    integration_id: entry.integrationId || "hyros",
    kind: entry.kind || "incremental",
    range_from: entry.rangeFrom || null,
    range_to: entry.rangeTo || null,
    status: entry.status || "running",
    records_in: Number(entry.recordsIn) || 0,
    error: entry.error || "",
    started_at: entry.startedAt || new Date().toISOString(),
    finished_at: entry.finishedAt || null,
  });
  return rowToSyncRun(r);
}

async function syncRunUpdate(id, fields) {
  const row = {};
  if ("status" in fields) row.status = fields.status;
  if ("recordsIn" in fields) row.records_in = fields.recordsIn;
  if ("error" in fields) row.error = fields.error;
  if ("finishedAt" in fields) row.finished_at = fields.finishedAt;
  if ("rangeFrom" in fields) row.range_from = fields.rangeFrom;
  if ("rangeTo" in fields) row.range_to = fields.rangeTo;
  const r = await update("hyros_sync_runs", `id=eq.${Number(id) || 0}`, row);
  return r ? rowToSyncRun(r) : null;
}

async function syncRunLatest(integrationId) {
  const rows = await select(
    "hyros_sync_runs",
    `select=*&integration_id=eq.${encodeURIComponent(integrationId)}&order=id.desc&limit=1`
  );
  return rows.length ? rowToSyncRun(rows[0]) : null;
}

async function syncRunList(integrationId, limit = 20) {
  let query = "select=*&order=id.desc";
  if (integrationId) query += `&integration_id=eq.${encodeURIComponent(integrationId)}`;
  query += `&limit=${Math.max(1, Math.min(200, Number(limit) || 20))}`;
  return (await select("hyros_sync_runs", query)).map(rowToSyncRun);
}

const FACT_COLUMNS = "id,source_system,integration_id,external_id,event_type,event_at,"
  + "channel,platform,source_name,campaign,ad_account,goal,tags,is_organic,is_qualified,"
  + "value,currency,lead_id,sale_id,created_at,updated_at";

const rowToFact = (r, withRaw) => ({
  id: r.id,
  sourceSystem: r.source_system || "", integrationId: r.integration_id || "",
  externalId: r.external_id || "", eventType: r.event_type || "",
  eventAt: r.event_at || null,
  channel: r.channel || "", platform: r.platform || "", sourceName: r.source_name || "",
  campaign: r.campaign || "", adAccount: r.ad_account || "", goal: r.goal || "",
  tags: r.tags || "",
  isOrganic: r.is_organic == null ? null : r.is_organic === true,
  isQualified: r.is_qualified == null ? null : r.is_qualified === true,
  value: r.value == null ? null : Number(r.value),
  currency: r.currency || "", leadId: r.lead_id || "", saleId: r.sale_id || "",
  createdAt: r.created_at || null, updatedAt: r.updated_at || null,
  ...(withRaw ? { raw: r.raw || {} } : {}),
});

const factToRow = (f) => ({
  source_system: String(f.sourceSystem),
  integration_id: f.integrationId || "",
  external_id: String(f.externalId),
  event_type: String(f.eventType),
  event_at: f.eventAt,
  channel: f.channel || "", platform: f.platform || "", source_name: f.sourceName || "",
  campaign: f.campaign || "", ad_account: f.adAccount || "", goal: f.goal || "",
  tags: f.tags || "",
  is_organic: f.isOrganic == null ? null : !!f.isOrganic,
  is_qualified: f.isQualified == null ? null : !!f.isQualified,
  value: f.value == null ? null : Number(f.value),
  currency: f.currency || "", lead_id: f.leadId || "", sale_id: f.saleId || "",
  raw: f.raw && typeof f.raw === "object" ? f.raw : {},
});

/** UTC day bounds for timestamptz range filters: [from 00:00Z, day after to 00:00Z). */
const dayStartIso = (day) => `${day}T00:00:00.000Z`;
const dayAfterIso = (day) =>
  new Date(new Date(`${day}T00:00:00Z`).getTime() + 86400000).toISOString();

/**
 * Idempotent ingest in 500-row chunks: ON CONFLICT (source_system, event_type,
 * external_id) DO NOTHING — duplicates are skipped, never updated (re-running a
 * sync is safe). Returns { inserted, skipped, invalid }. To refresh mutated
 * source records (e.g. refunds), reportingFactsDelete + re-backfill.
 */
async function reportingFactsUpsert(rows) {
  const list = (Array.isArray(rows) ? rows : []).filter(
    (r) => r && r.sourceSystem && r.eventType && r.externalId && r.eventAt
  );
  const invalid = (Array.isArray(rows) ? rows.length : 0) - list.length;
  let inserted = 0;
  for (let i = 0; i < list.length; i += 500) {
    const chunk = list.slice(i, i + 500).map(factToRow);
    const returned = await req("POST", "reporting_facts", {
      query: "on_conflict=source_system,event_type,external_id",
      body: chunk,
      prefer: "resolution=ignore-duplicates,return=representation",
    });
    inserted += Array.isArray(returned) ? returned.length : 0;
  }
  return { inserted, skipped: list.length - inserted, invalid };
}

async function reportingFactsList(query = {}) {
  const {
    from, to, sourceSystem, integrationId, eventType,
    channel, platform, source, campaign,
    order = "asc", limit = 20000, withRaw = false,
  } = query || {};
  let q = `select=${withRaw ? "*" : FACT_COLUMNS}`;
  if (from) q += `&event_at=gte.${encodeURIComponent(dayStartIso(from))}`;
  if (to) q += `&event_at=lt.${encodeURIComponent(dayAfterIso(to))}`;
  if (sourceSystem) q += `&source_system=eq.${encodeURIComponent(sourceSystem)}`;
  if (integrationId) q += `&integration_id=eq.${encodeURIComponent(integrationId)}`;
  if (eventType) q += `&event_type=eq.${encodeURIComponent(eventType)}`;
  if (channel) q += `&channel=eq.${encodeURIComponent(channel)}`;
  if (platform) q += `&platform=eq.${encodeURIComponent(platform)}`;
  if (source) q += `&source_name=eq.${encodeURIComponent(source)}`;
  if (campaign) q += `&campaign=eq.${encodeURIComponent(campaign)}`;
  q += `&order=event_at.${order === "desc" ? "desc" : "asc"},id.asc`;
  const cap = Math.max(1, Math.min(50000, Number(limit) || 20000));
  // PostgREST max-rows (default 1000) silently truncates a single request —
  // page with offset until a short page or the caller's cap is reached.
  const pageSize = Math.min(1000, cap);
  const rows = [];
  for (let offset = 0; offset < cap; offset += pageSize) {
    const page = await select("reporting_facts", `${q}&limit=${pageSize}&offset=${offset}`);
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows.map((r) => rowToFact(r, withRaw));
}

async function reportingFactsDelete({ integrationId, sourceSystem } = {}) {
  if (!integrationId) throw new Error("reportingFactsDelete: integrationId is required");
  let query = `select=id&integration_id=eq.${encodeURIComponent(integrationId)}`;
  if (sourceSystem) query += `&source_system=eq.${encodeURIComponent(sourceSystem)}`;
  const rows = await req("DELETE", "reporting_facts", {
    query,
    prefer: "return=representation",
  });
  return Array.isArray(rows) ? rows.length : 0;
}

async function reportingFactsCount() {
  const res = await fetch(`${BASE()}/reporting_facts?select=id&limit=1`, {
    headers: headers({ Prefer: "count=exact" }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Supabase GET reporting_facts failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const range = res.headers.get("content-range") || ""; // e.g. "0-0/128" or "*/0"
  const m = range.match(/\/(\d+)\s*$/);
  return m ? Number(m[1]) : 0;
}

/* ------------------------ reporting_daily (v2 aggregates) ------------------------ */

const DAILY_COLUMNS = "id,source_system,day,scope,channel,platform,ad_account,"
  + "campaign_id,campaign_name,spend,clicks,impressions,leads,sales,revenue,aov,synced_at";

const numOr0 = (v) => (v == null || isNaN(Number(v)) ? 0 : Number(v));
const numOrNull = (v) => (v == null || isNaN(Number(v)) ? null : Number(v));

const rowToDaily = (r) => ({
  id: r.id,
  sourceSystem: r.source_system || "",
  day: r.day || "",
  scope: r.scope || "",
  channel: r.channel || "",
  platform: r.platform || "",
  adAccount: r.ad_account || "",
  campaignId: r.campaign_id || "",
  campaignName: r.campaign_name || "",
  spend: numOr0(r.spend),
  clicks: numOrNull(r.clicks),
  impressions: numOrNull(r.impressions),
  leads: numOr0(r.leads),
  sales: numOr0(r.sales),
  revenue: numOr0(r.revenue),
  aov: numOrNull(r.aov),
  syncedAt: r.synced_at || null,
});

const dailyToRow = (d) => ({
  source_system: String(d.sourceSystem || "hyros"),
  day: String(d.day).slice(0, 10),
  scope: String(d.scope),
  channel: d.channel || "Unknown",
  platform: d.platform || "Other",
  ad_account: d.adAccount || "",
  campaign_id: d.campaignId || "",
  campaign_name: d.campaignName || "",
  spend: numOr0(d.spend),
  clicks: numOrNull(d.clicks),           // null = untracked / unavailable
  impressions: numOrNull(d.impressions),
  leads: numOr0(d.leads),
  sales: numOr0(d.sales),
  revenue: numOr0(d.revenue),
  aov: numOrNull(d.aov),
  synced_at: new Date().toISOString(),
});

/**
 * Upsert daily aggregate rows in 500-row chunks, keyed by (source_system, day,
 * scope, platform, ad_account, campaign_id) — ON CONFLICT DO UPDATE, so
 * re-syncing a day overwrites its numbers instead of duplicating rows.
 * Returns rows written.
 */
async function reportingDailyUpsert(rows) {
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r && r.day && r.scope);
  let written = 0;
  for (let i = 0; i < list.length; i += 500) {
    const chunk = list.slice(i, i + 500).map(dailyToRow);
    const returned = await req("POST", "reporting_daily", {
      query: "on_conflict=source_system,day,scope,platform,ad_account,campaign_id",
      body: chunk,
      prefer: "resolution=merge-duplicates,return=representation",
    });
    written += Array.isArray(returned) ? returned.length : 0;
  }
  return written;
}

async function reportingDailyQuery(query = {}) {
  const {
    from, to, sourceSystem, scope, channel, platform, campaignId,
    order = "asc", limit = 50000,
  } = query || {};
  let q = `select=${DAILY_COLUMNS}`;
  if (from) q += `&day=gte.${encodeURIComponent(from)}`;
  if (to) q += `&day=lte.${encodeURIComponent(to)}`;
  if (sourceSystem) q += `&source_system=eq.${encodeURIComponent(sourceSystem)}`;
  if (scope) q += `&scope=eq.${encodeURIComponent(scope)}`;
  if (channel) q += `&channel=eq.${encodeURIComponent(channel)}`;
  if (platform) q += `&platform=eq.${encodeURIComponent(platform)}`;
  if (campaignId) q += `&campaign_id=eq.${encodeURIComponent(campaignId)}`;
  q += `&order=day.${order === "desc" ? "desc" : "asc"},id.asc`;
  const cap = Math.max(1, Math.min(50000, Number(limit) || 50000));
  // Same PostgREST max-rows guard as reportingFactsList — page via offset.
  const pageSize = Math.min(1000, cap);
  const rows = [];
  for (let offset = 0; offset < cap; offset += pageSize) {
    const page = await select("reporting_daily", `${q}&limit=${pageSize}&offset=${offset}`);
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows.map(rowToDaily);
}

async function reportingDailyDelete({ sourceSystem } = {}) {
  if (!sourceSystem) throw new Error("reportingDailyDelete: sourceSystem is required");
  const rows = await req("DELETE", "reporting_daily", {
    query: `select=id&source_system=eq.${encodeURIComponent(sourceSystem)}`,
    prefer: "return=representation",
  });
  return Array.isArray(rows) ? rows.length : 0;
}

/* --------------------------- platform reports (GSC + Clarity) --------------------------- */

const platformDailyToRow = (r) => ({
  platform: r.platform,
  day: r.day,
  slice_type: r.sliceType || "date",
  slice_value: (r.sliceValue || "").slice(0, 1000),
  metric: (r.metric || "").slice(0, 200),
  clicks: r.clicks == null ? null : Number(r.clicks),
  impressions: r.impressions == null ? null : Number(r.impressions),
  ctr: r.ctr == null ? null : Number(r.ctr),
  position: r.position == null ? null : Number(r.position),
  value: r.value == null ? null : Number(r.value),
  synced_at: r.syncedAt || new Date().toISOString(),
});

const rowToPlatformDaily = (r) => ({
  id: r.id, platform: r.platform, day: r.day,
  sliceType: r.slice_type || "date", sliceValue: r.slice_value || "",
  metric: r.metric || "",
  clicks: r.clicks == null ? null : Number(r.clicks),
  impressions: r.impressions == null ? null : Number(r.impressions),
  ctr: r.ctr == null ? null : Number(r.ctr),
  position: r.position == null ? null : Number(r.position),
  value: r.value == null ? null : Number(r.value),
  syncedAt: r.synced_at || null,
});

const PLATFORM_DAILY_COLUMNS = "id,platform,day,slice_type,slice_value,metric,clicks,impressions,ctr,position,value,synced_at";

async function platformDailyUpsert(rows) {
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r && r.platform && r.day);
  let written = 0;
  for (let i = 0; i < list.length; i += 500) {
    const chunk = list.slice(i, i + 500).map(platformDailyToRow);
    const returned = await req("POST", "platform_daily", {
      query: "on_conflict=platform,day,slice_type,slice_value,metric",
      body: chunk,
      prefer: "resolution=merge-duplicates,return=representation",
    });
    written += Array.isArray(returned) ? returned.length : 0;
  }
  return written;
}

async function platformDailyQuery(query = {}) {
  const { platform, from, to, sliceType, limit = 50000 } = query || {};
  let q = `select=${PLATFORM_DAILY_COLUMNS}`;
  if (platform) q += `&platform=eq.${encodeURIComponent(platform)}`;
  if (from) q += `&day=gte.${encodeURIComponent(from)}`;
  if (to) q += `&day=lte.${encodeURIComponent(to)}`;
  if (sliceType) q += `&slice_type=eq.${encodeURIComponent(sliceType)}`;
  q += "&order=day.asc,id.asc";
  const cap = Math.max(1, Math.min(50000, Number(limit) || 50000));
  const pageSize = Math.min(1000, cap);
  const rows = [];
  for (let offset = 0; offset < cap; offset += pageSize) {
    const page = await select("platform_daily", `${q}&limit=${pageSize}&offset=${offset}`);
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows.map(rowToPlatformDaily);
}

async function platformDailyDelete({ platform } = {}) {
  if (!platform) throw new Error("platformDailyDelete: platform is required");
  const rows = await req("DELETE", "platform_daily", {
    query: `select=id&platform=eq.${encodeURIComponent(platform)}`,
    prefer: "return=representation",
  });
  return Array.isArray(rows) ? rows.length : 0;
}

async function platformDailyCount({ platform } = {}) {
  let q = "select=id&limit=1";
  if (platform) q += `&platform=eq.${encodeURIComponent(platform)}`;
  const res = await fetch(`${BASE()}/platform_daily?${q}`, {
    headers: headers({ Prefer: "count=exact" }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Supabase GET platform_daily failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const range = res.headers.get("content-range") || "";
  const m = range.match(/\/(\d+)\s*$/);
  return m ? Number(m[1]) : 0;
}

/* --------------------------- report library --------------------------- */

// Curated report links (Google Drive decks, dashboards, …) shown on the
// Reports page, grouped by month and kind. Validation lives in the handler;
// the store only normalizes shape. Table: migrations/011_report_library.sql.
const sanitizeReportLinks = (links) =>
  (Array.isArray(links) ? links : [])
    .filter((l) => l && typeof l.url === "string" && l.url)
    .map((l) => ({ label: typeof l.label === "string" ? l.label : "", url: l.url }));

const rowToLibraryReport = (r) => ({
  id: r.id,
  title: r.title || "",
  description: r.description || "",
  kind: r.kind || "weekly",
  periodMonth: r.period_month || "",
  links: sanitizeReportLinks(r.links),
  createdBy: r.created_by || "",
  clientId: r.client_id || "neonmonki",
  createdAt: r.created_at || null,
  updatedAt: r.updated_at || null,
});

async function reportsList() {
  const rows = await select("report_library", "select=*&order=period_month.desc,id.desc");
  return rows.map(rowToLibraryReport);
}

async function reportInsert(fields) {
  const r = await insert("report_library", {
    title: fields.title || "",
    description: fields.description || "",
    kind: fields.kind || "weekly",
    period_month: fields.periodMonth || "",
    links: sanitizeReportLinks(fields.links),
    created_by: fields.createdBy || "",
    // Only written when set — the 012 default ('neonmonki') covers the rest and
    // pre-migration databases keep accepting report inserts.
    ...(fields.clientId ? { client_id: fields.clientId } : {}),
  });
  return rowToLibraryReport(r);
}

async function reportUpdate(id, fields) {
  const row = { updated_at: new Date().toISOString() };
  if ("title" in fields) row.title = fields.title;
  if ("description" in fields) row.description = fields.description;
  if ("kind" in fields) row.kind = fields.kind;
  if ("periodMonth" in fields) row.period_month = fields.periodMonth;
  if ("links" in fields) row.links = sanitizeReportLinks(fields.links);
  if ("clientId" in fields) row.client_id = fields.clientId || "neonmonki";
  const r = await update("report_library", `id=eq.${Number(id) || 0}`, row);
  return r ? rowToLibraryReport(r) : null;
}

async function reportDelete(id) {
  await remove("report_library", `id=eq.${Number(id) || 0}`);
  return true;
}

/* ------------------------------ clients ------------------------------ */

// Client registry (migration 012). An empty (or not-yet-created) table reads
// as the built-in NEONMONKI default so pre-migration deploys keep working.
const DEFAULT_CLIENT = { id: "neonmonki", name: "NEONMONKI", active: true, notes: "", createdAt: null };

const rowToClient = (r) => ({
  id: r.id, name: r.name || "", active: r.active !== false,
  notes: r.notes || "", createdAt: r.created_at || null,
});

async function clientsList() {
  try {
    const rows = await select("clients", "select=*&order=name.asc");
    if (!rows.length) return [{ ...DEFAULT_CLIENT }];
    return rows.map(rowToClient);
  } catch {
    return [{ ...DEFAULT_CLIENT }]; // clients table not migrated yet
  }
}

async function clientInsert({ id, name, active, notes }) {
  const r = await insert("clients", {
    id, name: name || "", active: active !== false, notes: notes || "",
  });
  return rowToClient(r);
}

async function clientUpdate(id, fields) {
  const row = {};
  if ("name" in fields) row.name = fields.name;
  if ("active" in fields) row.active = fields.active !== false;
  if ("notes" in fields) row.notes = fields.notes;
  const r = await update("clients", `id=eq.${encodeURIComponent(id)}`, row);
  return r ? rowToClient(r) : null;
}

/** Stamp the user's current visit; returns the previous stamp (or null). */
async function touchLastSeen(username) {
  const rows = await select(
    "users",
    `select=last_seen_at&username=eq.${encodeURIComponent(username)}`
  );
  if (!rows.length) return null;
  const previous = rows[0].last_seen_at || null;
  await update("users", `username=eq.${encodeURIComponent(username)}`, {
    last_seen_at: new Date().toISOString(),
  });
  return previous;
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
  aiLog, aiAuditList, aiAuditQuery, aiCallsToday,  aiSummaryInsert, aiSummaryLatest,
  aiActionInsert, aiActionList, aiActionGet, aiActionUpdate,
  metricsList, metricInsert, metricDelete,
  aiReportInsert, aiReportLatest, touchLastSeen,
  getIntegration, listIntegrations, getIntegrationSecret, putIntegration, clearIntegrationSecret,
  syncRunInsert, syncRunUpdate, syncRunLatest, syncRunList,
  reportingFactsUpsert, reportingFactsList, reportingFactsDelete, reportingFactsCount,
  reportingDailyUpsert, reportingDailyQuery, reportingDailyDelete,
  platformDailyUpsert, platformDailyQuery, platformDailyDelete, platformDailyCount,
  reportsList, reportInsert, reportUpdate, reportDelete,
  clientsList, clientInsert, clientUpdate,
  // exposed for scripts/seed_supabase.js
  _internals: { req, taskToRow, rowToTask, fieldsToRow },
};
