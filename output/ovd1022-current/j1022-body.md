## Linear issue ID

- Refs OVD-1022
- This bounded source repair addresses row-bound cart cleanup and native confirmation safety. Verification is not complete: the sandbox blocks RMFG transport tests from opening a local listener, and the coordinator owns browser suites. Change to Fixes OVD-1022 after the remaining required verification passes.
- This is the main repair for OVD-1022, a bounded implementation issue, not a release-outcome parent. No PR was opened and no git writes were performed.

## Summary

Bind kernel cleanup clicks to one unique row and one control. Retain that row's DOM identity and filename across subsequent clicks. Reject page-global confirmations, ambiguous selections, row replacement/reuse, and detached or moved controls with `manual_cleanup_required`.

Native confirmations are accepted only during the selected row's active click, when a dedicated filename field was verified and the message exactly matches a single-row Delete/Remove prompt naming that filename. Otherwise dismiss and report manual cleanup. Validation uses the pre-click snapshot because native modals pause page JavaScript.

## Problem

The generic cleanup capability previously clicked the first matching control, including page-global confirmation selectors, and accepted native dialogs without checking their row. An unrelated row's confirmation could therefore authorize the wrong deletion.

Current registry/source inventory at f7b322d7:

| Provider | liveAdapter | Adapter path | Kernel cleanup with confirmation |
| --- | --- | --- | --- |
| Xometry | true | Custom `XometryAdapter` | None; does not use the kernel |
| Fictiv | true | Custom `FictivAdapter` | None; `cleanupLiveSession` closes browser resources |
| Quickparts | true | Kernel via `buildQuickpartsProductionPortalDefinition` | No cleanup hook declared |
| Weerg | true | Kernel via `buildWeergProductionPortalDefinition` | No cleanup hook declared |
| RMFG | false | API `RmfgAdapter` | Not live; no portal cleanup |
| OSH Cut | false | Kernel definitions retained, automation hard-disabled | Only production-source cleanup declarations; report-only rules, disabled hook |

The generic kernel remains worth hardening despite no current live adapter declaring cleanup. No provider is enabled by this repair.

## Acceptance criteria addressed

- [x] Inventory live registry providers and trace their adapter/cleanup usage.
- [x] Require row-bound, unique confirmation targets; never click page-global confirms, even a single candidate.
- [x] Dismiss unbound/mismatched native dialogs and report manual cleanup.
- [x] Preserve valid row-bound behavior when another row's confirmation exists.
- [x] Add unrelated-row, ambiguous-control, row replacement/reuse, native filename and modal-state regressions.
- [ ] Complete environment-dependent adapter checks and coordinator browser suites.

## Files changed

- `worker/src/adapters/providerPortalKernel.ts`: strict cleanup target resolution and manual-cleanup reporting.
- `worker/src/adapters/providerPortalCleanupConfirmation.ts`: selected-row/filename binding, containment check, and native prompt validation.
- `worker/src/adapters/providerPortalKernel.test.ts`: connected kernel regressions using synthetic DOM rows and native-modal fixtures.

## Scope

One generic cleanup safety repair with its regression matrix. The diff exceeds the approximately 200-line guideline primarily because the DOM/modal fixtures and failure matrix accompany the guard; separating those tests would leave the safety boundary without its regression evidence.

No provider routing, credentials, customer/provider activity, browser suites, deployment, database changes, or OSH Cut re-enablement. Existing retained `output/ovd1022/` evidence is preserved.

## Verification

Commands run:

```bash
npm run provider:check
npx vitest run worker/src/adapters --exclude '**/*.browser.test.ts'
npm run typecheck:worker
npx eslint worker/src/adapters/providerPortalKernel.ts worker/src/adapters/providerPortalCleanupConfirmation.ts worker/src/adapters/providerPortalKernel.test.ts
git diff --check
```

Results:

- Provider check: PASS.
- Worker typecheck: PASS.
- Scoped ESLint: PASS.
- Whitespace check: PASS.
- Adapter suite: 42 files passed, 1 failed; 1,396 tests passed, 10 failed, with 10 uncaught errors. RMFG transport tests cannot bind `127.0.0.1` (`listen EPERM`). This is an environment failure, not a passing suite.
- Final kernel tests: 145 passed within the adapter run.
- [ ] All listed verification passed.
- [x] Environment failures are described below.

Baseline failures or exceptions:

Ten RMFG HTTP transport tests require an ephemeral loopback HTTP server. The execution sandbox denies `listen` on `127.0.0.1`, yielding ten uncaught EPERM errors and test timeouts. No transport source or tests were changed to evade this restriction. The coordinator must run the exact adapter command in an environment permitting loopback listeners and run the browser suites.

`npm run preflight` was not run: this task requested the commands above and forbids git writes; no PR was opened or updated. Required PR-boundary preflight remains with the coordinator.

## Proof

- Test: worker/src/adapters/providerPortalKernel.test.ts
- Command: npm run typecheck:worker
```text
> overdrafter-cad-worker@0.1.0 typecheck
> tsc --noEmit -p tsconfig.json
exit 0
```

Local source hashes, ownership, base revision, and check logs are recorded in `output/ovd1022-current/`. These are synthetic local results; no live provider operation was performed.

## Review findings and coverage

- Final PR head SHA: no PR/commit created; base f7b322d7c50bac3aa0e3bac5f982000527ffc8f1 plus the recorded working-tree patch hashes.
- Sonar issue findings: not queried; no PR/final head available for this no-git-write task.
- CodeRabbit: unavailable for this uncommitted patch; not counted as clean.
- Codex and other reviewers: independent Astra xhigh read-only review completed. Fixed its native-modal DOM-evaluation and reused-node filename findings; reviewer reported no remaining actionable findings in the bounded patch. Additional negative test cases were added afterward without production code changes.
- [ ] Inspected hosted findings and threads on a final PR head; coordinator must complete hosted review and risk-sized repository gates.

## Tests

Regressions cover one or multiple global confirms, a second row's confirm, successful row-bound deletion, wrong-row selection, duplicate controls, ambiguous rows, replacement/reused rows, native messages naming other/suffix filenames or multiple rows, generic messages, absent/duplicate filename fields, no active click, non-confirm dialogs, and validation while DOM evaluation is blocked by a modal. Existing kill-switch and OSH Cut report-only/disabled behavior remains covered.

## Migration notes

- [x] No migration impact.
- [ ] Migration impact exists.

## Rollback / risk notes

Fail-closed behavior can leave a part requiring manual cleanup when a portal uses a detached modal, unfamiliar prompt wording, or ambiguous identity. This is intentional. New portal bindings should supply verified row-scoped controls and a dedicated filename field for native dialogs. One cleanup pass remains pinned to its initially selected row.

If a regression is found, fix the scoped binding forward while preserving fail-closed behavior and the OSH Cut hard-disable. No runtime rollout occurs in this task.

## Documentation

- [x] Inline cleanup capability contract updated.

## Follow-up items

- [ ] Coordinator: rerun adapter suite where loopback listeners are permitted; run browser suites and required preflight/hosted review.
- [ ] Keep OSH Cut disabled unless its separate readiness and authorization requirements are satisfied.
