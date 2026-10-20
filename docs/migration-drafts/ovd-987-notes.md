# OVD-987 slice P3: controlled beta user quantity (notes)

**NEEDS BLAINE MIGRATION WINDOW - not applied anywhere hosted.** Staging first
(`docs/runbooks/staging.md`); production only with Blaine's approval card.
Turning the switch on in production is a separate Blaine approval, after the
separately authorized quantity-10 live run.

- Migration: `supabase/migrations/20261020100000_ovd987_controlled_beta_user_quantity.sql`
- Rollback: `docs/migration-drafts/ovd-987.rollback.sql`
- pgTAP: `supabase/tests/ovd987_controlled_beta_user_quantity.sql`
- Text pins: `src/features/quotes/controlled-beta-user-quantity-migration.test.ts`

## Decision

Blaine, 2026-10-19 (OVD-987 comment): the customer chooses the quantity; there
is no product cap ("Why are we defining the quantity? Let the user decide.").
With the switch on, the Xometry controlled beta admits exactly one quote
quantity that is a positive integer. `public.normalize_positive_integer_array`
already drops non-positive values and de-duplicates, and `integer` is the only
range. Several quantities, or none after normalization, are denied with
`xometry_beta_single_quantity_required`. With the switch off (the seed) the
rule and the error code are today's: exactly `[1]`,
`xometry_beta_quantity_one_required`. There is no price-break feature: a new
quantity is a new quote request.

## What changes

| Object | Change |
| --- | --- |
| `private.commercial_rollout_controls`, `private.commercial_rollout_control_events` | Capability CHECKs accept `controlled_beta_user_quantity`; the control is seeded off at revision 0 (same seed shape as the four commercial controls) |
| `public.api_set_commercial_rollout_control` | Allow-list gains the capability; this audited, revisioned, service_role-only setter is the way to flip it |
| `private.xometry_beta_user_quantity_enabled()` | New. STABLE, SECURITY INVOKER (every caller is SECURITY DEFINER), no API role may execute it; reads the control through `private.commercial_rollout_enabled`, so a missing row reads as off |
| S1 `private.resolve_xometry_beta_dispatch_scope_with_access` | Off: today's check. On: exactly one normalized quantity, else `xometry_beta_single_quantity_required`. Same position in the gate order |
| S3 `public.api_request_xometry_beta_dispatch` | The created lane must be at the scope's quantity while on, at 1 while off |
| S4 `public.api_authorize_xometry_beta_worker_dispatch` | Lane identity: the lane quantity must equal its own snapshot quantity, the result's `requested_quantity` must equal the lane's, and the task payload's `requestedQuantity`, when the payload has that key, must equal the lane's (else `dispatch_lane_identity_mismatch`). Current candidate at the lane's quantity. New re-check after the rollout check: a lane above 1 is refused with `dispatch_quantity_not_admitted` while the switch is off (only for such a lane it first takes the shared advisory lock `commercial-rollout:controlled_beta_user_quantity`) |
| S5 `private.record_quote_access_admission`, S6 `private.finalize_free_quote_job`, S7 `public.api_reconcile_terminal_free_quote_tasks` | Never read the switch. Lane quantity must equal the lane's snapshot quantity, result quantity must equal the lane's, so a permit issued at N still settles after the switch is turned off |

Unchanged: S2 (exactly one candidate), `quote_lane_candidates`, the scope
snapshot and its fingerprint (quantity is already in it), the permit tables,
the generic provider path (it already accepts one quantity of any size), the
worker, the client. Security attributes, `search_path = pg_catalog`, owner,
revokes and grants of every restated function are restated unchanged.

The snapshot quantity is compared as text (`requested_quantity::text` against
`scope_snapshot ->> 'quantity'`) rather than with the design's `::integer`
cast: equal for every snapshot the server builds, and a malformed snapshot
fails closed instead of raising inside the deferred settlement trigger.

### What the worker browses with, and the S4 binding

