/**
 * Structured task-system helpers.
 *
 * Production already has the core task, update, decision and link tables. To
 * keep this upgrade deployable without a risky one-off database operation, the
 * richer workflow is encoded into those existing durable records:
 *   - department definitions are system decision records
 *   - comments/subtasks are typed task-update events
 *   - file review metadata lives on task-linked file records
 *
 * Both storage drivers use these helpers, so JSON development and Supabase
 * production expose exactly the same model.
 */
"use strict";

const DEPARTMENT_WORKSTREAM = "__SYSTEM_DEPARTMENT__";
const TASK_EVENT_PREFIX = "@@NM_TASK_EVENT@@";
const FILE_META_PREFIX = "@@NM_FILE_META@@";
const TASK_SOURCE_PREFIX = "@@NM_TASK_SOURCE@@";
const USER_PROFILE_WORKSTREAM = "__SYSTEM_USER_PROFILE__";

const DEFAULT_DEPARTMENTS = [
  { id: "seo", name: "SEO", color: "#2563eb", icon: "⌕", active: true, order: 10 },
  { id: "google-ads", name: "Google Ads", color: "#f59e0b", icon: "G", active: true, order: 20 },
  { id: "email-marketing", name: "Email Marketing", color: "#ec4899", icon: "✉", active: true, order: 30 },
  { id: "research", name: "Research", color: "#8b5cf6", icon: "◈", active: true, order: 40 },
  { id: "social-media", name: "Social Media", color: "#06b6d4", icon: "#", active: true, order: 50 },
  { id: "development", name: "Development", color: "#10b981", icon: "</>", active: true, order: 60 },
  { id: "ai-automation", name: "AI & Automation", color: "#7c3aed", icon: "✦", active: true, order: 70 },
  { id: "project-management", name: "Project Management", color: "#ef4444", icon: "✓", active: true, order: 80 },
];

const LEGACY_DEPARTMENT_IDS = {
  "seo": "seo",
  "seo - technical": "seo",
  "seo - content": "seo",
  "seo - research": "research",
  "google ads": "google-ads",
  "paid marketing": "google-ads",
  "conversion tracking": "google-ads",
  "email marketing": "email-marketing",
  "research": "research",
  "italy expansion": "research",
  "social media": "social-media",
  "development": "development",
  "ai & automation": "ai-automation",
  "ai automation": "ai-automation",
  "project management": "project-management",
  "data analytics": "project-management",
  "salesforce / crm": "project-management",
};

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

function departmentId(value, departments = DEFAULT_DEPARTMENTS) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const lower = raw.toLowerCase();
  const exact = departments.find((d) => d.id === raw || d.name.toLowerCase() === lower);
  return exact ? exact.id : (LEGACY_DEPARTMENT_IDS[lower] || slugify(raw));
}

function normalizeDepartment(input, index = 0) {
  const id = slugify(input.id || input.name);
  return {
    id,
    name: String(input.name || id).trim().slice(0, 60),
    color: /^#[0-9a-f]{6}$/i.test(String(input.color || "")) ? input.color : "#64748b",
    icon: String(input.icon || "◆").trim().slice(0, 8),
    active: input.active !== false,
    order: Number.isFinite(Number(input.order)) ? Number(input.order) : (index + 1) * 10,
  };
}

function departmentDecision(department) {
  const d = normalizeDepartment(department);
  return {
    id: `SYS-DEPT-${d.id}`,
    date: "",
    topic: d.name,
    rule: JSON.stringify({ color: d.color, icon: d.icon, active: d.active, order: d.order }),
    workstream: DEPARTMENT_WORKSTREAM,
    owner: d.id,
  };
}

function parseDepartmentDecision(row) {
  if (!row || row.workstream !== DEPARTMENT_WORKSTREAM) return null;
  let meta = {};
  try { meta = JSON.parse(row.rule || "{}"); } catch { /* tolerate old/bad overrides */ }
  return normalizeDepartment({
    id: row.owner || String(row.id || "").replace(/^SYS-DEPT-/, ""),
    name: row.topic,
    ...meta,
  });
}

