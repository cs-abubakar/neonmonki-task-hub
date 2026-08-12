/**
 * Shared permission rules — the single source both the HTTP routes and the
 * AI context layer use. If it isn't allowed here, it doesn't happen anywhere.
 */
"use strict";

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
 *   shared   — everyone (client included)
 *   internal — Advertidea team + super admin only
 *   private  — creator (requestedBy) + the person it's private for + super admin
 */
function canSeeTask(user, task) {
  const v = task.visibility || "shared";
  if (v === "shared") return true;
  if (user.role === "super_admin") return true;
  if (v === "internal") return user.role !== "client"; // team only, never client
  // private: creator + the person it's private for (+ super admin, above)
  return task.privateFor === user.username || task.requestedBy === user.name;
}

function visibleTasks(tasks, user) {
  return tasks.filter((t) => canSeeTask(user, t));
}

module.exports = { memberOf, canAccessChannel, accessibleChannels, canSeeTask, visibleTasks };
