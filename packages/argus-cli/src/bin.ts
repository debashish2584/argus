#!/usr/bin/env node
/**
 * The `argus` command.
 *
 *   argus init     scaffold .argus/config.yaml in a target repository
 *   argus doctor   verify the local environment (node, git, LLM endpoint)
 *   argus version  print version
 *
 * Closed loop (each is a slice of the six-stage pipeline; see
 * src/pipeline.ts for the mapping):
 *   argus plan     analyze + testplan — draft test plans from the diff
 *   argus run      execute + triage   — run plans, report failures as bugs
 *   argus heal     all six stages     — full loop: detect → fix → verify → PR
 *   argus triage   ad-hoc re-triage of an existing run's failures
 *   argus report   re-send the email report for an existing run
 *   argus inspect  print run/bug/scenario state
 *
 * PRs are opened only when ARGUS_GITHUB_TOKEN is set; otherwise fixes land on
 * local `argus/BUG-NNN` branches with a staged (pending-local) PR record.
 */
import { Command } from "commander";
import { existsSync } from "node:fs";
import path from "node:path";
import { PROVIDER_PRESETS, loadConfig, type AgentId } from "@argus/core";
import { initConfig } from "./init.js";
import {
  executePipeline,
  collectTriageTargets,
  triageTargets,
  resendReport,
  inspect,
  allStages,
} from "./pipeline.js";

const VERSION = "0.1.0";

const program = new Command();
program.name("argus").description("Argus — autonomous self-healing quality engineering").version(VERSION);

program
  .command("init")
  .description("scaffold .argus/config.yaml in the target repository")
  .option("--repo <dir>", "target source root (default: current directory)")
  .option("--env <VAR=URL...>", "service URLs, repeatable", (v, prev: string[]) => [...(prev ?? []), v], [] as string[])
  .option("--model <model>", "LLM model id")
  .option("--base-url <url>", "OpenAI-compatible endpoint")
  .option("--provider <provider>", "provider preset")
  .action(async (opts: { repo?: string; env: string[]; model?: string; baseUrl?: string; provider?: string }) => {
    const dir = path.resolve(opts.repo ?? process.cwd());
    try {
      const file = initConfig(dir, {
        repo: opts.repo ? path.resolve(opts.repo) : dir,
        env: opts.env,
        model: opts.model,
        baseUrl: opts.baseUrl,
        provider: opts.provider,
      });
      console.log(`wrote ${file}`);
      console.log("next:  argus doctor   # verify environment");
    } catch (e) {
      console.error(`error: ${(e as Error).message}`);
      process.exitCode = 1;
    }
  });

program
  .command("doctor")
  .description("verify the local environment Argus needs")
  .option("--repo <dir>", "target directory (default: cwd)")
  .action(async (opts: { repo?: string }) => {
    const dir = path.resolve(opts.repo ?? process.cwd());
    let ok = true;
    const check = (name: string, pass: boolean, detail: string) => {
      console.log(`${pass ? "  ✓" : "  ✗"} ${name}: ${detail}`);
      if (!pass) ok = false;
    };

    const nodeMajor = Number(process.versions.node.split(".")[0]);
    check("node", nodeMajor >= 20, `v${process.versions.node} (need ≥20)`);

    const git = await run("git --version");
    check("git", git.status === 0, git.status === 0 ? git.stdout.trim() : "not found");

    const cfgFile = path.join(dir, ".argus", "config.yaml");
    check("config", existsSync(cfgFile), existsSync(cfgFile) ? cfgFile : `${cfgFile} missing — run: argus init`);

    if (existsSync(cfgFile)) {
      let baseUrl = "";
      try {
        const { config, configHash } = loadConfig(dir);
        check("config", true, `valid (hash ${configHash})`);
        const b = config.llm;
        baseUrl = b.base_url ?? PROVIDER_PRESETS[b.provider] ?? "";
        const probe = await probeEndpoint(baseUrl, b.api_key);
        check(
          "llm",
          probe.ok,
          probe.ok
            ? `${b.provider}/${b.model} reachable`
            : `${baseUrl || b.provider} unreachable (${probe.detail})`,
        );
      } catch (e) {
        check("config", false, (e as Error).message);
      }
    }
    process.exitCode = ok ? 0 : 1;
  });

program.command("version").description("print version").action(() => {
  console.log(VERSION);
});

/** Common options for the pipeline commands (run/heal). */
function pipelineOptions(cmd: Command): Command {
  return cmd
    .option("--repo <dir>", "target directory containing .argus/ (default: cwd)")
    .option("-y, --yes", "bypass human gates (CI)")
    .option("--headful", "run the browser headed (dogfooding on a screen)")
    .option("--no-video", "skip video capture")
    .option("--no-trace", "skip trace capture")
    .option("--no-har", "skip HAR capture");
}

/** Shared action: run a stage slice, map errors → exit 1. */
function pipelineAction(stages: AgentId[]) {
  return async (opts: {
    repo?: string;
    yes?: boolean;
    headful?: boolean;
    video?: boolean;
    trace?: boolean;
    har?: boolean;
    plan?: string[];
  }) => {
    try {
      await executePipeline({
        repo: path.resolve(opts.repo ?? process.cwd()),
        stages,
        yes: opts.yes,
        headful: opts.headful,
        noVideo: opts.video === false,
        noTrace: opts.trace === false,
        noHar: opts.har === false,
        plans: opts.plan,
      });
    } catch (e) {
      console.error(`error: ${(e as Error).message}`);
      process.exitCode = 1;
    }
  };
}

