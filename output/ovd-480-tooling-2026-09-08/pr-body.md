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

## Files changed

- `scripts/native/file-admission/SharedFilePredicates.cs`: existing experimental path/length/hash checks, formatted with scope documentation.
- `scripts/native/file-admission/FileAdmissionCases.cs`: deterministic generated fixtures and observed verdict assertions.
- `scripts/native/file-admission/qualify.ps1`: installed-framework compilation, bounded child execution, hashes and retained receipts.
- `scripts/native/file-admission/README.md`: Windows command, provenance, result interpretation and limits.
- `docs/solidworks-2022-feasibility.md`: pointer to repeatable tooling and its verified scope.

## Scope

Internal qualification tooling, stacked on #467. No production admission API, native executor integration, CAD/COM invocation, queue, database, dependency installation, customer file processing or OS/license/security configuration change. Test output is diagnostic evidence, not authority or a production worker contract.

Complexity: Medium for this test-tooling slice; the full OVD-480 worker remains High and incomplete.

## Verification

Commands run:

```bash
./scripts/symphony-preflight.sh
git diff --cached --check
codex review --uncommitted --title 'OVD-480 repeatable Windows file-admission fixture'
```

Windows invocation against hash-verified copies of the uncommitted source (private output path abbreviated):

```powershell
powershell.exe -NoProfile -NonInteractive -File qualify.ps1 -OutputRoot <private-attempt-root>
```

Results:

- [x] all listed verification passed
- [x] unrelated baseline failures are described below

Baseline failures or exceptions:

- Identity, whitespace and documentation link/fence checks passed.
- Focused pre-execution review identified two reporting issues; both were corrected and the fixes reviewed. Unknown termination and interrupted integrity checks cannot claim success.
- Actual Windows source hashes matched all three repository files. PowerShell5.1 parsing returned zero errors. Compiler4.8.9221.0 exited zero (0.206s); the test exited zero (0.163s); the parent exited zero (1.047s). All five cases passed, four synthetic controls retained their hashes, and no termination or CAD invocation occurred. SourceCommit is null because the exact source was tested before commit. A separate source binding confirmed all three committed Git blobs at `07adbef37696537d097486118c2431a6c5176edb` match the executed-source hashes without rewriting that original receipt. The coordinator passed 16 source/receipt consistency checks; Windows observations remain executor-reported.
- Full local app/worker verification is not used as evidence for Windows semantics. Application code and dependencies are unchanged; Windows qualification is the affected test lane.
- Local Codex review exited zero with no actionable findings. It inspected all new source files; MCP shutdown authentication warnings did not prevent the local review. Hosted checks passed on `07adbef37696537d097486118c2431a6c5176edb`: build, lint/typecheck, main tests, browser tests, worker verification, extraction/recovery checks, aggregate CI and Sonar. The single watcher exited zero. CodeRabbit explicitly skipped substantive review because this PR is a draft; its green context is not a review.
- The existing helpers' lexical path and shared-read limitations are retained explicitly. These tests do not prove reparse-point/race resistance or isolation.

## Tests

Five generated file cases exercise the actual C# predicates: valid, missing, same-size one-byte mutation, outside root and prefix sibling. Setup hash reads are separate from admission reads. Original synthetic controls are rechecked after the cases. The fixture emits a failure and nonzero exit when any required observation is incomplete or incorrect.

## Migration notes

- [x] No migration impact
- [ ] Migration impact exists and is described below

## Rollback / risk notes

Revert this tooling change; retained private test artifacts require no runtime rollback. The main risk is reusing these experimental predicates as a production security boundary. The documentation excludes untrusted manifest validation, aliases/reparse points, file races, complete CAD dependency closure, native execution authority and release eligibility. This change does not qualify those controls.

## Documentation

- [x] Docs updated
- [ ] No doc updates needed

## Screenshots or videos (if UI)

Not applicable — no material UI impact.

## Follow-up items

- [ ] Qualify actual worker isolation, serialized scheduling and interrupted native recovery.
- [ ] Admit native integration and broader assembly/component operations through separately reviewed slices.
