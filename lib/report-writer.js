/**
 * NEONMONKI report writer — composes audience-aware performance reports and
 * renders them as a zero-dependency .docx (ZIP/STORE) plus a safe HTML subset.
 *
 * Design rules baked in here:
 * - Data in: the SAME reporting aggregates the dashboards show (lib/reporting.js)
 *   plus Task Hub work context from store.getState(). Compact plain data only —
 *   no PII beyond owner names, never client emails.
 * - The model's prose is UNTRUSTED: we accept only a structured JSON outline
 *   and build every HTML tag / docx run ourselves, fully escaped. Raw model
 *   HTML is never injected into anything.
 * - If the AI provider is unconfigured, down or returns unusable output, a
 *   deterministic report is built from the same data — the user never gets an
 *   empty file.
 * - Client-audience output never names internal tools or vendors (never the
 *   word "Hyros"); the figures are simply "your synced marketing data".
 */
"use strict";

const ai = require("./ai");
const { visibleTasks } = require("./permissions");
const { decodeDepartmentIds, DEFAULT_DEPARTMENTS } = require("./task-system");

/** lib/reporting.js ships with the reporting data layer; load lazily so the
 * writer keeps working (deterministic, work-only) where it is not merged. */
function reportingModule() {
  try { return require("./reporting"); } catch { return null; }
}

/* ------------------------------ small helpers ------------------------------ */

const DAY_MS = 86400000;
const isoDay = (d) => d.toISOString().slice(0, 10);
const todayDay = () => isoDay(new Date());
const shiftDay = (day, delta) => isoDay(new Date(new Date(`${day}T00:00:00Z`).getTime() + delta * DAY_MS));
const spanDays = (from, to) =>
  Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / DAY_MS);
const daysBetween = (from, to) => spanDays(from, to);

function validDayString(d) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const t = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
}

const trunc = (s, n) => {
  s = String(s == null ? "" : s);
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
};

const inRangeDay = (day, from, to) => {
  const d = String(day || "").slice(0, 10);
  return !!d && d >= from && d <= to;
};

const r2 = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

