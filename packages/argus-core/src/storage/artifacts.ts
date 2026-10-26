/**
 * Run artifact layout. Everything a run produces lives under
 * `.argus/runs/<run_id>/` so evidence is self-contained and shareable:
 *
 *   .argus/runs/<run_id>/
 *   ├── run.json                      # manifest (written at run start)
 *   ├── scenarios/
 *   │   └── TP-003/
 *   │       ├── result.json           # machine-readable outcome
 *   │       ├── video.webm
 *   │       ├── trace.zip
 *   │       ├── har.json
 *   │       ├── console.log
 *   │       └── failure.png
 *   └── bugs/
 *       └── BUG-001/
 *           ├── bug-report.md
 *           └── ...evidence...
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export function newRunId(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const d = now;
  return (
    `run-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

export interface RunManifest {
  run_id: string;
  started_at: string;
  argus_version: string;
  config_hash: string;
  target_repo: string;
  head: string;
  model?: string;
  notes?: string;
}

export class RunArtifacts {
  readonly dir: string;

  constructor(
    private root: string,
    public readonly runId: string,
    manifest: RunManifest,
  ) {
    this.dir = path.join(root, ".argus", "runs", runId);
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(
      path.join(this.dir, "run.json"),
      JSON.stringify(manifest, null, 2) + "\n",
      "utf8",
    );
  }

  /** Per-scenario (test plan) artifact directory. */
  scenarioDir(planId: string): string {
    const d = path.join(this.dir, "scenarios", planId);
    mkdirSync(d, { recursive: true });
    return d;
  }

  /** Per-bug artifact directory. */
  bugDir(bugId: string): string {
    const d = path.join(this.dir, "bugs", bugId);
    mkdirSync(d, { recursive: true });
    return d;
  }

  writeJson(dir: string, name: string, obj: unknown): string {
    const p = path.join(dir, name);
    writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
    return p;
  }

  writeText(dir: string, name: string, text: string): string {
    const p = path.join(dir, name);
    writeFileSync(p, text, "utf8");
    return p;
  }
}
