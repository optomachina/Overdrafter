## Linear issue ID

- Issue: OVD-480

## Summary

Add a default-off runner that owns an empty SolidWorks process from direct launch through verified normal exit. One live run passed on the Workstation with SolidWorks 2022: it closed the identified empty session, started a new session, waited for API readiness, and confirmed normal shutdown in 16.2 seconds.

## Problem

The existing process harness owns its helper child, but COM can reach a separately owned SolidWorks session. Interrupted native-work testing first needs a direct native launch, retained process identity, API binding, and confirmed exit. GUI input-idle alone does not establish API readiness.

## Acceptance criteria addressed

- [x] Require explicit admission and exact identity; record fresh attempt locations and source/compiler/binary hashes.
- [x] Close normally only after current native/API identity and zero-document checks.
- [x] Directly start and retain the new native process, tolerate only classified startup-not-ready observations within a fixed budget, and confirm normal exit separately from helper exit.
- [x] Demonstrate final-source default-off and stale-identity rejection, then one successful empty-session lifecycle on Windows.
- [x] Preserve evidence and distinguish this bounded result from full worker qualification.

## Files changed

- `scripts/native/session-lifecycle/NativeSessionProbe.cs`: typed identity, startup and empty-session inspection with guarded normal exit.
- `scripts/native/session-lifecycle/lifecycle.ps1`: admission, process ownership, bounded readiness, compilation and receipt coordination.
- `scripts/native/session-lifecycle/README.md`: invocation and qualification limits.
- `docs/solidworks-2022-feasibility.md`: observed lifecycle result and remaining gaps.

## Scope

One standalone empty-session qualification runner. The shared process helper is unchanged. CAD-file operations, forced native termination, interrupted-save recovery, licensed scheduling, production deployment and PDM publication remain outside this increment.

## Verification

Commands run:

```bash
npm run verify
git diff --check
```

Results:

- [x] Repository verification passed: 326 test files; 3,800 tests passed and one skipped; lint/typecheck, application build and worker verification passed.
- [x] The lifecycle source correlated to d99d7772 compiled and ran on Windows. Default-off and stale-identity cases rejected before native work. The live wrapper exited 0 in 16.2196468 seconds; original PID 5968 and owned PID 5880 both exited normally with code 0.
- [x] Six classified COM-not-ready probes preceded verified API readiness. Final CIM and .NET native-process inventories were empty; both synthetic fixtures and execution-policy observations were unchanged.
- [x] Independent receipt review passed 31 checks. The 28,836-byte raw packet matches SHA256 `c837074fcf02b747c320af8c638cd0d5738177134333b12ff78b840a4d976810`; all three live-tested source byte strings match d99d7772's Git blobs. The later 7ee9b2b1 change adjusts failure reporting only; its Windows inert regression checks passed, with the initial harness failure preserved. It does not retroactively replace the live-tested source.
- [x] Local review's startup-readiness finding was fixed; the second local review found no actionable defects.
- [x] Hosted CI, browser checks, worker checks and Sonar quality passed on `d99d777249fa9333ff4dad9d4cc3a2025d5c9102`. Fresh hosted checks also passed on reporting correction `7ee9b2b1ecebe5e46a4bdb69a118541bbab14aa8`, with zero open Sonar findings.

Baseline failures or exceptions: local repository verification does not compile C# or run SolidWorks; Windows compile/execution supplies that evidence. Sonar reports no open issues and indexes the PowerShell runner; it does not index the C# probe, whose evidence is Windows compilation/execution and source review. Native observations are executor-reported and locally checked for internal consistency. Runtime SourceCommit remains null; later source-to-Git matching is recorded separately. This is the user-approved experimental Windows 11 Home environment, not full supported-deployment qualification.

## Tests

Hosted review found that inert denials incorrectly requested native recovery. The correction initializes and records native-close intent before helper dispatch, then gates recovery on native start/close attempts while preserving existing uncertainty. A scoped independent source review found no defects; Windows reported all four start/close combinations, repeated errors and preservation of an existing true flag passed before the initial harness stopped on Get-FileHash resolution. A separate repair replaced only harness hashing with .NET SHA256 and passed both remaining top-level denials: default-off exit 1, invalid PID-zero/ticks-one binding exit 2 with recovery false and no compile/observations. The repair outer process exited 0 in 1.1735162 seconds; no new native action occurred. Raw repair receipt SHA256 is `88fc3322d0e09039820c9c5800af288a329321c672c1f35794021152e960e21b`. The underlying launch-context difference for command resolution remains unconfirmed; no module-path or policy changes were made. Optional centralization of the single fixture's fixed pins and additional COM-busy retry classifications are deferred: current pins fail closed, and new retry conditions require qualification.

The Windows batch exercised default-off rejection, stale process identity, startup-not-ready handling and one clean owned native lifecycle. Receipts preserve all terminal helper results, unsuccessful earlier attempts and final native inventories. The independent local validator checks packet/source identity and the 31 reported invariants. No application test was added because this runner is outside the application runtime; the existing repository suite and hosted checks passed.

## Migration notes

- [x] No migration impact.

## Rollback / risk notes

Removing the standalone runner withdraws the capability; no application or database rollout is involved. An admitted invocation normally closes an explicitly identified empty session and starts/closes a new native process. The final document check and shutdown are sequential, requiring an interval without concurrent operator interaction. Unknown native exit stops the run for reconciliation. The Windows profile and application startup settings are shared; filesystem/network isolation and native interruption recovery are still unproven.

## Documentation

- [x] Docs updated with ownership boundaries, invocation, readiness policy, actual Windows evidence and remaining qualification work.

## Screenshots or videos (if UI)

Not applicable — no material UI impact. Raw receipt, source packet, logs and independent validation remain in `output/ovd-480-native-recovery-2026-09-08/` in the preserved coordinator worktree. The rolling OVD-480 comment retains the final receipt transport; original Windows artifacts remain under `C:/Users/blain/AppData/Local/Temp/OVD480-Q-db84289d`.

## Follow-up items

- [ ] Native operation interruption/recovery, filesystem/network and profile isolation, legitimate licensed capacity, scheduling and prepared assemblies remain separate OVD-480/OVD-479 qualification slices. Full OVD-480 stays In Progress after this PR.
