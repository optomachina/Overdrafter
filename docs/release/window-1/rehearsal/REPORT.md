# OVD-635 window 1 rehearsal report

Runner: `node scripts/window-1/rehearse.mjs` (manifest `docs/release/window-1/manifest.json`). Base `main` `efbe516f` (its `supabase/` tree is identical to `3e27c254`). Heads: #675 `a9923e6d`, #676 `f3ce78b3`, #677 `96d8b7ad`. Drafts read from git objects at the pinned PR SHAs; nothing is fetched during a run.

## Environment and isolation

* Disposable PostgreSQL 16.15 cluster created by `initdb` in a fresh temp directory, started with `listen_addresses=''`: it has a Unix socket and **no TCP listener**, and the runner refuses to continue if `show listen_addresses` is not empty. Every `psql` child gets a scrubbed environment (`PGHOST` is the socket directory; inherited `DATABASE_URL`, `PGHOSTADDR`, passwords and service files are dropped). The cluster and its directory are removed at the end (gate "cleanup removed the disposable cluster").
* No Docker daemon was available in this container, so the local Supabase stack was not used. `scripts/window-1/supabase-shim.sql` stands in for the platform: `anon`, `authenticated`, `service_role` (BYPASSRLS), `auth.users`, `auth.sessions`, `auth.uid()/role()/jwt()`, `storage.buckets/objects/foldername()`, `extensions` with pgcrypto, and Supabase's default privileges on `public`. Toolchain provisioning (pgTAP 1.3.2 from the Ubuntu archive, `npm ci`) happened before the runs; no rehearsal step touches a network host.
* Main migrations run one file per `psql --single-transaction`, except files with `CONCURRENTLY` or their own `BEGIN`/`COMMIT` (9 on main, plus the 722 draft), which run statement by statement. All 148 apply in about 2 s.
* Each pgTAP suite runs in its own `CREATE DATABASE ... TEMPLATE` clone, with pgTAP installed the way `supabase test db` does, and `ovd.test_conninfo` pointed at the socket for the dblink suites.

## Shim fidelity (main, before any draft)

63 of 70 main suites pass. The 7 that fail on the shim fail identically before and after every draft, so they are environment gaps, not window findings: `automatic_quote_rollout_concurrency`, `commercial_rollout_controls_concurrency`, `organization_entitlements_concurrency` ("requires a freshly reset disposable local database"), `stripe_event_sync_concurrency` (requires the database be named `postgres`), `capability_runtime_persistence_concurrency` (needs the OVD-591 CI fixture password), `capability_observation_ledger_concurrency` (2 lock wait timing assertions), `manual_quote_admin_inbox` #63 (a delete that the hosted non superuser `postgres` role cannot do; the shim runs as superuser). The regression gate compares each suite only with its own baseline result.

## Results

| Run | Order | Result | Time |
| --- | --- | --- | --- |
| `ovd-462-only/` | 462 | **PASS, every gate** | 114 s |
| `recommended/` | 462, 723 (PHASE 1), 722 | FAIL (see below) | 331 s |
| scratch run at the earlier heads, not kept | 462, 722, 723 | FAIL, same plus 2 composed 722 assertions | 295 s |

Per migration (recommended run; times are the first apply / reapply):

| | Apply | Own pgTAP after apply | Composed pgTAP | Rollback | Reapply |
| --- | --- | --- | --- | --- | --- |
| OVD-462 | ok, 25/24 ms | 122/122 | 122/122 | ok 21 ms, inventory back to the pin exactly | ok; inventory identical to first apply; 122/122 |
| OVD-723 PHASE 1 | ok, 35/28 ms | 58/64 | 58/64 (PHASE 2 applied in a clone: 64/64) | ok 17 ms with the packet rollback; only the 4 audit tables and their 4 read policies remain, as intended | ok; 58/64 |
| OVD-722 | ok, 23/27 ms | 53/53 | 53/53 | ok 14 ms with the packet rollback, which byte matches the draft's commented section | ok; 53/53 |

The 6 OVD-723 failures (#3, #4, #7, #17, #19, #25) are the upload and storage assertions that its header says need PHASE 2.

Main suites that pass on the baseline and fail after a draft (cumulative):

| After | Newly failing main suites |
| --- | --- |
| OVD-462 | none (every run on an idle host) |
| OVD-723 PHASE 1 | `free_confirmed_quote_access`, `provider_dispatch_preflight`, `provider_dispatch_preflight_concurrency`, `xometry_beta_dispatch_permits` |
| OVD-722 | adds `job_service_detail_privileges`, `provider_dispatch_admission_serialization`, `provider_dispatch_permits`, `xometry_beta_dispatch_admission_serialization` (at the earlier head, applied after 462 without 723, it also failed `provider_dispatch_preflight`) |

These confirm review findings R723-2 and R722-1. In the order 462, 722, 723 the composed 722 suite fails 2 assertions (#32, #40: `export_declaration_missing` instead of `provider_kill_switch_engaged`), which confirms RX-2; in the order 462, 723, 722 it passes.

**One unrelated flake.** In one 462 only run at the earlier heads (two rehearsals were running at once), `provider_dispatch_preflight` #9 failed. That assertion checks that the response text contains no `7075`, and the response embeds random UUIDs and a hex fingerprint, so a random value can contain that substring. It is a test on `main`, not a 462 effect. The TAP is kept in `flake-evidence/provider_dispatch_preflight-assertion9.tap` (earlier heads); every later run on an idle host passed it. The test was not changed. Fix it on `main` separately (match the fixture value with word boundaries).

## OVD-602 inventory

`docs/release/window-1/ovd602-pin.main.json` pins `main`: 262 SECURITY DEFINER functions, all with a pinned `search_path`; 123 relations; 132 policies. 56 definer functions on `main` are executable by `anon` through PUBLIC (for example `api_create_project`, `api_admin_list_all_users`, `is_platform_admin`). They predate the window; the pin now makes any change to that list an explicit diff, and the hosted baseline step in the README checks production matches.

Expected diffs (`ovd602-expected/`):

* **462 only:** 6 new SECURITY DEFINER functions, all `service_role` only, all `search_path=""`; 2 new tables with RLS enabled and forced, no policies, no grants. **0 flags.**
* **462, 723, 722:** 29 new SECURITY DEFINER functions, all with `search_path` pinned. Not all are `service_role` only: 3 kill switch admin RPCs and 6 export control RPCs are granted to `authenticated` on purpose (bodies check the caller), and 723's adds leave `service_role` EXECUTE as well (R723-6). 6 existing RPCs change `search_path` from `pg_catalog` or `public` to `""` (the cause of the test pin failures). 8 new private tables, all with RLS enabled (722's are forced since `f3ce78b3`). 19 flags in total, every one listed in the file.

## Reproduce

```
npm ci
node scripts/window-1/rehearse.mjs --order ovd-462      # GO path, about 2 minutes
node scripts/window-1/rehearse.mjs                      # recommended order, about 6 minutes
npx vitest run scripts/window-1/window1-packet.test.mjs # unit tests for the diff and runner helpers
```
Needs local PostgreSQL server binaries (`/usr/lib/postgresql/<n>/bin` or `OVD_PG_BIN`) and pgTAP. As root it runs the server as the `postgres` OS user.
