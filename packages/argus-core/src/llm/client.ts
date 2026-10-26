/**
 * LLM client for OpenAI-compatible chat endpoints.
 *
 * Design notes (see docs/agent-architecture-and-configuration.md §6):
 *  - Presets: openai, openrouter, gemini (its OpenAI-compat endpoint),
 *    vllm-local, custom. Native-Anthropic is post-MVP.
 *  - Reasoning models (e.g. local Qwen3.x) may consume the token budget on
 *    hidden "reasoning" tokens and return null content with finish_reason
 *    "length". We retry once with 2x max_tokens before giving up.
 *  - Optional fallback binding for resilience (rate limits / outages).
 *  - Token budget guard across a run.
 *  - Every call emits a telemetry entry (wired to state storage by the
 *    pipeline runner) — runs must be reproducible.
 */
import { PROVIDER_PRESETS, type LlmBinding } from "../config/schema.js";
import { LlmError } from "../errors.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmUsage {
  prompt_tokens: number;
  completion_tokens: number;
}

export interface LlmResult {
  content: string;
  model: string;
  provider: string;
  finish_reason: string;
  usage: LlmUsage;
  duration_ms: number;
  via_fallback?: boolean;
}

export interface LlmCallLogEntry {
  ts: string;
  run_id?: string;
  agent?: string;
  purpose?: string;
  provider: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  duration_ms: number;
  ok: boolean;
  error?: string;
  via_fallback?: boolean;
}

export interface LlmCallContext {
  run_id?: string;
  agent?: string;
  purpose?: string;
  max_tokens?: number;
  temperature?: number;
}

export interface LlmClientOptions {
  onCall?: (entry: LlmCallLogEntry) => void;
}

interface RawChoice {
  finish_reason?: string | null;
  message?: { content?: string | null; reasoning?: string | null };
}
interface RawResponse {
  model?: string;
  choices?: RawChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class LlmClient {
  private totalTokens = 0;

  constructor(
    private binding: LlmBinding,
    private opts: LlmClientOptions = {},
  ) {}

  /** Total tokens consumed by this client instance (budget accounting). */
  usage(): number {
    return this.totalTokens;
  }

  private get endpoint(): string {
    const url = this.binding.base_url ?? PROVIDER_PRESETS[this.binding.provider];
    if (!url) {
      throw new LlmError(
        `no base_url for provider '${this.binding.provider}' (set llm.base_url)`,
      );
    }
    return url.replace(/\/+$/, "");
  }

  private async rawChat(body: Record<string, unknown>): Promise<RawResponse> {
    const key = this.binding.api_key;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.binding.timeout_ms);
    try {
      const res = await fetch(`${this.endpoint}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(key ? { authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      if (!res.ok) {
        const text = (await res.text()).slice(0, 500);
        throw new LlmError(`LLM HTTP ${res.status} from ${this.endpoint}: ${text}`);
      }
      return (await res.json()) as RawResponse;
    } catch (e) {
      if (e instanceof LlmError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      throw new LlmError(`LLM request to ${this.endpoint} failed: ${msg}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * One chat completion. `ctx.max_tokens` overrides the binding default for
   * this call; reasoning models retry once at 2x on `length` finishes.
   */
  async chat(messages: ChatMessage[], ctx: LlmCallContext = {}): Promise<LlmResult> {
    const maxTokens = ctx.max_tokens ?? this.binding.max_tokens;
    const temperature = ctx.temperature ?? this.binding.temperature;
    const t0 = Date.now();

    for (const attemptMax of [maxTokens, maxTokens * 2]) {
      const data = await this.rawChat({
        model: this.binding.model,
        messages,
        temperature,
        max_tokens: attemptMax,
      });
      const choice = data.choices?.[0];
      const finished = choice?.finish_reason;
      const content = typeof choice?.message?.content === "string"
        ? choice.message.content
        : "";

      if (!content.trim()) {
        const reasoning = choice?.message?.reasoning;
        if (finished === "length" && attemptMax === maxTokens) continue; // retry at 2x
        throw new LlmError(
          `empty completion (finish_reason=${finished ?? "unknown"}${
            typeof reasoning === "string" && reasoning.length > 0
              ? "; model returned reasoning only"
              : ""
          }); raise llm.max_tokens or check the model serves chat completions`,
        );
      }

      const usage: LlmUsage = {
        prompt_tokens: data.usage?.prompt_tokens ?? 0,
        completion_tokens: data.usage?.completion_tokens ?? 0,
      };
      const total = usage.prompt_tokens + usage.completion_tokens;
      const limit = this.binding.budget.max_tokens_total;
      if (limit !== undefined && this.totalTokens + total > limit) {
        throw new LlmError(
          `token budget exceeded for ${this.binding.provider}/${this.binding.model} (${this.totalTokens + total} > ${limit})`,
          "budget",
        );
      }
      this.totalTokens += total;
      const duration_ms = Date.now() - t0;
      this.opts.onCall?.({
        ts: new Date().toISOString(),
        run_id: ctx.run_id,
        agent: ctx.agent,
        purpose: ctx.purpose,
        provider: this.binding.provider,
        model: this.binding.model,
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
        duration_ms,
        ok: true,
      });
      return {
        content,
        model: data.model ?? this.binding.model,
        provider: this.binding.provider,
        finish_reason: finished ?? "stop",
        usage,
        duration_ms,
      };
    }
    throw new LlmError("unreachable: token escalation loop exited without result");
  }

  /**
   * Chat with automatic fallback: primary endpoint errors (network/HTTP)
   * trigger the fallback binding, if configured.
   */
  async chatWithFallback(
    messages: ChatMessage[],
    ctx: LlmCallContext = {},
  ): Promise<LlmResult> {
    try {
      return await this.chat(messages, ctx);
    } catch (primaryErr) {
      this.opts.onCall?.({
        ts: new Date().toISOString(),
        run_id: ctx.run_id,
        agent: ctx.agent,
        purpose: ctx.purpose,
        provider: this.binding.provider,
        model: this.binding.model,
        prompt_tokens: 0,
        completion_tokens: 0,
        duration_ms: 0,
        ok: false,
        error: primaryErr instanceof Error ? primaryErr.message : String(primaryErr),
      });
      if (!this.binding.fallback) throw primaryErr;
      const fb = new LlmClient(this.binding.fallback, this.opts);
      const r = await fb.chat(messages, { ...ctx, purpose: `${ctx.purpose ?? "chat"}+fallback` });
      return { ...r, via_fallback: true };
    }
  }
}
