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

## Apply locks (review round 1, finding 2)

Right after the md5 precondition (which reads only `pg_proc`) and before any
change, the migration takes, under `lock_timeout = '5s'`, ACCESS EXCLUSIVE on
`private.commercial_rollout_control_events`, then on
`private.commercial_rollout_controls`: the modes its two CHECK replacements take
anyway, now taken in the order the audited setter needs. The setter reads the
events (its idempotency lookup) before it locks a control row. The first version
of this file replaced the controls CHECK first and the events CHECK last; a setter
call in flight held the events read lock and waited for the control row while the
migration waited for the events table: a deadlock. PostgreSQL aborts one of the
two, so either the apply or the operator's rollout-disable call fails; the apply
is one transaction, so nothing is left partial.

Two-session evidence (local Postgres 17.11 container, the real 154 migrations
replayed, the real file re-run as the second session, the real setter and read
API; the drill and its raw outputs are kept with the overnight run notes, not in
this repo). Warm and cold sessions differ: the setter declares `%rowtype`
variables, so a session that has never called it takes a brief read lock on the
controls while it compiles the function, before the events read; a pooled
connection that already compiled it goes straight to the events read.

| Case | Original file (controls first) | This file (events first) |
| --- | --- | --- |
| Warm setter call lands during a 2 s gap between the two table changes | `deadlock detected`; the setter was the victim at a 2 s gap, the migration at 3.5 s | Setter waits at its first read, both finish, no error (2 s and 3.5 s gap) |
| Cold setter session, same gap | No deadlock (it waits on the controls at compile and holds nothing) | No deadlock |
| Real file re-run 60 times, unwidened, while a warm setter session loops (4,400 to 4,900 calls) | 8 of 60 runs aborted by `deadlock detected`, 8 setter calls aborted | 0 of 60, 0 setter errors |
| Same, plus a warm read-API session looping (4,900 to 5,500 calls, roughly 100 a second) | 13 of 60 runs aborted, 19 setter calls aborted, 0 read errors | 3 of 60 runs aborted, 0 setter errors, 4 read-API calls aborted |

`md5(prosrc)` of the seven functions after the replay equal the table in
"Ordering with other work"; the migration's pgTAP (111 assertions) and
`commercial_rollout_controls.sql` (25) pass on that database.

Residual, and what this does not fix. The read API
`public.api_get_commercial_rollout_controls()` (service role only) reads the
controls and then the events in one statement, the reverse of the setter. A call
that lands between the migration's two LOCK statements (back to back in the real
file) can deadlock with it, and the last row above shows it is not only
theoretical when the API is polled continuously. The original order was safe
for the read API. Events first is the order the finding asked for, because the
setter is the audited disable path an operator reaches for under pressure; the
read API is read-only and a retry is harmless. So: do not call the read API,
and do not run the setter, while the migration is applying; a deadlock victim
rolls the whole apply back and it is rerun. A second residual applies only to a
re-apply onto a database that already has this migration (a staging drill): the
three-transaction cycle described under "Rollback locks" (a worker preflight for
a lane above 1, a setter call for the switch, and this transaction) needs a lane
above 1 in flight, which cannot exist before the first apply, so run a re-apply
only with none in flight.

