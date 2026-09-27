# OVD-562 one-job companion lifecycle

This is a default-off source connection. It does not activate a worker, issue a
credential, admit a real Windows runtime, or qualify native execution. The only
job is an already admitted `overdrafter.prepared-dimension-job.v2` bound to one
task, runtime admission, input admission, paired installation, boot and session.
The owner supplies the three opaque admission IDs; the worker cannot select a
different task after starting. The server's existing native ownership RPCs
remain authoritative for claims, leases, fences and occupancy.

## State and authority

1. Poll the paired session. A new claim requires `enabled` and an exact current
   boot. Paused or expired sessions prohibit a claim; an existing attempt may
   drain within its fixed deadline. Revocation denies worker authority and
   retains occupancy until authorized recovery.
2. Persist the claim request and idempotency key before sending it. A missing
   reply is **unknown**, not a failed claim. Replay only the identical request
   to recover its receipt. A replay or restarted companion never starts native
   work; it enters visible reconciliation.
3. A fresh `api_native_attempt_eligibility` receipt, exact immutable job/context
   bytes and SHA-256, current fence, remaining deadline, and a new per-attempt
   journal are required immediately before the sole native launch. Historical
   claim or heartbeat receipts cannot grant launch authority. A preexisting
   attempt journal or output directory prohibits another launch.
4. Heartbeats use the attempt revision, stable key and exact fence. Successful
   renewal is bounded by the original ten-minute deadline. A missing heartbeat
   reply leaves the same request for explicit reconciliation and suspends new
   native effects. The companion writes a private revocation marker immediately;
   the runner checks that marker and its exact, bounded lease before native
   start and operation launch. Lease expiry, deadline, changed boot, revocation or unknown process
   state is visible `recovery_required`; it does not free occupancy.
   The owned helper checks the remaining budget again after durable launch
   intent, immediately before `Start`, and after creation acknowledgment.
   A blocked post-start acknowledgment can still leave that child running past
   the lease until the callback returns. The connected runtime is not qualified
   for live use until that running-child deadline case is closed.
5. No response or restart can automatically retry native mutation. The durable
   database retry policy and a higher fence are separate owner actions; the
   companion never invents either.

## Stop evidence

A worker's journal or `stopped: true` claim is not sufficient. The validator
must authenticate the exact worker and fetch retained journal/evidence bytes
from the trusted store. It checks the attempt, installation, original boot and
session, runtime admission, job/context digests and fence; a complete launch
forest with terminal identities; an independently qualified process-boundary
observation; and the observation time. It rejects absent, altered, incomplete,
late or cross-attempt evidence. The admitted record is immutable and private.
The worker-facing stop request contains only an opaque evidence ID and exact
attempt/fence. The retained canonical `overdrafter.native-stop-evidence.v1`
manifest binds its journal byte/hash and head, observed terminal set, outcome,
validator identity and time. An owner-only repository must atomically insert
the stable admission ID and invoke the existing stop RPC; no API role can insert
the private admission directly. This source seam supplies no production adapter
or validator key. An exact committed stop request can return its retained
admission and receipt after a lost HTTP response, even after slot release.
Different evidence IDs, request keys, revisions, and attempts remain new
requests subject to the occupied-slot gate.

Only after that admission can the existing `api_record_native_stop` transaction
release the matching occupied slot. Its `resultEligible` decision is separate:
success additionally needs current authority and independent OVD-561 verified
result finalization. A late stop cannot release a newer fence. On any uncertain
attestation, retain occupancy and show recovery required.

## Evidence required before live operation

Synthetic transport and runner tests prove protocol behavior only. Real Windows
qualification must demonstrate DPAPI retention, process identity and child-set
closure across interruption, PID reuse and surviving child cases, exact job
download, deadline handling and the stopped-process validator against a
disposable admitted runtime. Production gateway, database migration/adapters,
credentials, SolidWorks/PDM and customer files remain inactive until separately
authorized and qualified.
