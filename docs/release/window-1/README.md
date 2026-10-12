# Migration window 1: Blaine's run sheet

Target: Wed Oct 21, 2026. Project ref `ozuatdcakezjtevztjlr`. Base: `main` at `cc9a5fe8` (production ledger had the same 148 versions on Oct 12).

## Status at packet time

| Migration | PR @ pin | Rehearsal | Verdict |
| --- | --- | --- | --- |
| OVD-462 provider session lease | #675 @ `42d5cc61` | apply about 25 ms, pgTAP 128/128, 602 diff exact (0 flags), rollback refuses under a concurrent writer and otherwise restores the pin, reapply passes, no main suite regresses | **GO** (decision 1 below) |
| OVD-723 export control, EXPAND | #677 @ `161329de` (placeholder) | apply about 42 ms, pgTAP 128/128, 602 diff exact, guarded rollback (keeps audit tables) and reapply pass, no main suite regresses with the 6 suites the PR updates | **GO** (decision 2 below) |
| OVD-722 provider kill switch (expand only) | #676 @ `a8e0bfd7` | apply about 35 ms, pgTAP 66/66, 602 diff exact, guarded rollback and reapply pass, no main suite regresses | **GO** |
| OVD-723 CONTRACT | #677 | `ovd-723-contract.sql`: the server side ITAR/EAR block | **window 2** (about Nov 9) |
| OVD-725 Stripe catalog | #671 | `docs/migration-drafts/ovd-725-stripe-catalog.sql` (expand only) | **window 2** |

Evidence: `rehearsal/ovd-462-only/summary.json` and `rehearsal/recommended/summary.json` (462, 723, 722: every gate passes). Findings: [review-722-723.md](review-722-723.md), [rehearsal/REPORT.md](rehearsal/REPORT.md). If a PR head moves, the packet is repinned and rehearsed again; a head that differs from this table is a no go. **723 is pinned at a placeholder** (`161329de`): its round 4 may still change `ovd-723.sql`, and the packet will be repinned once more before the window. The 722 SQL is final at `a8e0bfd7`.

## Blaine decides before the window

1. **OVD-462 operator RPCs.** `revoke_provider_session_binding` and `clear_provider_session_binding_block` are granted to `service_role` like the worker RPCs (called only from the admin server path). The draft recommends keeping `service_role` for 1.0 and a dedicated operator database role in 1.1. Confirm, or ask for the role now.
2. **OVD-723 dispatch hold.** Once the new 723 worker ships, every existing job with files is held until its owner declares (see migration 2).

## What you need

* This packet merged to `main` (it carries `scripts/window-1/`), Node 20, the Supabase CLI, Docker (for the local restore), and `psql` 17 or newer. **The hosted project runs PostgreSQL 17**, and the rehearsal must use the same major version: PostgreSQL 17 grants the new `MAINTAIN` table privilege, so an inventory taken on 16 differs from production on 56 relations. `rehearse.mjs` refuses any cluster whose major version differs from `manifest.json` (`postgresMajor: 17`); it needs PostgreSQL 17 server binaries and pgTAP (on macOS point `OVD_PG_BIN` at them). `restore-check.mjs` finds `psql` in the standard install locations (apt, Homebrew, libpq, Postgres.app); anywhere else, set `OVD_PSQL` to its absolute path.
* `DB_URL`: Dashboard, **Connect > Session pooler**, copy the URI. In your shell only: `export DB_URL='postgresql://...'`. Never paste it anywhere else, never commit it.

## Pre-window dry run (Oct 19 or 20, read only)

From a checkout of `main`:
```
psql "$DB_URL" -X -A -t -q -f scripts/window-1/ovd602-inventory.sql > /tmp/w1-dryrun.json
node scripts/window-1/ovd602-diff.mjs docs/release/window-1/ovd602-pin.main.json /tmp/w1-dryrun.json
psql "$DB_URL" -X -At -c "select rolsuper or rolbypassrls from pg_roles where rolname = current_user"
```
Expected: `ovd602: no difference from the pin`, then `t`. Then run the full dump and restore check below once, end to end, and expect `restore check PASS`.

**Oct 12 baseline.** The lead ran exactly the inventory and diff commands above, read only, against production with `scripts/window-1/ovd602-inventory.sql` at `46d07c03` (sha256 `33d63f00…`). Production matched the pin in every schema, all 290 functions, all 123 relations and all 132 policies, except that the then PostgreSQL 16 pin lacked `MAINTAIN` on 56 relations. The pin is now regenerated on PostgreSQL 17 (the 17 pin minus `MAINTAIN` equals the old pin byte for byte), so the same commands should print `ovd602: no difference from the pin`. If the diff tool prints "only one side grants MAINTAIN", the two inventories come from different major versions.

