/**
 * Smart Reporting aggregation layer — pure functions over the store.
 * No HTTP, no Hyros knowledge: reporting_facts + reporting_daily (+ manual
 * metrics) in → compact aggregates out. Both store drivers feed it.
 *
 * DATA DOCTRINE (hard — migration 009 / reporting_daily v2):
 * - facts are the truth for lead/sale/call counts and for all displayed
 *   revenue (paid + organic). Daily rows never add to revenue/leads/sales.
 * - daily ACCOUNT rows are the truth for spend and for paid revenue → ROAS
 *   (roas = Σ account revenue / Σ account spend, never facts revenue / spend).
 * - daily CAMPAIGN rows are the truth for clicks/impressions and back the
 *   campaign breakdown (spend/clicks/impressions + attribution revenue).
 * - daily CHANNEL rows are rollups OF the facts — never folded into totals
 *   (that would double count); they only advertise channels/platforms to the
 *   filter endpoint.
 * - unknown means null: spend is null when no account rows match, clicks /
 *   impressions null when no campaign row reports them. A null renders as "—"
 *   in the UI; a fabricated 0 would render as real data.
 *
 * METRIC RULES (hard):
 * - additive (spend, revenue, leads, sales, calls, clicks, impressions) → SUM
 * - ratio (roas, ctr, cpc, cpl, cpa, cvr, aov) → derived from totals, never summed
 * - zero/unknown denominator → null (never Infinity/NaN)
 */
"use strict";

const { getStore } = require("./store");

/* ------------------------------ channel classes ------------------------------ */

// "Paid" facts = anything not in an organic/unknown channel. CPL/CPA divide
// account-row spend by THESE fact counts only — organic leads/sales must not
// dilute paid efficiency ratios.
const ORGANIC_CHANNELS = new Set([
  "Organic Search / SEO", "Organic Social", "Email", "Referral", "Direct", "Other", "Unknown", "",
]);
const isPaidChannel = (channel) => !ORGANIC_CHANNELS.has(channel || "");

/* ------------------------------ metric math ------------------------------ */

const div = (a, b) => (a == null || b == null || !b ? null : a / b);

function derive(t) {
  // ratio metrics are derived from totals, never summed; a ratio that needs
  // spend data is null while spend is unknown (null means "not tracked",
  // not "free"). ROAS numerator: account-row paid revenue when account rows
  // exist (sale-date basis, the doctrine's paid-revenue truth) — manual-metric
  // spend has no account rows, so there the displayed revenue is the only
  // truthful numerator (legacy manual behavior).
  const hasSpend = t.spend != null && t.spend > 0;
  return {
    ...t,
    roas: hasSpend ? div(t.hasAccountRows ? t.paidRevenue : t.revenue, t.spend) : null,
    cpl: hasSpend ? div(t.spend, t.paidLeads) : null,
    cpa: hasSpend ? div(t.spend, t.paidSales) : null,
    cpc: hasSpend ? div(t.spend, t.clicks) : null,
    cvr: div(t.sales, t.leads),
    aov: div(t.revenue, t.sales),
    ctr: div(t.clicks, t.impressions),
  };
}

function deltaPct(current, previous) {
  if (!previous && !current) return null;
  if (!previous) return current > 0 ? null : 0; // no baseline → null (UI shows "new")
  return Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10;
}

// spend/clicks/impressions start at null: unknown until a daily row says otherwise.
const EMPTY_TOTALS = () => ({
  spend: null, revenue: 0, leads: 0, sales: 0, calls: 0,
  clicks: null, impressions: null,
  paidRevenue: 0, paidLeads: 0, paidSales: 0,
  hasAccountRows: false, hasCampaignRows: false, hasFacts: false,
  rowLeads: 0, rowSales: 0, // campaign-row counts, used only when no facts name-match
});

/* ------------------------------ filters ------------------------------ */

