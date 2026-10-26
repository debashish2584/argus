# SampleApp — product spec

SampleApp is a tiny static SaaS site (landing, features, pricing, checkout,
about). This document is the ground truth for what the site must do. Argus
test plans are derived from it, and the fixer must not change it — when UI
behavior disagrees with this spec, the UI is wrong.

## Section 1 — Landing

The landing page (`/`) hero must read exactly:

> Start free — no credit card

## Section 2 — Features

The features page (`/features.html`) lists capabilities and renders a
free-trial call-to-action button with `data-testid="free-trial-cta"`
(label: "Start free trial").

## Section 3 — Pricing

The pricing table on `/pricing.html` lists exactly:

| Plan | Price |
|------|-------|
| Free | $0/mo |
| Pro  | $9/mo |
| Team | $49/mo |

## Section 4 — Navigation

Every page renders a primary navigation (Home, Features, Pricing, About).
The About link must navigate to `/about.html`.

## Section 5 — Checkout

On `/checkout.html`, entering an email and clicking the "Place order"
button must show the confirmation text `Order received` in the status
region (`#checkout-status`).
