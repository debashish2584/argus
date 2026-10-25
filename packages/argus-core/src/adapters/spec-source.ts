/**
 * Spec source adapters: the TestPlan agent's document input.
 *
 *  - `git-md`: read Markdown files from the repo (default; paths glob).
 *  - `hook`: external command implementing the hook protocol, emitting
 *    `{ "specs": [SpecDoc] }`.
 *
 * Both produce the same `SpecDoc[]` — a custom doc store is one script away.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { HookError } from "../errors.js";
import { parseHookOutput, runHook, type HookContext } from "../hook.js";

export const SpecDocSchema = z.object({
  /** Stable identifier — usually the repo-relative path. */
  id: z.string().min(1),
  title: z.string().min(1),
  /** Reference for traceability (path, URL, doc id). */
  ref: z.string().min(1),
  content: z.string(),
});
export type SpecDoc = z.infer<typeof SpecDocSchema>;

export type SpecSourceConfig =
  | { type: "git-md"; paths: string[] }
  | { type: "hook"; command: string; timeout_ms: number };

const MAX_SPEC_BYTES = 120_000; // keep prompts bounded

export async function loadSpecs(
  repoDir: string,
  source: SpecSourceConfig,
  ctx: HookContext,
): Promise<SpecDoc[]> {
  if (source.type === "git-md") {
    return gitMdSpecs(repoDir, source.paths);
  }
  const out = await runHook(source.command, ctx, {
    timeout_ms: source.timeout_ms,
    cwd: repoDir,
  });
  const data = parseHookOutput<{ specs?: unknown }>(out, source.command);
  let parsed: SpecDoc[];
  try {
    parsed = z.array(SpecDocSchema).parse(data.specs);
  } catch (e) {
    throw new HookError(
      `hook spec output failed validation: ${(e as Error).message}; ` +
        "expected { specs: [{id, title, ref, content}] }",
    );
  }
  return parsed;
}

function gitMdSpecs(repoDir: string, patterns: string[]): SpecDoc[] {
  const specs: SpecDoc[] = [];
  const seen = new Set<string>();
  for (const pattern of patterns) {
    for (const file of matchGlob(repoDir, pattern)) {
      if (!/\.md$/i.test(file)) continue;
      const rel = path.relative(repoDir, file);
      if (seen.has(rel)) continue;
      seen.add(rel);
      let content: string;
      try {
        content = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      if (content.length > MAX_SPEC_BYTES) continue;
      const title =
        content.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? rel;
      specs.push({ id: rel, title, ref: rel, content });
    }
  }
  return specs;
}

/* ------------------------------------------------------------------ */
/* Minimal glob (supports `*`, `**` per path segment; no `{a,b}`)       */
/* ------------------------------------------------------------------ */

export function matchGlob(rootDir: string, pattern: string): string[] {
  const results: string[] = [];
  const walk = (dir: string, segments: string[]): void => {
    if (segments.length === 0) {
      if (statSync(dir).isFile()) results.push(dir);
      return;
    }
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const [head, ...rest] = segments;
    if (!head) return;
    if (head === "**") {
      // Zero or more directories: try skipping the rest from here, and
      // descend into every subdirectory with the same remaining segments.
      walk(dir, rest);
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith(".")) {
          walk(path.join(dir, entry.name), segments);
        }
      }
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (!fnMatch(entry.name, head)) continue;
      const next = path.join(dir, entry.name);
      if (rest.length === 0) {
        if (entry.isFile()) results.push(next);
      } else if (entry.isDirectory()) {
        walk(next, rest);
      }
    }
  };
  walk(rootDir, pattern.split("/").filter(Boolean));
  return results;
}

function fnMatch(name: string, pat: string): boolean {
  if (pat === name) return true;
  if (!pat.includes("*")) return false;
  const re = new RegExp(
    "^" + pat.split("*").map(escapeRegExp).join(".*") + "$",
  );
  return re.test(name);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
