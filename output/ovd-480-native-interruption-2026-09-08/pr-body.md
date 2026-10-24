## Linear issue ID

- Issue: OVD-480; bounded native interruption prerequisite for OVD-479.

## Summary

Extend the existing default-off lifecycle driver with one explicitly admitted read-only synthetic interruption/recovery fixture. The driver records an immutable checkpoint, interrupts only its directly started retained native process, then verifies a separate private baseline copy in a fresh process.

## Problem

An owned empty-session lifecycle does not prove behavior when native execution is interrupted. The next qualification step needs separate interrupted and recovery attempts, exact file/process bindings, preserved failure state and measured read-only results before broader recovery claims are possible.

## Acceptance criteria addressed

- [x] Require an explicit interruption opt-in, empty initial native inventory and the two exact native04 synthetic source identities.
- [x] Reuse the owned-process/lifecycle boundaries and extract the previously demonstrated cylinder reader.
- [x] Preserve independent input manifests, a flushed pre-interruption checkpoint and separate attempt results/logs.
- [x] Gate termination on fresh identity and completed read-only verification; stop on ambiguous or unconfirmed effects.
- [x] Complete exact-source Windows compilation/admission tests and the one live interrupted/fresh-read-only case.

## Files changed

- `scripts/native/session-lifecycle/lifecycle.ps1`: explicit opt-in, source packaging and reused native startup/shutdown helpers.
- `scripts/native/session-lifecycle/InterruptionCase.ps1`: pinned private copies, immutable records, retained-object interruption and separate recovery.
- `scripts/native/session-lifecycle/NativeSessionProbe.cs`: fixture modes using the existing native/API identity checks.
- `scripts/native/session-lifecycle/PreparedCylinder.cs`: read-only inspection, existing extrusion/geometry checks and owned-reference cleanup.
- `scripts/native/session-lifecycle/README.md`, `docs/solidworks-2022-feasibility.md`: workflow, source lineage and claim boundaries.

## Scope

One trusted native04 cylinder and the observed SolidWorks 2022 environment. In-memory rebuild is part of verification; no save or dimension edit occurs. This increment does not implement interrupted-save repair, arbitrary CAD inputs, worker leases, separate-profile containment, PDM publication or customer execution.

## Verification

Commands run:

```bash
npm run verify
git diff --check
codex review --base origin/main
```

Results:

- [x] Repository verification passed, including lint/typecheck, tests, app build and worker verification.
- [x] Local full-diff review and the independent native-control-flow review found no actionable issue.
- [x] Read-only Windows preflight found no native process, unchanged original synthetic fixtures, pinned binaries, and PS5.1 hashing-command resolution.
- [x] Windows compilation and four actual inert driver denials passed.
- [x] Final-source reset sentinel and one live interruption/fresh-read-only case passed; outer exit 0 in 31.260 seconds, interrupted native exit -1, fresh recovery native exit 0, final inventories empty.
- [x] Both original synthetic files and both private inputs retained their byte hashes.
- [x] Independent evidence review passed 72 checks with no contradictions, including 34 raw-record hashes and the six source hashes against Git.
- [x] Final documentation-head CI and Sonar passed; direct Sonar issue query returned zero.
- [x] CodeRabbit reviewed all six files through final head4216c2af with no actionable comments; zero review threads remain. Generic docstring-coverage percentage warning is non-authoritative under docs/code-review.md. No concrete documentation finding was raised.

Baseline failures or exceptions: repository checks cannot compile/run SolidWorks. The native test must supply separate exact-source evidence. Windows 11 Home remains the user-approved experimental environment, with broader deployment/entitlement and isolation qualification still open. Runtime commit labels are caller claims; source byte hashes were checked independently against Git. Native measurements and binary hashes remain executor-reported. Exact termination timestamps and separate raw sentinel assertions are absent; chronology relies on pinned source order and recorded observations. This review checks evidence consistency, not independent native re-execution.

## Tests

The Windows lane compiled the actual sources and passed default-off/old-process-adoption/stale-binding/wrong-baseline denials. It then passed an inert launch-reset sentinel and one owned interruption with a separately identified fresh-session read-only recovery. Local repository verification passed 326 test files, 3,800 tests and one intentional skip. The shared process and file predicates are unchanged. Native observations, partial failures and original file hashes remain individual evidence, rather than one generic successful status.

## Migration notes

- [x] No migration impact.

## Rollback / risk notes

Withdraw the new opt-in and probe modes to remove this internal capability; no service or database rollout is involved. Only the retained process directly created by this attempt can be targeted. The native inspection and interruption remain sequential, requiring an interval without concurrent operator interaction in the shared profile. An unconfirmed native exit stops execution for reconciliation; no broad cleanup is attempted. Interrupted saves and application recovery dialogs remain unqualified.

## Documentation

- [x] Docs updated with invocation, exact-source lineage, separate attempt/evidence semantics and limitations.

## Screenshots or videos (if UI)

Not applicable — no material UI impact. Source packets, review logs and complete Windows receipts are retained under `output/ovd-480-native-interruption-2026-09-08/` in the preserved coordinating worktree and corresponding Windows attempt directories. The single rolling OVD-480 comment carries status and evidence references. Live receipt: 193,397 bytes, SHA256 `a73d62181df3e9c85714efa16f28e6f83c41f93a21c37fb3d0ff16d64f771762`; compilation/denial receipt: 11,603 bytes, SHA256 `33f4d789c27b95a92263339f040810034845d3d97fa555f8647f5e582abcaa08`. Live executable sources bind commit `939a1b9d318ebedb3d10c3949ca03e139df6c3af`; the following commit changes documentation only.

## Follow-up items

- [ ] Broader isolation, legitimate licensed capacity, serialized jobs, prepared assemblies and interrupted native saves remain separate qualification work; full OVD-480 remains In Progress.
