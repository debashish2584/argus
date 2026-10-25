# Argus — Autonomous Self-Healing Quality Engineering Platform
## Architecture & Technical Specification

> **Project Name**: Argus (The All-Seeing Autonomous QE Agent)  
> **Status**: Draft Architecture Specification v1.0  
> **License Target**: Apache License 2.0 (Open Source)  
> **Scope**: Autonomous, closed-loop Quality Engineering platform that reads software specifications and git changes, synthesizes test plans, executes visual human-like end-to-end tests, tracks bugs, and autonomously creates verified pull requests with fixes.

---

## 1. Executive Vision & Philosophy

Modern software delivery struggles with a chronic QA bottleneck:
1. Product specs and API contracts evolve rapidly.
2. Manual QA engineers spend hours repeatedly executing manual exploratory and regression runs.
3. Automated test suites (Selenium, manual Playwright scripts) are brittle, require continuous manual maintenance, and fail when CSS selectors or layouts shift.
4. When regressions happen, bug reports are often incomplete, lacking network HAR traces, video evidence, or backend logs.

**Argus** establishes an **autonomous, closed-loop quality lifecycle**:
```
┌─────────────────┐       ┌─────────────────┐       ┌─────────────────┐
│  Spec & Diff    │ ───►  │ Test Generation │ ───►  │ Visual Human QA │
│  Understanding  │       │ & Test Matrix   │       │ Execution       │
└─────────────────┘       └─────────────────┘       └────────┬────────┘
                                                             │
                                                             ▼
┌─────────────────┐       ┌─────────────────┐       ┌─────────────────┐
│ Git Commit & PR │ ◄───  │ Autonomous Code │ ◄───  │ Triage, Video   │
│ Creation        │       │ Fix & Re-Verify │       │ & Bug Tracking  │
└─────────────────┘       └─────────────────┘       └─────────────────┘
```

---

## 2. The 6-Stage Autonomous Feedback Loop

### Stage 1: Spec & Change Analysis (The Test Architect)
- **Inputs**:
  - Git diff (`git diff HEAD~1` or between branches / commits).
  - Software specs (Markdown documents, Product Requirement Documents, Design Specs).
  - Frozen API contracts (OpenAPI 3.1 YAML/JSON, gRPC Proto, GraphQL schemas).
  - Authorization models (OpenFGA models, OPA Rego policies).
- **Core Engine**:
  - Determines affected application surfaces, public endpoints, and UI routes.
  - Formulates a delta-aware testing strategy: distinguishes between newly added features and existing flows that risk regression.

### Stage 2: Test Plan & Matrix Synthesis
- **Core Engine**:
  - Synthesizes user stories and journeys covering:
    1. **Happy Paths**: Core user conversion funnels.
    2. **Edge Cases**: Rate-limits, network drops, malformed payloads.
    3. **Capability / Security Boundaries**: ReBAC roles (e.g. Primary Parent vs. Guardian permissions), token expiration, session idle timeouts.
- **Persistence (Git-Native Test Management)**:
  - Formats test cases as structured Markdown with YAML frontmatter.
  - Stores test plans directly inside `.argus/testplans/` in the repository so tests are versioned in Git alongside application code.

### Stage 3: Visual Human-Like Browser Execution (The Autonomous QA Persona)
- **Browser Automation Core**: Playwright (open-source, Apache 2.0).
- **Hybrid Visual Intelligence**:
  - Combines Playwright's Accessibility (a11y) tree (`role`, `aria-label`, test-ids) with Vision Models (multimodal visual reasoning).
  - Interacts like a real human: navigates across tabs, fills inputs, clicks buttons, scrolls, checks for toast notifications, and observes visual animations.
  - Self-healing: if element classes or DOM structure change, the vision layer inspects screenshots to identify the correct target without failing.
- **Multi-App & Cross-Origin Orchestration**:
  - Can orchestrate complex cross-origin journeys (e.g. logging into Portal A at `:3000` and validating redirection to Portal B at `:3008`).
