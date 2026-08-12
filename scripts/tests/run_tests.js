#!/usr/bin/env node
/**
 * Backend test suite — zero dependencies, Node >= 18.
 *
 *   node scripts/tests/run_tests.js
 *
 * Covers:
 *  1. store-json.js unit tests (temp data file — never touches data/data.json)
 *  2. store-supabase.js driver tests with a stubbed global.fetch (no network)
 *  3. End-to-end HTTP tests against a spawned server.js (JSON driver, port 4187)
 *  4. Error-path tests against a server with a broken store (port 4188)
 *
 * Exit code 0 = all green, 1 = failures.
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..", "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nm-task-hub-test-"));
const DATA_FILE = path.join(TMP, "data.json");

let passed = 0;
let failed = 0;
const failures = [];

function ok(cond, name, extra) {
  if (cond) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; failures.push(name); console.log(`FAIL  ${name}${extra ? " — " + extra : ""}`); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ============================ 1. store-json unit ============================ */

async function testStoreJson() {
  console.log("\n[1] store-json unit tests");
  process.env.TASK_HUB_DATA_FILE = DATA_FILE;
  const store = require(path.join(ROOT, "lib", "store-json"));

  // fresh file seeded from seed.json
  const state = await store.getState();
  ok(state.tasks.length === 51, "json: seeds 51 tasks", String(state.tasks.length));
  ok(state.deliverables.length === 19 && state.decisions.length === 11, "json: seeds deliverables/decisions");
  ok(state.recurring.length === 8 && state.team.length === 10 && state.links.length === 42, "json: seeds recurring/team/links");
  ok(state.activity.length === 1 && state.activity[0].by === "system", "json: init activity entry");
  ok(fs.existsSync(DATA_FILE) && !fs.existsSync(DATA_FILE + ".tmp"), "json: atomic save leaves no .tmp");

  // maxIdSuffix: prefix filtering + numeric max (not lexicographic)
  await store.insertTask(mkTask("NM-NEW-009"));
  await store.insertTask(mkTask("NM-NEW-010"));
  const max = await store.maxIdSuffix("tasks", "NM-NEW");
  ok(max === 10, "json: maxIdSuffix numeric max over NM-NEW-*", String(max));
  ok((await store.maxIdSuffix("tasks", "NM-PM")) === 7, "json: maxIdSuffix prefix-isolated (NM-PM seed max 7)");

  // duplicate id rejected
  let dupThrew = false;
  try { await store.insertTask(mkTask("NM-NEW-010")); } catch (e) { dupThrew = /duplicate/i.test(e.message); }
  ok(dupThrew, "json: duplicate task id rejected");

  // update / pushUpdate
  await store.updateTask("NM-NEW-009", { status: "In Progress" });
  ok((await store.getTask("NM-NEW-009")).status === "In Progress", "json: updateTask");
  await store.pushTaskUpdate("NM-NEW-009", { ts: "2026-08-11T00:00:00Z", by: "t", text: "hello" });
  ok((await store.getTask("NM-NEW-009")).updates.length === 1, "json: pushTaskUpdate");

  // activity cap
  for (let i = 0; i < 600; i++) await store.logActivity({ ts: "t" + i, taskId: null, by: "x", text: "e" + i });
  ok(JSON.parse(fs.readFileSync(DATA_FILE, "utf8")).activity.length === 500, "json: activity capped at 500");
  ok((await store.getState()).activity.length === 120, "json: getState activity sliced to 120");

  // per-user AI access + persisted proposal lifecycle
  const inherited = await store.getAiUserPermission("taha");
  ok(inherited.enabled === true && inherited.tools === null && inherited.dailyLimit === null,
    "json: AI user access inherits global defaults");
  const restricted = await store.putAiUserPermission("taha", {
    enabled: true, tools: ["search_tasks"], dailyLimit: 7, updatedBy: "abubakar",
  });
  ok(eq(restricted.tools, ["search_tasks"]) && restricted.dailyLimit === 7,
    "json: AI user access persists tools and daily override");
  const action = await store.aiActionInsert({
    username: "taha", actionType: "task_update",
    payload: { type: "task_update", taskId: "NM-NEW-009", fields: { priority: "Low" } },
  });
  const decided = await store.aiActionUpdate(action.id, {
    status: "executed", modifiedPayload: { fields: { priority: "High" } }, decidedBy: "taha",
  });
  ok(decided.status === "executed" && decided.decidedBy === "taha"
    && decided.modifiedPayload.fields.priority === "High", "json: AI proposal update preserves modified provenance");
  ok((await store.aiActionGet(action.id)).status === "executed", "json: AI proposal is retrievable by id");

  // Control Center provider keys are persisted encrypted and resolve for calls.
  process.env.SESSION_SECRET = "unit-test-session-secret";
  const ai = require(path.join(ROOT, "lib", "ai"));
  const providerPlaintext = "sk-control-center-unit-test-123456";
  const encrypted = ai.encryptApiKey(providerPlaintext);
  await store.putAiSettings({ model: "kimi-k3", provider: { apiKeyEncrypted: encrypted } });
  const providerSettings = await store.getAiSettings();
  ok(providerSettings.model === "kimi-k3" && providerSettings.provider.apiKeyEncrypted === encrypted,
    "json: AI provider settings persist");
  ok(ai.providerConfig(providerSettings).apiKey === providerPlaintext,
    "json: encrypted AI provider key resolves server-side");
  ok(!fs.readFileSync(DATA_FILE, "utf8").includes(providerPlaintext),
    "json: AI provider key is never stored as plaintext");

  const realProviderFetch = global.fetch;
  const testedEndpoints = [];
  global.fetch = async (url) => {
    testedEndpoints.push(url);
    if (url.startsWith(ai.GLOBAL_KIMI_BASE_URL)) {
      return { ok: false, status: 401, statusText: "Unauthorized", json: async () => ({}) };
    }
    if (url.endsWith("/models")) {
      return { ok: true, status: 200, json: async () => ({ data: [{ id: "kimi-k3" }] }) };
    }
    return { ok: true, status: 200, json: async () => ({ data: { available_balance: 88 } }) };
  };
  try {
    const detected = await ai.testConnection({ getAiSettings: async () => ({
      model: "kimi-k2.6",
      provider: { apiKeyEncrypted: encrypted, baseUrl: ai.GLOBAL_KIMI_BASE_URL },
    }) });
    ok(detected.ok && detected.autoDetected && detected.baseUrl === ai.CHINA_KIMI_BASE_URL
      && detected.modelsAvailable.includes("kimi-k3"),
      "json: AI connection detects a China key rejected by Global");
    ok(testedEndpoints.some((u) => u.startsWith(ai.GLOBAL_KIMI_BASE_URL))
      && testedEndpoints.some((u) => u.startsWith(ai.CHINA_KIMI_BASE_URL)),
      "json: AI endpoint detection probes Global then China once");
  } finally {
    global.fetch = realProviderFetch;
  }
}

function mkTask(id) {
  return {
    id, title: "t " + id, dateRequested: "2026-08-11", department: "", project: "",
    description: "", requestedBy: "", owner: "", supporting: "", priority: "Medium",
    status: "Planned", evidence: "", update: "", blocker: "", deliverable: "",
    deliverableLink: "", nextAction: "", dueDate: "", source: "test", updates: [],
  };
}

/* ========================= 2. store-supabase driver ========================= */

