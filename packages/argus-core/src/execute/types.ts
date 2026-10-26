/**
 * Execution result contract — the shared shape produced by the browser
 * harness and consumed by triage, the state store, and the fixer.
 *
 * Keep this flat and JSON-serializable: everything in a ScenarioResult is
 * written verbatim into run artifacts.
 */
export interface StepRecord {
  step_id: string;
  action: string;
  status: "pass" | "fail" | "skipped";
  error?: string;
  duration_ms: number;
}

export interface ScenarioArtifacts {
  /** Absolute paths; present only when captured. */
  screenshot?: string;
  video?: string;
  trace?: string;
  har?: string;
  /** Per-scenario console log file. */
  console_log?: string;
}

export interface ScenarioResult {
  plan_id: string;
  status: "pass" | "fail";
  /** The step where the scenario stopped (first failing step). */
  failed_step_id?: string;
  /** One line describing the failure; absent on pass. */
  error?: string;
  steps: StepRecord[];
  console_errors: string[];
  network_failures: string[];
  duration_ms: number;
  started_at: string;
  artifacts: ScenarioArtifacts;
}

export interface ScenarioSink {
  /** Directory where the harness must write captured artifacts (video,
   *  trace, HAR, console log, screenshots). Paths are absolute. */
  dir: string;
}

export interface Executor {
  /**
   * Execute one plan's steps deterministically and return the outcome.
   * Captured artifacts must be written into `sink.dir`; their absolute
   * paths are reported in `ScenarioResult.artifacts`.
   */
  runScenario(
    plan: import("../config/schema.js").TestPlan,
    env: Record<string, string>,
    sink: ScenarioSink,
  ): Promise<ScenarioResult>;
}
