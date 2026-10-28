/**
 * Data layer — reads a target repo's `.argus/` workspace (state JSONL,
 * run artifacts, test plans) and shapes it for the studio API.
 *
 * All record types come from @argus/core (single source of truth for the
 * on-disk format). Reads are tolerant: a missing/corrupt artifact degrades
 * to a defined "unknown" shape instead of throwing, so the dashboard never
 * blanks out because one file is mid-write.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  JsonlStateStore,
  parsePlanFile,
  type BugRecord,
  type LlmCallRecord,
  type RunRecord,
  type ScenarioRecord,
  type StageRecord,
  type TestPlan,
} from "@argus/core";

/* ------------------------------------------------------------------ */
/* verdict model                                                       */
/* ------------------------------------------------------------------ */

export type Verdict = "pass" | "needs-attention" | "fail" | "running";

/** Bug statuses that still need a human or the fix loop. */
const OPEN_BUGS = new Set(["new", "confirmed", "unverified"]);

export interface RunSummaryJson {
  run_id: string;
  status: string;
  plans_executed: number;
  failures: number;
  bugs: unknown[];
  prs: Array<{ bug_id: string; branch: string; status: string; pr_url?: string }>;
}

/**
 * The honest verdict for a run (documented in docs/argus-studio.md):
 *  - running:           status is still `running`
 *  - fail:              status `failed` / `aborted` (the loop itself broke)
 *  - needs-attention:   completed, but failures remain or bugs are still open
 *  - pass:              completed, zero failures, no open bugs
 */
export function verdictFor(run: RunRecord, summary: RunSummaryJson | null, bugs: BugRecord[]): Verdict {
  if (run.status === "running") return "running";
  if (run.status === "failed" || run.status === "aborted") return "fail";
  const failures = summary?.failures ?? 0;
  const openBugs = bugs.filter((b) => OPEN_BUGS.has(b.status)).length;
  return failures > 0 || openBugs > 0 ? "needs-attention" : "pass";
}

export function openBugCount(bugs: BugRecord[]): number {
  return bugs.filter((b) => OPEN_BUGS.has(b.status)).length;
}

/* ------------------------------------------------------------------ */
/* tolerant JSON read                                                  */
/* ------------------------------------------------------------------ */

export function readJsonSafe<T>(file: string): T | null {
  try {
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null; // mid-write / corrupt — degrade, don't throw
  }
}

function readTextSafe(file: string): string | null {
  try {
    if (!existsSync(file)) return null;
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* state                                                               */
/* ------------------------------------------------------------------ */

export interface ArgusState {
  runs: RunRecord[];
  stages: StageRecord[];
  scenarios: ScenarioRecord[];
  bugs: BugRecord[];
  llmCalls: LlmCallRecord[];
}

/**
 * bugs.jsonl is append-only: every bug status change appends a fresh row
 * for the same bug_id (triage → confirmed → fixed …). Collapse to one row
 * per bug — latest status wins, first-appearance order — so counts, lists,
 * and the verdict reflect the bug's CURRENT state, not its history.
 */
export function currentBugs(all: BugRecord[]): BugRecord[] {
  const latest = new Map<string, BugRecord>();
  const order: string[] = [];
  for (const b of all) {
    if (!latest.has(b.bug_id)) order.push(b.bug_id);
    latest.set(b.bug_id, b);
  }
  return order.map((id) => latest.get(id)!);
}

export function readState(repoPath: string): ArgusState {
  const store = new JsonlStateStore(path.join(repoPath, ".argus", "state"));
  return {
    runs: store.lastRuns(1000),
    stages: readAll("stages"),
    scenarios: readAll("scenarios"),
    bugs: currentBugs(store.bugs()),
    llmCalls: readAll("llm-calls"),
  };
  function readAll<T>(kind: string): T[] {
    // JsonlStateStore has no public "all" reader for stages/scenarios/llm —
    // read the file directly, same format, same tolerance.
    const file = path.join(repoPath, ".argus", "state", `${kind}.jsonl`);
    if (!existsSync(file)) return [];
    const out: T[] = [];
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t) as T);
      } catch {
        // corrupt trailing line — skip
      }
    }
    return out;
  }
}

export interface PlanInfo {
  id: string;
  title: string;
  module: string;
  priority: string;
  status: string;
  tags: string[];
  spec_ref?: string;
  preconditions: string[];
  steps: TestPlan["steps"];
  body: string;
  file: string;
}