- **Telemetry Capture**:
  - Automatically captures high-definition `.webm` video recording, Playwright trace zip (`trace.zip`), network HAR, and browser console warnings/errors.

### Stage 4: Triage, Scoring & Bug Tracking
- **Automated Root-Cause Correlation**:
  - When an assertion or flow fails, correlates:
    1. Visual failure screenshot + video timestamp.
    2. Client-side console errors.
    3. Network request/response failure (RFC 9457 problem details, 4xx/5xx responses).
    4. Backend service container logs.
- **Deduplication & Prioritization**:
  - Classifies severity: `P0-Blocker`, `P1-High`, `P2-Medium`, `P3-Low`.
  - Queries local historical database (`.argus/state.db`) to identify regressions vs. recurring flaky tests.
- **Issue Creation & Notification**:
  - Stores local bug diagnostics in `.argus/runs/<run_id>/bugs/<bug_id>/`.
  - Pluggable tracker integration: Default GitHub Issues (`gh issue create`) or Linear / Jira / GitLab.
  - Dispatches human review summary (Markdown digest and email notifications).

### Stage 5: Autonomous Code Repair (The SWE Fixer)
- **Isolation Principle**:
  - Creates a dedicated git branch: `fix/argus-<bug-id>`.
  - Feeds the bug report, failed assertion, video timestamp, and relevant source code to a coding LLM.
- **Strict Invariant Guard**:
  - **The Fixer cannot modify test assertions, OpenAPI specs, or test plans** (prevents cheating).
  - The Fixer is restricted to application source code edits only.
- **Verification Gate**:
  - Re-executes the targeted failing test and the full regression suite.
  - All tests must pass cleanly.

### Stage 6: Push & Pull Request Submission
- Commits the verified code fix with detailed explanation citing the failing test case ID and root-cause fix.
- Pushes the branch to remote and opens a Pull Request with linked issue, trace video, and before/after verification logs for human sign-off.

---

## 3. Storage Architecture: Git-Native Core + Pluggable Sync

Argus avoids mandatory paid SaaS subscriptions. It operates directly inside a local repository by default:

```
repo-root/
└── .argus/
    ├── config.yaml               # Engine configuration & tracker settings
    ├── state.db                  # Local SQLite run history & flakiness analytics
    ├── testplans/                # Version-controlled Test Plans (Git-native)
    │   ├── TP-001-auth-signin.md
    │   ├── TP-002-rebac-guard.md
    │   └── TP-003-session-idle.md
    └── runs/                     # Execution runs & media artifacts
        └── run-20261025-215000/
            ├── summary.json
            ├── trace.zip
            ├── video.webm
            └── bugs/
                └── BUG-001/
                    ├── bug-report.md
                    ├── failure-screenshot.png
                    └── diff-proposal.patch
```

### Storage Components & Rationale

| Component | Technology | Rationale & Properties |
| :--- | :--- | :--- |
| **Test Case Store** | **Markdown with YAML Frontmatter** | Git-versioned, lives directly with code branches, human-readable, AI-native. |
| **Execution State & Metrics** | **SQLite (`.argus/state.db`)** | Embedded, zero-setup, lightning-fast queries for test history, flakiness, and run timings. |
| **Media & Trace Capture** | **Local Disk / S3 / MinIO** | Captures Playwright `.webm` videos, `.zip` traces, and network HAR archives. |
| **Issue Tracking (Default)** | **GitHub Issues (via `gh` CLI / API)** | Direct integration where developers live. Issues automatically link to auto-fix branches. |
| **Issue Tracking (Adapters)** | **Linear / Jira / GitLab / Markdown** | Pluggable interface via `.argus/config.yaml`. |

---

## 4. Test Plan & Bug Schema

### 4.1 Test Plan Format (`.argus/testplans/TP-xxx.md`)

