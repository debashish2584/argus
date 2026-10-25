import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initConfig, renderConfig } from "./init.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "argus-init-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("initConfig", () => {
  it("scaffolds .argus/config.yaml + testplans/", () => {
    const file = initConfig(dir, { repo: dir });
    expect(existsSync(file)).toBe(true);
    expect(existsSync(path.join(dir, ".argus/testplans"))).toBe(true);
    const content = readFileSync(file, "utf8");
    expect(content).toContain(`repo: ${dir}`);
    expect(content).toContain("provider: vllm-local");
    expect(content).toContain("${ARGUS_LLM_KEY}");
  });

  it("refuses to overwrite an existing config", () => {
    initConfig(dir, {});
    expect(() => initConfig(dir, {})).toThrowError(/already exists/);
  });

  it("emits env vars and matching health checks", () => {
    const out = renderConfig(
      { env: ["AUTH_URL=http://localhost:3000", "APP_URL=http://localhost:3008"] },
      "/x",
    );
    expect(out).toContain("AUTH_URL: http://localhost:3000");
    expect(out).toContain('url: "{{APP_URL}}/"');
  });

  it("rejects malformed env pairs", () => {
    expect(() => renderConfig({ env: ["JUST_A_NAME"] }, "/x")).toThrowError(
      /invalid env pair/,
    );
  });
});
