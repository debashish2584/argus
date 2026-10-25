/**
 * Execution state store.
 *
 * MVP backend: JSONL files under `.argus/state/` — zero native dependencies,
 * append-only, crash-safe enough for a single writer (the pipeline runner is
 * sequential in the MVP; parallel workers get per-worker shards post-MVP).
 * The `StateStore` interface is stable; the post-MVP upgrade to SQLite (WAL)
 * is a backend swap, not a rewrite (see docs/post-mvp-roadmap.md §5).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

export type RunStatus = "running" | "completed" | "failed" | "aborted";

export interface RunRecord {
  run_id: string;
  started_at: string;
  ended_at?: string;
  status: RunStatus;
  target_repo: string;
  head: string;
  config_hash: string;
  stages: string[];
}

export interface StageRecord {
  run_id: string;
  stage: string;
  agent: string;
  /** Prompt version in effect (default | user override path). */
  prompt_version: string;
  provider: string;
  model: string;
  status: "ok" | "failed" | "skipped";
  started_at: string;
  ended_at?: string;
  duration_ms?: number;
  tokens_in?: number;
  tokens_out?: number;
  detail?: string;
}

export interface ScenarioRecord {
  run_id: string;
  plan_id: string;
  status: "pass" | "fail" | "error";
  failed_step_id?: string;
  error?: string;
  duration_ms: number;
  artifacts_dir: string;
  started_at: string;
}

export interface BugRecord {
  bug_id: string;
  run_id: string;
  plan_id: string;
  title: string;
  severity: string;
  status: "new" | "confirmed" | "unverified" | "fixed" | "dismissed";
  tracker_ref?: string;
  created_at: string;
}

export interface LlmCallRecord {
  ts: string;
  run_id?: string;
  agent?: string;
  purpose?: string;
  provider: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  duration_ms: number;
  ok: boolean;
  error?: string;
  via_fallback?: boolean;
}

export interface StateStore {
  recordRun(run: RunRecord): void;
  recordStage(stage: StageRecord): void;
  recordScenario(scenario: ScenarioRecord): void;
  recordBug(bug: BugRecord): void;
  recordLlmCall(entry: LlmCallRecord): void;
  /** Full scenario history for a plan — the flakiness/regression signal. */
  scenariosForPlan(planId: string): ScenarioRecord[];
  lastRuns(limit: number): RunRecord[];
  bugs(): BugRecord[];
}

type Kind = "runs" | "stages" | "scenarios" | "bugs" | "llm-calls";

const FILES: Record<Kind, string> = {
  runs: "runs.jsonl",
  stages: "stages.jsonl",
  scenarios: "scenarios.jsonl",
  bugs: "bugs.jsonl",
  "llm-calls": "llm-calls.jsonl",
};

export class JsonlStateStore implements StateStore {
  constructor(private dir: string) {
    mkdirSync(this.dir, { recursive: true });
  }

  private append(kind: Kind, obj: unknown): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    appendFileSync(
      path.join(this.dir, FILES[kind]),
      JSON.stringify(obj) + "\n",
      "utf8",
    );
  }

  private readAll<T>(kind: Kind): T[] {
    const file = path.join(this.dir, FILES[kind]);
    if (!existsSync(file)) return [];
    const out: T[] = [];
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed) as T);
      } catch {
        // Corrupt trailing line (partial write) — skip, never crash reads.
      }
    }
    return out;
  }

  recordRun(run: RunRecord): void {
    this.append("runs", run);
  }

  recordStage(stage: StageRecord): void {
    this.append("stages", stage);
  }

  recordScenario(scenario: ScenarioRecord): void {
    this.append("scenarios", scenario);
  }

  recordBug(bug: BugRecord): void {
    this.append("bugs", bug);
  }

  recordLlmCall(entry: LlmCallRecord): void {
    this.append("llm-calls", entry);
  }

  scenariosForPlan(planId: string): ScenarioRecord[] {
    return this.readAll<ScenarioRecord>("scenarios").filter(
      (s) => s.plan_id === planId,
    );
  }

  lastRuns(limit: number): RunRecord[] {
    return this.readAll<RunRecord>("runs").slice(-limit);
  }

  bugs(): BugRecord[] {
    return this.readAll<BugRecord>("bugs");
  }
}
