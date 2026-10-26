#!/usr/bin/env node
/**
 * Scripted OpenAI-compatible LLM for the hermetic Argus dogfood.
 *
 * Serves POST /v1/chat/completions and answers each agent's prompt with a
 * canned response that matches the agent's zod schema exactly. Dispatch is
 * on the rendered prompt content, never on request order:
 *
 *   system prompt contains          canned response
 *   ------------------------------  ------------------------------------
 *   "ANALYZE agent"                 impact report (all surfaces)
 *   "TEST PLAN agent"               6 plans (5 map to seeded bugs, 1 control)
 *   "TRIAGE agent" + plan title     bug report for that plan
 *   "FIXER agent" + bug title       minimal patch fixing the seeded defect
 *   "SUBMIT agent" + bug id/title   PR content (commit msg, title, body)
 *
 * The patches are byte-exact unified diffs against the seeded sample-app
 * files, so `git apply` succeeds and re-running the failing plan passes.
 *
 * Zero dependencies. Usage: PORT=4321 node dogfood/scripted-llm.mjs
 */
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT ?? 4321);

/** The spec-required hero copy — byte-identical to docs/spec.md section 1. */
const HERO_COPY = "Start free — no credit card";

/* ------------------------------------------------------------------ */
/* Stage 1 — analyze                                                    */
/* ------------------------------------------------------------------ */

export const IMPACT = {
  summary:
    "Baseline coverage review of the SampleApp static site: landing, features, pricing, navigation, checkout, and about surfaces.",
  affected: [
    {
      module: "landing",
      files: ["public/index.html"],
      risk: "medium",
      why: "Hero copy is the user-facing value proposition.",
    },
    {
      module: "features",
      files: ["public/features.html"],
      risk: "medium",
      why: "The free-trial CTA is the primary conversion entry.",
    },
    {
      module: "pricing",
      files: ["public/pricing.html"],
      risk: "medium",
      why: "Plan prices are user-facing data.",
    },
    {
      module: "navigation",
      files: ["public/js/nav.js"],
      risk: "medium",
      why: "Primary navigation reaches every page.",
    },
    {
      module: "checkout",
      files: ["public/checkout.html", "public/js/checkout.js"],
      risk: "high",
      why: "Order confirmation is the primary transactional flow.",
    },
  ],
  test_focus: [
    `Landing hero reads '${HERO_COPY}' (spec section 1)`,
    "Features page renders the free-trial CTA with testid free-trial-cta (spec section 2)",
    "Pricing page lists the Pro plan at $9/mo (spec section 3)",
    "Primary navigation reaches /about.html from the About link (spec section 4)",
    "Checkout: clicking Place order shows 'Order received' (spec section 5)",
    "About page renders its title and content",
  ],
};

/* ------------------------------------------------------------------ */
/* Stage 2 — testplan                                                   */
/* ------------------------------------------------------------------ */

