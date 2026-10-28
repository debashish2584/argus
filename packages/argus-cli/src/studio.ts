/**
 * `argus studio` — thin bridge to @argus/studio (mission control).
 *
 * Keeps the main CLI a thin surface: argument parsing + exit codes here,
 * the server/registry logic lives in @argus/studio. The dynamic import
 * keeps studio code out of every other `argus` command's startup path.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface StudioServeOptions {
  port?: string;
  host?: string;
  open?: boolean;
  /** One-off project directories (not persisted to the registry). */
  project: string[];
}

export async function studioServe(opts: StudioServeOptions): Promise<void> {
  const { StudioServer, oneOffFromDirs, defaultRegistryPath } = await import("@argus/studio");
  const server = new StudioServer({
    host: opts.host,
    port: opts.port ? Number(opts.port) : undefined,
    oneOff: oneOffFromDirs(opts.project),
    // console.log so the daemon (stdout → studio.log) and the foreground
    // server log identically: startup, every trigger/stop, and 5xx errors.
    log: (msg) => console.log(`[${new Date().toISOString()}] ${msg}`),
  });
  await server.start();
  const host = opts.host ?? "127.0.0.1";
  const shown = host === "0.0.0.0" ? "127.0.0.1" : host;
  const url = `http://${shown}:${server.port}`;
  console.log("┌──────────────────────────────────────────────────────┐");
  console.log("│  Argus Studio — mission control                     │");
  console.log("└──────────────────────────────────────────────────────┘");
  console.log(`  ${url}`);
  console.log(`  registry: ${defaultRegistryPath()}`);
  console.log("  projects: add from the UI, or `argus studio add <repo-with-.argus>`");
  if (opts.open) openBrowser(url);
  console.log("  ctrl-c to stop");
  // run until interrupted
  await new Promise(() => {});
}

export async function studioAdd(dir: string, name?: string): Promise<void> {
  const { ProjectRegistry, defaultRegistryPath, slugifyDir } = await import("@argus/studio");
  const proj = new ProjectRegistry().add(name ?? slugifyDir(dir), dir);
  console.log(`✓ registered '${proj.name}' → ${proj.path}`);
  console.log(`  registry: ${defaultRegistryPath()}`);
}

export async function studioRemove(name: string): Promise<void> {
  const { ProjectRegistry } = await import("@argus/studio");
  new ProjectRegistry().remove(name);
  console.log(`✓ removed '${name}'`);
}

export async function studioList(): Promise<void> {
  const { ProjectRegistry, defaultRegistryPath } = await import("@argus/studio");
  const projects = new ProjectRegistry().list();
  console.log(`registry: ${defaultRegistryPath()}`);
  if (projects.length === 0) {
    console.log("  (none — `argus studio add <repo-with-.argus>` to register a project)");
    return;
  }
  for (const p of projects) {
    const ok = existsSync(p.path) ? "ok " : "GONE";
    console.log(`  [${ok}] ${p.name} → ${p.path}`);
  }
}

export interface StudioOpenOptions {
  port?: string;
  host?: string;
}

/** The subset of the `/api/health` response the launcher needs. */
export interface HealthBody {
  ok?: boolean;
  version?: string;
  /** Hash of the server runtime + served SPA (undefined on older builds). */
  build_id?: string;
  projects?: number;
}

export type LaunchDecision = "open" | "restart" | "start";

/**
 * What the launcher should do, given the running server's health response
 * (or null when nothing healthy is on the port) and the installed build's
 * fingerprint:
 *
 *   - `open`    — healthy and running the same build → just open the browser.
 *   - `restart` — healthy but running a DIFFERENT build (or a pre-fingerprint
 *                 build that reports no build id at all) → stop it and start a
 *                 fresh server, so the UI and the API stay in lockstep.
 *   - `start`   — nothing healthy on the port → start the server.
 */
export function decideLaunch(health: HealthBody | null, localBuildId: string | null): LaunchDecision {
  if (!health || health.ok !== true) return "start";
  if (!localBuildId) return "open"; // can't verify — leave the running server alone
  return health.build_id === localBuildId ? "open" : "restart";
}

