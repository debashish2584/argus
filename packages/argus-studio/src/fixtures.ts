/**
 * Test fixtures — fabricate a complete `.argus/` workspace (state JSONL +
 * run artifacts + test plans) in a temp directory. Used by the studio test
 * suites; not part of the shipped surface.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/** 1x1 red PNG (evidence files don't need to be real screenshots). */
export const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

export interface Fixture {
  repo: string;
  runId: string;
  runIdRunning: string;
}

export function makeFixtureRepo(dir: string, opts?: { includeRunning?: boolean }): Fixture {
  const argus = path.join(dir, ".argus");
  const runId = "run-20261027-000001";
  const runIdRunning = "run-20261027-120000";
  const mk = (rel: string) => {
    const p = path.join(argus, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    return p;
  };
  const write = (rel: string, content: string | Buffer) => {
    const p = mk(rel);
    writeFileSync(p, content);
  };

  write(
    "state/runs.jsonl",
    [
      // run 1 (terminal)
      {
        run_id: runId,
        started_at: "2026-10-27T00:00:00.000Z",
        ended_at: "2026-10-27T00:04:00.000Z",
        status: "completed",
        target_repo: dir,
        head: "abcdef1234567890abcdef1234567890abcdef12",
        config_hash: "deadbeefcafe1234",
        stages: ["analyze", "testplan", "execute", "triage", "fixer", "submit"],
      },
      // run 2 (still running, appended last)
      {
        run_id: runIdRunning,
        started_at: "2026-10-27T12:00:00.000Z",
        status: "running",
        target_repo: dir,
        head: "1234567890abcdef1234567890abcdef12345678",
        config_hash: "deadbeefcafe1234",
        stages: ["analyze", "testplan", "execute", "triage", "fixer", "submit"],
      },
    ]
      .filter((r) => opts?.includeRunning !== false)
      .map((r) => JSON.stringify(r))
      .join("\n") + "\n",
  );
  write(
    "state/stages.jsonl",
    [
      { run_id: runId, stage: "analyze", agent: "analyze", prompt_version: "default", provider: "openai", model: "gpt-x", status: "ok", duration_ms: 1000 },
      { run_id: runId, stage: "testplan", agent: "testplan", prompt_version: "default", provider: "openai", model: "gpt-x", status: "ok", duration_ms: 2000 },
      { run_id: runId, stage: "execute", agent: "execute", prompt_version: "none", provider: "none", model: "none", status: "ok", duration_ms: 3000 },
      { run_id: runId, stage: "triage", agent: "triage", prompt_version: "default", provider: "openai", model: "gpt-x", status: "ok", duration_ms: 500 },
      { run_id: runId, stage: "fixer", agent: "fixer", prompt_version: "default", provider: "openai", model: "gpt-x", status: "skipped", duration_ms: 0 },
      { run_id: runId, stage: "submit", agent: "submit", prompt_version: "default", provider: "openai", model: "gpt-x", status: "skipped", duration_ms: 0 },
    ]
      .map((s) => JSON.stringify(s))
      .join("\n") + "\n",
  );
  write(
    "state/scenarios.jsonl",
    [
      { run_id: runId, plan_id: "TP-001", status: "fail", failed_step_id: "S2", error: "expected button", duration_ms: 1200, artifacts_dir: path.join(argus, "runs", runId, "scenarios", "TP-001"), started_at: "2026-10-27T00:01:00.000Z" },
      { run_id: runId, plan_id: "TP-002", status: "pass", duration_ms: 800, artifacts_dir: path.join(argus, "runs", runId, "scenarios", "TP-002"), started_at: "2026-10-27T00:02:00.000Z" },
      { run_id: runId, plan_id: "TP-001-verify", status: "pass", duration_ms: 900, artifacts_dir: path.join(argus, "runs", runId, "scenarios", "TP-001-verify"), started_at: "2026-10-27T00:03:00.000Z" },
    ]
      .map((s) => JSON.stringify(s))
      .join("\n") + "\n",
  );
  write(
    "state/bugs.jsonl",
    [
      { bug_id: "BUG-001", run_id: runId, plan_id: "TP-001", title: "login button missing", severity: "P0-Blocker", status: "confirmed", created_at: "2026-10-27T00:02:30.000Z" },
    ].map((b) => JSON.stringify(b)).join("\n") + "\n",
  );
  write(
    "state/llm-calls.jsonl",
    [
      { ts: "2026-10-27T00:00:10.000Z", run_id: runId, agent: "analyze", purpose: "analyze", provider: "openai", model: "gpt-x", prompt_tokens: 100, completion_tokens: 20, duration_ms: 900, ok: true },
      { ts: "2026-10-27T00:02:40.000Z", run_id: runId, agent: "triage", purpose: "triage", provider: "openai", model: "gpt-x", prompt_tokens: 300, completion_tokens: 40, duration_ms: 400, ok: true },
    ]
      .map((c) => JSON.stringify(c))
      .join("\n") + "\n",
  );

  const runDir = path.join(argus, "runs", runId);
  write(
    `runs/${runId}/run.json`,
    JSON.stringify({ argus_version: "0.1.0", head: "abcdef1234567890abcdef1234567890abcdef12", config_hash: "deadbeefcafe1234" }),
  );
  write(
    `runs/${runId}/summary.json`,
    JSON.stringify({
      run_id: runId,
      status: "completed",
      plans_executed: 2,
      failures: 1,
      bugs: [{ bug_id: "BUG-001", severity: "P0", fix_status: "triaged" }],
      prs: [],
    }),
  );
  write(`runs/${runId}/analyze/impact.json`, JSON.stringify({ summary: "one file changed", affected: ["auth"], test_focus: ["login flow"] }));
  write(`runs/${runId}/analyze/diff.txt`, "diff --git a/app.js b/app.js\n-a\n+b\n");
  write(`runs/${runId}/analyze/files.txt`, "app.js\n");
  write(`runs/${runId}/testplan/created.json`, JSON.stringify({ created: [{ id: "TP-001", title: "login", file: ".argus/testplans/TP-001.md" }], notes: "drafted from diff" }));

  const sc = path.join(runDir, "scenarios", "TP-001");
  write(
    `runs/${runId}/scenarios/TP-001/result.json`,
    JSON.stringify({
      plan_id: "TP-001",
      status: "fail",
      failed_step_id: "S2",
      error: "expected button",
      steps: [
        { step_id: "S1", action: "navigate", status: "pass", duration_ms: 300 },
        { step_id: "S2", action: "click", status: "fail", error: "expected button", duration_ms: 500 },
      ],
      console_errors: ["TypeError: x is undefined"],
      network_failures: ["GET /api/session 500"],
      duration_ms: 1200,
      started_at: "2026-10-27T00:01:00.000Z",
      artifacts: { screenshot: path.join(sc, "screenshot.png") },
    }),
  );
  write(`runs/${runId}/scenarios/TP-001/screenshot.png`, TINY_PNG);
  write(`runs/${runId}/scenarios/TP-001/fail-S2.png`, TINY_PNG);
  write(`runs/${runId}/scenarios/TP-001/video.webm`, Buffer.from("webm-fake"));
  write(`runs/${runId}/scenarios/TP-001/trace.zip`, Buffer.from("zip-fake"));
  write(`runs/${runId}/scenarios/TP-001/network.har`, JSON.stringify({ version: "1.2" }));
  write(`runs/${runId}/scenarios/TP-001/console.log`, "console output\n");

  write(`runs/${runId}/scenarios/TP-002/result.json`, JSON.stringify({
    plan_id: "TP-002",
    status: "pass",
    steps: [{ step_id: "S1", action: "navigate", status: "pass", duration_ms: 400 }],
    console_errors: [],
    network_failures: [],
    duration_ms: 800,
    started_at: "2026-10-27T00:02:00.000Z",
    artifacts: {},
  }));
  write(`runs/${runId}/scenarios/TP-002/screenshot.png`, TINY_PNG);

  write(
    `runs/${runId}/bugs/BUG-001/bug-report.json`,
    JSON.stringify({
      bug_id: "BUG-001",
      plan_id: "TP-001",
      run_id: runId,
      title: "login button missing",
      severity: "P0",
      component: "auth",
      description: "the login button never renders",
      evidence: {
        screenshot: path.join(sc, "screenshot.png"),
        video: path.join(sc, "video.webm"),
        console_errors: ["TypeError: x is undefined"],
        network_failures: ["GET /api/session 500"],
        violated_contract: "login page must render #login",
      },
      proposed_fix: "render the button",
    }),
  );
  write(
    `runs/${runId}/bugs/BUG-001/pull-request.json`,
    JSON.stringify({
      branch: "argus/BUG-001",
      title: "fix: login button",
      body: "body",
      commit_message: "fix: render login button",
      status: "pending-local",
    }),
  );

  write(
    "testplans/TP-001-login.md",
    [
      "---",
      'id: "TP-001"',
      "title: login works",
      "module: auth",
      "priority: P0",
      "status: ACTIVE",
      "tags: [smoke]",
      "spec_ref: SPEC-1",
      "preconditions: [registered user]",
      "narrative: \"\"",
      "steps:",
      "  - id: S1",
      "    action: navigate",
      "    url: /",
      "  - id: S2",
      "    action: click",
      "    target:",
      "      role: button",
      "      name: login",
      "---",
      "Narrative body about logging in.",
    ].join("\n"),
  );
  write(
    "testplans/TP-002-checkout.md",
    [
      "---",
      'id: "TP-002"',
      "title: checkout works",
      "module: shop",
      "priority: P1",
      "status: DRAFT",
      "tags: []",
      "preconditions: [items in cart]",
      "narrative: \"\"",
      "steps:",
      "  - id: S1",
      "    action: navigate",
      "    url: /cart",
      "---",
      "Narrative about checkout.",
    ].join("\n"),
  );
  // a corrupt plan — must be tolerated, not fatal
  write("testplans/TP-999-broken.md", "---\nid: \"TP-999\"\nbroken: [unclosed\n");

  return { repo: dir, runId, runIdRunning };
}
