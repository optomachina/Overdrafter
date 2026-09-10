# Native task ownership and recovery

OVD-501 design contract, September 10, 2026. This is proposed implementation
guidance for the approved private automatic-loop milestone, not a description
of deployed APIs. OVD-497 records accepted changes; OVD-498/499 supplies worker
identity and enabled sessions; OVD-495 supplies the cumulative native protocol.
None of those alone owns an executing task.

The first coordinator slice establishes attempt ownership and recovery. Artifact
transport, successful verification/finalization and connected companion dispatch
remain separate required slices. Until those admission paths exist, a source
migration must not enable execution by inserting synthetic qualification rows.

## Invariants

1. An organization has at most one occupied native execution slot in this pilot,
   including across conversations and after worker revocation/replacement.
2. A claim binds an exact worker installation, boot, owner-enabled session,
   runtime qualification, task, decision, input snapshot and immutable job bytes.
3. A successor uses its explicitly recorded predecessor's verified output. A
   missing predecessor never falls back to the request's original snapshot.
4. Task execution, physical process state, verification and adoption remain
   separate. A process exiting zero cannot set verification to passed.
5. Lease expiry or a new boot ends execution authority but does not prove process
   exit. Uncertain process state retains the execution slot.
6. Retry requires admitted evidence that the old process cannot still execute,
   plus a permitted retry decision and a new, strictly higher fencing token.
7. Historical receipts never grant current authority. Replaying a delivery must
   neither repeat a native launch nor change an authoritative candidate head.
8. Evaluation cannot write authoritative files. Database fencing protects state;
   isolated private filesystem scope protects files from an obsolete process.

## Proposed records

Use additive tables rather than replacing the inbox, decision or worker tables.
Every tenant reference uses the established composite organization/project/owner
keys. Private admission/evidence records have no direct API-role write grants.

| Record | Purpose and immutable bindings |
| --- | --- |
| Runtime admission | Exact worker installation, supported capability/version, runtime/source digests, reviewed qualification evidence and revocation state. Owner session enablement cannot create qualification. |
| Input admission | Exact stored snapshot/context bytes, native artifact manifest and source provenance. A seed requires qualified imported bytes; a successor requires the complete finalized verification set and producing attempt. |
| Execution slot | Organization-wide native occupancy and monotonically increasing fence. Retained independently of worker revocation so a replacement cannot evade unresolved occupancy. |
| Execution attempt | Task/decision, worker/boot/session, fence, input admission, exact v2 job bytes and digest, fixed deadline, lease/revision, process phase and result eligibility. |
| Process observation | Immutable admitted evidence about the exact owned process, including executable/source identity, process creation identity and terminal observation. Separate from a worker's unvalidated claim. |
| Attempt event | Append-only transition arguments, actor/source, expected/result revisions, idempotency identity and receipt. No credentials or raw secret digests. |

Proposed names and RPC signatures must be checked against generated types and
schema conventions before migration. Input admissions are not a second geometry
model. They record why exact snapshot/artifact bytes are eligible for execution.
The snapshot table's existing wire-identity constraint is insufficient evidence.

## Lock order and admission

All coordinator transitions use one order: organization execution-slot lock,
worker row, existing conversation advisory lock and conversation row, then task
and attempt rows. Reuse the inbox's advisory-lock key; do not introduce another
lock for the same conversation. Existing session-only operations lock the worker
without taking a conversation lock; intake/cancellation currently locks the
conversation without taking the worker. Preserve that acyclic ordering when
adding recovery and finalization. Document every new path's acquired locks.

Claim in a short transaction; CAD and network transfer run outside it. After all
lock waits, recheck owner access, allowlist, worker credential, exact boot/session,
runtime admission, available slot, expected revisions, decision status and input
admission against database wall time. A disabled/expired session returns a finite
ineligible result rather than silently dispatching.

Choose only the first eligible outstanding decision in its ordered chain. The
original request order and explicit canceled suffix remain authoritative. Freeze
the native v2 job, its exact context bytes and admitted input identity once; do
not regenerate JSON on a duplicate delivery. Registering the attempt, occupying
the slot, changing task state and recording the receipt is atomic.

A claim deadline is fixed and at most ten minutes after admission. Heartbeats
arrive every ten seconds and extend a sixty-second lease only up to that fixed
deadline. The companion must use the remaining deadline, not start a fresh
ten-minute native timer after slow download or admission. A heartbeat cannot
revive an expired attempt or change its inputs.

## Process and result state

| Observation or action | Execution slot | Result/next-task consequence |
| --- | --- | --- |
| Task claimed; process not yet observed | Occupied | Only the exact attempt may start after current authority is checked. |
| Owned process running with valid lease | Occupied | Heartbeats renew within the fixed deadline; successor remains blocked. |
| Lease expires, boot changes, or process status becomes unknown | Occupied, recovery required | Attempt cannot renew/start; outputs are historical until explicit reconciliation establishes their permitted use. |
| Confirmed owned-process failure/stop | May release after admitted stop evidence | Task fails or awaits its distinct result check; no automatic success or predecessor release. |
| Confirmed successful process exit | May release after admitted stop evidence | Result still needs complete artifact verification and finalization. Exit zero is insufficient. |
| Permitted retry after confirmed stop | New occupancy and higher fence | New attempt, same accepted intent; old attempt/output history retained. |
| Explicit cancellation of failed change and pending suffix | Requires uncertainty resolved first | Preserve decisions/events; no rewrite of existing predecessor links. |