export function readPlans(repoPath: string): PlanInfo[] {
  const dir = path.join(repoPath, ".argus", "testplans");
  if (!existsSync(dir)) return [];
  const out: PlanInfo[] = [];
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".md")).sort()) {
    const file = path.join(dir, name);
    try {
      const f = parsePlanFile(file);
      out.push({
        id: f.plan.id,
        title: f.plan.title,
        module: f.plan.module,
        priority: f.plan.priority,
        status: f.plan.status,
        tags: f.plan.tags,
        spec_ref: f.plan.spec_ref,
        preconditions: f.plan.preconditions,
        steps: f.plan.steps,
        body: f.body,
        file,
      });
    } catch {
      // invalid / half-written plan — skip, never blank the whole list
    }
  }
  return out;
}

/** Per-plan history across runs — the flakiness/regression signal. */
export interface PlanHistory {
  plan_id: string;
  outcomes: Array<{ run_id: string; status: string; at: string }>;
  pass: number;
  fail: number;
}

export function planHistories(repoPath: string): PlanHistory[] {
  const { scenarios } = readState(repoPath);
  const byPlan = new Map<string, ScenarioRecord[]>();
  for (const s of scenarios) {
    if (s.plan_id.endsWith("-verify")) continue; // verify re-runs are not plan outcomes
    const arr = byPlan.get(s.plan_id) ?? [];
    arr.push(s);
    byPlan.set(s.plan_id, arr);
  }
  const out: PlanHistory[] = [];
  for (const [planId, recs] of byPlan) {
    const pass = recs.filter((r) => r.status === "pass").length;
    out.push({
      plan_id: planId,
      outcomes: recs
        .map((r) => ({ run_id: r.run_id, status: r.status, at: r.started_at }))
        .sort((a, b) => a.at.localeCompare(b.at)),
      pass,
      fail: recs.length - pass,
    });
  }
  return out.sort((a, b) => a.plan_id.localeCompare(b.plan_id));
}

/* ------------------------------------------------------------------ */
/* plan coverage                                                       */
/* ------------------------------------------------------------------ */

/**
 * Coverage of the latest analyze impact by ACTIVE plans: which impacted
 * modules have at least one ACTIVE plan, and which don't (the gap the
 * dashboard surfaces beside the verdict — spec behavior no active plan
 * exercises). Tolerates both impact shapes: the current
 * `affected: [{module, risk}]` and the legacy `affected: ["module"]`.
 */
export interface CoverageReport {
  run_id: string;
  modules: number;
  covered: string[];
  uncovered: Array<{ module: string; risk: string }>;
}

