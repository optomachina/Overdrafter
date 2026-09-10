# Native result verification and finalization

OVD-505 implements the next part of the approved automatic engineering loop.
This document describes the contract under implementation; it is not a claim
that the service, persistence or production activation is complete.

## Trust boundary

The worker submits immutable objects for its exact attempt. A server verifier
loads their registry entries through authenticated coordinator scope, reads the
actual bounded bytes, and checks their identities and contents. An object name,
worker hash, metadata length or list of passing checks supplies no authority.

The verifier consumes a trusted runtime admission and the exact process-stop
admission that kept this attempt result-eligible. It binds native and helper
creation identities to the stored reports. The report parser never manufactures
that admission. Runtime qualification and process-stop admission remain distinct
from the physical measurements recorded by the native probe.

## Verification policy

The first policy supports only the prepared two-cylinder assembly and Default
configuration. It consumes the existing v2 job/context/result, input-identity
report, source-preservation report and native-dimension report. Five mandatory
checks legitimately share the same native report; missing evidence cannot be
replaced by repeating another report's digest.

Report validation checks all required predicates plus the underlying measured
depth/volume, extrusion semantics, native rebuild errors, exact dependency
closure, component transforms, save results and final reopen observations.
Unknown, omitted, failed or contradictory required observations fail closed.
Malformed JSON, duplicate keys, invalid units/numbers and oversized reports are
invalid evidence. Windows paths are observations only and never storage keys.

Sanitized retained synthetic report fixtures exercise the parser. They are not
new CAD runs, stored native-file proof or runtime qualification. The existing
qualified source and its retained evidence remain the basis for admitting the
corresponding runtime; changes to the native report contract require a new
versioned verification policy and affected qualification.

## Stored objects and commit

Use server-owned attempt/object identifiers, a private bucket and bounded
allowlisted roles. Registration pins digest and byte count. Read and hash outside
database transactions. Finalization consumes an immutable verification receipt,
not arbitrary fields from the worker or browser. Accepted objects cannot be
replaced or deleted by clients; later reads check exact bytes again. This is an
application invariant, not a claim of storage-provider write-once semantics.

The short finalization transaction uses OVD-501's lock order: organization slot,
worker, conversation advisory lock/row, task, attempt. After lock waits it
rechecks current access, worker/runtime/input admissions, exact result-eligible
attempt/fence, uncanceled decision and predecessor. It then commits the immutable
snapshot/context, verification receipt, successor input admission and event
together. An identical replay returns its existing receipt; altered replay
conflicts. No finalization releases a newer attempt's slot.

Finalization additionally locks the runtime admission, then input admission
`FOR UPDATE`. These locks conflict with the key-share locks taken by revocation
foreign keys, so a revocation cannot commit between the final eligibility check
and the candidate commit. It then locks the applicable operator, organization
membership, project and project membership rows `FOR SHARE` before rechecking
access. Future writers must preserve this ordering. Revocation after a completed
finalization is a subsequent event; it does not erase the historical receipt.

Paused/expired execution sessions can drain already admitted work under the
coordinator contract. Revoked access, uncertainty, lost result eligibility or a
superseded attempt cannot be converted into success by a late upload. Upload or
verification retry never repeats CAD. Failed and incomplete results remain
retained evidence, with dependent work blocked.

STEP previews bind to exact finalized native context and output bytes. Missing
preview is explicitly unavailable; preview verification never substitutes for
native verification or authorizes engineering release. Candidates remain
unadopted.

## Remaining implementation gates

The bounded parser and registered-object byte verifier are implemented as
server-side helpers. The reader accepts only registry identifiers, limits
response size and elapsed time, and hashes the actual received bytes. It checks
v2 consistency and report semantics before returning a candidate for the later
transaction. Its supplied reader and admission are trusted internal inputs;
neither helper is a public endpoint or proof of current database authority.

The additive migration implements private immutable object registration,
sealed manifests, verification receipts and an atomic finalization operation.
The operation accepts a preexisting trusted receipt, checks the current attempt,
advances the conversation, and commits the snapshot, successor input admission,
task state and event together. Anonymous, authenticated and service API roles
cannot create verification receipts or register objects. A service-only RPC may
consume an existing receipt with a matching worker credential; it cannot mint
verification by accepting a worker-supplied verdict or hash.

### Verifier authority and delivery

The second additive migration creates a separate `engineering_native_verifier`
NOLOGIN role with only the two verifier RPCs and constrained storage reads. It
has no direct write grants to result registrations, receipts or native files.
Neither worker credentials nor the gateway's service role can invoke verifier
RPCs. A privately admitted principal pins organization, project, implementation
digest, policy and validator version, with expiry and one-way revocation. The
digest is an operational deployment admission, not proof that code executed.
Principal enrollment and JWT issuance require the reviewed activation process;
the migration provisions neither.

The qualified stop validator must supply an immutable `report_binding` containing
the native/helper process identities, candidate root and exact native report
digest. A missing binding cannot enter verification. Supplying this binding from
worker claims or a test fixture cannot replace qualification of that writer.

`createNativeVerifier` is a default-off server factory with a pinned HTTPS project
origin and verifier credential. It loads a server-bound manifest and 60-second
verification run, reads only registered private objects, hashes and validates
their bytes, then submits the checked context to completion. It never accepts
storage URLs from a caller. Storage has both permissive and restrictive policies
so an unrelated PUBLIC policy cannot broaden this role's registered-object
access. Reads also require current principal, project, runtime and input access.
RPCs have bounded bodies and the client has an overall deadline. JWT decoding in
the client is a configuration guard; platform signature/expiry validation is
still required before role selection.

