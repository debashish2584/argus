#!/usr/bin/env node
/**
 * Hermetic self-test of the dogfood harness itself (no build, no browser).
 *
 *  1. Consistency: every scripted triage report (P0–P2) has a matching fix,
 *     and vice versa — the 1:1 plan→bug→fix mapping the router relies on.
 *  2. Patches: each scripted fix is a byte-exact `git apply`-able unified
 *     diff against the seeded sample-app (checked on a scratch git copy,
 *     then applied, then the fixed content is asserted).
 *  3. Routing: the scripted LLM dispatches every agent's rendered-prompt
 *     shape to a canned response (synthetic prompts mirror the real
 *     templates' variable lines).
 *
 * Usage: node dogfood/selftest.mjs   (exit 0 = all good; CI-friendly)
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FIXES, PLANS, TRIAGE, route } from "./scripted-llm.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const failures = [];

function check(name, cond, detail = "") {
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures.push(name);
}

function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}:\n${r.stderr}`);
  return (r.stdout ?? "").trim();
}

/* ------------------------------------------------------------------ */
/* 1. triage ⇄ fix consistency                                          */
/* ------------------------------------------------------------------ */

check("triage reports: 5 seeded bugs", Object.keys(TRIAGE).length === 5);
check("scripted plans: 5 bug-mapped + 1 control", PLANS.plans.length === 6);

for (const [planTitle, report] of Object.entries(TRIAGE)) {
  check(
    `fix exists for '${report.title}'`,
    FIXES[report.title] !== undefined,
  );
  check(
    `severity P0–P2 so the fix loop engages: '${report.title}'`,
    ["P0-Blocker", "P1-High", "P2-Medium"].includes(report.severity),
    report.severity,
  );
  // The plan that produced this bug must reference the same surface.
  const plan = PLANS.plans.find((p) => p.title === planTitle);
  check(`plan exists for triage key '${planTitle}'`, plan !== undefined);
}
for (const title of Object.keys(FIXES)) {
  const hasTriage = Object.values(TRIAGE).some((r) => r.title === title);
  check(`triage exists for fix '${title}'`, hasTriage);
}

/* ------------------------------------------------------------------ */
/* 2. patches apply byte-exactly                                       */
/* ------------------------------------------------------------------ */

const tmp = mkdtempSync(path.join(os.tmpdir(), "argus-selftest-"));
try {
  cpSync(path.join(here, "sample-app"), tmp, { recursive: true });
  git(tmp, "init", "-b", "main");
  git(tmp, "config", "user.name", "Selftest");
  git(tmp, "config", "user.email", "selftest@argus.local");
  git(tmp, "add", "-A");
  git(tmp, "commit", "-m", "seeded base");

  const expectations = {
    "Landing hero copy does not match the spec": [
      "public/index.html",
      /Start free — no credit card/,
    ],
    "Features page is missing the free-trial call-to-action": [
      "public/features.html",
      /data-testid="free-trial-cta">Start free trial</,
    ],
    "Pricing page shows the wrong Pro plan price": [
      "public/pricing.html",
      /<tr><td>Pro<\/td><td>\$9\/mo<\/td><\/tr>/,
    ],
    "About navigation link is broken": [
      "public/js/nav.js",
      /{ label: "About", href: "\/about\.html" }/,
    ],
    "Checkout order button does not place the order": [
      "public/js/checkout.js",
      /getElementById\("place-order"\)/,
    ],
  };

  for (const [title, fix] of Object.entries(FIXES)) {
    check(
      `summary ≥10 chars: ${title.slice(0, 30)}…`,
      fix.summary.length >= 10,
    );
    check(
      `risk_notes ≥5 chars: ${title.slice(0, 30)}…`,
      fix.risk_notes.length >= 5,
    );
    // dry-run first (what the pipeline does via applyPatchCheck)
    const dry = spawnSync("git", ["apply", "--check", "-"], {
      cwd: tmp,
      encoding: "utf8",
      input: fix.patch,
    });
    check(
      `patch applies (git apply --check): ${title.slice(0, 40)}…`,
      dry.status === 0,
      dry.status === 0 ? "" : dry.stderr.trim(),
    );
    if (dry.status !== 0) continue;
    // then actually apply and verify the fixed content
    spawnSync("git", ["apply"], { cwd: tmp, encoding: "utf8", input: fix.patch });
    const [file, re] = expectations[title];
    const content = readFileSync(path.join(tmp, file), "utf8");
    check(`fixed content verified: ${file}`, re.test(content));
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ */
/* 3. routing                                                          */
/* ------------------------------------------------------------------ */

// Only the 5 seeded-bug plans are ever triaged/fixed; TP-006 is the passing
// control. Map plan title → its (bug-mapped) plan entry, skipping the control.
const buggy = PLANS.plans.filter((p) => TRIAGE[p.title]);
const control = PLANS.plans.find((p) => !TRIAGE[p.title]);
check("exactly one passing control plan", control !== undefined && buggy.length === 5,
  `control=${control?.id ?? "?"}`);

check("analyze routes", route("# Argus — ANALYZE agent (default prompt)").tag === "analyze");
check("testplan routes", route("# Argus — TEST PLAN agent (default prompt)").tag === "testplan");

for (const plan of buggy) {
  const system = `# Argus — TRIAGE agent (default prompt)\n- Plan: ${plan.id} — ${plan.title}\nRun ID: run-test`;
  const r = route(system);
  check(`triage routes ${plan.id}`, r.tag === `triage/${plan.id}` && r.out !== undefined, r.tag);
  if (r.out) check(`fix exists for triage '${plan.title}'`, FIXES[r.out.title] !== undefined);
}
check(
  `control ${control?.id} has no triage response (it passes)`,
  route(`# Argus — TRIAGE agent (default prompt)\n- Plan: ${control?.id} — ${control?.title}\nRun ID: run-test`).out === undefined,
);

for (const title of Object.keys(FIXES)) {
  const system = `# Argus — FIXER agent (default prompt)\n- Title: ${title}\nRun ID: run-test`;
  const r = route(system);
  check(`fixer routes '${title.slice(0, 40)}'…`, r.out !== undefined, r.tag);
}

for (let i = 0; i < buggy.length; i++) {
  const report = TRIAGE[buggy[i].title];
  const system =
    `# Argus — SUBMIT agent (default prompt)\n` +
    `- Bug: BUG-00${i + 1} — ${report.title} (${report.severity})\n` +
    `End with a footer line: \`Argus run run-20260101-000000 — generated fix, human review required.\``;
  const r = route(system);
  check(
    `submit routes BUG-00${i + 1}`,
    r.out?.commit_message !== undefined && r.out.title.length >= 8,
    r.tag,
  );
}

check("unrouted prompt → no response (hard error)", route("someone else").out === undefined);

/* ------------------------------------------------------------------ */

console.log(
  failures.length === 0
    ? "\nselftest: all checks passed"
    : `\nselftest: ${failures.length} check(s) failed: ${failures.join("; ")}`,
);
process.exit(failures.length === 0 ? 0 : 1);
