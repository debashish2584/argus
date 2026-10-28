import { describe, expect, it, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { StudioServer, isLoopback } from "./server.js";
import { buildId } from "./build.js";
import { makeFixtureRepo, TINY_PNG } from "./fixtures.js";

let root: string;
let repo: string;
let progRepo: string;
let runId: string;
let runIdRunning: string;
let server: StudioServer;
let base: string;

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), "argus-studio-srv-"));
  repo = path.join(root, "repo");
  const f = makeFixtureRepo(repo);
  runId = f.runId;
  runIdRunning = f.runIdRunning;
  // second fixture copy for the progress suite — the registry dedupes by path,
  // so a second project pointing at the same dir would 400 the registry suite
  progRepo = path.join(root, "prog");
  makeFixtureRepo(progRepo);
  server = new StudioServer({ registryFile: path.join(root, "projects.json"), port: 0 });
  await server.start();
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
  rmSync(root, { recursive: true, force: true });
});

async function req(method: string, p: string, body?: unknown): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await fetch(base + p, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let parsed: any = null;
  try {
    parsed = await res.json();
  } catch {
    /* non-json */
  }
  return { status: res.status, body: parsed, headers: res.headers };
}

describe("health", () => {
  it("reports ok and the project count", async () => {
    const { status, body } = await req("GET", "/api/health");
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(typeof body.projects).toBe("number");
  });

  it("reports the installed build fingerprint (stale-server detection)", async () => {
    const { status, body } = await req("GET", "/api/health");
    expect(status).toBe(200);
    expect(typeof body.build_id).toBe("string");
    // the running server reports the same id the installed files hash to
    expect(body.build_id).toBe(buildId());
  });
});

describe("run progress", () => {
  // Uses its own project name so this suite cannot collide with the registry
  // suite (which asserts a fresh 201 for `repo` on the shared server).
  const ensureProg = async () => {
    const r = await req("POST", "/api/projects", { name: "prog", path: progRepo });
    // 201 on first call, 400 (already registered) on repeat calls
    expect([201, 400]).toContain(r.status);
  };

  it("reports the stage track + per-stage status for an in-flight run", async () => {
    await ensureProg();
    const { status, body } = await req("GET", `/api/projects/prog/runs/${runIdRunning}/progress`);
    expect(status).toBe(200);
    expect(body.run_id).toBe(runIdRunning);
    expect(body.status).toBe("running");
    expect(body.stages.map((s: any) => s.name)).toEqual([
      "analyze",
      "testplan",
      "execute",
      "triage",
      "fixer",
      "submit",
    ]);
    expect(body.stages.map((s: any) => s.status)).toEqual([
      "running",
      "pending",
      "pending",
      "pending",
      "pending",
      "pending",
    ]);
    expect(body.progress).toBe(0);
    expect(Array.isArray(body.log_tail)).toBe(true);
  });

  it("reports 100% for a fully recorded terminal run", async () => {
    await ensureProg();
    const { status, body } = await req("GET", `/api/projects/prog/runs/${runId}/progress`);
    expect(status).toBe(200);
    expect(body.status).toBe("completed");
    expect(body.progress).toBe(1);
    expect(body.stages.map((s: any) => s.status)).toEqual(["done", "done", "done", "done", "skipped", "skipped"]);
  });

  it("includes a tail of the per-run trigger log when one exists", async () => {
    await ensureProg();
    // the server looks for trigger logs at <registryDir>/run-logs/<name>-<runId>.log
    const logDir = path.join(root, "run-logs");
    mkdirSync(logDir, { recursive: true });
    writeFileSync(path.join(logDir, `prog-${runIdRunning}.log`), "step one\nstep two\nstep three\n");
    const { status, body } = await req("GET", `/api/projects/prog/runs/${runIdRunning}/progress`);
    expect(status).toBe(200);
    expect(body.log_file).toContain(`prog-${runIdRunning}.log`);
    expect(body.log_tail).toEqual(["step one", "step two", "step three"]);
  });

  it("404s for an unknown project", async () => {
    const { status } = await req("GET", `/api/projects/nope/runs/${runId}/progress`);
    expect(status).toBe(404);
  });
});

