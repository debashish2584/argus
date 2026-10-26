/**
 * Agent runner: the single LLM boundary for all agents.
 *
 * Responsibilities:
 *  - resolve the prompt for an agent (built-in default or user override file)
 *  - render prompt templates ({{VARS}})
 *  - invoke the LLM with per-agent limits (timeout, retries)
 *  - record every call to state (model + prompt version + config hash)
 *
 * Agents themselves stay pure: they prepare inputs, call `invoke`, and
 * validate/transform the result. This keeps agents testable with a fake LLM.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { ChatMessage, LlmCallContext, LlmResult } from "../llm/client.js";
import { ConfigError } from "../errors.js";
import { renderTemplate } from "../template.js";
import type { AgentId } from "../config/schema.js";

export interface ChatFn {
  (messages: ChatMessage[], ctx: LlmCallContext): Promise<LlmResult>;
}

export interface AgentDeps {
  chat: ChatFn;
  log: (line: string) => void;
  /** Recorded on every stage record: which prompt revision is in effect. */
  configHash: string;
}

/** Where built-in prompts live (package root, next to dist/). */
export function builtinPromptDir(): string {
  // dist/agent/runner.js → <package>/prompts
  return path.join(fileURLToPath(new URL("..", import.meta.url)), "..", "prompts");
}

export interface ResolvedPrompt {
  /** "default" or the repo-relative override path. */
  version: string;
  text: string;
}

/**
 * Resolve an agent's prompt.
 * `prompt` is either "default" (built-in) or a path relative to repoRoot
 * (typically `.argus/agents/<agent>/<version>.md`).
 */
export function resolvePrompt(
  agent: AgentId,
  prompt: string,
  repoRoot: string,
): ResolvedPrompt {
  if (prompt === "default") {
    const file = path.join(builtinPromptDir(), agent, "default.md");
    if (!existsSync(file)) {
      throw new ConfigError(`built-in prompt missing: ${file}`);
    }
    return { version: "default", text: readFileSync(file, "utf8") };
  }
  const abs = path.resolve(repoRoot, prompt);
  if (!existsSync(abs)) {
    throw new ConfigError(`prompt override not found: ${abs}`);
  }
  return { version: prompt, text: readFileSync(abs, "utf8") };
}

export interface InvokeOptions {
  agent: AgentId;
  promptVersion: string;
  system: string;
  user: string;
  runId?: string;
  purpose?: string;
  maxTokens?: number;
  timeoutMs?: number;
  retries?: number;
}

/** Invoke the LLM with retries; returns the raw content plus call metadata. */
export async function invoke(
  deps: AgentDeps,
  opts: InvokeOptions,
): Promise<LlmResult> {
  const retries = opts.retries ?? 0;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await deps.chat(
        [
          { role: "system", content: opts.system },
          { role: "user", content: opts.user },
        ],
        {
          run_id: opts.runId,
          agent: opts.agent,
          purpose: opts.purpose ?? `agent:${opts.agent}`,
          max_tokens: opts.maxTokens,
        },
      );
    } catch (e) {
      lastErr = e;
      deps.log(
        `  agent ${opts.agent}: attempt ${attempt + 1}/${retries + 1} failed — ${(e as Error).message}`,
      );
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * Render a template and invoke. `vars` are rendered into both prompts.
 * Unknown variables fail loud (the harness must never run a plan pointing at
 * an empty URL).
 */
export async function renderAndInvoke(
  deps: AgentDeps,
  opts: InvokeOptions & { systemVars?: Record<string, string>; userVars?: Record<string, string> },
): Promise<LlmResult> {
  const system = renderTemplate(
    opts.system,
    opts.systemVars ?? {},
    `system prompt (${opts.agent})`,
  );
  const user = renderTemplate(
    opts.user,
    opts.userVars ?? {},
    `user prompt (${opts.agent})`,
  );
  return invoke(deps, { ...opts, system, user });
}

/* ------------------------------------------------------------------ */
/* JSON extraction                                                     */
/* ------------------------------------------------------------------ */

/**
 * Extract a JSON document from LLM output. Models frequently wrap JSON in
 * ```json fences or add commentary; this finds the first balanced
 * object/array and parses it. The parsed value is validated against `schema`
 * — invalid output is a hard error (never silently coerced).
 */
export function extractJson<T>(text: string, schema: z.ZodType<T>, where: string): T {
  const cleaned = stripFences(text);
  const start = findStart(cleaned);
  if (start === -1) {
    throw new ConfigError(
      `${where}: no JSON document in output (first 200 chars: ${cleaned.slice(0, 200)})`,
    );
  }
  const candidate = extractBalanced(cleaned, start);
  let value: unknown;
  try {
    value = JSON.parse(candidate);
  } catch (e) {
    throw new ConfigError(`${where}: invalid JSON: ${(e as Error).message}`);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .slice(0, 5)
      .join("; ");
    throw new ConfigError(`${where}: schema violation — ${detail}`);
  }
  return parsed.data;
}

function stripFences(text: string): string {
  return text
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();
}

function findStart(s: string): number {
  const a = s.indexOf("{");
  const b = s.indexOf("[");
  if (a === -1) return b;
  if (b === -1) return a;
  return Math.min(a, b);
}

/** Walk from `start` to the matching close bracket, respecting strings. */
function extractBalanced(s: string, start: number): string {
  const open = s[start] as string;
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i] as string;
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return s.slice(start); // unbalanced: return the rest, JSON.parse will report
}
