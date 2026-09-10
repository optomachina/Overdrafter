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

The production storage adapter and narrowly privileged verifier writer still
require implementation and connected storage/database tests. Native journal
review is an integration dependency. No fixture-only admission may bridge these
missing gates. Failed verification reporting and preview attachment remain
integration work as well.

`scripts/test-engineering-native-results.mjs` targets only a named disposable
local container and the fixed `ovd505_native_results` database. It tests actual
PostgreSQL constraints, API-role refusal, duplicate and changed replay, rollback,
successor admission, pause/expiry drain and preservation of newer occupancy.
Its runtime/stop/verification admissions are explicitly simulated database-owner
fixtures. Real stored-byte/report validation is covered by separate server tests.
Race barriers exercise both revocation before the conversation lock is released
and revocation after the final eligibility check, during snapshot insertion.

No production activation occurs in this source slice. Rollback disables new
verification/finalization admissions and retains artifacts, snapshots, receipts,
attempts and occupancy. Never reset fences or erase history as recovery.

Storage design follows the documented separation between
[Storage access policies](https://supabase.com/docs/guides/storage/security/access-control)
and [object replacement](https://supabase.com/docs/guides/storage/uploads/standard-uploads).
The trusted service must enforce immutable registration even when its underlying
storage credential bypasses client policies.
