# Argus dogfood — hermetic closed-loop harness (chunk D)

This directory dogfoods Argus **hermetically**: the full six-stage closed
loop (`argus heal`) is driven against a seeded target app with a **scripted**
OpenAI-compatible LLM. No real model, no API keys, no network beyond
`127.0.0.1`. The same harness runs in CI as the project's acceptance gate.

## Components

```
dogfood/
├── sample-app/        seeded target: tiny static SaaS site (5 bugs + 1 control)
│   ├── server.mjs     zero-dependency static server (honors PUBLIC_DIR)
│   ├── public/        pages, css, js — the bugs live here
│   └── docs/          spec.md (intended behavior) + agent-context.md (standards)
├── scripted-llm.mjs   scripted OpenAI-compatible endpoint (:4321)
├── run.mjs            orchestrator + acceptance checks (the CI gate)
├── selftest.mjs       fast harness self-test (no build, no browser)
└── reports/           one Markdown report per run (committed; verdict inside)
```

### The seeded target (`sample-app/`)

`docs/spec.md` states the intended behavior of a tiny SaaS landing site.
Five seeded defects make the corresponding test-plan assertions fail; a
sixth plan (TP-006) is a **passing control** that must stay green:

| plan | seeded defect | surface |
|------|---------------|---------|
| TP-001 | hero copy "Try us now" ≠ spec | `public/index.html` |
| TP-002 | `data-testid="free-trial-cta"` missing | `public/features.html` |
| TP-003 | Pro priced $19/mo instead of $9/mo | `public/pricing.html` |
| TP-004 | About nav link dead (`href="#"`) | `public/js/nav.js` |
| TP-005 | checkout binds `order-btn` ≠ real id `place-order` | `public/js/checkout.js` |
| TP-006 | *(control — no defect)* | `public/about.html` |

Evidence flavor: `/js/analytics.js` is deliberately absent, so every page's
network HAR contains a 404 — evidence is recorded but never a scenario
failure.

### The scripted LLM (`scripted-llm.mjs`)

An OpenAI-compatible `POST /v1/chat/completions` endpoint that returns
**canned, schema-valid responses** per agent. Dispatch is keyed on the
*rendered system-prompt content* (never request order), mirroring exactly
how the real Argus prompts look:

- `ANALYZE agent` → impact report over the (empty) baseline diff
- `TEST PLAN agent` → the six plans (TP-001…TP-006) with a11y locators
- `TRIAGE agent` → keyed by the plan line `- Plan: TP-NNN — <title>`; only
  the five seeded plans have responses (TP-006 passes, never triaged)
- `FIXER agent` → keyed by `- Title: <bug title>`; returns **byte-exact
  `git apply`-able unified diffs** (patch strings end with a newline, as
  `git apply` requires)
- `SUBMIT agent` → keyed by `- Bug: BUG-NNN — <title> (P…)` + the run-id
  footer; returns PR title/body/commit message

Any unrecognizable prompt yields **no response**, which makes the pipeline
hard-fail rather than silently pass — the harness is only as honest as its
routing.

### The orchestrator (`run.mjs`)

```
1. build (npm run build) if dist/ is missing
2. stage a fresh git target: copy sample-app → temp dir, git init -b main,
   one base commit. This copy is the served app, so patches the fix loop
   applies are what the verification re-runs actually see — no restart.
3. start scripted-llm (:4321) and sample-app (:4173, PUBLIC_DIR=target)
4. write .argus/config.yaml in the target:
   - gates.testplan=auto, on_failure=continue-to-triage
   - diff.base: main   (a fresh repo has no origin/main)
   - llm → scripted endpoint, provider custom
5. `argus heal --repo <target>` (ARGUS_GITHUB_TOKEN stripped → local PRs)
6. assert the acceptance bar (below)
7. write reports/dogfood-<ts>.md (verdict + tables + LLM telemetry)
```

Exit code `0` = acceptance bar met; `1` = not met. CI uses it verbatim.

## Running

```sh
# fast harness self-test (no build, no browser; patch + routing consistency)
node dogfood/selftest.mjs

# full hermetic closed loop (~2 min; needs Playwright chromium)
node dogfood/run.mjs            # exit 0 = PASS
node dogfood/run.mjs --keep     # keep the temp target for inspection
```

Ports are overridable: `DOGFOOD_LLM_PORT` (4321), `DOGFOOD_APP_PORT` (4173).

## Acceptance bar

| check | requirement |
|-------|-------------|
| run completed | `runs.jsonl` status `completed` |
| plans executed | all 6 plans ran (5 fail, control passes) |
| detection | ≥4/5 seeded bugs triaged into `bugs.jsonl` |
| repair | ≥4/5 bugs `fixed` (patch applied + verify re-run passes) |
| control | TP-006 stays green throughout |
| verification | every fix has a passing `<plan>-verify` scenario |
| evidence | video/trace/HAR/console/screenshot per fixed bug |
| PR staging | `pull-request.json` per fix, status `pending-local` (no token), branch exists |
| telemetry | ≥15 LLM calls recorded for the run (reproducible runs) |

## Design notes

- **Why the target is a fresh git copy** — the fix loop cuts
  `argus/BUG-NNN` branches from the run's `baseHead` and commits into the
  working tree; the static server serves that same tree, so the
  triage→fix→verify loop observes real file changes with zero rebuild.
- **Why dispatch keys on rendered prompts** — a scripted stand-in is only
  faithful if it reacts to the same signals a real model would see. If an
  Argus prompt template changes, the router misses it and the run fails
  loudly instead of producing a false PASS.
- **Why no GitHub token** — deterministic local PRs (`pending-local`)
  exercise the full submit stage without external state; with a token the
  same code path opens real PRs (see `src/github.ts` in `@argus/core`).

## Reports

Each run writes `reports/dogfood-<timestamp>.md`: verdict, acceptance
table, per-stage timings, scenario outcomes, bug table, and LLM token
telemetry. Reports are committed so CI history doubles as a regression
trail for the harness itself.
