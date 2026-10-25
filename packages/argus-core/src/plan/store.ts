/**
 * Test plan file store.
 *
 * A plan is a Markdown file with YAML frontmatter carrying the *executable*
 * part (structured steps + metadata) and a human-readable narrative body.
 * This format is both machine-executable (the harness runs `steps`) and
 * human-reviewable (plans are git-versioned in the target repo, so plan
 * changes are reviewable commits — see docs/agent-architecture-and-configuration.md §4).
 *
 *   .argus/testplans/TP-001-login.md
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stringify, parse } from "yaml";
import { ConfigError } from "../errors.js";
import { TestPlanSchema, type TestPlan } from "../config/schema.js";

export interface PlanFile {
  /** Absolute path of the plan file. */
  path: string;
  plan: TestPlan;
  /** Everything after the frontmatter (human narrative). */
  body: string;
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

/** Serialize a plan to the frontmatter+body file format. */
export function serializePlan(plan: TestPlan, body = ""): string {
  const meta = {
    id: plan.id,
    title: plan.title,
    module: plan.module,
    priority: plan.priority,
    status: plan.status,
    ...(plan.spec_ref ? { spec_ref: plan.spec_ref } : {}),
    tags: plan.tags,
    ...(plan.created_at ? { created_at: plan.created_at } : {}),
    preconditions: plan.preconditions,
    ...(plan.narrative ? { narrative: plan.narrative } : {}),
    steps: plan.steps,
  };
  return `---\n${stringify(meta, { lineWidth: 0 }).trimEnd()}\n---\n\n${body.trimEnd()}\n`;
}

/** Parse and validate a plan file. Throws ConfigError on any violation. */
export function parsePlanFile(filePath: string): PlanFile {
  const raw = readFileSync(filePath, "utf8");
  const m = raw.match(FRONTMATTER_RE);
  if (!m) {
    throw new ConfigError(`${filePath}: missing YAML frontmatter (--- ... ---)`);
  }
  let meta: unknown;
  try {
    meta = parse(m[1] as string);
  } catch (e) {
    throw new ConfigError(`${filePath}: invalid frontmatter YAML: ${(e as Error).message}`);
  }
  const parsed = TestPlanSchema.safeParse(meta);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new ConfigError(`${filePath}: invalid plan — ${detail}`);
  }
  return { path: filePath, plan: parsed.data, body: (m[2] as string).trim() };
}

export class PlanStore {
  constructor(private dir: string) {
    mkdirSync(this.dir, { recursive: true });
  }

  /** All plans in the directory, sorted by id. */
  list(): PlanFile[] {
    if (!existsSync(this.dir)) return [];
    const files = readdirSync(this.dir)
      .filter((f) => f.endsWith(".md"))
      .sort();
    const out: PlanFile[] = [];
    for (const f of files) {
      try {
        out.push(parsePlanFile(path.join(this.dir, f)));
      } catch {
        // A malformed plan file is reported by `argus plan check`; listing
        // must not hard-fail on one bad file.
      }
    }
    return out;
  }

  get(id: string): PlanFile | undefined {
    const file = path.join(this.dir, `${id}.md`);
    if (!existsSync(file)) return undefined;
    return parsePlanFile(file);
  }

  /** Write a plan; the filename is always `<id>.md` for stable references. */
  write(plan: TestPlan, body = ""): string {
    const file = path.join(this.dir, `${plan.id}.md`);
    writeFileSync(file, serializePlan(plan, body), "utf8");
    return file;
  }

  remove(id: string): boolean {
    const file = path.join(this.dir, `${id}.md`);
    if (!existsSync(file)) return false;
    try {
      rmSync(file);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Allocate the next free plan id in the TP-NNN sequence.
 * (LLM-proposed ids are normalized to this sequence so references stay stable.)
 */
export function nextPlanId(existing: TestPlan[]): string {
  let max = 0;
  for (const p of existing) {
    const m = p.id.match(/^TP-(\d+)$/);
    if (m) max = Math.max(max, Number(m[1] as string));
  }
  return `TP-${String(max + 1).padStart(3, "0")}`;
}
