/**
 * Argus error types. Every error carries a stable machine-readable `code`
 * so the CLI and pipelines can branch on failure classes.
 */
export class ArgusError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Malformed or unresolvable configuration (including missing ${ENV} refs). */
export class ConfigError extends ArgusError {
  constructor(message: string) {
    super(message, "config");
  }
}

/** LLM request failed: network, HTTP error, empty content, or budget. */
export class LlmError extends ArgusError {
  constructor(message: string, code = "llm") {
    super(message, code);
  }
}

/** A custom hook (external command) failed or produced invalid output. */
export class HookError extends ArgusError {
  constructor(message: string) {
    super(message, "hook");
  }
}

/** An agent attempted an action outside its declared tool scope. */
export class ScopeViolation extends ArgusError {
  constructor(message: string) {
    super(message, "scope-violation");
  }
}

/** The execution harness could not resolve or interact with a target. */
export class HarnessError extends ArgusError {
  constructor(message: string) {
    super(message, "harness");
  }
}

/** Pipeline aborted by a gate or on-failure policy. */
export class PipelineError extends ArgusError {
  constructor(message: string) {
    super(message, "pipeline");
  }
}
