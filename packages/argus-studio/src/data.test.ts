import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  readState,
  readPlans,
  planHistories,
  projectSummary,
  runDetail,
  runProgress,
  resolveEvidence,
  verdictFor,
  openBugCount,
  planCoverage,
  type RunSummaryJson,
} from "./data.js";
import type { BugRecord, RunRecord } from "@argus/core";
import { makeFixtureRepo } from "./fixtures.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "argus-studio-data-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const run = (over: Partial<RunRecord> = {}): RunRecord => ({
  run_id: "run-1",
  started_at: "2026-10-27T00:00:00Z",
  status: "completed",
  target_repo: dir,
  head: "abc",
  config_hash: "h",
  stages: [],
  ...over,
});

const bug = (over: Partial<BugRecord> = {}): BugRecord => ({
  bug_id: "BUG-001",
  run_id: "run-1",
  plan_id: "TP-001",
  title: "t",
  severity: "P1",
  status: "new",
  created_at: "2026-10-27T00:00:00Z",
  ...over,
});

const summary = (over: Partial<RunSummaryJson> = {}): RunSummaryJson => ({
  run_id: "run-1",
  status: "completed",
  plans_executed: 1,
  failures: 0,
  bugs: [],
  prs: [],
  ...over,
});

describe("verdictFor", () => {
  it("is 'running' while the run is in flight", () => {
    expect(verdictFor(run({ status: "running" }), null, [])).toBe("running");
  });

  it("is 'fail' when the loop itself failed or was aborted", () => {
    expect(verdictFor(run({ status: "failed" }), null, [])).toBe("fail");
    expect(verdictFor(run({ status: "aborted" }), null, [])).toBe("fail");
  });

  it("is 'needs-attention' when failures remain", () => {
    expect(verdictFor(run(), summary({ failures: 2 }), [])).toBe("needs-attention");
  });

  it("is 'needs-attention' when open bugs remain", () => {
    expect(verdictFor(run(), summary(), [bug({ status: "confirmed" })])).toBe("needs-attention");
  });

  it("is 'pass' only when completed, no failures, and no open bugs", () => {
    expect(verdictFor(run(), summary(), [bug({ status: "fixed" }), bug({ status: "dismissed" })])).toBe(
      "pass",
    );
    expect(verdictFor(run(), null, [])).toBe("pass");
  });
});

describe("openBugCount", () => {
  it("counts new/confirmed/unverified and ignores fixed/dismissed", () => {
    const bugs = [
      bug({ bug_id: "1", status: "new" }),
      bug({ bug_id: "2", status: "confirmed" }),
      bug({ bug_id: "3", status: "unverified" }),
      bug({ bug_id: "4", status: "fixed" }),
      bug({ bug_id: "5", status: "dismissed" }),
    ];
    expect(openBugCount(bugs)).toBe(3);
  });
});

describe("readState (tolerant)", () => {
  it("reads all five state streams from a real fixture", () => {
    const { repo, runId } = makeFixtureRepo(dir);
    const s = readState(repo);
    expect(s.runs.map((r) => r.run_id)).toContain(runId);
    expect(s.stages.length).toBe(6);
    expect(s.scenarios.length).toBe(3);
    expect(s.bugs.length).toBe(1);
    expect(s.llmCalls.length).toBe(2);
  });

  it("skips a corrupt trailing line without dropping valid records", () => {
    const { repo } = makeFixtureRepo(dir);
    const file = path.join(repo, ".argus", "state", "llm-calls.jsonl");
    writeFileSync(file, "\n{garbage-partial", { flag: "a" });
    expect(readState(repo).llmCalls.length).toBe(2);
  });
});

describe("readPlans (tolerant)", () => {
  it("parses valid plans and skips corrupt ones", () => {
    const { repo } = makeFixtureRepo(dir);
    const plans = readPlans(repo);
    expect(plans.map((p) => p.id)).toEqual(["TP-001", "TP-002"]);
    const login = plans[0]!;
    expect(login.title).toBe("login works");
    expect(login.status).toBe("ACTIVE");
    expect(login.steps.length).toBe(2);
    expect(login.body).toContain("Narrative body about logging in.");
  });

  it("returns [] when no testplans dir exists", () => {
    const empty = path.join(dir, "empty");
    mkdirSync(empty, { recursive: true });
    expect(readPlans(empty)).toEqual([]);
  });
});

describe("planHistories", () => {
  it("excludes verify re-runs and tallies pass/fail per plan", () => {
    const { repo } = makeFixtureRepo(dir);
    const hist = planHistories(repo);
    const tp1 = hist.find((h) => h.plan_id === "TP-001")!;
    const tp2 = hist.find((h) => h.plan_id === "TP-002")!;
    expect(hist.map((h) => h.plan_id)).toEqual(["TP-001", "TP-002"]);
    expect(tp1.outcomes).toHaveLength(1);
    expect(tp1.pass).toBe(0);
    expect(tp1.fail).toBe(1);
    expect(tp2.pass).toBe(1);
    expect(tp2.fail).toBe(0);
  });
});

