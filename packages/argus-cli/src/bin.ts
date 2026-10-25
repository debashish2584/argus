#!/usr/bin/env node
/**
 * The `argus` command.
 *
 * MVP commands:
 *   argus init     scaffold .argus/config.yaml in a target repository
 *   argus doctor   verify the local environment (node, git, LLM endpoint)
 *   argus version  print version
 *
 * The full closed-loop commands (plan/run/triage/heal/report) arrive with the
 * pipeline runner — see packages/argus-core/src/pipeline/.
 */
import { Command } from "commander";
import { existsSync } from "node:fs";
import path from "node:path";
import { PROVIDER_PRESETS, loadConfig } from "@argus/core";
import { initConfig } from "./init.js";

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
