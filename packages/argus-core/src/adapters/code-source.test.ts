import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ConfigError } from "../errors.js";
import { Git } from "../git.js";
import { gitCodeSource } from "./code-source.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "argus-git-"));
  const run = (cmd: string) =>
    execFileSync("bash", ["-c", cmd], { cwd: dir, stdio: "pipe" });
  run(`git init -q -b main && git config user.email t@t.t && git config user.name t`);
  writeFileSync(path.join(dir, "app.ts"), "export const x = 1;\n");
  writeFileSync(path.join(dir, "README.md"), "# App\n");
  run("git add -A && git commit -qm base");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("gitCodeSource", () => {
  it("produces base→head diff and file list (feature branch vs main)", async () => {
    execFileSync("git", ["checkout", "-qb", "feature"], { cwd: dir });
    writeFileSync(path.join(dir, "app.ts"), "export const x = 2;\n");
    writeFileSync(path.join(dir, "new.ts"), "export const y = 1;\n");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-qm", "change"], { cwd: dir });

    const res = await gitCodeSource(new Git(dir), "main");
    expect(res.base).toMatch(/^[0-9a-f]{40}$/);
    expect(res.head).toMatch(/^[0-9a-f]{40}$/);
    expect(res.files.sort()).toEqual(["app.ts", "new.ts"]);
    expect(res.diff).toContain("-export const x = 1;");
    expect(res.diff).toContain("+export const x = 2;");
  });

  it("discovers the standards doc (agent-context.md)", async () => {
    execFileSync("git", ["checkout", "-qb", "feature"], { cwd: dir });
    mkdirSync(path.join(dir, "docs"));
    writeFileSync(path.join(dir, "docs/agent-context.md"), "# Standards\nbe nice\n");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-qm", "docs"], { cwd: dir });

    const res = await gitCodeSource(new Git(dir), "main");
    expect(res.standards_doc?.path).toBe("docs/agent-context.md");
    expect(res.standards_doc?.content).toContain("# Standards");
  });

  it("returns empty diff when the branch has no changes vs base", async () => {
    execFileSync("git", ["checkout", "-qb", "feature"], { cwd: dir });
    const res = await gitCodeSource(new Git(dir), "main");
    expect(res.files).toEqual([]);
    expect(res.diff).toBe("");
  });

  it("throws a ConfigError when the base ref does not resolve", async () => {
    await expect(gitCodeSource(new Git(dir), "no-such-branch")).rejects.toThrowError(
      ConfigError,
    );
  });
});

describe("Git", () => {
  it("resolves refs and detects branch existence", async () => {
    const g = new Git(dir);
    expect(await g.resolveRef("main")).toMatch(/^[0-9a-f]{40}$/);
    expect(await g.resolveRef("v9")).toBe("");
    expect(await g.branchExists("main")).toBe(true);
    expect(await g.branchExists("nope")).toBe(false);
  });

  it("creates branches and reads the remote URL", async () => {
    const g = new Git(dir);
    await g.createBranch("fix/argus-001");
    expect(await g.branchExists("fix/argus-001")).toBe(true);
    // no remote configured → throws, which the caller treats as "no remote"
    await expect(g.remoteUrl("origin")).rejects.toThrow();
  });
});