export const PLANS = {
  plans: [
    {
      id: "TP-001",
      title: "Landing page shows the hero promise",
      module: "landing",
      priority: "P1",
      status: "DRAFT",
      spec_ref: "docs/spec.md#section-1",
      tags: ["landing"],
      preconditions: ["SampleApp served at {{APP_URL}}"],
      narrative:
        "Loads the landing page and verifies the hero copy matches section 1 of the spec.",
      steps: [
        { id: "open-landing", action: "navigate", url: "{{APP_URL}}/" },
        { id: "hero-copy", action: "assert", kind: "text_contains", value: HERO_COPY },
      ],
    },
    {
      id: "TP-002",
      title: "Features page renders the free-trial call-to-action",
      module: "features",
      priority: "P1",
      status: "DRAFT",
      spec_ref: "docs/spec.md#section-2",
      tags: ["features", "conversion"],
      preconditions: ["SampleApp served at {{APP_URL}}"],
      narrative:
        "Loads the features page and verifies the free-trial CTA documented in spec section 2 is present.",
      steps: [
        { id: "open-features", action: "navigate", url: "{{APP_URL}}/features.html" },
        {
          id: "cta-visible",
          action: "assert",
          kind: "visible",
          target: { testid: "free-trial-cta" },
        },
      ],
    },
    {
      id: "TP-003",
      title: "Pricing page lists the correct Pro plan price",
      module: "pricing",
      priority: "P2",
      status: "DRAFT",
      spec_ref: "docs/spec.md#section-3",
      tags: ["pricing"],
      preconditions: ["SampleApp served at {{APP_URL}}"],
      narrative:
        "Loads the pricing page and verifies the Pro plan price matches section 3 of the spec.",
      steps: [
        { id: "open-pricing", action: "navigate", url: "{{APP_URL}}/pricing.html" },
        { id: "pro-price", action: "assert", kind: "text_contains", value: "$9/mo" },
      ],
    },
    {
      id: "TP-004",
      title: "Navigation reaches the About page",
      module: "navigation",
      priority: "P2",
      status: "DRAFT",
      spec_ref: "docs/spec.md#section-4",
      tags: ["navigation"],
      preconditions: ["SampleApp served at {{APP_URL}}"],
      narrative:
        "From the landing page, follows the About entry in the primary navigation and verifies the URL reaches /about.html.",
      steps: [
        { id: "open-landing", action: "navigate", url: "{{APP_URL}}/" },
        { id: "click-about", action: "click", target: { role: "link", name: "About" } },
        { id: "on-about", action: "assert", kind: "url_contains", value: "/about.html" },
      ],
    },
    {
      id: "TP-005",
      title: "Checkout places an order and shows confirmation",
      module: "checkout",
      priority: "P0",
      status: "DRAFT",
      spec_ref: "docs/spec.md#section-5",
      tags: ["checkout", "transactional"],
      preconditions: ["SampleApp served at {{APP_URL}}"],
      narrative:
        "Enters an email on the checkout page, places the order, and verifies the 'Order received' confirmation appears.",
      steps: [
        { id: "open-checkout", action: "navigate", url: "{{APP_URL}}/checkout.html" },
        {
          id: "enter-email",
          action: "fill",
          target: { role: "textbox", name: "Email" },
          value: "qa@sampleapp.dev",
        },
        { id: "place-order", action: "click", target: { role: "button", name: "Place order" } },
        {
          id: "order-confirmed",
          action: "assert",
          kind: "text_contains",
          value: "Order received",
        },
      ],
    },
    {
      id: "TP-006",
      title: "About page renders its content",
      module: "about",
      priority: "P3",
      status: "DRAFT",
      spec_ref: "docs/spec.md",
      tags: ["about"],
      preconditions: ["SampleApp served at {{APP_URL}}"],
      narrative:
        "Passing control: loads the about page and verifies its title and content render.",
      steps: [
        { id: "open-about", action: "navigate", url: "{{APP_URL}}/about.html" },
        { id: "about-title", action: "assert", kind: "title_contains", value: "About" },
        { id: "about-content", action: "assert", kind: "text_contains", value: "About SampleApp" },
      ],
    },
  ],
  notes:
    "Five plans map 1:1 to the seeded defects (one failing assertion each); TP-006 is the passing control and must stay green.",
};

/* ------------------------------------------------------------------ */
/* Stage 4 — triage (keyed by plan title, rendered in the prompt)       */
/* ------------------------------------------------------------------ */

