import { describe, expect, it } from "vitest";
import type { ChatFn } from "../agent/runner.js";
import type { LlmResult } from "../llm/client.js";
import type { BugReport } from "../config/schema.js";
import { submitAgent } from "./submit.js";

function fakeChat(content: string): ChatFn {
  return async (): Promise<LlmResult> => ({
    content,
    model: "fake",
    provider: "fake",
    finish_reason: "stop",
    usage: { prompt_tokens: 5, completion_tokens: 5 },
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
    description: "500 on /api/auth during login.",
    evidence: {
      console_errors: ["TypeError: validateToken"],
      network_failures: [],
      violated_contract: "TP-001 landed asserts url_contains /dashboard",
    },
  };
}

describe("submitAgent", () => {
  it("renders before/after logs and parses the PR draft", async () => {
    const seen: string[] = [];
    const chat: ChatFn = async (messages, ctx) => {
      seen.push(messages.map((m) => m.content).join("\n"));
      const fn = fakeChat(
        JSON.stringify({
          commit_message: "fix(auth): keep v2 prefix before decode [BUG-001]",
          title: "fix(auth): keep v2 prefix before decode [BUG-001]",
          body: "## Summary\nlogin broke.\n## Verification\nTP-001 passes.",
        }),
      );
      return fn(messages, ctx);
    };

    const res = await submitAgent(
      chat,
      () => {},
      {
        bug: bug(),
        changedFiles: ["src/auth/login.ts"],
        fixSummary: "stop stripping the v2 prefix",
        riskNotes: "does not cover token rotation",
        beforeLog: "✗ landed — expected /dashboard, got /login",
        afterLog: "✓ landed — url contains /dashboard",
        evidencePaths: ["scenarios/TP-001/video.webm"],
      },
      { repoRoot: process.cwd(), runId: "run-test" },
    );

    expect(res.title).toContain("BUG-001");
    const prompt = seen[0] as string;
    expect(prompt).toContain("✗ landed"); // before log present
    expect(prompt).toContain("✓ landed"); // after log present
    expect(prompt).toContain("scenarios/TP-001/video.webm");
    expect(prompt).toContain("run-test");
    expect(prompt).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it("rejects a body under the minimum length", async () => {
    await expect(
      submitAgent(
        fakeChat(
          JSON.stringify({
            commit_message: "fix(auth): something [BUG-001]",
            title: "fix(auth): something [BUG-001]",
            body: "too short",
          }),
        ),
        () => {},
        {
          bug: bug(),
          changedFiles: [],
          fixSummary: "x",
          riskNotes: "y",
          beforeLog: "a",
          afterLog: "b",
          evidencePaths: [],
        },
        { repoRoot: process.cwd() },
      ),
    ).rejects.toThrow(/submit output/);
  });
});
