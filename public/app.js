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
    throw new Error((data && data.error) || `Request failed (${res.status})`);
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
  el.className = "toast " + (kind === "err" ? "err" : "ok");
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

/* ------------------------------ icons ------------------------------ */

const I = {
  dashboard: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>',
  board: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 4v13M12 4v9M19 4v16"/></svg>',
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
  admin: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33h.01a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51h.01a1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82v.01a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>',
  mute: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 01-3.4 0"/><line x1="4" y1="4" x2="20" y2="20"/></svg>',
  send: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/></svg>',
  key: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.8 12.2L21 2m-4 2l3 3m-6 0l3 3"/></svg>',
  taskChip: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 2v4M16 2v4M3 10h18"/></svg>',
  sparkle: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z"/><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15z"/></svg>',
};

/* ------------------------------ state ------------------------------ */

const S = {
  me: null,          // { username, role, name, org }
  data: null,        // { tasks, deliverables, decisions, recurring, team, links, activity, meta }
  route: "dashboard",
  openTaskId: null,
  modal: null,       // 'newTask' | 'deliverable' | 'decision' | 'link' | 'editTask' | 'acceptTask' | 'password' | 'addUser' | 'newChannel' | 'channelMembers'
  filters: { q: "", status: "", department: "", priority: "", owner: "", scope: "" },
  chat: { channels: [], openId: null, messages: [], channelInfo: null, replyToId: null, draft: "", mentionOpen: false, highlightId: null },
  pulse: { unread: {}, chatTotal: 0, notifications: 0 },
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
};

const isClient = () => S.me && S.me.role === "client";
const isTeam = () => S.me && (S.me.role === "team" || S.me.role === "super_admin");
const isAdmin = () => S.me && S.me.role === "super_admin";
/** Is AI usable by me right now, for this feature? */
const aiOn = (feature) =>
  !!(S.ai && S.ai.enabled && S.ai.allowedForMe && (!feature || S.ai.features[feature] !== false));

const OPEN_STATUSES = ["New Request","Backlog","Planned","In Progress","Ready / Waiting","Waiting on Client","Waiting on Internal","Waiting on External","Ready for Review","Revision Required"];
const isOpen = (t) => !["Completed", "Cancelled"].includes(t.status);
const lastTs = (t) => (t.updates && t.updates.length ? t.updates[t.updates.length - 1].ts : t.dateRequested);

const BOARD_COLS = [
  { key: "new", label: "New Requests", statuses: ["New Request"] },
  { key: "planned", label: "Planned", statuses: ["Backlog", "Planned"] },
  { key: "progress", label: "In Progress", statuses: ["In Progress"] },
  { key: "waiting", label: "Waiting", statuses: ["Ready / Waiting", "Waiting on Client", "Waiting on Internal", "Waiting on External"] },
  { key: "review", label: "Ready for Review", statuses: ["Ready for Review", "Revision Required"] },
  { key: "done", label: "Done", statuses: ["Completed", "Cancelled"] },
];

/* ------------------------------ data ------------------------------ */

