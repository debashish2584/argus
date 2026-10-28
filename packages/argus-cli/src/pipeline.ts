/**
 * CLI → core bridge for the closed-loop commands (plan/run/triage/heal/
 * report/inspect). The CLI only assembles context, prints, and maps exit
 * codes; all behavior lives in @argus/core (testable hermetically).
 *
 * Command → stage mapping (documented in the command help):
 *   argus plan   → analyze + testplan        (drafts plans from the diff)
 *   argus run    → execute + triage          (runs plans, reports failures)
 *   argus heal   → all six stages            (full closed loop: … → fix → PR)
 *   argus fix    → fixer + submit            (repair an existing run's open bugs)
 *   argus triage → ad-hoc re-triage of an existing run's failures
 *   argus report → re-sends the email report for an existing run
 *   argus inspect→ prints run/bug/scenario state
 */
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import {
  AGENT_IDS,
  type AgentId,
  GitHub,
  type LlmCallContext,
  loadConfig,
  LlmClient,
  type ChatMessage,
  newRunId,
  Pipeline,
  type PipelineContext,
  type RunSummary,
  PlaywrightExecutor,
  Redactor,
  RunArtifacts,
  sendEmailReport,
  Git,
  JsonlStateStore,
  type RunRecord,
  type BugRecord,
  type ScenarioRecord,
  type ArgusConfig,
  ARGUS_VERSION,
  type ScenarioResult,
  type TestPlan,
  PlanStore,
  triageAgent,
} from "@argus/core";

export interface PipelineFlags {
  /** Target directory containing .argus/ (default cwd). */
  repo: string;
  /** Stages to run, in order (command-derived). */
  stages: AgentId[];
  /** Bypass human gates. */
  yes?: boolean;
  /** Restrict execution to these plan ids. */
  plans?: string[];
  /** Browser flags. */
  headful?: boolean;
  noVideo?: boolean;
  noTrace?: boolean;
  noHar?: boolean;
  /**
   * Explicit run id. The dashboard passes one (via `--run-id`) so it can
   * track exactly which run it spawned — e.g. to mark it `aborted` when
   * the operator stops the run.
   */
  runId?: string;
  /** Repair mode: the run whose OPEN bugs the fixer stage addresses. */
  repairRunId?: string;
  /** Severities the fixer stage addresses (default P0–P2). */
  allowedSeverities?: string[];
  /** DRAFT → ACTIVE for the plans this run created (dashboard Plan button). */
  activate?: boolean;
}

/** Valid severity ids (mirrors the triage schema enum). */
export const SEVERITIES = ["P0-Blocker", "P1-High", "P2-Medium", "P3-Low"] as const;

export function validateSeverities(sev: string[]): string[] {
  const bad = sev.filter((s) => !(SEVERITIES as readonly string[]).includes(s));
  if (bad.length > 0) {
    throw new Error(`invalid severity '${bad[0]}' (expected: ${SEVERITIES.join(", ")})`);
  }
  return [...new Set(sev)];
}

/** GitHub token ref — PRs stay local when unset (documented, not an error). */
export function githubFromEnv(): GitHub | null {
  const token = process.env["ARGUS_GITHUB_TOKEN"];
  if (!token) return null;
  return new GitHub({ token });
}