describe("project registry via API", () => {
  it("registers a project (201) and lists it", async () => {
    const { status, body } = await req("POST", "/api/projects", { name: "repo", path: repo });
    expect(status).toBe(201);
    expect(body.project.name).toBe("repo");

    const list = await req("GET", "/api/projects");
    expect(list.status).toBe(200);
    expect(list.body.projects.map((p: any) => p.name)).toContain("repo");
  });

  it("rejects an invalid project name", async () => {
    const { status } = await req("POST", "/api/projects", { name: "Bad Name!", path: repo });
    expect(status).toBe(400);
  });

  it("rejects a missing body", async () => {
    const { status } = await req("POST", "/api/projects", undefined);
    expect(status).toBe(400);
  });

  it("surfaces the live run as running on the fleet card", async () => {
    const list = await req("GET", "/api/projects");
    const proj = list.body.projects.find((p: any) => p.name === "repo")!;
    expect(proj.latest?.verdict).toBe("running");
    expect(proj.open_bugs).toBe(1);
    expect(proj.plans).toBe(2);
    expect(Array.isArray(proj.plan_histories)).toBe(true);
  });
});

describe("project detail", () => {
  it("returns the project, plans, enriched runs, and bugs", async () => {
    const { status, body } = await req("GET", "/api/projects/repo");
    expect(status).toBe(200);
    expect(body.plans.map((p: any) => p.id)).toEqual(["TP-001", "TP-002"]);
    expect(body.bugs).toHaveLength(1);
    const run = body.runs[0]!;
    expect(run.run_id).toBe(runId);
    expect(run.plans_executed).toBe(2);
    expect(run.failures).toBe(1);
    expect(run.bug_count).toBe(1);
  });

  it("404s for an unknown project", async () => {
    const { status } = await req("GET", "/api/projects/nope");
    expect(status).toBe(404);
  });
});

describe("run detail", () => {
  it("returns the full run bundle", async () => {
    const { status, body } = await req("GET", `/api/projects/repo/runs/${runId}`);
    expect(status).toBe(200);
    const d = body.run;
    expect(d.verdict).toBe("needs-attention");
    expect(d.scenarios).toHaveLength(3);
    expect(d.llm_totals.calls).toBe(2);
    expect(d.stages).toHaveLength(6);
    expect(d.bugs[0].report.title).toBe("login button missing");
  });

  it("404s for an unknown run", async () => {
    const { status } = await req("GET", "/api/projects/repo/runs/run-nope");
    expect(status).toBe(404);
  });
});