Completion creates its receipt and invokes finalization in one transaction.
Verifier principal revocation is serialized by a shared row lock. A finalization
trigger rechecks principal/run deadlines after admission and snapshot lock waits;
expiry rolls back the receipt and candidate together. An identical load after a
lost completion response returns the committed receipt without re-reading files.
Historical recovery requires current verifier/project access but does not require
the originating worker to remain enabled or unrevoked.

Connected local tests exercise this client with real PostgreSQL role/RLS checks
and actual retained native bytes served over local HTTP. Native admission and
JWT signature validation are explicitly simulated. These tests do not qualify
the deployed Supabase Storage API, hosted JWT authentication, Windows execution
or the complete worker-to-result workflow.

### Remaining integration

The server factory and RPCs need a deployed, qualified caller and storage-upload,
runtime/input/stop-admission integration. Native journal review remains an
integration dependency. No fixture-only admission may bridge these gates.
Exact preview attachment and the authenticated workspace's consumption of the
result/failure APIs remain implementation work. No connected customer workflow
or activation is claimed.

### Failed verification and owner recovery

The third additive migration records immutable `native_verification_failures`
bound to the exact verification run, attempt and manifest. Definite size/digest
mismatches include the registered object identity and measured discrepancy.
Rejected native reports retain a bounded predicate label; JSON parser excerpts
are excluded because they may contain private document contents. Process
admission is validated before evidence classification. Malformed admission,
unavailable storage, transport failures and interrupted verification never become
terminal engineering-check failures; they leave the stored attempt eligible for
verification delivery recovery while its authority remains valid.

Only the scoped verifier can reject a run. The rejection transaction rechecks
identity, access, current attempt, source head, stop evidence, admissions and
deadlines under the coordinator locks. It stores the failure, marks the task's
verification and overall execution failed, closes result eligibility, and records
the transition together. The original native-stop receipt still records whether
the CAD process exited successfully. No snapshot or successor admission is
created, no later decision is skipped, and another attempt's occupancy is never
released. Deadline checks after writes roll everything back if an intervening
lock wait outlasted authority.

Identical sequential or concurrent rejection deliveries return the same receipt;
changed replay conflicts. The load endpoint recovers rejected history after a
lost response, even after worker revocation or a later owner retry, while current
verifier/project access remains required. The authenticated owner can inspect
the exact failure through `api_get_native_verification_failure`; other users and
worker credentials cannot read that history through this API.

An explicit owner retry can admit a new native attempt against the unchanged
qualified input. The current task returns to unverified only when that new
attempt is claimed. Its predecessor link and immutable failed evidence remain
intact. Evidence rejection never authorizes an automatic native retry. The owner
may instead cancel the exact failed change and pending suffix, with a reason;
partial suffix cancellation is rejected. Approval of failed evidence is not
introduced by either recovery action.

`scripts/test-engineering-native-results.mjs` targets only a named disposable
local container and the fixed `ovd505_native_results` database. It tests actual
PostgreSQL constraints, API-role refusal, duplicate and changed replay, rollback,
successor admission, pause/expiry drain and preservation of newer occupancy.
Its runtime/stop/verification admissions are explicitly simulated database-owner
fixtures. Real stored-byte/report validation is covered by separate server tests.
Race barriers exercise both revocation before the conversation lock is released
and revocation after the final eligibility check, during snapshot insertion.

### Exact preview evidence

`verifyStoredNativePreview` reads two bounded registered objects: the cumulative
preview bundle and the native export report. It accepts an exact finalized v2
candidate context and a separately trusted, completed export admission. The
admission loader must establish access, immutable object ownership, qualified
exporter source/process, and normal shutdown. Worker-supplied bundle labels,
report claims, or a successful native edit cannot create that admission.

The verifier measures actual sizes and hashes, bounds stream progress and total
time, rejects duplicate JSON keys, then reuses `readCumulativePreview` for exact
context/producer/native closure and STEP identity. It independently checks all
89 predicates in the qualified 2022 SP5 export envelope, both native-file
observations, measured target/companion geometry, private document opens,
dependency closure, fixed component placement before/after export, read-only
state, STEP settings, clean export outcome, and admitted process/source identity.
It returns frozen preview data for that snapshot only. This checks admitted
observations; it is not fresh geometry measurement or worker authentication.

No supplied export returns `unavailable/not_exported` against the exact candidate.
Invalid supplied evidence throws; callers must not substitute an earlier preview
or mark independent native verification failed. Native verification/adoption
remain separate from display readiness. Baseline display retains its existing
operator contract; this server function requires a candidate context.

The retained 9 mm and 7 mm byte fixtures are documented in
`server/engineering/fixtures/preview-fixtures.md`. Tests simulate trusted
admission and registration while replaying actual export bytes, and alter
measurements/identities with matching test hashes to exercise semantic rejection.
The function is currently a server library, not a deployed endpoint. Persistent
preview registration, trusted export admission loading, action-time access checks
and authenticated workspace delivery remain integration work; there is no
permissive fallback or automatic activation. The portable `CadPreviewSource`
type is shared without importing browser storage or renderer implementations
into the server type graph.

No production activation occurs in this source slice. Rollback disables new
verification/finalization admissions and revokes verifier principals, retaining
artifacts, snapshots, receipts, attempts and occupancy. Keep role grants and
storage policies under the same reviewed migration/activation process; never
grant a broader service credential to work around a failed verifier read. Never
reset fences or erase history as recovery.

Storage design follows the documented separation between
[Storage access policies](https://supabase.com/docs/guides/storage/security/access-control)
and [object replacement](https://supabase.com/docs/guides/storage/uploads/standard-uploads).
The trusted service must enforce immutable registration even when its underlying
storage credential bypasses client policies.