export function planCoverage(
  repoPath: string,
  runs: RunRecord[],
  plans: PlanInfo[],
): CoverageReport | null {
  const terminal = runs.filter((r) => r.status !== "running");
  for (let i = terminal.length - 1; i >= 0; i--) {
    const impact = readJsonSafe<{
      affected?: Array<{ module?: string; risk?: string } | string>;
    }>(path.join(repoPath, ".argus", "runs", terminal[i]!.run_id, "analyze", "impact.json"));
    if (!impact?.affected?.length) continue;
    const activeModules = new Set(plans.filter((p) => p.status === "ACTIVE").map((p) => p.module));
    const mods = impact.affected.map((a) =>
      typeof a === "string" ? { module: a, risk: "low" } : { module: a.module ?? "?", risk: a.risk ?? "low" },
    );
    return {
      run_id: terminal[i]!.run_id,
      modules: mods.length,
      covered: mods.filter((m) => activeModules.has(m.module)).map((m) => m.module),
      uncovered: mods.filter((m) => !activeModules.has(m.module)),
    };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* project summary                                                     */
/* ------------------------------------------------------------------ */

export interface ProjectSummary {
  name: string;
  path: string;
  exists: boolean;
  last_run_at: string | null;
  latest: {
    run_id: string;
    verdict: Verdict;
    status: string;
    started_at: string;
    head: string;
  } | null;
  runs_total: number;
  verdicts: Verdict[]; // last up to 10, oldest → newest (the sparkline)
  open_bugs: number;
  bugs_total: number;
  plans: number;
}

export function projectSummary(
  name: string,
  repoPath: string,
  state: ArgusState,
  plans: PlanInfo[],
): ProjectSummary {
  // runs.jsonl is append-only: each run appends a `running` row, then a
  // terminal row. The last row is therefore the freshest state of the most
  // recent run — a live run surfaces as `running` until it finishes.
  const runs = state.runs;
  const terminal = runs.filter((r) => r.status !== "running");
  const latestRun = runs.at(-1) ?? null;
  const summaryJson = latestRun ? readRunSummary(repoPath, latestRun.run_id) : null;
  const runBugs = latestRun ? state.bugs.filter((b) => b.run_id === latestRun.run_id) : [];
  const verdicts = terminal.slice(-10).map((r) =>
    verdictFor(r, readRunSummary(repoPath, r.run_id), state.bugs.filter((b) => b.run_id === r.run_id)),
  );
  return {
    name,
    path: repoPath,
    exists: existsSync(path.join(repoPath, ".argus")),
    last_run_at: latestRun?.started_at ?? null,
    latest: latestRun
      ? {
          run_id: latestRun.run_id,
          verdict: verdictFor(latestRun, summaryJson, runBugs),
          status: latestRun.status,
          started_at: latestRun.started_at,
          head: latestRun.head,
        }
      : null,
    runs_total: terminal.length,
    verdicts,
    open_bugs: openBugCount(state.bugs),
    bugs_total: state.bugs.length,
    plans: plans.length,
  };
}

function readRunSummary(repoPath: string, runId: string): RunSummaryJson | null {
  return readJsonSafe<RunSummaryJson>(path.join(repoPath, ".argus", "runs", runId, "summary.json"));
}

/* ------------------------------------------------------------------ */
/* run detail                                                          */
/* ------------------------------------------------------------------ */

export interface ScenarioDetail extends ScenarioRecord {
  steps: Array<{
    step_id: string;
    action: string;
    status: string;
    duration_ms: number;
    detail?: string;
  }>;
  console_errors: string[];
  network_failures: string[];
  has_evidence: {
    screenshot: boolean;
    video: boolean;
    trace: boolean;
    har: boolean;
    console: boolean;
  };
  failed_step_screenshot: string | null; // fail-<step>.png, if captured
}

export interface RunDetail {
  run: RunRecord;
  verdict: Verdict;
  summary: RunSummaryJson | null;
  stages: StageRecord[];
  scenarios: ScenarioDetail[];
  bugs: Array<BugRecord & { report: BugReportJson | null; pull_request: PullRequestJson | null }>;
  llm_calls: LlmCallRecord[];
  llm_totals: { calls: number; prompt_tokens: number; completion_tokens: number; duration_ms: number };
  analyze: {
    changed_files: string[];
    diff: string | null;
    impact: { summary?: string; affected?: unknown[]; test_focus?: string[] } | null;
  };
  testplan: { created: Array<{ id: string; title: string; file: string }>; notes: string | null };
  head: string;
  config_hash: string;
  argus_version?: string;
}

export interface BugReportJson {
  bug_id: string;
  plan_id: string;
  run_id: string;
  title: string;
  severity: string;
  component?: string;
  description: string;
  evidence: {
    screenshot?: string;
    video?: string;
    video_timestamp?: string;
    console_errors: string[];
    network_failures: string[];
    violated_contract?: string;
  };
  proposed_fix?: string;
}

export interface PullRequestJson {
  branch: string;
  title: string;
  body: string;
  commit_message: string;
  status: string;
  pr_url?: string;
}

export function runDetail(repoPath: string, runId: string): RunDetail | null {
  const state = readState(repoPath);
  const run = state.runs.filter((r) => r.run_id === runId && r.status !== "running").at(-1)
    ?? state.runs.find((r) => r.run_id === runId)
    ?? null;
  if (!run) return null;

  const runDir = path.join(repoPath, ".argus", "runs", runId);
  const runJson = readJsonSafe<{ argus_version?: string; head?: string; config_hash?: string }>(
    path.join(runDir, "run.json"),
  );
  const summary = readJsonSafe<RunSummaryJson>(path.join(runDir, "summary.json"));
  const bugs = state.bugs.filter((b) => b.run_id === runId);

  const impactFile = path.join(runDir, "analyze", "impact.json");
  const filesTxt = readTextSafe(path.join(runDir, "analyze", "files.txt"));
  const diffTxt = readTextSafe(path.join(runDir, "analyze", "diff.txt"));
  const testplanJson = readJsonSafe<{ created?: Array<{ id: string; title: string; file: string }>; notes?: string }>(
    path.join(runDir, "testplan", "created.json"),
  );

  const scenarios: ScenarioDetail[] = state.scenarios
    .filter((s) => s.run_id === runId)
    .map((s) => {
      const scDir = s.artifacts_dir;
      const result = readJsonSafe<{
        steps?: ScenarioDetail["steps"];
        console_errors?: string[];
        network_failures?: string[];
      }>(path.join(scDir, "result.json"));
      const failedStep = s.failed_step_id ? `fail-${s.failed_step_id}.png` : null;
      return {
        ...s,
        steps: result?.steps ?? [],
        console_errors: result?.console_errors ?? [],
        network_failures: result?.network_failures ?? [],
        has_evidence: {
          screenshot: existsSync(path.join(scDir, "screenshot.png")),
          video: existsSync(path.join(scDir, "video.webm")),
          trace: existsSync(path.join(scDir, "trace.zip")),
          har: existsSync(path.join(scDir, "network.har")),
          console: existsSync(path.join(scDir, "console.log")),
        },
        failed_step_screenshot: failedStep && existsSync(path.join(scDir, failedStep)) ? failedStep : null,
      };
    });

  const bugDetails = bugs.map((b) => ({
    ...b,
    report: readJsonSafe<BugReportJson>(path.join(runDir, "bugs", b.bug_id, "bug-report.json")),
    pull_request: readJsonSafe<PullRequestJson>(path.join(runDir, "bugs", b.bug_id, "pull-request.json")),
  }));

  const llm = state.llmCalls.filter((c) => c.run_id === runId);
  const llmTotals = llm.reduce(
    (acc, c) => ({
      calls: acc.calls + 1,
      prompt_tokens: acc.prompt_tokens + c.prompt_tokens,
      completion_tokens: acc.completion_tokens + c.completion_tokens,
      duration_ms: acc.duration_ms + c.duration_ms,
    }),
    { calls: 0, prompt_tokens: 0, completion_tokens: 0, duration_ms: 0 },
  );

  return {
    run,
    verdict: verdictFor(run, summary, bugs),
    summary,
    stages: state.stages.filter((s) => s.run_id === runId),
    scenarios,
    bugs: bugDetails,
    llm_calls: llm,
    llm_totals: llmTotals,
    analyze: {
      changed_files: filesTxt ? filesTxt.split("\n").filter(Boolean) : [],
      diff: diffTxt,
      impact: readJsonSafe(path.join(impactFile)),
    },
    testplan: {
      created: testplanJson?.created ?? [],
      notes: testplanJson?.notes ?? null,
    },
    head: runJson?.head ?? run.head,
    config_hash: runJson?.config_hash ?? run.config_hash,
    argus_version: runJson?.argus_version,
  };
}

/* ------------------------------------------------------------------ */
/* run progress — for the in-flight pipeline bar                       */
/* ------------------------------------------------------------------ */

export type ProgressStageStatus = "pending" | "running" | "done" | "skipped";

export interface ProgressStage {
  name: string;
  status: ProgressStageStatus;
  duration_ms?: number;
}

export interface RunProgress {
  run_id: string;
  /** Run status: running | completed | failed | aborted | unknown. */
  status: string;
  started_at: string;
  elapsed_ms: number;
  /** The ordered stage track this action will run, with per-stage status. */
  stages: ProgressStage[];
  /** 0..1 — finished stages over the track length. */
  progress: number;
  /** Last N lines of the per-run trigger log (for the live "what's happening"). */
  log_tail: string[];
  log_file: string | null;
}

/** Tolerant one-file JSONL read (same shape as the state reader). */
function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  const out: T[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as T);
    } catch {
      // corrupt / mid-write line — skip, never crash a progress poll
    }
  }
  return out;
}

