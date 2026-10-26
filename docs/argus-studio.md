# Argus Studio — Mission Control

Argus Studio is the web dashboard for Argus: a local, read-only mission-control
surface over every target repository's `.argus/` workspace. It answers the
questions a QE lead asks after handing work to Argus:

- **Which projects are I running Argus against, and how are they doing?** (Fleet)
- **What happened in the last run?** — per stage, per scenario, with evidence. (Run)
- **What did Argus find, what did it fix, and where is the PR?** (Bug drawer)
- **Is this test flaky?** — per-plan pass/fail history across runs.

Everything Argus writes to disk (state JSONL, run artifacts, test plans, bug
reports) is already the source of truth. Studio adds **no writes**: it renders
that state, and its only persistent state is the project registry (see below).

## Quick start

```sh
# from the main CLI (recommended)
argus studio                          # http://127.0.0.1:4900
argus studio --port 4901 --open       # custom port, open a browser
argus studio -P /path/to/repo         # one-off project (not persisted)

# or the standalone binary (same code)
argus-studio

# fleet management
argus studio add /path/to/repo        # register (needs a .argus/ inside)
argus studio add /path/to/repo --name myapp
argus studio list
argus studio remove myapp
```

The dashboard polls `/api/projects` every 4 seconds, so a run that starts while
the page is open appears live (the card pulses amber while `running`).

> Studio binds `127.0.0.1` by default. It can read arbitrary target-repo state
> (including console logs and network HARs), so it is a local tool. Use
> `--host 0.0.0.0` deliberately if you need remote access.

## Information architecture

```
Fleet (home)
└── one card per project
    ├── latest verdict chip + run head (short sha)
    ├── open-bug count, total plans
    ├── verdict sparkline (last ≤10 terminal runs, oldest → newest)
    └── last activity (relative timestamp)
Project
├── run history table (plans executed, failures, bugs per run — enriched
│   server-side so the table needs no second round-trip)
├── test plans (parsed frontmatter + narrative, status chips)
└── per-plan history (pass/fail across runs; verify re-runs excluded)
Run
├── 6-stage timeline (analyze → testplan → execute → triage → fixer → submit)
│   with per-stage duration, provider/model, prompt version
├── scenario table: expandable steps, console errors, network failures
├── evidence: screenshots, failure-step screenshots, video, trace, HAR,
│   console — in a lightbox, served from the run's own artifacts
├── analyze: changed files, diff, impact summary
└── LLM telemetry: per-call table + token/duration totals
Bug drawer (from anywhere a bug is listed)
├── severity chip, full bug report (evidence, violated contract, proposed fix)
└── fix record: branch, patch/commit message, PR status (pr_url or pending-local)
```

## Verdict model

Argus reports an **honest verdict** per run rather than a single green/red
light. The rules (implemented in `packages/argus-studio/src/data.ts`,
`verdictFor`) are:

