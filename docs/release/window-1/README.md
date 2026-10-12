# Migration window 1: Blaine's run sheet

Target: Wed Oct 21, 2026. Project ref `ozuatdcakezjtevztjlr`. Base: `main` at `efbe516f` (production ledger has the same 148 versions, read on Oct 12).

## Status at packet time

| Migration | PR | Rehearsal | Verdict |
| --- | --- | --- | --- |
| OVD-462 provider session lease | #675 @ `a9923e6d` | apply, pgTAP 122/122, 602 diff exact, rollback, reapply: all pass; no main suite regresses | **GO** |
| OVD-722 provider kill switch | #676 @ `f3ce78b3` | applies, own suite 53/53, rollback and reapply pass; **4 more main suites regress after it** (5 when applied without 723) | **NO GO until #676 is fixed** |
| OVD-723 export control, PHASE 1 | #677 @ `96d8b7ad` | applies, rollback and reapply pass; own suite 58/64 (6 need PHASE 2); **4 main suites regress**; blocks dispatch for every existing job | **NO GO for window 1** |
| OVD-725 Stripe catalog | #671 | no migration draft (only a test file) | not in window 1 |

Evidence: `rehearsal/ovd-462-only/summary.json` (the GO path) and `rehearsal/recommended/summary.json` (all three, order 462, 723, 722). Findings: [review-722-723.md](review-722-723.md) and [rehearsal/REPORT.md](rehearsal/REPORT.md). If any PR head moves, update the SHA in `manifest.json` and rerun `node scripts/window-1/rehearse.mjs --order ovd-462` (about 2 minutes, local only).

## Before the window (any day, read only)

1. **PITR.** Dashboard, project, **Database > Backups > Point in time**. It must show a recovery window ("restore to any point since ..."). An upgrade or "enable" prompt means PITR is off: **no go**. Cross check: **Project Settings > Add-ons > Point in time recovery** shows a retention period.
2. **Connection.** Dashboard, **Connect > Session pooler**, copy the URI. In your shell only: `export DB_URL='postgresql://...'` (never paste it anywhere else).
3. **Baseline inventory** from a checkout of `main`:
   ```
   psql "$DB_URL" -X -A -t -q -f scripts/window-1/ovd602-inventory.sql > /tmp/w1-before.json
   node scripts/window-1/ovd602-diff.mjs docs/release/window-1/ovd602-pin.main.json /tmp/w1-before.json
   ```
   Expected: `ovd602: no difference from the pin`. Any other line is drift between production and `main`: stop and send me the output.

## Go/no go (all must hold at the start)

PITR shows a window; baseline diff is empty; `supabase db push --db-url "$DB_URL" --dry-run` from `main` says the remote is up to date; the PR head SHA equals `manifest.json`; the PR's CI is green; the worker build that uses the migration is **not** deployed yet. Write down `select now();` as the restore point.

## Migration 1: OVD-462 (GO)

**Promote** (an agent can do this before the window; you only label):
```
git switch -c window-1/ovd462 origin/main
F=supabase/migrations/$(npm run --silent migration:next -- ovd462_provider_session_lease)
git show a9923e6d:docs/migration-drafts/ovd-462.sql > "$F"
sha256sum "$F"   # must print 1c152860e106674a3670ef4507a5b5ff9112eb5ff059f3e6e520eeffa1252990
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
Then close the PR unmerged. The rollback refuses if a lease row is active or blocked; there are none before the worker ships. Rehearsed: rollback about 20 ms, inventory returns exactly to the pin, reapply passes.

## Migration 2: OVD-722 (NO GO until these land on #676, then rerun the rehearsal)

Blocking: main suites `job_service_detail_privileges`, `provider_dispatch_admission_serialization`, `provider_dispatch_permits`, `provider_dispatch_preflight` and `xometry_beta_dispatch_admission_serialization` fail after it; the draft lists only 3 retargets (R722-1). Also: remove the nested `begin;`/`commit;` (R722-2) and add the "outermost wrapper" guard to the rollback (RX-1). RLS on its private tables (R722-3) is fixed at `f3ce78b3`.

When fixed, the steps match migration 1 with: slug `ovd722_provider_kill_switch`, the draft `docs/migration-drafts/ovd-722.sql` at the new SHA, the expected diff file for the new order, and rollback `docs/release/window-1/rollback/ovd-722.rollback.sql` (run with `psql -f`, it carries its own transaction). Readback: `select * from api_admin_list_provider_kill_switches()` as an admin shows one row per provider, all `engaged = false`, plus the global row `false`. Deploy order: migration first, then the worker build.

## Migration 3: OVD-723 PHASE 1 (NO GO for window 1)

As drafted, PHASE 1 backfills a `missing` declaration for every job with files and installs the dispatch gate, so every existing job is refused dispatch until a new upload (R723-1, Blocker). It also breaks 4 main suites (R723-2). The reviewer's fix is to split it: an expand only part (tables, RPCs, upload overloads) that could join a later window, and the dispatch gate plus backfill after scans exist. PHASE 2 locks `storage.objects` and is out of window 1 regardless. A runnable PHASE 1 rollback is ready in `rollback/ovd-723-phase1.rollback.sql` and was rehearsed.

## If both 722 and 723 ship together later

Apply 723 before 722 so the kill switch wraps outermost (then a switched off provider reports `provider_kill_switch_engaged`; in the other order the 722 suite fails 2 assertions). Roll back strictly in reverse order of apply; rolling back the inner one first silently removes the outer gate.

## After the window

Merge each promotion PR you applied, in order. Rerun step 3 and keep `/tmp/w1-after-*.json`; it becomes the new pin (`node scripts/window-1/ovd602-diff.mjs --normalize <file> docs/release/window-1/ovd602-pin.main.json` in a follow up PR).
