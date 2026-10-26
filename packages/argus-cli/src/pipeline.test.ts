import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GitHub, JsonlStateStore, PlanStore } from "@argus/core";
import {
  collectTriageTargets,
  githubFromEnv,
  inspect,
  resendReport,
} from "./pipeline.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "argus-cli-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A minimal valid config (the init template shape), with report/agent hooks. */
function writeConfig(opts: {
  email?: boolean;
  emailAgent?: boolean;
}): void {
  const report = opts.email
    ? `report:
  email:
    smtp: { host: 127.0.0.1, port: 1 }   # nothing listens here
    from: argus@test.local`
    : "report: {}";
  const agents = opts.emailAgent
    ? `agents:
  triage:
    report: { type: email, on: failure-only, to: [qa@test.local] }`
    : "agents: {}";
  mkdirSync(path.join(root, ".argus"), { recursive: true });
  writeFileSync(
    path.join(root, ".argus", "config.yaml"),
    `version: 1
target:
  repo: ${root}
  env: { APP_URL: http://localhost:1 }
  health: []
diff: { base: HEAD~1 }
llm:
  provider: custom
  base_url: http://127.0.0.1:1/v1
  model: test
  api_key: k
pipeline:
  stages: [analyze, testplan, execute, triage, fixer, submit]
  gates: { testplan: human }
  on_failure: fail-fast
${report}
${agents}
redact: { env_secrets: [] }
`,
    "utf8",
  );
}

function seedScenario(over: {
  runId: string;
  planId: string;
  status: "pass" | "fail" | "error";
  withResultFile?: boolean;
}): string {
  const artifactsDir = path.join(
    root,
    ".argus",
    "runs",
    over.runId,
    "scenarios",
    over.planId,
  );
  mkdirSync(artifactsDir, { recursive: true });
  if (over.withResultFile !== false) {
    // Shape of the pipeline's `result.json` (pass|fail only — harness errors
    // are recorded as `fail`; `error` is a state-store-only status).
    const result = {
      plan_id: over.planId,
      status: over.status === "error" ? "fail" : over.status,
      failed_step_id: over.status === "pass" ? undefined : "step-1",
      error: over.status === "pass" ? undefined : "boom",
      steps: [],
      console_errors: [],
      network_failures: [],
      duration_ms: 1,
      started_at: "2026-10-26T00:00:00Z",
      artifacts: {},
    };
    writeFileSync(
      path.join(artifactsDir, "result.json"),
      JSON.stringify(result),
      "utf8",
    );
  }
  return artifactsDir;
}

function recordRun(runId: string, status: "completed" | "failed"): void {
  new JsonlStateStore(path.join(root, ".argus", "state")).recordRun({
    run_id: runId,
    started_at: "2026-10-26T00:00:00Z",
    status,
    target_repo: root,
    head: "abc123",
    config_hash: "h",
    stages: ["execute"],
  });
}

/* ------------------------------------------------------------------ */

describe("githubFromEnv", () => {
  it("returns null without ARGUS_GITHUB_TOKEN (PRs stay local)", () => {
    const prev = process.env["ARGUS_GITHUB_TOKEN"];
    delete process.env["ARGUS_GITHUB_TOKEN"];
    try {
      expect(githubFromEnv()).toBeNull();
    } finally {
      if (prev !== undefined) process.env["ARGUS_GITHUB_TOKEN"] = prev;
    }
  });

  it("constructs a GitHub client when the token is set", () => {
    const prev = process.env["ARGUS_GITHUB_TOKEN"];
    process.env["ARGUS_GITHUB_TOKEN"] = "ghp_test";
    try {
      expect(githubFromEnv()).toBeInstanceOf(GitHub);
    } finally {
      if (prev !== undefined) process.env["ARGUS_GITHUB_TOKEN"] = prev;
      else delete process.env["ARGUS_GITHUB_TOKEN"];
    }
  });
});

/* ------------------------------------------------------------------ */