function testStoreSupabase() {
  return new Promise((resolveAll) => {
    const realFetch = global.fetch;
    const restore = () => { global.fetch = realFetch; };
    (async () => {
      console.log("\n[2] store-supabase driver tests (fetch stubbed)");
      process.env.SUPABASE_URL = "https://unit-test.supabase.co";
      process.env.SUPABASE_SERVICE_ROLE_KEY = "unit-test-key";
      const store = require(path.join(ROOT, "lib", "store-supabase"));
      const { _internals } = store;

      const calls = [];
      let queue = [];
      const respond = (rows, status = 200) => queue.push({ rows, status });
      const realFetch = global.fetch;
      const restore = () => { global.fetch = realFetch; };
      global.fetch = async (url, opts = {}) => {
        calls.push({ url, method: opts.method || "GET", headers: opts.headers || {}, body: opts.body ? JSON.parse(opts.body) : undefined });
        const r = queue.shift() || { rows: [], status: 200 };
        return {
          ok: r.status >= 200 && r.status < 300,
          status: r.status,
          text: async () => (r.status === 204 ? "" : JSON.stringify(r.rows)),
        };
      };

      /* --- fresh Supabase bootstrap preserves department assignments --- */
      respond([]); // no users yet -> bootstrap all defaults
      await store.getUserWithHash("nobody");
      const seededTaha = calls.find((c) => c.method === "POST" && c.url.includes("/users") && c.body.username === "taha");
      ok(seededTaha && eq(seededTaha.body.departments, ["Paid Marketing", "Conversion Tracking", "Data Analytics"]),
        "sb: fresh bootstrap writes user departments");

      /* --- mapping round-trip --- */
      const task = mkTask("NM-NEW-001");
      task.owner = "Hafeez"; task.priority = "High"; task.dueDate = ""; task.dateRequested = "";
      const row = _internals.taskToRow(task);
      ok(row.date_requested === null, "sb: empty dateRequested -> null (date col would reject \"\")");
      ok(row.due_date === null, "sb: empty dueDate -> null");
      const back = _internals.rowToTask({ ...row, date_requested: "2026-08-01", latest_update: "u1" });
      ok(back.dateRequested === "2026-08-01" && back.update === "u1" && back.owner === "Hafeez", "sb: rowToTask maps snake->camel");
      ok(eq(Object.keys(back.updates), []) && back.updates.length === 0, "sb: rowToTask updates empty");

      /* --- updateTask must PATCH only the given fields (regression: full-row wipe) --- */
      respond([{ id: "NM-NEW-001" }]);           // PATCH return=representation
      respond([{ id: "NM-NEW-001", title: "keep me" }]); // getTask tasks select
      respond([]);                                // getTask task_updates select
      await store.updateTask("NM-NEW-001", { status: "Completed", update: "done" });
      const patch = calls.find((c) => c.method === "PATCH");
      ok(!!patch, "sb: updateTask issues PATCH");
      ok(patch && eq(Object.keys(patch.body).sort(), ["latest_update", "status"]),
        "sb: PATCH body contains ONLY mapped fields", patch && JSON.stringify(patch.body));
      ok(patch && patch.url.includes("id=eq.NM-NEW-001"), "sb: PATCH filtered by id");
      ok(patch && patch.headers.Prefer === "return=representation", "sb: PATCH asks representation");

      /* --- maxIdSuffix: numeric, not lexicographic, and like-pattern encoded --- */
      respond([{ id: "NM-NEW-998" }, { id: "NM-NEW-1000" }, { id: "NM-NEW-999" }]);
      const max = await store.maxIdSuffix("tasks", "NM-NEW");
      ok(max === 1000, "sb: maxIdSuffix numeric (not lexicographic 999)", String(max));
      const maxCall = calls[calls.length - 1];
      ok(/like\.NM-NEW-\*/.test(maxCall.url), "sb: maxIdSuffix uses like prefix-*", maxCall.url);

      /* --- getState: deterministic order + mapping --- */
      respond([{ id: "NM-PM-001", title: "A", created_at: "2026-01-01T00:00:00Z" },
               { id: "NM-PM-002", title: "B", created_at: "2026-01-02T00:00:00Z" }]); // tasks
      respond([{ task_id: "NM-PM-001", ts: "2026-01-03T00:00:00Z", author: "x", text: "u", status_from: "a", status_to: "b" }]); // updates
      respond([{ id: "DEL-001" }]); // deliverables
      respond([{ id: "DEC-001" }]); // decisions
      respond([{ id: "REC-001" }]); // recurring
      respond([{ id: 1 }, { id: 2 }]); // team
      respond([{ id: "LNK-001" }]); // links
      respond([{ ts: "2026-01-04T00:00:00Z", task_id: "NM-PM-001", author: "y", text: "act" }]); // activity
      const gsStart = calls.length;
      const state = await store.getState();
      const gsCalls = calls.slice(gsStart);
      const taskQ = gsCalls.find((c) => c.url.includes("/tasks?"));
      ok(taskQ && /order=/.test(taskQ.url), "sb: getState tasks has explicit order (no reliance on heap order)", taskQ && taskQ.url);
      const teamQ = gsCalls.find((c) => c.url.includes("/team?"));
      ok(teamQ && /order=id\.asc/.test(teamQ.url), "sb: team ordered id.asc", teamQ && teamQ.url);
      const actQ = gsCalls.find((c) => c.url.includes("/activity?"));
      ok(actQ && /order=ts\.desc/.test(actQ.url) && /limit=120/.test(actQ.url), "sb: activity ts.desc limit 120", actQ && actQ.url);
      ok(state.tasks.length === 2 && state.tasks[0].id === "NM-PM-001", "sb: tasks not reversed vs DB order");
      ok(state.tasks[0].updates.length === 1, "sb: updates attached to tasks");
      ok(state.tasks[0].updates[0].statusFrom === "a" && state.tasks[0].updates[0].statusTo === "b", "sb: rowToUpdate status fields");
      ok(state.activity[0].by === "y" && state.activity[0].taskId === "NM-PM-001", "sb: activity mapped");

      /* --- insertTask: row insert first, then task_updates (FK order), Prefer header --- */
      respond([_internals.taskToRow(mkTask("NM-NEW-005"))]); // POST tasks
      respond([{ id: 1 }]); // POST task_updates
      const t5 = mkTask("NM-NEW-005");
      t5.updates = [{ ts: "2026-08-11T00:00:00Z", by: "Adika", text: "req" }];
      await store.insertTask(t5);
      const postTask = calls.find((c) => c.method === "POST" && c.url.includes("/tasks"));
      const postUpd = calls.find((c) => c.method === "POST" && c.url.includes("/task_updates"));
      ok(postTask && postTask.body.id === "NM-NEW-005", "sb: insertTask posts row");
      ok(postTask && postTask.headers.Prefer === "return=representation", "sb: insert returns representation");
      ok(postUpd && postUpd.body.task_id === "NM-NEW-005" && postUpd.body.author === "Adika", "sb: update inserted after task (FK)");
      ok(postUpd && "status_from" in postUpd.body && postUpd.body.status_from === null, "sb: status_from null when absent");

      /* --- insertRow / logActivity mapping --- */
      respond([{ id: "LNK-100" }]);
      await store.insertRow("links", { id: "LNK-100", taskId: "NM-PM-001", date: "2026-08-11", title: "doc", url: "u", type: "t", owner: "o", note: "n", workstream: "w" });
      const linkCall = calls[calls.length - 1];
      ok(linkCall.body.task_id === "NM-PM-001" && linkCall.body.title === "doc", "sb: insertRow links camel->snake");
      respond([{ id: 9 }]);
      await store.logActivity({ ts: "2026-08-11T00:00:00Z", taskId: null, by: "Adika", text: "x" });
      ok(calls[calls.length - 1].body.task_id === null, "sb: activity task_id null (text col, nullable)");
      let threw = false;
      try { await store.insertRow("nope", {}); } catch (e) { threw = true; }
      ok(threw, "sb: insertRow unknown collection throws");

      /* --- req() error + 204 handling --- */
      queue.push({ rows: { message: "boom" }, status: 409 });
      let errMsg = "";
      try { await _internals.req("POST", "tasks", { body: {} }); } catch (e) { errMsg = e.message; }
      ok(/409/.test(errMsg), "sb: req throws with status on !ok", errMsg.slice(0, 60));
      queue.push({ rows: null, status: 204 });
      ok((await _internals.req("DELETE", "team", { query: "id=gt.0" })) === null, "sb: 204 -> null");

      /* --- AI permission + approval provenance mappings --- */
      respond([{ username: "taha", enabled: true, tools: ["search_tasks"], daily_limit: 5, updated_by: "abubakar" }]);
      const aiPerm = await store.putAiUserPermission("taha", { tools: ["search_tasks"], dailyLimit: 5, updatedBy: "abubakar" });
      ok(eq(aiPerm.tools, ["search_tasks"]) && aiPerm.dailyLimit === 5,
        "sb: AI user permission round-trips PostgREST fields");
      respond([{ id: 9 }]);
      respond([{ id: 9, username: "taha", action_type: "task_update", payload: {}, modified_payload: { fields: { priority: "Low" } }, execution_result: { taskId: "NM-TRK-007" }, status: "executed", decided_by: "taha" }]);
      const aiAction = await store.aiActionUpdate(9, {
        status: "executed", modifiedPayload: { fields: { priority: "Low" } },
        executionResult: { taskId: "NM-TRK-007" }, decidedBy: "taha",
      });
      ok(aiAction.status === "executed" && aiAction.modifiedPayload.fields.priority === "Low"
        && aiAction.executionResult.taskId === "NM-TRK-007", "sb: AI proposal provenance round-trips PostgREST fields");

      /* --- migration-003 compatibility until production applies 005 --- */
      respond({ message: "table missing" }, 404);
      respond([{ id: 1, enabled: true, features: { ask: true, __userPermissions: {
        taha: { enabled: false, tools: ["search_tasks"], dailyLimit: 3, updatedBy: "abubakar" },
      } } }]);
      const legacyPerm = await store.getAiUserPermission("taha");
      ok(legacyPerm.enabled === false && legacyPerm.dailyLimit === 3 && eq(legacyPerm.tools, ["search_tasks"]),
        "sb: pre-005 AI user permission reads from server-only settings fallback");

      respond({ message: "table missing" }, 404); // new permission table POST
      respond([{ id: 1, enabled: true, features: { ask: true, __userPermissions: {} } }]); // fallback get
      respond([{ id: 1, enabled: true, features: { ask: true, __userPermissions: {} } }]); // put reads current
      respond([], 201); // settings upsert
      respond([{ id: 1, enabled: true, features: { ask: true, __userPermissions: {
        taha: { enabled: true, tools: ["search_tasks"], dailyLimit: 4 },
      } } }]); // put read-back
      const legacySaved = await store.putAiUserPermission("taha", { enabled: true, tools: ["search_tasks"], dailyLimit: 4 });
      ok(legacySaved.dailyLimit === 4 && eq(legacySaved.tools, ["search_tasks"]),
        "sb: pre-005 AI user permission persists in settings fallback");

      const legacyMeta = "__nm_action_meta__:" + JSON.stringify({
        note: "human correction", modifiedPayload: { fields: { priority: "High" } },
        executionResult: { taskId: "NM-TRK-007" }, updatedAt: "2026-08-13T00:00:00Z",
      });
      respond({ message: "columns missing" }, 400); // dedicated-column PATCH
      respond([{ id: 10 }]); // fallback PATCH
      respond([{ id: 10, ts: "2026-08-13T00:00:00Z", username: "taha", action_type: "task_update", payload: {}, status: "executed", decided_by: "taha", note: legacyMeta }]);
      const legacyAction = await store.aiActionUpdate(10, {
        status: "executed", modifiedPayload: { fields: { priority: "High" } },
        executionResult: { taskId: "NM-TRK-007" }, decidedBy: "taha", note: "human correction",
      });
      ok(legacyAction.note === "human correction" && legacyAction.modifiedPayload.fields.priority === "High"
        && legacyAction.executionResult.taskId === "NM-TRK-007", "sb: pre-005 proposal provenance uses structured note fallback");

      /* --- auth headers on every call --- */
      ok(calls.every((c) => c.headers.apikey === "unit-test-key" && c.headers.Authorization === "Bearer unit-test-key"),
        "sb: apikey + Authorization headers on all calls");

      delete process.env.SUPABASE_URL;
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      restore();
      resolveAll();
    })().catch((e) => { ok(false, "sb: suite crashed", e.message); restore(); resolveAll(); });
  });
}