async function loadState(quiet) {
  try {
    S.data = await api("/api/state");
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
function playTone() {
  unlockAudio();
  if (!audioCtx) return;
  try {
    const t = audioCtx.currentTime;
    [[880, 0], [1174.7, 0.09]].forEach(([f, off]) => {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = "sine";
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + off);
      g.gain.exponentialRampToValueAtTime(0.12, t + off + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + off + 0.22);
      o.connect(g);
      g.connect(audioCtx.destination);
      o.start(t + off);
      o.stop(t + off + 0.25);
    });
  } catch { /* ignore */ }
}
window.addEventListener("pointerdown", unlockAudio);

/* ------------------------------ login ------------------------------ */

function renderLogin() {
  document.getElementById("app").innerHTML = `
  <div class="login-wrap">
    <div class="login-card">
      <div class="login-logo">
        <div class="brand-mark">NM</div>
        <div>
          <div class="brand-name">NEONMONKI</div>
          <div class="brand-sub">TASK HUB — by Advertidea</div>
        </div>
      </div>
      <div class="login-sub">The shared workspace for NEONMONKI &amp; Advertidea — tasks, channels, files and decisions. Sign in with the account your admin gave you.</div>
      <div class="account-pick">
        <button type="button" id="pick-abubakar" onclick="App.pickAccount('abubakar')">
          <span class="acc-name">Abu Bakar</span>
          <span class="acc-role">Super Admin</span>
        </button>
        <button type="button" id="pick-adika" onclick="App.pickAccount('adika')">
          <span class="acc-name">Adika</span>
          <span class="acc-role">NEONMONKI</span>
        </button>
        <button type="button" id="pick-advertidea" onclick="App.pickAccount('advertidea')">
          <span class="acc-name">Advertidea</span>
          <span class="acc-role">Agency Team</span>
        </button>
      </div>
      <form onsubmit="App.login(event)">
        <label>USERNAME</label>
        <input name="username" id="login-username" autocomplete="username" required placeholder="your username">
        <label>PASSWORD</label>
        <input name="password" type="password" autocomplete="current-password" required placeholder="••••••••••">
        <button class="login-btn" type="submit">Sign in</button>
        <div id="login-error"></div>
      </form>
      <div class="login-foot">Accounts are created by the super admin — no self-signup.</div>
    </div>
  </div>`;
}

/* ------------------------------ shell ------------------------------ */

const NAV = [
  { section: "Work" },
  { route: "dashboard", label: "Dashboard", icon: "dashboard" },
  { route: "chat", label: "Chat", icon: "chat", chatBadge: true },
  { route: "board", label: "Board", icon: "board", badge: true },
  { route: "mywork", label: "Department Tasks", icon: "tasks", teamOnly: true },
  { route: "tasks", label: "All Tasks", icon: "tasks" },
  { section: "Records" },
  { route: "deliverables", label: "Deliverables", icon: "deliverables" },
  { route: "decisions", label: "Decisions & Rules", icon: "decisions" },
  { route: "recurring", label: "Recurring Work", icon: "recurring" },
  { route: "files", label: "Files", icon: "files" },
  { section: "People" },
  { route: "team", label: "Team", icon: "team", teamOnly: true },
  { route: "admin", label: "Admin", icon: "admin", adminOnly: true },
  { route: "aicontrol", label: "AI Control", icon: "sparkle", adminOnly: true },
];

const PAGE_META = {
  dashboard: ["Dashboard", "What is happening across the NEONMONKI account right now"],
  chat: ["Chat", "Channels per service line — turn any message into a task"],
  board: ["Board", "Drag-free kanban — click any card to open details and act"],
  mywork: ["Department Tasks", "Tasks assigned to you and every department you belong to"],
  tasks: ["All Tasks", "Full task register from the master sheet, live"],
  deliverables: ["Deliverables", "Everything delivered to NEONMONKI, with links"],
  decisions: ["Decisions & Rules", "Binding decisions made on calls and in chat"],
  recurring: ["Recurring Work", "Weekly / monthly / ongoing commitments"],
  files: ["Files", "Project documents organized by channel and workstream"],
  team: ["Team", "Who owns what on the Advertidea side"],
  admin: ["Admin", "Users, passwords and channel management — super admin only"],
  aicontrol: ["AI Control Center", "Kimi connection, features, limits, usage and audit — super admin only"],
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
        <div class="brand-mark">NM</div>
        <div>
          <div class="brand-name">NEONMONKI</div>
          <div class="brand-sub">TASK HUB</div>
        </div>
      </div>
      <nav class="nav">
        ${NAV.map((n) => {
          if (n.section) return `<div class="nav-section">${n.section}</div>`;
          if (n.adminOnly && !isAdmin()) return "";
          if (n.teamOnly && !isTeam()) return "";
          if (n.aiFeature && !aiOn(n.aiFeature)) return "";
          return `<button class="nav-item ${route === n.route ? "active" : ""}" onclick="App.nav('${n.route}')">
            ${I[n.icon]}<span>${n.label}</span>
            ${n.badge && badge ? `<span class="nav-badge ${isTeam() ? "neon" : ""}">${badge}</span>` : ""}
            ${n.chatBadge && chatBadge ? `<span class="nav-badge neon">${chatBadge > 99 ? "99+" : chatBadge}</span>` : ""}
          </button>`;
        }).join("")}
      </nav>
      <div class="sidebar-user">
        <div class="avatar ${isClient() ? "client" : "team"}">${esc(initials(S.me.name))}</div>
        <div class="who">
          <div class="n">${esc(S.me.name)}</div>
          <div class="r">${isAdmin() ? "Super Admin" : isClient() ? "NEONMONKI" : "Advertidea Team"}</div>
        </div>
        <button class="logout-btn" title="Change password" onclick="App.openModal('password')">${I.key}</button>
        <button class="logout-btn" title="Sign out" onclick="App.logout()">${I.logout}</button>
      </div>
    </aside>
    <div class="main">
      <div class="topbar">
        <div>
          <h1>${title}</h1>
          <div class="crumb">${crumb}</div>
        </div>
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

function renderPage(route) {
  const el = document.getElementById("content");
  if (!el) return;
  switch (route) {
    case "dashboard": el.innerHTML = viewDashboard(); break;
    case "chat": renderChat(el); break;
    case "board": el.innerHTML = viewBoard(); break;
    case "mywork": el.innerHTML = viewMyWork(); break;
    case "tasks": el.innerHTML = viewTasks(); break;
    case "deliverables": el.innerHTML = viewDeliverables(); break;
    case "decisions": el.innerHTML = viewDecisions(); break;
    case "recurring": el.innerHTML = viewRecurring(); break;
    case "files": el.innerHTML = viewFiles(); break;
    case "team": el.innerHTML = viewTeam(); break;
    case "admin": renderAdmin(el); break;
    case "aicontrol": renderAiControl(el); break;
  }
}

/* ------------------------------ dashboard ------------------------------ */

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

  return `
  <div class="kpi-grid">
    ${kpis.map((k) => `
      <button type="button" class="kpi" style="--kpi-color:${k.color}" onclick="App.dashboardFilter('${k.kind}')" aria-label="Show ${esc(k.label.toLowerCase())}">
        <div class="k-label">${k.label}</div>
        <div class="k-value">${k.value}</div>
        <div class="k-sub">${k.sub} <span class="k-view">View tasks →</span></div>
      </button>`).join("")}
  </div>
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
  </div>
  ${aiOn("brief") ? `
  <div class="card card-pad" style="margin-bottom:16px">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:${S.aiBrief ? "10px" : "0"}">
      <div class="card-title">${I.sparkle} AI daily brief</div>
      <button class="btn neon sm" onclick="App.aiBrief()" ${S.aiBrief && S.aiBrief.loading ? "disabled" : ""}>${S.aiBrief && S.aiBrief.loading ? "Thinking…" : S.aiBrief && S.aiBrief.answer ? "Regenerate" : "Generate my brief"}</button>
      ${S.aiBrief && S.aiBrief.ts ? `<span style="color:var(--faint);font-size:12px">${timeAgo(S.aiBrief.ts)}</span>` : ""}
    </div>
    ${S.aiBrief && S.aiBrief.answer ? `<div class="ai-label" style="margin-bottom:10px">${I.sparkle} AI-generated from live workspace data</div>${renderAiBrief(S.aiBrief.answer)}` : ""}
    ${S.aiBrief && S.aiBrief.error ? `<div class="login-error" style="margin:0">${esc(S.aiBrief.error)}</div>` : ""}
  </div>` : ""}
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
  <div class="board-card ${blocked ? "blocked" : ""}" onclick="App.openTask('${esc(t.id)}')">
    <div class="bc-id">${esc(t.id)} ${taskOriginBadge(t)}</div>
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
  </div>`;
}

function viewBoard() {
  const tasks = S.data.tasks;
  return `<div class="board">
    ${BOARD_COLS.map((col) => {
      const list = tasks
        .filter((t) => col.statuses.includes(t.status))
        .sort((a, b) => new Date(lastTs(b)) - new Date(lastTs(a)));
      return `
      <div class="board-col">
        <div class="board-col-head">${col.label}<span class="col-count">${list.length}</span></div>
        ${list.length ? list.map(boardCard).join("") : `<div class="board-col-empty">No tasks</div>`}
      </div>`;
    }).join("")}
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
      return true;
    })
    .sort((a, b) => new Date(lastTs(b)) - new Date(lastTs(a)));

  const deptOpts = departments();
  const ownerOpts = teamUsers();

  return `
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
    ${(f.q || f.status || f.scope || f.department || f.priority || f.owner) ? `<button class="btn ghost sm" onclick="App.clearFilters()">Clear</button>` : ""}
    <span style="color:var(--faint);font-size:12.5px;margin-left:auto">${tasks.length} task${tasks.length === 1 ? "" : "s"}</span>
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

  el.innerHTML = `<div class="drawer-head task-drawer-head"><div class="dh-top"><span class="dh-id">${esc(t.id)}</span>${taskOriginBadge(t)}<span class="pill ${statusClass(t.status)}"><span class="dot"></span>${esc(t.status)}</span><span class="pill ${prioClass(t.priority)}">${esc(t.priority)}</span>${visBadge(t)}</div><h2>${esc(t.title)}</h2><div class="drawer-dept-signals">${departmentSignals(t)}</div><button class="drawer-close" onclick="App.closeDrawer()">✕</button></div>
  <div class="drawer-actions">${actions.join("")}${aiOn("summaries") ? `<button class="btn ghost sm" onclick="App.summarizeTask('${esc(t.id)}')">${I.sparkle} AI summary</button>` : ""}${isTeam() ? `<span class="da-label">Status</span><select onchange="App.setStatus('${esc(t.id)}',this.value)">${S.data.meta.statuses.map((s) => `<option ${t.status === s ? "selected" : ""}>${esc(s)}</option>`).join("")}</select><button class="btn ghost sm" onclick="App.openModal('editTask')">Edit task</button>` : ""}</div>
  <div class="drawer-body task-workspace">
    <div class="task-overview-grid"><div class="section overview-card"><div class="section-h">Task details</div><div class="meta-grid">${metaCell("Departments", departmentSignals(t))}${metaCell("Owners", esc(t.owner || (t.assignmentMode === "whole_team" ? "Whole team" : "Department assignment")))}${metaCell("Project / Area", esc(t.project))}${metaCell("Requested by", esc(t.requestedBy))}${metaCell("Due date", fmtDate(t.dueDate))}${metaCell("Visibility", esc(t.visibility === "shared" ? "NEONMONKI + team" : t.visibility === "department" ? "Assigned departments" : t.visibility === "private" ? "Named owners" : "Whole team"))}</div></div>
      <div class="section overview-card"><div class="section-h">Progress</div>${t.nextAction ? `<div class="note-box next"><div class="nb-label">Next action</div>${esc(t.nextAction)}</div>` : `<div class="empty-note compact">No next action set.</div>`}${t.blocker ? `<div class="note-box blocker"><div class="nb-label">Blocker</div>${esc(t.blocker)}</div>` : ""}</div></div>
    ${t.description ? `<div class="section"><div class="section-h">Description</div><div class="desc-text">${esc(t.description)}</div></div>` : ""}

    <div class="section workflow-section"><div class="section-title-row"><div><div class="section-h">Subtasks <span class="count">(${subtasks.length})</span></div><div class="section-sub">Break down the main task and assign each part separately.</div></div>${isTeam() ? `<button class="btn primary sm" onclick="App.openModal('addSubtask')">${I.plus} Add subtask</button>` : ""}</div>
      <div class="subtask-list">${subtasks.length ? subtasks.map((s) => `<div class="subtask-card"><button class="subtask-check ${s.status === "Completed" ? "done" : ""}" ${isTeam() ? `onclick="App.updateSubtask('${esc(t.id)}','${esc(s.id)}',{status:'${s.status === "Completed" ? "In Progress" : "Completed"}'})"` : "disabled"}>${s.status === "Completed" ? "✓" : ""}</button><div class="subtask-main"><b>${esc(s.title)}</b><div class="subtask-meta">${(s.ownerUsernames || []).map((id) => esc((teamUsers().find((u) => u.username === id) || {}).name || id)).join(", ") || "Department assignment"} · ${departmentSignals({ departmentIds: s.departmentIds || [] }, false)}${s.dueDate ? ` · due ${fmtDate(s.dueDate)}` : ""}${s.clientVisible ? ` · <span class="client-safe-chip">visible to NEONMONKI</span>` : ""}</div>${s.description ? `<p>${esc(s.description)}</p>` : ""}</div><span class="pill ${statusClass(s.status)}">${esc(s.status)}</span>${isTeam() ? `<button class="icon-delete" title="Delete subtask" onclick="App.deleteSubtask('${esc(t.id)}','${esc(s.id)}')">✕</button>` : ""}</div>`).join("") : `<div class="empty-note compact">No subtasks yet.</div>`}</div>
    </div>

    <div class="section workflow-section"><div class="section-title-row"><div><div class="section-h">Links &amp; approvals <span class="count">(${attachments.length})</span></div><div class="section-sub">Share a Google Drive, Docs, Sheets, Figma, Dropbox or other HTTPS link → owner review → client delivery.</div></div></div>
      <div class="task-file-list">${attachments.length ? attachments.map(attachmentHtml).join("") : `<div class="empty-note compact">No sharing links attached.</div>`}</div>
      <div class="inline-file-upload"><input id="drawer-link-title" placeholder="Link title"><input id="drawer-link-url" type="url" placeholder="https://drive.google.com/…"><select id="drawer-file-subtask"><option value="">Attach to main task</option>${subtasks.map((s) => `<option value="${esc(s.id)}">${esc(s.title)}</option>`).join("")}</select><button class="btn ghost sm" onclick="App.shareDrawerLink('${esc(t.id)}')">Share link</button></div>
    </div>

    ${linkedDocs.length ? `<div class="section"><div class="section-h">Linked documents</div>${linkedDocs.map((l) => `<div class="linked-doc">📄 ${linkify(l.url || l.title, l.title)}</div>`).join("")}</div>` : ""}

    <div class="section workflow-section comments-section"><div class="section-title-row"><div><div class="section-h">Task conversation <span class="count">(${comments.filter((c) => !c.deleted).length})</span></div><div class="section-sub">Use @username or @everyone. Notifications open this exact comment.</div></div></div>
      <div class="task-comments">${comments.length ? comments.map((c) => `<div class="task-comment ${c.clientVisible ? "client-visible" : "internal-comment"}" id="comment-${esc(c.id)}"><div class="comment-avatar">${esc(initials(c.by || "?"))}</div><div class="comment-body"><div class="comment-head"><b>${esc(c.by)}</b><span>${timeAgo(c.ts)}</span>${c.clientVisible ? `<span class="client-safe-chip">Shared with NEONMONKI</span>` : `<span class="internal-chip">Internal</span>`}${!c.deleted && c.authorUsername === S.me.username ? `<button class="comment-delete" onclick="App.deleteComment('${esc(t.id)}','${esc(c.id)}')">Delete</button>` : ""}</div><div class="comment-text">${c.deleted ? `<i>Comment deleted</i>` : linkifyText(c.text)}</div></div></div>`).join("") : `<div class="empty-note compact">No comments yet.</div>`}</div>
      <div class="comment-composer"><textarea id="task-comment-text" placeholder="Write a comment… Use @username or @everyone"></textarea><div class="comment-composer-foot">${isTeam() && t.visibility === "shared" ? `<label class="safe-share-toggle"><input type="checkbox" id="comment-client-visible"> Share this comment with NEONMONKI</label>` : isTeam() ? `<span class="internal-safety-note">🔒 Internal comment — this task is not shared with NEONMONKI</span>` : `<span class="client-safety-note">Visible to the assigned team</span>`}<button class="btn primary sm" onclick="App.postComment('${esc(t.id)}')">${I.send} Post comment</button></div></div>
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
            <div class="form-row"><label>PRIORITY</label><select name="priority">${prioOptions(d.priority || "High")}</select></div>
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
              <div class="form-row"><label>DUE DATE</label><input name="dueDate" type="date" value="${esc(d.dueDate || "")}"></div>
            </div>
            <div class="form-row"><label>NEXT ACTION</label><input name="nextAction" maxlength="300" value="${esc(d.nextAction || "")}" placeholder="The single next step"></div>
            <div class="form-row"><label>SHARING LINK <span class="label-note">optional · Google Drive, Docs, Sheets, Figma or another HTTPS link</span></label><div class="link-field-pair"><input name="taskLinkTitle" maxlength="180" placeholder="Link title"><input name="taskLinkUrl" type="url" maxlength="1500" placeholder="https://…"></div></div>
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
          <div class="form-row"><label>ORGANIZATION</label><input name="org" value="${esc(u.org || "")}" maxlength="60"></div></div>
        <div class="form-row"><label>ACCESS TYPE</label><select name="role" onchange="App.userRoleChanged(this)">
          <option value="team" ${u.role === "team" ? "selected" : ""}>Team — internal workspace</option>
          <option value="client" ${u.role === "client" ? "selected" : ""}>Client — limited dashboard, no internal data</option>
          <option value="super_admin" ${u.role === "super_admin" ? "selected" : ""}>Super Admin — full control</option>
        </select></div>
        <div class="form-row user-department-row" style="${u.role === "client" ? "display:none" : ""}"><label>DEPARTMENTS <span class="label-note">multiple allowed</span></label>${departmentPicker("departments", u.departments || [], { required: false })}</div>
        <div class="access-explainer"><b>Client</b> sees only shared/requested work and client-visible comments or delivered files. <b>Team</b> can access internal work within its permissions. Department membership controls department-only tasks and Monki context.</div>
        <div class="modal-foot"><button type="button" class="btn ghost" onclick="App.closeModal()">Cancel</button><button class="btn primary" type="submit">Save access</button></div>
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
      const candidates = S.admin.users.filter((u) => u.active && !memberSet.has(u.username) && (u.role !== "client" || c.clientAllowed));
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
                  <button type="button" class="mp-item" style="cursor:pointer" onclick="App.addChannelMember('${esc(cid)}', '${esc(u.username)}')">+ ${esc(u.name)}</button>`).join("") : `<span style="color:var(--faint);font-size:12.5px">Everyone eligible is already in.</span>`}
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
          ${d.loading ? `<div class="ai-summary-loading"><img src="/monki-mascot.webp" alt=""><div><b>Monki is reading the work…</b><span>Checking task history, communication and shared links.</span></div></div>` : d.error ? `<div class="login-error" style="margin:0">${esc(d.error)}</div>` : `
            ${d.task ? `<div class="ai-summary-facts"><span><small>Task</small><b>${esc(d.task.id)}</b></span><span><small>Status</small><b>${esc(d.task.status)}</b></span><span><small>Priority</small><b>${esc(d.task.priority)}</b></span><span><small>Due</small><b>${fmtDate(d.task.dueDate)}</b></span><span class="wide"><small>Owners</small><b>${esc(d.task.owners || "Unassigned")}</b></span></div>` : ""}
            <div class="ai-summary-meta"><span>${I.sparkle} AI-generated with ${esc(d.model || "K3")}</span><span>${d.generatedAt ? `Updated ${timeAgo(d.generatedAt)}` : ""}</span></div>
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
      <div class="cc-mentions" style="display:${S.chat.mentionOpen ? "flex" : "none"}"><button onclick="App.insertMention('everyone')">@everyone</button>${people.filter((person) => person.username !== S.me.username).map((person) => `<button onclick="App.insertMention('${esc(person.username)}')">@${esc(person.username)} <span>${esc(person.name)}</span></button>`).join("")}</div>
      <div class="cc-attach" id="cc-attach" style="display:none">
        <input id="cc-link-url" placeholder="https://… (link to share & file in this channel)">
        <input id="cc-link-title" placeholder="Link title">
      </div>
      <div class="cc-row">
        <button class="btn ghost sm" title="Attach a link" onclick="App.toggleAttach()">${I.docs}</button>
        <button class="btn ghost sm" title="Mention someone" onclick="App.toggleMentions()">@</button>
        <textarea id="chat-input" rows="1" placeholder="Message # ${esc(c.name)}…  (Enter to send, Shift+Enter for newline)" oninput="App.chatDraft(this.value)" onkeydown="App.chatKey(event, '${esc(c.id)}')">${esc(S.chat.draft || "")}</textarea>
        <button class="btn neon sm" onclick="App.sendMessage('${esc(c.id)}')" title="Send">${I.send}</button>
      </div>
      <div class="cc-hint">Use @username or @everyone · reply in context · only you can delete your messages</div>
    </div>`;
}

