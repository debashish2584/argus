import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { ArgusConfigSchema } from "../config/schema.js";
import type { ArgusConfig, TestPlan } from "../config/schema.js";
import { JsonlStateStore } from "../storage/state.js";
import { RunArtifacts } from "../storage/artifacts.js";
import { Git } from "../git.js";
import { Redactor } from "../redact.js";
import { newRunId } from "../storage/artifacts.js";
import { Pipeline } from "./run.js";
import type { Executor, ScenarioResult, ScenarioSink } from "../execute/types.js";
import { PlanStore } from "../plan/store.js";

/* ------------------------------------------------------------------ */
/* Fixtures                                                             */
/* ------------------------------------------------------------------ */

const BUGGY = `export function add(a: number, b: number): number {
  const total = a - b; // BUG: subtraction instead of addition
  return total;
}
`;

const FIXED = `export function add(a: number, b: number): number {
  const total = a + b;
  return total;
}
`;

const FIX_PATCH = `diff --git a/src/login.ts b/src/login.ts
--- a/src/login.ts
+++ b/src/login.ts
@@ -1,3 +1,3 @@
 export function add(a: number, b: number): number {
-  const total = a - b; // BUG: subtraction instead of addition
+  const total = a + b;
   return total;
}
`;

/** The plan the testplan agent will create (the LLM emits it verbatim). */
const PLAN: TestPlan = {
  id: "TP-001",
  title: "Addition works",
  module: "auth",
  priority: "P0",
  status: "DRAFT",
  tags: ["core"],
  preconditions: ["app reachable"],
  narrative: "Verifies add() surfaces the correct total.",
  steps: [
    { id: "open-app", action: "navigate", url: "{{APP_URL}}/" },
    { id: "total-shown", action: "assert", kind: "text_contains", value: "42" },
  ],
};

/** Scripted LLM server: answers per-agent based on the system prompt. */
let llmServer: Server;
let llmUrl: string;
const llmCalls: string[] = [];