export async function executePipeline(
  flags: PipelineFlags,
): Promise<RunSummary> {
  const { config: loaded, configHash, root } = loadConfig(flags.repo);
  const config: ArgusConfig = {
    ...loaded,
    pipeline: { ...loaded.pipeline, stages: flags.stages },
  };
  const git = new Git(root);
  const baseHead = await git.head();
  const state = new JsonlStateStore(path.join(root, ".argus", "state"));
  const runId = flags.runId ?? newRunId();
  const artifacts = new RunArtifacts(root, runId, {
    run_id: runId,
    started_at: new Date().toISOString(),
    argus_version: ARGUS_VERSION,
    config_hash: configHash,
    target_repo: root,
    head: baseHead,
  });
  const redactor = new Redactor({
    extraPatterns: config.redact.patterns,
    envSecrets: config.redact.env_secrets,
  });
  const log = (line: string) => console.log(line);

  const ctx: PipelineContext = {
    config,
    configHash,
    repoRoot: root,
    runId,
    baseHead,
    repairRunId: flags.repairRunId,
    state,
    artifacts,
    git,
    redactor,
    log,
  };
  const pipeline = new Pipeline(ctx, {
    executor: new PlaywrightExecutor({
      headless: !flags.headful,
      recordVideo: !flags.noVideo,
      recordTrace: !flags.noTrace,
      recordHar: !flags.noHar,
      redact: (s) => redactor.run(s),
    }),
    github: githubFromEnv(),
    autoApprove: flags.yes,
    plans: flags.plans,
    allowedSeverities: flags.allowedSeverities,
  });

  const summary = await pipeline.run();
  printSummary(summary, artifacts.dir);
  if (flags.activate) {
    activateCreatedPlans(root, runId);
  }
  return summary;
}

/**
 * DRAFT → ACTIVE for every plan this run's testplan stage created (the
 * dashboard's Plan button wants the new plans to actually run on the next
 * Run — a draft is never executed). Plans that vanished or already had a
 * different status are left alone; activation is best-effort and logged,
 * never fatal.
 */
export function activateCreatedPlans(root: string, runId: string): number {
  const createdFile = path.join(root, ".argus", "runs", runId, "testplan", "created.json");
  if (!existsSync(createdFile)) return 0;
  let created: { id: string }[];
  try {
    created = (JSON.parse(readFileSync(createdFile, "utf8")) as {
      created?: { id: string }[];
    }).created ?? [];
  } catch {
    return 0; // mid-write / corrupt — the run already finished, don't fail the command
  }
  const store = new PlanStore(path.join(root, ".argus", "testplans"));
  let activated = 0;
  for (const c of created) {
    const pf = store.get(c.id);
    if (!pf) continue; // plan removed after creation
    if (pf.plan.status !== "DRAFT") continue; // never force a human's choice
    store.write({ ...pf.plan, status: "ACTIVE" }, pf.body);
    console.log(`  activated ${c.id} (DRAFT → ACTIVE)`);
    activated++;
  }
  return activated;
}

function printSummary(summary: RunSummary, artifactDir: string): void {
  console.log("");
  console.log(`run ${summary.runId}: ${summary.status}`);
  console.log(
    `  plans executed: ${summary.plansExecuted} (failures: ${summary.failures})`,
  );
  for (const b of summary.bugs) {
    console.log(`  ${b.bug_id} [${b.severity}] fix=${b.fix_status}`);
  }
  for (const p of summary.prs) {
    console.log(
      `  pr ${p.bug_id}: ${p.status}${p.pr_url ? ` ${p.pr_url}` : ""}`,
    );
  }
  if (summary.report.sent) {
    console.log(`  email report: sent${summary.report.detail ? ` (${summary.report.detail})` : ""}`);
  } else if (summary.report.detail) {
    console.log(`  email report: ${summary.report.detail}`);
  }
  console.log(`  artifacts: ${artifactDir}`);
}

/* ------------------------------------------------------------------ */
/* Standalone triage (ad-hoc; does not mutate state)                     */
/* ------------------------------------------------------------------ */

export interface TriageTarget {
  runId: string;
  scenario: ScenarioResult;
  plan: TestPlan;
}

/**
 * Find a run's failed scenarios (latest run by default) and pair each with
 * its plan. Used by `argus triage` to re-triage with a different
 * prompt/model without re-running the browser.
 */
