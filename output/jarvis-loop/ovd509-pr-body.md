## Linear issue ID

- Issue: OVD-509
- This bounded change satisfies OVD-509's source and Workstation acceptance: trusted handle-derived input/candidate admission, alias and replacement denial, and one fresh 5 → 7 mm synthetic SolidWorks result. No OVD-509 post-merge criterion remains. Connected server admission and durable finalization are separate OVD-510/511/519/520 work.
- This is OVD-509's main PR.
- OVD-509 is a child of OVD-505, not a release-outcome parent.

## Summary

Bind the fixed prepared CAD package to handle-derived Windows filesystem identities for one exact attempt, hold those identities during native work, and retain the admission observation in the supervisor receipt.

## Problem

The prepared native runner previously used path and hash checks without a trusted open-handle input/candidate identity. A path alias or replacement could evade those observations, so the verifier had no qualified filesystem admission evidence.

## Acceptance criteria addressed

- [x] Input and candidate directories use `FILE_ID_INFO` volume serial and 128-bit file ID from open handles, bound to Workstation and one attempt.
- [x] Junctions, symlinks, substituted drives, hard links, unsupported descendants and missing/unverifiable paths deny before native effects.
- [x] Held source/candidate handles deny replacement; before/after source hashes are unchanged.
- [x] One fresh minimal three-file 5 → 7 mm SolidWorks run passed seven native checks with distinct input/candidate identities, native exit 0 and an unadopted candidate.
- [x] Portable checks and current-source Windows receipts are reported separately; failed and older attempts retain their original source identities.

## Files changed

- `scripts/native/file-admission/PreparedFilesystemAdmission.cs`: handle-derived Windows identity and fail-closed closure/alias checks.
- `scripts/native/file-admission/test-prepared-filesystem-admission.ps1`: 14 synthetic Windows cases.
- `scripts/native/prepared-dimension/run.ps1`: admission before attempt/native effects, rechecks and supervisor evidence.
- `scripts/native/file-admission/README.md`, `scripts/native/prepared-dimension/README.md`, `docs/engineering-result-finalization.md`: scope, clean-input procedure, proof and limits.

## Scope

Included: the fixed three-file synthetic prepared package and local Workstation admission/native qualification. Excluded: customer files, PDM writes, server admission, database migrations, verifier privileges, atomic finalization, production activation and candidate adoption.

## Verification

Commands run:

```bash
env -u NOTION_API_TOKEN npm run verify
./scripts/symphony-preflight.sh
git diff --check origin/main...HEAD
```

On Workstation, x64 Windows PowerShell 5.1 ran `test-prepared-filesystem-admission.ps1` at final HEAD `d475427f44fb4ac49032dc364b4ed99d39dae663`: 14/14 passed, source unchanged, `nativeCalls=0`. Result: `C:/temp/ovd509-d475427f-1d6e7959/ovd509-f21364bcda6c46cda9988f38304e3758/result.json`, SHA-256 `986be484adb7c256001b777c21e9e7f3e9c07aae62ab25c1157b4bcad43c4c6f`.

One separate fresh 5 → 7 mm run at executable source `9a4d2486b10f51b56811fc20c1fff3798f661002` passed all seven checks, measured 5 → 7 mm, preserved input/companion hashes, retained distinct `FILE_ID_INFO` identities, and confirmed native exit 0 with no remaining SLDWORKS process. The final PR head changes only documentation after that executable commit; C#, PowerShell test and runner SHA-256 match byte for byte. Native attempt `C:/temp/ovd509-run-582c9de3/11ebefda-f517-458f-aea7-bab8b4523a2e`: `result.json` SHA-256 `177d7137b48240d419416f2faceac80d5dc2006c008a022ac6dd1ceacbf830ee`; `supervisor-final.json` SHA-256 `21a5f53bde545fe7b7382a36f9b1dfa448cd3b1e86d5a56eae1ab5cbb0207057`.

Results:

- [x] All final listed verification passed: 5,507 repo tests passed, one skipped, build, lint, typecheck and worker verification passed; Symphony preflight and diff check passed.
- [x] Earlier failures are described below and retained; none is counted as passing evidence.

Baseline failures or exceptions: The first full run in the isolated Mac checkout found absent worker dependencies and an OVD-410 deadline failure; targeted reruns and complete reruns passed after installing the committed dependencies. The first Windows synthetic attempt at `1dbce683` failed in test receipt serialization; a forward repair produced passing current-source receipts. The first native invocation rejected the historical seed's extra `template/` and partial manifest before attempt creation or CAD launch; the passing attempt used a new exact three-file copy. All failed artifacts remain on Workstation.

## Review findings and coverage

- Final PR head SHA: `d475427f44fb4ac49032dc364b4ed99d39dae663`.
- Sonar issue findings: [PR #525 analysis](https://sonarcloud.io/dashboard?id=optomachina_Overdrafter&pullRequest=525) passed with 0 new issues, 0 accepted issues and 0 security hotspots on this head.
- CodeRabbit: attempted after the PR left draft but reported its included review rate limit, with the next review available in about 22 minutes at the time of the report. No review findings or threads were produced; this is unavailable, not a clean review.
- Codex and other reviewers: local Codex review found and drove repairs for five actionable items; final local review on `d475427f` found no actionable defects. Hosted PR review is pending.
- [ ] Inspect findings and threads on the final head; resolve or document every actionable current-change finding before merge.

## Tests

Added a Windows synthetic fixture for handle identity, source and candidate replacement denial, junction/symlink/substituted-drive denial, missing roots, source/external hard links, recheck stability and unchanged source bytes. The existing focused native-result/lineage suite passed 128/128 before final docs and test-receipt-only changes.

## Migration notes

- [x] No migration impact.
- [ ] Migration impact exists and is described below.

## Rollback / risk notes

If a different Windows/SolidWorks configuration conflicts with held read handles, fail closed and revert this source change before further execution; do not reuse a partially started attempt. Preserve all retained fixtures and native receipts. No production database or worker state was changed. The qualifying candidate remains unadopted.

## Documentation

- [x] Docs updated.
- [ ] No doc updates needed.

## Screenshots or videos (if UI)

Not applicable — no reviewer-visible UI change. Retained Windows result/supervisor receipts and exact hashes are listed above.

## Follow-up items

- [ ] OVD-510: prove effective verifier database privileges in a disposable local database.
- [ ] OVD-511: restore atomic finalization only behind qualified admission.
- [ ] OVD-519/520 and parent OVD-505: connected transport, cumulative proof, review artifact and activation gates.
