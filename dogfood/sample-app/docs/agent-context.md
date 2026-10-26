# SampleApp — engineering standards (agent context)

Rules every change to this repository must follow. Argus ingests this
document as mandatory fixer context.

1. **Minimal diff.** Change only the lines implicated by the bug. No
   refactors, no reformatting, no drive-by edits.
2. **Static site.** No build step, no dependencies. New behavior is plain
   HTML/CSS/JS under `public/`.
3. **Keep the a11y tree honest.** Buttons and links carry real accessible
   names; `data-testid` attributes only where `docs/spec.md` documents them.
4. **Copy and prices come from `docs/spec.md`.** When UI copy or prices
   disagree with the spec, the UI is wrong — fix the UI, not the spec.
5. **`docs/` is ground truth.** Never "fix" a failing test by editing the
   spec, the test plans, or Argus configuration.