function messageHtml(m) {
  const linkedTask = m.taskId ? S.data.tasks.find((t) => t.id === m.taskId) : null;
  const isAi = m.authorId === "ai";
  const parent = m.replyToId ? S.chat.messages.find((item) => Number(item.id) === Number(m.replyToId)) : null;
  const replyCount = S.chat.messages.filter((item) => Number(item.replyToId) === Number(m.id)).length;
  const reactionHtml = Object.entries(m.reactions || {}).map(([emoji, people]) => `<button class="msg-reaction ${(people || []).includes(S.me.username) ? "mine" : ""}" onclick="App.reactMessage(${m.id},'${emoji}')"><span>${emoji}</span>${people.length}</button>`).join("");
  return `
  <div class="msg ${m.replyToId ? "is-reply" : ""} ${Number(S.chat.highlightId) === Number(m.id) ? "message-highlight" : ""}" id="message-${m.id}">
    <div class="msg-avatar ${isAi ? "ai" : ""}">${isAi ? "AI" : esc(initials(m.author || "?"))}</div>
    <div class="msg-body">
      <div class="msg-head"><span class="msg-author">${esc(m.author)}</span><span class="msg-time">${timeAgo(m.ts)}</span></div>
      ${m.replyToId ? `<button class="msg-reply-preview" onclick="App.focusMessage(${m.replyToId})"><b>${parent ? esc(parent.author) : "Original message"}</b><span>${parent ? esc((parent.text || parent.linkTitle || "Shared item").slice(0, 150)) : "This message is no longer available."}</span></button>` : ""}
      ${m.text ? `<div class="msg-text">${linkifyText(m.text)}</div>` : ""}
      ${m.linkUrl ? `<div class="msg-link">🔗 ${linkify(m.linkUrl, m.linkTitle || shortUrl(m.linkUrl))}</div>` : ""}
      ${m.taskId ? `<div class="msg-task" onclick="App.openTask('${esc(m.taskId)}')">${I.taskChip} <b>${esc(m.taskId)}</b>${linkedTask ? ` — ${esc(linkedTask.title)}` : ""}<span class="pill ${statusClass(linkedTask ? linkedTask.status : "")}" style="margin-left:6px">${linkedTask ? esc(linkedTask.status) : ""}</span></div>` : ""}
      <div class="msg-reaction-row">${reactionHtml}</div>
      <button class="msg-act" title="Reply in this thread" onclick="App.replyToMessage(${m.id})">↩ Reply${replyCount ? ` · ${replyCount}` : ""}</button>
      <button class="msg-act" title="React" onclick="App.toggleReactionPicker(${m.id})">☺ React</button>
      <span class="reaction-picker" id="reaction-picker-${m.id}">${["👍","✅","❤️","👀","🎉"].map((emoji) => `<button onclick="App.reactMessage(${m.id},'${emoji}')">${emoji}</button>`).join("")}</span>
      ${m.text ? `<button class="msg-act" title="Create a task from this message" onclick="App.taskFromMessage(${m.id})">${I.plus} Task</button>` : ""}
      ${m.authorId === S.me.username && !isAi ? `<button class="msg-act danger-text" title="Delete your message" onclick="App.deleteChatMessage(${m.id})">Delete</button>` : ""}
    </div>
  </div>`;
}

