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
├── docs/                  # specifications, architecture, roadmap
├── packages/
│   ├── argus-core/        # agent runtime, adapters, storage, harness
│   └── argus-cli/         # the `argus` command
├── dogfood/               # self-contained sample app with seeded bugs
├── LICENSE                # Apache-2.0
└── README.md
```

## Development

Node.js ≥ 20, npm workspaces.

```sh
npm install
npm run build
npm test
```

## License

[Apache License 2.0](./LICENSE)