function splitDepartmentRecords(rows) {
  const overrides = new Map();
  const decisions = [];
  for (const row of rows || []) {
    if (row && row.workstream === USER_PROFILE_WORKSTREAM) continue;
    const parsed = parseDepartmentDecision(row);
    if (parsed) overrides.set(parsed.id, parsed);
    else decisions.push(row);
  }
  const merged = DEFAULT_DEPARTMENTS.map((d) => overrides.get(d.id) || { ...d });
  for (const [id, d] of overrides) {
    if (!merged.some((x) => x.id === id)) merged.push(d);
  }
  merged.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  return { departments: merged, decisions };
}

function normalizeUserProfile(input = {}) {
  const availability = input.availability === "online" ? "online" : "away";
  return {
    username: String(input.username || "").trim().toLowerCase().slice(0, 30),
    bio: String(input.bio || "").trim().slice(0, 500),
    contact: String(input.contact || "").trim().slice(0, 120),
    email: String(input.email || "").trim().toLowerCase().slice(0, 254),
    availability,
    avatar: String(input.avatar || "").slice(0, 360000),
    updatedAt: input.updatedAt || new Date().toISOString(),
  };
}

function userProfileDecision(input) {
  const p = normalizeUserProfile(input);
  return {
    id: `SYS-PROFILE-${p.username}`,
    date: "",
    topic: p.username,
    rule: JSON.stringify({
      bio: p.bio,
      contact: p.contact,
      email: p.email,
      availability: p.availability,
      avatar: p.avatar,
      updatedAt: p.updatedAt,
    }),
    workstream: USER_PROFILE_WORKSTREAM,
    owner: p.username,
  };
}

function parseUserProfileDecision(row) {
  if (!row || row.workstream !== USER_PROFILE_WORKSTREAM) return null;
  let data = {};
  try { data = JSON.parse(row.rule || "{}"); } catch { /* tolerate bad legacy data */ }
  return normalizeUserProfile({ username: row.owner || row.topic, ...data });
}

function decodeDepartmentIds(raw, primary, departments = DEFAULT_DEPARTMENTS) {
  let values = [];
  if (Array.isArray(raw)) values = raw;
  else if (String(raw || "").trim().startsWith("[")) {
    try { values = JSON.parse(raw); } catch { values = [raw]; }
  } else if (raw) values = [raw];
  if (!values.length && primary) values = [primary];
  return [...new Set(values.map((v) => departmentId(v, departments)).filter(Boolean))];
}

function encodeDepartmentIds(values, departments = DEFAULT_DEPARTMENTS) {
  return JSON.stringify([...new Set((values || []).map((v) => departmentId(v, departments)).filter(Boolean))]);
}

function ownerUsernamesFor(task, users) {
  if (Array.isArray(task.ownerUsernames)) return [...new Set(task.ownerUsernames.filter(Boolean))];
  const hay = String(task.owner || "").toLowerCase();
  return (users || [])
    .filter((u) => u.role !== "client" && u.name && hay.includes(u.name.toLowerCase()))
    .map((u) => u.username);
}

function ownerNames(usernames, users) {
  const wanted = new Set(usernames || []);
  return (users || []).filter((u) => wanted.has(u.username)).map((u) => u.name).join(", ");
}

function encodeTaskSource(meta) {
  return TASK_SOURCE_PREFIX + JSON.stringify({
    label: String(meta.label || "Task Hub").slice(0, 100),
    assignmentMode: ["users", "departments", "whole_team"].includes(meta.assignmentMode)
      ? meta.assignmentMode : "departments",
    createdByUsername: String(meta.createdByUsername || "").slice(0, 30),
    createdByType: meta.createdByType === "client" ? "client" : "team",
  });
}

function parseTaskSource(source) {
  const value = String(source || "");
  if (!value.startsWith(TASK_SOURCE_PREFIX)) return null;
  try { return JSON.parse(value.slice(TASK_SOURCE_PREFIX.length)); }
  catch { return null; }
}

