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
 * Smart Reporting gate — V1 is the workspace owner only: the super admin
 * account "abubakar". The prepared grant path for future access is a per-user
 * `smartReporting: true` flag on the AI permission record
 * (store.getAiUserPermission) — pass it in as the second argument. Every
 * reporting route and every Monki reporting tool checks through here.
 */
function canUseSmartReporting(user, permission) {
  if (!user || user.active === false) return false;
  if (user.role === "super_admin" && user.username === "abubakar") return true;
  return !!permission && permission.smartReporting === true;
}

module.exports = {
  memberOf,
  canAccessChannel,
  accessibleChannels,
  canSeeTask,
  visibleTasks,
  canSeeLink,
  visibleLinks,
  canUseSmartReporting,
};
