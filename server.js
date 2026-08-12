#!/usr/bin/env node
/**
 * Local development server — zero dependencies.
 * Serves public/ statically and routes /api/* through lib/handler.js
 * (JSON-file storage unless SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set).
 *
 * Run:  node server.js            (or: PORT=8080 node server.js)
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { handle } = require("./lib/handler");

const PORT = Number(process.env.PORT || 4173);
const PUBLIC_DIR = path.join(__dirname, "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function serveStatic(req, res) {
  let p;
  try {
    p = decodeURIComponent(req.url.split("?")[0]);
  } catch {
    // malformed percent-encoding (e.g. GET /%) — reject, don't crash the process
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Bad request");
    return;
  }
  if (p === "/") p = "/index.html";
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  // prefix check must include the separator: "/x/publicity" startsWith "/x/public"
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      fs.readFile(path.join(PUBLIC_DIR, "index.html"), (e2, html) => {
        if (e2) { res.writeHead(404).end("Not found"); return; }
        res.writeHead(200, { "Content-Type": MIME[".html"] });
        res.end(html);
      });
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(data);
  });
}

http.createServer(async (req, res) => {
  if (await handle(req, res)) return; // API request, handled
  serveStatic(req, res);
}).listen(PORT, () => {
  const driver = process.env.SUPABASE_URL ? "supabase" : "json-file";
  console.log(`NEONMONKI Task Hub at http://localhost:${PORT}  (storage: ${driver})`);
  console.log("Accounts: adika (client) / advertidea (team) — see README.md");
});
