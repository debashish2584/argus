/**
 * Output redaction. Every outbound text — logs, bug reports, PR bodies,
 * emails — passes through a Redactor. Built-ins cover JWTs, API keys, and
 * credential-shaped strings; config adds patterns and scrubs the *values* of
 * named environment secrets (e.g. the SMTP password) wherever they appear.
 */
export interface RedactorOptions {
  /** Extra regex *sources* (global flag applied internally). */
  extraPatterns?: string[];
  /** Env var names whose values must be scrubbed from output. */
  envSecrets?: string[];
}

interface Rule {
  src: string;
  label?: string;
  i?: boolean;
}

const BUILTINS: ReadonlyArray<Rule> = [
  // JWT / bearer payloads
  { src: "eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_.-]{8,}", label: "JWT" },
  // Provider API keys (best-effort shapes)
  { src: "\\bsk-[A-Za-z0-9]{16,}\\b", label: "API_KEY" },
  { src: "\\bAIza[A-Za-z0-9_-]{20,}\\b", label: "API_KEY" },
  // Credentials in logs / query strings (case-insensitive)
  {
    src: "\\b(password|passwd|secret|token)\\b\\s*[:=]\\s*[\"'][^\"']{4,}[\"']",
    label: "CREDENTIAL",
    i: true,
  },
  {
    src: "\\b(password|passwd|secret|token)=[A-Za-z0-9%]{6,}",
    label: "CREDENTIAL",
    i: true,
  },
];

export class Redactor {
  private rules: ReadonlyArray<{ re: RegExp; label: string }> = [];
  private values: string[] = [];

  constructor(opts: RedactorOptions = {}) {
    for (const b of BUILTINS) this.add(b);
    for (const p of opts.extraPatterns ?? []) this.add({ src: p, label: "CUSTOM" });
    for (const name of opts.envSecrets ?? []) {
      const v = process.env[name];
      if (v && v.length >= 5) this.values.push(v);
    }
  }

  add(rule: Rule): void {
    try {
      const re = new RegExp(rule.src, rule.i ? "gi" : "g");
      this.rules = [...this.rules, { re, label: rule.label ?? "CUSTOM" }];
    } catch {
      // An invalid pattern is a config mistake — skip it, don't crash the run.
    }
  }

  run(text: string): string {
    let out = text;
    for (const { re, label } of this.rules) {
      out = out.replace(re, `[REDACTED:${label}]`);
    }
    for (const v of this.values) {
      out = out.split(v).join("[REDACTED]");
    }
    return out;
  }
}
