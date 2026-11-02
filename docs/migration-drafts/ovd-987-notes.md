# OVD-987 slice P3: controlled beta user quantity (notes)

**NEEDS BLAINE MIGRATION WINDOW - not applied anywhere hosted.** Staging first
(`docs/runbooks/staging.md`); production only with Blaine's approval card.
Turning the switch on in production is a separate Blaine approval, after the
separately authorized quantity-10 live run.

- Migration: `supabase/migrations/20261101130000_ovd987_controlled_beta_user_quantity.sql`
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
The replay of all 153 migrations (before the 2026-10-31 merge of main) confirmed
these are the latest definitions and that the seven quantity-1 predicates
listed in the design (1.2) were the only ones in latest bodies. Main has since
added an eighth site, which this migration does not change (see "Known
findings": `public.accept_vendor_quote_result`, OVD-1073). The migration's precondition block refuses unless each
body is the previous md5 or this file's; the rollback's guard refuses unless
each body is this file's or the previous one.

## Reviewed file bytes

| File | sha256 | md5 |
| --- | --- | --- |
| `supabase/migrations/20261101130000_ovd987_controlled_beta_user_quantity.sql` | `e674bc081e5fe53a0513a00030781ccfd8c1032e4d0f4318769bb5c408540362` | `8e9f067e7c9849b53ac267833d74ad64` |
| `docs/migration-drafts/ovd-987.rollback.sql` | `2ad4e3c7c03baf7703d0ed88d45d55f29b64d42345d7d4a52a4df6cca97619c5` | `2d5beb4c6d982a45bc121880e3cf79f8` |

The migration's sha256 is also pinned in `scripts/free-quote-ci-profile.mjs` and
`scripts/fixtures/free-quote-ci-source.json`. The review-round-3 change (the
lock blocks and the header text of both files) changed no function body, so the
`md5(prosrc)` tables in this file still hold. The rollback is byte-copied to
`supabase/tests/fixtures/ovd987_controlled_beta_user_quantity_rollback.inc` for
the pgTAP drill; `scripts/run-supabase-policy-tests.node-test.mjs` requires the
copy to be identical. The audit-history change (below, "Rollback and audit
history") changed the rollback only (sha256 was `e863f27f...`); no function
body changed.

**Staging must be re-applied.** The staging evidence is for the migration at
sha256 `f34f5f7d...` (b91c086c) and a rollback drill with the earlier rollback
(sha256 `0d00ebf6...`). Neither matches these bytes. Before the production
card, re-apply this migration on staging (it re-runs on an applied database) and
repeat the rollback drill there with this rollback file, with the evidence, so
production gets the bytes that staging ran.

**Renamed 2026-10-31.** Main gained OVD-1097, OVD-1073 and OVD-1018 migrations
(up to `20261030204050`), so the original version `20261020100000` became
backdated. The migration is now `20261031224054`; its bytes (sha256 above) are
unchanged. Only the version comments in the rollback and the OVD-762 rollback
changed. Staging holds a `schema_migrations` row for the old version: the
staging re-apply must account for that row (card-only; not done here).

**Renamed 2026-11-01.** Main gained `20261031052436` (OVD-746), `20261031184522`
(OVD-1127) and `20261101110559` (OVD-1073), and the OVD-979 U2–U5 stack
(#984–#988) takes `20261101115900`–`20261101120200`, so `20261031224054` became
backdated. The migration is now `20261101130000`; its bytes (sha256 above) are
unchanged. Only the version comments in the rollback (sha256 in the table
above) and the OVD-762 rollback changed; both pgTAP fixture copies follow.

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

## Locks (apply and rollback)

### What both files do

Right after the md5 precondition (which reads only `pg_proc`) and before any
change, the migration takes ACCESS EXCLUSIVE on
`private.commercial_rollout_control_events` and
`private.commercial_rollout_controls`, the modes its two CHECK replacements need
anyway. Before its guard reads anything, the rollback takes the same two and
SHARE on `private.xometry_beta_dispatch_permits`. Both take them in one `DO`
block, all or nothing and without waiting:

- Each attempt is `LOCK TABLE ... NOWAIT` inside its own exception block (a
  subtransaction). An attempt refused with `lock_not_available` therefore gives
  back every lock it took.
- It then sleeps 50 ms, holding none of these tables, and tries again.
- After 5 s of refusals it raises 55P03 ("stayed in use for 5 s; nothing
  changed, re-run it") and the whole file rolls back.

`controlled-beta-user-quantity-migration.test.ts` pins this: every LOCK in the
block is NOWAIT, only `lock_not_available` is retried, and there is no top-level
LOCK.

### Why no waiting order works (review round 2, the read-API finding)

Two callers take the two rollout tables in opposite orders:

- The audited setter `public.api_set_commercial_rollout_control` reads the
  events (its idempotency lookup) and then locks its control row.
- The read API `public.api_get_commercial_rollout_controls()` reads the controls
  and then the events, in one statement.

A transaction that waits for one table while it holds the other deadlocks with
one of them. Controls first deadlocked with a setter call (review round 1).
Events first deadlocked with a read-API call (review round 2). Both are
reproduced below. Never waiting removes both, whatever order a caller takes.

### Proof against every other caller

A deadlock is a cycle of transactions, each waiting for a lock the next one
holds. The apply or the rollback can be in a cycle only if it waits for a lock
while it holds one that somebody else waits for. It never does:

1. Before the lock block it holds nothing on these tables. The migration's
   precondition reads only `pg_catalog.pg_proc`; the rollback runs only
   `SET LOCAL` first.
2. In the lock block it never waits for any of the three tables. A NOWAIT
   request is granted at once or fails, and a failed attempt releases what it
   took before the sleep. A NOWAIT request is never queued, so no later caller
   queues behind it either.
3. After the block it holds all of its tables, so a caller that needs them
   waits for it. It waits for nothing such a caller can hold:
   - Migration: the CHECK replacements and the seed touch only the two locked
     tables. The seed row has no `updated_by_user_id`, so its foreign key to
     `auth.users` checks nothing. `CREATE OR REPLACE FUNCTION`, `GRANT` and
     `REVOKE` update catalog rows that only other DDL writes. Validating the
     plpgsql bodies takes ACCESS SHARE on their `%rowtype` tables, which only an
     ACCESS EXCLUSIVE holder (DDL) blocks.
   - Rollback: the guard reads the locked tables, plus `quote_request_lanes`,
     `quote_requests`, `work_queue` and `quote_access_admissions` with ACCESS
     SHARE (only DDL blocks it; a plain read never waits for a row lock).
     `private.commercial_rollout_enabled` takes no advisory lock. The restores,
     the `DROP FUNCTION` of the helper (a caller takes no lock on a function),
     the control-row `DELETE` (no foreign key references the controls) and the
     CHECK replacements touch only locked tables or catalog rows.

Every caller of the three tables, from the latest definitions after this
migration (`git grep` over `supabase/migrations`; permits are append-only, a
trigger rejects UPDATE and DELETE, and they have no foreign keys of their own):

| Caller | What it takes on these tables | While the apply or rollback runs |
| --- | --- | --- |
| Setter `public.api_set_commercial_rollout_control` (service role) | Exclusive advisory `commercial-rollout:<capability>`, events read, control row `FOR UPDATE`, event insert, control update. A session that has not compiled it yet reads both tables briefly at compile | Waits, or makes an attempt give its locks back. A call for this switch queued behind a rollback fails once it commits (`query returned no rows`), and later calls get `Unknown commercial rollout capability` until a re-apply |
| Read API `public.api_get_commercial_rollout_controls()` (service role; operator scripts only) | Controls, then events, one statement | Waits, or makes an attempt give its locks back |
| `private.commercial_rollout_enabled` and its callers: `automatic_quote_rollout_enabled_with_lock` (shared advisory `automatic_quote_collection` first), `require_commercial_admin_mutation` (shared advisory `commercial_admin_mutations` first), `xometry_beta_user_quantity_enabled` (new), `resolve_provider_dispatch_scope`, `api_authorize_provider_worker_dispatch` | Controls read | Waits, or makes an attempt give its locks back |
| S1 and S3, `api_request_xometry_beta_dispatch` (the only permit writer) | Controls read (rollout and switch checks), then the permit INSERT (ROW EXCLUSIVE; its BEFORE INSERT triggers read `provider_dispatch_permits` and the kill switch) | Same. The insert always follows the controls read in the same transaction, so the rollback gets the controls only when no such request is open: its permit has committed (the guard sees it) or rolled back |
| S4, `api_authorize_xometry_beta_worker_dispatch` (worker preflight) | Task row `FOR UPDATE`, permit read, shared `founding-beta:<org>`, shared `automatic_quote_collection` and controls read, then for a lane above 1 the switch's shared advisory lock | Waits, or makes an attempt give its locks back. Its wait for a setter's advisory lock no longer closes a cycle through the rollback (the round-3 residual) |
| Permit readers: `api_request_provider_dispatch`, `resolve_quote_access_for_permit`, `validate_quote_access_admission`, `record_quote_access_admission`, `finalize_free_quote_job`, `release_cancelled_free_quote_job`, `api_reconcile_terminal_free_quote_tasks` | Permit read (ACCESS SHARE). No foreign key references the permits, so no other insert or delete locks them | Not blocked by the rollback's SHARE; wait only if they also read a rollout table |
| A delete from `auth.users` | `ON DELETE SET NULL` updates the control row that names the user | Waits |

### Evidence (local Postgres 17.11, the real files, the real setter and read API)

- Scratch container `public.ecr.aws/supabase/postgres:17.11.0.004`.
- The 153 base migrations were replayed and recorded in the CLI history, then
  this migration was applied with `supabase migration up --db-url` (CLI 2.121.0).
- `md5(prosrc)` of the seven functions equals the tables in this file.
- pgTAP on that fresh database: 111/111 and 25/25.

In each two-session case a 2 s sleep sits between the first and the second
table lock, and the other session's call lands in that gap. In the previous
files the sleep is between the two LOCK statements. In these files the attempt
is split into two NOWAIT statements with the sleep between them.

| Case | Previous files (d3088e01) | These files |
| --- | --- | --- |
| Apply, read-API call in the gap | `deadlock detected`, apply aborted | The attempt gave its locks back when the read API blocked on it, the read API finished, the next attempt took both, and the apply committed |
| Apply, warm setter call in the gap | Setter waited, both finished | Same |
| Rollback, read-API call in the gap | `deadlock detected`, rollback aborted | As for the apply; rollback committed |
| Rollback, setter call in the gap | Not re-run | Setter waited and the rollback committed; the queued call then failed with `query returned no rows` (the drain rule) |
| Rollback, plus a preflight-shaped transaction (shared `automatic_quote_collection` lock and controls read, then the switch's shared advisory lock) and a setter call that holds the switch's advisory lock (the round-3 residual) | `deadlock detected`, the setter aborted | No error in any of the three; the rollback committed after both |
| Apply re-run 150 times, unwidened, while warm sessions loop the setter and the read API | 2 of 150 runs and 3 read-API calls aborted by `deadlock detected` | 150 of 150 committed; 0 errors in about 4,800 setter and 4,900 read-API calls; slowest run 0.87 s |
| Rollback then re-apply, 40 times, same load | Not re-run | 40 of 40 committed, 0 deadlocks; setter calls between a rollback and its re-apply failed as expected (40 `query returned no rows`, 58 `Unknown commercial rollout capability`) |
| A session holds a controls read for 7 s | Not re-run | The apply and the rollback each refused after 5 s with the 55P03 message; nothing changed |

The drill scripts and raw outputs are kept with the overnight run notes, not in
this repo. They ran the rollback before the audit-history change ("Rollback and
audit history" below); that change touches only the guard's first check and the
events CHECK statement, not the lock block.

### Runners (review round 2, L1)

The files have no begin/commit of their own.

- `psql --single-transaction` and the Supabase CLI (`db push`, `migration up`)
  both apply the whole file as one transaction. The CLI sends the file as one
  pipeline. `SET LOCAL` warns there but stays in effect, the locks taken in the
  `DO` block are held to the end, and a failure leaves nothing. A probe
  migration confirmed it: one `txid_current()`, `lock_timeout` read back, and
  the lock still granted after the `DO` statement.
- A top-level `LOCK TABLE` errors in that pipeline, which is one reason the
  locks sit in a `DO` block; the exception block needs one anyway.
- Only plain `psql -f` without `--single-transaction` (the CI fixtures) gives
  each statement its own transaction. There the locks end with the `DO`
  statement, each later statement takes its own lock, and the file still applies
  and can be re-run.

Earlier versions of this file said the CLI applied a migration statement by
statement. That was wrong.

## Rollback and audit history (decision: refuse loudly)

The rollback always restores the events CHECK to its pre-OVD-987 definition
(`20260802020349_add_commercial_rollout_controls.sql`: the four commercial
capabilities). The earlier rollback kept the widened CHECK, with a NOTICE, when
audit events for the switch existed; that left the schema half rolled back.

Audit events are immutable (a trigger rejects UPDATE and DELETE) and the
rollback never deletes or rewrites them. The restored CHECK rejects an event row
with `controlled_beta_user_quantity`, so the two cannot coexist. The rollback
therefore refuses, as the first check of its guard and before any change, with
errcode `55000` and the message `OVD-987 rollback refused: immutable audit
events exist for controlled_beta_user_quantity; ...`, while any event row uses
that capability. Nothing changes and the operator decides.

Every setter call for the switch writes an event, a no-op call included (the
event records `changed = false`). So:

- If the switch was never set (only the migration's seed exists), the rollback
  runs as before.
- Once the switch has been set even once, the rollback for this migration is
  turning the switch off and keeping the migration applied. That is the
  operational rollback OVD-313 prescribes for the whole registry ("leave this
  schema installed and set affected controls off"). Removing the schema after
  that is a separate decision (for example: export the events, then a reviewed
  migration), not something this file does.

Rejected alternatives: keeping the widened CHECK (a partial rollback that a
later migration would trip over); deleting the events, or `NOT VALID` on the
CHECK (rewrites or hides audit history, and a later `VALIDATE` fails); mapping
the events to another capability (rewrites history).

Proof: `supabase/tests/ovd987_controlled_beta_user_quantity.sql` runs the byte
copy of the rollback twice in its rolled-back transaction: (a) first, with no
event for the switch, inside a savepoint: the events CHECK and the controls
CHECK equal the pre-OVD-987 definitions, the control row and the helper are
gone and the seven bodies have their previous md5; (b) last, after the test's
two audited flips: the include refuses at the guard and the events, both
CHECKs, the control row, the helper and the seven bodies are unchanged. The
text pins in `controlled-beta-user-quantity-migration.test.ts` require the
refusal to be the guard's first check, with `55000`, before any change, and the
plain restore of the old CHECK.

Staging: if the staging smoke or drill called the setter for this switch, its
events now make this rollback refuse there, by design. The rollback drill on
staging then proves the refusal; a drill of the restore path needs a database
whose events never name the switch (for example a fresh local replay).

## Rollback order (design 5.4)

1. The switch is off and was never set: no row in
   `private.commercial_rollout_control_events` has capability
   `controlled_beta_user_quantity`. Do not call the setter to make sure; a no-op
   call writes an event. If such an event exists, stop: keep the migration
   applied with the switch off (above).
2. Drain: check 1 above returns `in_flight = 0` (a refused task fails, its
   result fails, the meter releases; `api_reconcile_terminal_free_quote_tasks`
   settles stragglers).
3. Apply the rollback file as one transaction. Its guard enforces 1 and 2.

**Rollback locks.** The rollback takes its three tables the way the migration
takes its two (see "Locks" above): all or nothing, never waiting, and before the
guard reads anything. The lock block replaces the three waiting LOCK statements
that were drilled on staging. Every request reads the controls (S1, through the
rollout and switch checks) before it inserts a permit, in the same transaction.
So the controls lock is granted only when no request that read the switch is
still open: its permit and reservation have committed (the guard then refuses)
or rolled back. A request that starts later reads the controls only after the
rollback ends, under the restored quantity-1 rules.

The drain rule still applies, for the guard and for queued callers. Run the
rollback only after the switch is off, no quantity-above-1 permit is in flight
and no setter call is running. A call that queued behind the rollback runs
against the restored functions once it commits, and can fail with a generic
error: a dropped helper (42883), or the deleted control row for a setter call.
Every such failure is atomic.

While the rollback holds its locks, previews, requests, worker preflights, the
setter and the read API wait for it, bounded by their own statement timeouts.

**Data loss: none.** The deleted control row is disabled and has no audit
events (the guard refuses otherwise), so no audit row is lost, rewritten or
orphaned. Re-applying re-seeds the control at revision 0.

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

- **Eighth quantity-1 site, from main (OVD-1073, found in the 2026-10-31
  review).** `supabase/migrations/20261029165751_reconcile_claim_fence.sql`
  (around line 338, inside `public.accept_vendor_quote_result`) builds the
  permit identity with a literal `1 requested_quantity` for
  `private.xometry_beta_dispatch_permits` and compares it with the result's
  `requested_quantity`. With the switch OFF nothing changes. With it ON, a
  Xometry beta result above quantity 1 that goes through this fenced acceptance
  would get `{"outcome":"stale"}` and never reach `finalize_free_quote_job`.
  Nothing calls `accept_vendor_quote_result` yet (only its SQL, pgTAP and text
  pin). This migration does not restate it, so its bytes and the reviewed md5s
  stay as they are. **Hard prerequisite for switch-on (OVD-1000):** a follow-up
  migration must take that quantity from the permit's lane
  (`quote_request_lanes.requested_quantity`) instead of the literal, with an md5
  precondition and a pgTAP case for acceptance at quantity 5 with the switch ON,
  before the switch is turned on or before any caller starts using the fenced
  acceptance for Xometry beta results, whichever comes first.
- `node scripts/lint-security-definer.mjs` on the migration reports 0 failing
  and 0 baselined (7 SECURITY DEFINER functions). S1, S5 and S6 are owner-only
  private helpers; commit 892a7e9 added their owner-only
  `grant execute ... to postgres` lines (migration around lines 650 and
  1328-1329), which closed the earlier report-mode `grant` finding. The rollback
  does not revoke those grants; with postgres as the owner they change nothing.
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