const eur = (v) => (v == null ? "—" : `€${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const num = (v) => (v == null ? "—" : Number(v).toLocaleString("en-US"));
const fmtRoas = (v) => (v == null ? "—" : `${(Math.round(v * 100) / 100).toFixed(2)}x`);
const fmtDelta = (v) => (v == null ? "—" : `${v > 0 ? "+" : ""}${Math.round(v * 10) / 10}%`);

/** Call a reporting-layer function defensively: missing module/function or a
 * rejection degrades to the fallback instead of breaking the report. */
function callReporting(fn, arg, fallback) {
  if (typeof fn !== "function") return Promise.resolve(fallback);
  return Promise.resolve().then(() => fn(arg)).catch(() => fallback);
}

/** The day a task reached Completed (mirrors lib/ai.js's completionDay rule). */
function taskCompletedDay(task) {
  const updates = Array.isArray(task.updates) ? task.updates : [];
  const event = updates.filter((u) => u && u.statusTo === "Completed").pop();
  const last = updates.slice(-1)[0];
  return String((event && event.ts) || (last && last.ts) || task.dateRequested || "").slice(0, 10);
}

function deptNames(task, departments) {
  const list = Array.isArray(departments) && departments.length ? departments : DEFAULT_DEPARTMENTS;
  const ids = decodeDepartmentIds(task.assignedDept, task.department, list);
  const names = ids.map((id) => {
    const d = list.find((x) => x.id === id);
    return d ? d.name : id;
  });
  return names.join(", ") || "Unassigned";
}

/** Cap a daily series for prompt/context size, keeping first/last and an even spread. */
function capSeries(rows, cap) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length <= cap) return list;
  const out = [];
  for (let i = 0; i < cap; i++) {
    out.push(list[Math.round((i * (list.length - 1)) / (cap - 1))]);
  }
  return [...new Set(out)];
}

/* ------------------------------ report context ------------------------------ */

const slimTotals = (t) => (t == null ? null : {
  spend: r2(t.spend), revenue: r2(t.revenue), leads: t.leads, sales: t.sales, calls: t.calls,
  clicks: t.clicks, impressions: t.impressions, paidRevenue: r2(t.paidRevenue),
  roas: r2(t.roas), cpl: r2(t.cpl), cpa: r2(t.cpa), cvr: r2(t.cvr), aov: r2(t.aov),
  ctr: r2(t.ctr), cpc: r2(t.cpc),
});

const slimDeltas = (d) => (d == null ? null : Object.fromEntries(
  ["spend", "revenue", "leads", "sales", "calls", "clicks", "impressions", "roas", "cpl", "cpa", "cvr", "aov", "ctr", "cpc"]
    .map((k) => [k, typeof d[k] === "number" ? d[k] : null])
));

const hasSignal = (r) =>
  (r.revenue || 0) > 0 || (r.spend || 0) > 0 || (r.leads || 0) > 0 || (r.sales || 0) > 0 || (r.clicks || 0) > 0;

const slimBreakdownRow = (r) => ({
  name: trunc(r && r.name || "Unknown", 120),
  spend: r2(r.spend), revenue: r2(r.revenue), leads: r.leads || 0, sales: r.sales || 0,
  roas: r2(r.roas), cpl: r2(r.cpl),
  deltaPct: {
    revenue: r.deltaPct && typeof r.deltaPct.revenue === "number" ? r.deltaPct.revenue : null,
    spend: r.deltaPct && typeof r.deltaPct.spend === "number" ? r.deltaPct.spend : null,
    leads: r.deltaPct && typeof r.deltaPct.leads === "number" ? r.deltaPct.leads : null,
    sales: r.deltaPct && typeof r.deltaPct.sales === "number" ? r.deltaPct.sales : null,
    roas: r.deltaPct && typeof r.deltaPct.roas === "number" ? r.deltaPct.roas : null,
  },
});

const byRevenueDesc = (a, b) =>
  (b.revenue || 0) - (a.revenue || 0) || (b.spend || 0) - (a.spend || 0) || a.name.localeCompare(b.name);

/**
 * Pull everything a report needs for [from, to]: the reporting aggregates the
 * dashboards show (overview vs the equal-length previous period, channel /
 * platform / campaign breakdowns, daily trend) plus the Task Hub work context
 * (completed / in-progress / overdue tasks, per-department rollups, decisions
 * and deliverables in range). Compact plain data — owner names only, no PII.
 */
async function buildReportContext(store, { from, to } = {}) {
  const toDay = validDayString(String(to || "").slice(0, 10)) ? String(to).slice(0, 10) : todayDay();
  let fromDay = validDayString(String(from || "").slice(0, 10)) ? String(from).slice(0, 10) : shiftDay(toDay, -29);
  if (fromDay > toDay) fromDay = toDay;
  const days = spanDays(fromDay, toDay) + 1;
  // equal-length previous period, ending the day before `from`
  const cmpto = shiftDay(fromDay, -1);
  const cmpfrom = shiftDay(cmpto, -(days - 1));

  const reporting = reportingModule();
  const opts = { from: fromDay, to: toDay, cmpfrom, cmpto };
  let overview = null;
  let channels = [];
  let platforms = [];
  let campaigns = [];
  let trendDaily = [];
  let basic = null;
  if (reporting) {
    [overview, channels, platforms, campaigns, trendDaily, basic] = await Promise.all([
      callReporting(reporting.reportingOverview, opts, null),
      callReporting(reporting.reportingBreakdown, { ...opts, dimension: "channel" }, []),
      callReporting(reporting.reportingBreakdown, { ...opts, dimension: "platform" }, []),
      callReporting(reporting.reportingBreakdown, { ...opts, dimension: "campaign" }, []),
      callReporting(reporting.reportingTrend, { from: fromDay, to: toDay, granularity: "day" }, []),
      callReporting(reporting.reportingBasic, { from: fromDay, to: toDay }, null),
    ]);
  }

  const current = slimTotals(overview && overview.current);
  const previous = slimTotals(overview && overview.previous);
  const deltas = slimDeltas(overview && overview.deltas);
  const rawCurrent = (overview && overview.current) || {};
  const available = !!(overview && (
    rawCurrent.hasFacts || rawCurrent.hasAccountRows || rawCurrent.hasCampaignRows
    || (current && ((current.revenue || 0) > 0 || (current.leads || 0) > 0 || (current.sales || 0) > 0 || (current.spend || 0) > 0))
  ));

  const slimRows = (rows, cap) => (Array.isArray(rows) ? rows : [])
    .map(slimBreakdownRow).filter(hasSignal).sort(byRevenueDesc).slice(0, cap);

  const marketing = {
    available,
    current, previous, deltas,
    channels: slimRows(channels, 12),
    platforms: slimRows(platforms, 8),
    campaigns: slimRows(campaigns, 10),
    trendDaily: capSeries((Array.isArray(trendDaily) ? trendDaily : []).map((b) => ({
      day: String(b.bucket || "").slice(0, 10),
      spend: r2(b.spend), revenue: r2(b.revenue), leads: b.leads || 0, sales: b.sales || 0,
    })), 45),
    // The curated client-safe layer (same numbers the Performance page shows);
    // used for client-audience reports so both surfaces always agree.
    basic: basic ? {
      range: basic.range || null,
      current: basic.current || null,
      channels: (Array.isArray(basic.channels) ? basic.channels : []).slice(0, 6),
      campaigns: (Array.isArray(basic.campaigns) ? basic.campaigns : []).slice(0, 5),
      highlights: (Array.isArray(basic.highlights) ? basic.highlights : []).slice(0, 3),
    } : null,
  };

  // ---- Task Hub work context ----
  const state = await store.getState();
  const tasks = Array.isArray(state.tasks) ? state.tasks : [];
  const departments = Array.isArray(state.departments) ? state.departments : [];
  const today = todayDay();

  const completedAll = tasks
    .filter((t) => t.status === "Completed" && inRangeDay(taskCompletedDay(t), fromDay, toDay))
    .sort((a, b) => taskCompletedDay(b).localeCompare(taskCompletedDay(a)));
  const openAll = tasks.filter((t) => !["Completed", "Cancelled"].includes(t.status));
  const inProgressAll = openAll
    .filter((t) => t.status === "In Progress")
    .sort((a, b) => String(a.dueDate || "9999").localeCompare(String(b.dueDate || "9999")));
  const overdueAll = openAll
    .filter((t) => validDayString(String(t.dueDate || "")) && t.dueDate < today)
    .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)));

  const taskRow = (t, extra) => ({
    id: String(t.id || ""),
    title: trunc(t.title, 140),
    owner: trunc(t.owner || "", 80),
    department: deptNames(t, departments),
    ...extra,
  });

  const decisionsAll = (Array.isArray(state.decisions) ? state.decisions : [])
    .filter((d) => inRangeDay(d.date, fromDay, toDay))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const deliverablesAll = (Array.isArray(state.deliverables) ? state.deliverables : [])
    .filter((d) => inRangeDay(d.date, fromDay, toDay))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));

  const deptMap = new Map();
  const bump = (dept, key) => {
    const row = deptMap.get(dept) || { completed: 0, inProgress: 0, overdue: 0 };
    row[key] += 1;
    deptMap.set(dept, row);
  };
  for (const t of completedAll) bump(deptNames(t, departments), "completed");
  for (const t of inProgressAll) bump(deptNames(t, departments), "inProgress");
  for (const t of overdueAll) bump(deptNames(t, departments), "overdue");
  const byDepartment = [...deptMap.entries()]
    .map(([department, v]) => ({ department, ...v }))
    .sort((a, b) =>
      (b.completed + b.inProgress + b.overdue) - (a.completed + a.inProgress + a.overdue)
      || a.department.localeCompare(b.department))
    .slice(0, 12);

  const work = {
    completed: completedAll.slice(0, 40).map((t) => taskRow(t, { day: taskCompletedDay(t), priority: t.priority || "" })),
    inProgress: inProgressAll.slice(0, 25).map((t) => taskRow(t, { dueDate: t.dueDate || "" })),
    overdue: overdueAll.slice(0, 25).map((t) => taskRow(t, { dueDate: t.dueDate, daysOverdue: daysBetween(t.dueDate, today) })),
    byDepartment,
    decisions: decisionsAll.slice(0, 20).map((d) => ({
      id: String(d.id || ""), date: String(d.date || "").slice(0, 10),
      topic: trunc(d.topic, 120), rule: trunc(d.rule, 300),
      workstream: trunc(d.workstream, 80), owner: trunc(d.owner, 80),
    })),
    deliverables: deliverablesAll.slice(0, 20).map((d) => ({
      id: String(d.id || ""), date: String(d.date || "").slice(0, 10),
      title: trunc(d.title, 140), workstream: trunc(d.workstream, 80),
      status: trunc(d.status, 60), owner: trunc(d.owner, 80), link: trunc(d.link, 200),
    })),
    totals: {
      tasks: tasks.length,
      completed: completedAll.length,
      inProgress: inProgressAll.length,
      overdue: overdueAll.length,
      decisions: decisionsAll.length,
      deliverables: deliverablesAll.length,
    },
  };

  return {
    generatedAt: new Date().toISOString(),
    range: { from: fromDay, to: toDay, days, cmpfrom, cmpto },
    marketing,
    work,
  };
}

/* ------------------------------ client-safe views ------------------------------ */

// The one bucket the client surface never shows as-is (mirrors reporting.js).
const friendlyChannelName = (name) => (!name || name === "Unknown" ? "Direct / Other" : name);

/**
 * Client-audience marketing view: the curated basic layer when available
 * (identical to the Performance page), otherwise a friendly-named subset of
 * the full aggregates. Never carries diagnostics or vendor details.
 */
function clientMarketing(context) {
  const basic = context.marketing && context.marketing.basic;
  const available = !!(context.marketing && context.marketing.available);
  if (basic && basic.current) return { ...basic, available };
  const m = context.marketing || {};
  const c = m.current || {};
  const d = m.deltas || {};
  return {
    available,
    range: { from: context.range.from, to: context.range.to },
    current: {
      revenue: c.revenue ?? null, leads: c.leads ?? null, sales: c.sales ?? null,
      spend: c.spend ?? null, roas: c.roas ?? null, aov: c.aov ?? null,
      deltas: {
        revenue: d.revenue ?? null, leads: d.leads ?? null, sales: d.sales ?? null,
        spend: d.spend ?? null, roas: d.roas ?? null,
      },
    },
    channels: (m.channels || []).slice(0, 6).map((ch) => ({
      name: friendlyChannelName(ch.name), revenue: ch.revenue, leads: ch.leads, sales: ch.sales,
    })),
    campaigns: (m.campaigns || []).filter((c2) => (c2.revenue || 0) > 0).slice(0, 5).map((c2) => ({
      name: c2.name === "Unknown" ? "Other campaigns" : c2.name, revenue: c2.revenue, sales: c2.sales,
    })),
    highlights: [],
  };
}

/**
 * Client-audience work view: exactly what the client account may see (same
 * permission filter as the weekly digest), titles and dates only.
 */
async function clientWorkView(store, { from, to }) {
  const state = await store.getState();
  const tasks = Array.isArray(state.tasks) ? state.tasks : [];
  const clientView = { role: "client", username: "__report__", name: "NEONMONKI", active: true };
  const visible = visibleTasks(tasks, clientView);
  const completed = visible
    .filter((t) => t.status === "Completed" && inRangeDay(taskCompletedDay(t), from, to))
    .sort((a, b) => taskCompletedDay(b).localeCompare(taskCompletedDay(a)))
    .slice(0, 12)
    .map((t) => ({ title: trunc(t.title, 140), day: taskCompletedDay(t) }));
  const inProgress = visible
    .filter((t) => t.status === "In Progress")
    .slice(0, 6)
    .map((t) => ({ title: trunc(t.title, 140) }));
  const deliverables = (Array.isArray(state.deliverables) ? state.deliverables : [])
    .filter((d) => inRangeDay(d.date, from, to))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .slice(0, 8)
    .map((d) => ({
      title: trunc(d.title, 140), status: trunc(d.status, 60), date: String(d.date || "").slice(0, 10),
    }));
  return { completed, inProgress, deliverables };
}

/* ------------------------------ AI composition ------------------------------ */

const OUTPUT_CONTRACT = `OUTPUT CONTRACT — return ONLY a JSON object, no markdown fences, no commentary:
{"title": string, "sections": [{"heading": string, "paragraphs": string[], "bullets": string[], "table": {"headers": string[], "rows": [[string]]} | null}]}
Rules:
- Every number must come from the DATA provided — never invent a figure, date or name. If a figure is null or absent, say it is not tracked.
- At most 3 short paragraphs and 8 bullets per section; tables at most 10 rows.
- Use **bold** sparingly around key figures.
- Write in English.`;

const INTERNAL_WRITER_PROMPT = `You write the internal performance report for the NEONMONKI account (premium B2B LED neon signage, Germany) for the Advertidea agency owner. Voice: senior performance marketer — direct, numbers-first, benchmark-aware. Name problems plainly: overspend, soft channels, slipping delivery, missing data. No fluff, no hedging. Label inference as inference. All money is EUR.
Structure: headline performance vs the previous period, channel/campaign detail, work delivered, what is at risk, then recommendations.

${OUTPUT_CONTRACT}`;

const CLIENT_WRITER_PROMPT = `You write a calm, confident performance update for NEONMONKI's project lead, prepared by their marketing delivery team. Plain business language; lead with outcomes and delivered value. When a number is softer than the previous period, state it neutrally and always pair it with what is being done about it — never alarm language. Never mention internal tools, vendors or data platforms by name — never write the word "Hyros"; the figures are simply "your synced marketing data". Never expose internal team chatter, internal-only work or delivery problems. All money is EUR.
Structure: the period in brief, marketing performance, delivered work, looking ahead.

${OUTPUT_CONTRACT}`;

/** Keep the prompt payload bounded: trim the longest lists before serializing. */
function promptData(data) {
  let json = JSON.stringify(data);
  if (json.length <= 22000) return json;
  const trimmed = { ...data };
  if (trimmed.marketing) {
    trimmed.marketing = { ...trimmed.marketing, trendDaily: capSeries(trimmed.marketing.trendDaily || [], 20) };
  }
  if (trimmed.work) {
    const w = trimmed.work;
    trimmed.work = {
      ...w,
      completed: (w.completed || []).slice(0, 15),
      inProgress: (w.inProgress || []).slice(0, 10),
      overdue: (w.overdue || []).slice(0, 10),
      decisions: (w.decisions || []).slice(0, 10),
      deliverables: (w.deliverables || []).slice(0, 10),
    };
  }
  return JSON.stringify(trimmed);
}

function normalizeTable(t) {
  if (!t || typeof t !== "object" || !Array.isArray(t.headers) || !t.headers.length) return null;
  const headers = t.headers.slice(0, 8).map((h) => trunc(h == null ? "" : String(h), 60));
  const rows = (Array.isArray(t.rows) ? t.rows : [])
    .filter((r) => Array.isArray(r))
    .slice(0, 25)
    .map((r) => headers.map((_, i) => trunc(r[i] == null ? "" : String(r[i]), 160)));
  return { headers, rows };
}

/** Parse the model's structured outline. Returns null on anything unusable —
 * the caller then falls back to the deterministic report. */
function parseModelReport(content) {
  if (!content || typeof content !== "string") return null;
  const text = content.slice(0, 20000).trim().replace(/^```(?:json)?/i, "").replace(/```\s*$/, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed;
  try { parsed = JSON.parse(text.slice(start, end + 1)); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.sections)) return null;
  const sections = [];
  for (const s of parsed.sections) {
    if (!s || typeof s !== "object") continue;
    const heading = String(s.heading || "").trim();
    if (!heading) continue;
    sections.push({
      heading,
      paragraphs: (Array.isArray(s.paragraphs) ? s.paragraphs : []).filter((p) => typeof p === "string" && p.trim()),
      bullets: (Array.isArray(s.bullets) ? s.bullets : []).filter((b) => typeof b === "string" && b.trim()),
      table: normalizeTable(s.table),
    });
    if (sections.length >= 10) break;
  }
  if (!sections.length) return null;
  return { title: String(parsed.title || "").trim() || null, sections };
}

async function composeWithModel({ context, clientView, audience, provider, model }) {
  const internal = audience !== "client";
  const data = internal
    ? {
      range: context.range,
      marketing: {
        available: context.marketing.available,
        current: context.marketing.current,
        previous: context.marketing.previous,
        deltas: context.marketing.deltas,
        channels: context.marketing.channels,
        platforms: context.marketing.platforms,
        campaigns: context.marketing.campaigns,
        trendDaily: context.marketing.trendDaily,
      },
      work: context.work,
    }
    : {
      range: { from: context.range.from, to: context.range.to, days: context.range.days },
      marketing: clientView.marketing,
      work: clientView.work,
    };
  const resp = await ai.chatCompletion({
    messages: [
      { role: "system", content: internal ? INTERNAL_WRITER_PROMPT : CLIENT_WRITER_PROMPT },
      {
        role: "user",
        content: [
          `Report period: ${context.range.from} → ${context.range.to} (previous period: ${context.range.cmpfrom} → ${context.range.cmpto}).`,
          "",
          "DATA (JSON — the only source of numbers you may use):",
          promptData(data),
        ].join("\n"),
      },
    ],
    model,
    provider,
    maxTokens: 3500,
  });
  return parseModelReport(resp && resp.content);
}

/* ------------------------------ deterministic fallback ------------------------------ */

function internalRecommendations(context) {
  const m = context.marketing || {};
  const c = m.current || {};
  const d = m.deltas || {};
  const w = context.work || {};
  const recs = [];
  if (m.available) {
    for (const ch of (m.channels || [])) {
      if ((ch.spend || 0) > 0 && ch.roas != null && ch.roas < 1) {
        recs.push(`Review **${ch.name}**: ${eur(ch.spend)} spend returned ${eur(ch.revenue)} attributed revenue (ROAS ${fmtRoas(ch.roas)}) — below breakeven before product margin. Fix targeting/creative or reallocate before the next budget cycle.`);
      }
    }
    if (d.cpl != null && d.cpl > 20 && c.cpl != null) {
      recs.push(`Cost per lead rose ${fmtDelta(d.cpl)} vs the previous period (now ${eur(c.cpl)}) — inspect search terms, placements and creative fatigue before scaling spend.`);
    }
    if (d.leads != null && d.leads > 10 && (d.sales == null || d.sales <= 0)) {
      recs.push(`Lead volume grew ${fmtDelta(d.leads)} while sales were flat to down — check lead quality and sales follow-up speed before adding budget.`);
    }
    const winner = (m.channels || []).filter((ch) => (ch.revenue || 0) > 0 && ch.roas != null && ch.roas >= 2)
      .sort((a, b) => b.roas - a.roas)[0];
    if (winner) {
      recs.push(`Scale what works: **${winner.name}** at ROAS ${fmtRoas(winner.roas)} is the strongest paid channel this period — incremental budget goes here first.`);
    }
  } else {
    recs.push("Reporting data is missing for this period — verify the reporting sync before judging channel performance.");
  }
  if ((w.totals && w.totals.overdue) > 0) {
    const n = w.totals.overdue;
    recs.push(`${n} ${n === 1 ? "task is" : "tasks are"} overdue — re-commit a date or close ${n === 1 ? "it" : "them"} this week; the report names ${n === 1 ? "it" : "them"} above.`);
  }
  if (!recs.length) {
    recs.push("Performance is steady — hold the current plan and let the next report confirm the trend before changing budgets.");
  }
  return recs.slice(0, 6);
}

function deterministicInternalReport(context) {
  const { from, to, days, cmpfrom, cmpto } = context.range;
  const m = context.marketing || {};
  const c = m.current || {};
  const d = m.deltas || {};
  const w = context.work || {};
  const totals = w.totals || {};
  const sections = [];

  const summaryParas = [`Period ${from} → ${to} (${days} days), compared with ${cmpfrom} → ${cmpto}.`];
  if (m.available) {
    summaryParas.push(`**Revenue ${eur(c.revenue)}** (${fmtDelta(d.revenue)}), **ad spend ${eur(c.spend)}** (${fmtDelta(d.spend)}), **leads ${num(c.leads)}** (${fmtDelta(d.leads)}), **sales ${num(c.sales)}** (${fmtDelta(d.sales)}), **ROAS ${fmtRoas(c.roas)}**.`);
    if (c.spend == null) {
      summaryParas.push("Spend is not tracked for this period — ROAS, CPL and CPA stay unavailable until spend rows sync.");
    }
  } else {
    summaryParas.push("No synced marketing data landed in this period — spend, revenue and lead figures are unavailable. The work sections below still stand.");
  }
  summaryParas.push(`Delivery: **${totals.completed || 0} completed** in range, ${totals.inProgress || 0} currently in progress, ${totals.overdue || 0} overdue today.`);
  sections.push({ heading: "Executive summary", paragraphs: summaryParas, bullets: [], table: null });

  const channels = (m.channels || []).slice(0, 10);
  const channelBullets = [];
  if (channels.length) {
    channelBullets.push(`Strongest channel: **${channels[0].name}** — ${eur(channels[0].revenue)} revenue (${fmtDelta(channels[0].deltaPct.revenue)} vs the previous period).`);
    const weakest = channels.filter((ch) => (ch.spend || 0) > 0 && ch.roas != null).sort((a, b) => a.roas - b.roas)[0];
    if (weakest) {
      channelBullets.push(`Weakest paid efficiency: **${weakest.name}** — ROAS ${fmtRoas(weakest.roas)} on ${eur(weakest.spend)} spend.`);
    }
  }
  sections.push({
    heading: "Channel performance",
    paragraphs: channels.length ? [] : ["No channel data for this period."],
    bullets: channelBullets,
    table: channels.length ? {
      headers: ["Channel", "Spend", "Revenue", "Leads", "Sales", "ROAS", "Δ Revenue"],
      rows: channels.map((ch) => [ch.name, eur(ch.spend), eur(ch.revenue), num(ch.leads), num(ch.sales), fmtRoas(ch.roas), fmtDelta(ch.deltaPct.revenue)]),
    } : null,
  });

  const campaigns = (m.campaigns || []).slice(0, 8);
  sections.push({
    heading: "Campaign highlights",
    paragraphs: campaigns.length ? [] : ["No campaign data for this period."],
    bullets: [],
    table: campaigns.length ? {
      headers: ["Campaign", "Spend", "Revenue", "Sales", "ROAS"],
      rows: campaigns.map((c2) => [c2.name, eur(c2.spend), eur(c2.revenue), num(c2.sales), fmtRoas(c2.roas)]),
    } : null,
  });

  const delivered = [
    ...(w.completed || []).slice(0, 10).map((t) => `**${t.title}** — ${t.owner || "unassigned"} · completed ${t.day}`),
    ...(w.deliverables || []).slice(0, 5).map((d2) => `Deliverable: **${d2.title}** — ${d2.status || "shared"} (${d2.date})`),
  ];
  sections.push({
    heading: "Work delivered",
    paragraphs: delivered.length ? [] : ["No tasks were completed inside this exact window."],
    bullets: delivered,
    table: null,
  });

  const overdueBullets = (w.overdue || []).slice(0, 8).map((t) =>
    `**${t.title}** — owner ${t.owner || "unassigned"}, due ${t.dueDate}, ${t.daysOverdue} ${t.daysOverdue === 1 ? "day" : "days"} overdue.`);
  sections.push({
    heading: "In flight & at risk",
    paragraphs: [`${totals.inProgress || 0} tasks currently in progress; ${totals.overdue || 0} overdue.`],
    bullets: overdueBullets,
    table: (w.byDepartment || []).length ? {
      headers: ["Department", "Completed", "In progress", "Overdue"],
      rows: w.byDepartment.map((r) => [r.department, num(r.completed), num(r.inProgress), num(r.overdue)]),
    } : null,
  });

  if ((w.decisions || []).length) {
    sections.push({
      heading: "Decisions & direction",
      paragraphs: [],
      bullets: w.decisions.slice(0, 8).map((d2) => `${d2.date} — **${d2.topic}**: ${d2.rule}`),
      table: null,
    });
  }

  sections.push({ heading: "Recommendations", paragraphs: [], bullets: internalRecommendations(context), table: null });
  return { title: null, sections };
}

function clientNextSteps(current, work) {
  const d = (current && current.deltas) || {};
  const steps = [];
  if (d.revenue != null && d.revenue < -1) {
    steps.push("Revenue came in slightly softer than the previous period — we are reviewing the campaign mix this week and will share the adjustment plan in the next update.");
  }
  if (d.leads != null && d.leads < -5) {
    steps.push("Enquiry volume dipped — we are refreshing audiences and creative to lift it back.");
  }
  if ((work.inProgress || []).length) {
    steps.push(`In progress right now: ${work.inProgress.slice(0, 3).map((t) => t.title).join("; ")}.`);
  }
  if (!steps.length) {
    steps.push("We continue with the current plan and will flag anything that needs your input.");
  }
  return steps.slice(0, 4);
}

function deterministicClientReport(context, clientView) {
  const { from, to } = context.range;
  const mk = (clientView && clientView.marketing) || {};
  const cur = mk.current || {};
  const d = cur.deltas || {};
  const work = (clientView && clientView.work) || { completed: [], inProgress: [], deliverables: [] };
  // A table of zeros when nothing synced would read as real data — the
  // available flag from the aggregates decides whether numbers exist at all.
  const hasNumbers = mk.available === true && ["revenue", "leads", "sales", "spend"].some((k) => cur[k] != null);
  const sections = [];

  const highlights = (Array.isArray(mk.highlights) ? mk.highlights : [])
    .map((h) => String((h && h.text) || "")).filter(Boolean).slice(0, 3);
  sections.push({
    heading: "The period in brief",
    paragraphs: [
      `Here is your performance summary for **${from} to ${to}**, compared with the previous period of the same length.`,
      ...(hasNumbers ? [] : ["Your synced marketing data has not landed for this period yet — as soon as it does, this report fills in automatically."]),
    ],
    bullets: hasNumbers ? highlights : [],
    table: null,
  });

  if (hasNumbers) {
    sections.push({
      heading: "Your marketing performance",
      paragraphs: [],
      bullets: [],
      table: {
        headers: ["Metric", "This period", "Change vs previous"],
        rows: [
          ["Revenue", eur(cur.revenue), fmtDelta(d.revenue)],
          ["Leads", num(cur.leads), fmtDelta(d.leads)],
          ["Sales", num(cur.sales), fmtDelta(d.sales)],
          ["Ad spend", eur(cur.spend), fmtDelta(d.spend)],
          ["Return on ad spend", fmtRoas(cur.roas), fmtDelta(d.roas)],
        ],
      },
    });
  }

  const delivered = [
    ...(work.completed || []).map((t) => `**${t.title}** (${t.day})`),
    ...(work.deliverables || []).map((d2) => `**${d2.title}** — ${d2.status || "shared"}`),
  ].slice(0, 12);
  sections.push({
    heading: "Delivered this period",
    paragraphs: delivered.length ? [] : ["Delivery is in motion — the current work list is in your Task Hub."],
    bullets: delivered,
    table: null,
  });

  sections.push({ heading: "Looking ahead", paragraphs: [], bullets: clientNextSteps(cur, work), table: null });
  return { title: null, sections };
}

/* ------------------------------ sanitize + render ------------------------------ */

const defaultTitle = (audience, from, to) =>
  `NEONMONKI ${audience === "client" ? "performance update" : "performance report"} — ${from} to ${to}`;

/**
 * Enforce the report shape and bounds, and — for the client audience — strip
 * vendor names no matter where the text came from. Everything downstream
 * (HTML, docx) escapes at render time on top of this.
 */
function sanitizeReport(report, { audience, from, to, cmpfrom, cmpto }) {
  const stripVendor = (s) => (audience === "client"
    ? String(s == null ? "" : s).replace(/\bhyros\b/ig, "your synced marketing data")
    : String(s == null ? "" : s));
  const title = trunc(stripVendor(String((report && report.title) || "").trim()) || defaultTitle(audience, from, to), 160);
  const sections = [];
  for (const s of ((report && report.sections) || []).slice(0, 10)) {
    if (!s || typeof s !== "object") continue;
    const heading = trunc(stripVendor(String(s.heading || "").trim()), 140);
    const paragraphs = (Array.isArray(s.paragraphs) ? s.paragraphs : [])
      .filter((p) => typeof p === "string" && p.trim()).slice(0, 6)
      .map((p) => trunc(stripVendor(p), 1200));
    const bullets = (Array.isArray(s.bullets) ? s.bullets : [])
      .filter((b) => typeof b === "string" && b.trim()).slice(0, 14)
      .map((b) => trunc(stripVendor(b), 400));
    const rawTable = normalizeTable(s.table);
    const table = rawTable ? {
      headers: rawTable.headers.map(stripVendor),
      rows: rawTable.rows.map((r) => r.map(stripVendor)),
    } : null;
    if (!heading && !paragraphs.length && !bullets.length && !table) continue;
    sections.push({ heading: heading || "Details", paragraphs, bullets, table });
  }
  if (!sections.length) {
    sections.push({
      heading: "Summary",
      paragraphs: ["No content could be composed for this period."],
      bullets: [],
      table: null,
    });
  }
  const subtitle = `Period ${from} → ${to}${audience === "internal" && cmpfrom ? ` · compared with ${cmpfrom} → ${cmpto}` : ""}`;
  return { title, subtitle, sections };
}

/* ------------------------------ HTML (safe subset) ------------------------------ */

function escapeXml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

// XML 1.0 forbids most control characters — strip them before they ever reach
// a text run, or the document would be corrupt.
const cleanXmlText = (s) => String(s == null ? "" : s).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/g, "");

/** Escape, then turn **pairs** into <strong>. Tags are only ever ours. */
function inlineHtml(text) {
  return escapeXml(cleanXmlText(text)).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

/** h1/h2/p/ul/li/strong/table only — built by us from structured data. */
function renderReportHtml(report) {
  const parts = [`<h1>${inlineHtml(report.title)}</h1>`];
  if (report.subtitle) parts.push(`<p>${inlineHtml(report.subtitle)}</p>`);
  for (const s of report.sections) {
    if (s.heading) parts.push(`<h2>${inlineHtml(s.heading)}</h2>`);
    for (const p of s.paragraphs || []) parts.push(`<p>${inlineHtml(p)}</p>`);
    if ((s.bullets || []).length) {
      parts.push(`<ul>${s.bullets.map((b) => `<li>${inlineHtml(b)}</li>`).join("")}</ul>`);
    }
    if (s.table && s.table.headers && s.table.headers.length) {
      parts.push(`<table><thead><tr>${s.table.headers.map((h) => `<th>${inlineHtml(h)}</th>`).join("")}</tr></thead><tbody>${
        s.table.rows.map((r) => `<tr>${r.map((cell) => `<td>${inlineHtml(cell)}</td>`).join("")}</tr>`).join("")
      }</tbody></table>`);
    }
  }
  return parts.join("\n");
}

function renderPlainText(report) {
  const lines = [report.title];
  if (report.subtitle) lines.push(report.subtitle);
  for (const s of report.sections) {
    lines.push("", (s.heading || "Details").toUpperCase());
    for (const p of s.paragraphs || []) lines.push(p.replace(/\*\*([^*]+)\*\*/g, "$1"));
    for (const b of s.bullets || []) lines.push(`- ${b.replace(/\*\*([^*]+)\*\*/g, "$1")}`);
    if (s.table && s.table.headers && s.table.headers.length) {
      lines.push(s.table.headers.join(" | "));
      for (const r of s.table.rows) lines.push(r.join(" | "));
    }
  }
  return cleanXmlText(lines.join("\n"));
}

/* ------------------------------ .docx (zero-dependency ZIP/STORE) ------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Minimal ZIP writer: STORE method (no compression), correct CRC32, local
 * headers and central directory. Deterministic timestamps (1980-01-01). */
function zipStore(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const data = f.data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);       // local file header signature
    local.writeUInt16LE(20, 4);               // version needed
    local.writeUInt16LE(0x0800, 6);           // flag: UTF-8 names
    local.writeUInt16LE(0, 8);                // method: STORE
    local.writeUInt16LE(0, 10);               // mod time
    local.writeUInt16LE(0x21, 12);            // mod date: 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);     // compressed size
    local.writeUInt32LE(data.length, 22);     // uncompressed size
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);               // extra length
    chunks.push(local, name, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);          // central directory signature
    cd.writeUInt16LE(20, 4);                  // version made by
    cd.writeUInt16LE(20, 6);                  // version needed
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    // extra/comment/disk/internal attrs stay 0
    cd.writeUInt32LE(0, 38);                  // external attrs
    cd.writeUInt32LE(offset, 42);             // local header offset
    central.push(cd, name);
    offset += 30 + name.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);           // end of central directory
  end.writeUInt16LE(files.length, 8);         // entries on this disk
  end.writeUInt16LE(files.length, 10);        // total entries
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);              // central directory offset
  return Buffer.concat([...chunks, cdBuf, end]);
}

const CONTENT_TYPES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`;

const RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="120"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="40"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="360" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="30"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="280" w:after="100"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="200" w:after="80"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style></w:styles>`;

/** Runs for a paragraph: **bold** pairs become bold runs; everything escaped. */
function wRuns(text) {
  const clean = cleanXmlText(text);
  const segs = [];
  const re = /\*\*([^*]+)\*\*/g;
  let last = 0;
  let m;
  while ((m = re.exec(clean))) {
    if (m.index > last) segs.push({ t: clean.slice(last, m.index) });
    segs.push({ t: m[1], b: true });
    last = m.index + m[0].length;
  }
  if (last < clean.length) segs.push({ t: clean.slice(last) });
  if (!segs.length) segs.push({ t: "" });
  return segs
    .map((s) => `<w:r>${s.b ? "<w:rPr><w:b/></w:rPr>" : ""}<w:t xml:space="preserve">${escapeXml(s.t)}</w:t></w:r>`)
    .join("");
}

function wP(text, style) {
  return `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}${wRuns(text)}</w:p>`;
}

/** A bullet is a plain paragraph with an indent and a • character — no
 * numbering part needed, Word and Google Docs both render it as-is. */
function wBullet(text) {
  return `<w:p><w:pPr><w:ind w:left="360" w:hanging="180"/></w:pPr>${wRuns(`• ${text}`)}</w:p>`;
}

function wTable(table) {
  const t = normalizeTable(table);
  if (!t) return "";
  const cols = Math.max(1, t.headers.length);
  const width = Math.max(1000, Math.floor(9000 / cols));
  const borders = `<w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"]
    .map((k) => `<w:${k} w:val="single" w:sz="4" w:space="0" w:color="auto"/>`).join("")}</w:tblBorders>`;
  const headerCells = t.headers
    .map((h) => `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/></w:tcPr><w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${escapeXml(cleanXmlText(h))}</w:t></w:r></w:p></w:tc>`)
    .join("");
  const bodyRows = t.rows
    .map((r) => `<w:tr>${r.map((cell) => `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/></w:tcPr><w:p>${wRuns(cell)}</w:p></w:tc>`).join("")}</w:tr>`)
    .join("");
  const grid = t.headers.map(() => `<w:gridCol w:w="${width}"/>`).join("");
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>${borders}</w:tblPr><w:tblGrid>${grid}</w:tblGrid><w:tr>${headerCells}</w:tr>${bodyRows}</w:tbl>`;
}