export function collectTriageTargets(
  root: string,
  runId?: string,
): TriageTarget[] {
  const state = new JsonlStateStore(path.join(root, ".argus", "state"));
  const runs = state.lastRuns(100);
  const run = runId
    ? runs.find((r) => r.run_id === runId)
    : runs[runs.length - 1];
  if (!run) throw new Error("no runs found in state — nothing to triage");
  const planStore = new PlanStore(path.join(root, ".argus", "testplans"));
  const out: TriageTarget[] = [];
  for (const s of state
    .scenariosForRun(run.run_id)
    .filter((x) => x.status === "fail" || x.status === "error")) {
    const resultFile = path.join(s.artifacts_dir, "result.json");
    if (!existsSync(resultFile)) continue; // artifact dir was cleaned
    const scenario = JSON.parse(
      readFileSync(resultFile, "utf8"),
    ) as ScenarioResult;
    const pf = planStore.list().find((p) => p.plan.id === s.plan_id);
    if (!pf) continue; // plan was removed
    out.push({ runId: run.run_id, scenario, plan: pf.plan });
  }
  return out;
}

export async function triageTargets(
  root: string,
  targets: TriageTarget[],
  agentPrompt?: string,
): Promise<void> {
  const { config } = loadConfig(root);
  const state = new JsonlStateStore(path.join(root, ".argus", "state"));
  const redactor = new Redactor({
    extraPatterns: config.redact.patterns,
    envSecrets: config.redact.env_secrets,
  });
  const agentCfg = config.agents["triage"];
  const binding = agentCfg?.llm ?? config.llm;
  const client = new LlmClient(binding, {
    onCall: (entry) => state.recordLlmCall(entry),
  });
  const chat = (messages: ChatMessage[], ctx: LlmCallContext) =>
    client.chatWithFallback(messages, ctx);
  const log = (line: string) => console.log(line);

  for (const t of targets) {
    const report = await triageAgent(
      chat,
      log,
      { scenario: t.scenario, plan: t.plan, changedFiles: [] },
      { prompt: agentPrompt, repoRoot: root, runId: t.runId },
    );
    console.log(
      JSON.stringify(
        {
          plan_id: t.plan.id,
          failed_step: t.scenario.failed_step_id,
          title: redactor.run(report.title),
          severity: report.severity,
          component: report.component ?? null,
          violated_contract: redactor.run(report.violated_contract),
          description: redactor.run(report.description),
          proposed_fix: report.proposed_fix ? redactor.run(report.proposed_fix) : null,
        },
        null,
        2,
      ),
    );
  }
}

/* ------------------------------------------------------------------ */
/* Repair (argus fix)                                                   */
/* ------------------------------------------------------------------ */

/** Bug statuses the repair action still considers open. */
export const OPEN_BUG_STATUSES = ["new", "confirmed", "unverified"] as const;

/**
 * bugs.jsonl is append-only: every status change appends a fresh row for the
 * same bug_id. Collapse to one row per bug (last row wins) so counts and
 * open/closed decisions reflect the current status, not the history.
 */
export function currentBugs(state: JsonlStateStore): BugRecord[] {
  const latest = new Map<string, BugRecord>();
  for (const b of state.bugs()) latest.set(b.bug_id, b);
  return [...latest.values()];
}

/**
 * Resolve the run `argus fix` should repair: the explicit `--run` id if
 * given, otherwise the most recent run with at least one open bug. Returns
 * null when nothing is repairable (no open bugs anywhere).
 */
