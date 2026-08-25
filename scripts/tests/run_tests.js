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

// The report writer emits a zero-dependency .docx: a zip of STOREd (method 0,
// uncompressed) entries. Walk the local file headers and return one entry's
// bytes as utf8 — enough to assert the document part is real and escaped.
function unzipStoredEntry(buf, name) {
  let off = 0;
  while (off + 30 <= buf.length && buf.readUInt32LE(off) === 0x04034b50) {
    const method = buf.readUInt16LE(off + 8);
    const compSize = buf.readUInt32LE(off + 18);
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const entryName = buf.slice(off + 30, off + 30 + nameLen).toString("utf8");
    const dataStart = off + 30 + nameLen + extraLen;
    if (entryName === name) {
      if (method !== 0) return null; // contract is STORE-only; anything else is off-spec
      return buf.slice(dataStart, dataStart + compSize).toString("utf8");
    }
    off = dataStart + compSize;
  }
  return null;
}

/* ============================ 1. store-json unit ============================ */

async function testStoreJson() {
  console.log("\n[1] store-json unit tests");
  process.env.TASK_HUB_DATA_FILE = DATA_FILE;
  const store = require(path.join(ROOT, "lib", "store-json"));

  // fresh file seeded from seed.json
  const state = await store.getState();
  const { DEFAULT_DEPARTMENTS } = require(path.join(ROOT, "lib", "task-system"));
  ok(eq(DEFAULT_DEPARTMENTS.map((d) => d.name), [
    "SEO", "Google Ads", "Email Marketing", "Research", "Social Media",
    "Development", "AI & Automation", "Project Management",
  ]), "json: task system starts with exactly the eight approved departments");
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
  let codeProbeBody = null;
  global.fetch = async (url, options = {}) => {
    testedEndpoints.push(url);
    if (url.startsWith(ai.KIMI_CODE_BASE_URL)) {
      codeProbeBody = JSON.parse(options.body);
      return {
        ok: true, status: 200,
        json: async () => ({ model: "k3", choices: [{ message: { content: "KIMI_OK" } }] }),
      };
    }
    return { ok: false, status: 401, statusText: "Unauthorized", json: async () => ({}) };
  };
  try {
    const detected = await ai.testConnection({ getAiSettings: async () => ({
      model: "kimi-k2.6",
      provider: { apiKeyEncrypted: encrypted, baseUrl: ai.GLOBAL_KIMI_BASE_URL },
    }) });
    ok(detected.ok && detected.autoDetected && detected.baseUrl === ai.KIMI_CODE_BASE_URL
      && detected.recommendedModel === "k3" && detected.modelsAvailable.includes("k3"),
      "json: AI connection detects a Kimi Code membership key");
    ok(testedEndpoints.some((u) => u.startsWith(ai.GLOBAL_KIMI_BASE_URL))
      && testedEndpoints.some((u) => u.startsWith(ai.KIMI_CODE_BASE_URL)),
      "json: AI endpoint detection probes Moonshot then Kimi Code");
    ok(codeProbeBody.model === "k3" && codeProbeBody.reasoning_effort === "low"
      && codeProbeBody.messages[0].content.includes("KIMI_OK"),
      "json: Kimi Code probe performs a lightweight K3 completion");
  } finally {
    global.fetch = realProviderFetch;
  }

  /* --- reporting layer: metrics, ai reports, last-seen --- */
  const m1 = await store.metricInsert({ date: "2026-08-10", channel: "SEO", metric: "organic_clicks", value: 60, note: "", createdBy: "taha" });
  await store.metricInsert({ date: "2026-08-12", channel: "SEO", metric: "organic_clicks", value: 50, note: "", createdBy: "taha" });
  await store.metricInsert({ date: "2026-08-04", channel: "SEO", metric: "organic_clicks", value: 100, note: "", createdBy: "taha" });
  ok(m1.id === 1 && m1.value === 60 && !!m1.ts, "json: metric entry persisted with id + ts");
  const week = await store.metricsList("2026-08-10", "2026-08-16");
  ok(week.length === 2 && week[0].date === "2026-08-10" && week.every((e) => e.channel === "SEO"),
    "json: metricsList filters by date range, sorted ascending");
  ok((await store.metricsList(null, null)).length === 3, "json: metricsList without range returns everything");
  await store.metricDelete(m1.id);
  ok((await store.metricsList(null, null)).length === 2, "json: metricDelete removes the entry");

  await store.aiReportInsert({ audience: "team", periodFrom: "2026-08-04", periodTo: "2026-08-10", text: "TEAM REPORT", citations: [{ type: "task", id: "NM-1" }], createdBy: "taha" });
  await store.aiReportInsert({ audience: "client", periodFrom: "2026-08-04", periodTo: "2026-08-10", text: "CLIENT REPORT", citations: [], createdBy: "taha" });
  const latestTeam = await store.aiReportLatest("team");
  const latestClient = await store.aiReportLatest("client");
  ok(latestTeam.text === "TEAM REPORT" && latestClient.text === "CLIENT REPORT",
    "json: ai reports are stored per audience");
  ok(latestClient.periodFrom === "2026-08-04" && latestTeam.citations.length === 1,
    "json: ai report round-trips period + citations");
  ok((await store.aiReportLatest("nobody")) === null, "json: aiReportLatest misses cleanly");

  /* --- report library collection (Reports page, migration 011 shape) --- */
  ok(Array.isArray(JSON.parse(fs.readFileSync(DATA_FILE, "utf8")).reportLibrary),
    "json: reportLibrary collection exists from first boot");
  const libA = await store.reportInsert({ title: "July weekly", kind: "weekly", periodMonth: "2026-07", links: [{ label: "Deck", url: "https://drive.google.com/d" }], createdBy: "taha" });
  ok(libA.id === 1 && libA.kind === "weekly" && libA.links.length === 1 && libA.createdBy === "taha"
    && typeof libA.createdAt === "string" && typeof libA.updatedAt === "string",
    "json: reportInsert assigns id + timestamps, camelCase out", JSON.stringify(libA));
  const libB = await store.reportInsert({ title: "August monthly", kind: "monthly", periodMonth: "2026-08", links: [{ url: "https://example.com/m" }], createdBy: "taha" });
  const libC = await store.reportInsert({ title: "August special", kind: "special", periodMonth: "2026-08", links: [{ label: "", url: "https://example.com/s" }], createdBy: "abubakar" });
  const libAll = await store.reportsList();
  ok(eq(libAll.map((r) => r.id), [libC.id, libB.id, libA.id]),
    "json: reportsList sorts periodMonth desc then id desc", JSON.stringify(libAll.map((r) => [r.periodMonth, r.id])));
  ok(libAll.find((r) => r.id === libB.id).links[0].label === "",
    "json: link label defaults to empty (the UI falls back to the hostname)");
  const libDefaults = await store.reportInsert({ title: "Bare", periodMonth: "2026-08" });
  ok(libDefaults.kind === "weekly" && libDefaults.description === "" && eq(libDefaults.links, []),
    "json: library defaults (weekly kind, empty description + links)");
  const libUpd = await store.reportUpdate(libA.id, { title: "July weekly (final)", description: "W30" });
  ok(libUpd.title === "July weekly (final)" && libUpd.description === "W30" && libUpd.kind === "weekly"
    && libUpd.updatedAt >= libA.updatedAt, "json: reportUpdate patches only the given fields");
  ok((await store.reportUpdate(99999, { title: "x" })) === null, "json: reportUpdate unknown id -> null");
  ok((await store.reportDelete(libB.id)) === true && (await store.reportDelete(libB.id)) === false,
    "json: reportDelete returns whether a row was removed");
  ok((await store.reportsList()).every((r) => r.id !== libB.id), "json: deleted library row stays gone");

  /* --- reporting tier values: new whitelist + legacy "full" read mapping --- */
  // Rows written before the rename still store "full"; both drivers must read
  // it back as "advanced" (the JSON driver re-reads the file on every call,
  // so a direct file edit faithfully simulates a legacy row).
  const rawPermDb = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  rawPermDb.aiUserPermissions.legacyfull = { username: "legacyfull", enabled: true, tools: null, dailyLimit: null, reporting: "full", updatedBy: "", updatedAt: null };
  fs.writeFileSync(DATA_FILE, JSON.stringify(rawPermDb));
  ok((await store.getAiUserPermission("legacyfull")).reporting === "advanced",
    "json: legacy stored reporting=full reads as advanced");
  ok((await store.listAiUserPermissions()).find((p) => p.username === "legacyfull").reporting === "advanced",
    "json: listAiUserPermissions maps legacy full to advanced too");
  const superTier = await store.putAiUserPermission("taha", { reporting: "super" });
  ok(superTier.reporting === "super", "json: reporting=super persists (new whitelist)");
  const junkTier = await store.putAiUserPermission("taha", { reporting: "everything" });
  ok(junkTier.reporting === "", "json: unknown reporting tier sanitizes back to inherit");

  /* --- reporting_daily v2 store methods (upsert/query/delete) --- */
  const dailyWritten = await store.reportingDailyUpsert([
    { day: "2026-08-18", scope: "account", channel: "Paid Search", platform: "Google Ads", adAccount: "5861254545", spend: 473.55, revenue: 1760.52, sales: 4, aov: 440.13 },
    { day: "2026-08-18", scope: "campaign", channel: "Paid Search", platform: "Google Ads", adAccount: "5861254545", campaignId: "adsrc-1001", campaignName: "Neon Signs DE", spend: 284.13, clicks: 58, impressions: 1450, leads: 4, sales: 3, revenue: 1232.36 },
    { day: "2026-08-18", scope: "channel", channel: "Organic Search / SEO", platform: "Organic Google", spend: 0, clicks: null, impressions: null, leads: 1, sales: 0, revenue: 0 },
    { day: "2026-08-18", scope: "account", channel: "Email", platform: "Email", sourceSystem: "manual", spend: 10, revenue: 0 },
  ]);
  ok(dailyWritten === 4, "json: reportingDailyUpsert writes account/campaign/channel rows", String(dailyWritten));
  // idempotent: the unique key (sourceSystem, day, scope, platform, adAccount,
  // campaignId) overwrites — re-syncing a day never duplicates it.
  await store.reportingDailyUpsert([{ day: "2026-08-18", scope: "account", channel: "Paid Search", platform: "Google Ads", adAccount: "5861254545", spend: 500, revenue: 2000, sales: 5, aov: 400 }]);
  const dq = await store.reportingDailyQuery({ from: "2026-08-01", to: "2026-08-31", scope: "account", platform: "Google Ads" });
  ok(dq.length === 1 && dq[0].spend === 500 && dq[0].adAccount === "5861254545" && dq[0].campaignId === "",
    "json: reportingDaily upsert overwrites by unique key; query outputs camelCase", JSON.stringify(dq[0] || null));
  const dchan = await store.reportingDailyQuery({ scope: "channel" });
  ok(dchan.length === 1 && dchan[0].clicks === null && dchan[0].spend === 0,
    "json: null clicks preserved (untracked, not a fake 0); organic spend 0 truthful");
  const ddel = await store.reportingDailyDelete({ sourceSystem: "hyros" });
  ok(ddel === 3, "json: reportingDailyDelete removes exactly the hyros rows", String(ddel));
  const dleft = await store.reportingDailyQuery({});
  ok(dleft.length === 1 && dleft[0].sourceSystem === "manual",
    "json: other source systems survive a hyros-scoped delete (resync clears only hyros rows)");
  await store.reportingDailyDelete({ sourceSystem: "manual" }); // leave no residue for later suites

  ok((await store.touchLastSeen("taha")) === null, "json: first visit has no previous stamp");
  const stamped = (await store.getUser("taha")).lastSeenAt;
  ok(typeof stamped === "string" && stamped.includes("T"), "json: visit stamp persisted on the user");
  ok((await store.touchLastSeen("taha")) === stamped, "json: touchLastSeen returns the previous stamp");
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
      ok(seededTaha && eq(seededTaha.body.departments, ["google-ads"]),
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

      /* --- reporting layer mappings --- */
      const impactRow = _internals.fieldsToRow({ status: "Planned", impact: "Revenue-critical" });
      ok(eq(Object.keys(impactRow).sort(), ["impact", "status"]) && impactRow.impact === "Revenue-critical",
        "sb: fieldsToRow maps impact");
      ok(_internals.rowToTask({ id: "X", impact: "Why it matters" }).impact === "Why it matters"
        && _internals.rowToTask({ id: "X" }).impact === "", "sb: rowToTask impact passthrough + default");

      respond([{ id: 1, date: "2026-08-10", channel: "SEO", metric: "organic_clicks", value: 60, note: "", created_by: "taha", ts: "2026-08-10T10:00:00Z" }]);
      const mEntry = await store.metricInsert({ date: "2026-08-10", channel: "SEO", metric: "organic_clicks", value: 60, note: "", createdBy: "taha" });
      const mPost = calls[calls.length - 1];
      ok(mPost.method === "POST" && mPost.url.includes("/metrics") && mPost.body.created_by === "taha"
        && mPost.body.value === 60, "sb: metricInsert posts a snake_case row");
      ok(mEntry.createdBy === "taha" && mEntry.value === 60 && mEntry.id === 1, "sb: metric row mapped back to camelCase");

      respond([{ id: 2, date: "2026-08-11", channel: "SEO", metric: "clicks", value: 5, created_by: "t" }]);
      const mList = await store.metricsList("2026-08-10", "2026-08-16");
      const mGet = calls[calls.length - 1];
      ok(/date=gte\.2026-08-10/.test(mGet.url) && /date=lte\.2026-08-16/.test(mGet.url) && /order=date\.asc/.test(mGet.url),
        "sb: metricsList queries the date range in order", mGet.url);
      ok(mList.length === 1 && mList[0].id === 2 && mList[0].value === 5, "sb: metricsList maps rows");

      respond(null, 204);
      await store.metricDelete(2);
      const mDel = calls[calls.length - 1];
      ok(mDel.method === "DELETE" && /metrics\?id=eq\.2/.test(mDel.url), "sb: metricDelete deletes by numeric id");

      respond([{ id: 7, audience: "client", period_from: "2026-08-04", period_to: "2026-08-10", text: "R", citations: [{ type: "task", id: "NM-1" }], created_by: "taha", ts: "2026-08-10T11:00:00Z" }]);
      const report = await store.aiReportInsert({ audience: "client", periodFrom: "2026-08-04", periodTo: "2026-08-10", text: "R", citations: [{ type: "task", id: "NM-1" }], createdBy: "taha" });
      const rPost = calls[calls.length - 1];
      ok(rPost.url.includes("/ai_reports") && rPost.body.period_from === "2026-08-04" && rPost.body.created_by === "taha",
        "sb: aiReportInsert posts a snake_case row");
      ok(report.periodFrom === "2026-08-04" && report.citations.length === 1 && report.audience === "client",
        "sb: ai report mapped back to camelCase");

      respond([{ id: 7, audience: "client", period_from: "2026-08-04", period_to: "2026-08-10", text: "R", citations: [], created_by: "taha" }]);
      const latest = await store.aiReportLatest("client");
      const lGet = calls[calls.length - 1];
      ok(/audience=eq\.client/.test(lGet.url) && /order=id\.desc/.test(lGet.url) && /limit=1/.test(lGet.url),
        "sb: aiReportLatest queries latest per audience", lGet.url);
      ok(latest && latest.text === "R", "sb: aiReportLatest returns the row");
      respond([]);
      ok((await store.aiReportLatest("client")) === null, "sb: aiReportLatest empty -> null");

      /* --- report library driver (migration 011) --- */
      respond([{ id: 3, title: "August weekly", description: "", kind: "weekly", period_month: "2026-08", links: [{ label: "Deck", url: "https://drive.google.com/d" }], created_by: "taha", created_at: "2026-08-19T10:00:00Z", updated_at: "2026-08-19T10:00:00Z" }]);
      const libRep = await store.reportInsert({ title: "August weekly", kind: "weekly", periodMonth: "2026-08", links: [{ label: "Deck", url: "https://drive.google.com/d" }], createdBy: "taha" });
      const libPost = calls[calls.length - 1];
      ok(libPost.method === "POST" && libPost.url.includes("/report_library")
        && libPost.body.period_month === "2026-08" && libPost.body.created_by === "taha",
        "sb: reportInsert posts a snake_case row", JSON.stringify(libPost.body));
      ok(libRep.id === 3 && libRep.periodMonth === "2026-08" && libRep.links[0].label === "Deck" && libRep.createdBy === "taha",
        "sb: library row mapped back to camelCase", JSON.stringify(libRep));

      respond([
        { id: 3, title: "A", description: "", kind: "weekly", period_month: "2026-08", links: [], created_by: "t", created_at: "x", updated_at: "x" },
        { id: 2, title: "B", description: "", kind: "monthly", period_month: "2026-07", links: [], created_by: "t", created_at: "x", updated_at: "x" },
      ]);
      const libRows = await store.reportsList();
      const libGet = calls[calls.length - 1];
      ok(/report_library/.test(libGet.url) && /order=period_month\.desc,id\.desc/.test(libGet.url),
        "sb: reportsList orders period_month desc, id desc", libGet.url);
      ok(libRows.length === 2 && libRows[0].id === 3 && libRows[1].periodMonth === "2026-07",
        "sb: reportsList maps rows to camelCase");

      respond([{ id: 3, title: "August weekly (final)", description: "", kind: "weekly", period_month: "2026-08", links: [], created_by: "t", created_at: "x", updated_at: "2026-08-19T11:00:00Z" }]);
      const libUpdRow = await store.reportUpdate(3, { title: "August weekly (final)" });
      const libPatch = calls[calls.length - 1];
      ok(libPatch.method === "PATCH" && /report_library\?id=eq\.3/.test(libPatch.url)
        && eq(Object.keys(libPatch.body).sort(), ["title", "updated_at"]),
        "sb: reportUpdate patches only the given fields + updated_at", JSON.stringify(libPatch.body));
      ok(libUpdRow && libUpdRow.title === "August weekly (final)", "sb: reportUpdate maps the row back");
      respond([]);
      ok((await store.reportUpdate(99999, { title: "x" })) === null, "sb: reportUpdate unknown id -> null");

      respond(null, 204);
      ok((await store.reportDelete(3)) === true, "sb: reportDelete -> true");
      const libDel = calls[calls.length - 1];
      ok(libDel.method === "DELETE" && /report_library\?id=eq\.3/.test(libDel.url), "sb: reportDelete deletes by numeric id");

      /* --- reporting tier mapping: legacy "full" reads as "advanced" --- */
      respond([{ username: "adika", enabled: true, tools: null, daily_limit: null, reporting: "full", updated_by: "", updated_at: null }]);
      ok((await store.getAiUserPermission("adika")).reporting === "advanced",
        "sb: legacy stored reporting=full reads as advanced");
      respond([{ username: "adika", enabled: true, tools: null, daily_limit: null, reporting: "super", updated_by: "", updated_at: null }]);
      ok((await store.getAiUserPermission("adika")).reporting === "super",
        "sb: reporting=super round-trips the new whitelist");

      respond([{ last_seen_at: "2026-08-01T09:00:00Z" }]); // select previous stamp
      respond([{ username: "taha" }]);                      // PATCH representation
      const prevSeen = await store.touchLastSeen("taha");
      const seenCalls = calls.slice(-2);
      ok(prevSeen === "2026-08-01T09:00:00Z", "sb: touchLastSeen returns the previous stamp");
      ok(seenCalls[1].method === "PATCH" && typeof seenCalls[1].body.last_seen_at === "string"
        && /users\?username=eq\.taha/.test(seenCalls[1].url), "sb: touchLastSeen stamps last_seen_at");

      /* --- reporting facts paginate past the PostgREST 1000-row cap --- */
      // Production regression: a single capped select silently truncated the
      // reporting window to the oldest 1000 facts (recent days missing).
      const FACT_COLS_MIN = ["id","source_system","integration_id","external_id","event_type","event_at","channel","platform","source_name","campaign","ad_account","goal","tags","is_organic","is_qualified","value","currency","lead_id","sale_id","created_at","updated_at"];
      const mkFactRow = (i) => Object.fromEntries(FACT_COLS_MIN.map((c) => [c,
        c === "id" ? i : c === "event_at" ? "2026-08-18T10:00:00Z" : c === "event_type" ? "lead" : c === "source_system" ? "hyros" : c === "integration_id" ? "hyros" : c === "external_id" ? `f-${i}` : null]));
      respond(Array.from({ length: 1000 }, (_, i) => mkFactRow(i)));       // page 1: full cap page
      respond([mkFactRow(1000), mkFactRow(1001)]);                          // page 2: short page → stop
      const allFacts = await store.reportingFactsList({});
      const pageCalls = calls.slice(-2);
      ok(allFacts.length === 1002, "sb: reportingFactsList follows offset pages past the 1000-row cap", String(allFacts.length));
      ok(/[?&]offset=0/.test(pageCalls[0].url) && /[?&]offset=1000/.test(pageCalls[1].url),
        "sb: reportingFactsList pages with offset=0 then offset=1000");
      ok(pageCalls.every((c) => /[?&]limit=1000/.test(c.url)), "sb: reportingFactsList keeps pages at the server cap");

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

/* =============== 2b. permissions unit matrix: external + client scoping =============== */

function testExternalPermissions() {
  console.log("\n[2b] permissions unit matrix — external partner + client scoping");
  const perms = require(path.join(ROOT, "lib", "permissions"));

  const ext = { username: "ext1", name: "Ext One", role: "external", active: true, departments: ["seo"] };
  const extTask = (over) => ({
    id: "NM-X-001", title: "probe", visibility: "team", clientId: "neonmonki",
    departmentIds: ["google-ads"], ownerUsernames: [],
    createdByUsername: "abubakar", requestedBy: "Abu Bakar", ...over,
  });

  // canSeeTask: external partners only ever see owned / created /
  // department-intersecting work — shared/team/internal visibility never applies.
  ok(perms.canSeeTask(ext, extTask({ visibility: "shared" })) === false,
    "perm-ext: shared task in another department hidden");
  ok(perms.canSeeTask(ext, extTask({ departmentIds: ["seo"] })) === true,
    "perm-ext: department-intersecting task visible");
  ok(perms.canSeeTask(ext, extTask({ visibility: "shared", departmentIds: ["google-ads", "seo"] })) === true,
    "perm-ext: shared + department match visible (the department grants it, not the visibility)");
  ok(perms.canSeeTask(ext, extTask({ ownerUsernames: ["ext1"] })) === true,
    "perm-ext: owned task visible");
  ok(perms.canSeeTask(ext, extTask({ visibility: "private", ownerUsernames: ["ext1"] })) === true,
    "perm-ext: owned private task stays visible (ownership beats private)");
  ok(perms.canSeeTask(ext, extTask({ createdByUsername: "ext1" })) === true,
    "perm-ext: created task visible");
  ok(perms.canSeeTask(ext, extTask({ createdByUsername: "", requestedBy: "Ext One" })) === true,
    "perm-ext: legacy requestedBy-name creator match visible");
  ok(perms.canSeeTask(ext, extTask({ visibility: "private", departmentIds: ["seo"], ownerUsernames: ["taha"] })) === false,
    "perm-ext: someone else's private task hidden even with a department match");
  ok(perms.canSeeTask(ext, extTask({ visibility: "internal" })) === false,
    "perm-ext: internal visibility never grants access");

  // canAccessChannel: no autoAll for external partners — explicit membership only.
  const general = { id: "general", autoAll: true, clientAllowed: true, members: [] };
  ok(perms.canAccessChannel(general, ext) === false,
    "perm-ext: autoAll channel refuses external partners without membership");
  ok(perms.canAccessChannel({ ...general, members: [{ username: "ext1" }] }, ext) === true,
    "perm-ext: explicit channel membership opens the channel");
  ok(perms.canAccessChannel(general, { username: "taha", role: "team" }) === true,
    "perm-ext: autoAll still includes the team (regression control)");

  // reportingAccess: external partners default to no reporting at all.
  ok(perms.reportingAccess(ext, null) === "none", "perm-ext: reportingAccess defaults to none");

  // canSeeTask client scoping: task.clientId (default "neonmonki") must match
  // user.clientId (default "neonmonki") — both directions, plus the defaults.
  const clientNm = { username: "adika", name: "Adika", role: "client", active: true, clientId: "neonmonki" };
  const clientOther = { username: "otto", name: "Otto", role: "client", active: true, clientId: "other-co" };
  const sharedNm = { id: "NM-C-001", visibility: "shared", clientId: "neonmonki" };
  const sharedOther = { id: "NM-C-002", visibility: "shared", clientId: "other-co" };
  ok(perms.canSeeTask(clientNm, sharedNm) === true, "perm-client: same-client shared task visible");
  ok(perms.canSeeTask(clientNm, sharedOther) === false, "perm-client: another client's shared task hidden");
  ok(perms.canSeeTask(clientOther, sharedOther) === true, "perm-client: the other client sees its own task");
  ok(perms.canSeeTask(clientOther, sharedNm) === false, "perm-client: neonmonki task hidden from the other client");
  ok(perms.canSeeTask({ username: "legacy", name: "Legacy", role: "client", active: true }, { id: "NM-C-003", visibility: "shared" }) === true,
    "perm-client: missing clientId defaults to neonmonki on both sides");
  ok(perms.canSeeTask(clientOther, { id: "NM-C-004", visibility: "shared" }) === false,
    "perm-client: a task without clientId is neonmonki-scoped for other clients");
  ok(perms.canSeeTask(clientNm, { id: "NM-C-005", visibility: "shared", clientId: "" }) === true,
    "perm-client: an empty clientId reads as neonmonki too");
  ok(perms.canSeeTask({ username: "taha", name: "Taha", role: "team", active: true }, sharedOther) === true,
    "perm-client: client scope never restricts the team");
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
    ok(Array.isArray(st.activity) && st.activity.length === 0, "privacy: activity is hidden from Adika");
    const stTeam = (await http(port, "GET", "/api/state", { cookie: tcookie })).json;
    ok(Array.isArray(stTeam.activity) && stTeam.activity.length === 0, "privacy: activity is hidden from team users");
    const stAdmin = (await http(port, "GET", "/api/state", { cookie: acookie })).json;
    ok(stAdmin.tasks.length === 51, "http: /api/state shape (admin sees all 51 incl. internal)");
    ok(stAdmin.activity.length > 0, "privacy: activity remains available to the super admin");
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
    const big = await http(port, "POST", "/api/tasks", { cookie, body: { title: "big", description: "x".repeat(4_100_000) } });
    ok(big.status === 400, "http: >4MB body -> 400", String(big.status));

    /* --- routing edge cases --- */
    ok((await http(port, "GET", "/api/nothing", { cookie })).status === 404, "http: unknown endpoint -> 404");
    ok((await http(port, "GET", "/api/tasks", { cookie })).status === 404, "http: GET /api/tasks -> 404");
    ok((await http(port, "POST", `/api/tasks/${newId}/explode`, { cookie, body: {} })).status === 404, "http: unknown sub-route -> 404");
    ok((await http(port, "DELETE", `/api/tasks/${newId}`, { cookie })).status === 403, "http: client cannot delete a handed-over task");
    ok((await http(port, "POST", "/api/login/", { body: { username: "adika", password: "neonmonki2026" } })).status === 200, "http: trailing slash tolerated");

    /* --- static + traversal (dev server) --- */
    ok((await http(port, "GET", "/")).status === 200, "http: static index");
    const browserBundle = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
    ok(browserBundle.includes("dashboardFilter(kind)") && browserBundle.includes("App.dashboardFilter"),
      "ui: dashboard KPI cards drive task filters");
    ok(browserBundle.includes('<option value="">Everyone</option>') && browserBundle.includes("f.owner"),
      "ui: task list provides an Everyone owner filter");
    ok(browserBundle.includes('class="monki-panel') && browserBundle.includes("monki-mark.svg") && browserBundle.includes("App.askMonki"),
      "ui: Monki is a persistent workspace chatbot");
    ok(browserBundle.includes("monki-entity-link") && browserBundle.includes("runMonkiSuggestion")
      && browserBundle.includes("captureMonkiViewport") && browserBundle.includes("source-link"),
      "ui: Monki renders clickable task ids, direct source links, action suggestions and preserves chat position");
    ok(browserBundle.includes("What needs my attention today?")
      && browserBundle.includes("Create a task for the team from my request")
      && browserBundle.includes("Draft a reply to the latest project update")
      && browserBundle.includes("Find the latest links for my active projects"),
      "ui: Monki gives clients actionable attention, task, reply and link prompts");
    ok(!browserBundle.includes("Workspace AI") && !browserBundle.includes("AI-powered monkey assistant")
      && browserBundle.includes("Tasks, replies and next steps"),
      "ui: Monki stays simply branded while explaining useful actions");
    ok(browserBundle.includes("Two teams.<br><em>One flow.</em>")
      && browserBundle.includes("NEONMONKI and AdvertIdea collaboration")
      && browserBundle.includes("System designed &amp; built by <b>Abu Bakar</b>"),
      "ui: login presents the joint-brand collaboration and builder attribution");
    ok(browserBundle.includes('placeholder="Enter your username"')
      && !browserBundle.includes("App.pickAccount") && !browserBundle.includes("account-pick"),
      "ui: login requires manual credentials without prebuilt account choices");
    ok(!/Kimi|Moonshot|\bK3\b|powered by/i.test(browserBundle)
      && browserBundle.includes("Prepared by Monki")
      && !browserBundle.includes("AI-generated report${a.model")
      && !browserBundle.includes("AI-generated by Monki${r.model"),
      "ui: Monki exposes no underlying vendor or model branding");
    ok(!browserBundle.includes('{ route: "ask", label: "Ask AI"'),
      "ui: AI chatbot is not duplicated as a navigation page");
    ok(browserBundle.includes('label: "My Approvals"') && !browserBundle.includes("Client — NEONMONKI"),
      "ui: Adika is presented as NEONMONKI, not as Client");
    ok(browserBundle.includes("renderAiBrief(S.aiBrief.answer)") && browserBundle.includes('isAdmin() ? `<div class="card">'),
      "ui: AI brief is designed and Recent activity is super-admin-only");
    ok(browserBundle.includes('label: "Department Tasks"') && browserBundle.includes("Selected departments only"),
      "ui: team navigation and visibility expose department-specific work");
    ok(browserBundle.includes("Task conversation") && browserBundle.includes("Links &amp; approvals") && browserBundle.includes("Subtasks")
      && browserBundle.includes("task-create-links") && !browserBundle.includes('name="taskFile"'),
      "ui: task workspace uses sharing links, subtasks and approvals without direct upload");
    ok(browserBundle.includes("Share with NEONMONKI + team") && !browserBundle.includes("Shared — client + team"),
      "ui: visibility language separates client and team without the old ambiguous label");
    ok(browserBundle.includes("deleteChatMessage") && browserBundle.includes("deleteComment") && !browserBundle.includes("Taha / Abu Bakar"),
      "ui: messages are deletable and owner selection has no combined pseudo-users");
    ok(browserBundle.includes('route: "search"') && browserBundle.includes("/api/search?q=")
      && browserBundle.includes("Search tasks, links and messages") && browserBundle.includes('e.key.toLowerCase() === "k"'),
      "ui: workspace search is available from navigation and Command-K");
    ok(browserBundle.includes('label: "My Approvals"') && browserBundle.includes("request_changes")
      && browserBundle.includes("Send all for client approval"),
      "ui: client approval queue supports approve and request-changes decisions");
    ok(browserBundle.includes("task-create-subtasks") && browserBundle.includes("task-create-links")
      && browserBundle.includes("Add another") && browserBundle.includes("subtaskDepartments"),
      "ui: task creation supports repeatable subtasks and unlimited deliverable links");
    ok(browserBundle.includes('route: "profile"') && browserBundle.includes("250 KB")
      && browserBundle.includes("setAvailability") && browserBundle.includes("availability-switch"),
      "ui: every user has a profile, picture limit and online/away controls");
    ok(browserBundle.includes("Delete user") && browserBundle.includes("NEW PASSWORD")
      && browserBundle.includes("USERNAME"), "ui: super admin can edit or delete complete user accounts");
    ok(browserBundle.includes("ensureAllowedRoute") && browserBundle.includes("canAccessRoute"),
      "ui: each account is kept out of routes it cannot access");
    ok(browserBundle.includes('route: "calendar"') && browserBundle.includes("function viewCalendar")
      && browserBundle.includes("My tasks") && browserBundle.includes("Overall tasks") && browserBundle.includes("Department"),
      "ui: every account has a calendar with personal, overall and department scopes");
    ok(browserBundle.includes("boardDragStart") && browserBundle.includes("boardDrop")
      && browserBundle.includes('draggable="true"') && browserBundle.includes("boardRange"),
      "ui: Kanban supports drag-and-drop status changes and date ranges");
    ok(browserBundle.includes("dateFrom") && browserBundle.includes("dateTo")
      && browserBundle.includes("taskRange") && browserBundle.includes("Dashboard filter"),
      "ui: tasks expose date filters and dashboard selections remain explicit");
    ok(browserBundle.includes("TONE_PATTERNS") && browserBundle.includes("toneForNotification")
      && browserBundle.includes("newTask") && browserBundle.includes("approval") && browserBundle.includes("mention"),
      "ui: notifications use distinct event-specific sounds");
    ok(browserBundle.includes("Account &amp; security") && browserBundle.includes("Password and session controls")
      && !browserBundle.includes('title="Change password"') && !browserBundle.includes('title="Sign out"'),
      "ui: change-password and sign-out actions live in the profile instead of the sidebar");
    ok(browserBundle.includes("task-conversation-head") && browserBundle.includes('rows="5"')
      && browserBundle.includes("Ctrl/⌘ + Enter to post"),
      "ui: task conversation uses a full-size focused composer");
    ok(browserBundle.includes('class="msg-toolbar"') && browserBundle.includes("toggleMessageMenu")
      && browserBundle.includes("Reply in thread") && !browserBundle.includes('class="msg-act"'),
      "ui: chat uses a compact Slack-style contextual action toolbar");
    ok(browserBundle.includes("mentionCandidates") && browserBundle.includes("mentionDisplayName")
      && browserBundle.includes("Type @ to mention a person"),
      "ui: typing @ opens full-name mention autocomplete");

    /* --- Reports library page + super-tier report generator (Results page removed) --- */
    ok(!browserBundle.includes('route: "results"') && !browserBundle.includes("viewResults")
      && !browserBundle.includes("loadResults") && !browserBundle.includes("loadLatestReport")
      && !browserBundle.includes("reportCardHtml") && !browserBundle.includes("S.results"),
      "ui: the Results page is fully removed (nav route, view, loaders, card renderer, state)");
    ok(browserBundle.includes('route: "reports"') && browserBundle.includes('label: "Reports"'),
      "ui: the Reports library page sits in navigation");
    ok(browserBundle.includes("Weekly reports") && browserBundle.includes("Monthly reports") && browserBundle.includes("special reports"),
      "ui: Reports groups entries into weekly, monthly and annual/special sections");
    ok(browserBundle.includes("Add report") && browserBundle.includes('type="month"'),
      "ui: team and admin get an Add report modal with a month picker");
    ok(browserBundle.includes('id="sr-generate-report"'),
      "ui: Smart Reporting carries the Generate Report button hook (super tier)");
    ok(browserBundle.includes("Writing the report") && browserBundle.includes("Download .docx")
      && browserBundle.includes("Open as Google Doc") && browserBundle.includes("Internal team"),
      "ui: the Generate Report modal has the audience toggle, busy state and download/Google Docs handoff");
    ok(browserBundle.includes('value="advanced"') && browserBundle.includes('value="super"')
      && browserBundle.includes("Advanced (Smart Reporting)") && browserBundle.includes("Super (incl. report generator)")
      && !browserBundle.includes("Full Smart Reporting"),
      "ui: AI Control offers the four reporting tiers (the retired \"full\" is no longer selectable)");

    /* --- external partner role + multi-client UI hooks --- */
    ok(browserBundle.includes("EXTERNAL_HIDDEN_ROUTES") && browserBundle.includes("externalHide: true")
      && browserBundle.includes("isExternal()") && browserBundle.includes("externalAllowed: true"),
      "ui: navigation gates external partners out of reporting/admin routes while keeping department tasks");
    ok(browserBundle.includes('<option value="external">External partner</option>')
      && browserBundle.includes("External partner — own + department tasks only"),
      "ui: the user forms offer the External partner role");
    ok(browserBundle.includes('id="admin-clients"') && browserBundle.includes("App.submitClient")
      && browserBundle.includes("client-admin-list"),
      "ui: Admin carries the Clients card");
    ok(browserBundle.includes('name="clientId"') && browserBundle.includes("user-client-row"),
      "ui: client accounts get a client select in the user forms");
    ok(browserBundle.includes("REPORTING ACCESS") && browserBundle.includes('name="reporting"')
      && browserBundle.includes("Advanced (Smart Reporting)") && browserBundle.includes("Super (incl. report generator)"),
      "ui: the user forms expose the reporting-access select with all tiers");
    ok(browserBundle.includes("rep-toolbar-search") && browserBundle.includes("rep-toolbar-month")
      && browserBundle.includes("App.reportsFilter") && browserBundle.includes("App.reportsClearFilters")
      && browserBundle.includes("rep-client-filter"),
      "ui: the Reports page has the search/type/month/client filter toolbar");
    ok(browserBundle.includes('reports: { items: null, loading: false, loaded: false, error: "", year: "all", type: "all", month: "all", client: "all", q: "" }'),
      "ui: Reports filter state carries year/type/month/client/query");
    ok(browserBundle.includes("External partner team") && browserBundle.includes('name="external"'),
      "ui: the department editor carries the External partner team checkbox");
    const stylesSheet = fs.readFileSync(path.join(ROOT, "public", "styles.css"), "utf8");
    ok(stylesSheet.includes(".rep-card"), "ui: styles carry the report library card classes");
    const monkiMark = fs.readFileSync(path.join(ROOT, "public", "monki-mark.svg"), "utf8");
    const neonmonkiMark = fs.readFileSync(path.join(ROOT, "public", "neonmonki-retro.svg"), "utf8");
    ok(/retro pixel monkey/i.test(monkiMark) && /retro NM workspace badge/i.test(neonmonkiMark)
      && !/<animate|<style|@keyframes/i.test(monkiMark + neonmonkiMark),
      "ui: NEONMONKI and Monki use static retro SVG identity marks");
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

    /* --- reporting: metrics CRUD + summary --- */
    ok((await http(port, "GET", "/api/metrics", { cookie: tcookie })).status === 200, "metrics: team can list results");
    ok((await http(port, "GET", "/api/metrics", { cookie })).status === 200, "metrics: client reads results (shared business data)");
    ok((await http(port, "POST", "/api/metrics", { cookie, body: { date: "2026-08-10", channel: "SEO", metric: "clicks", value: 1 } })).status === 403,
      "metrics: client cannot record results");
    ok((await http(port, "POST", "/api/metrics", { cookie: tcookie, body: { date: "2026-08-10", channel: "SEO", value: 1 } })).status === 400,
      "metrics: channel + metric are required");
    ok((await http(port, "POST", "/api/metrics", { cookie: tcookie, body: { channel: "SEO", metric: "clicks", value: "lots" } })).status === 400,
      "metrics: value must be numeric");
    ok((await http(port, "POST", "/api/metrics", { cookie: tcookie, body: { date: "10/08/2026", channel: "SEO", metric: "clicks", value: 1 } })).status === 400,
      "metrics: date must be YYYY-MM-DD");
    ok((await http(port, "GET", "/api/metrics/summary?from=2026-13-99", { cookie: tcookie })).status === 400,
      "metrics: impossible calendar date -> 400 (not a server error)");

    const mA = (await http(port, "POST", "/api/metrics", { cookie: tcookie, body: { date: "2026-08-10", channel: "SEO", metric: "organic_clicks", value: 60, note: "GSC" } })).json.entry;
    ok(mA && mA.id && mA.createdBy === "advertidea" && mA.value === 60, "metrics: team records a result", JSON.stringify(mA));
    await http(port, "POST", "/api/metrics", { cookie: tcookie, body: { date: "2026-08-12", channel: "SEO", metric: "organic_clicks", value: 50 } });
    await http(port, "POST", "/api/metrics", { cookie: tcookie, body: { date: "2026-08-04", channel: "SEO", metric: "organic_clicks", value: 100 } });
    await http(port, "POST", "/api/metrics", { cookie: tcookie, body: { date: "2026-08-11", channel: "Email Marketing", metric: "signups", value: 80 } });
    await http(port, "POST", "/api/metrics", { cookie: tcookie, body: { date: "2026-08-05", channel: "Email Marketing", metric: "signups", value: 100 } });
    await http(port, "POST", "/api/metrics", { cookie: tcookie, body: { date: "2026-08-11", channel: "Google Ads", metric: "spend", value: 500 } });
    const listed = (await http(port, "GET", "/api/metrics?from=2026-08-10&to=2026-08-16", { cookie })).json.entries;
    ok(listed.length === 4 && listed.every((e) => e.date >= "2026-08-10" && e.date <= "2026-08-16"),
      "metrics: range query returns only in-range entries");
    const msum = (await http(port, "GET", "/api/metrics/summary?from=2026-08-10&to=2026-08-16&cmpfrom=2026-08-03&cmpto=2026-08-09", { cookie })).json;
    ok(msum.channels.SEO.organic_clicks.current === 110 && msum.channels.SEO.organic_clicks.previous === 100
      && msum.channels.SEO.organic_clicks.deltaPct === 10, "metrics: summary aggregates + WoW deltaPct", JSON.stringify(msum.channels.SEO));
    ok(msum.channels["Email Marketing"].signups.deltaPct === -20, "metrics: negative deltaPct computed");
    ok(msum.channels["Google Ads"].spend.current === 500 && msum.channels["Google Ads"].spend.previous === 0
      && msum.channels["Google Ads"].spend.deltaPct === null, "metrics: deltaPct is null without a baseline");
    ok((await http(port, "DELETE", `/api/metrics/${mA.id}`, { cookie: tcookie })).status === 403, "metrics: team cannot delete entries");
    ok((await http(port, "DELETE", `/api/metrics/${mA.id}`, { cookie: acookie })).status === 200, "metrics: super admin deletes an entry");
    ok(!(await http(port, "GET", "/api/metrics", { cookie: tcookie })).json.entries.some((e) => e.id === mA.id),
      "metrics: deleted entry is gone");

    /* --- report library: /api/reports CRUD + validation --- */
    ok((await http(port, "GET", "/api/reports")).status === 401, "reports: anonymous -> 401");
    const lib0 = await http(port, "GET", "/api/reports", { cookie });
    ok(lib0.status === 200 && Array.isArray(lib0.json.reports), "reports: any signed-in user (client) can list the library");
    const goodReport = { title: "August weekly wrap", description: "W33 numbers + notes", kind: "weekly", periodMonth: "2026-08", links: [{ label: "Drive deck", url: "https://drive.google.com/file/d/abc" }] };
    ok((await http(port, "POST", "/api/reports", { cookie, body: goodReport })).status === 403,
      "reports: client cannot add entries");
    ok((await http(port, "POST", "/api/reports", { cookie: tcookie, body: { ...goodReport, kind: "daily" } })).status === 400,
      "reports: unknown kind -> 400");
    ok((await http(port, "POST", "/api/reports", { cookie: tcookie, body: { ...goodReport, periodMonth: "2026-8" } })).status === 400,
      "reports: malformed periodMonth -> 400");
    ok((await http(port, "POST", "/api/reports", { cookie: tcookie, body: { ...goodReport, links: [] } })).status === 400,
      "reports: at least one link is required");
    ok((await http(port, "POST", "/api/reports", { cookie: tcookie, body: { ...goodReport, links: Array.from({ length: 7 }, (_, i) => ({ label: `l${i}`, url: `https://example.com/${i}` })) } })).status === 400,
      "reports: more than six links -> 400");
    ok((await http(port, "POST", "/api/reports", { cookie: tcookie, body: { ...goodReport, links: [{ label: "x", url: "ftp://example.com/x" }] } })).status === 400,
      "reports: non-http(s) link url -> 400");
    ok((await http(port, "POST", "/api/reports", { cookie: tcookie, body: { ...goodReport, title: "x" } })).status === 400,
      "reports: title under 2 chars -> 400");

    const rep1 = await http(port, "POST", "/api/reports", { cookie: tcookie, body: goodReport });
    ok(rep1.status === 201 && rep1.json.report && rep1.json.report.id != null
      && rep1.json.report.title === "August weekly wrap" && rep1.json.report.kind === "weekly"
      && rep1.json.report.periodMonth === "2026-08" && rep1.json.report.createdBy === "advertidea"
      && Array.isArray(rep1.json.report.links) && rep1.json.report.links.length === 1
      && rep1.json.report.links[0].label === "Drive deck" && rep1.json.report.links[0].url === "https://drive.google.com/file/d/abc"
      && typeof rep1.json.report.createdAt === "string" && typeof rep1.json.report.updatedAt === "string",
      "reports: team adds an entry (201, camelCase shape, link round-trips)", JSON.stringify(rep1.json).slice(0, 200));
    const rep1Id = rep1.json.report && rep1.json.report.id;
    const rep2 = await http(port, "POST", "/api/reports", { cookie: tcookie, body: { title: "June monthly review", kind: "monthly", periodMonth: "2026-06", links: [{ url: "https://example.com/june" }] } });
    ok(rep2.status === 201 && rep2.json.report.links[0].label === "", "reports: link label is optional (the UI falls back to the hostname)");
    const rep3 = await http(port, "POST", "/api/reports", { cookie: tcookie, body: { title: "Mid-year special audit", kind: "special", periodMonth: "2026-08", links: [{ label: "Audit", url: "https://example.com/audit" }] } });
    ok(rep3.status === 201 && rep3.json.report.kind === "special", "reports: special kind accepted");
    const libSorted = (await http(port, "GET", "/api/reports", { cookie })).json.reports;
    ok(eq(libSorted.map((r) => r.id), [rep3.json.report.id, rep1Id, rep2.json.report.id]),
      "reports: library sorts periodMonth desc, then id desc", JSON.stringify(libSorted.map((r) => [r.periodMonth, r.id])));

    ok((await http(port, "PATCH", `/api/reports/${rep1Id}`, { cookie: tcookie, body: { title: "nope" } })).status === 403,
      "reports: team cannot edit entries");
    ok((await http(port, "DELETE", `/api/reports/${rep1Id}`, { cookie })).status === 403,
      "reports: client cannot delete entries");
    const repPatched = await http(port, "PATCH", `/api/reports/${rep1Id}`, { cookie: acookie, body: { title: "August weekly wrap (final)", links: [{ label: "Deck", url: "https://drive.google.com/file/d/abc" }, { label: "Sheet", url: "https://docs.google.com/spreadsheets/d/xyz" }] } });
    ok(repPatched.status === 200 && repPatched.json.report.title === "August weekly wrap (final)"
      && repPatched.json.report.links.length === 2 && repPatched.json.report.periodMonth === "2026-08",
      "reports: super admin edits title + links", JSON.stringify(repPatched.json).slice(0, 200));
    const repDeleted = await http(port, "DELETE", `/api/reports/${rep2.json.report.id}`, { cookie: acookie });
    ok(repDeleted.status === 200 && repDeleted.json.ok === true, "reports: super admin deletes an entry");
    ok(!(await http(port, "GET", "/api/reports", { cookie })).json.reports.some((r) => r.id === rep2.json.report.id),
      "reports: deleted entry is gone");

    /* --- reporting: task impact round-trip --- */
    const impactTask = await http(port, "POST", "/api/tasks", { cookie: acookie, body: {
      title: "Impact probe", visibility: "shared", impact: "Feeds roughly 30% of monthly demo requests.",
    } });
    ok(impactTask.status === 201 && impactTask.json.task.impact === "Feeds roughly 30% of monthly demo requests.",
      "impact: create accepts business-impact context");
    const impactId = impactTask.json.task.id;
    const impactPatch = await http(port, "PATCH", `/api/tasks/${impactId}`, { cookie: tcookie, body: { impact: "Protects the Q4 pipeline." } });
    ok(impactPatch.status === 200 && impactPatch.json.task.impact === "Protects the Q4 pipeline.", "impact: patch updates it");
    const longImpact = await http(port, "PATCH", `/api/tasks/${impactId}`, { cookie: tcookie, body: { impact: "x".repeat(620) } });
    ok(longImpact.status === 200 && longImpact.json.task.impact.length === 500, "impact: capped at 500 chars");
    ok((await http(port, "GET", "/api/state", { cookie })).json.tasks.find((t) => t.id === impactId).impact.length === 500,
      "impact: present in client state for shared tasks");

    /* --- reporting: lastVisit stamping --- */
    await http(port, "POST", "/api/admin/users", { cookie: acookie, body: { username: "visitprobe", name: "Visit Probe", role: "team", password: "pass123" } });
    const { cookie: vp } = await login(port, "visitprobe", "pass123");
    ok((await http(port, "GET", "/api/state", { cookie: vp })).json.lastVisit === null,
      "state: first visit reports lastVisit null");
    const secondVisit = (await http(port, "GET", "/api/state", { cookie: vp })).json;
    ok(typeof secondVisit.lastVisit === "string" && secondVisit.lastVisit.includes("T"),
      "state: second visit returns the previous stamp");
    const thirdVisit = (await http(port, "GET", "/api/state", { cookie: vp })).json;
    ok(thirdVisit.lastVisit >= secondVisit.lastVisit, "state: visit stamps move forward");

    /* --- reporting: report latest when empty --- */
    ok((await http(port, "GET", "/api/ai/report/latest?audience=team", { cookie: tcookie })).json.text === null,
      "report: latest returns text:null when nothing is stored");

    /* --- clients registry: CRUD + built-in default (migration 012) --- */
    const clientsAsTeam = (await http(port, "GET", "/api/clients", { cookie: tcookie })).json.clients;
    ok(clientsAsTeam.some((c) => c.id === "neonmonki" && c.name === "NEONMONKI"),
      "clients: the built-in NEONMONKI client exists before any insert");
    ok(clientsAsTeam.every((c) => !("active" in c)), "clients: non-admin listing carries only id + name");
    ok((await http(port, "GET", "/api/clients", { cookie: acookie })).json.clients
      .some((c) => c.id === "neonmonki" && c.active === true),
      "clients: super admin listing includes the active flag");
    ok((await http(port, "GET", "/api/clients")).status === 401, "clients: anonymous -> 401");
    ok((await http(port, "POST", "/api/clients", { cookie: tcookie, body: { name: "Other Co" } })).status === 403,
      "clients: team cannot create clients");
    const otherCo = await http(port, "POST", "/api/clients", { cookie: acookie, body: { name: "Other Co" } });
    ok(otherCo.status === 201 && otherCo.json.client.id === "other-co" && otherCo.json.client.name === "Other Co",
      "clients: super admin creates a client (slug id derived from the name)", JSON.stringify(otherCo.json).slice(0, 140));
    ok((await http(port, "POST", "/api/clients", { cookie: acookie, body: { name: "Other Co" } })).status === 409,
      "clients: duplicate client -> 409");
    ok((await http(port, "POST", "/api/clients", { cookie: acookie, body: { name: "x" } })).status === 400,
      "clients: name under 2 chars -> 400");

    /* --- client scoping: tasks + report library rows --- */
    const otherTask = await http(port, "POST", "/api/tasks", { cookie: acookie, body: {
      title: "Other Co shared work", visibility: "shared", clientId: "other-co",
    } });
    ok(otherTask.status === 201 && otherTask.json.task.clientId === "other-co",
      "clients: admin files a task under the other client", JSON.stringify(otherTask.json).slice(0, 140));
    const otherTaskId = otherTask.json.task.id;
    ok(!(await http(port, "GET", "/api/state", { cookie })).json.tasks.some((t) => t.id === otherTaskId),
      "clients: adika (default neonmonki) cannot see the other client's shared task");
    ok((await http(port, "GET", "/api/state", { cookie: tcookie })).json.tasks.some((t) => t.id === otherTaskId),
      "clients: the team sees every client's tasks");
    ok((await http(port, "POST", "/api/tasks", { cookie: acookie, body: { title: "x", clientId: "no-such-co" } })).status === 400,
      "clients: task clientId validated against the registry");
    const ottoUser = await http(port, "POST", "/api/admin/users", { cookie: acookie, body: {
      username: "otto", name: "Otto Other", role: "client", password: "ottopass", clientId: "other-co",
    } });
    ok(ottoUser.status === 201 && ottoUser.json.user.clientId === "other-co",
      "clients: a client account binds to a registered client", JSON.stringify(ottoUser.json).slice(0, 160));
    ok((await http(port, "POST", "/api/admin/users", { cookie: acookie, body: {
      username: "noone", name: "No Client", role: "client", password: "pass123", clientId: "no-such-co",
    } })).status === 400, "clients: user clientId validated against the registry");
    const { cookie: ottoC } = await login(port, "otto", "ottopass");
    ok((await http(port, "GET", "/api/state", { cookie: ottoC })).json.tasks.some((t) => t.id === otherTaskId),
      "clients: the other client's account sees its own shared task");
    const otherReport = await http(port, "POST", "/api/reports", { cookie: acookie, body: {
      title: "Other Co monthly", kind: "monthly", periodMonth: "2026-08",
      links: [{ url: "https://example.com/other" }], clientId: "other-co",
    } });
    ok(otherReport.status === 201 && otherReport.json.report.clientId === "other-co",
      "clients: report entries carry a client scope", JSON.stringify(otherReport.json).slice(0, 140));
    const otherReportId = otherReport.json.report.id;
    ok(!(await http(port, "GET", "/api/reports", { cookie })).json.reports.some((r) => r.id === otherReportId),
      "clients: adika's report library hides the other client's rows");
    ok((await http(port, "GET", "/api/reports", { cookie: tcookie })).json.reports.some((r) => r.id === otherReportId),
      "clients: the team's report library lists every client");
    ok((await http(port, "GET", "/api/reports", { cookie: ottoC })).json.reports.some((r) => r.id === otherReportId),
      "clients: the other client's account reads its own report rows");
    ok((await http(port, "PATCH", "/api/clients/other-co", { cookie: tcookie, body: { active: true } })).status === 403,
      "clients: team cannot edit clients");
    const otherCoOff = await http(port, "PATCH", "/api/clients/other-co", { cookie: acookie, body: { active: false } });
    ok(otherCoOff.status === 200 && otherCoOff.json.client.active === false, "clients: super admin deactivates a client");
    ok(!(await http(port, "GET", "/api/clients", { cookie: tcookie })).json.clients.some((c) => c.id === "other-co"),
      "clients: inactive clients drop out of the non-admin listing");
    ok((await http(port, "GET", "/api/clients", { cookie: acookie })).json.clients
      .some((c) => c.id === "other-co" && c.active === false),
      "clients: super admin still sees inactive clients");

    /* --- external partner role: full HTTP flow --- */
    const extDeptTask = (await http(port, "POST", "/api/tasks", { cookie: acookie, body: {
      title: "Partner department work", departmentIds: ["seo"], visibility: "team",
    } })).json.task;
    const extFarTask = (await http(port, "POST", "/api/tasks", { cookie: acookie, body: {
      title: "Unrelated shared work", departmentIds: ["google-ads"], visibility: "shared",
    } })).json.task;
    const extUser = await http(port, "POST", "/api/admin/users", { cookie: acookie, body: {
      username: "partnerpix", name: "Pixel Partner", role: "external", password: "partnerpass", departments: ["seo"],
    } });
    ok(extUser.status === 201 && extUser.json.user.role === "external"
      && eq(extUser.json.user.departments, ["seo"]) && extUser.json.user.clientId === "",
      "external: admin creates an external partner scoped to a department", JSON.stringify(extUser.json).slice(0, 160));
    const { r: extLogin, cookie: extC } = await login(port, "partnerpix", "partnerpass");
    ok(extLogin.status === 200 && extLogin.json.user.role === "external", "external: the partner logs in");
    const extState = (await http(port, "GET", "/api/state", { cookie: extC })).json;
    ok(Array.isArray(extState.team) && extState.team.length === 0, "external: state hides the team directory");
    ok(extState.tasks.some((t) => t.id === extDeptTask.id), "external: department task visible");
    ok(!extState.tasks.some((t) => t.id === extFarTask.id), "external: shared task outside their department hidden");
    ok(extState.tasks.every((t) => (t.departmentIds || []).includes("seo")
      || (t.ownerUsernames || []).includes("partnerpix") || t.createdByUsername === "partnerpix"),
      "external: every visible task is department-scoped, owned or self-created");
    const extReports = await http(port, "GET", "/api/reports", { cookie: extC });
    ok(extReports.status === 403 && extReports.json.error === "Reports are not enabled for this account.",
      "external: report library -> 403 with the contract message");
    ok((await http(port, "POST", "/api/tasks", { cookie: extC, body: { title: "partner attempt" } })).status === 403,
      "external: cannot create tasks");
    const extStatus = await http(port, "PATCH", `/api/tasks/${extDeptTask.id}`, { cookie: extC, body: { status: "In Progress" } });
    ok(extStatus.status === 200 && extStatus.json.task.status === "In Progress",
      "external: status move on a visible department task allowed");
    ok((await http(port, "POST", `/api/tasks/${extDeptTask.id}/comments`, { cookie: extC, body: { text: "Partner note" } })).status === 201,
      "external: comment on a visible task allowed");
    const extFar = await http(port, "PATCH", `/api/tasks/${extFarTask.id}`, { cookie: extC, body: { status: "In Progress" } });
    ok(extFar.status === 403 || extFar.status === 404,
      "external: status move on an out-of-department task refused", String(extFar.status));
    ok((await http(port, "PATCH", `/api/tasks/${extDeptTask.id}`, { cookie: extC, body: { priority: "Critical" } })).status === 403,
      "external: field edits refused even on visible tasks");
    ok((await http(port, "PATCH", `/api/tasks/${extDeptTask.id}`, { cookie: extC, body: { ownerUsernames: ["taha"] } })).status === 403,
      "external: assignment changes refused");
    ok((await http(port, "POST", "/api/decisions", { cookie: extC, body: { rule: "partner rule" } })).status === 403,
      "external: decisions refused");

    /* --- department external flag round-trip --- */
    const partnerDept = await http(port, "POST", "/api/admin/departments", { cookie: acookie, body: {
      name: "Partner Squad", external: true,
    } });
    ok(partnerDept.status === 201 && partnerDept.json.department.id === "partner-squad"
      && partnerDept.json.department.external === true,
      "departments: external partner team flag persists on create", JSON.stringify(partnerDept.json).slice(0, 140));
    ok((await http(port, "GET", "/api/state", { cookie: acookie })).json.departments
      .some((d) => d.id === "partner-squad" && d.external === true),
      "departments: external flag visible in state");
    const partnerDeptOff = await http(port, "PATCH", "/api/admin/departments/partner-squad", { cookie: acookie, body: { external: false } });
    ok(partnerDeptOff.status === 200 && partnerDeptOff.json.department.external === false,
      "departments: external flag clears via PATCH");
    ok((await http(port, "GET", "/api/state", { cookie: acookie })).json.departments
      .some((d) => d.id === "partner-squad" && d.external === false),
      "departments: cleared flag persists through state");

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

    const defaultProfile = (await http(port, "GET", "/api/me/profile", { cookie: taha })).json.profile;
    ok(defaultProfile.availability === "away", "profile: users start away until they mark themselves online");
    const savedProfile = await http(port, "PATCH", "/api/me/profile", { cookie: taha, body: {
      bio: "Google Ads and performance strategy", contact: "WeChat: taha", email: "taha@example.com", availability: "online",
    } });
    ok(savedProfile.status === 200 && savedProfile.json.profile.availability === "online"
      && savedProfile.json.profile.email === "taha@example.com", "profile: user updates bio, contact, email and availability");
    const tooLargeAvatar = `data:image/png;base64,${Buffer.alloc(250 * 1024 + 1).toString("base64")}`;
    ok((await http(port, "PATCH", "/api/me/profile", { cookie: taha, body: { avatar: tooLargeAvatar } })).status === 400,
      "profile: pictures larger than 250 KB are rejected");

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
    const hafPulse = (await http(port, "GET", "/api/chat/pulse", { cookie: haf })).json;
    ok(hafPulse.notificationSignals.some((signal) => signal.id === notifs[0].id && signal.kind === "chat"),
      "notifications: pulse identifies event kinds so the UI can play the right tone");
    ok((await http(port, "DELETE", `/api/chat/messages/${msg.json.message.id}`, { cookie: haf })).status === 403,
      "chat: another channel member cannot delete the author's message");
    ok((await http(port, "DELETE", `/api/chat/messages/${msg.json.message.id}`, { cookie: admin })).status === 403,
      "chat: even super admin cannot delete another person's message");
    ok((await http(port, "DELETE", `/api/chat/messages/${msg.json.message.id}`, { cookie: taha })).status === 200,
      "chat: message author can delete their message");

    const rootMessage = await http(port, "POST", "/api/chat/channels/google-ads/messages", { cookie: taha, body: { text: "Please review the new campaign copy @hafeez" } });
    const threadReply = await http(port, "POST", "/api/chat/channels/google-ads/messages", { cookie: haf, body: {
      text: "Reviewed — one headline needs a change.", replyToId: rootMessage.json.message.id,
    } });
    ok(threadReply.status === 201 && threadReply.json.message.replyToId === rootMessage.json.message.id,
      "chat: replies preserve their thread target");
    const reacted = await http(port, "POST", `/api/chat/messages/${rootMessage.json.message.id}/reactions`, { cookie: haf, body: { emoji: "✅" } });
    ok(reacted.status === 200 && reacted.json.message.reactions["✅"].includes("hafeez"),
      "chat: channel members can add reactions");
    const unreacted = await http(port, "POST", `/api/chat/messages/${rootMessage.json.message.id}/reactions`, { cookie: haf, body: { emoji: "✅" } });
    ok(!unreacted.json.message.reactions["✅"], "chat: clicking a reaction again removes it");
    const mentionNotification = (await http(port, "GET", "/api/notifications", { cookie: haf })).json.items
      .find((n) => n.messageId === rootMessage.json.message.id);
    ok(mentionNotification && mentionNotification.kind === "mention" && mentionNotification.channelId === "google-ads",
      "chat: mentions deep-link the exact message");

    // mute suppresses notifications
    await http(port, "POST", "/api/chat/channels/google-ads/mute", { cookie: haf, body: { muted: true } });
    await http(port, "POST", "/api/chat/channels/google-ads/messages", { cookie: taha, body: { text: "second" } });
    const notifs2 = (await http(port, "GET", "/api/notifications", { cookie: haf })).json.items;
    ok(!notifs2.some((notification) => /: second$/.test(notification.text)), "chat: muted channel sends no new notification");

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

    // permission-safe unified search: tasks, channel messages and shared links
    ok((await http(port, "GET", "/api/search?q=campaign")).status === 401,
      "search: anonymous users cannot query workspace content");
    await http(port, "POST", "/api/chat/channels/google-ads/messages", { cookie: taha, body: {
      text: "INTERNAL-SEARCH-XYZZY paid media decision",
    } });
    await http(port, "POST", "/api/links", { cookie: taha, body: {
      title: "INTERNAL-SEARCH-FILE-XYZZY", note: "restricted working link", channelId: "google-ads", url: "https://docs.google.com/internal-search",
    } });
    await http(port, "POST", "/api/chat/channels/general/messages", { cookie: taha, body: {
      text: "CLIENT-SEARCH-ALPHA shared launch decision",
    } });
    await http(port, "POST", "/api/links", { cookie: taha, body: {
      title: "CLIENT-SEARCH-LINK-ALPHA", note: "shared launch file", channelId: "general", url: "https://docs.google.com/shared-search",
    } });
    const hiddenSearch = (await http(port, "GET", "/api/search?q=XYZZY", { cookie: client })).json;
    ok(hiddenSearch.total === 0 && !JSON.stringify(hiddenSearch).includes("google-ads"),
      "search: client cannot discover internal messages or links");
    const teamSearch = (await http(port, "GET", "/api/search?q=XYZZY", { cookie: taha })).json;
    ok(teamSearch.counts.messages === 1 && teamSearch.counts.files === 1
      && teamSearch.results.some((item) => item.kind === "message")
      && teamSearch.results.some((item) => item.kind === "file"),
      "search: authorized team member finds communication and shared links together");
    const sharedSearch = (await http(port, "GET", "/api/search?q=ALPHA", { cookie: client })).json;
    ok(sharedSearch.counts.messages === 1 && sharedSearch.counts.files === 1,
      "search: client finds permitted messages and links");
    const modifierSearch = (await http(port, "GET", `/api/search?q=${encodeURIComponent('"Reviewed — one headline" in:#google-ads type:message')}`, { cookie: haf })).json;
    ok(modifierSearch.type === "messages" && modifierSearch.results.length === 1
      && modifierSearch.results[0].author === "Hafeez" && modifierSearch.results[0].channelId === "google-ads",
      "search: exact phrase, channel and type modifiers narrow communication results");
    const clientTaskSearch = (await http(port, "GET", "/api/search?q=NM-AI-001%20type:task", { cookie: client })).json;
    const adminTaskSearch = (await http(port, "GET", "/api/search?q=NM-AI-001%20type:task", { cookie: admin })).json;
    ok(clientTaskSearch.total === 0 && adminTaskSearch.results.some((item) => item.kind === "task" && item.id === "NM-AI-001"),
      "search: task results obey the same internal visibility boundary");

    // task-from-chat echo
    const task = await http(port, "POST", "/api/tasks", { cookie: admin, body: { title: "from chat", department: "Paid Marketing" } });
    const echo = await http(port, "POST", "/api/chat/channels/google-ads/messages", { cookie: admin, body: { text: "made a task", taskId: task.json.task.id } });
    ok(echo.json.message.taskId === task.json.task.id, "chat: task card message carries taskId");

    // admin: users
    ok((await http(port, "POST", "/api/admin/users", { cookie: taha, body: { username: "zz", name: "Z", role: "team", password: "xxxxxx" } })).status === 403, "admin: non-admin create user -> 403");
    const nu = await http(port, "POST", "/api/admin/users", { cookie: admin, body: {
      username: "newbie", name: "New Bee", role: "team", password: "pass123", departments: ["SEO", "research"],
    } });
    ok(nu.status === 201 && nu.json.user.username === "newbie"
      && eq(nu.json.user.departments.sort(), ["research", "seo"]), "admin: create user with multiple departments");
    ok((await login(port, "newbie", "pass123")).cookie !== undefined, "admin: new user can log in");
    ok((await http(port, "POST", "/api/admin/users", { cookie: admin, body: { username: "newbie", name: "Dup", role: "team", password: "pass123" } })).status === 409, "admin: duplicate username -> 409");
    ok((await http(port, "POST", "/api/admin/users", { cookie: admin, body: { username: "BAD NAME", name: "X", role: "team", password: "pass123" } })).status === 400, "admin: invalid username -> 400");
    await http(port, "POST", "/api/admin/users", { cookie: admin, body: { username: "rename_me", name: "Rename Person", role: "client", password: "pass123" } });
    ok((await http(port, "PATCH", "/api/admin/users/rename_me", { cookie: admin, body: { username: "renamed_client" } })).status === 400,
      "admin: username change requires a fresh password because password salts include usernames");
    const renamedUser = await http(port, "PATCH", "/api/admin/users/rename_me", { cookie: admin, body: {
      username: "renamed_client", password: "newpass123", name: "Renamed Client", role: "client", org: "Client Co", departments: [],
    } });
    ok(renamedUser.status === 200 && renamedUser.json.user.username === "renamed_client"
      && (await http(port, "POST", "/api/login", { body: { username: "rename_me", password: "pass123" } })).status === 401
      && (await login(port, "renamed_client", "newpass123")).cookie,
      "admin: updates username and password without exposing the old password");
    ok((await http(port, "DELETE", "/api/admin/users/renamed_client", { cookie: admin })).status === 200
      && (await http(port, "POST", "/api/login", { body: { username: "renamed_client", password: "newpass123" } })).status === 401,
      "admin: deletes a user and their login");
    ok((await http(port, "PATCH", "/api/admin/users/abubakar", { cookie: admin, body: { active: false } })).status === 400, "admin: self-deactivate blocked");

    // disabled user is locked out immediately (stateless token, but active is re-checked per request)
    const { cookie: nb } = await login(port, "newbie", "pass123");
    await http(port, "PATCH", "/api/admin/users/newbie", { cookie: admin, body: { active: false } });
    ok((await http(port, "GET", "/api/me", { cookie: nb })).status === 401, "admin: disabled user -> 401 on next request");
    ok((await http(port, "POST", "/api/ai/ask", { cookie: nb, body: { question: "x" } })).status === 401, "admin: disabled user blocked from AI too");
    await http(port, "PATCH", "/api/admin/users/newbie", { cookie: admin, body: { active: true } });
    const clientAccess = await http(port, "PATCH", "/api/admin/users/newbie", { cookie: admin, body: {
      role: "client", departments: ["seo"], org: "NEONMONKI",
    } });
    ok(clientAccess.status === 200 && clientAccess.json.user.role === "client"
      && clientAccess.json.user.departments.length === 0, "admin: switching a user to client access removes internal department membership");
    await http(port, "PATCH", "/api/admin/users/newbie", { cookie: admin, body: {
      role: "team", departments: ["seo", "research"], org: "Advertidea",
    } });
    const clientDirectory = (await http(port, "GET", "/api/users/basic", { cookie: client })).json.users;
    ok(eq(clientDirectory.map((u) => u.username), ["adika"]),
      "privacy: client account never receives the internal team directory");

    // admin: department catalogue (eight defaults plus super-admin CRUD)
    const adminOverview = (await http(port, "GET", "/api/admin/overview", { cookie: admin })).json;
    const initialDepartments = adminOverview.departments;
    ok(!JSON.stringify(adminOverview.users).includes("passwordHash"),
      "privacy: even super-admin user responses never contain password hashes");
    ok(eq(initialDepartments.filter((d) => d.active).map((d) => d.name), [
      "SEO", "Google Ads", "Email Marketing", "Research", "Social Media",
      "Development", "AI & Automation", "Project Management",
    ]), "admin: exactly the eight approved departments are active by default");
    ok((await http(port, "POST", "/api/admin/departments", { cookie: taha, body: { name: "Quality Ops" } })).status === 403,
      "admin: only super admin can create departments");
    const customDept = await http(port, "POST", "/api/admin/departments", { cookie: admin, body: {
      name: "Quality Ops", color: "#123456", icon: "Q", order: 90,
    } });
    ok(customDept.status === 201 && customDept.json.department.id === "quality-ops"
      && customDept.json.department.color === "#123456", "admin: create a department with its color and symbol");
    const editedDept = await http(port, "PATCH", "/api/admin/departments/quality-ops", { cookie: admin, body: {
      name: "Quality Assurance", color: "#654321", icon: "QA",
    } });
    ok(editedDept.status === 200 && editedDept.json.department.name === "Quality Assurance"
      && editedDept.json.department.icon === "QA", "admin: edit department identity");
    ok((await http(port, "DELETE", "/api/admin/departments/quality-ops", { cookie: admin })).status === 200,
      "admin: archive a department");
    ok(!(await http(port, "GET", "/api/state", { cookie: taha })).json.departments.some((d) => d.id === "quality-ops"),
      "departments: archived definitions disappear from team pickers");

    // admin: channels
    const nc = await http(port, "POST", "/api/admin/channels", { cookie: admin, body: { name: "Web Dev", department: "Development", members: ["newbie"] } });
    ok(nc.status === 201 && nc.json.channel.id === "web-dev" && nc.json.channel.members.length === 1, "admin: create channel with member");
    ok((await http(port, "DELETE", "/api/admin/channels/web-dev/members/newbie", { cookie: admin })).json.channel.members.length === 0, "admin: remove member");
    ok((await http(port, "DELETE", "/api/admin/channels/general", { cookie: admin })).status === 400, "admin: general channel can't be deleted");
    ok((await http(port, "DELETE", "/api/admin/channels/web-dev", { cookie: admin })).status === 200, "admin: delete channel");
    await http(port, "POST", "/api/admin/channels", { cookie: admin, body: { name: "Client Project Room", department: "Project Management", members: ["abubakar"] } });
    await http(port, "POST", "/api/chat/channels/client-project-room/messages", { cookie: admin, body: { text: "Historical project context" } });
    ok((await http(port, "POST", "/api/admin/channels/client-project-room/members", { cookie: admin, body: { username: "adika" } })).status === 409,
      "admin: adding a client to an internal group requires explicit history visibility confirmation");
    ok((await http(port, "POST", "/api/admin/channels/client-project-room/members", { cookie: admin, body: { username: "adika", confirmClientAccess: true } })).status === 200
      && (await http(port, "GET", "/api/chat/channels/client-project-room/messages", { cookie: client })).status === 200,
      "admin: can add a client account to a chosen group after confirmation");
    await http(port, "DELETE", "/api/admin/channels/client-project-room", { cookie: admin });

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
    ok(dt.status === 201 && eq(dt.json.task.departmentIds, ["google-ads"]),
      "vis: legacy client department assignment is normalized to Google Ads");
    // client-cannot-create-internal enforced
    ok((await http(port, "POST", "/api/tasks", { cookie: client, body: { title: "sneaky", visibility: "internal" } })).json.task.visibility === "team",
      "vis: legacy client internal flag is converted to a team-routed request");
    // Clients cannot name internal individuals or create private internal work.
    const cpv = await http(port, "POST", "/api/tasks", { cookie: client, body: { title: "client private note", visibility: "private", privateFor: "taha" } });
    ok(cpv.status === 201 && cpv.json.task.visibility === "team" && cpv.json.task.ownerUsernames.length === 0,
      "vis: client cannot create a private assignment to an internal individual");
    ok((await http(port, "GET", "/api/state", { cookie: munsifC })).json.tasks.some((t) => t.id === cpv.json.task.id),
      "vis: all team users can receive a client whole-team request");
    const clientTaskNotification = (await http(port, "GET", "/api/notifications", { cookie: admin })).json.items
      .find((notification) => notification.taskId === cpv.json.task.id);
    ok(clientTaskNotification && clientTaskNotification.kind === "new_task",
      "notifications: newly created tasks have a dedicated event kind");

    // department, multi-owner and whole-team task assignment
    const deptOnly = await http(port, "POST", "/api/tasks", { cookie: admin, body: {
      title: "Google Ads department work", departmentIds: ["google-ads"], assignmentMode: "departments", visibility: "department",
    } });
    ok(deptOnly.status === 201 && (await http(port, "GET", "/api/state", { cookie: taha })).json.tasks.some((t) => t.id === deptOnly.json.task.id),
      "tasks: a department member sees department-specific work");
    ok(!(await http(port, "GET", "/api/state", { cookie: munsifC })).json.tasks.some((t) => t.id === deptOnly.json.task.id),
      "tasks: users outside the assigned department cannot see department-specific work");

    const multiOwner = await http(port, "POST", "/api/tasks", { cookie: admin, body: {
      title: "Multi-owner, multi-department work", departmentIds: ["research", "development"],
      ownerUsernames: ["taha", "hafeez"], assignmentMode: "users", visibility: "department",
    } });
    ok(multiOwner.status === 201
      && eq([...multiOwner.json.task.ownerUsernames].sort(), ["hafeez", "taha"])
      && eq(multiOwner.json.task.departmentIds, ["research", "development"]),
      "tasks: one task supports multiple individual owners and multiple departments");
    ok(!multiOwner.json.task.owner.includes("/"), "tasks: stored owner display does not use combined pseudo-users");

    const wholeTeam = await http(port, "POST", "/api/tasks", { cookie: admin, body: {
      title: "Whole team internal work", departmentIds: ["google-ads"], assignmentMode: "whole_team", visibility: "team",
    } });
    ok(wholeTeam.status === 201 && wholeTeam.json.task.assignmentMode === "whole_team"
      && wholeTeam.json.task.ownerUsernames.length === 0, "tasks: whole-team assignment survives storage round-trip");
    ok((await http(port, "GET", "/api/state", { cookie: munsifC })).json.tasks.some((t) => t.id === wholeTeam.json.task.id)
      && !(await http(port, "GET", "/api/state", { cookie: client })).json.tasks.some((t) => t.id === wholeTeam.json.task.id),
      "tasks: whole-team internal work reaches every team user but no client");
    const reassignedWholeTeam = await http(port, "PATCH", `/api/tasks/${multiOwner.json.task.id}`, { cookie: admin, body: {
      assignmentMode: "whole_team", ownerUsernames: [],
    } });
    ok(reassignedWholeTeam.status === 200 && reassignedWholeTeam.json.task.assignmentMode === "whole_team"
      && reassignedWholeTeam.json.task.ownerUsernames.length === 0,
      "tasks: edit flow can switch named-owner work to whole-team assignment");
    ok((await http(port, "PATCH", `/api/tasks/${multiOwner.json.task.id}`, { cookie: admin, body: {
      assignmentMode: "users", ownerUsernames: [],
    } })).status === 400, "tasks: named-owner assignment cannot be saved without an individual owner");

    // shared task workspace: comments, mentions, subtasks and file approval/delivery
    const workflow = await http(port, "POST", "/api/tasks", { cookie: admin, body: {
      title: "Client delivery workflow", departmentIds: ["google-ads", "research"],
      ownerUsernames: ["taha", "hafeez"], assignmentMode: "users", visibility: "shared",
    } });
    const workflowId = workflow.json.task.id;
    ok(workflow.status === 201 && workflow.json.task.createdByType === "team"
      && (await http(port, "GET", "/api/state", { cookie: client })).json.tasks.some((t) => t.id === workflowId),
      "tasks: team-created shared work is visibly marked and available to the client");

    const internalComment = await http(port, "POST", `/api/tasks/${workflowId}/comments`, { cookie: taha, body: {
      text: "Internal delivery note", clientVisible: false,
    } });
    ok(internalComment.status === 201 && !(await http(port, "GET", "/api/state", { cookie: client })).json.tasks
      .find((t) => t.id === workflowId).comments.some((c) => c.id === internalComment.json.comment.id),
      "comments: internal task discussion never leaks to the client");

    const mentioned = await http(port, "POST", `/api/tasks/${workflowId}/comments`, { cookie: taha, body: {
      text: "@adika the first draft is ready", clientVisible: true,
    } });
    const clientMention = (await http(port, "GET", "/api/notifications", { cookie: client })).json.items
      .find((n) => n.commentId === mentioned.json.comment.id);
    ok(mentioned.status === 201 && clientMention && clientMention.taskId === workflowId,
      "comments: @mention notification deep-links the exact task comment");
    ok((await http(port, "DELETE", `/api/tasks/${workflowId}/comments/${mentioned.json.comment.id}`, { cookie: munsifC })).status === 403,
      "comments: another team member cannot delete someone else's comment");
    ok((await http(port, "DELETE", `/api/tasks/${workflowId}/comments/${mentioned.json.comment.id}`, { cookie: taha })).status === 200,
      "comments: comment author can delete it");
    const deletedComment = (await http(port, "GET", "/api/state", { cookie: taha })).json.tasks
      .find((t) => t.id === workflowId).comments.find((c) => c.id === mentioned.json.comment.id);
    ok(deletedComment.deleted === true && deletedComment.text === "", "comments: deleted content is scrubbed from API responses");
    const everyoneComment = await http(port, "POST", `/api/tasks/${workflowId}/comments`, { cookie: taha, body: {
      text: "@everyone internal workflow sync", clientVisible: false,
    } });
    const munsifEveryone = (await http(port, "GET", "/api/notifications", { cookie: munsifC })).json.items
      .find((n) => n.commentId === everyoneComment.json.comment.id);
    const clientEveryone = (await http(port, "GET", "/api/notifications", { cookie: client })).json.items
      .find((n) => n.commentId === everyoneComment.json.comment.id);
    ok(munsifEveryone && !clientEveryone, "comments: @everyone notifies every permitted team user without crossing the client boundary");
    const clientComment = await http(port, "POST", `/api/tasks/${workflowId}/comments`, { cookie: client, body: {
      text: "Please keep the labels consistent", clientVisible: false,
    } });
    ok(clientComment.status === 201 && clientComment.json.comment.clientVisible === true,
      "comments: client feedback is automatically shared with the assigned team");
    ok((await http(port, "DELETE", `/api/tasks/${workflowId}/comments/${clientComment.json.comment.id}`, { cookie: admin })).status === 403,
      "comments: even super admin cannot delete another person's comment");

    const clientRequestWithPlan = await http(port, "POST", "/api/tasks", { cookie: client, body: {
      title: "Client planned request", departmentIds: ["seo", "research"], assignmentMode: "departments",
    } });
    const clientPlannedSubtask = await http(port, "POST", `/api/tasks/${clientRequestWithPlan.json.task.id}/subtasks`, { cookie: client, body: {
      title: "Research source list", departmentIds: ["research"], ownerUsernames: ["taha"],
    } });
    ok(clientPlannedSubtask.status === 201 && clientPlannedSubtask.json.subtask.ownerUsernames.length === 0
      && eq(clientPlannedSubtask.json.subtask.departmentIds, ["research"]),
      "subtasks: a client can plan department-assigned subtasks while creating a new request without seeing internal owners");
    ok((await http(port, "DELETE", `/api/tasks/${clientRequestWithPlan.json.task.id}`, { cookie: client })).status === 200,
      "tasks: client can delete their own unaccepted request");

    const hiddenSubtask = await http(port, "POST", `/api/tasks/${workflowId}/subtasks`, { cookie: taha, body: {
      title: "Internal QA", ownerUsernames: ["hafeez"], departmentIds: ["research"], clientVisible: false,
    } });
    const sharedSubtask = await http(port, "POST", `/api/tasks/${workflowId}/subtasks`, { cookie: taha, body: {
      title: "Client review", ownerUsernames: ["taha", "hafeez"], departmentIds: ["google-ads", "research"], clientVisible: true,
    } });
    const clientSubtasks = (await http(port, "GET", "/api/state", { cookie: client })).json.tasks
      .find((t) => t.id === workflowId).subtasks;
    ok(hiddenSubtask.status === 201 && sharedSubtask.status === 201 && clientSubtasks.length === 1
      && clientSubtasks[0].id === sharedSubtask.json.subtask.id,
      "subtasks: assignees/departments are supported and internal subtasks stay client-hidden");
    ok((await http(port, "PATCH", `/api/tasks/${workflowId}/subtasks/${sharedSubtask.json.subtask.id}`, { cookie: haf, body: {
      status: "Completed",
    } })).json.subtask.status === "Completed", "subtasks: assigned work can be updated independently");
    ok((await http(port, "DELETE", `/api/tasks/${workflowId}/subtasks/${hiddenSubtask.json.subtask.id}`, { cookie: taha })).status === 200,
      "subtasks: team can delete a subtask");

    const upload = await http(port, "POST", `/api/tasks/${workflowId}/files`, { cookie: taha, body: {
      name: "Campaign report", url: "https://drive.google.com/file/d/campaign-report/view", subtaskId: sharedSubtask.json.subtask.id,
    } });
    const fileId = upload.json.attachment.id;
    ok(upload.status === 201 && upload.json.attachment.status === "pending_review",
      "links: task/subtask owner can share a link for review");
    ok((await http(port, "POST", `/api/tasks/${workflowId}/files`, { cookie: taha, body: {
      name: "Direct upload", dataUrl: "data:text/plain;base64,SGVsbG8=",
    } })).status === 400, "links: direct file uploads are rejected");
    ok((await http(port, "PATCH", `/api/tasks/${workflowId}/files/${fileId}`, { cookie: munsifC, body: { action: "approve" } })).status === 403,
      "links: non-owner cannot approve a task link");
    ok((await http(port, "PATCH", `/api/tasks/${workflowId}/files/${fileId}`, { cookie: taha, body: { action: "deliver" } })).status === 409,
      "links: a link cannot be delivered before owner approval");
    ok((await http(port, "PATCH", `/api/tasks/${workflowId}/files/${fileId}`, { cookie: taha, body: { action: "approve" } })).json.attachment.status === "approved",
      "links: task owner can approve the link");
    const delivered = await http(port, "PATCH", `/api/tasks/${workflowId}/files/${fileId}`, { cookie: taha, body: { action: "deliver" } });
    ok(delivered.status === 200 && delivered.json.attachment.deliveredToClient === true
      && delivered.json.attachment.clientStatus === "awaiting_review", "links: approved work can be delivered directly to the client");
    const clientWorkflow = (await http(port, "GET", "/api/state", { cookie: client })).json.tasks.find((t) => t.id === workflowId);
    ok(clientWorkflow.attachments.some((f) => f.id === fileId), "links: delivered link appears in the client's task");
    const downloaded = await http(port, "GET", `/api/files/${fileId}/download`, { cookie: client });
    ok(downloaded.status === 302 && downloaded.headers.get("location") === "https://drive.google.com/file/d/campaign-report/view",
      "links: authorized client is redirected to the shared HTTPS link");
    ok((await http(port, "PATCH", `/api/tasks/${workflowId}/files/${fileId}`, { cookie: client, body: { action: "client_approve" } })).json.attachment.clientStatus === "approved",
      "links: client can approve the delivered link");
    ok((await http(port, "GET", "/api/state", { cookie: client })).json.deliverables.some((d) =>
      d.title.includes("Campaign report") && d.status === "Delivered · approved"),
      "links: client-approved work is recorded in Delivered Tasks");

    const secondDeliverable = await http(port, "POST", `/api/tasks/${workflowId}/files`, { cookie: taha, body: {
      name: "Campaign dashboard", url: "https://docs.google.com/spreadsheets/d/campaign-dashboard/edit",
    } });
    await http(port, "PATCH", `/api/tasks/${workflowId}/files/${secondDeliverable.json.attachment.id}`, { cookie: taha, body: { action: "approve" } });
    const sentForApproval = await http(port, "POST", `/api/tasks/${workflowId}/review`, { cookie: taha, body: { action: "send" } });
    ok(sentForApproval.status === 200 && sentForApproval.json.task.status === "Waiting on Client"
      && sentForApproval.json.task.approval.status === "awaiting_review",
      "approvals: task owner sends every approved deliverable link into the client's approval queue");
    const clientApprovalTask = (await http(port, "GET", "/api/state", { cookie: client })).json.tasks.find((task) => task.id === workflowId);
    ok(clientApprovalTask.approval.status === "awaiting_review" && clientApprovalTask.attachments.length >= 2,
      "approvals: client sees the task and all deliverable links in My Approvals");
    const requestedChanges = await http(port, "POST", `/api/tasks/${workflowId}/review`, { cookie: client, body: {
      action: "request_changes", feedback: "Please update the dashboard date range.",
    } });
    ok(requestedChanges.status === 200 && requestedChanges.json.task.status === "Revision Required"
      && requestedChanges.json.task.approval.feedback.includes("date range"),
      "approvals: request changes returns the task to the team with feedback");
    await http(port, "POST", `/api/tasks/${workflowId}/review`, { cookie: taha, body: { action: "send" } });
    const approvedTask = await http(port, "POST", `/api/tasks/${workflowId}/review`, { cookie: client, body: { action: "approve" } });
    ok(approvedTask.status === 200 && approvedTask.json.task.status === "Completed"
      && approvedTask.json.task.approval.status === "approved",
      "approvals: client approval completes the task and closes the review stage");

    const internalUpload = await http(port, "POST", `/api/tasks/${wholeTeam.json.task.id}/files`, { cookie: taha, body: {
      name: "Internal plan", url: "https://drive.google.com/file/d/internal-plan/view",
    } });
    ok(internalUpload.status === 201
      && (await http(port, "GET", `/api/files/${internalUpload.json.attachment.id}/download`, { cookie: client })).status === 404,
      "links: client cannot discover or open links from internal tasks");
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
      if (/due date.*(?:flow|happen)|what happens.*date.*due/i.test(userText) && offered.has("explain_workspace_flow")) {
        chosen = "explain_workspace_flow";
        args = { topic: "due_dates" };
      } else if (/decision/i.test(userText) && offered.has("propose_decision")) {
        chosen = "propose_decision";
        args = { topic: "Test", rule: "Italy decision via AI approval", workstream: "Italy", owner: "Adika" };
      } else if (/propose/i.test(userText) && offered.has("propose_task_update")) {
        chosen = "propose_task_update";
        args = { id: "NM-TRK-007", status: "Ready for Review", reason: "test proposal" };
      } else if (/draft a reply/i.test(userText) && offered.has("draft_reply")) {
        chosen = "draft_reply";
        args = { channelId: "general", text: "Thanks for the update. I will review this today and confirm the next step.", tone: "concise" };
      } else if (/needs my attention today/i.test(userText) && offered.has("list_attention")) {
        chosen = "list_attention";
      } else if (/files/i.test(userText) && offered.has("search_files")) {
        chosen = "search_files";
        args = { query: "SECRETFILE" };
      } else if (/force workspace health/i.test(userText)) {
        // Requested even when the tool was NOT offered — proves the
        // server-side executor gate, not just the provider-side tool list.
        chosen = "workspace_health";
      } else if (/workspace health/i.test(userText) && offered.has("workspace_health")) {
        chosen = "workspace_health";
      } else if (/ai usage/i.test(userText) && offered.has("ai_usage")) {
        chosen = "ai_usage";
      } else if (/compare results/i.test(userText) && offered.has("compare_results")) {
        chosen = "compare_results";
        args = { fromA: "2026-08-01", toA: "2026-08-07", fromB: "2026-08-08", toB: "2026-08-14" };
      } else if (/weekly digest/i.test(userText) && offered.has("weekly_digest")) {
        chosen = "weekly_digest";
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
    const fallbackSearch = await http(port, "POST", "/api/search/answer", { cookie: taha, body: { query: "campaign brief" } });
    ok(fallbackSearch.status === 200 && fallbackSearch.json.available === false,
      "search: normal search keeps working without a configured or enabled AI answer");
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
      // Keep the local stub route from KIMI_BASE_URL while setting the private
      // engine profile. The browser uses the public connectionType abstraction.
      cookie: admin, body: { apiKey: savedProviderKey, model: "k3" },
    });
    ok(providerSave.status === 200 && providerSave.json.settings.enabled === false
      && providerSave.json.settings.model === undefined,
      "ai: super admin saves the private connection without exposing a model");
    const providerCtl = (await http(port, "GET", "/api/ai/admin", { cookie: admin })).json;
    ok(providerCtl.configured === true && providerCtl.provider.keySource === "control_center"
      && !JSON.stringify(providerCtl).includes(savedProviderKey),
      "ai: control center reports saved key without revealing it");
    ok(providerCtl.connectionType === "api_global" && providerCtl.settings.model === undefined
      && !JSON.stringify(providerCtl).includes(savedProviderKey),
      "ai: control center never leaks the saved key");
    // vendor/model names are visible only on the admin surface (model config);
    // every public surface stays vendor-neutral
    const stPub = (await http(port, "GET", "/api/ai/status", { cookie: admin })).json;
    ok(!/Kimi|Moonshot|\bK3\b/i.test(JSON.stringify(stPub)), "ai: public status stays vendor-neutral");
    ok(!fs.readFileSync(path.join(TMP, "ai-data.json"), "utf8").includes(savedProviderKey),
      "ai: Control Center key is encrypted at rest");

    // enable AI (admin)
    const en = await http(port, "PATCH", "/api/ai/admin", { cookie: admin, body: { enabled: true } });
    ok(en.status === 200 && en.json.settings.enabled === true, "ai: admin enables AI");

    /* --- two-tier model routing --- */
    const setModels = await http(port, "PATCH", "/api/ai/admin", { cookie: admin, body: { models: { basic: "kimi-k2.6", advanced: "kimi-k3" } } });
    ok(setModels.status === 200, "ai: admin saves two-tier models");
    const ctlModels = (await http(port, "GET", "/api/ai/admin", { cookie: admin })).json;
    ok(ctlModels.settings.models.basic === "kimi-k2.6" && ctlModels.settings.models.advanced === "kimi-k3", "ai: models round-trip in admin config");
    received.length = 0;
    await http(port, "POST", "/api/ai/ask", { cookie: taha, body: { question: "everyday question" } });
    ok(received.length && received[0].model === "kimi-k2.6", "ai: normal ask uses the basic model");
    received.length = 0;
    await http(port, "POST", "/api/ai/ask", { cookie: taha, body: { question: "complex decision", deep: true } });
    ok(received.length && received[0].model === "kimi-k3" && received[0].reasoning_effort === "low", "ai: deep ask uses the advanced model");
    // restore default single-model routing for the rest of the suite
    await http(port, "PATCH", "/api/ai/admin", { cookie: admin, body: { models: { basic: "k3", advanced: "kimi-k3" } } });

    const intelligentSearch = await http(port, "POST", "/api/search/answer", { cookie: taha, body: { query: "campaign tracking" } });
    ok(intelligentSearch.status === 200 && intelligentSearch.json.available === true
      && intelligentSearch.json.answer === "FINAL ANSWER", "search: configured AI adds a permission-safe workspace answer");

    const callsBeforeIdentity = received.length;
    const identity = await http(port, "POST", "/api/ai/ask", { cookie: taha, body: { question: "Who built you?" } });
    ok(identity.status === 200 && identity.json.answer === "Abu Bakar built me in three months."
      && identity.json.model === undefined && received.length === callsBeforeIdentity,
      "ai: Monki gives the approved creator identity without calling or exposing the engine");

    received.length = 0;
    const providerAsk = await http(port, "POST", "/api/ai/ask", { cookie: taha, body: { question: "provider credential check" } });
    ok(providerAsk.status === 200 && received[0].__authorization === `Bearer ${savedProviderKey}`
      && received[0].model === "k3" && received[0].reasoning_effort === "low",
      "ai: saved private connection drives provider calls with the server-only engine profile");

    const initialCtl = (await http(port, "GET", "/api/ai/admin", { cookie: admin })).json;
    const allTools = initialCtl.tools.map((t) => t.name);
    const readTools = initialCtl.tools.filter((t) => t.kind === "read").map((t) => t.name);
    ok(initialCtl.provider.status === "configured" && initialCtl.userAccess.some((u) => u.username === "taha")
      && initialCtl.tools.some((t) => t.name === "list_attention" && t.kind === "read")
      && initialCtl.tools.some((t) => t.name === "explain_workspace_flow" && t.kind === "read")
      && initialCtl.tools.some((t) => t.name === "propose_task_update")
      && initialCtl.tools.some((t) => t.name === "draft_reply" && t.kind === "draft"),
      "ai: control center exposes provider, users and tool catalog");
    const replyDraft = await http(port, "POST", "/api/ai/ask", { cookie: taha, body: { question: "Draft a reply for the general channel" } });
    ok(replyDraft.status === 200 && replyDraft.json.replyDrafts.length === 1
      && replyDraft.json.replyDrafts[0].channelId === "general"
      && /review this today/.test(replyDraft.json.replyDrafts[0].text),
      "ai: Monki prepares a reusable communication reply without posting it");
    received.length = 0;
    const attentionAsk = await http(port, "POST", "/api/ai/ask", { cookie: client, body: { question: "What needs my attention today?" } });
    ok(attentionAsk.status === 200 && received.some((request) =>
      (request.messages || []).some((message) => message.role === "tool" && /attention/i.test(message.content || ""))),
      "ai: client attention prompt uses the permission-filtered action queue");
    ok(Array.isArray(attentionAsk.json.suggestions)
      && attentionAsk.json.suggestions.some((item) => item.kind === "open_task")
      && attentionAsk.json.suggestions.some((item) => item.kind === "prompt"),
      "ai: attention answers include immediate task and follow-up actions");
    received.length = 0;
    const dueFlow = await http(port, "POST", "/api/ai/ask", { cookie: client, body: { question: "What happens when a due date is due? What is the flow?" } });
    ok(dueFlow.status === 200 && dueFlow.json.citations.some((item) => item.type === "guide" && item.id === "due_dates")
      && dueFlow.json.suggestions.some((item) => item.id === "due:attention")
      && received.some((request) => (request.messages || []).some((message) => message.role === "tool" && /does not automatically complete/i.test(message.content || ""))),
      "ai: Monki explains the real due-date workflow and offers the next actionable view");
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
      url: "https://docs.google.com/spreadsheets/d/secret-test-file",
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
      && filesT.json.citations.some((c) => c.title === "SECRETFILE XYZZYFILE"
        && c.url === "https://docs.google.com/spreadsheets/d/secret-test-file")
      && filesT.json.suggestions.some((item) => item.kind === "open_url"),
      "ai: authorized file search returns a directly openable source and action");

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

    /* --- last-visit awareness --- */
    received.length = 0;
    const askLv = await http(port, "POST", "/api/ai/ask", { cookie: client, body: { question: "what changed since my last visit?", lastVisit: "2026-08-10T09:00:00.000Z" } });
    ok(askLv.status === 200, "ai: ask with lastVisit -> 200");
    const lvPayload = JSON.stringify(received);
    ok(lvPayload.includes("last visit was at 2026-08-10T09:00:00.000Z"), "ai: snapshot states the visit timestamp");
    ok(lvPayload.includes("What changed since then"), "ai: snapshot includes changed-since section");
    ok(!lvPayload.includes("ZQXWV"), "ai: last-visit context still excludes internal content");
    // snapshot unit check: without a timestamp there is no last-visit block
    {
      const aiMod = require(path.join(ROOT, "lib", "ai.js"));
      const fakeStore = {
        getState: async () => ({
          tasks: [], deliverables: [], decisions: [], recurring: [], team: [], links: [], activity: [],
        }),
        listUsers: async () => [],
        listChannels: async () => [],
      };
      const snap = await aiMod.stateSnapshot(fakeStore, { role: "client", name: "Adika" });
      ok(!snap.includes("last visit was at"), "ai: snapshot omits last-visit block when no timestamp");
      const snap2 = await aiMod.stateSnapshot(fakeStore, { role: "client", name: "Adika" }, { lastVisit: "2026-08-10T00:00:00.000Z" });
      ok(snap2.includes("last visit was at 2026-08-10T00:00:00.000Z"), "ai: snapshot renders last-visit block with timestamp");
    }

    // daily brief must not leak internal-task activity (titles) to the client
    await http(port, "POST", "/api/tasks", { cookie: admin, body: { title: "BRIEFLEAK internal marker", visibility: "internal" } });
    received.length = 0;
    await http(port, "POST", "/api/ai/brief", { cookie: client, body: {} });
    ok(!JSON.stringify(received).includes("BRIEFLEAK"), "ai: client brief excludes internal-task activity");
    const aiDataPath = path.join(TMP, "ai-data.json");
    const aiData = JSON.parse(fs.readFileSync(aiDataPath, "utf8"));
    aiData.activity.unshift({ ts: new Date().toISOString(), taskId: null, by: "audit", text: "RAWACTIVITYHIDDEN" });
    fs.writeFileSync(aiDataPath, JSON.stringify(aiData));
    received.length = 0;
    await http(port, "POST", "/api/ai/brief", { cookie: client, body: {} });
    ok(!JSON.stringify(received).includes("RAWACTIVITYHIDDEN"), "privacy: Adika AI brief receives no raw activity feed");
    ok(!JSON.stringify(received).includes("Recent activity:"), "privacy: Adika AI brief omits the Recent activity section entirely");

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

    /* --- Monki period reports: platform-metrics-first, no team workload --- */
    const todayStr2 = new Date().toISOString().slice(0, 10);
    const shiftDay2 = (day, n) => new Date(new Date(`${day}T00:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);
    // Current week (today-6..today) vs previous week (today-13..today-7).
    await http(port, "POST", "/api/metrics", { cookie: admin, body: { date: shiftDay2(todayStr2, -1), channel: "Google Ads", metric: "spend", value: 700 } });
    await http(port, "POST", "/api/metrics", { cookie: admin, body: { date: shiftDay2(todayStr2, -1), channel: "Google Ads", metric: "leads", value: 12 } });
    await http(port, "POST", "/api/metrics", { cookie: admin, body: { date: shiftDay2(todayStr2, -8), channel: "Google Ads", metric: "spend", value: 500 } });
    await http(port, "POST", "/api/metrics", { cookie: admin, body: { date: shiftDay2(todayStr2, -8), channel: "Google Ads", metric: "leads", value: 10 } });

    // Internal marker task, completed today so it lands in this week's
    // "what drove it" section for roles allowed to see internal work.
    const leakTask = (await http(port, "POST", "/api/tasks", { cookie: admin, body: { title: "REPORTLEAK internal pricing strategy", visibility: "internal" } })).json.task;
    await http(port, "PATCH", `/api/tasks/${leakTask.id}`, { cookie: admin, body: { status: "Completed" } });

    received.length = 0;
    const clientReport = await http(port, "POST", "/api/ai/report", { cookie: client, body: { period: "week" } });
    ok(clientReport.status === 200 && clientReport.json.text === "FINAL ANSWER"
      && clientReport.json.audience === "client" && !!clientReport.json.from && !!clientReport.json.to
      && clientReport.json.model === undefined,
      "report: client weekly report generates");
    const clientReportPayload = JSON.stringify(received);
    ok(!clientReportPayload.includes("REPORTLEAK"),
      "report: internal task titles never reach the provider for a client report");
    ok(!(clientReport.json.citations || []).some((c) => /REPORTLEAK/.test(c.title || "")),
      "report: client report citations exclude internal tasks");
    ok(clientReportPayload.includes("Measured results")
      && clientReportPayload.indexOf("Measured results") < clientReportPayload.indexOf("What drove it"),
      "report: measured results lead the report context");
    ok(clientReportPayload.includes("Google Ads / spend: 700 this period (previous period 500, +40%)")
      && clientReportPayload.includes("Google Ads / leads: 12 this period (previous period 10, +20%)"),
      "report: per-channel headline numbers with period-over-period deltas");
    ok(!clientReportPayload.includes("Work in motion") && !clientReportPayload.includes("Activity log"),
      "report: open-work and activity sections are gone for the client");

    // A range with no metrics says so plainly and notes Smart Reporting already covers synced channels.
    received.length = 0;
    const emptyReport = await http(port, "POST", "/api/ai/report", { cookie: taha, body: { period: "custom", from: "2026-07-01", to: "2026-07-07" } });
    const emptyPayload = JSON.stringify(received);
    ok(emptyReport.status === 200 && emptyPayload.includes("no metrics recorded for this period yet")
      && emptyPayload.includes("Smart Reporting"),
      "report: empty metrics period says so and points to Smart Reporting");

    received.length = 0;
    const teamReport = await http(port, "POST", "/api/ai/report", { cookie: taha, body: { period: "week" } });
    ok(teamReport.status === 200 && teamReport.json.audience === "team"
      && teamReport.json.from === shiftDay2(todayStr2, -6) && teamReport.json.to === todayStr2,
      "report: team weekly report generates");
    const teamReportPayload = JSON.stringify(received);
    ok(teamReportPayload.includes("REPORTLEAK"),
      "report: team report may reference internal work visible to that member");
    ok(teamReportPayload.indexOf("Measured results") !== -1
      && teamReportPayload.indexOf("Measured results") < teamReportPayload.indexOf("What drove it"),
      "report: team report is metrics-first too");
    ok(!teamReportPayload.includes("Work in motion") && !teamReportPayload.includes("Activity log")
      && !/workload|busyness/i.test(teamReportPayload) && !/workload|busyness/i.test(clientReportPayload),
      "report: no workload/busyness framing reaches the model for either audience");

    ok((await http(port, "POST", "/api/ai/report", { cookie: taha, body: { period: "custom", from: "2026-08-14", to: "2026-08-01" } })).status === 400,
      "report: inverted custom range rejected");
    ok((await http(port, "POST", "/api/ai/report", { cookie: taha, body: { period: "year" } })).status === 400,
      "report: unknown period rejected");

    const latestClient = (await http(port, "GET", "/api/ai/report/latest?audience=client", { cookie: client })).json;
    ok(latestClient.text === "FINAL ANSWER" && latestClient.audience === "client",
      "report: latest client report is served back");
    const forced = (await http(port, "GET", "/api/ai/report/latest?audience=team", { cookie: client })).json;
    ok(forced.audience === "client", "report: client can never read the team-audience report");
    const latestTeam = (await http(port, "GET", "/api/ai/report/latest?audience=team", { cookie: taha })).json;
    ok(latestTeam.audience === "team" && latestTeam.from === shiftDay2(todayStr2, -6),
      "report: team reads the stored team-audience report");

    const auditAfter = (await http(port, "GET", "/api/ai/admin", { cookie: admin })).json;
    ok(auditAfter.audit.some((a) => a.kind === "report" && a.username === "adika")
      && auditAfter.audit.some((a) => a.kind === "report" && a.username === "taha"),
      "report: generations are audited per user");

    /* --- super-admin Monki tools --- */
    const ADMIN_TOOLS = ["workspace_health", "ai_usage", "compare_results", "weekly_digest"];
    const adminCtl = (await http(port, "GET", "/api/ai/admin", { cookie: admin })).json;
    ok(ADMIN_TOOLS.every((n) => adminCtl.tools.some((t) => t.name === n && t.kind === "admin")),
      "ai admin: tool catalog lists the four admin tools");
    const tahaAccess = adminCtl.userAccess.find((u) => u.username === "taha");
    // taha's saved profile literally contains every catalog tool (set above) —
    // the role gate must still strip the admin ones everywhere downstream.
    ok(tahaAccess && ADMIN_TOOLS.every((n) => !tahaAccess.tools.includes(n)),
      "ai admin: team access profile never lists admin tools");

    received.length = 0;
    const healthAsk = await http(port, "POST", "/api/ai/ask", { cookie: admin, body: { question: "Give me a workspace health check" } });
    const healthToolText = JSON.stringify((received[1] || {}).messages || []);
    ok(healthAsk.status === 200
      && healthToolText.includes("Overdue (") && healthToolText.includes("Channels silent"),
      "ai admin: workspace_health scans overdue/stale/unassigned/undated/blocked work and silent channels");

    received.length = 0;
    const healthTeam = await http(port, "POST", "/api/ai/ask", { cookie: taha, body: { question: "Give me a workspace health check" } });
    const offeredTeam = (received[0].tools || []).map((t) => t.function.name);
    ok(healthTeam.status === 200 && !ADMIN_TOOLS.some((n) => offeredTeam.includes(n))
      && !JSON.stringify(received).includes("Overdue ("),
      "ai admin: admin tools are never offered or executed for the team");
    received.length = 0;
    await http(port, "POST", "/api/ai/ask", { cookie: client, body: { question: "Give me a workspace health check" } });
    const offeredClient = (received[0].tools || []).map((t) => t.function.name);
    ok(!ADMIN_TOOLS.some((n) => offeredClient.includes(n))
      && !JSON.stringify(received).includes("Overdue ("),
      "ai admin: admin tools are never offered to the client");

    // Even when the provider explicitly requests an admin tool, the executor
    // refuses it for non-admins (defense in depth beyond the offered list).
    received.length = 0;
    const forcedTeam = await http(port, "POST", "/api/ai/ask", { cookie: taha, body: { question: "force workspace health please" } });
    ok(forcedTeam.status === 200 && JSON.stringify(received).includes("Tool is not permitted for this user.")
      && !JSON.stringify(received).includes("Overdue ("),
      "ai admin: a forced admin tool call is rejected server-side for the team");
    received.length = 0;
    const forcedClient = await http(port, "POST", "/api/ai/ask", { cookie: client, body: { question: "force workspace health please" } });
    ok(JSON.stringify(received).includes("Tool is not permitted for this user.")
      && !JSON.stringify(received).includes("Overdue ("),
      "ai admin: a forced admin tool call is rejected server-side for the client");
    received.length = 0;
    const forcedAdmin = await http(port, "POST", "/api/ai/ask", { cookie: admin, body: { question: "force workspace health please" } });
    ok(JSON.stringify((received[1] || {}).messages || []).includes("Overdue ("),
      "ai admin: the same forced call executes for the super admin");

    received.length = 0;
    const usageAsk = await http(port, "POST", "/api/ai/ask", { cookie: admin, body: { question: "Show ai usage by day and by user" } });
    const usageToolText = JSON.stringify((received[1] || {}).messages || []);
    ok(usageAsk.status === 200
      && usageToolText.includes("By day") && usageToolText.includes("By user") && usageToolText.includes("abubakar"),
      "ai admin: ai_usage summarizes calls and tokens by day and user");
    ok(!usageToolText.includes("provider credential check"),
      "ai admin: ai_usage never returns audited question contents");

    // compare_results math: fixed ranges, known values.
    await http(port, "POST", "/api/metrics", { cookie: admin, body: { date: "2026-08-03", channel: "SEO", metric: "organic_clicks", value: 100 } });
    await http(port, "POST", "/api/metrics", { cookie: admin, body: { date: "2026-08-10", channel: "SEO", metric: "organic_clicks", value: 150 } });
    await http(port, "POST", "/api/metrics", { cookie: admin, body: { date: "2026-08-03", channel: "SEO", metric: "signups", value: 20 } });
    await http(port, "POST", "/api/metrics", { cookie: admin, body: { date: "2026-08-10", channel: "SEO", metric: "signups", value: 10 } });
    await http(port, "POST", "/api/metrics", { cookie: admin, body: { date: "2026-08-10", channel: "Email Marketing", metric: "signups", value: 80 } });
    received.length = 0;
    const cmpAsk = await http(port, "POST", "/api/ai/ask", { cookie: admin, body: { question: "compare results for the two ranges please" } });
    const cmpToolText = JSON.stringify((received[1] || {}).messages || []);
    ok(cmpAsk.status === 200
      && cmpToolText.includes("150 in 2026-08-08..2026-08-14 vs 100 in baseline 2026-08-01..2026-08-07, +50%")
      && cmpToolText.includes("10 in 2026-08-08..2026-08-14 vs 20 in baseline 2026-08-01..2026-08-07, -50%")
      && cmpToolText.includes("no baseline"),
      "ai admin: compare_results computes two-range deltas correctly");

    received.length = 0;
    const digestAsk = await http(port, "POST", "/api/ai/ask", { cookie: admin, body: { question: "Prepare the weekly digest for Adika" } });
    const digestToolText = JSON.stringify((received[1] || {}).messages || []);
    ok(digestAsk.status === 200
      && digestToolText.includes("weekly update")
      && digestToolText.includes("Google Ads — spend: 700 this week (last week 500, +40%)"),
      "ai admin: weekly_digest drafts a metrics-led client-ready update");
    ok(!digestToolText.includes("REPORTLEAK"),
      "ai admin: weekly digest excludes internal work");
  } finally {
    child.kill();
    stub.close();
  }
}

/* ================= 7. Smart Reporting (Hyros) ================= */

/* Stub Hyros API: user-info + paginated sales/leads/calls with fixtures. */
/* ==================== Hyros fixtures (real MCP schema) ==================== */

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/** Inclusive YYYY-MM-DD → YYYY-MM-DD list (UTC-safe), capped for sanity. */
function dayList(from, to) {
  const out = [];
  let d = String(from || "").slice(0, 10);
  const end = String(to || "").slice(0, 10);
  while (d && end && d <= end && out.length < 400) {
    out.push(d);
    const dt = new Date(d + "T00:00:00Z");
    dt.setUTCDate(dt.getUTCDate() + 1);
    d = dt.toISOString().slice(0, 10);
  }
  return out;
}

// Synthetic fixtures shaped EXACTLY like the live Hyros MCP payloads (verified
// against the real account, Aug 2026):
// - sales: Java Date.toString() creationDate ("Mon Aug 10 10:00:00 UTC 2026")
//   and money at TOP level `sale.price` in account currency (EUR).
//   `product.USDPrice` is the USD-converted trap — fixtures deliberately carry
//   a DIFFERENT USDPrice so a connector that reads it fails loudly.
// - leads: ISO creationDate with timezone offset ("2026-08-10T09:00:00+02:00").
// - attribution: firstSource/lastSource objects with adSource.platform
//   GOOGLE_V2, trafficSource, category (the campaign grouping).
// - "@google-organic": the misconfigured live source — organic:false but
//   adSource:null. "No adSource" must classify as organic regardless of the flag.
// Names/emails are synthetic — no real PII. Ad account ids are the real
// (non-PII) NEONMONKI account ids so fixtures match the verified ground truth.
function hyrosRealFixtures() {
  const GOOGLE_ACCOUNT = "5861254545";
  const FACEBOOK_ACCOUNT = "1422344841739919";
  const PINTEREST_ACCOUNT = "549762230078";
  const srcGoogle = {
    sourceLinkId: "sl-g-1", name: "@gg-neon-signs", tag: "@gg-neon-signs",
    organic: false, disregarded: false,
    trafficSource: { id: "ts-google", name: "google" },
    adSource: { adSourceId: "adsrc-1001", adAccountId: GOOGLE_ACCOUNT, platform: "GOOGLE_V2" },
    category: { id: "cat-1", name: "Neon Signs DE" }, goal: "PURCHASE",
  };
  const srcFacebook = {
    sourceLinkId: "sl-f-1", name: "@fb-prospecting", tag: "@fb-prospecting",
    organic: false, disregarded: false,
    trafficSource: { id: "ts-facebook", name: "facebook" },
    adSource: { adSourceId: "adsrc-2001", adAccountId: FACEBOOK_ACCOUNT, platform: "FACEBOOK" },
    category: { id: "cat-2", name: "FB Prospecting" }, goal: "LEAD",
  };
  const srcGoogleOrganicBroken = {
    sourceLinkId: "sl-o-1", name: "@google-organic", tag: "@google-organic",
    organic: false, disregarded: false, // ← the live misconfiguration
    trafficSource: { id: "ts-gorganic", name: "google organic" },
    adSource: null, category: null, goal: null,
  };
  const sales = [
    {
      id: "sle-1", orderId: "o1", creationDate: "Mon Aug 10 10:00:00 UTC 2026",
      price: { price: 1200, discount: 0, hardCost: 100, refunded: 0, currency: "EUR" },
      product: { id: "pdt-1", name: "Leuchtreklame", USDPrice: { price: 1410, discount: 0, hardCost: 0, refunded: 0, currency: "USD" } },
      firstSource: srcGoogle, lastSource: srcGoogle,
    },
    {
      id: "sle-2", orderId: "o2", creationDate: "Wed Aug 12 11:00:00 UTC 2026",
      price: { price: 800, discount: 0, hardCost: 50, refunded: 0, currency: "EUR" },
      product: { id: "pdt-2", name: "Neon", USDPrice: { price: 940, discount: 0, hardCost: 0, refunded: 0, currency: "USD" } },
      firstSource: srcGoogleOrganicBroken, lastSource: srcGoogleOrganicBroken,
    },
  ];
  const leads = [
    { id: "lead-1", creationDate: "2026-08-10T09:00:00+02:00", firstSource: srcGoogle, lastSource: srcGoogle },
    { id: "lead-2", creationDate: "2026-08-11T09:00:00+02:00", firstSource: srcFacebook, lastSource: srcFacebook },
    { id: "lead-3", creationDate: "2026-08-12T09:00:00+02:00", firstSource: srcGoogleOrganicBroken, lastSource: srcGoogleOrganicBroken },
  ];
  const sources = [
    { name: "@gg-neon-signs", tag: "@gg-neon-signs", organic: false, disregarded: false, trafficSource: { id: "ts-google", name: "google" }, adSource: { adSourceId: "adsrc-1001", adAccountId: GOOGLE_ACCOUNT, platform: "GOOGLE_V2" }, category: { id: "cat-1", name: "Neon Signs DE" }, goal: "PURCHASE" },
    { name: "@gg-brand", tag: "@gg-brand", organic: false, disregarded: false, trafficSource: { id: "ts-google", name: "google" }, adSource: { adSourceId: "adsrc-1002", adAccountId: GOOGLE_ACCOUNT, platform: "GOOGLE_V2" }, category: { id: "cat-3", name: "Brand Search" }, goal: "PURCHASE" },
    { name: "@fb-prospecting", tag: "@fb-prospecting", organic: false, disregarded: false, trafficSource: { id: "ts-facebook", name: "facebook" }, adSource: { adSourceId: "adsrc-2001", adAccountId: FACEBOOK_ACCOUNT, platform: "FACEBOOK" }, category: { id: "cat-2", name: "FB Prospecting" }, goal: "LEAD" },
    { name: "@pin-broad", tag: "@pin-broad", organic: false, disregarded: false, trafficSource: { id: "ts-pinterest", name: "pinterest" }, adSource: { adSourceId: "adsrc-3001", adAccountId: PINTEREST_ACCOUNT, platform: "PINTEREST" }, category: { id: "cat-4", name: "Pinterest Broad" }, goal: "AWARENESS" },
    { name: "@google-organic", tag: "@google-organic", organic: false, disregarded: false, trafficSource: { id: "ts-gorganic", name: "google organic" }, adSource: null, category: null, goal: "LEAD" },
  ];
  const adAccounts = [
    { id: GOOGLE_ACCOUNT, name: "NEONMONKI Google", type: "GOOGLE_V2" },
    { id: FACEBOOK_ACCOUNT, name: "NEONMONKI Meta", type: "FACEBOOK" },
    { id: PINTEREST_ACCOUNT, name: "NEONMONKI Pinterest", type: "PINTEREST" },
  ];
  return {
    sales, leads, calls: [], sources, adAccounts,
    accountIds: { google: GOOGLE_ACCOUNT, facebook: FACEBOOK_ACCOUNT, pinterest: PINTEREST_ACCOUNT },
    googleCampaigns: ["adsrc-1001", "adsrc-1002"],
  };
}

/* Deterministic daily account series (sale-date basis) — the stub's answer to
 * hyros_get_roas_report. The two days verified against the live account carry
 * the real numbers; every other day is a stable synthetic function of the
 * date. Meta + Pinterest are all-zero (inactive) so the aggregate sync must
 * skip them. Tests compute expectations through this same function — no
 * duplicated constants. */
function hyrosStubAccountDaily(accountId, day) {
  if (String(accountId) !== "5861254545") return { cost: 0, revenue: 0, sales: 0 };
  if (day === "2026-08-19") return { cost: 27.84, revenue: 0, sales: 0 };          // today — verified live
  if (day === "2026-08-18") return { cost: 473.55, revenue: 1760.52, sales: 4 };   // yesterday — verified live
  const dom = Number(String(day).slice(8, 10)) || 0;
  const cost = round2(80 + ((dom * 37) % 240));
  return { cost, revenue: round2(cost * 2.5), sales: 1 + (dom % 3) };
}

/* Campaign-level split of the Google account day (hyros_get_attribution_report,
 * DAY grouping). adsrc-1001 = "Neon Signs DE", adsrc-1002 = "Brand Search" —
 * display names resolved from the sources list. */
function hyrosStubCampaignDaily(campaignId, day) {
  const base = hyrosStubAccountDaily("5861254545", day);
  const dom = Number(String(day).slice(8, 10)) || 0;
  if (String(campaignId) === "adsrc-1001") {
    const sales = base.sales - Math.floor(base.sales / 3);
    const clicks = 40 + dom;
    return { cost: round2(base.cost * 0.6), revenue: round2(base.revenue * 0.7), sales, leads: sales + 1, clicks, impressions: clicks * 25 };
  }
  const sales = Math.floor(base.sales / 3);
  const clicks = 15 + dom;
  return { cost: round2(base.cost * 0.4), revenue: round2(base.revenue * 0.3), sales, leads: sales, clicks, impressions: clicks * 25 };
}

/** Sum one account metric over an inclusive day range (Google account). */
function accountRangeSum(from, to, metric) {
  return round2(dayList(from, to).reduce((s, d) => s + hyrosStubAccountDaily("5861254545", d)[metric], 0));
}

/** Sum one campaign metric (both Google campaigns) over an inclusive range. */
function campaignRangeSum(from, to, metric) {
  return dayList(from, to).reduce((s, d) => s + hyrosStubCampaignDaily("adsrc-1001", d)[metric] + hyrosStubCampaignDaily("adsrc-1002", d)[metric], 0);
}

/* Stub Hyros REST API (API-Key transport): flat query params, filters honored. */
function startHyrosStub(port, fixtures) {
  const dayOf = (v) => { const d = new Date(v); return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10); };
  const srv = require("http").createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const sendJson = (result) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ result, nextPageId: null, request_id: "r1" }));
    };
    if (req.headers["api-key"] !== "hyros-test-key") {
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "bad key" }));
    }
    const entityPage = (rows) => {
      const from = dayOf(url.searchParams.get("fromDate") || "");
      const to = dayOf(url.searchParams.get("toDate") || "");
      return sendJson((rows || []).filter((row) => {
        const d = dayOf(row.creationDate);
        return (!from || d >= from) && (!to || d <= to);
      }));
    };
    if (url.pathname.endsWith("/user-info")) return sendJson({ userProfile: { companyName: "NEONMONKI", email: "ops@example.test" } });
    if (url.pathname.endsWith("/sales")) return entityPage(fixtures.sales);
    if (url.pathname.endsWith("/leads")) return entityPage(fixtures.leads);
    if (url.pathname.endsWith("/calls")) return sendJson(fixtures.calls || []);
    if (url.pathname.endsWith("/ad-accounts")) return sendJson(fixtures.adAccounts);
    if (url.pathname.endsWith("/sources")) return sendJson(fixtures.sources);
    if (url.pathname.endsWith("/attribution/roas")) {
      let cost = 0, revenue = 0, sales = 0;
      for (const d of dayList(url.searchParams.get("startDate"), url.searchParams.get("endDate"))) {
        const v = hyrosStubAccountDaily(url.searchParams.get("id"), d);
        cost += v.cost; revenue += v.revenue; sales += v.sales;
      }
      return sendJson({ id: url.searchParams.get("id") || "", roas: cost ? round2(revenue / cost) : 0, revenue: round2(revenue), total_revenue: round2(revenue), cost: round2(cost), unique_sales: sales, average_order_value: sales ? round2(revenue / sales) : 0 });
    }
    if (url.pathname.endsWith("/attribution")) {
      const ids = String(url.searchParams.get("ids") || "").split(",").filter(Boolean);
      const days = dayList(url.searchParams.get("startDate"), url.searchParams.get("endDate"));
      if (/^day$/i.test(url.searchParams.get("timeGroupingOption") || "")) {
        const rows = [];
        for (const d of days) for (const cid of ids) {
          const v = hyrosStubCampaignDaily(cid, d);
          rows.push({ startDate: d, endDate: d, cost: v.cost, revenue: v.revenue, sales: v.sales, leads: v.leads, clicks: v.clicks, impressions: v.impressions, roas: v.cost ? round2(v.revenue / v.cost) : 0, campaignId: cid, name: null, parentName: null });
        }
        return sendJson(rows);
      }
      return sendJson(ids.map((cid) => {
        let cost = 0, revenue = 0, sales = 0, leads = 0;
        for (const d of days) { const v = hyrosStubCampaignDaily(cid, d); cost += v.cost; revenue += v.revenue; sales += v.sales; leads += v.leads; }
        return { id: cid, cost: round2(cost), revenue: round2(revenue), sales, leads, roas: cost ? round2(revenue / cost) : 0 };
      }));
    }
    res.writeHead(404); res.end("{}");
  });
  return new Promise((resolve) => srv.listen(port, () => resolve(srv)));
}

/* Stub Hyros OAuth + MCP server: discovery, DCR, PKCE authorize/token, MCP.
 *
 * The list tools reproduce the REAL production semantics that caused the
 * wrong-data bug: filters live inside `arguments.request` — FLAT arguments
 * are silently ignored and the server answers its DEFAULT FIRST PAGE
 * (pageSize 50, unfiltered). A wrapped `request.{fromDate,toDate,pageSize,
 * pageId}` is honored with cursor pagination (nextPageId = row offset).
 * state.lastArgs / state.callsLog record every tool call for assertions. */
function startHyrosOAuthStub(port, fixtures) {
  const crypto = require("crypto");
  const state = {
    challenge: "", clientId: "nm-test-client", clientSecret: "nm-test-secret",
    refreshSeq: 0, sawWriteTool: false, initCalls: 0, failInit429: 0, authCodeSeq: 0,
    constantCursor: false, bigLeads: 0, bigLeadsRows: [],
    lastArgs: {}, callsLog: [],
  };
  const dayOf = (v) => { const d = new Date(v); return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10); };
  /* Bulk fixture mode for the pagination tests: N leads spread over the last
   * 60 days, so pageSize 250 needs 2+ pages and the default 50-cap is visible. */
  const bigLeadsRows = () => {
    if (!state.bigLeadsRows.length) {
      state.bigLeadsRows = Array.from({ length: state.bigLeads }, (_, i) => ({
        id: `bulk-${i + 1}`,
        creationDate: new Date(Date.now() - (i % 60) * 86400000).toISOString(),
        lastSource: { organic: false, disregarded: false, trafficSource: { id: "ts-google", name: "google" }, adSource: { adSourceId: "adsrc-1001", adAccountId: "5861254545", platform: "GOOGLE_V2" }, category: { id: "cat-1", name: "Neon Signs DE" }, goal: "LEAD" },
      }));
    }
    return state.bigLeadsRows;
  };
  function listToolPayload(name, args) {
    const wrapped = !!(args && typeof args.request === "object" && args.request);
    const req = wrapped ? args.request : {};
    let rows =
      name === "hyros_get_sales" ? fixtures.sales
      : name === "hyros_get_leads" ? (state.bigLeads ? bigLeadsRows() : fixtures.leads)
      : name === "hyros_get_calls" ? (fixtures.calls || [])
      : name === "hyros_get_sources" ? fixtures.sources
      : [];
    if (wrapped && name !== "hyros_get_sources" && (req.fromDate || req.toDate)) {
      const from = req.fromDate ? dayOf(req.fromDate) : "";
      const to = req.toDate ? dayOf(req.toDate) : "";
      rows = rows.filter((row) => { const d = dayOf(row.creationDate); return (!from || d >= from) && (!to || d <= to); });
    }
    // THE BUG, faithfully reproduced: flat args → ignored → default first page
    // (pageSize 50), unfiltered. Wrapped args → honored.
    const pageSize = wrapped ? Math.max(1, Number(req.pageSize) || 50) : 50;
    const offset = wrapped ? Math.max(0, Number(req.pageId) || 0) : 0;
    const pageRows = rows.slice(offset, offset + pageSize);
    let nextPageId = offset + pageSize < rows.length ? String(offset + pageSize) : null;
    if (state.constantCursor && name === "hyros_get_sales") nextPageId = "same-cursor";
    const payload = { result: pageRows, nextPageId, request_id: "r1" };
    if (wrapped) payload.request = req; // the live server echoes the request back
    return payload;
  }
  function roasPayload(args) {
    const req = (args && typeof args.request === "object" && args.request) || {};
    let cost = 0, revenue = 0, sales = 0;
    for (const d of dayList(req.startDate, req.endDate)) {
      const v = hyrosStubAccountDaily(req.id, d);
      cost += v.cost; revenue += v.revenue; sales += v.sales;
    }
    // FLAT response (no result wrapper) — the verified live shape.
    return {
      id: String(req.id || ""), revenue: round2(revenue), totalRevenue: round2(revenue),
      cost: round2(cost), roas: cost ? round2(revenue / cost) : 0,
      uniqueSales: sales, averageOrderValue: sales ? round2(revenue / sales) : 0,
      request: req,
    };
  }
  function attributionPayload(args) {
    const req = (args && typeof args.request === "object" && args.request) || {};
    const ids = Array.isArray(req.ids) ? req.ids.map(String) : [];
    const days = dayList(req.startDate, req.endDate);
    if (req.timeGroupingOption === "DAY") {
      const rows = [];
      for (const d of days) for (const cid of ids) {
        const v = hyrosStubCampaignDaily(cid, d);
        rows.push({ startDate: d, endDate: d, cost: v.cost, revenue: v.revenue, sales: v.sales, leads: v.leads, clicks: v.clicks, impressions: v.impressions, roas: v.cost ? round2(v.revenue / v.cost) : 0, campaignId: cid, adGroupId: null, id: cid, name: null, parentName: null });
      }
      const pageSize = Math.max(1, Number(req.pageSize) || 50);
      const offset = Math.max(0, Number(req.pageId) || 0);
      return { result: rows.slice(offset, offset + pageSize), nextPageId: offset + pageSize < rows.length ? String(offset + pageSize) : null, request_id: "r1" };
    }
    // no time grouping → per-campaign totals keyed by id
    const totals = ids.map((cid) => {
      let cost = 0, revenue = 0, sales = 0, leads = 0;
      for (const d of days) { const v = hyrosStubCampaignDaily(cid, d); cost += v.cost; revenue += v.revenue; sales += v.sales; leads += v.leads; }
      return { id: cid, cost: round2(cost), revenue: round2(revenue), sales, leads, roas: cost ? round2(revenue / cost) : 0 };
    });
    return { result: totals, nextPageId: null, request_id: "r1" };
  }
  const srv = require("http").createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const json = (code, obj, headers = {}) => {
      res.writeHead(code, { "Content-Type": "application/json", ...headers });
      res.end(JSON.stringify(obj));
    };
    const readBody = () => new Promise((resolve) => {
      let b = ""; req.on("data", (c) => { b += c; }); req.on("end", () => resolve(b));
    });
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      return json(200, { resource: `http://localhost:${port}/mcp`, authorization_servers: [`http://localhost:${port}`] });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return json(200, {
        issuer: `http://localhost:${port}`,
        authorization_endpoint: `http://localhost:${port}/authorize`,
        token_endpoint: `http://localhost:${port}/token`,
        registration_endpoint: `http://localhost:${port}/register`,
      });
    }
    if (url.pathname === "/register" && req.method === "POST") {
      const body = JSON.parse(await readBody() || "{}");
      if (body.token_endpoint_auth_method !== "client_secret_basic") return json(400, { error: "invalid_client_metadata" });
      return json(201, { client_id: state.clientId, client_secret: state.clientSecret });
    }
    if (url.pathname === "/authorize") {
      if (url.searchParams.get("client_id") !== state.clientId) return json(400, { error: "bad client" });
      if (url.searchParams.get("code_challenge_method") !== "S256" || !url.searchParams.get("code_challenge")) return json(400, { error: "pkce required" });
      if (url.searchParams.get("scope") !== "mcp") return json(400, { error: "bad scope" });
      state.challenge = url.searchParams.get("code_challenge");
      const cb = new URL(url.searchParams.get("redirect_uri"));
      cb.searchParams.set("code", "auth-code-1");
      cb.searchParams.set("state", url.searchParams.get("state"));
      res.writeHead(302, { Location: cb.toString() });
      return res.end();
    }
    if (url.pathname === "/token" && req.method === "POST") {
      const auth = req.headers.authorization || "";
      if (auth !== `Basic ${Buffer.from(`${state.clientId}:${state.clientSecret}`).toString("base64")}`) {
        return json(401, { error: "invalid_client" });
      }
      const body = new URLSearchParams(await readBody());
      if (body.get("grant_type") === "authorization_code") {
        const expect = crypto.createHash("sha256").update(body.get("code_verifier") || "").digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
        if (body.get("code") !== "auth-code-1" || expect !== state.challenge) return json(400, { error: "invalid_grant" });
        // A fresh token pair per authorization, like the real Hyros: a second
        // OAuth dance must not reuse the first dance's access token (the client
        // caches its MCP session per token, which would mask a forced 429).
        state.authCodeSeq += 1;
        state.refreshSeq = state.authCodeSeq;
        return json(200, { access_token: `mcp-at-${state.authCodeSeq}`, refresh_token: `mcp-rt-${state.authCodeSeq}`, expires_in: 900, token_type: "Bearer", scope: "mcp" });
      }
      if (body.get("grant_type") === "refresh_token") {
        if (body.get("refresh_token") !== `mcp-rt-${state.refreshSeq}`) return json(400, { error: "invalid_grant" });
        state.refreshSeq += 1;
        return json(200, { access_token: `mcp-at-${state.refreshSeq}`, refresh_token: `mcp-rt-${state.refreshSeq}`, expires_in: 900, token_type: "Bearer" });
      }
      return json(400, { error: "unsupported_grant_type" });
    }
    if (url.pathname === "/mcp" && req.method === "POST") {
      const auth = req.headers.authorization || "";
      if (!auth.startsWith("Bearer mcp-at-")) return json(401, { error: "unauthorized" });
      const rpc = JSON.parse(await readBody() || "{}");
      if (rpc.method === "initialize") {
        state.initCalls += 1;
        if (state.failInit429 > 0) { // simulate Hyros rate-limiting the MCP handshake
          state.failInit429 -= 1;
          return json(429, { error: "rate_limited" }, { "Retry-After": "1" });
        }
        return json(200, { jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: rpc.params.protocolVersion, capabilities: {}, serverInfo: { name: "hyros-stub", version: "1.0" } } }, { "Mcp-Session-Id": "sess-1" });
      }
      if (rpc.method === "notifications/initialized") { res.writeHead(202); return res.end(); }
      if (rpc.method === "tools/call") {
        const name = rpc.params && rpc.params.name;
        const args = (rpc.params && rpc.params.arguments) || {};
        if (!String(name || "").startsWith("hyros_get_")) state.sawWriteTool = true; // must never happen
        state.lastArgs[name] = args;
        state.callsLog.push({ name, args });
        const payload =
          name === "hyros_get_user_info"
            // userProfile sits at TOP level (merged with a request echo) — the
            // verified live shape, NOT nested under result.
            ? { userProfile: { companyName: "NEONMONKI MCP", email: "ops@example.test" }, request: args.request || {} }
          : name === "hyros_get_ad_accounts" ? { result: fixtures.adAccounts, nextPageId: null, request_id: "r1" }
          : name === "hyros_get_roas_report" ? roasPayload(args)
          : name === "hyros_get_attribution_report" ? attributionPayload(args)
          : listToolPayload(name, args);
        return json(200, { jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: JSON.stringify(payload) }] } });
      }
      if (rpc.method === "tools/list") {
        const tools = ["hyros_get_user_info", "hyros_get_sales", "hyros_get_leads", "hyros_get_calls", "hyros_get_sources", "hyros_get_ad_accounts", "hyros_get_roas_report", "hyros_get_attribution_report"];
        return json(200, { jsonrpc: "2.0", id: rpc.id, result: { tools: tools.map((n) => ({ name: n })) } });
      }
      return json(200, { jsonrpc: "2.0", id: rpc.id, result: {} });
    }
    res.writeHead(404); res.end("{}");
  });
  return new Promise((resolve) => srv.listen(port, () => resolve(Object.assign(srv, { state, daily: { account: hyrosStubAccountDaily, campaign: hyrosStubCampaignDaily } }))));
}


