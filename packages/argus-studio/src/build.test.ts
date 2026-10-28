import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildId, packageRoot } from "./build.js";

describe("buildId", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "argus-studio-build-"));
    mkdirSync(path.join(dir, "dist"), { recursive: true });
    mkdirSync(path.join(dir, "web"), { recursive: true });
    writeFileSync(path.join(dir, "dist", "a.js"), "console.log(1);\n");
    writeFileSync(path.join(dir, "web", "app.js"), "let x = 1;\n");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("is stable across repeated calls", () => {
    expect(buildId(dir)).toBe(buildId(dir));
  });

  it("changes when a runtime file changes", () => {
    const before = buildId(dir);
    writeFileSync(path.join(dir, "dist", "a.js"), "console.log(2);\n");
    expect(buildId(dir)).not.toBe(before);
  });

  it("changes when a served SPA asset changes", () => {
    const before = buildId(dir);
    writeFileSync(path.join(dir, "web", "app.js"), "let x = 2;\n");
    expect(buildId(dir)).not.toBe(before);
  });

  it("ignores compiled test output (dist/*.test.js)", () => {
    const before = buildId(dir);
    writeFileSync(path.join(dir, "dist", "a.test.js"), "whatever;\n");
    expect(buildId(dir)).toBe(before);
  });

  it("tolerates missing files (hashes only what exists)", () => {
    const without = buildId(dir);
    writeFileSync(path.join(dir, "web", "index.html"), "<html></html>\n");
    expect(buildId(dir)).not.toBe(without);
  });

  it("defaults to the studio package root and returns a 12-char hex id", () => {
    const id = buildId();
    expect(id).toMatch(/^[0-9a-f]{12}$/);
    expect(packageRoot().endsWith("argus-studio")).toBe(true);
  });
});