function linkifyText(text) {
  const escaped = esc(text);
  return escaped.replace(
    /(https?:\/\/[^\s&<>"']+)/g,
    (u) => `<a href="${u}" target="_blank" rel="noopener">${u.length > 48 ? u.slice(0, 48) + "…" : u}</a>`
  ).replace(/(^|\s)@([a-z0-9_.-]{2,30}|everyone)\b/gi, (all, lead, name) => `${lead}<span class="mention">@${name}</span>`);
}

function scrollChatToBottom() {
  const el = document.getElementById("chat-messages");
  if (el) el.scrollTop = el.scrollHeight;
}

/* ------------------------------ notifications ------------------------------ */

function renderNotifPanel() {
  const items = S.notifs.items;
  return `
  <div class="notif-panel">
    <div class="notif-head">
      <span>Notifications</span>
      <button class="btn ghost sm" onclick="App.markNotifsRead()">Mark all read</button>
    </div>
    ${items.length ? items.map((n) => `
      <div class="notif-item ${n.read ? "read" : ""}" onclick="App.gotoNotif(${n.id})">
        <div class="notif-kind">${n.kind === "chat" ? "💬" : "📋"}</div>
        <div class="notif-body">
          <div class="notif-text">${esc(n.text)}</div>
          <div class="notif-time">${timeAgo(n.ts)}</div>
        </div>
      </div>`).join("") : `<div class="empty-note">No notifications yet.</div>`}
  </div>`;
}

/* ------------------------------ admin ------------------------------ */

async function loadAdmin() {
  try {
    const { users, channels, departments: adminDepartments } = await api("/api/admin/overview");
    S.admin = { users, channels, departments: adminDepartments || [] };
  } catch { /* not admin */ }
}

function renderAdmin(el) {
  if (!isAdmin()) {
    el.innerHTML = `<div class="card"><div class="empty-note">Super admin only.</div></div>`;
    return;
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
          <td>${u.active ? `<span class="pill status-Completed">Active</span>` : `<span class="pill status-Cancelled">Disabled</span>`}</td>
          <td class="admin-actions"><button class="btn ghost sm" onclick="App.openModal('editUser:${esc(u.username)}')">Manage access</button>${u.username !== S.me.username ? `<button class="btn ghost sm" onclick="App.resetPassword('${esc(u.username)}')">Reset pw</button><button class="btn ghost sm" onclick="App.toggleUserActive('${esc(u.username)}', ${u.active})">${u.active ? "Disable" : "Enable"}</button>` : ""}</td></tr>`).join("")}
      </tbody></table></div>
    </div>
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

function viewTeam() {
  return `
  <div class="page-head-note">Who owns what on the Advertidea delivery team. When assigning a task, pick the owner from this list.</div>
  <div class="team-grid">
    ${S.data.team.length ? S.data.team.map((p) => `
      <div class="card team-card">
        <div class="tc-name">${esc(p.name)}</div>
        <div class="tc-role">${esc(p.role)}</div>
        <div class="tc-area">${esc(p.area)}</div>
        <div class="tc-resp">${esc(p.responsibility)}</div>
      </div>`).join("") : `<div class="card"><div class="empty-note">No team members listed yet.</div></div>`}
  </div>`;
}

/* ------------------------------ Monki AI chatbot ------------------------------ */

function citationChips(citations) {
  if (!citations || !citations.length) return "";
  const icons = { task: "📋", message: "💬", link: "🔗", decision: "⚖️", deliverable: "📦" };
  return `<div class="cite-row">` + citations.map((c) => {
    const icon = icons[c.type] || "📄";
    if (c.type === "task") return `<button class="cite-chip" onclick="App.openTask('${esc(c.id)}')">${icon} ${esc(c.id)}</button>`;
    if (c.type === "message") return `<button class="cite-chip" onclick="App.gotoChannel('${esc(c.channelId)}')">${icon} ${esc(c.title)}</button>`;
    if (c.type === "link") return `<button class="cite-chip" onclick="App.nav('files')">${icon} ${esc(c.title)}</button>`;
    if (c.type === "decision") return `<button class="cite-chip" onclick="App.nav('decisions')">${icon} ${esc(c.title || c.id)}</button>`;
    if (c.type === "deliverable") return `<button class="cite-chip" onclick="App.nav('deliverables')">${icon} ${esc(c.title || c.id)}</button>`;
    return `<span class="cite-chip">${icon} ${esc(c.title || c.id)}</span>`;
  }).join("") + `</div>`;
}

function monkiExamples() {
  return isClient()
    ? ["What was completed this week?", "Draft a reply to the latest project update", "What is waiting for my review?", "Find the Italy expansion links"]
    : ["What should I work on today?", "Draft a reply to Adika's latest message", "Create a task draft for the next priority", "Find the latest HYROS file and discussion"];
}

function monkiFormat(text) {
  return esc(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\n/g, "<br>");
}

function monkiAnswerExtras(a, interactive) {
  if (!a) return "";
  return `
    ${citationChips(a.citations)}
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
    <img class="monki-mini-avatar" src="/monki-mascot.webp" alt="" aria-hidden="true">
    <div class="monki-message-body">
      <div class="monki-message-name"><span>Monki</span><span class="monki-model">${esc(a.model || "K3")}</span><span>${timeAgo(a.ts)}</span></div>
      <div class="monki-bubble assistant-bubble ${a.error ? "error" : ""}">
        <div class="monki-answer-text">${monkiFormat(a.answer || "")}</div>
        ${monkiAnswerExtras(a, interactive)}
      </div>
    </div>
  </div>`;
}

function renderMonkiWidget() {
  const firstName = esc((S.me && S.me.name || "there").split(/\s+/)[0]);
  const examples = monkiExamples();
  const used = S.ai ? S.ai.callsToday || 0 : 0;
  const limit = S.ai ? S.ai.dailyLimit || 0 : 0;
  const messages = S.monki.messages || [];
  return `
  <section class="monki-panel ${S.monki.open ? "open" : ""}" role="dialog" aria-modal="false" aria-label="Chat with Monki" aria-hidden="${S.monki.open ? "false" : "true"}">
    <header class="monki-header">
      <div class="monki-header-art" aria-hidden="true">
        <span class="monki-orbit one"></span><span class="monki-orbit two"></span>
        <img src="/monki-mascot.webp" alt="">
      </div>
      <div class="monki-heading">
        <div class="monki-title-row"><h2>Monki</h2><span class="monki-live"><i></i> Online</span></div>
        <p>Your AI workspace copilot <span>·</span> powered by K3</p>
      </div>
      <button class="monki-close" onclick="App.closeMonki()" aria-label="Close Monki">×</button>
    </header>
    <div class="monki-messages" id="monki-messages" aria-live="polite">
      <div class="monki-message assistant welcome">
        <img class="monki-mini-avatar" src="/monki-mascot.webp" alt="" aria-hidden="true">
        <div class="monki-message-body">
          <div class="monki-message-name"><span>Monki</span><span class="monki-model">K3</span></div>
          <div class="monki-bubble assistant-bubble">
            <div class="monki-greeting">Hi ${firstName} — I’m Monki <span aria-hidden="true">🐒</span></div>
            <div>I can read your permitted tasks and conversations, find shared links, draft replies, prepare tasks and propose updates. What should we do?</div>
          </div>
        </div>
      </div>
      ${messages.length ? messages.map(renderMonkiMessage).join("") : `
        <div class="monki-suggestions" aria-label="Suggested questions">
          <div class="monki-suggestions-label">Try asking</div>
          ${examples.map((q) => `<button onclick="App.askMonki(this.textContent)">${I.sparkle}<span>${esc(q)}</span></button>`).join("")}
        </div>`}
      ${S.aiBusy ? `<div class="monki-message assistant typing">
        <img class="monki-mini-avatar" src="/monki-mascot.webp" alt="" aria-hidden="true">
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
      <div class="monki-composer-meta"><span>${used}/${limit} today</span><span>Answers include workspace sources</span></div>
    </div>
  </section>
  <div class="monki-launcher-wrap ${S.monki.open ? "panel-open" : ""}">
    <div class="monki-launcher-label"><strong>Ask Monki</strong><span>Workspace AI</span></div>
    <button class="monki-launcher ${S.aiBusy ? "thinking" : ""}" onclick="App.toggleMonki()" aria-label="${S.monki.open ? "Close" : "Open"} Monki chatbot" aria-expanded="${S.monki.open}">
      <span class="monki-launcher-ring"></span>
      <span class="monki-spark s1">✦</span><span class="monki-spark s2">✦</span>
      <img src="/monki-mascot.webp" alt="Monki, AI-powered monkey assistant">
      <span class="monki-status-dot"></span>
    </button>
  </div>`;
}

function scrollMonki(focus) {
  setTimeout(() => {
    const box = document.getElementById("monki-messages");
    if (box) box.scrollTop = box.scrollHeight;
    const input = document.getElementById("monki-input");
    if (focus && input && !S.aiBusy) input.focus();
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
        <div class="card-title" style="margin-bottom:12px">${I.sparkle} Connection</div>
        <div class="ai-kv"><span>Provider</span><b>${esc(c.provider && c.provider.name || "Kimi")}</b></div>
        <div class="ai-kv"><span>System status</span><b>${esc(c.provider && c.provider.status || "unknown")}</b></div>
        <div class="ai-kv"><span>Endpoint</span><b>${esc(c.baseUrl)}</b></div>
        <div class="ai-kv"><span>API key</span><b>${c.configured ? `Configured · ${c.provider.keySource === "control_center" ? "saved in AI Control" : "Vercel environment"}` : "Not configured"}</b></div>
        <div class="ai-kv"><span>Model</span><b>${esc(s.model)}</b></div>
        ${c.provider.storedKeyUnreadable ? `<div class="login-error">The saved key cannot be decrypted with the current server secret. Save the key again.</div>` : ""}
        <form class="ai-provider-form" onsubmit="App.aiSaveProvider(event)">
          <div class="form-row">
            <label>SERVICE / KEY TYPE</label>
            <select name="baseUrl" required onchange="App.aiPlatformChanged(this)">
              <option value="https://api.kimi.com/coding/v1" ${c.baseUrl.includes("api.kimi.com/coding") ? "selected" : ""}>Kimi Code membership · K3</option>
              <option value="https://api.moonshot.cn/v1" ${c.baseUrl.includes("moonshot.cn") ? "selected" : ""}>Moonshot China API · RMB</option>
              <option value="https://api.moonshot.ai/v1" ${c.baseUrl.includes("moonshot.ai") ? "selected" : ""}>Moonshot Global API</option>
            </select>
            <div class="form-hint">Keys from kimi.com/code use membership quota; Moonshot API keys use API balance.</div>
          </div>
          <div class="form-row">
            <label>KIMI API KEY</label>
            <input name="apiKey" type="password" autocomplete="new-password" maxlength="500" placeholder="${c.configured ? "Leave blank to keep the current key" : "Paste your Kimi API key"}">
            <div class="form-hint">The key is encrypted server-side and is never displayed back in the browser.</div>
          </div>
          <div class="form-row">
            <label>MODEL</label>
            <input name="model" list="kimi-model-options" value="${esc(s.model)}" maxlength="80" required>
            <datalist id="kimi-model-options">
              <option value="k3">Kimi Code K3 · up to 1M</option>
              <option value="k3-256k">Kimi Code K3 · 256K</option>
              <option value="kimi-for-coding">Kimi Code K2.7</option>
              <option value="kimi-for-coding-highspeed">Kimi Code K2.7 HighSpeed</option>
              <option value="kimi-k3">Moonshot API K3</option>
              <option value="kimi-k2.6">Kimi K2.6</option>
              <option value="kimi-k2.5">Kimi K2.5</option>
            </datalist>
          </div>
          <div class="ai-provider-actions">
            <button class="btn primary sm" type="submit">Save provider</button>
            <button class="btn ghost sm" type="button" onclick="App.aiTest()">Test connection</button>
            ${c.provider.keySource === "control_center" ? `<button class="btn danger sm" type="button" onclick="App.aiClearProviderKey()">Remove saved key</button>` : ""}
          </div>
        </form>
        ${S.aiTestResult ? `<div style="margin-top:10px"><span class="ai-test ${S.aiTestResult.ok ? "ok" : "err"}">${S.aiTestResult.ok ? `Connected to ${esc(S.aiTestResult.providerLabel || "Kimi")}${S.aiTestResult.model ? " · model " + esc(S.aiTestResult.model) : ""}${S.aiTestResult.configurationUpdated ? " · configuration corrected automatically" : ""}${S.aiTestResult.balance != null ? " · balance " + esc(S.aiTestResult.balance) : ""}` : esc(S.aiTestResult.error)}</span></div>` : ""}
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
          </div>
          <button class="btn primary sm" type="submit">Save settings</button>
        </form>
      </div>
      <div class="card card-pad" style="margin-bottom:16px">
        <div class="card-title" style="margin-bottom:4px">Per-user AI access</div>
        <div class="form-hint">These capability profiles are enforced by the API. Read only cannot draft or propose changes; Read + drafts can prepare tasks; Full can also propose task updates and decisions for human approval.</div>
        <div class="ai-user-list">
          ${(c.userAccess || []).map((u) => {
            const profile = aiToolProfile(c, u);
            return `
            <form class="ai-user-row" onsubmit="App.aiSaveUser(event, '${esc(u.username)}')">
              <label class="ai-user-enabled"><input type="checkbox" name="enabled" ${u.enabled ? "checked" : ""}> <span><b>${esc(u.name)}</b><small>${esc(u.role)}${u.active ? "" : " · disabled account"}</small></span></label>
              <select name="profile" aria-label="AI capability profile for ${esc(u.name)}">
                <option value="read" ${profile === "read" ? "selected" : ""}>Read only</option>
                <option value="draft" ${profile === "draft" ? "selected" : ""}>Read + drafts</option>
                <option value="full" ${profile === "full" ? "selected" : ""}>Full proposals</option>
                ${profile === "custom" ? `<option value="custom" selected>Custom API policy</option>` : ""}
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
    S.route = route;
    location.hash = "#/" + route;
    renderApp();
  },

  pickAccount(u) {
    document.getElementById("login-username").value = u;
    document.querySelectorAll(".account-pick button").forEach((b) => b.classList.remove("active"));
    const btn = document.getElementById("pick-" + u);
    if (btn) btn.classList.add("active");
    document.querySelector('input[name="password"]').focus();
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
      await loadState();
      toast(`Welcome, ${user.name}`);
    } catch (err) {
      document.getElementById("login-error").innerHTML = `<div class="login-error">${esc(err.message)}</div>`;
    }
  },

  async logout() {
    try { await api("/api/logout", "POST"); } catch { /* ignore */ }
    location.reload();
  },

  filter(key, value) {
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

  clearFilters() {
    S.filters = { q: "", status: "", department: "", priority: "", owner: "", scope: "" };
    renderPage("tasks");
  },

  dashboardFilter(kind) {
    const filters = { q: "", status: "", department: "", priority: "", owner: "", scope: "" };
    if (kind === "open") filters.scope = "open";
    if (kind === "inProgress") filters.status = "In Progress";
    if (kind === "waitingClient") filters.status = "Waiting on Client";
    if (kind === "review") filters.status = "Ready for Review";
    if (kind === "critical") { filters.scope = "open"; filters.priority = "Critical"; }
    if (kind === "completed") filters.status = "Completed";
    S.filters = filters;
    App.nav("tasks");
  },

  openTask(id) {
    S.openTaskId = id;
    history.replaceState(null, "", `#/${S.route}/${id}`);
    renderApp();
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

  async deleteComment(taskId, commentId) {
    if (!window.confirm("Delete this comment?")) return;
    try {
      await api(`/api/tasks/${encodeURIComponent(taskId)}/comments/${encodeURIComponent(commentId)}`, "DELETE");
      await loadState();
      toast("Comment deleted");
    } catch (e) { toast(e.message, "err"); }
  },

  async submitNewTask(e) {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    if (btn) btn.disabled = true;
    const fd = new FormData(e.target);
    const body = Object.fromEntries(fd.entries());
    body.departmentIds = selectedValues(e.target, "departmentIds");
    body.ownerUsernames = selectedValues(e.target, "ownerUsernames");
    const taskLink = {
      name: String(body.taskLinkTitle || body.title || "Task link").trim(),
      url: String(body.taskLinkUrl || "").trim(),
    };
    delete body.taskLinkTitle;
    delete body.taskLinkUrl;
    if (!body.departmentIds.length) {
      if (btn) btn.disabled = false;
      return toast("Choose at least one department", "err");
    }
    const draft = S.taskDraft;
    try {
      const { task } = await api("/api/tasks", "POST", body);
      if (taskLink.url) await api(`/api/tasks/${encodeURIComponent(task.id)}/files`, "POST", taskLink);
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

  async shareDrawerLink(taskId) {
    const title = document.getElementById("drawer-link-title");
    const input = document.getElementById("drawer-link-url");
    const subtask = document.getElementById("drawer-file-subtask");
    if (!input || !input.value.trim()) return toast("Paste a sharing link first", "err");
    if (!title || !title.value.trim()) return toast("Add a clear link title", "err");
    try {
      await api(`/api/tasks/${encodeURIComponent(taskId)}/files`, "POST", {
        name: title.value.trim(),
        url: input.value.trim(),
        subtaskId: subtask ? subtask.value : "",
      });
      await loadState();
      toast("Sharing link added for review");
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
    try {
      await api(`/api/chat/channels/${encodeURIComponent(channelId)}/messages`, "POST", {
        text, linkUrl: linkUrl.trim() || undefined, linkTitle: linkTitle.trim() || undefined, replyToId,
      });
      // @ai <question> → the AI answers in-channel (channel-scoped context only)
      const aiMatch = text.match(/^@ai\s+(.+)/i);
      if (aiMatch && aiOn("chat")) {
        renderApp();
        try {
          await api("/api/ai/ask", "POST", { question: aiMatch[1], channelId });
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
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      App.sendMessage(channelId);
    }
  },

  chatDraft(value) {
    S.chat.draft = value;
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
    if (ta) S.chat.draft = ta.value;
    S.chat.mentionOpen = !S.chat.mentionOpen;
    renderApp();
  },

  insertMention(username) {
    const addition = `@${username} `;
    S.chat.draft = `${S.chat.draft || ""}${S.chat.draft && !/\s$/.test(S.chat.draft) ? " " : ""}${addition}`;
    S.chat.mentionOpen = false;
    renderApp();
    setTimeout(() => { const input = document.getElementById("chat-input"); if (input) { input.focus(); input.selectionStart = input.selectionEnd = input.value.length; } }, 20);
  },

  toggleReactionPicker(id) {
    const picker = document.getElementById(`reaction-picker-${id}`);
    if (picker) picker.classList.toggle("open");
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

  async addChannelMember(channelId, username) {
    try {
      await api(`/api/admin/channels/${encodeURIComponent(channelId)}/members`, "POST", { username });
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
      const r = await api("/api/ai/ask", "POST", { question });
      S.aiAnswer = { ...r, question, ts: new Date().toISOString() };
      S.monki.messages.push({ role: "assistant", answer: S.aiAnswer });
      if (S.ai) S.ai.callsToday = (S.ai.callsToday || 0) + 1;
    } catch (e) {
      S.aiAnswer = { question, answer: `I couldn’t complete that request: ${e.message}`, citations: [], model: "K3", error: true, ts: new Date().toISOString() };
      S.monki.messages.push({ role: "assistant", answer: S.aiAnswer });
    }
    S.aiBusy = false;
    renderApp();
    scrollMonki(true);
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
    };
    try {
      await api("/api/ai/admin", "PATCH", body);
      await Promise.all([loadAiControl(), loadAiStatus()]);
      renderApp();
      toast("AI settings saved");
    } catch (err) { toast(err.message, "err"); }
  },

  aiPlatformChanged(select) {
    const modelInput = select && select.form && select.form.querySelector('[name="model"]');
    if (!modelInput) return;
    modelInput.value = String(select.value).includes("api.kimi.com/coding") ? "k3" : "kimi-k3";
  },

  async aiSaveProvider(e) {
    e.preventDefault();
    const fd = new FormData(e.target);
    const key = String(fd.get("apiKey") || "").trim();
    const body = {
      model: String(fd.get("model") || "").trim(),
      baseUrl: String(fd.get("baseUrl") || "").trim(),
    };
    if (key) body.apiKey = key;
    try {
      await api("/api/ai/admin", "PATCH", body);
      e.target.reset();
      await Promise.all([loadAiControl(), loadAiStatus()]);
      renderApp();
      toast(key ? "Kimi key and model saved" : "Kimi model saved");
    } catch (err) { toast(err.message, "err"); }
  },

  async aiClearProviderKey() {
    if (!window.confirm("Remove the Kimi key saved in AI Control? A Vercel environment key, if present, will become the fallback.")) return;
    try {
      await api("/api/ai/admin", "PATCH", { clearApiKey: true });
      await Promise.all([loadAiControl(), loadAiStatus()]);
      renderApp();
      toast("Saved Kimi key removed");
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

    // tones for increases in unmuted channels (not the one being watched)
    let changed = p.chatTotal !== prev.chatTotal || p.notifications !== prev.notifications;
    for (const [cid, n] of Object.entries(p.unread)) {
      if (n > (prev.unread[cid] || 0)) {
        const watching = S.route === "chat" && S.chat.openId === cid && !document.hidden;
        const ch = S.chat.channels.find((c) => c.id === cid);
        if (!watching && !(ch && ch.muted)) playTone();
        changed = true;
      }
    }
    if (p.notifications > prev.notifications) playTone();
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
    let changed = false;
    if (route && PAGE_META[route] && route !== S.route) { S.route = route; changed = true; }
    if (route !== "chat" && param !== S.openTaskId) { S.openTaskId = param; changed = true; }
    if (changed) renderApp();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (S.modal) App.closeModal();
    else if (S.openTaskId) App.closeDrawer();
    else if (S.monki.open) App.closeMonki();
  });
  // close the notifications panel on outside click
  document.addEventListener("click", (e) => {
    if (S.notifs.open && !e.target.closest(".bell-wrap")) {
      S.notifs.open = false;
      renderApp();
    }
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
    await loadState();
    await Promise.all([loadChatChannels(), loadAiStatus(), loadDirectory()]);
    renderApp(); // AI status affects Monki and the dashboard brief card
    if (S.route === "chat" && param) await App.openChannel(param);
    else if (route !== "chat" && param) { S.openTaskId = param; renderApp(); }
    pulse();
  } catch {
    renderLogin();
  }

  // keep both sides in sync while the app is open
  setInterval(() => { if (S.me) loadState(true); }, 60000);
  setInterval(pulse, 5000);
})();