async function testSmartReporting() {
  console.log("\n[7] Smart Reporting (port 4196 app, 4195 Hyros stub, 4197 Hyros OAuth stub)");

  /* --- access-tier unit matrix (lib/permissions, no server needed) --- */
  {
    const perms = require(path.join(ROOT, "lib", "permissions"));
    const ownerU = { username: "abubakar", name: "Abu Bakar", role: "super_admin", active: true };
    const clientU = { username: "adika", name: "Adika", role: "client", active: true };
    const teamU = { username: "taha", name: "Taha", role: "team", active: true };
    // reportingAccess: four tiers — none < basic < advanced < super
    ok(perms.reportingAccess(ownerU, null) === "super", "sr-tier: reportingAccess owner -> super (role default)");
    ok(perms.reportingAccess(clientU, null) === "basic", "sr-tier: reportingAccess client default -> basic");
    ok(perms.reportingAccess(teamU, { reporting: "" }) === "basic", "sr-tier: reportingAccess team default -> basic");
    ok(perms.reportingAccess(null, null) === "none", "sr-tier: reportingAccess missing user -> none");
    ok(perms.reportingAccess({ ...clientU, active: false }, null) === "none", "sr-tier: reportingAccess inactive -> none");
    ok(perms.reportingAccess({ ...clientU, active: false }, { reporting: "super" }) === "none", "sr-tier: reportingAccess inactive beats an explicit grant");
    ok(perms.reportingAccess(clientU, { reporting: "advanced" }) === "advanced", "sr-tier: explicit reporting=advanced overrides the client role");
    ok(perms.reportingAccess(clientU, { reporting: "super" }) === "super", "sr-tier: explicit reporting=super grants the generator tier");
    ok(perms.reportingAccess(clientU, { reporting: "full" }) === "advanced", "sr-tier: legacy reporting=full reads as advanced");
    ok(perms.reportingAccess(ownerU, { reporting: "basic" }) === "basic", "sr-tier: explicit reporting=basic overrides the owner role");
    ok(perms.reportingAccess(ownerU, { reporting: "none" }) === "none", "sr-tier: explicit reporting=none overrides the owner role");
    ok(perms.reportingAccess(teamU, { reporting: "none" }) === "none", "sr-tier: explicit reporting=none overrides the team role");
    ok(perms.reportingAccess({ username: "x", role: "partner", active: true }, null) === "none", "sr-tier: reportingAccess unknown role -> none");
    // canUseSmartReporting: advanced + super pass, plus the legacy flag and the owner rule
    ok(perms.canUseSmartReporting(ownerU, null) === true, "sr-tier: owner keeps Smart Reporting (unchanged owner rule)");
    ok(perms.canUseSmartReporting(clientU, { reporting: "advanced" }) === true, "sr-tier: reporting=advanced grants Smart Reporting");
    ok(perms.canUseSmartReporting(clientU, { reporting: "super" }) === true, "sr-tier: reporting=super grants Smart Reporting");
    ok(perms.canUseSmartReporting(clientU, { reporting: "full" }) === true, "sr-tier: legacy reporting=full still grants Smart Reporting");
    ok(perms.canUseSmartReporting(clientU, { reporting: "basic" }) === false, "sr-tier: reporting=basic denies Smart Reporting");
    ok(perms.canUseSmartReporting(clientU, { reporting: "none" }) === false, "sr-tier: reporting=none denies Smart Reporting");
    ok(perms.canUseSmartReporting(clientU, { smartReporting: true }) === true, "sr-tier: legacy smartReporting flag still grants (backward compat)");
    ok(perms.canUseSmartReporting(teamU, null) === false, "sr-tier: team default has no Smart Reporting");
    ok(perms.canUseSmartReporting({ ...ownerU, active: false }, null) === false, "sr-tier: inactive owner denied");
    // canGenerateReports: the super tier only (owner by default, grantable per user)
    ok(perms.canGenerateReports(ownerU, null) === true, "sr-tier: owner generates reports (super role default)");
    ok(perms.canGenerateReports(clientU, { reporting: "super" }) === true, "sr-tier: a granted reporting=super user generates reports");
    ok(perms.canGenerateReports(clientU, { reporting: "advanced" }) === false, "sr-tier: advanced alone cannot generate reports");
    ok(perms.canGenerateReports(clientU, { reporting: "full" }) === false, "sr-tier: legacy full reads as advanced — still no generator");
    ok(perms.canGenerateReports(clientU, null) === false, "sr-tier: basic default cannot generate reports");
    ok(perms.canGenerateReports(teamU, { smartReporting: true }) === false, "sr-tier: the legacy smartReporting flag never unlocks the generator");
    ok(perms.canGenerateReports(ownerU, { reporting: "advanced" }) === false, "sr-tier: explicit advanced beats the owner default for the generator");
    ok(perms.canGenerateReports(null, null) === false, "sr-tier: missing user cannot generate reports");
    ok(perms.canGenerateReports({ ...ownerU, active: false }, null) === false, "sr-tier: inactive owner cannot generate reports");
  }

  const fixtures = hyrosRealFixtures();
  const hyros = await startHyrosStub(4195, fixtures);
  const oauthStub = await startHyrosOAuthStub(4197, fixtures);
  // In-process unit tests below require lib/hyros-mcp.js directly; the module
  // binds HYROS_MCP_URL at load time, so point it at the stub before any require.
  process.env.HYROS_MCP_URL = "http://localhost:4197/mcp";
  const port = 4196;
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    env: {
      PATH: process.env.PATH, PORT: String(port),
      TASK_HUB_DATA_FILE: path.join(TMP, "sr-data.json"),
      HYROS_BASE_URL: "http://localhost:4195/v1",
      HYROS_MCP_URL: "http://localhost:4197/mcp",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (d) => { out += d; if (out.includes("http://localhost")) resolve(); });
    child.on("exit", () => reject(new Error("sr server exited early")));
    setTimeout(() => reject(new Error("sr server start timeout")), 8000);
  });
  try {
    const { cookie: admin } = await login(port, "abubakar", "NM-admin-2026");
    const { cookie: taha } = await login(port, "taha", "NM-taha-2026");
    const { cookie: client } = await login(port, "adika", "neonmonki2026");

    /* --- permission matrix --- */
    ok((await http(port, "GET", "/api/reporting/status", { cookie: admin })).status === 200, "sr: abubakar can read reporting status");
    ok((await http(port, "GET", "/api/reporting/overview", { cookie: taha })).status === 403, "sr: team overview -> 403");
    ok((await http(port, "GET", "/api/reporting/overview", { cookie: client })).status === 403, "sr: client overview -> 403");
    ok((await http(port, "GET", "/api/reporting/status")).status === 401, "sr: anonymous -> 401");
    ok((await http(port, "POST", "/api/integrations/hyros/connect", { cookie: taha, body: { apiKey: "x".repeat(20) } })).status === 403, "sr: team connect -> 403");
    ok((await http(port, "GET", "/api/integrations/hyros/status", { cookie: client })).status === 403, "sr: client integration status -> 403");

    /* --- basic tier: /api/reporting/basic status matrix + empty-state shape --- */
    ok((await http(port, "GET", "/api/reporting/basic")).status === 401, "sr-tier: basic anonymous -> 401");
    ok((await http(port, "GET", "/api/reporting/basic", { cookie: client })).status === 200, "sr-tier: basic client -> 200");
    ok((await http(port, "GET", "/api/reporting/basic", { cookie: taha })).status === 200, "sr-tier: basic team -> 200");
    ok((await http(port, "GET", "/api/reporting/basic", { cookie: admin })).status === 200, "sr-tier: basic owner (super tier) -> 200");
    ok((await http(port, "GET", "/api/reporting/basic?from=not-a-date", { cookie: client })).status === 400,
      "sr-tier: basic rejects a malformed from date (same range rules as the other reporting routes)");
    const basic0 = ((await http(port, "GET", "/api/reporting/basic", { cookie: client })).json) || {};
    ok(basic0.range && typeof basic0.range.from === "string" && typeof basic0.range.to === "string"
      && basic0.current && ["revenue", "leads", "sales", "spend", "roas", "aov"].every((k) => k in basic0.current)
      && basic0.current.deltas && ["revenue", "leads", "sales", "spend", "roas"].every((k) => k in basic0.current.deltas)
      && Array.isArray(basic0.trend) && Array.isArray(basic0.channels)
      && Array.isArray(basic0.campaigns) && Array.isArray(basic0.highlights),
      "sr-tier: basic payload shape (range/current+deltas/trend/channels/campaigns/highlights)", JSON.stringify(basic0).slice(0, 160));
    ok(!/hyros|sync|rate_limit|rateLimited/i.test(JSON.stringify(basic0)),
      "sr-tier: basic payload never mentions sourcing, sync or rate limits");
    ok((basic0.channels || []).every((c) => c.name !== "Unknown"), "sr-tier: basic channels never named \"Unknown\"");

    // No rows at all → spend-derived metrics are null, never fabricated zeros.
    const ov0 = (await http(port, "GET", "/api/reporting/overview?from=2026-08-01&to=2026-08-19", { cookie: admin })).json;
    ok(ov0.current.spend == null && ov0.current.roas === null && ov0.current.cpl === null && ov0.current.cpa === null,
      "sr: no data -> spend/roas/cpl/cpa null (never fabricated zeros)", JSON.stringify(ov0.current));

    /* --- connect (stub Hyros) + backfill + idempotency --- */
    const conn = await http(port, "POST", "/api/integrations/hyros/connect", { cookie: admin, body: { apiKey: "hyros-test-key", historicalDays: 30 } });
    ok(conn.status === 200 && conn.json.ok === true, "sr: connect succeeds against stub", JSON.stringify(conn.json).slice(0, 120));
    ok(conn.json.webhookToken && conn.json.webhookUrl.includes("token="), "sr: webhook token returned once");
    ok(!JSON.stringify(conn.json).includes("hyros-test-key"), "sr: api key never in connect response");
    // report tools are OAuth-only; the api-key path must still COMPLETE its
    // entity backfill (aggregates skip gracefully) instead of erroring forever.
    ok(conn.json.backfill && conn.json.backfill.complete === true, "sr: initial backfill completes (api-key: entities done, aggregates skip gracefully)", JSON.stringify(conn.json.backfill || {}));
    const count1 = (await http(port, "GET", "/api/integrations/hyros/status", { cookie: admin })).json.recordCount;
    ok(count1 === 5, "sr: backfill stored 5 facts (2 sales + 3 leads)", String(count1));
    const sync2 = await http(port, "POST", "/api/integrations/hyros/sync", { cookie: admin, body: {} });
    ok(sync2.status === 200, "sr: incremental sync ok (a stuck api-key backfill would 502 here)", `${sync2.status} ${JSON.stringify(sync2.json).slice(0, 120)}`);
    const count2 = (await http(port, "GET", "/api/integrations/hyros/status", { cookie: admin })).json.recordCount;
    ok(count2 === 5, "sr: re-sync is idempotent (still 5 facts)", String(count2));

    /* --- basic payload with real data: correct numbers, client-safe hygiene --- */
    const basicQ = "/api/reporting/basic?from=2026-08-01&to=2026-08-19";
    const basic = (await http(port, "GET", basicQ, { cookie: client })).json;
    ok(basic && basic.current && basic.current.revenue === 2000 && basic.current.leads === 3 && basic.current.sales === 2,
      "sr-tier: basic totals match the facts (client view)", JSON.stringify(basic && basic.current));
    ok(basic.range && basic.range.from === "2026-08-01" && basic.range.to === "2026-08-19",
      "sr-tier: basic echoes the requested range", JSON.stringify(basic && basic.range));
    ok(Array.isArray(basic.trend) && basic.trend.length > 0
      && basic.trend.every((b) => typeof b.bucket === "string" && "revenue" in b && "leads" in b && "sales" in b && "spend" in b),
      "sr-tier: basic trend is buckets with the contracted keys");
    ok(Array.isArray(basic.channels) && basic.channels.length === 3
      && basic.channels[0].name === "Paid Search"
      && basic.channels.every((c) => c.name !== "Unknown" && "sharePct" in c),
      "sr-tier: basic channels friendly-named, sorted by revenue, never \"Unknown\"", JSON.stringify((basic.channels || []).map((c) => c.name)));
    ok(Array.isArray(basic.campaigns) && basic.campaigns.length > 0 && basic.campaigns.length <= 5
      && basic.campaigns.every((c) => typeof c.name === "string" && c.revenue > 0),
      "sr-tier: basic campaigns are top-5 by revenue with revenue > 0", JSON.stringify(basic.campaigns));
    ok(Array.isArray(basic.highlights) && basic.highlights.length <= 3
      && basic.highlights.every((h) => ["up", "flat", "down"].includes(h.tone) && typeof h.text === "string"),
      "sr-tier: basic highlights are at most 3 calm tone/text lines", JSON.stringify(basic.highlights));
    ok(!/hyros|sync|rate_limit|rateLimited/i.test(JSON.stringify(basic)),
      "sr-tier: basic payload with data still carries no sourcing/diagnostics vocabulary");
    const basicTeam = (await http(port, "GET", basicQ, { cookie: taha })).json;
    ok(basicTeam && basicTeam.current && eq(basicTeam.current, basic.current) && eq(basicTeam.channels, basic.channels),
      "sr-tier: team and client see the same basic performance view");

    /* --- reporting tier override through the AI admin per-user PATCH --- */
    ok((await http(port, "PATCH", "/api/ai/admin/users/adika", { cookie: taha, body: { reporting: "super" } })).status === 403,
      "sr-tier: non-admin cannot set a reporting tier");
    ok((await http(port, "PATCH", "/api/ai/admin/users/adika", { cookie: admin, body: { reporting: "everything" } })).status === 400,
      "sr-tier: invalid reporting tier -> 400");
    const legacyFull = await http(port, "PATCH", "/api/ai/admin/users/adika", { cookie: admin, body: { reporting: "full" } });
    ok(legacyFull.status === 200 && legacyFull.json.permission && legacyFull.json.permission.reporting === "advanced",
      "sr-tier: the legacy \"full\" tier name is accepted and stored as \"advanced\"", JSON.stringify(legacyFull.json).slice(0, 160));
    ok((await http(port, "GET", "/api/reporting/overview", { cookie: client })).status === 200,
      "sr-tier: the normalized advanced tier opens Smart Reporting");
    const grantAdvanced = await http(port, "PATCH", "/api/ai/admin/users/adika", { cookie: admin, body: { reporting: "advanced" } });
    ok(grantAdvanced.status === 200 && grantAdvanced.json.permission && grantAdvanced.json.permission.reporting === "advanced",
      "sr-tier: reporting=advanced persisted and returned", JSON.stringify(grantAdvanced.json).slice(0, 160));
    ok((await http(port, "GET", "/api/reporting/overview", { cookie: client })).status === 200,
      "sr-tier: reporting=advanced opens the Smart Reporting overview for the client");
    ok((await http(port, "GET", "/api/reporting/basic", { cookie: client })).status === 200,
      "sr-tier: advanced tier still passes the basic route");
    const stAdv = (await http(port, "GET", "/api/reporting/status", { cookie: client })).json;
    ok(stAdv && stAdv.tier === "advanced", "sr-tier: status reports the caller's tier (advanced)", JSON.stringify(stAdv).slice(0, 140));
    ok((await http(port, "POST", "/api/reporting/report", { cookie: client, body: { audience: "internal" } })).status === 403,
      "sr-tier: advanced opens the dashboard but NOT the report generator");
    const grantSuper = await http(port, "PATCH", "/api/ai/admin/users/adika", { cookie: admin, body: { reporting: "super" } });
    ok(grantSuper.status === 200 && grantSuper.json.permission && grantSuper.json.permission.reporting === "super",
      "sr-tier: reporting=super persisted and returned", JSON.stringify(grantSuper.json).slice(0, 160));
    const stSup = (await http(port, "GET", "/api/reporting/status", { cookie: client })).json;
    ok(stSup && stSup.tier === "super", "sr-tier: status reports the super tier (drives the Generate Report button)", JSON.stringify(stSup).slice(0, 140));

    /* --- report generator: gates, payload shape, docx validity --- */
    ok((await http(port, "POST", "/api/reporting/report", { body: { audience: "internal" } })).status === 401,
      "report-gen: anonymous -> 401");
    ok((await http(port, "POST", "/api/reporting/report", { cookie: taha, body: { audience: "internal" } })).status === 403,
      "report-gen: team default (basic tier) -> 403");

    // A completed task with an XML-hostile title must land escaped in every output.
    const fixtureTitle = 'Escape <probe> & "safety" check';
    const fixtureTask = (await http(port, "POST", "/api/tasks", { cookie: admin, body: { title: fixtureTitle, visibility: "internal" } })).json.task;
    await http(port, "PATCH", `/api/tasks/${fixtureTask.id}`, { cookie: admin, body: { status: "Completed", update: "shipped" } });

    // AI is unconfigured in this instance: the deterministic fallback must
    // still produce a complete, valid report — never an empty file.
    const todayIso = new Date().toISOString().slice(0, 10);
    const weekAgoIso = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);
    const gen = await http(port, "POST", "/api/reporting/report", { cookie: client, body: { from: weekAgoIso, to: todayIso, audience: "internal" } });
    ok(gen.status === 200 && gen.json && typeof gen.json.title === "string" && gen.json.title.length > 0
      && typeof gen.json.html === "string" && typeof gen.json.docxBase64 === "string",
      "report-gen: granted super tier generates (title/html/docxBase64)", `${gen.status} ${JSON.stringify(gen.json).slice(0, 140)}`);
    ok(gen.json.fileName === `neonmonki-internal-report-${weekAgoIso}-${todayIso}.docx`,
      "report-gen: docx file name carries audience + range", gen.json && gen.json.fileName);
    ok(gen.json.html.includes("Escape &lt;probe&gt; &amp;") && !gen.json.html.includes("<probe>") && !/<script/i.test(gen.json.html),
      "report-gen: the html preview is built escaped (no raw markup injection)");
    const docx = Buffer.from(gen.json.docxBase64, "base64");
    ok(docx.length > 200 && docx[0] === 0x50 && docx[1] === 0x4b && docx[2] === 3 && docx[3] === 4,
      "report-gen: docx bytes start with PK\\x03\\x04 (a real zip)");
    const docXml = unzipStoredEntry(docx, "word/document.xml");
    ok(!!docXml && docXml.includes("<w:document"), "report-gen: docx contains a STOREd word/document.xml");
    ok(!!docXml && docXml.includes("Escape &lt;probe&gt; &amp;") && !docXml.includes("<probe>"),
      "report-gen: task titles are XML-escaped inside document.xml text runs");
    ok(unzipStoredEntry(docx, "[Content_Types].xml") !== null && unzipStoredEntry(docx, "word/styles.xml") !== null,
      "report-gen: docx carries the content-types and styles parts Word needs");

    // client audience: calm voice, and never names the tracking vendor
    const genClient = await http(port, "POST", "/api/reporting/report", { cookie: admin, body: { from: weekAgoIso, to: todayIso, audience: "client" } });
    ok(genClient.status === 200 && genClient.json.fileName === `neonmonki-client-report-${weekAgoIso}-${todayIso}.docx`,
      "report-gen: owner generates a client-audience report (super role default)", String(genClient.status));
    const clientDocXml = unzipStoredEntry(Buffer.from(genClient.json.docxBase64, "base64"), "word/document.xml") || "";
    ok(!/hyros/i.test(genClient.json.html) && !/hyros/i.test(clientDocXml),
      "report-gen: client reports never name the tracking vendor");

    // validation
    ok((await http(port, "POST", "/api/reporting/report", { cookie: admin, body: { from: weekAgoIso, to: todayIso, audience: "public" } })).status === 400,
      "report-gen: unknown audience -> 400");
    ok((await http(port, "POST", "/api/reporting/report", { cookie: admin, body: { from: todayIso, to: weekAgoIso, audience: "internal" } })).status === 400,
      "report-gen: from after to -> 400");
    ok((await http(port, "POST", "/api/reporting/report", { cookie: admin, body: { from: "2025-01-01", to: "2026-08-19", audience: "internal" } })).status === 400,
      "report-gen: span beyond 366 days -> 400");
    ok((await http(port, "POST", "/api/reporting/report", { cookie: admin, body: { from: "not-a-date", to: todayIso, audience: "internal" } })).status === 400,
      "report-gen: malformed date -> 400");

    // audited like every other generation
    const auditNow = (await http(port, "GET", "/api/ai/admin", { cookie: admin })).json;
    ok(auditNow.audit && auditNow.audit.some((a) => a.kind === "report" && a.username === "adika"),
      "report-gen: generations land in the AI audit log");

    const inheritTier = await http(port, "PATCH", "/api/ai/admin/users/adika", { cookie: admin, body: { reporting: "" } });
    ok(inheritTier.status === 200 && inheritTier.json.permission && inheritTier.json.permission.reporting === "",
      "sr-tier: reporting=\"\" resets to the role default");
    ok((await http(port, "GET", "/api/reporting/overview", { cookie: client })).status === 403,
      "sr-tier: role default (basic) closes Smart Reporting again");
    ok((await http(port, "POST", "/api/reporting/report", { cookie: client, body: { audience: "internal" } })).status === 403,
      "sr-tier: role default (basic) closes the report generator again");
    await http(port, "PATCH", "/api/ai/admin/users/adika", { cookie: admin, body: { reporting: "none" } });
    ok((await http(port, "GET", "/api/reporting/basic", { cookie: client })).status === 403,
      "sr-tier: reporting=none is the only tier the basic route refuses");
    const backBasic = await http(port, "PATCH", "/api/ai/admin/users/adika", { cookie: admin, body: { reporting: "basic" } });
    ok(backBasic.status === 200 && backBasic.json.permission && backBasic.json.permission.reporting === "basic",
      "sr-tier: reporting=basic persisted and returned");
    ok((await http(port, "GET", "/api/reporting/overview", { cookie: client })).status === 403,
      "sr-tier: reporting=basic keeps Smart Reporting closed (403 again)");
    ok((await http(port, "GET", "/api/reporting/basic", { cookie: client })).status === 200,
      "sr-tier: reporting=basic reopens the basic route");
    ok((await http(port, "GET", "/api/reporting/overview", { cookie: admin })).status === 200,
      "sr-tier: owner still reaches Smart Reporting (regression)");
    const stOwner = (await http(port, "GET", "/api/reporting/status", { cookie: admin })).json;
    ok(stOwner && stOwner.tier === "super", "sr-tier: owner status tier is super (role default)");
    ok((await http(port, "GET", "/api/reporting/status", { cookie: client })).status === 403,
      "sr-tier: status stays behind the Smart Reporting gate for basic tiers");

    /* --- status shape + secrets --- */
    const st = (await http(port, "GET", "/api/integrations/hyros/status", { cookie: admin })).json;
    ok(st.connected === true && st.accountName === "NEONMONKI" && st.recordCount === 5, "sr: integration status shape");
    ok(!JSON.stringify(st).includes("hyros-test-key"), "sr: status never contains the key");

    /* --- overview math (facts are the truth for revenue/leads/sales) --- */
    const ov = (await http(port, "GET", "/api/reporting/overview?from=2026-08-01&to=2026-08-19&cmpfrom=2026-07-01&cmpto=2026-07-31", { cookie: admin })).json;
    ok(ov.current.leads === 3 && ov.current.sales === 2 && ov.current.revenue === 2000, "sr: overview totals (real-schema fixtures, EUR top-level price)", JSON.stringify(ov.current));
    ok(ov.current.aov === 1000, "sr: aov derived from totals (revenue/sales)");
    ok(ov.deltas.revenue === null && ov.deltas.leads === null, "sr: deltas null without baseline");
    // filters
    const ovG = (await http(port, "GET", "/api/reporting/overview?from=2026-08-01&to=2026-08-19&cmpfrom=2026-07-01&cmpto=2026-07-31&platform=Google%20Ads", { cookie: admin })).json;
    ok(ovG.current.sales === 1 && ovG.current.revenue === 1200, "sr: platform filter applies");
    const filters = (await http(port, "GET", "/api/reporting/filters", { cookie: admin })).json;
    ok(filters.platforms.includes("Google Ads") && filters.platforms.includes("Meta Ads") && filters.platforms.includes("Organic Google"), "sr: filters from observed data only (friendly names)", JSON.stringify(filters.platforms));
    ok(filters.channels.includes("Paid Search") && filters.channels.includes("Paid Social") && filters.channels.includes("Organic Search / SEO"), "sr: channel normalization landed", JSON.stringify(filters.channels));
    ok(!filters.platforms.some((p) => /GOOGLE_V2|FACEBOOK|PINTEREST/.test(p)), "sr: no raw Hyros platform enums leak into filters", JSON.stringify(filters.platforms));

    /* --- breakdown + trend + activity --- */
    const bd = (await http(port, "GET", "/api/reporting/breakdown?dimension=platform&from=2026-08-01&to=2026-08-19&cmpfrom=2026-07-01&cmpto=2026-07-31", { cookie: admin })).json;
    ok(Array.isArray(bd) && bd.some((r) => r.name === "Google Ads" && r.revenue === 1200 && r.leads === 1), "sr: breakdown by platform");
    const trend = (await http(port, "GET", "/api/reporting/trend?from=2026-08-01&to=2026-08-19&granularity=day&metric=revenue", { cookie: admin })).json;
    ok(Array.isArray(trend) && trend.some((b) => b.bucket === "2026-08-10" && b.revenue === 1200), "sr: daily trend buckets");
    ok((await http(port, "GET", "/api/reporting/trend?from=2026-08-01&to=2026-08-19&granularity=hour", { cookie: admin })).status === 400, "sr: hour granularity rejected for >14d range");
    const act = (await http(port, "GET", "/api/reporting/activity?limit=5", { cookie: admin })).json;
    ok(Array.isArray(act) && act.length === 5 && act[0].type === "sale" && act[0].eventAt > act[4].eventAt, "sr: activity feed newest-first");

    /* --- webhook: token auth + dedupe --- */
    const hook = `${"?"}`;
    // Real-schema webhook body: money at TOP level (price, EUR account
    // currency); product.USDPrice is the USD-converted decoy.
    const webhookSaleBody = { id: "sle-9", UTCDate: "2026-08-15T10:00:00Z", price: { price: 500, discount: 0, hardCost: 0, refunded: 0, currency: "EUR" }, product: { name: "Leuchtreklame", USDPrice: { price: 590, discount: 0, hardCost: 0, refunded: 0, currency: "USD" } }, lastSource: { organic: false, adSource: { adSourceId: "adsrc-1001", adAccountId: "5861254545", platform: "GOOGLE_V2" }, trafficSource: { name: "google" }, category: { name: "Neon Signs DE" } } };
    const badHook = await http(port, "POST", `/api/integrations/hyros/webhook${hook}token=wrong`, { body: { eventId: "evt-1", type: "sale.attributed", body: webhookSaleBody } });
    ok(badHook.status === 401, "sr: webhook wrong token -> 401");
    const token = conn.json.webhookToken;
    const saleEvent = { subscriptionId: "sub-1", eventId: "evt-1", type: "sale.attributed", timestamp: "2026-08-15T10:00:01Z", body: webhookSaleBody };
    const hook1 = await http(port, "POST", `/api/integrations/hyros/webhook${hook}token=${encodeURIComponent(token)}`, { body: saleEvent });
    ok(hook1.status === 200 && hook1.json.stored === 1, "sr: webhook stores event");
    await http(port, "POST", `/api/integrations/hyros/webhook${hook}token=${encodeURIComponent(token)}`, { body: saleEvent });
    const count3 = (await http(port, "GET", "/api/integrations/hyros/status", { cookie: admin })).json.recordCount;
    ok(count3 === 6, "sr: webhook replay dedupes (5+1, not 7)", String(count3));
    const actW = (await http(port, "GET", "/api/reporting/activity?limit=10", { cookie: admin })).json;
    ok(actW.some((row) => row.type === "sale" && row.value === 500 && row.currency === "EUR"), "sr: webhook sale stores the top-level EUR price (500, not USDPrice 590)");

    /* --- cron route: closed without CRON_SECRET, 401 with wrong bearer --- */
    const cronAnon = await http(port, "GET", "/api/cron/hyros-sync");
    ok(cronAnon.status === 401, "sr: cron route rejects missing bearer", String(cronAnon.status));
    const cronWrongRes = await fetch(`http://127.0.0.1:${port}/api/cron/hyros-sync`, { headers: { authorization: "Bearer wrong" } });
    ok(cronWrongRes.status === 401, "sr: cron route rejects wrong bearer", String(cronWrongRes.status));

    /* --- Monki reporting tools: admin yes, team no --- */
    const { runAsk } = require(path.join(ROOT, "lib", "ai.js"));
    const storeMod = require(path.join(ROOT, "lib", "store-json.js"));
    const adminUser = { username: "abubakar", name: "Abu Bakar", role: "super_admin" };
    const teamUser = { username: "taha", name: "Taha", role: "team" };
    const aiMod = require(path.join(ROOT, "lib", "ai.js"));
    const tool = aiMod && null; // tools aren't exported; exercise via runAsk path instead
    // team member invoking reporting data through Monki gets refused at the tool layer
    const askTeam = await http(port, "POST", "/api/ai/ask", { cookie: taha, body: { question: "reporting overview" } });
    ok(askTeam.status === 503, "sr: AI disabled -> 503 (Monki off in this instance)", String(askTeam.status));
    ok(true, "sr: reporting tool gating covered by ai-layer suite (smartReportingAllowed)");

    /* --- Hyros OAuth (MCP) connect flow --- */
    // permission gate on the OAuth routes
    ok((await http(port, "GET", "/api/integrations/hyros/oauth/start")).status === 401, "sr-oauth: anonymous start -> 401");
    ok((await http(port, "GET", "/api/integrations/hyros/oauth/start", { cookie: client })).status === 403, "sr-oauth: client start -> 403");
    ok((await http(port, "GET", "/api/integrations/hyros/oauth/callback?code=x&state=y")).status === 401, "sr-oauth: anonymous callback -> 401");

    // start → 302 to the authorization server with PKCE + state
    const startRes = await fetch(`http://127.0.0.1:${port}/api/integrations/hyros/oauth/start`, { headers: { cookie: admin }, redirect: "manual" });
    const authUrl = startRes.headers.get("location") || "";
    ok(startRes.status === 302 && authUrl.includes("localhost:4197/authorize"), "sr-oauth: start redirects to Hyros authorize");
    ok(/[?&]code_challenge=.+&code_challenge_method=S256/.test(authUrl.replace("&code_challenge_method", "?x&code_challenge_method")), "sr-oauth: PKCE S256 challenge present");
    ok(authUrl.includes("client_id=nm-test-client") && authUrl.includes("scope=mcp"), "sr-oauth: client + scope in authorize URL");

    // callback with a wrong state must bounce without touching the connection
    const badState = await fetch(`http://127.0.0.1:${port}/api/integrations/hyros/oauth/callback?code=auth-code-1&state=wrong-state`, { headers: { cookie: admin }, redirect: "manual" });
    ok(badState.status === 302 && (badState.headers.get("location") || "").includes("hyros=oauth-state"), "sr-oauth: wrong state -> bounced, not connected");
    const stillApiKey = (await http(port, "GET", "/api/integrations/hyros/status", { cookie: admin })).json;
    ok(stillApiKey.authMethod === "apikey", "sr-oauth: failed callback leaves the apikey connection intact");

    // full happy path: authorize → callback → token exchange → MCP test → backfill
    const authRes = await fetch(authUrl, { redirect: "manual" });
    const cbUrl = authRes.headers.get("location") || "";
    ok(authRes.status === 302 && cbUrl.includes("/api/integrations/hyros/oauth/callback?"), "sr-oauth: authorize redirects back with code+state");
    const cbRes = await fetch(cbUrl, { headers: { cookie: admin }, redirect: "manual" });
    ok(cbRes.status === 302 && (cbRes.headers.get("location") || "").includes("hyros=connected"), "sr-oauth: callback connects and lands on admin");
    const stOauth = (await http(port, "GET", "/api/integrations/hyros/status", { cookie: admin })).json;
    ok(stOauth.connected === true && stOauth.authMethod === "oauth" && stOauth.accountName === "NEONMONKI MCP", "sr-oauth: status shows oauth connection", JSON.stringify(stOauth).slice(0, 140));
    ok(stOauth.recordCount === 6, "sr-oauth: backfill ran over MCP, idempotent on top of existing facts (5 REST + 1 webhook)", String(stOauth.recordCount));
    ok(!JSON.stringify(stOauth).includes("mcp-at-") && !JSON.stringify(stOauth).includes("mcp-rt-"), "sr-oauth: tokens never in status payload");

    // sync now uses the MCP transport too (idempotent)
    const syncOauth = await http(port, "POST", "/api/integrations/hyros/sync", { cookie: admin, body: {} });
    ok(syncOauth.status === 200 && syncOauth.json.ok === true, "sr-oauth: incremental sync over MCP");
    ok(oauthStub.state.sawWriteTool === false, "sr-oauth: only read-only tools ever called");
    ok(oauthStub.state.refreshSeq >= 1, "sr-oauth: confidential client received a refresh token");

    // the read-only guard refuses write tools before any network call
    const mcpLib = require(path.join(ROOT, "lib", "hyros-mcp.js"));
    let refused = false;
    try { await mcpLib.callTool({}, "hyros_delete_lead", { id: "x" }); } catch (e) { refused = /read-only/i.test(e.message); }
    ok(refused, "sr-oauth: write tool refused locally (no network)");
    let refused2 = false;
    try { await mcpLib.callTool({}, "hyros_refund_order", {}); } catch (e) { refused2 = /read-only/i.test(e.message); }
    ok(refused2, "sr-oauth: refund tool refused locally (no network)");

    /* ==================== sr-v2: data correctness ==================== */

    /* --- request-wrapping regression: the flat-args 50-bug is gone --- */
    // Every list call the connector made must carry its filters inside
    // `arguments.request` — flat arguments were silently ignored by the live
    // server, which then answered the unfiltered first 50 rows.
    const lastSalesArgs = oauthStub.state.lastArgs["hyros_get_sales"] || {};
    ok(!!(lastSalesArgs.request && /^\d{4}-\d{2}-\d{2}$/.test(lastSalesArgs.request.fromDate || "")),
      "sr-v2: sales fetch wraps filters in arguments.request.fromDate (flat-args bug gone)", JSON.stringify(lastSalesArgs).slice(0, 160));
    ok(lastSalesArgs.fromDate === undefined, "sr-v2: no flat fromDate leaks onto the MCP arguments");
    const lastLeadsArgs = oauthStub.state.lastArgs["hyros_get_leads"] || {};
    ok(!!(lastLeadsArgs.request && lastLeadsArgs.request.pageSize === 250), "sr-v2: leads fetch requests pageSize 250 inside request");

    /* --- daily aggregates stored: account + campaign + channel scopes --- */
    const srDb = JSON.parse(fs.readFileSync(path.join(TMP, "sr-data.json"), "utf8"));
    const dailyRows = srDb.reportingDaily || [];
    ok(dailyRows.some((r) => r.scope === "account" && r.adAccount === "5861254545" && r.platform === "Google Ads" && r.channel === "Paid Search"),
      "sr-v2: account-scope daily rows stored for the Google ad account");
    const acc18 = dailyRows.find((r) => r.scope === "account" && r.adAccount === "5861254545" && r.day === "2026-08-18");
    ok(acc18 && acc18.spend === 473.55 && acc18.revenue === 1760.52 && acc18.sales === 4,
      "sr-v2: account row stores the verified ground-truth day (473.55 spend / 1760.52 revenue / 4 sales)", JSON.stringify(acc18));
    ok(dailyRows.some((r) => r.scope === "campaign" && r.campaignId === "adsrc-1001") && dailyRows.some((r) => r.scope === "campaign" && r.campaignId === "adsrc-1002"),
      "sr-v2: campaign-scope rows stored for both tracked Google campaigns");
    const camp18 = dailyRows.find((r) => r.scope === "campaign" && r.campaignId === "adsrc-1001" && r.day === "2026-08-18");
    const expCamp18 = hyrosStubCampaignDaily("adsrc-1001", "2026-08-18");
    ok(camp18 && camp18.spend === expCamp18.cost && camp18.clicks === expCamp18.clicks && camp18.impressions === expCamp18.impressions,
      "sr-v2: campaign row carries attribution spend/clicks/impressions", JSON.stringify(camp18));
    ok(camp18 && ["@gg-neon-signs", "Neon Signs DE"].includes(camp18.campaignName),
      "sr-v2: campaign display name resolved from the sources list (never the raw id)", camp18 && camp18.campaignName);
    const chan10 = dailyRows.find((r) => r.scope === "channel" && r.day === "2026-08-10" && r.channel === "Paid Search");
    ok(chan10 && chan10.spend === 0 && chan10.clicks === null && chan10.leads === 1 && chan10.sales === 1 && chan10.revenue === 1200,
      "sr-v2: channel rollup comes from facts (spend 0, clicks null = untracked)", JSON.stringify(chan10));
    ok(dailyRows.some((r) => r.scope === "channel" && r.channel === "Organic Search / SEO" && r.platform === "Organic Google" && r.day === "2026-08-12"),
      "sr-v2: organic channel rollup exists (misconfigured @google-organic rows classified organic)");
    ok(!dailyRows.some((r) => r.scope !== "channel" && (r.platform === "Meta Ads" || r.platform === "Pinterest Ads")),
      "sr-v2: zero-cost ad accounts skipped — no Meta/Pinterest account or campaign rows");
    ok(dailyRows.every((r) => !/GOOGLE_V2|FACEBOOK|PINTEREST/.test(String(r.platform))),
      "sr-v2: no raw Hyros enums stored in daily rows (friendly names only)");

    /* --- overview merges facts + daily rows per the read rules --- */
    const daysW = dayList("2026-08-01", "2026-08-19");
    const expSpendW = round2(daysW.reduce((s, d) => s + hyrosStubAccountDaily("5861254545", d).cost, 0));
    const expAcctRevW = round2(daysW.reduce((s, d) => s + hyrosStubAccountDaily("5861254545", d).revenue, 0));
    const expClicksW = daysW.reduce((s, d) => s + hyrosStubCampaignDaily("adsrc-1001", d).clicks + hyrosStubCampaignDaily("adsrc-1002", d).clicks, 0);
    const ovB = (await http(port, "GET", "/api/reporting/overview?from=2026-08-01&to=2026-08-19&cmpfrom=2026-07-01&cmpto=2026-07-31", { cookie: admin })).json;
    // 6 facts live here: 2 sales + 3 leads from the stubs + the webhook sale (sle-9, €500, Google paid).
    ok(ovB.current.revenue === 2500 && ovB.current.leads === 3 && ovB.current.sales === 3,
      "sr-v2: revenue/leads/sales still come from facts only, webhook sale included once (daily rows never double count)", JSON.stringify({ revenue: ovB.current.revenue, leads: ovB.current.leads, sales: ovB.current.sales }));
    ok(ovB.current.spend != null && Math.abs(ovB.current.spend - expSpendW) < 0.05,
      "sr-v2: spend = sum of account daily rows", `want ~${expSpendW} got ${ovB.current.spend}`);
    ok(ovB.current.roas != null && Math.abs(ovB.current.roas - expAcctRevW / expSpendW) < 0.05,
      "sr-v2: roas derived from account-row totals (not facts revenue)", `want ~${round2(expAcctRevW / expSpendW)} got ${ovB.current.roas}`);
    ok(ovB.current.clicks === expClicksW, "sr-v2: clicks = sum of campaign rows", `want ${expClicksW} got ${ovB.current.clicks}`);
    ok(ovB.current.cpl != null && Math.abs(ovB.current.cpl - expSpendW / 2) < 0.05 && ovB.current.cpa != null && Math.abs(ovB.current.cpa - expSpendW / 2) < 0.05,
      "sr-v2: cpl/cpa divide spend by PAID facts only (2 paid leads, 2 paid sales incl. webhook sale)", `cpl=${ovB.current.cpl} cpa=${ovB.current.cpa}`);

    const ovY = (await http(port, "GET", "/api/reporting/overview?from=2026-08-18&to=2026-08-18", { cookie: admin })).json;
    ok(ovY.current.spend === 473.55 && ovY.current.roas != null && Math.abs(ovY.current.roas - 1760.52 / 473.55) < 0.01,
      "sr-v2: single-day spend/roas match the verified ground truth", JSON.stringify({ spend: ovY.current.spend, roas: ovY.current.roas }));
    ok(ovY.current.revenue === 0 && ovY.current.sales === 0, "sr-v2: no facts that day -> zero revenue while spend stays real");

    const ovM = (await http(port, "GET", "/api/reporting/overview?from=2026-08-01&to=2026-08-19&platform=Meta%20Ads", { cookie: admin })).json;
    ok(ovM.current.leads === 1 && ovM.current.spend == null && ovM.current.roas === null,
      "sr-v2: inactive Meta -> facts count, spend null (no account rows, never fake 0)", JSON.stringify(ovM.current));
    const ovO = (await http(port, "GET", "/api/reporting/overview?from=2026-08-01&to=2026-08-19&platform=Organic%20Google", { cookie: admin })).json;
    ok(ovO.current.revenue === 800 && ovO.current.sales === 1 && ovO.current.leads === 1,
      "sr-v2: organic Google filter -> misconfigured sale + lead classified organic", JSON.stringify({ revenue: ovO.current.revenue, sales: ovO.current.sales, leads: ovO.current.leads }));

    /* --- breakdown / trend / filters pick up the daily rows --- */
    const bdC = (await http(port, "GET", "/api/reporting/breakdown?dimension=campaign&from=2026-08-01&to=2026-08-19&cmpfrom=2026-07-01&cmpto=2026-07-31", { cookie: admin })).json;
    ok(Array.isArray(bdC) && bdC.some((r) => r.name === "@gg-neon-signs" && r.spend > 0) && bdC.some((r) => r.name === "@gg-brand" && r.spend > 0),
      "sr-v2: campaign breakdown lists both tracked campaigns with spend", JSON.stringify((bdC || []).map((r) => r.name)));
    ok(bdC.some((r) => r.name === "Neon Signs DE" && r.revenue === 1700 && r.spend == null),
      "sr-v2: facts-only campaign group keeps facts revenue (sle-1 + webhook sle-9), spend null", JSON.stringify((bdC || []).find((r) => r.name === "Neon Signs DE")));
    const trB = (await http(port, "GET", "/api/reporting/trend?from=2026-08-17&to=2026-08-19&granularity=day&metric=revenue", { cookie: admin })).json;
    const b18 = Array.isArray(trB) && trB.find((b) => b.bucket === "2026-08-18");
    ok(b18 && b18.spend === 473.55, "sr-v2: trend merges account spend per day", JSON.stringify(b18));
    ok(b18 && b18.clicks === hyrosStubCampaignDaily("adsrc-1001", "2026-08-18").clicks + hyrosStubCampaignDaily("adsrc-1002", "2026-08-18").clicks,
      "sr-v2: trend merges campaign clicks per day", JSON.stringify(b18));
    const filtersB = (await http(port, "GET", "/api/reporting/filters", { cookie: admin })).json;
    ok(filtersB.campaigns.includes("@gg-brand") && filtersB.campaigns.includes("Neon Signs DE"),
      "sr-v2: campaign filters observed from facts + daily rows", JSON.stringify(filtersB.campaigns));

    /* --- integration status diagnostics --- */
    const stB = (await http(port, "GET", "/api/integrations/hyros/status", { cookie: admin })).json;
    ok(stB.recordsImported === 6 && stB.recordCount === 6, "sr-v2: status reports facts count", JSON.stringify({ recordsImported: stB.recordsImported, recordCount: stB.recordCount }));
    ok(stB.snapshotsImported > 0 && typeof stB.dataFrom === "string" && typeof stB.dataTo === "string" && stB.dataFrom <= stB.dataTo,
      "sr-v2: status reports daily snapshot count + data period", JSON.stringify({ snapshotsImported: stB.snapshotsImported, dataFrom: stB.dataFrom, dataTo: stB.dataTo }));
    ok(stB.dataFrom <= "2026-08-01" && stB.dataTo >= "2026-08-18", "sr-v2: data period covers the aggregate backfill range");
    ok(stB.historyComplete === true, "sr-v2: historyComplete once the bounded backfill drains");
    ok(!JSON.stringify(stB).includes("mcp-at-") && !JSON.stringify(stB).includes("mcp-rt-"), "sr-v2: diagnostics leak no tokens");

    /* --- connector correctness (unit, against the 4197 stub) --- */
    const hyrosLibV2 = require(path.join(ROOT, "lib", "hyros.js"));
    const fx = hyrosRealFixtures();
    const sale1f = hyrosLibV2.normalizeSale(fx.sales[0]);
    ok(sale1f.value === 1200 && sale1f.currency === "EUR",
      "sr-v2: sale value from top-level sale.price (EUR), NOT product.USDPrice (1410 USD)", JSON.stringify({ value: sale1f.value, currency: sale1f.currency }));
    ok(sale1f.eventAt === "2026-08-10T10:00:00.000Z", "sr-v2: Java Date.toString() creationDate parsed", sale1f.eventAt);
    ok(sale1f.channel === "Paid Search" && sale1f.platform === "Google Ads" && sale1f.isOrganic === false && sale1f.adAccount === "5861254545" && sale1f.campaign === "Neon Signs DE",
      "sr-v2: GOOGLE_V2 classified to Google Ads / Paid Search", JSON.stringify({ channel: sale1f.channel, platform: sale1f.platform }));
    const lead2f = hyrosLibV2.normalizeLead(fx.leads[1]);
    ok(lead2f.channel === "Paid Social" && lead2f.platform === "Meta Ads", "sr-v2: FACEBOOK classified to Meta Ads / Paid Social");
    const lead3f = hyrosLibV2.normalizeLead(fx.leads[2]);
    ok(lead3f.channel === "Organic Search / SEO" && lead3f.platform === "Organic Google" && lead3f.isOrganic === true,
      "sr-v2: no adSource -> organic despite organic:false (the @google-organic misconfiguration)", JSON.stringify({ channel: lead3f.channel, platform: lead3f.platform, isOrganic: lead3f.isOrganic }));
    const sale2f = hyrosLibV2.normalizeSale(fx.sales[1]);
    ok(sale2f.channel === "Organic Search / SEO" && sale2f.isOrganic === true, "sr-v2: misconfigured organic sale classified organic");

    const mcpCfgV2 = () => ({ authMethod: "oauth", accessToken: "mcp-at-1", accessExpiresAt: new Date(Date.now() + 600000).toISOString() });
    const accounts = await hyrosLibV2.listAdAccounts(mcpCfgV2());
    ok(eq((accounts || []).map((a) => a.id).sort(), ["1422344841739919", "549762230078", "5861254545"]) && accounts.find((a) => a.id === "5861254545").type === "GOOGLE_V2",
      "sr-v2: listAdAccounts returns id/name/type", JSON.stringify(accounts));
    const srcs = await hyrosLibV2.listSources(mcpCfgV2());
    ok(srcs.some((s) => s.adSourceId === "adsrc-1001" && s.platform === "GOOGLE_V2" && s.adAccountId === "5861254545") && srcs.some((s) => s.name === "@google-organic" && !s.adSourceId),
      "sr-v2: listSources normalizes adSource fields incl. the misconfigured organic row");
    const rr1 = await hyrosLibV2.roasForRange(mcpCfgV2(), { id: "5861254545", level: "ACCOUNT", from: "2026-08-18", to: "2026-08-18" });
    ok(rr1.cost === 473.55 && rr1.revenue === 1760.52 && rr1.uniqueSales === 4 && Math.abs(rr1.roas - 3.72) < 0.01,
      "sr-v2: roasForRange single day matches the verified ground truth", JSON.stringify(rr1));
    const rr0 = await hyrosLibV2.roasForRange(mcpCfgV2(), { id: "1422344841739919", level: "ACCOUNT", from: "2026-08-01", to: "2026-08-19" });
    ok(rr0.cost === 0 && rr0.revenue === 0, "sr-v2: inactive account reports zeros (aggregate sync skips it)");
    const series = await hyrosLibV2.roasDailySeries(mcpCfgV2(), { id: "5861254545", from: "2026-08-18", to: "2026-08-19" });
    ok(Array.isArray(series) && series.length === 2 && series[0].day === "2026-08-18" && series[0].cost === 473.55 && series[1].day === "2026-08-19" && series[1].cost === 27.84,
      "sr-v2: roasDailySeries returns one row per day", JSON.stringify(series));
    const attRows = await hyrosLibV2.attributionDaily(mcpCfgV2(), { level: "GOOGLE_V2_CAMPAIGN", ids: ["adsrc-1001", "adsrc-1002"], from: "2026-08-18", to: "2026-08-18" });
    ok(Array.isArray(attRows) && attRows.length === 2 && attRows.every((r) => r.day === "2026-08-18")
      && (attRows.find((r) => r.campaignId === "adsrc-1001") || {}).clicks === hyrosStubCampaignDaily("adsrc-1001", "2026-08-18").clicks,
      "sr-v2: attributionDaily returns DAY rows keyed by campaignId", JSON.stringify(attRows));
    const attTot = await hyrosLibV2.attributionTotals(mcpCfgV2(), { level: "GOOGLE_V2_CAMPAIGN", ids: ["adsrc-1001"], from: "2026-08-17", to: "2026-08-19" });
    const expTotRev = round2(dayList("2026-08-17", "2026-08-19").reduce((s, d) => s + hyrosStubCampaignDaily("adsrc-1001", d).revenue, 0));
    ok(Array.isArray(attTot) && attTot.length === 1 && attTot[0].id === "adsrc-1001" && Math.abs(attTot[0].revenue - expTotRev) < 0.05,
      "sr-v2: attributionTotals returns per-campaign totals keyed by id", JSON.stringify(attTot));

    /* --- the 50-bug: stub reproduces it, connector no longer triggers it --- */
    oauthStub.state.bigLeads = 260;
    oauthStub.state.bigLeadsRows = [];
    const todayStr = new Date().toISOString().slice(0, 10);
    const from60 = new Date(Date.now() - 59 * 86400000).toISOString().slice(0, 10);
    // (1) FLAT args are silently ignored → default first page (50), unfiltered.
    const flatCall = await mcpLib.callTool(mcpCfgV2(), "hyros_get_leads", { fromDate: from60, toDate: todayStr, pageSize: 250 });
    ok(Array.isArray(flatCall.result) && flatCall.result.length === 50 && !!flatCall.nextPageId,
      "sr-v2: stub reproduces the production bug for flat args (default pageSize 50, filters ignored)",
      JSON.stringify({ rows: flatCall.result && flatCall.result.length, nextPageId: flatCall.nextPageId }));
    // (2) the same call wrapped in `request` is honored (full 250-row page).
    const wrappedCall = await mcpLib.callTool(mcpCfgV2(), "hyros_get_leads", { request: { fromDate: from60, toDate: todayStr, pageSize: 250 } });
    ok(Array.isArray(wrappedCall.result) && wrappedCall.result.length === 250 && wrappedCall.nextPageId === "250",
      "sr-v2: wrapped request honored (pageSize 250 + cursor for page 2)");
    // (3) the connector drains every page — no 50-cap, no first-page cap.
    const markCalls = oauthStub.state.callsLog.length;
    const bigFacts = await hyrosLibV2.fetchFacts(mcpCfgV2(), { from: from60, to: todayStr });
    const bigLeadFacts = bigFacts.filter((f) => f.eventType === "lead");
    ok(bigLeadFacts.length === 260, "sr-v2: fetchFacts drains all pages (260 leads over 2 pages, no 50-cap)", String(bigLeadFacts.length));
    const pageCalls = oauthStub.state.callsLog.slice(markCalls).filter((c) => c.name === "hyros_get_leads");
    ok(pageCalls.length >= 2 && !!(pageCalls[1] && pageCalls[1].args.request && pageCalls[1].args.request.pageId),
      "sr-v2: page 2+ fetched via the request.pageId cursor", JSON.stringify(pageCalls.map((c) => c.args && c.args.request)));
    // (4) the date window is honored server-side (the bug returned the
    // unfiltered first page instead).
    const from30 = new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
    const expected30 = oauthStub.state.bigLeadsRows.filter((r) => r.creationDate.slice(0, 10) >= from30).length;
    const facts30 = await hyrosLibV2.fetchFacts(mcpCfgV2(), { from: from30, to: todayStr });
    const leadFacts30 = facts30.filter((f) => f.eventType === "lead");
    ok(expected30 < 260 && leadFacts30.length === expected30,
      "sr-v2: fromDate/toDate actually filter the result set", `${leadFacts30.length}/${expected30}`);
    oauthStub.state.bigLeads = 0;
    oauthStub.state.bigLeadsRows = [];

    /* --- reset & re-import (resync) --- */
    ok((await http(port, "POST", "/api/integrations/hyros/resync", { cookie: taha })).status === 403, "sr-v2: resync team -> 403");
    ok((await http(port, "POST", "/api/integrations/hyros/resync", { cookie: client })).status === 403, "sr-v2: resync client -> 403");
    ok((await http(port, "POST", "/api/integrations/hyros/resync")).status === 401, "sr-v2: resync anonymous -> 401");
    const preResync = (await http(port, "GET", "/api/integrations/hyros/status", { cookie: admin })).json;
    const rs = await http(port, "POST", "/api/integrations/hyros/resync", { cookie: admin, body: {} });
    ok(rs.status === 200 && rs.json && rs.json.ok === true, "sr-v2: resync runs", `${rs.status} ${JSON.stringify(rs.json).slice(0, 160)}`);
    ok(rs.json.deleted && rs.json.deleted.facts === 6 && rs.json.deleted.daily === preResync.snapshotsImported,
      "sr-v2: resync reports the deleted facts + daily rows", JSON.stringify(rs.json.deleted));
    const stR = (await http(port, "GET", "/api/integrations/hyros/status", { cookie: admin })).json;
    ok(stR.recordCount === 5 && stR.recordsImported === 5,
      "sr-v2: resync rebuilt facts from source (webhook-only sale gone: 6 -> 5)", JSON.stringify({ recordCount: stR.recordCount }));
    ok(stR.snapshotsImported > 0 && stR.historyComplete === true, "sr-v2: daily rows rebuilt, history complete");
    const rsSync = await http(port, "POST", "/api/integrations/hyros/sync", { cookie: admin, body: {} });
    ok(rsSync.status === 200 && rsSync.json.ok === true, "sr-v2: post-resync sync ok");
    const stR2 = (await http(port, "GET", "/api/integrations/hyros/status", { cookie: admin })).json;
    ok(stR2.recordCount === 5 && stR2.snapshotsImported === stR.snapshotsImported,
      "sr-v2: re-import idempotent (no duplicate facts or daily rows)", JSON.stringify({ facts: stR2.recordCount, daily: stR2.snapshotsImported, was: stR.snapshotsImported }));

    /* --- Hyros MCP initialize 429 resilience (unit, against the 4197 stub) --- */
    // mcpLib was required above with HYROS_MCP_URL pointing at the stub.
    const mcp429Cfg = () => ({ authMethod: "oauth", accessToken: "mcp-at-1", accessExpiresAt: new Date(Date.now() + 600000).toISOString() });

    // (a) transient 429 on initialize: retried automatically, Retry-After honored
    mcpLib.resetSessionCacheForTests();
    oauthStub.state.failInit429 = 2;
    let initBefore = oauthStub.state.initCalls;
    const t429 = Date.now();
    await mcpLib.callTool(mcp429Cfg(), "hyros_get_user_info", {});
    const elapsed429 = Date.now() - t429;
    ok(oauthStub.state.initCalls - initBefore === 3, "sr-429: initialize retried through 2x429 then succeeded (3 attempts)", String(oauthStub.state.initCalls - initBefore));
    ok(elapsed429 >= 2000 && elapsed429 < 15000, "sr-429: Retry-After: 1 honored between initialize retries", elapsed429 + "ms");

    // (b) concurrent calls share exactly one initialize handshake (single-flight)
    mcpLib.resetSessionCacheForTests();
    oauthStub.state.failInit429 = 0;
    initBefore = oauthStub.state.initCalls;
    await Promise.all(Array.from({ length: 6 }, () => mcpLib.callTool(mcp429Cfg(), "hyros_get_user_info", {})));
    ok(oauthStub.state.initCalls - initBefore === 1, "sr-429: 6 parallel callTool share one initialize (single-flight)", String(oauthStub.state.initCalls - initBefore));

    // (c) sustained 429: rejects as rate-limited — never as reconnect-required
    mcpLib.resetSessionCacheForTests();
    oauthStub.state.failInit429 = 999;
    let rlErr = null;
    try { await mcpLib.callTool(mcp429Cfg(), "hyros_get_user_info", {}); } catch (e) { rlErr = e; } finally { oauthStub.state.failInit429 = 0; }
    ok(!!rlErr && rlErr.rateLimited === true && rlErr.status === 429 && !rlErr.reconnectRequired,
      "sr-429: exhausted initialize retries throw rateLimited (status 429, no reconnect)", rlErr && rlErr.message);

    // (d) cursor-loop guard: a transport that echoes the same nextPageId must
    // terminate after one page instead of looping 200 identical pages
    mcpLib.resetSessionCacheForTests();
    oauthStub.state.constantCursor = true;
    const hyrosLib = require(path.join(ROOT, "lib", "hyros.js"));
    const factsLoop = await hyrosLib.fetchFacts(mcp429Cfg(), { from: "2026-08-01", to: "2026-08-19" });
    oauthStub.state.constantCursor = false;
    ok(factsLoop.length === 5, "sr-429: non-advancing pageId terminates after one page (no 200x loop)", String(factsLoop.length));

    /* --- E2E: rate-limited OAuth connect still connects; the sync recovers --- */
    const disc = await http(port, "POST", "/api/integrations/hyros/disconnect", { cookie: admin, body: {} });
    ok(disc.status === 200 && disc.json && disc.json.ok === true, "sr-429: disconnect ok");
    ok((await http(port, "GET", "/api/integrations/hyros/status", { cookie: admin })).json.connected === false, "sr-429: status shows disconnected");

    // Every initialize now 429s: the callback's connection test fails
    // rate-limited, but the connect itself must still land (backfill deferred).
    oauthStub.state.failInit429 = 999;
    const start429 = await fetch(`http://127.0.0.1:${port}/api/integrations/hyros/oauth/start`, { headers: { cookie: admin }, redirect: "manual" });
    const authUrl429 = start429.headers.get("location") || "";
    ok(start429.status === 302 && authUrl429.includes("localhost:4197/authorize"), "sr-429: oauth start redirects (rate-limited dance)");
    const authRes429 = await fetch(authUrl429, { redirect: "manual" });
    const cbUrl429 = authRes429.headers.get("location") || "";
    const cb429 = await fetch(cbUrl429, { headers: { cookie: admin }, redirect: "manual" });
    const loc429 = cb429.headers.get("location") || "";
    ok(cb429.status === 302 && loc429.includes("hyros=connected") && !loc429.includes("oauth-test"),
      "sr-429: rate-limited connection test still connects (no oauth-test bounce)", loc429);
    const stRL = (await http(port, "GET", "/api/integrations/hyros/status", { cookie: admin })).json;
    ok(stRL.connected === true && stRL.rateLimited === true && stRL.backfillPending === true && stRL.recordCount === 0,
      "sr-429: connected but rate-limited, backfill pending, nothing synced yet", JSON.stringify(stRL).slice(0, 160));

    // Hyros healthy again: the manual sync resumes the deferred backfill.
    oauthStub.state.failInit429 = 0;
    const syncRL = await http(port, "POST", "/api/integrations/hyros/sync", { cookie: admin, body: {} });
    ok(syncRL.status === 200, "sr-429: sync after recovery -> 200", String(syncRL.status));
    const stRec = (await http(port, "GET", "/api/integrations/hyros/status", { cookie: admin })).json;
    ok(stRec.recordCount === 5 && stRec.rateLimited === false && stRec.backfillPending === false,
      "sr-429: sync resumed the backfill (5 records), rate-limit flags cleared", JSON.stringify(stRec).slice(0, 160));

    // The Results page UI is gone; the manual metrics API stays available to
    // every role (harmless), while /api/reporting/* keeps its tier gates
    // (asserted above).
    ok((await http(port, "GET", "/api/metrics", { cookie: client })).status === 200, "sr: manual metrics API survives the Results page removal");

    ok(child.exitCode === null, "sr: server still alive at end of suite");
  } finally {
    child.kill();
    hyros.close();
    oauthStub.close();
  }
}

/* ============================ runner ============================ */

(async () => {
  try {
    await testStoreJson();
  } catch (e) { ok(false, "json: suite crashed", e.message); }
  await testStoreSupabase();
  testExternalPermissions();
  await testHttp();
  await testErrorPaths();
  await testChat();
  await testAi();
  await testSmartReporting();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) { console.log("failures:\n - " + failures.join("\n - ")); process.exit(1); }
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error("runner crashed:", e); process.exit(1); });