function enrichTask(task, users, departments) {
  const sourceMeta = parseTaskSource(task.source) || {};
  const ownerUsernames = ownerUsernamesFor(task, users);
  const departmentIds = decodeDepartmentIds(task.assignedDept, task.department, departments);
  const creator = (users || []).find((u) =>
    u.username === task.createdByUsername || u.username === sourceMeta.createdByUsername ||
    (u.name && u.name === task.requestedBy)
  );
  const assignmentMode = task.assignmentMode || sourceMeta.assignmentMode ||
    (ownerUsernames.length ? "users" : departmentIds.length ? "departments" : "whole_team");
  return {
    ...task,
    source: sourceMeta.label || task.source,
    owner: ownerNames(ownerUsernames, users) || task.owner,
    ownerUsernames,
    departmentIds,
    assignmentMode,
    createdByUsername: task.createdByUsername || sourceMeta.createdByUsername || (creator && creator.username) || "",
    createdByType: task.createdByType || sourceMeta.createdByType || (creator && creator.role === "client" ? "client" : "team"),
  };
}

function encodeTaskEvent(kind, data) {
  return TASK_EVENT_PREFIX + JSON.stringify({ kind, ...data });
}

function parseTaskEvent(text) {
  const value = String(text || "");
  if (!value.startsWith(TASK_EVENT_PREFIX)) return null;
  try { return JSON.parse(value.slice(TASK_EVENT_PREFIX.length)); }
  catch { return null; }
}

function composeTaskEvents(task) {
  const comments = new Map();
  const subtasks = new Map();
  let approval = null;
  const updates = [];
  for (const update of task.updates || []) {
    const event = parseTaskEvent(update.text);
    if (!event) {
      updates.push(update);
      continue;
    }
    if (event.kind === "comment") {
      comments.set(event.id, { ...event, ts: event.ts || update.ts, by: event.by || update.by });
    } else if (event.kind === "comment_delete") {
      const current = comments.get(event.commentId);
      if (current) comments.set(event.commentId, {
        ...current,
        text: "",
        mentions: [],
        deleted: true,
        deletedAt: event.ts || update.ts,
      });
    } else if (event.kind === "subtask_upsert") {
      const current = subtasks.get(event.subtask.id) || {};
      subtasks.set(event.subtask.id, { ...current, ...event.subtask });
    } else if (event.kind === "subtask_delete") {
      subtasks.delete(event.subtaskId);
    } else if (event.kind === "approval") {
      approval = { ...event, ts: event.ts || update.ts, by: event.by || update.by };
    }
  }
  return {
    ...task,
    updates,
    comments: [...comments.values()].sort((a, b) => String(a.ts).localeCompare(String(b.ts))),
    subtasks: [...subtasks.values()].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))),
    approval,
  };
}

function encodeFileMeta(meta) {
  return FILE_META_PREFIX + JSON.stringify(meta || {});
}

function parseFileMeta(note) {
  const value = String(note || "");
  if (!value.startsWith(FILE_META_PREFIX)) return null;
  try { return JSON.parse(value.slice(FILE_META_PREFIX.length)); }
  catch { return null; }
}

module.exports = {
  DEFAULT_DEPARTMENTS,
  DEPARTMENT_WORKSTREAM,
  TASK_EVENT_PREFIX,
  FILE_META_PREFIX,
  TASK_SOURCE_PREFIX,
  USER_PROFILE_WORKSTREAM,
  slugify,
  departmentId,
  normalizeDepartment,
  departmentDecision,
  parseDepartmentDecision,
  splitDepartmentRecords,
  normalizeUserProfile,
  userProfileDecision,
  parseUserProfileDecision,
  decodeDepartmentIds,
  encodeDepartmentIds,
  ownerUsernamesFor,
  ownerNames,
  encodeTaskSource,
  parseTaskSource,
  enrichTask,
  encodeTaskEvent,
  parseTaskEvent,
  composeTaskEvents,
  encodeFileMeta,
  parseFileMeta,
};
