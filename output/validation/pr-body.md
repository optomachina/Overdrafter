## Linear issue ID

- Issue: OVD-495 — https://linear.app/overdrafter/issue/OVD-495

## Summary

Bind successive prepared dimension changes to the exact verified predecessor package. Add a default-off Workstation qualification that executes the synthetic 5 → 8 → 9 → 7 mm chain and checks that every earlier package remains intact.

## Problem

Reusing the original baseline for every request would discard previously accepted changes. A successor must match its actual input snapshot, files, depth, attempt and mandatory evidence, while existing v1 operator and recovery readers continue to work.

## Acceptance criteria addressed

- [x] V2 scope, lineage, request/context/file digests and eligible attempt/fence validation.
- [x] Mandatory verification and stored evidence before constructing a successor snapshot.
- [x] Separate v1 compatibility and pinned default-reader initialization.
- [x] Native runner takes exact predecessor bytes and measured before-depth.
- [x] Real Windows compilation and cumulative SolidWorks qualification: 5 → 8 → 9 → 7 mm, all21 mandatory checks passed.

## Files changed

- src/lib/engineering-cumulative.ts and its test: strict cumulative protocol and successor construction.
- scripts/native/.gitattributes: preserve source bytes on Windows checkout.
- scripts/native/prepared-dimension: v2 wire validation, native package identity/measurement binding, run integration and qualification/contract tests.
- scripts/native/prepared-preview/run.ps1: complete shared lifecycle compiler dependencies.
- docs/engineering-automatic-loop.md, PLAN.md, TEST_STRATEGY.md and native README: milestone and qualification boundaries.

## Scope

Prepared synthetic assembly, Default configuration, absolute depth6–10mm, one predecessor chain. High complexity under the explicitly approved staged milestone. This source does not activate the service, issue credentials, claim jobs, admit customer files or publish a design.

## Verification

Commands run:

```sh
npm run test -- src/lib/engineering-cumulative.test.ts src/features/engineering
output/runtime/powershell/pwsh -NoProfile -File scripts/native/prepared-dimension/test-contract.ps1
npm run verify
git diff --check
```

Results:

- [x] all listed verification passed
- [x] unrelated baseline failures are described below

The current-main rebase passed236 targeted tests and35 inert PowerShell Core7.6.6 assertions. Full repository checks passed338 files,4197 tests,1 skipped, plus lint/typecheck/build and worker verification. Existing warning output remains; no unrelated failing check was waived. The actual test counts are retained in output/validation/verify-rebased.log.

Independent local full and incremental reviews found no remaining actionable defect after the shared reader and compiler closure fixes. Native source is byte-identical across the rebase; the PLAN conflict retained both decision-log entries. The separate Workstation run established actual Windows compilation and SolidWorks execution as recorded below.

## Native qualification

Exact source e3264e167526ec417e091f1079c4ecaa7e83fca5 passed one direct qualification with exit0 on x64 Desktop PowerShell5.1.26100.9278 and SolidWorks2022 SP5 30.5.0.0049. Measured depth5→8→9→7 mm; volumes1570.7963268→2513.2741229→2827.4333882→2199.1148575 mm³. All seven mandatory checks passed for each step; exact predecessor lineage and source/earlier-package preservation verified. Three native processes and fresh pinned-input readers exited0; final SolidWorks inventory empty. Retained qualification.json SHA256 f8723f76fc98b63bb63aab22828f3b578ae4a30408b214a66eb48a7b89316829; paths and readback are recorded in the native README and rolling OVD-495 comment. This proves the synthetic operator chain, not authenticated dispatch or customer qualification.

Earlier attempts stopped before native launch: the child inherited incompatible Core module paths, then Windows Git materialized a pinned helper with CRLF. Child-only environment normalization and scoped LF checkout rules corrected these causes without changing machine settings or weakening hashes. A disposable Git regression reproduced and verified the source-byte fix; independent review passed. Failed evidence is retained.

## Tests

51 cumulative cases cover malformed scope, units/depth, predecessor and snapshot identities, evidence membership, stale/late attempts and failed prerequisites. Existing conversation/workflow/preview tests passed. PowerShell contract tests cover the wire boundary without native actions. The Windows harness checks all seven native checks, measured depth/volume, exact evidence bytes, earlier package preservation and a fresh-process pinned recovery reader.

## Migration notes

- [x] No migration impact
- [ ] Migration impact exists and is described below

No schema change or new dependency. Native v2 remains separate from current v1 operator imports.

## Rollback / risk notes

Keep the default-off qualifier disabled and revert the source if necessary; preserve outputs for reconciliation. The qualifier stops after any failed child, performs no automatic retry and does not close pre-existing SolidWorks processes. The prepared synthetic chain passed its Windows gate; unrelated runtime/operation envelopes remain unqualified. Candidates remain unadopted.

## Documentation

- [x] Docs updated
- [ ] No doc updates needed

Documented the full automatic-loop objective, staged delivery, cumulative contracts and distinction between operator proof and authenticated durable execution.

## Screenshots or videos (if UI)

Not applicable — no material UI impact. Actual native qualification records are required separately before landing.

## Follow-up items

- [x] Compile and execute the pinned source on Workstation with the synthetic package.
- [x] Inspect native outputs, source preservation and failure evidence.
- [x] Complete hosted quality/reviews; merged3aa622a2 after resolving the mistaken companion-index finding.
- [ ] Durable dispatcher, connected companion, bounded AI, live UI and controlled activation remain part of the overall milestone.