export async function getHealth(url: string): Promise<HealthBody | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    return (await res.json()) as HealthBody;
  } catch {
    return null;
  }
}

/**
 * Stop whatever is serving the studio port so a fresh server can bind it.
 *
 * Order of operations: SIGTERM the pid from `home/studio.pid` (what the
 * launcher itself writes); if the port is still live, fall back to finding
 * the actual socket listener via /proc (covers a server started by hand,
 * without a pid file) and SIGKILL it. Throws if the port stays occupied.
 */
export async function stopServer(port: number, home: string, host = "127.0.0.1"): Promise<void> {
  const healthUrl = `http://${host}:${port}/api/health`;
  const pidFile = path.join(home, "studio.pid");
  const signaled: number[] = [];
  try {
    const t = readFileSync(pidFile, "utf8").trim();
    if (/^\d+$/.test(t)) {
      const pid = Number(t);
      try {
        process.kill(pid, "SIGTERM");
        signaled.push(pid);
      } catch {
        // stale pid — already gone; skip the wait and go to the /proc scan
      }
    }
  } catch {
    // no pid file (or unreadable) — fall through to the /proc scan
  }
  if (signaled.length > 0 && await portFree(healthUrl, 5000)) return;

  const listener = findPortListener(port);
  if (listener) {
    try {
      process.kill(listener, "SIGKILL");
    } catch {
      // already gone
    }
    if (await portFree(healthUrl, 3000)) return;
  }

  throw new Error(
    `port ${port} is still in use after stopping the old server ` +
      `(tried pid ${signaled.length ? signaled.join(", ") : "n/a"}${listener ? ` and listener pid ${listener}` : ""})`,
  );
}

async function portFree(healthUrl: string, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!(await getHealth(healthUrl))) return true;
    await sleep(150);
  }
  return !(await getHealth(healthUrl));
}

/**
 * Find the pid listening on `port` by matching socket inodes in
 * /proc/net/tcp{,6} against /proc/<pid>/fd links. Linux-only, best-effort:
 * returns null when the platform or /proc doesn't allow it.
 */
export function findPortListener(port: number): number | null {
  if (process.platform !== "linux") return null;
  const inodes = new Set<string>();
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of content.split("\n").slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 10) continue;
      // columns: sl local_address rem_address st … timeout inode
      const localPort = cols[1]?.split(":")[1];
      const inode = cols[9];
      if (cols[3] === "0A" && localPort && inode && parseInt(localPort, 16) === port) inodes.add(inode);
    }
  }
  if (inodes.size === 0) return null;
  let pids: string[];
  try {
    pids = readdirSync("/proc").filter((d) => /^\d+$/.test(d));
  } catch {
    return null;
  }
  for (const pid of pids) {
    let fds: string[];
    try {
      fds = readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue; // no permission / gone
    }
    for (const fd of fds) {
      let link = "";
      try {
        link = readlinkSync(`/proc/${pid}/fd/${fd}`);
      } catch {
        continue;
      }
      const m = link.match(/^socket:\[(\d+)\]$/);
      if (m && m[1] && inodes.has(m[1])) return Number(pid);
    }
  }
  return null;
}

/**
 * `argus studio open` — the launcher entry point (what a taskbar/desktop
 * icon runs). Ensures the dashboard server is running **and current**:
 *
 *   1. health-check the port; if a healthy server answers, compare its
 *      build id to the installed build. Same → just open the browser.
 *      Different (or a pre-fingerprint server) → stop the old server and
 *      start a fresh one, so the served UI and the API are in lockstep —
 *      otherwise the SPA shows new features the in-memory server doesn't
 *      have ("no such API route").
 *   2. if nothing healthy is on the port, start the server as a detached
 *      daemon (log + pid under the studio home), wait until it is healthy
 *      (15 s budget), then open it.
 *
 * Idempotent — safe to invoke repeatedly (e.g. every time the icon is
 * clicked). A browser app can't start a local server, so this native
 * launcher is what makes a pinned icon "just work".
 */
