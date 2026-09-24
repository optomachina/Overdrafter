# Stored native evidence verification

OVD-505 / draft PR #495 was narrowed on September 11, 2026 to pure evidence
validation. It does **not** finalize a database candidate. The original four
migrations, verifier client, failure recovery and preview association remain
preserved at `125af011d11cc176f89ad685eafc6d203ed0ce98`, outside this branch's
active diff. See [the consolidation plan](jarvis-bounded-restart.md).

## Current contract

`verifyStoredNativeCandidate` consumes exact v2 context/job bytes, an admitted
attempt, trusted process/filesystem identity and seven immutable registered
objects: assembly, edited part, fixed companion, result, input identity,
preservation and native report. The injected reader accepts only registry IDs,
never worker URLs or paths. It measures actual bytes and digests, bounds size,
duration and stream progress, and validates all seven native checks against the
fixed prepared two-cylinder policy. It returns a candidate context and evidence
identities in memory, not a receipt or authorization to advance any task.

The `prepared-native-reports-v2` policy requires separate input and candidate
directory admissions. Each includes its admitted absolute path and the
`FILE_ID_INFO` volume serial (16 lowercase hex digits) and file ID (32 lowercase
hex digits). Both must be captured by a trusted Windows boundary on the same
host for the same attempt. The input report must name the admitted input path;
candidate report/process paths must name the admitted candidate path. Equal
volume/file identities are rejected even when paths differ. Missing or malformed
admission is rejected before stored objects are read, not recorded as defective
CAD evidence. Tests explicitly inject simulated identities.

The handle identity format follows Microsoft's
[FILE_ID_INFO contract](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_id_info).
At the OVD-505 validator checkpoint, the capture writer was **not implemented
or qualified**. OVD-509 adds a fixed-package writer. At its executable source
`a938fb830a1758300237f6223998802978b144e2`, Workstation passed 16 synthetic
admission cases and one fresh 5 → 7 mm native run with all seven checks; see
`scripts/native/file-admission/README.md` for the retained receipts. This
qualification covers the prepared synthetic package on that source and host, not
server admission or later source changes. The boundary resolves junctions,
symlinks and substituted drives using filesystem handles, binds observations to
the attempt, and holds/revalidates them across native work. String normalization,
a new report field, or a successful validator test alone cannot establish that
trust. Descendant-file aliases and filesystem replacement are excluded before
execution.

`verifyStoredNativePreview` separately verifies two registered objects (bundle
and export report) against one exact cumulative context, process and qualified
export source. It checks all required report predicates, geometry measurements,
native preservation claims, placements, export settings and actual STEP bytes.
No export yields `unavailable`; a mismatch throws without altering the native
context or substituting an earlier snapshot's geometry. This does not remeasure
the referenced native files or confer trust on a caller-supplied context.

There is no caller-facing endpoint, authenticated loader, database role/RPC,
storage policy, immutable registry writer, receipt transaction, owner recovery,
quarantine service or connected Windows transport in this slice. Public API or
worker code must not call these functions using self-issued admissions.

## Evidence and demonstration

Run the focused tests in `server/engineering/` and
`npm run demo:engineering-evidence`. The command replays the retained **7 mm
preview** for one editable synthetic part, verifies report/bundle/STEP bindings,
and parses the actual STEP using the existing Open Cascade dependency. It emits
snapshot/digest and measured geometry evidence; it never executes SolidWorks.
The command pins the context, sanitized report and bundle to fixed known hashes
before constructing simulated admission; a self-consistent replacement cannot
issue its own trusted fixture identity.

The retained native candidate files are from a distinct 5 → 8 mm qualification
run. Those tests prove actual native-byte measurement and report validation, not
a new 7 mm execution. Preview text fixtures are sanitized derivatives with new
report hashes; embedded STEP bytes and exact contexts remain unchanged. See
`server/engineering/fixtures/README.md` and `preview-fixtures.md` for provenance.

Current test evidence is distinct from historical local PostgreSQL proofs and
hosted review. A test replay is not a cross-device demonstration, a current-head
Windows qualification, a production migration or engineering release authority.

## Deferred authority and recovery

Reintroduction must use a separately reviewed, least-privilege design. The
preserved verifier role had effective access through inherited `PUBLIC` schema
usage and `PUBLIC EXECUTE`; removing its direct grant alone is insufficient.
Require catalog proofs for existing and newly created functions, scoped default
privileges for their actual owners, and legitimate-client regression tests.
The exact OVD-521 authority boundary, signature allowlist, owner/default rules,
migration order, proof matrix and rollback handling are defined in
[the native verifier database authority contract](verifier-authority-contract.md).
That document is a prerequisite for a later disposable migration proof, not a
migration or activation authorization.

Only after trusted immutable admission and effective permissions are verified
may a short locked transaction recheck eligibility and atomically persist the
receipt, snapshot, successor admission and event. Preserve stale/canceled/failed
evidence, keep successor work blocked and never free another attempt's occupancy.
Reintroduce rejection/recovery and preview association as separate bounded work.

No migration in this slice is deployed or rolled back. Revert source commits to
undo the validators; retain native fixtures and the preserved deferred source.

## OVD-509 implementation checkpoint (2026-09-24)