export const TRIAGE = {
  "Landing page shows the hero promise": {
    title: "Landing hero copy does not match the spec",
    severity: "P1-High",
    component: "public/index.html",
    description:
      "Step hero-copy failed: the landing page text does not contain the spec-required hero copy; the hero renders different copy. Console and network evidence show the page itself loaded normally.",
    violated_contract: `docs/spec.md section 1 requires the landing hero to read '${HERO_COPY}'; plan step hero-copy asserts text_contains.`,
    proposed_fix:
      "Update the hero <h1> in public/index.html to the copy required by docs/spec.md section 1.",
  },
  "Features page renders the free-trial call-to-action": {
    title: "Features page is missing the free-trial call-to-action",
    severity: "P1-High",
    component: "public/features.html",
    description:
      "Step cta-visible failed: no element with testid free-trial-cta exists in the features page DOM; the features list itself renders. The placeholder comment in the markup marks where the CTA belongs.",
    violated_contract:
      'docs/spec.md section 2 requires a free-trial CTA button with data-testid="free-trial-cta"; plan step cta-visible asserts it is visible.',
    proposed_fix:
      "Add the free-trial CTA button (testid free-trial-cta, label 'Start free trial') to public/features.html at the marked location.",
  },
  "Pricing page lists the correct Pro plan price": {
    title: "Pricing page shows the wrong Pro plan price",
    severity: "P2-Medium",
    component: "public/pricing.html",
    description:
      "Step pro-price failed: the pricing table shows a different price for the Pro plan than the spec's $9/mo. Other rows render correctly.",
    violated_contract:
      "docs/spec.md section 3 lists Pro — $9/mo; plan step pro-price asserts the page contains '$9/mo'.",
    proposed_fix:
      "Correct the Pro plan price cell in public/pricing.html to $9/mo.",
  },
  "Navigation reaches the About page": {
    title: "About navigation link is broken",
    severity: "P2-Medium",
    component: "public/js/nav.js",
    description:
      "Step on-about failed: after clicking the About entry in the primary navigation, the URL did not move to /about.html — the link's href is a dead placeholder.",
    violated_contract:
      "docs/spec.md section 4 requires the About link to navigate to /about.html; plan step on-about asserts url_contains /about.html.",
    proposed_fix:
      "Point the About entry in public/js/nav.js at /about.html instead of the dead placeholder href.",
  },
  "Checkout places an order and shows confirmation": {
    title: "Checkout order button does not place the order",
    severity: "P0-Blocker",
    component: "public/js/checkout.js",
    description:
      "Step order-confirmed failed: after entering an email and clicking Place order, the status region never shows 'Order received' — the click handler is not attached to the button that exists in the DOM.",
    violated_contract:
      "docs/spec.md section 5 requires clicking Place order to show 'Order received'; plan step order-confirmed asserts the confirmation text.",
    proposed_fix:
      "Fix the element id used to bind the click handler in public/js/checkout.js so it matches the button's real id in public/checkout.html.",
  },
};

/* ------------------------------------------------------------------ */
/* Stage 5 — fixer (keyed by bug title; byte-exact patches)             */
/* ------------------------------------------------------------------ */

/** A real LLM's `git diff` output ends with a newline; `git apply` requires it. */
const diff = (lines) => lines.join("\n") + "\n";