beforeAll(async () => {
  llmServer = createServer((req, res) => {
    let data = "";
    req.on("data", (d) => (data += d));
    req.on("end", () => {
      const body = JSON.parse(data);
      const system = (body.messages?.[0]?.content as string) ?? "";
      llmCalls.push(system.slice(0, 60));
      const reply = system.includes("ANALYZE")
        ? JSON.stringify({
            summary: "add() logic changed; totals at risk",
            affected: [
              { module: "auth", files: ["src/login.ts"], risk: "high", why: "operator flipped" },
            ],
            test_focus: ["add(20, 22) surfaces 42"],
          })
        : system.includes("TEST PLAN")
          ? JSON.stringify({ plans: [PLAN], notes: "one plan" })
          : system.includes("TRIAGE")
            ? JSON.stringify({
                title: "add() returns the wrong total",
                severity: "P1-High",
                component: "src/login.ts",
                description: "assert total-shown failed: expected 42, saw a different value.",
                violated_contract: "TP-001 total-shown asserts text_contains 42.",
                proposed_fix: "the operator in add() is subtracting",
              })
            : system.includes("FIXER")
              ? JSON.stringify({
                  summary: "restore addition in add()",
                  patch: FIX_PATCH,
                  files: ["src/login.ts"],
                  risk_notes: "only covers add(); does not audit other arithmetic",
                })
              : system.includes("SUBMIT")
                ? JSON.stringify({
                    commit_message: "fix(auth): restore addition in add() [BUG-001]",
                    title: "fix(auth): restore addition in add() [BUG-001]",
                    body: "## Summary\nadd() was subtracting.\n## Verification\nTP-001 passes.",
                  })
                : "{}";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          model: "scripted",
          choices: [{ finish_reason: "stop", message: { content: reply } }],
          usage: { prompt_tokens: 10, completion_tokens: 10 },
        }),
      );
    });
  });
  await new Promise<void>((r) => llmServer.listen(0, "127.0.0.1", r));
  llmUrl = `http://127.0.0.1:${(llmServer.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  await new Promise((r) => llmServer.close(r));
});

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" });
}

function makeRepo(): string {
  const repo = mkdtempSync(path.join(os.tmpdir(), "argus-target-"));
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "argus@test.local");
  git(repo, "config", "user.name", "Argus Test");
  git(repo, "config", "commit.gpgsign", "false");
  // baseline
  mkdirSync(path.join(repo, "src"), { recursive: true });
  writeFileSync(path.join(repo, "src", "login.ts"), FIXED, "utf8");
  mkdirSync(path.join(repo, "docs"), { recursive: true });
  writeFileSync(path.join(repo, "docs", "spec.md"), "# Spec\nadd() must add.\n", "utf8");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "baseline");
  // the change under test (introduces the bug)
  writeFileSync(path.join(repo, "src", "login.ts"), BUGGY, "utf8");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "flip the operator (bug)");
  return repo;
}

/** Fails the first execution of a plan, passes on verification runs. */
class ScriptedExecutor implements Executor {
  calls: string[] = [];
  private callsSoFar = 0;
  async runScenario(
    plan: TestPlan,
    _env: Record<string, string>,
    sink: ScenarioSink,
  ): Promise<ScenarioResult> {
    this.calls.push(plan.id);
    // The pipeline re-runs the *same plan object* for verification
    // (recorded under `plan_id: <id>-verify`), so count invocations.
    const failing = this.callsSoFar === 0;
    this.callsSoFar += 1;
    return {
      plan_id: plan.id,
      status: failing ? "fail" : "pass",
      failed_step_id: failing ? "total-shown" : undefined,
      error: failing ? "expected text to contain 42, page shows 0" : undefined,
      steps: [
        { step_id: "open-app", action: "navigate", status: "pass", duration_ms: 1 },
        {
          step_id: "total-shown",
          action: "assert",
          status: failing ? "fail" : "pass",
          error: failing ? "expected text to contain 42, page shows 0" : undefined,
          duration_ms: 1,
        },
      ],
      console_errors: [],
      network_failures: [],
      duration_ms: 2,
      started_at: new Date().toISOString(),
      artifacts: { console_log: path.join(sink.dir, "console.log") },
    };
  }
}

function config(repo: string): ArgusConfig {
  return ArgusConfigSchema.parse({
    target: { repo, env: { APP_URL: "http://localhost:1" }, health: [] },
    diff: { base: "HEAD~1" },
    llm: {
      provider: "custom",
      base_url: llmUrl,
      model: "scripted",
      api_key: "k",
      temperature: 0,
      max_tokens: 1024,
      timeout_ms: 5000,
      budget: {},
    },
    pipeline: { stages: ["analyze", "testplan", "execute", "triage", "fixer", "submit"] },
  });
}

async function runPipeline(
  repo: string,
  autoApprove = true,
  executor: Executor = new ScriptedExecutor(),
  plans?: string[],
) {
  const cfg = config(repo);
  const state = new JsonlStateStore(path.join(repo, ".argus", "state"));
  const runId = newRunId();
  const artifacts = new RunArtifacts(repo, runId, {
    run_id: runId,
    started_at: new Date().toISOString(),
    argus_version: "0.1.0",
    config_hash: "test",
    target_repo: repo,
    head: "",
  });
  const pipeline = new Pipeline(
    {
      config: cfg,
      configHash: "test",
      repoRoot: repo,
      runId,
      baseHead: git(repo, "rev-parse", "HEAD").trim(),
      state,
      artifacts,
      git: new Git(repo),
      redactor: new Redactor(),
      log: () => {},
    },
    { executor, github: null, autoApprove, plans },
  );
  const summary = await pipeline.run();
  return { cfg, state, runId, artifacts, executor, summary };
}

/* ------------------------------------------------------------------ */
/* Tests                                                                */
/* ------------------------------------------------------------------ */

describe("Pipeline (closed loop, hermetic)", () => {
  it("detects a seeded bug, fixes it, verifies, and stages the PR", async () => {
    const repo = makeRepo();
    try {
      const executor = new ScriptedExecutor();
      const { state, runId, summary, artifacts } = await runPipeline(repo, true, executor);

      // Every stage of the loop ran.
      expect(summary.status).toBe("completed");
      expect(summary.plansExecuted).toBe(1);
      expect(summary.failures).toBe(1);
      expect(summary.bugs).toHaveLength(1);
      expect(summary.bugs[0]?.severity).toBe("P1-High");
      expect(summary.bugs[0]?.fix_status).toBe("fixed");
      expect(summary.fixes).toHaveLength(1);
      expect(summary.prs[0]?.status).toBe("pending-local"); // no GitHub in test

      // The LLM was invoked once per stage, in order.
      expect(llmCalls.length).toBeGreaterThanOrEqual(5);
      expect(llmCalls.join(" ")).toMatch(/ANALYZE.*TEST PLAN.*TRIAGE.*FIXER.*SUBMIT/s);

      // The fix branch exists, carries one commit, and the worktree is fixed.
      const branch = "argus/BUG-001";
      expect(git(repo, "rev-parse", "--verify", branch).trim()).toHaveLength(40);
      const ahead = Number(
        git(repo, "rev-list", "--count", "main..argus/BUG-001").trim(),
      );
      expect(ahead).toBe(1);
      expect(readFileSync(path.join(repo, "src", "login.ts"), "utf8")).toBe(FIXED);
      const commitMsg = git(repo, "log", "-1", "--format=%s").trim();
      expect(commitMsg).toContain("BUG-001"); // submit amended the commit message

      // Executor ran the plan twice: the failing run + the verification re-run.
      expect(executor.calls).toEqual(["TP-001", "TP-001"]);

      // State store: bug lifecycle new → fixed; scenarios fail + verify pass.
      const bugs = state.bugs().filter((b) => b.run_id === runId);
      const lastBug = bugs[bugs.length - 1];
      expect(lastBug?.status).toBe("fixed");
      const scenarios = state
        .scenariosForPlan("TP-001")
        .filter((s) => s.run_id === runId);
      expect(scenarios.some((s) => s.status === "fail")).toBe(true);
      expect(state.scenariosForPlan("TP-001-verify").some((s) => s.status === "pass")).toBe(
        true,
      );

      // Artifacts: plan file, bug report, PR draft, summary.
      const planFile = path.join(repo, ".argus", "testplans", "TP-001.md");
      expect(existsSync(planFile)).toBe(true);
      const bugDir = artifacts.bugDir("BUG-001");
      expect(existsSync(path.join(bugDir, "bug-report.json"))).toBe(true);
      const pr = JSON.parse(
        readFileSync(path.join(bugDir, "pull-request.json"), "utf8"),
      ) as { branch: string; body: string };
      expect(pr.branch).toBe(branch);
      expect(pr.body).toContain("TP-001");
      const sum = JSON.parse(
        readFileSync(path.join(artifacts.dir, "summary.json"), "utf8"),
      ) as { status: string };
      expect(sum.status).toBe("completed");

      // Plans stay DRAFT (human approval is out of band in the MVP loop).
      const planStore = new PlanStore(path.join(repo, ".argus", "testplans"));
      const pf = planStore.get("TP-001");
      expect(pf?.plan.status).toBe("DRAFT");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("all-green run: no failures → triage/fixer/submit skipped, run completes", async () => {
    const repo = makeRepo();
    try {
      // Pre-seed an ACTIVE plan and use a passing executor (no failures).
      const store = new PlanStore(path.join(repo, ".argus", "testplans"));
      store.write({ ...PLAN, status: "ACTIVE" as const, id: "TP-001" });

      const passingExecutor: Executor = {
        async runScenario(plan) {
          return {
            plan_id: plan.id,
            status: "pass",
            steps: [],
            console_errors: [],
            network_failures: [],
            duration_ms: 1,
            started_at: new Date().toISOString(),
            artifacts: {},
          };
        },
      };
      const { state, summary } = await runPipeline(repo, true, passingExecutor);

      expect(summary.status).toBe("completed");
      expect(summary.failures).toBe(0);
      expect(summary.bugs).toHaveLength(0);
      expect(summary.fixes).toHaveLength(0);
      // triage/fixer/submit stages were skipped
      const stages = state
        .lastRuns(1)[0]
        ?.stages ?? [];
      expect(stages).toContain("triage");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("plans filter: executes only the requested plan ids, ignoring ACTIVE others", async () => {
    const repo = makeRepo();
    try {
      // Two ACTIVE plans; the testplan stage will skip creating TP-001
      // (id already known) so the store holds exactly TP-001 + TP-002.
      const store = new PlanStore(path.join(repo, ".argus", "testplans"));
      store.write({ ...PLAN, id: "TP-001" });
      store.write({ ...PLAN, id: "TP-002", title: "other active plan" });

      const executor = new ScriptedExecutor();
      const { state, runId, summary } = await runPipeline(repo, true, executor, [
        "TP-001",
      ]);

      expect(summary.status).toBe("completed");
      expect(summary.plansExecuted).toBe(1);
      // Only TP-001 was executed (and its verification re-run); the ACTIVE
      // TP-002 never reached the browser.
      expect(executor.calls).toEqual(["TP-001", "TP-001"]);
      const scenarios = state.scenariosForRun(runId);
      expect(scenarios.map((s) => s.plan_id)).toEqual([
        "TP-001",
        "TP-001-verify",
      ]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("plans filter: unknown ids are a hard error before any stage work", async () => {
    const repo = makeRepo();
    try {
      await expect(
        runPipeline(repo, true, new ScriptedExecutor(), ["TP-999"]),
      ).rejects.toThrow(/plan\(s\) not found: TP-999/);

      // The run is recorded as failed; the execute stage never completed, so
      // no scenario ran and no bug was triaged.
      const state = new JsonlStateStore(path.join(repo, ".argus", "state"));
      const recorded = state.lastRuns(1)[0];
      expect(recorded?.status).toBe("failed");
      expect(state.scenariosForRun(recorded!.run_id)).toEqual([]);
      expect(state.bugs()).toEqual([]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
