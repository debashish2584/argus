/**
 * `argus studio` — thin bridge to @argus/studio (mission control).
 *
 * Keeps the main CLI a thin surface: argument parsing + exit codes here,
 * the server/registry logic lives in @argus/studio. The dynamic import
 * keeps studio code out of every other `argus` command's startup path.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, closeSync, writeFileSync } from "node:fs";
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

/**
 * `argus studio open` — the launcher entry point (what a taskbar/desktop
 * icon runs). Ensures the dashboard server is running:
 *
 *   1. health-check the port; if already healthy, just open the browser.
 *   2. otherwise start the server as a detached daemon (log + pid under the
 *      studio home), wait until it is healthy (15 s budget), then open it.
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

  if (await isHealthy(healthUrl)) {
    console.log(`✓ Argus Studio is already running at ${url}`);
    openBrowser(url);
    return;
  }

  console.log("Argus Studio is not running — starting it…");
  const binPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
  if (!binPath) throw new Error("could not resolve the argus bin path");

  const { defaultRegistryPath } = await import("@argus/studio");
  const home = path.dirname(defaultRegistryPath());
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
    if (await isHealthy(healthUrl)) {
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

  console.log(`✓ Argus Studio started at ${url}`);
  console.log(`  pid ${child.pid} (stop with: kill $(cat ${pidFile}))`);
  console.log(`  log: ${logFile}`);
  openBrowser(url);
}

async function isHealthy(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean };
    return body.ok === true;
  } catch {
    return false;
  }
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
