# Migration window 1: Blaine's run sheet

Target: Wed Oct 21, 2026. Project ref `ozuatdcakezjtevztjlr`. Base: `main` at `57b2647c` (production ledger has the same 148 versions, read on Oct 12).

## Status at packet time

| Migration | PR | Rehearsal | Verdict |
| --- | --- | --- | --- |
| OVD-462 provider session lease | #675 @ `790466d1` | apply, pgTAP 122/122, 602 diff exact, rollback refuses under a concurrent writer then succeeds, reapply: all pass; no main suite regresses | **GO** |
| OVD-723 export control (one migration: upload block, dispatch gate, backfill) | #677 @ `673fbe33` | applies, own suite 91/91, rollback (packet file) and reapply pass; **6 main suites regress** | **NO GO until #677 retargets those suites and Blaine accepts the dispatch outage below** |
| OVD-722 provider kill switch | #676 @ `f3ce78b3` | applies, own suite 53/53, rollback and reapply pass; **4 more main suites regress** | **NO GO until #676 retargets those suites** |
| OVD-725 Stripe catalog | #671 | no migration draft (only a test file) | not in window 1 |

Evidence: `rehearsal/ovd-462-only/summary.json` (the GO path) and `rehearsal/recommended/summary.json` (all three, order 462, 723, 722, kill switch outermost). Findings: [review-722-723.md](review-722-723.md) and [rehearsal/REPORT.md](rehearsal/REPORT.md). If any PR head moves, update the SHA in `manifest.json` and rerun `node scripts/window-1/rehearse.mjs --order ovd-462` (about 2 minutes, local only).

## Before the window (any day, read only)

1. **PITR.** Dashboard, project, **Database > Backups > Point in time**. It must show a recovery window ("restore to any point since ..."). An upgrade or "enable" prompt means PITR is off: **no go**. Cross check: **Project Settings > Add-ons > Point in time recovery** shows a retention period.
2. **Connection.** Dashboard, **Connect > Session pooler**, copy the URI. In your shell only: `export DB_URL='postgresql://...'` (never paste it anywhere else).
3. **Baseline inventory** from a checkout of `main`:
   ```
   psql "$DB_URL" -X -A -t -q -f scripts/window-1/ovd602-inventory.sql > /tmp/w1-before.json
   node scripts/window-1/ovd602-diff.mjs docs/release/window-1/ovd602-pin.main.json /tmp/w1-before.json
   ```
   Expected: `ovd602: no difference from the pin`. Any other line is drift between production and `main`: stop and send me the output.
4. **Rollback role.** `psql "$DB_URL" -X -At -c "select rolsuper or rolbypassrls from pg_roles where rolname = current_user"` must print `t`. The 462 rollback refuses otherwise (it could not see occupants through forced RLS).

## Go/no go (all must hold at the start)

PITR shows a window; baseline diff is empty; `supabase db push --db-url "$DB_URL" --dry-run` from `main` says the remote is up to date; the PR head SHA equals `manifest.json`; the PR's CI is green; the worker build that uses the migration is **not** deployed yet. Write down `select now();` as the restore point.

## Migration 1: OVD-462 (GO)

**Promote** (an agent can do this before the window; you only label):
```
git switch -c window-1/ovd462 origin/main
F=supabase/migrations/$(npm run --silent migration:next -- ovd462_provider_session_lease)
git show 790466d1:docs/migration-drafts/ovd-462.sql > "$F"
sha256sum "$F"   # must print 757fcd6b419d3ae46eaab1b5a09989a9ceabc1fef9a2b645e622d716b4971418
```
Commit, push, open a PR labeled `blaine-window`. Wait for green CI.

**Apply** from that PR branch:
```
supabase db push --db-url "$DB_URL" --dry-run   # lists exactly one file: $F
supabase db push --db-url "$DB_URL"
```
Expected: `Applying migration <timestamp>_ovd462_provider_session_lease.sql...` then `Finished supabase db push.` Rehearsed apply time: about 25 ms.

