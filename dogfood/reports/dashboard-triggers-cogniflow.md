# Argus dogfood — Dashboard pipeline triggers (real LLM, real app, real browser)

Date: 2026-10-28
Target: `cfroot/cogniflow` → `modules/frontend/app-shell/` (product portal on `:3008`)
LLM: `nvidia/Qwen3.8-27B-NVFP4` served by local **vLLM** at `http://localhost:8000/v1`
App: app-shell Vite dev server running on `127.0.0.1:3008`
GitHub: **no token** → any fix would have been staged locally (none needed)

> This dogfood exercises the **new dashboard pipeline triggers** — the
> Plan / Run / Auto-run buttons and the opt-in Fix action on the Project view.
> The runs below were started **from the browser-facing HTTP endpoints**
> (`POST /api/projects/cogniflow/pipeline`), not from the terminal — the literal
> "click a button" path. The value here is proving the closed loop works when
> driven by the Studio server spawning the built CLI as a tracked child, with
> the same gates, artifacts, and evidence as a terminal run.

**Verdict: PASS** — two button-triggered runs completed against a real LLM and
a real app: an `auto-run` (analyze + testplan) and a `run` (execute in the real
browser, full evidence). The one active-run guard, the loopback-only gate, and
the `active_run`/coverage projections all behaved correctly.

## How it was run

```sh
# 1. fresh Studio server on a spare port (the running :4900 was pre-trigger code)
node packages/argus-cli/dist/bin.js studio --port 4910

# 2. Auto-run button  →  POST /api/projects/cogniflow/pipeline  { action: "auto-run" }
#    spawns: argus auto-run --yes --activate --run-id run-20261028-034105
#    (analyze + testplan + execute + triage)

# 3. baseline plan TP-001 approved DRAFT → ACTIVE (the human "approve" step)
#    via the built core PlanStore.write({ ...plan, status: "ACTIVE" })

# 4. Run button  →  POST /api/projects/cogniflow/pipeline  { action: "run" }
#    spawns: argus run --yes --run-id run-20261028-034541
#    (execute all ACTIVE plans + triage)
```

Trigger response (the 202 the UI toasts and then polls):

```json
{ "action": "auto-run",
  "run_id": "run-20261028-034105",
  "pid": 1049090,
  "started_at": "2026-10-27T22:11:05.918Z",
  "log_file": "/home/debashish/.config/argus/run-logs/cogniflow-run-20261028-034105.log" }
```

## Run 1 — `auto-run` (`run-20261028-034105`)

| stage | status | duration | detail |
|-------|--------|----------|--------|
| analyze | ok | 41s | 0 changed files, 1 spec → impact over the app-shell contract |
| testplan | ok | 56s | **0 plans created** — no-duplication rule (see below), gate `auto` |
| execute | skipped | 0ms | no ACTIVE plan and no plan created this run |
| triage | skipped | 0ms | no failures to triage |

`run.jsonl` status: **completed**. LLM-only (analyze + testplan); execute/triage
never ran because there was nothing ACTIVE to execute.

### Why testplan created 0 plans (correct, not a defect)

The empty-diff impact report's only `test_focus` item — "verify an
unauthenticated app shell redirects to the auth portal" — is **already covered
by existing plan `TP-001`** (steps `open-shell` → `wait-redirect` →
`redirected`). The testplan agent applied the no-duplication rule and returned
`created: []` with an explicit note:

> "…explicitly covered by existing plan TP-001 … Per the no-duplication rule,
> no new plan is created for it. All other spec behaviors … are outside the
> impact scope … so they are intentionally not tested in this run."

This is the intended impact-aware behavior: don't re-create a plan for a
surface that already has one. It surfaced one lifecycle fact — `TP-001` was
`DRAFT`, and the `run` stage only executes `ACTIVE + createdThisRun`, so with
the baseline plan un-approved, `auto-run` had nothing to execute. That is why
the second, explicit `run` below is what produced the browser execution.

## Run 2 — `run` (`run-20261028-034541`)

After approving `TP-001` to `ACTIVE` (the human plan-approval step), the
**Run** button executed it in the real browser:

