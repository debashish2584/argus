import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { StudioServer } from "./server.js";
import { makeFixtureRepo, TINY_PNG } from "./fixtures.js";

let root: string;
let repo: string;
let runId: string;
let server: StudioServer;
let base: string;

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), "argus-studio-srv-"));
  repo = path.join(root, "repo");
  const f = makeFixtureRepo(repo);
  runId = f.runId;
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
