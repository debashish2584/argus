/**
 * Schema definitions for Argus: configuration, test plans, plan steps,
 * and bug records. Every external input is validated against these before
 * any agent sees it ("high quality" principle: no unvalidated input).
 */
import { z } from "zod";

export const AGENT_IDS = [
  "analyze",
  "testplan",
  "execute",
  "triage",
  "fixer",
  "submit",
] as const;
export type AgentId = (typeof AGENT_IDS)[number];

/* ------------------------------------------------------------------ */
/* LLM bindings                                                        */
/* ------------------------------------------------------------------ */

/**
 * MVP supports OpenAI-compatible chat endpoints (the `anthropic` native API
 * adapter is post-MVP). Presets:
 *  - openai, openrouter, gemini (OpenAI-compat endpoint), vllm-local, custom
 */

/**
 * LLM binding, as validated. Stated explicitly (rather than inferred) so the
 * schema can be recursive — `fallback` is itself a binding.
 */
export interface LlmBinding {
  provider: "openai" | "openrouter" | "gemini" | "vllm-local" | "custom";
  base_url?: string;
  model: string;
  api_key?: string;
  temperature: number;
  max_tokens: number;
  timeout_ms: number;
  fallback?: LlmBinding;
  budget: { max_tokens_total?: number };
}

export const LlmBindingSchema: z.ZodType<LlmBinding> = z
  .object({
    provider: z
      .enum(["openai", "openrouter", "gemini", "vllm-local", "custom"])
      .default("vllm-local"),
    /** Required for `vllm-local` / `custom`; optional elsewhere. */
    base_url: z.string().min(1).optional(),
    model: z.string().min(1),
    /** A `${ENV}` reference is resolved at config load; never a literal in git. */
    api_key: z.string().min(1).optional(),
    temperature: z.number().min(0).max(2).default(0.2),
    /**
     * Reasoning models spend tokens thinking before answering; keep this
     * generous. Retries escalate up to 2x on `length` finishes.
     */
    max_tokens: z.number().int().positive().default(8192),
    timeout_ms: z.number().int().positive().default(300_000),
    fallback: z.lazy(() => LlmBindingSchema).optional(),
    budget: z
      .object({
        /** Token cap across all calls for one run (guard against runaways). */
        max_tokens_total: z.number().int().positive().optional(),
      })
      .default({}),
  })
  .superRefine((b, ctx) => {
    if ((b.provider === "vllm-local" || b.provider === "custom") && !b.base_url) {
      ctx.addIssue({
        code: "custom",
        path: ["base_url"],
        message: `provider '${b.provider}' requires base_url`,
      });
    }
  });

export const PROVIDER_PRESETS: Readonly<Record<string, string>> = {
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
};

/* ------------------------------------------------------------------ */
/* Plan steps & test plans                                             */
/* ------------------------------------------------------------------ */

export const stepIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,31}$/i, "step id: lowercase alnum/dash, ≤32");

/**
 * Accessibility-first locator. The execution harness resolves these against
 * the page's a11y tree; `css` is a last-resort escape hatch.
 */
export const LocatorSpecSchema = z
  .object({
    role: z.string().optional(),
    name: z.string().optional(),
    name_match: z.enum(["exact", "contains", "regex"]).default("contains"),
    testid: z.string().optional(),
    text: z.string().optional(),
    text_match: z.enum(["exact", "contains", "regex"]).default("contains"),
    css: z.string().optional(),
    nth: z.number().int().min(0).default(0),
  })
  .refine(
    (s) => Boolean(s.role || s.name || s.testid || s.text || s.css),
    { message: "locator needs at least one of role/name/testid/text/css" },
  );
export type LocatorSpec = z.infer<typeof LocatorSpecSchema>;

const stepBase = { id: stepIdSchema };

const navigateStep = z.object({
  ...stepBase,
  action: z.literal("navigate"),
  url: z.string().min(1),
});