On a mismatch: do not change anything. Send the diff output (it names objects and grants, never data). A drift between production and `main` must be explained before the window; a `restore check FAIL` means the backup path is not proven and the window does not start.

## Start of the window (Oct 21)

1. **Baseline, again.** Run the first two commands above into `/tmp/w1-before.json` and diff it against the pin. Expected: `ovd602: no difference from the pin`.
2. **Rollback role.** The third command above prints `t`.
3. **Dump** (on your machine only, outside the repo; it holds customer data):
   ```
   mkdir -p ~/w1-backup && chmod 700 ~/w1-backup
   supabase db dump --db-url "$DB_URL" -f ~/w1-backup/schema.sql
   supabase db dump --db-url "$DB_URL" --data-only --use-copy -f ~/w1-backup/data.sql
   psql "$DB_URL" -X -A -t -q -f scripts/window-1/smoke-counts.sql > ~/w1-backup/counts.prod.json
   psql "$DB_URL" -X -A -t -q -f scripts/window-1/storage-policies.sql > ~/w1-backup/storage-policies.sql
   ```
   Roles are not dumped. Storage file bytes are not in a database dump. Do not start while a customer is uploading.
4. **Restore check** into an empty, throwaway local Supabase stack (stop any other local stack first; same ports), never the linked project:
   ```
   mkdir -p ~/w1-restore && cd ~/w1-restore && supabase init && supabase start
   cd <repo> && node scripts/window-1/restore-check.mjs --target postgresql://postgres:postgres@127.0.0.1:54322/postgres --dump ~/w1-backup
   (cd ~/w1-restore && supabase stop --no-backup)
   ```
   Expected: 7 `PASS` lines ending in `restore check PASS`. The script refuses any non local target, creates the repo's two NOLOGIN roles, clears the stack's default grants (otherwise restored objects pick up `anon` access production revoked), loads schema, data and storage policies in one transaction, and requires equal row counts and a 602 inventory equal to the pin.
5. **Rollback files**, taken from the pinned SHAs (the draft directory does not exist on `main`):
   ```
   git show 42d5cc61:docs/migration-drafts/ovd-462.rollback.sql > /tmp/ovd-462.rollback.sql
   git show 161329de:docs/migration-drafts/ovd-723.rollback.sql > /tmp/ovd-723.rollback.sql
   cp docs/release/window-1/rollback/ovd-722.rollback.sql /tmp/ovd-722.rollback.sql
   sha256sum /tmp/ovd-462.rollback.sql /tmp/ovd-723.rollback.sql /tmp/ovd-722.rollback.sql
   ```
   Expected, in order: `9c8943b784c762a6365efd355921e3ca9e5df19229db429fdedc13b43959ad6d`, `de183d8ad4f3d97fa6288ca42e8df6e73f2457913ea96b6fa7faadf27b6d828b`, `c88ed166312e23abcef7daa6d9e76ffd294aa24ae4c582b0d9db9f5ab4863ecf`.

**Go/no go.** All must hold: steps 1 to 5 as expected; every PR head equals the table above with green CI; no worker or client build that uses these migrations is deployed yet. Write down `select now();`. The dump in `~/w1-backup` is the recovery point beyond the per migration rollbacks; restoring it to production is a separate decision.

## Rules for every migration

* **One promotion PR at a time.** Cut its branch from `origin/main` only after the previous promotion PR has merged (`git fetch origin && git switch -c <branch> origin/main`). Before the dry run, `git log origin/main..HEAD --name-only` must list exactly one new file under `supabase/migrations/`, plus that PR's test files.
* **Dry run first.** `supabase db push --db-url "$DB_URL" --dry-run` must list exactly that one migration. Anything else: stop.
* **Never run `supabase migration repair` in the window.** If `db push` refuses (for example "Remote migration versions not found") or fails, stop and send the output. A failed apply changes nothing: the CLI runs the file in one transaction.
* **Pass** means every readback and the 602 diff match. Then merge the promotion PR and only then cut the next branch.
* **Fail** means any line differs. Run that migration's rollback from `/tmp`, close the promotion PR unmerged, stop the window, and send the output. Do not apply the next migration. Reconciling the ledger row is decided afterwards, not in the window.
* Roll back strictly in reverse order of apply.

## Migration 1: OVD-462