```yaml
---
id: TP-003
title: 30-Minute Inactivity Warning & Forced Logout
module: app-shell
priority: P0
status: ACTIVE
spec_ref: docs/architecture/app-shell-platform-architecture.md#L84-L134
tags: [security, session, idle-guard]
created_at: 2026-10-25T21:50:00Z
---

# Test Narrative & Invariants
Verify that an authenticated adult session on port :3008 enforces the 30-minute idle policy and displays an accessible modal before termination.

## Preconditions
- Auth Portal running on http://localhost:3000
- AppShell running on http://localhost:3008
- Valid adult credentials for David Miller

## Journey Steps
1. Navigate to `http://localhost:3000/signin`.
2. Authenticate with email `david.miller@example.com` and valid password.
3. Assert browser redirects to `http://localhost:3008/#session_token=...&return_to=/family`.
4. Assert `#session_token` is synchronously stripped from the address bar before initial render.
5. Simulate 30 minutes of idle inactivity (advance browser wall-clock).
6. Assert modal dialog appears with `role="dialog"`, `aria-modal="true"`, and countdown timer.
7. Assert focus is trapped inside the modal on "Stay Signed In".
8. Wait for countdown expiry (120s) -> Assert storage cleared and redirected to `:3000/signin?reason=idle_timeout`.
```

### 4.2 Bug Report Format (`.argus/runs/<id>/bugs/BUG-xxx/bug-report.md`)

```markdown
# [BUG-001] [P0-Blocker] Hash token not stripped on initial AppShell mount

- **Test Plan Ref**: `TP-003`
- **Execution Run**: `run-20261025-215000`
- **Component**: `modules/frontend/app-shell/src/App.tsx`
- **Severity**: P0-Blocker (Security / Credential Exposure)

## Description
During visual E2E execution, the browser redirected from `:3000/signin` to `:3008/#session_token=eyJhbGci...`.
The address bar retained `#session_token=...` after React component mount.

## Evidence
- **Screenshot**: `failure-screenshot.png`
- **Video Replay**: `video.webm` (timestamp: 00:04)
- **Console Log**: No error logged.
- **Violated Contract**: `docs/architecture/app-shell-platform-architecture.md#L78`

## Proposed Fix
Apply synchronous `window.history.replaceState(null, '', location.pathname + location.search)` prior to component state initialization.
```

---

## 5. Security & Invariance Safeguards

To prevent automated chaos, Argus enforces strict operational boundaries:

1. **Test Invariance Principle**:
   - The Auto-Repair Agent has read-only access to `.argus/testplans/` and OpenAPI specifications. It cannot alter tests to force green builds.
2. **Deterministic E2E First, Visual Fallback**:
   - Uses deterministic selectors (accessibility roles, labels, and test IDs) first. Multimodal vision models are only used when selectors fail or for visual assertion validation (preventing high inference latency and LLM token costs).
3. **Branch Protection & Human-in-the-Loop**:
   - Auto-repair code is **never pushed directly to `main`**. It is always pushed to a feature branch (`fix/argus-...`) and submitted as a Pull Request for human review.
4. **Data Privacy**:
   - When running tests, Argus scrubs sensitive PII (passwords, JWT payloads, phone numbers) from log outputs and bug report markdowns.

---

## 6. Project Roadmap

- **Phase 1: Local CLI & Runner (`argus-cli`)**:
  - Core CLI: `argus init`, `argus plan`, `argus run`.
  - Local SQLite execution logging and Markdown testplan generation.
  - Playwright test runner harness.
- **Phase 2: Visual AI Persona (`argus-vision`)**:
  - Integration with Stagehand / Multimodal LLMs for visual human-like journey execution.
  - Automated video and trace capture on failure.
- **Phase 3: Automated Triage & Auto-Fixer (`argus-heal`)**:
  - Closed-loop SWE repair agent capable of fixing UI/API regressions, re-running test suites, and opening Pull Requests.
- **Phase 4: Open Source Release & Ecosystem Integrations**:
  - GitHub Actions reusable workflow (`action-argus`).
  - Adapters for Linear, Jira, and Slack/Discord notifications.