The file also needs a transaction block now: `LOCK TABLE` errors outside one, so
a runner that does not wrap the file stops at the first lock, before any change
(`psql -f` without `--single-transaction` did exactly that in the drill). Before,
`set local lock_timeout` only warned in that case and the file applied statement
by statement. `psql --single-transaction` and the whole file sent as one
multi-statement query (how a payload runner sends it) both applied it in the drill;
the Supabase CLI wraps it too, as the header says.

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
  no advisory lock, so on their own neither the setter's exclusive nor the
  preflight's shared advisory locks can close a cycle with it. Three transactions
  together can (found in the overnight review of round 3 and reproduced on minimal
  tables in a throwaway Postgres 17 container, not in this migration's database): a
  worker preflight for a lane above 1 that already holds the controls read lock (its
  `automatic_quote_collection` check) and waits for this switch's shared advisory
  lock, a setter call for this switch that holds that advisory lock exclusively and
  has not read the events yet, and the rollback that holds the events lock and waits
  for the controls. PostgreSQL aborts one of the three after `deadlock_timeout` (in
  the run it was the preflight) and nothing is left partial. The drain step rules it
  out: run the rollback only after the switch is off, no quantity-above-1 permit is
  in flight and no setter call is running. The header of `ovd-987.rollback.sql`
  still carries the broader sentence; its bytes stay as drilled on staging (sha256
  `0d00ebf6...`) and this note supersedes it.
- Residual: the read API `public.api_get_commercial_rollout_controls()` (service role
  only) reads the controls and then the events in one statement. A call that starts
  exactly between the rollback's first two LOCK statements can deadlock with it
  (shown only with that gap widened to 2 s on purpose); PostgreSQL aborts one of the
  two and neither leaves a partial change. Do not call the read API, and do not run
  the setter, in the same transaction as the rollback or while it is running.

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
- **Consumers that pin exactly four rollout controls (review round 1, finding 1).**
  Once this migration is applied in production,
  `public.api_get_commercial_rollout_controls()` returns five controls and
  `private.commercial_rollout_controls` has five rows. Nothing below is changed by
  this PR; each consumer either fails closed (it blocks, it never allows) or
  reports five rows where its text says four. The first group is live, not frozen:

  | Consumer | What it assumes | After the production apply |
  | --- | --- | --- |
  | `scripts/collect-ovd410-operational-envelope.mjs` (`OVD410_COMMERCIAL_CONTROLS`, `validateControls`) | The response has exactly four controls, the four names, all off | Rejects with `Invalid rollout-control response.` |
  | `docs/workflows/ovd410-stable-egress.md` (the baseline and after reads of the containment step call the collector) | The collector succeeds | The containment step stops at the collector |
  | `scripts/run-ovd419-live-release.mjs` (imports the collector) | Same | An OVD-419 run stops at its envelope read |
  | `scripts/ovd419-diagnostic-adapter.mjs` (`controlsDisabled` needs `length === 4`) and `scripts/ovd419-acquisition-compatibility.mjs` (`CONTROLS`, `length === 4`) | Four controls | Report the controls as not disabled, or reject the packet |
  | `docs/release/ovd-206-window-kit.md` section 1, query 1 ("Expect enabled = false for all four") | Four rows | Five rows; wording only |
  | `scripts/verify-ovd373-rollout-preconditions.sql`, `scripts/verify-ovd373-production-postconditions.sql`, `scripts/verify-ovd418-production-quiescence.sql` (run by `scripts/verify-ovd418-production-preconditions.sql` and `scripts/hold-ovd418-production-locks.sql`), `scripts/verify-ovd418-production-postconditions.sql` and `scripts/run-ovd418-production-release.sh` (both read `rollout_control_count`), `scripts/ovd570-minimal-rehearsal.mjs` (`count(*)=4`) | `count(*) = 4` | Refuse (`<> 4`); frozen or held release packages |

  The collector file itself was last changed on 2026-08-24; its OVD-419 caller
  on 2026-10-14. Neither is pinned in a manifest, and the OVD-206 window kit relies
  on the stable-egress runbook, so the next recovery procedure or OVD-419 run
  after the production apply would stop there.
  **Before Blaine's production card, one of two things must happen, and the card
  must name these consumers:** (A) a separate PR updates the collector, the
  OVD-419 adapter and compatibility pin (with their tests) and the OVD-206 kit
  wording to accept `controlled_beta_user_quantity` as a fifth control that must
  also be off, and lands first; or (B) the production apply is scheduled after
  the OVD-206 and OVD-410 work. This PR does not choose. Any reuse of the frozen
  scripts against a database with this migration must allow the fifth control.
  `docs/workflows/commercial-rollout-controls.md` says the read API returns five
  controls and points here.
- SonarCloud: the migration and the rollback are excluded from copy-paste
  detection (`.sonarcloud.properties`), like the OVD-628, OVD-722, OVD-723 and
  OVD-762 restatements; `plsql:S1192` (repeated literals) findings are
  dispositioned per finding, because an issue exclusion for that rule is
  recorded there as ineffective under Automatic Analysis.
