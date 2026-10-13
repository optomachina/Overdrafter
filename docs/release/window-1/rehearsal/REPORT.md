# OVD-635 window 1 rehearsal report

Runner: `node scripts/window-1/rehearse.mjs` (manifest `docs/release/window-1/manifest.json`). Heads are listed under Results. Drafts read from git objects at the pinned PR SHAs; nothing is fetched during a run.

## Environment and isolation

* **PostgreSQL 17.11**, matching production's major version (`manifest.json` `postgresMajor: 17`; the runner refuses any other). Earlier runs used 16.15; on Oct 12 the lead's read only production baseline showed the only difference to be PostgreSQL 17's `MAINTAIN` privilege on 56 relations. Regenerated on 17, the pin minus `MAINTAIN` equals the 16 pin byte for byte, and all five expected window diffs are unchanged (the window's new tables carry no API grants). PostgreSQL 17 and pgTAP 1.3.4 came from the official PostgreSQL apt repository.

* Disposable PostgreSQL cluster created by `initdb` in a fresh temp directory, started with `listen_addresses=''`: it has a Unix socket and **no TCP listener**, and the runner refuses to continue if `show listen_addresses` is not empty. Every `psql` child gets a scrubbed environment (`PGHOST` is the socket directory; inherited `DATABASE_URL`, `PGHOSTADDR`, passwords and service files are dropped). The cluster and its directory are removed at the end (gate "cleanup removed the disposable cluster").
* No Docker daemon was available in this container, so the local Supabase stack was not used. `scripts/window-1/supabase-shim.sql` stands in for the platform: `anon`, `authenticated`, `service_role` (BYPASSRLS), `auth.users`, `auth.sessions`, `auth.uid()/role()/jwt()`, `storage.buckets/objects/foldername()`, `extensions` with pgcrypto, and Supabase's default privileges on `public`. Toolchain provisioning (pgTAP 1.3.2 from the Ubuntu archive, `npm ci`) happened before the runs; no rehearsal step touches a network host.
* Main migrations run one file per `psql --single-transaction`, except files with `CONCURRENTLY` or their own `BEGIN`/`COMMIT` (9 on main, plus the 722 draft), which run statement by statement. All 148 apply in about 2 s.
* Each pgTAP suite runs in its own `CREATE DATABASE ... TEMPLATE` clone, with pgTAP installed the way `supabase test db` does, and `ovd.test_conninfo` pointed at the socket for the dblink suites.

## Shim fidelity (main, before any draft)

63 of 70 main suites pass. The 7 that fail on the shim fail identically before and after every draft, so they are environment gaps, not window findings: `automatic_quote_rollout_concurrency`, `commercial_rollout_controls_concurrency`, `organization_entitlements_concurrency` ("requires a freshly reset disposable local database"), `stripe_event_sync_concurrency` (requires the database be named `postgres`), `capability_runtime_persistence_concurrency` (needs the OVD-591 CI fixture password), `capability_observation_ledger_concurrency` (2 lock wait timing assertions), `manual_quote_admin_inbox` #63 (a delete that the hosted non superuser `postgres` role cannot do; the shim runs as superuser). The regression gate compares each suite only with its own baseline result.

## Results

