# Archived-part deletion safety: current path and proposed repair

This is an explanation and design proposal for the archived-part delete path, not
an implemented contract or a release qualification. The proposed database,
Edge Function, and application changes require their own bounded issue(s),
review, tests, and deployment approval. OVD-536 and its archive-safety children
remain blocked. The existing deletion risk is not fixed or waived here, but the
archive redesign is not a technical prerequisite for OVD-419's worker-only
promotion and no-upload sign-in checks. OVD-419 and OVD-527 retain their own
unmet database, billing, image, and live release checks.

## The problem

The application first calls the authenticated
[`api_delete_archived_jobs(uuid[])`](../supabase/migrations/20260330144838_align_destructive_job_auth_contract.sql)
database function. That function checks the caller, writes a `job.deleted` audit
event, removes published quote options, attempts to delete `storage.objects`
rows, then deletes jobs and orphan blob records in one database transaction.
When Supabase rejects direct deletion from `storage.objects`, the
[application API](../src/features/quotes/api/archive-api.ts) recognizes that
specific error and calls `job-archive-fallback` once per job. The database
function's failed transaction is rolled back, but the fallback has a different
ordering and authority boundary.

The [Edge fallback](../supabase/functions/job-archive-fallback/index.ts)
verifies the bearer token with `auth.getUser()`, requires a confirmed email or
accepted identity provider, and checks creator, organization internal-admin,
or project owner/editor rights through direct SQL. It then:

```text
Transaction A: authorize and collect Storage candidates; commit/close
Storage API:   remove candidate paths using the service-role key
Transaction B: reauthorize, delete published options, write audit, delete job
               and now-unreferenced blob records; commit/close
```

The [flow helper and tests](../src/features/quotes/job-archive-fallback-delete-flow.test.ts)
explicitly require Storage removal before the database delete. Missing
service-role credentials and a reported Storage error stop transaction B, but
they do not make the two systems atomic. A Storage call can remove some paths
before a later bucket fails. Transaction B can then fail because of a database
error, a changed permission, a concurrent edit, or a process crash. The job
and its file references survive, while one or more objects may already be
gone. The current Storage-failure message says “No records were deleted”; that
is only about database records, not a guarantee that no files were removed.

The candidate list is also a snapshot from transaction A. It checks some
cross-job references for organization blobs, drawing previews, and unowned
job files, but it holds no lock through Storage removal. Another operation
could attach the same path after the check. The current implementation does
not re-derive all Storage candidates in transaction B. A path that becomes
shared could therefore be removed. The vendor-artifact candidate query has
no cross-job path check in the fallback itself; its current table definition
has a unique `storage_path`, but the repair should prove ownership across all
relevant reference sources and the physical Storage namespace.

The fallback opens a direct Postgres connection from `SUPABASE_DB_URL` and
uses `SUPABASE_SERVICE_ROLE_KEY` only for Storage removal. The source does not
establish the deployed database URL's actual role or set authenticated JWT
claims on that connection. The current
[`log_audit_event`](../supabase/migrations/20260303101500_curated_cnc_quote_platform.sql)
helper records `auth.uid()` as the actor. Source inspection alone therefore
cannot prove that a fallback `job.deleted` audit row names the verified user,
or that a narrower database grant would preserve its legitimate caller.
Verify the deployed role privately before changing its privileges. A separate
service-role call to the existing audit function is not an acceptable repair:
it would move the audit outside the delete transaction and would not establish
the verified human actor. The current `audit_events.job_id` foreign key uses
`ON DELETE SET NULL`; the existing in-transaction audit keeps the deleted job's
ID in its payload, while the relational job reference becomes null. An
after-delete call with that deleted ID cannot rely on the foreign key as proof
of which job was removed.

## Proposed safety contract (not implemented)

The target is a database-first *logical* delete with a durable, retryable
Storage-cleanup obligation. The exact schema, function signature, grants, and
deployment mechanism must be selected and reviewed in the implementation
issue; the terms below describe behavior, not existing objects.

1. Authenticate the person, require the same verified-sign-in and destructive
   job rights, and bind that identity to the database operation through a
   narrow, non-forgeable server-side route. Do not trust a caller-supplied
   actor ID or expose an unrestricted audit-writing RPC. Identify and test
   the actual deployed `SUPABASE_DB_URL` role first.
2. In **one database transaction**, lock and recheck the archived job and the
   relevant ownership rows; derive every `(bucket, path)` candidate; reject or
   hold any path still referenced by another job or asset. Atomically record
   a durable cleanup obligation and path reservation, write one attributable
   `job.deleted` audit event, remove dependent published quote options, and
   delete the job and now-unreferenced blob metadata. If any step fails, none
   of those database changes commit. Deduplicate by operation/job/path so a
   repeated request cannot produce a second logical deletion or audit event.
   Preserve the job ID in the audit payload, since the job foreign key is
   cleared when the job is deleted.
3. After commit, a narrowly authorized cleaner may claim pending obligations
   and call the Storage API. Before each physical removal it must recheck all
   applicable references and keep a reservation that prevents a concurrent
   upload or attachment from reusing that path. If that cannot be guaranteed
   for every writer and bucket, hold the obligation for review instead of
   deleting the object. A shared object is retained, not treated as orphaned.
4. Record the Storage result and an independent absence/readback receipt.
   A timeout or crash after removal but before acknowledgment leaves an
   obligation to reconcile. Repeating a confirmed missing-object cleanup is
   safe only while the same path reservation and ownership proof remain valid.
   Bound attempts, backoff, and escalation; do not spin or silently discard
   failed obligations.
