/**
 * Build fingerprint — lets the launcher detect a stale server.
 *
 * A running server freezes a hash of its on-disk runtime + served SPA at
 * startup and reports it via `/api/health`. After a code change + rebuild, the
 * files on disk hash differently, so `argus studio open` compares the running
 * server's reported id to the installed id and restarts the server to pick up
 * the new code. Without this, the SPA (served fresh from disk) shows the new
 * buttons while the in-memory server still lacks the new routes — the
 * "no such API route" class of bug.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The studio package root, resolved from this module (works from src/ and dist/). */
export function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

/** Every `*.js` file under `dir` (recursive), excluding compiled test output. */
function jsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...jsFiles(p));
    else if (entry.endsWith(".js") && !entry.endsWith(".test.js")) out.push(p);
  }
  return out;
}

/**
 * A short, stable hash of the server runtime (all JS files under `dist/`)
 * plus the SPA assets it serves. Any change to the running code or the
 * frontend changes the id — which is exactly what makes "click the taskbar
 * icon after an update" self-heal. Deterministic: files are sorted before
 * hashing.
 */
export function buildId(root: string = packageRoot()): string {
  const files = [
    ...jsFiles(path.join(root, "dist")),
    path.join(root, "web", "app.js"),
    path.join(root, "web", "studio.css"),
    path.join(root, "web", "index.html"),
    path.join(root, "web", "manifest.webmanifest"),
  ].filter((f) => existsSync(f));
  const h = createHash("sha256");
  for (const f of [...files].sort()) {
    h.update(path.relative(root, f) + "\0");
    h.update(readFileSync(f));
  }
  return h.digest("hex").slice(0, 12);
}
