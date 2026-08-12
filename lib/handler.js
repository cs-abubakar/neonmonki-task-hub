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
} = require("./permissions");
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
  const allowedTools = ai.allowedToolNames(permission.tools);
  let blocked = null;
  if (!settings.enabled) blocked = { status: 503, error: "AI is currently disabled by the super admin." };
  else if (me.role === "client" && !settings.allowClient) blocked = { status: 403, error: "AI is not enabled for the client role." };
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
      if (size > 1_000_000) {
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
      return send(res, 200, { user: publicOf(user) }, {
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
      return send(res, 200, { user: publicOf(me) });
    }

    case "GET /api/users/basic": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      // minimal directory for pickers — names are already visible across the app
      const users = (await store.listUsers())
        .filter((u) => u.active)
        .map((u) => ({ username: u.username, name: u.name, role: u.role, departments: u.departments || [] }));
      return send(res, 200, { users });
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
      const state = await store.getState();
      // task visibility boundary: client never receives internal/private tasks,
      // and activity about those tasks never leaks either
      const tasks = visibleTasks(state.tasks, me);
      const visibleIds = new Set(tasks.map((t) => t.id));
      const activity = state.activity.filter((a) => !a.taskId || visibleIds.has(a.taskId));
      const channels = await store.listChannels();
      const links = visibleLinks(state.links, me, { tasks: state.tasks, channels });
      return send(res, 200, { ...state, tasks, links, activity, meta: { statuses: STATUSES, priorities: PRIORITIES } });
    }

    case "POST /api/tasks": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      const body = await readBody(req);
      const title = clean(body.title, 300);
      if (!title) return send(res, 400, { error: "Task title is required." });
      // visibility rules: team can mark internal/private; the client can only
      // create shared tasks or tasks private to one named team member
      let visibility = oneOf(body.visibility, ["shared", "internal", "private"], "shared");
      let privateFor = clean(body.privateFor, 30).toLowerCase();
      if (me.role === "client" && visibility === "internal") visibility = "shared";
      if (visibility === "private") {
        const target = privateFor ? await store.getUser(privateFor) : null;
        if (!target || !isTeamRole(target.role)) {
          return send(res, 400, { error: "Private tasks need a valid team member (privateFor username)." });
        }
      } else {
        privateFor = "";
      }
      const now = new Date().toISOString();
      const task = await insertWithFreshId(store, "tasks", "NM-NEW", async (id) => {
        const t = {
          id,
          title,
          dateRequested: now.slice(0, 10),
          department: clean(body.department, 100) || "Project Management",
          project: clean(body.project, 150),
          description: clean(body.description, 4000),
          requestedBy: me.role === "client" ? me.name : clean(body.requestedBy, 100) || me.name,
          owner: clean(body.owner, 150),
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
          source: body.fromChannel ? "Task Hub chat" : "Task Hub",
          visibility,
          privateFor,
          assignedDept: clean(body.assignedDept, 100),
          updates: [{
            ts: now,
            by: me.name,
            text: me.role === "client"
              ? "Task requested by client. Waiting for the team to accept."
              : "Task created by the team.",
          }],
        };
        await store.insertTask(t);
        return t;
      });
      await store.logActivity({ ts: now, taskId: task.id, by: me.name, text: `created task “${task.title}”` });
      if (visibility === "private") {
        await store.notify({ username: privateFor, kind: "task", text: `${me.name} assigned you a private task: ${task.title}`, taskId: task.id });
      } else if (me.role === "client") {
        // whole team should notice a new client request
        const users = await store.listUsers();
        for (const u of users) {
          if (u.active && isTeamRole(u.role)) {
            await store.notify({ username: u.username, kind: "task", text: `New request from ${me.name}: ${task.title}`, taskId: task.id });
          }
        }
      } else {
        await notifyTaskFollowers(store, task, me, `${me.name} created task “${task.title}”`);
      }
      return send(res, 201, { task });
    }

    case "PATCH /api/tasks/:id": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      const id = parts[0];
      const task = await store.getTask(id);
      if (!task || !canSeeTask(me, task)) return send(res, 404, { error: "Task not found." });
      const body = await readBody(req);
      const now = new Date().toISOString();

      const textFields = [
        "title", "department", "project", "description", "owner", "supporting",
        "blocker", "deliverable", "deliverableLink", "nextAction", "dueDate", "update", "assignedDept",
      ];
      const wantsFields = textFields.some((f) => f in body) || "priority" in body;
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
      return send(res, 200, { task: await store.getTask(id) });
    }

    case "POST /api/tasks/:id/accept": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      if (!isTeamRole(me.role)) return send(res, 403, { error: "Only the team can accept requests." });
      const id = parts[0];
      const task = await store.getTask(id);
      if (!task || !canSeeTask(me, task)) return send(res, 404, { error: "Task not found." });
      if (task.status !== "New Request") return send(res, 409, { error: "Task is not a new request." });
      const body = await readBody(req);
      const now = new Date().toISOString();
      const fields = { status: "In Progress" };
      if (body.owner && clean(body.owner, 150)) fields.owner = clean(body.owner, 150);
      await store.updateTask(id, fields);
      await store.pushTaskUpdate(id, {
        ts: now, by: me.name,
        text: `Accepted by ${me.name}${fields.owner ? ` — owner: ${fields.owner}` : ""}. Work started.`,
        statusFrom: "New Request", statusTo: "In Progress",
      });
      await store.logActivity({ ts: now, taskId: id, by: me.name, text: `accepted “${task.title}”` });
      await notifyTaskFollowers(store, task, me, `${me.name} accepted “${task.title}”`);
      return send(res, 200, { task: await store.getTask(id) });
    }

    case "POST /api/tasks/:id/updates": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      const id = parts[0];
      const task = await store.getTask(id);
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
      return send(res, 200, { task: await store.getTask(id) });
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
      return send(res, 200, {
        unread,
        chatTotal,
        notifications: notifs.filter((n) => !n.read).length,
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
        if (!message.taskId) return message;
        const task = await store.getTask(message.taskId);
        // Historical/broken task cards fail closed. The surrounding message
        // remains visible, but no inaccessible record identifier is exposed.
        return task && canSeeTask(me, task) ? message : { ...message, taskId: "" };
      }));
      return send(res, 200, {
        messages,
        channel: {
          id: channel.id, name: channel.name, description: channel.description,
          department: channel.department, clientAllowed: channel.clientAllowed,
          autoAll: channel.autoAll,
          members: channel.members.map((m) => ({ username: m.username, muted: m.muted })),
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
      const linkUrl = clean(body.linkUrl, 500);
      const taskId = clean(body.taskId, 30);
      if (taskId && !/^[\w-]+$/.test(taskId)) return send(res, 400, { error: "Invalid task id." });
      if (!text && !linkUrl && !taskId) return send(res, 400, { error: "Message is empty." });
      if (taskId) {
        const task = await store.getTask(taskId);
        if (!task || !canSeeTask(me, task)) return send(res, 404, { error: "Task not found." });
        const audience = (await store.listUsers()).filter((u) => u.active && canAccessChannel(channel, u));
        if (audience.some((u) => !canSeeTask(u, task))) {
          return send(res, 400, { error: "That task is not visible to everyone in this channel." });
        }
      }
      const message = await store.postMessage({
        channelId: channel.id,
        author: me.name,
        authorId: me.username,
        text,
        linkUrl,
        linkTitle: clean(body.linkTitle, 300),
        taskId,
      });
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
      const preview = text ? (text.length > 80 ? text.slice(0, 80) + "…" : text) : (linkUrl ? "shared a link" : "created a task");
      for (const u of recipients) {
        await store.notify({
          username: u.username, kind: "chat",
          text: `${me.name} in #${channel.name}: ${preview}`,
          channelId: channel.id,
        });
      }
      return send(res, 201, { message });
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
      const items = await store.listNotifications(me.username, 30);
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
      const [users, channels] = await Promise.all([store.listUsers(), store.listChannels()]);
      return send(res, 200, { users, channels });
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
      const user = await store.createUser({
        username, name, role, org: clean(body.org, 60) || (role === "client" ? "NEONMONKI" : "Advertidea"),
        active: true, passwordHash: hashPassword(username, password),
      });
      await store.logActivity({ ts: new Date().toISOString(), taskId: null, by: me.name, text: `added user ${name} (${username}, ${role})` });
      return send(res, 201, { user });
    }

    case "PATCH /api/admin/users/:username": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      if (me.role !== "super_admin") return send(res, 403, { error: "Super admin only." });
      const target = await store.getUser(parts[0]);
      if (!target) return send(res, 404, { error: "User not found." });
      const body = await readBody(req);
      const fields = {};
      if ("name" in body) fields.name = clean(body.name, 100) || target.name;
      if ("role" in body) fields.role = oneOf(body.role, ROLES, target.role);
      if ("active" in body) fields.active = !!body.active;
      if (body.password) {
        if (String(body.password).length < 6) return send(res, 400, { error: "Password must be at least 6 characters." });
        fields.passwordHash = hashPassword(target.username, String(body.password));
      }
      // lockout guards
      if (target.username === me.username && (fields.active === false || (fields.role && fields.role !== "super_admin"))) {
        return send(res, 400, { error: "You can't deactivate or demote your own account." });
      }
      if (target.role === "super_admin" && (fields.active === false || (fields.role && fields.role !== "super_admin"))) {
        const admins = (await store.listUsers()).filter((u) => u.role === "super_admin" && u.active);
        if (admins.length <= 1) return send(res, 400, { error: "At least one active super admin is required." });
      }
      const user = await store.updateUser(target.username, fields);
      await store.logActivity({ ts: new Date().toISOString(), taskId: null, by: me.name, text: `updated user ${target.name} (${Object.keys(fields).map((k) => (k === "passwordHash" ? "password" : k)).join(", ")})` });
      return send(res, 200, { user });
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
        return send(res, 400, { error: "This channel doesn't allow client members." });
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
        model: s.model,
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
            channelId: channel.id, author: "NEONMONKI AI", authorId: "ai",
            text: r.answer || "(no answer)",
          });
        }
        return send(res, 200, { answer: r.answer, citations: r.citations, drafts: r.drafts, proposals, model: r.model });
      } catch (e) {
        await store.aiLog({
          username: me.username, kind: "ask", question, status: "error",
          error: e.code === "unconfigured" ? "unconfigured" : "provider",
        });
        const msg = e.code === "unconfigured"
          ? "AI is not configured yet — the super admin needs to set KIMI_API_KEY."
          : "The AI provider couldn't answer right now. Try again in a moment.";
        return send(res, 502, { error: msg });
      }
    }

    case "POST /api/ai/summarize/task/:id": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      const access = await aiPolicy(store, me, "summaries");
      if (!access.allowed) return send(res, access.blocked.status, { error: access.blocked.error });
      const task = await store.getTask(parts[0]);
      if (!task || !canSeeTask(me, task)) return send(res, 404, { error: "Task not found." });

      const citations = [{ type: "task", id: task.id, title: task.title }];
      let ctx = rec("task", task.id,
        `${task.title}\ndepartment: ${task.department} | project: ${task.project}\nowner: ${task.owner} | status: ${task.status} | priority: ${task.priority}\nrequested: ${task.dateRequested} by ${task.requestedBy}${task.dueDate ? " | due " + task.dueDate : ""}\ndescription: ${task.description}\nlatest: ${task.update}\nblocker: ${task.blocker}\ndeliverable: ${task.deliverable} ${task.deliverableLink}\nnext action: ${task.nextAction}\nhistory:\n` +
        (task.updates || []).map((u) => `  - [${String(u.ts).slice(0, 10)}] ${u.by}: ${u.text}`).join("\n"));
      // related discussions: messages mentioning this task id, in channels the user can see
      const channels = accessibleChannels(await store.listChannels(), me);
      for (const c of channels) {
        const msgs = await store.listMessages(c.id, null, 50);
        for (const m of msgs) {
          if (m.text && m.text.includes(task.id)) {
            citations.push({ type: "message", id: m.id, title: `#${c.name}`, channelId: c.id });
            ctx += `\n` + rec("message", m.id, `#${c.name} [${String(m.ts).slice(0, 10)}] ${m.author}: ${m.text.slice(0, 200)}`);
          }
        }
      }
      const linkState = await store.getState();
      const linkChannels = await store.listChannels();
      const links = visibleLinks(linkState.links, me, { tasks: linkState.tasks, channels: linkChannels })
        .filter((l) => l.taskId === task.id);
      for (const l of links) {
        citations.push({ type: "link", id: l.id, title: l.title });
        ctx += `\n` + rec("file", l.id, `${l.title} — ${l.url || "no url"}`);
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
        return send(res, 200, { answer: r.answer, citations: r.citations, model: r.model });
      } catch (e) {
        await store.aiLog({ username: me.username, kind: "task_summary", question: task.id, status: "error", error: e.code || "provider" });
        return send(res, 502, { error: e.code === "unconfigured" ? "AI is not configured yet." : "The AI provider couldn't answer right now." });
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

      const msgs = await store.listMessages(channel.id, null, 40);
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
        return send(res, 200, { answer: r.answer, citations: r.citations, model: r.model });
      } catch (e) {
        await store.aiLog({ username: me.username, kind: "channel_summary", question: channel.id, status: "error", error: e.code || "provider" });
        return send(res, 502, { error: e.code === "unconfigured" ? "AI is not configured yet." : "The AI provider couldn't answer right now." });
      }
    }

    case "POST /api/ai/brief": {
      const me = await getAuth(req, store);
      if (!me) return send(res, 401, { error: "Not signed in." });
      const access = await aiPolicy(store, me, "brief");
      if (!access.allowed) return send(res, access.blocked.status, { error: access.blocked.error });
      const snapshot = await ai.stateSnapshot(store, me);
      const { tasks: allTasks, decisions, activity: rawActivity } = await store.getState();
      // brief context must respect task visibility (activity text contains titles)
      const visibleIds = new Set(visibleTasks(allTasks, me).map((t) => t.id));
      const activity = rawActivity.filter((a) => !a.taskId || visibleIds.has(a.taskId));
      const recentDecisions = decisions.slice(0, 5)
        .map((d) => rec("decision", d.id, `[${d.date}] ${d.topic}: ${d.rule.slice(0, 150)}`)).join("\n");
      const recentActivity = activity.slice(0, 10).map((a) => `- [${String(a.ts).slice(0, 10)}] ${a.by} ${a.text}`).join("\n");
      const audience = me.role === "client"
        ? "Write the client's morning brief: what moved, what is done, what needs the client's decision or review. Plain language, no internal team noise."
        : "Write this person's morning brief: what needs their attention first, what's blocked, what changed recently. Be operational.";
      try {
        const r = await ai.runSummarize(store, me, "daily brief", me.name,
          `${audience}\n\n${snapshot}\n\nRecent decisions:\n${recentDecisions}\n\nRecent activity:\n${recentActivity}`,
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
        return send(res, 200, { answer: r.answer, model: r.model });
      } catch (e) {
        await store.aiLog({ username: me.username, kind: "brief", status: "error", error: e.code || "provider" });
        return send(res, 502, { error: e.code === "unconfigured" ? "AI is not configured yet." : "The AI provider couldn't answer right now." });
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
          tools: ai.allowedToolNames(p.tools),
          inheritsTools: !Array.isArray(p.tools),
          dailyLimit: p.dailyLimit,
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
          model: s.model,
          features: s.features,
          allowClient: s.allowClient,
          dailyLimit: s.dailyLimit,
        },
        configured,
        baseUrl: providerConfig.baseUrl,
        provider: {
          name: "Kimi (Moonshot)",
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
        audit: audit.slice(0, 100),
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
      if ("tools" in body) {
        if (!Array.isArray(body.tools)) return send(res, 400, { error: "Tools must be an array." });
        const tools = ai.allowedToolNames(body.tools);
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
          return send(res, 400, { error: "Kimi API key must be between 12 and 500 characters." });
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
      if ("baseUrl" in body) {
        const baseUrl = String(body.baseUrl || "").replace(/\/$/, "");
        if (!ai.ALLOWED_KIMI_BASE_URLS.includes(baseUrl)) {
          return send(res, 400, { error: "Choose the Kimi China or Global platform endpoint." });
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
        model: settings.model,
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
          model: "kimi-k3",
          provider: { ...(current.provider || {}), baseUrl: result.baseUrl },
          updatedBy: me.username,
        });
        result.configurationUpdated = true;
      }
      await store.aiLog({ username: me.username, kind: "test", status: result.ok ? "ok" : "error", error: result.ok ? "" : result.error });
      return send(res, 200, result);
    }

    default:
      return send(res, 404, { error: "Unknown endpoint." });
  }
}