function buildDocumentXml(title, subtitle, sections) {
  const parts = [wP(title, "Title")];
  if (subtitle) parts.push(wP(subtitle));
  for (const s of sections) {
    if (s.heading) parts.push(wP(s.heading, "Heading1"));
    for (const p of s.paragraphs || []) parts.push(wP(p));
    for (const b of s.bullets || []) parts.push(wBullet(b));
    if (s.table && s.table.headers && s.table.headers.length) {
      parts.push(wTable(s.table));
      parts.push("<w:p/>"); // a table must never be the last element
    }
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${parts.join("")}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`;
}

/**
 * Build a minimal, valid .docx (Word + Google Docs open it): a ZIP archive
 * with STORE entries — [Content_Types].xml, _rels/.rels, word/document.xml,
 * word/styles.xml. All text is XML-escaped; headings use the Heading1 style,
 * bullets are •-character paragraphs.
 */
function buildDocx({ title, sections, subtitle } = {}) {
  const safeTitle = String(title || "Report");
  const safeSections = (Array.isArray(sections) ? sections : []).slice(0, 12).map((s) => ({
    heading: s && s.heading ? String(s.heading) : "",
    paragraphs: (Array.isArray(s && s.paragraphs) ? s.paragraphs : []).filter((p) => typeof p === "string"),
    bullets: (Array.isArray(s && s.bullets) ? s.bullets : []).filter((b) => typeof b === "string"),
    table: s && s.table ? s.table : null,
  }));
  const documentXml = buildDocumentXml(safeTitle, subtitle ? String(subtitle) : "", safeSections);
  return zipStore([
    { name: "[Content_Types].xml", data: Buffer.from(CONTENT_TYPES_XML, "utf8") },
    { name: "_rels/.rels", data: Buffer.from(RELS_XML, "utf8") },
    { name: "word/document.xml", data: Buffer.from(documentXml, "utf8") },
    { name: "word/styles.xml", data: Buffer.from(STYLES_XML, "utf8") },
  ]);
}

/* ------------------------------ orchestration ------------------------------ */

/**
 * Compose a report for [from, to]. audience "internal" is the direct,
 * senior-marketer read; "client" is calm, confident and vendor-free. The AI
 * provider (advanced-tier model) writes the prose when configured; otherwise
 * the deterministic fallback builds the report from the same data. Never
 * throws away the report: worst case is a small, honest skeleton.
 * Returns { title, html, plainText, sections } — sections feed buildDocx.
 */
async function writeReport(store, { from, to, audience } = {}) {
  const aud = audience === "client" ? "client" : "internal";
  let context;
  try {
    context = await buildReportContext(store, { from, to });
  } catch (e) {
    console.error("report-writer: context failed:", e && e.message);
    const f = validDayString(String(from || "").slice(0, 10)) ? String(from).slice(0, 10) : todayDay();
    const t = validDayString(String(to || "").slice(0, 10)) ? String(to).slice(0, 10) : todayDay();
    const safe = sanitizeReport({
      title: null,
      sections: [{
        heading: "Summary",
        paragraphs: ["The underlying data could not be loaded for this period. Please try regenerating the report in a moment."],
        bullets: [],
        table: null,
      }],
    }, { audience: aud, from: f, to: t });
    return { title: safe.title, html: renderReportHtml(safe), plainText: renderPlainText(safe), sections: safe.sections };
  }

  const { from: f, to: t, cmpfrom, cmpto } = context.range;
  let clientView = null;
  if (aud === "client") {
    clientView = {
      marketing: clientMarketing(context),
      work: await clientWorkView(store, context.range).catch(() => ({ completed: [], inProgress: [], deliverables: [] })),
    };
  }

  let composed = null;
  try {
    const settings = typeof store.getAiSettings === "function" ? await store.getAiSettings() : {};
    const provider = ai.providerConfig(settings || {});
    if (provider && provider.apiKey) {
      composed = await composeWithModel({
        context, clientView, audience: aud, provider, model: ai.modelForTier(settings || {}, "advanced"),
      });
    }
  } catch { composed = null; }
  if (!composed) {
    composed = aud === "client" ? deterministicClientReport(context, clientView) : deterministicInternalReport(context);
  }
  const safe = sanitizeReport(composed, { audience: aud, from: f, to: t, cmpfrom, cmpto });
  return { title: safe.title, html: renderReportHtml(safe), plainText: renderPlainText(safe), sections: safe.sections };
}

module.exports = {
  buildReportContext,
  writeReport,
  buildDocx,
};
