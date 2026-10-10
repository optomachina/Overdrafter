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
   In the connected path, the runner requests fresh server eligibility after
   durable native launch intent and immediately before `SolidWorks.exe` start.
   `NativeSessionProbe` and `PreparedDimensionProbe` start inert. Each helper
   effect request carries a fresh nonce and per-launch monotonic index over its owned
   standard streams. The runner first records the exact child creation, then
   relays the request over inherited anonymous pipes to the credential-owning
   companion. The companion checks current server eligibility for that effect
   and returns a one-use release with the exact attempt, fence, child creation
   identity, deadline, lease and revision. The helper denies a missing, altered,
   repeated, expired or revoked response before entering that effect. A later
   successful heartbeat may extend the local lease while an earlier one-use
   release is in transit; the helper accepts that release only if its nonce,
   index and exact identity match and the current lease/revision are no older.
   The original deadline and lease also bound every wait. A stalled post-start
   journal acknowledgment leaves the helper inert and unable to enter COM.
   This is a source and inert-Windows claim until connected native qualification
   proves the actual process and call boundaries.
   An in-flight SolidWorks COM call can outlast a later revocation or lease;
   its process remains occupied and requires explicit reconciliation.
5. No response or restart can automatically retry native mutation. The durable
   database retry policy and a higher fence are separate owner actions; the
   companion never invents either.

After a successful observed runner result, freeze all seven immutable output
spools and their exact attempt/scope descriptor before any output send. Retention
is local and cannot be lost merely because another session HTTP check fails.
The task then awaits qualified stop admission. OVD-560 registry writes require
that admission (`awaiting_result`, `result_eligible`, `stop_admission_id`); the
companion must not upload-and-register before it. The separate default-off
`replay-output.ps1` uses only the retained descriptor/spools and current session,
and the server enforces stop eligibility at registration. A lost response replays
identical bytes. Partial retention without a descriptor remains recovery-required;
it cannot cause a second native launch or a mutable-source reconstruction.

## Stop evidence

The connected runner requires a separately prepared runtime profile and its
owner-supplied SHA-256. `prepare-runtime.ps1 -Prepare` creates a fresh private
bundle before observation: the OVD-574 WindowsApplication host, detached process
adapter, precompiled filesystem admission with source binding, exact source
inventory, engine, standalone Roslyn compiler dependencies and explicit Framework
references. Preparation installs nothing and supplies no native qualification.
`run-task.ps1` validates and locks those files before opening the paired store.
The host executes `PreparedRunnerBootstrap.ps1`; compiler/native/lifecycle/operation
children use the detached adapter. The connected path cannot fall back to
ConsoleHost or the historical Framework compiler. The authority pipe interop uses
fixed Reflection.Emit declarations and cannot launch an unjournaled compiler.

The independent OVD-574 observer runs in a separate runspace in the trusted
companion process, outside the prepared root job, concurrently with the existing
heartbeat/effect authority loop. Only the exact root receives authority client
handles; no token enters the root or observer. Lost authority prevents new
releases; the observer continues within the original fixed deadline. Observer
failure or job cleanup cannot certify a stop. Connected observation always disables
kill-on-job-close: observer deadline/error/exit preserves uncertain native
processes for explicit recovery. Only the inert fixture lane may enable automatic
job termination. Clean authority EOF stops renewal and new releases while final
journal/result flush and independent terminal observation finish; truncated frames
still require recovery. A completed canonical
`overdrafter.native-stop-observer.v1` manifest and exact journal are retained for
restricted OVD-575 validator ingestion. The older worker-constructed
`overdrafter.native-stop-evidence.v1` shape is not accepted.

A local manifest does not authenticate its producer or free occupancy. OVD-575
requires independently provisioned validator attribution and a server-owned
qualified profile. After that separate step returns an opaque evidence ID, the
OVD-577 default-off `/functions/v1/engineering-worker-stop` endpoint authenticates
the paired token and invokes OVD-576's restricted atomic transaction with exact
worker/boot/task/attempt/fence/revision/key. It cannot use a service-role executor,
worker verdict, terminal set or caller-supplied completeness. Exact same-key
replay recovers a committed receipt after a lost response. Unknown outcomes retain
occupancy until that receipt is recovered. A stale/foreign fence cannot release a
newer slot; `resultEligible` remains separate from `verification: unverified` and
OVD-561 result finalization.

The retained parent's in-memory admission tests were replaced by receipt-boundary
tests. Evidence authenticity, journal completeness and occupancy races are owned
by the merged OVD-575/576 SQL fixture suites; OVD-577 HTTP/SQL tests cover the
restricted deployed-handler source path. No privileged parent repository or old
manifest adapter remains.

## Evidence required before live operation

Synthetic transport and runner tests prove protocol behavior only. Real Windows
qualification must demonstrate DPAPI retention, process identity and child-set
closure across interruption, PID reuse and surviving child cases, exact job
download, delayed creation acknowledgment, each effect release, deadline
handling and the stopped-process validator against a
disposable admitted runtime. Production gateway, database migration/adapters,
credentials, SolidWorks/PDM and customer files remain inactive until separately
authorized and qualified.