function publicOf(user) {
  return { username: user.username, role: user.role, name: user.name, org: user.org };
}

// path patterns that hit route() with dynamic segments; key = the switch label
const ROUTE_PATTERNS = [
  { re: /^\/api\/tasks\/([\w-]+)\/accept$/, key: "POST /api/tasks/:id/accept", methods: ["POST"] },
  { re: /^\/api\/tasks\/([\w-]+)\/updates$/, key: "POST /api/tasks/:id/updates", methods: ["POST"] },
  { re: /^\/api\/tasks\/([\w-]+)$/, key: "PATCH /api/tasks/:id", methods: ["PATCH"] },
  { re: /^\/api\/chat\/channels\/([\w-]+)\/messages$/, key: "GET /api/chat/channels/:cid/messages", methods: ["GET"] },
  { re: /^\/api\/chat\/channels\/([\w-]+)\/messages$/, key: "POST /api/chat/channels/:cid/messages", methods: ["POST"] },
  { re: /^\/api\/chat\/channels\/([\w-]+)\/read$/, key: "POST /api/chat/channels/:cid/read", methods: ["POST"] },
  { re: /^\/api\/chat\/channels\/([\w-]+)\/mute$/, key: "POST /api/chat/channels/:cid/mute", methods: ["POST"] },
  { re: /^\/api\/ai\/summarize\/task\/([\w-]+)$/, key: "POST /api/ai/summarize/task/:id", methods: ["POST"] },
  { re: /^\/api\/ai\/summarize\/channel\/([\w-]+)$/, key: "POST /api/ai/summarize/channel/:cid", methods: ["POST"] },
  { re: /^\/api\/ai\/admin\/users\/([\w.-]+)$/, key: "PATCH /api/ai/admin/users/:username", methods: ["PATCH"] },
  { re: /^\/api\/admin\/users\/([\w.-]+)$/, key: "PATCH /api/admin/users/:username", methods: ["PATCH"] },
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
      send(res, 400, { error: "Request body too large (limit 1 MB)." }, { Connection: "close" });
      return true;
    }
    console.error(`[task-hub] ${req.method} ${pathname} failed:`, err);
    send(res, 500, { error: "Server error." });
  }
  return true;
}

module.exports = { handle };
