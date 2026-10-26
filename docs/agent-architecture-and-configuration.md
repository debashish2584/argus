# Argus — Agent Architecture & Configuration Model

> **Status**: Design document, part of the MVP specification.
> **Companions**: [Architecture & Technical Specification](./architecture-and-specification.md) · [Post-MVP Roadmap](./post-mvp-roadmap.md)

## 1. Core Idea

The **pipeline is fixed; the agents are swappable**. Argus runs a six-stage loop
(analyze → plan → execute → triage → fix → submit), but every stage is executed
by an *agent* that is independently configurable: its prompt, its model, its
inputs, its outputs, its tools, its limits, and its report channel.

**Anatomy of an agent** — seven dimensions, each overridable per agent:

| Dimension        | What it is                                                        | Shipped default |
| :--------------- | :---------------------------------------------------------------- | :-------------- |
| **Identity**     | `id` + `version` (which prompt/config revision)                   | `default`       |
| **Prompt**       | Templated instruction file with `{{variables}}`                   | built-in        |
| **LLM binding**  | provider + model + API-key reference + fallback + cost budget     | user-set        |
| **Input adapters** | typed slots: code source, spec source, contracts, run history  | git + repo md   |
| **Output sinks**   | typed slots: where artifacts/reports are written or sent        | `.argus/` local |
| **Tool scope**     | mechanical capability policy (fs, shell, net, git) — **not** prompt-based | per-agent |
| **Limits & report** | timeout, retries, optional report sink (email/markdown/webhook) | conservative |

Ship a working default for every dimension; users override progressively.

## 2. The Six Agents (defaults)

| Agent | Stage | Reads | Writes | Tool scope | Invariant guard |
| :---- | :---- | :---- | :---- | :--------- | :-------------- |
| `analyze` | 1 | git diff, specs, contracts | impact report (in-memory + run dir) | `fs_read`, `git` | — |
| `testplan` | 2 | impact report, specs, existing plans | `.argus/testplans/` (staging) | `fs_write: .argus/testplans/**` only | may not modify `ACTIVE` plans; new plans land as `DRAFT` |
| `execute` | 3 | plans, env (service URLs) | run artifacts (video/trace/HAR/console) | browser + `net: target URLs only` | deterministic a11y path; LLM escalation only if `--vision` |
| `triage` | 4 | run artifacts, state history, app logs | bug reports, tracker issues | `fs_read`, app-log access | runs **serially** (cross-run correlation) |
| `fixer` | 5 | bug report, source, target repo's standards doc | application source on `argus/<bug>` branch | `fs_write` allowlist, `shell` allowlist (build/test) | **cannot write**: `.argus/**`, test files, specs, contracts, `package*.json`, lockfiles, CI config — enforced at fs layer, not by prompt |
| `submit` | 6 | verified fix + evidence | commit, PR | `git push` (branch only), tracker API | **never** pushes to `main`/protected branches |

## 3. Configuration Schema

Config lives at `.argus/config.yaml` in the target repository. Secrets are
**always references**, never values: `${ENV_VAR}` is resolved at load time.

```yaml
# .argus/config.yaml
version: 1

target:                       # the application under test (external-env mode in MVP)
  repo: /home/dev/cogniflow   # source root the agents may read
  env:                        # service map; consumed by plans as {{VAR}}
    AUTH_URL: http://localhost:3000
    APP_URL: http://localhost:3008
  health:                     # all must pass before execution
    - { url: "{{AUTH_URL}}/", expect: 200 }
    - { url: "{{APP_URL}}/", expect: 200 }

diff:
  base: origin/main           # merge-base semantics, not HEAD~1

llm:                          # global defaults; agents override
  provider: vllm-local        # preset: openai | anthropic | gemini | openrouter | vllm-local | custom
  base_url: http://localhost:8000/v1
  model: nvidia/Qwen3.8-27B-NVFP4
  api_key: ${ARGUS_LLM_KEY}   # any string for local endpoints

agents:
  testplan:
    prompt: default           # or: .argus/agents/testplan/v2.md
    llm:
      provider: openai
      model: gpt-4o
      api_key: ${OPENAI_API_KEY}
      fallback: { provider: openrouter, model: anthropic/claude-sonnet-4, api_key: ${OPENROUTER_KEY} }
      budget: { max_cost_usd: 2.0 }
    inputs:
      code_source: { type: git }                          # built-in
      spec_source: { type: git-md, paths: ["docs/**/*.md"] }
      # spec_source: { type: hook, command: ./tools/export-specs.sh, timeout: 60s }
    limits: { timeout: 10m, retries: 2 }
    report: { type: email, on: failure-only, to: [qa@example.com] }

  fixer:
    prompt: default
    tools:
      fs_write:
        - "modules/**/src/**"
        - "modules/**/app/**"
      shell:
        allow: ["npm run test:*", "npm run build", "npx vitest run"]
      net: deny
    limits: { timeout: 30m, retries: 1 }

pipeline:
  stages: [analyze, testplan, execute, triage, fixer, submit]
  gates:
    testplan: human           # human (default) | auto | verify-then-pr
  on_failure: fail-fast       # fail-fast | continue-to-triage

report:                       # global sinks; per-agent `report` overrides `on`/`to`
  email:
    smtp: { host: ${SMTP_HOST}, port: 1025, user: ${SMTP_USER}, password: ${SMTP_PASS} }
    from: argus@example.com

redact:                       # applied to every log, report, PR body
  patterns:
    - "eyJ[A-Za-z0-9._-]+"                 # JWT
    - "\\b[0-9]{3}-[0-9]{2}-[0-9]{4}\\b"   # SSN
  env_secrets: [SMTP_PASS, OPENAI_API_KEY] # scrub these env var *values* too
```

