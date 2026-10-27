/**
 * Project registry — which target repositories Argus Studio monitors.
 *
 * The registry lives OUTSIDE any single target repo (it is a fleet-wide
 * setting), at `$XDG_CONFIG_HOME/argus/projects.json` (default
 * `~/.config/argus/projects.json`; override with `ARGUS_STUDIO_HOME`).
 * Format:
 *   { "version": 1, "projects": [ { "name": "cogniflow", "path": "/abs/path", "added_at": "..." } ] }
 *
 * Names are URL-safe slugs so they can appear in API routes as-is.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

export interface RegistryProject {
  /** URL-safe slug, unique. */
  name: string;
  /** Absolute path to the target repository (must contain `.argus/`). */
  path: string;
  added_at: string;
}

export interface RegistryFile {
  version: 1;
  projects: RegistryProject[];
}

export const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function defaultRegistryPath(): string {
  if (process.env.ARGUS_STUDIO_HOME) return process.env.ARGUS_STUDIO_HOME;
  const xdg = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(xdg, "argus", "projects.json");
}

export class RegistryError extends Error {}

export class ProjectRegistry {
  constructor(readonly file: string = defaultRegistryPath()) {}

  private read(): RegistryFile {
    if (!existsSync(this.file)) return { version: 1, projects: [] };
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.file, "utf8"));
    } catch (e) {
      throw new RegistryError(
        `registry ${this.file} is corrupt: ${(e as Error).message} — fix or delete it`,
      );
    }
    const r = raw as Partial<RegistryFile>;
    if (r.version !== 1 || !Array.isArray(r.projects)) {
      throw new RegistryError(`registry ${this.file}: unsupported shape (want version 1)`);
    }
    return r as RegistryFile;
  }

  private write(reg: RegistryFile): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    // Atomic: write a sibling temp file, then rename over the real one.
    const tmp = `${this.file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(reg, null, 2) + "\n", "utf8");
    renameSync(tmp, this.file);
  }

  list(): RegistryProject[] {
    return this.read().projects;
  }

  get(name: string): RegistryProject | undefined {
    return this.list().find((p) => p.name === name);
  }

  add(name: string, repoPath: string): RegistryProject {
    if (!NAME_RE.test(name)) {
      throw new RegistryError(
        `invalid project name '${name}' — use lowercase letters, digits, '.', '_', '-' (starting alphanumeric)`,
      );
    }
    const abs = path.resolve(repoPath);
    if (!existsSync(path.join(abs, ".argus"))) {
      throw new RegistryError(
        `${abs} does not contain a .argus/ directory — run 'argus init --repo ${abs}' first`,
      );
    }
    const reg = this.read();
    if (reg.projects.some((p) => p.name === name)) {
      throw new RegistryError(`project '${name}' already exists`);
    }
    const existing = reg.projects.find((p) => p.path === abs);
    if (existing && existing.name !== name) {
      throw new RegistryError(`${abs} is already registered as '${existing.name}'`);
    }
    const proj: RegistryProject = { name, path: abs, added_at: new Date().toISOString() };
    reg.projects.push(proj);
    this.write(reg);
    return proj;
  }

  remove(name: string): void {
    const reg = this.read();
    const before = reg.projects.length;
    reg.projects = reg.projects.filter((p) => p.name !== name);
    if (reg.projects.length === before) throw new RegistryError(`no project named '${name}'`);
    this.write(reg);
  }

  /** All registered projects whose path still exists on disk. */
  listExisting(): RegistryProject[] {
    return this.list().filter((p) => existsSync(p.path));
  }
}

/**
 * Copy a whole Argus workspace (state, runs, plans) into a new location —
 * used by tests to fabricate fixtures without a real `argus heal` run.
 */
export function copyArgusTree(src: string, dst: string): void {
  if (!existsSync(src)) throw new RegistryError(`source ${src} missing`);
  cpSync(src, dst, { recursive: true });
}

/* ------------------------------------------------------------------ */
/* one-off projects (used by CLIs that pass dirs without registering)  */
/* ------------------------------------------------------------------ */

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

/** URL-safe slug for a repo directory (basename, truncated, path-hashed). */
export function slugifyDir(dir: string): string {
  const abs = path.resolve(dir);
  let base = path.basename(abs).toLowerCase().replace(/[^a-z0-9._-]/g, "-") || "project";
  if (!NAME_RE.test(base)) base = "project";
  if (base.length > 40) base = `${base.slice(0, 40)}-${(Math.abs(hash(abs)) % 1296).toString(36)}`;
  return base;
}

/** Build one-off project entries from directories (not persisted to the registry). */
export function oneOffFromDirs(dirs: string[]): Array<{ name: string; path: string }> {
  return dirs.map((d) => ({ name: slugifyDir(d), path: path.resolve(d) }));
}
