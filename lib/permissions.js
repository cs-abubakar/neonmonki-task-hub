/**
 * Shared permission rules — the single source both the HTTP routes and the
 * AI context layer use. If it isn't allowed here, it doesn't happen anywhere.
 */
"use strict";

const { decodeDepartmentIds } = require("./task-system");

function memberOf(channel, username) {
  return (channel.members || []).find((m) => m.username === username) || null;
}

/** Can this user see/post in this channel? */
function canAccessChannel(channel, user) {
  if (user.role === "super_admin") return true;
  if (user.role === "client" && !channel.clientAllowed) return false;
  if (channel.autoAll) return true;
  return !!memberOf(channel, user.username);
}

/** Channels visible to this user. */
function accessibleChannels(channels, user) {
  return channels.filter((c) => canAccessChannel(c, user));
}

/**
 * Task visibility — the second hard boundary.
 *   shared     — client workspace + team
 *   team       — all internal team users
 *   department — assigned department members, named owners and creator
 *   private    — creator and named owners only
 *
 * `internal` remains a supported alias for older tasks and means `team`.
 */
function canSeeTask(user, task) {
  const v = task.visibility || "shared";
  if (v === "shared") return true;
  if (user.role === "super_admin") return true;
  const creator = task.createdByUsername === user.username || task.requestedBy === user.name;
  const owner = (task.ownerUsernames || []).includes(user.username);
  if (v === "internal") return user.role !== "client";
  if (v === "team") return user.role !== "client" || creator;
  if (v === "department") {
    if (creator || owner) return true;
    if (user.role === "client") return false;
    const userDepartments = new Set(decodeDepartmentIds(user.departments || []));
    return decodeDepartmentIds(task.departmentIds || task.assignedDept, task.department)
      .some((id) => userDepartments.has(id));
  }
  // private: creator + named owner + legacy privateFor (+ super admin, above)
  return creator || owner || task.privateFor === user.username;
}

function visibleTasks(tasks, user) {
  return tasks.filter((t) => canSeeTask(user, t));
}

/**
 * File/link visibility follows every scope the link declares.
 *
 * - task-linked files inherit the task's shared/internal/private boundary
 * - channel-linked files inherit channel membership/client access
 * - unscoped files are shared workspace records
 * - broken task/channel references fail closed for everyone except super admin
 */
function canSeeLink(user, link, { tasks = [], channels = [] } = {}) {
  if (user.role === "super_admin") return true;

  if (link.taskId) {
    const task = tasks.find((t) => t.id === link.taskId);
    if (!task || !canSeeTask(user, task)) return false;
  }

  if (link.channelId) {
    const channel = channels.find((c) => c.id === link.channelId);
    if (!channel || !canAccessChannel(channel, user)) return false;
  }

  return true;
}

function visibleLinks(links, user, context) {
  return links.filter((l) => canSeeLink(user, l, context));
}

/**
 * Reporting access tier — "none" | "basic" | "advanced" | "super".
 *   basic    — the calm, client-safe Performance page (/api/reporting/basic)
 *   advanced — the Smart Reporting dashboard and every /api/reporting/*
 *              endpoint (this is what the legacy "full" tier meant)
 *   super    — advanced plus the AI report generator (/api/reporting/report)
 *   none     — no reporting at all
 * An explicit per-user `reporting` value on the AI permission record
 * (store.getAiUserPermission) wins over the role default; "" means "inherit".
 * A legacy stored "full" reads as "advanced".
 */
const REPORTING_TIERS = ["none", "basic", "advanced", "super"];

function reportingAccess(user, permission) {
  if (!user || user.active === false) return "none";
  const explicit = permission && permission.reporting;
  const tier = explicit === "full" ? "advanced" : explicit; // legacy tier name
  if (REPORTING_TIERS.includes(tier)) return tier;
  if (user.role === "super_admin") return "super";
  if (user.role === "client" || user.role === "team") return "basic";
  return "none";
}

/**
 * Smart Reporting gate — passes on the "advanced" and "super" tiers. The
 * owner rule is unchanged: the super admin account "abubakar" always has
 * access. Beyond that, access comes from the AI permission record
 * (store.getAiUserPermission): `reporting: "advanced" | "super"` grants it,
 * and the legacy `smartReporting: true` flag still grants it for backward
 * compat.
 */
function canUseSmartReporting(user, permission) {
  if (!user || user.active === false) return false;
  if (user.role === "super_admin" && user.username === "abubakar") return true;
  const tier = reportingAccess(user, permission);
  if (tier === "advanced" || tier === "super") return true;
  return !!permission && permission.smartReporting === true;
}

/**
 * Report generator gate — the "super" tier only
 * (POST /api/reporting/report). Nothing is hard-locked to the owner: any
 * account granted `reporting: "super"` in AI Control can generate reports.
 */
function canGenerateReports(user, permission) {
  return reportingAccess(user, permission) === "super";
}

module.exports = {
  memberOf,
  canAccessChannel,
  accessibleChannels,
  canSeeTask,
  visibleTasks,
  canSeeLink,
  visibleLinks,
  reportingAccess,
  canUseSmartReporting,
  canGenerateReports,
};