export const FIXES = {
  "Landing hero copy does not match the spec": {
    summary: `Replace the landing hero heading with the spec-required copy '${HERO_COPY}'.`,
    patch: diff([
      "diff --git a/public/index.html b/public/index.html",
      "--- a/public/index.html",
      "+++ b/public/index.html",
      "@@ -11,5 +11,5 @@",
      "   <main>",
      "-    <h1>Try us now</h1>",
      `+    <h1>${HERO_COPY}</h1>`,
      "     <p>SampleApp is a tiny SaaS for demoing Argus.</p>",
      '     <a class="cta" href="/features.html">See features</a>',
      "   </main>",
    ]),
    files: ["public/index.html"],
    risk_notes:
      "Changes only the hero copy; does not verify any other landing copy or styling.",
  },
  "Features page is missing the free-trial call-to-action": {
    summary:
      "Add the free-trial CTA button (testid free-trial-cta) where the placeholder comment marks it, replacing the comment.",
    patch: diff([
      "diff --git a/public/features.html b/public/features.html",
      "--- a/public/features.html",
      "+++ b/public/features.html",
      "@@ -15,3 +15,3 @@",
      "     </ul>",
      "-    <!-- the free-trial call-to-action belongs here (see docs/spec.md section 2) -->",
      '+    <button class="cta" data-testid="free-trial-cta">Start free trial</button>',
      "   </main>",
    ]),
    files: ["public/features.html"],
    risk_notes:
      "Adds the documented CTA only; does not wire the button to a destination (spec defines no behavior for it).",
  },
  "Pricing page shows the wrong Pro plan price": {
    summary: "Correct the Pro plan price cell from $19/mo to the spec's $9/mo.",
    patch: diff([
      "diff --git a/public/pricing.html b/public/pricing.html",
      "--- a/public/pricing.html",
      "+++ b/public/pricing.html",
      "@@ -11,4 +11,4 @@",
      '     <table id="plans">',
      '       <tr><td>Free</td><td>$0/mo</td></tr>',
      '-      <tr><td>Pro</td><td>$19/mo</td></tr>',
      '+      <tr><td>Pro</td><td>$9/mo</td></tr>',
      '       <tr><td>Team</td><td>$49/mo</td></tr>',
    ]),
    files: ["public/pricing.html"],
    risk_notes:
      "Changes one price cell; does not verify billing or currency formatting elsewhere.",
  },
  "About navigation link is broken": {
    summary: "Point the About nav entry at /about.html instead of the dead '#' placeholder.",
    patch: diff([
      "diff --git a/public/js/nav.js b/public/js/nav.js",
      "--- a/public/js/nav.js",
      "+++ b/public/js/nav.js",
      "@@ -6,3 +6,3 @@",
      '     { label: "Pricing", href: "/pricing.html" },',
      '-    { label: "About", href: "#" },',
      '+    { label: "About", href: "/about.html" },',
      "   ];",
    ]),
    files: ["public/js/nav.js"],
    risk_notes:
      "Fixes the About href on every page that shares the nav; does not affect other nav entries.",
  },
  "Checkout order button does not place the order": {
    summary:
      "Bind the checkout click handler to the button's real id (place-order) instead of the nonexistent order-btn.",
    patch: diff([
      "diff --git a/public/js/checkout.js b/public/js/checkout.js",
      "--- a/public/js/checkout.js",
      "+++ b/public/js/checkout.js",
      "@@ -2,3 +2,3 @@",
      " (function () {",
      '-  const btn = document.getElementById("order-btn");',
      '+  const btn = document.getElementById("place-order");',
      '   const status = document.getElementById("checkout-status");',
    ]),
    files: ["public/js/checkout.js"],
    risk_notes:
      "Fixes handler binding only; does not add validation or a real order backend (the spec defines none).",
  },
};

/* ------------------------------------------------------------------ */
/* Stage 6 — submit (keyed by bug title; bug id + run id interpolated)  */
/* ------------------------------------------------------------------ */

const PRS = {
  "Landing hero copy does not match the spec": {
    module: "landing",
    what: "use the spec-required landing hero copy",
  },
  "Features page is missing the free-trial call-to-action": {
    module: "features",
    what: "restore the free-trial CTA on the features page",
  },
  "Pricing page shows the wrong Pro plan price": {
    module: "pricing",
    what: "correct the Pro plan price to $9/mo",
  },
  "About navigation link is broken": {
    module: "navigation",
    what: "point the About nav link at /about.html",
  },
  "Checkout order button does not place the order": {
    module: "checkout",
    what: "bind the order handler to the real button id",
  },
};