The worker (`worker/src/index.ts`, `handleVendorQuoteTask`) reads
`task.payload.requestedQuantity` (a number, or a string it parses) only to find
the result row when the payload has no `vendorQuoteResultId`; for a Xometry
beta task it loads the result by id and passes `vendor_quote_results.requested_quantity`
to the adapter. Before this change S4 tied neither value to the lane, so an
internal user or the service role could edit the task payload or the result
row after enqueue and still be authorized. S4 now requires both to equal the
lane's quantity (the payload only when it has the key), returning the existing
`dispatch_lane_identity_mismatch`. Rows written by the server always agree
(`request_scoped_automatic_quote_impl` writes the result and the payload from
the same lane), so with the switch off this is a tightening that only edited
rows meet. The same holds for S5 at quantity 1: a lane whose snapshot was
edited no longer reserves.

## Body diff (previous definition to new, `pg_proc.prosrc`)

| Function | Previous source | Lines | Previous md5 / bytes | New md5 / bytes |
| --- | --- | --- | --- | --- |
| `api_set_commercial_rollout_control` | 20260802020349 | -1 +2 | `eb741ed4f0be63d3189486959cdccdac` / 4468 | `2a2b6b6980abb0dd113b64b3dcd57041` / 4505 |
| S1 | 20261010230000 | -1 +10 | `0d4abcf48f054aced6dd3d531a1114bb` / 9234 | `916594293cfc4e66053acf4c7414b2ba` / 9656 |
| S3 | 20261004100000 | -1 +6 | `b633e6921485eefc211ab238bab10e43` / 6331 | `28c932e1ccf964302ffed42d9ce4bc0b` / 6550 |
| S4 | 20261002182910 | -2 +22 | `eb659d92aa927555f4c4fe93591fa9d1` / 9505 | `0fef772880a4122f72475a9905b7ed19` / 10603 |
| S5 | 20261002182714 | -1 +1 | `92b05edef3ec774fdb704e21efdc392d` / 6050 | `7c5f710bccffddd8562974ae489e803c` / 6102 |
| S6 | 20261002182714 | -1 +2 | `66021f1fc65ee7fa7d5c24666c858512` / 6337 | `b76415a18a9bb15659ec388cc4da2880` / 6409 |
| S7 | 20261003011148 | -2 +4 | `30208617d8ea6ec756e268d1b31ad4c9` / 7473 | `edcca1ef0dd3cf45a7ff9c202696f185` / 7574 |

Every other line of each body is byte-identical to the previous definition.
The replay of all 153 migrations confirms these are the latest definitions and
that the seven quantity-1 predicates listed in the design (1.2) are the only
ones in latest bodies. The migration's precondition block refuses unless each
body is the previous md5 or this file's; the rollback's guard refuses unless
each body is this file's or the previous one.

## Read-only hosted checks (before the apply and before a rollback)

1. Quantity-above-1 Xometry permits in flight (must be 0 before a rollback):

   ```sql
   select count(*) as total,
     count(*) filter (where admission.state = 'reserved' or request_row.status::text in ('queued', 'requesting')
                      or task.status::text in ('queued', 'running')) as in_flight
   from private.xometry_beta_dispatch_permits permit
   join public.quote_request_lanes lane on lane.id = permit.quote_request_lane_id
   left join public.quote_requests request_row on request_row.id = permit.quote_request_id
   left join public.work_queue task on task.id = permit.work_queue_task_id
   left join private.quote_access_admissions admission on admission.permit_id = permit.id
   where lane.requested_quantity <> 1;
   ```

2. Switch state: `select capability, enabled, revision from private.commercial_rollout_controls order by capability;`
3. Bodies: `select p.oid::regprocedure, md5(p.prosrc), length(p.prosrc), p.proacl from pg_proc p where p.oid = to_regprocedure('<signature>');`
   against the table above.
4. No later wrapper: `select to_regprocedure('private.xometry_beta_worker_dispatch_core(uuid,uuid,jsonb,text,timestamptz)') is null;` (OVD-723 contract not applied) and one overload of the resolver (OVD-762 not applied).