export function findRepairRun(
  root: string,
  runId?: string,
): string | null {
  const state = new JsonlStateStore(path.join(root, ".argus", "state"));
  const openRuns = new Set(
    currentBugs(state)
      .filter((b) => (OPEN_BUG_STATUSES as readonly string[]).includes(b.status))
      .map((b) => b.run_id),
  );
  if (openRuns.size === 0) return null;
  if (runId) {
    return openRuns.has(runId) ? runId : null;
  }
  // lastRuns is append-ordered (oldest first) — walk newest to oldest.
  for (const r of state.lastRuns(200).slice().reverse()) {
    if (openRuns.has(r.run_id)) return r.run_id;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Report re-send                                                       */
/* ------------------------------------------------------------------ */

/**
 * Re-send the email report for an existing run from its `summary.json`.
 * Returns {sent, detail} — never throws (reporting is never fatal).
 */
export async function resendReport(
  root: string,
  runId: string | undefined,
): Promise<{ sent: boolean; detail: string }> {
  const { config } = loadConfig(root);
  const email = config.report.email;
  if (!email) {
    return { sent: false, detail: "no report.email configured in .argus/config.yaml" };
  }
  const state = new JsonlStateStore(path.join(root, ".argus", "state"));
  const runs = state.lastRuns(100);
  const run = runId ? runs.find((r) => r.run_id === runId) : runs[runs.length - 1];
  if (!run) return { sent: false, detail: `run ${runId ?? "(latest)"} not found in state` };

  // Config-level checks before artifact-level ones: a report misconfiguration
  // should say so, not "summary not found".
  const emailAgents = Object.values(config.agents).filter(
    (a) => a.report?.type === "email",
  );
  if (emailAgents.length === 0) {
    return { sent: false, detail: "no agents configured with an email report sink" };
  }

  const summaryFile = path.join(root, ".argus", "runs", run.run_id, "summary.json");
  if (!existsSync(summaryFile)) {
    return { sent: false, detail: `${summaryFile} not found — nothing to report` };
  }
  const summary = JSON.parse(readFileSync(summaryFile, "utf8")) as RunSummary;
  const redactor = new Redactor({
    extraPatterns: config.redact.patterns,
    envSecrets: config.redact.env_secrets,
  });
  const body = redactor.run(
    [
      `Argus run ${summary.runId}`,
      `status: ${summary.status}`,
      `plans executed: ${summary.plansExecuted} (failures: ${summary.failures})`,
      ...summary.bugs.map((b) => `bug ${b.bug_id} [${b.severity}] fix=${b.fix_status}`),
      ...summary.prs.map((p) => `pr ${p.bug_id}: ${p.status}${p.pr_url ? ` ${p.pr_url}` : ""}`),
      `artifacts: ${path.join(root, ".argus", "runs", run.run_id)}`,
    ].join("\n"),
  );

  const failing = summary.failures > 0 || summary.status === "failed";
  const recipients = new Set<string>();
  for (const agentCfg of emailAgents) {
    if (agentCfg.report.on === "failure-only" && !failing) continue;
    for (const to of agentCfg.report.to) recipients.add(to);
  }
  if (recipients.size === 0) {
    return {
      sent: false,
      detail: failing
        ? "email-configured agents have no recipients"
        : "run did not fail — failure-only reports were not triggered",
    };
  }

  const res = await sendEmailReport({
    smtp: email.smtp,
    from: email.from,
    to: [...recipients],
    subject: `[argus] run ${summary.runId}: ${summary.status} (${summary.failures} failures, ${summary.bugs.length} bugs)`,
    text: body,
  });
  return { sent: res.sent, detail: res.detail };
}

/* ------------------------------------------------------------------ */
/* Inspect                                                              */
/* ------------------------------------------------------------------ */

export function inspect(
  root: string,
  runId?: string,
): { runs: RunRecord[]; bugs: BugRecord[]; scenarios: ScenarioRecord[] } {
  const state = new JsonlStateStore(path.join(root, ".argus", "state"));
  let runs = state.lastRuns(50);
  if (runId) runs = runs.filter((r) => r.run_id === runId);
  if (runId && runs.length === 0) throw new Error(`run ${runId} not found in state`);
  const bugs = state.bugs().filter(
    (b) => !runId || b.run_id === runId,
  );
  const scenarios = runId
    ? state.scenariosForRun(runId)
    : state
        .lastRuns(50)
        .flatMap((r) => state.scenariosForRun(r.run_id));
  return { runs, bugs, scenarios };
}

export function allStages(): AgentId[] {
  return [...AGENT_IDS];
}