function readLogTail(file: string | null, n: number): string[] {
  if (!file || !existsSync(file)) return [];
  try {
    const lines = readFileSync(file, "utf8").split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines.slice(-n);
  } catch {
    return [];
  }
}

/**
 * Progress snapshot for a run: the ordered stage track (from the run record —
 * exactly the stages this action will run), which stages have finished (from
 * the append-only stage records), and a tail of the trigger log. Light by
 * design — it reads only `runs.jsonl` + `stages.jsonl` + the log file, so it
 * is cheap enough for the 2 s progress poll.
 */
export function runProgress(
  repoPath: string,
  runId: string,
  logFile: string | null,
  lines = 30,
): RunProgress {
  const stateDir = path.join(repoPath, ".argus", "state");
  const runs = readJsonl<RunRecord>(path.join(stateDir, "runs.jsonl")).filter(
    (r) => r.run_id === runId,
  );
  const run = runs.at(-1) ?? null;
  const track: string[] = run?.stages ?? [];
  const done = new Map<string, { status: StageRecord["status"]; duration_ms?: number }>();
  for (const s of readJsonl<StageRecord>(path.join(stateDir, "stages.jsonl")).filter(
    (x) => x.run_id === runId,
  )) {
    done.set(s.stage, { status: s.status, duration_ms: s.duration_ms });
  }

  const status = run?.status ?? "unknown";
  const isRunning = status === "running";
  const firstOpen = track.findIndex((n) => !done.has(n));
  const stages: ProgressStage[] = track.map((name, i) => {
    const d = done.get(name);
    if (d) {
      return {
        name,
        status: d.status === "skipped" ? "skipped" : "done",
        duration_ms: d.duration_ms,
      };
    }
    return { name, status: isRunning && i === firstOpen ? "running" : "pending" };
  });

  const finished = stages.filter((s) => s.status === "done" || s.status === "skipped").length;
  const progress = track.length ? finished / track.length : 0;
  const startedAt = run?.started_at ?? "";
  const elapsed_ms = startedAt ? Math.max(0, Date.now() - Date.parse(startedAt)) : 0;

  return {
    run_id: runId,
    status,
    started_at: startedAt,
    elapsed_ms,
    stages,
    progress,
    log_tail: readLogTail(logFile, lines),
    log_file: logFile,
  };
}