## Operating the switch

Turn on (service_role, audited; production needs Blaine's go after the
quantity-10 run):

```sql
select public.api_set_commercial_rollout_control('controlled_beta_user_quantity', true,
  '<reason>', '<operator>', <current revision>, '<new idempotency key>');
```

Turn off the same way with `false`. What to expect:

- **One rollout capability per transaction.** Each setter call takes the
  capability's exclusive advisory lock until its transaction ends. S4 takes
  `automatic_quote_collection`'s shared lock and then, for a lane above 1, this
  switch's. A transaction that sets this switch and then
  `automatic_quote_collection` holds this switch's lock while it waits for
  `automatic_quote_collection`'s, while an in-flight S4 holds that one and waits
  for this one: a deadlock (PostgreSQL aborts one side). If both must change in
  one transaction, change `automatic_quote_collection` first.
- **A lane that already passed S4 still launches.** Turning the switch off stops
  a lane above 1 at its next preflight (`dispatch_quantity_not_admitted`), not a
  browser session already authorized.
- **Replays after a turn-off.** Replaying a committed quantity-N request (same
  approval reference) raises `xometry_beta_quantity_one_required` instead of
  returning `deduplicated`, because S3 runs the resolver before its replay
  return. The permit and its hold are unaffected.
- Holds already reserved at N settle normally after a turn-off. The worker maps
  the new reason `dispatch_quantity_not_admitted` to
  `dispatch_authorization_denied` until a worker PR adds it to its bounded list.

## Rollback order (design 5.4)

1. Switch off (above).
2. Drain: check 1 above returns `in_flight = 0` (a refused task fails, its
   result fails, the meter releases; `api_reconcile_terminal_free_quote_tasks`
   settles stragglers).
3. Apply the rollback file as one transaction. Its guard enforces 1 and 2.

**Rollback locks.** Before the guard reads anything the rollback takes, under
`lock_timeout = '5s'`, ACCESS EXCLUSIVE on `private.commercial_rollout_control_events`,
then ACCESS EXCLUSIVE on `private.commercial_rollout_controls` (the modes its two
CHECK replacements need anyway), then SHARE on `private.xometry_beta_dispatch_permits`.
Every request reads the controls (S1, through the rollout and switch checks) before
it inserts a permit, so a request that read the switch while it was on still holds
the controls lock the rollback waits for: its permit and reservation commit (the
guard then refuses) or roll back before the guard runs, and a request that starts
later reads the controls only after the rollback ends, under the restored
quantity-1 rules.

Deadlock review (each case run locally with two sessions and a rollback that
holds its locks for 2 s):

- The setter reads the events table (its idempotency lookup) before it locks a
  control row. The first version of this rollback locked the controls first and
  replaced the events CHECK only at the end, after the controls lock; a setter call
  made in between held the events read lock and waited for the control row while
  the rollback waited for the events table: a deadlock (reproduced by the delta
  review and here; PostgreSQL aborted the rollback, nothing was left partial).
  Taking the events lock first, before the controls, removes it: the setter now
  waits at its first read and holds nothing the rollback needs. Warm and cold setter
  sessions, a request-shaped transaction, a worker preflight, a second rollback and
  the read API all waited and finished without a deadlock.
- Requests and worker preflights never read the events table, and the rollback takes
  no advisory lock, so neither the setter's exclusive nor the preflight's shared
  advisory locks can close a cycle with it.
- Residual: the read API `public.api_get_commercial_rollout_controls()` (service role
  only) reads the controls and then the events in one statement. A call that starts
  exactly between the rollback's first two LOCK statements can deadlock with it
  (shown only with that gap widened to 2 s on purpose); PostgreSQL aborts one of the
  two and neither leaves a partial change. Do not call the read API, and do not run
  the setter, in the same transaction as the rollback.

While the rollback holds these locks, previews, requests, worker preflights, the
setter and the read API wait for it (bounded by their own statement timeouts).

