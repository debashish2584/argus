import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { LlmClient } from "./client.js";
import { LlmError } from "../errors.js";
import type { LlmBinding } from "../config/schema.js";

/**
 * Emulates an OpenAI-compatible /chat/completions endpoint with scripted
 * behavior, so the client is tested without a live model.
 */
let server: Server;
let url: string;
let behavior: (reqBody: Record<string, unknown>) => object;
const calls: Array<Record<string, unknown>> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let data = "";
    req.on("data", (d) => (data += d));
    req.on("end", () => {
      const body = JSON.parse(data);
      calls.push(body);
      const out = behavior(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
});

function binding(over: Partial<LlmBinding> = {}): LlmBinding {
  return {
    provider: "custom",
    base_url: url,
    model: "test-model",
    api_key: "k",
    temperature: 0.2,
    max_tokens: 100,
    timeout_ms: 5000,
    budget: {},
    ...over,
  };
}

function okResponse(body: Record<string, unknown>, content: string) {
  return {
    model: body.model,
    choices: [{ finish_reason: "stop", message: { content } }],
    usage: { prompt_tokens: 10, completion_tokens: 20 },
  };
}

describe("LlmClient", () => {
  it("returns content on a normal completion", async () => {
    behavior = (b) => okResponse(b, "hello");
    const client = new LlmClient(binding());
    const r = await client.chat([{ role: "user", content: "hi" }]);
    expect(r.content).toBe("hello");
    expect(r.usage.completion_tokens).toBe(20);
    expect(r.finish_reason).toBe("stop");
  });

  it("retries at 2x max_tokens when a reasoning model burns the budget", async () => {
    calls.length = 0;
    behavior = (b) =>
      b.max_tokens === 100 && b.model === "test-model"
        ? {
            choices: [
              {
                finish_reason: "length",
                message: { content: null, reasoning: "thinking..." },
              },
            ],
          }
        : okResponse(b, "finally");
    const client = new LlmClient(binding());
    const r = await client.chat([{ role: "user", content: "hi" }]);
    expect(r.content).toBe("finally");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.max_tokens).toBe(200);
  });

  it("throws a descriptive LlmError when content stays empty after retry", async () => {
    behavior = () => ({
      choices: [
        { finish_reason: "length", message: { content: null, reasoning: "..." } },
      ],
    });
    const client = new LlmClient(binding());
    await expect(
      client.chat([{ role: "user", content: "hi" }]),
    ).rejects.toThrowError(/empty completion/);
  });

  it("enforces the token budget across calls", async () => {
    behavior = (b) => okResponse(b, "ok");
    // 30 tokens per call; cap of 50 allows one, not two.
    const client = new LlmClient(binding({ budget: { max_tokens_total: 50 } }));
    await client.chat([{ role: "user", content: "a" }]); // 30 tokens
    await expect(
      client.chat([{ role: "user", content: "b" }]),
    ).rejects.toThrowError(LlmError);
  });

  it("emits an onCall entry per successful call", async () => {
    behavior = (b) => okResponse(b, "ok");
    const entries: unknown[] = [];
    const client = new LlmClient(binding(), {
      onCall: (e) => entries.push(e),
    });
    await client.chat([{ role: "user", content: "hi" }], {
      run_id: "r1",
      agent: "triage",
      purpose: "classify",
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      run_id: "r1",
      agent: "triage",
      purpose: "classify",
      ok: true,
    });
  });

  it("falls back to the secondary binding on primary failure", async () => {
    behavior = (b) =>
      b.model === "primary"
        ? { error: "boom" }
        : okResponse(b, "from-fallback");
    const client = new LlmClient(
      binding({
        model: "primary",
        fallback: binding({ model: "secondary" }),
      }),
    );
    const r = await client.chatWithFallback([{ role: "user", content: "hi" }]);
    expect(r.content).toBe("from-fallback");
    expect(r.via_fallback).toBe(true);
    expect(r.model).toBe("secondary");
  });

  it("rethrows the primary error when no fallback is configured", async () => {
    behavior = () => ({ error: "down" });
    const client = new LlmClient(binding());
    await expect(
      client.chatWithFallback([{ role: "user", content: "hi" }]),
    ).rejects.toThrowError();
  });
});
