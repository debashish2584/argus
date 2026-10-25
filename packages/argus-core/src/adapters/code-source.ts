/**
 * Built-in code source adapter (git).
 *
 * Produces the canonical diff envelope consumed by the analyze agent:
 * base→head diff, changed file list, and — if present — the target repo's
 * engineering-standards document, which the fixer must ingest as mandatory
 * context ("the tool respects the target").
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { ConfigError } from "../errors.js";
import { Git } from "../git.js";

export interface CodeSourceResult {
  /** Commit sha of the diff base (resolved ref or merge-base). */
  base: string;
  /** Commit sha of the diff head (repo HEAD). */
  head: string;
  /** Unified diff, base→head. */
  diff: string;
  /** Paths changed base→head. */
  files: string[];
  /** Target repo's engineering-standards doc, when discoverable. */
  standards_doc?: { path: string; content: string };
}

const STANDARDS_DOC_CANDIDATES = [
  "docs/agent-context.md",
  "AGENT_CONTEXT.md",
  "docs/engineering-standards.md",
  "docs/standards.md",
  "CONTRIBUTING.md",
];
const STANDARDS_MAX_BYTES = 200_000;

export async function gitCodeSource(
  git: Git,
  baseRef: string,
): Promise<CodeSourceResult> {
  const head = await git.head();
  // Prefer merge-base semantics (correct when head has diverged); fall back
  // to the ref itself for shallow/linear histories.
  let base = await git.mergeBase(baseRef, head);
  if (!base) base = await git.resolveRef(baseRef);
  if (!base) {
    throw new ConfigError(
      `diff base '${baseRef}' does not resolve in the target repo — ` +
        "set diff.base to an existing ref (e.g. origin/main, main, or a commit)",
    );
  }
  const [diff, files] = await Promise.all([
    git.diff(base, head),
    git.changedFiles(base, head),
  ]);

  let standards_doc: CodeSourceResult["standards_doc"];
  for (const rel of STANDARDS_DOC_CANDIDATES) {
    const abs = path.join(git.cwd, rel);
    if (!existsSync(abs)) continue;
    const content = readFileSync(abs, "utf8");
    standards_doc = {
      path: rel,
      content: content.slice(0, STANDARDS_MAX_BYTES),
    };
    break;
  }

  return { base, head, diff, files, standards_doc };
}
