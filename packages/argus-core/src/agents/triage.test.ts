import { describe, expect, it } from "vitest";
import type { ChatFn } from "../agent/runner.js";
import type { ChatMessage, LlmCallContext, LlmResult } from "../llm/client.js";
import type { TestPlan } from "../config/schema.js";
import type { ScenarioResult } from "../execute/types.js";
import { triageAgent } from "./triage.js";

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

function plan(): TestPlan {
  return {
    id: "TP-001",
    title: "Login with valid credentials",
    module: "auth",
    priority: "P0",
    status: "ACTIVE",
    tags: [],
    preconditions: [],
    narrative: "Valid login lands on /dashboard.",
    steps: [
      { id: "open-login", action: "navigate", url: "{{APP_URL}}/login" },
      { id: "landed", action: "assert", kind: "url_contains", value: "/dashboard" },
    ],
  };
}

function scenario(): ScenarioResult {
  return {
    plan_id: "TP-001",
    status: "fail",
    failed_step_id: "landed",
    error: "expected url to contain /dashboard, got /login",
    steps: [
      { step_id: "open-login", action: "navigate", status: "pass", duration_ms: 10 },
      {
        step_id: "landed",
        action: "assert",
        status: "fail",
        error: "expected url to contain /dashboard, got /login",
        duration_ms: 2,
      },
    ],
    console_errors: ["TypeError: validateToken"],
    network_failures: ["POST /api/auth → 500"],
    duration_ms: 12,
    started_at: "2026-10-26T00:00:00Z",
    artifacts: {},
  };
}

describe("triageAgent", () => {
  it("renders the failure evidence and parses the report", async () => {
    const seen: string[] = [];
    const chat: ChatFn = async (messages, ctx) => {
      seen.push(messages.map((m) => m.content).join("\n"));
      const fn = fakeChat(
        JSON.stringify({
          title: "Valid login fails to land on dashboard",
          severity: "P1-High",
          component: "src/auth/login.ts",
          description: "assert step failed; console shows validateToken TypeError.",
          violated_contract:
            "TP-001 step 'landed' asserts url_contains /dashboard after login.",
          proposed_fix: "inspect validateToken",
        }),
      );
      return fn(messages, ctx);
    };

    const res = await triageAgent(
      chat,
      () => {},
      { scenario: scenario(), plan: plan(), changedFiles: ["src/auth/login.ts"] },
      { repoRoot: process.cwd() },
    );

    expect(res.severity).toBe("P1-High");
    expect(res.component).toBe("src/auth/login.ts");
    const prompt = seen[0] as string;
    expect(prompt).toContain("TP-001");
    expect(prompt).toContain("TypeError: validateToken");
    expect(prompt).toContain("POST /api/auth → 500");
    expect(prompt).toContain("src/auth/login.ts"); // changed files grounded
    // Only the plan steps' service-map refs ({{APP_URL}}) may keep braces —
    // they are rendered at execution time, not at triage time.
    const leftovers = prompt.replaceAll("{{APP_URL}}", "").match(/\{\{[A-Z_]+\}\}/g);
    expect(leftovers).toBeNull();
  });

  it("hard-fails on a report missing required fields", async () => {
    await expect(
      triageAgent(
        fakeChat(JSON.stringify({ title: "x", severity: "P0-Blocker" })),
        () => {},
        { scenario: scenario(), plan: plan(), changedFiles: [] },
        { repoRoot: process.cwd() },
      ),
    ).rejects.toThrow(/triage output/);
  });
});
