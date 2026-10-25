import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { JsonlStateStore } from "./state.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "argus-state-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const scenario = (over: Partial<import("./state.js").ScenarioRecord> = {}) => ({
  run_id: "run-1",
  plan_id: "TP-001",
  status: "pass" as const,
  duration_ms: 10,
  artifacts_dir: "/tmp/x",
  started_at: "2026-10-26T00:00:00Z",
  ...over,
});

describe("JsonlStateStore", () => {
  it("records and reads back scenarios", () => {
    const s = new JsonlStateStore(dir);
    s.recordScenario(scenario());
    s.recordScenario(scenario({ plan_id: "TP-002" }));
    s.recordScenario(scenario({ plan_id: "TP-001", status: "fail", failed_step_id: "step-2" }));
    const tp1 = s.scenariosForPlan("TP-001");
    expect(tp1).toHaveLength(2);
    expect(tp1[0]!.status).toBe("pass");
    expect(s.scenariosForPlan("TP-002")).toHaveLength(1);
  });

  it("records runs and returns the most recent", () => {
    const s = new JsonlStateStore(dir);
    for (const id of ["run-a", "run-b", "run-c"]) {
      s.recordRun({
        run_id: id,
        started_at: "t",
        status: "completed",
        target_repo: "/r",
        head: "abc",
        config_hash: "h",
        stages: [],
      });
    }
    const last = s.lastRuns(2);
    expect(last.map((r) => r.run_id)).toEqual(["run-b", "run-c"]);
  });

  it("skips corrupt trailing lines (partial writes) without crashing reads", () => {
    const s = new JsonlStateStore(dir);
    s.recordScenario(scenario());
    // Simulate a torn append: a valid record followed by a partial line.
    writeFileSync(
      path.join(dir, "scenarios.jsonl"),
      'garbage-partial-line',
      { flag: "a" },
    );
    const s2 = new JsonlStateStore(dir);
    expect(s2.scenariosForPlan("TP-001")).toHaveLength(1);
  });

  it("reads empty stores as empty arrays", () => {
    const s = new JsonlStateStore(dir);
    expect(s.bugs()).toEqual([]);
    expect(s.lastRuns(5)).toEqual([]);
    expect(s.scenariosForPlan("TP-X")).toEqual([]);
  });

  it("records bugs and llm calls", () => {
    const s = new JsonlStateStore(dir);
    s.recordBug({
      bug_id: "BUG-001",
      run_id: "run-1",
      plan_id: "TP-001",
      title: "Login broken",
      severity: "P1-High",
      status: "new",
      created_at: "t",
    });
    s.recordLlmCall({
      ts: "t",
      provider: "vllm-local",
      model: "qwen",
      prompt_tokens: 10,
      completion_tokens: 20,
      duration_ms: 100,
      ok: true,
    });
    expect(s.bugs()).toHaveLength(1);
    const lines = readFileSync(path.join(dir, "llm-calls.jsonl"), "utf8").trim();
    expect(JSON.parse(lines).prompt_tokens).toBe(10);
  });
});
