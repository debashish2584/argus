/**
 * `argus studio` — thin bridge to @argus/studio (mission control).
 *
 * Keeps the main CLI a thin surface: argument parsing + exit codes here,
 * the server/registry logic lives in @argus/studio. The dynamic import
 * keeps studio code out of every other `argus` command's startup path.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

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

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // no browser available — the URL on stdout is enough
  }
}
