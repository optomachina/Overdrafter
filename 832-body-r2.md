Refs OVD-811

Model: model:codex (Codex on the box; Claude review-only until Oct 17 3 PM MST)

## Linear issue ID

- Issue: OVD-811 (bounded child of OVD-795; not a release-outcome parent)
- Main PR for the rescoped OVD-811 criteria that #832 meets (AR-5 and the AR seam). Lead approved the rescope: AR-1/2/3/4/6/7 and device Proof move to OVD-904 (Jarvis AR: real USDZ export + device proof).

## Summary

Adds `usdz` as a design-graph artifact kind, lets the CAD agent emit an `artifact{usdz}` event (same `dimensionsMm` as the GLB) when the worker returns a USDZ file, adds a converter seam in `plate.py` (no dependency, records `usdz: null` plus a reason), and adds a dependency-free "View in AR" row with device detection per SPEC §5.8, shown on a dev-only preview page at `/dev/jarvis-ar`.

## Problem

Jarvis slice 1 needs AR: AR Quick Look on iOS (USDZ) and Scene Viewer on Android (GLB), hidden where AR isn't supported. The graph contract had no USDZ artifact and the web had no AR action.

## Acceptance criteria addressed

- [x] `artifact{usdz}` validates and is emitted after GLB when present (no event when absent).
- [x] AR action: iOS Quick Look (`<a rel="ar">` with child `<img>`), Android Scene Viewer intent URL, installed iOS PWA OPEN IN SAFARI fallback, unsupported hides the row and shows the note (AR-5 logic).
- [x] States: available, unavailable, Safari fallback, loading (quiet text), failed (one line plus retry). 44px row in a MORE sheet; OPEN 3D stays the visible outline button.
- [ ] AR-1/AR-2 real GLB + USDZ export with gltf-validator/usdchecker: moved to OVD-904 (blocked on converter approval).
- [ ] AR-3/AR-4 on real devices; AR-6/AR-7 signed URL 403s: moved to OVD-904.

## Files changed

- `server/design-graph/events.ts`, `server/design-graph/cad-agent.ts` (+ tests in `cad-agent.test.ts`, `design-graph.test.ts`)
- `src/features/jarvis/core/types.ts` (mirror union kept in sync with events.ts)
- `scripts/jarvis-demo/plate.py` (optional converter seam)
- `src/features/jarvis/ar/` (`ar-support.ts`, `ViewInArAction.tsx`, `ar.css`, fixtures, tests)
- `src/pages/JarvisArPreview.tsx` (+ test), `src/App.tsx` (2 lines: DEV-only lazy route)

## Scope

**This PR ships (confirmed against `gh pr diff 832`):**

- AR support detection (`ar-support.ts`)
- Scene Viewer (Android) and Quick Look (iOS) launch paths
- Safari fallback (installed iOS PWA)
- "AR unavailable" note when unsupported
- `ViewInArAction` component
- cad-agent USDZ artifact event plumbing (emit when a worker USDZ file is present)
- All behind the dev-only `/dev/jarvis-ar` route
- Tests for the above

**Not included / moved to OVD-904:** AR-1, AR-2, AR-3, AR-4, AR-6, AR-7, and the required device Proof. No real USDZ is produced yet (`optional_usdz_export` returns `None`, pending Blaine's USDZ-converter decision) and there is no device session. Also not included: `@google/model-viewer` integration (lands with OVD-804 / #839), result card/MORE sheet in the real thread (OVD-804 / #838 + OVD-903), artifact serving and signed URL policy, any migration, env var, workflow or dependency change.

**Placeholder approach:** the real result card is being built in OVD-804 in parallel (#836 transport, #837 gate, #838 thread UI, #839 3D viewer), so the row is mounted on a minimal MORE sheet in a DEV-only preview (`/dev/jarvis-ar`, gated by `import.meta.env.DEV`, no new env var) fed by fixture URLs (`example.invalid`).

## Verification

Commands run on the box at head (Linux; targeted only, no full e2e per box limits):

```bash
npm run lint        # PASS (exit 0)
npm run typecheck   # PASS (exit 0)
npx vitest run server/design-graph/design-graph.test.ts server/design-graph/cad-agent.test.ts server/jarvis/design-graph-port.test.ts src/features/jarvis/ar/ar-support.test.ts src/features/jarvis/ar/ViewInArAction.test.tsx src/pages/JarvisArPreview.test.tsx src/features/jarvis/import-boundary.test.ts server/design-graph/import-boundary.test.ts
# Test Files 8 passed (8); Tests 44 passed | 3 skipped (47)
```

Results:

- [x] all listed verification passed
- [x] unrelated baseline failures are described below

Baseline failures or exceptions: 3 real-CAD tests in `cad-agent.test.ts` skip because the build123d Python runtime is not installed on the box (pre-existing skip). Full `npm run preflight` (all unit tests) was not run on the box because of memory limits; CI runs it.

## Tests

- `server/design-graph/cad-agent.test.ts`: usdz absent / null / present; artifact order, MIME `model/vnd.usdz+zip`, 101.6 mm edge on both GLB and USDZ events (AR-2 at the event level), result inclusion.
- `server/design-graph/design-graph.test.ts`: validator accepts `usdz`.
- `src/features/jarvis/ar/ar-support.test.ts`: iOS Quick Look, iPadOS, Android intent encoding, iOS standalone fallback, missing USDZ and non https GLB are unsupported, desktop hidden.
- `src/features/jarvis/ar/ViewInArAction.test.tsx`, `src/pages/JarvisArPreview.test.tsx`: rendered element/state per case.

## Proof

Test: src/features/jarvis/ar/ar-support.test.ts
Test: src/features/jarvis/ar/ViewInArAction.test.tsx
Test: server/design-graph/cad-agent.test.ts

Still to collect (moved to OVD-904 / OVD-781): validator output at head once a converter exists, a real iPhone AR Quick Look screenshot and an Android Scene Viewer screenshot, signed-URL 403 cases.

## Migration notes

None. No database, migration, RLS or env changes.

## Rollback / risk notes

Revert the squash commit. The USDZ path only fires when the worker returns a USDZ file (never today), and the UI is DEV-only, so production behavior is unchanged. Touches `server/design-graph` (shared contract), so it is not in an auto-merge category.

## Documentation

Converter contract documented in `plate.py` (`optional_usdz_export`): mm coordinates (USD metersPerUnit=0.001), Y up, same origin as STEP/GLB.

## Open items

- **Follow-up OVD-904:** real USDZ export + device proof (AR-1/2/3/4/6/7). Blocked on Blaine's USDZ-converter dependency decision and a real-device session. QA FAIL: https://github.com/optomachina/Overdrafter/pull/832#issuecomment-6230160005
- **Follow-up OVD-903:** design fixes + Opus review suggestions (batched, after #832), still behind `/dev/jarvis-ar`.
- **Follow-up:** switch the detection/launch adapter to `@google/model-viewer`'s `canActivateAR`/`activateAR` once OVD-804 / #839 lands, and mount the row in the real result card MORE sheet via `arActionSlot` (#838 / OVD-903).
- AR-6 / AR-7 and T-5 (non-owner resolve -> 403, from OVD-804): belong to artifact serving / server auth; no server or storage changes here.

## Open questions for Blaine

- **USDZ converter:** real GLB/STEP to USDZ export needs a new dependency (e.g. `usd-core`, which provides `pxr` but is not a GLB importer by itself, so a converter path is also needed). It is stubbed until you approve one; AR-1/AR-2 stay on OVD-904 until then.