describe("evidence", () => {
  it("serves a whitelisted scenario screenshot with the right content type", async () => {
    const res = await fetch(`${base}/api/projects/repo/runs/${runId}/evidence?scenario=TP-001&file=screenshot.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const buf = Buffer.from(await res.arrayBuffer());
    expect(Buffer.compare(buf, TINY_PNG)).toBe(0);
  });

  it("serves a bug artifact", async () => {
    const res = await fetch(`${base}/api/projects/repo/runs/${runId}/evidence?scenario=BUG-001&file=bug-report.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("rejects path traversal with a 400", async () => {
    const res = await fetch(
      `${base}/api/projects/repo/runs/${runId}/evidence?scenario=TP-001&file=${encodeURIComponent("../../etc/passwd")}`,
    );
    expect(res.status).toBe(400);
  });

  it("404s for a whitelisted file that is absent", async () => {
    const res = await fetch(`${base}/api/projects/repo/runs/${runId}/evidence?scenario=TP-002&file=video.webm`);
    expect(res.status).toBe(404);
  });
});

describe("plans endpoint", () => {
  it("lists the parsed plans", async () => {
    const { status, body } = await req("GET", "/api/projects/repo/plans");
    expect(status).toBe(200);
    expect(body.plans.map((p: any) => p.id)).toEqual(["TP-001", "TP-002"]);
  });
});

describe("static + SPA fallback", () => {
  it("serves the app shell at /", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Argus");
  });

  it("falls back to index.html for an unknown client route", async () => {
    const res = await fetch(`${base}/project/some-project`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("404s for a missing asset with an extension", async () => {
    const res = await fetch(`${base}/does-not-exist.js`);
    expect(res.status).toBe(404);
  });

  it("serves static assets (css) with the right type", async () => {
    const res = await fetch(`${base}/studio.css`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/css");
  });
});

describe("one-off projects", () => {
  it("exposes --project dirs without persisting them", async () => {
    const oneOff = new StudioServer({ registryFile: path.join(root, "reg2.json"), port: 0, oneOff: [{ name: "one", path: repo }] });
    await oneOff.start();
    try {
      const b2 = `http://127.0.0.1:${oneOff.port}`;
      const res = await fetch(`${b2}/api/projects`);
      const body = (await res.json()) as { projects: Array<{ name: string }> };
      expect(body.projects.map((p) => p.name)).toEqual(["one"]);
      // not persisted to the registry
      const reg2 = path.join(root, "reg2.json");
      expect(existsSync(reg2)).toBe(false);
    } finally {
      await oneOff.close();
    }
  });
});

describe("remove project", () => {
  it("unregisters a project (200) then it disappears from the list", async () => {
    const tempRepo = path.join(root, "temp-repo");
    makeFixtureRepo(tempRepo);
    const added = await req("POST", "/api/projects", { name: "temp", path: tempRepo });
    expect(added.status).toBe(201);

    const { status } = await req("DELETE", "/api/projects/temp");
    expect(status).toBe(200);

    const list = await req("GET", "/api/projects");
    expect(list.body.projects.every((p: any) => p.name !== "temp")).toBe(true);
  });

  it("404s/removes an already-gone project cleanly", async () => {
    const { status } = await req("DELETE", "/api/projects/never-existed");
    expect(status).toBe(400);
  });
});

/* ------------------------------------------------------------------ */
/* loopback gate                                                       */
/* ------------------------------------------------------------------ */

describe("isLoopback", () => {
  it("accepts loopback peers", () => {
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("::1")).toBe(true);
    expect(isLoopback("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopback(undefined)).toBe(true);
    expect(isLoopback("")).toBe(true);
  });
  it("rejects non-loopback peers", () => {
    expect(isLoopback("10.0.0.5")).toBe(false);
    expect(isLoopback("192.168.1.20")).toBe(false);
    expect(isLoopback("::ffff:10.0.0.5")).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* pipeline triggers (stubbed CLI)                                     */
/* ------------------------------------------------------------------ */

const STUB_SOURCE = `
const fs = require("node:fs");
const path = require("node:path");
const argv = process.argv.slice(2);
const cmd = argv[0];
const calls = process.env.ARGUS_STUB_CALLS;
if (calls) fs.appendFileSync(calls, JSON.stringify({ cmd, argv, cwd: process.cwd() }) + "\\n");
const idx = argv.indexOf("--run-id");
const runId = idx >= 0 ? argv[idx + 1] : undefined;
if (runId) {
  // mimic the real CLI recording a live run row
  const runsFile = path.join(process.cwd(), ".argus", "state", "runs.jsonl");
  fs.appendFileSync(runsFile, JSON.stringify({
    run_id: runId,
    started_at: new Date().toISOString(),
    status: "running",
    target_repo: process.cwd(),
    head: "stubhead",
    config_hash: "stubhash",
    stages: [],
  }) + "\\n");
}
if (process.env.ARGUS_STUB_STAY) {
  setInterval(() => {}, 60000); // live until killed
} else {
  process.exit(0);
}
`;

describe("pipeline triggers (stubbed CLI)", () => {
  let trigServer: StudioServer;
  let trigBase: string;
  let trigRepo: string;
  let stubCalls: string;
  let stubBinPath: string;
  let fixtureRunId: string;
  let fixtureRunningId: string;

  const treq = async (method: string, p: string, body?: unknown) => {
    const res = await fetch(trigBase + p, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    let parsed: any = null;
    try {
      parsed = await res.json();
    } catch {}
    return { status: res.status, body: parsed };
  };

  const readCalls = (): Array<{ cmd: string; argv: string[]; cwd: string }> =>
    existsSync(stubCalls)
      ? readFileSync(stubCalls, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];

  const waitFor = async (fn: () => boolean | Promise<boolean>, ms = 3000) => {
    const start = Date.now();
    while (Date.now() - start < ms) {
      if (await fn()) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return await fn();
  };

  const activeCleared = () =>
    treq("GET", "/api/projects/trig").then((r) => r.body.active_run === null);

  beforeAll(async () => {
    const stubDir = path.join(root, "stub");
    mkdirSync(stubDir, { recursive: true });
    const stubPath = path.join(stubDir, "argus-stub.js");
    writeFileSync(stubPath, STUB_SOURCE);
    stubBinPath = stubPath;
    stubCalls = path.join(root, "stub-calls.jsonl");
    process.env.ARGUS_STUB_CALLS = stubCalls;

    trigRepo = path.join(root, "trig-repo");
    const f = makeFixtureRepo(trigRepo);
    fixtureRunId = f.runId;
    fixtureRunningId = f.runIdRunning;

    trigServer = new StudioServer({
      registryFile: path.join(root, "trig-registry.json"),
      port: 0,
      cliBin: stubPath,
    });
    await trigServer.start();
    trigBase = `http://127.0.0.1:${trigServer.port}`;
    const added = await treq("POST", "/api/projects", { name: "trig", path: trigRepo });
    expect(added.status).toBe(201);
  });

  afterAll(async () => {
    await trigServer.close();
    delete process.env.ARGUS_STUB_CALLS;
    delete process.env.ARGUS_STUB_STAY;
  });

  afterEach(() => {
    delete process.env.ARGUS_STUB_STAY;
  });

  it("starts a plan run and records the stub invocation with --run-id", async () => {
    const { status, body } = await treq("POST", "/api/projects/trig/pipeline", { action: "plan" });
    expect(status).toBe(202);
    expect(body.action).toBe("plan");
    expect(typeof body.run_id).toBe("string");
    expect(typeof body.pid).toBe("number");
    // the stub exits immediately here (no STAY), so it must have recorded the call
    const ok = await waitFor(() =>
      readCalls().some((c) => c.cmd === "plan" && c.argv.includes(body.run_id)),
    );
    expect(ok).toBe(true);
    const call = readCalls().find((c) => c.cmd === "plan")!;
    expect(call.argv).toContain("--yes");
    expect(call.argv).toContain("--activate");
    expect(call.argv).toContain("--run-id");
    expect(call.cwd).toBe(trigRepo);
  });

  it("exposes an active_run while a run is in flight, then clears it", async () => {
    process.env.ARGUS_STUB_STAY = "1";
    const { status, body } = await treq("POST", "/api/projects/trig/pipeline", { action: "run" });
    expect(status).toBe(202);
    const detail = await treq("GET", "/api/projects/trig");
    expect(detail.body.active_run).toMatchObject({ action: "run", run_id: body.run_id });
    // stop it (kills the STAY child) and wait for the entry to clear
    const stop = await treq("POST", "/api/projects/trig/pipeline/stop");
    expect(stop.status).toBe(200);
    expect(await waitFor(activeCleared)).toBe(true);
  });

  it("a fresh server instance has no active run (in-memory only)", async () => {
    // separate instance + base so the shared trigServer is untouched
    const fresh = new StudioServer({
      registryFile: path.join(root, "trig-registry.json"),
      port: 0,
      cliBin: stubBinPath,
    });
    await fresh.start();
    const fb = `http://127.0.0.1:${fresh.port}`;
    try {
      const res = await fetch(`${fb}/api/projects/trig`);
      const b = (await res.json()) as { active_run: unknown };
      expect(b.active_run).toBe(null);
    } finally {
      await fresh.close();
    }
  });

  it("rejects a second trigger while one is active (409)", async () => {
    process.env.ARGUS_STUB_STAY = "1";
    const first = await treq("POST", "/api/projects/trig/pipeline", { action: "run" });
    expect(first.status).toBe(202);
    const second = await treq("POST", "/api/projects/trig/pipeline", { action: "plan" });
    expect(second.status).toBe(409);
    expect(second.body.error).toMatch(/already running/i);
    // stop it and wait for the active entry to clear
    const stop = await treq("POST", "/api/projects/trig/pipeline/stop");
    expect(stop.status).toBe(200);
    expect(stop.body.stopped).toBe(true);
    expect(await waitFor(activeCleared)).toBe(true);
  });

  it("stop marks the in-flight run aborted in the state store", async () => {
    process.env.ARGUS_STUB_STAY = "1";
    const start = await treq("POST", "/api/projects/trig/pipeline", { action: "auto-run" });
    expect(start.status).toBe(202);
    const stop = await treq("POST", "/api/projects/trig/pipeline/stop");
    expect(stop.status).toBe(200);
    expect(await waitFor(activeCleared)).toBe(true);
    // the stub recorded a `running` row; stop should have appended an `aborted` row
    const rowsFile = path.join(trigRepo, ".argus", "state", "runs.jsonl");
    const rows = readFileSync(rowsFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((r) => r.run_id === start.body.run_id);
    expect(rows.some((r) => r.status === "aborted")).toBe(true);
  });

  it("starts a fix run for a run with open bugs (fix --run <src>)", async () => {
    const { status, body } = await treq("POST", `/api/projects/trig/runs/${fixtureRunId}/fix`, {});
    expect(status).toBe(202);
    expect(body.action).toBe("fix");
    expect(body.source_run).toBe(fixtureRunId);
    expect(body.open_bugs).toBeGreaterThanOrEqual(1);
    const ok = await waitFor(() => readCalls().some((c) => c.cmd === "fix"));
    expect(ok).toBe(true);
    const call = readCalls().find((c) => c.cmd === "fix")!;
    const i = call.argv.indexOf("--run");
    expect(call.argv[i + 1]).toBe(fixtureRunId);
    expect(call.argv).toContain("--run-id");
  });

  it("fix honors a severity scope in the argv", async () => {
    const { status } = await treq("POST", `/api/projects/trig/runs/${fixtureRunId}/fix`, {
      severity: ["P0-Blocker"],
    });
    expect(status).toBe(202);
    const ok = await waitFor(
      () =>
        readCalls()
          .filter((c) => c.cmd === "fix")
          .some((c) => c.argv.includes("--severity") && c.argv.includes("P0-Blocker")),
    );
    expect(ok).toBe(true);
  });

  it("400s a fix on a run that exists but has no open bugs", async () => {
    const { status, body } = await treq("POST", `/api/projects/trig/runs/${fixtureRunningId}/fix`, {});
    expect(status).toBe(400);
    expect(body.error).toMatch(/no open bugs/i);
  });

  it("400s an invalid severity for fix", async () => {
    const { status, body } = await treq("POST", `/api/projects/trig/runs/${fixtureRunId}/fix`, {
      severity: ["P9-Weird"],
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/invalid severity/i);
  });

  it("404s a fix on an unknown run", async () => {
    const { status } = await treq("POST", "/api/projects/trig/runs/run-never/fix", {});
    expect(status).toBe(404);
  });

  it("404s a trigger for an unknown project", async () => {
    const { status } = await treq("POST", "/api/projects/ghost/pipeline", { action: "plan" });
    expect(status).toBe(404);
  });

  it("400s a trigger for a project whose .argus workspace was removed", async () => {
    const bare = path.join(root, "bare");
    mkdirSync(path.join(bare, ".argus"), { recursive: true });
    const added = await treq("POST", "/api/projects", { name: "bare", path: bare });
    expect(added.status).toBe(201);
    // simulate the workspace disappearing after registration
    rmSync(path.join(bare, ".argus"), { recursive: true, force: true });
    const { status, body } = await treq("POST", "/api/projects/bare/pipeline", { action: "run" });
    expect(status).toBe(400);
    expect(body.error).toMatch(/\.argus/i);
  });

  it("400s an unknown pipeline action", async () => {
    const { status, body } = await treq("POST", "/api/projects/trig/pipeline", { action: "dance" });
    expect(status).toBe(400);
    expect(body.error).toMatch(/action must be one of/i);
  });

  it("404s a stop when nothing is in progress", async () => {
    const { status } = await treq("POST", "/api/projects/trig/pipeline/stop");
    expect(status).toBe(404);
  });
});
