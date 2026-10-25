# Argus — Post-MVP Feature Roadmap

> **Status**: Planned. These features were deliberately scoped **out of the
> MVP** ("honest scope" principle): each is documented here so it is designed
> but not forgotten. The MVP architecture was shaped so these are
> configuration and adapter additions, not rewrites.

Ordered by expected value.

## 1. Sandbox Pool ⭐ (highest value)

Isolated, reproducible execution environments per scenario.

- **Backends (pluggable)**: `docker` · `docker-compose` · `kubernetes` ·
  `local-process` · `custom-hook`. Default: compose template shipped at
  `.argus/sandbox/docker-compose.yaml` (app + DB + mock services).
- **Sandbox spec**: compose template, env, seed command, health checks, port
  strategy, per-sandbox CPU/mem caps.
- **Lifecycle**: `create → ready (health) → seed → lease → release →
  teardown`. Teardown is guaranteed even on crash; **artifacts are captured
  before teardown** (video, trace, HAR, container logs).
- **Port & identity allocation**: per-sandbox port block (or random-free),
  exposed as a service map (`{{AUTH_URL}}`, `{{APP_URL}}`, `SANDBOX_ID`)
  injected into plans at lease time; seed data suffixed by `SANDBOX_ID` for
  identity isolation.
- **Browser placement**: default = app in sandbox, browser on host hitting
  published ports (simple video/trace capture); in-sandbox browser as an option.
- **Sandbox access API** (scoped per agent): service map · `logs(service)` ·
  `exec(allowlisted)` · seed/reset · fs write (fixer only).
- **Pool**: `max_concurrent`, per-sandbox resources, acquire timeout, scenario
  timeout, `overflow: queue|fail`, capacity probe (`argus sandbox capacity`).
- **Daemon boundary**: MVP owns the pool in-process; post-MVP it moves to a
  small local daemon with a CLI client (required for CI/remote runners).

## 2. Parallel Execution (DAG pipeline)

- Pipeline as a **DAG** with `fan_out` / `merge` primitives:
  - **testplan fan-out**: by *shard* (split affected surface) or by
    *diversity* (two models/prompt versions, then dedupe/reconcile). Writers
    stage to temp paths; a merge step writes final plans.
  - **execute fan-out**: by *scenario*, `sandbox: exclusive` per scenario
    (state isolation; makes flakiness-vs-contamination analysis meaningful).
  - **fixer fan-out**: by *bug*, isolated in **git worktrees**
    (`fix/argus-<bug>`), each with its own verification sandbox.
  - **triage stays serial** — cross-run root-cause correlation (10 scenario
    failures → 1 bug with 10 reproductions) is the win; sharding it loses it.
- **Run-level cost budget** shared across all workers (parallelism multiplies
  LLM spend; caps are mandatory, not optional).
- **State sharding**: workers write per-worker shards; a collector merges into
  the central state store at run end.
- **ID threading**: `run_id / scenario_id / sandbox_id / agent_version` must
  appear in every artifact, log line, bug report, and PR.

## 3. Vision Layer

- Multimodal **self-healing**: on locator failure → screenshot + a11y tree →
  vision model proposes the correct target → runtime applies it.
- **Escalation policy**: deterministic selectors first (always); vision only
  on failure or for visual assertions (layout, toasts, animations).
- **Budgets**: max vision escalations per step and per run; cost logged in
  state.
- **Providers**: OpenAI, Gemini, Anthropic, OpenRouter — same binding model as
  any other agent (vision is a capability of the `execute` agent, not a new
  agent).

## 4. Test Plan Lifecycle

- `DRAFT → ACTIVE` approval flow: plans are ground truth only after approval;
  plan changes go through PRs (breaks the "LLM tests → LLM fixer" circular
  trust loop).
- `covers:` metadata in plan frontmatter (modules/routes/endpoints) so
  diff→plan selection is a set intersection, not a guess.

## 5. State Backend Upgrade

MVP uses a zero-dependency JSONL state store behind a `StateStore` interface.
Upgrade to **SQLite (WAL)** for flakiness analytics queries; interface is
already stable — this is a backend swap.

## 6. Adapters & Integrations

- **Trackers**: Linear, Jira, GitLab (MVP ships GitHub + local markdown).
- **Notifications**: Slack, Discord, generic webhook, PagerDuty.
- **Contract testing as first-class stage**: OpenAPI/gRPC/GraphQL probes run
  before visual E2E — contract violations are often the root cause of UI
  failures, and probing is cheap, fast, deterministic.

## 7. Artifact Management

S3 / MinIO / GCS upload for media; local disk as cache; retention & prune
policy (`runs: keep_failure_artifacts_only`, `retention_days`); HAR filtering.

## 8. Triggers & CI

- `action-argus`: GitHub Actions reusable workflow (PR / merge / cron).
- Webhook triggers; branch-level `.argus/config.yaml` support.
- `human` gates in CI become artifact-approval gates (PR check on plans).

## 9. KPI Analytics

Tracked in state, reported per run and per repo: bugs caught vs. bugs found by
humans, false-positive rate, fix acceptance rate (PRs merged as-is / merged
with changes / rejected), flake rate, cost per run, mean time to verified fix.

## Status Table

| # | Feature | MVP? | Priority |
| :- | :------ | :--- | :------- |
| 1 | Sandbox pool | No | P0 post-MVP |
| 2 | Parallel DAG execution | No | P0 post-MVP |
| 3 | Vision layer (hook present, off) | Partial | P1 |
| 4 | Test plan lifecycle | Partial (`DRAFT` only) | P1 |
| 5 | SQLite state backend | No (JSONL) | P2 |
| 6 | Tracker/notification adapters | No (GitHub + markdown) | P2 |
| 7 | Artifact management | No (local disk) | P2 |
| 8 | Triggers & CI workflow | No | P1 |
| 9 | KPI analytics | No | P3 |
