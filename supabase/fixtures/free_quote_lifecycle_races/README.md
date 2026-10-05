# Independent-session free-quote lifecycle races

Status: **authored, not executed**. These sources target the combined original-tree
and reviewed free-repair checkpoint `b4b618ebe609a6cfd27fdf03b379f42fff1447fd`, including
`supabase/migrations/20261003011148_reconcile_free_quote_job_reservations.sql`
at ordinal 133. The source bodies were independently reviewed and reconciled
from prior candidate `e5f38df`; no runtime compatibility or test pass is inferred.

## Runtime and package contract

Only the separately reviewed isolated fixture runner may execute these files. Its
exclusive UUID/owner/source-labelled, network-none container and own Unix socket
provide isolation and ownership proof. This package does not accept a database
URL, authenticate to another database, modify authentication, start containers,
or implement cleanup. The runner retains exact source/input hashes, backend PIDs,
TAP, SQLSTATEs, overlap evidence, bounded runtime, and owned-resource cleanup.

`races.json` is an ordered package fragment: copy `raceSetupSql` and `races` into
the parent package and hash-bind **all referenced files**. Preserve ordering.
`00-common-setup.sql` runs once after rollback-only suites. It refuses existing
jobs, users, spend, permits, policy/buckets/admissions, or fixture schema. It
contains an expanded copy of `free_quote_meter_setup.inc`; it has no runtime
include and is not a replacement for the authentic full-schema bootstrap.

One persistent database is used. The synthetic organization policy has immutable
limit **2**, solely for these tests. The two last-slot cases each hold one real
filler reservation before competing for the remaining slot. Every release-only
case drains normally before the next; the two consumed success cases run last.
Do not change the policy to accommodate a reordered or reused fixture.

All application sessions originate as postgres. The protected APIs execute under
explicit authenticated or service_role selection; SECURITY INVOKER helpers add
no application-table grants or definer privileges. Fixture-only setup, direct
row-lock probes, and synthetic DELETE use the existing fixture owner. Direct
DELETE deliberately tests the database fence below the archive API's preflight;
the companion deterministic lifecycle suite covers the archived-delete API.

Each session sets statement timeout 10 seconds, lock timeout 6 seconds, and idle
transaction timeout 20 seconds. The runner owns the independent outer deadline.
A timeout, absent blocker, SQL error outside an expected contract, incomplete TAP,
or failed assertion fails qualification. A successful psql exit alone is not a
passing TAP result.

## Actor protocol

- `setupSql`: prepares and commits the exact synthetic case; previous case must
  have passed verification and left no reserved receipts.
- `acquire.sql`: begins the specified transaction, executes the exact protected
  operation, verifies acquisition, and leaves its actual row/advisory locks held.
- `contender.sql`: independent backend, separate caller role and transaction,
  complete TAP transcript. Expected errors are captured as exact SQLSTATE/message;
  query-cancellation timeouts are not converted to success.
- `release.sql`: commits only after the runner's causal overlap checks.
- `verify.sql`: fresh session; checks post-commit canonical state, precise capacity
  and object counts, then drains only this case's synthetic holds. It compares all
  receipt identities, full immutable permits, terminal receipt/evidence snapshots,
  and known/unresolved spend rows byte-for-byte.
- `complete-before-release` cases also use `probe.sql`. The independent probe
  requests the **same actual result, request, queue, or job row** held by the
  coordinator. The runner must prove its exact PID is blocked by the coordinator
  while the contender completes passing TAP, then release and require passing
  probe TAP. No unrelated sentinel lock or fixed sleep substitutes for overlap.

## Expected coverage

| Cases | Expected outcome |
| --- | --- |
| Same approval at full capacity | Contender waits, accepts and deduplicates to identical request/permit IDs; one filler plus one winner, no extra debit |
| Distinct requests for last slot | Contender waits then P0001/free_allowance_unavailable; no orphan request/permit/task/receipt |
| Reconciler before canonical success, immediate/deferred | Writer waits then P0001/free_quote_terminal_fenced; one released receipt, failed result, no offers |
| Reconciler before cancellation, immediate/deferred | Cancel waits then not_cancelable; failed request and released receipt remain |
| Cancellation before reconciler, immediate/deferred | Reconciler completes before release with scanned1/deferred1/reconciled0; canceled history survives; later canonical success fenced |
| Queue revival before reconciler lock | Reconciler skips held queue; after revival commits, fresh running lease still defers and preserves hold/result; later genuine terminal failure releases once |
| Two sweepers and pages | Second sweeper skips locked first page, advances exact cursor and releases second page while first remains uncommitted; exact retry and wrap do not double-settle |
| Admission before DELETE, RC | DELETE waits then P0001/free_quote_reservation_unresolved; canonical job/hold retained |
| Admission before DELETE, RR and Serializable | DELETE waits then40001, because its snapshot excludes the still-active admission UPDATE |
| DELETE before admission, all three DELETE isolation levels | READ COMMITTED admission fails fast on its job-row FOR SHARE NOWAIT lock (OVD-598) with P0001 `xometry_beta_job_busy` before any write and before release (complete-before-release; the probe holds a FOR UPDATE wait on the deleted job row); no dangling receipt/permit/request/task |
| Canonical success before reconciler, immediate/deferred | Reconciler skips held result; one consumed receipt, canonical success/evidence retained, including after job deletion |

The first verification also invokes the real reconciliation and admission APIs
under REPEATABLE READ and SERIALIZABLE, requiring their explicit
P0001/free_quote_reconciliation_requires_read_committed and
P0001/free_quote_isolation_unsupported guards. Admission remains READ COMMITTED
in every mixed-isolation DELETE race.

The second-page helper intentionally discards the **settling** RPC's JSON result,
then independently checks the resulting row state and repeats the identical
cursor/limit after commit. This models ambiguous client response handling; it
does not claim a real network disconnection. Every lifecycle setup durably commits
the queue-only failure before any RPC, modeling interrupted reaper recovery.

With the complete ordered manifest, expected final totals are 18 admissions:
2 consumed, 16 released, 0 reserved; 36 unchanged synthetic spend rows. Every
successful receipt and permit remains, including historical bare IDs after
terminal job deletion. These numbers are expectations, not measured results.

## Explicit remaining gaps

- The stronger cross-held-lock case where reconciliation retains the result lock
  while cancellation subsequently acquires/finishes under a request lock is not
  staged by this one-shot contender interface. The cancellation-first cases prove
  request-lock skipping after cancellation has executed but remains uncommitted.
- Revival proves uncommitted queue-lock skipping plus fresh committed lease/status
  revalidation. It does not instrument an invisible internal instruction boundary
  between the reconciler's receipt scan and its next SQL statement.
- Corrupt/null bindings, access-control denial, archived API behavior, and wider
  lifecycle correctness remain the deterministic companion suite's responsibility.
- No real process crash, lost TCP session, hosted transport/PostgREST behavior,
  production RLS integration, worker/provider execution, deployment, or rollback
  readiness is established. Runtime SQL parsing and behavior are still unexecuted.

Integration note: the fixtures were authored/reviewed against e5f38df. They are now carried unchanged into the combined restored-original source (133 migrations); the lifecycle migration body and all three free migration inputs are unchanged. No runtime pass is claimed.