**Read back** (SQL editor):
```sql
select p.proname, p.prosecdef, p.proconfig,
       has_function_privilege('anon', p.oid, 'execute') as anon,
       has_function_privilege('authenticated', p.oid, 'execute') as authed,
       has_function_privilege('service_role', p.oid, 'execute') as svc
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.proname ~ '^(acquire|renew|release|report|revoke|clear)_provider_session'
order by 1;
select relname, relrowsecurity, relforcerowsecurity,
       (select count(*) from pg_policies where tablename = relname) as policies
from pg_class where relname in ('provider_session_leases', 'provider_session_bindings');
```
Expected: 6 rows, each `prosecdef = true`, `proconfig = {search_path=""}`, `anon = false`, `authed = false`, `svc = true`. Then 2 rows, both `true, true, 0`.

**602 diff:**
```
psql "$DB_URL" -X -A -t -q -f scripts/window-1/ovd602-inventory.sql > /tmp/w1-after-462.json
node scripts/window-1/ovd602-diff.mjs /tmp/w1-before.json /tmp/w1-after-462.json --expect docs/release/window-1/ovd602-expected/ovd-462.json
```
Expected last line: `ovd602: difference matches ... exactly` (6 functions added, 2 tables added, 0 flags).

**Pass:** merge the PR. **Fail** (any expected line differs), roll back:
```
psql "$DB_URL" -X -v ON_ERROR_STOP=1 --single-transaction -f docs/migration-drafts/ovd-462.rollback.sql
supabase migration repair --db-url "$DB_URL" --status reverted <timestamp>
```
Then close the PR unmerged. The rollback locks both lease tables and refuses if a lease row is active or blocked; there are none before the worker ships. Rehearsed: rollback about 20 ms, inventory returns exactly to the pin, reapply passes; with a writer holding an uncommitted lease, the rollback waited about 3 s for it and then refused, leaving everything in place.

## Migration 2: OVD-723 (NO GO until #677 is fixed and Blaine decides)

Now one migration: upload block (legacy upload RPCs refuse, Storage INSERT needs an exact grant), dispatch gate, and a backfill of a `missing` declaration for every job with files. Blocking: main suites `empty_file_upload_rejection`, `founding_beta_file_boundaries`, `free_confirmed_quote_access`, `provider_dispatch_preflight`, `provider_dispatch_preflight_concurrency` and `xometry_beta_dispatch_permits` fail after it. **Blaine decides:** every existing job is refused dispatch until its owner declares (R723-1), and old browser clients cannot upload until the new client ships. Ask #677 to add `set local lock_timeout = '3s';` before the `storage.objects` policy swap (R723-5). When ready, the steps match migration 1 with slug `ovd723_export_control_upload_block`, the draft up to its `-- ROLLBACK` line, deploy order migration, then client, then worker, and rollback `docs/release/window-1/rollback/ovd-723.rollback.sql` (rehearsed; keeps the audit tables).

## Migration 3: OVD-722 (NO GO until #676 is fixed)

Blocking: main suites `job_service_detail_privileges`, `provider_dispatch_admission_serialization`, `provider_dispatch_permits` and `xometry_beta_dispatch_admission_serialization` fail after it (`provider_dispatch_preflight` too when it runs without 723); the draft lists only 3 retargets (R722-1). Also: remove the nested `begin;`/`commit;` (R722-2) and add the order guard to the rollback (RX-1). When fixed, the steps match migration 1 with slug `ovd722_provider_kill_switch`, the draft at the new SHA, and rollback `docs/release/window-1/rollback/ovd-722.rollback.sql` (run with `psql -f`; it carries its own transaction). Readback: as an admin, `select * from api_admin_list_provider_kill_switches()` shows one row per provider, all `engaged = false`, plus the global row. Deploy order: migration first, then the worker build.

## If both 722 and 723 ship together later

Apply 723 before 722 (as above) so the kill switch wraps outermost (then a switched off provider reports `provider_kill_switch_engaged`; in the other order the 722 suite failed 2 assertions at the earlier heads). Roll back strictly in reverse order of apply; rolling back the inner one first silently removes the outer gate.

## After the window

Merge each promotion PR you applied, in order. Rerun step 3 and keep `/tmp/w1-after-*.json`; it becomes the new pin (`node scripts/window-1/ovd602-diff.mjs --normalize <file> docs/release/window-1/ovd602-pin.main.json` in a follow up PR).
