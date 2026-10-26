/**
 * The sequential closed-loop pipeline runner.
 *
 *   analyze → testplan → execute → triage → fix → submit
 *
 * Design notes:
 *  - **Sequential by design (MVP).** Parallel execution is a post-MVP
 *    feature (docs/post-mvp-roadmap.md §2); the JSONL state store is
 *    single-writer for exactly this reason.
 *  - **on_failure governs the per-bug loop**: `fail-fast` stops the
 *    fix/submit loop on the first bug that cannot be fixed or verified;
 *    `continue-to-triage` records it and moves to the next bug. Scenario
 *    failures *always* feed triage — that is the core loop, not a failure.
 *    A hard stage error (LLM down, unparseable output) aborts the run
 *    regardless of on_failure.
 *  - **Gates** (`pipeline.gates`) run after a stage: `human` requires an
 *    interactive confirmation unless autoApprove is set; `verify-then-pr`
 *    is enforced structurally — no PR is ever opened before the failed
 *    plan re-runs green in the fix stage's verification step.
 *  - **Evidence everywhere.** Every stage writes its machine-readable
 *    output to the run artifact dir; every bug gets its own dir.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { LlmClient, type ChatMessage, type LlmCallContext, type LlmResult } from "../llm/client.js";
import type { AgentConfig, ArgusConfig, BugReport, TestPlan } from "../config/schema.js";
import { AgentConfigSchema } from "../config/schema.js";
import { PipelineError } from "../errors.js";
import { Git } from "../git.js";
import { GitHub, repoFromRemoteUrl, type PullRequestRef } from "../github.js";
import { gitCodeSource, type CodeSourceResult } from "../adapters/code-source.js";
import { ARGUS_VERSION } from "../hook.js";
import { loadSpecs, type SpecDoc } from "../adapters/spec-source.js";
import { renderTemplate } from "../template.js";
import { PlanStore } from "../plan/store.js";
import type { StateStore, BugRecord } from "../storage/state.js";
import type { RunArtifacts } from "../storage/artifacts.js";
import { Redactor } from "../redact.js";
import { analyzeAgent, type ImpactReport } from "../agents/analyze.js";
import { testplanAgent } from "../agents/testplan.js";
import { triageAgent } from "../agents/triage.js";
import {
  assertPatchAllowed,
  fixerAgent,
  type FixProposal,
} from "../agents/fixer.js";
import { submitAgent } from "../agents/submit.js";
import { sendEmailReport } from "../report/email.js";
import type { Executor, ScenarioResult } from "../execute/types.js";

export interface PipelineContext {
  config: ArgusConfig;
  configHash: string;
  /** Target repo root (where .argus/ lives). */
  repoRoot: string;
  runId: string;
  /** SHA the run started from (fix branches are cut from here). */
  baseHead: string;
  state: StateStore;
  artifacts: RunArtifacts;
  git: Git;
  redactor: Redactor;
  log: (line: string) => void;
}

export interface PipelineDeps {
  executor: Executor;
  /** GitHub access for the submit stage; null = PRs stay local (documented). */
  github: GitHub | null;
  /** Bypass `human` gates (CI / --yes). */
  autoApprove?: boolean;
  /**
   * Restrict the execute stage to these plan ids (regardless of status).
   * Unknown ids are a hard error. Used by `argus run --plan TP-001`.
   */
  plans?: string[];
}

export interface AppliedFix {
  bug: BugRecord;
  bugReport: BugReport;
  branch: string;
  files: string[];
  proposal: FixProposal;
  verification: ScenarioResult;
}

export interface RunSummary {
  runId: string;
  status: "completed" | "failed";
  plansExecuted: number;
  failures: number;
  bugs: Array<{ bug_id: string; severity: string; fix_status: string }>;
  fixes: AppliedFix[];
  prs: Array<{ bug_id: string; branch: string; status: string; pr_url?: string }>;
  report: { sent: boolean; detail?: string };
}

type Chat = (messages: ChatMessage[], ctx: LlmCallContext) => Promise<LlmResult>;

/** Defaults for agents that have no per-agent config block. */
const EMPTY_AGENT: AgentConfig = AgentConfigSchema.parse({});

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

