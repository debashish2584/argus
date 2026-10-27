# Argus

**The all-seeing autonomous quality engineering agent.**

Argus reads your software specifications and git changes, synthesizes test
plans, executes human-like end-to-end browser tests, triages failures with
full evidence (video, traces, HAR, console, backend logs), autonomously
creates verified fixes, and submits pull requests for human sign-off.

```
┌──────────────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│  Analyze     │ → │  Test Plan   │ → │  Execute     │ → │  Triage      │
│ spec + diff  │   │ synthesis    │   │ browser E2E  │   │ + bug report │
└──────────────┘   └──────────────┘   └──────────────┘   └──────┬───────┘
                                                               │
┌──────────────┐   ┌──────────────┐                            │
│  Submit PR   │ ← │  Fix &       │ ←──────────────────────────┘
│ (human sign) │   │  re-verify   │
└──────────────┘   └──────────────┘
```

> **Status: MVP in development.**
>
> - 📄 [Architecture & Technical Specification](./docs/architecture-and-specification.md)
> - 📄 [Agent Architecture & Configuration Model](./docs/agent-architecture-and-configuration.md)
> - 📄 [Argus Studio — mission control dashboard](./docs/argus-studio.md)
> - 📄 [Post-MVP Roadmap](./docs/post-mvp-roadmap.md) — sandbox pool, parallel
>   execution, and vision are designed and deliberately out of MVP scope.

## The principles Argus is built on

1. **High quality** — strict types, schema-validated inputs, tests, docs.
2. **Fully open source** — Apache-2.0; no vendor lock-in; no telemetry.
3. **PR discipline** — nothing touches `main` without review. Argus itself
   never pushes fixes directly: verified fixes land as pull requests.
4. **Small core, swappable adapters** — LLM providers, sources, trackers,
   and report sinks are adapters behind stable interfaces.
5. **Determinism first** — deterministic a11y-selector execution; LLM/vision
   only as the escalation path.
6. **Evidence always** — every failure ships an artifact bundle; every run is
   reproducible (model + prompt version + config hash are recorded).
7. **The tool respects the target** — the fixer follows the target repo's own
   engineering standards and is mechanically barred from touching tests,
   specs, and config.
8. **Secrets by reference** — `${ENV}` only; redaction on all outbound text.
9. **Honest scope** — cuts are documented in the roadmap, not forgotten.
10. **Leave the tree green** — every commit compiles and passes tests.
11. **Keep documenting** — docs change in the same commit as behavior.

## Repository layout

```
argus/
├── .github/workflows/     # CI: tests + hermetic dogfood gate
├── docs/                  # specifications, architecture, roadmap
├── packages/
│   ├── argus-core/        # agent runtime, adapters, storage, harness
│   ├── argus-studio/      # mission-control web dashboard (server + SPA)
│   └── argus-cli/         # the `argus` command
├── dogfood/               # hermetic closed-loop harness (sample app + scripted LLM)
├── LICENSE                # Apache-2.0
└── README.md
```

## Quickstart

Node.js ≥ 20, npm workspaces.

```sh
npm install
npm run build
npm test                      # unit + integration (both workspaces)
npx playwright install chromium
```

Point `argus` at a target repository that has a spec and a running app:

```sh
argus init --repo /path/to/target     # scaffold .argus/config.yaml
# edit .argus/config.yaml: llm provider/base_url/model, target.env, …

argus plan  --repo /path/to/target     # analyze the diff → draft test plans
argus run   --repo /path/to/target     # execute plans → triage failures
argus heal  --repo /path/to/target     # full loop: … → fix → verify → PR
```

`plan`/`run`/`heal` are slices of the same six-stage pipeline — see
[docs/agent-architecture-and-configuration.md](./docs/agent-architecture-and-configuration.md)
for the agent model, config reference, and gate semantics. PRs are opened only
when `ARGUS_GITHUB_TOKEN` is set; otherwise verified fixes are staged locally
on `argus/BUG-NNN` branches with a `pending-local` PR record.

### Watching it work: Argus Studio

Studio is a local mission-control dashboard over any number of target
repositories — fleet cards with verdicts and sparklines, run history, a
6-stage timeline per run, evidence lightbox (screenshots, video, HAR,
console), per-plan flakiness history, and the full bug → fix → PR story.
It's a read-only viewer: the `.argus/` workspace is the source of truth.

```sh
argus studio                    # http://127.0.0.1:4900
argus studio open               # launcher: start the server if it isn't running, then open the dashboard
argus studio -P /path/to/repo   # one-off project (not persisted)
argus studio add /path/to/repo  # register a project in the fleet
```

`argus studio open` is what a pinned taskbar/dock icon runs — the whole
"click → dashboard" flow, idempotent and daemon-managed. See
[docs/argus-studio.md](./docs/argus-studio.md) for the verdict model, API,
registry format, evidence-security notes, and the native taskbar pin.

## Hermetic dogfood

`dogfood/` drives the full closed loop against a seeded sample app with a
scripted LLM — no keys, no network beyond `127.0.0.1`:

```sh
node dogfood/selftest.mjs     # fast harness self-test (no browser)
node dogfood/run.mjs          # full closed loop; exit 0 = acceptance bar met
```

This is also the CI gate (`.github/workflows/ci.yml`); each run writes a
report to `dogfood/reports/`. See [dogfood/README.md](./dogfood/README.md).

## License

[Apache License 2.0](./LICENSE)
