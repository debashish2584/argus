import { describe, expect, it } from "vitest";
import type { ChatFn } from "../agent/runner.js";
import type { LlmResult } from "../llm/client.js";
import type { CodeSourceResult } from "../adapters/code-source.js";
import type { SpecDoc } from "../adapters/spec-source.js";
import { analyzeAgent } from "./analyze.js";

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

const diff: CodeSourceResult = {
  base: "abc123",
  head: "def456",
  diff: "diff --git a/src/auth/login.ts b/src/auth/login.ts\n",
  files: ["src/auth/login.ts"],
  standards_doc: { path: "docs/agent-context.md", content: "standards" },
};

const specs: SpecDoc[] = [
  { id: "spec-1", title: "Login", ref: "docs/login.md", content: "login behavior" },
];

describe("analyzeAgent", () => {
  it("renders diff + specs + existing plans and parses the impact report", async () => {
    const seen: string[] = [];
    const chat: ChatFn = async (messages, ctx) => {
      seen.push(messages.map((m) => m.content).join("\n"));
      const fn = fakeChat(
        JSON.stringify({
          summary: "Auth token handling changed; login path at risk.",
          affected: [
            {
              module: "auth",
              files: ["src/auth/login.ts"],
              risk: "high",
              why: "token decode changed",
            },
          ],
          test_focus: ["valid login lands on /dashboard"],
        }),
      );
      return fn(messages, ctx);
    };

    const res = await analyzeAgent(
      chat,
      () => {},
      { diff, specs, existingPlans: [] },
      { repoRoot: process.cwd(), runId: "run-x" },
    );

    expect(res.test_focus).toHaveLength(1);
    const prompt = seen[0] as string;
    expect(prompt).toContain("src/auth/login.ts");
    expect(prompt).toContain("login behavior");
    expect(prompt).toContain("run-x");
    expect(prompt).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it("hard-fails when test_focus is empty (schema requires ≥1)", async () => {
    await expect(
      analyzeAgent(
        fakeChat(
          JSON.stringify({
            summary: "no risk found",
            affected: [],
            test_focus: [],
          }),
        ),
        () => {},
        { diff, specs, existingPlans: [] },
        { repoRoot: process.cwd() },
      ),
    ).rejects.toThrow(/analyze output/);
  });
});