| Verdict | When |
| --- | --- |
| `running` | the run row is still `running` (the loop is in flight) |
| `fail` | the run status is `failed` or `aborted` — the loop itself broke |
| `needs-attention` | the loop completed, but failures remain **or** bugs are still open (`new` / `confirmed` / `unverified`) |
| `pass` | completed, zero failures, no open bugs (`fixed` / `dismissed` bugs don't count) |

A completed run whose bugs are all still open is `needs-attention`, not
`pass` — the dashboard never claims success while the fix loop owes you
something.

## Project registry

Studio must know *which repositories* it monitors. That is a fleet-wide
setting, so the registry lives **outside** any single repo:

```
~/.config/argus/projects.json        (override: $ARGUS_STUDIO_HOME,
                                      or $XDG_CONFIG_HOME/argus/projects.json)
```

```json
{
  "version": 1,
  "projects": [
    { "name": "cogniflow", "path": "/abs/path/to/repo", "added_at": "2026-10-27T00:00:00Z" }
  ]
}
```

- `name` is a URL-safe slug: `^[a-z0-9][a-z0-9._-]{0,63}$` (it appears in API
  routes).
- `path` must contain a `.argus/` directory, or registration is refused.
- Writes are atomic (temp file + rename); a corrupt or unsupported-version
  file raises an explicit `RegistryError` instead of silently resetting.
- A registered path that later disappears is flagged `GONE` (in `list`) and
  dropped from the fleet cards, never an error.
- **One-off projects** (`-P/--project`) are slugged from the directory
  basename and used for this server instance only — never written to the
  registry.

## Data layer and tolerance

Studio reads the on-disk format produced by `@argus/core` (types imported
from core — no duplicated schemas). All reads are **tolerant**:

- state JSONL: a corrupt/partial trailing line is skipped, never fatal;
- run artifacts (`summary.json`, `impact.json`, `bug-report.json`, …): a
  missing or half-written file degrades that card to "unknown";
- test plans: each `.md` file is parsed and zod-validated independently — one
  broken plan never blanks the list;
- per-plan history excludes `<plan>-verify` re-runs, so the flakiness signal
  reflects actual plan outcomes only.

A dashboard should never be more dramatic than the data warrants: bad input
degrades to a defined unknown shape, not a 500.

## HTTP API

| Method & path | Purpose |
| --- | --- |
| `GET /api/health` | liveness + project count |
| `GET /api/projects` | fleet: one `ProjectSummary` per project (+ `plan_histories`) |
| `POST /api/projects` | `{ name, path }` → 201 `{ project }`; 400 on validation errors |
| `DELETE /api/projects/:name` | unregister |
| `GET /api/projects/:name` | project detail: summary, plans, per-plan histories, enriched runs (terminal runs get `plans_executed` / `failures` / `bug_count`), all bugs |
| `GET /api/projects/:name/runs/:runId` | full run bundle: stages, scenarios (steps, console/network errors, evidence flags, failed-step screenshot), bugs (report + PR record), LLM calls + totals, analyze (files/diff/impact), testplan output |
| `GET /api/projects/:name/runs/:runId/evidence?scenario=&file=` | artifact bytes (screenshot / fail-step / video / trace / HAR / console / bug report / PR record) |
| `GET /api/projects/:name/plans` | parsed plans |
| `*` | static host for `web/` with SPA fallback |

## Evidence access — security

The evidence route only ever serves a **whitelist** of filenames
(`EVIDENCE_NAMES` in `data.ts`: screenshots, the `fail-<step>.png` series,
video, trace, HAR, console, `result.json`, `bug-report.json`,
`pull-request.json`), and only from the named run's own scenario or bug
directory. Any `..`, absolute path, or non-whitelisted name is rejected with
400/404 before a single byte is read. The static host applies the same
prefix guard.

## UX notes

- **Live**: 4 s polling; in-progress runs pulse amber; relative timestamps.
- **PWA / taskbar pin**: `manifest.webmanifest` + the top-bar **Install**
  button (via `beforeinstallprompt`) pins Studio to your taskbar/dock; the
  Argus-eye favicon (`favicon.svg`) shows in the browser tab. Icons
  (`web/icons/icon-192.png`, `icon-512.png`) are generated by
  `scripts/make-icons.mjs` — a hand-rolled PNG encoder, no image tooling.
- **Service worker** (`web/sw.js`): network-first for `/api/*`,
  stale-while-revalidate for assets, precached app shell — the fleet view
  renders offline-ish on a flaky connection, but data is never stale by
  more than one poll when online.
- **Evidence lightbox** for screenshots/HAR/video, **bug drawer** for the
  fix story, **Esc** to close overlays, `prefers-reduced-motion` respected.
- Designed empty states (no projects yet → add form; no runs yet → hint) and
  explicit error states (project gone, unreadable state).

## Implementation notes

- Zero runtime dependencies beyond `@argus/core`: `node:http` server,
  hand-rolled ESM SPA (no build step for the frontend), no framework.
- `packages/argus-studio` builds to `dist/` (consumed by `@argus/cli`, which
  imports it **dynamically** — studio code stays out of every other `argus`
  command's startup path).
- Build order is core → studio → cli (root `npm run build`); studio tests
  fabricate a full `.argus/` workspace via `src/fixtures.ts` (state JSONL,
  run artifacts, valid + corrupt plans, bug + PR records) and exercise the
  server over real HTTP on an ephemeral port.