program
  .command("plan")
  .description("analyze the diff and draft test plans (stages: analyze, testplan)")
  .option("--repo <dir>", "target directory containing .argus/ (default: cwd)")
  .option("-y, --yes", "bypass the testplan gate")
  .action(async (opts: { repo?: string; yes?: boolean }) => {
    try {
      await executePipeline({
        repo: path.resolve(opts.repo ?? process.cwd()),
        stages: ["analyze", "testplan"],
        yes: opts.yes,
      });
    } catch (e) {
      console.error(`error: ${(e as Error).message}`);
      process.exitCode = 1;
    }
  });

pipelineOptions(
  program
    .command("run")
    .description("run test plans and triage failures (stages: execute, triage)"),
)
  .option(
    "--plan <id>",
    "only run this plan id (repeatable); ignores plan status",
    (v, prev: string[]) => [...(prev ?? []), v],
    [] as string[],
  )
  .action(pipelineAction(["execute", "triage"]));

pipelineOptions(
  program
    .command("heal")
    .description("full closed loop: analyze → plan → execute → triage → fix → submit"),
)
  .option(
    "--plan <id>",
    "restrict execution to this plan id (repeatable)",
    (v, prev: string[]) => [...(prev ?? []), v],
    [] as string[],
  )
  .action(pipelineAction(allStages()));

program
  .command("triage")
  .description("ad-hoc re-triage of an existing run's failures (no state changes)")
  .option("--repo <dir>", "target directory containing .argus/ (default: cwd)")
  .option("--run <runId>", "run to re-triage (default: latest)")
  .option("--prompt <path>", "override the triage prompt file")
  .action(async (opts: { repo?: string; run?: string; prompt?: string }) => {
    try {
      const root = path.resolve(opts.repo ?? process.cwd());
      const targets = collectTriageTargets(root, opts.run);
      if (targets.length === 0) {
        console.log("no failed scenarios to triage in that run");
        return;
      }
      console.log(`triaging ${targets.length} failed scenario(s)…`);
      await triageTargets(root, targets, opts.prompt);
    } catch (e) {
      console.error(`error: ${(e as Error).message}`);
      process.exitCode = 1;
    }
  });

program
  .command("report")
  .description("re-send the email report for an existing run")
  .option("--repo <dir>", "target directory containing .argus/ (default: cwd)")
  .option("--run <runId>", "run to report (default: latest)")
  .action(async (opts: { repo?: string; run?: string }) => {
    try {
      const root = path.resolve(opts.repo ?? process.cwd());
      const res = await resendReport(root, opts.run);
      console.log(`${res.sent ? "sent" : "not sent"}: ${res.detail}`);
      if (!res.sent) process.exitCode = 1;
    } catch (e) {
      console.error(`error: ${(e as Error).message}`);
      process.exitCode = 1;
    }
  });

program
  .command("inspect")
  .description("print run/bug/scenario state")
  .option("--repo <dir>", "target directory containing .argus/ (default: cwd)")
  .option("--run <runId>", "limit to one run")
  .action((opts: { repo?: string; run?: string }) => {
    try {
      const root = path.resolve(opts.repo ?? process.cwd());
      const { runs, bugs, scenarios } = inspect(root, opts.run);
      console.log(`runs (${runs.length}):`);
      for (const r of runs) {
        console.log(
          `  ${r.run_id}  ${r.status.padEnd(10)}  ${r.started_at}  head=${r.head.slice(0, 12)}  [${r.stages.join("→")}]`,
        );
      }
      console.log(`\nbugs (${bugs.length}):`);
      for (const b of bugs) {
        console.log(`  ${b.bug_id} [${b.severity}] ${b.status.padEnd(10)} ${b.title}`);
      }
      console.log(`\nscenarios (${scenarios.length}):`);
      for (const s of scenarios) {
        console.log(
          `  ${s.run_id}  ${s.plan_id}  ${s.status.padEnd(5)}  ${s.duration_ms}ms${s.error ? `  — ${s.error.slice(0, 100)}` : ""}`,
        );
      }
    } catch (e) {
      console.error(`error: ${(e as Error).message}`);
      process.exitCode = 1;
    }
  });

async function probeEndpoint(
  baseUrl: string,
  key?: string,
): Promise<{ ok: boolean; detail: string }> {
  if (!baseUrl) return { ok: false, detail: "no base_url" };
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
      headers: key ? { authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    return { ok: true, detail: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}

async function run(cmd: string): Promise<{ status: number; stdout: string }> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  try {
    const { stdout } = await promisify(execFile)("bash", ["-c", cmd]);
    return { status: 0, stdout };
  } catch (e) {
    return { status: 1, stdout: (e as Error).message };
  }
}

program.parseAsync().catch((e: Error) => {
  console.error(e.message);
  process.exitCode = 1;
});
