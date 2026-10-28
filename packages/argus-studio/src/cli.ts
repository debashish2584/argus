#!/usr/bin/env node
/**
 * argus-studio — mission control for Argus runs.
 *
 *   argus-studio                      start the dashboard (default :4900)
 *   argus-studio serve --port 4901    same, explicit
 *   argus-studio --project <dir>      one-off project (not persisted)
 *   argus-studio add <dir> [--name x] register a project
 *   argus-studio remove <name>        unregister
 *   argus-studio list                 show registered projects
 *
 * Also reachable as `argus studio …` from the main CLI.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { StudioServer } from "./server.js";
import {
  ProjectRegistry,
  RegistryError,
  defaultRegistryPath,
  NAME_RE,
  slugifyDir,
} from "./registry.js";

interface Flags {
  port?: number;
  host?: string;
  open: boolean;
  oneOff: Array<{ name: string; path: string }>;
  quiet: boolean;
}

function parseArgs(argv: string[]): { cmd: string; args: string[]; flags: Flags } {
  const flags: Flags = { open: false, oneOff: [], quiet: false };
  const cmd = argv[0] && !argv[0].startsWith("-") ? argv[0] : "serve";
  const rest = cmd === argv[0] ? argv.slice(1) : argv;
  const args: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] as string;
    if (a === "--port" || a === "-p") flags.port = Number(rest[++i]);
    else if (a === "--host" || a === "-H") flags.host = rest[++i];
    else if (a === "--project" || a === "-P") {
      const dir = path.resolve(rest[++i] as string);
      flags.oneOff.push({ name: slugifyDir(dir), path: dir });
    } else if (a === "--name" || a === "-n") {
      // name applies to the most recent --project or to `add <dir>`
      const last = flags.oneOff.at(-1);
      const name = rest[++i];
      if (last && name) last.name = name;
    } else if (a === "--open") flags.open = true;
    else if (a === "--quiet" || a === "-q") flags.quiet = true;
    else args.push(a);
  }
  return { cmd, args, flags };
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

async function serve(flags: Flags): Promise<void> {
  const server = new StudioServer({
    host: flags.host,
    port: flags.port,
    oneOff: flags.oneOff,
    // startup, every trigger/stop, and 5xx errors — timestamped to the console
    log: (msg) => console.log(`[${new Date().toISOString()}] ${msg}`),
  });
  await server.start();
  const host = flags.host ?? "127.0.0.1";
  const port = server.port;
  if (!flags.quiet) {
    console.log("┌──────────────────────────────────────────────────┐");
    console.log("│  Argus Studio — mission control                  │");
    console.log("└──────────────────────────────────────────────────┘");
    console.log(`  ${`http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`}`);
    console.log(`  registry: ${defaultRegistryPath()}`);
    console.log("  projects: add from the UI, or `argus-studio add <repo-with-.argus>`");
    console.log("  ctrl-c to stop");
  }
  if (flags.open) openBrowser(`http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`);
  // keep the process alive until ctrl-c
  await new Promise(() => {});
}

function add(flags: Flags, args: string[]): void {
  const dir = args[0];
  if (!dir) throw new RegistryError("usage: argus-studio add <path-to-repo-with-.argus> [--name slug]");
  const name = flags.oneOff.at(-1)?.name;
  const registry = new ProjectRegistry();
  const proj = registry.add(name ?? slugifyDir(dir), dir);
  console.log(`✓ registered '${proj.name}' → ${proj.path}`);
  console.log(`  registry: ${defaultRegistryPath()}`);
}

function remove(args: string[]): void {
  const name = args[0];
  if (!name) throw new RegistryError("usage: argus-studio remove <name>");
  new ProjectRegistry().remove(name);
  console.log(`✓ removed '${name}'`);
}

function list(): void {
  const registry = new ProjectRegistry();
  const projects = registry.list();
  console.log(`registry: ${defaultRegistryPath()}`);
  if (projects.length === 0) {
    console.log("  (none — `argus-studio add <repo-with-.argus>` to register a project)");
    return;
  }
  for (const p of projects) {
    const ok = existsSync(p.path) ? "ok " : "GONE";
    console.log(`  [${ok}] ${p.name} → ${p.path}`);
  }
}

async function main(): Promise<void> {
  const { cmd, args, flags } = parseArgs(process.argv.slice(2));
  switch (cmd) {
    case "serve":
    case "start":
      await serve(flags);
      break;
    case "add":
    case "register":
      add(flags, args);
      break;
    case "remove":
    case "unregister":
      remove(args);
      break;
    case "list":
      list();
      break;
    case "paths": {
      console.log(JSON.stringify(
        { registry: defaultRegistryPath(), web_root: process.env.ARGUS_STUDIO_WEB ?? "(package default)" },
        null, 2,
      ));
      break;
    }
    case "help":
    case "--help":
    case "-h":
      console.log(
        [
          "argus-studio — Argus mission control",
          "",
          "  argus-studio [--port N] [--host H] [--open] [--project <dir>...]   start dashboard",
          "  argus-studio add <repo-with-.argus> [--name slug]                  register project",
          "  argus-studio remove <name>                                         unregister project",
          "  argus-studio list                                                  show projects",
          "",
          "Env: ARGUS_STUDIO_HOME overrides the registry path.",
        ].join("\n"),
      );
      break;
    default:
      throw new RegistryError(`unknown command '${cmd}' — try: argus-studio help`);
  }
}

main().catch((e) => {
  console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