describe("collectTriageTargets", () => {
  it("pairs a run's fail+error scenarios with their plans; skips pass and missing plans", () => {
    writeConfig({});
    const store = new PlanStore(path.join(root, ".argus", "testplans"));
    const plan = {
      id: "TP-001",
      title: "a plan",
      module: "m",
      priority: "P2" as const,
      status: "ACTIVE" as const,
      tags: [],
      preconditions: [],
      narrative: "x",
      steps: [{ id: "s", action: "navigate" as const, url: "{{APP_URL}}/" }],
    };
    store.write(plan);
    store.write({ ...plan, id: "TP-003", title: "a passing plan" });

    recordRun("run-a", "completed");
    const state = new JsonlStateStore(path.join(root, ".argus", "state"));
    const dir1 = seedScenario({
      runId: "run-a",
      planId: "TP-001",
      status: "fail",
    });
    const dir2 = seedScenario({
      runId: "run-a",
      planId: "TP-002", // no plan file on disk → skipped
      status: "error",
    });
    const dir3 = seedScenario({
      runId: "run-a",
      planId: "TP-003", // passing → not a triage target
      status: "pass",
    });

    // The artifacts dir is under the scenario sink; the record points at it.
    state.recordScenario({
      run_id: "run-a",
      plan_id: "TP-001",
      status: "fail",
      failed_step_id: "step-1",
      duration_ms: 1,
      artifacts_dir: dir1,
      started_at: "t",
    });
    state.recordScenario({
      run_id: "run-a",
      plan_id: "TP-002",
      status: "error",
      duration_ms: 1,
      artifacts_dir: dir2,
      started_at: "t",
    });
    state.recordScenario({
      run_id: "run-a",
      plan_id: "TP-003",
      status: "pass",
      duration_ms: 1,
      artifacts_dir: dir3,
      started_at: "t",
    });

    const targets = collectTriageTargets(root, "run-a");
    expect(targets.map((t) => t.plan.id)).toEqual(["TP-001"]);
    expect(targets[0]?.scenario.status).toBe("fail");
  });

  it("defaults to the latest run", () => {
    writeConfig({});
    new PlanStore(path.join(root, ".argus", "testplans")).write({
      id: "TP-001",
      title: "a plan",
      module: "m",
      priority: "P2",
      status: "ACTIVE",
      tags: [],
      preconditions: [],
      narrative: "x",
      steps: [{ id: "s", action: "navigate", url: "{{APP_URL}}/" }],
    });
    recordRun("run-1", "completed");
    recordRun("run-2", "completed");
    const state = new JsonlStateStore(path.join(root, ".argus", "state"));
    state.recordScenario({
      run_id: "run-2",
      plan_id: "TP-001",
      status: "fail",
      duration_ms: 1,
      artifacts_dir: seedScenario({
        runId: "run-2",
        planId: "TP-001",
        status: "fail",
      }),
      started_at: "t",
    });
    const targets = collectTriageTargets(root);
    expect(targets.map((t) => t.runId)).toEqual(["run-2"]);
  });

  it("throws when there are no runs at all", () => {
    writeConfig({});
    expect(() => collectTriageTargets(root)).toThrowError(/no runs found/);
  });
});

/* ------------------------------------------------------------------ */

describe("resendReport", () => {
  it("is a no-op when report.email is not configured", async () => {
    writeConfig({});
    recordRun("run-1", "completed");
    const res = await resendReport(root, "run-1");
    expect(res.sent).toBe(false);
    expect(res.detail).toMatch(/no report\.email configured/);
  });

  it("is a no-op when no agent has an email report sink", async () => {
    writeConfig({ email: true });
    recordRun("run-1", "completed");
    const res = await resendReport(root, "run-1");
    expect(res.sent).toBe(false);
    expect(res.detail).toMatch(/no agents configured/);
  });

  it("is a no-op when the summary.json is missing", async () => {
    writeConfig({ email: true, emailAgent: true });
    recordRun("run-1", "completed");
    const res = await resendReport(root, "run-1");
    expect(res.sent).toBe(false);
    expect(res.detail).toMatch(/not found/);
  });

  it("sends (or reports the SMTP failure) for a real run", async () => {
    writeConfig({ email: true, emailAgent: true });
    recordRun("run-1", "completed");
    const runDir = path.join(root, ".argus", "runs", "run-1");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      path.join(runDir, "summary.json"),
      JSON.stringify({
        runId: "run-1",
        status: "completed",
        plansExecuted: 1,
        failures: 1,
        bugs: [{ bug_id: "BUG-001", severity: "P1-High", fix_status: "fixed" }],
        prs: [{ bug_id: "BUG-001", branch: "argus/BUG-001", status: "opened" }],
        report: { sent: false },
      }),
      "utf8",
    );
    // SMTP points at 127.0.0.1:1 — nothing listens, so the honest outcome is
    // {sent:false, detail} rather than a thrown error.
    const res = await resendReport(root, "run-1");
    expect(res.sent).toBe(false);
    expect(res.detail.length).toBeGreaterThan(0);
  }, 30_000);
});

/* ------------------------------------------------------------------ */

describe("inspect", () => {
  it("lists runs, bugs, and scenarios; filters by run id", () => {
    writeConfig({});
    recordRun("run-1", "completed");
    recordRun("run-2", "failed");
    const state = new JsonlStateStore(path.join(root, ".argus", "state"));
    for (const [runId, status] of [
      ["run-1", "pass"],
      ["run-1", "fail"],
      ["run-2", "fail"],
    ] as const) {
      state.recordScenario({
        run_id: runId,
        plan_id: "TP-001",
        status,
        duration_ms: 1,
        artifacts_dir: seedScenario({ runId, planId: "TP-001", status }),
        started_at: "t",
      });
    }
    state.recordBug({
      bug_id: "BUG-001",
      run_id: "run-1",
      plan_id: "TP-001",
      title: "boom",
      severity: "P1-High",
      status: "fixed",
      created_at: "t",
    });

    const all = inspect(root);
    expect(all.runs).toHaveLength(2);
    expect(all.bugs).toHaveLength(1);
    expect(all.scenarios).toHaveLength(3);

    const one = inspect(root, "run-1");
    expect(one.runs.map((r) => r.run_id)).toEqual(["run-1"]);
    expect(one.bugs).toHaveLength(1);
    expect(one.scenarios).toHaveLength(2);

    expect(() => inspect(root, "run-nope")).toThrowError(/not found/);
  });
});
