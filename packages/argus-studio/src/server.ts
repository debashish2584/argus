/**
 * Studio server — zero-dependency node:http API + static host.
 *
 * Binds 127.0.0.1 by default (this is a local mission-control surface; it
 * reads arbitrary target-repo state, so it must not be exposed without
 * thought). Pass host "0.0.0.0" explicitly if you need remote access.
 *
 * Routes:
 *   GET    /api/health
 *   GET    /api/projects
 *   POST   /api/projects                       { name, path }
 *   DELETE /api/projects/:name
 *   GET    /api/projects/:name
 *   GET    /api/projects/:name/runs/:runId
 *   GET    /api/projects/:name/runs/:runId/evidence?scenario=&file=
 *   GET    /api/projects/:name/plans
 *   POST   /api/projects/:name/pipeline        { action: plan | run | auto-run }
 *   POST   /api/projects/:name/runs/:runId/fix { severity? }
 *   POST   /api/projects/:name/pipeline/stop
 *   *      static (web/) with SPA fallback
 *
 * Pipeline triggers spawn the built `argus` CLI as a tracked child process
 * (one active run per project, 409 otherwise) and are LOOPBACK-ONLY:
 * trigger/stop run code in registered repos, so with `--host 0.0.0.0`
 * they would be remote-code-execution. The gate is isLoopback(remoteAddr).
 */
import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ProjectRegistry,
  RegistryError,
  NAME_RE,
  defaultRegistryPath,
  type RegistryProject,
} from "./registry.js";
import {
  projectSummary,
  readPlans,
  readState,
  runDetail,
  runProgress,
  resolveEvidence,
  readJsonSafe,
  EVIDENCE_CONTENT_TYPES,
  planHistories,
  planCoverage,
  currentBugs,
  type ProjectSummary,
  type PlanHistory,
  type RunSummaryJson,
  type CoverageReport,
} from "./data.js";
import { buildId } from "./build.js";
import { JsonlStateStore, newRunId } from "@argus/core";

export interface StudioOptions {
  host?: string;
  port?: number;
  /** Registry file location (default: ~/.config/argus/projects.json). */
  registryFile?: string;
  /** Static web root (default: the package's web/ directory). */
  webRoot?: string;
  log?: (msg: string) => void;
  /** Extra one-off projects for this server instance (not persisted). */
  oneOff?: Array<{ name: string; path: string }>;
  /**
   * Path to the `argus` CLI entry the pipeline triggers spawn (default:
   * the sibling package's dist/bin.js, or $ARGUS_CLI_BIN). Overridable so
   * tests can point at a stub.
   */
  cliBin?: string;
}

export interface ProjectApiEntry extends ProjectSummary {
  plan_histories: PlanHistory[];
  /** The run this server instance is actively driving (null if idle). */
  active_run: {
    action: PipelineAction;
    run_id: string;
    source_run?: string;
    pid: number;
    started_at: string;
    log_file: string;
  } | null;
  /** Impacted modules vs ACTIVE plans (null: no analyze artifact yet). */
  coverage: CoverageReport | null;
}

interface Route {
  method: "GET" | "POST" | "DELETE";
  re: RegExp;
  params: string[];
  fn: (
    params: Record<string, string>,
    url: URL,
    body: string | null,
    res: http.ServerResponse,
    /** Peer address — only the pipeline triggers use it (loopback gate). */
    remoteAddress?: string,
  ) => void;
}

/** Actions the dashboard can start on a project (fix is per-run). */
export type PipelineAction = "plan" | "run" | "auto-run" | "fix";

const PIPELINE_ACTIONS = ["plan", "run", "auto-run"] as const;
const FIX_SEVERITIES = ["P0-Blocker", "P1-High", "P2-Medium", "P3-Low"] as const;
/** Bug statuses the fix action still considers open (mirrors the CLI). */
const OPEN_BUG_STATUSES = new Set(["new", "confirmed", "unverified"]);

