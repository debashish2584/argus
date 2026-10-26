# Argus dogfood — CogniFlow app-shell (real LLM, real app)

Date: 2026-10-26
Target: `cfroot/cogniFlow` → `modules/frontend/app-shell/` (product portal on `:3008`)
LLM: `nvidia/Qwen3.8-27B-NVFP4` served by local **vLLM** at `http://localhost:8000/v1`
App: app-shell Vite dev server already running on `127.0.0.1:3008`
GitHub: **no token** → any fix would have been staged locally (none needed)

> This is a **real-model** dogfood: unlike the hermetic `sample-app` run
> (scripted LLM + seeded bugs, which exercises the fix loop), the app-shell
> has no seeded defects. The value here is proving the closed loop works
> against a **real reasoning model** producing **schema-validated JSON**, and
> against a **real running app** with a **real spec** — the surfaces the
> hermetic harness cannot exercise.

**Verdict: PASS** — the full six-stage closed loop completed against a real
LLM and a real app; the spec-derived plan was valid, executed, and passed
with full evidence captured.

## How it was run

```sh
# 1. config written to the target repo (.argus/config.yaml):
#    - target.env.APP_URL = http://localhost:3008, health on {{APP_URL}}/
#    - spec_source scoped to docs/specs/app-shell-microspecs…md (the app's
#      own frozen contract) for both analyze and testplan
#    - llm: provider vllm-local, base_url http://localhost:8000/v1,
#      model nvidia/Qwen3.8-27B-NVFP4, max_tokens 8192
#    - pipeline.gates.testplan = auto, on_failure = continue-to-triage
#    - standards_doc = docs/agent-context.md
# 2. closed loop:
env -u ARGUS_GITHUB_TOKEN NO_COLOR=1 \
  node packages/argus-cli/dist/bin.js heal --repo /home/debashish/Projects/cfroot/cogniflow
```

Run id: `run-20261026-073303` · target head `6629e2c` (main) · config hash `a436de7e7f73f1`

## Stages

| stage | status | duration | detail |
|-------|--------|----------|--------|
| analyze | ok | 60.9s | 0 changed files, 1 spec → impact report over the app-shell contract |
| testplan | ok | 251.9s | 1 plan created (DRAFT), gate `auto` |
| execute | ok | 10.5s | 1 executed, 0 failed (health `:3008/` → 200 first) |
| triage | skipped | 0ms | no failures to triage |
| fixer | skipped | 0ms | no bugs to fix |
| submit | skipped | 0ms | no verified fixes to submit |

`run.runs.jsonl` status: **completed**.

## The spec-derived plan (TP-001)

The testplan agent read the app-shell microspec and produced a valid,
schema-validated plan — a P0 baseline on the primary auth entry contract:

| field | value |
|-------|-------|
| id | `TP-001` |
| title | *Verify unauthenticated app shell redirects to auth portal signin* |
| module / priority / status | `app-shell` / `P0` / `DRAFT` |
| spec_ref | `docs/specs/app-shell-microspecs-and-parallel-agent-prompts.md` |
| tags | `baseline, auth, token-guard, redirect` |

Steps (deterministic, a11y/url-first — no vision):

```
open-shell    navigate {{APP_URL}}
wait-redirect wait      (10s budget for the client-side redirect)
redirected    assert url_contains "/signin?reason=auth_required"
```

**Result: PASS** in 10.5s.

## Why the pass is meaningful (not vacuous)

The assertion is not a no-op. The app-shell's `App.tsx` token guard genuinely
ejects an unauthenticated visitor to the auth portal:

```ts
// modules/frontend/app-shell/src/App.tsx
// "… cf.adultSession → eject to :3000/signin?reason=auth_required"
window.location.assign(getAuthRedirectUrl('auth_required', '/family'));
```

So the LLM-derived plan independently re-derived the same contract the code
implements, and the browser confirmed it at runtime. That is the closed loop
doing its job: **spec → plan → execution → verdict**, with the model's output
validated against the plan schema before execution.

## Evidence captured (per scenario, `scenarios/TP-001/`)

| file | present |
|------|---------|
| `result.json` | ✓ (status `pass`, 3/3 steps) |
| `video.webm` | ✓ |
| `trace.zip` | ✓ |
| `network.har` | ✓ (initial `:3008/` load + module graph, all 200) |
| `console.log` | ✓ (empty — no console errors/warnings) |
| `screenshot.png` | ✓ (final state after redirect) |

`result.json`: `status: pass`, steps `open-shell ✓ (73ms) → wait-redirect ✓ (10001ms) → redirected ✓ (1ms)`, `console_errors: []`, `network_failures: []`.

## LLM telemetry (reproducible run)

Recorded in `.argus/state/llm-calls.jsonl` (model + prompt version + config hash per call):

| agent | model | tokens (in→out) | latency |
|-------|-------|-----------------|---------|
| analyze | nvidia/Qwen3.8-27B-NVFP4 | 5853 → 1014 | 60.9s |
| testplan | nvidia/Qwen3.8-27B-NVFP4 | 5503 → 5256 | 251.8s |
| **total** | | **11356 → 6270** | **~5.4 min** |

The testplan call is the expensive one (large spec + full plan synthesis).
Both outputs were valid against the zod schemas on the first attempt — no
reasoning-model `length`-retry was needed at `max_tokens: 8192`.

## What this run proves / does not prove

**Proves (real-model, real-app dimensions the hermetic harness can't reach):**
- The pipeline drives a real OpenAI-compatible endpoint (vLLM) and its
  `chat/completions` responses validate cleanly against the agent schemas.
- A real 27B reasoning model produces correct, well-structured JSON for
  analyze + testplan without retries.
- Execution runs a real app (Vite dev server, client-side React redirect)
  and captures real evidence; the redirect assertion is a true positive.
- The no-failure path is correct: triage/fixer/submit are clean no-ops.

**Does not exercise here (no seeded defect):**
- The fix loop (branch → patch → verify → commit → PR) — already proven by
  the hermetic `sample-app` dogfood (5/5 seeded bugs detected, fixed, and
  re-verified; `dogfood/reports/`). The cogniflow target simply had nothing
  to fix on the tested surface.

## Honest scope / observations

- **Plan count is 1.** With an empty diff (the dogfood runs on a clean
  `main`), the testplan agent produced a single baseline P0 plan rather than
  a broad sweep. That is the intended baseline behavior; a real PR-with-diff
  run would scope plans to the changed surface. This is a coverage note, not
  a defect — the loop's mechanics are what this dogfood targets.
- **Redirect target is cross-origin** (`:3000` auth portal). The
  `url_contains` assertion matches the path+query, so it passes regardless of
  the origin host; a stricter dogfood could assert the full URL. Left as-is
  to stay within the deterministic a11y/url executor's supported assert kinds.
- The app-shell had **no console errors and no failed network requests** in
  the captured HAR during this scenario — a clean baseline signal for the
  `:3008` product portal.

## Artifacts

- Run directory: `cfroot/cogniflow/.argus/runs/run-20261026-073303/`
  (plan, scenario evidence, `run.json`)
- State: `cfroot/cogniflow/.argus/state/*.jsonl` (runs, stages, scenarios,
  llm-calls)
- Plan: `cfroot/cogniflow/.argus/testplans/TP-001.md`

## Reproduce

```sh
# app-shell must be running on :3008 and vLLM serving on :8000
env -u ARGUS_GITHUB_TOKEN NO_COLOR=1 \
  node packages/argus-cli/dist/bin.js heal --repo <path-to-cogniflow>
```
