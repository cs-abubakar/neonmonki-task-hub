/**
 * Storage driver selection.
 *
 * - Supabase (production): active when SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 *   are set (on Vercel, via Project → Settings → Environment Variables).
 * - JSON file (local dev): zero-setup fallback, persists to data/data.json.
 *
 * Both drivers expose the same async interface; lib/handler.js is driver-agnostic.
 */
"use strict";

let store = null;

function getStore() {
  if (store) return store;
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    store = require("./store-supabase");
    store._driver = "supabase";
  } else {
    store = require("./store-json");
    store._driver = "json";
  }
  return store;
}

module.exports = { getStore };
