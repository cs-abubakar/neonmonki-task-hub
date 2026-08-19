/* ============================================================
   NEONMONKI Task Hub — SPA (vanilla JS, no build step)
   ============================================================ */
"use strict";

/* ------------------------------ helpers ------------------------------ */

const $ = (sel, el) => (el || document).querySelector(sel);

const esc = (s) =>
  String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function fmtDate(s) {
  if (!s) return "—";
  const d = new Date(s.length === 10 ? s + "T00:00:00" : s);
  if (isNaN(d)) return esc(s);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

function timeAgo(ts) {
  const d = new Date(ts);
  if (isNaN(d)) return "";
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return Math.floor(diff / 60) + "m ago";
  if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
  if (diff < 7 * 86400) return Math.floor(diff / 86400) + "d ago";
  return fmtDate(ts);
}

function aiInline(text) {
  return esc(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

function renderAiBrief(text) {
  const lines = String(text || "").split(/\r?\n/);
  const sectionIcons = {
    "status overview": "◉", "needs attention": "⚡", "what you moved": "↗",
    "standing decisions": "✓", "what's next": "→", "what’s next": "→",
    "at a glance": "◉", "progress": "↗", "communication & decisions": "💬",
    "risks / blockers": "⚠", "next actions": "→",
  };
  let html = "";
  let list = "";
  let sectionOpen = false;
  const closeList = () => { if (list) { html += `</${list}>`; list = ""; } };
  const closeSection = () => { closeList(); if (sectionOpen) { html += "</section>"; sectionOpen = false; } };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { closeList(); continue; }
    const h1 = line.match(/^#\s+(.+)/);
    const h2 = line.match(/^##\s+(.+)/);
    const bullet = line.match(/^[-*]\s+(.+)/);
    const numbered = line.match(/^\d+[.)]\s+(.+)/);
    if (h1) {
      closeSection();
      html += `<div class="ai-brief-hero"><div class="ai-brief-kicker">Your workspace briefing</div><h3>${aiInline(h1[1])}</h3></div>`;
    } else if (h2) {
      closeSection();
      const title = h2[1].replace(/\s*\([^)]*\)\s*$/, "");
      const icon = sectionIcons[title.toLowerCase()] || "◆";
      html += `<section class="ai-brief-section"><h4><span>${icon}</span>${aiInline(h2[1])}</h4>`;
      sectionOpen = true;
    } else if (bullet) {
      if (list !== "ul") { closeList(); html += '<ul class="ai-brief-list">'; list = "ul"; }
      html += `<li>${aiInline(bullet[1])}</li>`;
    } else if (numbered) {
      if (list !== "ol") { closeList(); html += '<ol class="ai-brief-list numbered">'; list = "ol"; }
      html += `<li>${aiInline(numbered[1])}</li>`;
    } else {
      closeList();
      html += `<p>${aiInline(line)}</p>`;
    }
  }
  closeSection();
  return `<div class="ai-brief-ui">${html || `<p>${aiInline(text)}</p>`}</div>`;
}

const statusClass = (s) => "status-" + String(s || "").replace(/[^a-zA-Z]/g, "");
const prioClass = (p) => "prio-" + String(p || "").replace(/[^a-zA-Z]/g, "");
const visBadge = (t) =>
  t.visibility === "internal" || t.visibility === "team"
    ? `<span class="pill status-Backlog" title="Team only — hidden from client accounts">🔒 team</span>`
    : t.visibility === "department"
      ? `<span class="pill status-Planned" title="Only assigned departments">◉ department</span>`
    : t.visibility === "private"
      ? `<span class="pill status-NewRequest" title="Private — only the assignee + admin">👤 private</span>`
      : "";

function departments(activeOnly = true) {
  const all = (S.data && S.data.departments) || [];
  return activeOnly ? all.filter((d) => d.active !== false) : all;
}

function deptById(id) {
  return departments(false).find((d) => d.id === id || d.name === id) || null;
}

function taskDepartmentIds(task) {
  return (task.departmentIds && task.departmentIds.length)
    ? task.departmentIds
    : departments(false).filter((d) => d.name === task.department).map((d) => d.id);
}

function departmentSignals(task, labels = true) {
  const ids = taskDepartmentIds(task);
  if (!ids.length) return `<span class="dept-signal neutral">◆${labels ? ` ${esc(task.department || "Unassigned")}` : ""}</span>`;
  return `<span class="dept-signals">${ids.map((id) => {
    const d = deptById(id) || { name: id, color: "#64748b", icon: "◆" };
    return `<span class="dept-signal" style="--dept:${esc(d.color)}" title="${esc(d.name)}"><i>${esc(d.icon)}</i>${labels ? `<b>${esc(d.name)}</b>` : ""}</span>`;
  }).join("")}</span>`;
}

function taskOriginBadge(task) {
  return task.createdByType === "client"
    ? `<span class="origin-badge client-origin" title="Created by NEONMONKI">NM request</span>`
    : `<span class="origin-badge team-origin" title="Created by the delivery team">Team task</span>`;
}

function teamUsers() {
  return (S.directory || []).filter((u) => u.active !== false && u.username !== "advertidea"
    && (u.role === "team" || u.role === "super_admin"));
}

function selectedValues(form, name) {
  return [...form.querySelectorAll(`[name="${name}"]:checked`)].map((el) => el.value);
}

async function api(path, method, body) {
  const res = await fetch(path, {
    method: method || "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    // session expired mid-use → back to login (but not during the boot /me probe or login itself)
    if (res.status === 401 && !path.endsWith("/login") && !path.endsWith("/me")) { location.reload(); }
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function toast(msg, kind) {
  let box = $(".toasts");
  if (!box) {
    box = document.createElement("div");
    box.className = "toasts";
    document.body.appendChild(box);
  }
  const el = document.createElement("div");
  el.className = "toast " + (kind === "err" ? "err" : kind === "warn" ? "warn" : "ok");
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

/* ------------------------------ icons ------------------------------ */

const I = {
  dashboard: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>',
  board: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 4v13M12 4v9M19 4v16"/></svg>',
  calendar: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/><path d="M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01"/></svg>',
  tasks: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 5.5l1 1L7 4.5M4 11.5l1 1 2-2M4 17.5l1 1 2-2"/></svg>',
  deliverables: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8l-9-5-9 5v8l9 5 9-5V8z"/><path d="M3.3 8.3L12 13l8.7-4.7M12 13v9"/></svg>',
  decisions: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8.5 12.5l2.5 2.5 4.5-5.5"/></svg>',
  recurring: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 11-2.6-6.4"/><path d="M21 3v6h-6"/></svg>',
  docs: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 007.5.5l3-3a5 5 0 00-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 00-7.5-.5l-3 3a5 5 0 007 7L12.2 19"/></svg>',
  team: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.2 3.4-5 6.5-5s5.7 1.8 6.5 5"/><circle cx="17.5" cy="9" r="2.5"/><path d="M16 15.3c2.6.3 4.7 1.9 5.5 4.7"/></svg>',
  plus: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  logout: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H6a2 2 0 01-2-2V5a2 2 0 012-2h3"/><path d="M16 17l5-5-5-5M21 12H9"/></svg>',
  ext: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><path d="M15 3h6v6M10 14L21 3"/></svg>',
  clock: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  alert: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/></svg>',
  chat: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 01-8.5 8.4c-1.5 0-2.9-.35-4.1-1L3 20l1.2-5.2a8.3 8.3 0 01-1.2-4.3A8.4 8.4 0 0111.5 2h.5a8.4 8.4 0 019 9.5z"/></svg>',
  bell: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 01-3.4 0"/></svg>',
  files: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 012-2h4l2 2.5h8a2 2 0 012 2V17a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/></svg>',
  search: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>',
  admin: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33h.01a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51h.01a1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82v.01a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>',
  mute: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 01-3.4 0"/><line x1="4" y1="4" x2="20" y2="20"/></svg>',
  send: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/></svg>',
  key: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.8 12.2L21 2m-4 2l3 3m-6 0l3 3"/></svg>',
  taskChip: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 2v4M16 2v4M3 10h18"/></svg>',
  sparkle: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z"/><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15z"/></svg>',
  results: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v16a2 2 0 002 2h16"/><path d="M7 14l4-4 3 3 5-6"/></svg>',
  report: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6M9 13h6M9 17h4"/></svg>',
  copy: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>',
};

/* ------------------------------ state ------------------------------ */

const S = {
  me: null,          // { username, role, name, org }
  data: null,        // { tasks, deliverables, decisions, recurring, team, links, activity, meta }
  route: "dashboard",
  openTaskId: null,
  modal: null,       // 'newTask' | 'deliverable' | 'decision' | 'link' | 'editTask' | 'acceptTask' | 'password' | 'addUser' | 'newChannel' | 'channelMembers' | 'reportForm' | 'generateReport'
  filters: { q: "", status: "", department: "", priority: "", owner: "", scope: "", dateField: "due", dateFrom: "", dateTo: "", range: "all" },
  boardFilters: { department: "", priority: "", owner: "", dateField: "due", dateFrom: "", dateTo: "", range: "all" },
  calendar: { cursor: new Date().toISOString().slice(0, 7) + "-01", scope: "mine", department: "" },
  taskFilterOrigin: "",
  chat: { channels: [], openId: null, messages: [], channelInfo: null, replyToId: null, draft: "", mentionOpen: false, mentionQuery: "", mentionIndex: 0, mentionStart: null, highlightId: null, messageMenuId: null },
  search: { q: "", type: "all", results: null, loading: false, error: "", answer: null, answerLoading: false },
  pulse: { unread: {}, chatTotal: 0, notifications: 0, notificationSignals: [] },
  notifs: { items: [], open: false },
  admin: { users: [], channels: [], departments: [] },
  taskDraft: null,   // prefill for the new-task modal (e.g. from a chat message)
  fileFolder: "all", // selected folder on the Files page
  ai: null,          // /api/ai/status result
  aiAnswer: null,    // last Monki response { answer, citations, drafts, question }
  aiBusy: false,
  monki: { open: false, draft: "", messages: [] },
  aiControl: null,   // admin control-center payload
  directory: [],     // active users (for pickers)
  profileAvatarDraft: null,
  visitBaseline: undefined, // lastVisit captured at session start (stable for "since your last visit")
  reports: { items: null, loading: false, loaded: false, error: "" }, // Reports library page
  reportDraft: null,   // add/edit report modal draft { kind, periodMonth, title, description, links:[{label,url}] }
  reportEditId: null,  // set when the report modal edits an existing entry (null = adding)
  reportBusy: false,   // report library save in flight
  reportGen: {         // Generate Report modal (super reporting tier)
    audience: "internal", preset: "last_30", customFrom: "", customTo: "",
    busy: false, error: "", result: null,
  },
  reporting: {       // Smart Reporting — Hyros-backed dashboards (advanced/super tiers; the API grants per user)
    allowed: false,  // set by the /api/reporting/status probe (403/404 → nav hidden)
    probed: false, probing: false, status: null,
    range: "last_7", customFrom: "", customTo: "", cmp: "previous", granularity: "auto",
    channel: "", platform: "", source: "", campaign: "",
    metric: "revenue", mixDimension: "source",
    overview: null, trend: null, cmpTrend: null, channels: null, mix: null, campaigns: null, activity: null,
    loading: false, loaded: false, error: "", req: 0,
    tableSort: "spend", tableDir: -1, tableQ: "",
    dismissedInsights: [], manualOpen: false,
    justLoaded: false, // one-shot flag: run entrance motion (count-up/draw-in) after a fresh load
  },
  reportingBasic: {  // Performance — the calm, client-safe basic reporting page
    allowed: false,  // set by the /api/reporting/basic probe (401/403 → nav hidden)
    probed: false, probing: false,
    range: "last_30", // one of PERF_RANGE_OPTIONS
    data: null, loading: false, loaded: false, error: "", req: 0,
  },
  integrations: { hyros: undefined, loading: false, busy: false, notice: "", error: "" },
};

const isClient = () => S.me && S.me.role === "client";
const isTeam = () => S.me && (S.me.role === "team" || S.me.role === "super_admin");
const isAdmin = () => S.me && S.me.role === "super_admin";
function canAccessRoute(route) {
  if (!PAGE_META[route]) return false;
  if (["admin", "aicontrol"].includes(route)) return isAdmin();
  if (["mywork", "team"].includes(route)) return isTeam();
  if (route === "approvals") return isClient();
  if (route === "smartreporting") return S.reporting.allowed === true; // Smart Reporting: advanced/super tier, granted per user and enforced by the API
  // Performance is the basic tier — hidden from users with full Smart Reporting (owner sees that instead)
  if (route === "performance") return S.reportingBasic.allowed === true && S.reporting.allowed !== true;
  return true;
}

function ensureAllowedRoute() {
  if (canAccessRoute(S.route)) return;
  S.route = "dashboard";
  S.openTaskId = null;
  history.replaceState(null, "", "#/dashboard");
}
/** Is AI usable by me right now, for this feature? */
const aiOn = (feature) =>
  !!(S.ai && S.ai.enabled && S.ai.allowedForMe && (!feature || S.ai.features[feature] !== false));

const OPEN_STATUSES = ["New Request","Backlog","Planned","In Progress","Ready / Waiting","Waiting on Client","Waiting on Internal","Waiting on External","Ready for Review","Revision Required"];
const isOpen = (t) => !["Completed", "Cancelled"].includes(t.status);
const lastTs = (t) => (t.updates && t.updates.length ? t.updates[t.updates.length - 1].ts : t.dateRequested);

const BOARD_COLS = [
  { key: "new", label: "New Requests", statuses: ["New Request"], dropStatus: "New Request" },
  { key: "planned", label: "Planned", statuses: ["Backlog", "Planned"], dropStatus: "Planned" },
  { key: "progress", label: "In Progress", statuses: ["In Progress"], dropStatus: "In Progress" },
  { key: "waiting", label: "Waiting", statuses: ["Ready / Waiting", "Waiting on Client", "Waiting on Internal", "Waiting on External"], dropStatus: "Waiting on Internal" },
  { key: "review", label: "Ready for Review", statuses: ["Ready for Review", "Revision Required"], dropStatus: "Ready for Review" },
  { key: "done", label: "Done", statuses: ["Completed", "Cancelled"], dropStatus: "Completed" },
];

function localISODate(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function taskBelongsToMe(task) {
  return (task.ownerUsernames || []).includes(S.me.username)
    || task.privateFor === S.me.username
    || task.createdByUsername === S.me.username
    || task.requestedBy === S.me.name
    || (isClient() && (task.status === "Waiting on Client" || (task.approval && task.approval.status === "awaiting_review")));
}

function taskDateValue(task, field) {
  if (field === "created") return String(task.dateRequested || "").slice(0, 10);
  if (field === "updated") return String(lastTs(task) || "").slice(0, 10);
  return String(task.dueDate || "").slice(0, 10);
}

function rangeBounds(range) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  const end = new Date(today);
  if (range === "overdue") { end.setDate(end.getDate() - 1); return { from: "", to: localISODate(end) }; }
  if (range === "this_week") {
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    end.setTime(start.getTime()); end.setDate(end.getDate() + 6);
  } else if (range === "next_7") end.setDate(end.getDate() + 6);
  else if (range === "next_30") end.setDate(end.getDate() + 29);
  else if (range === "this_month") {
    start.setDate(1);
    end.setMonth(end.getMonth() + 1, 0);
  } else return { from: "", to: "" };
  return { from: localISODate(start), to: localISODate(end) };
}

function inDateRange(task, filters) {
  if (!filters.dateFrom && !filters.dateTo) return true;
  const value = taskDateValue(task, filters.dateField || "due");
  if (!value) return false;
  if (filters.dateFrom && value < filters.dateFrom) return false;
  if (filters.dateTo && value > filters.dateTo) return false;
  return true;
}

function rangeOptions(selected) {
  const options = [
    ["all", "All dates"], ["overdue", "Overdue"], ["this_week", "This week"],
    ["next_7", "Next 7 days"], ["next_30", "Next 30 days"], ["this_month", "This month"], ["custom", "Custom range"],
  ];
  return options.map(([value, label]) => `<option value="${value}" ${selected === value ? "selected" : ""}>${label}</option>`).join("");
}

/* ------------------------------ data ------------------------------ */

async function loadState(quiet) {
  try {
    S.data = await api("/api/state");
    // The server re-stamps the visit on every /api/state call, so pin the
    // first stamp we see this session — the change feed must not shrink
    // while the user is reading it (background syncs run every 60s).
    if (S.visitBaseline === undefined) S.visitBaseline = S.data.lastVisit || null;
    if (quiet) {
      // background sync: never clobber an open modal or an in-progress edit
      const ae = document.activeElement;
      const typing = ae && ["TEXTAREA", "INPUT", "SELECT"].includes(ae.tagName);
      if (S.modal || typing) return;
    }
    // quiet re-render: keep an open (but blurred) composer draft + drawer scroll
    const keep = quiet ? stashLiveInput() : null;
    renderApp();
    if (keep) restoreLiveInput(keep);
  } catch (e) {
    if (!S.data) {
      document.getElementById("app").innerHTML =
        `<div class="login-wrap"><div class="login-card"><div class="login-error">Could not load workspace: ${esc(e.message)}</div></div></div>`;
    }
  }
}

/* capture/restore in-progress composer text + drawer scroll across re-renders */
function stashLiveInput() {
  const st = {};
  const ta = document.getElementById("update-text");
  if (ta && ta.value) st.composer = ta.value;
  const ci = document.getElementById("chat-input");
  if (ci && ci.value) st.chatComposer = ci.value;
  const body = document.querySelector(".drawer-body");
  if (body && body.scrollTop) st.drawerScroll = body.scrollTop;
  return st;
}
function restoreLiveInput(st) {
  if (st.composer) {
    const ta = document.getElementById("update-text");
    if (ta) ta.value = st.composer;
  }
  if (st.chatComposer) {
    const ci = document.getElementById("chat-input");
    if (ci) ci.value = st.chatComposer;
  }
  if (st.drawerScroll) {
    const body = document.querySelector(".drawer-body");
    if (body) body.scrollTop = st.drawerScroll;
  }
}

/* re-render without clobbering an open modal or a field being typed in */
function guardedRender() {
  const ae = document.activeElement;
  const typing = ae && ["TEXTAREA", "INPUT", "SELECT"].includes(ae.tagName);
  if (S.modal || typing) return;
  const keep = stashLiveInput();
  renderApp();
  restoreLiveInput(keep);
}

/* ------------------------------ notification tone ------------------------------ */

let audioCtx = null;
function unlockAudio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
  } catch { /* no audio */ }
}
const TONE_PATTERNS = {
  message: { wave: "sine", notes: [[659.3, 0, .16], [880, .08, .18]], gain: .08 },
  mention: { wave: "triangle", notes: [[987.8, 0, .12], [1318.5, .07, .13], [1568, .14, .18]], gain: .09 },
  newTask: { wave: "sine", notes: [[523.3, 0, .2], [659.3, .12, .2], [784, .24, .26]], gain: .1 },
  assignment: { wave: "square", notes: [[740, 0, .09], [740, .13, .09], [987.8, .27, .2]], gain: .045 },
  approval: { wave: "triangle", notes: [[659.3, 0, .18], [987.8, .11, .2], [1318.5, .23, .3]], gain: .075 },
  task: { wave: "sine", notes: [[587.3, 0, .16], [784, .1, .22]], gain: .075 },
};

function toneForNotification(kind) {
  if (kind === "mention") return "mention";
  if (kind === "new_task") return "newTask";
  if (kind === "subtask") return "assignment";
  if (["approval", "delivery", "delivery_review"].includes(kind)) return "approval";
  if (["chat", "task_comment"].includes(kind)) return "message";
  return "task";
}

function playTone(kind = "message") {
  unlockAudio();
  if (!audioCtx) return;
  try {
    const t = audioCtx.currentTime;
    const pattern = TONE_PATTERNS[kind] || TONE_PATTERNS.message;
    pattern.notes.forEach(([f, off, duration]) => {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = pattern.wave;
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + off);
      g.gain.exponentialRampToValueAtTime(pattern.gain, t + off + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + off + duration);
      o.connect(g);
      g.connect(audioCtx.destination);
      o.start(t + off);
      o.stop(t + off + duration + .03);
    });
  } catch { /* ignore */ }
}
window.addEventListener("pointerdown", unlockAudio);

/* ------------------------------ login ------------------------------ */

function renderLogin() {
  document.getElementById("app").innerHTML = `
  <div class="login-wrap">
    <span class="login-glow login-glow-neon" aria-hidden="true"></span>
    <span class="login-glow login-glow-violet" aria-hidden="true"></span>
    <main class="login-shell">
      <section class="login-story" aria-label="NEONMONKI and AdvertIdea collaboration">
        <div class="collab-lockup">
          <span class="partner-wordmark neonmonki-wordmark">NEONMONKI</span>
          <span class="together-mark" aria-label="together">
            <i></i><i></i><b>×</b>
          </span>
          <span class="partner-wordmark advertidea-wordmark">ADVERTIDEA</span>
        </div>
        <div class="login-eyebrow"><span></span> ONE SHARED WORKSPACE</div>
        <h1>Two teams.<br><em>One flow.</em></h1>
        <p class="login-story-copy">Where NEONMONKI's vision and AdvertIdea's delivery move together—from request to result, with every decision in view.</p>
        <div class="collab-principles">
          <div><span>01</span><b>Plan together</b><small>One source of truth</small></div>
          <div><span>02</span><b>Work visibly</b><small>Clear ownership</small></div>
          <div><span>03</span><b>Deliver better</b><small>Shared momentum</small></div>
        </div>
        <div class="login-builder"><span>◆</span> System designed &amp; built by <b>Abu Bakar</b></div>
      </section>
      <section class="login-card">
        <div class="login-card-mark"><span>NM</span><i></i><span>AD</span></div>
        <div class="login-kicker">PRIVATE COLLABORATION PORTAL</div>
        <h2>Welcome back</h2>
        <p class="login-sub">Enter the username and password provided by your workspace administrator.</p>
        <form onsubmit="App.login(event)">
          <label for="login-username">USERNAME</label>
          <div class="login-input-wrap">
            <span aria-hidden="true">@</span>
            <input name="username" id="login-username" autocomplete="username" autocapitalize="none" spellcheck="false" required placeholder="Enter your username">
          </div>
          <label for="login-password">PASSWORD</label>
          <div class="login-input-wrap">
            <span aria-hidden="true">●</span>
            <input name="password" id="login-password" type="password" autocomplete="current-password" required placeholder="Enter your password">
          </div>
          <button class="login-btn" type="submit"><span>Enter workspace</span><b aria-hidden="true">→</b></button>
          <div id="login-error" aria-live="polite"></div>
        </form>
        <div class="login-foot"><span>●</span> Secure access · accounts are managed by the super admin</div>
      </section>
    </main>
  </div>`;
}

/* ------------------------------ shell ------------------------------ */

const NAV = [
  { section: "Work" },
  { route: "dashboard", label: "Dashboard", icon: "dashboard" },
  { route: "performance", label: "Performance", icon: "results", performanceOnly: true },
  { route: "smartreporting", label: "Smart Reporting", icon: "results", reportingOnly: true },
  { route: "search", label: "Search", icon: "search" },
  { route: "chat", label: "Chat", icon: "chat", chatBadge: true },
  { route: "board", label: "Board", icon: "board", badge: true },
  { route: "calendar", label: "Calendar", icon: "calendar" },
  { route: "mywork", label: "Department Tasks", icon: "tasks", teamOnly: true },
  { route: "approvals", label: "My Approvals", icon: "decisions", clientOnly: true },
  { route: "tasks", label: "All Tasks", icon: "tasks" },
  { section: "Records" },
  { route: "reports", label: "Reports", icon: "files" },
  { route: "deliverables", label: "Deliverables", icon: "deliverables" },
  { route: "decisions", label: "Decisions & Rules", icon: "decisions" },
  { route: "recurring", label: "Recurring Work", icon: "recurring" },
  { route: "files", label: "Files", icon: "files" },
  { section: "People" },
  { route: "profile", label: "My Profile", icon: "team" },
  { route: "team", label: "Team", icon: "team", teamOnly: true },
  { route: "admin", label: "Admin", icon: "admin", adminOnly: true },
  { route: "aicontrol", label: "AI Control", icon: "sparkle", adminOnly: true },
];

const PAGE_META = {
  dashboard: ["Dashboard", "What is happening across the NEONMONKI account right now"],
  performance: ["Performance", "Your marketing results at a glance"],
  smartreporting: ["Smart Reporting", "Attribution, channel performance and trends across every channel"],
  reports: ["Reports", "Weekly, monthly and special reports — every delivered report in one library"],
  search: ["Search", "Find tasks, shared links and communication you have permission to see"],
  chat: ["Chat", "Channels per service line — turn any message into a task"],
  board: ["Board", "Drag tasks between stages and focus the board by owner, department or date"],
  calendar: ["Calendar", "Due dates across your tasks, departments and visible workspace"],
  mywork: ["Department Tasks", "Tasks assigned to you and every department you belong to"],
  approvals: ["My Approvals", "Work delivered to you and waiting for approval or feedback"],
  tasks: ["All Tasks", "Full task register from the master sheet, live"],
  deliverables: ["Deliverables", "Everything delivered to NEONMONKI, with links"],
  decisions: ["Decisions & Rules", "Binding decisions made on calls and in chat"],
  recurring: ["Recurring Work", "Weekly / monthly / ongoing commitments"],
  files: ["Files", "Project documents organized by channel and workstream"],
  team: ["Team", "Who owns what on the Advertidea side"],
  profile: ["My Profile", "Contact details, picture and today’s availability"],
  admin: ["Admin", "Users, passwords and channel management — super admin only"],
  aicontrol: ["AI Control Center", "Private engine, features, limits, usage and audit — super admin only"],
};

function attentionCount() {
  if (!S.data) return 0;
  if (isTeam()) return S.data.tasks.filter((t) => t.status === "New Request" || t.status === "Revision Required").length;
  return S.data.tasks.filter((t) => t.status === "Ready for Review" || t.status === "Waiting on Client").length;
}

function renderApp() {
  if (!S.me) return renderLogin();
  if (!S.data) return;
  const route = S.route;
  const [title, crumb] = PAGE_META[route] || PAGE_META.dashboard;
  const badge = attentionCount();
  const chatBadge = S.pulse.chatTotal || 0;
  const notifCount = S.pulse.notifications || 0;

  document.getElementById("app").innerHTML = `
  <div class="shell">
    <aside class="sidebar">
      <div class="brand">
        <img class="brand-mark" src="/neonmonki-retro.svg" alt="NEONMONKI">
        <div>
          <div class="brand-name">NEONMONKI</div>
          <div class="brand-sub">WORKSPACE // 86</div>
        </div>
      </div>
      <nav class="nav">
        ${NAV.map((n) => {
          if (n.section) return `<div class="nav-section">${n.section}</div>`;
          if (n.adminOnly && !isAdmin()) return "";
          if (n.teamOnly && !isTeam()) return "";
          if (n.clientOnly && !isClient()) return "";
          if (n.reportingOnly && !S.reporting.allowed) return "";
          if (n.performanceOnly && (!S.reportingBasic.allowed || S.reporting.allowed === true)) return "";
          if (n.aiFeature && !aiOn(n.aiFeature)) return "";
          return `<button class="nav-item ${route === n.route ? "active" : ""}" onclick="App.nav('${n.route}')">
            ${I[n.icon]}<span>${n.label}</span>
            ${n.badge && badge ? `<span class="nav-badge ${isTeam() ? "neon" : ""}">${badge}</span>` : ""}
            ${n.chatBadge && chatBadge ? `<span class="nav-badge neon">${chatBadge > 99 ? "99+" : chatBadge}</span>` : ""}
          </button>`;
        }).join("")}
      </nav>
      <div class="system-signature"><span>◆</span><small>System by</small><b>Abu Bakar</b></div>
      <div class="sidebar-user" onclick="App.nav('profile')" role="button" tabindex="0">
        ${personAvatar(S.me, `avatar ${isClient() ? "client" : "team"}`)}
        <div class="who">
          <div class="n">${esc(S.me.name)} <i class="presence-dot ${(S.me.profile || {}).availability === "online" ? "online" : "away"}"></i></div>
          <div class="r">${(S.me.profile || {}).availability === "online" ? "Online · available" : "Away"}</div>
        </div>
      </div>
    </aside>
    <div class="main">
      <div class="topbar">
        <div>
          <h1>${title}</h1>
          <div class="crumb">${crumb}</div>
        </div>
        <button class="global-search-trigger" onclick="App.openSearch()" aria-label="Search workspace">
          ${I.search}<span>Search tasks, links and messages</span><kbd>⌘ K</kbd>
        </button>
        <div class="topbar-spacer"></div>
        <div class="bell-wrap">
          <button class="bell-btn" onclick="App.toggleNotifs(event)" title="Notifications">
            ${I.bell}
            ${notifCount ? `<span class="bell-count">${notifCount > 99 ? "99+" : notifCount}</span>` : ""}
          </button>
          ${S.notifs.open ? renderNotifPanel() : ""}
        </div>
        <button class="btn primary newtask-btn" title="New Task" aria-label="New Task" onclick="App.openModal('newTask')">${I.plus}<span class="nt-label">New Task</span></button>
      </div>
      <div class="content" id="content"></div>
    </div>
  </div>
  ${aiOn("ask") ? renderMonkiWidget() : ""}
  <div class="drawer-overlay ${S.openTaskId ? "open" : ""}" onclick="App.closeDrawer()"></div>
  <div class="drawer ${S.openTaskId ? "open" : ""}" id="drawer"></div>
  <div id="modal-root"></div>`;

  renderPage(route);
  if (S.openTaskId) renderDrawer();
  if (S.modal) renderModal();
}

function initials(name) {
  return name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
}

function personAvatar(person, className = "avatar") {
  const profile = (person && person.profile) || {};
  return profile.avatar
    ? `<div class="${className} image-avatar"><img src="${esc(profile.avatar)}" alt="${esc(person.name || "Profile")}"></div>`
    : `<div class="${className}">${esc(initials((person && person.name) || "?"))}</div>`;
}

function renderPage(route) {
  const el = document.getElementById("content");
  if (!el) return;
  switch (route) {
    case "dashboard": el.innerHTML = viewDashboard(); break;
    case "performance": renderPerformance(el); break;
    case "smartreporting": renderSmartReporting(el); break;
    case "reports": renderReports(el); break;
    case "search": renderSearch(el); break;
    case "chat": renderChat(el); break;
    case "board": el.innerHTML = viewBoard(); break;
    case "calendar": el.innerHTML = viewCalendar(); break;
    case "mywork": el.innerHTML = viewMyWork(); break;
    case "approvals": el.innerHTML = viewApprovals(); break;
    case "tasks": el.innerHTML = viewTasks(); break;
    case "deliverables": el.innerHTML = viewDeliverables(); break;
    case "decisions": el.innerHTML = viewDecisions(); break;
    case "recurring": el.innerHTML = viewRecurring(); break;
    case "files": el.innerHTML = viewFiles(); break;
    case "team": el.innerHTML = viewTeam(); break;
    case "profile": el.innerHTML = viewProfile(); break;
    case "admin": renderAdmin(el); break;
    case "aicontrol": renderAiControl(el); break;
  }
}

/* ------------------------------ dashboard ------------------------------ */

const PRIO_RANK = { Critical: 0, High: 1, Medium: 2, Low: 3 };

function taskDueISO(t) {
  return String(t.dueDate || "").slice(0, 10);
}

function isOverdueOpen(t) {
  const due = taskDueISO(t);
  return !!(isOpen(t) && due && due < localISODate());
}

function isStaleOpen(t, days = 14) {
  if (!isOpen(t)) return false;
  const ts = new Date(lastTs(t)).getTime();
  return !isNaN(ts) && Date.now() - ts > days * 864e5;
}

/* how many calendar days until the due date (negative = overdue) */
function dueDaysLeft(t) {
  const due = taskDueISO(t);
  if (!due) return null;
  const delta = new Date(due + "T00:00:00").getTime() - new Date(localISODate() + "T00:00:00").getTime();
  return Math.round(delta / 864e5);
}

function dueCountdownLabel(t) {
  const days = dueDaysLeft(t);
  if (days === null) return "";
  if (days < 0) return `${Math.abs(days)}d overdue`;
  if (days === 0) return "due today";
  if (days === 1) return "due tomorrow";
  return `${days} days left`;
}

/* everything that moved on visible tasks since the user's previous visit */
function changesSinceLastVisit() {
  const baseline = S.visitBaseline !== undefined ? S.visitBaseline : (S.data && S.data.lastVisit);
  const lv = baseline ? new Date(baseline).getTime() : NaN;
  if (isNaN(lv)) return { known: false, items: [] };
  const items = [];
  for (const t of S.data.tasks) {
    const created = new Date(taskDateValue(t, "created") + "T00:00:00").getTime();
    if (!isNaN(created) && created > lv) items.push({ ts: taskDateValue(t, "created"), kind: "new", t });
    for (const u of t.updates || []) {
      const ts = new Date(u.ts).getTime();
      if (!isNaN(ts) && ts > lv) items.push({ ts: u.ts, kind: u.statusTo ? "status" : "update", t, by: u.by, statusTo: u.statusTo });
    }
    for (const c of t.comments || []) {
      if (c.deleted) continue;
      const ts = new Date(c.ts).getTime();
      if (!isNaN(ts) && ts > lv) items.push({ ts: c.ts, kind: "comment", t, by: c.by });
    }
    if (t.approval && t.approval.ts && new Date(t.approval.ts).getTime() > lv) {
      items.push({ ts: t.approval.ts, kind: "approval", t, approvalStatus: t.approval.status });
    }
  }
  items.sort((a, b) => new Date(b.ts) - new Date(a.ts));
  return { known: true, items };
}

/* open tasks due within the next `days` days, soonest first */
function upcomingTasks(days = 14) {
  const today = localISODate();
  const end = localISODate(new Date(Date.now() + (days - 1) * 864e5));
  return S.data.tasks
    .filter((t) => {
      const due = taskDueISO(t);
      return isOpen(t) && due && due >= today && due <= end;
    })
    .sort((a, b) => taskDueISO(a).localeCompare(taskDueISO(b)) || (PRIO_RANK[a.priority] ?? 9) - (PRIO_RANK[b.priority] ?? 9));
}

/* per-department health: at risk = any overdue open task, or any open task stale >14d */
function areaHealth() {
  return departments().map((d) => {
    const openTasks = S.data.tasks.filter((t) => isOpen(t) && taskDepartmentIds(t).includes(d.id));
    const overdue = openTasks.filter(isOverdueOpen).length;
    const stale = openTasks.filter((t) => !isOverdueOpen(t) && isStaleOpen(t)).length;
    return { d, open: openTasks.length, overdue, stale, atRisk: overdue + stale > 0 };
  }).sort((a, b) => Number(b.atRisk) - Number(a.atRisk) || b.open - a.open || (a.d.order || 0) - (b.d.order || 0));
}

function dashHero(decisionCount, nextCount, areas, criticalCount) {
  const firstName = esc((S.me.name || "there").split(" ")[0]);
  const todayLabel = new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
  const onTrack = areas.filter((a) => !a.atRisk).length;
  const chip = (id, value, label, tone) => `
    <button class="dash-chip ${tone || ""}" onclick="App.dashScroll('${id}')"><b>${value}</b><span>${label}</span></button>`;
  return `
  <div class="dash-hero">
    <div class="dash-hero-main">
      <div class="dash-hero-kicker">${esc(todayLabel)}</div>
      <h2>Hi ${firstName} — here's where things stand.</h2>
      <p>What needs your decision, what changed, what's coming next, and how each area is doing.</p>
    </div>
    <div class="dash-hero-chips">
      ${chip("dash-decisions", decisionCount, decisionCount === 1 ? "needs your decision" : "need your decision", decisionCount ? "warn" : "good")}
      ${chip("dash-next", nextCount, "due in the next 14 days", nextCount ? "" : "good")}
      ${chip("dash-health", `${onTrack}/${areas.length}`, "areas on track", onTrack === areas.length ? "good" : "warn")}
      ${chip("dash-critical", criticalCount, criticalCount === 1 ? "critical item open" : "critical items open", criticalCount ? "warn" : "good")}
    </div>
  </div>`;
}

/* client: approvals + ready-for-review + waiting-on-client, one-click actions */
function dashDecisionCard() {
  const approvals = S.data.tasks.filter((t) => t.approval && t.approval.status === "awaiting_review");
  const reviews = S.data.tasks.filter((t) => t.status === "Ready for Review");
  const waiting = S.data.tasks.filter((t) => t.status === "Waiting on Client");
  const items = [
    ...approvals.map((t) => ({ t, kind: "approval" })),
    ...reviews.map((t) => ({ t, kind: "review" })),
    ...waiting.map((t) => ({ t, kind: "input" })),
  ].sort((a, b) => new Date(lastTs(b.t)) - new Date(lastTs(a.t)));
  const count = items.length;
  const rows = items.slice(0, 6).map(({ t, kind }) => `
    <div class="decision-item" onclick="App.openTask('${esc(t.id)}')">
      <div class="decision-main">
        <div class="decision-title">${esc(t.title)}</div>
        <div class="decision-meta">${departmentSignals(t)}${t.owner ? `<span>${esc(t.owner)}</span>` : ""}${t.dueDate ? `<span>due ${fmtDate(t.dueDate)}</span>` : ""}</div>
      </div>
      <div class="decision-actions" onclick="event.stopPropagation()">
        ${kind === "approval" ? `<button class="btn neon sm" onclick="App.reviewTask('${esc(t.id)}','approve')">Approve</button><button class="btn ghost sm" onclick="App.reviewTask('${esc(t.id)}','request_changes',true)">Request changes</button>` : ""}
        ${kind === "review" ? `<button class="btn neon sm" onclick="App.confirmDone('${esc(t.id)}')">Confirm done</button><button class="btn ghost sm" onclick="App.requestRevision('${esc(t.id)}')">Request revision</button>` : ""}
        ${kind === "input" ? `<span class="pill status-WaitingonClient"><span class="dot"></span>Your input needed</span>` : ""}
      </div>
    </div>`).join("");
  return `
  <div class="card dash-card" id="dash-decisions">
    <div class="card-pad dash-card-head">
      <div class="card-title">${I.decisions} Needs your decision <span class="count">(${count})</span></div>
      <div class="dash-card-sub">Approvals, reviews and questions waiting on you — handled with one click.</div>
    </div>
    ${count ? `<div>${rows}</div>${count > 6 ? `<div class="dash-more"><button onclick="App.nav('approvals')">See all ${count} in My Approvals →</button></div>` : ""}`
      : `<div class="empty-note">Nothing needs your decision right now.<br><small>When work is ready for review or the team needs your input, it lands here.</small></div>`}
  </div>`;
}

function dashSinceCard() {
  const { known, items } = changesSinceLastVisit();
  const lv = S.visitBaseline !== undefined ? S.visitBaseline : (S.data && S.data.lastVisit);
  const verb = (it) => {
    const title = `<b>${esc(it.t.title)}</b>`;
    if (it.kind === "new") return `New request in — ${title}`;
    if (it.kind === "status") return it.statusTo === "Completed" ? `${title} was completed ✓` : `${title} moved to <b>${esc(it.statusTo)}</b>`;
    if (it.kind === "update") return `<b>${esc(it.by)}</b> posted an update on ${title}`;
    if (it.kind === "comment") return `<b>${esc(it.by)}</b> commented on ${title}`;
    if (it.approvalStatus === "approved") return `${title} was approved`;
    if (it.approvalStatus === "changes_requested") return `Changes were requested on ${title}`;
    return `${title} was sent for review`;
  };
  const tone = (it) => it.kind === "new" ? "violet" : it.kind === "comment" ? "pink" : (it.kind === "approval" || it.statusTo === "Completed") ? "green" : "blue";
  const icon = (it) => it.kind === "new" ? "●" : it.kind === "comment" ? "💬" : (it.kind === "approval" || it.statusTo === "Completed") ? "✓" : it.kind === "status" ? "→" : "↗";
  return `
  <div class="card dash-card" id="dash-since">
    <div class="card-pad dash-card-head">
      <div class="card-title">${I.clock} Since your last visit ${known && items.length ? `<span class="count">(${items.length})</span>` : ""}</div>
      <div class="dash-card-sub">${known ? `Everything that moved since ${timeAgo(lv)}.` : "Your change feed starts with this visit."}</div>
    </div>
    ${!known ? `<div class="empty-note">Welcome — this is your first tracked visit.<br><small>From now on, everything that changes between visits is listed here.</small></div>`
      : items.length ? `<div>${items.slice(0, 7).map((it) => `
        <div class="change-item" onclick="App.openTask('${esc(it.t.id)}')">
          <span class="change-icon ${tone(it)}">${icon(it)}</span>
          <span class="change-text">${verb(it)}</span>
          <span class="change-time">${timeAgo(it.ts)}</span>
        </div>`).join("")}</div>${items.length > 7 ? `<div class="dash-more"><span>+ ${items.length - 7} more update${items.length - 7 === 1 ? "" : "s"} — open a task to see its full history</span></div>` : ""}`
      : `<div class="empty-note">Quiet since your last visit.<br><small>New requests, status changes, updates and comments will show up here.</small></div>`}
  </div>`;
}

function dashNextCard(next14) {
  const overdueCount = S.data.tasks.filter(isOverdueOpen).length;
  return `
  <div class="card dash-card" id="dash-next">
    <div class="card-pad dash-card-head">
      <div class="card-title">${I.calendar} Next 14 days <span class="count">(${next14.length})</span></div>
      <div class="dash-card-sub">What is scheduled to land, soonest first.</div>
      ${overdueCount ? `<button class="dash-overdue-link" onclick="App.showOverdue()">⚠ ${overdueCount} overdue — view</button>` : ""}
    </div>
    ${next14.length ? `<div>${next14.slice(0, 7).map((t) => {
      const due = new Date(taskDueISO(t) + "T00:00:00");
      const left = dueDaysLeft(t);
      return `
      <div class="next-item" onclick="App.openTask('${esc(t.id)}')">
        <div class="next-date ${left === 0 ? "today" : ""}"><b>${due.getDate()}</b><span>${MONTHS[due.getMonth()]}</span></div>
        <div class="next-main">
          <div class="next-title">${esc(t.title)}</div>
          <div class="next-meta">${departmentSignals(t)}${t.owner ? `<span>${esc(t.owner)}</span>` : `<span>Unassigned</span>`}</div>
        </div>
        <span class="next-left ${left <= 1 ? "soon" : ""}">${esc(dueCountdownLabel(t))}</span>
      </div>`;
    }).join("")}</div>${next14.length > 7 ? `<div class="dash-more"><button onclick="App.nav('calendar')">+ ${next14.length - 7} more — open the calendar →</button></div>` : ""}`
      : `<div class="empty-note">Nothing due in the next 14 days.<br><small>${isTeam() ? "Add due dates to keep the plan visible." : "Upcoming work appears here as the team schedules it."}</small></div>`}
  </div>`;
}

function dashHealthCard(areas) {
  const atRisk = areas.filter((a) => a.atRisk).length;
  return `
  <div class="card dash-card" id="dash-health">
    <div class="card-pad dash-card-head">
      <div class="card-title">${I.board} Area health ${atRisk ? `<span class="count">(${atRisk} at risk)</span>` : `<span class="count">(all on track)</span>`}</div>
      <div class="dash-card-sub">${isClient() ? "One glance per area — green means on track." : "At risk = an overdue task, or an open task with no movement in 14+ days."}</div>
    </div>
    ${areas.length ? `<div class="health-grid">${areas.map((a) => `
      <button class="health-chip ${a.atRisk ? "risk" : "ok"}" onclick="App.dashDept('${esc(a.d.id)}')" title="${esc(a.d.name)}: ${a.open} open${a.overdue ? `, ${a.overdue} overdue` : ""}${a.stale ? `, ${a.stale} quiet 14+ days` : ""} — click to view tasks">
        <span class="dept-dot" style="--dept:${esc(a.d.color)}">${esc(a.d.icon)}</span>
        <span class="hc-body"><b>${esc(a.d.name)}</b><span>${a.open} open${a.overdue ? ` · ${a.overdue} overdue` : ""}${a.stale ? ` · ${a.stale} quiet 14d+` : ""}</span></span>
        <span class="hc-pill">${a.atRisk ? "At risk" : "On track"}</span>
      </button>`).join("")}</div>`
      : `<div class="empty-note">No active departments yet.</div>`}
  </div>`;
}

function dashCriticalCard(criticalOpen) {
  return `
  <div class="card dash-card" id="dash-critical">
    <div class="card-pad dash-card-head">
      <div class="card-title">${I.alert} Critical items <span class="count">(${criticalOpen.length})</span></div>
      <div class="dash-card-sub">Highest-priority work — and why it matters for the business.</div>
    </div>
    ${criticalOpen.length ? `<div>${criticalOpen.slice(0, 6).map((t) => `
      <div class="critical-item" onclick="App.openTask('${esc(t.id)}')">
        <div class="critical-top">
          <div class="critical-main">
            <div class="decision-title">${esc(t.title)}</div>
            <div class="decision-meta">${departmentSignals(t)}${t.owner ? `<span>${esc(t.owner)}</span>` : ""}</div>
          </div>
          ${t.dueDate ? `<span class="due-chip ${isOverdueOpen(t) ? "overdue" : ""}">${isOverdueOpen(t) ? "⚠ " : ""}${esc(dueCountdownLabel(t))}</span>` : `<span class="due-chip none">no due date</span>`}
        </div>
        ${t.impact && String(t.impact).trim() ? `<div class="impact-line">${I.alert}<span>${esc(t.impact)}</span></div>` : ""}
      </div>`).join("")}</div>${criticalOpen.length > 6 ? `<div class="dash-more"><button onclick="App.dashboardFilter('critical')">See all ${criticalOpen.length} critical tasks →</button></div>` : ""}`
      : `<div class="empty-note">No critical items open — nothing is on fire right now.</div>`}
  </div>`;
}

function viewDashboard() {
  const tasks = S.data.tasks;
  const open = tasks.filter(isOpen);
  const inProgress = tasks.filter((t) => t.status === "In Progress");
  const waitingClient = tasks.filter((t) => t.status === "Waiting on Client");
  const review = tasks.filter((t) => t.status === "Ready for Review");
  const critical = open.filter((t) => t.priority === "Critical");
  const done = tasks.filter((t) => t.status === "Completed");
  const newReq = tasks.filter((t) => t.status === "New Request");
  const revision = tasks.filter((t) => t.status === "Revision Required");

  // active-tasks strip: In Progress, freshest activity first + progress hints
  const active = inProgress.slice().sort((a, b) => new Date(lastTs(b)) - new Date(lastTs(a)));
  const doneThisWeek = done.filter((t) => Date.now() - new Date(lastTs(t)).getTime() < 7 * 864e5).length;
  const donePct = tasks.length ? Math.round((done.length / tasks.length) * 100) : 0;

  const kpis = [
    { kind: "open", label: "Open tasks", value: open.length, sub: `${tasks.length} total visible tasks`, color: "var(--c-planned)" },
    { kind: "inProgress", label: "In progress", value: inProgress.length, sub: "team is actively working", color: "var(--c-progress)" },
    { kind: "waitingClient", label: isClient() ? "Waiting on you" : "Waiting on NEONMONKI", value: waitingClient.length, sub: isClient() ? "need your input" : "need Adika's input", color: "var(--c-wait-client)" },
    { kind: "review", label: "Ready for review", value: review.length, sub: "waiting for confirmation", color: "var(--c-review)" },
    { kind: "critical", label: "Critical open", value: critical.length, sub: "highest priority", color: "var(--c-critical)" },
    { kind: "completed", label: "Completed", value: done.length, sub: "since Jan 2026", color: "var(--c-done)" },
  ];

  // attention list, role-aware
  let attn = [];
  if (isTeam()) {
    attn = [
      ...newReq.map((t) => ({ t, kind: "new" })),
      ...revision.map((t) => ({ t, kind: "revision" })),
    ];
  } else {
    attn = [
      ...review.map((t) => ({ t, kind: "review" })),
      ...waitingClient.map((t) => ({ t, kind: "waiting" })),
      ...newReq.map((t) => ({ t, kind: "sent" })),
    ];
  }

  const attnTitle = isTeam() ? "Needs team action" : "Needs your attention";
  const attnHtml = attn.length
    ? attn.map(({ t, kind }) => `
      <div class="attn-item" onclick="App.openTask('${esc(t.id)}')">
        <div class="t">
          <div class="title">${esc(t.title)}</div>
          <div class="meta">${esc(t.id)} · ${departmentSignals(t)}${t.owner ? " · " + esc(t.owner) : ""}</div>
        </div>
        <span class="pill ${prioClass(t.priority)}">${esc(t.priority)}</span>
        <div class="attn-actions" onclick="event.stopPropagation()">
          ${kind === "new" && isTeam() ? `<button class="btn neon sm" onclick="App.openTask('${esc(t.id)}');App.openModal('acceptTask')">Accept</button>` : ""}
          ${kind === "review" && isClient() ? `
            <button class="btn neon sm" onclick="App.confirmDone('${esc(t.id)}')">Confirm done</button>
            <button class="btn danger sm" onclick="App.requestRevision('${esc(t.id)}')">Request revision</button>` : ""}
          ${kind === "waiting" ? `<span class="pill status-WaitingonClient"><span class="dot"></span>Your input needed</span>` : ""}
          ${kind === "revision" ? `<span class="pill status-RevisionRequired"><span class="dot"></span>Revision</span>` : ""}
          ${kind === "sent" ? `<span class="pill status-NewRequest"><span class="dot"></span>Awaiting team</span>` : ""}
        </div>
      </div>`).join("")
    : `<div class="empty-note">Nothing pending — all caught up.</div>`;

  // department breakdown
  const byDept = Object.fromEntries(departments().map((d) => [d.id, { total: 0, open: 0 }]));
  for (const t of tasks) {
    for (const id of taskDepartmentIds(t)) {
      if (!byDept[id]) continue;
      byDept[id].total++;
      if (isOpen(t)) byDept[id].open++;
    }
  }
  const depts = departments().map((d) => [d, byDept[d.id] || { total: 0, open: 0 }])
    .sort((a, b) => b[1].total - a[1].total || a[0].order - b[0].order);
  const maxTotal = Math.max(...depts.map(([, v]) => v.total), 1);

  // The audit-style activity feed is a super-admin-only surface.
  const act = isAdmin() ? (S.data.activity || []).slice(0, 14) : [];

  // management-first sections (shared: client = full dashboard, team = clean summary)
  const areas = areaHealth();
  const next14 = upcomingTasks(14);
  const criticalOpen = critical.slice()
    .sort((a, b) => (taskDueISO(a) || "9999").localeCompare(taskDueISO(b) || "9999"));
  const decisionCount = S.data.tasks.filter((t) =>
    (t.approval && t.approval.status === "awaiting_review") || t.status === "Ready for Review" || t.status === "Waiting on Client").length;

  const activeStripHtml = `
  <div class="card active-strip-card">
    <div class="card-pad active-strip-head">
      <div class="card-title">${I.tasks} Active tasks <span class="count">(${active.length})</span></div>
      <div class="active-strip-progress">
        ${doneThisWeek ? `<span class="asp-week">✓ ${doneThisWeek} done this week</span>` : ""}
        <span class="dept-bar asp-bar" title="${done.length} of ${tasks.length} tasks completed"><span class="has-open" style="width:${donePct}%"></span></span>
        <span class="asp-ratio">${done.length}/${tasks.length} done</span>
      </div>
    </div>
    ${active.length ? `<div class="active-strip">
      ${active.map((t) => {
        const upd = t.update || (t.updates && t.updates.length ? t.updates[t.updates.length - 1].text : "");
        return `
        <div class="at-card" onclick="App.openTask('${esc(t.id)}')">
          <div class="at-top"><span class="bc-id">${esc(t.id)}</span>${departmentSignals(t, false)}<span class="pill ${prioClass(t.priority)}">${esc(t.priority)}</span></div>
          <div class="at-title">${esc(t.title)} ${visBadge(t)}</div>
          <div class="at-update${upd ? "" : " none"}">${upd ? esc(upd) : "No updates yet — click to open"}</div>
          <div class="at-foot"><span class="at-owner">${esc(t.owner || "Unassigned")}</span><span class="at-time">${timeAgo(lastTs(t))}</span></div>
        </div>`;
      }).join("")}
    </div>` : `<div class="empty-note">${isTeam() ? "Nothing in progress right now — accept a request from the board to get moving." : "Nothing in progress right now — the team will post here as work starts."}</div>`}
  </div>`;

  const briefHtml = aiOn("brief") ? `
  <div class="card card-pad" style="margin-bottom:16px">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:${S.aiBrief ? "10px" : "0"}">
      <div class="card-title">${I.sparkle} Monki daily brief</div>
      <button class="btn neon sm" onclick="App.aiBrief()" ${S.aiBrief && S.aiBrief.loading ? "disabled" : ""}>${S.aiBrief && S.aiBrief.loading ? "Thinking…" : S.aiBrief && S.aiBrief.answer ? "Regenerate" : "Generate my brief"}</button>
      ${S.aiBrief && S.aiBrief.ts ? `<span style="color:var(--faint);font-size:12px">${timeAgo(S.aiBrief.ts)}</span>` : ""}
    </div>
    ${S.aiBrief && S.aiBrief.answer ? `<div class="ai-label" style="margin-bottom:10px">${I.sparkle} Prepared by Monki from live workspace data</div>${renderAiBrief(S.aiBrief.answer)}` : ""}
    ${S.aiBrief && S.aiBrief.error ? `<div class="login-error" style="margin:0">${esc(S.aiBrief.error)}</div>` : ""}
  </div>` : "";

  const mgmtGrid = `
  <div class="mgmt-grid">
    ${dashSinceCard()}
    ${dashNextCard(next14)}
    ${dashHealthCard(areas)}
    ${dashCriticalCard(criticalOpen)}
  </div>`;

  if (isClient()) {
    return `
    ${dashHero(decisionCount, next14.length, areas, criticalOpen.length)}
    ${dashDecisionCard()}
    ${mgmtGrid}
    ${briefHtml}
    ${activeStripHtml}`;
  }

  return `
  <div class="kpi-grid">
    ${kpis.map((k) => `
      <button type="button" class="kpi" style="--kpi-color:${k.color}" onclick="App.dashboardFilter('${k.kind}')" aria-label="Show ${esc(k.label.toLowerCase())}">
        <div class="k-label">${k.label}</div>
        <div class="k-value">${k.value}</div>
        <div class="k-sub">${k.sub} <span class="k-view">View tasks →</span></div>
      </button>`).join("")}
  </div>
  ${mgmtGrid}
  ${activeStripHtml}
  ${briefHtml}
  <div class="${isAdmin() ? "grid-2" : "dashboard-main-grid"}">
    <div>
      <div class="card" style="margin-bottom:16px">
        <div class="card-pad" style="border-bottom:1px solid var(--line)">
          <div class="card-title">${I.alert} ${attnTitle} <span class="count">(${attn.length})</span></div>
        </div>
        <div>${attnHtml}</div>
      </div>
      <div class="card">
        <div class="card-pad" style="border-bottom:1px solid var(--line)">
          <div class="card-title">${I.tasks} Workload by department</div>
        </div>
        <div class="card-pad">
          ${depts.map(([department, v]) => `
            <div class="dept-row">
              <div class="dname"><span class="dept-dot" style="--dept:${esc(department.color)}">${esc(department.icon)}</span>${esc(department.name)}</div>
              <div class="dept-bar"><span class="${v.open ? "has-open" : ""}" style="width:${Math.round((v.total / maxTotal) * 100)}%"></span></div>
              <div class="dnum">${v.open} open / ${v.total}</div>
            </div>`).join("")}
        </div>
      </div>
    </div>
    ${isAdmin() ? `<div class="card">
      <div class="card-pad" style="border-bottom:1px solid var(--line)">
        <div class="card-title">${I.clock} Recent activity</div>
      </div>
      <div>
        ${act.length ? act.map((a) => `
          <div class="act-item">
            <div class="act-dot"></div>
            <div class="a-text"><b>${esc(a.by)}</b> ${esc(a.text)}
              ${a.taskId ? ` <span class="act-task-link" onclick="App.openTask('${esc(a.taskId)}')">open task</span>` : ""}
            </div>
            <div class="a-time">${timeAgo(a.ts)}</div>
          </div>`).join("") : `<div class="empty-note">No activity yet.</div>`}
      </div>
    </div>` : ""}
  </div>`;
}

/* ------------------------------ smart reporting ------------------------------ */

function renderSmartReporting(el) {
  const r = S.reporting;
  if (!r.allowed) {
    el.innerHTML = `<div class="card"><div class="empty-note">Smart Reporting is not enabled for this account.</div></div>`;
    return;
  }
  el.innerHTML = viewSmartReporting();
  if (r.justLoaded && r.loaded && !r.error) {
    r.justLoaded = false;
    srCountUpKpis();
  }
  srChartDrawIn(); // no-op until the trend chart is actually in the DOM
  if (r.status && r.status.connected && !r.loaded && !r.loading) loadSmartReporting();
}

function renderPerformance(el) {
  const rb = S.reportingBasic;
  if (!rb.allowed || S.reporting.allowed) {
    el.innerHTML = `<div class="card"><div class="empty-note">Performance reporting is not enabled for this account.</div></div>`;
    return;
  }
  el.innerHTML = viewPerformance();
  srChartDrawIn(); // measures the trend line for the CSS draw-in
  if (!rb.loaded && !rb.loading) loadPerformance();
}

const SR_RANGE_OPTIONS = [
  ["today", "Today"], ["yesterday", "Yesterday"],
  ["last_7", "Last 7 days"], ["prev_7", "Previous 7 days"], ["last_30", "Last 30 days"],
  ["this_week", "This week"], ["last_week", "Last week"],
  ["this_month", "This month"], ["last_month", "Last month"],
  ["this_quarter", "This quarter"], ["ytd", "Year to date"],
  ["custom", "Custom range"],
];
const SR_CMP_OPTIONS = [
  ["previous", "Previous period"], ["prev_week", "Previous week"],
  ["prev_month", "Previous month"], ["prev_year", "Previous year"], ["none", "No comparison"],
];
const SR_KPIS = [
  { key: "revenue", label: "Revenue", kind: "money" },
  { key: "spend", label: "Spend", kind: "money", invert: true },
  { key: "roas", label: "ROAS", kind: "ratio" },
  { key: "leads", label: "Leads", kind: "num" },
  { key: "sales", label: "Sales", kind: "num" },
  { key: "cpl", label: "CPL", kind: "money", invert: true },
];
const SR_TREND_METRICS = ["revenue", "spend", "roas", "leads", "sales", "cpl"];
const SR_DRILL_ORDER = ["channel", "platform", "source", "campaign"];
const SR_MIX_COLORS = ["#65a30d", "#0ea5e9", "#8b5cf6", "#f59e0b", "#ec4899", "#14b8a6", "#f97316", "#64748b"];

/* encode a dynamic filter value so it is safe inside an inline onclick string */
const jsq = (s) => encodeURIComponent(String(s == null ? "" : s));

/* Raw connector enums (GOOGLE_V2, FACEBOOK, …) must never surface in the Smart
 * Reporting UI — the API already normalizes new data, this is the display safety
 * net for anything legacy. Only display text is mapped; filter values round-trip raw. */
const SR_RAW_DISPLAY = {
  GOOGLE_V2: "Google Ads", GOOGLE: "Google Ads", FACEBOOK: "Meta Ads",
  PINTEREST: "Pinterest Ads", TIKTOK: "TikTok Ads", BING: "Microsoft / Bing Ads",
  LINKEDIN: "LinkedIn Ads", SNAPCHAT: "Snapchat Ads", TWITTER: "Twitter / X Ads",
  REDDIT: "Reddit Ads", APPLOVIN: "AppLovin", WHOP_ADS: "Whop Ads",
};
function srDisplay(value) {
  const s = String(value == null ? "" : value);
  return SR_RAW_DISPLAY[s.toUpperCase()] || s;
}

function srMetricMeta(key) {
  if (SR_KPIS.find((k) => k.key === key)) return SR_KPIS.find((k) => k.key === key);
  const kinds = { cpa: "money", cpc: "money", aov: "money", cvr: "pct", ctr: "pct", clicks: "num", impressions: "num", calls: "num" };
  return { key, label: key.toUpperCase(), kind: kinds[key] || "num", invert: ["cpa", "cpc"].includes(key) };
}

function srFmtNum(v, kind) {
  const n = Number(v);
  if (v === null || v === undefined || v === "" || isNaN(n)) return "—";
  if (kind === "money") return "€" + n.toLocaleString(undefined, { maximumFractionDigits: Math.abs(n) < 100 && n % 1 !== 0 ? 2 : 0 });
  if (kind === "ratio") return (Math.round(n * 100) / 100).toLocaleString() + "×";
  if (kind === "pct") return (Math.round(n * 10) / 10) + "%";
  return Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function srFmtCompact(v) {
  const n = Number(v);
  if (isNaN(n)) return "—";
  return Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

/* delta chip with good/bad colouring — for cost metrics (invert) down is good */
function srDeltaChip(pct, invert) {
  if (pct === null || pct === undefined || isNaN(Number(pct))) return `<span class="delta-chip flat">—</span>`;
  const n = Number(pct);
  if (n === 0) return `<span class="delta-chip flat">• 0%</span>`;
  const good = invert ? n < 0 : n > 0;
  const rounded = Math.abs(Math.round(n * 10) / 10);
  return `<span class="delta-chip ${good ? "up" : "down"}" title="${good ? "Improving" : "Declining"} vs the comparison period">${n > 0 ? "▲" : "▼"} ${rounded}%</span>`;
}

function srRangeBounds(range, customFrom, customTo) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const monday = addDays(today, -((today.getDay() + 6) % 7));
  if (range === "today") return { from: localISODate(today), to: localISODate(today) };
  if (range === "yesterday") { const y = addDays(today, -1); return { from: localISODate(y), to: localISODate(y) }; }
  if (range === "last_7") return { from: localISODate(addDays(today, -6)), to: localISODate(today) };
  if (range === "prev_7") return { from: localISODate(addDays(today, -13)), to: localISODate(addDays(today, -7)) };
  if (range === "last_30") return { from: localISODate(addDays(today, -29)), to: localISODate(today) };
  if (range === "this_week") return { from: localISODate(monday), to: localISODate(today) };
  if (range === "last_week") return { from: localISODate(addDays(monday, -7)), to: localISODate(addDays(monday, -1)) };
  if (range === "this_month") return { from: localISODate(new Date(today.getFullYear(), today.getMonth(), 1)), to: localISODate(today) };
  if (range === "last_month") {
    return { from: localISODate(new Date(today.getFullYear(), today.getMonth() - 1, 1)), to: localISODate(new Date(today.getFullYear(), today.getMonth(), 0)) };
  }
  if (range === "this_quarter") {
    const qm = Math.floor(today.getMonth() / 3) * 3;
    return { from: localISODate(new Date(today.getFullYear(), qm, 1)), to: localISODate(today) };
  }
  if (range === "ytd") return { from: localISODate(new Date(today.getFullYear(), 0, 1)), to: localISODate(today) };
  // custom
  const from = /^\d{4}-\d{2}-\d{2}$/.test(customFrom || "") ? customFrom : localISODate(addDays(today, -6));
  const to = /^\d{4}-\d{2}-\d{2}$/.test(customTo || "") ? customTo : localISODate(today);
  return { from, to };
}

function srCmpBounds(b, cmp) {
  if (!cmp || cmp === "none") return null;
  const from = new Date(b.from + "T00:00:00");
  const to = new Date(b.to + "T00:00:00");
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  if (cmp === "prev_week") return { cmpfrom: localISODate(addDays(from, -7)), cmpto: localISODate(addDays(to, -7)) };
  if (cmp === "prev_month") {
    const f = new Date(from); f.setMonth(f.getMonth() - 1);
    const t = new Date(to); t.setMonth(t.getMonth() - 1);
    return { cmpfrom: localISODate(f), cmpto: localISODate(t) };
  }
  if (cmp === "prev_year") {
    const f = new Date(from); f.setFullYear(f.getFullYear() - 1);
    const t = new Date(to); t.setFullYear(t.getFullYear() - 1);
    return { cmpfrom: localISODate(f), cmpto: localISODate(t) };
  }
  // "previous" — the equal-length period immediately before `from`
  const len = Math.max(0, Math.round((to - from) / 864e5));
  return { cmpfrom: localISODate(addDays(from, -(len + 1))), cmpto: localISODate(addDays(from, -1)) };
}

function srGranularityFor(from, to) {
  const days = Math.round((new Date(to + "T00:00:00") - new Date(from + "T00:00:00")) / 864e5) + 1;
  if (days <= 2) return "hour";
  if (days <= 62) return "day";
  if (days <= 400) return "week";
  return "month";
}

/* probe once per session whether Smart Reporting is available to this user.
 * The API decides (role default, or an explicit per-user reporting grant of
 * "advanced"/"super") — non-admins without a grant get a 403 here. The status
 * payload also carries the caller's tier, which gates the report generator. */
async function probeReporting(force) {
  const r = S.reporting;
  if (r.probing) return;
  if (r.probed && !force) return;
  r.probing = true;
  try {
    r.status = await api("/api/reporting/status");
    r.allowed = true;
  } catch (e) {
    r.allowed = false;
    r.status = null;
    if (e && e.status === 403) r.error = "";
  } finally {
    r.probing = false;
    r.probed = true;
  }
}

/* probe once per session whether the calm basic-tier Performance page is
 * available to this user (401/403 → hidden). The probe response IS the
 * default-range (last 30 days) payload, so it doubles as the page's initial
 * data — no second request on first visit. */
async function probeReportingBasic(force) {
  const rb = S.reportingBasic;
  if (rb.probing) return;
  if (rb.probed && !force) return;
  rb.probing = true;
  try {
    const data = await api("/api/reporting/basic");
    rb.allowed = true;
    if (data && data.range) { rb.data = data; rb.loaded = true; rb.range = "last_30"; rb.error = ""; }
  } catch {
    rb.allowed = false;
    rb.data = null;
  } finally {
    rb.probing = false;
    rb.probed = true;
  }
}

function srFilterParams(p) {
  const r = S.reporting;
  if (r.channel) p.set("channel", r.channel);
  if (r.platform) p.set("platform", r.platform);
  if (r.source) p.set("source", r.source);
  if (r.campaign) p.set("campaign", r.campaign);
  return p;
}

function srQuery(b, extra) {
  const p = srFilterParams(new URLSearchParams({ from: b.from, to: b.to }));
  if (extra) for (const [k, v] of Object.entries(extra)) if (v !== "" && v != null) p.set(k, v);
  return p.toString();
}

const srRows = (x) => (Array.isArray(x) ? x : (x && (x.rows || x.items || x.data)) || []);

async function loadSmartReporting(force) {
  const r = S.reporting;
  if (!r.allowed || !r.status || !r.status.connected) return;
  if (r.loading) return;
  if (r.loaded && !force) return;
  const req = (r.req || 0) + 1;
  r.req = req;
  r.loading = true;
  r.error = "";
  if (S.route === "smartreporting") renderPage("smartreporting");
  const b = srRangeBounds(r.range, r.customFrom, r.customTo);
  const cmp = srCmpBounds(b, r.cmp);
  const trendExtra = {
    granularity: r.granularity && r.granularity !== "auto" ? r.granularity : srGranularityFor(b.from, b.to),
    metric: r.metric,
  };
  try {
    const [overview, trend, cmpTrend, channels, mix, campaigns, activity] = await Promise.all([
      api(`/api/reporting/overview?${srQuery(b, cmp ? { cmpfrom: cmp.cmpfrom, cmpto: cmp.cmpto } : {})}`),
      api(`/api/reporting/trend?${srQuery(b, trendExtra)}`),
      cmp
        ? api(`/api/reporting/trend?${srQuery({ from: cmp.cmpfrom, to: cmp.cmpto }, trendExtra)}`).catch(() => null)
        : Promise.resolve(null),
      api(`/api/reporting/breakdown?${srQuery(b, { dimension: "channel" })}`),
      api(`/api/reporting/breakdown?${srQuery(b, { dimension: r.mixDimension })}`),
      api(`/api/reporting/breakdown?${srQuery(b, { dimension: "campaign" })}`),
      api(`/api/reporting/activity?${srFilterParams(new URLSearchParams({ limit: "15" }))}`),
    ]);
    if (r.req !== req) return; // a newer filter/range request superseded this one
    r.overview = overview;
    r.trend = srRows(trend);
    r.cmpTrend = srRows(cmpTrend);
    r.channels = srRows(channels);
    r.mix = srRows(mix);
    r.campaigns = srRows(campaigns);
    r.activity = srRows(activity);
    r.justLoaded = true; // the render that follows runs the count-up + chart draw-in
    r.loaded = true;
  } catch (e) {
    if (r.req !== req) return;
    if (e && e.status === 403) { // access revoked mid-session — hide the feature again
      r.allowed = false;
      r.loading = false;
      renderApp();
      return;
    }
    r.error = e.message;
    r.loaded = true; // attempted — no auto-retry loop; the error card offers Retry
  }
  r.loading = false;
  if (S.route === "smartreporting") renderPage("smartreporting");
}

/* the reporting context Monki inherits when asked from the Smart Reporting page */
function srAskContext() {
  const r = S.reporting;
  if (S.route !== "smartreporting" || !r.allowed || !r.status || !r.status.connected) return null;
  const b = srRangeBounds(r.range, r.customFrom, r.customTo);
  return { from: b.from, to: b.to, channel: r.channel || "", platform: r.platform || "", source: r.source || "", campaign: r.campaign || "" };
}

function srNotConnectedHtml() {
  return `
  <div class="card sr-connect-card">
    <div class="sr-connect-art">${I.results}</div>
    <h3>Smart Reporting needs a data source</h3>
    <p>Connect the attribution source from <button class="sr-inline-link" onclick="App.navAdminIntegrations()">Admin → Integrations</button> and this page becomes a live marketing intelligence center — spend, revenue, leads, ROAS and attribution, synced automatically.</p>
    <button class="btn neon" onclick="App.navAdminIntegrations()">${I.admin} Open Integrations</button>
  </div>`;
}

/* data freshness chip — shown in the Smart Reporting page header */
function srSyncChipHtml(st) {
  const stale = !st.lastSyncAt || (Date.now() - new Date(st.lastSyncAt).getTime()) > 6 * 3600e3;
  /* rate-limited is transient (Hyros 429) — show it with the stale style, not as an error */
  const rateLimited = !!(st.rateLimited || (S.integrations.hyros && S.integrations.hyros.rateLimited));
  return rateLimited
    ? `<span class="sr-sync-chip stale" title="The data provider is rate-limiting requests right now — syncs retry automatically"><i></i>Sync rate-limited — retrying</span>`
    : st.lastSyncAt
      ? `<span class="sr-sync-chip ${stale ? "stale" : ""}" title="Last data sync: ${esc(String(st.lastSyncAt))}"><i></i>Synced ${esc(timeAgo(st.lastSyncAt))}</span>`
      : `<span class="sr-sync-chip stale"><i></i>Never synced</span>`;
}

/* page header: identity + the super-tier report generator + the sync chip */
function srPageHeadHtml(st) {
  const canGenerate = st && st.tier === "super";
  return `
  <div class="sr-page-head">
    <div class="sr-page-head-text">
      <h2 class="sr-page-title">Smart Reporting</h2>
      <p class="sr-page-sub">Attribution, spend and revenue across every channel — drill into any number, or let Monki write the period up.</p>
    </div>
    <div class="sr-page-head-actions">
      ${canGenerate ? `<button class="btn neon" id="sr-generate-report" onclick="App.openGenerateReport()">${I.sparkle} Generate Report</button>` : ""}
      ${srSyncChipHtml(st)}
    </div>
  </div>`;
}

function srToolbarHtml(st) {
  const r = S.reporting;
  const b = srRangeBounds(r.range, r.customFrom, r.customTo);
  const cmp = srCmpBounds(b, r.cmp);
  const filters = (st && st.filters) || {};
  const dimSelect = (key, label, values) => {
    if (!Array.isArray(values) || !values.length) return ""; // hide empty dimensions entirely
    return `<label class="sr-filter"><span>${label}</span><select onchange="App.srFilter('${key}', this.value)" aria-label="Filter by ${label}">
      <option value="">All ${label.toLowerCase()}s</option>
      ${values.map((v) => `<option value="${esc(v)}" ${r[key] === v ? "selected" : ""}>${esc(srDisplay(v))}</option>`).join("")}
    </select></label>`;
  };
  return `
  <div class="card sr-toolbar">
    <div class="sr-toolbar-row">
      <label class="sr-filter"><span>Range</span>
        <select onchange="App.srRange(this.value)" aria-label="Date range">
          ${SR_RANGE_OPTIONS.map(([v, l]) => `<option value="${v}" ${r.range === v ? "selected" : ""}>${l}</option>`).join("")}
        </select>
      </label>
      ${r.range === "custom" ? `
      <label class="date-filter"><span>From</span><input type="date" value="${esc(r.customFrom)}" onchange="App.srCustom('customFrom', this.value)"></label>
      <label class="date-filter"><span>To</span><input type="date" value="${esc(r.customTo)}" onchange="App.srCustom('customTo', this.value)"></label>
      <button class="btn primary sm" onclick="App.srApplyCustom()">Apply</button>` : ""}
      <label class="sr-filter"><span>Compare</span>
        <select onchange="App.srCmp(this.value)" aria-label="Comparison period">
          ${SR_CMP_OPTIONS.map(([v, l]) => `<option value="${v}" ${r.cmp === v ? "selected" : ""}>${l}</option>`).join("")}
        </select>
      </label>
      ${dimSelect("channel", "Channel", filters.channels)}
      ${dimSelect("platform", "Platform", filters.platforms)}
      ${dimSelect("source", "Source", filters.sources)}
      <span class="sr-toolbar-spacer"></span>
      <button class="btn ghost sm" onclick="App.srRefresh()" title="Reload the reporting data">${I.recurring} Refresh</button>
    </div>
    <div class="sr-toolbar-sub">${esc(fmtDate(b.from))} → ${esc(fmtDate(b.to))}${cmp ? ` <span>vs ${esc(fmtDate(cmp.cmpfrom))} → ${esc(fmtDate(cmp.cmpto))}</span>` : ` <span>no comparison</span>`}${r.loading && r.loaded ? ` <span class="results-loading">Updating…</span>` : ""}</div>
  </div>`;
}

function srStaleBannerHtml(st) {
  if (!st || !st.lastSyncAt) return "";
  const age = Date.now() - new Date(st.lastSyncAt).getTime();
  if (!(age > 6 * 3600e3)) return "";
  return `<div class="sr-stale">
    ${I.alert}<div><b>Reporting data may be stale.</b><span>Last data sync was ${esc(timeAgo(st.lastSyncAt))} — syncs and webhooks normally keep this fresh.</span></div>
    <button class="btn primary sm" onclick="App.hyrosSync(true)">${I.recurring} Sync now</button>
  </div>`;
}

function srBreadcrumbHtml() {
  const r = S.reporting;
  const active = SR_DRILL_ORDER.filter((k) => r[k]);
  if (!active.length) return "";
  const crumbs = [`<button class="sr-crumb" onclick="App.srClearFilters()">All channels</button>`];
  active.forEach((k, i) => {
    const last = i === active.length - 1;
    crumbs.push(`<span class="sr-crumb-sep">›</span><button class="sr-crumb ${last ? "current" : ""}" ${last ? "" : `onclick="App.srTruncateFilters('${k}')"`} title="${esc(k)}">${esc(srDisplay(r[k]))}</button>`);
  });
  return `<div class="sr-breadcrumb"><button class="btn ghost sm" onclick="App.srBack()">← Back</button>${crumbs.join("")}</div>`;
}

function srKpiStripHtml() {
  const o = S.reporting.overview || {};
  const cur = o.current || {};
  const prev = o.previous || {};
  const deltas = o.deltas || {};
  return `<div class="kpi-grid sr-kpis">
    ${SR_KPIS.map((k) => `
    <div class="kpi sr-kpi">
      <div class="k-label">${k.label}</div>
      <div class="k-value">${srFmtNum(cur[k.key], k.kind)}</div>
      <div class="k-sub sr-kpi-sub">${srDeltaChip(deltas[k.key], k.invert)}<span>vs ${srFmtNum(prev[k.key], k.kind)}</span></div>
    </div>`).join("")}
  </div>`;
}

/* short bucket labels for the chart axes; full label for tooltips */
function srBucketLabel(bucket) {
  const s = String(bucket || "");
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2})/);
  if (m) return `${m[4]}:00`;
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}`;
  m = s.match(/^(\d{4})-(\d{2})$/);
  if (m) return MONTHS[Number(m[2]) - 1];
  return s;
}
function srBucketFull(bucket) {
  const s = String(bucket || "");
  const m = s.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}))?/);
  if (!m) return s;
  return m[2] ? `${fmtDate(m[1])} · ${m[2]}:00` : fmtDate(m[1]);
}

/* geometry cache for chart hover hit-testing (set on every chart render) */
let srChartGeom = null;

function srTrendCardHtml() {
  const r = S.reporting;
  const meta = srMetricMeta(r.metric);
  const rows = r.trend || [];
  const cmpRows = r.cmpTrend || [];
  const b = srRangeBounds(r.range, r.customFrom, r.customTo);
  const effGran = r.granularity && r.granularity !== "auto" ? r.granularity : srGranularityFor(b.from, b.to);
  const metricPick = `<div class="range-presets sr-metric-pick" role="group" aria-label="Trend metric">${SR_TREND_METRICS.map((k) => `<button class="${r.metric === k ? "active" : ""}" onclick="App.srMetric('${k}')">${esc(srMetricMeta(k).label)}</button>`).join("")}</div>`;
  const granPick = `<select class="sr-gran" onchange="App.srGranularity(this.value)" title="Bucket size" aria-label="Bucket size">
    ${["auto", "hour", "day", "week", "month"].map((g) => `<option value="${g}" ${(r.granularity || "auto") === g ? "selected" : ""}>${g === "auto" ? `Auto (${effGran})` : g[0].toUpperCase() + g.slice(1)}</option>`).join("")}
  </select>`;
  const head = `
    <div class="card-pad sr-chart-head">
      <div><div class="card-title">${I.results} Trend — ${esc(meta.label)}</div>
      <div class="dash-card-sub">${esc(fmtDate(b.from))} → ${esc(fmtDate(b.to))} · ${esc(effGran)} buckets${cmpRows.length ? " · dashed = comparison period" : ""}</div></div>
      <div class="sr-chart-controls">${metricPick}${granPick}</div>
    </div>`;
  if (!rows.length) {
    srChartGeom = null;
    return `<div class="card sr-chart-card">${head}<div class="empty-note">No reporting data in this range yet — syncs and webhooks add to it continuously.</div></div>`;
  }
  const vals = rows.map((x) => Number(x[r.metric]) || 0);
  const cmpVals = cmpRows.map((x) => Number(x[r.metric]) || 0);
  const W = 720, H = 250, pl = 48, pr = 12, pt = 12, pb = 26;
  const iw = W - pl - pr, ih = H - pt - pb;
  const n = vals.length;
  const max = Math.max(1, ...vals, ...cmpVals);
  const x = (i) => pl + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v) => pt + ih - (Math.max(0, v) / max) * ih;
  const linePath = vals.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const areaPath = `${linePath} L${x(n - 1).toFixed(1)},${(pt + ih).toFixed(1)} L${x(0).toFixed(1)},${(pt + ih).toFixed(1)} Z`;
  const cmpPath = cmpVals.length
    ? cmpVals.map((v, i) => `${i ? "L" : "M"}${x(Math.min(i, n - 1)).toFixed(1)},${y(v).toFixed(1)}`).join(" ")
    : "";
  const gridLines = [0.25, 0.5, 0.75, 1].map((f) => {
    const gy = y(max * f);
    return `<line x1="${pl}" y1="${gy.toFixed(1)}" x2="${W - pr}" y2="${gy.toFixed(1)}" class="sr-grid"/><text x="${pl - 6}" y="${(gy + 3.5).toFixed(1)}" class="sr-axis" text-anchor="end">${srFmtCompact(max * f)}</text>`;
  }).join("");
  const labelEvery = Math.max(1, Math.ceil(n / 7));
  const xLabels = rows.map((row, i) => (i % labelEvery === 0
    ? `<text x="${x(i).toFixed(1)}" y="${H - 8}" class="sr-axis" text-anchor="middle">${esc(srBucketLabel(row.bucket))}</text>` : "")).join("");
  srChartGeom = {
    n, pl, iw, w: W, metric: r.metric, kind: meta.kind, label: meta.label,
    vals, cmpVals, yCur: vals.map(y), yCmp: cmpVals.map(y),
    buckets: rows.map((row) => srBucketFull(row.bucket)),
  };
  return `
  <div class="card sr-chart-card">
    ${head}
    <div class="sr-chart-wrap" onmousemove="App.srChartMove(event)" onmouseleave="App.srChartLeave()">
      <svg viewBox="0 0 ${W} ${H}" class="sr-chart" role="img" aria-label="${esc(meta.label)} trend chart">
        <defs><linearGradient id="srAreaFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#b8ff2e" stop-opacity=".38"/><stop offset="1" stop-color="#b8ff2e" stop-opacity="0"/>
        </linearGradient></defs>
        ${gridLines}
        ${cmpPath ? `<path d="${cmpPath}" class="sr-line-cmp"/>` : ""}
        <path d="${areaPath}" class="sr-area" fill="url(#srAreaFill)"/>
        <path d="${linePath}" class="sr-line"/>
        ${xLabels}
        <line id="sr-chart-guide" x1="0" y1="${pt}" x2="0" y2="${pt + ih}" class="sr-guide" style="display:none"/>
        <circle id="sr-chart-cmpdot" r="3.5" class="sr-dot cmp" style="display:none"/>
        <circle id="sr-chart-dot" r="4" class="sr-dot" style="display:none"/>
      </svg>
      <div id="sr-chart-tooltip" class="sr-tooltip" style="display:none"></div>
    </div>
  </div>`;
}

function srChannelCardsHtml() {
  const r = S.reporting;
  const rows = r.channels || [];
  const head = `<div class="card-pad dash-card-head"><div><div class="card-title">${I.dashboard} Channel performance</div><div class="dash-card-sub">Click a channel to drill in — the whole page follows the filter.</div></div></div>`;
  if (!rows.length) return `<div class="card sr-channels-card">${head}<div class="empty-note compact">No channel data in this range.</div></div>`;
  const totalRev = rows.reduce((s, x) => s + (Number(x.revenue) || 0), 0);
  const totalSpend = rows.reduce((s, x) => s + (Number(x.spend) || 0), 0);
  const byRevenue = totalRev > 0;
  const denom = byRevenue ? totalRev : totalSpend;
  return `
  <div class="card sr-channels-card">
    ${head}
    <div class="sr-channel-list">
      ${rows.map((row) => {
        const share = denom > 0 ? Math.round(((Number(byRevenue ? row.revenue : row.spend) || 0) / denom) * 1000) / 10 : 0;
        return `
        <button class="sr-channel-row ${r.channel === row.name ? "active" : ""}" onclick="App.srFilter('channel', decodeURIComponent('${jsq(row.name)}'))">
          <div class="sr-channel-top"><b>${esc(srDisplay(row.name))}</b>${srDeltaChip(row.deltaPct, false)}<span class="sr-share">${share}% of ${byRevenue ? "revenue" : "spend"}</span></div>
          <div class="sr-share-bar"><i style="width:${Math.min(100, Math.max(1.5, share))}%"></i></div>
          <div class="sr-channel-stats">
            <span>Revenue <b>${srFmtNum(row.revenue, "money")}</b></span>
            <span>Spend <b>${srFmtNum(row.spend, "money")}</b></span>
            <span>ROAS <b>${srFmtNum(row.roas, "ratio")}</b></span>
            <span>Leads <b>${srFmtNum(row.leads, "num")}</b></span>
            <span>CPL <b>${srFmtNum(row.cpl, "money")}</b></span>
          </div>
        </button>`;
      }).join("")}
    </div>
  </div>`;
}

function srMixHtml() {
  const r = S.reporting;
  const rows = r.mix || [];
  const dim = r.mixDimension;
  const dimBtn = (d) => `<button class="${dim === d ? "active" : ""}" onclick="App.srMixDim('${d}')">${d === "source" ? "By source" : "By platform"}</button>`;
  const head = `<div class="card-pad dash-card-head"><div><div class="card-title">${I.sparkle} Attribution mix</div><div class="dash-card-sub">Click a segment to filter the page to it.</div></div><div class="range-presets sr-metric-pick">${dimBtn("source")}${dimBtn("platform")}</div></div>`;
  if (!rows.length) return `<div class="card sr-mix-card">${head}<div class="empty-note compact">No attribution data in this range.</div></div>`;
  const totalRev = rows.reduce((s, x) => s + (Number(x.revenue) || 0), 0);
  const useKey = totalRev > 0 ? "revenue" : "spend";
  const total = rows.reduce((s, x) => s + (Number(x[useKey]) || 0), 0);
  if (!(total > 0)) return `<div class="card sr-mix-card">${head}<div class="empty-note compact">No attribution data in this range.</div></div>`;
  const segs = rows.map((row, i) => {
    const val = Number(row[useKey]) || 0;
    const pct = Math.round((val / total) * 1000) / 10;
    return { row, val, pct, color: SR_MIX_COLORS[i % SR_MIX_COLORS.length] };
  });
  return `
  <div class="card sr-mix-card">
    ${head}
    <div class="sr-mix-bar" role="img" aria-label="Attribution mix by ${esc(dim)}">
      ${segs.map((s) => `<button class="sr-mix-seg ${r[dim] === s.row.name ? "active" : ""}" style="width:${Math.max(s.pct, 0.8)}%;background:${s.color}" title="${esc(srDisplay(s.row.name))} — ${s.pct}% of ${useKey}" onclick="App.srFilter('${dim}', decodeURIComponent('${jsq(s.row.name)}'))"></button>`).join("")}
    </div>
    <div class="sr-mix-legend">
      ${segs.map((s) => `
      <button class="sr-mix-item ${r[dim] === s.row.name ? "active" : ""}" onclick="App.srFilter('${dim}', decodeURIComponent('${jsq(s.row.name)}'))">
        <span class="sw" style="background:${s.color}"></span><b>${esc(srDisplay(s.row.name))}</b><span class="mix-val">${srFmtNum(s.val, useKey === "revenue" ? "money" : "money")}</span><span class="pct">${s.pct}%</span>
      </button>`).join("")}
    </div>
  </div>`;
}

function srCampaignRowsHtml() {
  const r = S.reporting;
  let rows = (r.campaigns || []).slice();
  const q = (r.tableQ || "").trim().toLowerCase();
  if (q) rows = rows.filter((x) => String(x.name || "").toLowerCase().includes(q));
  const key = r.tableSort, dir = r.tableDir;
  rows.sort((a, b) => {
    if (key === "name") return dir * String(a.name || "").localeCompare(String(b.name || ""));
    return dir * ((Number(a[key]) || 0) - (Number(b[key]) || 0)) || String(a.name || "").localeCompare(String(b.name || ""));
  });
  if (!rows.length) return `<tr><td colspan="8"><div class="empty-note compact">${q ? `No campaigns match “${esc(r.tableQ)}”.` : "No campaign data in this range."}</div></td></tr>`;
  return rows.slice(0, 100).map((row) => `
    <tr onclick="App.srFilter('campaign', decodeURIComponent('${jsq(row.name)}'))" title="Drill into ${esc(row.name)}">
      <td><div class="t-title">${esc(row.name)}</div></td>
      <td class="num">${srFmtNum(row.spend, "money")}</td>
      <td class="num"><b>${srFmtNum(row.revenue, "money")}</b></td>
      <td class="num">${srFmtNum(row.roas, "ratio")}</td>
      <td class="num">${srFmtNum(row.leads, "num")}</td>
      <td class="num">${srFmtNum(row.sales, "num")}</td>
      <td class="num">${srFmtNum(row.cpl, "money")}</td>
      <td class="num">${srDeltaChip(row.deltaPct, false)}</td>
    </tr>`).join("");
}

function srCampaignTableHtml() {
  const r = S.reporting;
  const head = (key, label) =>
    `<th class="${key === "name" ? "" : "num"} ${r.tableSort === key ? "sorted" : ""}" onclick="App.srSort('${key}')">${label}${r.tableSort === key ? (r.tableDir === 1 ? " ▲" : " ▼") : ""}</th>`;
  return `
  <div class="card sr-table-card">
    <div class="card-pad sr-table-head">
      <div><div class="card-title">${I.tasks} Campaign drill-down <span class="count">(${(r.campaigns || []).length})</span></div>
      <div class="dash-card-sub">Click a row to filter the whole page to that campaign.</div></div>
      <label class="sr-table-search">${I.search}<input placeholder="Search campaigns…" value="${esc(r.tableQ)}" oninput="App.srTableSearch(this.value)" aria-label="Search campaigns"></label>
    </div>
    <div class="table-wrap">
      <table class="data sr-table">
        <thead><tr>${head("name", "Campaign")}${head("spend", "Spend")}${head("revenue", "Revenue")}${head("roas", "ROAS")}${head("leads", "Leads")}${head("sales", "Sales")}${head("cpl", "CPL")}${head("deltaPct", "Δ Rev")}</tr></thead>
        <tbody id="sr-table-body">${srCampaignRowsHtml()}</tbody>
      </table>
    </div>
  </div>`;
}

function srActivityHtml() {
  const rows = S.reporting.activity || [];
  const meta = (t) => {
    const k = String(t || "").toLowerCase();
    if (k === "sale" || k === "order") return ["€", "t-sale", "Sale"];
    if (k === "lead") return ["✦", "t-lead", "Lead"];
    if (k === "call") return ["☎", "t-call", "Call"];
    if (k === "click") return ["➤", "t-click", "Click"];
    if (k === "impression") return ["◉", "t-impr", "Impression"];
    return ["•", "t-other", t ? String(t) : "Event"];
  };
  return `
  <div class="card sr-activity-card">
    <div class="card-pad dash-card-head"><div><div class="card-title">${I.clock} Recent attributed activity</div><div class="dash-card-sub">Latest attributed events, newest first.</div></div></div>
    ${rows.length ? `<div class="sr-activity-list">${rows.map((row) => {
      const m = meta(row.type);
      const where = [row.channel, row.platform, row.source].filter(Boolean).map(srDisplay).join(" · ");
      return `
      <div class="sr-activity-row">
        <span class="sr-act-icon ${m[1]}" title="${esc(m[2])}">${m[0]}</span>
        <div class="a-body"><b>${row.value != null && row.value !== "" ? `${srFmtNum(row.value, "money")} — ` : ""}${esc(m[2])}</b><span>${esc(where || "Unattributed")}</span></div>
        <time>${esc(timeAgo(row.eventAt))}</time>
      </div>`;
    }).join("")}</div>` : `<div class="empty-note compact">No attributed activity in this view yet.</div>`}
  </div>`;
}

/* deterministic client-side signals: |delta| ≥ 15% with enough baseline volume */
function srInsightsData() {
  const r = S.reporting;
  const o = r.overview || {};
  const cur = o.current || {}, prev = o.previous || {}, deltas = o.deltas || {};
  const out = [];
  const baselineFor = { revenue: prev.revenue, spend: prev.spend, roas: prev.revenue, leads: prev.leads, sales: prev.sales, cpl: prev.leads };
  for (const k of SR_KPIS) {
    const d = Number(deltas[k.key]);
    if (!isFinite(d) || Math.abs(d) < 15) continue;
    if (!(Number(baselineFor[k.key]) >= 10)) continue;
    const pct = Math.abs(Math.round(d * 10) / 10);
    const dir = d > 0 ? "up" : "down";
    const text = `${k.label} is ${dir} ${pct}% vs the previous period (${srFmtNum(prev[k.key], k.kind)} → ${srFmtNum(cur[k.key], k.kind)}).`;
    out.push({
      key: `kpi-${k.key}-${d > 0 ? "up" : "down"}`,
      good: k.invert ? d < 0 : d > 0,
      text,
      taskTitle: `Investigate ${k.label} ${d > 0 ? "+" : "−"}${pct}% vs previous period`,
      question: `On Smart Reporting, ${text} Why did that happen? Break down what changed and what we should do about it.`,
    });
  }
  for (const row of r.channels || []) {
    const d = Number(row.deltaPct);
    if (!isFinite(d) || Math.abs(d) < 15) continue;
    if (!(Number(row.revenue) >= 10)) continue;
    const pct = Math.abs(Math.round(d * 10) / 10);
    const dispName = srDisplay(row.name);
    const text = `${dispName} revenue is ${d > 0 ? "up" : "down"} ${pct}% vs the previous period (now ${srFmtNum(row.revenue, "money")}).`;
    out.push({
      key: `channel-${row.name}`,
      good: d > 0,
      text,
      taskTitle: `Investigate ${dispName} revenue ${d > 0 ? "+" : "−"}${pct}% vs previous period`,
      question: `On Smart Reporting, ${text} What is driving it and is it worth acting on?`,
    });
  }
  return out.filter((i) => !r.dismissedInsights.includes(i.key)).slice(0, 6);
}

function srInsightsHtml() {
  const items = srInsightsData();
  const b = srRangeBounds(S.reporting.range, S.reporting.customFrom, S.reporting.customTo);
  return `
  <div class="card sr-insights-card">
    <div class="card-pad dash-card-head">
      <div><div class="card-title"><img src="/monki-mark.svg" class="sr-monki-mark" alt=""> Monki insights</div>
      <div class="dash-card-sub">Rule-based signals from this exact view — ${esc(fmtDate(b.from))} → ${esc(fmtDate(b.to))}. Only moves of 15%+ with enough volume are shown.</div></div>
    </div>
    ${items.length ? items.map((ins, i) => `
    <div class="sr-insight ${ins.good ? "good" : "bad"}">
      <span class="sr-insight-dot"></span>
      <p>${esc(ins.text)}</p>
      <div class="sr-insight-actions">
        <button class="btn ghost sm" onclick="App.srInvestigate(${i})">${I.sparkle} Investigate</button>
        <button class="btn ghost sm" onclick="App.srInsightTask(${i})">${I.plus} Create task</button>
        <button class="btn ghost sm" onclick="App.srDismissInsight('${jsq(ins.key)}')">Dismiss</button>
      </div>
    </div>`).join("") : `<div class="empty-note compact">No significant moves in this view — nothing crossed the 15% signal threshold.</div>`}
    ${aiOn("ask") ? `
    <form class="sr-ask" onsubmit="App.srAsk(event)">
      <img src="/monki-mark.svg" alt="">
      <input name="q" maxlength="500" placeholder="Ask Monki about this data — it inherits the current range and filters…" aria-label="Ask Monki about this data">
      <button class="btn neon sm" type="submit">${I.send} Ask</button>
    </form>` : ""}
  </div>`;
}

function srSkeletonHtml() {
  return `
  <div class="kpi-grid sr-kpis">${Array.from({ length: 6 }).map(() => `<div class="kpi sr-kpi"><div class="sr-skel-line w40"></div><div class="sr-skel-line big w70"></div><div class="sr-skel-line w50"></div></div>`).join("")}</div>
  <div class="card sr-skel-card"><div class="sr-skel-line w30"></div><div class="sr-skel-chart"></div></div>
  <div class="sr-mid-grid">
    <div class="card sr-skel-card"><div class="sr-skel-line w40"></div><div class="sr-skel-line w80"></div><div class="sr-skel-line w70"></div><div class="sr-skel-line w80"></div></div>
    <div class="card sr-skel-card"><div class="sr-skel-line w40"></div><div class="sr-skel-line w70"></div><div class="sr-skel-line w80"></div><div class="sr-skel-line w50"></div></div>
  </div>`;
}

function viewSmartReporting() {
  const r = S.reporting;
  const st = r.status;
  if (!st) {
    return `<div class="card"><div class="empty-note">Checking the reporting connection…</div></div>`;
  }
  if (!st.connected) {
    return srNotConnectedHtml();
  }
  const body = r.error
    ? `<div class="card"><div class="empty-note"><b>Smart Reporting could not load.</b><br><small>${esc(r.error)}</small><br><br><button class="btn primary sm" onclick="App.retryReporting()">${I.recurring} Retry</button></div></div>`
    : !r.loaded
      ? srSkeletonHtml()
      : `
      ${srKpiStripHtml()}
      ${srTrendCardHtml()}
      <div class="sr-mid-grid">${srChannelCardsHtml()}${srMixHtml()}</div>
      ${srCampaignTableHtml()}
      <div class="sr-mid-grid">${srActivityHtml()}${srInsightsHtml()}</div>`;
  return `
  ${srPageHeadHtml(st)}
  ${srToolbarHtml(st)}
  ${srStaleBannerHtml(st)}
  ${srBreadcrumbHtml()}
  ${body}`;
}

/* KPI count-up: eases from 0 to the loaded value, formatted with srFmtNum at
 * every frame so the final text is exactly what a static render would show.
 * Skipped entirely under prefers-reduced-motion. */
function srCountUpKpis() {
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const cur = (S.reporting.overview || {}).current || {};
  const els = document.querySelectorAll("#content .sr-kpis .sr-kpi .k-value");
  els.forEach((el, i) => {
    const meta = SR_KPIS[i];
    if (!meta) return;
    const raw = cur[meta.key];
    const target = Number(raw);
    if (raw === null || raw === undefined || raw === "" || isNaN(target)) return; // "—" stays
    const t0 = performance.now();
    const dur = 750;
    const tick = (now) => {
      if (!el.isConnected) return;
      const p = Math.min(1, (now - t0) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      el.textContent = p < 1 ? srFmtNum(target * eased, meta.kind) : srFmtNum(raw, meta.kind);
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/* measure the trend line so the CSS draw-in covers exactly its length (hourly
 * buckets can produce far longer paths than the 2200px default assumes) */
function srChartDrawIn() {
  const line = document.querySelector("#content .sr-chart .sr-line");
  if (!line || typeof line.getTotalLength !== "function") return;
  try {
    line.style.setProperty("--sr-line-len", String(Math.ceil(line.getTotalLength()) + 2));
  } catch { /* the CSS default stays */ }
}

/* ------------------------------ performance (basic tier) ------------------------------ */
/* The calm client/team page fed by GET /api/reporting/basic. Everything here
 * is presentation-only: the API already sends friendly channel/campaign names
 * and calm highlight phrasing — no diagnostics ever surface on this page. */

const PERF_RANGE_OPTIONS = [["last_7", "Last 7 days"], ["last_30", "Last 30 days"], ["this_month", "This month"]];
const PERF_KPIS = [
  { key: "revenue", label: "Revenue", kind: "money" },
  { key: "leads", label: "Leads", kind: "num" },
  { key: "sales", label: "Sales", kind: "num" },
  { key: "roas", label: "ROAS", kind: "ratio" },
];
const PERF_TONE_ICONS = { up: "↗", flat: "→", down: "↘" };

/* calm delta chips: a down move gets the same neutral styling as flat — never
 * alarm colours on a client-facing page */
function perfDeltaChip(pct) {
  if (pct === null || pct === undefined || isNaN(Number(pct))) return "";
  const n = Number(pct);
  if (n === 0) return `<span class="perf-delta flat">± 0%</span>`;
  const rounded = Math.abs(Math.round(n * 10) / 10);
  return `<span class="perf-delta ${n > 0 ? "up" : "down"}">${n > 0 ? "▲" : "▼"} ${rounded}%</span>`;
}

async function loadPerformance(force) {
  const rb = S.reportingBasic;
  if (!rb.allowed) return;
  if (rb.loading) return;
  if (rb.loaded && !force) return;
  const req = (rb.req || 0) + 1;
  rb.req = req;
  rb.loading = true;
  rb.error = "";
  if (S.route === "performance") renderPage("performance");
  const b = srRangeBounds(rb.range, "", "");
  try {
    const data = await api(`/api/reporting/basic?from=${b.from}&to=${b.to}`);
    if (rb.req !== req) return;
    rb.data = data;
    rb.loaded = true;
  } catch (e) {
    if (rb.req !== req) return;
    if (e && e.status === 403) { // access revoked mid-session — hide the page again
      rb.allowed = false;
      rb.loading = false;
      renderApp();
      return;
    }
    rb.error = "load";
    rb.loaded = true; // attempted — no auto-retry loop; the error card offers Retry
  }
  rb.loading = false;
  if (S.route === "performance") renderPage("performance");
}

function perfTrendCardHtml(data) {
  const rows = Array.isArray(data.trend) ? data.trend : [];
  const range = data.range || {};
  const head = `
    <div class="card-pad sr-chart-head">
      <div><div class="card-title">${I.results} Revenue trend</div>
      <div class="dash-card-sub">${esc(fmtDate(range.from))} → ${esc(fmtDate(range.to))} · daily</div></div>
    </div>`;
  if (!rows.length) {
    return `<div class="card sr-chart-card perf-chart-card">${head}<div class="empty-note">No revenue in this period yet — new results appear here automatically.</div></div>`;
  }
  const vals = rows.map((x) => Number(x.revenue) || 0);
  const W = 720, H = 230, pl = 48, pr = 12, pt = 12, pb = 26;
  const iw = W - pl - pr, ih = H - pt - pb;
  const n = vals.length;
  const max = Math.max(1, ...vals);
  const x = (i) => pl + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v) => pt + ih - (Math.max(0, v) / max) * ih;
  const linePath = vals.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const areaPath = `${linePath} L${x(n - 1).toFixed(1)},${(pt + ih).toFixed(1)} L${x(0).toFixed(1)},${(pt + ih).toFixed(1)} Z`;
  const gridLines = [0.25, 0.5, 0.75, 1].map((f) => {
    const gy = y(max * f);
    return `<line x1="${pl}" y1="${gy.toFixed(1)}" x2="${W - pr}" y2="${gy.toFixed(1)}" class="sr-grid"/><text x="${pl - 6}" y="${(gy + 3.5).toFixed(1)}" class="sr-axis" text-anchor="end">${srFmtCompact(max * f)}</text>`;
  }).join("");
  const labelEvery = Math.max(1, Math.ceil(n / 7));
  const xLabels = rows.map((row, i) => (i % labelEvery === 0
    ? `<text x="${x(i).toFixed(1)}" y="${H - 8}" class="sr-axis" text-anchor="middle">${esc(srBucketLabel(row.bucket))}</text>` : "")).join("");
  return `
  <div class="card sr-chart-card perf-chart-card">
    ${head}
    <div class="sr-chart-wrap">
      <svg viewBox="0 0 ${W} ${H}" class="sr-chart" role="img" aria-label="Revenue trend chart">
        <defs><linearGradient id="perfAreaFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#b8ff2e" stop-opacity=".38"/><stop offset="1" stop-color="#b8ff2e" stop-opacity="0"/>
        </linearGradient></defs>
        ${gridLines}
        <path d="${areaPath}" class="sr-area" fill="url(#perfAreaFill)"/>
        <path d="${linePath}" class="sr-line"/>
        ${xLabels}
      </svg>
    </div>
  </div>`;
}

function perfChannelsHtml(data) {
  const rows = Array.isArray(data.channels) ? data.channels : [];
  const head = `<div class="card-pad dash-card-head"><div><div class="card-title">${I.dashboard} Channels</div><div class="dash-card-sub">Where your results came from in this period.</div></div></div>`;
  if (!rows.length) return `<div class="card perf-channels-card">${head}<div class="empty-note compact">No channel results in this period yet.</div></div>`;
  return `
  <div class="card perf-channels-card">
    ${head}
    <div class="sr-channel-list">
      ${rows.map((row) => {
        const share = Math.min(100, Math.max(0, Number(row.sharePct) || 0));
        return `
        <div class="perf-channel">
          <div class="sr-channel-top"><b>${esc(row.name)}</b><span class="sr-share">${Math.round(share * 10) / 10}% of revenue</span></div>
          <div class="sr-share-bar"><i style="width:${Math.max(1.5, share)}%"></i></div>
          <div class="sr-channel-stats">
            <span>Revenue <b>${srFmtNum(row.revenue, "money")}</b></span>
            <span>Leads <b>${srFmtNum(row.leads, "num")}</b></span>
            <span>Sales <b>${srFmtNum(row.sales, "num")}</b></span>
          </div>
        </div>`;
      }).join("")}
    </div>
  </div>`;
}

function perfHighlightsHtml(data) {
  const items = Array.isArray(data.highlights) ? data.highlights : [];
  const head = `<div class="card-pad dash-card-head"><div><div class="card-title">${I.sparkle} Highlights</div><div class="dash-card-sub">The short version, in plain language.</div></div></div>`;
  if (!items.length) return `<div class="card perf-highlights-card">${head}<div class="empty-note compact">Nothing notable to call out in this period yet.</div></div>`;
  return `
  <div class="card perf-highlights-card">
    ${head}
    <div class="perf-highlight-list">
      ${items.map((h) => {
        const tone = ["up", "flat", "down"].includes(h && h.tone) ? h.tone : "flat";
        return `<div class="perf-highlight ${tone}"><span class="perf-highlight-icon">${PERF_TONE_ICONS[tone]}</span><p>${esc(h.text)}</p></div>`;
      }).join("")}
    </div>
  </div>`;
}

function perfCampaignsHtml(data) {
  const rows = Array.isArray(data.campaigns) ? data.campaigns : [];
  const head = `<div class="card-pad dash-card-head"><div><div class="card-title">${I.tasks} Top campaigns</div><div class="dash-card-sub">Your best-performing campaigns by revenue in this period.</div></div></div>`;
  if (!rows.length) return `<div class="card perf-campaigns-card">${head}<div class="empty-note compact">No campaign results in this period yet.</div></div>`;
  return `
  <div class="card perf-campaigns-card">
    ${head}
    <div class="perf-campaign-list">
      ${rows.map((row, i) => `
      <div class="perf-campaign">
        <span class="perf-rank">${i + 1}</span>
        <span class="perf-campaign-name" title="${esc(row.name)}">${esc(row.name)}</span>
        <span class="perf-campaign-stats">Revenue <b>${srFmtNum(row.revenue, "money")}</b> · Sales <b>${srFmtNum(row.sales, "num")}</b></span>
      </div>`).join("")}
    </div>
  </div>`;
}

function viewPerformance() {
  const rb = S.reportingBasic;
  const data = rb.data || {};
  const range = data.range || {};
  const toolbar = `
  <div class="card sr-toolbar perf-toolbar">
    <div class="sr-toolbar-row">
      <div class="range-presets" role="group" aria-label="Performance period">
        ${PERF_RANGE_OPTIONS.map(([v, l]) => `<button class="${rb.range === v ? "active" : ""}" onclick="App.perfRange('${v}')">${l}</button>`).join("")}
      </div>
      <span class="sr-toolbar-spacer"></span>
      ${rb.loading && rb.loaded ? `<span class="results-loading">Updating…</span>` : ""}
    </div>
    ${rb.loaded && !rb.error && range.from ? `<div class="sr-toolbar-sub">${esc(fmtDate(range.from))} → ${esc(fmtDate(range.to))} <span>vs the previous period</span></div>` : ""}
  </div>`;
  if (rb.error) {
    return toolbar + `
    <div class="card"><div class="empty-note"><b>Your performance data could not be loaded right now.</b><br><small>Please try again in a moment.</small><br><br><button class="btn primary sm" onclick="App.perfRetry()">${I.recurring} Retry</button></div></div>`;
  }
  if (!rb.loaded) return toolbar + srSkeletonHtml();
  const cur = data.current || {};
  const deltas = cur.deltas || {};
  return `
  ${toolbar}
  <div class="kpi-grid sr-kpis perf-kpis">
    ${PERF_KPIS.map((k) => `
    <div class="kpi sr-kpi perf-kpi">
      <div class="k-label">${k.label}</div>
      <div class="k-value">${srFmtNum(cur[k.key], k.kind)}</div>
      <div class="k-sub sr-kpi-sub">${perfDeltaChip(deltas[k.key])}<span>vs previous period</span></div>
    </div>`).join("")}
  </div>
  ${perfTrendCardHtml(data)}
  <div class="sr-mid-grid">${perfChannelsHtml(data)}${perfHighlightsHtml(data)}</div>
  ${perfCampaignsHtml(data)}
  ${range.to ? `<div class="perf-updated">Your synced marketing data · updated through ${esc(fmtDate(range.to))}</div>` : ""}`;
}

/* ------------------------------ reports library ------------------------------ */
/* The report library (Google Docs/Sheets/decks the team delivers) — visible to
 * every signed-in user; team + super admin can add entries, only the super
 * admin edits/deletes. Probe-free: the page always renders, data lazy-loads. */

const REP_KINDS = [["weekly", "Weekly reports"], ["monthly", "Monthly reports"], ["special", "Annual & special reports"]];
const REP_KIND_LABEL = { weekly: "Weekly", monthly: "Monthly", special: "Special" };
const REP_EMPTY = {
  weekly: "No weekly reports yet.",
  monthly: "No monthly reports yet.",
  special: "No annual or special reports yet.",
};
const MONTHS_FULL = ["January","February","March","April","May","June","July","August","September","October","November","December"];

function repMonthLabel(periodMonth) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(periodMonth || ""));
  if (!m) return String(periodMonth || "Undated");
  return `${MONTHS_FULL[Number(m[2]) - 1]} ${m[1]}`;
}

function repLinkLabel(link) {
  const label = String((link && link.label) || "").trim();
  if (label) return label;
  try { return new URL(link.url).hostname.replace(/^www\./, ""); } catch { return "Open link"; }
}

async function loadReports(force) {
  const st = S.reports;
  if (st.loading) return;
  if (st.loaded && !force) return;
  st.loading = true;
  st.error = "";
  if (S.route === "reports") renderPage("reports");
  try {
    const r = await api("/api/reports");
    st.items = (r && r.reports) || [];
    st.loaded = true;
  } catch (e) {
    st.error = e.message;
    st.items = st.items || [];
    st.loaded = true; // attempted — the error card offers Retry, no auto-retry loop
  }
  st.loading = false;
  if (S.route === "reports") renderPage("reports");
}

function renderReports(el) {
  el.innerHTML = viewReports();
  if (!S.reports.loaded && !S.reports.loading) loadReports();
}

function repCardHtml(r) {
  const links = (r.links || []).filter((l) => l && l.url);
  const kind = REP_KIND_LABEL[r.kind] || "Report";
  return `
  <div class="rep-card">
    <div class="rep-card-main">
      <div class="rep-card-top">
        <b class="rep-title">${esc(r.title)}</b>
        <span class="rep-kind ${esc(r.kind)}">${esc(kind)}</span>
      </div>
      ${r.description ? `<p class="rep-desc">${esc(r.description)}</p>` : ""}
      ${links.length ? `<div class="rep-links">${links.map((l) => `<a class="rep-link" href="${esc(l.url)}" target="_blank" rel="noopener" title="${esc(l.url)}">${I.ext}<span>${esc(repLinkLabel(l))}</span></a>`).join("")}</div>` : ""}
      <div class="rep-meta">${r.createdBy ? `Added by ${esc(r.createdBy)} · ` : ""}${esc(timeAgo(r.updatedAt || r.createdAt))}</div>
    </div>
    ${isAdmin() ? `<div class="rep-card-actions">
      <button class="btn ghost sm" onclick="App.openEditReport('${esc(String(r.id))}')">Edit</button>
      <button class="btn ghost sm danger-text" onclick="App.deleteReport('${esc(String(r.id))}')">Delete</button>
    </div>` : ""}
  </div>`;
}

function viewReports() {
  const st = S.reports;
  const items = st.items || [];
  const bar = `
  <div class="rep-bar">
    <div class="rep-bar-note">Every report the team delivers — Google Docs, Sheets and decks — grouped by the month it covers.</div>
    ${isTeam() ? `<button class="btn primary" onclick="App.openAddReport()">${I.plus} Add report</button>` : ""}
  </div>`;
  if (st.error) {
    return bar + `<div class="card"><div class="empty-note"><b>The report library could not be loaded.</b><br><small>${esc(st.error)}</small><br><br><button class="btn primary sm" onclick="App.reportsReload()">${I.recurring} Retry</button></div></div>`;
  }
  if (!st.loaded) {
    return bar + `<div class="card"><div class="empty-note">Loading the report library…</div></div>`;
  }
  return bar + REP_KINDS.map(([kind, label]) => {
    const rows = items.filter((r) => r.kind === kind);
    const months = [...new Set(rows.map((r) => r.periodMonth))].sort().reverse(); // YYYY-MM sorts chronologically
    return `
    <section class="rep-section">
      <div class="rep-section-head"><h2>${esc(label)}</h2><span class="count">${rows.length ? `(${rows.length})` : ""}</span></div>
      ${rows.length ? months.map((m) => `
        <div class="rep-month">${esc(repMonthLabel(m))}</div>
        <div class="rep-grid">${rows.filter((r) => r.periodMonth === m).map(repCardHtml).join("")}</div>`).join("")
      : `<div class="card"><div class="empty-note compact">${esc(REP_EMPTY[kind])}${isTeam() ? " Add the first one with the button above." : ""}</div></div>`}
    </section>`;
  }).join("");
}

/* ------------------------------ generate report (super tier) ------------------------------ */

const REP_GEN_PRESETS = [["last_7", "Last 7 days"], ["last_30", "Last 30 days"], ["this_month", "This month"], ["last_month", "Last month"], ["custom", "Custom dates"]];

function repGenBounds(preset, customFrom, customTo) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  if (preset === "last_7") return { from: localISODate(addDays(today, -6)), to: localISODate(today) };
  if (preset === "this_month") return { from: localISODate(new Date(today.getFullYear(), today.getMonth(), 1)), to: localISODate(today) };
  if (preset === "last_month") {
    return { from: localISODate(new Date(today.getFullYear(), today.getMonth() - 1, 1)), to: localISODate(new Date(today.getFullYear(), today.getMonth(), 0)) };
  }
  if (preset === "custom") return { from: customFrom || "", to: customTo || "" };
  return { from: localISODate(addDays(today, -29)), to: localISODate(today) }; // last_30 default
}

/* Defense in depth for the modal preview: the server already builds the report
 * HTML from a safe subset with all model text escaped — this re-checks the
 * allowlist before it lands in the DOM. Regex-based on purpose: the input is
 * our own tiny tag subset, and this works identically in every environment. */
const REP_PREVIEW_TAGS = "h1|h2|h3|p|ul|ol|li|strong|b|em|br|table|thead|tbody|tr|th|td";
function repSanitizeHtml(html) {
  let s = String(html || "");
  s = s.replace(/<\s*(script|style|iframe|object|embed|form|input|button|link|meta)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, ""); // dangerous elements, contents included
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(new RegExp(`<(${REP_PREVIEW_TAGS})\\s+[^<>]*>`, "gi"), "<$1>"); // strip attributes from allowed tags
  s = s.replace(new RegExp(`<\\/(?!(?:${REP_PREVIEW_TAGS})\\s*>)[^<>]*>`, "gi"), ""); // disallowed closing tags
  s = s.replace(new RegExp(`<(?!\\/)(?!(?:${REP_PREVIEW_TAGS})(?:\\s|\\/?>))[^<>]*>`, "gi"), ""); // disallowed opening tags — text survives
  return s.trim();
}

function repPlainText(html) {
  return repSanitizeHtml(html)
    .replace(/<li>/gi, "• ")
    .replace(/<\/(h1|h2|h3|p|li|tr)>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " | ")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/* ------------------------------ board ------------------------------ */

function dueInfo(t) {
  if (!t.dueDate) return null;
  const d = new Date(String(t.dueDate).length === 10 ? t.dueDate + "T00:00:00" : t.dueDate);
  if (isNaN(d)) return { label: t.dueDate, overdue: false };
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return { label: fmtDate(t.dueDate), overdue: isOpen(t) && d < today };
}

function boardCard(t) {
  // red edge = genuinely blocked right now (waiting states / revision bounced back)
  const blocked =
    t.blocker &&
    (t.status.startsWith("Waiting") || t.status === "Revision Required" || t.status === "Ready / Waiting");
  const due = dueInfo(t);
  return `
  <div class="board-card ${blocked ? "blocked" : ""}" ${isTeam() ? `draggable="true" ondragstart="App.boardDragStart(event,'${esc(t.id)}')" ondragend="App.boardDragEnd(event)"` : ""} onclick="App.boardCardClick('${esc(t.id)}')">
    <div class="bc-id">${isTeam() ? `<span class="drag-handle" title="Drag to change status">⠿</span>` : ""}${esc(t.id)} ${taskOriginBadge(t)}</div>
    <div class="bc-title">${esc(t.title)}</div>
    <div class="bc-departments">${departmentSignals(t, false)}</div>
    <div class="bc-foot">
      <span class="pill ${prioClass(t.priority)}">${esc(t.priority)}</span>
      ${t.status === "Waiting on Client" ? `<span class="pill status-WaitingonClient"><span class="dot"></span>Client</span>` : ""}
      ${t.status === "Revision Required" ? `<span class="pill status-RevisionRequired"><span class="dot"></span>Revision</span>` : ""}
      ${due ? `<span class="due-chip ${due.overdue ? "overdue" : ""}">${due.overdue ? "⚠ " : ""}${due.label}</span>` : ""}
      ${visBadge(t)}
      <span class="bc-owner">${esc(t.owner || "Unassigned")}</span>
    </div>
    ${isTeam() ? `<select class="board-mobile-move" aria-label="Move ${esc(t.title)}" onclick="event.stopPropagation()" onchange="App.boardMove('${esc(t.id)}',this.value)">${S.data.meta.statuses.map((status) => `<option value="${esc(status)}" ${t.status === status ? "selected" : ""}>${esc(status)}</option>`).join("")}</select>` : ""}
  </div>`;
}

function viewBoard() {
  const f = S.boardFilters;
  const tasks = S.data.tasks.filter((task) => {
    if (f.department && !(task.departmentIds || []).includes(f.department)) return false;
    if (f.priority && task.priority !== f.priority) return false;
    if (f.owner && !(task.ownerUsernames || []).includes(f.owner)) return false;
    return inDateRange(task, f);
  });
  const hasFilters = f.department || f.priority || f.owner || f.dateFrom || f.dateTo || f.range !== "all";
  return `<div class="board-filter-shell">
    <div class="board-filter-copy"><b>${isTeam() ? "Drag cards to move work" : "Open a card to review work"}</b><span>${isTeam() ? "Drop a card into another stage; the task status updates immediately." : "Only the delivery team can change workflow stages."}</span></div>
    <div class="filters board-filters">
      <select onchange="App.boardFilter('department',this.value)"><option value="">All departments</option>${departments().map((d) => `<option value="${esc(d.id)}" ${f.department === d.id ? "selected" : ""}>${esc(d.name)}</option>`).join("")}</select>
      <select onchange="App.boardFilter('owner',this.value)" aria-label="Filter board by owner"><option value="">Everyone</option>${teamUsers().map((u) => `<option value="${esc(u.username)}" ${f.owner === u.username ? "selected" : ""}>${esc(u.name)}</option>`).join("")}</select>
      <select onchange="App.boardFilter('priority',this.value)"><option value="">All priorities</option>${S.data.meta.priorities.map((p) => `<option ${f.priority === p ? "selected" : ""}>${esc(p)}</option>`).join("")}</select>
      <select onchange="App.boardFilter('dateField',this.value)"><option value="due" ${f.dateField === "due" ? "selected" : ""}>Due date</option><option value="created" ${f.dateField === "created" ? "selected" : ""}>Created date</option><option value="updated" ${f.dateField === "updated" ? "selected" : ""}>Updated date</option></select>
      <select onchange="App.boardRange(this.value)">${rangeOptions(f.range)}</select>
      <label class="date-filter"><span>From</span><input type="date" value="${esc(f.dateFrom)}" onchange="App.boardCustomDate('dateFrom',this.value)"></label>
      <label class="date-filter"><span>To</span><input type="date" value="${esc(f.dateTo)}" onchange="App.boardCustomDate('dateTo',this.value)"></label>
      ${hasFilters ? `<button class="btn ghost sm" onclick="App.clearBoardFilters()">Clear</button>` : ""}
      <span class="filter-result-count">${tasks.length} task${tasks.length === 1 ? "" : "s"}</span>
    </div>
  </div>
  <div class="board">
    ${BOARD_COLS.map((col) => {
      const list = tasks
        .filter((t) => col.statuses.includes(t.status))
        .sort((a, b) => new Date(lastTs(b)) - new Date(lastTs(a)));
      return `
      <div class="board-col" data-status="${esc(col.dropStatus)}" ondragover="App.boardDragOver(event)" ondragleave="App.boardDragLeave(event)" ondrop="App.boardDrop(event,'${esc(col.dropStatus)}')">
        <div class="board-col-head"><span>${col.label}<small>${isTeam() ? `Drop → ${esc(col.dropStatus)}` : ""}</small></span><span class="col-count">${list.length}</span></div>
        ${list.length ? list.map(boardCard).join("") : `<div class="board-col-empty">No tasks</div>`}
      </div>`;
    }).join("")}
  </div>`;
}

/* ------------------------------ calendar ------------------------------ */

function calendarTasks() {
  const c = S.calendar;
  return S.data.tasks.filter((task) => {
    if (c.scope === "mine" && !taskBelongsToMe(task)) return false;
    if (c.scope === "department" && (!c.department || !(task.departmentIds || []).includes(c.department))) return false;
    return true;
  });
}

function viewCalendar() {
  const c = S.calendar;
  const cursor = new Date(`${c.cursor}T00:00:00`);
  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const first = new Date(year, month, 1);
  const gridStart = new Date(first);
  gridStart.setDate(1 - ((first.getDay() + 6) % 7));
  const tasks = calendarTasks();
  const scheduled = tasks.filter((task) => task.dueDate);
  const unscheduled = tasks.filter((task) => !task.dueDate && isOpen(task));
  const today = localISODate();
  const monthKey = `${year}-${String(month + 1).padStart(2, "0")}`;
  const monthTasks = scheduled.filter((task) => String(task.dueDate).startsWith(monthKey));
  const overdue = scheduled.filter((task) => isOpen(task) && task.dueDate < today);
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const day = new Date(gridStart); day.setDate(gridStart.getDate() + i);
    const iso = localISODate(day);
    const dayTasks = scheduled.filter((task) => String(task.dueDate).slice(0, 10) === iso)
      .sort((a, b) => (a.priority === "Critical" ? -1 : 1) - (b.priority === "Critical" ? -1 : 1));
    cells.push(`<div class="calendar-day ${day.getMonth() === month ? "" : "outside"} ${iso === today ? "today" : ""}">
      <div class="calendar-date"><span>${day.getDate()}</span>${iso === today ? `<b>Today</b>` : ""}</div>
      <div class="calendar-day-tasks">${dayTasks.slice(0, 4).map((task) => {
        const department = deptById(taskDepartmentIds(task)[0]) || { color: "#64748b", icon: "◆" };
        return `<button class="calendar-task ${isOpen(task) ? "" : "done"}" style="--dept:${esc(department.color)}" onclick="App.openTask('${esc(task.id)}')" title="${esc(task.title)}"><i>${esc(department.icon)}</i><span>${esc(task.title)}</span></button>`;
      }).join("")}${dayTasks.length > 4 ? `<button class="calendar-more" onclick="App.calendarDay('${iso}')">+${dayTasks.length - 4} more</button>` : ""}</div>
    </div>`);
  }
  const scopeLabel = c.scope === "mine" ? "My tasks" : c.scope === "department" ? ((deptById(c.department) || {}).name || "Department tasks") : "Overall visible tasks";
  return `<div class="calendar-page">
    <div class="calendar-toolbar card">
      <div class="calendar-nav"><button class="btn ghost sm" onclick="App.calendarMove(-1)" aria-label="Previous month">←</button><button class="btn ghost sm" onclick="App.calendarToday()">Today</button><button class="btn ghost sm" onclick="App.calendarMove(1)" aria-label="Next month">→</button><h2>${cursor.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</h2></div>
      <div class="calendar-scope" role="group" aria-label="Calendar task scope"><button class="${c.scope === "mine" ? "active" : ""}" onclick="App.calendarScope('mine')">My tasks</button><button class="${c.scope === "all" ? "active" : ""}" onclick="App.calendarScope('all')">Overall tasks</button><button class="${c.scope === "department" ? "active" : ""}" onclick="App.calendarScope('department')">Department</button></div>
      <select onchange="App.calendarDepartment(this.value)" aria-label="Calendar department" ${c.scope !== "department" ? "disabled" : ""}><option value="">Choose department</option>${departments().map((d) => `<option value="${esc(d.id)}" ${c.department === d.id ? "selected" : ""}>${esc(d.icon)} ${esc(d.name)}</option>`).join("")}</select>
    </div>
    <div class="calendar-summary"><div><b>${monthTasks.length}</b><span>due this month</span></div><div class="danger"><b>${overdue.length}</b><span>overdue</span></div><div><b>${unscheduled.length}</b><span>without a due date</span></div><p>Showing <strong>${esc(scopeLabel)}</strong>. Click any task to open it.</p></div>
    <div class="calendar-shell card"><div class="calendar-weekdays">${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) => `<span>${day}</span>`).join("")}</div><div class="calendar-grid">${cells.join("")}</div></div>
    ${unscheduled.length ? `<div class="card unscheduled-card"><div class="card-pad"><div class="card-title">${I.calendar} Needs a due date <span class="count">(${unscheduled.length})</span></div><p>These ${scopeLabel.toLowerCase()} will appear on the calendar after a due date is added.</p></div><div class="unscheduled-list">${unscheduled.slice(0, 12).map((task) => `<button onclick="App.openTask('${esc(task.id)}')"><span>${esc(task.id)}</span><b>${esc(task.title)}</b>${departmentSignals(task, false)}</button>`).join("")}</div></div>` : ""}
  </div>`;
}

/* ------------------------------ my work ------------------------------ */

function viewMyWork() {
  const meEntry = S.directory.find((u) => u.username === S.me.username) || {};
  const myDepts = meEntry.departments || S.me.departments || [];
  const tasks = S.data.tasks;
  const open = tasks.filter(isOpen);
  const today = new Date().toISOString().slice(0, 10);
  const prioRank = { Critical: 0, High: 1, Medium: 2, Low: 3 };

  const mine = open
    .filter((t) => (t.ownerUsernames || []).includes(S.me.username) || t.privateFor === S.me.username)
    .sort((a, b) => prioRank[a.priority] - prioRank[b.priority] || (a.dueDate || "9") .localeCompare(b.dueDate || "9"));
  const deptRequests = open.filter((t) =>
    (t.departmentIds || []).some((id) => myDepts.includes(id)) && !(t.ownerUsernames || []).length);
  const deptOverview = myDepts.map((id) => {
    const department = deptById(id) || { id, name: id, color: "#64748b", icon: "◆" };
    const dt = tasks.filter((t) => (t.departmentIds || []).includes(id));
    const dOpen = dt.filter(isOpen);
    return {
      ...department,
      open: dOpen.length,
      total: dt.length,
      critical: dOpen.filter((t) => t.priority === "Critical").length,
      overdue: dOpen.filter((t) => t.dueDate && t.dueDate < today).length,
    };
  });

  const row = (t, extra) => `
    <div class="attn-item" onclick="App.openTask('${esc(t.id)}')">
      <div class="t">
        <div class="title">${esc(t.title)} ${visBadge(t)}</div>
        <div class="meta">${esc(t.id)} · ${departmentSignals(t)}${t.owner ? " · " + esc(t.owner) : ""}</div>
      </div>
      ${dueInfo(t) ? `<span class="due-chip ${dueInfo(t).overdue ? "overdue" : ""}">${dueInfo(t).overdue ? "⚠ " : ""}${dueInfo(t).label}</span>` : ""}
      <span class="pill ${prioClass(t.priority)}">${esc(t.priority)}</span>
      <span class="pill ${statusClass(t.status)}"><span class="dot"></span>${esc(t.status)}</span>
      ${extra || ""}
    </div>`;

  return `
  <div class="grid-2">
    <div class="card">
      <div class="card-pad" style="border-bottom:1px solid var(--line)">
        <div class="card-title">${I.tasks} My plate <span class="count">(${mine.length})</span></div>
      </div>
      ${mine.length ? mine.map((t) => row(t)).join("") : `<div class="empty-note">Nothing assigned to you right now.</div>`}
    </div>
    <div>
      <div class="card" style="margin-bottom:16px">
        <div class="card-pad" style="border-bottom:1px solid var(--line)">
          <div class="card-title">${I.alert} New requests for my departments <span class="count">(${deptRequests.length})</span></div>
        </div>
        ${deptRequests.length ? deptRequests.map((t) => row(t, `<button class="btn neon sm" onclick="event.stopPropagation();App.openTask('${esc(t.id)}')">Take it</button>`)).join("") : `<div class="empty-note">No unassigned department requests.</div>`}
      </div>
      <div class="card">
        <div class="card-pad" style="border-bottom:1px solid var(--line)">
          <div class="card-title">${I.board} Department overview</div>
        </div>
        <div class="card-pad">
          ${deptOverview.length ? deptOverview.map((d) => `
            <div class="dept-row">
              <div class="dname"><span class="dept-mini" style="--dept:${esc(d.color)}">${esc(d.icon)}</span>${esc(d.name)}</div>
              <div class="dept-bar"><span class="${d.open ? "has-open" : ""}" style="width:${d.total ? Math.round((d.open / d.total) * 100) : 0}%"></span></div>
              <div class="dnum">${d.open} open${d.critical ? ` · ${d.critical} critical` : ""}${d.overdue ? ` · ⚠ ${d.overdue}` : ""}</div>
            </div>`).join("") : `<div class="empty-note">No departments on your profile yet — the admin sets them.</div>`}
        </div>
      </div>
    </div>
  </div>`;
}

/* ------------------------------ tasks list ------------------------------ */

function viewTasks() {
  const f = S.filters;
  const tasks = S.data.tasks
    .filter((t) => {
      if (f.q) {
        const q = f.q.toLowerCase();
        const hay = `${t.id} ${t.title} ${t.owner} ${t.project} ${t.department} ${t.description} ${t.update} ${t.blocker} ${t.nextAction}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (f.status && t.status !== f.status) return false;
      if (f.scope === "open" && !isOpen(t)) return false;
      if (f.department && !(t.departmentIds || []).includes(f.department)) return false;
      if (f.priority && t.priority !== f.priority) return false;
      if (f.owner && !(t.ownerUsernames || []).includes(f.owner)) return false;
      if (!inDateRange(t, f)) return false;
      return true;
    })
    .sort((a, b) => new Date(lastTs(b)) - new Date(lastTs(a)));

  const deptOpts = departments();
  const ownerOpts = teamUsers();

  const hasFilters = f.q || f.status || f.scope || f.department || f.priority || f.owner || f.dateFrom || f.dateTo || f.range !== "all";
  return `
  ${S.taskFilterOrigin ? `<div class="task-filter-context"><span>Dashboard filter</span><b>${esc(S.taskFilterOrigin)}</b><small>${tasks.length} matching task${tasks.length === 1 ? "" : "s"}</small><button onclick="App.clearFilters()">Show all tasks</button></div>` : ""}
  <div class="filters">
    <input type="search" placeholder="Search title, ID, owner…" value="${esc(f.q)}" oninput="App.filter('q', this.value)">
    <select onchange="App.filter('status', this.value)">
      <option value="">All statuses</option>
      <option value="__open__" ${f.scope === "open" && !f.status ? "selected" : ""}>Open tasks</option>
      ${S.data.meta.statuses.map((s) => `<option ${f.status === s ? "selected" : ""}>${esc(s)}</option>`).join("")}
    </select>
    <select onchange="App.filter('department', this.value)">
      <option value="">All departments</option>
      ${deptOpts.map((d) => `<option value="${esc(d.id)}" ${f.department === d.id ? "selected" : ""}>${esc(d.name)}</option>`).join("")}
    </select>
    <select onchange="App.filter('priority', this.value)">
      <option value="">All priorities</option>
      ${S.data.meta.priorities.map((p) => `<option ${f.priority === p ? "selected" : ""}>${esc(p)}</option>`).join("")}
    </select>
    <select onchange="App.filter('owner', this.value)" aria-label="Filter tasks by owner">
      <option value="">Everyone</option>
      ${ownerOpts.map((u) => `<option value="${esc(u.username)}" ${f.owner === u.username ? "selected" : ""}>${esc(u.name)}</option>`).join("")}
    </select>
    <select onchange="App.filter('dateField',this.value)" aria-label="Choose task date"><option value="due" ${f.dateField === "due" ? "selected" : ""}>Due date</option><option value="created" ${f.dateField === "created" ? "selected" : ""}>Created date</option><option value="updated" ${f.dateField === "updated" ? "selected" : ""}>Updated date</option></select>
    <select onchange="App.taskRange(this.value)" aria-label="Choose date range">${rangeOptions(f.range)}</select>
    <label class="date-filter"><span>From</span><input type="date" value="${esc(f.dateFrom)}" onchange="App.taskCustomDate('dateFrom',this.value)"></label>
    <label class="date-filter"><span>To</span><input type="date" value="${esc(f.dateTo)}" onchange="App.taskCustomDate('dateTo',this.value)"></label>
    ${hasFilters ? `<button class="btn ghost sm" onclick="App.clearFilters()">Clear</button>` : ""}
    <span class="filter-result-count">${tasks.length} task${tasks.length === 1 ? "" : "s"}</span>
  </div>
  <div class="table-wrap">
    <table class="data">
      <thead><tr>
        <th>ID</th><th>Task</th><th>Department</th><th>Owner</th><th>Due</th><th>Priority</th><th>Status</th><th>Updated</th>
      </tr></thead>
      <tbody>
        ${tasks.length ? tasks.map((t) => {
          const due = dueInfo(t);
          return `
          <tr onclick="App.openTask('${esc(t.id)}')">
            <td class="t-id">${esc(t.id)}</td>
            <td><div class="t-title">${esc(t.title)} ${taskOriginBadge(t)} ${visBadge(t)}</div>${t.project ? `<div class="t-sub">${esc(t.project)}</div>` : ""}</td>
            <td>${departmentSignals(t)}</td>
            <td>${esc(t.owner || "—")}</td>
            <td style="white-space:nowrap">${due ? `<span class="due-chip ${due.overdue ? "overdue" : ""}">${due.overdue ? "⚠ " : ""}${due.label}</span>` : "—"}</td>
            <td><span class="pill ${prioClass(t.priority)}">${esc(t.priority)}</span></td>
            <td><span class="pill ${statusClass(t.status)}"><span class="dot"></span>${esc(t.status)}</span></td>
            <td style="white-space:nowrap;color:var(--muted);font-size:12px">${timeAgo(lastTs(t))}</td>
          </tr>`;
        }).join("") : `<tr><td colspan="8"><div class="empty-note">No tasks match the filters.</div></td></tr>`}
      </tbody>
    </table>
  </div>`;
}

/* ------------------------------ drawer ------------------------------ */

/* slim requested → due chip for the drawer head */
function timelineChipHtml(t) {
  const req = String(t.dateRequested || "").slice(0, 10);
  const due = taskDueISO(t);
  if (!req && !due) return "";
  let tail = "";
  if (due) {
    const days = dueDaysLeft(t);
    if (!isOpen(t)) tail = `<b class="tlc-done">${esc(t.status)}</b>`;
    else if (days < 0) tail = `<b class="tlc-over">⚠ ${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} overdue</b>`;
    else if (days === 0) tail = `<b class="tlc-soon">due today</b>`;
    else if (days === 1) tail = `<b class="tlc-soon">due tomorrow</b>`;
    else tail = `<b>${days} days left</b>`;
    return `<div class="timeline-chip">${I.clock}<span>Requested ${fmtDate(req)}</span><i>→</i><span>Due ${fmtDate(due)}</span>${tail}</div>`;
  }
  return `<div class="timeline-chip">${I.clock}<span>Requested ${fmtDate(req)}</span><b class="tlc-none">no due date yet</b></div>`;
}

function metaCell(k, v) {
  return `<div class="meta-cell"><div class="mk">${k}</div><div class="mv">${v || "—"}</div></div>`;
}

function renderDrawer() {
  const el = document.getElementById("drawer");
  if (!el) return;
  const t = S.data.tasks.find((x) => x.id === S.openTaskId);
  if (!t) {
    S.openTaskId = null;
    el.classList.remove("open");
    history.replaceState(null, "", `#/${S.route}`);
    toast("Task not found — it may have been removed", "err");
    return;
  }

  const updates = [...(t.updates || [])].reverse();
  const linkedDocs = S.data.links.filter((l) => l.taskId === t.id);
  const comments = t.comments || [];
  const subtasks = t.subtasks || [];
  const attachments = t.attachments || [];
  const myDepartments = S.me.departments || [];
  const canReview = isAdmin() || (t.ownerUsernames || []).includes(S.me.username) ||
    (!(t.ownerUsernames || []).length && (t.departmentIds || []).some((id) => myDepartments.includes(id)));
  const subtaskName = (id) => (subtasks.find((s) => s.id === id) || {}).title || "Main task";

  const actions = [];
  if (isTeam() && t.status === "New Request") actions.push(`<button class="btn neon" onclick="App.openModal('acceptTask')">Accept &amp; start</button>`);
  if (isClient() && t.status === "Ready for Review") {
    actions.push(`<button class="btn neon" onclick="App.confirmDone('${esc(t.id)}')">Confirm completed</button>`);
    actions.push(`<button class="btn danger" onclick="App.requestRevision('${esc(t.id)}')">Request revision</button>`);
  }
  if (isClient() && t.status === "New Request") actions.push(`<span class="da-label">Sent to the team — waiting for acceptance.</span>`);
  if (isTeam() && canReview && t.visibility === "shared" && attachments.length && attachments.every((file) => ["approved", "delivered"].includes(file.status)) && (!t.approval || t.approval.status !== "awaiting_review")) {
    actions.push(`<button class="btn neon" onclick="App.sendForApproval('${esc(t.id)}')">Send all for client approval</button>`);
  }
  if (isClient() && t.approval && t.approval.status === "awaiting_review") {
    actions.push(`<button class="btn neon" onclick="App.reviewTask('${esc(t.id)}','approve')">Approve task</button>`);
    actions.push(`<button class="btn ghost" onclick="App.reviewTask('${esc(t.id)}','request_changes',true)">Request changes</button>`);
  }
  const canDelete = isAdmin() || t.createdByUsername === S.me.username || (isTeam() && canReview);

  const attachmentHtml = (file) => {
    const statusLabel = {
      pending_review: "Pending owner review", approved: "Approved", rejected: "Rejected",
      delivered: "Delivered to NEONMONKI", submitted_by_client: "Submitted by NEONMONKI",
    }[file.status] || file.status;
    const clientLabel = file.clientStatus === "approved" ? "NEONMONKI approved" : file.clientStatus === "changes_requested" ? "Changes requested" : file.clientStatus === "awaiting_review" ? "Awaiting NEONMONKI review" : "";
    return `<div class="task-file-card ${esc(file.status)}"><div class="file-icon">🔗</div><div class="file-main"><a href="${esc(file.openUrl || file.downloadUrl)}" target="_blank" rel="noopener">${esc(file.name)} ${I.ext}</a><div class="file-meta">${esc(subtaskName(file.subtaskId))} · shared by ${esc(file.uploadedByName || file.uploadedBy)}</div><div class="file-status-row"><span class="file-status">${esc(statusLabel)}</span>${clientLabel ? `<span class="client-file-status">${esc(clientLabel)}</span>` : ""}</div>${file.feedback ? `<div class="file-feedback">${esc(file.feedback)}</div>` : ""}</div><div class="file-actions">
      ${isTeam() && canReview && ["pending_review","submitted_by_client","rejected"].includes(file.status) ? `<button class="btn neon sm" onclick="App.fileAction('${esc(t.id)}','${esc(file.id)}','approve')">Approve</button><button class="btn ghost sm danger-text" onclick="App.fileAction('${esc(t.id)}','${esc(file.id)}','reject',true)">Reject</button>` : ""}
      ${isTeam() && canReview && file.status === "approved" ? `<button class="btn primary sm" onclick="App.fileAction('${esc(t.id)}','${esc(file.id)}','deliver')">Deliver to NEONMONKI</button>` : ""}
      ${isClient() && file.deliveredToClient && file.clientStatus === "awaiting_review" ? `<button class="btn neon sm" onclick="App.fileAction('${esc(t.id)}','${esc(file.id)}','client_approve')">Approve</button><button class="btn ghost sm" onclick="App.fileAction('${esc(t.id)}','${esc(file.id)}','client_changes',true)">Request changes</button>` : ""}
    </div></div>`;
  };

  el.innerHTML = `<div class="drawer-head task-drawer-head"><div class="dh-top"><span class="dh-id">${esc(t.id)}</span>${taskOriginBadge(t)}<span class="pill ${statusClass(t.status)}"><span class="dot"></span>${esc(t.status)}</span><span class="pill ${prioClass(t.priority)}">${esc(t.priority)}</span>${visBadge(t)}</div><h2>${esc(t.title)}</h2><div class="drawer-dept-signals">${departmentSignals(t)}</div>${timelineChipHtml(t)}<button class="drawer-close" onclick="App.closeDrawer()">✕</button></div>
  <div class="drawer-actions">${actions.join("")}${aiOn("summaries") ? `<button class="btn ghost sm" onclick="App.summarizeTask('${esc(t.id)}')">${I.sparkle} AI summary</button>` : ""}${isTeam() ? `<span class="da-label">Status</span><select onchange="App.setStatus('${esc(t.id)}',this.value)">${S.data.meta.statuses.map((s) => `<option ${t.status === s ? "selected" : ""}>${esc(s)}</option>`).join("")}</select><button class="btn ghost sm" onclick="App.openModal('editTask')">Edit task</button>` : ""}${canDelete ? `<button class="btn ghost sm danger-text" onclick="App.deleteTask('${esc(t.id)}','${esc(t.title)}')">Delete task</button>` : ""}</div>
  <div class="drawer-body task-workspace">
    ${t.impact && String(t.impact).trim() ? `<div class="note-box impact"><div class="nb-label">Business impact</div>${esc(t.impact)}</div>` : ""}
    ${!(t.impact && String(t.impact).trim()) && isTeam() && t.priority === "Critical" && isOpen(t) ? `<div class="impact-prompt"><span>${I.alert}</span><p>This <b>Critical</b> task has no business-impact note yet — adding one helps everyone understand why it matters.</p><button class="btn ghost sm" onclick="App.openModal('editTask')">Add business impact</button></div>` : ""}
    <div class="task-overview-grid"><div class="section overview-card"><div class="section-h">Task details</div><div class="meta-grid">${metaCell("Departments", departmentSignals(t))}${metaCell("Owners", esc(t.owner || (t.assignmentMode === "whole_team" ? "Whole team" : "Department assignment")))}${metaCell("Project / Area", esc(t.project))}${metaCell("Requested by", esc(t.requestedBy))}${metaCell("Due date", fmtDate(t.dueDate))}${metaCell("Visibility", esc(t.visibility === "shared" ? "NEONMONKI + team" : t.visibility === "department" ? "Assigned departments" : t.visibility === "private" ? "Named owners" : "Whole team"))}</div></div>
      <div class="section overview-card"><div class="section-h">Progress</div>${t.nextAction ? `<div class="note-box next"><div class="nb-label">Next action</div>${esc(t.nextAction)}</div>` : `<div class="empty-note compact">No next action set.</div>`}${t.blocker ? `<div class="note-box blocker"><div class="nb-label">Blocker</div>${esc(t.blocker)}</div>` : ""}</div></div>
    ${t.description ? `<div class="section"><div class="section-h">Description</div><div class="desc-text">${esc(t.description)}</div></div>` : ""}
    ${t.approval ? `<div class="section approval-status-panel ${esc(t.approval.status)}"><div class="section-h">Client approval</div><b>${t.approval.status === "awaiting_review" ? "Waiting for client review" : t.approval.status === "approved" ? "Approved" : "Changes requested"}</b>${t.approval.feedback ? `<p>${esc(t.approval.feedback)}</p>` : ""}<small>${esc(t.approval.by || "")} · ${timeAgo(t.approval.ts)}</small></div>` : ""}

    <div class="section workflow-section"><div class="section-title-row"><div><div class="section-h">Subtasks <span class="count">(${subtasks.length})</span></div><div class="section-sub">Break down the main task and assign each part separately.</div></div>${isTeam() ? `<button class="btn primary sm" onclick="App.openModal('addSubtask')">${I.plus} Add subtask</button>` : ""}</div>
      <div class="subtask-list">${subtasks.length ? subtasks.map((s) => `<div class="subtask-card"><button class="subtask-check ${s.status === "Completed" ? "done" : ""}" ${isTeam() ? `onclick="App.updateSubtask('${esc(t.id)}','${esc(s.id)}',{status:'${s.status === "Completed" ? "In Progress" : "Completed"}'})"` : "disabled"}>${s.status === "Completed" ? "✓" : ""}</button><div class="subtask-main"><b>${esc(s.title)}</b><div class="subtask-meta">${(s.ownerUsernames || []).map((id) => esc((teamUsers().find((u) => u.username === id) || {}).name || id)).join(", ") || "Department assignment"} · ${departmentSignals({ departmentIds: s.departmentIds || [] }, false)}${s.dueDate ? ` · due ${fmtDate(s.dueDate)}` : ""}${s.clientVisible ? ` · <span class="client-safe-chip">visible to NEONMONKI</span>` : ""}</div>${s.description ? `<p>${esc(s.description)}</p>` : ""}</div><span class="pill ${statusClass(s.status)}">${esc(s.status)}</span>${isTeam() ? `<button class="icon-delete" title="Delete subtask" onclick="App.deleteSubtask('${esc(t.id)}','${esc(s.id)}')">✕</button>` : ""}</div>`).join("") : `<div class="empty-note compact">No subtasks yet.</div>`}</div>
    </div>

    <div class="section workflow-section"><div class="section-title-row"><div><div class="section-h">Links &amp; approvals <span class="count">(${attachments.length})</span></div><div class="section-sub">Share a Google Drive, Docs, Sheets, Figma, Dropbox or other HTTPS link → owner review → client delivery.</div></div><button class="btn ghost sm" onclick="App.addDrawerLinkRow()">${I.plus} Add another</button></div>
      <div class="task-file-list">${attachments.length ? attachments.map(attachmentHtml).join("") : `<div class="empty-note compact">No sharing links attached.</div>`}</div>
      <div class="drawer-link-rows">${drawerLinkRow(subtasks)}</div><button class="btn primary sm" onclick="App.shareDrawerLinks('${esc(t.id)}')">Share links</button>
    </div>

    ${linkedDocs.length ? `<div class="section"><div class="section-h">Linked documents</div>${linkedDocs.map((l) => `<div class="linked-doc">📄 ${linkify(l.url || l.title, l.title)}</div>`).join("")}</div>` : ""}

    <div class="section workflow-section comments-section">
      <div class="task-conversation-head"><div class="conversation-mark">${I.chat}</div><div><div class="section-h">Task conversation <span class="count">(${comments.filter((c) => !c.deleted).length})</span></div><div class="section-sub">Keep decisions and feedback with the work. Use @username or @everyone to notify people.</div></div></div>
      <div class="task-comments">${comments.length ? comments.map((c) => { const author = S.directory.find((user) => user.username === c.authorUsername) || { name: c.by, profile: {} }; return `<div class="task-comment ${c.clientVisible ? "client-visible" : "internal-comment"}" id="comment-${esc(c.id)}">${personAvatar(author, "comment-avatar")}<div class="comment-body"><div class="comment-head"><b>${esc(c.by)}</b><span>${timeAgo(c.ts)}</span>${c.clientVisible ? `<span class="client-safe-chip">Shared with NEONMONKI</span>` : `<span class="internal-chip">Internal</span>`}${!c.deleted && c.authorUsername === S.me.username ? `<button class="comment-delete" onclick="App.deleteComment('${esc(t.id)}','${esc(c.id)}')">Delete</button>` : ""}</div><div class="comment-text">${c.deleted ? `<i>Comment deleted</i>` : linkifyText(c.text)}</div></div></div>`; }).join("") : `<div class="conversation-empty"><span>${I.chat}</span><b>Start the conversation</b><p>Ask a question, share an update, or mention the person who needs to respond.</p></div>`}</div>
      <div class="comment-composer"><div class="comment-composer-head">${personAvatar(S.me, "comment-avatar")}<div><b>Reply as ${esc(S.me.name)}</b><span>Ctrl/⌘ + Enter to post</span></div></div><textarea id="task-comment-text" rows="5" onkeydown="App.commentKeydown(event,'${esc(t.id)}')" placeholder="Write a clear update, question, or feedback…&#10;&#10;Type @ to mention a teammate, or @everyone to notify everyone with access."></textarea><div class="comment-composer-foot">${isTeam() && t.visibility === "shared" ? `<label class="safe-share-toggle"><input type="checkbox" id="comment-client-visible"> Share this comment with NEONMONKI</label>` : isTeam() ? `<span class="internal-safety-note">🔒 Internal comment — hidden from client accounts</span>` : `<span class="client-safety-note">Visible to the assigned team</span>`}<button class="btn primary" onclick="App.postComment('${esc(t.id)}')">${I.send} Post comment</button></div></div>
    </div>

    <details class="section history-details"><summary>Activity history (${updates.length})</summary><div class="timeline">${updates.length ? updates.map((u) => `<div class="tl-item ${u.statusTo ? "status-change" : ""}"><div class="tl-rail"><div class="tl-dot"></div><div class="tl-line"></div></div><div class="tl-content"><div class="tl-head"><span class="tl-by">${esc(u.by)}</span><span class="tl-time">${timeAgo(u.ts)} · ${fmtDate(u.ts)}</span></div><div class="tl-text">${esc(u.text)}</div></div></div>`).join("") : `<div class="empty-note">No history yet.</div>`}</div></details>
  </div>`;
}

function linkify(urlOrText, label) {
  const v = String(urlOrText || "");
  if (/^(https?:\/\/|\/api\/)/i.test(v)) {
    return `<a href="${esc(v)}" ${/^https?:\/\//i.test(v) ? 'target="_blank" rel="noopener"' : ""}>${esc(label || shortUrl(v))} ${I.ext}</a>`;
  }
  return esc(label || v);
}

function shortUrl(u) {
  try {
    const url = new URL(u);
    return url.hostname.replace("www.", "") + url.pathname.slice(0, 28) + (url.pathname.length > 28 ? "…" : "");
  } catch { return u.slice(0, 40); }
}

/* ------------------------------ modals ------------------------------ */

function ownerDatalist() {
  return `<datalist id="owner-list">${teamUsers().map((u) => `<option value="${esc(u.name)}">`).join("")}</datalist>`;
}

function deptOptions(selected) {
  return departments().map((d) => `<option value="${esc(d.id)}" ${(selected === d.id || selected === d.name) ? "selected" : ""}>${esc(d.icon)} ${esc(d.name)}</option>`).join("");
}

function departmentPicker(name, selected, { required = true } = {}) {
  const chosen = new Set(selected || []);
  return `<div class="choice-grid department-choice-grid">
    ${departments().map((d) => `<label class="choice-card ${chosen.has(d.id) ? "selected" : ""}" style="--dept:${esc(d.color)}">
      <input type="checkbox" name="${esc(name)}" value="${esc(d.id)}" ${chosen.has(d.id) ? "checked" : ""} ${required ? "data-required-group" : ""} onchange="this.closest('.choice-card').classList.toggle('selected',this.checked)">
      <span class="choice-icon">${esc(d.icon)}</span><span>${esc(d.name)}</span>
    </label>`).join("")}
  </div>`;
}

function ownerPicker(name, selected) {
  const chosen = new Set(selected || []);
  return `<div class="choice-grid owner-choice-grid">
    ${teamUsers().map((u) => `<label class="choice-card ${chosen.has(u.username) ? "selected" : ""}">
      <input type="checkbox" name="${esc(name)}" value="${esc(u.username)}" ${chosen.has(u.username) ? "checked" : ""} onchange="this.closest('.choice-card').classList.toggle('selected',this.checked)">
      <span class="mini-avatar">${esc(initials(u.name))}</span><span>${esc(u.name)}</span>
    </label>`).join("")}
  </div>`;
}

function taskCreateLinkRow() {
  return `<div class="task-create-link repeatable-row"><input data-field="title" maxlength="180" placeholder="Deliverable link title"><input data-field="url" type="url" maxlength="1500" placeholder="https://drive.google.com/…"><button type="button" class="repeatable-remove" title="Remove" onclick="this.closest('.repeatable-row').remove()">×</button></div>`;
}

function drawerLinkRow(subtasks) {
  return `<div class="drawer-link-row repeatable-row"><input data-field="title" placeholder="Link title"><input data-field="url" type="url" placeholder="https://drive.google.com/…"><select data-field="subtaskId"><option value="">Attach to main task</option>${(subtasks || []).map((subtask) => `<option value="${esc(subtask.id)}">${esc(subtask.title)}</option>`).join("")}</select><button type="button" class="repeatable-remove" title="Remove" onclick="this.closest('.repeatable-row').remove()">×</button></div>`;
}

function taskCreateSubtaskRow(defaultDepartments = ["project-management"]) {
  return `<details class="task-create-subtask repeatable-card" open><summary><span>New subtask</span><button type="button" class="repeatable-remove" title="Remove" onclick="event.preventDefault();this.closest('.repeatable-card').remove()">×</button></summary><div class="repeatable-card-body">
    <div class="form-row"><label>SUBTASK TITLE *</label><input data-field="title" maxlength="300" placeholder="A specific result to complete"></div>
    <div class="form-row"><label>DESCRIPTION</label><textarea data-field="description" maxlength="2000" placeholder="What done looks like"></textarea></div>
    ${isTeam() ? `<div class="form-row"><label>ASSIGN TO INDIVIDUALS <span class="label-note">multiple allowed</span></label>${ownerPicker("subtaskOwners", [])}</div>` : ""}
    <div class="form-row"><label>ASSIGN TO DEPARTMENTS <span class="label-note">multiple allowed</span></label>${departmentPicker("subtaskDepartments", defaultDepartments, { required: false })}</div>
    <div class="form-grid"><div class="form-row"><label>PRIORITY</label><select data-field="priority">${prioOptions("Medium")}</select></div><div class="form-row"><label>DUE DATE</label><input data-field="dueDate" type="date"></div></div>
  </div></details>`;
}

function prioOptions(selected) {
  return ["Critical", "High", "Medium", "Low"].map((p) => `<option ${selected === p ? "selected" : ""}>${esc(p)}</option>`).join("");
}

function statusOptions(selected) {
  const statuses = (S.data && S.data.meta && S.data.meta.statuses) || OPEN_STATUSES;
  return statuses.map((s) => `<option ${selected === s ? "selected" : ""}>${esc(s)}</option>`).join("");
}

function renderModal() {
  const root = document.getElementById("modal-root");
  if (!root) return;
  const m = S.modal;
  let body = "";

  if (m === "acceptTask") {
    const t = S.data.tasks.find((x) => x.id === S.openTaskId);
    if (t) {
      body = `
      <div class="modal-overlay" onclick="if(event.target===this)App.closeModal()">
        <div class="modal">
          <div class="modal-head"><h3>Accept request — ${esc(t.id)}</h3>
            <button class="modal-close" onclick="App.closeModal()">✕</button></div>
          <div class="modal-body">
            <div class="form-hint"><b>${esc(t.title)}</b><br>Accepting moves it to <b>In Progress</b> and the client is shown that work started. Who takes it?</div>
            <form onsubmit="App.submitAccept(event, '${esc(t.id)}')">
              <div class="form-row"><label>OWNERS <span class="label-note">multiple allowed; defaults to you</span></label>${ownerPicker("ownerUsernames", t.ownerUsernames || [])}</div>
              <div class="modal-foot">
                <button type="button" class="btn ghost" onclick="App.closeModal()">Cancel</button>
                <button type="submit" class="btn neon">Accept &amp; start</button>
              </div>
            </form>
          </div>
        </div>
      </div>`;
    }
  }

  if (m === "newTask") {
    const d = S.taskDraft || {};
    body = `
    <div class="modal-overlay" onclick="if(event.target===this)App.closeModal()">
      <div class="modal">
        <div class="modal-head"><h3>${isClient() ? "Assign a task to the team" : "Create a task"}</h3>
          <button class="modal-close" onclick="App.closeModal()">✕</button></div>
        <div class="modal-body">
          ${isClient() ? `<div class="form-hint">This lands on the team's board as a <b>New Request</b>. Choose the whole team or the departments that should handle it.</div>` : ""}
          ${d.fromChannel ? `<div class="form-hint">Created from a chat discussion — a task card will be posted back into the channel automatically.</div>` : ""}
          <form onsubmit="App.submitNewTask(event)">
            <div class="form-row"><label>TASK TITLE *</label><input name="title" required maxlength="300" value="${esc(d.title || "")}" placeholder="e.g. Set up Italy Google Ads campaign structure"></div>
            <div class="form-row"><label>DEPARTMENTS * <span class="label-note">choose one or more</span></label>${departmentPicker("departmentIds", d.departmentIds || (d.department ? [d.department] : ["project-management"]))}</div>
            <div class="form-row"><label>PRIORITY</label><select name="priority" onchange="App.dueHintRefresh(this.form)">${prioOptions(d.priority || "High")}</select></div>
            <div class="form-row"><label>PROJECT / AREA</label><input name="project" maxlength="150" value="${esc(d.project || "")}" placeholder="e.g. Italy Expansion"></div>
            <div class="form-row"><label>DESCRIPTION / CONTEXT</label><textarea name="description" maxlength="4000" placeholder="What is needed, why, and what done looks like…">${esc(d.description || "")}</textarea></div>
            <div class="form-row"><label>ASSIGNMENT</label>
              <select name="assignmentMode" onchange="App.toggleAssignment(this)">
                ${isClient() ? `<option value="whole_team" ${d.assignmentMode === "whole_team" ? "selected" : ""}>Whole team</option><option value="departments" ${d.assignmentMode !== "whole_team" ? "selected" : ""}>Selected departments</option>` : `<option value="users" ${(d.ownerUsernames || []).length ? "selected" : ""}>Named owners</option><option value="departments" ${(d.ownerUsernames || []).length ? "" : "selected"}>Selected departments</option><option value="whole_team">Whole team</option>`}
              </select>
            </div>
            ${isTeam() ? `<div class="form-row assignment-owners" style="display:${(d.ownerUsernames || []).length ? "block" : "none"}"><label>OWNERS <span class="label-note">individuals only; multiple allowed</span></label>${ownerPicker("ownerUsernames", d.ownerUsernames || [])}</div>` : ""}
            <div class="form-grid">
              <div class="form-row"><label>VISIBILITY</label>
                <select name="visibility">
                  ${isClient() ? `<option value="team" ${d.visibility !== "department" ? "selected" : ""}>Team</option><option value="department" ${d.visibility === "department" ? "selected" : ""}>Selected departments only</option>` : `
                    <option value="team" ${d.visibility === "team" ? "selected" : ""}>Whole team — internal</option>
                    <option value="department" ${!d.visibility || d.visibility === "department" ? "selected" : ""}>Selected departments only</option>
                    <option value="shared" ${d.visibility === "shared" ? "selected" : ""}>Share with NEONMONKI + team</option>
                    <option value="private" ${d.visibility === "private" ? "selected" : ""}>Named owners only</option>`}
                </select>
              </div>
              <div class="form-row"><label>DUE DATE <span class="label-note">expected for Critical / High</span></label><input name="dueDate" type="date" value="${esc(d.dueDate || "")}" onchange="App.dueHintRefresh(this.form)"><div class="due-hint" style="display:none"><span>⚠</span><p>High-priority work needs a timeline — pick a due date so it stays on the radar.</p></div></div>
            </div>
            <div class="form-row"><label>NEXT ACTION</label><input name="nextAction" maxlength="300" value="${esc(d.nextAction || "")}" placeholder="The single next step"></div>
            <div class="form-row create-builder-section"><div class="builder-head"><label>SUBTASKS <span class="label-note">optional · assign each to individuals or departments</span></label><button type="button" class="btn ghost sm" onclick="App.addTaskSubtaskRow(this)">${I.plus} Add subtask</button></div><div class="task-create-subtasks"></div></div>
            <div class="form-row create-builder-section"><div class="builder-head"><label>DELIVERABLE LINKS <span class="label-note">add as many Google Drive, Docs, Figma or other HTTPS links as needed</span></label><button type="button" class="btn ghost sm" onclick="App.addTaskLinkRow(this)">${I.plus} Add link</button></div><div class="task-create-links">${taskCreateLinkRow()}</div></div>
            <div class="modal-foot">
              <button type="button" class="btn ghost" onclick="App.closeModal()">Cancel</button>
              <button type="submit" class="btn primary">${isClient() ? "Send to team" : "Create task"}</button>
            </div>
          </form>
        </div>
      </div>
    </div>`;
  }

  if (m === "editTask") {
    const t = S.data.tasks.find((x) => x.id === S.openTaskId);
    if (t) {
      body = `
      <div class="modal-overlay" onclick="if(event.target===this)App.closeModal()">
        <div class="modal">
          <div class="modal-head"><h3>Edit task — ${esc(t.id)}</h3>
            <button class="modal-close" onclick="App.closeModal()">✕</button></div>
          <div class="modal-body">
            <form onsubmit="App.submitEdit(event, '${esc(t.id)}')">
              <div class="form-row"><label>TITLE *</label><input name="title" required maxlength="300" value="${esc(t.title)}"></div>
              <div class="form-row"><label>DEPARTMENTS * <span class="label-note">multiple allowed</span></label>${departmentPicker("departmentIds", t.departmentIds || [])}</div>
              <div class="form-grid"><div class="form-row"><label>PRIORITY</label><select name="priority">${prioOptions(t.priority)}</select></div>
                <div class="form-row"><label>VISIBILITY</label><select name="visibility">
                  <option value="team" ${["team","internal"].includes(t.visibility) ? "selected" : ""}>Whole team — internal</option>
                  <option value="department" ${t.visibility === "department" ? "selected" : ""}>Selected departments only</option>
                  <option value="shared" ${t.visibility === "shared" ? "selected" : ""}>Share with NEONMONKI + team</option>
                  <option value="private" ${t.visibility === "private" ? "selected" : ""}>Named owners only</option>
                </select></div></div>
              <div class="form-row"><label>PROJECT / AREA</label><input name="project" maxlength="150" value="${esc(t.project)}"></div>
              <div class="form-row"><label>DESCRIPTION</label><textarea name="description" maxlength="4000">${esc(t.description)}</textarea></div>
              <div class="form-row"><label>ASSIGNMENT</label><select name="assignmentMode" onchange="App.toggleAssignment(this)">
                <option value="users" ${t.assignmentMode === "users" ? "selected" : ""}>Named owners</option>
                <option value="departments" ${t.assignmentMode === "departments" ? "selected" : ""}>Selected departments</option>
                <option value="whole_team" ${t.assignmentMode === "whole_team" ? "selected" : ""}>Whole team</option>
              </select></div>
              <div class="form-row assignment-owners" style="display:${t.assignmentMode === "users" ? "block" : "none"}"><label>OWNERS <span class="label-note">individuals only; multiple allowed</span></label>${ownerPicker("ownerUsernames", t.ownerUsernames || [])}</div>
              <div class="form-row"><label>SUPPORTING NOTE</label><input name="supporting" maxlength="150" value="${esc(t.supporting)}"></div>
              <div class="form-grid">
                <div class="form-row"><label>DUE DATE</label><input name="dueDate" type="date" value="${esc(t.dueDate)}"></div>
                <div class="form-row"><label>NEXT ACTION</label><input name="nextAction" maxlength="300" value="${esc(t.nextAction)}"></div>
              </div>
              <div class="form-row"><label>BUSINESS IMPACT <span class="label-note">why this task matters — surfaced on the dashboard for Critical items</span></label><textarea name="impact" maxlength="500" placeholder="e.g. Blocks the Italy launch campaign; each week of delay costs leads">${esc(t.impact || "")}</textarea></div>
              <div class="form-row"><label>BLOCKER / DEPENDENCY</label><input name="blocker" maxlength="300" value="${esc(t.blocker)}"></div>
              <div class="form-row"><label>DELIVERABLE</label><input name="deliverable" maxlength="300" value="${esc(t.deliverable)}"></div>
              <div class="form-row"><label>DELIVERABLE LINK</label><input name="deliverableLink" maxlength="500" value="${esc(t.deliverableLink)}" placeholder="https://…"></div>
              <div class="form-row"><label>ADD SHARING LINK <span class="label-note">optional</span></label><div class="link-field-pair"><input name="taskLinkTitle" maxlength="180" placeholder="Link title"><input name="taskLinkUrl" type="url" maxlength="1500" placeholder="https://…"></div></div>
              <div class="modal-foot">
                <button type="button" class="btn ghost" onclick="App.closeModal()">Cancel</button>
                <button type="submit" class="btn primary">Save changes</button>
              </div>
            </form>
          </div>
        </div>
      </div>`;
    }
  }

  if (m === "addSubtask") {
    const t = S.data.tasks.find((x) => x.id === S.openTaskId);
    if (t) body = `
    <div class="modal-overlay" onclick="if(event.target===this)App.closeModal()">
      <div class="modal">
        <div class="modal-head"><h3>Add subtask — ${esc(t.id)}</h3><button class="modal-close" onclick="App.closeModal()">✕</button></div>
        <div class="modal-body">
          <div class="form-hint">Break the main task into a clear piece of work. Assign it to individuals, departments, or both.</div>
          <form onsubmit="App.submitSubtask(event, '${esc(t.id)}')">
            <div class="form-row"><label>SUBTASK TITLE *</label><input name="title" required maxlength="300" placeholder="A specific result to complete"></div>
            <div class="form-row"><label>DESCRIPTION</label><textarea name="description" maxlength="2000" placeholder="What done looks like"></textarea></div>
            <div class="form-row"><label>OWNERS <span class="label-note">multiple allowed</span></label>${ownerPicker("ownerUsernames", [])}</div>
            <div class="form-row"><label>DEPARTMENTS <span class="label-note">multiple allowed</span></label>${departmentPicker("departmentIds", t.departmentIds || [], { required: false })}</div>
            <div class="form-grid">
              <div class="form-row"><label>PRIORITY</label><select name="priority">${prioOptions(t.priority)}</select></div>
              <div class="form-row"><label>DUE DATE</label><input type="date" name="dueDate"></div>
            </div>
            ${t.visibility === "shared" ? `<label class="safe-share-toggle"><input type="checkbox" name="clientVisible"> Show this subtask to NEONMONKI</label>` : ""}
            <div class="form-row"><label>SHARING LINK <span class="label-note">optional</span></label><div class="link-field-pair"><input name="subtaskLinkTitle" maxlength="180" placeholder="Link title"><input name="subtaskLinkUrl" type="url" maxlength="1500" placeholder="https://…"></div></div>
            <div class="modal-foot"><button type="button" class="btn ghost" onclick="App.closeModal()">Cancel</button><button class="btn primary" type="submit">Add subtask</button></div>
          </form>
        </div>
      </div>
    </div>`;
  }

  if (m === "deliverable") {
    body = `
    <div class="modal-overlay" onclick="if(event.target===this)App.closeModal()">
      <div class="modal">
        <div class="modal-head"><h3>Log a deliverable</h3><button class="modal-close" onclick="App.closeModal()">✕</button></div>
        <div class="modal-body">
          <form onsubmit="App.submitSimple(event, '/api/deliverables', 'Deliverable logged')">
            <div class="form-row"><label>TITLE *</label><input name="title" required maxlength="300"></div>
            <div class="form-grid">
              <div class="form-row"><label>DATE</label><input name="date" type="date"></div>
              <div class="form-row"><label>WORKSTREAM</label><input name="workstream" maxlength="100"></div>
            </div>
            <div class="form-grid">
              <div class="form-row"><label>OWNER</label><input name="owner" list="owner-list" maxlength="100">${ownerDatalist()}</div>
              <div class="form-row"><label>STATUS</label><input name="status" maxlength="100" value="Shared"></div>
            </div>
            <div class="form-row"><label>LINK</label><input name="link" maxlength="500" placeholder="https://…"></div>
            <div class="modal-foot">
              <button type="button" class="btn ghost" onclick="App.closeModal()">Cancel</button>
              <button type="submit" class="btn primary">Save</button>
            </div>
          </form>
        </div>
      </div>
    </div>`;
  }

  if (m === "decision") {
    body = `
    <div class="modal-overlay" onclick="if(event.target===this)App.closeModal()">
      <div class="modal">
        <div class="modal-head"><h3>Record a decision / rule</h3><button class="modal-close" onclick="App.closeModal()">✕</button></div>
        <div class="modal-body">
          <form onsubmit="App.submitSimple(event, '/api/decisions', 'Decision recorded')">
            <div class="form-row"><label>TOPIC</label><input name="topic" maxlength="200" placeholder="e.g. Budget test timing"></div>
            <div class="form-row"><label>DECISION / RULE *</label><textarea name="rule" required maxlength="1000" placeholder="What was decided, in one or two sentences…"></textarea></div>
            <div class="form-grid">
              <div class="form-row"><label>WORKSTREAM</label><input name="workstream" maxlength="100"></div>
              <div class="form-row"><label>APPLIES TO</label><input name="owner" maxlength="100" placeholder="e.g. Paid Team"></div>
            </div>
            <div class="modal-foot">
              <button type="button" class="btn ghost" onclick="App.closeModal()">Cancel</button>
              <button type="submit" class="btn primary">Save</button>
            </div>
          </form>
        </div>
      </div>
    </div>`;
  }

  if (m === "password") {
    body = `
    <div class="modal-overlay" onclick="if(event.target===this)App.closeModal()">
      <div class="modal">
        <div class="modal-head"><h3>Change your password</h3><button class="modal-close" onclick="App.closeModal()">✕</button></div>
        <div class="modal-body">
          <form onsubmit="App.submitPassword(event)">
            <div class="form-row"><label>CURRENT PASSWORD</label><input name="current" type="password" required autocomplete="current-password"></div>
            <div class="form-grid">
              <div class="form-row"><label>NEW PASSWORD</label><input name="next" type="password" required minlength="6" autocomplete="new-password"></div>
              <div class="form-row"><label>CONFIRM NEW</label><input name="confirm" type="password" required minlength="6" autocomplete="new-password"></div>
            </div>
            <div class="modal-foot">
              <button type="button" class="btn ghost" onclick="App.closeModal()">Cancel</button>
              <button type="submit" class="btn primary">Change password</button>
            </div>
          </form>
        </div>
      </div>
    </div>`;
  }

  if (m === "addUser") {
    body = `
    <div class="modal-overlay" onclick="if(event.target===this)App.closeModal()">
      <div class="modal">
        <div class="modal-head"><h3>Add a user</h3><button class="modal-close" onclick="App.closeModal()">✕</button></div>
        <div class="modal-body">
          <div class="form-hint">No email needed — you set the username and password and hand them over. They can change the password after logging in.</div>
          <form onsubmit="App.submitAddUser(event)">
            <div class="form-grid">
              <div class="form-row"><label>FULL NAME *</label><input name="name" required maxlength="100" placeholder="e.g. Fatima Noor"></div>
              <div class="form-row"><label>USERNAME *</label><input name="username" required maxlength="30" pattern="[a-z0-9_.\\-]{2,30}" placeholder="e.g. fatima" style="text-transform:lowercase"></div>
            </div>
            <div class="form-grid">
              <div class="form-row"><label>ACCESS TYPE</label><select name="role" onchange="App.userRoleChanged(this)">
                <option value="team">Team</option>
                <option value="client">Client</option>
                <option value="super_admin">Super Admin</option>
              </select></div>
              <div class="form-row"><label>PASSWORD *</label><input name="password" required minlength="6" placeholder="min 6 chars"></div>
            </div>
            <div class="form-row user-department-row"><label>DEPARTMENTS <span class="label-note">a user may belong to several</span></label>${departmentPicker("departments", [], { required: false })}</div>
            <div class="modal-foot">
              <button type="button" class="btn ghost" onclick="App.closeModal()">Cancel</button>
              <button type="submit" class="btn primary">Create user</button>
            </div>
          </form>
        </div>
      </div>
    </div>`;
  }

  if (m && m.startsWith("editUser:")) {
    const username = m.split(":")[1];
    const u = S.admin.users.find((x) => x.username === username);
    if (u) body = `
    <div class="modal-overlay" onclick="if(event.target===this)App.closeModal()"><div class="modal">
      <div class="modal-head"><h3>Manage access — ${esc(u.name)}</h3><button class="modal-close" onclick="App.closeModal()">✕</button></div>
      <div class="modal-body"><form onsubmit="App.submitEditUser(event, '${esc(u.username)}')">
        <div class="form-grid"><div class="form-row"><label>FULL NAME</label><input name="name" value="${esc(u.name)}" required maxlength="100"></div>
          <div class="form-row"><label>USERNAME</label><input name="username" value="${esc(u.username)}" required maxlength="30" pattern="[a-z0-9_.\-]{2,30}"></div></div>
        <div class="form-grid"><div class="form-row"><label>ORGANIZATION</label><input name="org" value="${esc(u.org || "")}" maxlength="60"></div><div class="form-row"><label>NEW PASSWORD <span class="label-note">leave blank to keep it</span></label><input name="password" type="password" minlength="6" autocomplete="new-password" placeholder="Set a new password"></div></div>
        <div class="form-row"><label>ACCESS TYPE</label><select name="role" onchange="App.userRoleChanged(this)">
          <option value="team" ${u.role === "team" ? "selected" : ""}>Team — internal workspace</option>
          <option value="client" ${u.role === "client" ? "selected" : ""}>Client — limited dashboard, no internal data</option>
          <option value="super_admin" ${u.role === "super_admin" ? "selected" : ""}>Super Admin — full control</option>
        </select></div>
        <div class="form-row user-department-row" style="${u.role === "client" ? "display:none" : ""}"><label>DEPARTMENTS <span class="label-note">multiple allowed</span></label>${departmentPicker("departments", u.departments || [], { required: false })}</div>
        <div class="access-explainer"><b>Client</b> sees only shared/requested work and client-visible comments or delivered files. <b>Team</b> can access internal work within its permissions. Department membership controls department-only tasks and Monki context.</div>
        <div class="modal-foot"><button type="button" class="btn danger" onclick="App.deleteUser('${esc(u.username)}','${esc(u.name)}')">Delete user</button><span class="spacer"></span><button type="button" class="btn ghost" onclick="App.closeModal()">Cancel</button><button class="btn primary" type="submit">Save user</button></div>
      </form></div>
    </div></div>`;
  }

  if (m === "addDepartment" || (m && m.startsWith("editDepartment:"))) {
    const deptId = m.startsWith("editDepartment:") ? m.split(":")[1] : "";
    const d = departments(false).find((x) => x.id === deptId) || { name: "", color: "#2563eb", icon: "◆", order: departments(false).length * 10 + 10 };
    body = `
    <div class="modal-overlay" onclick="if(event.target===this)App.closeModal()"><div class="modal small-modal">
      <div class="modal-head"><h3>${deptId ? "Edit" : "Create"} department</h3><button class="modal-close" onclick="App.closeModal()">✕</button></div>
      <div class="modal-body"><form onsubmit="App.submitDepartment(event, '${esc(deptId)}')">
        <div class="form-row"><label>DEPARTMENT NAME *</label><input name="name" required maxlength="60" value="${esc(d.name)}"></div>
        <div class="form-grid"><div class="form-row"><label>COLOR</label><input name="color" type="color" value="${esc(d.color)}"></div>
          <div class="form-row"><label>SYMBOL</label><input name="icon" maxlength="8" value="${esc(d.icon)}" placeholder="◆"></div></div>
        <div class="form-row"><label>DISPLAY ORDER</label><input name="order" type="number" value="${esc(d.order)}"></div>
        <div class="modal-foot"><button type="button" class="btn ghost" onclick="App.closeModal()">Cancel</button><button class="btn primary" type="submit">Save department</button></div>
      </form></div>
    </div></div>`;
  }

  if (m === "newChannel") {
    body = `
    <div class="modal-overlay" onclick="if(event.target===this)App.closeModal()">
      <div class="modal">
        <div class="modal-head"><h3>Create a channel</h3><button class="modal-close" onclick="App.closeModal()">✕</button></div>
        <div class="modal-body">
          <form onsubmit="App.submitNewChannel(event)">
            <div class="form-row"><label>CHANNEL NAME *</label><input name="name" required maxlength="60" placeholder="e.g. Web Development"></div>
            <div class="form-row"><label>DESCRIPTION</label><input name="description" maxlength="200" placeholder="What belongs here"></div>
            <div class="form-grid">
              <div class="form-row"><label>TASK DEPARTMENT (for tasks created here)</label><select name="department">${deptOptions()}</select></div>
              <div class="form-row"><label style="display:flex;align-items:center;gap:8px;margin-top:22px"><input type="checkbox" name="clientAllowed" style="width:auto"> Client can be a member</label></div>
            </div>
            <div class="form-row"><label>MEMBERS</label>
              <div class="member-pick">
                ${S.admin.users.filter((u) => u.active).map((u) => `
                  <label class="mp-item"><input type="checkbox" name="member" value="${esc(u.username)}"> ${esc(u.name)}</label>`).join("")}
              </div>
            </div>
            <div class="modal-foot">
              <button type="button" class="btn ghost" onclick="App.closeModal()">Cancel</button>
              <button type="submit" class="btn primary">Create channel</button>
            </div>
          </form>
        </div>
      </div>
    </div>`;
  }

  if (m && m.startsWith("channelMembers:")) {
    const cid = m.split(":")[1];
    const c = S.admin.channels.find((x) => x.id === cid);
    if (c) {
      const memberSet = new Set(c.members.map((x) => x.username));
      const candidates = S.admin.users.filter((u) => u.active && !memberSet.has(u.username));
      body = `
      <div class="modal-overlay" onclick="if(event.target===this)App.closeModal()">
        <div class="modal">
          <div class="modal-head"><h3>Members — # ${esc(c.name)}</h3><button class="modal-close" onclick="App.closeModal()">✕</button></div>
          <div class="modal-body">
            <div class="form-row"><label>CURRENT MEMBERS</label>
              <div class="member-pick">
                ${c.members.length ? c.members.map((mm) => {
                  const u = S.admin.users.find((x) => x.username === mm.username);
                  return `<span class="mp-chip">${esc(u ? u.name : mm.username)} <button type="button" class="mp-x" title="Remove" onclick="App.removeChannelMember('${esc(cid)}', '${esc(mm.username)}')">✕</button></span>`;
                }).join("") : `<span style="color:var(--faint);font-size:12.5px">No members yet.</span>`}
              </div>
            </div>
            <div class="form-row"><label>ADD MEMBER</label>
              <div class="member-pick">
                ${candidates.length ? candidates.map((u) => `
                  <button type="button" class="mp-item ${u.role === "client" ? "client-candidate" : ""}" style="cursor:pointer" onclick="App.addChannelMember('${esc(cid)}', '${esc(u.username)}', ${u.role === "client"})">+ ${esc(u.name)}${u.role === "client" ? " · client" : ""}</button>`).join("") : `<span style="color:var(--faint);font-size:12.5px">Everyone is already in.</span>`}
              </div>
            </div>
          </div>
        </div>
      </div>`;
    }
  }

  if (m === "aiSummary") {
    const d = S.aiSummaryData || {};
    const subject = d.task || d.channel || null;
    body = `
    <div class="modal-overlay" onclick="if(event.target===this)App.closeModal()">
      <div class="modal ai-summary-modal">
        <div class="modal-head ai-summary-head"><div><span class="ai-summary-kicker">${I.sparkle} Monki workspace brief</span><h3>${esc(subject && (subject.title || subject.name) || d.title || "")}</h3></div>
          <button class="modal-close" onclick="App.closeModal()">✕</button></div>
        <div class="modal-body">
          ${d.loading ? `<div class="ai-summary-loading"><img src="/monki-mark.svg" alt=""><div><b>Monki is reading the work…</b><span>Checking task history, communication and shared links.</span></div></div>` : d.error ? `<div class="login-error" style="margin:0">${esc(d.error)}</div>` : `
            ${d.task ? `<div class="ai-summary-facts"><span><small>Task</small><b>${esc(d.task.id)}</b></span><span><small>Status</small><b>${esc(d.task.status)}</b></span><span><small>Priority</small><b>${esc(d.task.priority)}</b></span><span><small>Due</small><b>${fmtDate(d.task.dueDate)}</b></span><span class="wide"><small>Owners</small><b>${esc(d.task.owners || "Unassigned")}</b></span></div>` : ""}
            <div class="ai-summary-meta"><span>${I.sparkle} Prepared by Monki</span><span>${d.generatedAt ? `Updated ${timeAgo(d.generatedAt)}` : ""}</span></div>
            <div class="ai-summary-content">${renderAiBrief(d.answer || "")}</div>
            <div class="ai-summary-sources"><b>Workspace sources</b>${citationChips(d.citations)}</div>`}
        </div>
      </div>
    </div>`;
  }

  if (m && m.startsWith("aiProposal:")) {
    const index = Number(m.split(":")[1]);
    const p = S.aiAnswer && S.aiAnswer.proposals && S.aiAnswer.proposals[index];
    if (p && p.type === "task_update") {
      const t = S.data.tasks.find((task) => task.id === p.taskId);
      if (t) {
        const f = p.fields || {};
        body = `
        <div class="modal-overlay" onclick="if(event.target===this)App.closeModal()">
          <div class="modal">
            <div class="modal-head"><h3>Modify AI proposal — ${esc(t.id)}</h3><button class="modal-close" onclick="App.closeModal()">✕</button></div>
            <div class="modal-body">
              <div class="form-hint">Review the final values below. Only changes from the current task are submitted, and your normal task permissions still apply.</div>
              <form onsubmit="App.submitModifiedAction(event, ${index})">
                <div class="form-row"><label>TITLE</label><input name="title" maxlength="300" value="${esc(f.title !== undefined ? f.title : t.title)}"></div>
                <div class="form-grid">
                  <div class="form-row"><label>OWNER</label><input name="owner" list="owner-list" maxlength="500" value="${esc(f.owner !== undefined ? f.owner : t.owner)}">${ownerDatalist()}</div>
                  <div class="form-row"><label>PRIORITY</label><select name="priority">${prioOptions(f.priority !== undefined ? f.priority : t.priority)}</select></div>
                </div>
                <div class="form-grid">
                  <div class="form-row"><label>DUE DATE</label><input name="dueDate" type="date" value="${esc(f.dueDate !== undefined ? f.dueDate : t.dueDate)}"></div>
                  <div class="form-row"><label>STATUS</label><select name="status">${statusOptions(f.status !== undefined ? f.status : t.status)}</select></div>
                </div>
                <div class="form-row"><label>DESCRIPTION</label><textarea name="description" maxlength="4000">${esc(f.description !== undefined ? f.description : t.description)}</textarea></div>
                <div class="form-row"><label>NEXT ACTION</label><input name="nextAction" maxlength="500" value="${esc(f.nextAction !== undefined ? f.nextAction : t.nextAction)}"></div>
                <div class="form-row"><label>NEW LATEST UPDATE (optional)</label><textarea name="update" maxlength="2000" placeholder="Leave blank unless this approval should add/update the latest progress note">${esc(f.update || "")}</textarea></div>
                <div class="form-row"><label>WHY</label><input name="reason" maxlength="200" value="${esc(p.reason || "")}"></div>
                <div class="modal-foot">
                  <button type="button" class="btn ghost" onclick="App.closeModal()">Cancel</button>
                  <button type="submit" class="btn neon">Approve modified proposal</button>
                </div>
              </form>
            </div>
          </div>
        </div>`;
      }
    } else if (p && p.type === "decision") {
      body = `
      <div class="modal-overlay" onclick="if(event.target===this)App.closeModal()">
        <div class="modal">
          <div class="modal-head"><h3>Modify proposed decision</h3><button class="modal-close" onclick="App.closeModal()">✕</button></div>
          <div class="modal-body">
            <form onsubmit="App.submitModifiedAction(event, ${index})">
              <div class="form-row"><label>TOPIC</label><input name="topic" maxlength="200" value="${esc(p.topic || "")}"></div>
              <div class="form-row"><label>DECISION / RULE *</label><textarea name="rule" required maxlength="1000">${esc(p.rule || "")}</textarea></div>
              <div class="form-grid">
                <div class="form-row"><label>WORKSTREAM</label><input name="workstream" maxlength="100" value="${esc(p.workstream || "")}"></div>
                <div class="form-row"><label>OWNER / APPLIES TO</label><input name="owner" maxlength="100" value="${esc(p.owner || "")}"></div>
              </div>
              <div class="modal-foot">
                <button type="button" class="btn ghost" onclick="App.closeModal()">Cancel</button>
                <button type="submit" class="btn neon">Approve modified proposal</button>
              </div>
            </form>
          </div>
        </div>
      </div>`;
    }
  }

  if (m === "link") {
    body = `
    <div class="modal-overlay" onclick="if(event.target===this)App.closeModal()">
      <div class="modal">
        <div class="modal-head"><h3>Add a document link</h3><button class="modal-close" onclick="App.closeModal()">✕</button></div>
        <div class="modal-body">
          <form onsubmit="App.submitSimple(event, '/api/links', 'Link added')">
            <div class="form-row"><label>TITLE *</label><input name="title" required maxlength="300"></div>
            <div class="form-row"><label>URL</label><input name="url" maxlength="500" placeholder="https://docs.google.com/…"></div>
            <div class="form-grid">
              <div class="form-row"><label>WORKSTREAM</label><input name="workstream" maxlength="100"></div>
              <div class="form-row"><label>TYPE</label><input name="type" maxlength="60" placeholder="Google Doc"></div>
            </div>
            <div class="form-row"><label>WHY IT MATTERS</label><input name="note" maxlength="300"></div>
            <div class="modal-foot">
              <button type="button" class="btn ghost" onclick="App.closeModal()">Cancel</button>
              <button type="submit" class="btn primary">Save</button>
            </div>
          </form>
        </div>
      </div>
    </div>`;
  }

  if (m === "reportForm") {
    const d = S.reportDraft || { kind: "weekly", periodMonth: "", title: "", description: "", links: [{ label: "", url: "" }] };
    const editing = S.reportEditId != null;
    body = `
    <div class="modal-overlay" onclick="if(event.target===this)App.closeModal()">
      <div class="modal">
        <div class="modal-head"><h3>${editing ? "Edit report" : "Add a report"}</h3><button class="modal-close" onclick="App.closeModal()">✕</button></div>
        <div class="modal-body">
          <div class="form-hint">${editing ? "Changes are visible to the whole workspace as soon as you save." : "Link a delivered report (Google Doc, Sheet, deck…) so the client and the team can always find it in the library."}</div>
          <form onsubmit="App.submitReport(event)">
            <div class="form-grid">
              <div class="form-row"><label>KIND</label>
                <select name="kind" onchange="App.reportDraftSet('kind', this.value)">
                  <option value="weekly" ${d.kind === "weekly" ? "selected" : ""}>Weekly report</option>
                  <option value="monthly" ${d.kind === "monthly" ? "selected" : ""}>Monthly report</option>
                  <option value="special" ${d.kind === "special" ? "selected" : ""}>Annual / special</option>
                </select>
              </div>
              <div class="form-row"><label>PERIOD (MONTH) *</label><input name="periodMonth" type="month" value="${esc(d.periodMonth)}" required onchange="App.reportDraftSet('periodMonth', this.value)"></div>
            </div>
            <div class="form-row"><label>TITLE *</label><input name="title" required minlength="2" maxlength="140" value="${esc(d.title)}" placeholder="e.g. August 2026 — performance report, week 33" onchange="App.reportDraftSet('title', this.value)"></div>
            <div class="form-row"><label>DESCRIPTION <span class="label-note">optional</span></label><textarea name="description" maxlength="500" placeholder="One or two lines — what this report covers." onchange="App.reportDraftSet('description', this.value)">${esc(d.description)}</textarea></div>
            <div class="form-row"><label>LINKS * <span class="label-note">1–6 · Google Drive / Docs / Sheets URLs</span></label>
              <div class="rep-link-rows">
                ${d.links.map((l, i) => `
                <div class="rep-link-row">
                  <input name="link_label_${i}" maxlength="80" placeholder="Label (optional)" value="${esc(l.label)}" aria-label="Link ${i + 1} label" onchange="App.reportLinkSet(${i}, 'label', this.value)">
                  <input name="link_url_${i}" type="url" maxlength="2000" placeholder="https://docs.google.com/…" value="${esc(l.url)}" aria-label="Link ${i + 1} URL" onchange="App.reportLinkSet(${i}, 'url', this.value)">
                  ${d.links.length > 1 ? `<button type="button" class="btn ghost sm rep-link-remove" title="Remove link" onclick="App.reportLinkRemove(${i})">✕</button>` : ""}
                </div>`).join("")}
              </div>
              ${d.links.length < 6 ? `<button type="button" class="btn ghost sm" onclick="App.reportLinkAdd()">${I.plus} Add another link</button>` : ""}
            </div>
            <div class="modal-foot">
              <button type="button" class="btn ghost" onclick="App.closeModal()">Cancel</button>
              <button type="submit" class="btn primary" ${S.reportBusy ? "disabled" : ""}>${S.reportBusy ? "Saving…" : editing ? "Save changes" : "Add report"}</button>
            </div>
          </form>
        </div>
      </div>
    </div>`;
  }

  if (m === "generateReport") {
    const g = S.reportGen;
    const formView = `
      <div class="form-hint">Monki writes the report from the synced attribution data and the workspace's task activity for the period. Nothing leaves this workspace until you download or copy it.</div>
      <div class="form-row"><label>AUDIENCE</label>
        <div class="range-presets repgen-audience" role="group" aria-label="Report audience">
          <button type="button" class="${g.audience === "internal" ? "active" : ""}" onclick="App.reportGenSet('audience', 'internal')">Internal team</button>
          <button type="button" class="${g.audience === "client" ? "active" : ""}" onclick="App.reportGenSet('audience', 'client')">Client</button>
        </div>
        <div class="repgen-hint">${g.audience === "client"
          ? "Calm, confident language — no internal tool or vendor names. Safe to share with NEONMONKI."
          : "Direct senior-marketer voice — problems are named plainly. Internal use only."}</div>
      </div>
      <div class="form-row"><label>PERIOD</label>
        <div class="range-presets" role="group" aria-label="Report period">
          ${REP_GEN_PRESETS.map(([v, l]) => `<button type="button" class="${g.preset === v ? "active" : ""}" onclick="App.reportGenSet('preset', '${v}')">${l}</button>`).join("")}
        </div>
      </div>
      ${g.preset === "custom" ? `
      <div class="form-row repgen-custom">
        <label class="date-filter"><span>From</span><input type="date" value="${esc(g.customFrom)}" onchange="App.reportGenSet('customFrom', this.value)"></label>
        <label class="date-filter"><span>To</span><input type="date" value="${esc(g.customTo)}" onchange="App.reportGenSet('customTo', this.value)"></label>
      </div>` : ""}
      ${g.error ? `<div class="repgen-error">${I.alert}<div><b>The report could not be written.</b><span>${esc(g.error)}</span></div></div>` : ""}
      <div class="modal-foot">
        <button type="button" class="btn ghost" onclick="App.closeModal()">Cancel</button>
        ${g.error ? `<button type="button" class="btn primary" onclick="App.runGenerateReport()">${I.recurring} Retry</button>` : ""}
        <button type="button" class="btn neon" onclick="App.runGenerateReport()">${I.sparkle} Generate</button>
      </div>`;
    const busyView = `
      <div class="repgen-loading"><img src="/monki-mark.svg" alt=""><div><b>Writing the report…</b><span>Monki is reading the period's attribution data and the workspace's activity.</span></div></div>`;
    const resultView = g.result ? `
      <div class="repgen-result">
        <div class="ai-label">${I.sparkle} ${g.result.audience === "client" ? "Client" : "Internal"} report · ${esc(fmtDate(g.result.from))} → ${esc(fmtDate(g.result.to))} — review before sharing</div>
        <h4 class="repgen-title">${esc(g.result.title)}</h4>
        <div class="repgen-preview">${repSanitizeHtml(g.result.html)}</div>
        <div class="modal-foot repgen-actions">
          <button type="button" class="btn ghost" onclick="App.reportGenBack()">← New report</button>
          <button type="button" class="btn primary" onclick="App.downloadReportDocx()">${I.report} Download .docx</button>
          <button type="button" class="btn neon" onclick="App.openReportAsGoogleDoc()">${I.ext} Open as Google Doc</button>
        </div>
      </div>` : "";
    body = `
    <div class="modal-overlay" onclick="if(event.target===this)App.closeModal()">
      <div class="modal repgen-modal">
        <div class="modal-head"><h3>Generate report</h3><button class="modal-close" onclick="App.closeModal()">✕</button></div>
        <div class="modal-body">
          ${g.busy ? busyView : g.result ? resultView : formView}
        </div>
      </div>
    </div>`;
  }

  root.innerHTML = body;
}

/* ------------------------------ record pages ------------------------------ */

function viewDeliverables() {
  const rows = [...S.data.deliverables].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  return `
  ${isTeam() ? `<div style="margin-bottom:16px"><button class="btn primary" onclick="App.openModal('deliverable')">${I.plus} Log deliverable</button></div>` : ""}
  <div class="table-wrap">
    <table class="data">
      <thead><tr><th>ID</th><th>Date</th><th>Deliverable</th><th>Workstream</th><th>Owner</th><th>Status</th><th>Link</th></tr></thead>
      <tbody>
        ${rows.length ? rows.map((d) => `
          <tr style="cursor:default">
            <td class="t-id">${esc(d.id)}</td>
            <td style="white-space:nowrap">${fmtDate(d.date)}</td>
            <td><div class="t-title">${esc(d.title)}</div></td>
            <td><span class="tag-plain">${esc(d.workstream)}</span></td>
            <td>${esc(d.owner)}</td>
            <td>${esc(d.status)}</td>
            <td>${d.link ? linkify(d.link, "Open") : "—"}</td>
          </tr>`).join("") : `<tr><td colspan="7"><div class="empty-note">No deliverables logged yet.</div></td></tr>`}
      </tbody>
    </table>
  </div>`;
}

function viewDecisions() {
  const rows = [...S.data.decisions].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  return `
  <div class="page-head-note">Decisions made on calls and in chat. These are binding for how the team works — check here before changing an approach.</div>
  <div style="margin-bottom:16px"><button class="btn primary" onclick="App.openModal('decision')">${I.plus} Record decision</button></div>
  ${rows.length ? rows.map((d) => `
    <div class="card decision-card">
      <div class="dc-top">
        <span class="t-id">${esc(d.id)}</span>
        <span class="dc-topic">${esc(d.topic || "Decision")}</span>
        ${d.workstream ? `<span class="tag-plain">${esc(d.workstream)}</span>` : ""}
      </div>
      <div class="dc-rule">${esc(d.rule)}</div>
      <div class="dc-meta">${fmtDate(d.date)}${d.owner ? " · applies to: " + esc(d.owner) : ""}</div>
    </div>`).join("") : `<div class="card"><div class="empty-note">No decisions recorded yet.</div></div>`}`;
}

function viewRecurring() {
  const order = { Weekly: 0, Monthly: 1, Ongoing: 2 };
  const rows = [...S.data.recurring].sort((a, b) => (order[a.cadence] ?? 9) - (order[b.cadence] ?? 9));
  return `
  <div class="page-head-note">Standing commitments that never disappear from the board — they repeat weekly, monthly or continuously.</div>
  <div class="table-wrap">
    <table class="data">
      <thead><tr><th>Cadence</th><th>Activity</th><th>Department</th><th>Owner</th><th>Reviewed by</th><th>What it means</th></tr></thead>
      <tbody>
        ${rows.length ? rows.map((r) => `
          <tr style="cursor:default">
            <td><span class="pill ${r.cadence === "Weekly" ? "status-InProgress" : r.cadence === "Monthly" ? "status-Planned" : "status-Backlog"}">${esc(r.cadence)}</span></td>
            <td><div class="t-title">${esc(r.activity)}</div></td>
            <td><span class="tag-plain">${esc(r.department)}</span></td>
            <td>${esc(r.owner)}</td>
            <td>${esc(r.reviewer)}</td>
            <td style="color:var(--muted);font-size:12.5px;max-width:340px">${esc(r.definition)}</td>
          </tr>`).join("") : `<tr><td colspan="6"><div class="empty-note">No recurring work defined yet.</div></td></tr>`}
      </tbody>
    </table>
  </div>`;
}

function viewFiles() {
  if (!S.chat.channels.length) loadChatChannels();
  const folders = [{ id: "all", label: "All files" }];
  for (const c of S.chat.channels) folders.push({ id: "ch:" + c.id, label: "# " + c.name });
  const workstreams = [...new Set(S.data.links.filter((l) => !l.channelId).map((l) => l.workstream).filter(Boolean))].sort();
  for (const w of workstreams) folders.push({ id: "ws:" + w, label: w });

  const sel = S.fileFolder;
  const rows = S.data.links
    .filter((l) => {
      if (sel === "all") return true;
      if (sel.startsWith("ch:")) return l.channelId === sel.slice(3);
      if (sel.startsWith("ws:")) return !l.channelId && l.workstream === sel.slice(3);
      return true;
    })
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""));

  return `
  <div class="files-layout">
    <div class="card files-folders">
      <div class="card-pad" style="border-bottom:1px solid var(--line)"><div class="card-title">${I.files} Folders</div></div>
      ${folders.map((f) => `<button class="folder-item ${sel === f.id ? "active" : ""}" onclick="App.pickFolder('${esc(f.id)}')">${esc(f.label)}</button>`).join("")}
    </div>
    <div>
      <div style="margin-bottom:16px"><button class="btn primary" onclick="App.openModal('link')">${I.plus} Add file link</button></div>
      <div class="card">
        ${rows.length ? rows.map((l) => `
          <div class="link-item">
            <div class="link-ico">${esc((l.type || "DOC").slice(0, 4).toUpperCase())}</div>
            <div class="li-body">
              <div class="li-title">${l.url ? linkify(l.url, l.title) : esc(l.title)}</div>
              <div class="li-note">${esc(l.note || "")}${l.owner ? " · " + esc(l.owner) : ""}</div>
            </div>
            ${l.taskId ? `<span class="tag-plain" style="cursor:pointer" onclick="App.openTask('${esc(l.taskId)}')">${esc(l.taskId)}</span>` : ""}
            <span class="tag-plain">${esc(l.channelId ? "#" + l.channelId : l.workstream)}</span>
            <span style="color:var(--faint);font-size:12px;white-space:nowrap">${fmtDate(l.date)}</span>
          </div>`).join("") : `<div class="empty-note">No files in this folder yet.</div>`}
      </div>
    </div>
  </div>`;
}

/* ------------------------------ workspace search ------------------------------ */

function searchResultHtml(result) {
  const kindLabel = result.kind === "task" ? "Task" : result.kind === "file" ? "Shared link" : "Message";
  const icon = result.kind === "task" ? I.tasks : result.kind === "file" ? I.files : I.chat;
  const title = result.kind === "message"
    ? `${result.author} in #${result.channelName}`
    : result.title;
  let meta = "";
  if (result.kind === "task") {
    meta = `${result.id} · ${result.status || "No status"}${result.owner ? ` · ${result.owner}` : ""}`;
  } else if (result.kind === "file") {
    meta = [result.channelName ? `#${result.channelName}` : result.workstream, result.taskId, result.owner].filter(Boolean).join(" · ");
  } else {
    meta = `${timeAgo(result.updatedAt)}${result.replyToId ? " · thread reply" : ""}`;
  }
  return `<button class="search-result" onclick="App.openSearchResult('${esc(result.kind)}','${esc(String(result.id))}')">
    <span class="search-result-icon ${esc(result.kind)}">${icon}</span>
    <span class="search-result-body">
      <span class="search-result-top"><b>${esc(title)}</b><em>${kindLabel}</em></span>
      <span class="search-result-excerpt">${esc(result.excerpt || (result.kind === "file" ? result.url : "No preview available"))}</span>
      <span class="search-result-meta">${esc(meta)}${result.updatedAt ? ` · ${timeAgo(result.updatedAt)}` : ""}</span>
    </span>
    <span class="search-result-open">↗</span>
  </button>`;
}

function renderSearch(el) {
  const s = S.search;
  const response = s.results;
  const counts = response ? response.counts : { tasks: 0, files: 0, messages: 0 };
  const visibleResults = response ? response.results.filter((result) => s.type === "all" || `${result.kind}s` === s.type || (s.type === "messages" && result.kind === "message")) : [];
  const visibleTotal = s.type === "all" ? (response ? response.total : 0) : counts[s.type] || 0;
  const tabs = [
    ["all", "All", response ? response.total : 0],
    ["tasks", "Tasks", counts.tasks],
    ["files", "Shared links", counts.files],
    ["messages", "Messages", counts.messages],
  ];
  el.innerHTML = `<div class="search-workspace">
    <div class="card search-hero">
      <form class="workspace-search-form" onsubmit="App.runSearch(event)">
        <span>${I.search}</span>
        <input id="workspace-search-input" type="search" autocomplete="off" value="${esc(s.q)}" placeholder='Search anything… try “Italy brief”, from:"Abu Bakar" or in:#general' oninput="App.searchDraft(this.value)">
        ${s.q ? `<button type="button" class="search-clear" onclick="App.clearSearch()" aria-label="Clear search">×</button>` : ""}
        <button type="submit" class="btn primary">Search</button>
      </form>
      <div class="search-guide"><span>Searches only work you can access</span><code>"exact phrase"</code><code>from:"Full Name"</code><code>in:#channel</code><code>type:task</code></div>
    </div>
    <div class="search-tabs" role="tablist">
      ${tabs.map(([value, label, count]) => `<button class="${s.type === value ? "active" : ""}" onclick="App.searchType('${value}')"><span>${label}</span>${response ? `<b>${count}</b>` : ""}</button>`).join("")}
    </div>
    ${s.answerLoading ? `<div class="card search-answer-card loading"><img src="/monki-mark.svg" alt=""><div><b>Monki is checking the workspace…</b><span>Reading relevant tasks, links and communication.</span></div></div>` : s.answer && s.answer.available ? `<div class="card search-answer-card"><div class="search-answer-head"><img src="/monki-mark.svg" alt=""><div><b>Monki answer</b><span>Based only on workspace records you can access</span></div></div><div class="search-answer-text">${renderAiBrief(s.answer.answer || "")}</div>${citationChips(s.answer.citations)}</div>` : ""}
    <div class="card search-results-card">
      ${s.loading ? `<div class="search-state"><span class="search-loader"></span><b>Searching your workspace…</b><small>Tasks, communication and shared links</small></div>`
        : s.error ? `<div class="search-state error"><b>Search could not finish</b><small>${esc(s.error)}</small></div>`
        : response && visibleResults.length ? `<div class="search-results-head"><b>${visibleTotal} result${visibleTotal === 1 ? "" : "s"}</b><span>Best matches first</span></div><div class="search-results">${visibleResults.map(searchResultHtml).join("")}</div>`
        : response ? `<div class="search-state"><b>No matches found</b><small>Try fewer words, another channel, or a broader result type.</small></div>`
        : `<div class="search-empty-grid">
            <button onclick="App.quickSearch('overdue critical')"><span>⚡</span><b>Urgent work</b><small>Find overdue and critical tasks</small></button>
            <button onclick="App.quickSearch('campaign brief')"><span>↗</span><b>Shared briefs</b><small>Search links and task context</small></button>
            <button onclick="App.quickSearch('decision')"><span>💬</span><b>Past communication</b><small>Find messages where decisions were discussed</small></button>
          </div>`}
    </div>
  </div>`;
}

/* ------------------------------ chat ------------------------------ */

async function loadChatChannels() {
  try {
    const { channels } = await api("/api/chat/channels");
    S.chat.channels = channels;
  } catch { /* ignore — next poll retries */ }
}

function renderChat(el) {
  const ch = S.chat.channels;
  if (!ch.length) {
    el.innerHTML = `<div class="card"><div class="empty-note">Loading channels…</div></div>`;
    loadChatChannels().then(() => { if (S.route === "chat") renderPage("chat"); });
    return;
  }
  const openId = S.chat.openId;
  const open = ch.find((c) => c.id === openId);

  el.innerHTML = `
  <div class="chat-layout">
    <div class="card chat-channels">
      <div class="card-pad" style="border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between">
        <div class="card-title">${I.chat} Channels</div>
        ${isAdmin() ? `<button class="btn ghost sm" title="New channel" onclick="App.openModal('newChannel')">${I.plus}</button>` : ""}
      </div>
      <div class="chat-channel-list">
        ${ch.map((c) => `
          <button class="channel-item ${openId === c.id ? "active" : ""}" onclick="App.openChannel('${esc(c.id)}')">
            <span class="ch-hash">#</span>
            <span class="ch-name">${esc(c.name)}</span>
            ${c.muted ? `<span class="ch-muted" title="Muted">${I.mute}</span>` : ""}
            ${c.unread ? `<span class="ch-unread ${c.muted ? "dim" : ""}">${c.unread}</span>` : ""}
          </button>`).join("")}
      </div>
    </div>
    <div class="card chat-pane" id="chat-pane">
      ${open ? chatPaneHtml(open) : `<div class="chat-empty">Pick a channel to start talking.<br>Every message can become a task.</div>`}
    </div>
  </div>`;
  if (open) {
    const lastMsg = S.chat.messages[S.chat.messages.length - 1];
    if (lastMsg && lastMsg.id !== lastRenderedMsgId) {
      lastRenderedMsgId = lastMsg.id;
      scrollChatToBottom();
    }
  }
}

function chatPaneHtml(c) {
  const replyTo = S.chat.messages.find((message) => Number(message.id) === Number(S.chat.replyToId));
  const people = (S.chat.channelInfo && S.chat.channelInfo.people) || [];
  return `
    <div class="chat-head">
      <div>
        <div class="chat-title"># ${esc(c.name)}</div>
        <div class="chat-desc">${esc(c.description || "")}</div>
      </div>
      ${aiOn("summaries") ? `<button class="btn ghost sm" title="Summarize this channel with AI" onclick="App.summarizeChannel('${esc(c.id)}')">${I.sparkle}</button>` : ""}
      <button class="btn ghost sm" onclick="App.toggleMute('${esc(c.id)}')" title="${c.muted ? "Unmute channel" : "Mute channel"}">${I.mute} ${c.muted ? "Unmute" : "Mute"}</button>
      <button class="btn primary sm" onclick="App.chatNewTask('${esc(c.id)}')">${I.plus} Task</button>
    </div>
    <div class="chat-messages" id="chat-messages">
      ${S.chat.messages.length ? S.chat.messages.map(messageHtml).join("") : `<div class="chat-empty">No messages yet — say hi.</div>`}
    </div>
    <div class="chat-composer">
      ${replyTo ? `<div class="cc-reply"><div><span>Replying to ${esc(replyTo.author)}</span><p>${esc((replyTo.text || replyTo.linkTitle || "Shared item").slice(0, 150))}</p></div><button onclick="App.cancelChatReply()" aria-label="Cancel reply">×</button></div>` : ""}
      <div class="cc-mentions" id="cc-mentions" style="display:${S.chat.mentionOpen ? "block" : "none"}">${mentionMenuHtml(people)}</div>
      <div class="cc-attach" id="cc-attach" style="display:none">
        <input id="cc-link-url" placeholder="https://… (link to share & file in this channel)">
        <input id="cc-link-title" placeholder="Link title">
      </div>
      <div class="cc-row">
        <button class="btn ghost sm" title="Attach a link" onclick="App.toggleAttach()">${I.docs}</button>
        <button class="btn ghost sm" title="Mention someone" onclick="App.toggleMentions()">@</button>
        <textarea id="chat-input" rows="1" placeholder="Message # ${esc(c.name)}…  (Enter to send, Shift+Enter for newline)" oninput="App.chatDraft(this.value, this.selectionStart)" onkeydown="App.chatKey(event, '${esc(c.id)}')">${esc(S.chat.draft || "")}</textarea>
        <button class="btn neon sm" onclick="App.sendMessage('${esc(c.id)}')" title="Send">${I.send}</button>
      </div>
      <div class="cc-hint">Type @ to mention a person · replies stay connected · only you can delete your messages</div>
    </div>`;
}

function mentionCandidates(people) {
  const query = String(S.chat.mentionQuery || "").toLowerCase();
  const candidates = [
    { username: "everyone", name: "Everyone in this channel", special: true },
    ...(aiOn("chat") ? [{ username: "ai", name: "Monki", bot: true }] : []),
    ...(people || []).filter((person) => person.username !== S.me.username),
  ];
  return candidates.filter((person) => !query || `${person.name} ${person.username}`.toLowerCase().includes(query)).slice(0, 8);
}

function mentionMenuHtml(people) {
  const candidates = mentionCandidates(people);
  if (!candidates.length) return `<div class="mention-empty">No people match “${esc(S.chat.mentionQuery)}”</div>`;
  return `<div class="mention-menu-label">Mention someone</div>${candidates.map((person, index) => `<button class="mention-option ${index === S.chat.mentionIndex ? "active" : ""}" onmousedown="event.preventDefault();App.insertMention('${esc(person.username)}')">
    ${person.special || person.bot ? `<span class="mention-avatar ${person.bot ? "bot" : "all"}">${person.special ? "@" : "M"}</span>` : personAvatar(person, "mention-avatar")}
    <span><b>${esc(person.name)}${!person.special && !person.bot ? ` <i class="presence-dot ${(person.profile || {}).availability === "online" ? "online" : "away"}"></i>` : ""}</b><small>${person.special ? "Notifies every channel member" : person.bot ? "Workspace assistant" : `@${esc(person.username)} · ${(person.profile || {}).availability === "online" ? "online" : "away"}`}</small></span>
    ${index === S.chat.mentionIndex ? `<kbd>↵</kbd>` : ""}
  </button>`).join("")}`;
}

function refreshMentionMenu() {
  const menu = document.getElementById("cc-mentions");
  if (!menu) return;
  menu.style.display = S.chat.mentionOpen ? "block" : "none";
  if (S.chat.mentionOpen) menu.innerHTML = mentionMenuHtml((S.chat.channelInfo && S.chat.channelInfo.people) || []);
}

function messageHtml(m) {
  const linkedTask = m.taskId ? S.data.tasks.find((t) => t.id === m.taskId) : null;
  const isAi = m.authorId === "ai";
  const person = ((S.chat.channelInfo && S.chat.channelInfo.people) || []).find((item) => item.username === m.authorId) || { name: m.author };
  const parent = m.replyToId ? S.chat.messages.find((item) => Number(item.id) === Number(m.replyToId)) : null;
  const replyCount = S.chat.messages.filter((item) => Number(item.replyToId) === Number(m.id)).length;
  const reactionHtml = Object.entries(m.reactions || {}).map(([emoji, people]) => `<button class="msg-reaction ${(people || []).includes(S.me.username) ? "mine" : ""}" onclick="App.reactMessage(${m.id},'${emoji}')"><span>${emoji}</span>${people.length}</button>`).join("");
  return `
  <div class="msg ${m.replyToId ? "is-reply" : ""} ${Number(S.chat.highlightId) === Number(m.id) ? "message-highlight" : ""}" id="message-${m.id}">
    ${isAi ? `<div class="msg-avatar ai">AI</div>` : personAvatar(person, "msg-avatar")}
    <div class="msg-body">
      <div class="msg-head"><span class="msg-author">${esc(m.author)}</span><span class="msg-time">${timeAgo(m.ts)}</span></div>
      ${m.replyToId ? `<button class="msg-reply-preview" onclick="App.focusMessage(${m.replyToId})"><b>${parent ? esc(parent.author) : "Original message"}</b><span>${parent ? esc((parent.text || parent.linkTitle || "Shared item").slice(0, 150)) : "This message is no longer available."}</span></button>` : ""}
      ${m.text ? `<div class="msg-text">${linkifyText(m.text)}</div>` : ""}
      ${m.linkUrl ? `<div class="msg-link">🔗 ${linkify(m.linkUrl, m.linkTitle || shortUrl(m.linkUrl))}</div>` : ""}
      ${m.taskId ? `<div class="msg-task" onclick="App.openTask('${esc(m.taskId)}')">${I.taskChip} <b>${esc(m.taskId)}</b>${linkedTask ? ` — ${esc(linkedTask.title)}` : ""}<span class="pill ${statusClass(linkedTask ? linkedTask.status : "")}" style="margin-left:6px">${linkedTask ? esc(linkedTask.status) : ""}</span></div>` : ""}
      <div class="msg-reaction-row">${reactionHtml}</div>
      ${replyCount ? `<button class="thread-count" onclick="App.replyToMessage(${m.id})"><span>↩</span><b>${replyCount} ${replyCount === 1 ? "reply" : "replies"}</b><em>View thread</em></button>` : ""}
      <div class="msg-toolbar" role="toolbar" aria-label="Message actions">
        <button title="React with thumbs up" aria-label="React with thumbs up" onclick="App.reactMessage(${m.id},'👍')">👍</button>
        <button title="React with check mark" aria-label="React with check mark" onclick="App.reactMessage(${m.id},'✅')">✅</button>
        <button title="Add reaction" aria-label="Add reaction" onclick="App.toggleReactionPicker(${m.id})">☺<span>+</span></button>
        <button title="Reply in thread" aria-label="Reply in thread" onclick="App.replyToMessage(${m.id})">↩</button>
        ${m.text ? `<button title="Create task from message" aria-label="Create task from message" onclick="App.taskFromMessage(${m.id})">${I.plus}</button>` : ""}
        ${m.authorId === S.me.username && !isAi ? `<button title="More actions" aria-label="More actions" onclick="App.toggleMessageMenu(${m.id})">•••</button>` : ""}
      </div>
      <span class="reaction-picker" id="reaction-picker-${m.id}">${["👍","✅","❤️","👀","🎉","🔥","🙌","🤔"].map((emoji) => `<button onclick="App.reactMessage(${m.id},'${emoji}')">${emoji}</button>`).join("")}</span>
      ${m.authorId === S.me.username && !isAi ? `<div class="message-more" id="message-more-${m.id}"><button class="danger-text" onclick="App.deleteChatMessage(${m.id})"><span>⌫</span><b>Delete message</b><small>Only your own messages can be deleted</small></button></div>` : ""}
    </div>
  </div>`;
}

function mentionDisplayName(username) {
  if (String(username).toLowerCase() === "everyone") return "Everyone";
  if (String(username).toLowerCase() === "ai") return "Monki";
  const people = (S.chat.channelInfo && S.chat.channelInfo.people) || [];
  const person = people.find((item) => item.username.toLowerCase() === String(username).toLowerCase())
    || S.directory.find((item) => item.username.toLowerCase() === String(username).toLowerCase());
  return person ? person.name : username;
}

function linkifyText(text) {
  const escaped = esc(text);
  return escaped.replace(
    /(https?:\/\/[^\s&<>"']+)/g,
    (u) => `<a href="${u}" target="_blank" rel="noopener">${u.length > 48 ? u.slice(0, 48) + "…" : u}</a>`
  ).replace(/(^|\s)@([a-z0-9_.-]{2,30}|everyone)\b/gi, (all, lead, name) => `${lead}<span class="mention">@${esc(mentionDisplayName(name))}</span>`);
}

function scrollChatToBottom() {
  const el = document.getElementById("chat-messages");
  if (el) el.scrollTop = el.scrollHeight;
}

/* ------------------------------ notifications ------------------------------ */

function renderNotifPanel() {
  const items = S.notifs.items;
  const kindMeta = (kind) => {
    if (kind === "mention") return ["@", "Mention"];
    if (kind === "new_task") return ["＋", "New task"];
    if (kind === "subtask") return ["↳", "Assignment"];
    if (["approval", "delivery", "delivery_review"].includes(kind)) return ["✓", "Approval"];
    if (kind === "task_comment") return ["💬", "Task comment"];
    if (kind === "chat") return ["💬", "Message"];
    return ["📋", "Task update"];
  };
  return `
  <div class="notif-panel">
    <div class="notif-head">
      <span>Notifications</span>
      <button class="btn ghost sm" onclick="App.markNotifsRead()">Mark all read</button>
    </div>
    ${items.length ? items.map((n) => { const meta = kindMeta(n.kind); return `
      <div class="notif-item ${n.read ? "read" : ""}" onclick="App.gotoNotif(${n.id})">
        <div class="notif-kind kind-${esc(n.kind)}" title="${meta[1]}">${meta[0]}</div>
        <div class="notif-body">
          <div class="notif-label">${meta[1]}</div>
          <div class="notif-text">${esc(n.text)}</div>
          <div class="notif-time">${timeAgo(n.ts)}</div>
        </div>
      </div>`; }).join("") : `<div class="empty-note">No notifications yet.</div>`}
  </div>`;
}

/* ------------------------------ admin ------------------------------ */

async function loadAdmin() {
  try {
    const { users, channels, departments: adminDepartments } = await api("/api/admin/overview");
    S.admin = { users, channels, departments: adminDepartments || [] };
  } catch { /* not admin */ }
}

async function loadIntegrations() {
  if (!isAdmin()) return;
  try {
    S.integrations.hyros = await api("/api/integrations/hyros/status");
    S.integrations.error = "";
  } catch (e) {
    S.integrations.hyros = null;
    S.integrations.error = e.message;
  }
}

function syncRunHtml(run) {
  if (!run || typeof run !== "object") return "";
  const bits = [];
  if (run.status) bits.push(run.status === "rate_limited" ? "rate-limited — retrying automatically" : `status: ${run.status}`);
  if (run.processed != null && run.total != null) bits.push(`${Number(run.processed).toLocaleString()}/${Number(run.total).toLocaleString()} records`);
  else if (run.processed != null) bits.push(`${Number(run.processed).toLocaleString()} records`);
  if (run.startedAt) bits.push(`started ${timeAgo(run.startedAt)}`);
  if (run.finishedAt) bits.push(`finished ${timeAgo(run.finishedAt)}`);
  if (!bits.length) return "";
  return `<div class="intg-syncrun">${I.recurring} Latest sync run — ${esc(bits.join(" · "))}</div>`;
}

function integrationsCardHtml() {
  const g = S.integrations;
  const h = g.hyros;
  let body;
  if (h === undefined) {
    body = `<div class="empty-note compact">Loading integration status…</div>`;
  } else if (!h) {
    body = `<div class="empty-note compact"><b>Integration status unavailable.</b><br><small>${esc(g.error || "The integrations API may not be deployed yet.")}</small></div>`;
  } else if (h.connected) {
    body = `
    <div class="intg-kv">
      ${h.accountName ? `<div><span>Account</span><b>${esc(h.accountName)}</b></div>` : ""}
      <div><span>Last sync</span><b>${h.lastSyncAt ? esc(timeAgo(h.lastSyncAt)) : "—"}</b></div>
      <div><span>Last webhook</span><b>${h.lastWebhookAt ? esc(timeAgo(h.lastWebhookAt)) : "—"}</b></div>
      <div><span>Historical coverage</span><b>${h.historicalDays ? `${Number(h.historicalDays).toLocaleString()} days` : "—"}</b></div>
      <div><span>Records synced</span><b>${h.recordCount != null ? Number(h.recordCount).toLocaleString() : "—"}</b></div>
    </div>
    <div class="intg-diag">
      <div class="intg-diag-title">Import diagnostics</div>
      <div class="intg-kv">
        <div><span>Data period</span><b>${h.dataFrom ? `${esc(fmtDate(h.dataFrom))} → ${esc(fmtDate(h.dataTo || h.dataFrom))}` : "—"}</b></div>
        <div><span>Records imported</span><b>${h.recordsImported != null ? Number(h.recordsImported).toLocaleString() : "—"}</b></div>
        <div><span>Daily snapshots</span><b>${h.snapshotsImported != null ? Number(h.snapshotsImported).toLocaleString() : "—"}</b></div>
        <div><span>History complete</span><b>${h.historyComplete === true ? "Yes" : h.historyComplete === false ? "No" : "—"}</b></div>
      </div>
    </div>
    ${h.rateLimited ? `<div class="intg-chip warn">${I.clock} Sync temporarily rate-limited — retrying automatically</div>` : ""}
    ${h.backfillPending ? `<div class="intg-chip info">${I.recurring} History sync in progress — continues automatically</div>` : ""}
    ${h.lastError && h.lastError !== "rate_limited" ? `<div class="intg-error">${I.alert} ${esc(h.lastError)}</div>` : ""}
    ${syncRunHtml(h.syncRun || h.lastSyncRun)}
    <div class="intg-actions">
      <button class="btn primary sm" onclick="App.hyrosSync()" ${g.busy ? "disabled" : ""}>${I.recurring} ${g.busy ? "Working…" : "Sync now"}</button>
      <button class="btn ghost sm" onclick="App.hyrosTest()" ${g.busy ? "disabled" : ""}>Test connection</button>
      <button class="btn ghost sm" onclick="App.hyrosResync()" ${g.busy ? "disabled" : ""} title="Delete all imported reporting data, then rebuild the full history from scratch">Reset &amp; re-import</button>
      <button class="btn danger sm" onclick="App.hyrosDisconnect()" ${g.busy ? "disabled" : ""}>Disconnect</button>
    </div>
    ${g.notice ? `<div class="intg-notice">${esc(g.notice)}</div>` : ""}
    ${g.error ? `<div class="intg-notice err">${esc(g.error)}</div>` : ""}`;
  } else {
    body = `
    <a class="btn neon" href="/api/integrations/hyros/oauth/start">${I.ext} Connect with Hyros</a>
    <div class="form-hint" style="margin-top:8px">Official sign-in — a Hyros window opens, you log in, and the connection is live. No API key to paste, nothing stored in the browser. <b>Read-only:</b> the app can only read Hyros data; it can never change anything in Hyros.</div>
    <details class="intg-advanced">
      <summary>Advanced: connect with an API key instead</summary>
      <form class="intg-connect" onsubmit="App.hyrosConnect(event)">
        <input name="apiKey" type="password" autocomplete="new-password" maxlength="500" required placeholder="Paste the Hyros API key" aria-label="Hyros API key">
        <button class="btn primary sm" type="submit" ${g.busy ? "disabled" : ""}>${g.busy ? "Connecting…" : "Connect & Test"}</button>
      </form>
      <div class="form-hint">Write-only — the key is stored encrypted server-side and never shown back here. Connecting runs a test call first, then starts the 90-day backfill.</div>
    </details>
    ${g.error ? `<div class="intg-notice err">${esc(g.error)}</div>` : ""}`;
  }
  return `
  <div class="card" id="admin-integrations">
    <div class="card-pad admin-card-head"><div><div class="card-title">${I.ext} Integrations</div><div class="admin-subtitle">External data sources feeding Smart Reporting. Credentials are write-only and stored encrypted server-side.</div></div></div>
    <div class="intg-row">
      <div class="intg-head">
        <span class="intg-dot ${h && h.connected ? "on" : ""}"></span>
        <b>Hyros</b>
        ${h ? (h.connected ? `<span class="pill status-Completed">Connected</span>` : `<span class="pill status-Backlog">Not connected</span>`) : ""}
        ${h && h.connected ? `<span class="pill status-Backlog" title="This connection can only read Hyros data">${h.authMethod === "oauth" ? "Signed in with Hyros" : "API key"} · read-only</span>` : ""}
        ${h && h.connected && h.accountName ? `<span class="intg-acct">${esc(h.accountName)}</span>` : ""}
      </div>
      ${body}
    </div>
  </div>`;
}

function renderAdmin(el) {
  if (!isAdmin()) {
    el.innerHTML = `<div class="card"><div class="empty-note">Super admin only.</div></div>`;
    return;
  }
  if (S.integrations.hyros === undefined && !S.integrations.loading) {
    S.integrations.loading = true;
    loadIntegrations().then(() => { S.integrations.loading = false; if (S.route === "admin") renderPage("admin"); });
  }
  const { users, channels, departments: adminDepartments = [] } = S.admin;
  if (!users.length) {
    el.innerHTML = `<div class="card"><div class="empty-note">Loading…</div></div>`;
    loadAdmin().then(() => { if (S.route === "admin") renderPage("admin"); });
    return;
  }
  const rolePill = (r) =>
    r === "super_admin" ? `<span class="pill status-NewRequest">Super Admin</span>`
    : r === "client" ? `<span class="pill status-WaitingonClient">Client</span>`
    : `<span class="pill status-Planned">Team</span>`;

  el.innerHTML = `<div class="admin-stack">
    <div class="card">
      <div class="card-pad admin-card-head"><div><div class="card-title">${I.team} Users &amp; access <span class="count">(${users.length})</span></div><div class="admin-subtitle">Client and team are separate access types. Department membership may be multiple.</div></div><button class="btn primary sm" onclick="App.openModal('addUser')">${I.plus} Add user</button></div>
      <div class="table-wrap"><table class="data admin-users-table"><thead><tr><th>User</th><th>Access</th><th>Departments</th><th>Status</th><th></th></tr></thead><tbody>
        ${users.map((u) => `<tr style="cursor:default"><td><div class="t-title">${esc(u.name)}</div><div class="t-sub">@${esc(u.username)} · ${esc(u.org || "")}</div></td>
          <td>${rolePill(u.role)}</td><td>${u.role === "client" ? `<span class="client-safe-chip">Limited client view</span>` : (u.departments || []).length ? (u.departments || []).map((id) => { const d = adminDepartments.find((x) => x.id === id) || deptById(id); return d ? `<span class="admin-dept-chip" style="--dept:${esc(d.color)}">${esc(d.icon)} ${esc(d.name)}</span>` : ""; }).join("") : `<span class="muted-note">No departments</span>`}</td>
          <td>${u.active ? `<span class="pill status-Completed">Active</span> <span class="availability-label"><i class="presence-dot ${(u.profile || {}).availability === "online" ? "online" : "away"}"></i>${(u.profile || {}).availability === "online" ? "Online" : "Away"}</span>` : `<span class="pill status-Cancelled">Disabled</span>`}</td>
          <td class="admin-actions"><button class="btn ghost sm" onclick="App.openModal('editUser:${esc(u.username)}')">Manage user</button>${u.username !== S.me.username ? `<button class="btn ghost sm" onclick="App.toggleUserActive('${esc(u.username)}', ${u.active})">${u.active ? "Disable" : "Enable"}</button>` : ""}</td></tr>`).join("")}
      </tbody></table></div>
    </div>
    ${integrationsCardHtml()}
    <div class="grid-2 admin-lower-grid">
      <div class="card"><div class="card-pad admin-card-head"><div><div class="card-title">Department system <span class="count">(${adminDepartments.filter((d) => d.active).length})</span></div><div class="admin-subtitle">Colors and symbols appear on every department task.</div></div><button class="btn primary sm" onclick="App.openModal('addDepartment')">${I.plus} Department</button></div>
        <div class="department-admin-list">${adminDepartments.map((d) => `<div class="department-admin-row ${d.active ? "" : "archived"}"><span class="department-admin-icon" style="--dept:${esc(d.color)}">${esc(d.icon)}</span><div><b>${esc(d.name)}</b><small>${d.active ? "Active" : "Archived"} · ${esc(d.color)}</small></div><span class="spacer"></span><button class="btn ghost sm" onclick="App.openModal('editDepartment:${esc(d.id)}')">Edit</button>${d.active ? `<button class="btn ghost sm danger-text" onclick="App.archiveDepartment('${esc(d.id)}','${esc(d.name)}')">Archive</button>` : `<button class="btn ghost sm" onclick="App.reactivateDepartment('${esc(d.id)}')">Reactivate</button>`}</div>`).join("")}</div>
      </div>
      <div class="card"><div class="card-pad admin-card-head"><div><div class="card-title">${I.chat} Channels <span class="count">(${channels.length})</span></div><div class="admin-subtitle">Separate discussions by workstream and audience.</div></div><button class="btn primary sm" onclick="App.openModal('newChannel')">${I.plus} Channel</button></div>
        ${channels.map((c) => `<div class="admin-channel"><div class="ac-head"><span class="ch-name"># ${esc(c.name)}</span>${c.autoAll ? `<span class="tag-plain">everyone</span>` : ""}${c.clientAllowed ? `<span class="client-safe-chip">client allowed</span>` : ""}<span class="spacer"></span>${!c.autoAll ? `<button class="btn ghost sm" onclick="App.openChannelMembers('${esc(c.id)}')">Members (${c.members.length})</button><button class="btn ghost sm danger-text" onclick="App.deleteChannel('${esc(c.id)}','${esc(c.name)}')">Delete</button>` : ""}</div><div class="ac-desc">${esc(c.description || "")}</div></div>`).join("")}
      </div>
    </div>
  </div>`;
}

function viewApprovals() {
  const waiting = S.data.tasks.filter((task) => task.approval && task.approval.status === "awaiting_review");
  const decided = S.data.tasks.filter((task) => task.approval && ["approved", "changes_requested"].includes(task.approval.status));
  const card = (task) => {
    const links = task.attachments || [];
    const pending = task.approval.status === "awaiting_review";
    return `<div class="card approval-card">
      <div class="approval-card-head"><div><span class="dh-id">${esc(task.id)}</span><h3>${esc(task.title)}</h3></div><span class="pill ${pending ? statusClass("Waiting on Client") : task.approval.status === "approved" ? statusClass("Completed") : statusClass("Revision Required")}">${pending ? "Needs your review" : task.approval.status === "approved" ? "Approved" : "Changes requested"}</span></div>
      <div class="approval-meta">${departmentSignals(task)}<span>${links.length} deliverable link${links.length === 1 ? "" : "s"}</span><span>Sent ${timeAgo(task.approval.ts)}</span></div>
      <div class="approval-files">${links.map((file) => `<a href="${esc(file.openUrl)}" target="_blank" rel="noopener">🔗 ${esc(file.name)} ${I.ext}</a>`).join("")}</div>
      ${task.approval.feedback ? `<div class="approval-feedback"><b>Your feedback</b>${esc(task.approval.feedback)}</div>` : ""}
      <div class="approval-actions"><button class="btn ghost sm" onclick="App.openTask('${esc(task.id)}')">Open task</button>${pending ? `<button class="btn neon sm" onclick="App.reviewTask('${esc(task.id)}','approve')">Approve</button><button class="btn ghost sm" onclick="App.reviewTask('${esc(task.id)}','request_changes',true)">Request changes</button>` : ""}</div>
    </div>`;
  };
  return `<div class="approval-page">
    <div class="approval-summary"><div><b>${waiting.length}</b><span>waiting for you</span></div><p>Open every deliverable, then approve the work or send clear feedback to the team.</p></div>
    <h3 class="page-section-title">Needs your approval</h3>${waiting.length ? `<div class="approval-grid">${waiting.map(card).join("")}</div>` : `<div class="card empty-note">Nothing is waiting for your approval.</div>`}
    ${decided.length ? `<h3 class="page-section-title">Recent decisions</h3><div class="approval-grid">${decided.slice(0, 12).map(card).join("")}</div>` : ""}
  </div>`;
}

function viewProfile() {
  const p = S.me.profile || { availability: "away", bio: "", contact: "", email: "", avatar: "" };
  const preview = S.profileAvatarDraft === null ? p.avatar : S.profileAvatarDraft;
  return `<div class="profile-layout">
    <div class="card profile-identity">
      ${preview ? `<div class="profile-avatar large image-avatar"><img src="${esc(preview)}" alt="${esc(S.me.name)}"></div>` : `<div class="profile-avatar large">${esc(initials(S.me.name))}</div>`}
      <h2>${esc(S.me.name)}</h2><span>@${esc(S.me.username)}</span>
      <div class="availability-switch"><button class="${p.availability === "online" ? "active" : ""}" onclick="App.setAvailability('online')"><i class="presence-dot online"></i> Online</button><button class="${p.availability !== "online" ? "active" : ""}" onclick="App.setAvailability('away')"><i class="presence-dot away"></i> Away</button></div>
      <p>Online means you are working and available today. Choose Away when you are unavailable.</p>
    </div>
    <div class="profile-main">
      <div class="card card-pad profile-editor"><div class="card-title">Profile information</div>
        <form onsubmit="App.saveProfile(event)">
          <div class="form-row"><label>PROFILE PICTURE <span class="label-note">PNG, JPG, WEBP or GIF · under 250 KB</span></label><input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onchange="App.selectProfilePicture(this)">${preview ? `<button type="button" class="btn ghost sm" onclick="App.removeProfilePicture()">Remove picture</button>` : ""}</div>
          <div class="form-row"><label>BIO</label><textarea name="bio" maxlength="500" placeholder="What you work on and how teammates can work with you…">${esc(p.bio || "")}</textarea></div>
          <div class="form-grid"><div class="form-row"><label>CONTACT</label><input name="contact" maxlength="120" value="${esc(p.contact || "")}" placeholder="Phone, WeChat or preferred contact"></div><div class="form-row"><label>EMAIL</label><input name="email" type="email" maxlength="254" value="${esc(p.email || "")}" placeholder="name@company.com"></div></div>
          <div class="modal-foot"><button class="btn primary" type="submit">Save profile</button></div>
        </form>
      </div>
      <div class="card account-card"><div><div class="card-title">Account &amp; security</div><p>Password and session controls are kept here in your private profile.</p></div><div class="account-actions"><button class="btn ghost" onclick="App.openModal('password')">${I.key} Change password</button><button class="btn danger" onclick="App.logout()">${I.logout} Sign out</button></div></div>
    </div>
  </div>`;
}

function viewTeam() {
  const people = (S.directory || []).filter((user) => user.role === "team" || user.role === "super_admin");
  return `
  <div class="page-head-note">Who is available today and what they own. Green means online and available; amber means away.</div>
  <div class="team-grid">
    ${people.length ? people.map((user) => { const p = S.data.team.find((item) => item.name === user.name) || {}; return `
      <div class="card team-card">
        <div class="team-card-person">${personAvatar(user, "team-avatar")}<div><div class="tc-name">${esc(user.name)} <i class="presence-dot ${(user.profile || {}).availability === "online" ? "online" : "away"}"></i></div><div class="tc-role">${(user.profile || {}).availability === "online" ? "Online · available" : "Away"}</div></div></div>
        <div class="tc-area">${esc(p.area || (user.departments || []).map((id) => (deptById(id) || {}).name || id).join(", "))}</div>
        <div class="tc-resp">${esc((user.profile || {}).bio || p.responsibility || "No bio added yet.")}</div>
        ${((user.profile || {}).email || (user.profile || {}).contact) ? `<div class="team-contact">${esc((user.profile || {}).email || (user.profile || {}).contact)}</div>` : ""}
      </div>`; }).join("") : `<div class="card"><div class="empty-note">No team members listed yet.</div></div>`}
  </div>`;
}

/* ------------------------------ Monki AI chatbot ------------------------------ */

function citationChips(citations) {
  if (!citations || !citations.length) return "";
  const icons = { task: "📋", message: "💬", link: "🔗", decision: "⚖️", deliverable: "📦", guide: "↗" };
  return `<div class="cite-row">` + citations.map((c) => {
    const icon = icons[c.type] || "📄";
    if (c.type === "task") return `<button class="cite-chip" onclick="App.openTask('${esc(c.id)}')" title="Open ${esc(c.title || c.id)}">${icon} ${esc(c.id)}</button>`;
    if (c.type === "message") return `<button class="cite-chip" onclick="App.gotoChannel('${esc(c.channelId)}')">${icon} ${esc(c.title)}</button>`;
    if (c.type === "link" && /^https:\/\//i.test(c.url || "")) return `<a class="cite-chip source-link" href="${esc(c.url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()" title="Open shared link in a new tab">${icon} ${esc(c.title)} ${I.ext}</a>`;
    if (c.type === "link" && c.taskId) return `<button class="cite-chip" onclick="App.openTask('${esc(c.taskId)}')" title="Open the related task">${icon} ${esc(c.title)}</button>`;
    if (c.type === "link") return `<button class="cite-chip" onclick="App.nav('files')">${icon} ${esc(c.title)}</button>`;
    if (c.type === "decision") return `<button class="cite-chip" onclick="App.nav('decisions')">${icon} ${esc(c.title || c.id)}</button>`;
    if (c.type === "deliverable" && /^https:\/\//i.test(c.url || "")) return `<a class="cite-chip source-link" href="${esc(c.url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()" title="Open the deliverable file in a new tab">${icon} ${esc(c.title || c.id)} ${I.ext}</a>`;
    if (c.type === "deliverable") return `<button class="cite-chip" onclick="App.nav('deliverables')">${icon} ${esc(c.title || c.id)}</button>`;
    if (c.type === "guide") return `<span class="cite-chip guide-chip">${icon} ${esc(c.title || "Workspace workflow")}</span>`;
    return `<span class="cite-chip">${icon} ${esc(c.title || c.id)}</span>`;
  }).join("") + `</div>`;
}

function monkiExamples() {
  return isClient()
    ? [
      { prompt: "What needs my attention today?", hint: "Reviews, approvals and decisions" },
      { prompt: "What changed since my last visit?", hint: "A concise progress update" },
      { prompt: "Create a task for the team from my request", hint: "Prepare an actionable task draft" },
      { prompt: "Draft a reply to the latest project update", hint: "Review it before posting" },
      { prompt: "What is waiting for my approval?", hint: "Deliverables and visible work" },
      { prompt: "Find the latest links for my active projects", hint: "Search shared task and file links" },
    ]
    : [
      { prompt: "What needs my attention today?", hint: "Priorities, blockers and reviews" },
      { prompt: "Show my overdue and blocked tasks", hint: "Focus on work that needs action" },
      { prompt: "Create a task draft for the next priority", hint: "Prepare ownership and next steps" },
      { prompt: "Draft a reply to the latest client message", hint: "Use the relevant conversation" },
      { prompt: "Find the latest link for my active work", hint: "Search tasks and shared links" },
      { prompt: "Summarize what changed since yesterday", hint: "Recent movement across my work" },
    ];
}

function monkiFormat(text) {
  const tokens = [];
  const hold = (html) => {
    const token = `@@MONKI_ENTITY_${tokens.length}@@`;
    tokens.push({ token, html });
    return token;
  };
  let raw = String(text || "")
    .replace(/https:\/\/[^\s<>()]+/gi, (value) => {
      const trimmed = value.replace(/[.,!?;:]+$/, "");
      const trailing = value.slice(trimmed.length);
      return hold(`<a class="monki-entity-link external" href="${esc(trimmed)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">${esc(trimmed)} ${I.ext}</a>`) + trailing;
    })
    .replace(/\bNM-[A-Z0-9]+-[0-9]{3,}\b/g, (id) => {
      const exists = S.data && S.data.tasks && S.data.tasks.some((task) => task.id === id);
      return exists ? hold(`<button class="monki-entity-link task" onclick="App.openTask('${esc(id)}')" title="Open ${esc(id)}">${esc(id)}</button>`) : id;
    });
  let html = esc(raw)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\n/g, "<br>");
  for (const item of tokens) html = html.replace(item.token, item.html);
  return html;
}

function monkiSuggestions(a, messageIndex) {
  const items = (a && a.suggestions) || [];
  if (!items.length) return "";
  return `<div class="monki-next-actions"><div class="monki-next-label">Do it now</div>${items.map((item, suggestionIndex) => {
    const primary = suggestionIndex === 0 ? " primary" : "";
    if (item.kind === "open_url" && /^https:\/\//i.test(item.url || "")) {
      return `<a class="monki-next-btn${primary}" href="${esc(item.url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">${I.ext}<span>${esc(item.label)}</span></a>`;
    }
    return `<button class="monki-next-btn${primary}" onclick="App.runMonkiSuggestion(${messageIndex},${suggestionIndex})">${item.kind === "open_task" ? I.tasks : I.sparkle}<span>${esc(item.label)}</span></button>`;
  }).join("")}</div>`;
}

function monkiAnswerExtras(a, interactive, messageIndex) {
  if (!a) return "";
  return `
    ${citationChips(a.citations)}
    ${monkiSuggestions(a, messageIndex)}
    ${interactive ? (a.drafts || []).map((d, i) => `
      <div class="draft-card monki-draft">
        <div class="draft-head">📋 Task draft — review before creating</div>
        <div class="draft-title">${esc(d.title)}</div>
        <div class="draft-meta">${esc(d.department || "—")} · ${esc(d.priority)}${d.owner ? " · " + esc(d.owner) : ""}${d.dueDate ? " · due " + esc(d.dueDate) : ""}</div>
        ${d.description ? `<div class="draft-desc">${esc(d.description)}</div>` : ""}
        <button class="btn primary sm" onclick="App.createDraftTask(${i})">Create this task</button>
      </div>`).join("") : ""}
    ${interactive ? (a.replyDrafts || []).map((d, i) => `
      <div class="draft-card monki-draft reply-draft-card">
        <div class="draft-head">💬 Reply draft for #${esc(d.channelName || d.channelId)} · ${esc(d.tone || "concise")}</div>
        <div class="draft-reply-text">${monkiFormat(d.text || "")}</div>
        <button class="btn primary sm" onclick="App.useReplyDraft(${i})">Use in chat</button>
        <button class="btn ghost sm" onclick="App.copyReplyDraft(${i})">Copy</button>
      </div>`).join("") : ""}
    ${interactive ? (a.proposals || []).map((p, i) => {
      const st = (a.proposalState || {})[i];
      const desc = p.type === "task_update"
        ? `<b>${esc(p.taskId)}</b> — ${esc(p.title || "")}<br>${Object.entries(p.fields || {}).map(([k, v]) => `${esc(k)} → <b>${esc(v)}</b>`).join(" · ")}${p.reason ? `<br><span class="monki-muted">${esc(p.reason)}</span>` : ""}`
        : `Record decision: <b>${esc(p.topic || "Decision")}</b><br>${esc(p.rule || "")}`;
      return `
      <div class="draft-card monki-draft">
        <div class="draft-head">${p.type === "task_update" ? "📋 Proposed task change" : "⚖️ Proposed decision"} — nothing changes until you approve</div>
        <div class="draft-desc">${desc}</div>
        ${st === "applied" ? `<span class="pill status-Completed">Approved &amp; applied ✓</span>`
          : st === "modified" ? `<span class="pill status-Completed">Modified &amp; applied ✓</span>`
          : st === "rejected" ? `<span class="pill status-Cancelled">Rejected</span>`
          : st && st.error ? `<span class="pill status-RevisionRequired">${esc(st.error)}</span>`
          : `<button class="btn neon sm" onclick="App.applyAction(${i})">Approve</button>
             <button class="btn ghost sm" onclick="App.openModal('aiProposal:${i}')">Modify</button>
             <button class="btn ghost sm" onclick="App.rejectAction(${i})">Reject</button>`}
      </div>`;
    }).join("") : ""}`;
}

function renderMonkiMessage(message, index) {
  if (message.role === "user") {
    return `<div class="monki-message user">
      <div class="monki-bubble user-bubble">${monkiFormat(message.text)}</div>
      <div class="monki-message-time">You · ${timeAgo(message.ts)}</div>
    </div>`;
  }
  const a = message.answer || {};
  const interactive = a === S.aiAnswer && index === S.monki.messages.length - 1;
  return `<div class="monki-message assistant">
    <img class="monki-mini-avatar" src="/monki-mark.svg" alt="" aria-hidden="true">
    <div class="monki-message-body">
      <div class="monki-message-name"><span>Monki</span><span>${timeAgo(a.ts)}</span></div>
      <div class="monki-bubble assistant-bubble ${a.error ? "error" : ""} ${a.report ? "report-bubble" : ""}">
        ${a.report ? `<div class="ai-label monki-report-label">${I.sparkle} AI-generated performance report — review before sharing</div>` : ""}
        <div class="monki-answer-text">${a.report ? renderAiBrief(a.answer || "") : monkiFormat(a.answer || "")}</div>
        ${monkiAnswerExtras(a, interactive, index)}
        ${a.report && !a.error ? `<div class="monki-report-actions"><button class="btn ghost sm" onclick="App.copyMonkiMessage(${index})">${I.copy} Copy report</button></div>` : ""}
      </div>
    </div>
  </div>`;
}

function renderMonkiWidget() {
  const displayName = esc((S.me && S.me.name) || "there");
  const examples = monkiExamples();
  const used = S.ai ? S.ai.callsToday || 0 : 0;
  const limit = S.ai ? S.ai.dailyLimit || 0 : 0;
  const messages = S.monki.messages || [];
  return `
  <section class="monki-panel ${S.monki.open ? "open" : ""}" role="dialog" aria-modal="false" aria-label="Chat with Monki" aria-hidden="${S.monki.open ? "false" : "true"}">
    <header class="monki-header">
      <div class="monki-header-art" aria-hidden="true">
        <img src="/monki-mark.svg" alt="">
      </div>
      <div class="monki-heading">
        <div class="monki-title-row"><h2>Monki</h2><span class="monki-live"><i></i> Online</span></div>
        <p>Tasks, replies and next steps</p>
      </div>
      <div class="monki-header-actions">
        <button class="monki-min" onclick="App.closeMonki()" aria-label="Minimize Monki" title="Minimize — chat is kept">–</button>
        <button class="monki-close" onclick="App.closeMonki()" aria-label="Close Monki" title="Close">×</button>
      </div>
    </header>
    <div class="monki-messages" id="monki-messages" aria-live="polite">
      <div class="monki-message assistant welcome">
        <img class="monki-mini-avatar" src="/monki-mark.svg" alt="" aria-hidden="true">
        <div class="monki-message-body">
          <div class="monki-message-name"><span>Monki</span></div>
          <div class="monki-bubble assistant-bubble">
            <div class="monki-greeting">Hi ${displayName}. What needs your attention today?</div>
            <div>I can review your work, prepare a task, draft a reply or find the right link.</div>
          </div>
        </div>
      </div>
      ${messages.length ? messages.map(renderMonkiMessage).join("") : `
        <div class="monki-suggestions" aria-label="Suggested questions">
          <div class="monki-suggestions-label">Quick actions</div>
          ${examples.map((q, i) => `<button class="${i === 0 ? "primary" : ""}" data-prompt="${esc(q.prompt)}" onclick="App.askMonki(this.dataset.prompt)">${I.sparkle}<span class="monki-suggestion-copy"><b>${esc(q.prompt)}</b><small>${esc(q.hint)}</small></span></button>`).join("")}
        </div>`}
      ${S.aiBusy ? `<div class="monki-message assistant typing">
        <img class="monki-mini-avatar" src="/monki-mark.svg" alt="" aria-hidden="true">
        <div class="monki-message-body">
          <div class="monki-message-name"><span>Monki is checking your workspace…</span></div>
          <div class="monki-bubble assistant-bubble"><span class="monki-dot"></span><span class="monki-dot"></span><span class="monki-dot"></span></div>
        </div>
      </div>` : ""}
    </div>
    <div class="monki-composer">
      <div class="monki-input-wrap">
        <textarea id="monki-input" rows="1" placeholder="Message Monki…" aria-label="Message Monki" oninput="App.monkiDraft(this.value)" onkeydown="App.monkiKey(event)" ${S.aiBusy ? "disabled" : ""}>${esc(S.monki.draft || "")}</textarea>
        <button onclick="App.askMonki()" aria-label="Send message" title="Send" ${S.aiBusy ? "disabled" : ""}>${I.send}</button>
      </div>
      <div class="monki-composer-meta"><span>${used}/${limit} today</span><button class="monki-deep ${S.monki.deep ? "on" : ""}" onclick="App.toggleDeep()" title="Use the advanced reasoning engine for complex questions">🧠 Deep think</button><select class="monki-report-pick" title="Generate a platform performance report for a period" aria-label="Generate a performance report" onchange="App.monkiReport(this.value)" ${S.aiBusy ? "disabled" : ""}><option value="">📊 Performance report…</option><option value="week">This week</option><option value="month">This month</option></select><span>Answers include workspace sources</span></div>
    </div>
  </section>
  <div class="monki-launcher-wrap ${S.monki.open ? "panel-open" : ""}">
    <div class="monki-launcher-label"><strong>Monki</strong><span>Ready to help</span></div>
    <button class="monki-launcher ${S.aiBusy ? "thinking" : ""}" onclick="App.toggleMonki()" aria-label="${S.monki.open ? "Close" : "Open"} Monki chatbot" aria-expanded="${S.monki.open}">
      <img src="/monki-mark.svg" alt="Monki">
      <span class="monki-status-dot"></span>
    </button>
  </div>`;
}

function scrollMonki(focus) {
  setTimeout(() => {
    const box = document.getElementById("monki-messages");
    if (box) box.scrollTop = (S.monki.messages || []).length || S.aiBusy ? box.scrollHeight : 0;
    const input = document.getElementById("monki-input");
    if (focus && input && !S.aiBusy) input.focus();
  }, 30);
}

function captureMonkiViewport() {
  const box = document.getElementById("monki-messages");
  if (!box) return null;
  return {
    top: box.scrollTop,
    atBottom: box.scrollHeight - box.clientHeight - box.scrollTop < 36,
  };
}

function restoreMonkiViewport(viewport) {
  if (!viewport) return;
  setTimeout(() => {
    const box = document.getElementById("monki-messages");
    if (!box) return;
    box.scrollTop = viewport.atBottom ? box.scrollHeight : viewport.top;
  }, 30);
}

/* ------------------------------ AI Control Center ------------------------------ */

async function loadAiControl() {
  try {
    const [admin, actions] = await Promise.all([api("/api/ai/admin"), api("/api/ai/actions")]);
    S.aiControl = { ...admin, actions: actions.actions };
  } catch { /* not admin */ }
}

function aiToolProfile(control, user) {
  const names = (user.tools || []).slice().sort().join(",");
  const read = control.tools.filter((t) => t.kind === "read").map((t) => t.name).sort().join(",");
  const draft = control.tools.filter((t) => t.kind !== "proposal").map((t) => t.name).sort().join(",");
  const full = control.tools.map((t) => t.name).sort().join(",");
  if (names === read) return "read";
  if (names === draft) return "draft";
  if (names === full) return "full";
  return "custom";
}

function aiToolsForProfile(control, profile, current) {
  if (profile === "read") return control.tools.filter((t) => t.kind === "read").map((t) => t.name);
  if (profile === "draft") return control.tools.filter((t) => t.kind !== "proposal").map((t) => t.name);
  if (profile === "full") return control.tools.map((t) => t.name);
  return current || [];
}

function renderAiControl(el) {
  if (!isAdmin()) {
    el.innerHTML = `<div class="card"><div class="empty-note">Super admin only.</div></div>`;
    return;
  }
  const c = S.aiControl;
  if (!c) {
    el.innerHTML = `<div class="card"><div class="empty-note">Loading…</div></div>`;
    loadAiControl().then(() => { if (S.route === "aicontrol") renderPage("aicontrol"); });
    return;
  }
  const s = c.settings;
  const f = s.features || {};
  el.innerHTML = `
  <div class="grid-2">
    <div>
      <div class="card card-pad" style="margin-bottom:16px">
        <div class="card-title" style="margin-bottom:12px">${I.sparkle} Private engine</div>
        <div class="ai-kv"><span>Connection</span><b>${esc(c.provider && c.provider.name || "Private intelligence engine")}</b></div>
        <div class="ai-kv"><span>System status</span><b>${esc(c.provider && c.provider.status || "unknown")}</b></div>
        <div class="ai-kv"><span>Access key</span><b>${c.configured ? `Configured · ${c.provider.keySource === "control_center" ? "saved in AI Control" : "server environment"}` : "Not configured"}</b></div>
        ${c.provider.storedKeyUnreadable ? `<div class="login-error">The saved key cannot be decrypted with the current server secret. Save the key again.</div>` : ""}
        <form class="ai-provider-form" onsubmit="App.aiSaveProvider(event)">
          <div class="form-row">
            <label>ACCESS ROUTE</label>
            <select name="connectionType" required>
              <option value="membership_cn" ${c.connectionType === "membership_cn" ? "selected" : ""}>Membership access · China</option>
              <option value="api_cn" ${c.connectionType === "api_cn" ? "selected" : ""}>API access · China / RMB</option>
              <option value="api_global" ${c.connectionType === "api_global" ? "selected" : ""}>API access · Global</option>
            </select>
            <div class="form-hint">Choose the route that matches the private access key issued to this workspace.</div>
          </div>
          <div class="form-row">
            <label>PRIVATE ENGINE ACCESS KEY</label>
            <input name="apiKey" type="password" autocomplete="new-password" maxlength="500" placeholder="${c.configured ? "Leave blank to keep the current key" : "Paste the private access key"}">
            <div class="form-hint">The key is encrypted server-side and is never displayed back in the browser.</div>
          </div>
          <div class="ai-provider-actions">
            <button class="btn primary sm" type="submit">Save connection</button>
            <button class="btn ghost sm" type="button" onclick="App.aiTest()">Test connection</button>
            ${c.provider.keySource === "control_center" ? `<button class="btn danger sm" type="button" onclick="App.aiClearProviderKey()">Remove saved key</button>` : ""}
          </div>
        </form>
        ${S.aiTestResult ? `<div style="margin-top:10px"><span class="ai-test ${S.aiTestResult.ok ? "ok" : "err"}">${S.aiTestResult.ok ? `Private connection verified${S.aiTestResult.configurationUpdated ? " · route corrected automatically" : ""}` : esc(S.aiTestResult.error)}</span></div>` : ""}
      </div>
      <div class="card card-pad" style="margin-bottom:16px">
        <div class="card-title" style="margin-bottom:12px">Features &amp; limits</div>
        <form onsubmit="App.aiSaveSettings(event)">
          <label class="ai-toggle"><input type="checkbox" name="enabled" ${s.enabled ? "checked" : ""}> AI enabled (global)</label>
          <label class="ai-toggle"><input type="checkbox" name="allowClient" ${s.allowClient ? "checked" : ""}> Allow the client (Adika) to use AI — client-safe context only</label>
          <label class="ai-toggle"><input type="checkbox" name="f_ask" ${f.ask !== false ? "checked" : ""}> Monki chatbot</label>
          <label class="ai-toggle"><input type="checkbox" name="f_chat" ${f.chat !== false ? "checked" : ""}> In-chat @ai</label>
          <label class="ai-toggle"><input type="checkbox" name="f_brief" ${f.brief !== false ? "checked" : ""}> Daily brief</label>
          <label class="ai-toggle"><input type="checkbox" name="f_summaries" ${f.summaries !== false ? "checked" : ""}> Task &amp; channel summaries</label>
          <div class="form-grid" style="margin-top:10px">
            <div class="form-row"><label>DAILY LIMIT (per user)</label><input name="dailyLimit" type="number" min="1" max="1000" value="${s.dailyLimit}"></div>
            <div class="form-row"><label>BASIC MODEL (everyday asks, summaries, briefs)</label><input name="modelBasic" value="${esc((s.models && s.models.basic) || "")}" placeholder="fast engine id" maxlength="80"></div>
            <div class="form-row"><label>ADVANCED MODEL (deep reasoning, decision support)</label><input name="modelAdvanced" value="${esc((s.models && s.models.advanced) || "")}" placeholder="deep engine id" maxlength="80"></div>
          </div>
          <button class="btn primary sm" type="submit">Save settings</button>
        </form>
      </div>
      <div class="card card-pad" style="margin-bottom:16px">
        <div class="card-title" style="margin-bottom:4px">Per-user AI access</div>
        <div class="form-hint">These capability profiles are enforced by the API. Read only cannot draft or propose changes; Read + drafts can prepare tasks; Full can also propose task updates and decisions for human approval.</div>
        <div class="form-hint">Reporting access — "Advanced" is the full Smart Reporting dashboard; "Super" adds the AI report generator; "Basic" is the calm Performance page; empty follows the role default (super admin → Super, client/team → Basic).</div>
        <div class="ai-user-list">
          ${(c.userAccess || []).map((u) => {
            const profile = aiToolProfile(c, u);
            const reporting = u.reporting === "full" ? "advanced" : (u.reporting || ""); // legacy stored "full" reads as advanced
            return `
            <form class="ai-user-row" onsubmit="App.aiSaveUser(event, '${esc(u.username)}')">
              <label class="ai-user-enabled"><input type="checkbox" name="enabled" ${u.enabled ? "checked" : ""}> <span><b>${esc(u.name)}</b><small>${esc(u.role)}${u.active ? "" : " · disabled account"}</small></span></label>
              <select name="profile" aria-label="AI capability profile for ${esc(u.name)}">
                <option value="read" ${profile === "read" ? "selected" : ""}>Read only</option>
                <option value="draft" ${profile === "draft" ? "selected" : ""}>Read + drafts</option>
                <option value="full" ${profile === "full" ? "selected" : ""}>Full proposals</option>
                ${profile === "custom" ? `<option value="custom" selected>Custom API policy</option>` : ""}
              </select>
              <select name="reporting" aria-label="Reporting access for ${esc(u.name)}">
                <option value="" ${reporting === "" ? "selected" : ""}>Role default</option>
                <option value="basic" ${reporting === "basic" ? "selected" : ""}>Basic</option>
                <option value="advanced" ${reporting === "advanced" ? "selected" : ""}>Advanced (Smart Reporting)</option>
                <option value="super" ${reporting === "super" ? "selected" : ""}>Super (incl. report generator)</option>
                <option value="none" ${reporting === "none" ? "selected" : ""}>None</option>
              </select>
              <input name="dailyLimit" type="number" min="1" max="1000" value="${u.dailyLimit == null ? "" : u.dailyLimit}" placeholder="global ${s.dailyLimit}" aria-label="Daily limit override">
              <span class="ai-user-usage">${u.usage.calls} calls · ${u.usage.tokens.toLocaleString()} tokens</span>
              <button class="btn ghost sm" type="submit">Save</button>
            </form>`;
          }).join("")}
        </div>
      </div>
      <div class="card card-pad">
        <div class="card-title" style="margin-bottom:12px">Usage today</div>
        <div class="ai-kv"><span>Calls</span><b>${c.stats.callsToday}</b></div>
        <div class="ai-kv"><span>Tokens</span><b>${c.stats.tokensToday.toLocaleString()}</b></div>
        <div class="ai-kv"><span>Errors</span><b>${c.stats.errorsToday}</b></div>
        <div class="ai-kv"><span>Key handling</span><b>Encrypted server-side · never returned to the browser</b></div>
      </div>
      <div class="card card-pad" style="margin-top:16px">
        <div class="card-title" style="margin-bottom:10px">AI action requests (propose / modify / decide trail)</div>
        ${(c.actions || []).length ? c.actions.slice(0, 20).map((a) => `
          <div class="ai-action-row">
            <span class="pill ${a.status === "executed" ? "status-Completed" : a.status === "rejected" ? "status-Cancelled" : "status-Planned"}">${esc(a.status)}</span>
            <span class="aa-text"><b>${esc(a.username)}</b> · ${esc(a.actionType)}${a.payload && a.payload.taskId ? " · " + esc(a.payload.taskId) : ""}${a.payload && a.payload.topic ? " · " + esc(a.payload.topic) : ""}${a.modifiedPayload && Object.keys(a.modifiedPayload).length ? " · modified before approval" : ""}${a.decidedBy ? " · decided by " + esc(a.decidedBy) : ""}</span>
            <span class="aa-time">${timeAgo(a.ts)}</span>
          </div>`).join("") : `<div class="empty-note">No AI action requests yet. When the AI proposes a task change or decision and a human approves or dismisses it, it lands here.</div>`}
      </div>
    </div>
    <div class="card">
      <div class="card-pad" style="border-bottom:1px solid var(--line)"><div class="card-title">AI audit log (latest 100)</div></div>
      <table class="data">
        <thead><tr><th>Time</th><th>User</th><th>Kind</th><th>Question</th><th>Tools</th><th>Tokens</th><th>Status</th></tr></thead>
        <tbody>
          ${c.audit.length ? c.audit.map((a) => `
            <tr style="cursor:default">
              <td style="white-space:nowrap;font-size:12px">${timeAgo(a.ts)}</td>
              <td>${esc(a.username)}</td>
              <td><span class="tag-plain">${esc(a.kind)}</span></td>
              <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(a.question || "")}">${esc(a.question || "—")}</td>
              <td style="font-size:11.5px;color:var(--muted)">${(a.tools || []).join(", ") || "—"}</td>
              <td style="font-size:12px">${(a.promptTokens || 0) + (a.completionTokens || 0)}</td>
              <td>${a.status === "ok" ? `<span class="pill status-Completed">ok</span>` : `<span class="pill status-RevisionRequired">${esc(a.status)}</span>`}</td>
            </tr>`).join("") : `<tr><td colspan="7"><div class="empty-note">No AI activity yet.</div></td></tr>`}
        </tbody>
      </table>
    </div>
  </div>`;
}

/* ------------------------------ actions ------------------------------ */

const App = {
  nav(route) {
    if (route === "ask") {
      S.monki.open = true;
      renderApp();
      scrollMonki(true);
      return;
    }
    if (!canAccessRoute(route)) route = "dashboard";
    S.route = route;
    location.hash = "#/" + route;
    renderApp();
  },

  openSearch() {
    S.route = "search";
    location.hash = "#/search";
    renderApp();
    setTimeout(() => { const input = document.getElementById("workspace-search-input"); if (input) input.focus(); }, 20);
  },

  searchDraft(value) {
    S.search.q = value;
  },

  async runSearch(event) {
    if (event) event.preventDefault();
    const input = document.getElementById("workspace-search-input");
    if (input) S.search.q = input.value;
    const q = S.search.q.trim();
    if (!q) return App.clearSearch();
    S.search.loading = true;
    S.search.answerLoading = aiOn("ask");
    S.search.answer = null;
    S.search.error = "";
    renderPage("search");
    try {
      const normalPromise = api(`/api/search?q=${encodeURIComponent(q)}&limit=100`);
      const answerPromise = aiOn("ask") ? api("/api/search/answer", "POST", { query: q }).catch(() => ({ available: false })) : Promise.resolve({ available: false });
      const [normal, answer] = await Promise.all([normalPromise, answerPromise]);
      S.search.results = normal;
      S.search.answer = answer;
      const queryType = (S.search.results || {}).type;
      if (queryType && queryType !== "all") S.search.type = queryType;
    } catch (e) {
      S.search.error = e.message;
      S.search.results = null;
    } finally {
      S.search.loading = false;
      S.search.answerLoading = false;
      if (S.route === "search") renderPage("search");
    }
  },

  searchType(type) {
    S.search.type = ["all", "tasks", "files", "messages"].includes(type) ? type : "all";
    renderPage("search");
  },

  clearSearch() {
    S.search = { q: "", type: "all", results: null, loading: false, error: "", answer: null, answerLoading: false };
    renderPage("search");
    setTimeout(() => { const input = document.getElementById("workspace-search-input"); if (input) input.focus(); }, 20);
  },

  quickSearch(query) {
    S.search.q = query;
    App.runSearch();
  },

  async openSearchResult(kind, id) {
    const result = ((S.search.results || {}).results || []).find((item) => item.kind === kind && String(item.id) === String(id));
    if (!result) return;
    if (kind === "task") return App.openTask(result.id);
    if (kind === "file") {
      if (result.url) window.open(result.url, "_blank", "noopener");
      return;
    }
    if (kind === "message") {
      await App.openChannel(result.channelId);
      S.chat.highlightId = Number(result.id);
      renderApp();
      setTimeout(() => App.focusMessage(result.id), 80);
    }
  },

  async login(e) {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const { user } = await api("/api/login", "POST", {
        username: fd.get("username"),
        password: fd.get("password"),
      });
      S.me = user;
      await probeReporting();
      await probeReportingBasic();
      ensureAllowedRoute();
      await loadState();
      // fresh logins must load the same auxiliary state as a session restore —
      // without this, AI features/channels/directory stay hidden until a reload
      await Promise.all([loadChatChannels(), loadAiStatus(), loadDirectory()]);
      renderApp();
      pulse();
      toast(`Welcome, ${user.name}`);
    } catch (err) {
      document.getElementById("login-error").innerHTML = `<div class="login-error">${esc(err.message)}</div>`;
    }
  },

  async logout() {
    try { await api("/api/logout", "POST"); } catch { /* ignore */ }
    location.reload();
  },

  async setAvailability(availability) {
    try {
      const { profile } = await api("/api/me/profile", "PATCH", { availability });
      S.me.profile = profile;
      const mine = S.directory.find((user) => user.username === S.me.username);
      if (mine) mine.profile = profile;
      renderApp();
      toast(availability === "online" ? "You are online and available" : "You are marked away");
    } catch (error) { toast(error.message, "err"); }
  },

  selectProfilePicture(input) {
    const file = input.files && input.files[0];
    if (!file) return;
    if (file.size > 250 * 1024) {
      input.value = "";
      return toast("Profile picture must be smaller than 250 KB", "err");
    }
    if (!/^image\/(png|jpeg|webp|gif)$/i.test(file.type)) {
      input.value = "";
      return toast("Choose a PNG, JPG, WEBP or GIF picture", "err");
    }
    const reader = new FileReader();
    reader.onload = () => { S.profileAvatarDraft = String(reader.result || ""); renderPage("profile"); };
    reader.readAsDataURL(file);
  },

  removeProfilePicture() {
    S.profileAvatarDraft = "";
    renderPage("profile");
  },

  async saveProfile(event) {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(event.target).entries());
    if (S.profileAvatarDraft !== null) body.avatar = S.profileAvatarDraft;
    try {
      const { profile } = await api("/api/me/profile", "PATCH", body);
      S.me.profile = profile;
      S.profileAvatarDraft = null;
      const mine = S.directory.find((user) => user.username === S.me.username);
      if (mine) mine.profile = profile;
      renderApp();
      toast("Profile saved");
    } catch (error) { toast(error.message, "err"); }
  },

  filter(key, value) {
    S.taskFilterOrigin = "";
    if (key === "status" && value === "__open__") {
      S.filters.status = "";
      S.filters.scope = "open";
    } else {
      S.filters[key] = value;
      if (key === "status") S.filters.scope = "";
    }
    renderPage("tasks");
    if (key === "q") {
      const inp = document.querySelector('.filters input[type="search"]');
      if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
    }
  },

  taskRange(range) {
    const bounds = rangeBounds(range);
    S.filters.range = range;
    if (range !== "custom") {
      S.filters.dateFrom = bounds.from;
      S.filters.dateTo = bounds.to;
    }
    S.taskFilterOrigin = "";
    renderPage("tasks");
  },

  taskCustomDate(key, value) {
    S.filters[key] = value;
    S.filters.range = "custom";
    S.taskFilterOrigin = "";
    renderPage("tasks");
  },

  clearFilters() {
    S.filters = { q: "", status: "", department: "", priority: "", owner: "", scope: "", dateField: "due", dateFrom: "", dateTo: "", range: "all" };
    S.taskFilterOrigin = "";
    renderPage("tasks");
  },

  dashboardFilter(kind) {
    const filters = { q: "", status: "", department: "", priority: "", owner: "", scope: "", dateField: "due", dateFrom: "", dateTo: "", range: "all" };
    const labels = { open: "Open tasks", inProgress: "In progress", waitingClient: isClient() ? "Waiting on you" : "Waiting on NEONMONKI", review: "Ready for review", critical: "Critical open", completed: "Completed" };
    if (kind === "open") filters.scope = "open";
    if (kind === "inProgress") filters.status = "In Progress";
    if (kind === "waitingClient") filters.status = "Waiting on Client";
    if (kind === "review") filters.status = "Ready for Review";
    if (kind === "critical") { filters.scope = "open"; filters.priority = "Critical"; }
    if (kind === "completed") filters.status = "Completed";
    S.filters = filters;
    S.taskFilterOrigin = labels[kind] || "Dashboard selection";
    App.nav("tasks");
  },

  dashScroll(id) {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  },

  dashDept(departmentId) {
    S.filters = { q: "", status: "", department: departmentId, priority: "", owner: "", scope: "open", dateField: "due", dateFrom: "", dateTo: "", range: "all" };
    const department = deptById(departmentId);
    S.taskFilterOrigin = `${department ? department.name : "Department"} — open tasks`;
    App.nav("tasks");
  },

  showOverdue() {
    const bounds = rangeBounds("overdue");
    S.filters = { q: "", status: "", department: "", priority: "", owner: "", scope: "open", dateField: "due", dateFrom: bounds.from, dateTo: bounds.to, range: "overdue" };
    S.taskFilterOrigin = "Overdue open tasks";
    App.nav("tasks");
  },

  /* ------------------------------ reports library ------------------------------ */

  openAddReport() {
    if (!isTeam()) return; // the API enforces this too (client gets 403)
    S.reportEditId = null;
    S.reportDraft = { kind: "weekly", periodMonth: localISODate().slice(0, 7), title: "", description: "", links: [{ label: "", url: "" }] };
    S.modal = "reportForm";
    renderApp();
  },

  openEditReport(id) {
    if (!isAdmin()) return; // the API enforces this too
    const r = (S.reports.items || []).find((x) => String(x.id) === String(id));
    if (!r) return;
    S.reportEditId = r.id;
    S.reportDraft = {
      kind: ["weekly", "monthly", "special"].includes(r.kind) ? r.kind : "weekly",
      periodMonth: String(r.periodMonth || ""),
      title: String(r.title || ""),
      description: String(r.description || ""),
      links: (r.links && r.links.length ? r.links : [{ label: "", url: "" }]).map((l) => ({ label: String((l && l.label) || ""), url: String((l && l.url) || "") })),
    };
    S.modal = "reportForm";
    renderApp();
  },

  reportDraftSet(key, value) {
    if (S.reportDraft && ["kind", "periodMonth", "title", "description"].includes(key)) S.reportDraft[key] = value;
  },

  reportLinkSet(i, key, value) {
    const row = S.reportDraft && S.reportDraft.links[i];
    if (row && (key === "label" || key === "url")) row[key] = value;
  },

  reportLinkAdd() {
    const d = S.reportDraft;
    if (!d || d.links.length >= 6) return;
    d.links.push({ label: "", url: "" });
    renderModal();
  },

  reportLinkRemove(i) {
    const d = S.reportDraft;
    if (!d || d.links.length <= 1) return;
    d.links.splice(i, 1);
    renderModal();
  },

  async submitReport(e) {
    e.preventDefault();
    if (S.reportBusy) return;
    const fd = new FormData(e.target);
    const links = [];
    for (let i = 0; i < 6; i++) {
      const url = String(fd.get(`link_url_${i}`) || "").trim();
      if (!url) continue;
      links.push({ label: String(fd.get(`link_label_${i}`) || "").trim(), url });
    }
    const body = {
      title: String(fd.get("title") || "").trim(),
      description: String(fd.get("description") || "").trim(),
      kind: String(fd.get("kind") || ""),
      periodMonth: String(fd.get("periodMonth") || ""),
      links,
    };
    if (body.title.length < 2) return toast("Give the report a title (2+ characters)", "err");
    if (!/^\d{4}-\d{2}$/.test(body.periodMonth)) return toast("Pick the month this report covers", "err");
    if (!["weekly", "monthly", "special"].includes(body.kind)) return toast("Pick a report kind", "err");
    if (!links.length) return toast("Add at least one link to the report", "err");
    if (links.some((l) => !/^https?:\/\//i.test(l.url))) return toast("Links must start with http:// or https://", "err");
    const editingId = S.reportEditId;
    S.reportBusy = true;
    renderModal(); // disables the save button while the request is in flight
    try {
      if (editingId != null) await api(`/api/reports/${encodeURIComponent(editingId)}`, "PATCH", body);
      else await api("/api/reports", "POST", body);
      S.reportBusy = false;
      S.reportEditId = null;
      S.reportDraft = null;
      S.modal = null;
      toast(editingId != null ? "Report updated" : "Report added to the library");
      await loadReports(true);
      renderApp();
    } catch (err) {
      S.reportBusy = false;
      renderModal();
      toast(err.message, "err");
    }
  },

  async deleteReport(id) {
    if (!isAdmin()) return;
    if (!window.confirm("Remove this report from the library? The linked document itself is not touched.")) return;
    try {
      await api(`/api/reports/${encodeURIComponent(id)}`, "DELETE");
      toast("Report removed");
      await loadReports(true);
    } catch (err) { toast(err.message, "err"); }
  },

  reportsReload() {
    loadReports(true);
  },

  /* --- Generate Report (super reporting tier) --- */

  openGenerateReport() {
    const st = S.reporting.status;
    if (!st || st.tier !== "super") return toast("The report generator needs the Super reporting tier", "err");
    S.reportGen = { audience: "internal", preset: "last_30", customFrom: "", customTo: "", busy: false, error: "", result: null };
    S.modal = "generateReport";
    renderApp();
  },

  reportGenSet(key, value) {
    const g = S.reportGen;
    if (!g || g.busy) return;
    if (key === "audience") g.audience = value === "client" ? "client" : "internal";
    else if (key === "preset") {
      if (!REP_GEN_PRESETS.some(([v]) => v === value)) return;
      g.preset = value;
      if (value === "custom" && (!g.customFrom || !g.customTo)) {
        const b = repGenBounds("last_30");
        g.customFrom = b.from;
        g.customTo = b.to;
      }
    } else if (key === "customFrom" || key === "customTo") g[key] = value;
    renderModal();
  },

  async runGenerateReport() {
    const g = S.reportGen;
    if (!g || g.busy) return;
    const b = repGenBounds(g.preset, g.customFrom, g.customTo);
    if (!b.from || !b.to) return toast("Pick both dates for the report", "err");
    if (b.from > b.to) return toast("The 'from' date must be before the 'to' date", "err");
    const spanDays = Math.round((new Date(b.to + "T00:00:00") - new Date(b.from + "T00:00:00")) / 864e5) + 1;
    if (spanDays > 366) return toast("Reports cover at most 366 days — narrow the range", "err");
    g.busy = true;
    g.error = "";
    g.result = null;
    renderModal();
    try {
      const r = await api("/api/reporting/report", "POST", { from: b.from, to: b.to, audience: g.audience });
      g.result = { ...r, audience: g.audience, from: b.from, to: b.to };
      if (S.ai) S.ai.callsToday = (S.ai.callsToday || 0) + 1;
    } catch (err) {
      g.error = err.message;
    }
    g.busy = false;
    renderModal();
  },

  reportGenBack() {
    const g = S.reportGen;
    if (!g) return;
    g.result = null;
    g.error = "";
    renderModal();
  },

  downloadReportDocx() {
    const r = S.reportGen && S.reportGen.result;
    if (!r || !r.docxBase64) return;
    try {
      const bin = atob(r.docxBase64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = r.fileName || "neonmonki-report.docx";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      toast("Report downloaded");
    } catch { toast("Could not prepare the .docx download", "err"); }
  },

  async openReportAsGoogleDoc() {
    const r = S.reportGen && S.reportGen.result;
    if (!r || !r.html) return;
    try {
      if (!navigator.clipboard || typeof ClipboardItem === "undefined") throw new Error("clipboard unavailable");
      const item = new ClipboardItem({
        "text/html": new Blob([r.html], { type: "text/html" }),
        "text/plain": new Blob([`${r.title}\n\n${repPlainText(r.html)}`], { type: "text/plain" }),
      });
      await navigator.clipboard.write([item]);
      window.open("https://docs.new", "_blank", "noopener");
      toast("Report copied — paste it into the new Google Doc");
    } catch {
      // clipboard blocked (permissions / non-secure context) — still hand over the file
      App.downloadReportDocx();
      toast("Clipboard was blocked — the .docx downloaded instead", "warn");
    }
  },

  /* --- Performance (basic tier) --- */

  perfRange(value) {
    if (!PERF_RANGE_OPTIONS.some(([v]) => v === value)) return;
    const rb = S.reportingBasic;
    if (rb.range === value) return;
    rb.range = value;
    rb.loaded = false;
    loadPerformance();
  },

  perfRetry() {
    const rb = S.reportingBasic;
    rb.error = "";
    rb.loaded = false;
    loadPerformance(true);
  },

  /* --- Smart Reporting --- */

  srRange(value) {
    if (!SR_RANGE_OPTIONS.some(([v]) => v === value)) return;
    const r = S.reporting;
    r.range = value;
    if (value === "custom") {
      if (!r.customFrom || !r.customTo) {
        const b = srRangeBounds("custom", r.customFrom, r.customTo);
        r.customFrom = b.from;
        r.customTo = b.to;
      }
      renderPage("smartreporting");
      return;
    }
    r.loaded = false;
    loadSmartReporting();
  },

  srCustom(key, value) {
    S.reporting[key] = value;
  },

  srApplyCustom() {
    const r = S.reporting;
    if (!r.customFrom || !r.customTo) return toast("Pick both dates for the custom range", "err");
    if (r.customFrom > r.customTo) return toast("The 'from' date must be before the 'to' date", "err");
    r.loaded = false;
    loadSmartReporting();
  },

  srCmp(value) {
    if (!SR_CMP_OPTIONS.some(([v]) => v === value)) return;
    S.reporting.cmp = value;
    S.reporting.loaded = false;
    loadSmartReporting();
  },

  srGranularity(value) {
    S.reporting.granularity = ["auto", "hour", "day", "week", "month"].includes(value) ? value : "auto";
    S.reporting.loaded = false;
    loadSmartReporting();
  },

  srMetric(key) {
    if (!SR_TREND_METRICS.includes(key)) return;
    S.reporting.metric = key;
    S.reporting.loaded = false;
    loadSmartReporting();
  },

  srMixDim(dim) {
    if (!["source", "platform"].includes(dim)) return;
    S.reporting.mixDimension = dim;
    S.reporting.loaded = false;
    loadSmartReporting();
  },

  srFilter(key, value) {
    if (!SR_DRILL_ORDER.includes(key)) return;
    const r = S.reporting;
    value = String(value || "");
    if (r[key] === value) return;
    r[key] = value;
    // a campaign filter only makes sense under the channel/platform/source it came from
    if (key !== "campaign") r.campaign = "";
    r.loaded = false;
    loadSmartReporting();
  },

  srClearFilters() {
    const r = S.reporting;
    r.channel = r.platform = r.source = r.campaign = "";
    r.loaded = false;
    loadSmartReporting();
  },

  srTruncateFilters(key) {
    const r = S.reporting;
    const i = SR_DRILL_ORDER.indexOf(key);
    if (i === -1) return;
    for (const k of SR_DRILL_ORDER.slice(i + 1)) r[k] = "";
    r.loaded = false;
    loadSmartReporting();
  },

  srBack() {
    const r = S.reporting;
    const active = SR_DRILL_ORDER.filter((k) => r[k]);
    if (!active.length) return;
    r[active[active.length - 1]] = "";
    r.loaded = false;
    loadSmartReporting();
  },

  srSort(key) {
    const r = S.reporting;
    if (!["name", "spend", "revenue", "roas", "leads", "sales", "cpl", "deltaPct"].includes(key)) return;
    if (r.tableSort === key) r.tableDir = -r.tableDir;
    else { r.tableSort = key; r.tableDir = key === "name" ? 1 : -1; }
    renderPage("smartreporting");
  },

  srTableSearch(value) {
    S.reporting.tableQ = value;
    // surgical update — a full re-render would steal the search field's focus
    const body = document.getElementById("sr-table-body");
    if (body) body.innerHTML = srCampaignRowsHtml();
  },

  srRefresh() {
    S.reporting.loaded = false;
    loadSmartReporting(true);
  },

  retryReporting() {
    S.reporting.error = "";
    S.reporting.loaded = false;
    loadSmartReporting(true);
  },

  srChartMove(e) {
    const g = srChartGeom;
    if (!g || !g.n) return;
    const wrap = e.currentTarget;
    const svg = wrap.querySelector("svg");
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const scale = rect.width / g.w;
    if (!(scale > 0)) return;
    const px = (e.clientX - rect.left) / scale;
    const i = g.n === 1 ? 0 : Math.max(0, Math.min(g.n - 1, Math.round(((px - g.pl) / g.iw) * (g.n - 1))));
    const xSvg = g.n === 1 ? g.pl + g.iw / 2 : g.pl + (i / (g.n - 1)) * g.iw;
    const guide = document.getElementById("sr-chart-guide");
    const dot = document.getElementById("sr-chart-dot");
    const cmpDot = document.getElementById("sr-chart-cmpdot");
    const tip = document.getElementById("sr-chart-tooltip");
    if (!guide || !dot || !tip) return;
    guide.setAttribute("x1", xSvg.toFixed(1));
    guide.setAttribute("x2", xSvg.toFixed(1));
    guide.style.display = "";
    dot.setAttribute("cx", xSvg.toFixed(1));
    dot.setAttribute("cy", g.yCur[i].toFixed(1));
    dot.style.display = "";
    let cmpLine = "";
    if (g.cmpVals.length && g.yCmp[i] !== undefined) {
      if (cmpDot) {
        cmpDot.setAttribute("cx", xSvg.toFixed(1));
        cmpDot.setAttribute("cy", g.yCmp[i].toFixed(1));
        cmpDot.style.display = "";
      }
      const cv = g.cmpVals[i];
      const v = g.vals[i];
      const d = cv ? ((v - cv) / Math.abs(cv)) * 100 : null;
      cmpLine = `<div class="tt-cmp">vs ${srFmtNum(cv, g.kind)}${d === null || !isFinite(d) ? "" : ` · <span class="tt-delta ${d >= 0 ? "good" : "bad"}">${d >= 0 ? "▲" : "▼"} ${Math.abs(Math.round(d * 10) / 10)}%</span>`}</div>`;
    } else if (cmpDot) cmpDot.style.display = "none";
    tip.innerHTML = `<b>${esc(g.buckets[i])}</b><div>${esc(g.label)}: <b>${srFmtNum(g.vals[i], g.kind)}</b></div>${cmpLine}`;
    tip.style.display = "";
    const leftPx = xSvg * scale + svg.offsetLeft;
    tip.style.left = `${leftPx.toFixed(0)}px`;
    tip.style.top = `${Math.max(36, g.yCur[i] * scale - 14).toFixed(0)}px`;
    tip.style.transform = leftPx > rect.width * 0.78 ? "translate(-100%,-100%)" : leftPx < rect.width * 0.14 ? "translate(0,-100%)" : "translate(-50%,-100%)";
  },

  srChartLeave() {
    for (const id of ["sr-chart-guide", "sr-chart-dot", "sr-chart-cmpdot", "sr-chart-tooltip"]) {
      const el = document.getElementById(id);
      if (el) el.style.display = "none";
    }
  },

  srInvestigate(i) {
    const ins = srInsightsData()[i];
    if (!ins) return;
    App.askMonki(ins.question);
  },

  srInsightTask(i) {
    const ins = srInsightsData()[i];
    if (!ins) return;
    const r = S.reporting;
    const b = srRangeBounds(r.range, r.customFrom, r.customTo);
    const filters = [["channel", r.channel], ["platform", r.platform], ["source", r.source], ["campaign", r.campaign]]
      .filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join(", ");
    S.taskDraft = {
      title: ins.taskTitle,
      description: `${ins.text}\n\nSource: Smart Reporting — ${b.from} → ${b.to}${filters ? `, filtered by ${filters}` : ""}. Investigate the cause and recommend the next move.`,
      department: "",
      departmentIds: [],
      ownerUsernames: [],
      assignmentMode: "departments",
      project: "Marketing performance",
      visibility: "department",
      nextAction: "",
      priority: "Medium",
      dueDate: "",
    };
    App.openModal("newTask");
  },

  srDismissInsight(key) {
    S.reporting.dismissedInsights.push(decodeURIComponent(key));
    renderPage("smartreporting");
  },

  srAsk(e) {
    e.preventDefault();
    const input = e.target.querySelector('[name="q"]');
    const q = input ? input.value.trim() : "";
    if (!q) return;
    App.askMonki(q);
  },

  navAdminIntegrations() {
    App.nav("admin");
    setTimeout(() => {
      const el = document.getElementById("admin-integrations");
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 80);
  },

  /* --- Admin → Integrations (Hyros) --- */

  async hyrosConnect(e) {
    e.preventDefault();
    const g = S.integrations;
    if (g.busy) return;
    const input = e.target.querySelector('[name="apiKey"]');
    const apiKey = input ? input.value.trim() : "";
    if (!apiKey) return toast("Paste the Hyros API key first", "err");
    g.busy = true;
    g.notice = "";
    renderPage("admin");
    try {
      await api("/api/integrations/hyros/connect", "POST", { apiKey });
      g.notice = "Hyros connected — the first sync starts right away.";
      toast("Hyros connected");
    } catch (err) {
      g.notice = "";
      g.error = err.message;
      toast(err.message, "err");
    }
    g.busy = false;
    await Promise.all([loadIntegrations(), probeReporting(true)]);
    S.reporting.loaded = false;
    if (S.route === "admin") renderPage("admin");
  },

  async hyrosTest() {
    const g = S.integrations;
    if (g.busy) return;
    g.busy = true;
    g.notice = "";
    renderPage("admin");
    try {
      const r = await api("/api/integrations/hyros/test", "POST", {});
      g.notice = (r && r.message) || "Connection verified — Hyros is reachable.";
      g.error = "";
    } catch (err) {
      g.notice = "";
      g.error = err.message;
    }
    g.busy = false;
    await loadIntegrations();
    if (S.route === "admin") renderPage("admin");
  },

  async hyrosResync() {
    if (!window.confirm("Reset & re-import? This deletes every imported Hyros record and daily snapshot, then rebuilds the full history from scratch. Reporting can look empty for a few minutes while the re-import runs.")) return;
    const g = S.integrations;
    if (g.busy) return;
    g.busy = true;
    g.notice = "";
    renderPage("admin");
    try {
      const r = await api("/api/integrations/hyros/resync", "POST", {});
      const del = (r && r.deleted) || {};
      g.notice = `Reporting data cleared (${Number(del.facts || 0).toLocaleString()} records, ${Number(del.daily || 0).toLocaleString()} snapshots) — the re-import is running now.`;
      toast("Re-import started");
      g.error = "";
    } catch (err) {
      g.error = err.message;
      toast(err.message, "err");
    }
    g.busy = false;
    await Promise.all([loadIntegrations(), probeReporting(true)]);
    if (S.reporting.allowed && S.reporting.status && S.reporting.status.connected) {
      S.reporting.loaded = false;
      loadSmartReporting(true);
    }
    if (S.route === "admin") renderPage("admin");
  },

  async hyrosSync(fromReporting) {
    const g = S.integrations;
    if (g.busy) return;
    g.busy = true;
    if (!fromReporting) { g.notice = ""; renderPage("admin"); }
    try {
      const r = await api("/api/integrations/hyros/sync", "POST", {});
      if (r && r.rateLimited) {
        toast("The data provider is rate-limiting right now — the sync will retry automatically", "warn");
      } else {
        toast((r && r.message) || "Sync started");
      }
      g.error = "";
    } catch (err) {
      g.error = err.message;
      toast(err.message, "err");
    }
    g.busy = false;
    await Promise.all([loadIntegrations(), probeReporting(true)]);
    if (S.reporting.allowed && S.reporting.status && S.reporting.status.connected) {
      S.reporting.loaded = false;
      loadSmartReporting(true);
    }
    if (S.route === "admin") renderPage("admin");
  },

  async hyrosDisconnect() {
    if (!window.confirm("Disconnect Hyros? Synced reporting data is kept, but nothing new will arrive until you reconnect.")) return;
    const g = S.integrations;
    if (g.busy) return;
    g.busy = true;
    g.notice = "";
    renderPage("admin");
    try {
      await api("/api/integrations/hyros/disconnect", "POST", {});
      g.notice = "Hyros disconnected.";
      toast("Hyros disconnected");
    } catch (err) {
      g.error = err.message;
      toast(err.message, "err");
    }
    g.busy = false;
    await Promise.all([loadIntegrations(), probeReporting(true)]);
    if (S.route === "admin") renderPage("admin");
  },

  boardFilter(key, value) {
    S.boardFilters[key] = value;
    renderPage("board");
  },

  boardRange(range) {
    const bounds = rangeBounds(range);
    S.boardFilters.range = range;
    if (range !== "custom") {
      S.boardFilters.dateFrom = bounds.from;
      S.boardFilters.dateTo = bounds.to;
    }
    renderPage("board");
  },

  boardCustomDate(key, value) {
    S.boardFilters[key] = value;
    S.boardFilters.range = "custom";
    renderPage("board");
  },

  clearBoardFilters() {
    S.boardFilters = { department: "", priority: "", owner: "", dateField: "due", dateFrom: "", dateTo: "", range: "all" };
    renderPage("board");
  },

  boardDragStart(event, taskId) {
    if (!isTeam()) return event.preventDefault();
    S.boardDragging = true;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", taskId);
    event.currentTarget.classList.add("dragging");
  },

  boardDragOver(event) {
    if (!isTeam()) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    event.currentTarget.classList.add("drag-over");
  },

  boardDragLeave(event) {
    if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.classList.remove("drag-over");
  },

  boardDragEnd(event) {
    event.currentTarget.classList.remove("dragging");
    document.querySelectorAll(".board-col.drag-over").forEach((column) => column.classList.remove("drag-over"));
    setTimeout(() => { S.boardDragging = false; }, 80);
  },

  async boardDrop(event, status) {
    event.preventDefault();
    event.currentTarget.classList.remove("drag-over");
    const taskId = event.dataTransfer.getData("text/plain");
    if (!taskId) return;
    await App.boardMove(taskId, status);
  },

  async boardMove(taskId, status) {
    const task = S.data.tasks.find((item) => item.id === taskId);
    if (!task || task.status === status) return;
    try {
      await api(`/api/tasks/${encodeURIComponent(taskId)}`, "PATCH", { status });
      await loadState();
      toast(`Moved to ${status}`);
    } catch (error) { toast(error.message, "err"); }
  },

  boardCardClick(taskId) {
    if (!S.boardDragging) App.openTask(taskId);
  },

  calendarMove(months) {
    const cursor = new Date(`${S.calendar.cursor}T00:00:00`);
    cursor.setMonth(cursor.getMonth() + months, 1);
    S.calendar.cursor = localISODate(cursor);
    renderPage("calendar");
  },

  calendarToday() {
    const now = new Date(); now.setDate(1);
    S.calendar.cursor = localISODate(now);
    renderPage("calendar");
  },

  calendarScope(scope) {
    S.calendar.scope = ["mine", "all", "department"].includes(scope) ? scope : "mine";
    if (S.calendar.scope === "department" && !S.calendar.department) {
      const mine = S.directory.find((user) => user.username === S.me.username);
      S.calendar.department = ((mine && mine.departments) || S.me.departments || [])[0] || (departments()[0] || {}).id || "";
    }
    renderPage("calendar");
  },

  calendarDepartment(department) {
    S.calendar.scope = "department";
    S.calendar.department = department;
    renderPage("calendar");
  },

  calendarDay(date) {
    S.filters = { q: "", status: "", department: S.calendar.scope === "department" ? S.calendar.department : "", priority: "", owner: "", scope: "", dateField: "due", dateFrom: date, dateTo: date, range: "custom" };
    S.taskFilterOrigin = `Due ${fmtDate(date)}`;
    App.nav("tasks");
  },

  openTask(id) {
    const monkiViewport = captureMonkiViewport();
    S.openTaskId = id;
    history.replaceState(null, "", `#/${S.route}/${id}`);
    renderApp();
    restoreMonkiViewport(monkiViewport);
  },

  closeDrawer() {
    S.openTaskId = null;
    if (S.modal === "editTask") S.modal = null;
    history.replaceState(null, "", `#/${S.route}`);
    renderApp();
  },

  openModal(name) {
    S.modal = name;
    renderApp();
  },

  closeModal() {
    S.modal = null;
    renderApp();
  },

  async setStatus(id, status) {
    try {
      await api(`/api/tasks/${encodeURIComponent(id)}`, "PATCH", { status });
      await loadState();
      toast(`Status → ${status}`);
    } catch (e) { toast(e.message, "err"); }
  },

  toggleAssignment(select) {
    const form = select && select.form;
    const owners = form && form.querySelector(".assignment-owners");
    if (owners) owners.style.display = select.value === "users" ? "block" : "none";
  },

  /* show/hide the "due date expected" hint on the new-task form */
  dueHintRefresh(form) {
    if (!form) return;
    const prio = form.querySelector('[name="priority"]');
    const due = form.querySelector('[name="dueDate"]');
    const hint = form.querySelector(".due-hint");
    if (!prio || !due || !hint) return;
    const needs = ["Critical", "High"].includes(prio.value) && !due.value;
    hint.style.display = needs ? "flex" : "none";
    if (needs && form.dataset.dueAck === "1") hint.classList.add("ack");
    else hint.classList.remove("ack");
  },

  async submitAccept(e, id) {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    if (btn) btn.disabled = true;
    const ownerUsernames = selectedValues(e.target, "ownerUsernames");
    try {
      await api(`/api/tasks/${encodeURIComponent(id)}/accept`, "POST", { ownerUsernames });
      S.modal = null;
      await loadState();
      toast("Accepted — work is now in progress");
    } catch (err) {
      if (btn) btn.disabled = false;
      toast(err.message, "err");
    }
  },

  async confirmDone(id) {
    try {
      await api(`/api/tasks/${encodeURIComponent(id)}`, "PATCH", { status: "Completed" });
      await loadState();
      toast("Confirmed — task completed");
    } catch (e) { toast(e.message, "err"); }
  },

  async requestRevision(id) {
    try {
      await api(`/api/tasks/${encodeURIComponent(id)}`, "PATCH", { status: "Revision Required" });
      S.openTaskId = id;
      await loadState();
      toast("Sent back for revision — explain what to change below", "err");
      setTimeout(() => {
        const ta = document.getElementById("update-text");
        if (ta) ta.focus();
      }, 60);
    } catch (e) { toast(e.message, "err"); }
  },

  async postUpdate(id) {
    const text = document.getElementById("update-text").value.trim();
    const status = document.getElementById("update-status").value;
    if (!text && !status) return toast("Write an update or pick a status first", "err");
    try {
      await api(`/api/tasks/${encodeURIComponent(id)}/updates`, "POST", {
        text: text || undefined,
        status: status || undefined,
      });
      await loadState();
      toast("Update posted");
    } catch (e) { toast(e.message, "err"); }
  },

  async postComment(id) {
    const textarea = document.getElementById("task-comment-text");
    const text = String(textarea && textarea.value || "").trim();
    if (!text) return toast("Write a comment first", "err");
    const share = document.getElementById("comment-client-visible");
    try {
      const { comment } = await api(`/api/tasks/${encodeURIComponent(id)}/comments`, "POST", {
        text, clientVisible: !!(share && share.checked),
      });
      await loadState();
      toast("Comment posted");
      setTimeout(() => document.getElementById(`comment-${comment.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 80);
    } catch (e) { toast(e.message, "err"); }
  },

  commentKeydown(event, taskId) {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      App.postComment(taskId);
    }
  },

  async deleteComment(taskId, commentId) {
    if (!window.confirm("Delete this comment?")) return;
    try {
      await api(`/api/tasks/${encodeURIComponent(taskId)}/comments/${encodeURIComponent(commentId)}`, "DELETE");
      await loadState();
      toast("Comment deleted");
    } catch (e) { toast(e.message, "err"); }
  },

  addTaskLinkRow(button) {
    const container = button.closest(".create-builder-section").querySelector(".task-create-links");
    container.insertAdjacentHTML("beforeend", taskCreateLinkRow());
    container.lastElementChild.querySelector("input").focus();
  },

  addTaskSubtaskRow(button) {
    const form = button.closest("form");
    const selectedDepartments = selectedValues(form, "departmentIds");
    const container = button.closest(".create-builder-section").querySelector(".task-create-subtasks");
    container.insertAdjacentHTML("beforeend", taskCreateSubtaskRow(selectedDepartments.length ? selectedDepartments : ["project-management"]));
    container.lastElementChild.querySelector("input[data-field='title']").focus();
  },

  addDrawerLinkRow() {
    const task = S.data.tasks.find((item) => item.id === S.openTaskId);
    const container = document.querySelector(".drawer-link-rows");
    if (!task || !container) return;
    container.insertAdjacentHTML("beforeend", drawerLinkRow(task.subtasks || []));
    container.lastElementChild.querySelector("input").focus();
  },

  async submitNewTask(e) {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    if (btn) btn.disabled = true;
    const fd = new FormData(e.target);
    const body = Object.fromEntries(fd.entries());
    body.departmentIds = selectedValues(e.target, "departmentIds");
    body.ownerUsernames = selectedValues(e.target, "ownerUsernames");
    const taskLinks = [...e.target.querySelectorAll(".task-create-link")].map((row) => ({
      name: String(row.querySelector('[data-field="title"]').value || body.title || "Task link").trim(),
      url: String(row.querySelector('[data-field="url"]').value || "").trim(),
    })).filter((link) => link.url);
    const subtasks = [...e.target.querySelectorAll(".task-create-subtask")].map((row) => ({
      title: String(row.querySelector('[data-field="title"]').value || "").trim(),
      description: String(row.querySelector('[data-field="description"]').value || "").trim(),
      priority: row.querySelector('[data-field="priority"]').value,
      dueDate: row.querySelector('[data-field="dueDate"]').value,
      ownerUsernames: selectedValues(row, "subtaskOwners"),
      departmentIds: selectedValues(row, "subtaskDepartments"),
      clientVisible: isClient(),
    })).filter((subtask) => subtask.title);
    if (!body.departmentIds.length) {
      if (btn) btn.disabled = false;
      return toast("Choose at least one department", "err");
    }
    // soft requirement: Critical/High work should carry a timeline — first
    // submit warns and reveals the inline hint, a second submit proceeds
    if (["Critical", "High"].includes(body.priority) && !String(body.dueDate || "").trim() && e.target.dataset.dueAck !== "1") {
      e.target.dataset.dueAck = "1";
      if (btn) btn.disabled = false;
      App.dueHintRefresh(e.target);
      const dueInput = e.target.querySelector('[name="dueDate"]');
      if (dueInput) dueInput.focus();
      toast("Critical/High tasks should have a due date — add one, or press Create again to continue without it", "err");
      return;
    }
    const draft = S.taskDraft;
    try {
      const { task } = await api("/api/tasks", "POST", body);
      for (const subtask of subtasks) await api(`/api/tasks/${encodeURIComponent(task.id)}/subtasks`, "POST", subtask);
      for (const link of taskLinks) await api(`/api/tasks/${encodeURIComponent(task.id)}/files`, "POST", link);
      // task born in a chat channel → post the task card back into it
      if (draft && draft.fromChannel) {
        try {
          await api(`/api/chat/channels/${encodeURIComponent(draft.fromChannel)}/messages`, "POST", {
            text: `Task created from this discussion: ${task.title}`,
            taskId: task.id,
          });
          if (S.chat.openId === draft.fromChannel) {
            const r = await api(`/api/chat/channels/${encodeURIComponent(draft.fromChannel)}/messages`);
            S.chat.messages = r.messages;
          }
        } catch { /* task exists even if the chat echo fails */ }
      }
      S.taskDraft = null;
      S.modal = null;
      S.openTaskId = task.id;
      history.replaceState(null, "", `#/${S.route}/${task.id}`);
      await loadState();
      toast(isClient() ? "Task sent to the team" : `Task ${task.id} created`);
    } catch (err) {
      if (btn) btn.disabled = false;
      toast(err.message, "err");
    }
  },

  async submitEdit(e, id) {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    if (btn) btn.disabled = true;
    const fd = new FormData(e.target);
    const body = Object.fromEntries(fd.entries());
    body.departmentIds = selectedValues(e.target, "departmentIds");
    body.ownerUsernames = selectedValues(e.target, "ownerUsernames");
    const taskLink = {
      name: String(body.taskLinkTitle || "Task link").trim(),
      url: String(body.taskLinkUrl || "").trim(),
    };
    delete body.taskLinkTitle;
    delete body.taskLinkUrl;
    if (!body.departmentIds.length) {
      if (btn) btn.disabled = false;
      return toast("Choose at least one department", "err");
    }
    try {
      await api(`/api/tasks/${encodeURIComponent(id)}`, "PATCH", body);
      if (taskLink.url) await api(`/api/tasks/${encodeURIComponent(id)}/files`, "POST", taskLink);
      S.modal = null;
      await loadState();
      toast("Task updated");
    } catch (err) {
      if (btn) btn.disabled = false;
      toast(err.message, "err");
    }
  },

  async submitSubtask(e, taskId) {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    if (btn) btn.disabled = true;
    const fd = new FormData(e.target);
    const body = Object.fromEntries(fd.entries());
    body.ownerUsernames = selectedValues(e.target, "ownerUsernames");
    body.departmentIds = selectedValues(e.target, "departmentIds");
    body.clientVisible = fd.get("clientVisible") === "on";
    const subtaskLink = {
      name: String(body.subtaskLinkTitle || `${body.title || "Subtask"} link`).trim(),
      url: String(body.subtaskLinkUrl || "").trim(),
    };
    delete body.subtaskLinkTitle;
    delete body.subtaskLinkUrl;
    try {
      const { subtask } = await api(`/api/tasks/${encodeURIComponent(taskId)}/subtasks`, "POST", body);
      if (subtaskLink.url) await api(`/api/tasks/${encodeURIComponent(taskId)}/files`, "POST", { ...subtaskLink, subtaskId: subtask.id });
      S.modal = null;
      await loadState();
      toast("Subtask added");
    } catch (err) { if (btn) btn.disabled = false; toast(err.message, "err"); }
  },

  async updateSubtask(taskId, subtaskId, fields) {
    try {
      await api(`/api/tasks/${encodeURIComponent(taskId)}/subtasks/${encodeURIComponent(subtaskId)}`, "PATCH", fields);
      await loadState();
    } catch (e) { toast(e.message, "err"); }
  },

  async deleteSubtask(taskId, subtaskId) {
    if (!window.confirm("Delete this subtask? Attached files remain on the main task.")) return;
    try {
      await api(`/api/tasks/${encodeURIComponent(taskId)}/subtasks/${encodeURIComponent(subtaskId)}`, "DELETE");
      await loadState();
      toast("Subtask deleted");
    } catch (e) { toast(e.message, "err"); }
  },

  async shareDrawerLinks(taskId) {
    const links = [...document.querySelectorAll(".drawer-link-row")].map((row) => ({
      name: String(row.querySelector('[data-field="title"]').value || "").trim(),
      url: String(row.querySelector('[data-field="url"]').value || "").trim(),
      subtaskId: row.querySelector('[data-field="subtaskId"]').value,
    })).filter((link) => link.url);
    if (!links.length) return toast("Paste at least one sharing link", "err");
    if (links.some((link) => !link.name)) return toast("Add a clear title for every link", "err");
    try {
      for (const link of links) await api(`/api/tasks/${encodeURIComponent(taskId)}/files`, "POST", link);
      await loadState();
      toast(`${links.length} sharing link${links.length === 1 ? "" : "s"} added for review`);
    } catch (e) { toast(e.message, "err"); }
  },

  async fileAction(taskId, fileId, action, needsFeedback) {
    const feedback = needsFeedback ? window.prompt(action === "reject" ? "Why is this link rejected?" : "What should be changed?") : "";
    if (needsFeedback && feedback === null) return;
    try {
      await api(`/api/tasks/${encodeURIComponent(taskId)}/files/${encodeURIComponent(fileId)}`, "PATCH", { action, feedback: feedback || "" });
      await loadState();
      const messages = { approve: "Link approved", reject: "Link rejected", deliver: "Delivered to NEONMONKI", client_approve: "Delivery approved", client_changes: "Changes requested" };
      toast(messages[action] || "Link updated");
    } catch (e) { toast(e.message, "err"); }
  },

  async sendForApproval(taskId) {
    if (!window.confirm("Send every approved deliverable link to the client for one task-level approval?")) return;
    try {
      await api(`/api/tasks/${encodeURIComponent(taskId)}/review`, "POST", { action: "send" });
      await loadState();
      toast("Task sent for client approval");
    } catch (error) { toast(error.message, "err"); }
  },

  async reviewTask(taskId, action, needsFeedback) {
    const feedback = needsFeedback ? window.prompt("What should the team change?") : "";
    if (needsFeedback && feedback === null) return;
    try {
      await api(`/api/tasks/${encodeURIComponent(taskId)}/review`, "POST", { action, feedback: feedback || "" });
      await loadState();
      toast(action === "approve" ? "Task approved" : "Changes requested");
    } catch (error) { toast(error.message, "err"); }
  },

  async deleteTask(taskId, title) {
    if (!window.confirm(`Delete “${title}”? Its subtasks, comments and linked deliverables will be removed. This cannot be undone.`)) return;
    try {
      await api(`/api/tasks/${encodeURIComponent(taskId)}`, "DELETE");
      S.openTaskId = null;
      history.replaceState(null, "", `#/${S.route}`);
      await loadState();
      toast("Task deleted");
    } catch (error) { toast(error.message, "err"); }
  },

  async submitSimple(e, url, okMsg) {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    if (btn) btn.disabled = true;
    const fd = new FormData(e.target);
    const body = Object.fromEntries(fd.entries());
    try {
      await api(url, "POST", body);
      S.modal = null;
      await loadState();
      toast(okMsg);
    } catch (err) {
      if (btn) btn.disabled = false;
      toast(err.message, "err");
    }
  },

  /* ------------------------------ chat ------------------------------ */

  async openChannel(id) {
    S.chat.openId = id;
    S.chat.replyToId = null;
    S.chat.mentionOpen = false;
    S.chat.mentionQuery = "";
    S.chat.mentionStart = null;
    S.chat.messageMenuId = null;
    lastRenderedMsgId = null; // force scroll-to-bottom on open
    history.replaceState(null, "", `#/chat/${id}`);
    try {
      const r = await api(`/api/chat/channels/${encodeURIComponent(id)}/messages`);
      S.chat.messages = r.messages;
      S.chat.channelInfo = r.channel;
      await api(`/api/chat/channels/${encodeURIComponent(id)}/read`, "POST", {});
      await loadChatChannels();
      pulseSoon();
    } catch (e) { toast(e.message, "err"); }
    if (S.route !== "chat") S.route = "chat";
    renderApp();
  },

  async sendMessage(channelId) {
    const ta = document.getElementById("chat-input");
    const text = ta.value.trim();
    const linkUrl = (document.getElementById("cc-link-url") || {}).value || "";
    const linkTitle = (document.getElementById("cc-link-title") || {}).value || "";
    if (!text && !linkUrl.trim()) return;
    ta.value = "";
    const replyToId = S.chat.replyToId;
    S.chat.draft = "";
    S.chat.replyToId = null;
    S.chat.mentionOpen = false;
    S.chat.mentionQuery = "";
    S.chat.mentionStart = null;
    try {
      await api(`/api/chat/channels/${encodeURIComponent(channelId)}/messages`, "POST", {
        text, linkUrl: linkUrl.trim() || undefined, linkTitle: linkTitle.trim() || undefined, replyToId,
      });
      // @ai <question> → the AI answers in-channel (channel-scoped context only)
      const aiMatch = text.match(/^@ai\s+(.+)/i);
      if (aiMatch && aiOn("chat")) {
        renderApp();
        try {
          await api("/api/ai/ask", "POST", { question: aiMatch[1], channelId, lastVisit: S.visitBaseline || undefined });
        } catch (e) { toast(e.message, "err"); }
      }
      const r = await api(`/api/chat/channels/${encodeURIComponent(channelId)}/messages`);
      S.chat.messages = r.messages;
      await api(`/api/chat/channels/${encodeURIComponent(channelId)}/read`, "POST", {});
      await loadChatChannels();
      renderApp();
    } catch (e) {
      S.chat.draft = text;
      S.chat.replyToId = replyToId;
      renderApp();
      toast(e.message, "err");
    }
  },

  async deleteChatMessage(id) {
    if (!window.confirm("Delete this message?")) return;
    try {
      await api(`/api/chat/messages/${id}`, "DELETE");
      S.chat.messages = S.chat.messages.filter((m) => Number(m.id) !== Number(id));
      if (Number(S.chat.replyToId) === Number(id)) S.chat.replyToId = null;
      renderApp();
      toast("Message deleted");
    } catch (e) { toast(e.message, "err"); }
  },

  chatKey(e, channelId) {
    if (S.chat.mentionOpen) {
      const candidates = mentionCandidates((S.chat.channelInfo && S.chat.channelInfo.people) || []);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const direction = e.key === "ArrowDown" ? 1 : -1;
        S.chat.mentionIndex = candidates.length ? (S.chat.mentionIndex + direction + candidates.length) % candidates.length : 0;
        refreshMentionMenu();
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && candidates.length) {
        e.preventDefault();
        App.insertMention(candidates[S.chat.mentionIndex].username);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        S.chat.mentionOpen = false;
        refreshMentionMenu();
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      App.sendMessage(channelId);
    }
  },

  chatDraft(value, caret) {
    S.chat.draft = value;
    const at = Number.isFinite(Number(caret)) ? Number(caret) : value.length;
    const match = value.slice(0, at).match(/(^|\s)@([^\s@]*)$/);
    if (match) {
      S.chat.mentionQuery = match[2] || "";
      S.chat.mentionStart = at - S.chat.mentionQuery.length - 1;
      S.chat.mentionIndex = 0;
      S.chat.mentionOpen = true;
    } else {
      S.chat.mentionOpen = false;
      S.chat.mentionQuery = "";
      S.chat.mentionStart = null;
    }
    refreshMentionMenu();
  },

  replyToMessage(id) {
    const ta = document.getElementById("chat-input");
    if (ta) S.chat.draft = ta.value;
    S.chat.replyToId = Number(id);
    S.chat.mentionOpen = false;
    renderApp();
    setTimeout(() => { const input = document.getElementById("chat-input"); if (input) input.focus(); }, 20);
  },

  cancelChatReply() {
    S.chat.replyToId = null;
    renderApp();
  },

  toggleMentions() {
    const ta = document.getElementById("chat-input");
    if (!ta) return;
    const start = ta.selectionStart == null ? ta.value.length : ta.selectionStart;
    const end = ta.selectionEnd == null ? start : ta.selectionEnd;
    const spacer = start > 0 && !/\s/.test(ta.value[start - 1]) ? " " : "";
    ta.value = `${ta.value.slice(0, start)}${spacer}@${ta.value.slice(end)}`;
    const caret = start + spacer.length + 1;
    ta.selectionStart = ta.selectionEnd = caret;
    ta.focus();
    App.chatDraft(ta.value, caret);
  },

  insertMention(username) {
    const current = S.chat.draft || "";
    const addition = `@${username} `;
    let caret;
    if (S.chat.mentionStart != null) {
      const end = S.chat.mentionStart + 1 + String(S.chat.mentionQuery || "").length;
      S.chat.draft = `${current.slice(0, S.chat.mentionStart)}${addition}${current.slice(end)}`;
      caret = S.chat.mentionStart + addition.length;
    } else {
      S.chat.draft = `${current}${current && !/\s$/.test(current) ? " " : ""}${addition}`;
      caret = S.chat.draft.length;
    }
    S.chat.mentionOpen = false;
    S.chat.mentionQuery = "";
    S.chat.mentionStart = null;
    renderApp();
    setTimeout(() => { const input = document.getElementById("chat-input"); if (input) { input.focus(); input.selectionStart = input.selectionEnd = caret; } }, 20);
  },

  toggleReactionPicker(id) {
    const picker = document.getElementById(`reaction-picker-${id}`);
    if (!picker) return;
    const opening = !picker.classList.contains("open");
    document.querySelectorAll(".reaction-picker.open,.message-more.open").forEach((item) => item.classList.remove("open"));
    if (opening) picker.classList.add("open");
  },

  toggleMessageMenu(id) {
    const menu = document.getElementById(`message-more-${id}`);
    if (!menu) return;
    const opening = !menu.classList.contains("open");
    document.querySelectorAll(".reaction-picker.open,.message-more.open").forEach((item) => item.classList.remove("open"));
    if (opening) menu.classList.add("open");
  },

  async reactMessage(id, emoji) {
    try {
      const { message } = await api(`/api/chat/messages/${id}/reactions`, "POST", { emoji });
      S.chat.messages = S.chat.messages.map((item) => Number(item.id) === Number(id) ? message : item);
      renderApp();
    } catch (e) { toast(e.message, "err"); }
  },

  focusMessage(id) {
    const message = document.getElementById(`message-${id}`);
    if (!message) return;
    message.scrollIntoView({ behavior: "smooth", block: "center" });
    message.classList.add("message-highlight");
    setTimeout(() => message.classList.remove("message-highlight"), 1800);
  },

  toggleAttach() {
    const el = document.getElementById("cc-attach");
    if (el) el.style.display = el.style.display === "none" ? "flex" : "none";
  },

  async toggleMute(channelId) {
    const c = S.chat.channels.find((x) => x.id === channelId);
    try {
      await api(`/api/chat/channels/${encodeURIComponent(channelId)}/mute`, "POST", { muted: !(c && c.muted) });
      await loadChatChannels();
      pulseSoon();
      renderApp();
      toast(c && c.muted ? "Channel unmuted" : "Channel muted — no badges or tones from it");
    } catch (e) { toast(e.message, "err"); }
  },

  chatNewTask(channelId) {
    const c = S.chat.channels.find((x) => x.id === channelId);
    S.taskDraft = {
      department: (c && c.department) || "",
      description: c ? `From #${c.name} discussion.` : "",
      fromChannel: channelId,
    };
    App.openModal("newTask");
  },

  taskFromMessage(msgId) {
    const m = S.chat.messages.find((x) => x.id === msgId);
    if (!m) return;
    const c = S.chat.channels.find((x) => x.id === S.chat.openId);
    S.taskDraft = {
      title: m.text.slice(0, 120),
      description: `From #${c ? c.name : "chat"} — ${m.author} wrote:\n\n"${m.text}"`,
      department: (c && c.department) || "",
      fromChannel: S.chat.openId,
    };
    App.openModal("newTask");
  },

  pickFolder(id) {
    S.fileFolder = id;
    renderPage("files");
  },

  /* ------------------------------ notifications ------------------------------ */

  async toggleNotifs(e) {
    e.stopPropagation();
    S.notifs.open = !S.notifs.open;
    if (S.notifs.open) {
      try {
        const { items } = await api("/api/notifications");
        S.notifs.items = items;
      } catch { /* ignore */ }
    }
    renderApp();
  },

  async markNotifsRead() {
    try {
      await api("/api/notifications/read", "POST", {});
      S.notifs.items = S.notifs.items.map((n) => ({ ...n, read: true }));
      S.pulse.notifications = 0;
      renderApp();
    } catch (e) { toast(e.message, "err"); }
  },

  async gotoNotif(id) {
    const n = S.notifs.items.find((x) => x.id === id);
    S.notifs.open = false;
    if (n && n.taskId) {
      S.openTaskId = n.taskId;
      history.replaceState(null, "", `#/${S.route}/${n.taskId}`);
      renderApp();
      if (n.commentId) setTimeout(() => {
        const comment = document.getElementById(`comment-${n.commentId}`);
        if (comment) {
          comment.classList.add("comment-highlight");
          comment.scrollIntoView({ behavior: "smooth", block: "center" });
          setTimeout(() => comment.classList.remove("comment-highlight"), 2400);
        }
      }, 80);
    } else if (n && n.channelId) {
      S.route = "chat";
      S.chat.highlightId = n.messageId || null;
      location.hash = "#/chat/" + n.channelId;
      await App.openChannel(n.channelId);
      if (n.messageId) setTimeout(() => {
        const message = document.getElementById(`message-${n.messageId}`);
        if (message) {
          message.scrollIntoView({ behavior: "smooth", block: "center" });
          message.classList.add("message-highlight");
          setTimeout(() => {
            message.classList.remove("message-highlight");
            S.chat.highlightId = null;
          }, 2400);
        }
      }, 80);
    } else {
      renderApp();
    }
  },

  /* ------------------------------ admin ------------------------------ */

  async resetPassword(username) {
    const next = window.prompt(`New password for ${username} (min 6 chars):`);
    if (!next) return;
    try {
      await api(`/api/admin/users/${encodeURIComponent(username)}`, "PATCH", { password: next });
      toast(`Password reset for ${username}`);
    } catch (e) { toast(e.message, "err"); }
  },

  async toggleUserActive(username, currentlyActive) {
    try {
      await api(`/api/admin/users/${encodeURIComponent(username)}`, "PATCH", { active: !currentlyActive });
      await loadAdmin();
      renderApp();
      toast(currentlyActive ? `${username} disabled` : `${username} enabled`);
    } catch (e) { toast(e.message, "err"); }
  },

  userRoleChanged(select) {
    const row = select && select.form && select.form.querySelector(".user-department-row");
    if (row) row.style.display = select.value === "client" ? "none" : "block";
  },

  async submitAddUser(e) {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    if (btn) btn.disabled = true;
    const body = Object.fromEntries(new FormData(e.target).entries());
    body.departments = body.role === "client" ? [] : selectedValues(e.target, "departments");
    try {
      await api("/api/admin/users", "POST", body);
      S.modal = null;
      await loadAdmin();
      renderApp();
      toast(`User ${body.username} created`);
    } catch (err) {
      if (btn) btn.disabled = false;
      toast(err.message, "err");
    }
  },

  async submitEditUser(e, username) {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    if (btn) btn.disabled = true;
    const body = Object.fromEntries(new FormData(e.target).entries());
    body.departments = body.role === "client" ? [] : selectedValues(e.target, "departments");
    try {
      await api(`/api/admin/users/${encodeURIComponent(username)}`, "PATCH", body);
      S.modal = null;
      await Promise.all([loadAdmin(), loadDirectory()]);
      renderApp();
      toast("User access updated");
    } catch (err) { if (btn) btn.disabled = false; toast(err.message, "err"); }
  },

  async deleteUser(username, name) {
    if (!window.confirm(`Delete ${name} (@${username})? Their login and channel membership will be removed. Historical messages stay attributed to their name.`)) return;
    try {
      await api(`/api/admin/users/${encodeURIComponent(username)}`, "DELETE");
      S.modal = null;
      await Promise.all([loadAdmin(), loadDirectory(), loadChatChannels()]);
      renderApp();
      toast(`${name} deleted`);
    } catch (error) { toast(error.message, "err"); }
  },

  async submitDepartment(e, id) {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target).entries());
    body.order = Number(body.order) || 0;
    try {
      await api(id ? `/api/admin/departments/${encodeURIComponent(id)}` : "/api/admin/departments", id ? "PATCH" : "POST", body);
      S.modal = null;
      await Promise.all([loadState(), loadAdmin()]);
      renderApp();
      toast(id ? "Department updated" : "Department created");
    } catch (err) { toast(err.message, "err"); }
  },

  async archiveDepartment(id, name) {
    if (!window.confirm(`Archive ${name}? Existing tasks keep their department label.`)) return;
    try {
      await api(`/api/admin/departments/${encodeURIComponent(id)}`, "DELETE");
      await Promise.all([loadState(), loadAdmin()]);
      renderApp();
      toast(`${name} archived`);
    } catch (e) { toast(e.message, "err"); }
  },

  async reactivateDepartment(id) {
    try {
      await api(`/api/admin/departments/${encodeURIComponent(id)}`, "PATCH", { active: true });
      await Promise.all([loadState(), loadAdmin()]);
      renderApp();
      toast("Department reactivated");
    } catch (e) { toast(e.message, "err"); }
  },

  async submitNewChannel(e) {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    if (btn) btn.disabled = true;
    const body = Object.fromEntries(new FormData(e.target).entries());
    body.clientAllowed = body.clientAllowed === "on";
    body.members = [...e.target.querySelectorAll('input[name="member"]:checked')].map((x) => x.value);
    delete body.clientAllowed;
    try {
      await api("/api/admin/channels", "POST", { ...body, clientAllowed: e.target.querySelector('[name="clientAllowed"]').checked });
      S.modal = null;
      await Promise.all([loadAdmin(), loadChatChannels()]);
      renderApp();
      toast(`#${body.name} created`);
    } catch (err) {
      if (btn) btn.disabled = false;
      toast(err.message, "err");
    }
  },

  async deleteChannel(id, name) {
    if (!window.confirm(`Delete #${name}? All its messages are removed. This can't be undone.`)) return;
    try {
      await api(`/api/admin/channels/${encodeURIComponent(id)}`, "DELETE");
      if (S.chat.openId === id) { S.chat.openId = null; S.chat.messages = []; }
      await Promise.all([loadAdmin(), loadChatChannels()]);
      renderApp();
      toast(`#${name} deleted`);
    } catch (e) { toast(e.message, "err"); }
  },

  openChannelMembers(id) {
    S.modal = "channelMembers:" + id;
    renderApp();
  },

  async addChannelMember(channelId, username, isClientAccount) {
    let confirmClientAccess = false;
    if (isClientAccount) {
      const channel = S.admin.channels.find((item) => item.id === channelId);
      if (channel && !channel.clientAllowed) {
        confirmClientAccess = window.confirm(`Add this client to #${channel.name}? They will be able to read the full channel history and future messages.`);
        if (!confirmClientAccess) return;
      }
    }
    try {
      await api(`/api/admin/channels/${encodeURIComponent(channelId)}/members`, "POST", { username, confirmClientAccess });
      await loadAdmin();
      renderApp();
    } catch (e) { toast(e.message, "err"); }
  },

  async removeChannelMember(channelId, username) {
    try {
      await api(`/api/admin/channels/${encodeURIComponent(channelId)}/members/${encodeURIComponent(username)}`, "DELETE");
      await loadAdmin();
      renderApp();
    } catch (e) { toast(e.message, "err"); }
  },

  async submitPassword(e) {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    if (btn) btn.disabled = true;
    const fd = new FormData(e.target);
    if (fd.get("next") !== fd.get("confirm")) {
      if (btn) btn.disabled = false;
      return toast("New passwords don't match", "err");
    }
    try {
      await api("/api/me/password", "POST", { current: fd.get("current"), next: fd.get("next") });
      S.modal = null;
      renderApp();
      toast("Password changed");
    } catch (err) {
      if (btn) btn.disabled = false;
      toast(err.message, "err");
    }
  },

  /* ------------------------------ AI ------------------------------ */

  toggleMonki() {
    S.monki.open = !S.monki.open;
    S.notifs.open = false;
    renderApp();
    if (S.monki.open) scrollMonki(true);
  },

  closeMonki() {
    S.monki.open = false;
    renderApp();
  },

  monkiDraft(value) {
    S.monki.draft = value;
  },

  monkiKey(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      App.askMonki();
    }
  },

  async askMonki(prefill) {
    if (S.aiBusy) return;
    const ta = document.getElementById("monki-input");
    const question = String(prefill || (ta ? ta.value : S.monki.draft || "")).trim();
    if (!question) return toast("Type a question first", "err");
    S.monki.open = true;
    S.monki.draft = "";
    S.monki.messages.push({ role: "user", text: question, ts: new Date().toISOString() });
    S.aiBusy = true;
    renderApp();
    scrollMonki(false);
    try {
      const reportingContext = srAskContext();
      const r = await api("/api/ai/ask", "POST", {
        question,
        deep: S.monki.deep === true,
        lastVisit: S.visitBaseline || undefined,
        ...(reportingContext ? { reportingContext } : {}),
      });
      S.aiAnswer = { ...r, question, ts: new Date().toISOString() };
      S.monki.messages.push({ role: "assistant", answer: S.aiAnswer });
      if (S.ai) S.ai.callsToday = (S.ai.callsToday || 0) + 1;
    } catch (e) {
      S.aiAnswer = { question, answer: `I couldn’t complete that request: ${e.message}`, citations: [], error: true, ts: new Date().toISOString() };
      S.monki.messages.push({ role: "assistant", answer: S.aiAnswer });
    }
    S.aiBusy = false;
    renderApp();
    scrollMonki(true);
  },

  runMonkiSuggestion(messageIndex, suggestionIndex) {
    const message = S.monki.messages[messageIndex];
    const suggestion = message && message.answer && (message.answer.suggestions || [])[suggestionIndex];
    if (!suggestion) return;
    if (suggestion.kind === "open_task" && suggestion.taskId) return App.openTask(suggestion.taskId);
    if (suggestion.kind === "open_url" && /^https:\/\//i.test(suggestion.url || "")) {
      window.open(suggestion.url, "_blank", "noopener");
      return;
    }
    if (suggestion.kind === "prompt" && suggestion.prompt) App.askMonki(suggestion.prompt);
  },

  toggleDeep() {
    S.monki.deep = !S.monki.deep;
    renderApp();
    const ta = document.getElementById("monki-input");
    if (ta) ta.focus();
  },

  async monkiReport(period) {
    if (S.aiBusy || !["week", "month"].includes(period)) return;
    S.monki.open = true;
    S.monki.messages.push({ role: "user", text: `Generate ${period === "month" ? "this month's" : "this week's"} performance report`, ts: new Date().toISOString() });
    S.aiBusy = true;
    renderApp();
    scrollMonki(false);
    try {
      const r = await api("/api/ai/report", "POST", { period });
      S.monki.messages.push({
        role: "assistant",
        answer: { answer: r.text || "", citations: r.citations || [], report: true, period, ts: new Date().toISOString() },
      });
      if (S.ai) S.ai.callsToday = (S.ai.callsToday || 0) + 1;
    } catch (e) {
      S.monki.messages.push({
        role: "assistant",
        answer: { answer: `I couldn't write that report: ${e.message}`, citations: [], error: true, ts: new Date().toISOString() },
      });
    }
    S.aiBusy = false;
    renderApp();
    scrollMonki(true);
  },

  async copyMonkiMessage(index) {
    const message = S.monki.messages[index];
    const text = message && message.answer && message.answer.answer;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      toast("Report copied to clipboard");
    } catch { toast("Could not copy the report", "err"); }
  },

  createDraftTask(i) {
    const d = S.aiAnswer && S.aiAnswer.drafts && S.aiAnswer.drafts[i];
    if (!d) return;
    S.taskDraft = {
      title: d.title,
      description: d.description,
      department: d.department,
      departmentIds: d.departmentIds || [],
      ownerUsernames: d.ownerUsernames || [],
      assignmentMode: (d.ownerUsernames || []).length ? "users" : "departments",
      project: d.project || "",
      visibility: d.visibility || "department",
      nextAction: d.nextAction || "",
      priority: d.priority || "Medium",
      dueDate: d.dueDate || "",
    };
    App.openModal("newTask");
  },

  async useReplyDraft(i) {
    const d = S.aiAnswer && S.aiAnswer.replyDrafts && S.aiAnswer.replyDrafts[i];
    if (!d || !d.channelId) return;
    S.monki.open = false;
    S.route = "chat";
    location.hash = "#/chat/" + d.channelId;
    await App.openChannel(d.channelId);
    S.chat.draft = d.text || "";
    S.chat.replyToId = d.replyToId || null;
    renderApp();
    setTimeout(() => { const input = document.getElementById("chat-input"); if (input) input.focus(); }, 30);
  },

  async copyReplyDraft(i) {
    const d = S.aiAnswer && S.aiAnswer.replyDrafts && S.aiAnswer.replyDrafts[i];
    if (!d) return;
    try {
      await navigator.clipboard.writeText(d.text || "");
      toast("Reply copied");
    } catch { toast("Could not copy the reply", "err"); }
  },

  async applyAction(i, payload) {
    const a = S.aiAnswer;
    const p = a && a.proposals && a.proposals[i];
    if (!p) return;
    try {
      await api("/api/ai/actions/execute", "POST", {
        proposalId: p.id,
        ...(payload ? { payload } : {}),
      });
      a.proposalState = { ...(a.proposalState || {}), [i]: payload ? "modified" : "applied" };
      S.modal = null;
      await loadState();
      toast(payload ? "Modified proposal approved and applied" : "Proposal approved and applied");
    } catch (e) {
      a.proposalState = { ...(a.proposalState || {}), [i]: { error: e.message } };
      S.modal = null;
      renderApp();
      scrollMonki(false);
    }
  },

  async submitModifiedAction(e, i) {
    e.preventDefault();
    const a = S.aiAnswer;
    const p = a && a.proposals && a.proposals[i];
    if (!p) return;
    const fd = new FormData(e.target);
    if (p.type === "task_update") {
      const t = S.data.tasks.find((task) => task.id === p.taskId);
      if (!t) return toast("Task is no longer available", "err");
      const fields = {};
      for (const key of ["title", "owner", "priority", "dueDate", "status", "description", "nextAction"]) {
        const value = String(fd.get(key) || "").trim();
        if (value !== String(t[key] || "")) fields[key] = value;
      }
      const update = String(fd.get("update") || "").trim();
      if (update) fields.update = update;
      return App.applyAction(i, {
        ...p,
        fields,
        reason: String(fd.get("reason") || "").trim(),
      });
    }
    return App.applyAction(i, {
      ...p,
      topic: String(fd.get("topic") || "").trim(),
      rule: String(fd.get("rule") || "").trim(),
      workstream: String(fd.get("workstream") || "").trim(),
      owner: String(fd.get("owner") || "").trim(),
    });
  },

  async rejectAction(i) {
    const a = S.aiAnswer;
    const p = a && a.proposals && a.proposals[i];
    if (!p) return;
    try {
      await api("/api/ai/actions/decline", "POST", { proposalId: p.id });
    } catch (e) {
      a.proposalState = { ...(a.proposalState || {}), [i]: { error: e.message } };
      renderApp();
      scrollMonki(false);
      return;
    }
    a.proposalState = { ...(a.proposalState || {}), [i]: "rejected" };
    renderApp();
    scrollMonki(false);
  },

  gotoChannel(channelId) {
    if (!channelId) return;
    S.route = "chat";
    location.hash = "#/chat/" + channelId;
    App.openChannel(channelId);
  },

  async summarizeTask(id) {
    if (!aiOn("summaries")) return toast("AI summaries are not enabled", "err");
    S.modal = "aiSummary";
    S.aiSummaryData = { loading: true, title: id };
    renderApp();
    try {
      const r = await api(`/api/ai/summarize/task/${encodeURIComponent(id)}`, "POST", {});
      S.aiSummaryData = { loading: false, title: id, ...r };
    } catch (e) {
      S.aiSummaryData = { loading: false, title: id, error: e.message };
    }
    renderApp();
  },

  async summarizeChannel(cid) {
    if (!aiOn("summaries")) return toast("AI summaries are not enabled", "err");
    S.modal = "aiSummary";
    S.aiSummaryData = { loading: true, title: "#" + cid };
    renderApp();
    try {
      const r = await api(`/api/ai/summarize/channel/${encodeURIComponent(cid)}`, "POST", {});
      S.aiSummaryData = { loading: false, title: "#" + cid, ...r };
    } catch (e) {
      S.aiSummaryData = { loading: false, title: "#" + cid, error: e.message };
    }
    renderApp();
  },

  async aiBrief() {
    if (!aiOn("brief")) return toast("Daily brief is not enabled", "err");
    S.aiBrief = { loading: true };
    renderPage("dashboard");
    try {
      const r = await api("/api/ai/brief", "POST", {});
      S.aiBrief = { loading: false, ...r, ts: new Date().toISOString() };
      if (S.ai) S.ai.callsToday = (S.ai.callsToday || 0) + 1;
    } catch (e) {
      S.aiBrief = { loading: false, error: e.message };
    }
    renderPage("dashboard");
  },

  async aiTest() {
    S.aiTestResult = null;
    renderPage("aicontrol");
    try {
      S.aiTestResult = await api("/api/ai/admin/test", "POST", {});
      if (S.aiTestResult.ok && S.aiTestResult.configurationUpdated) {
        await Promise.all([loadAiControl(), loadAiStatus()]);
      }
    } catch (e) {
      S.aiTestResult = { ok: false, error: e.message };
    }
    renderPage("aicontrol");
  },

  async aiSaveSettings(e) {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = {
      enabled: fd.get("enabled") === "on",
      allowClient: fd.get("allowClient") === "on",
      features: {
        ask: fd.get("f_ask") === "on",
        chat: fd.get("f_chat") === "on",
        brief: fd.get("f_brief") === "on",
        summaries: fd.get("f_summaries") === "on",
      },
      dailyLimit: Number(fd.get("dailyLimit")) || 60,
      models: {
        basic: String(fd.get("modelBasic") || "").trim(),
        advanced: String(fd.get("modelAdvanced") || "").trim(),
      },
    };
    try {
      await api("/api/ai/admin", "PATCH", body);
      await Promise.all([loadAiControl(), loadAiStatus()]);
      renderApp();
      toast("AI settings saved");
    } catch (err) { toast(err.message, "err"); }
  },

  async aiSaveProvider(e) {
    e.preventDefault();
    const fd = new FormData(e.target);
    const key = String(fd.get("apiKey") || "").trim();
    const body = {
      connectionType: String(fd.get("connectionType") || "").trim(),
    };
    if (key) body.apiKey = key;
    try {
      await api("/api/ai/admin", "PATCH", body);
      e.target.reset();
      await Promise.all([loadAiControl(), loadAiStatus()]);
      renderApp();
      toast(key ? "Private connection and key saved" : "Private connection saved");
    } catch (err) { toast(err.message, "err"); }
  },

  async aiClearProviderKey() {
    if (!window.confirm("Remove the private access key saved in AI Control? A server environment key, if present, will become the fallback.")) return;
    try {
      await api("/api/ai/admin", "PATCH", { clearApiKey: true });
      await Promise.all([loadAiControl(), loadAiStatus()]);
      renderApp();
      toast("Saved private access key removed");
    } catch (err) { toast(err.message, "err"); }
  },

  async aiSaveUser(e, username) {
    e.preventDefault();
    const fd = new FormData(e.target);
    const control = S.aiControl;
    const user = control && control.userAccess && control.userAccess.find((u) => u.username === username);
    if (!control || !user) return;
    const rawLimit = String(fd.get("dailyLimit") || "").trim();
    const body = {
      enabled: fd.get("enabled") === "on",
      tools: aiToolsForProfile(control, fd.get("profile"), user.tools),
      dailyLimit: rawLimit ? Number(rawLimit) : null,
      reporting: String(fd.get("reporting") || ""), // "" = inherit the role default
    };
    try {
      await api(`/api/ai/admin/users/${encodeURIComponent(username)}`, "PATCH", body);
      await loadAiControl();
      renderPage("aicontrol");
      toast(`AI access saved for ${user.name}`);
    } catch (err) { toast(err.message, "err"); }
  },
};
window.App = App;

/* ------------------------------ AI status ------------------------------ */

async function loadAiStatus() {
  try {
    S.ai = await api("/api/ai/status");
  } catch {
    S.ai = null;
  }
}

async function loadDirectory() {
  try {
    const { users } = await api("/api/users/basic");
    S.directory = users;
  } catch { /* ignore */ }
}

/* ------------------------------ live pulse (chat + notifications) ------------------------------ */

let pulseTick = 0;
let lastRenderedMsgId = null;

async function pulse() {
  if (!S.me) return;
  pulseTick++;
  if (document.hidden && pulseTick % 6 !== 0) return; // 30s cadence while hidden
  try {
    const p = await api("/api/chat/pulse");
    const prev = S.pulse;

    // refresh the open channel live
    if (S.route === "chat" && S.chat.openId && (p.unread[S.chat.openId] || 0) > 0) {
      const r = await api(`/api/chat/channels/${encodeURIComponent(S.chat.openId)}/messages`);
      S.chat.messages = r.messages;
      await api(`/api/chat/channels/${encodeURIComponent(S.chat.openId)}/read`, "POST", {});
      p.unread[S.chat.openId] = 0;
      const mutedOpen = (S.chat.channels.find((c) => c.id === S.chat.openId) || {}).muted;
      p.chatTotal = Object.entries(p.unread).reduce((sum, [cid, n]) => {
        const ch = S.chat.channels.find((c) => c.id === cid);
        return sum + (ch && ch.muted ? 0 : n);
      }, 0);
      await loadChatChannels();
      S.pulse = p;
      guardedRender();
      return;
    }

    // One event-appropriate tone per pulse. Mentions, assignments, approvals,
    // new tasks and ordinary messages are deliberately recognizable by ear.
    let changed = p.chatTotal !== prev.chatTotal || p.notifications !== prev.notifications;
    let messageIncreased = false;
    for (const [cid, n] of Object.entries(p.unread)) {
      if (n > (prev.unread[cid] || 0)) {
        const watching = S.route === "chat" && S.chat.openId === cid && !document.hidden;
        const ch = S.chat.channels.find((c) => c.id === cid);
        if (!watching && !(ch && ch.muted)) messageIncreased = true;
        changed = true;
      }
    }
    const previousSignalIds = new Set((prev.notificationSignals || []).map((signal) => String(signal.id)));
    const newestSignal = (p.notificationSignals || []).find((signal) => !previousSignalIds.has(String(signal.id)));
    if (newestSignal) playTone(toneForNotification(newestSignal.kind));
    else if (messageIncreased) playTone("message");
    S.pulse = p;
    if (changed) guardedRender();
  } catch { /* hiccup — next tick retries */ }
}

function pulseSoon() {
  setTimeout(pulse, 300);
}

/* ------------------------------ boot ------------------------------ */

(async function boot() {
  // routes: #/<page>  |  #/<page>/<taskId> (task drawer)  |  #/chat/<channelId>
  const parseHash = () => {
    const parts = location.hash.replace(/^#\//, "").split("/").filter(Boolean);
    return { route: parts[0], param: parts[1] ? decodeURIComponent(parts[1]) : null };
  };
  window.addEventListener("hashchange", () => {
    if (!S.me || !S.data) return;
    const { route, param } = parseHash();
    if (route === "ask") {
      S.route = "dashboard";
      S.monki.open = true;
      history.replaceState(null, "", "#/dashboard");
      renderApp();
      scrollMonki(true);
      return;
    }
    if (route === "chat" && param && param !== S.chat.openId) {
      S.route = "chat";
      App.openChannel(param);
      return;
    }
    if (route && !canAccessRoute(route)) {
      ensureAllowedRoute();
      renderApp();
      return;
    }
    let changed = false;
    if (route && PAGE_META[route] && route !== S.route) { S.route = route; changed = true; }
    if (route !== "chat" && param !== S.openTaskId) { S.openTaskId = param; changed = true; }
    if (changed) renderApp();
  });
  window.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if (S.me) App.openSearch();
      return;
    }
    if (e.key !== "Escape") return;
    if (S.modal) App.closeModal();
    else if (S.openTaskId) App.closeDrawer();
    else if (S.monki.open) App.closeMonki();
  });
  // close the notifications panel and minimize Monki on outside click
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".msg-toolbar,.reaction-picker,.message-more")) {
      document.querySelectorAll(".reaction-picker.open,.message-more.open").forEach((item) => item.classList.remove("open"));
    }
    let needsRender = false;
    if (S.notifs.open && !e.target.closest(".bell-wrap")) {
      S.notifs.open = false;
      needsRender = true;
    }
    // minimize Monki back to the launcher bubble — conversation state is kept
    if (S.monki.open && !e.target.closest(".monki-panel,.monki-launcher")) {
      S.monki.open = false;
      needsRender = true;
    }
    if (needsRender) renderApp();
  });
  const { route, param } = parseHash();
  if (route === "ask") {
    S.route = "dashboard";
    S.monki.open = true;
    history.replaceState(null, "", "#/dashboard");
  } else if (PAGE_META[route]) S.route = route;

  try {
    const { user } = await api("/api/me");
    S.me = user;
    await probeReporting();
    await probeReportingBasic();
    ensureAllowedRoute();
    await loadState();
    await Promise.all([loadChatChannels(), loadAiStatus(), loadDirectory()]);
    renderApp(); // AI status affects Monki and the dashboard brief card
    if (S.route === "chat" && param) await App.openChannel(param);
    else if (route !== "chat" && param) { S.openTaskId = param; renderApp(); }
    pulse();
    // OAuth return flash from the Hyros connect flow (?hyros=…#/admin)
    const hyrosFlash = new URLSearchParams(location.search).get("hyros");
    if (hyrosFlash) {
      S.integrations.hyros = undefined; // force the Admin card to refetch
      const messages = {
        connected: ["Hyros connected — the 90-day history sync has started.", "ok"],
        "oauth-denied": ["The Hyros sign-in was cancelled or denied.", "err"],
        "oauth-state": ["The Hyros sign-in expired before it finished — try connecting again.", "err"],
        "oauth-test": ["Signed in, but Hyros did not answer a test call — try again or use the API-key option.", "err"],
        "oauth-start-failed": ["Could not reach Hyros to start the sign-in — try again in a moment.", "err"],
        "oauth-failed": ["The Hyros sign-in failed — try again or use the API-key option.", "err"],
      };
      const [text, kind] = messages[hyrosFlash] || ["Hyros connection updated.", "ok"];
      toast(text, kind === "err" ? "err" : undefined);
      history.replaceState(null, "", `${location.pathname}#/admin`);
    }
  } catch {
    renderLogin();
  }

  // keep both sides in sync while the app is open
  setInterval(() => { if (S.me) loadState(true); }, 60000);
  setInterval(pulse, 5000);
})();
