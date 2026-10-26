# SampleApp — dogfood target for Argus

A tiny static SaaS site with **five seeded bugs**, used to dogfood Argus
hermetically (local and CI) without a real LLM or a real target app.
`docs/spec.md` states the intended behavior; the seeded defects make the
corresponding assertions fail.

| # | Seeded defect | File | Caught by |
|---|---------------|------|-----------|
| 1 | Landing hero copy is "Try us now" instead of the spec's "Start free — no credit card" | `public/index.html` | TP-001 |
| 2 | Free-trial CTA (`data-testid="free-trial-cta"`) missing | `public/features.html` | TP-002 |
| 3 | Pro plan priced at $19/mo instead of $9/mo | `public/pricing.html` | TP-003 |
| 4 | About nav link dead (`href="#"`) | `public/js/nav.js` | TP-004 |
| 5 | Checkout handler binds to the wrong button id (`order-btn` vs `place-order`) | `public/js/checkout.js` | TP-005 |

TP-006 (about page renders) is the **passing control** — it must stay
green throughout the run.

Evidence flavor (captured, never scenario failures): `/js/analytics.js`
is deliberately absent → a 404 in every page's network HAR.

Run the site manually:

```sh
PORT=4173 node server.mjs
```

Drive the closed loop hermetically:

```sh
node dogfood/run.mjs        # from the repo root
```

See `dogfood/README.md` for the harness design and acceptance bar.