/* ------------------------------------------------------------------ */
/* evidence (artifact) access — guarded                                */
/* ------------------------------------------------------------------ */

/**
 * Evidence filenames a scenario directory may expose. The server only ever
 * serves these, from the run's own scenario/bug dirs — anything else
 * (including `..`) is rejected by `resolveEvidence`.
 */
export const EVIDENCE_NAMES = new Set([
  "screenshot.png",
  "video.webm",
  "trace.zip",
  "network.har",
  "console.log",
  "result.json",
  "bug-report.json",
  "pull-request.json",
]);

export const EVIDENCE_CONTENT_TYPES: Record<string, string> = {
  "screenshot.png": "image/png",
  "video.webm": "video/webm",
  "trace.zip": "application/zip",
  "network.har": "application/json",
  "console.log": "text/plain; charset=utf-8",
  "result.json": "application/json",
  "bug-report.json": "application/json",
  "pull-request.json": "application/json",
};

/**
 * Resolve `scenario` + `file` to an absolute path inside the run directory.
 * Returns null (→ 404) or throws-safe `""` (→ 400) on traversal attempts.
 */
export function resolveEvidence(
  repoPath: string,
  runId: string,
  scenario: string,
  file: string,
): { ok: true; file: string } | { ok: false; code: 400 | 404; reason: string } {
  if (/\.\./.test(scenario) || /\.\./.test(file) || path.isAbsolute(scenario) || path.isAbsolute(file)) {
    return { ok: false, code: 400, reason: "path traversal rejected" };
  }
  // scenario: "TP-001" | "TP-001-verify" | "BUG-001" (bug dirs)
  if (!/^(TP-[0-9A-Za-z]+(-[0-9A-Za-z]+)?|BUG-\d{3,})$/.test(scenario)) {
    return { ok: false, code: 404, reason: "unknown scenario" };
  }
  if (scenario.startsWith("BUG-") && !EVIDENCE_NAMES.has(file)) {
    return { ok: false, code: 400, reason: "not a bug artifact" };
  }
  // scenarios allow the fail-<step>.png series too
  if (scenario.startsWith("TP-") && file !== "screenshot.png" && !EVIDENCE_NAMES.has(file) && !/^fail-.+\.png$/.test(file)) {
    return { ok: false, code: 400, reason: "not a scenario artifact" };
  }
  const runDir = path.resolve(repoPath, ".argus", "runs", runId);
  const target = path.resolve(
    runDir,
    scenario.startsWith("BUG-") ? path.join("bugs", scenario, file) : path.join("scenarios", scenario, file),
  );
  if (target !== runDir && !target.startsWith(runDir + path.sep)) {
    return { ok: false, code: 400, reason: "path traversal rejected" };
  }
  if (!existsSync(target)) return { ok: false, code: 404, reason: "no such artifact" };
  return { ok: true, file: target };
}