describe("projectSummary", () => {
  it("surfaces the live run as the latest (running) verdict", () => {
    const { repo, runIdRunning } = makeFixtureRepo(dir);
    const p = projectSummary("x", repo, readState(repo), readPlans(repo));
    expect(p.exists).toBe(true);
    expect(p.latest?.run_id).toBe(runIdRunning);
    expect(p.latest?.verdict).toBe("running");
    expect(p.runs_total).toBe(1); // only the terminal run
    expect(p.open_bugs).toBe(1);
    expect(p.bugs_total).toBe(1);
    expect(p.plans).toBe(2);
  });

  it("sparkline lists terminal verdicts, oldest → newest", () => {
    const { repo } = makeFixtureRepo(dir);
    const p = projectSummary("x", repo, readState(repo), readPlans(repo));
    expect(p.verdicts).toEqual(["needs-attention"]);
  });

  it("reports a gone path as exists=false", () => {
    const p = projectSummary("ghost", path.join(dir, "nope"), {
      runs: [],
      stages: [],
      scenarios: [],
      bugs: [],
      llmCalls: [],
    }, []);
    expect(p.exists).toBe(false);
    expect(p.latest).toBeNull();
  });
});

describe("runDetail", () => {
  it("joins stages, scenarios, bugs, llm, analyze, and testplan for one run", () => {
    const { repo, runId } = makeFixtureRepo(dir);
    const d = runDetail(repo, runId)!;
    expect(d.verdict).toBe("needs-attention");
    expect(d.run.run_id).toBe(runId);
    expect(d.stages.length).toBe(6);
    expect(d.scenarios.length).toBe(3);
    const failed = d.scenarios.find((s) => s.plan_id === "TP-001")!;
    expect(failed.status).toBe("fail");
    expect(failed.steps.length).toBe(2);
    expect(failed.console_errors).toContain("TypeError: x is undefined");
    expect(failed.has_evidence.screenshot).toBe(true);
    expect(failed.failed_step_screenshot).toBe("fail-S2.png");
    expect(d.bugs[0]!.report?.title).toBe("login button missing");
    expect(d.bugs[0]!.pull_request?.branch).toBe("argus/BUG-001");
    expect(d.llm_totals).toEqual({ calls: 2, prompt_tokens: 400, completion_tokens: 60, duration_ms: 1300 });
    expect(d.analyze.changed_files).toEqual(["app.js"]);
    expect(d.analyze.diff).toContain("diff --git");
    expect(d.testplan.created).toHaveLength(1);
    expect(d.argus_version).toBe("0.1.0");
  });

  it("returns null for an unknown run", () => {
    const { repo } = makeFixtureRepo(dir);
    expect(runDetail(repo, "run-does-not-exist")).toBeNull();
  });
});

describe("resolveEvidence", () => {
  let repoPath: string;
  let runId: string;
  beforeEach(() => {
    const f = makeFixtureRepo(dir);
    repoPath = f.repo;
    runId = f.runId;
  });

  it("resolves a whitelisted scenario screenshot", () => {
    const r = resolveEvidence(repoPath, runId, "TP-001", "screenshot.png");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(existsSync(r.file)).toBe(true);
      expect(r.file.endsWith(path.join("TP-001", "screenshot.png"))).toBe(true);
    }
  });

  it("allows the fail-<step>.png series", () => {
    const r = resolveEvidence(repoPath, runId, "TP-001", "fail-S2.png");
    expect(r.ok).toBe(true);
  });

  it("rejects non-whitelisted scenario files", () => {
    const r = resolveEvidence(repoPath, runId, "TP-001", "secret.txt");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(400);
  });

  it("rejects path traversal in the file param", () => {
    const r = resolveEvidence(repoPath, runId, "TP-001", "../../etc/passwd");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/traversal/);
  });

  it("rejects absolute paths", () => {
    const r = resolveEvidence(repoPath, runId, "TP-001", "/etc/passwd");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/traversal/);
  });

  it("rejects traversal in the scenario param", () => {
    const r = resolveEvidence(repoPath, runId, "..", "screenshot.png");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/traversal/);
  });

  it("resolves bug artifacts only from bug dirs", () => {
    const ok = resolveEvidence(repoPath, runId, "BUG-001", "bug-report.json");
    expect(ok.ok).toBe(true);
    const bad = resolveEvidence(repoPath, runId, "BUG-001", "evil.sh");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe(400);
  });

  it("404s for a whitelisted file that is absent", () => {
    const r = resolveEvidence(repoPath, runId, "TP-002", "video.webm");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(404);
  });

  it("404s for an unknown scenario", () => {
    const r = resolveEvidence(repoPath, runId, "TP-999", "screenshot.png");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(404);
  });
});

