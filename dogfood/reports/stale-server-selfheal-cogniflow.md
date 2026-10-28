# Argus dogfood — Stale-server self-heal, live progress, server logging

Date: 2026-10-28
Target: `cfroot/cogniflow` → product portal on `:3008` (app running)
Studio: live server on `127.0.0.1:4900` (registry `~/.config/argus`)

> This dogfood verifies the fix for the reported incident **"Plan / Run /
> Auto-run buttons return 404 `no such API route`"**, and the two features added
> with it: (1) the launcher now **detects and restarts a stale server** so a
> taskbar click self-heals after any code change, and (2) the project view shows
> **live progress** (stage chips, % bar, log tail) while a run is in flight.
> Every step below was performed against the real `:4900` server — the same
> server the taskbar icon talks to.

**Verdict: PASS** — the stale server was detected and restarted by the launcher
itself, the new routes serve correctly, and a button-equivalent `run`
(`POST /api/projects/cogniflow/pipeline`) completed with live progress
streaming from the progress endpoint.

## The incident

- The live `:4900` server (pid `378229`, started **Oct 27 21:43**) predated the
  pipeline-trigger code, so its in-memory route table had no `/pipeline` routes.
- The SPA, however, is served **fresh from disk** on every request — so the
  dashboard showed the new Plan / Run / Auto-run buttons while the server
  answered `{"error":"no such API route"}`:

```sh
$ curl -s -X POST http://127.0.0.1:4900/api/projects/cogniflow/pipeline \
    -H 'content-type: application/json' -d '{"action":"plan"}'
{"error":"no such API route"}

$ curl -s http://127.0.0.1:4900/api/health
{"ok":true,"version":"0.1.0","projects":1}   # no build_id — pre-fingerprint build
```

- Root cause class: **in-memory server state (routes, active-run map) frozen at
  a pre-update code version, while static assets are always current.** The old
  launcher only health-checked — it never restarted after an update.

## The fix, as shipped

1. **Build fingerprint** (`packages/argus-studio/src/build.ts`): `buildId()`
   hashes the `dist/` runtime JS (excluding `*.test.js`) plus the served SPA
   assets (`app.js`, `studio.css`, `index.html`, `manifest.webmanifest`) to a
   12-char id. `GET /api/health` now reports it.
2. **Launcher decision** (`argus studio open`, `decideLaunch`):
   healthy + same id → open browser; healthy + different/missing id → **stop
   the old server and start a fresh one**; nothing healthy → start.
   `stopServer` SIGTERMs the pid from `studio.pid`, then falls back to a
   `/proc/net/tcp` socket-inode scan (covers servers started by hand) and
   SIGKILLs the actual listener.
3. **Progress endpoint** `GET /api/projects/:name/runs/:runId/progress`:
   ordered stage track from the run record, per-stage status from the
   append-only `stages.jsonl` (`pending`/`running`/`done`/`skipped`),
   `progress` 0..1, `elapsed_ms`, and a tail of the per-run trigger log. Reads
   only `runs.jsonl` + `stages.jsonl` + the log — cheap for a 2 s poll.
4. **Progress panel** (SPA): while `active_run` is set, the pipeline bar becomes
   a panel (stage chips, % bar, elapsed, log tail) polled every 2 s and
   repainted in place; triggers navigate to the project view so it's visible.
5. **Server logging**: startup (address, build id, registry, web root), every
   trigger/stop/fix, spawn errors, child exit codes, and every 5xx — timestamped
   to stdout (i.e. `~/.config/argus/studio.log` for the daemon).

## The self-heal, live

Running the exact taskbar-entry command against the stale server:

```sh
$ node packages/argus-cli/dist/bin.js studio open
Argus Studio on :4900 is running stale code (server build unknown,
  installed build 7e9fe5b62f64) — restarting it to pick up the new build…
  old server stopped.
✓ Argus Studio started at http://127.0.0.1:4900 (build 7e9fe5b62f64)
  pid 1587864 (stop with: kill $(cat /home/debashish/.config/argus/studio.pid))
```

Before/after:

| | before | after |
|---|--------|-------|
| pid | `378229` (Oct 27 21:43) | `1587864` |
| `GET /api/health` | `{"ok":true,"version":"0.1.0","projects":1}` | `{"ok":true,"version":"0.1.0","build_id":"7e9fe5b62f64","projects":1}` |
| `POST …/pipeline` (bad action) | `404 {"error":"no such API route"}` | `400 {"error":"action must be one of: plan, run, auto-run"}` — route exists and validates |

The old process was SIGTERMed via `studio.pid`; the port released cleanly and
the fresh server bound it. The launcher then opened the browser (as a taskbar
click would).

## Live progress, on a real run

The button-equivalent trigger (`run` → execute + triage, LLM-free):

```json
{"action":"run","run_id":"run-20261028-083717","pid":1589013,
 "started_at":"2026-10-28T03:07:17.015Z",
 "log_file":"/home/debashish/.config/argus/run-logs/cogniflow-run-20261028-083717.log"}
```

Sampling `GET …/runs/run-20261028-083717/progress` every 3 s (what the panel
polls):

| t | status | progress | stages | log tail (last line) |
|---|--------|----------|--------|----------------------|
| +2.7s | running | 0 | execute **running**, triage pending | `executing 1 plan(s)…` |
| +5.7s | running | 0 | execute **running**, triage pending | `executing 1 plan(s)…` |
| +8.7s | running | 0 | execute **running**, triage pending | `executing 1 plan(s)…` |
| done  | completed | 1 | execute done (10549ms), triage skipped (0ms) | `run run-20261028-083717: completed` |

The plan `TP-001` (the app-shell redirect contract) **passed** in 10.5 s —
1 executed, 0 failed, 0 LLM calls (execute is LLM-free by design).

Server log for the same run:

```
[2026-10-28T03:07:17.015Z] pipeline: run triggered for 'cogniflow' → run run-20261028-083717 (pid 1589013, log /home/debashish/.config/argus/run-logs/cogniflow-run-20261028-083717.log)
[2026-10-28T03:07:27.932Z] trigger run run-20261028-083717: exited (code 0)
```

## What this run proves / does not prove

**Proves:**
- The reported incident's root cause (stale in-memory server vs fresh SPA) is
  fixed: the launcher detects the build mismatch and self-heals with no
  manual intervention — the taskbar click path now survives any update.
- The progress endpoint streams truthful stage state from the append-only state
  files while a real run is in flight, and settles to 100% on completion.
- Server-side logging covers startup, triggers, and exits in
  `~/.config/argus/studio.log`.

**Does not exercise here:**
- The UI panel itself (DOM-level polling/repaint) — verified by code review +
  the endpoint contract above; a manual browser click is the remaining
  confirmation for the user.
- Fix + verify + PR (no open bugs on cogniflow; proven by the sample-app
  dogfood).

## Tests

Full suite green after the change: **217 tests** (core 88, studio 100, cli 29),
including new coverage for `buildId`, `runProgress`, the progress endpoint,
`/api/health` `build_id`, and the launcher (`decideLaunch`, `getHealth`,
`stopServer` incl. the `/proc` fallback, `findPortListener`).

## Artifacts

- Run directory: `cfroot/cogniflow/.argus/runs/run-20261028-083717/`
- State: `cfroot/cogniflow/.argus/state/*.jsonl`
- Per-run log: `~/.config/argus/run-logs/cogniflow-run-20261028-083717.log`
- Server log: `~/.config/argus/studio.log`
