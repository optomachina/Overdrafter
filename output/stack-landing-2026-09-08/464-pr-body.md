## Linear issue ID

- Issue: OVD-472

## Summary

Record accepted engineering decisions independently of CAD progress. Tasks retain exact immutable inputs, explicit prerequisite/output provenance, complete check sets and unadopted status as new decisions arrive.

## Problem

A single revision frontier cannot distinguish requested changes, running work, verified results and authoritative CAD. Superseding a decision must invalidate dependent eligibility without inventing a stopped worker or erasing previous evidence.

## Acceptance criteria addressed

- [x] Separate decision, execution, verification and adoption dimensions.
- [x] Record five decisions while an earlier job runs without changing its input identity.
- [x] Reject stale/conflicting commands and preserve history through supersession.
- [x] Require every exact mandatory check; success never adopts or replaces the baseline.

## Files changed

- `src/lib/engineering-state.ts` and its behavioral tests.
- `docs/engineering-control-plane.md`: implemented semantics, limitations and user-selected SolidWorks 2022 qualification target.

## Scope

Pure internal state reducer, stacked on OVD-476 / PR #462. The caller must use a state returned by this module. This does not implement database persistence, an authenticated API, durable leases, native dispatch, worker cancellation, historical late-result quarantine, approval/export or PDM publication. Source and evidence hashes remain caller-supplied claims.

## Verification

Historical source-head commands run:

```bash
npm test -- src/lib/engineering-state.test.ts src/lib/engineering-domain.test.ts
npx eslint src/lib/engineering-state.ts src/lib/engineering-state.test.ts
npm run typecheck
npm run build
codex review --commit 32c73f0f0da315135c91576f415185d2b1ff4c55
git diff --check
npm run verify
npm test -- --maxWorkers=2
```

Results:

- [ ] all listed verification passed
- [x] unrelated baseline failures are described below

60 tests passed (9 new state scenarios and 51 domain cases). Lint, typecheck and build passed. Local Codex review found no actionable regression. Full repository verification passed migration/provider checks, lint and typecheck, then stopped on four five-second timeouts in unchanged provider-check, workerDependencyCompatibility, xometryProfileSnapshot and persistentProfileLock tests: 3,669 passed, four timed out, one skipped. The complete two-worker test run passed: 3,673 passed and one skipped across 325 files. The default-concurrency canonical command is not claimed green. At that source-head checkpoint, hosted checks and automated review remained pending.

Landing preparation:

Independent bounded review of the incremental OVD-472 diff (`fa93fbb6` → `32c73f0`) reported no actionable findings, covering supersession, stale attempts, revisions and organization identity. CodeRabbit is rate limited; the current review inventory has zero actionable CodeRabbit threads. This records review availability and actionable-thread status without claiming that CodeRabbit completed a review.

Current-main refresh: head `dc9701b924e0627a10265b31e88b484135d971a9` is based on merged foundation `a33e966d`. Range-diff confirms the state patch is unchanged. All 70 focused domain/state/North Star tests, scoped lint, root typecheck, app build, whitespace checks and preflight passed. Full canonical verification passed on the immediately preceding foundation; this unchanged state increment has its targeted checks and fresh hosted full-suite run. All fresh hosted gates passed, including required ci, full tests, browser, build, worker and Sonar quality. Fresh review-thread inspection confirms no actionable threads. No actionable review threads exist; CodeRabbit is unavailable due to rate limiting, and local Codex plus independent code review supply the actual review handoff.

## Tests

Behavioral scenarios cover five queued decisions, CAS collisions, transitive verification blocking, independent results after failure, supersession while running, exact input-source provenance, swapped attempts/fences/context, malformed queues, missing/failed checks and immutable deterministic replay. Synthetic scenarios do not qualify SolidWorks.

## Migration notes

- [x] No migration impact
- [ ] Migration impact exists and is described below

## Rollback / risk notes

The module has no production caller. Revert this slice to remove the reducer. High complexity under the repository policy because this introduces shared internal state contracts, despite its bounded in-memory implementation. The user approved the staged plan and subsequently gave explicit “Do it” landing authority for this PR stack. Preserve that bounded decomposition; this approval does not expand the slice into native execution or production coordination. Integration must still enforce real authorization, compute artifact hashes and capture terminal observations truthfully; it must not treat this reducer as a production coordinator.

## Documentation

- [x] Docs updated
- [ ] No doc updates needed

## Screenshots or videos (if UI)

Not applicable — no material UI impact.

## Follow-up items

- [x] Fresh hosted gates and exact head confirmed before merge.
- [ ] Integrate separately reviewed persistence, cancellation/late-result handling and native qualification.
- [ ] Land OVD-470 prepared-operation preflight as its separately validated stacked slice.