// Hyros reports in the ACCOUNT timezone (+01:00, Berlin); facts are stored in
// UTC. Range filters and day buckets must therefore compare the account-tz
// calendar day, not the UTC day — otherwise events between 00:00–01:00 local
// (00:00–02:00 during DST) silently land on the wrong side of a range edge
// (the ~4% undercount we hit against Hyros ground truth).
const ACCOUNT_TZ = process.env.HYROS_ACCOUNT_TZ || "Europe/Berlin";
const tzDayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: ACCOUNT_TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const tzHourFmt = new Intl.DateTimeFormat("en-CA", { timeZone: ACCOUNT_TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false });
const tzDayOf = (ts) => tzDayFmt.format(new Date(ts)); // YYYY-MM-DD in account tz

function inRange(ts, from, to) {
  if (!from || !to) return false;
  const day = tzDayOf(ts);
  return day >= from && day <= to;
}

function matchDims(f, { channel, platform, source, campaign }) {
  if (channel && f.channel !== channel) return false;
  if (platform && f.platform !== platform) return false;
  if (source && f.sourceName !== source) return false;
  if (campaign && f.campaign !== campaign) return false;
  return true;
}

// Daily rows have no source grain, and only campaign-scope rows have a
// campaign grain — a filter on either excludes rows that cannot match.
function matchDaily(d, { channel, platform, source, campaign }) {
  if (channel && d.channel !== channel) return false;
  if (platform && d.platform !== platform) return false;
  if (source) return false;
  if (campaign) {
    if ((d.scope || "") !== "campaign") return false;
    if (d.campaignName !== campaign && d.campaignId !== campaign) return false;
  }
  return true;
}

/* ------------------------------ manual metric folding ------------------------------ */

// existing `metrics` table rows → fact-like rows, folded in only when no
// integration data covers that channel+metric in range (prevents double counts)
const MANUAL_METRIC_MAP = [
  [/spend|cost|ausgaben/i, "spend"],
  [/revenue|umsatz/i, "revenue"],
  [/lead/i, "leads"],
  [/sale|order/i, "sales"],
  [/click/i, "clicks"],
  [/impression/i, "impressions"],
  [/call/i, "calls"],
];
const MANUAL_CHANNEL_MAP = {
  "Google Ads": { channel: "Paid Search", platform: "Google Ads" },
  "SEO": { channel: "Organic Search / SEO", platform: "Organic Google" },
  "Email Marketing": { channel: "Email", platform: "Email" },
  "Paid Marketing": { channel: "Paid Search", platform: "Other" },
  "Social Media": { channel: "Paid Social", platform: "Other" },
};

function manualToFacts(metrics) {
  const out = [];
  for (const m of metrics || []) {
    let key = null;
    for (const [re, k] of MANUAL_METRIC_MAP) if (re.test(m.metric)) { key = k; break; }
    if (!key) continue;
    const dim = MANUAL_CHANNEL_MAP[m.channel] || { channel: m.channel || "Other", platform: "Other" };
    out.push({
      sourceSystem: "manual", eventType: "metric", eventAt: m.date,
      channel: dim.channel, platform: dim.platform, sourceName: "manual",
      campaign: "", metricKey: key, value: Number(m.value) || 0,
    });
  }
  return out;
}

/* ------------------------------ core aggregation ------------------------------ */

function foldFact(t, f) {
  t.hasFacts = true;
  const paid = isPaidChannel(f.channel);
  if (f.eventType === "lead") { t.leads += 1; if (paid) t.paidLeads += 1; }
  else if (f.eventType === "sale") { t.sales += 1; t.revenue += f.value || 0; if (paid) t.paidSales += 1; }
  else if (f.eventType === "refund") { t.revenue += f.value || 0; } // value negative
  else if (f.eventType === "call") t.calls += 1;
}

// Overview/trend/channel/platform fold: account rows own spend + paid revenue,
// campaign rows own clicks/impressions, channel rows restate facts (skipped).
function foldDaily(t, d) {
  const scope = d.scope || "channel";
  if (scope === "account") {
    t.hasAccountRows = true;
    t.spend = (t.spend == null ? 0 : t.spend) + (Number(d.spend) || 0);
    t.paidRevenue += Number(d.revenue) || 0;
  } else if (scope === "campaign") {
    t.hasCampaignRows = true;
    if (d.clicks != null) t.clicks = (t.clicks == null ? 0 : t.clicks) + Number(d.clicks);
    if (d.impressions != null) t.impressions = (t.impressions == null ? 0 : t.impressions) + Number(d.impressions);
  }
}