Heads: main `5773decb` (149 migrations: the 148 that production had on Oct 12 plus OVD-462, which was applied as migration 1 on Oct 12 and recorded by #717), #677 `efdb41ac` (723 EXPAND, final: round 9, independent review APPROVE), #676 `a53e794b` (722 expand only; its SQL is final and byte identical to `a8e0bfd7`). Earlier heads were rehearsed too. Their results drove the fixes recorded in `review-722-723.md` and are superseded.

| Run | Base | Order | Result | Time |
| --- | --- | --- | --- | --- |
| `ovd-462-only/` (record of migration 1 before it was applied) | `e254d032` | 462 | **PASS, every gate** | 152 s |
| `recommended/` | `5773decb` | 723, 722 | **PASS, every gate** | 221 s |
| 723 alone (not kept; its expected diff is) | `5773decb` | 723 | **PASS, every gate** | 147 s |
| 722 alone (not kept; its expected diff is) | `5773decb` | 722 | **PASS, every gate** | 146 s |

Per migration (recommended run; first apply / reapply):

| | Apply (bytes = draft file, sha256 recorded) | Own pgTAP | Composed pgTAP | Rollback | Reapply |
| --- | --- | --- | --- | --- | --- |
| OVD-462 | applied on production Oct 12 (`ovd-462-only/`: ok 31/34 ms, 128/128, rollback 21 ms; with a concurrent writer it waited 3.0 s, then refused) | | | | |
| OVD-723 EXPAND | ok, 55/35 ms | 167/167 | 167/167 | ok 19 ms with the draft's guarded rollback; only the 4 audit tables and their 4 read policies remain, as intended | ok; 167/167 |
| OVD-722 (expand only) | ok, 24/23 ms | 66/66 | 66/66 | ok 31 ms with the packet rollback, which byte matches the draft's guarded rollback section (it now fails closed when a switch row is missing) | ok; 66/66 |

Main suites: none regresses, gated both per step (against the suites' results just before that migration) and cumulatively. A main suite that a PR edits lands with its migration, so after each migration the runner uses that PR's version: #675 adds `provider_session_leases.sql`, #677 edits 6 suites (`job_service_detail_privileges` joined at `161329de`) (`free_confirmed_quote_access` is now the window 2 contract's seed patch), #676 edits none.

Run sheet readbacks: the runner extracts every `sql` readback block from each migration section of the README and runs it on the rehearsed database. Every value must be `true` (723: 4, 722: 2; 462 had 3 before it was applied). This gate caught a first draft of the 462 readback that compared `proconfig` to a one element array; the functions also set `lock_timeout`. At earlier heads 10 main suites failed; the workers fixed them (see the review status table).

**One unrelated flake.** In one 462 only run at the earlier heads (two rehearsals were running at once), `provider_dispatch_preflight` #9 failed. That assertion checks that the response text contains no `7075`, and the response embeds random UUIDs and a hex fingerprint, so a random value can contain that substring. It is a test on `main`, not a 462 effect. The TAP is kept in `flake-evidence/provider_dispatch_preflight-assertion9.tap`; every later run on an idle host passed it. The test was not changed. Fix it on `main` separately.

## OVD-602 inventory

`docs/release/window-1/ovd602-pin.main.json` pins `main` at `5773decb`: 268 SECURITY DEFINER functions, all with a pinned `search_path`; 125 relations; 132 policies. Against the previous pin (`e254d032`) it adds exactly OVD-462's 6 functions and 2 tables with 0 flags, the same difference the lead measured on production at 21:30Z on Oct 12. 56 definer functions on `main` are executable by `anon` through PUBLIC (for example `api_create_project`, `api_admin_list_all_users`, `is_platform_admin`). They predate the window; the pin makes any change to that list an explicit diff, and the hosted baseline step in the README checks production matches.

Expected diffs (`ovd602-expected/`, relative to the post 462 pin unless noted):

* **723:** 12 new functions, 5 tables, 5 policies, 7 flags (`ovd-723.json`), including `api_request_export_marking_rescan(uuid)` for `authenticated`.
* **723, 722:** 20 new SECURITY DEFINER functions, all with `search_path` pinned. 10 are granted to `authenticated` on purpose (3 kill switch admin RPCs and 7 export control RPCs whose bodies check the caller). No existing function changes. There are 8 new tables, all with RLS enabled, and 5 new policies, including `job_files_storage_insert_export_cleared` on `storage.objects`. 10 flags, every one listed in `ovd-723+ovd-722.json`.
* **722 alone** (if 723 is skipped): 8 functions, 3 tables, 3 flags (`ovd-722.json`; byte identical to its pre 462 version, so 722's diff does not depend on 462).
* **462** (`ovd-462.json`, relative to the previous pin): the diff migration 1 was checked against on production; kept as a record.
* **Not covered by the inventory:** column grants, default ACLs, schema CREATE, sequences, owners and triggers.

## Reproduce

```
npm ci
node scripts/window-1/rehearse.mjs --order ovd-722 --out /tmp/r722   # 722 alone, about 2.5 minutes
node scripts/window-1/rehearse.mjs --out /tmp/rall                     # recommended order (723, 722), about 4 minutes
npx vitest run scripts/window-1/window1-packet.test.mjs # unit tests for the diff and runner helpers
```
Needs local PostgreSQL server binaries (`/usr/lib/postgresql/<n>/bin` or `OVD_PG_BIN`) and pgTAP. As root it runs the server as the `postgres` OS user.

## Backup and restore drill (Free plan, no PITR)

`bash scripts/window-1/restore-drill.sh` builds a stand in for production (shim, every main migration, synthetic rows) and dumps it the way the README does: application schemas, data with COPY, storage policies, and smoke counts, with no roles. It then runs `scripts/window-1/restore-check.mjs` against a second, empty, socket only cluster. Output: `restore-drill/output.txt` (7 PASS lines, `restore check PASS`).

Two problems surfaced on the first attempts. Both are now handled by the restore check and matter for any real restore:

* **Grants widen on restore.** The target's default privileges gave every restored table and function `anon` and `authenticated` access that production revoked (126 functions, 26 tables, 12 more functions newly exposed). The dump has no REVOKE for grants it never saw. The check clears the target's default privileges in `public` before loading.
* **Storage policies are lost.** The 14 `storage.objects` policies from our migrations are not in an application schema dump. `scripts/window-1/storage-policies.sql` exports them read only, and the check replays them.

The drill also showed that main's two NOLOGIN roles (`ovd575_observer_validator`, `ovd576_stop_validator`) must exist before the schema loads. The check creates them from the repo definitions, since the dump excludes roles.

Not proven here: the exact output of `supabase db dump` against the hosted project, which the drill imitates with `pg_dump`. Blaine's real run of the restore check is that proof, and it is a go/no go item.
