## Linear issue ID

- Issue: OVD-476

## Summary

Add an internal engineering-domain contract that binds a request and its CAD/non-CAD evidence to exact source, decision, requirement and toolchain identities. Record the approved staged control-plane architecture while preserving the current Part-to-Quote release.

## Problem

Accepted engineering intent needs an identity independent of CAD execution. Existing package completeness and artifact review cannot safely stand in for engineering verification or authoritative adoption.

## Acceptance criteria addressed

- [x] Shared generic request/statement/artifact contracts represent dimension changes, substitution and DFM/DFA inspection.
- [x] Exact scoped identities reject malformed quantities/hashes, conflicting decision versions and cross-scope references.
- [x] Unknown, conflicting and stale evidence remain explicit; snapshots are owned, frozen and canonically represented.
- [x] Architecture and test expectations document later state, native qualification and publication gates.

## Files changed

- `src/lib/engineering-domain.ts` and its tests.
- `docs/engineering-control-plane.md`, plus ARCHITECTURE, PLAN and TEST_STRATEGY pointers.

## Scope

Internal pure TypeScript contracts and technical documentation only. No database migration, public endpoint, UI import, CAD execution, provider traffic, new dependency or production capability activation. Supplied hashes remain claims; this module does not verify native file bytes or grant authority.

## Verification

Commands run:

```bash
npm test -- src/lib/engineering-domain.test.ts src/lib/north-star-domain.test.ts
npx eslint src/lib/engineering-domain.ts src/lib/engineering-domain.test.ts
./scripts/symphony-preflight.sh
npm run verify
npm test -- scripts/deploy-cloud-run-contract.test.mjs scripts/ovd420-recovery-egress-control.test.mjs src/pages/CommercialAccountDetail.test.tsx src/components/admin/commercial/CommercialEntitlementControls.test.tsx --maxWorkers=2
npm run build
npm run verify:worker
codex review --uncommitted
git diff --check
```

Results:

- [ ] all listed verification passed
- [x] unrelated baseline failures are described below

57 focused tests passed (51 new, 6 existing); lint, preflight, build and worker verification passed. Full verification passed migration/provider checks, lint and typecheck, then reported 3,660 passing tests, four five-second timeouts and one skipped test. All 119 tests in those four unchanged test files passed in the bounded-concurrency rerun. The full canonical gate is not claimed green. Local Codex review found a TypeScript inference failure; its explicit-generic fix is applied and subsequent typecheck passed. No other local review findings. Hosted CI passed on the original foundation commit. The four subsequent Sonar maintainability findings were corrected with behavior-preserving changes; 57 focused tests, targeted lint and typecheck passed again. Sonar now reports zero open findings on fa93fbb6. Final hosted checks and CodeRabbit review are tracked on the PR.

Current-main landing refresh: `9fb41264` includes main `2a6de82d` plus focused review fixes. CodeRabbit completed its review of the preceding head; all three actionable findings and its documentation nit were addressed, independently reviewed and resolved. Four new conflicting-document cases failed before the fix and pass now. All 61 focused tests pass. The complete canonical `npm run verify` passed on the corrected head, including migration/provider checks, lint, typecheck, the full test suite, app build and worker verification. The earlier timeout remains historical evidence, not the final result. CodeRabbit rate-limited the new-head automated review; no completed repeat review is claimed. All fresh hosted gates passed, including required ci, full tests, browser, build, worker and Sonar quality. GitHub confirmed the exact-head squash merge as a33e966d on September 8.

## Tests

51 new cases cover generic request shapes, native and calculation evidence, source/decision/requirement/toolchain/policy identity changes, canonical ordering, immutability, malformed values and cross-scope denial. These are synthetic contract tests, not native CAD qualification.

## Migration notes

- [x] No migration impact
- [ ] Migration impact exists and is described below

## Rollback / risk notes

The new module has no production imports. Reverting this commit removes the foundation without changing existing runtime behavior. High complexity because this introduces an internal engineering contract. The user approved the staged architecture and explicitly instructed landing this defined stack on September 8. The accepted decomposition remains; this PR contains only the bounded foundation.

## Documentation

- [x] Docs updated
- [ ] No doc updates needed

## Screenshots or videos (if UI)

Not applicable — no material UI impact.

## Follow-up items

- [ ] OVD-472 state model and OVD-470 transaction preflight in separate changes.
- [x] Fresh hosted quality gates and exact-head merge completed; review findings and the local canonical gate are resolved.
- [ ] Windows/SolidWorks qualification, persistent service, native execution and customer pilot remain separate gates.


<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

- **New Features**
  - Added a documented foundation for tracking engineering requests, decisions, evidence, artifacts, verification, and approval across staged workflows.
  - Added immutable snapshots with deterministic identity handling and strict validation for engineering data.

- **Documentation**
  - Documented orchestration architecture, adoption boundaries, pilot scope, qualification gates, and future native-environment requirements.
  - Clarified that these changes do not alter the Part-to-Quote release, customer CAD pilot, or production execution capabilities.

- **Tests**
  - Added coverage for validation, identity consistency, evidence handling, stale results, and snapshot immutability.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->