// Campaign-dimension fold: here the campaign row IS the group, so it also owns
// spend and attribution revenue (the campaign table's paid-revenue/ROAS truth).
function foldCampaignRow(t, d) {
  t.hasCampaignRows = true;
  t.spend = (t.spend == null ? 0 : t.spend) + (Number(d.spend) || 0);
  if (d.clicks != null) t.clicks = (t.clicks == null ? 0 : t.clicks) + Number(d.clicks);
  if (d.impressions != null) t.impressions = (t.impressions == null ? 0 : t.impressions) + Number(d.impressions);
  t.paidRevenue += Number(d.revenue) || 0;
  t.rowLeads += Number(d.leads) || 0;
  t.rowSales += Number(d.sales) || 0;
}

function totalsFor(facts, daily, opts) {
  const t = EMPTY_TOTALS();
  const covered = { channelMetric: new Set() };
  for (const f of facts) {
    if (!matchDims(f, opts)) continue;
    if (!inRange(f.eventAt, opts.from, opts.to)) continue;
    foldFact(t, f);
    covered.channelMetric.add(`${f.channel}|${f.platform}`);
  }
  for (const d of daily || []) {
    if (!matchDaily(d, opts)) continue;
    if (!inRange(d.day, opts.from, opts.to)) continue;
    foldDaily(t, d);
    if (d.channel || d.platform) covered.channelMetric.add(`${d.channel}|${d.platform}`);
  }
  return { totals: t, covered };
}

// Manual metrics fill ONLY channel+platform pairs the integration doesn't cover.
function withManual(totals, coveredByIntegration, manualFacts, opts) {
  const t = { ...totals };
  for (const m of manualFacts) {
    if (!matchDims(m, opts)) continue;
    if (!inRange(m.eventAt, opts.from, opts.to)) continue;
    if (coveredByIntegration.has(`${m.channel}|${m.platform}`)) continue;
    t[m.metricKey] = (t[m.metricKey] == null ? 0 : t[m.metricKey]) + m.value;
    if (isPaidChannel(m.channel)) {
      if (m.metricKey === "leads") t.paidLeads += m.value;
      else if (m.metricKey === "sales") t.paidSales += m.value;
    }
  }
  return t;
}

// Channel+platform pairs covered by integration data (facts or daily rows),
// regardless of range — a covered channel stays covered in every view.
function coverageSet(facts, daily, opts) {
  const covered = new Set();
  for (const f of facts) if (matchDims(f, opts)) covered.add(`${f.channel}|${f.platform}`);
  for (const d of daily || []) {
    if (matchDaily(d, opts) && (d.channel || d.platform)) covered.add(`${d.channel}|${d.platform}`);
  }
  return covered;
}

/* ------------------------------ inputs ------------------------------ */

// reporting_daily v2 rows are loaded once with a wide range and filtered in
// memory — every endpoint below needs different from/to + comparison windows.
const WIDE_RANGE = { from: "1970-01-01", to: "2999-12-31" };

async function loadInputs() {
  const store = getStore();
  const dailyQuery = typeof store.reportingDailyQuery === "function"
    ? store.reportingDailyQuery.bind(store)
    : (typeof store.reportingDailyList === "function" ? store.reportingDailyList.bind(store) : null);
  const [facts, daily, metrics] = await Promise.all([
    store.reportingFactsList ? store.reportingFactsList() : Promise.resolve([]),
    dailyQuery ? dailyQuery(WIDE_RANGE).catch(() => []) : Promise.resolve([]),
    store.metricsList(null, null),
  ]);
  return { facts, daily: Array.isArray(daily) ? daily : [], manualFacts: manualToFacts(metrics) };
}

/* ------------------------------ public API ------------------------------ */