function prFor(title, bugId, runId, planId) {
  const pr = PRS[title];
  const subject = `fix(${pr.module}): ${pr.what} [${bugId}]`;
  return {
    commit_message: subject,
    title: subject,
    body: [
      `## Summary`,
      ``,
      `Fixes ${bugId}: ${title.toLowerCase()}. The patch is minimal and scoped to the responsible file.`,
      ``,
      `## Evidence`,
      ``,
      `- Before: plan ${planId} failed on its assertion (see the run's scenario artifacts).`,
      `- After: re-run of ${planId} passes; video/trace/HAR captured in the verify scenario directory.`,
      ``,
      `## Scope & risk`,
      ``,
      `- Minimal single-surface change; no refactors, no new dependencies.`,
      `- Not covered: adjacent surfaces of the same page were not re-tested.`,
      ``,
      `## Verification`,
      ``,
      `- ${planId} failed before the patch and passes after.`,
      `- Reproduce: \`argus run --plan ${planId}\` against the target.`,
      ``,
      `Argus run ${runId} — generated fix, human review required.`,
    ].join("\n"),
  };
}

/* ------------------------------------------------------------------ */
/* Routing                                                              */
/* ------------------------------------------------------------------ */

export function route(system) {
  if (system.includes("ANALYZE agent")) return { tag: "analyze", out: IMPACT };
  if (system.includes("TEST PLAN agent")) return { tag: "testplan", out: PLANS };
  if (system.includes("TRIAGE agent")) {
    const m = /^- Plan: (TP-\S+) — (.+)$/m.exec(system);
    const title = m?.[1] ? m[2].trim() : undefined;
    const out = title ? TRIAGE[title] : undefined;
    return { tag: `triage/${m?.[1] ?? "?"}`, out };
  }
  if (system.includes("FIXER agent")) {
    const m = /^- Title: (.+)$/m.exec(system);
    const title = m?.[1]?.trim();
    const out = title ? FIXES[title] : undefined;
    return { tag: `fixer/${title ?? "?"}`, out };
  }
  if (system.includes("SUBMIT agent")) {
    const bug = /^- Bug: (BUG-[0-9]+) — (.+) \(P[0-9]-[A-Za-z]+\)$/m.exec(system);
    // The submit prompt carries the run id in its footer instruction
    // ("End with a footer line: `Argus run {{RUN_ID}} — ...`").
    const run = /Argus run (\S+) — generated fix/.exec(system);
    const title = bug?.[2];
    const out = title
      ? prFor(title.trim(), bug[1], run?.[1] ?? "unknown", planIdForBug(title.trim()))
      : undefined;
    return { tag: `submit/${bug?.[1] ?? "?"}`, out };
  }
  return { tag: "unrouted", out: undefined };
}

/** Plan id is fixed by the scripted testplan order (TP-001..006). */
const PLAN_ID_BY_TITLE = Object.fromEntries(PLANS.plans.map((p) => [p.title, p.id]));

/** Bug title → plan id it came from (1:1 in this dogfood). */
function planIdForBug(bugTitle) {
  const planTitle = Object.entries(TRIAGE).find(([, r]) => r.title === bugTitle)?.[0];
  return planTitle ? (PLAN_ID_BY_TITLE[planTitle] ?? "TP-???") : "TP-???";
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                 */
/* ------------------------------------------------------------------ */

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        return send(res, 400, { error: { message: "bad json" } });
      }
      const system =
        (parsed.messages ?? []).find((m) => m.role === "system")?.content ?? "";
      const { tag, out } = route(system);
      if (!out) {
        console.error(
          `[scripted-llm] no canned response — system prompt starts: ${system.slice(0, 80).replace(/\n/g, " ")}`,
        );
        return send(res, 500, { error: { message: `no scripted response (${tag})` } });
      }
      console.error(`[scripted-llm] → ${tag}`);
      send(res, 200, {
        id: "chatcmpl-scripted",
        object: "chat.completions",
        created: Math.floor(Date.now() / 1000),
        model: "scripted-qe/1",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: JSON.stringify(out) },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 250, completion_tokens: 400, total_tokens: 650 },
      });
    });
    return;
  }
  send(res, 404, { error: { message: "not found" } });
});

// Only bind the port when run directly (a self-test imports the canned
// responses without starting the server).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`scripted-llm: OpenAI-compatible endpoint on http://127.0.0.1:${PORT}/v1`);
  });
}
