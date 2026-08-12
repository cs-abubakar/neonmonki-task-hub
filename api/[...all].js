/**
 * Vercel serverless function — catch-all for every /api/* request.
 * Requires env vars (Vercel Project → Settings → Environment Variables):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SESSION_SECRET,
 *   ADIKA_PASSWORD, TEAM_PASSWORD
 */
"use strict";

const { handle } = require("../lib/handler");

module.exports = async (req, res) => {
  const handled = await handle(req, res);
  if (!handled) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unknown endpoint." }));
  }
};
