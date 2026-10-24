## Linear issue ID

- Issue: OVD-480

## Summary

Extend the controlled read-only interruption case to the exact prepared synthetic assembly and both referenced parts. Each attempt receives a complete private package; the fresh recovery session must pass the same identity, dependency, geometry and placement checks as the interrupted session.

## Problem

The existing single-part recovery demonstration cannot establish that an assembly recovers with the correct referenced files or component placements.

## Acceptance criteria addressed

- [x] Create two private three-file packages and immutable input manifests from exact pinned originals.
- [x] Reuse prepared-package checks through a read-only adapter; preserve separate interrupted and recovery results.
- [x] Demonstrate Windows compilation, 13 inert/compatibility cases and one controlled native assembly recovery; 206 evidence assertions passed.

## Files changed

- `scripts/native/session-lifecycle/AssemblyRecovery.cs`: read-only adapter over existing prepared-package measurements.
- `InterruptionCase.ps1`: complete package copies, manifest and dependency hash checks.
- `NativeSessionProbe.cs` and `lifecycle.ps1`: explicit assembly modes and compiler entry-point selection.
- Native lifecycle README: invocation and qualification limits.

## Scope

One known synthetic assembly, two fixed resolved cylinders, one Default configuration and one read-only interruption. No public API, UI, service rollout, schema, arbitrary assembly support, interrupted-save repair, PDM/customer-file operation, licensing or profile isolation change.

## Verification

Commands run:

```bash
bash scripts/symphony-preflight.sh
git diff --check
codex review --base origin/main
npm run verify
```

Results:

- [x] All listed local verification passed: 333 test files, 4095 tests passed, one skipped; root build/lint/types and worker checks passed.
- [x] Local Codex review found no actionable regressions.
- [x] Windows compilation, 13 inert/compatibility checks and one native case passed. The outer invocation took 44.817 seconds. Native PID 6036 was interrupted (exit -1); fresh PID 23440 verified the complete package and closed normally (exit 0).

Baseline failures or exceptions: no local or native qualification failure. CodeRabbit is rate-limited and has not reviewed this PR; its hosted check reports success, but that is not review evidence. Local Codex review is the completed code review; all actual PR threads must be resolved or confirmed absent before landing.

## Tests

Repository regression suite passed. The meaningful new validation is on Windows: exact input/manifest rejection tests and a controlled interruption/recovery with raw receipts. The corrected six-record inert packet is 47,381 bytes / SHA256 `2c7f3c09c2f6dafbfb8bd90f6a89a532696e6226d7b4b1732219aad51616a1c7`. The live packet contains 51 raw records and 58 artifact entries; the independent validator reconstructs original bytes and verifies Git/source bindings, attempt manifests, geometry, placements, private/original hashes and supervisor observations. These are executor-reported native observations, not an independent native rerun.

## Migration notes

- [x] No migration impact.

## Rollback / risk notes

The lifecycle driver remains explicit opt-in. Revert this commit to remove assembly recovery support, preserving all recorded attempts. Native execution requires a fresh empty inventory and uninterrupted operator ownership. Shared Windows-profile startup effects, file alias races and general crash/save recovery remain unqualified. Compilation explicitly selects NativeSessionProbe; the dimension-editing entry point is not dispatched by recovery modes.

## Documentation

- [x] Native lifecycle README describes the new option and its limits.
- `docs/solidworks-2022-feasibility.md` records the exact native source/packet, passing case and remaining qualification limits.

## Screenshots or videos (if UI)

Not applicable — no material UI impact.

Live evidence: [Linear packet](https://uploads.linear.app/71e00950-b710-42e5-92db-012a17f2031f/744c5749-f1e6-4723-a55a-3c5c2a1a5881/07dcdb07-a865-410e-a733-e159f7a896ea) (base64/gzip transport; decoded JSON 870,991 bytes, SHA256 `50eef159066de873dae9ede1db0f8799a7237572be0970cb274cea5a5aa76d62`). Executable source is `7783ce2de30c8ffc5461e4996bc1c1bc3e399495`; subsequent changes document the result only. Local evidence and validator are preserved under `engineering-assembly-recovery/Overdrafter/output/assembly-recovery/` in the coordinating worktree.

## Follow-up items

- [x] Complete this bounded native qualification and evidence review.
- [ ] OVD-480 retains broader worker isolation, scheduling, entitlement and save-interruption criteria.