Physical slot release and result eligibility are distinct. A stopped process can
free the worker while server verification is pending. A later conversation may
use the free worker; a dependent task cannot run until its own predecessor is
verified. Do not lose the current result-eligible attempt when freeing the slot.
An obsolete attempt's late receipt cannot release a newer attempt's slot.

Pause and session expiry prohibit new claims; the already active job drains
under its fixed deadline. Its current attempt can send the bounded heartbeats
and terminal evidence needed to finish even though new-claim eligibility is
false. Credential revocation or owner access loss is different: deny new worker
authority, retain occupancy, and reconcile process state through the separately
authorized recovery path. Never turn access loss into a claim that CAD stopped.

## Evidence admission and trust

The Windows companion first persists a per-attempt journal before a launch. The
journal binds the attempt/fence to owned-process creation and executable identity.
A timeout, PID alone, process-name search, reboot report, or `stopped: true` field
is not a stop attestation. PID reuse and a surviving child process are explicit
adverse cases. If a crash happened between process launch and identity capture,
the record remains uncertain until the qualified reconciliation procedure can
establish the process boundary; a missing journal entry is not proof of no launch.

A narrow server validator must authenticate the reporting worker, bind the
receipt to its exact journal/attempt/runtime, inspect immutable retained evidence,
and record an admitted observation before the database can release occupancy or
permit retry. These attestations rely on the qualified companion/runtime trust
boundary; cryptographic hashes alone do not prove Windows process behavior.
Unrelated SolidWorks processes prevent startup and are never closed by recovery.

The ownership migration may define the admission reference contract but cannot
offer a public bypass that accepts arbitrary artifact hashes or a shutdown
boolean. The actual upload/validator integration must be present and qualified
before activation. SQL tests insert synthetic admission fixtures only as the
disposable database owner and label them as simulated evidence.

## Retry, cancellation and receipts

Failure classification is deterministic and versioned, derived from qualified
runner outcomes. Freeze the finite retryable-code list before implementing retry;
do not use model prose, message substrings or every nonzero exit as transient.
At most one automatic transient retry is permitted for the accepted task, across
worker restarts and boot changes. The retry counter is durable, not local memory.
Permanent failures block the pending suffix. Explicit owner retry requires
expected revisions, unchanged valid inputs, admitted stop evidence and current
session/runtime authority; it cannot erase the automatic-retry history.

Canceling a failed change includes its exact pending suffix and a reason. Running
or uncertain effects require reconciliation first. Preserve the existing suffix
validation, immutable decisions and sequence numbers; finalization and recovery
must serialize with cancellation. A failed check stays failed even when the user
cancels or retries the associated change.

State-changing requests carry stable idempotency keys and expected revisions.
Identical replay returns historical receipts without repeating a transition;
changed arguments under the same key conflict. Consumers separately read current
attempt eligibility before native effects. Replayed old enablement, claim or
heartbeat receipts must not extend the current lease or grant a new launch.
Failed, canceled, expired or superseded result-ineligible attempts reject new
heartbeats and finalization. A confirmed process exit can still await verification
while its result remains eligible; process termination is not task completion.

## Implementation and verification gates

The current prepared runner already writes `progress.json` before native launch,
then records PID, creation ticks, Windows session and executable path. Its final
supervisor records process exit and recovery requirements. These local records
are useful inputs to the new validator, but they are not authenticated durable
server observations. `Save-PreparedProgress` currently writes directly to a local
file, and `failureReason` is free text; neither should be treated as a complete
companion journal or a deterministic retry classification. Preserve the existing
operator lane while qualifying the new journal/receipt path separately.

Before the migration, finalize three contracts from the actual runner and
companion code: runtime admission, stop-observation admission, and the finite
failure classification. The current companion handles sessions only; its future
task journal/process reporting must implement those contracts, not merely call
new database functions. An unresolved evidence boundary blocks activation and
must remain visible in the issue; do not fill it with a permissive placeholder.

The ownership/recovery migration and its independent SQL/concurrency suite form
one reviewable slice. Artifact verification/finalization forms another: it must
authenticate, measure stored bytes, validate all seven checks against exact v2
bindings and atomically publish only the current eligible candidate head.
Transport and companion integration then exercise both together on Windows.

Required local cases include competing claims across conversations, revoked
worker replacement while occupancy persists, duplicate/mismatched idempotency,
clock expiry and access revocation during lock waits, deadlock probes, stale
heartbeats, deadline exhaustion, new boots with old native work, PID reuse,
missing process journals, late old receipts, retry exhaustion, failed suffix
cancellation and all owner/tenant/credential mismatches. Repeat the established
inbox, queue and session tests against the new migration.

Actual Windows qualification must interrupt the companion/native process at the
launch, identity capture, save, stop, upload and finalization boundaries. Prove
no overlapping native processes, no authoritative-file writes, retained private
outputs, exact retry counts and truthful recovery-required status. Database and
mock-worker tests cannot establish those Windows facts.

Migration rollback disables new claim/recovery API admission, drains or explicitly
reconciles the current process, and preserves slots, attempts and evidence. Do
not delete occupancy, reset fences or restore a backup as a substitute for
reconciling live external effects. Deployment remains default-off and needs the
separate reviewed activation packet required by the automatic-loop milestone.
