## Linear issue ID

- Refs OVD-1022
- Source acceptance is blocked: the reported cleanup implementation is absent from the requested base. This is an investigation handoff, not a completed repair or a publishable implementation PR.
- No PR was opened. OVD-1022 is the bounded cleanup repair issue, not a release-outcome parent.

## Summary

The requested branch `fix/portal-cleanup-row-bound-confirm` already exists and matches local `origin/main` at `e1cfce1214e9f895a95bdde53913a951d9efd3c7`. At this revision, `providerPortalKernel.ts` has no cart cleanup capability, row-removal helper, confirmation-button click, or native-dialog acceptance handler to repair.

The reported implementation exists on the separate local remote-tracking ref `origin/ovd-677-oshcut-live-readiness` at `f8a8a257` and is not incorporated into the supplied base. Its kernel diff adds 282 lines and removes two; importing that feature would exceed this bounded repair. A corrected base or an explicit coordinator handoff is required.

## Problem

OVD-1022 describes deletion confirmations that are not bound to the selected cart row. The unsafe native-dialog acceptance and generic first-candidate cleanup lookup can be located on the OSH Cut feature branch, but neither exists in this worktree. Adding an unused confirmation guard or a test for nonexistent cleanup would not resolve that defect.

## Acceptance criteria addressed

- [x] Inventory the named providers using `provider-integrations/provider-registry.v1.json` and actual adapter routing.
- [ ] Bind cleanup confirmations to the selected row or report for manual cleanup: blocked on the source containing cleanup.
- [ ] Native dialogs accept only the selected row's identity; ambiguous dialogs dismiss and report: blocked on the same missing implementation.
- [ ] Regression coverage with a second row's confirmation: blocked on the same missing implementation.

| Provider | liveAdapter | Implementation at e1cfce12 | Kernel cleanup with confirmation |
| --- | --- | --- | --- |
| Xometry | true | Custom `XometryAdapter` in `xometry.ts` | None; does not use the kernel |
| Fictiv | true | Custom `FictivAdapter` in `fictiv.ts` | None; does not use the kernel; `cleanupLiveSession` closes browser/session resources |
| Quickparts | true | `PortalQuoteWorkflowAdapter` with `buildQuickpartsProductionPortalDefinition` | None; kernel uploads, configures, and extracts offers without cart cleanup |
| Weerg | true | `PortalQuoteWorkflowAdapter` with `buildWeergProductionPortalDefinition` | None; kernel uploads, configures, and extracts offers without cart cleanup |
| RMFG | false | Custom API `RmfgAdapter` | Not live and no portal kernel cleanup |

On the inspected OSH Cut branch, the only production-source cleanup hook declarations are in `oshcut.ts` and `oshcutProductionPortal.ts`; none of the five named providers declares one. Local remote-tracking refs were inspected without fetching or other git writes; this is not a claim about current hosted branch state.

## Files changed

- `output/ovd1022/j1022-body.md`: investigation and verification handoff only.
- No implementation or test files changed.

## Scope

Read-only git inspection, local provider inventory, and requested baseline checks. No git writes, provider operations, browser suites, or remote updates. The coordinator owns browser suites and selection of the corrected source base.

## Verification

Commands run:

```bash
npm run provider:check
npx vitest run worker/src/adapters --exclude '**/*.browser.test.ts'
npm run typecheck:worker
```

Results:

- `provider:check`: PASS, `ok: true`; reported contract groups passed 56, 10, and 10 tests.
- Adapter unit suite: FAIL, exit 1; 39 files passed and 2 failed; 1,294 tests passed and 11 failed, with 10 unhandled errors. `geomiqProductionPortal.test.ts` has one baseline assertion failure (expected unavailable result, received `VendorAutomationError` with reason `dispatch_authorization_file_mismatch`). `rmfgHttpTransport.test.ts` has ten local-server timeouts with `listen EPERM: operation not permitted 127.0.0.1`; the sandbox prohibits binding the stub server.
- Worker typecheck: PASS, exit 0.
- ESLint on changed files: not applicable; no lintable source files changed.
- [ ] All listed verification passed.
- [x] Unrelated baseline failures are described below.

Baseline failures or exceptions: the Geomiq assertion and RMFG sandbox failures above occurred with unchanged source. Logs: `/private/tmp/ovd1022-provider-check.log`, `/private/tmp/ovd1022-adapters.log`, `/private/tmp/ovd1022-typecheck.log`. Cleanup implementation is absent from the supplied base. Browser suites are reserved for the coordinator. Full preflight and hosted checks were not run because no source repair or PR was produced.

## Proof

- Command: `git rev-parse HEAD origin/main`

```text
e1cfce1214e9f895a95bdde53913a951d9efd3c7
e1cfce1214e9f895a95bdde53913a951d9efd3c7
```

- Command: `rg -n -i 'cleanup|dialog|confirm' worker/src/adapters/providerPortalKernel.ts`

```text
No matches (exit 1).
```

- Command: `git diff --stat origin/main...origin/ovd-677-oshcut-live-readiness -- worker/src/adapters/providerPortalKernel.ts`

```text
 worker/src/adapters/providerPortalKernel.ts | 284 +++++++++++++++++++++++++++-
 1 file changed, 282 insertions(+), 2 deletions(-)
```

## Review findings and coverage

- Final PR head SHA: no PR or commit produced; inspected base is `e1cfce1214e9f895a95bdde53913a951d9efd3c7`.
- Sonar issue findings: not inspected; no repair PR exists.
- CodeRabbit: no repair review requested or available.
- Codex: source inventory completed; implementation review remains pending the correct base.
- [ ] Inspected findings and threads on the final head; actionable current-change findings resolved. No missing review is counted as clean.

## Tests

No tests added because the cleanup path described by the issue is absent. Existing adapter checks establish only the baseline; they do not establish OVD-1022 acceptance.

## Migration notes

- [x] No migration impact.
- [ ] Migration impact exists.

## Rollback / risk notes

No runtime changes to roll back. The unsafe implementation on the separate feature branch remains unmodified and must be repaired on its owning source before integration. Do not interpret this inventory as a deletion-safety qualification of that branch.

## Documentation

- [x] Investigation handoff recorded here.
- [ ] No doc updates needed.

## Follow-up items

- [ ] Coordinator supplies the cleanup-bearing base and transfers bounded repair ownership; implement the row-bound checks and regressions there.
- [ ] Coordinator runs browser suites on the eventual repaired revision.
- [ ] Copy this body to the requested sibling path `../j1022-body.md`; that path is outside this session's writable roots.

Checkpoint: owner `/root`, host `Blaines-MacBook-Pro.local`, worktree `/Users/blainewilson/Documents/Codex/2026-10-20/overnight/cx/ovd1022`, branch `fix/portal-cleanup-row-bound-confirm`, base SHA above, 2026-10-21 UTC. Budget: one focused inventory pass and the requested baseline checks. Failure family: source/base mismatch. Completion requires actual row-bound behavior and regressions on the cleanup-bearing source, followed by the requested checks. Only source inspection, scoped local edits, tests, and this handoff were in scope; git remained read-only.
