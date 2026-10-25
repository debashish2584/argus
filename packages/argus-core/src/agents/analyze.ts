/**
 * Stage 1 — Analyze.
 *
 * Reads the diff envelope + spec docs and produces a machine-readable
 * impact report: which modules are affected, the risk per module, and the
 * concrete behaviors the test plans must exercise. This report is the
 * single input that drives plan selection — no magic, no guesswork.
 *
 * The prompt (built-in or user override) is the single source of truth for
 * instructions; this module only renders variables, calls the LLM, and
 * validates the structured output.
 */
import { z } from "zod";
import type { ChatFn } from "../agent/runner.js";
import { extractJson, renderAndInvoke, resolvePrompt } from "../agent/runner.js";
import type { CodeSourceResult } from "../adapters/code-source.js";
import type { SpecDoc } from "../adapters/spec-source.js";
import type { TestPlan } from "../config/schema.js";

export const ImpactReportSchema = z.object({
  summary: z.string().min(5),
  affected: z.array(
    z.object({
      module: z.string().min(1),
      files: z.array(z.string()),
      risk: z.enum(["high", "medium", "low"]),
      why: z.string().min(5),
    }),
  ),
  /** Concrete, testable behaviors that must be verified for this change. */
  test_focus: z.array(z.string().min(3)).min(1),
});
export type ImpactReport = z.infer<typeof ImpactReportSchema>;

export interface AnalyzeInput {
  diff: CodeSourceResult;
  specs: SpecDoc[];
  existingPlans: TestPlan[];
}

export interface AnalyzeOptions {
  prompt?: string; // "default" or repo-relative override path
  repoRoot: string;
  runId?: string;
  maxTokens?: number;
  retries?: number;
}

export async function analyzeAgent(
  chat: ChatFn,
  log: (line: string) => void,
  input: AnalyzeInput,
  opts: AnalyzeOptions,
): Promise<ImpactReport> {
  const prompt = resolvePrompt("analyze", opts.prompt ?? "default", opts.repoRoot);
  const vars: Record<string, string> = {
    DIFF: input.diff.diff.slice(0, 60_000) || "(no changed files — empty diff)",
    FILES: input.diff.files.join("\n") || "(none)",
    SPECS: input.specs
      .map((s) => `### ${s.title} [ref: ${s.ref}]\n${s.content.slice(0, 20_000)}`)
      .join("\n\n")
      .slice(0, 60_000) || "(no specs found)",
    EXISTING_PLANS:
      input.existingPlans
        .map((p) => `- ${p.id} (${p.status}): ${p.title} — module=${p.module}`)
        .join("\n") || "(none)",
    RUN_ID: opts.runId ?? "",
  };

  const report = await renderAndInvoke(
    { chat, log, configHash: "" },
    {
      agent: "analyze",
      promptVersion: prompt.version,
      system: prompt.text,
      user: "Produce the impact report now. Respond with the JSON document only.",
      systemVars: vars,
      runId: opts.runId,
      maxTokens: opts.maxTokens,
      retries: opts.retries,
      purpose: "analyze",
    },
  );

  log(
    `  analyze: ${report.usage.prompt_tokens}→${report.usage.completion_tokens} tokens in ${report.duration_ms}ms (via ${report.provider}/${report.model})`,
  );
  return extractJson(report.content, ImpactReportSchema, "analyze output");
}
