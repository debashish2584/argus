/**
 * Stage 5 — Fixer.
 *
 * Turns a BugReport into a **minimal patch** (unified diff). The fixer is
 * scoped to single-surface fixes: no refactors, no new files outside the
 * component in question, no changes to tests/specs/config.
 *
 * Two layers of enforcement:
 *  1. The prompt (prompts/fixer/default.md) constrains *intent*.
 *  2. `patchFiles()` + `assertPatchAllowed()` below constrain *output* —
 *     the pipeline rejects any patch that touches protected paths, whatever
 *     the model says. This is the "mechanical capability policy" from
 *     docs/agent-architecture-and-configuration.md §7.
 */
import { z } from "zod";
import type { ChatFn } from "../agent/runner.js";
import {
  extractJson,
  renderAndInvoke,
  resolvePrompt,
} from "../agent/runner.js";
import { ScopeViolation } from "../errors.js";
import type { BugReport } from "../config/schema.js";

export const FixProposalSchema = z.object({
  /** One or two sentences: what the patch changes and why. */
  summary: z.string().min(10),
  /**
   * Unified diff, `git diff` compatible (apply with `git apply`).
   * Empty string = the agent declined to fix (no safe single-surface fix);
   * the pipeline then leaves the bug open for humans.
   */
  patch: z.string(),
  /** Files the patch touches (repo-relative); empty when patch is empty. */
  files: z.array(z.string().min(1)).default([]),
  /** Honest self-assessment of what this patch does NOT cover. */
  risk_notes: z.string().min(5),
});
export type FixProposal = z.infer<typeof FixProposalSchema>;

export interface FixerInput {
  bug: BugReport;
  /** Target repo's engineering standards doc (mandatory context). */
  standards: { path: string; content: string } | null;
  /** Source files the fixer may consider (repo-relative + content). */
  contextFiles: Array<{ path: string; content: string }>;
  /** The failing plan step(s), for the "definition of done". */
  failingSteps: string[];
}

export interface FixerOptions {
  prompt?: string;
  repoRoot: string;
  runId?: string;
  maxTokens?: number;
  retries?: number;
}

export async function fixerAgent(
  chat: ChatFn,
  log: (line: string) => void,
  input: FixerInput,
  opts: FixerOptions,
): Promise<FixProposal> {
  const prompt = resolvePrompt("fixer", opts.prompt ?? "default", opts.repoRoot);

  const context = input.contextFiles
    .map((f) => `### ${f.path}\n\`\`\`\n${f.content.slice(0, 24_000)}\n\`\`\``)
    .join("\n\n");

  const vars: Record<string, string> = {
    BUG_TITLE: input.bug.title,
    BUG_SEVERITY: input.bug.severity,
    BUG_COMPONENT: input.bug.component ?? "(unknown)",
    BUG_DESCRIPTION: input.bug.description,
    VIOLATED_CONTRACT: input.bug.evidence.violated_contract ?? "(not stated)",
    PROPOSED_FIX: input.bug.proposed_fix ?? "(none)",
    STANDARDS: input.standards
      ? `${input.standards.path}:\n${input.standards.content.slice(0, 12_000)}`
      : "(no standards doc found — follow conventional minimal-change practice)",
    FAILING_STEPS: input.failingSteps.join("\n") || "(not recorded)",
    CONTEXT_FILES: context || "(no context files provided)",
    RUN_ID: opts.runId ?? "",
  };

  const res = await renderAndInvoke(
    { chat, log, configHash: "" },
    {
      agent: "fixer",
      promptVersion: prompt.version,
      system: prompt.text,
      user: "Produce the fix now. Respond with the JSON document only.",
      systemVars: vars,
      runId: opts.runId,
      maxTokens: opts.maxTokens,
      retries: opts.retries,
      purpose: "fix",
    },
  );

  log(
    `  fixer: ${res.usage.prompt_tokens}→${res.usage.completion_tokens} tokens in ${res.duration_ms}ms`,
  );
  return extractJson(res.content, FixProposalSchema, "fixer output");
}

/* ------------------------------------------------------------------ */
/* Mechanical scope enforcement (output layer)                          */
/* ------------------------------------------------------------------ */

/**
 * Extract the repo-relative file paths a unified diff touches.
 * Handles both `diff --git a/x b/x` and bare `--- a/x` / `+++ b/x` forms.
 */
export function patchFiles(patch: string): string[] {
  const files = new Set<string>();
  for (const line of patch.split("\n")) {
    let m = line.match(/^diff --git a\/(\S+) b\/(\S+)/);
    if (m) {
      files.add(m[2] as string);
      continue;
    }
    m = line.match(/^\+\+\+ b\/(\S+)/);
    if (m) files.add((m[1] as string).replace(/^\/+/, ""));
    m = line.match(/^--- a\/(\S+)/);
    if (m) files.add((m[1] as string).replace(/^\/+/, ""));
  }
  return [...files];
}

/**
 * Protected path rules — the fixer may never touch these, regardless of
 * what it is told. Configured per-target by the pipeline; these are the
 * Argus defaults (see docs/agent-architecture-and-configuration.md §7):
 *  - tests:        the "tests the fixer wrote itself" trust loop, closed off
 *  - specs/docs:   ground truth for plans; the fixer must not move the goalposts
 *  - argus config: the tool's own configuration and plans
 *  - package/build: dependency + build manifest changes are review-only
 */
export interface ProtectionRule {
  name: string;
  match: (repoRelPath: string) => boolean;
}

export const DEFAULT_PROTECTION_RULES: ProtectionRule[] = [
  {
    name: "tests",
    match: (p) =>
      /(^|\/)(.*\.)?(test|spec)\.[a-z]+$/.test(p) || /(^|\/)__tests__\//.test(p),
  },
  {
    name: "specs/docs",
    match: (p) => /(^|\/)docs\//.test(p) || /(^|\/)specs?\//.test(p),
  },
  {
    name: "argus config",
    match: (p) => /^\.argus\//.test(p),
  },
  {
    name: "build/dependency manifests",
    match: (p) =>
      /(^|\/)package(-\w+)?\.json$/.test(p) ||
      /(^|\/)(pnpm-lock\.yaml|yarn\.lock|package-lock\.json|Cargo\.toml|go\.mod|requirements\.txt)$/.test(p) ||
      /(^|\/)(vite|webpack|rollup|tsconfig)\w*\.config\.[a-z]+$/.test(p),
  },
];

/**
 * Reject a patch that touches protected paths. Throws ScopeViolation naming
 * the offending rule and file. Returns the (allowed) file list on success.
 */
export function assertPatchAllowed(
  patch: string,
  rules: ProtectionRule[] = DEFAULT_PROTECTION_RULES,
): string[] {
  const files = patchFiles(patch);
  if (patch.trim() !== "" && files.length === 0) {
    throw new ScopeViolation(
      "fixer patch is unparseable (no `diff --git` / `+++ b/...` lines found)",
    );
  }
  for (const file of files) {
    for (const rule of rules) {
      if (rule.match(file)) {
        throw new ScopeViolation(
          `fixer attempted to modify '${file}' — protected by rule '${rule.name}' ` +
            `(fixers may not touch tests, specs, config, or build manifests)`,
        );
      }
    }
  }
  return files;
}