/* ========================= 3. HTTP end-to-end ========================= */

function startServer(port, dataFile) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
      env: { PATH: process.env.PATH, PORT: String(port), TASK_HUB_DATA_FILE: dataFile },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => { out += d; if (out.includes("http://localhost")) resolve(child); });
    child.stderr.on("data", (d) => process.stderr.write(`[server:${port}] ${d}`));
    child.on("exit", (code) => { if (!out.includes("http://localhost")) reject(new Error("server exited early, code " + code)); });
    setTimeout(() => reject(new Error("server start timeout")), 8000);
  });
}

async function http(port, method, p, { body, cookie } = {}) {
  const res = await fetch(`http://localhost:${port}${p}`, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body !== undefined ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
    redirect: "manual",
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* text */ }
  return { status: res.status, json, text, headers: res.headers };
}

const cookieOf = (r) => (r.headers.get("set-cookie") || "").split(";")[0];

async function login(port, username, password) {
  const r = await http(port, "POST", "/api/login", { body: { username, password } });
  return { r, cookie: cookieOf(r) };
}

async function testHttp() {
  console.log("\n[3] HTTP end-to-end (JSON driver, port 4187)");
  const port = 4187;
  const server = await startServer(port, path.join(TMP, "e2e.json"));
  try {
    /* --- auth --- */
    const t0 = Date.now();
    const bad = await http(port, "POST", "/api/login", { body: { username: "adika", password: "wrong" } });
    ok(bad.status === 401 && bad.json.error === "Invalid username or password.", "http: bad login -> 401 uniform msg");
    ok(Date.now() - t0 >= 350, "http: failed login delayed (>=350ms)", (Date.now() - t0) + "ms");
    const noUser = await http(port, "POST", "/api/login", { body: { username: "nosuch", password: "x" } });
    ok(noUser.status === 401 && eq(noUser.json, bad.json), "http: unknown user indistinguishable from bad password");

    const { r: lr, cookie } = await login(port, "adika", "neonmonki2026");
    ok(lr.status === 200 && lr.json.user.role === "client", "http: client login");
    const sc = lr.headers.get("set-cookie") || "";
    ok(/HttpOnly/.test(sc) && /SameSite=Lax/.test(sc) && /Path=\//.test(sc), "http: cookie flags HttpOnly/SameSite=Lax/Path");
    const teamLogin = await login(port, "advertidea", "advertidea2026");
    const tcookie = teamLogin.cookie;
    ok(teamLogin.r.status === 200 && teamLogin.r.json.user.role === "team", "http: team login");
    const acookie = (await login(port, "abubakar", "NM-admin-2026")).cookie;

    ok((await http(port, "GET", "/api/me")).status === 401, "http: /api/me anonymous -> 401");
    ok((await http(port, "GET", "/api/me", { cookie })).json.user.username === "adika", "http: /api/me with cookie");

    // forged / expired / malformed tokens
    const payload = Buffer.from(JSON.stringify({ u: "adika", r: "client", n: "Adika", o: "NEONMONKI", exp: Date.now() + 1e5 })).toString("base64url");
    const forged = `nm_session=${payload}.${crypto.randomBytes(32).toString("base64url")}`;
    ok((await http(port, "GET", "/api/me", { cookie: forged })).status === 401, "http: forged signature -> 401");
    const expPayload = Buffer.from(JSON.stringify({ u: "adika", r: "client", n: "Adika", o: "NEONMONKI", exp: Date.now() - 1e5 })).toString("base64url");
    const expSig = crypto.createHmac("sha256", "nm-task-hub-dev-secret").update(expPayload).digest("base64url");
    ok((await http(port, "GET", "/api/me", { cookie: `nm_session=${expPayload}.${expSig}` })).status === 401, "http: expired token -> 401");
    const roleForgePayload = Buffer.from(JSON.stringify({ u: "adika", r: "team", n: "Adika", o: "X", exp: Date.now() + 1e5 })).toString("base64url");
    const roleForgeSig = crypto.createHmac("sha256", "wrong-secret").update(roleForgePayload).digest("base64url");
    ok((await http(port, "GET", "/api/me", { cookie: `nm_session=${roleForgePayload}.${roleForgeSig}` })).status === 401, "http: role-forged token (wrong secret) -> 401");
    ok((await http(port, "GET", "/api/me", { cookie: "nm_session=!!garbage!!" })).status === 401, "http: malformed cookie -> 401");

    const lo = await http(port, "POST", "/api/logout", {});
    ok(lo.status === 200 && /Max-Age=0/.test(lo.headers.get("set-cookie") || ""), "http: logout clears cookie");

    /* --- state --- */
    const st = (await http(port, "GET", "/api/state", { cookie })).json;
    ok(st.tasks.length === 46 && st.meta.statuses.length === 12 && st.meta.priorities.length === 4, "http: /api/state shape (client sees only shared tasks)");
    const stAdmin = (await http(port, "GET", "/api/state", { cookie: acookie })).json;
    ok(stAdmin.tasks.length === 51, "http: /api/state shape (admin sees all 51 incl. internal)");
    ok((await http(port, "GET", "/api/state")).status === 401, "http: /api/state anonymous -> 401");

    /* --- task creation rules --- */
    const mk = await http(port, "POST", "/api/tasks", { cookie, body: { title: "Client request", status: "Completed", requestedBy: "Mallory", priority: "Critical" } });
    ok(mk.status === 201 && mk.json.task.status === "New Request", "http: client task forced to New Request");
    ok(mk.json.task.requestedBy === "Adika", "http: client requestedBy forced to own name");
    ok(mk.json.task.priority === "Critical", "http: priority honoured");
    const newId = mk.json.task.id;
    ok(/^NM-NEW-\d{3}$/.test(newId), "http: new id format NM-NEW-###", newId);

    const noTitle = await http(port, "POST", "/api/tasks", { cookie: tcookie, body: { title: "   " } });
    ok(noTitle.status === 400, "http: blank title -> 400");
    const teamTask = await http(port, "POST", "/api/tasks", { cookie: tcookie, body: { title: "Team task", status: "In Progress", priority: "Bogus" } });
    ok(teamTask.json.task.status === "In Progress" && teamTask.json.task.priority === "Medium", "http: team picks status, bogus priority falls back");

    /* --- role matrix: accept --- */
    const accClient = await http(port, "POST", `/api/tasks/${newId}/accept`, { cookie, body: {} });
    ok(accClient.status === 403, "http: client accept -> 403");
    ok((await http(port, "POST", `/api/tasks/${newId}/accept`, { body: {} })).status === 401, "http: anon accept -> 401");
    const acc = await http(port, "POST", `/api/tasks/${newId}/accept`, { cookie: tcookie, body: { owner: "Hafeez" } });
    ok(acc.status === 200 && acc.json.task.status === "In Progress" && acc.json.task.owner === "Hafeez", "http: team accept -> In Progress + owner");
    ok(acc.json.task.updates.some((u) => u.statusFrom === "New Request" && u.statusTo === "In Progress"), "http: accept logs status transition");
    ok((await http(port, "POST", `/api/tasks/${newId}/accept`, { cookie: tcookie, body: {} })).status === 409, "http: re-accept -> 409");

    /* --- PATCH --- */
    // team can move anything
    const patch = await http(port, "PATCH", `/api/tasks/${newId}`, { cookie: tcookie, body: { status: "Ready for Review", update: "latest!" } });
    ok(patch.status === 200 && patch.json.task.status === "Ready for Review" && patch.json.task.update === "latest!", "http: PATCH status+update");
    ok(patch.json.task.updates.some((u) => u.statusFrom === "In Progress" && u.statusTo === "Ready for Review"), "http: PATCH logs status change");
    ok(patch.json.task.updates.some((u) => /Edited task details: update/.test(u.text)), "http: PATCH logs field edit");
    ok((await http(port, "PATCH", `/api/tasks/${newId}`, { cookie: tcookie, body: { status: "Nope" } })).status === 400, "http: PATCH bogus status -> 400");
    ok((await http(port, "PATCH", "/api/tasks/NM-NOPE-999", { cookie: tcookie, body: { status: "Completed" } })).status === 404, "http: PATCH missing task -> 404");
    const keepPrio = await http(port, "PATCH", `/api/tasks/${newId}`, { cookie: tcookie, body: { priority: "Ultra" } });
    ok(keepPrio.json.task.priority === "Critical", "http: PATCH bogus priority keeps current");
    // client role rules: only the review handshake transitions + edits to own untouched request
    ok((await http(port, "PATCH", `/api/tasks/${newId}`, { cookie, body: { status: "In Progress" } })).status === 403, "http: client arbitrary status -> 403");
    ok((await http(port, "PATCH", `/api/tasks/${newId}`, { cookie, body: { title: "hijacked" } })).status === 403, "http: client field edit after handover -> 403");
    const mk2 = await http(port, "POST", "/api/tasks", { cookie, body: { title: "Client draft" } });
    ok((await http(port, "PATCH", `/api/tasks/${mk2.json.task.id}`, { cookie, body: { title: "Client draft v2", priority: "Critical" } })).status === 200,
      "http: client edits own New Request");
    const done = await http(port, "PATCH", `/api/tasks/${newId}`, { cookie, body: { status: "Completed" } });
    ok(done.status === 200 && done.json.task.status === "Completed", "http: client confirm Completed");
    ok((await http(port, "PATCH", `/api/tasks/${newId}`, { cookie, body: { status: "Cancelled" } })).status === 403, "http: client cancel -> 403");

    /* --- updates --- */
    const upd = await http(port, "POST", `/api/tasks/${newId}/updates`, { cookie: tcookie, body: { text: "progress note" } });
    ok(upd.status === 200 && upd.json.task.update === "progress note", "http: team update sets latest");
    ok((await http(port, "POST", `/api/tasks/${newId}/updates`, { cookie, body: { text: "" } })).status === 400, "http: empty update -> 400");
    ok((await http(port, "POST", `/api/tasks/${newId}/updates`, { cookie: tcookie, body: { status: "Revision Required" } })).status === 200, "http: team status-only update allowed");
    ok((await http(port, "POST", `/api/tasks/${newId}/updates`, { cookie, body: { status: "In Progress" } })).status === 403, "http: client status-only outside handshake -> 403");
    const updS = await http(port, "POST", `/api/tasks/${newId}/updates`, { cookie: tcookie, body: { text: "back to review", status: "Ready for Review" } });
    ok(updS.status === 200 && updS.json.task.status === "Ready for Review", "http: team update+status in one call");
    const updC = await http(port, "POST", `/api/tasks/${newId}/updates`, { cookie, body: { status: "Revision Required" } });
    ok(updC.status === 200 && updC.json.task.status === "Revision Required", "http: client bounce via update allowed");

    /* --- concurrent id allocation --- */
    const [c1, c2] = await Promise.all([
      http(port, "POST", "/api/tasks", { cookie: tcookie, body: { title: "race A" } }),
      http(port, "POST", "/api/tasks", { cookie: tcookie, body: { title: "race B" } }),
    ]);
    ok(c1.status === 201 && c2.status === 201 && c1.json.task.id !== c2.json.task.id,
      "http: concurrent creates get unique ids", `${c1.json.task && c1.json.task.id} vs ${c2.json.task && c2.json.task.id}`);

    /* --- deliverables / decisions / links role matrix --- */
    ok((await http(port, "POST", "/api/deliverables", { cookie, body: { title: "x" } })).status === 403, "http: client deliverable -> 403");
    const del = await http(port, "POST", "/api/deliverables", { cookie: tcookie, body: { title: "Report", link: "https://x" } });
    ok(del.status === 201 && /^DEL-\d{3}$/.test(del.json.item.id) && del.json.item.recipient === "Adika", "http: team deliverable -> 201 DEL-###", del.json.item && del.json.item.id);
    ok((await http(port, "POST", "/api/deliverables", { cookie: tcookie, body: {} })).status === 400, "http: deliverable w/o title -> 400");
    const dec = await http(port, "POST", "/api/decisions", { cookie, body: { rule: "Client decides", topic: "T" } });
    ok(dec.status === 201 && /^DEC-\d{3}$/.test(dec.json.item.id), "http: client decision allowed -> DEC-###", dec.json.item && dec.json.item.id);
    ok((await http(port, "POST", "/api/decisions", { cookie, body: {} })).status === 400, "http: decision w/o rule -> 400");
    const lnk = await http(port, "POST", "/api/links", { cookie: tcookie, body: { title: "Doc", url: "https://x", taskId: newId } });
    ok(lnk.status === 201 && /^LNK-\d{3}$/.test(lnk.json.item.id), "http: link -> LNK-###", lnk.json.item && lnk.json.item.id);

    /* --- input hygiene --- */
    const longTitle = "x".repeat(5000);
    const lt = await http(port, "POST", "/api/tasks", { cookie, body: { title: longTitle, description: longTitle } });
    ok(lt.json.task.title.length === 300 && lt.json.task.description.length === 4000, "http: length caps enforced");
    const badJson = await http(port, "POST", "/api/tasks", { cookie, body: "{not json" });
    ok(badJson.status === 400, "http: invalid JSON -> 400");
    const big = await http(port, "POST", "/api/tasks", { cookie, body: { title: "big", description: "x".repeat(1_100_000) } });
    ok(big.status === 400, "http: >1MB body -> 400", String(big.status));

    /* --- routing edge cases --- */
    ok((await http(port, "GET", "/api/nothing", { cookie })).status === 404, "http: unknown endpoint -> 404");
    ok((await http(port, "GET", "/api/tasks", { cookie })).status === 404, "http: GET /api/tasks -> 404");
    ok((await http(port, "POST", `/api/tasks/${newId}/explode`, { cookie, body: {} })).status === 404, "http: unknown sub-route -> 404");
    ok((await http(port, "DELETE", `/api/tasks/${newId}`, { cookie })).status === 404, "http: DELETE task -> 404");
    ok((await http(port, "POST", "/api/login/", { body: { username: "adika", password: "neonmonki2026" } })).status === 200, "http: trailing slash tolerated");

    /* --- static + traversal (dev server) --- */
    ok((await http(port, "GET", "/")).status === 200, "http: static index");
    const browserBundle = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
    ok(browserBundle.includes("dashboardFilter(kind)") && browserBundle.includes("App.dashboardFilter"),
      "ui: dashboard KPI cards drive task filters");
    ok(browserBundle.includes('<option value="">Everyone</option>') && browserBundle.includes("f.owner"),
      "ui: task list provides an Everyone owner filter");
    // fetch/undici normalizes %2e%2e client-side, so send a raw socket request
    // with a literal ".." path to actually exercise the server-side guard.
    const rawGet = (rawPath) => new Promise((resolveRaw) => {
      const sock = require("net").connect(port, "127.0.0.1", () => {
        sock.write(`GET ${rawPath} HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: close\r\n\r\n`);
      });
      let buf = "";
      sock.on("data", (d) => { buf += d; });
      sock.on("end", () => resolveRaw(Number((buf.match(/^HTTP\/1\.1 (\d+)/) || [])[1] || 0)));
      sock.on("error", () => resolveRaw(0));
    });
    ok((await rawGet("/../seed.json")) === 403, "http: raw ../ traversal blocked");
    ok((await rawGet("/%2e%2e/seed.json")) === 403, "http: encoded traversal blocked");
    ok((await rawGet("/..%2f..%2fserver.js")) === 403, "http: mixed-encoded traversal blocked");
    const badUri = await http(port, "GET", "/%");
    ok(badUri.status === 400, "http: malformed percent-encoding -> 400 (no crash)", String(badUri.status));

    /* --- security headers on API --- */
    const hdrs = await http(port, "GET", "/api/me", { cookie });
    ok(hdrs.headers.get("x-content-type-options") === "nosniff", "http: nosniff header");
    ok(/no-store/.test(hdrs.headers.get("cache-control") || ""), "http: API Cache-Control no-store");

    ok(server.exitCode === null, "http: server still alive at end of suite");
  } finally {
    server.kill();
  }
}

/* ========================= 4. error-path hygiene ========================= */

async function testErrorPaths() {
  console.log("\n[4] store-failure error hygiene (port 4188, broken data path)");
  const port = 4188;
  const badDir = path.join(TMP, "no-such-dir", "data.json"); // parent dir does not exist -> save() throws
  const server = await startServer(port, badDir);
  try {
    // with a broken store even login hits the store (users are DB-backed) —
    // the hygiene requirement is the same: a generic 500, no internals leaked.
    const r = await http(port, "POST", "/api/login", { body: { username: "adika", password: "neonmonki2026" } });
    ok(r.status === 500, "err: store failure -> 500", String(r.status));
    ok(r.json && r.json.error === "Server error.", "err: 500 body is generic (no fs path / stack leak)", r.text.slice(0, 120));
    ok(!/ENOENT|\/Users\/|at\s/.test(r.text), "err: 500 leaks no internals", r.text.slice(0, 120));
  } finally {
    server.kill();
  }
}

/* ========================= 5. chat + admin end-to-end ========================= */

async function testChat() {
  console.log("\n[5] chat + admin (port 4189, fresh temp data)");
  const port = 4189;
  const server = await startServer(port, path.join(TMP, "chat-data.json"));
  try {
    const { cookie: admin } = await login(port, "abubakar", "NM-admin-2026");
    const { cookie: taha } = await login(port, "taha", "NM-taha-2026");
    const { cookie: client } = await login(port, "adika", "neonmonki2026");
    ok(admin && taha && client, "chat: all three roles log in");

    // channel visibility
    const adminCh = (await http(port, "GET", "/api/chat/channels", { cookie: admin })).json.channels;
    ok(adminCh.length === 8, "chat: admin sees all 8 seeded channels", String(adminCh.length));
    const clientCh = (await http(port, "GET", "/api/chat/channels", { cookie: client })).json.channels;
    ok(eq(clientCh.map((c) => c.id).sort(), ["general", "strategies-planning"]), "chat: client sees general + strategies only");

    // access control
    ok((await http(port, "GET", "/api/chat/channels/google-ads/messages", { cookie: client })).status === 403, "chat: client reads team channel -> 403");
    ok((await http(port, "POST", "/api/chat/channels/google-ads/messages", { cookie: client, body: { text: "hi" } })).status === 403, "chat: client posts to team channel -> 403");
    ok((await http(port, "POST", "/api/chat/channels/general/messages", { cookie: client, body: { taskId: "NM-AI-001" } })).status === 404,
      "vis: client cannot post an internal task card");
    ok((await http(port, "POST", "/api/chat/channels/general/messages", { cookie: admin, body: { taskId: "NM-AI-001" } })).status === 400,
      "vis: admin cannot expose an internal task card to a client-visible channel");

    // post + unread + notify member
    const msg = await http(port, "POST", "/api/chat/channels/google-ads/messages", { cookie: taha, body: { text: "campaign ready" } });
    ok(msg.status === 201 && msg.json.message.author === "Taha" && msg.json.message.authorId === "taha", "chat: team posts message");
    const pulse1 = (await http(port, "GET", "/api/chat/pulse", { cookie: admin })).json;
    ok(pulse1.unread["google-ads"] === 1 && pulse1.chatTotal === 1, "chat: admin pulse shows 1 unread");
    const haf = (await login(port, "hafeez", "NM-hafeez-2026")).cookie;
    const notifs = (await http(port, "GET", "/api/notifications", { cookie: haf })).json.items;
    ok(notifs.length === 1 && notifs[0].kind === "chat" && /Taha in #Google Ads/.test(notifs[0].text), "chat: member got chat notification");

    // mute suppresses notifications
    await http(port, "POST", "/api/chat/channels/google-ads/mute", { cookie: haf, body: { muted: true } });
    await http(port, "POST", "/api/chat/channels/google-ads/messages", { cookie: taha, body: { text: "second" } });
    const notifs2 = (await http(port, "GET", "/api/notifications", { cookie: haf })).json.items;
    ok(notifs2.length === 1, "chat: muted channel sends no new notification");

    // read clears unread
    await http(port, "POST", "/api/chat/channels/google-ads/read", { cookie: admin, body: {} });
    ok((await http(port, "GET", "/api/chat/pulse", { cookie: admin })).json.unread["google-ads"] === 0, "chat: read clears unread");

    // link shared in chat lands in the channel's file folder
    await http(port, "POST", "/api/chat/channels/google-ads/messages", { cookie: taha, body: { text: "spec", linkUrl: "https://docs.google.com/x", linkTitle: "Spec" } });
    const links = (await http(port, "GET", "/api/state", { cookie: admin })).json.links;
    ok(links.some((l) => l.channelId === "google-ads" && l.title === "Spec"), "chat: link filed into channel folder");
    const clientLinks = (await http(port, "GET", "/api/state", { cookie: client })).json.links;
    ok(!clientLinks.some((l) => l.title === "Spec"), "vis: client state hides team-channel files");
    ok(!clientLinks.some((l) => ["LNK-032", "LNK-033", "LNK-034"].includes(l.id)),
      "vis: client state hides files attached to internal tasks");
    ok(clientLinks.some((l) => l.id === "LNK-001"), "vis: client state keeps files attached to shared tasks");
    const { cookie: munsifLinkC } = await login(port, "munsif", "NM-munsif-2026");
    ok(!(await http(port, "GET", "/api/state", { cookie: munsifLinkC })).json.links.some((l) => l.title === "Spec"),
      "vis: non-member team user state hides another channel's files");
    ok((await http(port, "POST", "/api/links", { cookie: client, body: { title: "blocked internal", taskId: "NM-AI-001" } })).status === 404,
      "vis: client cannot attach a file to an invisible task");
    ok((await http(port, "POST", "/api/links", { cookie: munsifLinkC, body: { title: "blocked channel", channelId: "google-ads" } })).status === 403,
      "vis: non-member cannot attach a file to another channel");
    const scopedLink = await http(port, "POST", "/api/links", { cookie: taha, body: {
      title: "Task and channel scope", taskId: "NM-TRK-007", channelId: "google-ads",
    } });
    ok(scopedLink.status === 201 && !(await http(port, "GET", "/api/state", { cookie: client })).json.links.some((l) => l.id === scopedLink.json.item.id),
      "vis: a file declaring two scopes must pass both visibility checks");

    // task-from-chat echo
    const task = await http(port, "POST", "/api/tasks", { cookie: admin, body: { title: "from chat", department: "Paid Marketing" } });
    const echo = await http(port, "POST", "/api/chat/channels/google-ads/messages", { cookie: admin, body: { text: "made a task", taskId: task.json.task.id } });
    ok(echo.json.message.taskId === task.json.task.id, "chat: task card message carries taskId");

    // admin: users
    ok((await http(port, "POST", "/api/admin/users", { cookie: taha, body: { username: "zz", name: "Z", role: "team", password: "xxxxxx" } })).status === 403, "admin: non-admin create user -> 403");
    const nu = await http(port, "POST", "/api/admin/users", { cookie: admin, body: { username: "newbie", name: "New Bee", role: "team", password: "pass123" } });
    ok(nu.status === 201 && nu.json.user.username === "newbie", "admin: create user");
    ok((await login(port, "newbie", "pass123")).cookie !== undefined, "admin: new user can log in");
    ok((await http(port, "POST", "/api/admin/users", { cookie: admin, body: { username: "newbie", name: "Dup", role: "team", password: "pass123" } })).status === 409, "admin: duplicate username -> 409");
    ok((await http(port, "POST", "/api/admin/users", { cookie: admin, body: { username: "BAD NAME", name: "X", role: "team", password: "pass123" } })).status === 400, "admin: invalid username -> 400");
    ok((await http(port, "PATCH", "/api/admin/users/abubakar", { cookie: admin, body: { active: false } })).status === 400, "admin: self-deactivate blocked");

    // disabled user is locked out immediately (stateless token, but active is re-checked per request)
    const { cookie: nb } = await login(port, "newbie", "pass123");
    await http(port, "PATCH", "/api/admin/users/newbie", { cookie: admin, body: { active: false } });
    ok((await http(port, "GET", "/api/me", { cookie: nb })).status === 401, "admin: disabled user -> 401 on next request");
    ok((await http(port, "POST", "/api/ai/ask", { cookie: nb, body: { question: "x" } })).status === 401, "admin: disabled user blocked from AI too");
    await http(port, "PATCH", "/api/admin/users/newbie", { cookie: admin, body: { active: true } });

    // admin: channels
    const nc = await http(port, "POST", "/api/admin/channels", { cookie: admin, body: { name: "Web Dev", department: "Development", members: ["newbie"] } });
    ok(nc.status === 201 && nc.json.channel.id === "web-dev" && nc.json.channel.members.length === 1, "admin: create channel with member");
    ok((await http(port, "DELETE", "/api/admin/channels/web-dev/members/newbie", { cookie: admin })).json.channel.members.length === 0, "admin: remove member");
    ok((await http(port, "DELETE", "/api/admin/channels/general", { cookie: admin })).status === 400, "admin: general channel can't be deleted");
    ok((await http(port, "DELETE", "/api/admin/channels/web-dev", { cookie: admin })).status === 200, "admin: delete channel");

    /* --- task visibility boundary --- */
    // seeded internal task is invisible to the client everywhere
    const clientState = (await http(port, "GET", "/api/state", { cookie: client })).json;
    ok(!clientState.tasks.some((t) => t.id === "NM-AI-001"), "vis: internal task hidden from client state");
    ok(!(await http(port, "GET", "/api/state", { cookie: admin })).json.tasks.every((t) => (t.visibility || "shared") === "shared"),
      "vis: internal flags present for admin");
    ok((await http(port, "PATCH", "/api/tasks/NM-AI-001", { cookie: client, body: { status: "Completed" } })).status === 404, "vis: client PATCH internal task -> 404 (not 403, no existence leak)");
    // private task: only creator + assignee + admin
    const pv = await http(port, "POST", "/api/tasks", { cookie: admin, body: { title: "private payroll note", visibility: "private", privateFor: "taha" } });
    ok(pv.status === 201 && pv.json.task.visibility === "private", "vis: admin creates private task for taha");
    const pvId = pv.json.task.id;
    ok((await http(port, "GET", "/api/state", { cookie: taha })).json.tasks.some((t) => t.id === pvId), "vis: assignee sees private task");
    ok(!(await http(port, "GET", "/api/state", { cookie: client })).json.tasks.some((t) => t.id === pvId), "vis: client never sees private task");
    const munsifC = munsifLinkC;
    ok(!(await http(port, "GET", "/api/state", { cookie: munsifC })).json.tasks.some((t) => t.id === pvId), "vis: other team member does not see private task");
    ok((await http(port, "PATCH", `/api/tasks/${pvId}`, { cookie: munsifC, body: { status: "In Progress" } })).status === 404, "vis: non-member PATCH private task -> 404");
    // invalid private target rejected
    ok((await http(port, "POST", "/api/tasks", { cookie: admin, body: { title: "x", visibility: "private", privateFor: "adika" } })).status === 400, "vis: private task for client rejected");
    // department assignment stored
    const dt = await http(port, "POST", "/api/tasks", { cookie: client, body: { title: "dept task", assignedDept: "Paid Marketing" } });
    ok(dt.status === 201 && dt.json.task.assignedDept === "Paid Marketing", "vis: client assigns task to a department");
    // client-cannot-create-internal enforced
    ok((await http(port, "POST", "/api/tasks", { cookie: client, body: { title: "sneaky", visibility: "internal" } })).json.task.visibility === "shared",
      "vis: client internal flag is forced to shared");
    // client CAN see the private task they themselves created (creator is in the circle)
    const cpv = await http(port, "POST", "/api/tasks", { cookie: client, body: { title: "client private note", visibility: "private", privateFor: "taha" } });
    ok(cpv.status === 201 && (await http(port, "GET", "/api/state", { cookie: client })).json.tasks.some((t) => t.id === cpv.json.task.id),
      "vis: client sees own private task");
    ok(!(await http(port, "GET", "/api/state", { cookie: munsifC })).json.tasks.some((t) => t.id === cpv.json.task.id),
      "vis: other team member cannot see client's private task");
    // stored-XSS vector closed at the server
    ok((await http(port, "POST", "/api/chat/channels/general/messages", { cookie: taha, body: { text: "x", taskId: "x');alert(1);//" } })).status === 400,
      "sec: message taskId charset validated");
    ok((await http(port, "POST", "/api/links", { cookie: taha, body: { title: "x", taskId: "x');alert(1);//" } })).status === 400,
      "sec: link taskId charset validated");

    ok(server.exitCode === null, "chat: server still alive at end of suite");
  } finally {
    server.kill();
  }
}

/* ========================= 6. AI layer ========================= */

/* Stub Kimi server: first call (with tools) -> search_chat tool call; calls with
   tool results or without tools -> final answer. Records every request body so
   tests can inspect EXACTLY what context left the building. */
function startKimiStub(port, received) {
  const srv = require("http").createServer((req, res) => {
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => {
      let body = {};
      try { body = JSON.parse(buf); } catch { /* ignore */ }
      body.__authorization = req.headers.authorization || "";
      received.push(body);
      const hasToolResult = (body.messages || []).some((m) => m.role === "tool");
      const noTools = !body.tools;
      // Pick a requested tool only when the API actually offered it. This lets
      // the suite prove that per-user tool restrictions affect the provider
      // request, not just the later executor.
      const userText = JSON.stringify((body.messages || []).filter((m) => m.role === "user"));
      const offered = new Set((body.tools || []).map((t) => t.function && t.function.name));
      let chosen = null;
      let args = {};
      if (/decision/i.test(userText) && offered.has("propose_decision")) {
        chosen = "propose_decision";
        args = { topic: "Test", rule: "Italy decision via AI approval", workstream: "Italy", owner: "Adika" };
      } else if (/propose/i.test(userText) && offered.has("propose_task_update")) {
        chosen = "propose_task_update";
        args = { id: "NM-TRK-007", status: "Ready for Review", reason: "test proposal" };
      } else if (/files/i.test(userText) && offered.has("search_files")) {
        chosen = "search_files";
        args = { query: "SECRETFILE" };
      } else if (offered.has("search_chat")) {
        chosen = "search_chat";
        args = { query: "tracking" };
      }
      const finalPayload = { model: body.model, choices: [{ message: { role: "assistant", content: "FINAL ANSWER" } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
      const payload = hasToolResult || noTools || !chosen
        ? finalPayload
        : { model: body.model, choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: "tool:0", type: "function", function: { name: chosen, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });
  return new Promise((resolve) => srv.listen(port, () => resolve(srv)));
}

async function testAi() {
  console.log("\n[6] AI layer (port 4191 app, 4192 stub Kimi)");
  const received = [];
  const stub = await startKimiStub(4192, received);
  const port = 4191;
  // start app wired to the stub
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    env: {
      PATH: process.env.PATH, PORT: String(port),
      TASK_HUB_DATA_FILE: path.join(TMP, "ai-data.json"),
      KIMI_BASE_URL: "http://localhost:4192/v1",
      KIMI_API_KEY: "test-key",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (d) => { out += d; if (out.includes("http://localhost")) resolve(); });
    child.on("exit", () => reject(new Error("ai server exited early")));
    setTimeout(() => reject(new Error("ai server start timeout")), 8000);
  });

  try {
    const { cookie: admin } = await login(port, "abubakar", "NM-admin-2026");
    const { cookie: taha } = await login(port, "taha", "NM-taha-2026");
    const { cookie: client } = await login(port, "adika", "neonmonki2026");

    // AI disabled by default -> 503, and the rest of the app still works
    ok((await http(port, "POST", "/api/ai/ask", { cookie: taha, body: { question: "hi" } })).status === 503, "ai: disabled -> 503");
    ok((await http(port, "GET", "/api/state", { cookie: taha })).status === 200, "ai: app unaffected while AI disabled");

    // control center guards
    ok((await http(port, "GET", "/api/ai/admin", { cookie: taha })).status === 403, "ai: team cannot read control center");
    ok((await http(port, "PATCH", "/api/ai/admin", { cookie: client, body: { enabled: true } })).status === 403, "ai: client cannot change settings");

    // Super admin can configure the provider from the Control Center. The key
    // is accepted write-only, encrypted at rest, and becomes the call credential.
    ok((await http(port, "PATCH", "/api/ai/admin", { cookie: admin, body: { apiKey: "short" } })).status === 400,
      "ai: provider rejects malformed short keys");
    ok((await http(port, "PATCH", "/api/ai/admin", { cookie: admin, body: { baseUrl: "https://example.com/v1" } })).status === 400,
      "ai: provider rejects an untrusted endpoint");
    const savedProviderKey = "sk-control-center-http-test-123456";
    const providerSave = await http(port, "PATCH", "/api/ai/admin", {
      cookie: admin, body: { apiKey: savedProviderKey, model: "kimi-k3" },
    });
    ok(providerSave.status === 200 && providerSave.json.settings.model === "kimi-k3",
      "ai: super admin saves Kimi key and K3 model");
    const providerCtl = (await http(port, "GET", "/api/ai/admin", { cookie: admin })).json;
    ok(providerCtl.configured === true && providerCtl.provider.keySource === "control_center"
      && !JSON.stringify(providerCtl).includes(savedProviderKey),
      "ai: control center reports saved key without revealing it");
    ok(!fs.readFileSync(path.join(TMP, "ai-data.json"), "utf8").includes(savedProviderKey),
      "ai: Control Center key is encrypted at rest");

    // enable AI (admin)
    const en = await http(port, "PATCH", "/api/ai/admin", { cookie: admin, body: { enabled: true } });
    ok(en.status === 200 && en.json.settings.enabled === true, "ai: admin enables AI");

    received.length = 0;
    const providerAsk = await http(port, "POST", "/api/ai/ask", { cookie: taha, body: { question: "provider credential check" } });
    ok(providerAsk.status === 200 && received[0].__authorization === `Bearer ${savedProviderKey}`
      && received[0].model === "kimi-k3", "ai: saved Control Center key and K3 model drive provider calls");

    const initialCtl = (await http(port, "GET", "/api/ai/admin", { cookie: admin })).json;
    const allTools = initialCtl.tools.map((t) => t.name);
    const readTools = initialCtl.tools.filter((t) => t.kind === "read").map((t) => t.name);
    ok(initialCtl.provider.status === "configured" && initialCtl.userAccess.some((u) => u.username === "taha")
      && initialCtl.tools.some((t) => t.name === "propose_task_update"),
      "ai: control center exposes provider, users and tool catalog");
    ok((await http(port, "PATCH", "/api/ai/admin/users/taha", { cookie: taha, body: { enabled: false } })).status === 403,
      "ai: non-admin cannot edit per-user access");
    ok((await http(port, "PATCH", "/api/ai/admin/users/taha", { cookie: admin, body: { tools: ["not-a-tool"] } })).status === 400,
      "ai: per-user access rejects unknown tools");
    await http(port, "PATCH", "/api/ai/admin/users/taha", { cookie: admin, body: { enabled: false } });
    ok((await http(port, "POST", "/api/ai/ask", { cookie: taha, body: { question: "blocked" } })).status === 403,
      "ai: disabled user is blocked from AI");
    ok((await http(port, "GET", "/api/state", { cookie: taha })).status === 200,
      "ai: disabling a user's AI leaves the workspace available");
    await http(port, "PATCH", "/api/ai/admin/users/taha", { cookie: admin, body: { enabled: true } });

    // Feature toggles are enforced by the API, including the separate in-chat flag.
    const featureBase = { ask: true, chat: false, brief: true, summaries: true };
    await http(port, "PATCH", "/api/ai/admin", { cookie: admin, body: { features: featureBase } });
    ok((await http(port, "POST", "/api/ai/ask", { cookie: taha, body: { question: "chat off", channelId: "general" } })).status === 403,
      "ai: chat feature toggle blocks in-channel AI server-side");
    ok((await http(port, "POST", "/api/ai/ask", { cookie: taha, body: { question: "ask still on" } })).status === 200,
      "ai: chat toggle does not disable the Ask page");
    await http(port, "PATCH", "/api/ai/admin", { cookie: admin, body: { features: { ...featureBase, ask: false, chat: true } } });
    const askOffStatus = (await http(port, "GET", "/api/ai/status", { cookie: taha })).json;
    ok(askOffStatus.allowedForMe === true && askOffStatus.features.ask === false && askOffStatus.features.chat === true,
      "ai: account availability is independent from individual feature toggles");
    ok((await http(port, "POST", "/api/ai/ask", { cookie: taha, body: { question: "ask off" } })).status === 403,
      "ai: Ask feature toggle blocks the Ask route server-side");
    ok((await http(port, "POST", "/api/ai/ask", { cookie: taha, body: { question: "chat still on", channelId: "general" } })).status === 200,
      "ai: Ask toggle does not disable in-channel AI");
    await http(port, "PATCH", "/api/ai/admin", { cookie: admin, body: { features: { ...featureBase, chat: true } } });

    // plant secrets in a team-only channel and its file folder
    await http(port, "POST", "/api/chat/channels/google-ads/messages", { cookie: taha, body: { text: "SECRET internal tracking note XYZZY" } });
    await http(port, "POST", "/api/links", { cookie: taha, body: {
      title: "SECRETFILE XYZZYFILE", note: "private paid-media working file", channelId: "google-ads",
    } });

    // client ask — provider must never receive team-channel content
    // (note: the string "google-ads" legitimately appears in tool *schema* descriptions;
    // what must never cross is the channel's message CONTENT — the XYZZY marker)
    received.length = 0;
    const askC = await http(port, "POST", "/api/ai/ask", { cookie: client, body: { question: "what tracking discussions happened?" } });
    ok(askC.status === 200 && askC.json.answer === "FINAL ANSWER", "ai: client ask -> 200");
    const clientPayload = JSON.stringify(received);
    ok(!clientPayload.includes("XYZZY"), "ai: NO team-channel content sent to provider for client");
    ok(!(askC.json.citations || []).some((c) => c.channelId === "google-ads"), "ai: client citations exclude team channels");

    // team ask — DOES retrieve the internal note (retrieval works for those allowed)
    received.length = 0;
    const askT = await http(port, "POST", "/api/ai/ask", { cookie: taha, body: { question: "what tracking discussions happened?" } });
    ok(askT.status === 200, "ai: team ask -> 200");
    ok(JSON.stringify(received).includes("XYZZY"), "ai: team retrieval includes accessible internal channel");

    // The same centralized file policy protects AI file retrieval.
    received.length = 0;
    const filesC = await http(port, "POST", "/api/ai/ask", { cookie: client, body: { question: "find files" } });
    ok(filesC.status === 200 && !JSON.stringify(received).includes("XYZZYFILE")
      && !(filesC.json.citations || []).some((c) => c.title === "SECRETFILE XYZZYFILE"),
      "ai: client search_files cannot retrieve team-channel files");
    received.length = 0;
    const filesT = await http(port, "POST", "/api/ai/ask", { cookie: taha, body: { question: "find files" } });
    ok(filesT.status === 200 && JSON.stringify(received).includes("XYZZYFILE")
      && filesT.json.citations.some((c) => c.title === "SECRETFILE XYZZYFILE"),
      "ai: authorized member search_files retrieves the scoped file");

    // Read-only users never offer drafting/proposal tools to the provider.
    await http(port, "PATCH", "/api/ai/admin/users/taha", { cookie: admin, body: { tools: readTools } });
    received.length = 0;
    const readOnlyProposal = await http(port, "POST", "/api/ai/ask", { cookie: taha, body: { question: "please propose a status change" } });
    const offeredToReadOnly = (received[0].tools || []).map((t) => t.function.name);
    ok(readOnlyProposal.status === 200 && readOnlyProposal.json.proposals.length === 0
      && !offeredToReadOnly.includes("propose_task_update") && !offeredToReadOnly.includes("draft_task"),
      "ai: per-user read-only profile removes write-capable tools from the provider request");
    await http(port, "PATCH", "/api/ai/admin/users/taha", { cookie: admin, body: { tools: allTools } });

    // in-channel scope: asking inside #general cannot pull google-ads content
    received.length = 0;
    const askCh = await http(port, "POST", "/api/ai/ask", { cookie: taha, body: { question: "what tracking discussions happened?", channelId: "general" } });
    ok(askCh.status === 200, "ai: in-channel ask -> 200");
    ok(!JSON.stringify(received).includes("XYZZY"), "ai: in-channel ask is scoped to that channel");

    // internal tasks never reach the provider for the client either
    await http(port, "PATCH", "/api/tasks/NM-AI-001", { cookie: admin, body: { description: "INTERNAL SECRET ZQXWV about candidate evaluation" } });
    received.length = 0;
    await http(port, "POST", "/api/ai/ask", { cookie: client, body: { question: "tell me about the AI hiring candidate tracking" } });
    ok(!JSON.stringify(received).includes("ZQXWV"), "ai: internal task content never sent to provider for client");

    // daily brief must not leak internal-task activity (titles) to the client
    await http(port, "POST", "/api/tasks", { cookie: admin, body: { title: "BRIEFLEAK internal marker", visibility: "internal" } });
    received.length = 0;
    await http(port, "POST", "/api/ai/brief", { cookie: client, body: {} });
    ok(!JSON.stringify(received).includes("BRIEFLEAK"), "ai: client brief excludes internal-task activity");

    // summaries + brief
    const sum = await http(port, "POST", "/api/ai/summarize/task/NM-TRK-007", { cookie: taha, body: {} });
    ok(sum.status === 200 && sum.json.answer === "FINAL ANSWER" && sum.json.citations.some((c) => c.id === "NM-TRK-007"), "ai: task summary with citations");
    ok((await http(port, "POST", "/api/ai/summarize/channel/google-ads", { cookie: client, body: {} })).status === 403, "ai: client cannot summarize team channel");
    ok((await http(port, "POST", "/api/ai/brief", { cookie: client, body: {} })).status === 200, "ai: client brief works (client-safe content)");

    // Per-user rate override takes precedence over the global limit.
    await http(port, "PATCH", "/api/ai/admin/users/munsif", { cookie: admin, body: { dailyLimit: 1 } });
    const { cookie: munsif } = await login(port, "munsif", "NM-munsif-2026");
    ok((await http(port, "POST", "/api/ai/ask", { cookie: munsif, body: { question: "q1" } })).status === 200, "ai: first call within limit");
    const limited = await http(port, "POST", "/api/ai/ask", { cookie: munsif, body: { question: "q2" } });
    ok(limited.status === 429, "ai: per-user daily override rate limits the second call");
    await http(port, "PATCH", "/api/ai/admin/users/munsif", { cookie: admin, body: { dailyLimit: null } });

    // audit log: admin sees the asks with tools + status, no chain-of-thought
    const ctl = (await http(port, "GET", "/api/ai/admin", { cookie: admin })).json;
    ok(ctl.audit.some((a) => a.kind === "ask" && a.username === "adika" && a.tools.includes("search_chat")), "ai: audit records user/kind/tools");
    ok(!JSON.stringify(ctl.audit).includes("FINAL ANSWER"), "ai: audit stores no model output");

    // test connection against stub (stub serves /models? no -> expect graceful false)
    const tc = await http(port, "POST", "/api/ai/admin/test", { cookie: admin, body: {} });
    ok(tc.status === 200 && typeof tc.json.ok === "boolean", "ai: test-connection returns structured result");

    /* --- AI action proposals + approval --- */
    // proposal flows through ask and comes back structured
    const askP = await http(port, "POST", "/api/ai/ask", { cookie: taha, body: { question: "please propose a status change" } });
    ok(askP.status === 200 && askP.json.proposals && askP.json.proposals[0] && askP.json.proposals[0].type === "task_update"
      && askP.json.proposals[0].taskId === "NM-TRK-007" && askP.json.proposals[0].fields.status === "Ready for Review",
      "ai: ask returns structured task-update proposal");
    // proposal itself changed nothing
    ok((await http(port, "GET", "/api/state", { cookie: taha })).json.tasks.find((t) => t.id === "NM-TRK-007").status === "In Progress",
      "ai: proposal alone changes nothing");
    const taskProposalId = askP.json.proposals[0].id;
    ok(Number.isInteger(taskProposalId), "ai: proposal is persisted and returned with an id");
    ok((await http(port, "POST", "/api/ai/actions/execute", { cookie: client, body: { proposalId: taskProposalId } })).status === 403,
      "ai: one user cannot approve another user's proposal");
    ok((await http(port, "POST", "/api/ai/actions/execute", { cookie: taha, body: {
      type: "decision", taskId: "NM-TRK-008", fields: { status: "Cancelled" },
    } })).status === 404, "ai: raw unpersisted action payload cannot execute");

    // team executes the proposal -> applied with audit trail
    const ex = await http(port, "POST", "/api/ai/actions/execute", { cookie: taha, body: { proposalId: taskProposalId } });
    ok(ex.status === 200 && ex.json.task.status === "Ready for Review", "ai: team executes proposal");
    ok(ex.json.task.updates.some((u) => /via AI proposal/.test(u.by)), "ai: execution marked as AI-proposed in task history");
    ok(ex.json.action.status === "executed" && ex.json.action.decidedBy === "taha"
      && ex.json.action.executionResult.taskId === "NM-TRK-007", "ai: approval result and decider are persisted");
    ok((await http(port, "POST", "/api/ai/actions/execute", { cookie: taha, body: { proposalId: taskProposalId } })).status === 409,
      "ai: a decided proposal cannot execute twice");

    // A human may modify the proposal fields before approval; the persisted
    // original remains immutable and the final payload is recorded separately.
    const askModified = await http(port, "POST", "/api/ai/ask", { cookie: taha, body: { question: "please propose another status change" } });
    const modifiedProposal = askModified.json.proposals[0];
    const exModified = await http(port, "POST", "/api/ai/actions/execute", { cookie: taha, body: {
      proposalId: modifiedProposal.id,
      payload: { ...modifiedProposal, taskId: "NM-TRK-008", fields: { priority: "Low", owner: "Taha", update: "Adjusted by human reviewer" }, reason: "human correction" },
    } });
    ok(exModified.status === 200 && exModified.json.task.priority === "Low"
      && exModified.json.task.owner === "Taha" && exModified.json.task.update === "Adjusted by human reviewer",
      "ai: reviewer can modify task fields before approval");
    ok(exModified.json.task.id === "NM-TRK-007" && exModified.json.action.payload.taskId === "NM-TRK-007"
      && exModified.json.action.modifiedPayload.fields.priority === "Low",
      "ai: modified approval cannot retarget the original task and preserves both payloads");
    ok(exModified.json.task.updates.some((u) => /via modified AI proposal/.test(u.by)),
      "ai: modified execution is marked in task history");

    // client executing outside the handshake -> 403 (no extra privileges via AI)
    const askClientProposal = await http(port, "POST", "/api/ai/ask", { cookie: client, body: { question: "please propose a status change" } });
    const clientProposal = askClientProposal.json.proposals[0];
    const exC = await http(port, "POST", "/api/ai/actions/execute", { cookie: client, body: {
      proposalId: clientProposal.id, payload: { ...clientProposal, fields: { status: "In Progress" } },
    } });
    ok(exC.status === 403, "ai: client execute outside handshake -> 403");
    // client CAN confirm a review (inside handshake)
    ok((await http(port, "POST", "/api/ai/actions/execute", { cookie: client, body: {
      proposalId: clientProposal.id, payload: { ...clientProposal, fields: { status: "Completed" } },
    } })).status === 200,
      "ai: client confirm-completed via proposal allowed");

    // decision proposal executes for any signed-in role (matches Decisions page rules)
    const askDecision = await http(port, "POST", "/api/ai/ask", { cookie: client, body: { question: "propose a decision" } });
    const decisionProposal = askDecision.json.proposals[0];
    const exD = await http(port, "POST", "/api/ai/actions/execute", { cookie: client, body: { proposalId: decisionProposal.id } });
    ok(exD.status === 200 && exD.json.action.executionResult.decisionId, "ai: persisted decision proposal executes");
    ok((await http(port, "GET", "/api/state", { cookie: admin })).json.decisions.some((d) => d.rule === "Italy decision via AI approval"), "ai: decision actually recorded");

    // decline is logged
    const askReject = await http(port, "POST", "/api/ai/ask", { cookie: taha, body: { question: "please propose a change to reject" } });
    const rejected = await http(port, "POST", "/api/ai/actions/decline", { cookie: taha, body: {
      proposalId: askReject.json.proposals[0].id, note: "not appropriate",
    } });
    ok(rejected.status === 200 && rejected.json.action.status === "rejected"
      && rejected.json.action.note === "not appropriate", "ai: rejection decision and note are persisted");
    // admin sees the action trail; team does not
    const acts = await http(port, "GET", "/api/ai/actions", { cookie: admin });
    ok(acts.status === 200 && acts.json.actions.some((a) => a.status === "executed" && a.actionType === "task_update")
      && acts.json.actions.some((a) => a.status === "rejected"), "ai: admin sees executed + rejected trail");
    ok((await http(port, "GET", "/api/ai/actions", { cookie: taha })).status === 403, "ai: action trail is admin-only");
  } finally {
    child.kill();
    stub.close();
  }
}

/* ============================ runner ============================ */

(async () => {
  try {
    await testStoreJson();
  } catch (e) { ok(false, "json: suite crashed", e.message); }
  await testStoreSupabase();
  await testHttp();
  await testErrorPaths();
  await testChat();
  await testAi();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) { console.log("failures:\n - " + failures.join("\n - ")); process.exit(1); }
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error("runner crashed:", e); process.exit(1); });