The new `PreparedFilesystemAdmission.cs` and runner wiring in
`codex/ovd-509-trusted-admission` replace the former missing writer for the
fixed synthetic prepared package only. Admission derives identities from open
Windows handles, holds input/candidate files and directory path components,
rejects reparse and substituted-drive aliases and all hard-linked files, checks closure, and
revalidates before and after native work. The runner records the bound attempt,
host and identities in `supervisor-final.json`.

An independent review found that an initially empty candidate `parts` directory
could acquire a junction in place after directory binding, redirecting the
path-based copy without changing its file ID. A Windows no-CAD fixture reproduced
the redirected copy and the missed recheck at `d475427f`. At `89580031`, fixed
candidate files are instead created relative to retained directory handles and
the recheck includes `candidate/parts`. Another review found that creating the
attempt by path under an initially empty output root could also redirect an
attempt directory before binding rejected it. Attempt and candidate directories
are now created relative to their retained parent handles, and the attempt has
a held internal anchor. The two adverse fixtures confirm both redirect targets
remain empty and admission is denied; all 16 current-source synthetic cases
passed at C# source SHA-256
`0fb86ba94226f28a4252ca3f5f03ec214ed09702edd56301e1e7a2340c136190`.

At executable source commit `9a4d2486b10f51b56811fc20c1fff3798f661002`,
x64 Windows PowerShell 5.1 on Workstation passed all 14 synthetic filesystem
cases with `nativeCalls=0` and unchanged source hashes. The retained receipt is
`C:/temp/ovd509-9a4d2486-0e0f1ffd/ovd509-3f79287aefe049459ff9ae0268c5f47c/result.json`
(source SHA-256 `6a40291c154d3bc8efd77082adc72028a8493b938b8f6dea7620bc697a9dceb8`).
One fresh 5 → 7 mm run from a newly copied exact three-file input also passed
all seven native checks, measured 5 → 7 mm, preserved the input and companion
hashes, and confirmed native exit 0 with an empty SolidWorks inventory. Its
attempt is `C:/temp/ovd509-run-582c9de3/11ebefda-f517-458f-aea7-bab8b4523a2e`;
the retained `result.json` SHA-256 is
`177d7137b48240d419416f2faceac80d5dc2006c008a022ac6dd1ceacbf830ee`,
and `supervisor-final.json` SHA-256 is
`21a5f53bde545fe7b7382a36f9b1dfa448cd3b1e86d5a56eae1ab5cbb0207057`.
The candidate remains unadopted. The older seed has extra `template/` and
`assembly-manifest.partial.json` entries and was correctly denied before native
launch; its evidence remains retained. These local receipts do not establish
server-authenticated admission, verifier authority, atomic finalization or
connected transport. OVD-510/511 and the connected companion remain separate
gates.

A new exact-source attempt at `89580031bfccee5ffcc44cc83d17e84019e8fbfb`
used a separate three-file input, context SHA-256
`7b3aea6c3e32f3ff4425a518a1ef36d4adb791e934e69aa9a1f1f0b7a5ad49f7`
and job SHA-256 `a8041f48ca4c6694a6102c924fe49e2b0129a9988e80b7f65c142884318b131a`.
Its attempt `044e44e2-8b6c-4b58-be14-3777f879f90a` under
`C:/temp/ovd509-n8958-b81432bb/runs` passed all seven native checks: measured
depth 5 → 7 mm and volume 1570.7963267948969 → 2199.1148575128555 mm³,
unchanged input/companion hashes, saved and reopened candidate, distinct input
and candidate handle IDs, native PID 6164 exit 0, and empty final SolidWorks
inventory. `result.json` SHA-256 is
`3cb7d32da3b04a1f9360b60f39fe9c467c57c262d4479ebb87bea04baefafa20`;
`supervisor-final.json` SHA-256 is
`9da1eb07d63b37a9083871756d554d1bb4aeb112d8a2a49a73bdf7c3ae544537`.
The output remains unadopted. This successful synthetic native run does not
establish isolation from another process that can write the candidate files.

The final executable source `a0e133b404430a8d498bf0713531f483b89fb73c`
also retains the SolidWorks executable path after verifying it. Its fresh
context SHA-256 was `57fb6c5b4b97597c96003aab6057e584ebcebcee27bb9f2034624ea4c7ae85c6`
and job SHA-256 was
`e708fb7c61c0709471c1e26525f064b175ae64ebd854b4c7798eaa87d0f7372f`.
Attempt `f86300cc-8da2-45d9-9036-90c43e2bed1d` under
`C:/temp/ovd509-na0e1-31cda4c5/runs` passed all seven checks with depth 5 → 7 mm,
volume ratio 1.4, unchanged input and companion, saved/reopened candidate,
distinct handle IDs, and native PID 13336 exit 0 with empty final inventory.
The final supervisor records the observed path
`C:\Program Files\SOLIDWORKS 2022\SOLIDWORKS\SLDWORKS.exe`.
`result.json` SHA-256 is
`8e5bbe46776cb1b7c3f18a906b3804b7869c8ddb8af3a1d66f551c6f945792fb`;
`supervisor-final.json` SHA-256 is
`a32232c6b74e0bc862c1eee8856d2da8960f9315d4e9d529b5c99d206ceb6c9d`.
This candidate is unadopted; the receipt does not claim server admission or
protection against a separate process authorized to edit the private candidate.
