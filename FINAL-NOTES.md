# OVD-811 handoff

Owner: Codex / OVD-811, host grok-bot-vm-55040405, worktree /workspace/wt-811.
Branch: bwilson/ovd-811-ar-export-view-in-ar.
Source revision: 213b62a0cbc48eccebc414b6dc4b41bc3a27085c plus these uncommitted changes, 2026-10-17 UTC.
Allowed actions: scoped reversible source edits and targeted checks. No commit, push, merge, new dependencies, real provider operations or hosted changes.
Completion condition: requested seam, event and dev preview implementation with verification and explicit remaining proof. One writer; no delegated agents. Timeout-runner failure family is stopped after repeated matching failures; no test/check weakening.

## Built and files changed

- server/design-graph/events.ts: adds USDZ to the existing validator's shared artifact-kind list, including result references; other validation remains compatible.
- server/design-graph/cad-agent.ts: optional nullable worker USDZ file; emits its artifact immediately after GLB with model/vnd.usdz+zip and the same dimensionsMm. The graph collects it in result artifacts. Missing/null files emit nothing.
- src/features/jarvis/core/types.ts: updates the graph mirror union so the existing port equality checks continue to hold.
- scripts/jarvis-demo/plate.py: optional USDZ converter seam probes pxr without installing it; files.usdz and top-level usdz remain null with usdzReason. No fake USDZ file is written.
- src/features/jarvis/ar/ar-support.ts: pure Quick Look, iPadOS, Android intent and standalone fallback adapter; browser capability probe is separate.
- src/features/jarvis/ar/ViewInArAction.tsx and ar.css: 44px neutral row, Quick Look image child, unsupported note, disabled installed-app row plus Safari share link, quiet loading and retry states. URLs are supplied by the caller; launch/fetch failures must be fed back through status/onRetry by the eventual viewer.
- src/pages/JarvisArPreview.tsx and src/App.tsx: lazy DEV-only /dev/jarvis-ar preview with MORE disclosure and persistent outline OPEN 3D. Fixture links use example.invalid intentionally; the preview is not a working model viewer or launch proof.
- src/features/jarvis/ar/ar-fixtures.ts: shared unit-test fixture data.
- Tests: server/design-graph/design-graph.test.ts, server/design-graph/cad-agent.test.ts, src/features/jarvis/ar/ar-support.test.ts, src/features/jarvis/ar/ViewInArAction.test.tsx, src/pages/JarvisArPreview.test.tsx.

## Verification

- `npx vitest run server/design-graph/design-graph.test.ts src/features/jarvis/ar/ar-support.test.ts src/features/jarvis/ar/ViewInArAction.test.tsx src/pages/JarvisArPreview.test.tsx`: PASS, 22 tests.
- `npx vitest run server/design-graph/cad-agent.test.ts -t 'publishes only supplied'`: PASS, 3 passed and 7 filtered/skipped. Covers absent, null and present USDZ; artifact order, MIME, URI, 101.6 mm edge metadata and result inclusion.
- Existing port tests: all 5 passed during `npx vitest run server/jarvis/design-graph-port.test.ts server/design-graph/cad-agent.test.ts -t 'publishes only supplied|design graph port|OVD'`. That filter also matched the CAD describe label, so it ran the existing timeout test and the combined command failed.
- Full requested initial targeted command (events/agent/support/component files): 27 passed, 3 real-CAD tests skipped, 1 existing timeout test failed. The timeout test expects `worker timed out after 300 ms`, but receives `worker exited 1 without a result`. It also fails in isolation. A disposable direct CLI reproduction exited 1 with empty stdout/stderr. The timeout path never calls plate.py in this fixture; its implementation was not modified. Cause remains unresolved; a host process-group limitation is possible, not proven. Do not treat the full file as passing. No more retries of that failure family were attempted after the repeated failure threshold.
- Three existing real-CAD tests skip because the required configured Python/build123d runtime is unavailable. No Python test for plate.py was found, so no Python tests were added per task. Python ast.parse syntax check: PASS.
- `npm run lint`: PASS (exit 0).
- `npm run typecheck`: PASS (exit 0). First run identified the mirror union and existing signature lookup, both corrected.
- `git diff --check`: PASS.
- No full e2e, Playwright, build, full test suite or dependency installs run. Browser layout and native device evidence remain unverified.

## Placeholders and open proof

- No USDZ conversion implementation or dependency was added. Even with pxr installed the seam records a reason and no artifact, because pxr alone is not a GLB importer. A separately approved converter is required to deliver both exports. USDZ absence does not fail existing STEP/GLB checks or imply AR readiness.
- Converter contract: preserve STEP millimeter coordinates and shared origin, export Y up, USD metersPerUnit=0.001. This is a documented requirement, not a verified property of the current GLB pipeline. AR-2 tests here prove event metadata only.
- AR-1 / AR-2: once conversion is approved, validate the same exported pair with gltf-validator and usdchecker. Inspect scene transforms, axis orientation, origin and unit metadata; measure world-space physical bounds to prove the 101.6 mm edge (including GLB meter semantics and USD unit conversion). Preserve reports alongside exact worker/tool versions and source revision. Do not infer scale from event dimensions.
- AR-3 / AR-4: logic passes; real iPhone Safari Quick Look and Android Chrome/ARCore launches remain open. Verify signed URLs are externally reachable and live long enough for native viewers. Check the fallback route opens the 3D viewer, including missing ARCore.
- Installed iOS PWA: target=_blank share link is a best-effort Safari exit; forcing Safari is platform dependent and requires device proof. The explanatory note remains visible.
- AR-5: pure/component desktop hide behavior passes; browser/device placement proof remains open.
- AR-6 / AR-7: expiration 403 and another user's artifact access 403 belong to the artifact-serving issue. No server storage/auth policy, migrations, RLS or environment changes were made here. Callers supply short-lived signed artifact URLs.
- OVD-804 integration: replace or extend the small detection/launch adapter with model-viewer's canActivateAR/activateAR after that parallel branch lands. No model-viewer import, dependency, package or lockfile change here. Mount the row in the real result MORE sheet and connect loading/failure/retry to the viewer; keep its authoritative STEP banner there.
- Source implementation is below the approximately 200-line guideline excluding tests/fixtures. No PR was opened and no Git mutation beyond working-tree edits was performed. Operator owns commit and publication.

PR-ready summary: Add optional USDZ graph artifacts and a dependency-free AR row behind a dev-only MORE sheet preview. Keep conversion and signed serving as explicit follow-ups; cover device routing, UI states and artifact metadata with targeted tests. Existing CAD timeout check remains unresolved in this host.