function nextBugId(existing: BugRecord[]): string {
  let max = 0;
  for (const b of existing) {
    const m = b.bug_id.match(/^BUG-(\d+)$/);
    if (m) max = Math.max(max, Number(m[1] as string));
  }
  return `BUG-${String(max + 1).padStart(3, "0")}`;
}

async function confirmGate(
  log: (l: string) => void,
  stage: string,
  detail: string,
  autoApprove?: boolean,
): Promise<void> {
  if (autoApprove) {
    log(`  gate ${stage}: auto-approved (--yes / CI)`);
    return;
  }
  if (!process.stdin.isTTY) {
    throw new PipelineError(
      `human gate at stage '${stage}' requires interactive approval (run in a TTY) ` +
        "or pass --yes / autoApprove in CI. Aborting.",
    );
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (
    await rl.question(`\n[gate:${stage}] ${detail}\nProceed? [y/N] `)
  ).trim();
  rl.close();
  if (!/^y(es)?$/i.test(answer)) {
    throw new PipelineError(`gate '${stage}' denied by operator — run aborted`);
  }
}

/** Per-scenario log excerpt, used as before/after evidence in the PR. */
function scenarioLog(res: ScenarioResult, planTitle: string): string {
  const lines = [
    `plan: ${res.plan_id} — ${planTitle}`,
    `result: ${res.status}${res.error ? ` (${res.error})` : ""}`,
    ...res.steps.map(
      (s) =>
        `  ${s.status === "pass" ? "✓" : s.status === "fail" ? "✗" : "–"} ${s.step_id}${s.error ? ` — ${s.error}` : ""}`,
    ),
  ];
  if (res.console_errors.length > 0) {
    lines.push("console errors:");
    lines.push(
      ...res.console_errors.slice(0, 10).map((c) => `  - ${c.slice(0, 300)}`),
    );
  }
  if (res.network_failures.length > 0) {
    lines.push("network failures:");
    lines.push(
      ...res.network_failures.slice(0, 10).map((c) => `  - ${c.slice(0, 300)}`),
    );
  }
  return lines.join("\n");
}

const CONTEXT_FILE_MAX = 12;
const CONTEXT_FILE_MAX_CHARS = 24_000;

/** Candidate source files for the fixer: triage component + changed files. */
function collectFixerContext(
  repoRoot: string,
  component: string | undefined,
  diffFiles: string[],
): Array<{ path: string; content: string }> {
  const seen = new Set<string>();
  const out: Array<{ path: string; content: string }> = [];
  for (const rel of [component, ...diffFiles]) {
    if (!rel || seen.has(rel) || out.length >= CONTEXT_FILE_MAX) continue;
    seen.add(rel);
    const abs = path.join(repoRoot, rel);
    if (!existsSync(abs)) continue;
    try {
      const content = readFileSync(abs, "utf8");
      if (content.length === 0) continue;
      out.push({ path: rel, content: content.slice(0, CONTEXT_FILE_MAX_CHARS) });
    } catch {
      // binary or unreadable — skip
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Pipeline                                                             */
/* ------------------------------------------------------------------ */

export class Pipeline {
  constructor(
    private ctx: PipelineContext,
    private deps: PipelineDeps,
  ) {}

  /**
   * Run the configured stages in order. Returns a summary on success;
   * throws PipelineError when a hard failure aborts the run (the run record
   * is still written as `failed` before the throw).
   */
  async run(): Promise<RunSummary> {
    const { config, state, artifacts, git, runId, log } = this.ctx;
    const stages = config.pipeline.stages;
    const startedAt = new Date().toISOString();

    state.recordRun({
      run_id: runId,
      started_at: startedAt,
      status: "running",
      target_repo: this.ctx.repoRoot,
      head: this.ctx.baseHead,
      config_hash: this.ctx.configHash,
      stages,
    });

    const summary: RunSummary = {
      runId,
      status: "completed",
      plansExecuted: 0,
      failures: 0,
      bugs: [],
      fixes: [],
      prs: [],
      report: { sent: false },
    };

    const planStore = new PlanStore(path.join(this.ctx.repoRoot, ".argus", "testplans"));
    const createdThisRun = new Set<string>();
    const failures: Array<{ plan: TestPlan; result: ScenarioResult }> = [];

    let impact: ImpactReport | null = null;
    let specs: SpecDoc[] = [];
    let diffFiles: string[] = [];

    try {
      for (const stage of stages) {
        log(`\n▶ stage: ${stage}`);
        const agentCfg = config.agents[stage] ?? EMPTY_AGENT;
        const started = Date.now();
        let status: "ok" | "failed" | "skipped" = "ok";
        let detail = "";

        try {
          switch (stage) {
            case "analyze": {
              const code: CodeSourceResult = await gitCodeSource(
                git,
                agentCfg.inputs?.code_source?.base ?? config.diff.base,
              );
              diffFiles = code.files;
              specs = await loadSpecs(
                this.ctx.repoRoot,
                agentCfg.inputs?.spec_source ?? { type: "git-md", paths: ["docs/**/*.md"] },
                { argus_version: ARGUS_VERSION, run_id: runId, agent: "analyze" },
              );
              const existing = planStore.list().map((p) => p.plan);
              impact = await this.withChat(agentCfg, (chat) =>
                analyzeAgent(chat, log, { diff: code, specs, existingPlans: existing }, {
                  prompt: agentCfg.prompt,
                  repoRoot: this.ctx.repoRoot,
                  runId,
                }),
              );
              const dir = mkdir(artifacts.dir, "analyze");
              artifacts.writeJson(dir, "impact.json", impact);
              artifacts.writeText(dir, "diff.txt", code.diff);
              artifacts.writeText(dir, "files.txt", code.files.join("\n") + "\n");
              detail = `${code.files.length} changed files, ${specs.length} specs`;
              break;
            }

            case "testplan": {
              if (!impact) throw new PipelineError("testplan ran without an analyze stage");
              const imp = impact;
              const result = await this.withChat(agentCfg, (chat) =>
                testplanAgent(
                  chat,
                  log,
                  planStore,
                  {
                    impact: imp,
                    specs: specs.map((s) => ({ title: s.title, ref: s.ref, content: s.content })),
                    existing: planStore.list(),
                    envVars: config.target.env,
                  },
                  {
                    prompt: agentCfg.prompt,
                    repoRoot: this.ctx.repoRoot,
                    plansDir: path.join(this.ctx.repoRoot, ".argus", "testplans"),
                    runId,
                  },
                ),
              );
              for (const c of result.created) createdThisRun.add(c.id);
              const dir = mkdir(artifacts.dir, "testplan");
              artifacts.writeJson(dir, "created.json", result);
              detail = `${result.created.length} plans created (DRAFT)`;
              // The testplan gate is human by default: plans are the fixer's
              // ground truth, so a human signs off before execution. `auto`
              // skips the prompt (CI); `verify-then-pr` defers approval to
              // the PR review (the plan is still executed this run).
              const gate = config.pipeline.gates["testplan"] ?? "human";
              if (gate === "human") {
                await confirmGate(
                  log,
                  "testplan",
                  `testplan produced:\n${result.created
                    .map((c) => `  - ${c.id} ${c.title} (${c.file})`)
                    .join("\n") || "  (no new plans)"}`,
                  this.deps.autoApprove,
                );
              } else {
                log(`  gate testplan: ${gate} — no interactive prompt`);
              }
              break;
            }

            case "execute": {
              await this.checkHealth();
              const all = planStore.list();
              const requested =
                this.deps.plans && this.deps.plans.length > 0
                  ? this.deps.plans
                  : null;
              const plans = requested
                ? all.filter((p) => requested!.includes(p.plan.id))
                : all.filter(
                    (p) =>
                      p.plan.status === "ACTIVE" || createdThisRun.has(p.plan.id),
                  );
              if (requested) {
                const missing = requested.filter(
                  (id) => !all.some((p) => p.plan.id === id),
                );
                if (missing.length > 0) {
                  throw new PipelineError(
                    `plan(s) not found: ${missing.join(", ")}`,
                  );
                }
              }
              if (plans.length === 0) {
                status = "skipped";
                detail = requested
                  ? "none of the requested plans matched"
                  : "no ACTIVE plans and none created this run";
                break;
              }
              log(`  executing ${plans.length} plan(s)…`);
              const env = config.target.env;
              for (const pf of plans) {
                const t0 = Date.now();
                const sinkDir = artifacts.scenarioDir(pf.plan.id);
                let res: ScenarioResult;
                try {
                  res = await this.deps.executor.runScenario(pf.plan, env, { dir: sinkDir });
                } catch (e) {
                  // Harness-level failure (browser crash, app down mid-run).
                  res = {
                    plan_id: pf.plan.id,
                    status: "fail",
                    error: `harness error: ${(e as Error).message}`,
                    steps: [],
                    console_errors: [],
                    network_failures: [],
                    duration_ms: 0,
                    started_at: new Date(t0).toISOString(),
                    artifacts: {},
                  };
                }
                if (res.duration_ms === 0) res.duration_ms = Date.now() - t0;
                state.recordScenario({
                  run_id: runId,
                  plan_id: pf.plan.id,
                  status: res.status,
                  failed_step_id: res.failed_step_id,
                  error: res.error,
                  duration_ms: res.duration_ms,
                  artifacts_dir: sinkDir,
                  started_at: res.started_at,
                });
                artifacts.writeJson(sinkDir, "result.json", res);
                if (res.status === "fail") failures.push({ plan: pf.plan, result: res });
                log(
                  `  ${res.status === "pass" ? "✓" : "✗"} ${pf.plan.id} (${res.duration_ms}ms)` +
                    (res.error ? ` — ${res.error.slice(0, 200)}` : ""),
                );
              }
              summary.plansExecuted = plans.length;
              summary.failures = failures.length;
              detail = `${plans.length} executed, ${failures.length} failed`;
              break;
            }

            case "triage": {
              if (failures.length === 0) {
                status = "skipped";
                detail = "no failures to triage";
                break;
              }
              for (const f of failures) {
                const report = await this.withChat(agentCfg, (chat) =>
                  triageAgent(chat, log, {
                    scenario: f.result,
                    plan: f.plan,
                    changedFiles: diffFiles,
                  }, {
                    prompt: agentCfg.prompt,
                    repoRoot: this.ctx.repoRoot,
                    runId,
                  }),
                );
                const bugId = nextBugId(state.bugs());
                const bugReport: BugReport = {
                  bug_id: bugId,
                  plan_id: f.plan.id,
                  run_id: runId,
                  title: this.ctx.redactor.run(report.title),
                  severity: report.severity,
                  component: report.component,
                  description: this.ctx.redactor.run(report.description),
                  evidence: {
                    screenshot: f.result.artifacts.screenshot,
                    video: f.result.artifacts.video,
                    console_errors: f.result.console_errors.map((c) =>
                      this.ctx.redactor.run(c),
                    ),
                    network_failures: f.result.network_failures.map((c) =>
                      this.ctx.redactor.run(c),
                    ),
                    violated_contract: report.violated_contract,
                  },
                  proposed_fix: report.proposed_fix,
                };
                state.recordBug({
                  bug_id: bugId,
                  run_id: runId,
                  plan_id: f.plan.id,
                  title: bugReport.title,
                  severity: bugReport.severity,
                  status: "new",
                  created_at: new Date().toISOString(),
                });
                const dir = artifacts.bugDir(bugId);
                artifacts.writeJson(dir, "bug-report.json", bugReport);
                artifacts.writeJson(dir, "scenario-result.json", f.result);
                log(`  ${bugId} [${report.severity}] ${bugReport.title}`);
                summary.bugs.push({
                  bug_id: bugId,
                  severity: report.severity,
                  fix_status: "triaged",
                });
              }
              detail = `${failures.length} failures triaged`;
              break;
            }

            case "fixer": {
              const triaged = state.bugs().filter((b) => b.run_id === runId);
              const fixable = triaged.filter((b) =>
                ["P0-Blocker", "P1-High", "P2-Medium"].includes(b.severity),
              );
              if (fixable.length === 0) {
                status = failures.length === 0 ? "skipped" : "ok";
                detail =
                  failures.length === 0
                    ? "no bugs to fix"
                    : "no P0–P2 bugs to fix (P3s left for humans)";
                break;
              }
              await this.runFixLoop(fixable, failures, summary, agentCfg);
              detail = `${summary.fixes.length}/${fixable.length} fixes verified`;
              break;
            }

            case "submit": {
              if (summary.fixes.length === 0) {
                status = "skipped";
                detail = "no verified fixes to submit";
                break;
              }
              await this.runSubmitLoop(summary, agentCfg);
              detail = `${summary.prs.filter((p) => p.status === "opened").length} PR(s) opened`;
              break;
            }

            default:
              throw new PipelineError(`unknown stage '${stage}'`);
          }
        } catch (e) {
          status = "failed";
          detail = (e as Error).message;
          log(`  ✗ stage ${stage} failed: ${detail}`);
          // Hard failures always abort; on_failure only relaxes the per-bug
          // fix/submit loop (see module docs). Gates are operator decisions —
          // a denied gate is an abort, not a "next bug".
          const isGateDenial = e instanceof PipelineError && /denied|interactive approval/.test(detail);
          const continueOk =
            config.pipeline.on_failure === "continue-to-triage" &&
            (stage === "fixer" || stage === "submit") &&
            !isGateDenial;
          if (!continueOk) {
            throw new PipelineError(`stage '${stage}' failed: ${detail}`);
          }
        }

        state.recordStage({
          run_id: runId,
          stage,
          agent: stage,
          prompt_version: config.agents[stage]?.prompt ?? "default",
          provider: config.llm.provider,
          model: config.agents[stage]?.llm?.model ?? config.llm.model,
          status,
          started_at: new Date(started).toISOString(),
          ended_at: new Date().toISOString(),
          duration_ms: Date.now() - started,
          detail,
        });
        if (status === "ok") log(`  stage ${stage}: done — ${detail}`);
      }

      summary.report = await this.sendReports(summary);
    } catch (e) {
      summary.status = "failed";
      state.recordRun({
        run_id: runId,
        started_at: startedAt,
        ended_at: new Date().toISOString(),
        status: "failed",
        target_repo: this.ctx.repoRoot,
        head: this.ctx.baseHead,
        config_hash: this.ctx.configHash,
        stages,
      });
      throw e;
    }

    state.recordRun({
      run_id: runId,
      started_at: startedAt,
      ended_at: new Date().toISOString(),
      status: "completed",
      target_repo: this.ctx.repoRoot,
      head: this.ctx.baseHead,
      config_hash: this.ctx.configHash,
      stages,
    });
    artifacts.writeJson(artifacts.dir, "summary.json", {
      run_id: runId,
      status: summary.status,
      plans_executed: summary.plansExecuted,
      failures: summary.failures,
      bugs: summary.bugs,
      prs: summary.prs,
    });
    return summary;
  }

  /* ---------------- stage helpers ---------------- */

  /** Chat fn for a stage: per-agent model override or the global llm block. */
  private withChat<T>(
    agentCfg: AgentConfig,
    fn: (chat: Chat) => Promise<T>,
  ): Promise<T> {
    const { config, state } = this.ctx;
    const binding = agentCfg.llm ?? config.llm;
    const client = new LlmClient(binding, {
      onCall: (entry) => state.recordLlmCall(entry),
    });
    return fn((messages, ctx) => client.chatWithFallback(messages, ctx));
  }

  /** All target.health URLs must pass before any browser work happens. */
  private async checkHealth(): Promise<void> {
    const { config, log } = this.ctx;
    for (const h of config.target.health) {
      const url = renderTemplate(h.url, config.target.env, "target.health");
      const timeoutMs = h.timeout_ms ?? 10_000;
      try {
        const res = await fetch(url, {
          signal: AbortSignal.timeout(timeoutMs),
          redirect: "follow",
        });
        if (res.status !== h.expect) {
          throw new PipelineError(
            `target unhealthy: ${url} → HTTP ${res.status} (expected ${h.expect})`,
          );
        }
        log(`  health: ${url} → ${res.status} ✓`);
      } catch (e) {
        if (e instanceof PipelineError) throw e;
        throw new PipelineError(`target unhealthy: ${url} — ${(e as Error).message}`);
      }
    }
  }

  /** The failing step's definition, as the fixer's "definition of done". */
  private failingStepSpec(
    plan: TestPlan,
    failedStepId: string | undefined,
  ): string[] {
    if (!failedStepId) return [];
    return plan.steps
      .filter((s) => s.id === failedStepId)
      .map((s) => JSON.stringify(s));
  }

  /** triage→fix→verify per bug, honoring on_failure. */
  private async runFixLoop(
    bugs: BugRecord[],
    failures: Array<{ plan: TestPlan; result: ScenarioResult }>,
    summary: RunSummary,
    agentCfg: AgentConfig,
  ): Promise<void> {
    const { git, artifacts, runId, log, config } = this.ctx;
    const planById = new Map(failures.map((f) => [f.plan.id, f] as const));

    for (const bug of bugs) {
      log(`\n  fix: ${bug.bug_id} — ${bug.title}`);
      const branch = `argus/${bug.bug_id}`;
      const bugEntry = summary.bugs.find((b) => b.bug_id === bug.bug_id);
      if (bugEntry) bugEntry.fix_status = "in-progress";

      try {
        // 1. Cut a branch from the run's base head (never stacked on other fixes).
        if (!(await git.branchExists(branch))) {
          await git.createBranch(branch, this.ctx.baseHead);
        }
        await git.checkout(branch);

        const failed = planById.get(bug.plan_id);
        if (!failed) throw new PipelineError(`no failing plan recorded for ${bug.plan_id}`);
        const plan = failed.plan;
        const bugReport = this.readBugReport(bug.bug_id);

        // 2. Ask the fixer.
        const contextFiles = collectFixerContext(
          this.ctx.repoRoot,
          bugReport.component,
          await this.diffFilesCached(),
        );
        const proposal = await this.withChat(agentCfg, (chat) =>
          fixerAgent(
            chat,
            log,
            {
              bug: bugReport,
              standards: this.discoverStandards(),
              contextFiles,
              failingSteps: this.failingStepSpec(plan, failed.result.failed_step_id),
            },
            { prompt: agentCfg.prompt, repoRoot: this.ctx.repoRoot, runId },
          ),
        );

        if (proposal.patch.trim() === "") {
          log(`  fixer declined: ${proposal.risk_notes.slice(0, 300)}`);
          this.setBugStatus(bug, "confirmed");
          if (bugEntry) bugEntry.fix_status = "declined";
          if (!this.loopContinues()) {
            throw new PipelineError(`fix for ${bug.bug_id} declined: ${proposal.risk_notes.slice(0, 200)}`);
          }
          continue;
        }

        // 3. Mechanical scope enforcement + apply (fs layer, not prompt layer).
        const allowed = assertPatchAllowed(proposal.patch);
        await git.applyPatchCheck(proposal.patch);
        await git.applyPatch(proposal.patch);
        await git.add(allowed);
        await git.commit(`fix: ${bug.title} [${bug.bug_id}]`);

        // 4. Verify-then-pr: the failed plan must now pass.
        const v0 = Date.now();
        const sinkDir = artifacts.scenarioDir(`${plan.id}-verify`);
        let verification: ScenarioResult;
        try {
          verification = await this.deps.executor.runScenario(plan, config.target.env, { dir: sinkDir });
        } catch (e) {
          throw new PipelineError(`verification harness error: ${(e as Error).message}`);
        }
        if (verification.duration_ms === 0) verification.duration_ms = Date.now() - v0;
        this.ctx.state.recordScenario({
          run_id: runId,
          plan_id: `${plan.id}-verify`,
          status: verification.status,
          failed_step_id: verification.failed_step_id,
          error: verification.error,
          duration_ms: verification.duration_ms,
          artifacts_dir: sinkDir,
          started_at: verification.started_at,
        });
        artifacts.writeJson(sinkDir, "result.json", verification);

        if (verification.status !== "pass") {
          log(`  verification FAILED: ${verification.error ?? "plan still failing"}`);
          this.setBugStatus(bug, "unverified");
          if (bugEntry) bugEntry.fix_status = "unverified";
          artifacts.writeJson(artifacts.bugDir(bug.bug_id), "verification-failed.json", verification);
          if (!this.loopContinues()) {
            throw new PipelineError(`verification for ${bug.bug_id} failed — fix not submitted`);
          }
          continue;
        }
        log(`  verification: ${plan.id} now PASSES ✓`);

        this.setBugStatus(bug, "fixed");
        if (bugEntry) bugEntry.fix_status = "fixed";
        summary.fixes.push({ bug, bugReport, branch, files: allowed, proposal, verification });
      } catch (e) {
        if (!this.loopContinues()) throw e; // fail-fast: abort the whole loop
        const msg = (e as Error).message;
        log(`  ✗ fix for ${bug.bug_id} failed: ${msg}`);
        this.setBugStatus(bug, "confirmed");
        if (bugEntry) bugEntry.fix_status = "failed";
        artifacts.writeJson(artifacts.bugDir(bug.bug_id), "fix-error.json", {
          error: msg,
          at: new Date().toISOString(),
        });
      }
    }
  }

  private loopContinues(): boolean {
    return this.ctx.config.pipeline.on_failure === "continue-to-triage";
  }

  private readBugReport(bugId: string): BugReport {
    const file = path.join(this.ctx.artifacts.bugDir(bugId), "bug-report.json");
    if (!existsSync(file)) {
      throw new PipelineError(`bug report artifact missing: ${file}`);
    }
    return JSON.parse(readFileSync(file, "utf8")) as BugReport;
  }

  private setBugStatus(bug: BugRecord, status: BugRecord["status"]): void {
    this.ctx.state.recordBug({ ...bug, status });
  }

  private diffFilesCache: string[] | undefined;
  private async diffFilesCached(): Promise<string[]> {
    if (!this.diffFilesCache) {
      this.diffFilesCache = (await gitCodeSource(this.ctx.git, this.ctx.config.diff.base)).files;
    }
    return this.diffFilesCache;
  }

  private standardsCache: { path: string; content: string } | null | undefined;
  private discoverStandards(): { path: string; content: string } | null {
    if (this.standardsCache !== undefined) return this.standardsCache;
    const configured = this.ctx.config.target.standards_doc;
    const candidates = configured
      ? [configured]
      : ["docs/agent-context.md", "AGENT_CONTEXT.md", "docs/standards.md"];
    for (const rel of candidates) {
      const abs = path.join(this.ctx.repoRoot, rel);
      if (existsSync(abs)) {
        this.standardsCache = {
          path: rel,
          content: readFileSync(abs, "utf8").slice(0, 12_000),
        };
        return this.standardsCache;
      }
    }
    this.standardsCache = null;
    return this.standardsCache;
  }

  /** submit stage: compose PR content, amend commit, push, open the PR. */
  private async runSubmitLoop(summary: RunSummary, agentCfg: AgentConfig): Promise<void> {
    const { git, artifacts, runId, log } = this.ctx;

    for (const fix of summary.fixes) {
      log(`\n  submit: ${fix.bug.bug_id} → ${fix.branch}`);

      const scenarioFile = path.join(
        artifacts.scenarioDir(fix.bug.plan_id),
        "result.json",
      );
      const before: ScenarioResult | null = existsSync(scenarioFile)
        ? (JSON.parse(readFileSync(scenarioFile, "utf8")) as ScenarioResult)
        : null;

      const draft = await this.withChat(agentCfg, (chat) =>
        submitAgent(
          chat,
          log,
          {
            bug: fix.bugReport,
            changedFiles: fix.files,
            fixSummary: fix.proposal.summary,
            riskNotes: fix.proposal.risk_notes,
            beforeLog: before ? scenarioLog(before, fix.bugReport.title) : "(not captured)",
            afterLog: scenarioLog(fix.verification, fix.bugReport.title),
            evidencePaths: [
              fix.verification.artifacts.video,
              fix.verification.artifacts.trace,
              fix.verification.artifacts.har,
              fix.verification.artifacts.console_log,
              before?.artifacts.screenshot,
            ]
              .filter((p): p is string => Boolean(p))
              .map((p) => path.relative(artifacts.dir, p) || p),
          },
          { prompt: agentCfg.prompt, repoRoot: this.ctx.repoRoot, runId },
        ),
      );

      await git.checkout(fix.branch);
      await git.commitAmend(draft.commit_message);

      let pr: PullRequestRef | null = null;
      let status = "pending-local";
      if (this.deps.github) {
        let remote = "";
        try {
          remote = await git.remoteUrl("origin");
        } catch {
          // no remote — PR stays local
        }
        const parsed = remote ? repoFromRemoteUrl(remote) : null;
        if (parsed) {
          const [owner, repo] = parsed;
          let base = this.ctx.config.diff.base.replace(/^origin\//, "");
          try {
            base = await this.deps.github.repo(owner, repo).then((i) => i.default_branch);
          } catch {
            log(`  warning: cannot read repo ${owner}/${repo}; using '${base}' as base`);
          }
          await git.push("origin", fix.branch);
          pr = await this.deps.github.createPullRequest(owner, repo, {
            base,
            head: fix.branch,
            title: draft.title,
            body: draft.body,
          });
          status = "opened";
          log(`  ✓ PR #${pr.number} opened: ${pr.html_url}`);
        } else {
          log(`  warning: origin remote not parseable ('${remote || "missing"}') — PR left local`);
        }
      } else {
        log(`  no GitHub token configured — PR content staged locally on '${fix.branch}'`);
      }

      artifacts.writeJson(artifacts.bugDir(fix.bug.bug_id), "pull-request.json", {
        branch: fix.branch,
        title: draft.title,
        body: draft.body,
        commit_message: draft.commit_message,
        status,
        pr_url: pr?.html_url,
      });
      if (pr) {
        this.ctx.state.recordBug({ ...fix.bug, status: "fixed", tracker_ref: pr.html_url });
      }
      summary.prs.push({
        bug_id: fix.bug.bug_id,
        branch: fix.branch,
        status,
        pr_url: pr?.html_url,
      });
    }
  }

  /** Per-agent email reports, after the run (honest scope: never fatal). */
  private async sendReports(summary: RunSummary): Promise<RunSummary["report"]> {
    const { config, log, redactor } = this.ctx;
    const email = config.report.email;
    if (!email) return { sent: false };

    const failing = summary.failures > 0 || summary.status === "failed";
    const body = redactor.run(
      [
        `Argus run ${summary.runId}`,
        `status: ${summary.status}`,
        `plans executed: ${summary.plansExecuted} (failures: ${summary.failures})`,
        ...summary.bugs.map((b) => `bug ${b.bug_id} [${b.severity}] fix=${b.fix_status}`),
        ...summary.prs.map((p) => `pr ${p.bug_id}: ${p.status}${p.pr_url ? ` ${p.pr_url}` : ""}`),
        `artifacts: ${this.ctx.artifacts.dir}`,
      ].join("\n"),
    );

    const recipients = new Set<string>();
    for (const agentCfg of Object.values(config.agents)) {
      if (agentCfg.report?.type !== "email") continue;
      if (agentCfg.report.on === "failure-only" && !failing) continue;
      for (const to of agentCfg.report.to) recipients.add(to);
    }
    if (recipients.size === 0) return { sent: false };

    const res = await sendEmailReport({
      smtp: email.smtp,
      from: email.from,
      to: [...recipients],
      subject: `[argus] run ${summary.runId}: ${summary.status} (${summary.failures} failures, ${summary.bugs.length} bugs)`,
      text: body,
    });
    log(`  email report: ${res.sent ? "sent" : `failed — ${res.detail}`}`);
    return { sent: res.sent, detail: res.detail };
  }
}

/** mkdir + return, for artifact subdirectories. */
function mkdir(parent: string, name: string): string {
  const d = path.join(parent, name);
  mkdirSync(d, { recursive: true });
  return d;
}
