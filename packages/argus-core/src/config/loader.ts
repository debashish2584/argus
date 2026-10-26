/**
 * Loads and validates `.argus/config.yaml`.
 *
 * Secret policy: config files may only reference secrets as `${ENV_VAR}`
 * (resolved from the process environment at load time). A missing variable is
 * a hard config error — Argus never guesses, and never stores key values.
 */
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { parse } from "yaml";
import { ConfigError } from "../errors.js";
import { ArgusConfigSchema, type ArgusConfig } from "./schema.js";

const ENV_REF = /\$\{([A-Z_][A-Z0-9_]*)\}/g;
const ENV_WHOLE = /^\$\{([A-Z_][A-Z0-9_]*)\}$/;

function resolveEnvRefs(value: unknown, missing: Set<string>): unknown {
  if (typeof value === "string") {
    const whole = value.match(ENV_WHOLE);
    if (whole) {
      const name = whole[1] as string;
      const v = process.env[name];
      if (v === undefined) missing.add(name);
      return v ?? "";
    }
    return value.replace(ENV_REF, (_m, name: string) => {
      const v = process.env[name];
      if (v === undefined) {
        missing.add(name);
        return "";
      }
      return v;
    });
  }
  if (Array.isArray(value)) return value.map((v) => resolveEnvRefs(v, missing));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveEnvRefs(v, missing);
    return out;
  }
  return value;
}

/** Canonical JSON (sorted keys) so the hash is stable across formats. */
function canonicalize(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v).sort()) out[k] = walk((v as Record<string, unknown>)[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(value));
}

export interface LoadedConfig {
  config: ArgusConfig;
  /**
   * Short sha256 over the fully-resolved config. Recorded with every run so
   * results are attributable to an exact configuration ("evidence always").
   */
  configHash: string;
  /** Absolute path of the repository root that owns `.argus/`. */
  root: string;
}

export function loadConfig(root: string): LoadedConfig {
  const file = path.join(root, ".argus", "config.yaml");
  if (!existsSync(file)) {
    throw new ConfigError(`missing ${file} — run \`argus init\` first`);
  }
  const raw = parse(readFileSync(file, "utf8"));
  if (raw === null || typeof raw !== "object") {
    throw new ConfigError(`${file} is empty or not a mapping`);
  }
  const missing = new Set<string>();
  const resolved = resolveEnvRefs(raw, missing);
  if (missing.size > 0) {
    throw new ConfigError(
      `config references unset environment variable(s): ${[...missing].join(", ")} — export them and retry`,
    );
  }
  const parsed = ArgusConfigSchema.safeParse(resolved);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new ConfigError(`invalid .argus/config.yaml — ${detail}`);
  }
  const config = parsed.data;
  const configHash = createHash("sha256").update(canonicalize(resolved)).digest("hex").slice(0, 16);
  return { config, configHash, root: path.resolve(root) };
}
