import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConfigError } from "../errors.js";
import { loadConfig } from "./loader.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "argus-cfg-"));
  mkdirSync(path.join(dir, ".argus"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.TEST_ARGUS_KEY;
  delete process.env.TEST_ARGUS_MISSING;
});

function writeConfig(yaml: string): void {
  writeFileSync(path.join(dir, ".argus", "config.yaml"), yaml, "utf8");
}

function config(llmBlock: string, extra = ""): string {
  return `version: 1\ntarget:\n  repo: /app\nllm:\n${llmBlock}\n${extra}`;
}

describe("loadConfig", () => {
  it("throws a ConfigError when config is missing", () => {
    expect(() => loadConfig(dir)).toThrowError(ConfigError);
  });

  it("parses a minimal config and applies defaults", () => {
    writeConfig(config("  provider: openai\n  model: gpt-4o"));
    const { config: cfg, configHash } = loadConfig(dir);
    expect(cfg.diff.base).toBe("origin/main");
    expect(cfg.target.env).toEqual({});
    expect(cfg.llm.model).toBe("gpt-4o");
    expect(cfg.pipeline.stages).toHaveLength(6);
    expect(configHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("resolves ${ENV} references at load time", () => {
    process.env.TEST_ARGUS_KEY = "sk-local-test-key";
    writeConfig(
      config(
        "  provider: vllm-local\n  base_url: http://localhost:8000/v1\n  model: qwen\n  api_key: ${TEST_ARGUS_KEY}",
      ),
    );
    const { config: cfg } = loadConfig(dir);
    expect(cfg.llm.api_key).toBe("sk-local-test-key");
  });

  it("fails loudly when a referenced env var is unset", () => {
    writeConfig(config("  provider: openai\n  model: m\n  api_key: ${TEST_ARGUS_MISSING}"));
    expect(() => loadConfig(dir)).toThrowError(/TEST_ARGUS_MISSING/);
  });

  it("rejects invalid schema values with field paths", () => {
    writeConfig(config("  provider: nope\n  model: m"));
    expect(() => loadConfig(dir)).toThrowError(/provider/);
  });

  it("rejects unknown provider enums for agent overrides", () => {
    writeConfig(
      config("  provider: openai\n  model: m", "agents:\n  fixer:\n    llm:\n      provider: no-such-provider\n      model: m\n"),
    );
    expect(() => loadConfig(dir)).toThrowError(ConfigError);
  });

  it("config hash is stable for identical configs and changes when content changes", () => {
    writeConfig(config("  provider: openai\n  model: gpt-4o"));
    const a = loadConfig(dir).configHash;
    const b = loadConfig(dir).configHash;
    expect(a).toBe(b);
    writeConfig(config("  provider: openai\n  model: gpt-4o-mini"));
    const c = loadConfig(dir).configHash;
    expect(c).not.toBe(a);
  });

  it("requires base_url for vllm-local providers", () => {
    writeConfig(config("  provider: vllm-local\n  model: qwen"));
    expect(() => loadConfig(dir)).toThrowError(/base_url/);
  });
});
