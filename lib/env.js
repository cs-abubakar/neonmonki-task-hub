/**
 * Minimal .env loader — no dependencies, no-ops when no .env exists
 * (e.g. on Vercel, where env vars come from the platform).
 */
"use strict";

const fs = require("fs");
const path = require("path");

const envFile = path.join(__dirname, "..", ".env");
// Skip .env when TASK_HUB_DATA_FILE is set — that flag means isolated
// JSON-file mode (tests), and .env's Supabase credentials must not leak in.
if (!process.env.TASK_HUB_DATA_FILE && fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m || process.env[m[1]]) continue;
    const raw = m[2].trim();
    const q = raw[0];
    if (q === '"' || q === "'") {
      // quoted value: take up to the closing quote (anything after is a comment)
      const end = raw.indexOf(q, 1);
      process.env[m[1]] = end === -1 ? raw.slice(1) : raw.slice(1, end);
    } else {
      // unquoted: strip trailing inline comments (`KEY=value  # note`)
      process.env[m[1]] = raw.replace(/\s+#.*$/, "").trimEnd();
    }
  }
}

module.exports = {};
