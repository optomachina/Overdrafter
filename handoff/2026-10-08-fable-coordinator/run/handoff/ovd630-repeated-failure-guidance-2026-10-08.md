# OVD-630 repeated-failure guidance (2026-10-08, read-only analysis of origin/main 7b50f0d)

Trigger: two consecutive A4 attempts failed (four-worker run; then single-worker run failing :279 phone sheet focus and :256 desktop CAD preview at 8.6 s, i.e. an assertion failure, not a timeout). Contract: stop editing, root-cause with evidence, classify each failing line, prove each fix with a mutation, then one bounded change set.

## Causal reading of the spec and the shell

1. `expectContainedBy` (e2e/client-shell.spec.ts:66-68) is a one-shot `boundingBox()` comparison, not a polling expectation. It samples layout once, immediately after `toBeVisible()` resolves. Any in-flight layout change makes it a coin flip: the desktop sidebar animates `transition-[width] duration-200` (QuoteIntelligenceShell.tsx:192-193), and the CAD canvas resizes after layout through its own observer, on the swiftshader GPU path the fixture lane forces (playwright.config.ts launchOptions). :256 failing at 8.6 s with the 30 s budget untouched is this class: the containment snapshot landed mid-reflow.
2. Width and focus assertions sit on animated surfaces. :132 `toHaveCSS("width","52px")` after "Close sidebar" waits on the 200 ms width transition; :293 `toHaveCSS("width","224px")` and the :279 focus expectations sit on the Radix Sheet open/close animation (`data-[state=open]:animate-in slide-in-from-left`, sheet.tsx:32-39) and on a `setTimeout(..., 0)` focus return (QuoteIntelligenceShell.tsx:368). Under the OVD-630 stall harness (150-300 ms frozen per 350-500 ms period, about 40-60 percent stalled; the 600/100 ms figure belongs to OVD-636, not here) the 5 s `expect` budget shrinks to roughly 2-3 s of effective time, so animation-bound expectations are the first to fail. The app already honours `prefers-reduced-motion` (src/index.css:184-188 sets animation and transition durations to 0.01 ms), but the spec never emulates it.
3. First render has no readiness marker. The tests `goto` then wait on a role query (`[data-workspace-scroll="primary"]` at :166, the sourcing toggle at :193). Both are the hosted failure signatures (5 s visibility timeout on PRs that touch nothing). The collapse state also settles after mount: `useSidebarCollapseState` initialises from `matchMedia` and re-sets it in an effect (:87-107), so a viewport change after navigation flips layout once more.
4. Load identity is fixed for OVD-630: A1 (red) and A4 (green) both run under the same 150-300 ms per 350-500 ms stall harness, and acceptance is not relaxed. The classification question is therefore not which load to use but which class each failing line belongs to under that load: the hosted lane shows only class (a) (5 s first-render visibility timeouts), while the local harness also surfaces class (b) (:117, :279, the :256 containment snapshot). Both classes must pass A4 under the same harness.

## What the independent review should establish before any further edit

- R1. Classify each failing line into (a) first-render readiness (:162, :187) or (b) animation/layout-sampling (:117/:132, :256, :279/:293). Evidence: the retained traces (`trace: retain-on-failure`): for each failure, the action timeline shows whether the element was absent (a) or present but mid-transition/mis-measured (b).
- R2. Keep the harness identity (150-300 ms per 350-500 ms) for every run; record which lines fail per class across the retained runs so the fix for each class is proven under the acceptance load itself. Optionally, a runner-like CPU-contention run shows which class the hosted lane sees, as information only, never as a substitute for A4.
- R3. Prove class (b) with a single-variable experiment under the same harness: add `await page.emulateMedia({ reducedMotion: "reduce" })` before `goto` in one failing test (and, separately, a polling containment check) and re-run; if :256/:279/:117 pass while the unmodified copies still fail, the animation class is confirmed.
- R4. Prove class (a) with instrumentation: `page.evaluate` timestamps for `performance.timing`/`PerformanceObserver` paint entries versus the moment the toggle appears; confirm the gap is the async app entry plus fixture data, not the sidebar.

## Bounded change set (after R1-R4; sole writer stays local)

- B1. Readiness primitive for class (a): one shared helper `openShell(page, viewport, route)` that sets the viewport BEFORE `goto`, then waits on a single, stable readiness signal (preferred: a `data-shell-ready="1"` attribute the shell sets in an effect after its first committed render and sidebar state settle; acceptable: `getByRole("button", { name: /sourcing/ }).waitFor()` plus `waitForLoadState("networkidle")` in the fixture lane). Every test in the file uses it. Assertion strength unchanged.
- B2. Reduced motion for class (b): `reducedMotion: "reduce"` in the fixture-lane `use` block of playwright.config.ts (or `test.use({ reducedMotion: "reduce" })` at the top of this spec). This removes the 200 ms sidebar transition and the Sheet slide animation from the assertions without touching assertion content; the CSS already implements it.
- B3. Make `expectContainedBy` a polling assertion: wrap the bounding-box comparison in `await expect.poll(async () => contained(container, content), { timeout: 5000 }).toBe(true)` (or `expect(async () => ...).toPass()`), so a reflow in flight is waited out instead of sampled.
- B4. Do not raise `expect` timeouts; do not add `test.fixme`/`skip`; no `waitForTimeout`.

## Acceptance evidence for the PR

- Red: unmodified spec under the 150-300 ms per 350-500 ms harness fails (A1, already captured); traces attached.
- Green: `--repeat-each=10` under the identical harness passes (A4, same load identity, no relaxation).
- Mutations: remove the readiness wait (B1) -> class (a) fails again; remove `reducedMotion` (B2) -> class (b) fails again under stress; revert the polling containment (B3) -> :256 fails again under stress.
- Hosted: browser-test green at the PR head; one re-run at most.

## OVD-636 note

Raising only the real-browser comparison test to 120 s with a measured reason is within the spec. The second known failure mode ("expected true, received false": the attempt cancelled by its own 5 s production deadline under load) is not addressed by a timeout; the 20-run loop must show it absent, and the mutation evidence must show the awaited-state change, not the timeout, is what makes the test deterministic.
