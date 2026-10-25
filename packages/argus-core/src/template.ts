/**
 * Template rendering for prompts, plan steps, and reports.
 *
 * `{{VAR}}` placeholders are replaced from a variable map. Unknown variables
 * are a hard error (misconfiguration must fail loudly, not silently render
 * empty URLs into a test plan).
 */
import { ConfigError } from "./errors.js";

const VAR_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export function renderTemplate(
  template: string,
  vars: Record<string, string>,
  where = "template",
): string {
  return template.replace(VAR_RE, (_m, name: string) => {
    const v = vars[name];
    if (v === undefined) {
      throw new ConfigError(`${where}: unknown variable {{${name}}}`);
    }
    return v;
  });
}

/** Recursively render `{{VAR}}` in every string inside an object graph. */
export function renderDeep<T>(
  value: T,
  vars: Record<string, string>,
  where = "template",
): T {
  if (typeof value === "string") {
    return renderTemplate(value, vars, where) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => renderDeep(v, vars, where)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = renderDeep(v, vars, where);
    }
    return out as T;
  }
  return value;
}
