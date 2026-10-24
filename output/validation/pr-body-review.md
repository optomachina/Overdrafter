## Linear issue ID

- Issue: OVD-500 — https://linear.app/overdrafter/issue/OVD-500

## Summary

Add a default-off Windows companion that preserves paired worker credentials and pending requests across restarts. It reconciles an old boot before registering a fresh one, then reports current session eligibility over the OVD-499 HTTPS gateway.

## Problem

Lost replies must not consume a new pairing code, rotate an uncertain credential or inherit an earlier process's grant. A durable local journal must precede every external mutation, with bounded transport and a separate owner enablement path.

## Acceptance criteria addressed

- [x] Strict recovery state and exact pending pair/boot requests.
- [x] Fresh process boot after old-request reconciliation; one bounded refresh after a definite conflict.
- [x] Source implementation for CurrentUser DPAPI, protected ACLs, exclusive file ownership, atomic write/readback and fixed worker/endpoint binding.
- [x] Default-off launcher and bounded HTTPS without redirects, cookies or proxy routing.
- [x] Portable recovery/stream/admission tests and Windows storage qualification script.
- [x] Actual x64 Windows PowerShell5.1 synthetic storage qualification passed10 assertions with direct exit0.
- [ ] Actual admitted HTTPS qualification remains outstanding before activation.

## Files changed

- `scripts/native/worker-companion/CompanionState.ps1`: typed state and replay protocol.
- `CompanionStore.ps1`: Windows CurrentUser DPAPI and private atomic state storage.
- `CompanionHttp.ps1`: fixed HTTPS endpoint, byte bounds and cancellation deadline.
- `run.ps1`: explicit connection, fresh startup and bounded status polling; no native execution.
- `test-state.ps1`, `test-boundaries.ps1`, `qualify-store.ps1`: inert tests and Windows qualification harness.
- Companion README, PLAN.md and TEST_STRATEGY.md: operating contract and distinct qualification gates.

## Scope

Session connectivity only, under the approved High-complexity staged automatic-loop milestone. Actual Windows same-user storage proof is recorded; full CodeRabbit review completed; all three findings are resolved at ad157d96. Final head0b99ec9d passes all hosted checks and reports Sonar0open. No task claims, CAD launch, file uploads, production pairing/credentials or external activation. No dependency or migration added. Existing C# native executor remains separate.

## Verification

Commands run:

```sh
pwsh -NoProfile -File scripts/native/worker-companion/test-state.ps1
pwsh -NoProfile -File scripts/native/worker-companion/test-boundaries.ps1
npm run verify
codex review --uncommitted
git diff --check
```

Results:

- [x] all listed verification passed
- [x] unrelated baseline failures are described below

Baseline failures or exceptions: the two explicit PowerShell tests use the already provisioned task-local PowerShell Core 7.6.6 on Mac, not Windows. Recovery suite: 291 assertions; boundary suite: 19 assertions. All scripts parse. Full repository verification: 337 files, 4146 passed, 1 skipped, root lint/types/build and worker checks pass. The normal Node suite does not execute PowerShell tests. Existing React act/browser-data/bundle-size warnings remain.

Independent review identified Windows PowerShell 5.1 handling of expected child stderr; the fixture now restores strict error preference after capturing that deliberate failure. Final static review found no actionable defect. The reviewer could not rerun PowerShell; the integrator ran the cached runtime. Windows state289 and boundary16 assertions passed on Desktop5.1.26100.9278 x64. The first storage run failed during atomic replacement: PowerShell converted the null backup path to an empty string. The corrected source uses NullString.Value, and structured failure receipts plus direct process capture prevent a wrapper exit from disguising failure. The corrected Windows storage run passed10 assertions with direct exit0 on Desktop5.1.26100.9278 x64. Hosted HTTPS remains unverified. Local reproduction, boundary suite, parser and independent review passed after the fix. Two hosted empty-catch findings were resolved through explicit missing-path handling; Sonar reported zero open issues on the prior head; current hosted quality also passes.

Review corrections at `ad157d96f510f4427690d89abe95831208570914` reject Core parsers without DateKind and mapped network volumes, and redact the absolute profile path from storage qualification. The exact source passed Windows state **290**, boundary **17**, and storage **10** assertions with direct exit **0** for each invocation on x64 Desktop 5.1.26100.9278. The network-drive case uses injected metadata and no network mapping. The success receipt contains only `retainedSyntheticWorkerId` for locating synthetic state. Evidence: `outputs/ovd-500-ad157d9/evidence/`; source-manifest SHA256 `4b676058d35ce87087f2c5f621162d0fdd72e24707e54be5b9eb1d6c16e54947`. The full local repository gate passed again; independent review found no actionable regression. HTTPS, other-user access, native behavior and eight-hour duration are not established by these tests.

Final head `0b99ec9dc8d641b78a724026cb8815d78bfbd092` adds only comments documenting intentionally scoped test doubles. Independent review confirms unchanged executable content, and Core291/19 suites pass again. All hosted checks pass on CI34471364148 attempt2 and Sonar has zero open issues. Attempt1 could not start its database because the runner port was occupied; the single failed-job rerun passed. All three CodeRabbit review threads are resolved.

## Tests

In-memory fault cases cover persistence before send, lost pair/boot replies, lost receipt saves, owner revision changes, restart, bounded confirmed conflicts, corrupt or coercible fields, malformed response scope and raw-secret retention rules. Stream tests cover actual size, invalid UTF-8, uncooperative asynchronous reads, endpoint restrictions and the actual default-off child launcher. The Windows-only qualifier retains synthetic ciphertext and tests roundtrip, tamper, worker entropy, ACLs, exclusion and reopen when explicitly run on an admitted host.

## Migration notes

- [x] No migration impact
- [ ] Migration impact exists and is described below

Targets main421e5173 after OVD-499/#487 merged. All PowerShell files are unchanged across rebase; its scoped session APIs precede activation. This PR makes no backend changes.

## Rollback / risk notes

Keep connection disabled and retain encrypted local state; never regenerate or delete an uncertain credential. Current-user storage is not isolation against that same user's other processes or administrators. The standalone status loop stops after at most eight hours and cannot run native work. Actual Windows API behavior, filesystem conditions and HTTPS routing must be qualified before activation. No production deployment, actual worker credential issuance, customer file or CAD operation was performed for local tests.

## Documentation

- [x] Docs updated
- [ ] No doc updates needed

The companion README documents protected storage, retry semantics, SecureString input, commands, limits and outstanding qualification. PLAN and TEST_STRATEGY preserve the full remaining automatic-loop milestone.

## Screenshots or videos (if UI)

Not applicable — no material UI impact. Local evidence is retained under the issue worktree's `output/validation`.

## Follow-up items

- [x] Run and inspect the admitted Windows synthetic storage qualification.
- [x] Complete hosted checks/review.
- [ ] Land on main after merged #487.
- [ ] Qualified HTTPS, owner controls, task coordination, native proof, file transport and connected app remain required before activation.


<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

- **New Features**
  - Added an optional, default-off Windows companion session client for authenticated gateway connectivity.
  - Added encrypted, locally protected session storage with atomic updates and restart recovery.
  - Added bounded HTTPS communication, status polling, conflict recovery, and secure pairing support.
  - The companion does not execute native tasks or start CAD processes.

- **Documentation**
  - Added setup, security, workflow, qualification, and testing documentation.

- **Tests**
  - Added coverage for storage protection, transport limits, validation, recovery, runtime boundaries, and default-off behavior.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->
