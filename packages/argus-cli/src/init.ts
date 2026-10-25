/**
 * `argus init` — scaffold a `.argus/config.yaml` in the target repository.
 *
 * Generates a complete, commented, working config. Every value the user is
 * likely to need is spelled out; secrets are `${ENV}` references only.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface InitOptions {
  /** Target source root (defaults to cwd). */
  repo?: string;
  /** Service URLs as VAR=URL pairs. */
  env?: string[];
  model?: string;
  baseUrl?: string;
  provider?: string;
}

export const CONFIG_TEMPLATE = `# Argus configuration — see docs/agent-architecture-and-configuration.md
# Secrets are always \${ENV_VAR} references, never literal values.
version: 1

target:
  repo: __REPO__
  env:
__ENV__
  health:
__HEALTH__

diff:
  base: origin/main

llm:
  provider: __PROVIDER__
  base_url: __BASE_URL__
  model: __MODEL__
  api_key: \${ARGUS_LLM_KEY}
  max_tokens: 8192

agents: {}
pipeline:
  stages: [analyze, testplan, execute, triage, fix, submit]
  gates:
    after_testplan: human
  on_failure: fail-fast

report: {}
redact:
  env_secrets: [ARGUS_LLM_KEY]
`;

export function renderConfig(opts: InitOptions, cwd: string): string {
  const repo = opts.repo ?? cwd;
  const envVars = opts.env ?? [];
  const envLines = envVars.length
    ? envVars
        .map((e) => {
          const [k, v] = e.split("=", 2);
          if (!k || !v) throw new Error(`invalid env pair: '${e}' (use VAR=URL)`);
          return `    ${k}: ${v}`;
        })
        .join("\n")
    : "    APP_URL: http://localhost:3000";
  const healthLines = envVars.length
    ? envVars
        .map((e) => {
          const k = e.split("=")[0];
          return `    - { url: "{{${k}}}/", expect: 200 }`;
        })
        .join("\n")
    : `    - { url: "{{APP_URL}}/", expect: 200 }`;

  let out = CONFIG_TEMPLATE;
  out = out.replace("__REPO__", repo);
  out = out.replace("__ENV__", envLines);
  out = out.replace("__HEALTH__", healthLines);
  out = out.replace("__PROVIDER__", opts.provider ?? "vllm-local");
  out = out.replace("__BASE_URL__", opts.baseUrl ?? "http://localhost:8000/v1");
  out = out.replace("__MODEL__", opts.model ?? "nvidia/Qwen3.8-27B-NVFP4");
  return out + "\n";
}

export function initConfig(dir: string, opts: InitOptions): string {
  const argusDir = path.join(dir, ".argus");
  const file = path.join(argusDir, "config.yaml");
  if (existsSync(file)) {
    throw new Error(`${file} already exists — edit it in place, or remove it`);
  }
  mkdirSync(argusDir, { recursive: true });
  mkdirSync(path.join(argusDir, "testplans"), { recursive: true });
  writeFileSync(file, renderConfig(opts, dir), "utf8");
  return file;
}