async function reportingOverview(opts) {
  const { facts, daily, manualFacts } = await loadInputs();
  const cur = totalsFor(facts, daily, opts);
  const prev = totalsFor(facts, daily, { ...opts, from: opts.cmpfrom, to: opts.cmpto });
  const curTotals = withManual(cur.totals, cur.covered.channelMetric, manualFacts, opts);
  const prevTotals = withManual(prev.totals, prev.covered.channelMetric, manualFacts, { ...opts, from: opts.cmpfrom, to: opts.cmpto });
  const current = derive(curTotals);
  const previous = derive(prevTotals);
  const deltas = {};
  for (const k of ["spend", "revenue", "leads", "sales", "calls", "clicks", "impressions", "roas", "cpl", "cpa", "cvr", "aov", "ctr", "cpc"]) {
    deltas[k] = current[k] == null || previous[k] == null ? null : deltaPct(current[k], previous[k]);
  }
  return { current, previous, deltas };
}

function bucketOf(ts, granularity) {
  if (granularity === "hour") return tzHourFmt.format(new Date(ts)).replace(", ", "T") + ":00";
  const day = tzDayOf(ts);
  if (granularity === "month") return day.slice(0, 7);
  if (granularity === "week") {
    const d = new Date(day + "T12:00:00Z"); // noon UTC avoids DST edge math
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // monday
    return d.toISOString().slice(0, 10);
  }
  return day;
}

function buildTrend({ facts, daily, manualFacts }, opts) {
  const granularity = opts.granularity || "day";
  const buckets = new Map();
  const bump = (key, fn) => {
    if (!buckets.has(key)) buckets.set(key, EMPTY_TOTALS());
    fn(buckets.get(key));
  };
  for (const f of facts) {
    if (!matchDims(f, opts) || !inRange(f.eventAt, opts.from, opts.to)) continue;
    bump(bucketOf(f.eventAt, granularity), (t) => foldFact(t, f));
  }
  for (const d of daily || []) {
    if (!matchDaily(d, opts) || !inRange(d.day, opts.from, opts.to)) continue;
    bump(bucketOf(d.day, granularity), (t) => foldDaily(t, d));
  }
  // manual metrics fold (same precedence rule: only uncovered channels)
  const covered = coverageSet(facts, daily, opts);
  for (const m of manualFacts) {
    if (!matchDims(m, opts) || !inRange(m.eventAt, opts.from, opts.to)) continue;
    if (covered.has(`${m.channel}|${m.platform}`)) continue;
    bump(bucketOf(m.eventAt, granularity), (t) => {
      t[m.metricKey] = (t[m.metricKey] == null ? 0 : t[m.metricKey]) + m.value;
      if (isPaidChannel(m.channel)) {
        if (m.metricKey === "leads") t.paidLeads += m.value;
        else if (m.metricKey === "sales") t.paidSales += m.value;
      }
    });
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([bucket, t]) => ({ bucket, ...derive(t) }));
}

async function reportingTrend(opts) {
  const inputs = await loadInputs();
  return buildTrend(inputs, opts);
}

const DIMENSION_OPTS_KEY = { channel: "channel", platform: "platform", source: "source", campaign: "campaign" };

