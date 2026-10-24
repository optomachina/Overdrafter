## Linear issue ID

- Issue: OVD-470

## Summary

Validate prepared CAD change proposals against exact context, permitted operations, required outputs/checks and observed execution limits before a future native worker is invoked.

## Problem

A plausible operation list can use stale component mappings, omit required verification, collide with another job or exceed its budget. Eligibility must be deterministic and remain separate from native correctness and execution authority.

## Acceptance criteria addressed

- [x] Pin snapshots, source artifacts/configurations, capability versions, ordered operations, mandatory outputs and required checks.
- [x] Reject stale sources/maps, unsupported operations, conflicting workspaces and malformed/over-budget proposals.
- [x] Preserve replay order and describe quarantine/restart recovery without native binary merge or atomic external rollback.
- [x] Return eligibility with executionAuthorized:false and nativeValidated:false.

## Files changed

- `src/lib/engineering-preflight.ts` and its behavioral tests.
- `docs/engineering-control-plane.md`: implemented preflight semantics and runtime limitations.

## Scope

Pure internal preflight stacked on OVD-472 / PR #464. Supports declared dimensions, approved component addition/replacement, optional suppression and versioned DFM/DFA review contracts. No native calls, file writes, actual lock acquisition, spending, persistence, authenticated endpoint, approval/export or PDM effects. Caller-supplied observations and hashes require future trusted runtime enforcement.

## Verification

Historical source-head commands run:

```bash
npm test -- src/lib/engineering-preflight.test.ts src/lib/engineering-domain.test.ts
npx eslint src/lib/engineering-preflight.ts src/lib/engineering-preflight.test.ts
npm run verify:migration-lineage
npm run provider:check
npm run lint
npm run typecheck
npm test -- --maxWorkers=2
npm test -- src/components/quotes/ManualQuoteIntakeCard.test.tsx --maxWorkers=1
npm run build
npm run verify:worker
codex review --commit 26a2b8c7c4c56f699bdb7280793681142472e7df
git diff --check
```

Results:

- [x] all listed verification passed
- [x] unrelated baseline failures are described below

126 focused tests passed (75 preflight and 51 domain). Migration lineage, provider catalog checks, root lint/typecheck, app build and worker verification passed. Local Codex review found no actionable regressions. Complete bounded tests reported 3,747 passed, one skipped and one five-second timeout in the unchanged ManualQuoteIntakeCard legacy-request test. All nine tests in that unchanged file passed on the isolated rerun; the failed aggregate run is not claimed green. A subsequent complete two-worker run with compilation finished passed all 3,748 tests, with one skipped, across 326 files. Sonar maintainability findings were corrected through 2c317896 without behavior changes; the latest analysis reports zero open issues. All 135 engineering tests, root typecheck and targeted lint passed again. All hosted CI jobs passed on 2c317896, including test, browser, build, lint/typecheck, worker, extraction and recovery-network checks. CodeRabbit review is rate limited, so that review gate remains open.

Landing preparation:

Independent bounded review of the incremental OVD-470 preflight slice reported no actionable findings. CodeRabbit is rate limited; the current review inventory has zero actionable CodeRabbit threads. This records review availability and actionable-thread status without claiming that CodeRabbit completed a review.

Current-main refresh: head `bc3a678d1409d208805214b1189303a92e62698b` is based on merged state `259839a9`. Range-diff confirms all three preflight patches are unchanged. All 139 engineering tests, scoped lint, root typecheck, app build, whitespace checks and preflight passed. The full canonical verification passed on the foundation; this unchanged increment has targeted checks and a fresh hosted full-suite run. All fresh hosted gates passed, including required ci, full tests, browser, build, worker and Sonar quality. Fresh review-thread inspection confirms no actionable threads. No actionable review threads exist; CodeRabbit remains rate-limited, while local Codex and independent review supply the actual review handoff.

## Tests

75 new cases cover every supported operation, exact hashes/versions/scope/configuration, units/ranges, unknown operations/fields, mandatory outputs/checks, mappings, optional suppression, parent cycles/suppression/replacement invalidation, operation order, physical workspace conflicts, positive fencing tokens, retry/deadline limits, batch spending, immutable results and no authority/native-success claims.

## Migration notes

- [x] No migration impact
- [ ] Migration impact exists and is described below

## Rollback / risk notes

No production imports or dependencies. Revert this slice to remove preflight. High complexity under the repository policy because this introduces shared internal preflight contracts, despite its bounded implementation. The user approved the staged plan and subsequently gave explicit “Do it” landing authority for this PR stack. Preserve that bounded decomposition; this approval does not expand the slice into native execution or production authority. Eligibility cannot substitute for measuring file bytes, acquiring a real lease, observing current source state or verifying native outputs. A subsequent native executor must enforce the pinned contracts again at dispatch.

## Documentation

- [x] Docs updated
- [ ] No doc updates needed

## Screenshots or videos (if UI)

Not applicable — no material UI impact.

## Follow-up items

- [x] Fresh hosted gates and exact head confirmed before merge.
- [ ] Qualified SolidWorks 2022 Workstation inspection/execution, persistent scheduling, verification artifacts and candidate export remain separate stages.
