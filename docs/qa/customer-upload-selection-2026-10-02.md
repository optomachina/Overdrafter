# Synthetic customer workflow QA

Owner: task `01a0fae5-d8ff-74ca-9131-e762f8674037` (Verify customer quoting workflow), local Mac executor.
Worktree: `/Users/blainewilson/Documents/Codex/2026-10-01/task-14/qa-worktree`.
Branch: `qa/customer-workflow`; source: `278122145914dadb1e0f7c89385d764965f9762f`.
Exclusive scope: frontend upload admission and validation. No shared Jev, provider, commercial contract, migration, settings, credential, or production modifications.
Completion: reproduce upload interruption/repetition/empty-input behavior in a real browser, repair demonstrated defects, exercise synthetic comparison/selection, commit and report exact evidence/limits.
Budget: one local Vite server on 127.0.0.1:4187, one isolated Playwright browser session, no containers; bounded manual QA session. Failure family: upload admission.

## Reproduced defects

On `/parts?fixture=client-quoted&debug=1`, intercept loopback backend calls: return synthetic eligible access; delay intake by 600ms and return 503. Select the same nonempty synthetic STEP twice while pending. Before repair, `api_prepare_part_intake` was called twice. The picker reset the input before awaiting access and had no shared pending guard. Users could start overlapping intake attempts and receive duplicate errors or create overlapping draft work.

Select a zero-byte `qa-empty.step`. Before repair, intake was called once. Empty files reached backend processing instead of actionable validation feedback.

## Repair

The picker now claims a pending selection synchronously before access refresh, blocks a second selection/open attempt with feedback, and releases the claim in `finally` after success, denial, validation, or failure. Validation rejects zero-byte files while retaining accepted files from mixed batches.

## Evidence

- Real browser baseline: repeated intake calls = 2; empty intake calls = 1.
- Same browser reproduction after repair: repeated intake calls = 1; empty intake calls = 0.
- Regression test covers cancellation, empty-file rejection, pending repetition, interrupted upload, and valid retry.
- Local evidence scripts/screenshots: `output/playwright/` (ignored artifacts; preserved in task workspace).

## Boundary

Backend and storage responses are synthetic browser interceptions. The comparison uses existing synthetic workspace fixtures; no extraction, real quote execution, customer upload, provider link, order, publication, merge, or deployment is performed. This verifies frontend behavior, not live end-to-end service integration.

## Verification receipt

- PASS: five targeted files, 16 tests (`use-client-job-file-picker`, `uploads-api`, `upload-groups`, `QuoteSelectionSurface`, `QuoteSelectionFunctionBar`).
- PASS: current comparison/decision components, 32 tests (`ClientQuoteComparisonChart`, `ClientQuoteDecisionPanel`). Subtotal: 48 tests.
- PASS: sourcing validity classification, 30 tests (`sourcing-result`). Total: 78 tests.
- PASS: `npm run typecheck`; changed-file ESLint; `git diff --check`; `npm run build` (existing chunk-size warning only).
- PASS: synthetic successful upload traversed prepare intake, create draft, prepare upload, storage upload, finalize upload, reconcile parts, and request extraction; reached `/parts/fx-job-published`. These responses were all intercepted, not actual service outcomes.
- PASS: explicit published fixture URL, US-only empty state, All sourcing recovery, repeated mouse/Enter selection, Balanced/Fast/Cheap switches. Selected row retained `aria-selected=true`; viewport 390×786 had no document overflow. Screenshot `output/playwright/selection-phone.png` visually inspected.
- PASS: client-empty fixture displayed `No matching parts` with Upload available. Screenshot capture timed out; accessibility snapshot retained.
- PARTIAL: automatic upload handoff loses the fixture query and leads to sign-in because no backend session exists. Comparison was therefore tested on its explicit fixture URL, not claimed as a fully connected service journey.
- CLASSIFIED: in the published fixture, enter `2020-01-01` in `Need by date`, then Clear. The field clears, but no quote rows return; the initial browser expectation of recovery timed out. Source tracing explains this: `ClientPart` persists the date through `handleSaveRequestPatch`; fixture `syncFixtureProjectPartState` advances the approved/override revision timestamp; `sourcing-result.ts` rejects offers captured before the latest requirement revision. Clearing the date does not undo that revision. Existing sourcing tests explicitly require invalidation after a client override. No commercial quote validity logic was changed, and no replacement quote was requested. Evidence: `output/playwright/empty-snapshot.txt`, `comparison-recovery.js`.

Verdict: PASS for the two repaired upload defects; PARTIAL for the complete customer journey. No release/merge readiness claim and no monolithic integration gate run. Current browser/tool chain: local Vite 5.4.19, cached Playwright CLI 0.1.21, Chromium, synthetic loopback interceptions. Baseline and repaired observations captured 2026-10-02 UTC.

Cleanup: isolated Playwright session closed and owned Vite process stopped. Worktree, commit, and ignored evidence files retained for parent review.
