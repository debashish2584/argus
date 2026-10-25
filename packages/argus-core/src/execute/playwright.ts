/**
 * The deterministic browser execution harness (Playwright).
 *
 * Execution semantics:
 *  - **Accessibility-first.** Locators resolve against the a11y tree
 *    (role/name/testid/text); raw `css` is a last-resort escape hatch.
 *  - **Stop at the first failure.** The failing step is recorded with its
 *    error; later steps are marked `skipped`. One failing step per scenario
 *    keeps triage unambiguous.
 *  - **Evidence always.** Each scenario captures, into its sink dir:
 *      video.webm      (full run; off with recordVideo:false)
 *      trace.zip       (Playwright trace with screenshots; off w/ recordTrace)
 *      network.har     (HAR 1.2 built from request/response events;
 *                       cookie/authorization headers masked)
 *      console.log     (console errors + warnings, one per line)
 *      screenshot.png  (final state; on failure, also fail-<step>.png)
 *  - **URLs are rendered, never baked.** Step URLs may contain {{VAR}}
 *    service-map refs; they are rendered against the run's env and an
 *    unknown variable is a hard error.
 *
 * One browser per scenario: isolation is worth the launch cost in a
 * sequential MVP.
 */
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";
import { HarnessError } from "../errors.js";
import { renderTemplate } from "../template.js";
import { ARGUS_VERSION } from "../hook.js";
import type { TestPlan, LocatorSpec, PlanStep } from "../config/schema.js";
import type { Executor, ScenarioResult, ScenarioSink, StepRecord } from "./types.js";

export interface PlaywrightExecutorOptions {
  /** Headless by default; --headful for dogfooding on a screen. */
  headless?: boolean;
  /** Capture video (default true). */
  recordVideo?: boolean;
  /** Capture trace.zip with screenshots (default true). */
  recordTrace?: boolean;
  /** Capture HAR (default true). */
  recordHar?: boolean;
  /** Per-step default timeout in ms (default 10s). */
  baseTimeoutMs?: number;
  /** Redact captured text before it hits disk (console, network). */
  redact?: (text: string) => string;
}

export class PlaywrightExecutor implements Executor {
  constructor(private opts: PlaywrightExecutorOptions = {}) {}