5. Separate “part no longer available in the app” from “active Storage
   objects removed.” A committed database delete can be reported as logical
   success with cleanup pending, but a privacy/deletion request must not be
   marked complete until Storage cleanup and its evidence are confirmed under
   the [support runbook](workflows/founding-beta-support.md). Never reuse the
   current “No records were deleted” wording for an uncertain partial cleanup.

```text
verified actor --> locked DB transaction --> audit + logical delete +
                                            durable cleanup obligation
                                                   | commit
                                                   v
                                       reserved, retryable Storage removal
                                                   | verified readback
                                                   v
                                           cleanup completed receipt
```

This trades immediate all-or-nothing appearance for recoverability across two
systems that cannot share one transaction. The durable obligation protects
against a crash or transient Storage outage, while the reservation and final
ownership check protect shared assets. It adds operational state and a cleaner
that must be monitored; a pending obligation is visible work, not silent
success.

### Why simpler repairs do not close the gap

- Merely reversing the current two calls leaves no durable record when the
  process dies after the database commit. The later Storage cleanup would be
  lost.
- Keeping Storage-first and adding another permission check cannot roll back
  a file removal when the later database transaction fails.
- A separate service-role audit call can succeed or fail independently of the
  delete and cannot by itself establish the verified user as actor.
- Deleting directly from `storage.objects` retains the already-observed
  Storage API restriction and is not a substitute for a reviewed cleanup path.

## Failure proofs required before implementation is accepted

The current unit tests cover the helper's order, missing service key, reported
Storage failure, and no-candidate case. They do not prove cross-system crash
recovery or an attributable audit row. The replacement needs at least these
tests with synthetic jobs and files in an isolated database/Storage fixture:

| Failure or race | Required observable result |
| --- | --- |
| Unauthorized, unverified, or unarchived request | No audit, job delete, cleanup obligation, or Storage call |
| Database failure before commit | Job, references, and Storage stay intact; no committed obligation |
| Duplicate request or replay | One logical delete and one attributable audit event; same cleanup work is reused |
| Shared blob, preview, artifact, or path | Physical object retained; no other job loses a file |
| New reference or upload races cleanup | Reservation blocks reuse or cleanup is held; no referenced object removed |
| One Storage bucket succeeds and another fails | Successful removals have receipts; remaining paths stay pending and retryable |
| Crash before Storage call | Committed obligations remain discoverable and can be processed later |
| Crash or timeout after Storage removal, before receipt | Readback reconciles the ambiguous result without deleting a reused path |
| Unknown database role or actor context | Deployment stops; no anonymous or forged `job.deleted` audit accepted |
| Cleanup retry limit or long-pending item | Visible alert and manual containment; no false erasure-complete claim |

The tests must also cover the application's bulk-to-single fallback and its
partial-result reporting so a failed job is not reported as deleted. Prove the
normal authenticated database path, the fallback, and their audit/cleanup
outcomes against the same intended contract.

## Bounded implementation and release sequence

1. **Read-only qualification:** establish the deployed database connection
   role and effective function/table privileges without exposing the URL or
   credentials. Map every writer that can attach, upload, or reuse a candidate
   path. Freeze the current behavior and verify the source/hosted migration
   versions before drafting grants or a new schema.
2. **Database slice:** in a separate reviewed issue, implement the atomic
   authorization, actor attribution, audit, logical delete, path reservation,
   and durable obligation. Use test-first database cases for grant boundaries,
   shared ownership, and transaction rollback. Keep schema/API choices in
   that issue, not in this design note.
3. **Cleaner and application slice:** in separately bounded work, consume and
   reconcile obligations through the Storage API, add bounded retry/alerts,
   and make API/UI results distinguish logical deletion from confirmed
   Storage cleanup. Test crashes, partial bucket success, idempotency, and
   old/new path coexistence. Do not leave the old Storage-first fallback
   callable once the new path is enabled.
4. **Controlled deployment:** run the full required source and disposable-DB
   checks, inspect hosted review findings, and obtain a separate exact
   production database/deployment approval. Disable or contain archived
   delete during the transition, apply only the reviewed migration(s), verify
   grants and actor behavior with synthetic no-customer-data checks, then
   deploy the matching Edge/application code and enable the path. Never run a
   blanket migration push or assume a source merge changed production.
5. **Readback and forward recovery:** verify the deployed versions, actual
   role/grants, one audit row per synthetic operation with the expected actor,
   no dangling references, pending/complete obligations, Storage absence or
   retained shared objects, and no stuck work. If any step is uncertain,
   stop new deletes and preserve the ledger/evidence. Revert only code/traffic
   that can safely revert while keeping durable cleanup records; do not
   re-enable the unsafe Storage-first flow or promise to restore an already
   removed object. Repair forward from the recorded state. Production
   migration and any live data operation need their own reviewed plan and
   exact approval.

Before accepting the archived-delete repair or claiming an old privacy deletion
is complete, disposition the possibility of earlier Storage-first partial
failures. Within a separately approved, read-only metadata review, compare
surviving archived-job references with object existence without opening
customer files; record the scope, results, and any gaps. If that review is not
authorized or cannot establish consistency, keep the archive-repair work
blocked rather than claiming that the new flow repaired old data. This is a
separate risk, not proof that OVD-419's worker promotion path is unsafe.

The first implementation blocker remains the unknown deployed DB URL role.
This document is a design input for OVD-536, not release evidence for OVD-527
or OVD-419. Their independent acceptance checks remain unchanged.