const fillStep = z.object({
  ...stepBase,
  action: z.literal("fill"),
  target: LocatorSpecSchema,
  value: z.string(),
});

const clickStep = z.object({
  ...stepBase,
  action: z.literal("click"),
  target: LocatorSpecSchema,
});

const waitStep = z.object({
  ...stepBase,
  action: z.literal("wait"),
  ms: z.number().int().positive().optional(),
  target: LocatorSpecSchema.optional(),
  timeout_ms: z.number().int().positive().default(10_000),
});

const assertStep = z.object({
  ...stepBase,
  action: z.literal("assert"),
  kind: z.enum([
    "url_contains",
    "url_not_contains",
    "redirected_to",
    "visible",
    "not_visible",
    "text_contains",
    "dialog_open",
    "title_contains",
  ]),
  value: z.string().optional(),
  target: LocatorSpecSchema.optional(),
});

export const PlanStepSchema = z.discriminatedUnion("action", [
  navigateStep,
  fillStep,
  clickStep,
  waitStep,
  assertStep,
]);
export type PlanStep = z.infer<typeof PlanStepSchema>;

/**
 * A machine-executable test plan. Plans are Markdown files with YAML
 * frontmatter (metadata + steps) and a free-form narrative body for humans.
 * Plans land as DRAFT; they become ground truth for the fixer only after
 * approval (status ACTIVE) — see docs/agent-architecture-and-configuration.md §4.
 */
export const TestPlanSchema = z.object({
  id: z.string().regex(/^TP-[A-Za-z0-9_-]+$/, "id must look like TP-001"),
  title: z.string().min(3),
  module: z.string().default("general"),
  priority: z.enum(["P0", "P1", "P2", "P3"]).default("P2"),
  status: z.enum(["DRAFT", "ACTIVE", "RETIRED"]).default("DRAFT"),
  /** Spec document this plan was derived from (traceability). */
  spec_ref: z.string().optional(),
  tags: z.array(z.string()).default([]),
  created_at: z.string().optional(),
  /** Human-readable setup notes (rendered in the plan body). */
  preconditions: z.array(z.string()).default([]),
  /** Prose narrative; executed behavior lives in `steps`. */
  narrative: z.string().default(""),
  steps: z.array(PlanStepSchema).min(1),
});
export type TestPlan = z.infer<typeof TestPlanSchema>;

/* ------------------------------------------------------------------ */
/* Bug records                                                         */
/* ------------------------------------------------------------------ */

export const BugReportSchema = z.object({
  bug_id: z.string().regex(/^BUG-\d{3,}$/),
  plan_id: z.string(),
  run_id: z.string(),
  title: z.string().min(5),
  severity: z.enum(["P0-Blocker", "P1-High", "P2-Medium", "P3-Low"]),
  /** Source component the triage agent believes is responsible. */
  component: z.string().optional(),
  description: z.string().min(1),
  evidence: z.object({
    screenshot: z.string().optional(),
    video: z.string().optional(),
    video_timestamp: z.string().optional(),
    console_errors: z.array(z.string()).default([]),
    network_failures: z.array(z.string()).default([]),
    violated_contract: z.string().optional(),
  }),
  proposed_fix: z.string().optional(),
});
export type BugReport = z.infer<typeof BugReportSchema>;

/* ------------------------------------------------------------------ */
/* Argus configuration (.argus/config.yaml)                            */
/* ------------------------------------------------------------------ */

