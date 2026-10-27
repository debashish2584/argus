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
 *   *      static (web/) with SPA fallback
 */
import http from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ProjectRegistry,
  RegistryError,
  NAME_RE,
  type RegistryProject,
} from "./registry.js";
import {
  projectSummary,
  readPlans,
  readState,
  runDetail,
  resolveEvidence,
  readJsonSafe,
  EVIDENCE_CONTENT_TYPES,
  planHistories,
  type ProjectSummary,
  type PlanHistory,
  type RunSummaryJson,
} from "./data.js";

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
}

export interface ProjectApiEntry extends ProjectSummary {
  plan_histories: PlanHistory[];
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
  ) => void;
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
      server.on("error", reject);
      server.listen(port, host, () => resolve());
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
      this.json(res, err.code ?? 500, { error: err.message });
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
            r.fn(params, url, body, res);
          } catch (e) {
            const err = e as Error & { code?: number };
            this.json(res, err.code ?? 500, { error: err.message });
          }
        });
        return;
      }
      r.fn(params, url, body, res);
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
      this.json(res, 200, {
        project: summary,
        plans,
        plan_histories: this.historiesFor(proj.path),
        runs,
        bugs: state.bugs,
      });
    };

    const runRoute = (params: Record<string, string>, _u: URL, _b: string | null, res: http.ServerResponse) => {
      const proj = this.findProject(params.name as string);
      if (!proj) throw this.err(404, `no project '${params.name}'`);
      const detail = runDetail(proj.path, params.runId as string);
      if (!detail) throw this.err(404, `no run '${params.runId}'`);
      this.json(res, 200, { run: detail });
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
      { method: "GET", re: /^\/api\/health$/, params: [], fn: (_p, _u, _b, res) => this.json(res, 200, { ok: true, version: "0.1.0", projects: this.safeRegistry().projects.length + this.oneOff.length }) },
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
