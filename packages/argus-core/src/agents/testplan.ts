/**
 * Stage 2 — Test Plan.
 *
 * Synthesizes test plans from the impact report + specs. Output is a JSON
 * array of plan objects (metadata + structured steps + narrative); each plan
 * is validated against TestPlanSchema, assigned a stable TP-NNN id, and
 * written to `.argus/testplans/` as **DRAFT**.
 *
 * Invariant guard: this agent never modifies ACTIVE plans. New plans land as
 * DRAFT; approval (`argus plan promote`) makes them ground truth. The fixer
 * only trusts ACTIVE plans — this is what breaks the "LLM tests → LLM
 * fixes its own tests" circular trust loop.
 */
import { z } from "zod";
import type { ChatFn } from "../agent/runner.js";
import { extractJson, renderAndInvoke, resolvePrompt } from "../agent/runner.js";
import { TestPlanSchema } from "../config/schema.js";
import { nextPlanId, PlanStore, type PlanFile } from "../plan/store.js";
import type { ImpactReport } from "./analyze.js";

/** The plan shape the LLM emits — ids are advisory, we reassign stable ids. */
const ProposedPlanSchema = TestPlanSchema.extend({
  /** LLM may suggest ids; we normalize them to the TP-NNN sequence. */
});

export interface TestPlanInput {
  impact: ImpactReport;
  specs: { title: string; ref: string; content: string }[];
  existing: PlanFile[];
  /** Service map — the ONLY source of URLs; steps must use {{VAR}} refs. */
  envVars: Record<string, string>;
}

export interface TestPlanOptions {
  prompt?: string;
  repoRoot: string;
  plansDir: string;
  runId?: string;
  maxTokens?: number;
  retries?: number;
}

export interface TestPlanResult {
  /** Plans written this run (all DRAFT). */
  created: { id: string; title: string; file: string }[];
  notes: string;
}

export async function testplanAgent(
  chat: ChatFn,
  log: (line: string) => void,
  store: PlanStore,
  input: TestPlanInput,
  opts: TestPlanOptions,
): Promise<TestPlanResult> {
  const prompt = resolvePrompt("testplan", opts.prompt ?? "default", opts.repoRoot);

  const specList = input.specs
    .map((s) => `### ${s.title} [ref: ${s.ref}]\n${s.content.slice(0, 15_000)}`)
    .join("\n\n")
    .slice(0, 50_000);
  const existingList = input.existing
    .map(
      (p) =>
        `- ${p.plan.id} (${p.plan.status}, ${p.plan.priority}) [module=${p.plan.module}]: ${p.plan.title}\n  steps: ${p.plan.steps
          .map((s) => s.id)
          .join(", ")}`,
    )
    .join("\n");
  const envEntries = Object.entries(input.envVars)
    .map(([k, v]) => `{{${k}}} = ${v}`)
    .join("\n");

  const res = await renderAndInvoke(
    { chat, log, configHash: "" },
    {
      agent: "testplan",
      promptVersion: prompt.version,
      system: prompt.text,
      user: "Produce the test plans now. Respond with the JSON array only.",
      systemVars: {
        IMPACT: JSON.stringify(input.impact, null, 2),
        SPECS: specList || "(no specs found)",
        EXISTING_PLANS: existingList || "(none)",
        ENV_VARS: envEntries || "(no service map — use relative paths)",
        RUN_ID: opts.runId ?? "",
        // The prompt body quotes the {{VAR}} syntax as an *example* the model
        // must copy into plan steps (rendered at execution time). Map those
        // names to themselves so the single-pass render preserves them.
        APP_URL: "{{APP_URL}}",
        VAR: "{{VAR}}",
      },
      runId: opts.runId,
      maxTokens: opts.maxTokens,
      retries: opts.retries,
      purpose: "testplan",
    },
  );

  log(
    `  testplan: ${res.usage.prompt_tokens}→${res.usage.completion_tokens} tokens in ${res.duration_ms}ms`,
  );

  const proposed = extractJson(
    res.content,
    z.object({ plans: z.array(ProposedPlanSchema), notes: z.string().default("") }),
    "testplan output",
  );

  // Normalize: stable ids, DRAFT status, dedupe against existing plans.
  const knownIds = new Set(input.existing.map((p) => p.plan.id));
  const created: TestPlanResult["created"] = [];
  for (const raw of proposed.plans) {
    if (knownIds.has(raw.id)) continue; // never clobber an existing plan id
    let id = nextPlanId(input.existing.map((p) => p.plan));
    while (created.some((c) => c.id === id) || knownIds.has(id)) {
      id = nextPlanId([
        ...input.existing.map((p) => p.plan),
        ...created.map((c) => ({ ...raw, id: c.id })),
      ]);
    }
    const plan = {
      ...raw,
      id,
      status: "DRAFT" as const,
      created_at: new Date().toISOString(),
    };
    const file = store.write(plan, raw.narrative);
    created.push({ id, title: raw.title, file });
  }

  return {
    created,
    notes: proposed.notes,
  };
}
