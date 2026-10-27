import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ProjectRegistry,
  RegistryError,
  defaultRegistryPath,
  slugifyDir,
  oneOffFromDirs,
} from "./registry.js";

let root: string;
let registryFile: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "argus-studio-reg-"));
  registryFile = path.join(root, "projects.json");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

/** A repo dir with an empty `.argus/` marker (enough to register). */
function argusRepo(name: string): string {
  const repo = path.join(root, name);
  mkdirSync(path.join(repo, ".argus"), { recursive: true });
  return repo;
}

describe("defaultRegistryPath", () => {
  it("honors ARGUS_STUDIO_HOME", () => {
    vi.stubEnv("ARGUS_STUDIO_HOME", "/tmp/custom/projects.json");
    expect(defaultRegistryPath()).toBe("/tmp/custom/projects.json");
  });

  it("falls back to XDG_CONFIG_HOME", () => {
    vi.stubEnv("ARGUS_STUDIO_HOME", "");
    vi.stubEnv("XDG_CONFIG_HOME", "/tmp/xdg");
    expect(defaultRegistryPath()).toBe(path.join("/tmp/xdg", "argus", "projects.json"));
  });
});

describe("ProjectRegistry.add", () => {
  it("registers a repo that contains .argus/", () => {
    const repo = argusRepo("cogniflow");
    const reg = new ProjectRegistry(registryFile);
    const proj = reg.add("cogniflow", repo);
    expect(proj.name).toBe("cogniflow");
    expect(proj.path).toBe(repo);
    expect(reg.list().map((p) => p.name)).toEqual(["cogniflow"]);
  });

  it("persists an atomic, readable version-1 file", () => {
    const repo = argusRepo("app");
    new ProjectRegistry(registryFile).add("app", repo);
    const raw = JSON.parse(readFileSync(registryFile, "utf8"));
    expect(raw.version).toBe(1);
    expect(Array.isArray(raw.projects)).toBe(true);
    expect(raw.projects[0]!.path).toBe(repo);
  });

  it("rejects invalid slugs", () => {
    const reg = new ProjectRegistry(registryFile);
    const repo = argusRepo("x");
    for (const bad of ["My Repo", "-leading", "UPPER", "", "a".repeat(65), "has/slash"]) {
      expect(() => reg.add(bad, repo)).toThrow(RegistryError);
    }
    // digits are allowed at the start (NAME_RE is [a-z0-9] first)
    expect(() => reg.add("9ok", repo)).not.toThrow();
  });

  it("rejects a path without .argus/", () => {
    const plain = path.join(root, "plain");
    mkdirSync(plain, { recursive: true });
    expect(() => new ProjectRegistry(registryFile).add("plain", plain)).toThrow(/\.argus/);
  });

  it("rejects a duplicate name", () => {
    const reg = new ProjectRegistry(registryFile);
    const repo = argusRepo("dup");
    reg.add("dup", repo);
    expect(() => reg.add("dup", argusRepo("other"))).toThrow(/already exists/);
  });

  it("rejects re-registering a path under a different name", () => {
    const reg = new ProjectRegistry(registryFile);
    const repo = argusRepo("same-path");
    reg.add("alpha", repo);
    expect(() => reg.add("beta", repo)).toThrow(/already registered/);
  });
});

describe("ProjectRegistry.remove / list", () => {
  it("removes a registered project", () => {
    const reg = new ProjectRegistry(registryFile);
    reg.add("a", argusRepo("a"));
    reg.add("b", argusRepo("b"));
    reg.remove("a");
    expect(reg.list().map((p) => p.name)).toEqual(["b"]);
  });

  it("throws on removing an unknown name", () => {
    expect(() => new ProjectRegistry(registryFile).remove("ghost")).toThrow(/no project/);
  });

  it("listExisting filters out paths that vanished", () => {
    const reg = new ProjectRegistry(registryFile);
    const live = argusRepo("live");
    const gone = argusRepo("gone");
    reg.add("live", live);
    reg.add("gone", gone);
    rmSync(gone, { recursive: true, force: true });
    expect(reg.listExisting().map((p) => p.name)).toEqual(["live"]);
  });

  it("survives a missing registry file (empty fleet)", () => {
    expect(new ProjectRegistry(registryFile).list()).toEqual([]);
  });

  it("raises a RegistryError on a corrupt registry", () => {
    writeFileSync(registryFile, "{ not json", "utf8");
    expect(() => new ProjectRegistry(registryFile).list()).toThrow(/corrupt/);
  });

  it("raises a RegistryError on an unsupported version", () => {
    writeFileSync(registryFile, JSON.stringify({ version: 2, projects: [] }), "utf8");
    expect(() => new ProjectRegistry(registryFile).list()).toThrow(/version/);
  });
});

describe("slugifyDir", () => {
  it("uses the sanitized basename", () => {
    expect(slugifyDir("/home/user/my-repo")).toBe("my-repo");
    expect(slugifyDir("/home/user/My Repo")).toBe("my-repo");
  });

  it("is stable for a given path (short basenames collide; server dedups by path)", () => {
    expect(slugifyDir("/tmp/deep/one/project")).toBe("project");
    expect(slugifyDir("/tmp/deep/one/project")).toBe(slugifyDir("/tmp/deep/one/project"));
  });

  it("truncates very long basenames with a hash suffix", () => {
    const long = slugifyDir("/x/" + "a".repeat(80));
    expect(long.length).toBeLessThanOrEqual(40 + 5);
    expect(long).toMatch(/^[a-z0-9._-]+$/);
  });
});

describe("oneOffFromDirs", () => {
  it("maps dirs to resolved one-off entries", () => {
    const out = oneOffFromDirs([path.join(root, "app")]);
    expect(out).toEqual([{ name: "app", path: path.join(root, "app") }]);
    expect(existsSync(path.join(root, "app"))).toBe(false);
  });
});
