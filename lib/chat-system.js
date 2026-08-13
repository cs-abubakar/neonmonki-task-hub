/**
 * Rich chat metadata stored inside the existing message text column.
 *
 * Production can gain replies and reactions without a database migration. Old
 * plain-text messages remain readable, while new messages use a small envelope
 * that both storage drivers can update atomically at the row level.
 */
"use strict";

const CHAT_META_PREFIX = "@@NM_CHAT_EVENT@@";

function normalizeReactions(value) {
  const output = {};
  if (!value || typeof value !== "object") return output;
  for (const [emoji, usernames] of Object.entries(value)) {
    const people = [...new Set((Array.isArray(usernames) ? usernames : [])
      .map((username) => String(username || "").trim().slice(0, 40))
      .filter(Boolean))];
    if (emoji && people.length) output[String(emoji).slice(0, 8)] = people;
  }
  return output;
}

function encodeChatText({ text, replyToId, reactions } = {}) {
  return CHAT_META_PREFIX + JSON.stringify({
    text: String(text || "").slice(0, 2000),
    replyToId: Number(replyToId) || null,
    reactions: normalizeReactions(reactions),
  });
}

function parseChatText(value) {
  const raw = String(value || "");
  if (!raw.startsWith(CHAT_META_PREFIX)) {
    return { text: raw, replyToId: null, reactions: {} };
  }
  try {
    const parsed = JSON.parse(raw.slice(CHAT_META_PREFIX.length));
    return {
      text: String(parsed.text || "").slice(0, 2000),
      replyToId: Number(parsed.replyToId) || null,
      reactions: normalizeReactions(parsed.reactions),
    };
  } catch {
    return { text: "", replyToId: null, reactions: {} };
  }
}

function hydrateChatMessage(message) {
  if (!message) return null;
  return { ...message, ...parseChatText(message.text) };
}

function encodedChatMessageText(message, fields = {}) {
  const current = hydrateChatMessage(message);
  return encodeChatText({
    text: fields.text !== undefined ? fields.text : current.text,
    replyToId: fields.replyToId !== undefined ? fields.replyToId : current.replyToId,
    reactions: fields.reactions !== undefined ? fields.reactions : current.reactions,
  });
}

module.exports = {
  CHAT_META_PREFIX,
  encodeChatText,
  parseChatText,
  hydrateChatMessage,
  encodedChatMessageText,
  normalizeReactions,
};
