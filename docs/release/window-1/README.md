# Migration window 1: Blaine's run sheet

Target: Wed Oct 21, 2026. Project ref `ozuatdcakezjtevztjlr`. Base: `main` at `cc9a5fe8` (production ledger has the same 148 versions, read on Oct 12).

## Status at packet time

| Migration | PR | Rehearsal | Verdict |
| --- | --- | --- | --- |
| OVD-462 provider session lease | #675 @ `42d5cc61` | apply 22 ms, pgTAP 128/128, 602 diff exact (0 flags), rollback refuses under a concurrent writer then succeeds, reapply: all pass; no main suite regresses | **GO** |
| OVD-723 export control, EXPAND (contract is a later window) | #677 @ `c1fbcd71` | apply 30 ms, pgTAP 94/94, 602 diff exact, guarded rollback (keeps audit tables) and reapply pass; no main suite regresses with the 6 suites the PR updates | **GO on evidence; Blaine decides the dispatch hold below** |
| OVD-722 provider kill switch | #676 @ `b623890a` | apply 22 ms, pgTAP 56/56, 602 diff exact, guarded rollback and reapply pass; no main suite regresses | **GO on evidence; needs Blaine's expand only exception** |
| OVD-725 Stripe catalog | #671 | no migration draft (only a test file) | not in window 1 |

Evidence: `rehearsal/ovd-462-only/summary.json` (the GO path) and `rehearsal/recommended/summary.json` (all three, order 462, 723, 722: every gate passes). Findings: [review-722-723.md](review-722-723.md) and [rehearsal/REPORT.md](rehearsal/REPORT.md). If any PR head moves, update the SHA in `manifest.json` and rerun `node scripts/window-1/rehearse.mjs --order ovd-462` (about 2 minutes, local only).

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

## Migration 2: OVD-723 EXPAND (Blaine decides)

**Decide first.** Expand is additive (new tables, RPCs, one extra Storage policy; legacy upload RPCs, the old policy and both preflights unchanged). But it backfills a `missing` declaration for every existing job with files, and the new 723 worker refuses dispatch for a job without a clean declaration and clean scans. Once that worker ships, every existing job waits until its owner declares. Old clients and direct calls to the legacy upload RPCs are not blocked until the contract migration (a later window).

**Promote:** as in migration 1, with slug `ovd723_export_control_upload_block`, source `git show c1fbcd71:docs/migration-drafts/ovd-723.sql`, sha256 `22d6b4b8794868220d5562a32aba2d9ed76b123400399b32a13c5108fb0765ac`. The same PR must carry #677's edits to the 6 main suites (`empty_file_upload_rejection`, `founding_beta_file_boundaries`, `free_confirmed_quote_access`, `provider_dispatch_preflight`, `provider_dispatch_preflight_concurrency`, `xometry_beta_dispatch_permits`) and rename the pending suite to `supabase/tests/ovd723_export_control_upload_block.sql`.

**Apply:** the same two `supabase db push` lines. Rehearsed apply time: about 30 ms. Deploy order after it: web client, then worker.

**Read back:**
```sql
select count(*) filter (where answer = 'missing') as backfilled, count(*) as declarations
from private.job_export_declarations;
select policyname from pg_policies where schemaname = 'storage' and tablename = 'objects'
  and policyname like 'job_files_storage_insert%' order by 1;
select has_function_privilege('anon', 'public.api_check_export_control_dispatch(uuid,text)', 'execute') as anon,
       has_function_privilege('service_role', 'public.api_check_export_control_dispatch(uuid,text)', 'execute') as svc;
```
Expected: `backfilled` equals `declarations` and equals the number of jobs that have files; two policies, `job_files_storage_insert` and `job_files_storage_insert_export_cleared`; `anon = false`, `svc = true`.

**602 diff:** `--expect docs/release/window-1/ovd602-expected/ovd-462+ovd-723.json` (against `/tmp/w1-before.json`; 15 functions, 7 tables, 5 policies, 6 flags, all deliberate `authenticated` grants).

**Rollback:** `psql "$DB_URL" -X -v ON_ERROR_STOP=1 --single-transaction -f docs/migration-drafts/ovd-723.rollback.sql` (from the PR branch), then `supabase migration repair --db-url "$DB_URL" --status reverted <timestamp>`. It refuses if the contract is applied, and keeps the audit tables (including the backfilled rows). Roll the client and worker back first: they fail closed without these RPCs. Rehearsed: about 16 ms; only the 4 audit tables and their 4 read policies remain; reapply passes.

## Migration 3: OVD-722 (needs Blaine's expand only exception)

**Decide first.** PHASE 1 is additive. PHASE 2 wraps the two worker preflights and adds a permit insert trigger; with every switch off (the seeded state) behavior is unchanged, but it changes existing objects, so the window rule needs your exception. Without it, ask #676 to split PHASE 2 into a later window.

**Promote:** slug `ovd722_provider_kill_switch`, source `git show b623890a:docs/migration-drafts/ovd-722.sql`, sha256 `59a145170bd31cbcb34b93d849cfbadfe30a18ecb9f1c2ff9247de4c407a1d6b`; rename the pending suite to `supabase/tests/ovd722_provider_kill_switch.sql` in the same PR.

**Apply:** the same two `supabase db push` lines; about 22 ms. Deploy the 722 worker after it (that worker refuses every live dispatch while the switch RPC is missing).

**Read back** (as a platform admin in the app, or): `select provider, engaged from private.provider_kill_switches order by 1;` and `select engaged from private.provider_global_kill_switch;`. Expected: one row per provider, all `false`; global `false`.

**602 diff:** `--expect docs/release/window-1/ovd602-expected/ovd-462+ovd-723+ovd-722.json` (25 functions, 10 tables, 5 policies in total; 12 flags, all deliberate).

**Rollback:** `psql "$DB_URL" -X -v ON_ERROR_STOP=1 -f docs/release/window-1/rollback/ovd-722.rollback.sql` (it carries its own transaction; derived byte for byte from the draft), then `supabase migration repair ... --status reverted <timestamp>`. It refuses if any switch is engaged, if the role cannot bypass RLS, or if 722 is not the outermost wrapper. Roll the worker back first. Rehearsed: about 16 ms, inventory back exactly; reapply passes.

## Order and rollback

Apply in the order 462, 723, 722 (kill switch outermost), one promotion PR at a time, each merged only after its readback and 602 diff pass. Roll back strictly in reverse order. If you skip 723, rerun `node scripts/window-1/rehearse.mjs --order ovd-462,ovd-722 --write-expected --skip-main-suites` first to get the matching expected diff.

## After the window

Merge each promotion PR you applied, in order. Rerun step 3 and keep `/tmp/w1-after-*.json`; it becomes the new pin (`node scripts/window-1/ovd602-diff.mjs --normalize <file> docs/release/window-1/ovd602-pin.main.json` in a follow up PR).
