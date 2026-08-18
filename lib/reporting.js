/**
 * Smart Reporting aggregation layer — pure functions over the store.
 * No HTTP, no Hyros knowledge: reporting_facts (+ reporting_daily + manual
 * metrics) in → compact aggregates out. Both store drivers feed it.
 *
 * METRIC RULES (hard):
 * - additive (spend, revenue, leads, sales, calls, clicks, impressions) → SUM
 * - ratio (roas, ctr, cpc, cpl, cpa, cvr, aov) → derived from totals, never summed
 * - zero denominator → null (never Infinity/NaN)
 */
"use strict";

const { getStore } = require("./store");

/* ------------------------------ metric math ------------------------------ */

function derive(t) {
  // ratio metrics are derived from totals, never summed; a ratio that needs
  // spend data is null while spend is unknown (0 means "not tracked", not "free")
  const div = (a, b) => (b ? a / b : null);
  const hasSpend = t.spend > 0;
  return {
    ...t,
    roas: hasSpend ? div(t.revenue, t.spend) : null,
    cpl: hasSpend ? div(t.spend, t.leads) : null,
    cpa: hasSpend ? div(t.spend, t.sales) : null,
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

const EMPTY_TOTALS = () => ({ spend: 0, revenue: 0, leads: 0, sales: 0, calls: 0, clicks: 0, impressions: 0 });

/* ------------------------------ filters ------------------------------ */

function inRange(ts, from, to) {
  const t = Date.parse(ts);
  return t >= Date.parse(from) && t <= Date.parse(to) + 86399999;
}

function matchDims(f, { channel, platform, source, campaign }) {
  if (channel && f.channel !== channel) return false;
  if (platform && f.platform !== platform) return false;
  if (source && f.sourceName !== source) return false;
  if (campaign && f.campaign !== campaign) return false;
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

function totalsFor(facts, daily, opts) {
  const t = EMPTY_TOTALS();
  const covered = { channelMetric: new Set() };
  for (const f of facts) {
    if (!matchDims(f, opts)) continue;
    if (!inRange(f.eventAt, opts.from, opts.to)) continue;
    if (f.eventType === "lead") t.leads += 1;
    else if (f.eventType === "sale") { t.sales += 1; t.revenue += f.value || 0; }
    else if (f.eventType === "refund") { t.revenue += f.value || 0; } // value negative
    else if (f.eventType === "call") t.calls += 1;
    covered.channelMetric.add(`${f.channel}|${f.platform}`);
  }
  for (const d of daily || []) {
    if (!matchDims(d, opts)) continue;
    if (!inRange(d.day, opts.from, opts.to)) continue;
    t.spend += Number(d.spend) || 0;
    t.clicks += Number(d.clicks) || 0;
    t.impressions += Number(d.impressions) || 0;
    t.leads += Number(d.leads) || 0;
    t.sales += Number(d.sales) || 0;
    t.revenue += Number(d.revenue) || 0;
    covered.channelMetric.add(`${d.channel}|${d.platform}`);
  }
  return { totals: t, covered };
}

async function loadInputs() {
  const store = getStore();
  const [facts, daily, metrics] = await Promise.all([
    store.reportingFactsList ? store.reportingFactsList() : Promise.resolve([]),
    store.reportingDailyList ? store.reportingDailyList() : Promise.resolve([]),
    store.metricsList(null, null),
  ]);
  return { facts, daily, manualFacts: manualToFacts(metrics) };
}

function withManual(totals, coveredByIntegration, manualFacts, opts) {
  // manual facts fill ONLY channel+metric pairs the integration doesn't cover
  const t = { ...totals };
  for (const m of manualFacts) {
    if (!matchDims(m, opts)) continue;
    if (!inRange(m.eventAt, opts.from, opts.to)) continue;
    if (coveredByIntegration.has(`${m.channel}|${m.platform}`)) continue;
    t[m.metricKey] = (t[m.metricKey] || 0) + m.value;
  }
  return t;
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
  const d = new Date(ts);
  if (granularity === "hour") return d.toISOString().slice(0, 13) + ":00";
  if (granularity === "month") return d.toISOString().slice(0, 7);
  if (granularity === "week") {
    const day = new Date(d); day.setUTCDate(day.getUTCDate() - day.getUTCDay() + 1); // monday
    return day.toISOString().slice(0, 10);
  }
  return d.toISOString().slice(0, 10); // day
}

async function reportingTrend(opts) {
  const { facts, daily, manualFacts } = await loadInputs();
  const granularity = opts.granularity || "day";
  const buckets = new Map();
  const bump = (key, fn) => {
    if (!buckets.has(key)) buckets.set(key, EMPTY_TOTALS());
    fn(buckets.get(key));
  };
  for (const f of facts) {
    if (!matchDims(f, opts) || !inRange(f.eventAt, opts.from, opts.to)) continue;
    const b = bucketOf(f.eventAt, granularity);
    if (f.eventType === "lead") bump(b, (t) => { t.leads += 1; });
    else if (f.eventType === "sale") bump(b, (t) => { t.sales += 1; t.revenue += f.value || 0; });
    else if (f.eventType === "refund") bump(b, (t) => { t.revenue += f.value || 0; });
    else if (f.eventType === "call") bump(b, (t) => { t.calls += 1; });
  }
  for (const d of daily || []) {
    if (!matchDims(d, opts) || !inRange(d.day, opts.from, opts.to)) continue;
    const b = bucketOf(d.day, granularity);
    bump(b, (t) => {
      t.spend += Number(d.spend) || 0; t.clicks += Number(d.clicks) || 0;
      t.impressions += Number(d.impressions) || 0; t.leads += Number(d.leads) || 0;
      t.sales += Number(d.sales) || 0; t.revenue += Number(d.revenue) || 0;
    });
  }
  // manual metrics fold (same precedence rule)
  const covered = new Set(facts.filter((f) => matchDims(f, opts)).map((f) => `${f.channel}|${f.platform}`));
  for (const m of manualFacts) {
    if (!matchDims(m, opts) || !inRange(m.eventAt, opts.from, opts.to)) continue;
    if (covered.has(`${m.channel}|${m.platform}`)) continue;
    bump(bucketOf(m.eventAt, granularity), (t) => { t[m.metricKey] = (t[m.metricKey] || 0) + m.value; });
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([bucket, t]) => ({ bucket, ...derive(t) }));
}

async function reportingBreakdown(opts) {
  const dimField = { channel: "channel", platform: "platform", source: "sourceName", campaign: "campaign" }[opts.dimension] || "channel";
  const { facts, daily, manualFacts } = await loadInputs();
  const groups = new Map();
  const addTo = (name, range, fn) => {
    const key = `${name}::${range}`;
    if (!groups.has(key)) groups.set(key, EMPTY_TOTALS());
    fn(groups.get(key));
  };
  for (const f of facts) {
    if (!matchDims(f, { ...opts, [ { channel: "channel", platform: "platform", source: "source", campaign: "campaign" }[opts.dimension] ]: undefined })) continue;
    const name = f[dimField] || "Unknown";
    if (inRange(f.eventAt, opts.from, opts.to)) {
      if (f.eventType === "lead") addTo(name, "cur", (t) => { t.leads += 1; });
      else if (f.eventType === "sale") addTo(name, "cur", (t) => { t.sales += 1; t.revenue += f.value || 0; });
      else if (f.eventType === "refund") addTo(name, "cur", (t) => { t.revenue += f.value || 0; });
      else if (f.eventType === "call") addTo(name, "cur", (t) => { t.calls += 1; });
    }
    if (inRange(f.eventAt, opts.cmpfrom, opts.cmpto)) {
      if (f.eventType === "lead") addTo(name, "prev", (t) => { t.leads += 1; });
      else if (f.eventType === "sale") addTo(name, "prev", (t) => { t.sales += 1; t.revenue += f.value || 0; });
      else if (f.eventType === "refund") addTo(name, "prev", (t) => { t.revenue += f.value || 0; });
      else if (f.eventType === "call") addTo(name, "prev", (t) => { t.calls += 1; });
    }
  }
  for (const d of daily || []) {
    if (!matchDims(d, opts)) continue;
    const name = d[dimField] || "Unknown";
    if (inRange(d.day, opts.from, opts.to)) {
      addTo(name, "cur", (t) => { t.spend += Number(d.spend) || 0; t.clicks += Number(d.clicks) || 0; t.impressions += Number(d.impressions) || 0; t.leads += Number(d.leads) || 0; t.sales += Number(d.sales) || 0; t.revenue += Number(d.revenue) || 0; });
    }
    if (inRange(d.day, opts.cmpfrom, opts.cmpto)) {
      addTo(name, "prev", (t) => { t.spend += Number(d.spend) || 0; t.clicks += Number(d.clicks) || 0; t.impressions += Number(d.impressions) || 0; t.leads += Number(d.leads) || 0; t.sales += Number(d.sales) || 0; t.revenue += Number(d.revenue) || 0; });
    }
  }
  // manual fold (precedence: skip channels/platforms covered by integration)
  const covered = new Set(facts.map((f) => `${f.channel}|${f.platform}`));
  for (const m of manualFacts) {
    if (!matchDims(m, opts)) continue;
    if (covered.has(`${m.channel}|${m.platform}`)) continue;
    const name = m[dimField] || "Unknown";
    if (inRange(m.eventAt, opts.from, opts.to)) addTo(name, "cur", (t) => { t[m.metricKey] = (t[m.metricKey] || 0) + m.value; });
    if (inRange(m.eventAt, opts.cmpfrom, opts.cmpto)) addTo(name, "prev", (t) => { t[m.metricKey] = (t[m.metricKey] || 0) + m.value; });
  }
  const names = [...new Set([...groups.keys()].map((k) => k.split("::")[0]))];
  return names.sort().map((name) => {
    const cur = derive(groups.get(`${name}::cur`) || EMPTY_TOTALS());
    const prev = derive(groups.get(`${name}::prev`) || EMPTY_TOTALS());
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

async function reportingFilterValues() {
  const { facts, daily, manualFacts } = await loadInputs();
  const all = [...facts, ...(daily || []).map((d) => ({ channel: d.channel, platform: d.platform })), ...manualFacts];
  const uniq = (arr) => [...new Set(arr.filter(Boolean))].sort();
  return {
    channels: uniq(all.map((f) => f.channel)),
    platforms: uniq(all.map((f) => f.platform)),
    sources: uniq(all.map((f) => f.sourceName)),
    campaigns: uniq(all.map((f) => f.campaign)),
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

module.exports = {
  derive, deltaPct, reportingOverview, reportingTrend, reportingBreakdown,
  reportingFilterValues, reportingActivity, manualToFacts,
};