describe("planCoverage", () => {
  let repoPath: string;
  let runId: string;

  const load = () => ({
    runs: readState(repoPath).runs,
    plans: readPlans(repoPath),
  });

  const setImpact = (affected: unknown) =>
    writeFileSync(
      path.join(repoPath, ".argus", "runs", runId, "analyze", "impact.json"),
      JSON.stringify({ affected, test_focus: [] }),
    );

  beforeEach(() => {
    const f = makeFixtureRepo(dir);
    repoPath = f.repo;
    runId = f.runId;
  });

  it("covers impacted modules that have an ACTIVE plan (legacy string shape)", () => {
    // fixture impact is `affected: ["auth"]`; TP-001 (auth) is ACTIVE
    const cov = planCoverage(repoPath, load().runs, load().plans);
    expect(cov).not.toBeNull();
    expect(cov!.run_id).toBe(runId); // uses the terminal run, not the running one
    expect(cov!.modules).toBe(1);
    expect(cov!.covered).toEqual(["auth"]);
    expect(cov!.uncovered).toEqual([]);
  });

  it("flags impacted modules with no ACTIVE plan as uncovered (current shape)", () => {
    setImpact([
      { module: "auth", risk: "high" },
      { module: "billing", risk: "medium" },
    ]);
    const cov = planCoverage(repoPath, load().runs, load().plans);
    expect(cov).not.toBeNull();
    expect(cov!.modules).toBe(2);
    expect(cov!.covered).toEqual(["auth"]);
    expect(cov!.uncovered).toEqual([{ module: "billing", risk: "medium" }]);
  });

  it("returns null when no analyze artifact exists", () => {
    rmSync(path.join(repoPath, ".argus", "runs", runId, "analyze"), { recursive: true, force: true });
    const cov = planCoverage(repoPath, load().runs, load().plans);
    expect(cov).toBe(null);
  });
});

describe("runProgress", () => {
  let repoPath: string;
  let runId: string;
  let runIdRunning: string;

  beforeEach(() => {
    const f = makeFixtureRepo(dir);
    repoPath = f.repo;
    runId = f.runId;
    runIdRunning = f.runIdRunning;
  });

  it("marks the first unrecorded stage running for an in-flight run", () => {
    const p = runProgress(repoPath, runIdRunning, null);
    expect(p.run_id).toBe(runIdRunning);
    expect(p.status).toBe("running");
    expect(p.stages.map((s) => s.status)).toEqual([
      "running",
      "pending",
      "pending",
      "pending",
      "pending",
      "pending",
    ]);
    expect(p.progress).toBe(0);
    expect(p.elapsed_ms).toBeGreaterThanOrEqual(0);
  });

  it("reports full progress for a terminal run (done + skipped stages)", () => {
    const p = runProgress(repoPath, runId, null);
    expect(p.status).toBe("completed");
    expect(p.stages.map((s) => s.status)).toEqual(["done", "done", "done", "done", "skipped", "skipped"]);
    expect(p.progress).toBe(1);
    // duration carries over from the stage records
    const first = p.stages[0]!;
    expect(first).toBeDefined();
    expect(first.duration_ms).toBe(1000);
  });

  it("returns a defined shape for an unknown run", () => {
    const p = runProgress(repoPath, "run-nope", null);
    expect(p.status).toBe("unknown");
    expect(p.stages).toEqual([]);
    expect(p.progress).toBe(0);
    expect(p.log_tail).toEqual([]);
  });

  it("tolerates a corrupt trailing line in stages.jsonl", () => {
    const f = path.join(repoPath, ".argus", "state", "stages.jsonl");
    writeFileSync(f, readFileSync(f, "utf8") + "not-json\n", { flag: "a" });
    const p = runProgress(repoPath, runId, null);
    expect(p.progress).toBe(1); // still fully parsed
  });

  it("returns a tail of the per-run trigger log when present", () => {
    const logFile = path.join(dir, "trigger.log");
    const lines = Array.from({ length: 50 }, (_, i) => `line-${i + 1}`);
    writeFileSync(logFile, lines.join("\n") + "\n");
    const p = runProgress(repoPath, runId, logFile, 10);
    expect(p.log_file).toBe(logFile);
    expect(p.log_tail).toEqual(lines.slice(-10));
  });

  it("returns an empty tail when the log file is missing", () => {
    const p = runProgress(repoPath, runId, path.join(dir, "nope.log"));
    expect(p.log_tail).toEqual([]);
  });
});