Tiering: a first-time user writes only `target:` + one `llm:` block. Every other
key has a sane default.

## 4. Prompt Versioning

- Shipped prompts: `packages/argus-core/prompts/<agent>/default.md`.
- User overrides: `.argus/agents/<agent>/<version>.md` — **git-versioned in the
  target repo**, so a prompt change is a reviewable commit.
- `argus agent use <agent> <version>` records the selection in config.
- Every run logs `(agent, prompt_version, provider, model, config_hash)` into
  state → runs are reproducible and prompt versions are A/B-able.

Prompt templates receive structured variables (`{{diff}}`, `{{specs}}`,
`{{impact_report}}`, `{{bug_report}}`, …) — the agent runtime renders them;
users never see raw JSON plumbing in their prompt files.

## 5. Hook Protocol (custom sources & sinks)

A hook is any executable command. The contract is JSON on stdin → JSON on
stdout; exit code `0` on success, non-zero aborts the stage with stderr as the
error message.

**Input (stdin)** — common envelope:
```json
{ "argus_version": "0.1.0", "run_id": "run-20261026-…", "agent": "testplan",
  "target": { "repo": "/path", "env": { "AUTH_URL": "…" } } }
```

**Per-slot output schemas** (MVP):
```json
// code_source
{ "base": "abc123", "head": "def456", "diff": "…", "files": ["a.ts", "b.ts"] }
// spec_source
{ "specs": [ { "id": "app-shell", "title": "…", "ref": "docs/architecture/….md", "content": "…" } ] }
```
Built-in adapters (`git`, `git-md`) implement the *same* schemas — a custom
hook is not a special case, it is another adapter. This keeps Confluence,
Notion, or an internal doc store one script away.

## 6. Security Model

1. **Tool scope is mechanical.** Path allowlists and shell policies are
   enforced by the runtime, not asked for in the prompt. A scope violation
   aborts the run and is recorded.
2. **Invariant guard (the fixer).** Test plans, specs, contracts, `.argus/**`,
   dependency manifests, lockfiles, and CI config are read-only for the fixer.
   Preventing "cheating" cannot rely on the model's goodwill.
3. **Secrets by reference.** `${ENV}` resolution happens at config load; values
   never enter config files, logs, bug reports, or PR bodies. A redaction pass
   (patterns + env-secret values) runs over *all* outbound text.
4. **Respect the target.** Before fixing, the fixer ingests the target repo's
   engineering-standards document (e.g. `docs/agent-context.md`) as mandatory
   context — the tool follows the repository's own rules.
5. **Branch-only writes.** `submit` may push `argus/*` branches only;
   PRs are the sole path to main.

## 7. Observability & Reproducibility

Per run, state records: `run_id`, timestamps per stage, `agent_version`,
`prompt_version`, `provider`, `model`, `config_hash`, target fingerprint
(commit + health), durations, token counts, statuses, artifact references.

Every *failure* ships an evidence bundle under `.argus/runs/<run_id>/`:
screenshots, `.webm` video, `trace.zip`, HAR, console log, backend log excerpts,
and a machine-readable `result.json`. This bundle is the input to triage and
the content of the PR.

## 8. Pipeline Orchestration (MVP)

- **Sequential** stages, each consuming the previous stage's on-disk output.
- **Gates**: `pipeline.gates.<stage>` = `auto | human | verify-then-pr`
  (default `human` where a gate exists). MVP ships one gate — after
  `testplan`, since plans are the fixer's ground truth: `human` prompts the
  operator (abort on non-TTY unless `--yes`), `auto` skips it, and
  `verify-then-pr` defers approval to PR review. PRs are opened **only after**
  the verification re-run passes — enforced structurally, not by prompt.
- **On-failure**: `fail-fast` (default) or `continue-to-triage` (collect all
  scenario results before triaging).
- Parallel fan-out, sandboxes, and pools are deliberately **out of MVP scope** —
  see [Post-MVP Roadmap](./post-mvp-roadmap.md). The orchestration code is
  written so that `fan_out` becomes a configuration concern, not a rewrite.

## 9. Execution Harness (Playwright)

Stage 3 (`execute`) is deterministic and LLM-free: a Playwright harness
interprets the plan's `steps` and writes evidence into the scenario sink.

- **Accessibility-first locators.** Steps target by `role`/`name`/`testid`/
  `text` (resolved against the a11y tree); raw `css` is a last-resort escape
  hatch. The `testplan` prompt is written to emit a11y locators.
- **Stop at the first failure.** The failing step is recorded with its error;
  later steps are marked `skipped`. One failure per scenario keeps triage
  unambiguous — "where did it break" must not need interpretation.
- **Evidence always.** Every scenario captures, in its sink dir:
  `video.webm`, `trace.zip` (with screenshots), `network.har` (HAR 1.2),
  `console.log`, and a final `screenshot.png` — plus `fail-<step>.png` at the
  failing step. Video/trace/HAR capture can each be disabled in the harness
  options; redaction runs over console + network text before it hits disk, and
  sensitive response headers (`set-cookie`, `cookie`, `authorization`) are
  masked inside the HAR.
- **URLs are rendered, never baked.** Step URLs may use `{{VAR}}` service-map
  refs; they are rendered against the run's env. A plan referencing an
  undefined variable is a configuration defect and fails **before** the
  browser launches — it is not executed and then triaged as an app bug.
- **One browser per scenario.** Isolation is worth the launch cost in a
  sequential MVP; per-scenario video/trace capture relies on it.
