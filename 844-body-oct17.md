Closes OVD-903

Model: model:codex (built with Codex on the box; Claude is capped until Oct 17 3 PM MST)

## Linear issue ID

- Issue: OVD-903 (batched follow-up to OVD-811 / #832; not a release-outcome parent)
- This one bounded change covers all 10 items OVD-903 lists (Designer's 4 fixes and Opus's 6 non-blocking suggestions from #832). No post-merge criteria remain for OVD-903. Real USDZ export and device proof stay in OVD-904, which is not started.
- This is the issue's main PR. It follows #832 by design (batched review follow-ups), not as a repair.

## Summary

Applies the Designer's and Opus's batched follow-ups to the DEV-only Jarvis AR preview (`/dev/jarvis-ar`). It adds state toggles, an `ArMoreAction` (MORE plus a bottom sheet) built as `arActionSlot` content for the OVD-804 thread, the specified sheet style, and a plate thumbnail poster. It also tightens AR URL handling to https-only, makes cad-agent reject worker file names that escape the run folder, and adds the missing tests.

## Problem

#832 shipped the AR seam, and its reviews left 4 design fixes and 6 non-blocking suggestions. The sheet was a standalone card, the poster was a blank `/placeholder.svg`, the loading and failed states could not be previewed, and the Quick Look and Safari hrefs were never checked as https. The worker file names were joined into `file://` URIs without a containment check, the Safari fallback appeared even with no USDZ, the Scene Viewer component test compared against its own implementation, the USDZ chat message had no test, and an `App.tsx` comment sat above the wrong declaration.

## Acceptance criteria addressed

- [x] D1: preview toggles for READY, LOADING (`Preparing AR view`) and FAILED (`TRY AGAIN`); TRY AGAIN returns to ready.
- [x] D2: `ArMoreAction` is shell-side `arActionSlot` content: a 44px MORE button that opens a modal bottom sheet holding the View in AR row. Escape, a backdrop tap and CANCEL all close it, focus stays inside while open and returns to MORE on close. The preview mounts it as the slot inside a mock result area, not as a standalone card.
- [x] D3: 36×5 grabber, 13px monospace title, `#18181B` surface, 0.5 backdrop, final 52px uppercase `CANCEL` row after a separator.
- [x] D4: the Quick Look poster is the plate thumbnail (`src/features/jarvis/ar/preview-assets/plate-thumb.png`, synthetic) instead of `/placeholder.svg`.
- [x] O1: a shared `isHttps()` check; USDZ (Quick Look), viewUrl (Safari fallback and `S.browser_fallback_url`) and the GLB must all be https or the row is `unavailable`. `javascript:alert(1)`, `http:`, empty and invalid cases are tested.
- [x] O2: cad-agent `uri()` rejects names where `basename(file) !== file`, empty names, `.`/`..`, or anything that resolves outside `runDir`. All supplied files are checked before any artifact is published, so a bad name fails the run with no artifacts. An absent, `null` or empty `usdz` is still skipped, as before.
- [x] O3: the installed iOS app shows the OPEN IN SAFARI fallback only when an https USDZ exists.
- [x] O4: the Scene Viewer component test asserts the literal intent string.
- [x] O5: a render test locks in the `artifact{usdz}` chat message (text plus web link, no `model3dUrl` even with 3D capability).
- [x] O6: the "dynamic import is eliminated…" comment sits above EngineeringWorkbench again.

## Files changed

- `src/features/jarvis/ar/ar-support.ts` (+ `ar-support.test.ts`, `ViewInArAction.test.tsx`), `ar.css`, `preview-assets/plate-thumb.png` + README
- `src/components/jarvis/ArMoreAction.tsx` (+ test), new
- `src/pages/JarvisArPreview.tsx` (+ test), `src/App.tsx` (comment move only)
- `server/design-graph/cad-agent.ts` (+ `cad-agent.test.ts`)
- `src/features/jarvis/core/conversation-service.test.ts` (USDZ render test)
- `docs/design/jarvis-pwa/screenshots/ovd-903/` (12 proof screenshots)

## Scope

**Included:** the 10 OVD-903 items above, all still behind the DEV-only `/dev/jarvis-ar` route.

**Not included:**
- Real USDZ export, device launch proof, and model-viewer `canActivateAR`/`activateAR` wiring (OVD-904).
- Mounting `ArMoreAction` in the real `JarvisThread`. The thread lives in the OVD-804 stack (#838) and is not on main yet. Once it lands, the shell passes `<ArMoreAction …/>` as `arActionSlot`, with no further component change.
- No dependency, migration, env, workflow or gate change.

`ArMoreAction` lives in `src/components/jarvis/` rather than `src/features/jarvis/ar/` because it needs React hooks, and the Jarvis import boundary (`src/features/jarvis/import-boundary.test.ts`, being narrowed in #837) keeps `react` imports out of the feature core. The boundary test was not changed.

## Verification

Commands run:

```bash
npm run preflight   # lint PASS, typecheck PASS, test: 626 files passed; only the 3 known docker-only failures (below)
npx vitest run src/features/jarvis src/components/jarvis src/pages/JarvisArPreview.test.tsx server/design-graph
# Test Files 11 passed (11); Tests 107 passed | 3 skipped (110)
```

Results:

- [x] all listed verification passed
- [x] unrelated baseline failures are described below

Baseline failures or exceptions: `scripts/qualify-ovd417-four-migration-suffix.test.mjs` has 3 failures that need docker, which the box doesn't have (known). 3 real-CAD tests in `cad-agent.test.ts` skip because build123d isn't installed on the box (pre-existing).

## Proof

Test: src/features/jarvis/ar/ar-support.test.ts
Test: src/components/jarvis/ArMoreAction.test.tsx
Test: src/pages/JarvisArPreview.test.tsx
Test: server/design-graph/cad-agent.test.ts
Test: e2e/journeys/jarvis-front-door.spec.ts (Jarvis journey, which covers the AR link; it stays `test.fail()` until OVD-805 adds the front door. This PR changes only the DEV preview.)
Screenshot: ![iOS MORE sheet 430](https://github.com/optomachina/Overdrafter/blob/7a195469beacf7d09d3c15f4711d62637e6848d8/docs/design/jarvis-pwa/screenshots/ovd-903/more-ios-available-430.png?raw=1)
Screenshot: ![installed iOS app Safari fallback 430](https://github.com/optomachina/Overdrafter/blob/7a195469beacf7d09d3c15f4711d62637e6848d8/docs/design/jarvis-pwa/screenshots/ovd-903/more-ios-pwa-safari-430.png?raw=1)
Screenshot: ![loading 375](https://github.com/optomachina/Overdrafter/blob/7a195469beacf7d09d3c15f4711d62637e6848d8/docs/design/jarvis-pwa/screenshots/ovd-903/more-loading-375.png?raw=1)
Screenshot: ![failed with TRY AGAIN 375](https://github.com/optomachina/Overdrafter/blob/7a195469beacf7d09d3c15f4711d62637e6848d8/docs/design/jarvis-pwa/screenshots/ovd-903/more-failed-375.png?raw=1)
Screenshot: ![desktop unavailable 430](https://github.com/optomachina/Overdrafter/blob/7a195469beacf7d09d3c15f4711d62637e6848d8/docs/design/jarvis-pwa/screenshots/ovd-903/more-unavailable-desktop-430.png?raw=1)

The screenshots are from the Vite dev server at `/dev/jarvis-ar?embed=1` in headless Chromium, with AR support and `navigator.standalone` stubbed per state. Placeholder Supabase env values were used only so the shell would boot. All 12 (375 and 430 wide) are in `docs/design/jarvis-pwa/screenshots/ovd-903/`.

## Review findings and coverage

- Final PR head SHA: 560cbf2b0c4c1557f774f471f7d1c3583a5ff28b
- Sonar issue findings: at d99e5867 there were 5 (1 BUG S1082, 4 smells S6819, S6848, S6759 x2) and the gate failed on new_reliability_rating. All 5 were fixed in code at 560cbf2b; nothing was marked Safe or Reviewed. Re-analysis pending.
- CodeRabbit: pending.
- Codex and other reviewers: the Codex review is posted as a PR comment at the head. The Jev-required reviewer is listed in the screen comment.
- [ ] Inspected findings and threads on the final head; actionable current-change findings are resolved or have evidence-backed dispositions. Missing or stale review is not counted as clean.

## Tests

- `ar-support.test.ts`: `isHttps` and the unsafe or missing URL matrix for USDZ, viewUrl and GLB on iOS, the installed iOS app and Android.
- `ViewInArAction.test.tsx`: literal Scene Viewer intent.
- `ArMoreAction.test.tsx` (new): labelled modal, focus containment, and focus restore after CANCEL, Escape and a backdrop tap.
- `JarvisArPreview.test.tsx`: thumbnail poster (not `/placeholder.svg`), focus restore after CANCEL, loading and failed toggles, TRY AGAIN returning to ready.
- `cad-agent.test.ts`: unsafe names (`../other/x.usdz`, `/etc/passwd`, `sub/plate.glb`, `.`, `..`, and empty for required files) fail the run for every artifact slot with no artifacts emitted; an empty usdz is still skipped.
- `conversation-service.test.ts`: `artifact{usdz}` render.

## Migration notes

- [x] No migration impact
- [ ] Migration impact exists and is described below

## Rollback / risk notes

- The UI is DEV-only, so production is unchanged. The one runtime change outside DEV is cad-agent `uri()`, which now fails a run whose worker returns a file name outside the run folder. The worker only returns bare file names today, so this should never fire on good output.
- Rollback: revert the squash commit.

## Documentation

- [ ] Docs updated
- [x] No doc updates needed

## Follow-up items

- [ ] Wire `ArMoreAction` into `JarvisThread`'s `arActionSlot` once the OVD-804 stack (#838) lands.
- [ ] OVD-904: real USDZ export and device proof.

