#!/usr/bin/env node
/**
 * Seed Supabase with the data extracted from the Excel master trackers.
 * Idempotent (upserts by id) — safe to run multiple times.
 *
 * Usage:
 *   SUPABASE_URL=https://xxx.supabase.co SUPABASE_SERVICE_ROLE_KEY=... node scripts/seed_supabase.js
 *   — or put both in a local .env file (never commit it) and just run the script.
 *
 * Prereq: migrations/001_schema.sql has been run in the Supabase SQL editor.
 */
"use strict";

const fs = require("fs");
const path = require("path");

// minimal .env loader (no dependencies)
require("../lib/env");

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (env or .env file).");
  process.exit(1);
}

const { _internals } = require("../lib/store-supabase");
const { req, taskToRow } = _internals;

const seed = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "data", "seed.json"), "utf8")
);

const CHUNK = 100;

async function upsertAll(table, rows) {
  for (let i = 0; i < rows.length; i += CHUNK) {
    await req("POST", table, {
      body: rows.slice(i, i + CHUNK),
      prefer: "resolution=merge-duplicates,return=minimal",
    });
  }
  console.log(`  ${table}: ${rows.length} rows upserted`);
}

(async () => {
  console.log("Seeding", process.env.SUPABASE_URL);

  // sanity: schema present?
  try {
    await req("GET", "tasks", { query: "select=id&limit=1" });
  } catch (e) {
    console.error("\nCould not read table 'tasks'. Run migrations/001_schema.sql first.");
    console.error("(If you just ran it, wait a few seconds for the PostgREST schema cache to reload, then retry.)");
    console.error(e.message);
    process.exit(1);
  }

  await upsertAll("tasks", seed.tasks.map(taskToRow));

  await upsertAll("deliverables", seed.deliverables.map((d) => ({
    id: d.id, date: d.date, title: d.title, workstream: d.workstream,
    owner: d.owner, recipient: d.recipient, status: d.status, link: d.link,
  })));

  await upsertAll("decisions", seed.decisions.map((d) => ({
    id: d.id, date: d.date, topic: d.topic, rule: d.rule,
    workstream: d.workstream, owner: d.owner,
  })));

  await upsertAll("recurring", seed.recurring.map((r) => ({
    id: r.id, cadence: r.cadence, activity: r.activity, department: r.department,
    owner: r.owner, reviewer: r.reviewer, definition: r.definition,
  })));

  await upsertAll("links", seed.links.map((l) => ({
    id: l.id, task_id: l.taskId || "", date: l.date, workstream: l.workstream,
    title: l.title, url: l.url, type: l.type, owner: l.owner, note: l.note,
  })));

  // team has no natural key — replace the set. Plain insert, not upsert:
  // merge-duplicates upserts must include the primary key (team.id is a
  // generated identity and is absent from these rows).
  await req("DELETE", "team", { query: "id=gt.0" });
  for (let i = 0; i < seed.team.length; i += CHUNK) {
    await req("POST", "team", {
      body: seed.team.slice(i, i + CHUNK).map((p) => ({
        name: p.name, area: p.area, responsibility: p.responsibility, role: p.role,
      })),
      prefer: "return=minimal",
    });
  }
  console.log(`  team: ${seed.team.length} rows inserted`);

  // initial activity entry, only once
  const existing = await req("GET", "activity", { query: "select=id&limit=1" });
  if (!existing.length) {
    await req("POST", "activity", {
      body: {
        task_id: null,
        author: "system",
        text: "Workspace initialized from the NEONMONKI master task sheet.",
      },
      prefer: "return=minimal",
    });
    console.log("  activity: init entry added");
  }

  // read-back verification
  const tables = ["tasks", "deliverables", "decisions", "recurring", "links", "team"];
  for (const t of tables) {
    const rows = await req("GET", t, { query: "select=*" });
    console.log(`verify ${t}: ${rows.length} rows`);
  }
  console.log("\nDone. Set the Vercel env vars and deploy — see README.md.");
})().catch((e) => {
  console.error("Seed failed:", e.message);
  process.exit(1);
});