  async runScenario(
    plan: TestPlan,
    env: Record<string, string>,
    sink: ScenarioSink,
  ): Promise<ScenarioResult> {
    mkdirSync(sink.dir, { recursive: true });
    const timeout = this.opts.baseTimeoutMs ?? 10_000;
    const redact = this.opts.redact ?? ((s: string) => s);
    const recordTrace = this.opts.recordTrace !== false;
    const recordHar = this.opts.recordHar !== false;
    const startedAt = new Date().toISOString();
    const t0 = Date.now();

    // Fail fast on unrenderable URLs: a plan that references a service map
    // var this env doesn't define is a configuration defect, not an app bug
    // — it must not be executed and then triaged as one.
    for (const step of plan.steps) {
      if (step.action === "navigate") {
        renderTemplate(step.url, env, `plan step ${step.id}`);
      }
    }

    const consoleLines: string[] = [];
    const consoleErrors: string[] = [];
    const networkFailures: string[] = [];
    const har = new HarRecorder();
    /** Resolved when every response's headers have been captured. */
    const pendingHeaders: Promise<unknown>[] = [];

    const browser = await chromium.launch({ headless: this.opts.headless ?? true });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      ...(this.opts.recordVideo !== false
        ? {
            recordVideo: {
              dir: path.join(sink.dir, ".video"),
              size: { width: 1280, height: 720 },
            },
          }
        : {}),
    });
    if (recordTrace) {
      await context.tracing.start({ screenshots: true, snapshots: false });
    }

    try {
      const page = await context.newPage();
      this.bindPage(page, {
        consoleLines,
        consoleErrors,
        networkFailures,
        har,
        pendingHeaders,
        redact,
      });

      const steps: StepRecord[] = [];
      let failedStep: { id: string; error: string } | null = null;
      for (const step of plan.steps) {
        if (failedStep) {
          steps.push({ step_id: step.id, action: step.action, status: "skipped", duration_ms: 0 });
          continue;
        }
        const s0 = Date.now();
        try {
          await this.runStep(page, step, env, timeout);
          steps.push({
            step_id: step.id,
            action: step.action,
            status: "pass",
            duration_ms: Date.now() - s0,
          });
        } catch (e) {
          failedStep = { id: step.id, error: (e as Error).message };
          steps.push({
            step_id: step.id,
            action: step.action,
            status: "fail",
            error: failedStep.error,
            duration_ms: Date.now() - s0,
          });
          // Screenshot at the failure point — the single most useful artifact.
          await page.screenshot({ path: path.join(sink.dir, `fail-${step.id}.png`) }).catch(() => {});
        }
      }

      const artifacts: ScenarioResult["artifacts"] = {};
      if (!failedStep) {
        await page.screenshot({ path: path.join(sink.dir, "screenshot.png") }).catch(() => {});
        artifacts.screenshot = path.join(sink.dir, "screenshot.png");
      }

      // The video is only flushed once the page is closed; capture the
      // promise before closing, resolve it after.
      const videoPathPromise = page.video()?.path().catch(() => null);
      await page.close();
      const videoPath = await videoPathPromise;
      if (videoPath && existsSync(videoPath)) {
        const dest = path.join(sink.dir, "video.webm");
        cpSync(videoPath, dest);
        artifacts.video = dest;
      }
      // The trace must be stopped before the context closes.
      if (recordTrace) {
        const tracePath = path.join(sink.dir, "trace.zip");
        await context.tracing.stop({ path: tracePath }).catch(() => {});
        if (existsSync(tracePath)) artifacts.trace = tracePath;
      }
      await context.close();
      await browser.close();

      // Flush any in-flight header captures before the HAR hits disk.
      await Promise.allSettled(pendingHeaders);

      const consoleFile = path.join(sink.dir, "console.log");
      writeFileSync(consoleFile, consoleLines.length ? consoleLines.join("\n") + "\n" : "", "utf8");
      artifacts.console_log = consoleFile;
      if (recordHar) {
        const harFile = path.join(sink.dir, "network.har");
        writeFileSync(harFile, JSON.stringify(har.document(), null, 2), "utf8");
        artifacts.har = harFile;
      }

      const result: ScenarioResult = {
        plan_id: plan.id,
        status: failedStep ? "fail" : "pass",
        failed_step_id: failedStep?.id,
        error: failedStep?.error,
        steps,
        console_errors: consoleErrors,
        network_failures: networkFailures,
        duration_ms: Date.now() - t0,
        started_at: startedAt,
        artifacts,
      };
      return result;
    } catch (e) {
      // Harness-level failure outside a step (launch, navigation crash…).
      if (recordTrace) {
        await context.tracing.stop({ path: path.join(sink.dir, "trace.zip") }).catch(() => {});
      }
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
      throw new HarnessError(`scenario ${plan.id}: ${(e as Error).message}`);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Page events                                                        */
  /* ---------------------------------------------------------------- */

  private bindPage(
    page: Page,
    sinks: {
      consoleLines: string[];
      consoleErrors: string[];
      networkFailures: string[];
      har: HarRecorder;
      pendingHeaders: Promise<unknown>[];
      redact: (s: string) => string;
    },
  ): void {
    page.on("console", (msg) => {
      if (msg.type() !== "error" && msg.type() !== "warning") return;
      const line = `[${msg.type()}] ${sinks.redact(msg.text())}`;
      sinks.consoleLines.push(line);
      if (msg.type() === "error") sinks.consoleErrors.push(line);
    });
    page.on("request", (req) => sinks.har.start(req.method(), req.url()));
    page.on("response", (res) => {
      const status = res.status();
      const method = res.request().method();
      const url = res.url();
      if (status >= 400) {
        sinks.networkFailures.push(`${method} ${shortUrl(url)} → ${status}`);
      }
      // allHeaders() (async) is the one that includes set-cookie — the
      // synchronous headers() view strips it. Track completion so the HAR
      // is flushed deterministically rather than racing the event handler.
      sinks.pendingHeaders.push(
        res
          .allHeaders()
          .then((headers) => sinks.har.completeRequest(method, url, status, headers))
          .catch(() => {
            // Headers vanished (aborted request) — fall back to the sync view.
            try {
              sinks.har.completeRequest(method, url, status, res.headers());
            } catch {
              // nothing to record
            }
          }),
      );
    });
    page.on("requestfailed", (req) => {
      const why = req.failure()?.errorText ?? "failed";
      sinks.networkFailures.push(`${req.method()} ${shortUrl(req.url())} — ${why}`);
      sinks.har.failRequest(req.url(), why);
    });
    page.on("requestfinished", (req) => sinks.har.finishRequest(req.method(), req.url()));
  }

  /* ---------------------------------------------------------------- */
  /* Steps                                                              */
  /* ---------------------------------------------------------------- */

  private async runStep(
    page: Page,
    step: PlanStep,
    env: Record<string, string>,
    timeout: number,
  ): Promise<void> {
    switch (step.action) {
      case "navigate": {
        const url = renderTemplate(step.url, env, `plan step ${step.id}`);
        await page.goto(url, { waitUntil: "domcontentloaded", timeout });
        return;
      }
      case "fill": {
        await resolveLocator(page, step.target).fill(step.value, { timeout });
        return;
      }
      case "click": {
        await resolveLocator(page, step.target).click({ timeout });
        return;
      }
      case "wait": {
        if (step.target) {
          await resolveLocator(page, step.target).waitFor({ state: "visible", timeout });
        } else {
          await page.waitForTimeout(step.ms ?? step.timeout_ms);
        }
        return;
      }
      case "assert":
        await this.runAssert(page, step, timeout);
    }
  }

  private async runAssert(
    page: Page,
    step: Extract<PlanStep, { action: "assert" }>,
    timeout: number,
  ): Promise<void> {
    const v = step.value ?? "";
    const target: Locator | null = step.target ? resolveLocator(page, step.target) : null;
    switch (step.kind) {
      case "url_contains":
        if (!page.url().includes(v))
          throw new Error(`expected URL to contain '${v}', got '${page.url()}'`);
        return;
      case "url_not_contains":
        if (page.url().includes(v))
          throw new Error(`expected URL NOT to contain '${v}', got '${page.url()}'`);
        return;
      case "redirected_to":
        if (!page.url().includes(v))
          throw new Error(`expected redirect to '${v}', got '${page.url()}'`);
        return;
      case "visible": {
        const loc = target ?? page.locator("body");
        if (!(await isVisible(loc, timeout)))
          throw new Error(
            `expected element to be visible (locator: ${describeLocator(step.target)})`,
          );
        return;
      }
      case "not_visible": {
        const loc = target ?? page.locator("body");
        if (await isVisible(loc, 2_000))
          throw new Error(
            `expected element to NOT be visible (locator: ${describeLocator(step.target)})`,
          );
        return;
      }
      case "text_contains": {
        const scope = target ?? page.locator("body");
        const text = await scope.innerText({ timeout });
        if (!text.includes(v))
          throw new Error(
            `expected text to contain '${v}'${target ? "" : " (page body)"}, ` +
              `saw: ${text.slice(0, 300).replace(/\s+/g, " ")}`,
          );
        return;
      }
      case "dialog_open": {
        const dialog = page.getByRole("dialog").first();
        if (!(await isVisible(dialog, timeout)))
          throw new Error("expected an open dialog (role=dialog) on the page");
        return;
      }
      case "title_contains": {
        const title = await page.title();
        if (!title.includes(v))
          throw new Error(`expected title to contain '${v}', got '${title}'`);
        return;
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Locators                                                             */
/* ------------------------------------------------------------------ */

export function resolveLocator(page: Page, spec: LocatorSpec): Locator {
  let loc: Locator;
  if (spec.role) {
    const opts: { name?: string | RegExp; exact?: boolean } = {};
    if (spec.name) {
      opts.name = spec.name_match === "regex" ? new RegExp(spec.name) : spec.name;
      opts.exact = spec.name_match === "exact";
    }
    loc = page.getByRole(spec.role as never, opts);
  } else if (spec.testid) {
    loc = page.getByTestId(spec.testid);
  } else if (spec.text) {
    loc = spec.text_match === "regex"
      ? page.getByText(new RegExp(spec.text))
      : page.getByText(spec.text, { exact: spec.text_match === "exact" });
  } else if (spec.css) {
    loc = page.locator(spec.css);
  } else {
    throw new HarnessError("locator has no selector (need role/name/testid/text/css)");
  }
  return spec.nth > 0 ? loc.nth(spec.nth) : loc;
}

/** Visibility with a budget — locator.isVisible() takes no timeout. */
async function isVisible(loc: Locator, timeout: number): Promise<boolean> {
  try {
    await loc.waitFor({ state: "visible", timeout });
    return true;
  } catch {
    try {
      await loc.waitFor({ state: "hidden", timeout: 100 });
    } catch {
      // still loading — treat as not visible within the budget
    }
    return (await loc.count().catch(() => 0)) > 0 && (await loc.isVisible().catch(() => false));
  }
}

function describeLocator(spec?: LocatorSpec): string {
  if (!spec) return "(page)";
  return (
    [spec.role, spec.name, spec.testid, spec.text, spec.css].filter(Boolean).join("/") ??
    "(page)"
  );
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

/* ------------------------------------------------------------------ */
/* HAR                                                                  */
/* ------------------------------------------------------------------ */

const SENSITIVE_HEADERS = new Set(["cookie", "set-cookie", "authorization"]);

interface HarPending {
  method: string;
  url: string;
  started: number;
  status?: number;
  headers?: Record<string, string>;
  finished?: number;
  failed?: string;
}

/**
 * Minimal HAR 1.2 recorder built from Playwright request events.
 * Response bodies are not captured (keeps the artifact small).
 */
export class HarRecorder {
  private byKey = new Map<string, HarPending>();
  private order: string[] = [];

  start(method: string, url: string): void {
    const key = `req-${this.order.length}`;
    this.byKey.set(key, { method, url, started: Date.now() });
    this.order.push(key);
  }

  completeRequest(
    method: string,
    url: string,
    status: number,
    headers: Record<string, string>,
  ): void {
    const entry = this.find(url);
    if (entry) {
      entry.method = method;
      entry.status = status;
      entry.headers = maskHeaders(headers);
    }
  }

  failRequest(url: string, why: string): void {
    const entry = this.find(url);
    if (entry) entry.failed = why;
  }

  finishRequest(_method: string, url: string): void {
    const entry = this.find(url);
    if (entry) entry.finished = Date.now();
  }

  document(): { log: Record<string, unknown> } {
    const entries = this.order
      .map((k) => this.byKey.get(k))
      .filter((e): e is HarPending => Boolean(e))
      .map((e) => ({
        startedDateTime: new Date(e.started).toISOString(),
        time: Math.max(0, (e.finished ?? Date.now()) - e.started),
        request: {
          method: e.method,
          url: e.url,
          httpVersion: "HTTP/1.1",
          headers: [],
        },
        response: e.status
          ? {
              status: e.status,
              statusText: "",
              httpVersion: "HTTP/1.1",
              headers: Object.entries(e.headers ?? {}).map(([name, value]) => ({ name, value })),
            }
          : {
              status: 0,
              statusText: e.failed ?? "incomplete",
              httpVersion: "HTTP/1.1",
              headers: [],
            },
        ...(e.failed ? { error: e.failed } : {}),
      }));
    return {
      log: {
        version: "1.2",
        creator: { name: "argus", version: ARGUS_VERSION },
        entries,
      },
    };
  }

  private find(url: string): HarPending | undefined {
    // Most recent unfinished entry for this URL (retries share a URL).
    for (let i = this.order.length - 1; i >= 0; i--) {
      const entry = this.byKey.get(this.order[i] as string);
      if (entry && entry.url === url && entry.finished === undefined) return entry;
    }
    for (let i = this.order.length - 1; i >= 0; i--) {
      const entry = this.byKey.get(this.order[i] as string);
      if (entry && entry.url === url) return entry;
    }
    return undefined;
  }
}

function maskHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SENSITIVE_HEADERS.has(k.toLowerCase()) ? "[REDACTED]" : v;
  }
  return out;
}
