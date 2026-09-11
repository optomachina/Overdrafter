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
The capture writer is **not implemented or qualified here**. It must resolve
junctions, symlinks and substituted drives using filesystem handles, bind those
observations to the attempt, and hold/revalidate them across native work. String
normalization, a new report field, or a successful validator test cannot establish
that trust. Descendant-file aliases and filesystem replacement must also be
excluded at the native admission boundary before execution.

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

Only after trusted immutable admission and effective permissions are verified
may a short locked transaction recheck eligibility and atomically persist the
receipt, snapshot, successor admission and event. Preserve stale/canceled/failed
evidence, keep successor work blocked and never free another attempt's occupancy.
Reintroduce rejection/recovery and preview association as separate bounded work.

No migration in this slice is deployed or rolled back. Revert source commits to
undo the validators; retain native fixtures and the preserved deferred source.