export async function studioOpen(opts: StudioOpenOptions): Promise<void> {
  const port = opts.port ? Number(opts.port) : 4900;
  const host = opts.host ?? "127.0.0.1";
  const browserHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  const url = `http://${browserHost}:${port}`;
  const healthUrl = `${url}/api/health`;

  const { defaultRegistryPath, buildId } = await import("@argus/studio");
  const home = path.dirname(defaultRegistryPath());
  const localBuild = buildId();
  const health = await getHealth(healthUrl);
  const decision = decideLaunch(health, localBuild);

  if (decision === "open") {
    console.log(`✓ Argus Studio is already running at ${url} (build ${health!.build_id})`);
    openBrowser(url);
    return;
  }
  if (decision === "restart") {
    console.log(
      `Argus Studio on :${port} is running stale code ` +
        `(server build ${health!.build_id ?? "unknown"}, installed build ${localBuild}) — ` +
        `restarting it to pick up the new build…`,
    );
    try {
      await stopServer(port, home, browserHost);
      console.log("  old server stopped.");
    } catch (e) {
      console.error(`✗ could not stop the running server: ${(e as Error).message}`);
      console.error(`  stop it manually — e.g. kill $(cat ${path.join(home, "studio.pid")}) — and try again.`);
      process.exitCode = 1;
      return;
    }
  } else {
    console.log("Argus Studio is not running — starting it…");
  }

  const binPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
  if (!binPath) throw new Error("could not resolve the argus bin path");

  mkdirSync(home, { recursive: true });
  const logFile = path.join(home, "studio.log");
  const pidFile = path.join(home, "studio.pid");

  const args = [binPath, "studio", "--port", String(port)];
  if (host !== "127.0.0.1") args.push("--host", host);
  const logStream = openSync(logFile, "a");
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ["ignore", logStream, logStream],
  });
  if (child.pid) writeFileSync(pidFile, String(child.pid));
  child.unref();
  closeSync(logStream);

  let exitCode: number | null = null;
  child.on("exit", (code) => (exitCode = code ?? 0));

  const deadline = Date.now() + 15_000;
  let up = false;
  while (Date.now() < deadline) {
    if ((await getHealth(healthUrl))?.ok) {
      up = true;
      break;
    }
    if (exitCode !== null) break; // server died during startup
    await sleep(250);
  }

  if (!up) {
    console.error(`✗ Argus Studio did not become healthy within 15s.`);
    if (exitCode !== null) {
      console.error(`  the server process exited early (code ${exitCode}).`);
    }
    console.error(`  port already taken by another process, or a startup error — see log: ${logFile}`);
    process.exitCode = 1;
    return;
  }

  const upHealth = await getHealth(healthUrl);
  console.log(`✓ Argus Studio started at ${url} (build ${upHealth?.build_id ?? "n/a"})`);
  console.log(`  pid ${child.pid} (stop with: kill $(cat ${pidFile}))`);
  console.log(`  log: ${logFile} (server startup + every trigger/stop is logged there)`);
  openBrowser(url);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Open `url` in a browser.
 *
 * Honors a `$BROWSER` override first (a conventional knob — also what makes
 * the open step testable headlessly, since some `xdg-open` builds ignore
 * `$BROWSER` in favor of the system default handler). When `$BROWSER` is
 * unset, falls back to the platform default.
 */
function openBrowser(url: string): void {
  let cmd: string;
  let args: string[];
  const override = process.env.BROWSER;
  const parts = override ? override.trim().split(/\s+/) : [];
  if (override && parts[0]) {
    cmd = parts[0];
    // Support the common "%s" placeholder; otherwise append the URL.
    args = parts
      .slice(1)
      .map((p) => (p === "%s" ? url : p));
    if (!override.includes("%s")) args.push(url);
  } else if (process.platform === "darwin") {
    cmd = "open";
    args = [url];
  } else if (process.platform === "win32") {
    cmd = "cmd";
    args = ["/c", "start", "", url];
  } else {
    cmd = "xdg-open";
    args = [url];
  }
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // no browser available — the URL on stdout is enough
  }
}