| stage | status | duration | detail |
|-------|--------|----------|--------|
| execute | ok | 11s | **1 executed, 0 failed** (health `:3008/` → 200 first) |
| triage | skipped | 0ms | no failures to triage |

`run.jsonl` status: **completed**. **0 LLM calls** — the execute stage is
100% LLM-free by design; the deterministic Playwright harness runs the plan.

### The plan executed (TP-001, `app-shell`, P0)

```
open-shell    navigate http://localhost:3008/        ✓ (117ms)
wait-redirect wait   (10s budget for the client-side redirect)  ✓ (10002ms)
redirected    assert url_contains "/signin?reason=auth_required"  ✓ (0ms)
```

**Result: PASS** in 10.6s — same true-positive contract as the earlier
`heal`-based dogfood (the app-shell token guard ejects an unauthenticated
visitor to the auth portal).

## What the trigger machinery itself proved

- **Tracked child + `active_run`.** While Run 1 was in flight,
  `GET /api/projects/cogniflow` returned
  `active_run: { action: "auto-run", run_id: "…034105", pid: 1049090, … }`;
  it cleared to `null` on the child's `exit`.
- **One active run per project.** A second trigger fired while Run 1 was active
  returned **409** (already running) — the guard that prevents concurrent runs
  on a repo.
- **Loopback-only gate.** The trigger/stop/fix endpoints reject any
  non-loopback peer with 403; a local request cleared the gate (reaching the
  409/202 path), so the gate is not blocking legitimate local use.
- **Per-run log.** Each trigger wrote
  `run-logs/<project>-<runId>.log` next to the registry, capturing the exact
  argv, cwd, and stage output shown above.
- **Coverage projection.** `coverage` was `null` for both runs — honest,
  because the empty-diff impact report lists zero affected modules. (The chip
  would read `m/n` on a run with a real diff.)

## Evidence captured (per scenario, `scenarios/TP-001/`, Run 2)

| file | present |
|------|---------|
| `result.json` | ✓ (status `pass`, 3/3 steps) |
| `video.webm` | ✓ (1.5 MB) |
| `trace.zip` | ✓ (657 KB) |
| `network.har` | ✓ (80 KB, all 200) |
| `console.log` | ✓ (empty — no console errors) |
| `screenshot.png` | ✓ (657 KB, final state after redirect) |

`has_evidence`: `{ screenshot, video, trace, har, console: all true }`,
`console_errors: []`, `network_failures: []`. The screenshot served through
`GET …/evidence?scenario=TP-001&file=screenshot.png` as `200 image/png`.

## LLM telemetry (Run 1 — the only LLM-bearing run)

Recorded in `.argus/state/llm-calls.jsonl`:

| agent | model | tokens (in→out) | latency |
|-------|-------|-----------------|---------|
| analyze | nvidia/Qwen3.8-27B-NVFP4 | 5875 → 596 | 41s |
| testplan | nvidia/Qwen3.8-27B-NVFP4 | 5519 → 1148 | 56s |
| **total** | | **11394 → 1744** | **~96s** |

Both outputs validated against the agent schemas on the first attempt.

## What this run proves / does not prove

**Proves (the dashboard-trigger dimensions):**
- The Studio server spawns the built CLI as a tracked child and the closed loop
  completes with the same artifacts/evidence as a terminal run.
- The one-active-run guard (409), the loopback-only gate, and the
  `active_run`/coverage projections all behave as designed.
- Real-model analyze + testplan still produce schema-valid JSON when driven
  through the button path; the real-app browser execution still passes.

**Does not exercise here (no seeded defect, no open bugs):**
- The opt-in **Fix + verify + PR** action — it only appears on a completed run
  with open bugs. cogniflow had none, so the button was never shown. The fix
  loop itself is proven by the hermetic `sample-app` dogfood.

## Artifacts

- Run directories: `cfroot/cogniflow/.argus/runs/run-20261028-034105/` and
  `…/run-20261028-034541/`
- State: `cfroot/cogniflow/.argus/state/*.jsonl` (runs, stages, scenarios,
  llm-calls)
- Per-trigger logs: `~/.config/argus/run-logs/cogniflow-run-20261028-*.log`
