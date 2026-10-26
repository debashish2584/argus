/**
 * Stage 6 — Submit.
 *
 * Composes the pull request: commit message, PR title, and PR body. The body
 * embeds the before/after evidence the run captured (failing logs before the
 * fix, passing logs after), so a reviewer can verify the closed loop without
 * reading the state store. Binary artifacts (video/trace/HAR) are referenced
 * by path in the MVP; attaching them to the PR is post-MVP
 * (docs/post-mvp-roadmap.md §7 "artifact delivery").
 */
import { z } from "zod";
import type { ChatFn } from "../agent/runner.js";
import {
  extractJson,
  renderAndInvoke,
  resolvePrompt,
} from "../agent/runner.js";
import type { BugReport } from "../config/schema.js";

export const PullRequestSchema = z.object({
  commit_message: z.string().min(10),
  title: z.string().min(8).max(100),
  body: z.string().min(40),
});
export type PullRequestDraft = z.infer<typeof PullRequestSchema>;

export interface SubmitInput {
  bug: BugReport;
  /** Repo-relative files changed by the applied patch. */
  changedFiles: string[];
  /** Summary of the applied fix (from the fixer's `summary`). */
  fixSummary: string;
  riskNotes: string;
  /** Excerpt of the failing run's log (pre-fix). */
  beforeLog: string;
  /** Excerpt of the verification run's log (post-fix; must show the plan passing). */
  afterLog: string;
  /** Artifact paths available in the run directory (video/trace/HAR/console). */
  evidencePaths: string[];
}

export interface SubmitOptions {
  prompt?: string;
  repoRoot: string;
  runId?: string;
  maxTokens?: number;
  retries?: number;
}

export async function submitAgent(
  chat: ChatFn,
  log: (line: string) => void,
  input: SubmitInput,
  opts: SubmitOptions,
): Promise<PullRequestDraft> {
  const prompt = resolvePrompt("submit", opts.prompt ?? "default", opts.repoRoot);

  const vars: Record<string, string> = {
    BUG_ID: input.bug.bug_id,
    BUG_TITLE: input.bug.title,
    BUG_SEVERITY: input.bug.severity,
    FIX_SUMMARY: input.fixSummary,
    RISK_NOTES: input.riskNotes,
    FILES: input.changedFiles.join("\n"),
    BEFORE_LOG: input.beforeLog.slice(0, 6_000),
    AFTER_LOG: input.afterLog.slice(0, 6_000),
    EVIDENCE:
      input.evidencePaths.map((p) => `- ${p}`).join("\n") ||
      "(no binary artifacts captured this run)",
    RUN_ID: opts.runId ?? "",
  };

  const res = await renderAndInvoke(
    { chat, log, configHash: "" },
    {
      agent: "submit",
      promptVersion: prompt.version,
      system: prompt.text,
      user: "Compose the pull request now. Respond with the JSON document only.",
      systemVars: vars,
      runId: opts.runId,
      maxTokens: opts.maxTokens,
      retries: opts.retries,
      purpose: "submit",
    },
  );

  log(
    `  submit: ${res.usage.prompt_tokens}→${res.usage.completion_tokens} tokens in ${res.duration_ms}ms`,
  );
  return extractJson(res.content, PullRequestSchema, "submit output");
}
