# OVD-503 exact recovery receipt

Verdict: **PASS for exact local source recovery and targeted portable verification. PR publication, independent review of the second commit, Windows qualification, and release admission remain pending.**

Recorded at `2026-09-12T01:24:27Z` in the Mac mini recovery worktree.

## Exact recovered chain

- Recovery branch: `codex/ovd-503-recovery-exact`
- Recovered head: `4cb226af74834bef785a761f2efb271951925732`
- Head tree: `d9b5326328b757ac05102287f62a072fd0eb48b2`
- Direct parent: `e70334b2bf187aaf72cf2e266f3838ae84cba1de`
- Parent tree: `b18c11cf1609431fe21b6a66cb77f25984933802`
- Published PR #492 head and first parent: `0b3ba54ff08c12b9c489d2b2e162cad769d1d48e`
- Exact recovered ref: `refs/recovery/ovd-503-4cb226af`
- Combined base-to-head stable patch ID: `d78cb98275e694a9453b03d2a1dce066bd233a53`
- Second-commit stable patch ID: `89459aca2ee5adb75fcd54efcf8c6ce4f18f20d6`

The objects were read from the clean tracked source branch
`codex/ovd-503-native-attempt-journal` in
`/Users/blainewilson/.codex/worktrees/engineering-native-journal/Overdrafter`
on the MacBook Pro and fetched directly into the isolated Mac mini worktree.
No patch was reconstructed and no commit bytes were changed.

## Recovered increments

1. `e70334b2` — `OVD-503 Preserve journal callback helpers in nested script scope`
   - Removes the runner capture callback's dynamic closure, preserving access to
     script-local journal helpers during synchronous nested invocation.
   - Adds `test-runner-scope.ps1` and related test/documentation coverage.
2. `4cb226af` — `OVD-503 Preserve qualification observer helpers in nested script scope`
   - Removes the same dynamic-closure isolation from the synchronous prepared
     operation acknowledgment observer.
   - Adds `test-native-call-acknowledgment-scope.ps1` and related test/docs.

## Files changed from the live PR head

- `TEST_STRATEGY.md`
- `scripts/native/attempt-journal/JournalRunner.ps1`
- `scripts/native/attempt-journal/README.md`
- `scripts/native/attempt-journal/test-native-call-acknowledgment-scope.ps1`
- `scripts/native/attempt-journal/test-native-call-acknowledgment.ps1`
- `scripts/native/attempt-journal/test-runner-scope.ps1`
- `scripts/native/attempt-journal/test-runner.ps1`
- `scripts/native/prepared-dimension/run.ps1`

`git diff --check 0b3ba54f..4cb226af` passed.

## Recovered evidence and fresh targeted verification

The completed task history and original MacBook receipt establish:

- The pre-`e70334b2` nested runner regression failed from both repository and
  filesystem-root working directories because `Set-RunnerJournalCreation` was
  unavailable; the exact candidate passed both cases with 61 assertions each.
- Independent review of `e70334b2` accepted that repair but reproduced a second
  nested-scope failure in the prepared operation observer.
- Before `4cb226af`, the new observer regression failed both working-directory
  cases. At `4cb226af`, it passed both cases with 33 assertions each.
- The writer's retained full repository gate at `4cb226af` reports 340 passing
  test files, 4,255 passing tests and one skip, plus lint, typecheck, build and
  worker verification. This recovery did not repeat that full gate.
- Original writer receipt:
  `/Users/blainewilson/Documents/GitHub/Overdrafter/output/release-coordination/pr492-observer-scope-repair-20260911/RESULT.md`
  with reported SHA256
  `3f158f71f1995ee9df2b86258e7c0f450109b098998b5600ed768ccc5b4a107b`.

Fresh serial reruns used PowerShell Core 7.6.6 from the retained MacBook runtime
against the exact recovered source branch:

- `test-runner-scope.ps1`: exit 0; repository and `/` cases each passed 61
  adapter assertions; directory restored; processes/storage mocked; zero native
  actions.
- `test-native-call-acknowledgment-scope.ps1`: exit 0; repository and `/` cases
  each passed 33 acknowledgment assertions; directory restored; processes and
  journal store mocked; only disposable checkpoint files were real; zero native
  actions.
- `test-native-call-acknowledgment.ps1`: exit 0; 92 contract, 46 checkpoint, 81
  evidence and 33 acknowledgment assertions; processes/store mocked; zero native
  actions.
- `test-runner.ps1`: exit 0; 61 assertions; processes/storage mocked; zero native
  actions.

The Mac mini has no local `pwsh`; therefore these PowerShell suites were run on
the MacBook's exact source branch after ancestry and tree identity were verified.
No Windows, SolidWorks, CAD, provider, customer, production or protected action
was performed.

## Current external state

- PR #492 was freshly read as OPEN at `0b3ba54f`, merge state CLEAN, with its
  hosted CI, SonarCloud, CodeRabbit and Vercel checks green for that published
  head only. Neither recovered commit is published.
- Linear OVD-503 was freshly read as `In Progress`; its rolling comment still
  describes the source repair as pending and has not been updated because tracker
  publication is outside this recovery authority.
- OVD-503 has no blocking Linear relation and blocks OVD-505, but its acceptance
  criteria still require corrected-source Windows qualification and final review.
- Canonical `PRD.md`, `PLAN.md`, and `ROADMAP.md` explicitly exclude native/CAD
  release work from the 1.0 Part-to-Quote gate. OVD-503 belongs to the separately
  approved internal automatic engineering loop. It is therefore not a canonical
  1.0 release blocker unless the source-of-truth product documents are deliberately
  changed through the applicable planning workflow.

## Remaining gates and next falsifiable action

1. An independent verifier reviews exact delta `e70334b2..4cb226af` and reruns
   the acknowledgment-scope regression at `4cb226af`.
2. The OVD-503 owner updates the single rolling Linear comment and PR only when
   publication is in scope.
3. If this internal milestone continues, a separately admitted Windows executor
   qualifies the corrected exact source on Desktop PowerShell 5.1, first resolving
   the recorded runtime/pending-rename preflight state. Existing native allowance
   remains unconsumed; no retry is inferred.
4. Hosted checks and review must cover the eventual published head before landing.

## Authority and rollback

Authorized and completed: read-only reconciliation, exact object import, local
recovery branch creation, portable mocked verification, and this local receipt.

Not authorized or performed: push, PR/Linear publication, merge, deployment,
production/provider operations, OVD-419 retry, protected reads, credentials,
quotes/orders, customer actions, or Windows/CAD execution.

Rollback is local and recoverable: return this worktree to its prior detached
commit and delete only the local recovery branch/ref after separate cleanup
authorization. No remote rollback exists because no remote state changed.