**Promote** (an agent can prepare it; you label it `blaine-window`):
```
git fetch origin && git switch -c window-1/ovd462 origin/main
F=supabase/migrations/$(npm run --silent migration:next -- ovd462_provider_session_lease)
git show 42d5cc61:docs/migration-drafts/ovd-462.sql > "$F"
sha256sum "$F"   # 9a95f7e38063dd56d50101b1d87efd3e6d70e445c70576eaf0fc7e0b026bf360
for t in provider_session_leases.sql fixtures/ovd462_provider_session_leases.inc fixtures/ovd462_provider_session_leases_rollback.inc; do
  git show 42d5cc61:supabase/tests/$t > supabase/tests/$t; done
```
The suite and its two fixture files ship in this PR byte for byte (the suite always loads the rollback fixture). #675 merges after this PR; its copies are identical, and its author removes `docs/migration-drafts/ovd-462*` there.

**Apply:** dry run (one file, `$F`), then `supabase db push --db-url "$DB_URL"`. Expected: `Applying migration <timestamp>_ovd462_provider_session_lease.sql...`, `Finished supabase db push.`

**Read back** (SQL editor):
```sql
select count(*) = 6 and bool_and(p.prosecdef and 'search_path=""' = any(p.proconfig)
         and not has_function_privilege('anon', p.oid, 'execute')
         and not has_function_privilege('authenticated', p.oid, 'execute')
         and has_function_privilege('service_role', p.oid, 'execute')) as rpcs_ok
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.proname ~ '^(acquire|renew|release|report|revoke|clear)_provider_session';
select count(*) = 2 and bool_and(c.relrowsecurity and c.relforcerowsecurity) as tables_ok,
       (select count(*) from pg_policies where tablename in ('provider_session_leases', 'provider_session_bindings')) = 0 as no_policies
from pg_class c where c.oid in ('public.provider_session_leases'::regclass, 'public.provider_session_bindings'::regclass);
```
Expected: `rpcs_ok = true`, `tables_ok = true`, `no_policies = true`.

**602 diff:**
```
psql "$DB_URL" -X -A -t -q -f scripts/window-1/ovd602-inventory.sql > /tmp/w1-after-462.json
node scripts/window-1/ovd602-diff.mjs /tmp/w1-before.json /tmp/w1-after-462.json --expect docs/release/window-1/ovd602-expected/ovd-462.json
```
Expected last line: `ovd602: difference matches ... exactly` (6 functions, 2 tables, 0 flags).

**Pass:** merge. **Fail:** `psql "$DB_URL" -X -v ON_ERROR_STOP=1 --single-transaction -f /tmp/ovd-462.rollback.sql`, then stop (rules above). It refuses while a lease is active or blocked (none exist before the worker ships) or if the role cannot bypass RLS. Rehearsed: about 16 ms, inventory back to the pin exactly, reapply passes; with a writer holding an uncommitted lease it waited about 3 s and then refused.

## Migration 2: OVD-723 EXPAND

**Decision 2 applies.** Expand is additive: new tables, RPCs and one extra Storage insert policy; the legacy upload RPCs, the existing policy and both preflights are unchanged. It backfills a `missing` declaration for every existing job with files, and the new worker refuses dispatch without a clean declaration and clean scans.

**The server side ITAR/EAR block is complete only after the window 2 contract.** Until then the protection is the new web client path (declare, then the 7 and 9 argument upload RPCs with an exact grant), the new worker's `api_check_export_control_dispatch` before every preflight, and foreign provider admission staying disabled. Old clients, old workers and direct calls to the legacy upload RPCs are not blocked until the contract. Check before the window: `select provider, admission_state from private.quote_provider_admission_policies where provider in ('geomiq', 'weerg');` returns two rows, both `disabled`.

**Promote:** branch `window-1/ovd723` from `origin/main` after migration 1 merged; slug `ovd723_export_control_upload_block`; `git show 161329de:docs/migration-drafts/ovd-723.sql > "$F"`, sha256 `72fa6de43f75a541749211b361cf22c229c053fab2dabdfbe737c5335e0f378a`. The same PR carries #677's versions of 6 main suites (`empty_file_upload_rejection`, `founding_beta_file_boundaries`, `job_service_detail_privileges`, `provider_dispatch_preflight`, `provider_dispatch_preflight_concurrency`, `xometry_beta_dispatch_permits`; `git show 161329de:supabase/tests/<name>.sql`) and its pending suite renamed to `supabase/tests/ovd723_export_control_upload_block.sql`. 

**Merge order on window day (723):** (1) the 723 promotion PR passes readback and the 602 diff and merges; (2) **#677 merges immediately after**, on the same day. #677's own CI stays red until the expand migration is in `supabase/migrations`, because its client path calls the expand RPCs; do not expect it green, or merge it, before step 1. Merging #677 deploys the web client. (3) Then the 723 worker ships.

