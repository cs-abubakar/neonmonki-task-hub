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

module.exports = { memberOf, canAccessChannel, accessibleChannels };