function buildBreakdown({ facts, daily, manualFacts }, opts) {
  const dimension = ["channel", "platform", "source", "campaign"].includes(opts.dimension) ? opts.dimension : "channel";
  // breaking down by dimension X must not self-apply the X filter — the chart
  // keeps the full list so the selected row has context (long-standing behavior)
  const fopts = { ...opts, [DIMENSION_OPTS_KEY[dimension]]: undefined };
  const groups = new Map(); // name → {cur, prev}
  const group = (name) => {
    if (!groups.has(name)) groups.set(name, { cur: EMPTY_TOTALS(), prev: EMPTY_TOTALS() });
    return groups.get(name);
  };
  const inCur = (ts) => inRange(ts, opts.from, opts.to);
  const inPrev = (ts) => inRange(ts, opts.cmpfrom, opts.cmpto);

  if (dimension === "campaign") {
    // Campaign groups come from campaign-scope daily rows (spend/clicks/
    // impressions/attribution revenue); facts merge BY NAME and own the
    // lead/sale counts. Where only facts exist (organic/untracked campaigns)
    // the group shows facts revenue with spend null; where only rows exist,
    // the row's attribution revenue/sales/leads stand in.
    for (const d of daily || []) {
      if ((d.scope || "") !== "campaign" || !matchDaily(d, fopts)) continue;
      const name = d.campaignName || d.campaignId || "Unknown";
      if (inCur(d.day)) foldCampaignRow(group(name).cur, d);
      if (inPrev(d.day)) foldCampaignRow(group(name).prev, d);
    }
    for (const f of facts) {
      if (!matchDims(f, fopts)) continue;
      const name = f.campaign || "Unknown";
      if (inCur(f.eventAt)) foldFact(group(name).cur, f);
      if (inPrev(f.eventAt)) foldFact(group(name).prev, f);
    }
    for (const g of groups.values()) {
      for (const t of [g.cur, g.prev]) {
        if (t.hasCampaignRows) {
          // rows + facts name-match: row revenue would double count the same
          // underlying sales, so the row's paid attribution revenue wins for
          // the revenue column; facts keep the lead/sale counts (their truth).
          t.revenue = t.paidRevenue;
          if (!t.hasFacts) {
            t.leads = t.rowLeads; t.sales = t.rowSales;
            t.paidLeads = t.rowLeads; t.paidSales = t.rowSales; // CPL/CPA derive
          }
        }
      }
    }
  } else {
    const dimField = { channel: "channel", platform: "platform", source: "sourceName" }[dimension];
    for (const f of facts) {
      if (!matchDims(f, fopts)) continue;
      const name = f[dimField] || "Unknown";
      if (inCur(f.eventAt)) foldFact(group(name).cur, f);
      if (inPrev(f.eventAt)) foldFact(group(name).prev, f);
    }
    if (dimension !== "source") {
      // account rows (spend/paid revenue) + campaign rows (clicks/impressions)
      // carry channel+platform, so they group natively by those dimensions.
      for (const d of daily || []) {
        if (!matchDaily(d, fopts)) continue;
        const name = d[dimField] || "Unknown";
        if (inCur(d.day)) foldDaily(group(name).cur, d);
        if (inPrev(d.day)) foldDaily(group(name).prev, d);
      }
    }
    // source dimension: account spend is platform-grained and cannot be split
    // across sources without fabricating numbers → spend/clicks stay null.
    // manual fold (precedence: skip channels/platforms covered by integration);
    // manual metrics are channel-grained, so the campaign dimension skips them.
    const covered = coverageSet(facts, daily, fopts);
    for (const m of manualFacts) {
      if (!matchDims(m, fopts)) continue;
      if (covered.has(`${m.channel}|${m.platform}`)) continue;
      const name = m[dimField] || "Unknown";
      if (inCur(m.eventAt)) {
        const t = group(name).cur;
        t[m.metricKey] = (t[m.metricKey] == null ? 0 : t[m.metricKey]) + m.value;
        if (isPaidChannel(m.channel)) {
          if (m.metricKey === "leads") t.paidLeads += m.value;
          else if (m.metricKey === "sales") t.paidSales += m.value;
        }
      }
      if (inPrev(m.eventAt)) {
        const t = group(name).prev;
        t[m.metricKey] = (t[m.metricKey] == null ? 0 : t[m.metricKey]) + m.value;
        if (isPaidChannel(m.channel)) {
          if (m.metricKey === "leads") t.paidLeads += m.value;
          else if (m.metricKey === "sales") t.paidSales += m.value;
        }
      }
    }
  }

  const names = [...groups.keys()];
  return names.sort().map((name) => {
    const cur = derive(groups.get(name).cur);
    const prev = derive(groups.get(name).prev);
    return {
      name, ...cur,
      deltaPct: {
        revenue: deltaPct(cur.revenue, prev.revenue),
        spend: deltaPct(cur.spend, prev.spend),
        leads: deltaPct(cur.leads, prev.leads),
        sales: deltaPct(cur.sales, prev.sales),
        roas: cur.roas == null || prev.roas == null ? null : deltaPct(cur.roas, prev.roas),
        cpl: cur.cpl == null || prev.cpl == null ? null : deltaPct(cur.cpl, prev.cpl),
      },
    };
  });
}