export const AgentConfigSchema = z.object({
  /** "default" or a path (relative to repo root) to a prompt override. */
  prompt: z.string().min(1).default("default"),
  /** Per-agent model override; falls back to the global `llm` block. */
  llm: LlmBindingSchema.optional(),
  inputs: z
    .object({
      code_source: z
        .object({
          type: z.literal("git"),
          /** Override of the global diff base for this agent. */
          base: z.string().optional(),
        })
        .default({ type: "git" }),
      spec_source: z
        .union([
          z.object({
            type: z.literal("git-md"),
            paths: z.array(z.string().min(1)).default(["docs/**/*.md"]),
          }),
          z.object({
            type: z.literal("hook"),
            command: z.string().min(1),
            timeout_ms: z.number().int().positive().default(60_000),
          }),
        ])
        .default({ type: "git-md", paths: ["docs/**/*.md"] }),
    })
    .default({
      code_source: { type: "git" },
      spec_source: { type: "git-md", paths: ["docs/**/*.md"] },
    }),
  /**
   * Mechanical capability policy — enforced by the runtime, not the prompt.
   * Empty fs_write = the agent may write nothing outside its own sinks.
   */
  tools: z
    .object({
      fs_write: z.array(z.string().min(1)).default([]),
      shell_allow: z.array(z.string().min(1)).default([]),
      net: z.enum(["deny", "target-only", "allow"]).default("deny"),
    })
    .default({ fs_write: [], shell_allow: [], net: "deny" }),
  limits: z
    .object({
      timeout_ms: z.number().int().positive().default(600_000),
      retries: z.number().int().min(0).max(5).default(0),
    })
    .default({ timeout_ms: 600_000, retries: 0 }),
  report: z
    .object({
      type: z.enum(["none", "email", "markdown"]).default("none"),
      on: z.enum(["always", "failure-only"]).default("failure-only"),
      to: z.array(z.string().email()).default([]),
    })
    .default({ type: "none", on: "failure-only", to: [] }),
});
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export const ArgusConfigSchema = z.object({
  version: z.literal(1).default(1),
  /** The application under test (external-env mode in the MVP). */
  target: z.object({
    /** Source root the agents may read (git repo of the app). */
    repo: z.string().min(1),
    /** Service map; consumed by plan steps as {{VAR}}. */
    env: z.record(z.string(), z.string()).default({}),
    /** All must pass before execution starts. */
    health: z
      .array(
        z.object({
          url: z.string().min(1),
          expect: z.number().int().min(100).max(599).default(200),
          timeout_ms: z.number().int().positive().default(10_000),
        }),
      )
      .default([]),
    /**
     * Target repo's engineering-standards document, ingested by the fixer as
     * mandatory context. Auto-detected if omitted.
     */
    standards_doc: z.string().optional(),
  }),
  diff: z
    .object({ base: z.string().default("origin/main") })
    .default({ base: "origin/main" }),
  /** Global LLM default; agents override per-agent. */
  llm: LlmBindingSchema,
  agents: z.record(z.string(), AgentConfigSchema).default({}),
  pipeline: z
    .object({
      stages: z.array(z.enum(AGENT_IDS)).default([...AGENT_IDS]),
      /**
       * Gate per stage name: auto | human | verify-then-pr.
       * `human` = interactive CLI confirmation; in CI it becomes PR approval.
       */
      gates: z
        .record(z.string(), z.enum(["auto", "human", "verify-then-pr"]))
        .default({}),
      on_failure: z
        .enum(["fail-fast", "continue-to-triage"])
        .default("fail-fast"),
    })
    .default({ stages: [...AGENT_IDS], gates: {}, on_failure: "fail-fast" }),
  report: z
    .object({
      email: z
        .object({
          smtp: z.object({
            host: z.string().min(1),
            port: z.number().int().positive().default(25),
            user: z.string().optional(),
            password: z.string().optional(),
            secure: z.boolean().default(false),
          }),
          from: z.string().min(1),
        })
        .optional(),
    })
    .default({}),
  redact: z
    .object({
      /** Extra regex sources (glob semantics of `new RegExp(src)`). */
      patterns: z.array(z.string().min(1)).default([]),
      /** Env vars whose *values* are scrubbed from all outbound text. */
      env_secrets: z.array(z.string()).default([]),
    })
    .default({ patterns: [], env_secrets: [] })
});
export type ArgusConfig = z.infer<typeof ArgusConfigSchema>;
