# Migration window 1: Blaine's run sheet

Target: Wed Oct 21, 2026. Project ref `ozuatdcakezjtevztjlr`. Base: `main` at `b6a66c83` (production ledger has the same 148 versions, read on Oct 12).

## Status at packet time

| Migration | PR | Rehearsal | Verdict |
| --- | --- | --- | --- |
| OVD-462 provider session lease | #675 @ `42d5cc61` | apply, pgTAP 128/128, 602 diff exact, rollback refuses under a concurrent writer then succeeds, reapply: all pass; no main suite regresses | **GO** |
| OVD-723 export control (one migration: upload block, dispatch gate, backfill) | #677 @ `673fbe33` | applies, own suite 91/91, rollback (packet file) and reapply pass; **6 main suites regress** | **NO GO until #677 retargets those suites and Blaine accepts the dispatch outage below** |
| OVD-722 provider kill switch | #676 @ `f3ce78b3` | applies, own suite 53/53, rollback and reapply pass; **4 more main suites regress** | **NO GO until #676 retargets those suites** |
| OVD-725 Stripe catalog | #671 | no migration draft (only a test file) | not in window 1 |

Evidence: `rehearsal/ovd-462-only/summary.json` (the GO path) and `rehearsal/recommended/summary.json` (all three, order 462, 723, 722, kill switch outermost). Findings: [review-722-723.md](review-722-723.md) and [rehearsal/REPORT.md](rehearsal/REPORT.md). If any PR head moves, update the SHA in `manifest.json` and rerun `node scripts/window-1/rehearse.mjs --order ovd-462` (about 2 minutes, local only).

## Before the window (any day, read only)