async function reportingBreakdown(opts) {
  const inputs = await loadInputs();
  return buildBreakdown(inputs, opts);
}

async function reportingFilterValues() {
  const { facts, daily, manualFacts } = await loadInputs();
  const uniq = (arr) => [...new Set(arr.filter(Boolean))].sort();
  const campaignRows = (daily || []).filter((d) => (d.scope || "") === "campaign");
  return {
    channels: uniq([...facts.map((f) => f.channel), ...(daily || []).map((d) => d.channel), ...manualFacts.map((f) => f.channel)]),
    platforms: uniq([...facts.map((f) => f.platform), ...(daily || []).map((d) => d.platform), ...manualFacts.map((f) => f.platform)]),
    sources: uniq([...facts.map((f) => f.sourceName), ...manualFacts.map((f) => f.sourceName)]),
    campaigns: uniq([...facts.map((f) => f.campaign), ...campaignRows.map((d) => d.campaignName), ...manualFacts.map((f) => f.campaign)]),
  };
}

async function reportingActivity(opts) {
  const { facts } = await loadInputs();
  return facts
    .filter((f) => matchDims(f, opts) && inRange(f.eventAt, opts.from || "1970-01-01", opts.to || "2999-01-01"))
    .filter((f) => ["sale", "lead", "call", "refund"].includes(f.eventType))
    .sort((a, b) => Date.parse(b.eventAt) - Date.parse(a.eventAt))
    .slice(0, Math.min(100, opts.limit || 20))
    .map((f) => ({
      eventAt: f.eventAt, type: f.eventType, channel: f.channel, platform: f.platform,
      source: f.sourceName, value: f.value, currency: f.currency || "EUR",
    }));
}

/* ------------------------------ basic (client-safe) read layer ------------------------------ */

// reportingBasic powers the client/team "Performance" page: the same numbers
// the owner sees, curated so nothing internal leaks — friendly channel names
// only, no data-quality labels, no diagnostics, and calm deterministic
// highlights. It must never name the upstream data provider or its mechanics.

const BASIC_RANGE_DAYS = 30; // default window: last 30 days

const utcDay = (d) => d.toISOString().slice(0, 10);
function shiftUtcDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return utcDay(d);
}
const spanDays = (from, to) =>
  Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000);

const round2 = (n) => (n == null ? null : Math.round(n * 100) / 100);
const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);

// The one bucket we never show as-is: "Unknown" reads like a data problem,
// "Direct / Other" is what it actually is.
const friendlyChannelName = (name) => (!name || name === "Unknown" ? "Direct / Other" : name);

// Calm, deterministic highlight lines (≤3). Down moves are stated plainly —
// "slightly below" / "softer than", never alarm wording. Only aggregates and
// channel names appear here; no PII, no internals.
function basicHighlights(deltas, chanSorted) {
  const out = [];
  if (deltas.revenue != null) {
    if (deltas.revenue > 1) {
      out.push({ tone: "up", text: `Revenue is up ${deltas.revenue}% vs the previous period.` });
    } else if (deltas.revenue < -1) {
      const pct = Math.abs(deltas.revenue);
      out.push({
        tone: "down",
        text: pct <= 10
          ? `Revenue is slightly below the previous period (down ${pct}%).`
          : `Revenue came in softer than the previous period (down ${pct}%).`,
      });
    } else {
      out.push({ tone: "flat", text: "Revenue is steady vs the previous period." });
    }
  }
  const topLeadChannel = chanSorted
    .filter((c) => c.leads > 0)
    .sort((a, b) => b.leads - a.leads || a.name.localeCompare(b.name))[0];
  if (topLeadChannel) {
    out.push({
      tone: "flat",
      text: `${topLeadChannel.name} brought in ${topLeadChannel.leads} ${topLeadChannel.leads === 1 ? "lead" : "leads"}.`,
    });
  }
  // chanSorted is revenue-ordered, so [0]/[1] are the strongest channels;
  // skip whatever the leads line already named to avoid repeating ourselves.
  const revenueChannels = chanSorted.filter((c) => c.revenue > 0);
  if (revenueChannels.length >= 2) {
    const named = topLeadChannel ? topLeadChannel.name : null;
    if (revenueChannels[1].name !== named) {
      out.push({ tone: "flat", text: `${revenueChannels[1].name} is your second-strongest channel.` });
    } else {
      out.push({ tone: "flat", text: `${revenueChannels[0].name} is your strongest channel for revenue right now.` });
    }
  }
  if (!out.length) {
    out.push({ tone: "flat", text: "There is not much to report for this period yet." });
  }
  return out.slice(0, 3);
}

