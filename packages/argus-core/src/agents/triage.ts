/**
 * Stage 4 — Triage.
 *
 * Takes a failed scenario (steps, console, network, evidence) plus the plan
 * that failed, and produces a structured BugReport: what broke, how bad it
 * is, which source component is responsible, and the contract that was
 * violated. Bug ids (BUG-NNN) and run ids are assigned by the pipeline —
 * the LLM only reports facts, never bookkeeping.
 */
import { z } from "zod";
import type { ChatFn } from "../agent/runner.js";
import {
  extractJson,
  renderAndInvoke,
  resolvePrompt,
} from "../agent/runner.js";
import type { TestPlan } from "../config/schema.js";
import type { ScenarioResult } from "../execute/types.js";

/** Triage's output; the pipeline adds bug_id + run_id to make a BugReport. */
export const TriageReportSchema = z.object({
  title: z.string().min(5).max(140),
  severity: z.enum(["P0-Blocker", "P1-High", "P2-Medium", "P3-Low"]),
  /** Source component the agent believes is responsible (best guess, cited). */
  component: z.string().optional(),
  description: z.string().min(10),
  /** The specification/plan contract that the behavior violated. */
  violated_contract: z.string().min(5),
  /** One-paragraph pointer to the likely fix — NOT a patch. */
  proposed_fix: z.string().optional(),
});
export type TriageReport = z.infer<typeof TriageReportSchema>;

export interface TriageInput {
  scenario: ScenarioResult;
  plan: TestPlan;
  /** Changed files from the diff — grounds the component guess. */
  changedFiles: string[];
}

export interface TriageOptions {
  prompt?: string;
  repoRoot: string;
  runId?: string;
  maxTokens?: number;
  retries?: number;
}

export async function triageAgent(
  chat: ChatFn,
  log: (line: string) => void,
  input: TriageInput,
  opts: TriageOptions,
): Promise<TriageReport> {
  const { scenario, plan } = input;
  const prompt = resolvePrompt("triage", opts.prompt ?? "default", opts.repoRoot);

  const stepLines = scenario.steps
    .map((s) => {
      const marker = s.status === "pass" ? "✓" : s.status === "fail" ? "✗" : "–";
      return `${marker} ${s.step_id} (${s.action})${
        s.error ? ` — ${s.error}` : ""
      }`;
    })
    .join("\n");

  const planSteps = plan.steps
    .map((s) => `${s.id} (${s.action}): ${JSON.stringify(s)}`)
    .join("\n");

  const vars: Record<string, string> = {
    PLAN_ID: plan.id,
    PLAN_TITLE: plan.title,
    PLAN_NARRATIVE: plan.narrative || "(no narrative)",
    PLAN_STEPS: planSteps,
    FAILED_STEP: scenario.failed_step_id ?? "unknown",
    ERROR: scenario.error ?? "(no error recorded)",
    STEP_LOG: stepLines,
    CONSOLE_ERRORS:
      scenario.console_errors
        .slice(0, 20)
        .map((c) => `- ${c.slice(0, 500)}`)
        .join("\n") || "(none)",
    NETWORK_FAILURES:
      scenario.network_failures
        .slice(0, 20)
        .map((c) => `- ${c.slice(0, 300)}`)
        .join("\n") || "(none)",
    CHANGED_FILES: input.changedFiles.join("\n") || "(none)",
    RUN_ID: opts.runId ?? "",
  };

  const res = await renderAndInvoke(
    { chat, log, configHash: "" },
    {
      agent: "triage",
      promptVersion: prompt.version,
      system: prompt.text,
      user: "Produce the triage report now. Respond with the JSON document only.",
      systemVars: vars,
      runId: opts.runId,
      maxTokens: opts.maxTokens,
      retries: opts.retries,
      purpose: "triage",
    },
  );

  log(
    `  triage: ${res.usage.prompt_tokens}→${res.usage.completion_tokens} tokens in ${res.duration_ms}ms`,
  );
  return extractJson(res.content, TriageReportSchema, "triage output");
}
