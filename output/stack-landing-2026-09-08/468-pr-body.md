## Linear issue ID

- Issue: [OVD-480](https://linear.app/overdrafter/issue/OVD-480/provision-isolated-solidworks-workers-and-license-aware-job-leasing)

## Summary

Make the demonstrated Windows file predicates reproducible from the repository with five synthetic cases and a bounded runner that retains source, binary and result evidence.

## Problem

The native feasibility experiment left its file checks in private Workstation helpers. Subsequent worker work needs reviewed, repeatable source and truthful test outcomes. The fixture preserves the demonstrated predicates and exercises missing, changed, outside-root and prefix-sibling files without CAD access.

## Acceptance criteria addressed

- [x] Preserve the demonstrated predicate behavior and record source provenance.
- [x] Add one valid control and four rejection cases using synthetic files only.
- [x] Capture actual child exit status, separate termination requests from confirmed exits, and retain attempt evidence.
- [x] Compile and run the exact repository source on Workstation.
- [x] Complete local review and relevant repository checks.

These criteria describe the bounded tooling checkpoint. They do not complete OVD-480's full worker qualification.

## Files changed

- `scripts/native/file-admission/SharedFilePredicates.cs`: existing experimental path/length/hash checks, formatted with scope documentation.
- `scripts/native/file-admission/FileAdmissionCases.cs`: deterministic generated fixtures and observed verdict assertions.
- `scripts/native/file-admission/qualify.ps1`: installed-framework compilation, bounded child execution, hashes and retained receipts.
- `scripts/native/file-admission/README.md`: Windows command, provenance, result interpretation and limits.
- `docs/solidworks-2022-feasibility.md`: pointer to repeatable tooling and its verified scope.

## Scope

Internal qualification tooling, originally stacked on #467. No production admission API, native executor integration, CAD/COM invocation, queue, database, dependency installation, customer file processing or OS/license/security configuration change. Test output is diagnostic evidence, not authority or a production worker contract.

Complexity: Medium for this bounded, separately executable test-tooling slice; it spans the PowerShell runner, C# predicates/cases and documentation without adding a deployed API, schema or runtime dependency. The full OVD-480 worker workstream remains High and incomplete. The user approved the staged plan and subsequently gave explicit “Do it” landing authority for the PR stack. Preserve that bounded decomposition; landing this fixture does not authorize or qualify production admission or native execution.

## Verification

Historical source-head commands run:

```bash
./scripts/symphony-preflight.sh
git diff --cached --check
codex review --uncommitted --title 'OVD-480 repeatable Windows file-admission fixture'
```

Windows invocation against hash-verified copies of the uncommitted source (private output path abbreviated):

```powershell
powershell.exe -NoProfile -NonInteractive -File qualify.ps1 -OutputRoot <private-attempt-root>
```

Historical results:

- [x] all listed verification passed
- [x] unrelated baseline failures are described below

Baseline failures or exceptions:

- Identity, whitespace and documentation link/fence checks passed.
- Focused pre-execution review identified two reporting issues; both were corrected and the fixes reviewed. Unknown termination and interrupted integrity checks cannot claim success.
- Actual Windows source hashes matched all three repository files. PowerShell 5.1 parsing returned zero errors. Compiler 4.8.9221.0 exited zero (0.206s); the test exited zero (0.163s); the parent exited zero (1.047s). All five cases passed, four synthetic controls retained their hashes, and no termination or CAD invocation occurred. SourceCommit is null because the exact source was tested before commit. A separate source binding confirmed all three committed Git blobs at `07adbef37696537d097486118c2431a6c5176edb` match the executed-source hashes without rewriting that original receipt. The coordinator passed 16 source/receipt consistency checks; Windows observations remain executor-reported.
- Full local app/worker verification is not used as evidence for Windows semantics. Application code and dependencies are unchanged; Windows qualification is the affected test lane.
- Local Codex review exited zero with no actionable findings. It inspected all new source files; MCP shutdown authentication warnings did not prevent the local review. Hosted checks passed on `07adbef37696537d097486118c2431a6c5176edb`: build, lint/typecheck, main tests, browser tests, worker verification, extraction/recovery checks, aggregate CI and Sonar. The single watcher exited zero. CodeRabbit originally skipped substantive review while the PR was a draft; that green context did not establish a review.
- The existing helpers' lexical path and shared-read limitations are retained explicitly. These tests do not prove reparse-point/race resistance or isolation. The successful run did not exercise timeout or forced-termination paths; their bounded behavior and reporting received source review, not a claimed adverse runtime test.

Landing preparation:

The PR is now ready for review. The latest requested CodeRabbit review was rate-limited; the current inventory contains zero submitted reviews and zero unresolved review threads, including outdated threads. The local reviews above do not establish a completed CodeRabbit review.

Current-main refresh: head `28db0236b7e69711c7b5de764c256389838f9c9c` is based on merged documentation `ebf10437`. Range-diff confirms the original tooling patch is unchanged; scope remains five files. All three executable source files in this commit byte-match the hashes reported by the successful Windows compilation/five-case run and the preserved original commit binding. A separate landing-head source binding is retained; the original receipt SourceCommit remains null. This does not independently reproduce Windows execution or qualify isolation. Whitespace, repository preflight, Markdown fences and relative links passed. Existing local code review and Windows evidence remain applicable; no native run was repeated. All fresh hosted gates passed, including required ci, full tests, browser, build, worker and Sonar quality. Fresh review-thread inspection confirms no actionable threads. OVD-480 full worker qualification remains incomplete.

## Tests

Five generated file cases exercise the actual C# predicates: valid, missing, same-size one-byte mutation, outside root and prefix sibling. Setup hash reads are separate from admission reads. Original synthetic controls are rechecked after the cases. The fixture emits a failure and nonzero exit when any required observation is incomplete or incorrect. These generated `.bin` tests are separate from the earlier native-assembly package experiment and do not demonstrate deployed native preflight integration.

## Migration notes

- [x] No migration impact
- [ ] Migration impact exists and is described below

## Rollback / risk notes

Revert this tooling change; retained private test artifacts require no runtime rollback. The main risk is reusing these experimental predicates as a production security boundary. The documentation excludes untrusted manifest validation, aliases/reparse points, file races, complete CAD dependency closure, native execution authority and release eligibility. This change does not qualify those controls or complete OVD-480.

## Documentation

- [x] Docs updated
- [ ] No doc updates needed

## Screenshots or videos (if UI)

Not applicable — no material UI impact.

## Follow-up items

- [x] Fresh hosted gates and exact head confirmed before merge.
- [ ] Qualify actual worker isolation, serialized scheduling and interrupted native recovery.
- [ ] Admit native integration and broader assembly/component operations through separately reviewed slices.
- [ ] Keep OVD-480 open until full worker qualification is demonstrated.