async function reportingBasic(opts = {}) {
  const to = opts.to || utcDay(new Date());
  const from = opts.from || shiftUtcDays(to, -(BASIC_RANGE_DAYS - 1));
  // previous window: same length, ending the day before `from` — the same
  // convention the full reporting endpoints use for their default comparison.
  const cmpto = shiftUtcDays(from, -1);
  const cmp = { from: shiftUtcDays(cmpto, -spanDays(from, to)), to: cmpto };

  const inputs = await loadInputs();
  const { facts, daily, manualFacts } = inputs;

  const cur = totalsFor(facts, daily, { from, to });
  const prev = totalsFor(facts, daily, cmp);
  const current = derive(withManual(cur.totals, cur.covered.channelMetric, manualFacts, { from, to }));
  const previous = derive(withManual(prev.totals, prev.covered.channelMetric, manualFacts, cmp));
  const deltas = {};
  for (const k of ["revenue", "leads", "sales", "spend", "roas"]) {
    deltas[k] = current[k] == null || previous[k] == null ? null : deltaPct(current[k], previous[k]);
  }

  const trend = buildTrend(inputs, { from, to, granularity: "day" })
    .map((b) => ({ bucket: b.bucket, revenue: round2(b.revenue), leads: b.leads, sales: b.sales, spend: round2(b.spend) }));

  // Channels: qualifying = revenue or leads above zero. Shares are computed
  // over ALL qualifying channels before the top-6 cap, so they stay honest.
  const chanSorted = buildBreakdown(inputs, { from, to, dimension: "channel" })
    .map((r) => ({ name: friendlyChannelName(r.name), revenue: round2(r.revenue), leads: r.leads, sales: r.sales }))
    .filter((r) => r.revenue > 0 || r.leads > 0)
    .sort((a, b) => b.revenue - a.revenue || b.leads - a.leads || a.name.localeCompare(b.name));
  const revenueBase = chanSorted.reduce((s, r) => s + Math.max(0, r.revenue), 0);
  const channels = chanSorted.slice(0, 6).map((r) => ({
    name: r.name, revenue: r.revenue, leads: r.leads, sales: r.sales,
    sharePct: revenueBase > 0 ? round1((Math.max(0, r.revenue) / revenueBase) * 100) : null,
  }));

  const campaigns = buildBreakdown(inputs, { from, to, dimension: "campaign" })
    .map((r) => ({ name: !r.name || r.name === "Unknown" ? "Other campaigns" : r.name, revenue: round2(r.revenue), sales: r.sales }))
    .filter((r) => r.revenue > 0)
    .sort((a, b) => b.revenue - a.revenue || b.sales - a.sales || a.name.localeCompare(b.name))
    .slice(0, 5);

  return {
    range: { from, to },
    current: {
      revenue: round2(current.revenue), leads: current.leads, sales: current.sales,
      spend: round2(current.spend), roas: round2(current.roas), aov: round2(current.aov),
      deltas,
    },
    trend,
    channels,
    campaigns,
    highlights: basicHighlights(deltas, chanSorted),
  };
}

module.exports = {
  derive, deltaPct, reportingOverview, reportingTrend, reportingBreakdown,
  reportingFilterValues, reportingActivity, reportingBasic, manualToFacts,
};