/**
 * Loopback gate for the pipeline trigger endpoints. The server binds
 * 127.0.0.1 by default, so these never fire in practice — but if someone
 * passes `--host 0.0.0.0`, triggering a run in a registered repo would be
 * remote code execution, so we refuse non-local peers outright.
 */
export function isLoopback(remote?: string): boolean {
  if (!remote) return true; // no address (unix socket / test harness) — local
  return remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
}

interface ActiveRun {
  action: PipelineAction;
  runId: string;
  /** For action "fix": the run whose open bugs get fixed. */
  sourceRun?: string;
  pid: number;
  startedAt: string;
  logFile: string;
  child: ChildProcess;
}

export function defaultWebRoot(): string {
  // dist/static.js → package root → web/
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "web");
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
};

export class StudioServer {
  private server: http.Server | null = null;
  private readonly registry: ProjectRegistry;
  private readonly webRoot: string;
  private readonly routes: Route[];
  private readonly log: (m: string) => void;
  private readonly oneOff: Array<{ name: string; path: string }>;
  /** One active run per project name (dashboard-triggered children). */
  private readonly active = new Map<string, ActiveRun>();

  constructor(private opts: StudioOptions = {}) {
    this.registry = new ProjectRegistry(opts.registryFile);
    this.webRoot = opts.webRoot ?? defaultWebRoot();
    this.log = opts.log ?? (() => {});
    this.oneOff = (opts.oneOff ?? []).map((o) => ({
      name: o.name,
      path: path.resolve(o.path),
    }));
    this.routes = this.buildRoutes();
  }

  get port(): number {
    const addr = this.server?.address();
    return typeof addr === "object" && addr ? addr.port : this.opts.port ?? 0;
  }

