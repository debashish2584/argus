import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChatFn } from "../agent/runner.js";
import type { LlmResult } from "../llm/client.js";
import type { ImpactReport } from "./analyze.js";
import { testplanAgent } from "./testplan.js";
import { PlanStore } from "../plan/store.js";

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

const impact: ImpactReport = {
  summary: "auth change; login at risk",
  affected: [
    { module: "auth", files: ["src/auth/login.ts"], risk: "high", why: "token decode changed" },
  ],
  test_focus: ["valid login lands on /dashboard"],
};

const PROPOSED = JSON.stringify({
  plans: [
    {
      id: "TP-999", // normalized to TP-001 below
      title: "Login with valid credentials",
      module: "auth",
      priority: "P0",
      spec_ref: "docs/login.md",
      tags: ["auth"],
      preconditions: ["app reachable"],
      narrative: "Verifies the primary login flow.",
      steps: [
        { id: "open-login", action: "navigate", url: "{{APP_URL}}/login" },
        { id: "landed", action: "assert", kind: "url_contains", value: "/dashboard" },
      ],
    },
  ],
  notes: "covers the login focus",
});

describe("testplanAgent", () => {
  it("writes DRAFT plans with normalized ids; keeps {{VAR}} refs intact", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "argus-plans-"));
    try {
      const store = new PlanStore(dir);
      const res = await testplanAgent(
        fakeChat(PROPOSED),
        () => {},
        store,
        {
          impact,
          specs: [{ title: "Login", ref: "docs/login.md", content: "login behavior" }],
          existing: [],
          envVars: { APP_URL: "http://localhost:3008" },
        },
        { repoRoot: process.cwd(), plansDir: dir, runId: "run-x" },
      );

      expect(res.created).toHaveLength(1);
      expect(res.created[0]?.id).toBe("TP-001"); // normalized from TP-999

      const file = path.join(dir, "TP-001.md");
      const text = readFileSync(file, "utf8");
      expect(text).toContain('url: "{{APP_URL}}/login"'); // rendered at exec time, never baked
      expect(text).toContain("DRAFT");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips plans whose id collides with an existing plan", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "argus-plans-"));
    try {
      const store = new PlanStore(dir);
      const existing = {
        path: path.join(dir, "TP-001.md"),
        plan: {
          id: "TP-001",
          title: "Existing plan",
          module: "auth",
          priority: "P0" as const,
          status: "ACTIVE" as const,
          tags: [],
          preconditions: [],
          narrative: "",
          steps: [{ id: "s1", action: "navigate" as const, url: "http://x/" }],
        },
        body: "",
      };
      store.write(existing.plan);

      const proposed = JSON.parse(PROPOSED) as { plans: Array<Record<string, unknown>> };
      proposed.plans[0]!.id = "TP-001"; // collide

      const res = await testplanAgent(
        fakeChat(JSON.stringify(proposed)),
        () => {},
        store,
        {
          impact,
          specs: [],
          existing: [existing],
          envVars: {},
        },
        { repoRoot: process.cwd(), plansDir: dir },
      );
      expect(res.created).toHaveLength(0); // collision → skipped, never clobbered
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves {{VAR}} example syntax in the rendered prompt", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "argus-plans-"));
    const seen: string[] = [];
    try {
      const chat: ChatFn = async (messages, ctx) => {
        seen.push(messages.map((m) => m.content).join("\n"));
        const fn = fakeChat(JSON.stringify({ plans: [], notes: "none" }));
        return fn(messages, ctx);
      };
      await testplanAgent(
        chat,
        () => {},
        new PlanStore(dir),
        { impact, specs: [], existing: [], envVars: { APP_URL: "http://localhost:3008" } },
        { repoRoot: process.cwd(), plansDir: dir },
      );
      const prompt = seen[0] as string;
      expect(prompt).toContain('"url": "{{APP_URL}}/login"'); // example preserved
      expect(prompt).toContain("{{APP_URL}} = http://localhost:3008"); // service map
      // Only the deliberate pass-through examples may keep braces.
      const leftovers = prompt
        .replaceAll("{{APP_URL}}", "")
        .replaceAll("{{VAR}}", "")
        .match(/\{\{[A-Z_]+\}\}/g);
      expect(leftovers).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
