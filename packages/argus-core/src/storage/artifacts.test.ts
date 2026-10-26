import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { newRunId, RunArtifacts } from "./artifacts.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "argus-art-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("RunArtifacts", () => {
  it("creates the run directory with a manifest", () => {
    const a = new RunArtifacts(dir, "run-test", {
      run_id: "run-test",
      started_at: "t",
      argus_version: "0.1.0",
      config_hash: "abc",
      target_repo: "/r",
      head: "deadbeef",
    });
    expect(existsSync(path.join(a.dir, "run.json"))).toBe(true);
    const manifest = JSON.parse(readFileSync(path.join(a.dir, "run.json"), "utf8"));
    expect(manifest.config_hash).toBe("abc");
  });

  it("creates per-scenario and per-bug directories", () => {
    const a = new RunArtifacts(dir, "run-test", {
      run_id: "run-test",
      started_at: "t",
      argus_version: "0.1.0",
      config_hash: "abc",
      target_repo: "/r",
      head: "deadbeef",
    });
    const sd = a.scenarioDir("TP-001");
    const bd = a.bugDir("BUG-001");
    expect(existsSync(sd)).toBe(true);
    expect(existsSync(bd)).toBe(true);
    expect(sd).toContain("scenarios");
    expect(bd).toContain("bugs");
  });

  it("writeJson/writeText return the path and persist content", () => {
    const a = new RunArtifacts(dir, "run-test", {
      run_id: "run-test",
      started_at: "t",
      argus_version: "0.1.0",
      config_hash: "abc",
      target_repo: "/r",
      head: "deadbeef",
    });
    const sd = a.scenarioDir("TP-001");
    const p = a.writeJson(sd, "result.json", { ok: true });
    expect(existsSync(p)).toBe(true);
    expect(readFileSync(p, "utf8")).toContain('"ok": true');
    const tp = a.writeText(sd, "console.log", "boom\n");
    expect(readFileSync(tp, "utf8")).toBe("boom\n");
  });
});

describe("newRunId", () => {
  it("produces a sortable, collision-resistant id", () => {
    const id = newRunId(new Date(2026, 9, 26, 14, 3, 5));
    expect(id).toBe("run-20261026-140305");
  });
});