**Data loss: none.** The deleted control row is disabled; its audit events are
immutable and stay (the events CHECK then keeps the capability, with a NOTICE).
Rolling back and re-applying re-seeds the control at revision 0, so a
(capability, revision) pair can repeat in the immutable audit log; the events'
ids and timestamps keep them apart.

## Ordering with other work

- OVD-979 (20261020002126/7): no function overlap. The staging packet for this
  migration applies only onto a ledger whose head is 20261020002127 (155 rows).
  If OVD-979 lands on main first, add its two entries before this one in
  `REVIEWED_APPENDED_MIGRATIONS` and regenerate
  `scripts/fixtures/free-quote-ci-source.json` (156 files).
- OVD-762 (draft): copies S1, S3 and S4. Whichever lands second rebases onto
  the other; this migration and its rollback refuse to overwrite an unknown
  body. The OVD-762 draft itself has **no** md5 precondition: applied unrebased
  after this migration it would silently replace S4 with its quantity-1 copy. That
  fails closed for quantity N (a lane above 1 meets `requested_quantity <> 1` and
  is refused as `dispatch_lane_identity_mismatch`), but it also drops the switch
  re-check and the result and payload checks for every lane. Its rebase must
  therefore add a precondition on this migration's bodies, refusing unless each is:

  | Function | md5 of `prosrc` after OVD-987 |
  | --- | --- |
  | `public.api_set_commercial_rollout_control(text,boolean,text,text,bigint,text)` | `2a2b6b6980abb0dd113b64b3dcd57041` |
  | `private.resolve_xometry_beta_dispatch_scope_with_access(uuid,text,uuid)` | `916594293cfc4e66053acf4c7414b2ba` |
  | `public.api_request_xometry_beta_dispatch(uuid,text,text,text,uuid,boolean,boolean,boolean)` | `28c932e1ccf964302ffed42d9ce4bc0b` |
  | `public.api_authorize_xometry_beta_worker_dispatch(uuid,uuid,jsonb,text,timestamptz)` | `0fef772880a4122f72475a9905b7ed19` |
  | `private.record_quote_access_admission(uuid,uuid,text,uuid)` | `7c5f710bccffddd8562974ae489e803c` |
  | `private.finalize_free_quote_job(uuid)` | `b76415a18a9bb15659ec388cc4da2880` |
  | `public.api_reconcile_terminal_free_quote_tasks(uuid,integer)` | `edcca1ef0dd3cf45a7ff9c202696f185` |

  (OVD-762 replaces only S4 of these and adds overloads; checking all seven also
  proves the database is where both drafts expect it.)
- OVD-723 contract (draft): moves S4 to `private.xometry_beta_worker_dispatch_core`
  and wraps it. If it lands first this migration refuses (precondition) and
  must restate the core instead.
- Client copy for `xometry_beta_single_quantity_required` (P2) must ship
  before the switch is turned on; P1 (single Quantity field) before or with it.

## Known findings

- `node scripts/lint-security-definer.mjs` on the migration reports `grant`
  missing for S1, S5 and S6 (report mode). They are owner-only private helpers
  whose current definitions are baselined with the same finding; the grants are
  restated verbatim and the baseline is not grown.
- Release tooling that pins exactly four rollout controls, all disabled, is not
  changed: `scripts/verify-ovd373-*.sql`,
  `scripts/verify-ovd418-production-quiescence.sql`,
  `scripts/ovd419-acquisition-compatibility.mjs` and
  `scripts/ovd570-minimal-rehearsal.mjs` (its `count(*)=4` source-default check).
  They belong to frozen or held release packages; a future reuse against a
  database with this migration must allow the fifth control.
  `docs/workflows/commercial-rollout-controls.md` now says the read API returns
  five controls.
- SonarCloud: the migration and the rollback are excluded from copy-paste
  detection (`.sonarcloud.properties`), like the OVD-628, OVD-722, OVD-723 and
  OVD-762 restatements; `plsql:S1192` (repeated literals) findings are
  dispositioned per finding, because an issue exclusion for that rule is
  recorded there as ineffective under Automatic Analysis.
