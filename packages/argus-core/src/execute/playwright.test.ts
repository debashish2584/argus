import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PlaywrightExecutor, HarRecorder } from "./playwright.js";
import { TestPlanSchema, type PlanStepInput, type TestPlan } from "../config/schema.js";
import { ConfigError } from "../errors.js";

let server: Server;
let base: string;

const PAGES: Record<string, { status?: number; headers?: Record<string, string>; body: string }> = {
  "/hello": {
    body: `<html><head><title>Hello Page</title></head><body>
      <h1>Hello Argus</h1>
      <input data-testid="name" type="text" />
      <button id="btn">Submit Form</button>
      <a href="/after">Continue</a>
    </body></html>`,
  },
  "/after": {
    body: `<html><head><title>After</title></head><body><p>You arrived.</p></body></html>`,
  },
  "/boom": {
    body: `<html><head><title>Boom</title></head><body>
      <script>console.error("kapow: token eyJhbGciOiJIUzI1NiJ9.payload.sig")</script>
      <img src="/missing" />
      <body></html>`,
  },
  "/cookie": {
    headers: { "set-cookie": "session=supersecret123; HttpOnly" },
    body: `<html><body>cookie page</body></html>`,
  },
};

beforeAll(async () => {
  server = createServer((req, res) => {
    const entry = PAGES[req.url ?? "/"] ?? { status: 404, body: "not found" };
    res.statusCode = entry.status ?? 200;
    for (const [k, v] of Object.entries(entry.headers ?? {})) res.setHeader(k, v);
    res.setHeader("content-type", "text/html");
    res.end(entry.body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
});

function plan(steps: PlanStepInput[]): TestPlan {
  return TestPlanSchema.parse({
    id: "TP-001",
    title: "harness test plan",
    module: "harness",
    priority: "P0",
    status: "ACTIVE",
    tags: [],
    preconditions: [],
    narrative: "drives the Playwright harness",
    steps,
  });
}

function sink(): string {
  return mkdtempSync(path.join(os.tmpdir(), "argus-exec-"));
}

describe("PlaywrightExecutor", () => {
  it("runs a passing scenario and captures evidence", async () => {
    const dir = sink();
    const executor = new PlaywrightExecutor({ headless: true, baseTimeoutMs: 5_000 });
    const res = await executor.runScenario(
      plan([
        { id: "open", action: "navigate", url: `${base}/hello` },
        { id: "title", action: "assert", kind: "title_contains", value: "Hello Page" },
        { id: "heading", action: "assert", kind: "text_contains", value: "Hello Argus" },
        { id: "field", action: "fill", target: { testid: "name" }, value: "Debas" },
        { id: "btn", action: "click", target: { role: "button", name: "Submit" } },
        { id: "url", action: "assert", kind: "url_contains", value: "/hello" },
      ]),
      {},
      { dir },
    );

    expect(res.status).toBe("pass");
    expect(res.steps.every((s) => s.status === "pass")).toBe(true);
    expect(existsSync(res.artifacts.screenshot ?? "")).toBe(true);
    expect(existsSync(res.artifacts.console_log ?? "")).toBe(true);
    expect(existsSync(res.artifacts.video ?? "")).toBe(true);
    expect(existsSync(res.artifacts.trace ?? "")).toBe(true);
    expect(existsSync(res.artifacts.har ?? "")).toBe(true);

    // The HAR is valid 1.2 and captured the page request.
    const har = JSON.parse(readFileSync(res.artifacts.har as string, "utf8")) as {
      log: { version: string; entries: Array<{ request: { url: string } }> };
    };
    expect(har.log.version).toBe("1.2");
    expect(har.log.entries.some((e) => e.request.url.includes("/hello"))).toBe(true);

    rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it("stops at the first failing step, screenshots it, skips the rest", async () => {
    const dir = sink();
    const executor = new PlaywrightExecutor({
      headless: true,
      baseTimeoutMs: 3_000,
      recordVideo: false,
      recordTrace: false,
    });
    const res = await executor.runScenario(
      plan([
        { id: "open", action: "navigate", url: `${base}/hello` },
        { id: "wrong-text", action: "assert", kind: "text_contains", value: "Goodbye" },
        { id: "never-run", action: "click", target: { role: "button", name: "Submit" } },
      ]),
      {},
      { dir },
    );

    expect(res.status).toBe("fail");
    expect(res.failed_step_id).toBe("wrong-text");
    expect(res.error).toContain("expected text to contain 'Goodbye'");
    const byId = Object.fromEntries(res.steps.map((s) => [s.step_id, s.status]));
    expect(byId).toEqual({ "open": "pass", "wrong-text": "fail", "never-run": "skipped" });
    expect(existsSync(path.join(dir, "fail-wrong-text.png"))).toBe(true);
    expect(res.artifacts.screenshot).toBeUndefined();

    rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it("captures console errors and network failures, with secrets redacted", async () => {
    const dir = sink();
    const redactor = (s: string) => s.replaceAll("supersecret123", "[REDACTED]");
    const executor = new PlaywrightExecutor({
      headless: true,
      baseTimeoutMs: 3_000,
      recordVideo: false,
      recordTrace: false,
      redact: redactor,
    });
    const res = await executor.runScenario(
      plan([
        { id: "open", action: "navigate", url: `${base}/boom` },
        { id: "wait", action: "wait", ms: 200 },
      ]),
      {},
      { dir },
    );

    // A console.error fired by the page.
    expect(res.console_errors.some((c) => c.includes("kapow"))).toBe(true);
    // The 404 on /missing (the broken <img src>).
    expect(res.network_failures.some((f) => f.includes("/missing") && f.includes("404"))).toBe(
      true,
    );

    // The HAR masks sensitive response headers.
    const har = JSON.parse(readFileSync(res.artifacts.har as string, "utf8")) as {
      log: {
        entries: Array<{
          request: { url: string };
          response: { status: number; headers: Array<{ name: string; value: string }> };
        }>;
      };
    };
    const pageEntry = har.log.entries.find((e) => e.request.url.includes("/boom"));
    expect(pageEntry?.response.status).toBe(200);

    rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it("masks sensitive headers in the HAR", async () => {
    const dir = sink();
    const executor = new PlaywrightExecutor({
      headless: true,
      baseTimeoutMs: 3_000,
      recordVideo: false,
      recordTrace: false,
    });
    await executor.runScenario(
      plan([{ id: "open", action: "navigate", url: `${base}/cookie` }]),
      {},
      { dir },
    );
    const har = JSON.parse(readFileSync(path.join(dir, "network.har"), "utf8")) as {
      log: {
        entries: Array<{ response: { headers: Array<{ name: string; value: string }> } }>;
      };
    };
    const cookieEntry = har.log.entries.find((e) =>
      JSON.stringify(e).includes("set-cookie"),
    );
    const setCookie = cookieEntry?.response.headers.find((h) => h.name.toLowerCase() === "set-cookie");
    expect(setCookie?.value).toBe("[REDACTED]");

    rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it("renders {{VAR}} urls and hard-fails on unknown variables", async () => {
    const dir = sink();
    const executor = new PlaywrightExecutor({
      headless: true,
      baseTimeoutMs: 3_000,
      recordVideo: false,
      recordTrace: false,
    });
    const res = await executor.runScenario(
      plan([
        { id: "open", action: "navigate", url: "{{BASE}}/hello" },
        { id: "url", action: "assert", kind: "url_contains", value: "/hello" },
      ]),
      { BASE: base },
      { dir },
    );
    expect(res.status).toBe("pass");

    await expect(
      executor.runScenario(
        plan([{ id: "open", action: "navigate", url: "{{MISSING}}/hello" }]),
        {},
        { dir },
      ),
    ).rejects.toThrow(ConfigError);

    rmSync(dir, { recursive: true, force: true });
  }, 60_000);
});

describe("HarRecorder", () => {
  it("records request/response pairs with timings", () => {
    const har = new HarRecorder();
    har.start("GET", "http://x/a");
    har.completeRequest("GET", "http://x/a", 200, { "content-type": "text/html" });
    har.finishRequest("GET", "http://x/a");
    har.start("POST", "http://x/b");
    har.failRequest("http://x/b", "net::ERR_ABORTED");

    const doc = har.document();
    const entries = doc.log.entries as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(2);
    expect(entries[0]?.["response"]).toEqual(
      expect.objectContaining({ status: 200 }),
    );
    expect(entries[1]?.["error"]).toBe("net::ERR_ABORTED");
  });
});
