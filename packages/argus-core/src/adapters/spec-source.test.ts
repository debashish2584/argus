import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { HookError } from "../errors.js";
import { loadSpecs, matchGlob, type SpecDoc } from "./spec-source.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "argus-spec-"));
  mkdirSync(path.join(dir, "docs/architecture"), { recursive: true });
  writeFileSync(path.join(dir, "docs/overview.md"), "# Overview\nhello\n");
  writeFileSync(path.join(dir, "docs/architecture/a.md"), "# Arch A\nx\n");
  writeFileSync(path.join(dir, "docs/architecture/b.md"), "# Arch B\ny\n");
  writeFileSync(path.join(dir, "notes.txt"), "not a spec");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const ctx = { argus_version: "0.1.0", run_id: "run-test" };

describe("matchGlob", () => {
  it("matches recursive ** patterns", () => {
    const m = matchGlob(dir, "docs/**/*.md");
    expect(m.sort()).toEqual([
      path.join(dir, "docs/architecture/a.md"),
      path.join(dir, "docs/architecture/b.md"),
      path.join(dir, "docs/overview.md"),
    ]);
  });

  it("ignores hidden directories", () => {
    mkdirSync(path.join(dir, "docs/.hidden"));
    writeFileSync(path.join(dir, "docs/.hidden/x.md"), "# H\n");
    const m = matchGlob(dir, "docs/**/*.md");
    expect(m.some((p) => p.includes(".hidden"))).toBe(false);
  });
});

describe("loadSpecs (git-md)", () => {
  it("loads markdown specs with title extraction", async () => {
    const specs = await loadSpecs(
      dir,
      { type: "git-md", paths: ["docs/**/*.md"] },
      ctx,
    );
    expect(specs).toHaveLength(3);
    const a = specs.find((s) => s.ref.endsWith("a.md")) as SpecDoc;
    expect(a.title).toBe("Arch A");
    expect(a.content).toContain("x");
  });

  it("falls back to the path when no title line exists", async () => {
    writeFileSync(path.join(dir, "docs/notitle.md"), "just body\n");
    const specs = await loadSpecs(
      dir,
      { type: "git-md", paths: ["docs/*.md"] },
      ctx,
    );
    expect(specs.find((s) => s.id === "docs/notitle.md")?.title).toBe(
      "docs/notitle.md",
    );
  });
});

describe("loadSpecs (hook)", () => {
  it("validates hook output against the spec schema", async () => {
    const cmd = `echo '{"specs":[{"id":"ext","title":"External","ref":"ext://1","content":"c"}]}'`;
    const specs = await loadSpecs(dir, { type: "hook", command: cmd, timeout_ms: 10_000 }, ctx);
    expect(specs).toHaveLength(1);
    expect(specs[0]!.id).toBe("ext");
  });

  it("rejects invalid JSON from the hook", async () => {
    const cmd = "echo 'not-json'";
    await expect(
      loadSpecs(dir, { type: "hook", command: cmd, timeout_ms: 10_000 }, ctx),
    ).rejects.toThrowError(HookError);
  });

  it("rejects schema-violating hook output", async () => {
    const cmd = "echo '{\"specs\":[{\"id\":\"x\"}]}'";
    await expect(
      loadSpecs(dir, { type: "hook", command: cmd, timeout_ms: 10_000 }, ctx),
    ).rejects.toThrowError(/validation/);
  });

  it("fails when the hook exits non-zero (stderr captured)", async () => {
    const cmd = "echo 'oops' >&2; exit 3";
    await expect(
      loadSpecs(dir, { type: "hook", command: cmd, timeout_ms: 10_000 }, ctx),
    ).rejects.toThrowError(/exited 3.*oops/s);
  });

  it("fails on timeout", async () => {
    const cmd = "sleep 2";
    await expect(
      loadSpecs(dir, { type: "hook", command: cmd, timeout_ms: 200 }, ctx),
    ).rejects.toThrowError(/timed out/);
  });
});
