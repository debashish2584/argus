import { describe, expect, it } from "vitest";
import type { ChatFn } from "../agent/runner.js";
import type { ChatMessage, LlmCallContext, LlmResult } from "../llm/client.js";
import { ScopeViolation } from "../errors.js";
import type { BugReport } from "../config/schema.js";
import {
  assertPatchAllowed,
  fixerAgent,
  patchFiles,
} from "./fixer.js";

const GOOD_PATCH = `diff --git a/src/auth/login.ts b/src/auth/login.ts
--- a/src/auth/login.ts
+++ b/src/auth/login.ts
@@ -41,7 +41,7 @@ export function validateToken(token: string): boolean {
-  const raw = token.replace(/^v2:/, "");
+  const raw = token;
   const payload = JSON.parse(Buffer.from(raw, "base64").toString());
`;

function fakeChat(content: string): ChatFn {
  return async (
    _messages: ChatMessage[],
    _ctx: LlmCallContext,
  ): Promise<LlmResult> => ({
    content,
    model: "fake",
    provider: "fake",
    finish_reason: "stop",
    usage: { prompt_tokens: 1, completion_tokens: 1 },
    duration_ms: 1,
  });
}

function bug(): BugReport {
  return {
    bug_id: "BUG-001",
    plan_id: "TP-001",
    run_id: "run-test",
    title: "Login rejects valid credentials",
    severity: "P1-High",
    component: "src/auth/login.ts",
    description: "Step s3 failed: expected dashboard, got 500.",
    evidence: {
      console_errors: ["TypeError: validateToken"],
      network_failures: [],
      violated_contract: "TP-001 s3 asserts url_contains /dashboard",
    },
    proposed_fix: "check validateToken",
  };
}

describe("patchFiles", () => {
  it("extracts paths from diff --git headers", () => {
    expect(patchFiles(GOOD_PATCH)).toEqual(["src/auth/login.ts"]);
  });

  it("falls back to ---/+++ lines (a//b/ prefixes stripped)", () => {
    const patch = "--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n";
    expect(patchFiles(patch)).toEqual(["x.ts"]);
  });

  it("returns [] for an empty patch", () => {
    expect(patchFiles("")).toEqual([]);
  });
});

describe("assertPatchAllowed", () => {
  it("accepts a patch confined to source files", () => {
    expect(assertPatchAllowed(GOOD_PATCH)).toEqual(["src/auth/login.ts"]);
  });

  it("treats an empty patch as a decline (returns no files)", () => {
    expect(assertPatchAllowed("")).toEqual([]);
    expect(assertPatchAllowed("   \n")).toEqual([]);
  });

  it("rejects an unparseable non-empty patch", () => {
    expect(() => assertPatchAllowed("here is some prose")).toThrow(ScopeViolation);
    expect(() => assertPatchAllowed("here is some prose")).toThrow(/unparseable/);
  });

  it.each([
    ["test file", "src/foo.test.ts"],
    ["spec file", "src/foo.spec.ts"],
    ["__tests__ dir", "__tests__/foo.ts"],
    ["docs", "docs/agent-context.md"],
    ["specs", "specs/api.md"],
    ["argus config", ".argus/config.yaml"],
    ["package.json", "package.json"],
    ["package-lock.json", "package-lock.json"],
    ["vite config", "vite.config.ts"],
  ])("rejects %s (%s)", (_label, file) => {
    const patch = `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-x\n+y\n`;
    expect(() => assertPatchAllowed(patch)).toThrow(ScopeViolation);
    expect(() => assertPatchAllowed(patch)).toThrow(/protected by rule/);
  });
});

describe("fixerAgent", () => {
  it("renders the bug into the prompt and parses the proposal", async () => {
    const seen: string[] = [];
    const chat: ChatFn = async (messages, ctx) => {
      seen.push(messages.map((m) => m.content).join("\n"));
      const fn = fakeChat(
        JSON.stringify({
          summary: "stop stripping the v2 prefix",
          patch: GOOD_PATCH,
          files: ["src/auth/login.ts"],
          risk_notes: "does not cover token rotation",
        }),
      );
      return fn(messages, ctx);
    };

    const res = await fixerAgent(
      chat,
      () => {},
      {
        bug: bug(),
        standards: { path: "docs/agent-context.md", content: "use small diffs" },
        contextFiles: [{ path: "src/auth/login.ts", content: "..." }],
        failingSteps: ['{"id":"s3","action":"assert"}'],
      },
      { repoRoot: process.cwd() },
    );

    expect(res.files).toEqual(["src/auth/login.ts"]);
    const prompt = seen[0] as string;
    expect(prompt).toContain("Login rejects valid credentials");
    expect(prompt).toContain("use small diffs"); // standards doc ingested
    expect(prompt).not.toMatch(/\{\{[A-Z_]+\}\}/); // fully rendered
  });

  it("hard-fails on schema-violating output (never coerces)", async () => {
    await expect(
      fixerAgent(
        fakeChat('{"summary":"x","patch":"","risk_notes":""}'),
        () => {},
        { bug: bug(), standards: null, contextFiles: [], failingSteps: [] },
        { repoRoot: process.cwd() },
      ),
    ).rejects.toThrow(/fixer output/);
  });

  it("accepts an honest decline (empty patch, empty files)", async () => {
    const res = await fixerAgent(
      fakeChat(
        JSON.stringify({
          summary: "cannot fix safely; needs API change",
          patch: "",
          files: [],
          risk_notes: "root cause is in the auth API contract",
        }),
      ),
      () => {},
      { bug: bug(), standards: null, contextFiles: [], failingSteps: [] },
      { repoRoot: process.cwd() },
    );
    expect(res.patch).toBe("");
    expect(res.files).toEqual([]);
  });
});