  start(): Promise<void> {
    const host = this.opts.host ?? "127.0.0.1";
    const port = this.opts.port ?? 4900;
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.handle(req, res));
      server.on("error", (e) => {
        this.log(`studio: listen error on ${host}:${port}: ${e.message}`);
        reject(e);
      });
      server.listen(port, host, () => {
        this.log(
          `studio: listening on http://${host}:${this.port} ` +
            `(build ${buildId()}, registry ${this.registryDir()}, webRoot ${this.webRoot})`,
        );
        resolve();
      });
      this.server = server;
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
  }

  /* ---------------------------------------------------------------- */
  /* routing                                                           */
  /* ---------------------------------------------------------------- */

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "local"}`);
    try {
      if (url.pathname.startsWith("/api/")) {
        this.routeApi(req, req.method ?? "GET", url, res);
      } else {
        this.serveStatic(url.pathname, res);
      }
    } catch (e) {
      const err = e as Error & { code?: number };
      const code = err.code ?? 500;
      if (code >= 500) this.log(`request failed: ${req.method} ${req.url} → ${code} ${err.message}`);
      this.json(res, code, { error: err.message });
    }
  }

  private routeApi(req: http.IncomingMessage, method: string, url: URL, res: http.ServerResponse): void {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = url.pathname.match(r.re);
      if (!m) continue;
      const params: Record<string, string> = {};
      r.params.forEach((name, i) => (params[name] = decodeURIComponent(m[i + 1] as string)));
      // body (JSON) only for POST
      let body: string | null = null;
      if (method === "POST") {
        let data = "";
        req.on("data", (c: unknown) => (data += String(c)));
        req.on("end", () => {
          body = data || null;
          // async entry point — errors must be caught here, not in handle()
          try {
            r.fn(params, url, body, res, req.socket.remoteAddress);
          } catch (e) {
            const err = e as Error & { code?: number };
            const code = err.code ?? 500;
            if (code >= 500) this.log(`request failed: ${method} ${url.pathname} → ${code} ${err.message}`);
            this.json(res, code, { error: err.message });
          }
        });
        return;
      }
      r.fn(params, url, body, res, req.socket.remoteAddress);
      return;
    }
    this.json(res, 404, { error: "no such API route" });
  }

  private buildRoutes(): Route[] {
    const safeName = String.raw`[a-z0-9][a-z0-9._-]*`;

    const projects = (_p: Record<string, string>, _u: URL, _b: string | null, res: http.ServerResponse) => {
      const regProjects = this.safeRegistry().projects;
      const all = [...regProjects, ...this.oneOff];
      const out: ProjectApiEntry[] = all
        .map((p) => {
          const state = this.stateFor(p.path);
          if (!state) return null;
          const plans = this.plansFor(p.path);
          if (plans === null) return null;
          return {
            ...projectSummary(p.name, p.path, state, plans),
            plan_histories: this.historiesFor(p.path),
          };
        })
        .filter((p): p is ProjectApiEntry => p !== null);
      // one-off names win over registry duplicates (same path)
      const seen = new Set<string>();
      const dedup = out
        .sort((a, b) => (a.name < b.name ? -1 : 1))
        .filter((p) => {
          const key = p.path;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      this.json(res, 200, { projects: dedup });
    };

    const addProject = (
      _params: Record<string, string>,
      _url: URL,
      body: string | null,
      res: http.ServerResponse,
    ) => {
      if (!body) throw this.err(400, "JSON body required: { name, path }");
      let payload: { name?: string; path?: string };
      try {
        payload = JSON.parse(body);
      } catch {
        throw this.err(400, "invalid JSON body");
      }
      const name = typeof payload.name === "string" ? payload.name : "";
      const p = typeof payload.path === "string" ? payload.path : "";
      if (!NAME_RE.test(name)) throw this.err(400, "invalid project name");
      if (!p) throw this.err(400, "path required");
      try {
        const proj = this.registry.add(name, p);
        this.json(res, 201, { project: proj });
      } catch (e) {
        const regErr = e as RegistryError;
        throw this.err(400, regErr.message);
      }
    };

    const removeProject = (
      params: Record<string, string>,
      _url: URL,
      _body: string | null,
      res: http.ServerResponse,
    ) => {
      try {
        this.registry.remove(params.name as string);
        this.json(res, 200, { removed: params.name });
      } catch (e) {
        throw this.err(400, (e as RegistryError).message);
      }
    };

    const projectDetail = (params: Record<string, string>, _u: URL, _b: string | null, res: http.ServerResponse) => {
      const proj = this.findProject(params.name as string);
      if (!proj) throw this.err(404, `no project '${params.name}'`);
      const state = this.stateFor(proj.path);
      if (!state) throw this.err(404, "project has no readable .argus/state");
      const plans = this.plansFor(proj.path) ?? [];
      const summary = projectSummary(proj.name, proj.path, state, plans);
      // enrich each terminal run with its summary + bug count so the runs
      // table can show plans/failures/bugs without a second round-trip
      const runs = state
        .runs.filter((r) => r.status !== "running")
        .map((r) => {
          const s = this.runSummaryFor(proj.path, r.run_id);
          return {
            ...r,
            plans_executed: s?.plans_executed ?? null,
            failures: s?.failures ?? null,
            bug_count: state.bugs.filter((b) => b.run_id === r.run_id).length,
          };
        });
      const act = this.active.get(proj.name);
      this.json(res, 200, {
        project: summary,
        plans,
        plan_histories: this.historiesFor(proj.path),
        runs,
        bugs: state.bugs,
        active_run: act
          ? {
              action: act.action,
              run_id: act.runId,
              ...(act.sourceRun ? { source_run: act.sourceRun } : {}),
              pid: act.pid,
              started_at: act.startedAt,
              log_file: act.logFile,
            }
          : null,
        coverage: planCoverage(proj.path, state.runs, plans),
      });
    };

    /* ---------------- pipeline triggers (loopback-only) ------------- */

    const triggerPipeline = (
      params: Record<string, string>,
      _u: URL,
      body: string | null,
      res: http.ServerResponse,
      remote?: string,
    ) => {
      if (!isLoopback(remote))
        throw this.err(403, "pipeline triggers are loopback-only (server is bound to a public interface)");
      const proj = this.findProject(params.name as string);
      if (!proj) throw this.err(404, `no project '${params.name}'`);
      if (!existsSync(path.join(proj.path, ".argus")))
        throw this.err(400, "project has no .argus workspace — run `argus init` there first");
      let action: unknown;
      try {
        action = body ? (JSON.parse(body) as { action?: unknown }).action : undefined;
      } catch {
        throw this.err(400, "JSON body required: { action: plan | run | auto-run }");
      }
      if (!PIPELINE_ACTIONS.includes(action as (typeof PIPELINE_ACTIONS)[number]))
        throw this.err(400, `action must be one of: ${PIPELINE_ACTIONS.join(", ")}`);
      if (this.active.has(proj.name)) {
        const cur = this.active.get(proj.name)!;
        throw this.err(409, `a ${cur.action} is already running (${cur.runId}) — stop it first`);
      }
      const runId = newRunId();
      const started = this.spawnPipeline(proj, action as PipelineAction, runId);
      this.log(`pipeline: ${action} triggered for '${proj.name}' → run ${runId} (pid ${started.pid}, log ${started.logFile})`);
      this.json(res, 202, {
        action: action,
        run_id: runId,
        pid: started.pid,
        started_at: started.startedAt,
        log_file: started.logFile,
      });
    };

    const triggerFix = (
      params: Record<string, string>,
      _u: URL,
      body: string | null,
      res: http.ServerResponse,
      remote?: string,
    ) => {
      if (!isLoopback(remote))
        throw this.err(403, "pipeline triggers are loopback-only (server is bound to a public interface)");
      const proj = this.findProject(params.name as string);
      if (!proj) throw this.err(404, `no project '${params.name}'`);
      if (!existsSync(path.join(proj.path, ".argus")))
        throw this.err(400, "project has no .argus workspace — run `argus init` there first");
      if (this.active.has(proj.name)) {
        const cur = this.active.get(proj.name)!;
        throw this.err(409, `a ${cur.action} is already running (${cur.runId}) — stop it first`);
      }
      const state = this.stateFor(proj.path);
      if (!state) throw this.err(404, "project has no readable .argus/state");
      const srcRun = params.runId as string;
      if (!state.runs.some((r) => r.run_id === srcRun)) throw this.err(404, `no run '${srcRun}'`);
      const open = currentBugs(state.bugs).filter((b) => b.run_id === srcRun && OPEN_BUG_STATUSES.has(b.status));
      if (open.length === 0) throw this.err(400, `run ${srcRun} has no open bugs to fix`);
      let severities: string[] = [];
      if (body) {
        let sev: unknown;
        try {
          sev = (JSON.parse(body) as { severity?: unknown }).severity;
        } catch {
          throw this.err(400, "JSON body required: { severity?: string[] }");
        }
        if (sev !== undefined) {
          if (!Array.isArray(sev) || sev.some((s) => typeof s !== "string"))
            throw this.err(400, "severity must be an array of severity ids");
          severities = sev as string[];
          const bad = severities.filter((s) => !(FIX_SEVERITIES as readonly string[]).includes(s));
          if (bad.length > 0)
            throw this.err(400, `invalid severity '${bad[0]}' (expected: ${FIX_SEVERITIES.join(", ")})`);
        }
      }
      const runId = newRunId();
      const started = this.spawnPipeline(proj, "fix", runId, srcRun, severities);
      this.log(
        `pipeline: fix triggered for '${proj.name}' → run ${runId} ` +
          `(${open.length} open bug${open.length === 1 ? "" : "s"} from ${srcRun}` +
          `${severities.length ? `, severities ${severities.join(", ")}` : ""}, pid ${started.pid}, log ${started.logFile})`,
      );
      this.json(res, 202, {
        action: "fix",
        run_id: runId,
        source_run: srcRun,
        open_bugs: open.length,
        pid: started.pid,
        started_at: started.startedAt,
        log_file: started.logFile,
      });
    };

    const stopPipeline = (
      params: Record<string, string>,
      _u: URL,
      _b: string | null,
      res: http.ServerResponse,
      remote?: string,
    ) => {
      if (!isLoopback(remote))
        throw this.err(403, "pipeline triggers are loopback-only (server is bound to a public interface)");
      const proj = this.findProject(params.name as string);
      if (!proj) throw this.err(404, `no project '${params.name}'`);
      const cur = this.active.get(proj.name);
      if (!cur) throw this.err(404, "no run in progress");
      this.log(`pipeline: stop requested for '${proj.name}' run ${cur.runId} (action ${cur.action}, pid ${cur.pid})`);
      try {
        cur.child.kill("SIGTERM");
      } catch (e) {
        this.log(`stop: kill failed for ${cur.runId}: ${(e as Error).message}`);
      }
      // Mark the run aborted. The CLI usually writes its own terminal row
      // first (only overwrite a `running` row); if we won the race before
      // the child could start, record a minimal row so the run doesn't
      // sit as `running` forever.
      try {
        const store = new JsonlStateStore(path.join(proj.path, ".argus", "state"));
        const last = store.lastRuns(1000).filter((r) => r.run_id === cur.runId).at(-1);
        const endedAt = new Date().toISOString();
        if (last && last.status === "running") {
          store.recordRun({ ...last, status: "aborted", ended_at: endedAt });
        } else if (!last) {
          store.recordRun({
            run_id: cur.runId,
            started_at: cur.startedAt,
            ended_at: endedAt,
            status: "aborted",
            target_repo: proj.path,
            head: "",
            config_hash: "",
            stages: [],
          });
        }
      } catch (e) {
        this.log(`stop: state update failed for ${cur.runId}: ${(e as Error).message}`);
      }
      // the child's `exit` event clears the tracking entry
      this.json(res, 200, { stopped: true, run_id: cur.runId });
    };

    const runRoute = (params: Record<string, string>, _u: URL, _b: string | null, res: http.ServerResponse) => {
      const proj = this.findProject(params.name as string);
      if (!proj) throw this.err(404, `no project '${params.name}'`);
      const detail = runDetail(proj.path, params.runId as string);
      if (!detail) throw this.err(404, `no run '${params.runId}'`);
      this.json(res, 200, { run: detail });
    };

    /**
     * Live progress for a run: the ordered stage track, per-stage status,
     * and a tail of the per-run trigger log. Cheap by design (reads only
     * runs.jsonl + stages.jsonl + the log file), so the UI can poll it
     * every couple of seconds while a run is in flight.
     */
    const runProgressRoute = (params: Record<string, string>, _u: URL, _b: string | null, res: http.ServerResponse) => {
      const proj = this.findProject(params.name as string);
      if (!proj) throw this.err(404, `no project '${params.name}'`);
      const runId = params.runId as string;
      const act = this.active.get(proj.name);
      const logFile =
        act && act.runId === runId
          ? act.logFile
          : path.join(this.registryDir(), "run-logs", `${proj.name}-${runId}.log`);
      this.json(res, 200, runProgress(proj.path, runId, logFile, 30));
    };

    const evidence = (
      params: Record<string, string>,
      url: URL,
      _b: string | null,
      res: http.ServerResponse,
    ) => {
      const proj = this.findProject(params.name as string);
      if (!proj) throw this.err(404, `no project '${params.name}'`);
      const scenario = url.searchParams.get("scenario") ?? "";
      const file = url.searchParams.get("file") ?? "";
      const r = resolveEvidence(proj.path, params.runId as string, scenario, file);
      if (!r.ok) throw this.err(r.code, r.reason);
      const ct = EVIDENCE_CONTENT_TYPES[path.basename(r.file)];
      if (!ct) throw this.err(400, "unsupported artifact type");
      res.writeHead(200, {
        "Content-Type": ct,
        "Content-Length": statSync(r.file).size,
        "Cache-Control": "no-store",
      });
      res.end(readFileSync(r.file));
    };

    const plansRoute = (params: Record<string, string>, _u: URL, _b: string | null, res: http.ServerResponse) => {
      const proj = this.findProject(params.name as string);
      if (!proj) throw this.err(404, `no project '${params.name}'`);
      this.json(res, 200, { plans: this.plansFor(proj.path) ?? [] });
    };

    return [
      {
        method: "GET",
        re: /^\/api\/health$/,
        params: [],
        fn: (_p, _u, _b, res) =>
          this.json(res, 200, {
            ok: true,
            version: "0.1.0",
            // Lets `argus studio open` detect a server running older code
            // (its build id no longer matches the installed files) and restart it.
            build_id: buildId(),
            projects: this.safeRegistry().projects.length + this.oneOff.length,
          }),
      },
      { method: "GET", re: /^\/api\/projects$/, params: [], fn: projects },
      { method: "POST", re: /^\/api\/projects$/, params: [], fn: addProject },
      { method: "DELETE", re: new RegExp(`^/api/projects/(${safeName})$`), params: ["name"], fn: removeProject },
      { method: "GET", re: new RegExp(`^/api/projects/(${safeName})$`), params: ["name"], fn: projectDetail },
      {
        method: "GET",
        re: new RegExp(`^/api/projects/(${safeName})/runs/([a-zA-Z0-9._-]+)$`),
        params: ["name", "runId"],
        fn: runRoute,
      },
      {
        method: "GET",
        re: new RegExp(`^/api/projects/(${safeName})/runs/([a-zA-Z0-9._-]+)/progress$`),
        params: ["name", "runId"],
        fn: runProgressRoute,
      },
      {
        method: "GET",
        re: new RegExp(`^/api/projects/(${safeName})/runs/([a-zA-Z0-9._-]+)/evidence$`),
        params: ["name", "runId"],
        fn: evidence,
      },
      {
        method: "GET",
        re: new RegExp(`^/api/projects/(${safeName})/plans$`),
        params: ["name"],
        fn: plansRoute,
      },
      {
        method: "POST",
        re: new RegExp(`^/api/projects/(${safeName})/pipeline$`),
        params: ["name"],
        fn: triggerPipeline,
      },
      {
        method: "POST",
        re: new RegExp(`^/api/projects/(${safeName})/pipeline/stop$`),
        params: ["name"],
        fn: stopPipeline,
      },
      {
        method: "POST",
        re: new RegExp(`^/api/projects/(${safeName})/runs/([a-zA-Z0-9._-]+)/fix$`),
        params: ["name", "runId"],
        fn: triggerFix,
      },
    ];
  }

  /* ---------------------------------------------------------------- */
  /* helpers                                                           */
  /* ---------------------------------------------------------------- */

  private err(code: number, message: string): Error & { code: number } {
    const e = new Error(message) as Error & { code: number };
    e.code = code;
    return e;
  }

  private safeRegistry(): { projects: RegistryProject[] } {
    try {
      return { projects: this.registry.list() };
    } catch (e) {
      this.log(`registry error: ${(e as Error).message}`);
      return { projects: [] };
    }
  }

  private findProject(name: string): { name: string; path: string } | undefined {
    return (
      this.oneOff.find((p) => p.name === name) ??
      this.safeRegistry().projects.find((p) => p.name === name)
    );
  }

  private runSummaryFor(repoPath: string, runId: string): RunSummaryJson | null {
    try {
      return readJsonSafe<RunSummaryJson>(path.join(repoPath, ".argus", "runs", runId, "summary.json"));
    } catch {
      return null;
    }
  }

  private stateFor(repoPath: string) {
    try {
      if (!existsSync(path.join(repoPath, ".argus"))) return null;
      return readState(repoPath);
    } catch (e) {
      this.log(`state read failed for ${repoPath}: ${(e as Error).message}`);
      return null;
    }
  }

  private plansFor(repoPath: string): ReturnType<typeof readPlans> | null {
    try {
      return readPlans(repoPath);
    } catch (e) {
      this.log(`plans read failed for ${repoPath}: ${(e as Error).message}`);
      return null;
    }
  }

  private historiesFor(repoPath: string): PlanHistory[] {
    try {
      return planHistories(repoPath);
    } catch {
      return [];
    }
  }

  /**
   * Spawn a tracked `argus` CLI child for a pipeline action. `--yes` is
   * always implicit — the dashboard has no TTY, so human gates are bypassed
   * by design (the trigger itself is the explicit human act). Output is
   * appended to a per-run log file next to the registry dir.
   */
  private spawnPipeline(
    proj: { name: string; path: string },
    action: PipelineAction,
    runId: string,
    sourceRun?: string,
    severities?: string[],
  ): { pid: number; startedAt: string; logFile: string } {
    const bin = this.resolveCliBin();
    if (!bin) throw this.err(500, "argus CLI entry not found — set ARGUS_CLI_BIN or run from the monorepo");
    const args =
      action === "fix"
        ? [
            "fix",
            "--yes",
            "--run",
            sourceRun!,
            "--run-id",
            runId,
            ...(severities?.length ? severities.flatMap((s) => ["--severity", s]) : []),
          ]
        : [
            action,
            "--yes",
            ...(action === "plan" || action === "auto-run" ? ["--activate"] : []),
            "--run-id",
            runId,
          ];
    const logDir = path.join(this.registryDir(), "run-logs");
    mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, `${proj.name}-${runId}.log`);
    const logStream = createWriteStream(logFile, { flags: "a" });
    logStream.write(`# ${new Date().toISOString()} argus ${args.join(" ")} (cwd ${proj.path})\n`);
    const child = spawn(process.execPath, [bin, ...args], {
      cwd: proj.path,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.pipe(logStream);
    child.stderr.pipe(logStream);
    const entry: ActiveRun = {
      action,
      runId,
      ...(sourceRun ? { sourceRun } : {}),
      pid: child.pid ?? -1,
      startedAt: new Date().toISOString(),
      logFile,
      child,
    };
    const clear = () => {
      if (this.active.get(proj.name)?.runId === runId) this.active.delete(proj.name);
      logStream.end();
    };
    child.on("error", (e) => {
      this.log(`trigger ${action} ${runId}: spawn error: ${e.message}`);
      clear();
    });
    child.on("exit", (code, signal) => {
      this.log(`trigger ${action} ${runId}: exited (code ${code ?? signal})`);
      clear();
    });
    child.unref(); // a run should outlive a server restart, not block its exit
    this.active.set(proj.name, entry);
    return { pid: entry.pid, startedAt: entry.startedAt, logFile };
  }

  /** Where the registry lives (per-run trigger logs are kept alongside it). */
  private registryDir(): string {
    return path.dirname(path.resolve(this.opts.registryFile ?? defaultRegistryPath()));
  }

  private resolveCliBin(): string | null {
    if (this.opts.cliBin) return path.resolve(this.opts.cliBin);
    if (process.env.ARGUS_CLI_BIN) return path.resolve(process.env.ARGUS_CLI_BIN);
    // <root>/packages/argus-studio/dist/server.js → <root>/packages/argus-cli/dist/bin.js
    const fromLocal = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "argus-cli",
      "dist",
      "bin.js",
    );
    return existsSync(fromLocal) ? fromLocal : null;
  }

  private json(res: http.ServerResponse, status: number, body: unknown): void {
    const raw = JSON.stringify(body);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(raw),
      "Cache-Control": "no-store",
    });
    res.end(raw);
  }

  private serveStatic(pathname: string, res: http.ServerResponse): void {
    let rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    let file = path.resolve(this.webRoot, rel);
    if (!file.startsWith(this.webRoot + path.sep) && file !== this.webRoot) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("bad path");
      return;
    }
    // SPA fallback: no extension + not an existing file → index.html
    if (!path.extname(rel) && !existsSync(file)) {
      file = path.join(this.webRoot, "index.html");
    }
    if (!existsSync(file)) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
    const ext = path.extname(file);
    res.writeHead(200, {
      "Content-Type": MIME[ext] ?? "application/octet-stream",
      "Cache-Control": ext === ".html" ? "no-cache" : "no-store",
    });
    res.end(readFileSync(file));
  }
}