The org is on the Supabase Free plan: no automated backups and no PITR (Blaine's decision, OVD-735). The backup is a fresh logical dump that is restored locally and checked before anything is applied.

1. **Connection.** Dashboard, **Connect > Session pooler**, copy the URI. In your shell only: `export DB_URL='postgresql://...'`. Never paste it anywhere else, never commit it.
2. **Baseline inventory** from a checkout of `main`:
   ```
   psql "$DB_URL" -X -A -t -q -f scripts/window-1/ovd602-inventory.sql > /tmp/w1-before.json
   node scripts/window-1/ovd602-diff.mjs docs/release/window-1/ovd602-pin.main.json /tmp/w1-before.json
   ```
   Expected: `ovd602: no difference from the pin`. Any other line is drift between production and `main`: stop and send me the output.
3. **Rollback role.** `psql "$DB_URL" -X -At -c "select rolsuper or rolbypassrls from pg_roles where rolname = current_user"` must print `t`. The 462 rollback refuses otherwise (it could not see occupants through forced RLS).

## Immediately before the first apply: dump and restore check

Keep the dump on your machine only (it holds customer data), outside the repo:
```
mkdir -p ~/w1-backup && chmod 700 ~/w1-backup
supabase db dump --db-url "$DB_URL" -f ~/w1-backup/schema.sql
supabase db dump --db-url "$DB_URL" --data-only --use-copy -f ~/w1-backup/data.sql
psql "$DB_URL" -X -A -t -q -f scripts/window-1/smoke-counts.sql > ~/w1-backup/counts.prod.json
psql "$DB_URL" -X -A -t -q -f scripts/window-1/storage-policies.sql > ~/w1-backup/storage-policies.sql
```
Roles are not dumped. Storage file bytes are not in a database dump; only `storage.objects` rows are. Take the counts right after the data dump, and do not start the window if a customer is uploading.

Restore into an empty, throwaway local Supabase stack (Docker; stop any other local stack first, it uses the same ports), never the linked project:
```
mkdir -p ~/w1-restore && cd ~/w1-restore && supabase init && supabase start
cd <repo> && node scripts/window-1/restore-check.mjs --target postgresql://postgres:postgres@127.0.0.1:54322/postgres --dump ~/w1-backup
(cd ~/w1-restore && supabase stop --no-backup)
```
Expected: 7 `PASS` lines, ending in `restore check PASS`. The script refuses any non local target. It creates the repo's two NOLOGIN roles, clears the stack's default grants first (otherwise every restored table and function picks up `anon` access that production revoked), loads schema, data and storage policies in one transaction, then requires the row counts to equal `counts.prod.json` and the 602 inventory to equal the pin. Rehearsed here with `bash scripts/window-1/restore-drill.sh` (synthetic data).

## Go/no go (all must hold at the start)

* The restore check printed `restore check PASS` within the last hour, from a dump taken in this session.
* The baseline 602 diff is empty, and the rollback role check printed `t`.
* `supabase db push --db-url "$DB_URL" --dry-run` from `main` says the remote is up to date.
* Each migration in the window is expand only, has a rehearsed rollback, and its PR head SHA equals `manifest.json`; its PR's CI is green.
* The worker build that uses the migration is **not** deployed yet.

Write down `select now();`. If something goes wrong beyond the per migration rollbacks, the dump in `~/w1-backup` is the recovery point; restoring it to production is a separate decision for Blaine.

## Migration 1: OVD-462 (GO)

**Promote** (an agent can do this before the window; you only label):
```
git switch -c window-1/ovd462 origin/main
F=supabase/migrations/$(npm run --silent migration:next -- ovd462_provider_session_lease)
git show 42d5cc61:docs/migration-drafts/ovd-462.sql > "$F"
sha256sum "$F"   # must print 9a95f7e38063dd56d50101b1d87efd3e6d70e445c70576eaf0fc7e0b026bf360
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

Not expand only: it enforces the upload block and the dispatch gate in the same step, so the window rule needs Blaine's explicit exception. Now one migration: upload block (legacy upload RPCs refuse, Storage INSERT needs an exact grant), dispatch gate, and a backfill of a `missing` declaration for every job with files. Blocking: main suites `empty_file_upload_rejection`, `founding_beta_file_boundaries`, `free_confirmed_quote_access`, `provider_dispatch_preflight`, `provider_dispatch_preflight_concurrency` and `xometry_beta_dispatch_permits` fail after it. **Blaine decides:** every existing job is refused dispatch until its owner declares (R723-1), and old browser clients cannot upload until the new client ships. Ask #677 to add `set local lock_timeout = '3s';` before the `storage.objects` policy swap (R723-5). When ready, the steps match migration 1 with slug `ovd723_export_control_upload_block`, the draft up to its `-- ROLLBACK` line, deploy order migration, then client, then worker, and rollback `docs/release/window-1/rollback/ovd-723.rollback.sql` (rehearsed; keeps the audit tables).

## Migration 3: OVD-722 (NO GO until #676 is fixed)

Not expand only: its wrappers change the behavior of four existing RPCs, so the window rule needs Blaine's explicit exception (or ship only its additive part). Blocking: main suites `job_service_detail_privileges`, `provider_dispatch_admission_serialization`, `provider_dispatch_permits` and `xometry_beta_dispatch_admission_serialization` fail after it (`provider_dispatch_preflight` too when it runs without 723); the draft lists only 3 retargets (R722-1). Also: remove the nested `begin;`/`commit;` (R722-2) and add the order guard to the rollback (RX-1). When fixed, the steps match migration 1 with slug `ovd722_provider_kill_switch`, the draft at the new SHA, and rollback `docs/release/window-1/rollback/ovd-722.rollback.sql` (run with `psql -f`; it carries its own transaction). Readback: as an admin, `select * from api_admin_list_provider_kill_switches()` shows one row per provider, all `engaged = false`, plus the global row. Deploy order: migration first, then the worker build.

## If both 722 and 723 ship together later

Apply 723 before 722 (as above) so the kill switch wraps outermost (then a switched off provider reports `provider_kill_switch_engaged`; in the other order the 722 suite failed 2 assertions at the earlier heads). Roll back strictly in reverse order of apply; rolling back the inner one first silently removes the outer gate.

## After the window

Merge each promotion PR you applied, in order. Rerun step 3 and keep `/tmp/w1-after-*.json`; it becomes the new pin (`node scripts/window-1/ovd602-diff.mjs --normalize <file> docs/release/window-1/ovd602-pin.main.json` in a follow up PR).
