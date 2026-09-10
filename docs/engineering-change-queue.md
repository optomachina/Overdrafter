# Ordered engineering change admission

OVD-497 adds the ordered admission portion of the private automatic-loop
milestone, following the [durable inbox](engineering-inbox.md). The whole loop
still requires cumulative native qualification, the coordinator/companion,
AI interpretation, connected UI and activation. This migration runs no AI or CAD
and seeds no operator access.

## Meaning of the records

Each inbox request receives at most one immutable interpretation. Its outcome is
`prepared_change`, `needs_context`, or `no_change`. A clarification is a completed
response to that message, with `needs_context` retained on the request. An answer
arrives as a new inbox message; the future interpreter must include relevant
conversation context. Neither clarification nor no-change outcomes create a CAD
decision or consume native queue capacity.

A prepared change creates one immutable accepted decision and one blocked task.
Only absolute `baseline-depth` changes of 6–10 mm in `Default` on
`ovd-native04-assembly` are supported. The operation records its unit explicitly.
A decision binds the exact requested snapshot and context hash, original request
through its interpretation, and the last noncanceled accepted predecessor.
Sequence numbers are never reused after cancellation.

These are accepted intentions. Tasks begin `blocked`, verification remains
`unverified`, and adoption remains `unadopted`. There is deliberately no realized
input or output claim in this admission contract. The coordinator must later
freeze inputs from the verified predecessor using the cumulative v2 contract;
it cannot substitute the requested snapshot for a missing predecessor result.

## Server interpretation API

`api_resolve_engineering_request` accepts:

- `p_request_id`: exact inbox request.
- `p_expected_revision`: current change-queue revision (zero before its first resolution).
- `p_idempotency_key`: caller-generated UUID, stable across delivery retries.
- `p_outcome`: one of the three outcomes above.
- `p_depth_mm`: bounded number for a prepared change; null otherwise.
- `p_response`: nonblank explanation or clarification, at most 4,000 characters.
- `p_provenance`: object up to 8 KiB including nonblank `model` and `promptVersion`,
  `schemaVersion: overdrafter.prepared-interpretation.v1`,
  `policyVersion: prepared-depth-v1`, `inputSha256` for the exact original message
  body, and `contextSha256` for the exact requested context bytes.

Only `service_role` may execute this API. Its private definer helper derives the
owner from the persisted request and rechecks current allowlist, organization
membership and project access after acquiring the conversation lock. The
server must validate the complete interpretation, its prompt/schema provenance,
Send authority and native context before calling. A recorded model/version/hash
is attribution, not proof that inference actually ran or that geometry passed.
The database validates bounds, bindings, identity and ordering independently.

Resolution follows original request order. An earlier request with no immutable
interpretation blocks later resolution. A future cancellation contract must
record an immutable resolution as well. Merely setting `interpreted` or `canceled`
on an inbox row cannot leapfrog this requirement. Accepted changes also reject stale
requested context, a failed/stale active chain, or five outstanding changes.
Failed work continues to count; only canceled tasks or successful tasks with
passed verification free capacity.

The receipt includes request, interpretation, decision/task (null for non-actionable
outcomes), predecessor and queue revision. Identical replay returns the original
receipt even after later queue activity; current access is still required.

## Owner cancellation API

`api_cancel_engineering_suffix` takes the conversation, expected queue revision,
idempotency key, exact ordered array of active decision IDs in the suffix, and a
nonblank reason up to 2,000 characters. Only the current authenticated owner with
current engineering access may call it.

The array must name every noncanceled decision from its first item through the
current tail. Partial, reordered, duplicate, unknown and stale selections fail.
Every selected task must be blocked/queued and unverified. Running, failed,
completed or checked work requires the later coordinator recovery contract;
this API cannot claim that a native process stopped. The milestone's explicit
retry and safe cancellation of failed work remain required coordinator work.

Cancellation retains decisions, interpretations and events, marks the selected
tasks canceled, and records the actor and reason. A later acceptance follows the
remaining tail because an explicit cancellation established it. Existing
predecessor links are never rewritten. An identical cancellation replay returns
its original receipt; different arguments using the same key conflict.

## Concurrency and access

The queue revision is separate from the inbox conversation/message revision.
Every resolution (including clarification/no-change) and cancellation advances
the queue revision exactly once and writes an immutable event/receipt in the
same transaction. Both APIs share the inbox's conversation advisory lock and
row lock. Future claims, finalization and head updates must follow that ordering.

All five tables use RLS and explicit read-only API grants. Reads require owner,
current allowlist and project/organization access. No client or service-role
writer can directly change task state, accepted decisions or audit history.
Cross-record composite keys preserve tenant and conversation ownership.
PostgreSQL migration owners remain privileged infrastructure actors.

Errors are finite: `22023` for invalid input, `42501` for unavailable access,
and `PT409` (HTTP 409) for stale/conflicting/order/capacity/recovery conditions.
A conflict needs refresh or explicit resolution, not a blind native retry.

## Verification and migration

`supabase/tests/engineering_ordered_changes.sql` covers access, ordering,
provenance, limits, immutable history, failure propagation and suffix behavior.
`npm run test:engineering-queue -- <disposable-local-container>` adds independent
sessions for duplicate admissions, last-slot contention, concurrent overflow,
duplicate cancellation and access revocation while waiting. Reports go to stdout.
The runner accepts only explicitly named local OVD-496/497 fixture containers.
Synthetic state injections in these tests are not native execution evidence.

The additive migration creates five tables, scoped keys, private helpers and two
public invoker wrappers. It changes no quote table behavior, creates no scheduler
and grants no native credentials. Production migration/activation remains a
separate reviewed operation. Rollback revokes both public/private API EXECUTE
permissions and disables admission; preserve records and evidence. Restrictive
references intentionally retain history; retention/erasure workflows remain
future explicit work.

## Analyzer review

Hosted analysis of this migration and pgTAP suite reported 37 `plsql:S1192`
contract-literal findings. They were reviewed and marked false positive under
the existing PostgreSQL contract-literal policy: persisted states, SQLSTATEs,
wire keys and independent expected test values span separate SQL scopes. No
security rules were disabled. The separate JavaScript conditional finding was
addressed by expanding the runner barrier into explicit blocks and rerunning
the real database/concurrency suite. Sonar dispositions are review evidence,
not native qualification or proof of the complete automatic loop.

## Review contract clarifications

The type-generation step preserves the nullable `p_depth_mm` argument for
clarification and no-change responses. PostgreSQL does not expose parameter
nullability in its function catalog, so the Supabase generator emits `number`
without this explicit contract correction. Keep the correction in the generator;
do not manually patch generated types. Strict-consumer compilation is tested.

The composite index on `engineering_requests` takes a write lock during creation.
Before production deployment, record that table's row count, size and write load
in the activation packet and keep engineering intake disabled during the index
build. Use a low-write maintenance window for an already populated installation.
If that window is unacceptable, prepare a separately reviewed concurrent-index
rollout before deploying dependent foreign keys. No production table-size or
write-load observation is claimed by these local migration tests.
