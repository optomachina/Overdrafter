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

## Admission contracts for the first migration

The following are the specified implementation shapes for this slice. They are
private records, not new worker-facing requests. A worker may submit evidence
to the future validator; it cannot choose an admission verdict or insert these
records. No admission fixtures are seeded by the deployment migration.

| Contract | Required identity and content | Admission and invalidation |
| --- | --- | --- |
| Runtime admission | UUID; existing worker/installation/org/project/owner composite identity; exact native job schema `overdrafter.prepared-dimension-job.v2`; qualified source-manifest, native executable, interop and compiler SHA-256 digests; runtime/platform manifest digest; qualification evidence manifest digest; validator/policy version; authorizing actor and timestamp. | Separate privileged qualification operation. A session enablement cannot create it. Any code/runtime/policy identity change requires a new admission; revocation is append-only history plus current eligibility state. |
| Input admission | UUID; existing snapshot/org/project identity; exact UTF-8 context bytes and SHA-256; complete ordered native file manifest with immutable storage identities; qualification or finalized producing attempt; requirements/check-policy identity; validator version; admission evidence digest. | Qualified seed import or successful independent finalization only. The context must pass the v2 validator. Candidate input requires all seven checks and exact predecessor identity. A missing, revoked or stale admission never falls back to the seed. |
| Stop admission | UUID; exact attempt, worker/installation, original boot/session, fence and runtime admission; exact job/context digests; launch-journal and immutable evidence manifest digests; terminal process set; observation time; validator/policy version; observing authority; verdict. | Qualified evidence validator or explicitly authorized recovery operation only. An admission can release only its own occupied slot; it never sets engineering verification or authorizes a new worker session. |

Keep native job bytes unchanged: worker/session/runtime identities belong to the
outer claim and journal, not extra fields added to the strict v2 job. The claim
stores both outer bindings and the exact native bytes/digest. UUID and digest
formats, safe integer limits and UTF-8 size bounds follow the existing native
and worker contracts; a JSON round trip does not preserve byte identity.

Runtime admissions use the existing
`engineering_workers(id, installation_id)` and scoped worker keys. Input
admissions use `engineering_snapshots(id, organization_id, project_id)`.
Add scoped unique keys for existing tasks where necessary before declaring
attempt foreign keys. Do not weaken an existing scope constraint or use a
single-column reference as a replacement for tenant consistency.

The SQL implementation stores these admission records in `engineering_private`
with no direct reads or writes by anon, authenticated or the worker-facing
service role. Exposed security-definer operations consume admission IDs after
full tenant/runtime checks; they do not accept equivalent caller-selected hashes
as substitutes. The separate validator's insertion path is not deployed or
granted by the ownership-only slice. Synthetic pgTAP fixtures use the local
database owner. Activation stays disabled until this trusted writer exists and
is qualified; a private table alone does not authenticate evidence.

### Process evidence shape

The future companion journal has schema `overdrafter.native-attempt-journal.v1`
and a bounded sequence of immutable records. Every record binds its sequence,
prior-record digest, attempt/fence, worker installation and originating boot,
native job digest, runtime admission and event kind. An authenticated transport
envelope binds the reporting boot separately; recovery after a restart must
retain the original attempt boot rather than rewriting its history.

Before spawning any helper or native process, durably record launch intent,
executable digest and private working directory. Record each created process's
PID, creation time in Windows ticks, Windows session, executable path/digest,
role and parent-launch record. Terminal records bind that exact creation identity
to observed exit, exit code and observation time. Native, compiler, lifecycle and
operation helper processes all belong to the evidence set; a closed SolidWorks
process alone does not prove its operation helper stopped.

The bounded validator must account for every launch intent and every owned
process. Any missing, inconsistent, reused-PID or unknown-child boundary keeps
the slot in recovery. Neither an empty process-name inventory nor a changed
boot is a terminal observation. A crash between durable launch intent and
process identity capture requires the separately qualified recovery procedure;
the normal receipt path cannot infer that no process launched.

Journal persistence must use exclusive ownership, a same-directory temporary
file, flush-to-disk and atomic replacement with acknowledged write completion
before the corresponding effect. OVD-500's credential-store qualification is
evidence for its storage implementation only; it does not qualify this new task
journal. The native runner's current `progress.json` and supervisor receipts
remain immutable evidence inputs, not replacements for that journal.

Stop verdicts are `all_owned_processes_exited` or
`no_launch_proven_by_recovery`. The latter is available only to the separate
authorized recovery validator after the exact launch gap has been resolved;
it is never derived from a worker's `nativeStarted: false` claim. Both verdicts
leave result verification independent and preserve the original observation.
Uncertain evidence receives no stop admission and cannot release the slot.

### Finite failure policy v1

Every attempt failure records a versioned code plus evidence identity. Human
explanations may accompany the code but are not inputs to retry classification.

| Code | Meaning | Automatic retry |
| --- | --- | --- |
| `native_startup_timeout` | The qualified runtime reached its bounded startup deadline before package opening or an operation launch. | At most once, only after separate stop admission, current runtime/input eligibility and a newly claimed fence. |
| `input_invalid` | Exact context, operation, native file closure or supported bounds failed admission. | No. |
| `runtime_mismatch` | Executable, interop, compiler, source, process or supported runtime identity differs. | No. |
| `native_operation_failed` | The native operation or a mandatory native check failed. | No. |
| `artifact_invalid` | Missing, altered, incomplete or invalid saved outputs/evidence. | No. |
| `deadline_exceeded` | The fixed overall attempt deadline elapsed. | No. |
| `authority_lost` | Lease, credential, boot or required access no longer permits the attempt. | No. |
| `process_uncertain` | A launch or termination boundary cannot be established. | No; retains occupancy pending recovery. |
| `unclassified` | Unknown outcome or legacy free-text failure. | No. |

The first retry allowlist contains only `native_startup_timeout`. Its positive
classification requires new structured runner instrumentation plus qualified
fault-injection evidence. Current GUI/API timeout exception strings do not
establish this code. Until that instrumentation exists, those outcomes are
`unclassified` and may require recovery. Transport errors before a claim, upload
retries and duplicate HTTP delivery are not new native attempts and do not
silently consume or reset the native retry counter. Transport uncertainty after
a launch is a recovery concern, not automatic transient eligibility.

Explicit owner retry is a separate transition: it rechecks unchanged input and
runtime admissions, complete stop evidence, revisions and current enabled
session. It preserves failure and automatic-retry history. A different operation
or corrected input is a new accepted decision, not a retry that rewrites the old
attempt. No failure code, including the transient code, substitutes for stop
evidence or grants execution authority by itself.

## Implementation and verification gates

The current prepared runner already writes `progress.json` before native launch,
then records PID, creation ticks, Windows session and executable path. Its final
supervisor records process exit and recovery requirements. These local records
are useful inputs to the new validator, but they are not authenticated durable
server observations. `Save-PreparedProgress` currently writes directly to a local
file, and `failureReason` is free text; neither should be treated as a complete
companion journal or a deterministic retry classification. Preserve the existing
operator lane while qualifying the new journal/receipt path separately.

The admission shapes above are grounded in the current runner and companion
code. The current companion handles sessions only; its future task journal and
process reporting must implement these contracts, not merely call new database
functions. The ownership migration may now define their constrained private
records and consumption, while their privileged writer, typed native failure
instrumentation and actual recovery qualification remain explicit activation
dependencies. Do not fill those dependencies with permissive placeholders.

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
