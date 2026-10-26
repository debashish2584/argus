/**
 * Custom hook protocol.
 *
 * A hook is any shell command. Argus writes a JSON context envelope to its
 * stdin; the hook writes ONE JSON document to stdout and exits 0. Anything
 * else is a HookError with stderr included.
 *
 * This is how users plug in non-git sources (Confluence, Notion, an internal
 * doc store, a private code search API) without changing Argus: a hook is
 * just another adapter implementing the same JSON contract as the built-ins.
 * See docs/agent-architecture-and-configuration.md §5.
 */
import { spawn } from "node:child_process";
import { HookError } from "./errors.js";

export interface HookContext {
  argus_version: string;
  run_id: string;
  agent?: string;
  target?: Record<string, unknown>;
}

export interface HookOptions {
  timeout_ms: number;
  cwd?: string;
}

export const ARGUS_VERSION = "0.1.0";

export async function runHook(
  command: string,
  input: HookContext,
  opts: HookOptions,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn("bash", ["-c", command], {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeout_ms);

    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new HookError(`hook spawn failed (${command}): ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new HookError(`hook timed out after ${opts.timeout_ms}ms: ${command}`));
        return;
      }
      if (code !== 0) {
        reject(
          new HookError(
            `hook exited ${code}: ${command} — ${stderr.trim().slice(0, 1000) || "(no stderr)"}`,
          ),
        );
        return;
      }
      resolve(stdout);
    });

    // A hook may exit before consuming stdin (e.g. it ignores the context
    // envelope) — the resulting EPIPE is expected, not an error. The
    // child's exit status is reported by the `close` handler above.
    child.stdin.on("error", () => {});
    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
  });
}

/** Parse hook stdout as JSON; invalid output is a HookError (with a preview). */
export function parseHookOutput<T>(stdout: string, command: string): T {
  try {
    return JSON.parse(stdout) as T;
  } catch (e) {
    throw new HookError(
      `hook produced invalid JSON (${command}): ${(e as Error).message}; output: ${stdout.slice(0, 300)}`,
    );
  }
}
