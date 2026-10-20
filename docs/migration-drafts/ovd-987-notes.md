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
| S4 `public.api_authorize_xometry_beta_worker_dispatch` | Lane quantity must equal its own snapshot quantity; current candidate at the lane's quantity; new re-check after the rollout check: a lane above 1 is refused with `dispatch_quantity_not_admitted` while the switch is off (only for such a lane it first takes the shared advisory lock `commercial-rollout:controlled_beta_user_quantity`) |
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

## Body diff (previous definition to new, `pg_proc.prosrc`)

| Function | Previous source | Lines | Previous md5 / bytes | New md5 / bytes |
| --- | --- | --- | --- | --- |
| `api_set_commercial_rollout_control` | 20260802020349 | -1 +2 | `eb741ed4f0be63d3189486959cdccdac` / 4468 | `2a2b6b6980abb0dd113b64b3dcd57041` / 4505 |
| S1 | 20261010230000 | -1 +10 | `0d4abcf48f054aced6dd3d531a1114bb` / 9234 | `916594293cfc4e66053acf4c7414b2ba` / 9656 |
| S3 | 20261004100000 | -1 +6 | `b633e6921485eefc211ab238bab10e43` / 6331 | `28c932e1ccf964302ffed42d9ce4bc0b` / 6550 |
| S4 | 20261002182910 | -2 +18 | `eb659d92aa927555f4c4fe93591fa9d1` / 9505 | `aa54ed4353e52ea527649ab31276c476` / 10303 |
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

Turn off the same way with `false`. While off, S1 denies new requests above 1
and S4 refuses queued lanes above 1 before browser launch; holds already
reserved at N settle normally. The worker maps the new reason
`dispatch_quantity_not_admitted` to `dispatch_authorization_denied` until a
worker PR adds it to its bounded list.

## Rollback order (design 5.4)

1. Switch off (above).
2. Drain: check 1 above returns `in_flight = 0` (a refused task fails, its
   result fails, the meter releases; `api_reconcile_terminal_free_quote_tasks`
   settles stragglers).
3. Apply the rollback file as one transaction. Its guard enforces 1 and 2.

Data loss: none. The deleted control row is disabled; its audit events are
immutable and stay (the events CHECK then keeps the capability, with a NOTICE).

## Ordering with other work

- OVD-979 (20261020002126/7): no function overlap. The staging packet for this
  migration applies only onto a ledger whose head is 20261020002127 (155 rows).
  If OVD-979 lands on main first, add its two entries before this one in
  `REVIEWED_APPENDED_MIGRATIONS` and regenerate
  `scripts/fixtures/free-quote-ci-source.json` (156 files).
- OVD-762 (draft): copies S1, S3 and S4. Whichever lands second rebases onto
  the other; this migration and its rollback refuse to overwrite an unknown
  body.
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
- Release tooling that pins exactly four rollout controls, all disabled:
  `scripts/verify-ovd373-*.sql`, `scripts/verify-ovd418-production-quiescence.sql`,
  `scripts/ovd419-acquisition-compatibility.mjs`. They belong to frozen or held
  release packages and are not changed here; a future reuse against a database
  with this migration must allow the fifth control.
