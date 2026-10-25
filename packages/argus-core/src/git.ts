/**
 * Thin git wrapper. Argus shells out to `git` — no library dependency, and
 * users' git (credentials, hooks, permissions) is used as-is.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pExecFile = promisify(execFile);

export class Git {
  constructor(
    /** Repository root. */
    public readonly cwd: string,
  ) {}

  private async run(
    args: string[],
    opts: { maxBuffer?: number } = {},
  ): Promise<string> {
    try {
      const { stdout } = await pExecFile("git", args, {
        cwd: this.cwd,
        maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
      });
      return stdout;
    } catch (e) {
      const err = e as Error & { stderr?: string };
      const detail = (err.stderr ?? err.message).trim();
      throw new Error(`git ${args.slice(0, 3).join(" ")} failed: ${detail}`);
    }
  }

  head(): Promise<string> {
    return this.run(["rev-parse", "HEAD"]).then((s) => s.trim());
  }

  /** Resolves a ref (branch/tag/commit) to a commit sha; empty string if unresolvable. */
  async resolveRef(ref: string): Promise<string> {
    try {
      return (await this.run(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).trim();
    } catch {
      return "";
    }
  }

  async mergeBase(a: string, b: string): Promise<string | null> {
    try {
      return (await this.run(["merge-base", a, b])).trim();
    } catch {
      return null;
    }
  }

  diff(baseSha: string, headSha: string, paths: string[] = []): Promise<string> {
    return this.run(["diff", baseSha, headSha, "--", ...paths]);
  }

  changedFiles(baseSha: string, headSha: string): Promise<string[]> {
    return this.run(["diff", "--name-only", baseSha, headSha]).then((s) =>
      s.split("\n").map((l) => l.trim()).filter(Boolean),
    );
  }

  branchExists(name: string): Promise<boolean> {
    return this.run(["branch", "--list", name]).then((s) => s.trim().length > 0);
  }

  createBranch(name: string, from?: string): Promise<string> {
    return this.run(["branch", name, ...(from ? [from] : [])]);
  }

  checkout(name: string): Promise<string> {
    return this.run(["checkout", name]);
  }

  add(paths: string[] = ["."]): Promise<string> {
    return this.run(["add", "--", ...paths]);
  }

  commit(message: string): Promise<string> {
    return this.run(["commit", "-m", message]);
  }

  push(remote: string, branch: string): Promise<string> {
    return this.run(["push", "-u", remote, branch]);
  }

  remoteUrl(remote = "origin"): Promise<string> {
    return this.run(["remote", "get-url", remote]).then((s) => s.trim());
  }

  statusShort(): Promise<string> {
    return this.run(["status", "--short"]);
  }
}