**Apply:** dry run (one file), then `db push`.

**Read back:**
```sql
select (select count(*) from private.job_export_declarations)
         = (select count(*) from public.jobs j where exists (select 1 from public.job_files f where f.job_id = j.id)) as backfill_ok,
       (select count(*) from private.job_export_declarations where answer <> 'missing') = 0 as only_backfill,
       (select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects'
          and policyname in ('job_files_storage_insert', 'job_files_storage_insert_export_cleared')) = 2 as policies_ok,
       not has_function_privilege('anon', 'public.api_check_export_control_dispatch(uuid,text)', 'execute')
         and has_function_privilege('service_role', 'public.api_check_export_control_dispatch(uuid,text)', 'execute') as grants_ok;
```
Expected: four `true`.

**602 diff:** as above into `/tmp/w1-after-723.json`, `--expect docs/release/window-1/ovd602-expected/ovd-462+ovd-723.json` (cumulative from `/tmp/w1-before.json`; 6 flags, all deliberate `authenticated` grants).

**Pass:** merge. **Fail:** `psql "$DB_URL" -X -v ON_ERROR_STOP=1 --single-transaction -f /tmp/ovd-723.rollback.sql`, then stop. It refuses if the contract is applied and keeps the audit tables, including the backfilled rows. If the client or worker already shipped, roll them back first (they fail closed without these RPCs). Rehearsed: about 20 ms; only the 4 audit tables and their 4 read policies remain; reapply passes.

## Migration 3: OVD-722

Expand only: new tables, RPCs and a BEFORE INSERT trigger on both permit tables that refuses with `provider_kill_switch_engaged` only while a switch is engaged. No existing function changes.

**Promote:** branch `window-1/ovd722` from `origin/main` after migration 2 merged; slug `ovd722_provider_kill_switch`; `git show a8e0bfd7:docs/migration-drafts/ovd-722.sql > "$F"`, sha256 `7acf12f06963220d917e65c2a738dfe4a6092be15aff4fc38ceff41ea7a48c13`; rename the pending suite to `supabase/tests/ovd722_provider_kill_switch.sql`. #676 merges after this PR, then its worker ships (that worker refuses every live dispatch while the switch RPC is missing).

**Apply:** dry run (one file), then `db push`.

**Read back:**
```sql
select count(*) = (select count(*) from unnest(enum_range(null::public.vendor_name))) and bool_and(not engaged) as providers_off,
       (select not engaged from private.provider_global_kill_switch) as global_off
from private.provider_kill_switches;
```
Expected: two `true`.

**602 diff:** into `/tmp/w1-after-722.json`, `--expect docs/release/window-1/ovd602-expected/ovd-462+ovd-723+ovd-722.json` (25 definer functions, 10 tables, 5 policies in total; no existing function changed; 9 flags, all deliberate).

**Pass:** merge. **Fail:** export the audit table first, then roll back:
```
psql "$DB_URL" -X -c "\copy private.provider_kill_switch_audit to '$HOME/w1-backup/provider_kill_switch_audit.csv' csv header"
psql "$DB_URL" -X -v ON_ERROR_STOP=1 -f /tmp/ovd-722.rollback.sql
```
then stop. The rollback carries its own transaction, drops `private.provider_kill_switch_audit`, and fails closed: it refuses while any switch is engaged, while the global or any provider switch row is missing, or if the role cannot bypass RLS. Roll the worker back first. Rehearsed: about 29 ms, inventory back exactly, reapply passes.

## If 723 is skipped

Apply 462 then 722 and use `--expect docs/release/window-1/ovd602-expected/ovd-462+ovd-722.json` for the 722 diff (checked in; 722 alone against `main` is `ovd-722.json`).

## What the 602 inventory covers

`scripts/window-1/ovd602-inventory.sql` pins, for application schemas: every SECURITY DEFINER function and every function `anon` or `authenticated` can execute (search_path and EXECUTE grantees), table and view grants and RLS flags for PUBLIC, `anon`, `authenticated` and `service_role`, every RLS policy (including `storage`), and schema USAGE. It does **not** cover column grants, default ACLs, schema CREATE, sequences, owners or triggers.

## After the window

When every applied promotion PR is merged, rerun step 1 of the window start into `/tmp/w1-after.json`; it becomes the new pin (`node scripts/window-1/ovd602-diff.mjs --normalize /tmp/w1-after.json docs/release/window-1/ovd602-pin.main.json` in a follow up PR).
