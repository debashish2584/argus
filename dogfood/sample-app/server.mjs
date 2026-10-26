#!/usr/bin/env node
/**
 * SampleApp static file server (zero dependencies).
 *
 * Serves ./public on 127.0.0.1:$PORT (default 4173). Missing files → 404;
 * the deliberately absent /js/analytics.js is part of the dogfood's
 * network-evidence story (recorded in the HAR, never a scenario failure).
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Serves ./public next to this script by default; the dogfood orchestrator
// points PUBLIC_DIR at the fresh git target so applied fixes are what the
// verification re-run actually sees (the fix loop edits the target copy).
const root = process.env.PUBLIC_DIR
  ? path.resolve(process.env.PUBLIC_DIR)
  : path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const port = Number(process.env.PORT ?? 4173);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    if (pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }
    const rel = pathname === "/" ? "/index.html" : pathname.endsWith("/")
      ? pathname + "index.html"
      : pathname;
    const file = path.normalize(path.join(root, rel));
    if (!file.startsWith(root + path.sep)) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("forbidden");
      return;
    }
    const data = await readFile(file);
    res.writeHead(200, {
      "content-type": TYPES[path.extname(file)] ?? "application/octet-stream",
    });
    res.end(data);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("404 not found");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`sample-app: serving ${root} on http://127.0.0.1:${port}`);
});
