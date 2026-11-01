# Migration window 2: Jarvis chain run sheet

The lead runs this sheet, with Blaine's yes for each protected step. Nothing in it has been applied to any hosted database. Project ref `ozuatdcakezjtevztjlr`.

This page is the one authoritative apply order and reverse order for the window 2 Jarvis chain. `manifest.json` pins every file by sha256 in the same order. Other documents point here and do not restate the order.

## What is in this packet

| Item | Where |
| --- | --- |
| Pins: base, every staged file sha256, the OVD-558 catalog pins, the slots | `manifest.json` |
| Expected OVD-602 inventory diff per step and for the whole window | `ovd602-expected/` |
| Rehearsal evidence (fixture run, proofs, timings, gates) | `rehearsal/` |
| Read only go or no go digest query | `ovd558-catalog-digest.sql` |
| Proof that the merged OVD-558 pins refused a production equal baseline | `evidence/pin-refusal/` |
| Rehearsal runner (staged SQL proof CI job) | `scripts/ovd510-window2-chain.mjs`, called by `scripts/ovd510-disposable-replay.mjs ... --ovd563` |
| Window order proof with #702's real pins | `scripts/ovd510-ovd649-window-order.mjs` |
| Portable checks (pins, generators, order, drift) | `scripts/window2-packet.node-test.mjs` |
| OVD-602 inventory, diff, dump and restore tools | `scripts/window-1/` (byte identical to #687) |

Base: `main` at `26b0b76e` with 148 migrations, equal to the production ledger (148 versions). OVD-575 (`20260927130000`) and OVD-576 (`20260927140000`, `20260927225843`) are in it.

## Decisions before the window

1. **OVD-558 runs as `postgres` (decided: option A).** Every step of the chain runs as `postgres`, the role `DB_URL` connects as on hosted Supabase; no superuser is needed. Storage functions belong to `supabase_storage_admin`, which `postgres` cannot act as, so OVD-558 leaves their ACLs exactly as Supabase ships them. Its postflight proves, live: outside `storage` the verifier can call exactly the 7 application functions; inside `storage` it can call exactly the functions `anon` can call, and that set equals the 20 names pinned in `manifest.json`; it holds no privilege on any `storage` table that `anon` lacks. So `storage.delete_leaf_prefixes` and the other Storage definer functions stay callable by the verifier exactly as by an unauthenticated visitor, and by nothing more. Option C (the verifier never gets `storage` USAGE; the worker mints signed URLs, or `service_role` fetches bytes after a definer check) is a 1.1 follow up the lead is filing.
   * **When a Supabase upgrade trips the pin** (`ovd558_storage_anon_functions_changed`, or a changed catalog digest), nothing was changed: the forward or reverse refused before any write. Rerun the postflight query on a disposable fixture with the new Storage version, review each new or changed Storage function (definer or not, what it touches), and repin through the generator in a reviewed PR. Never edit the pins in the window.
2. **Production catalog equality.** The OVD-558 forward hashes the whole catalog, including the server version, every role and every platform function. Its pin comes from the disposable Supabase image (`postgres:17.6.1.095`) with main's 148 migrations. Production must hash to the same value or the forward refuses (safely, before any change). The digest is taken with `search_path = pg_catalog`, so it is the same for any role. Check it read only before the window (go or no go item 4). If it differs, the Jarvis chain does not run in this window; regenerating the reviewed baseline from a production catalog snapshot is a separate, reviewed change.
3. **Order against the other window 2 items.** The Jarvis section runs first. Any migration applied before the OVD-558 forward changes the catalog it pins, and the forward refuses. Any migration applied after it changes the catalog the OVD-558 reverse pins, and the reverse refuses until that migration is rolled back. The slots below therefore run after the Jarvis section, and rolling back OVD-558 later means rolling back every later migration first. After the next ordinary migration lands, the OVD-558 reverse refuses permanently by design.
4. **The new reviewed caller baseline** (OVD-558 manifest at 148 migrations) gets an independent review before the window. See the PR for the table of new rules.

## Slots (not built in this packet)

| Slot | Item | Status |
| --- | --- | --- |
| W2-S1 | OVD-723 contract (server side ITAR/EAR block) | not built here; runs after the Jarvis section |
| W2-S2 | OVD-725 Stripe catalog (`docs/migration-drafts/ovd-725-stripe-catalog.sql`) | not built here; runs after the Jarvis section. Source already calls its two RPCs (`api_configure_stripe_catalog_price`, `api_disable_stripe_catalog_price`) |
| W2-S3 | OVD-746 client write auth gate | not built here; runs after the Jarvis section |

## What you need

* A checkout of `main` with this packet merged, Node 22, `psql` 17 or newer, the Supabase CLI and Docker for the local restore check.
* `DB_URL` from Blaine: Dashboard, **Connect > Session pooler**. In your shell only: `export DB_URL='postgresql://...'`. Never paste it anywhere else, never commit it. The dump needs it.

## Go or no go (read only, the day before and again at the start)

1. **Packet head.** Hosted CI is green on the packet head, including `Disposable staged SQL proof`. Locally:
   ```
   node scripts/ovd510-generate-migration-sql.mjs be97ed54f5f3f97d4c25f1709a6ed415c6edc912a0237c36471c45e327d981a8 --check
   node scripts/native/stop-observer/sql/generate-restore-sql.mjs --check
   node --test scripts/window2-packet.node-test.mjs
   ```
   Expected: both generators print their JSON line and exit 0; the test prints `# fail 0`.
2. **Ledger.** `psql "$DB_URL" -X -At -c "select count(*), max(version) from supabase_migrations.schema_migrations"` prints `148|` and the newest version in `supabase/migrations` on `main`.
3. **OVD-602 inventory**, the window 1 style check:
   ```
   psql "$DB_URL" -X -A -t -q -f scripts/window-1/ovd602-inventory.sql > /tmp/w2-before.json
   node scripts/window-1/ovd602-diff.mjs docs/release/window-1/ovd602-pin.main.json /tmp/w2-before.json
   ```
   Expected: `ovd602: no difference from the pin`. The rehearsal baseline equals this pin exactly (`rehearsal/window2-ovd602-baseline-vs-window1-pin.json`).
4. **OVD-558 catalog digest**, as `postgres` (read only, through the connector):
   ```
   psql "$DB_URL" -X -At -f docs/release/window-2/ovd558-catalog-digest.sql
   ```
   Expected: `e1947671b453122789c6ba947bac2a279973a8a429815a8a18f16f8c941e9d0b`. The query fixes `search_path = pg_catalog`, so every role prints the same value; on the rehearsal baseline this exact file printed it as both `postgres` and `supabase_admin` (`rehearsal/window2-read-only-digest.json`). Any other value is a no go for the Jarvis section.
5. **Dump and restore check**, as in window 1 (on your machine only, outside the repo; it holds customer data):
   Optional helper: `node scripts/prod-backup.mjs --out ~/w2-backup-$(date +%Y%m%d-%H%M) --url-env DB_URL --dry-run`, then the same without `--dry-run`. It reads the connection string from the variable named by `--url-env` (default `OVD_BACKUP_DB_URL`, for example the session pooler URL), runs the same four commands as below without the password in any argument (the CLI gets it as `PGPASSWORD`), and checks file integrity only (non-empty files, schema, row counts of the tables in `smoke-counts.sql` against the live counts, SHA256SUMS). Its `verify PASS` does not prove the dump restores: the `restore-check.mjs` run below stays mandatory either way. Run it inside the quiet window (items 6 and 7), because the live counts are read after the data dump. The manual commands below remain the reference.
   ```
   mkdir -p ~/w2-backup && chmod 700 ~/w2-backup
   supabase db dump --db-url "$DB_URL" -f ~/w2-backup/schema.sql
   supabase db dump --db-url "$DB_URL" --data-only --use-copy -f ~/w2-backup/data.sql
   psql "$DB_URL" -X -A -t -q -f scripts/window-1/smoke-counts.sql > ~/w2-backup/counts.prod.json
   psql "$DB_URL" -X -A -t -q -f scripts/window-1/storage-policies.sql > ~/w2-backup/storage-policies.sql
   mkdir -p ~/w2-restore && cd ~/w2-restore && supabase init && supabase start
   cd <repo> && node scripts/window-1/restore-check.mjs --target postgresql://postgres:postgres@127.0.0.1:54322/postgres --dump ~/w2-backup
   (cd ~/w2-restore && supabase stop --no-backup)
   ```
   Expected: `restore check PASS`. The drill passed on PostgreSQL 17 with this packet (`rehearsal/restore-drill.txt`). Storage file bytes are not in a database dump.
6. **Worker stopped.** `ENGINEERING_WORKER_GATEWAY_ENABLED`, `ENGINEERING_WORKER_TASK_ENABLED` and `ENGINEERING_WORKER_STOP_ENABLED` are off, and no native worker or companion is connected. No Jarvis traffic runs during the window.
7. **Schedule.** The window is at a low traffic time (see the Storage note below).

All seven must hold. Write down `select now();`.

## Storage stalls during reverses

The OVD-558 and OVD-560 reverses hold ACCESS EXCLUSIVE on `storage.objects`; the OVD-560 reverse also on `public.engineering_execution_attempts` and `public.engineering_snapshots`, and the private artifact reverse on `storage.objects`, `storage.buckets`, `public.engineering_execution_attempts` and `engineering_private.native_input_admissions`. While one runs, every Storage request (uploads, downloads, signed URLs) and every read of those tables waits, for at most the lock wait (`lock_timeout`, 5 s or 10 s per file) plus the statement time (`statement_timeout`, 30 s; 180 s for OVD-558). Rehearsed, each reverse took under 0.6 s. Forwards take the same relation locks for the same short time. So: stop the worker first (item 6), keep every file's own `lock_timeout` (never raise it), and run inside the scheduled window.

## Rules for every step

* Run each file as written, alone, with `psql "$DB_URL" -X -v ON_ERROR_STOP=1 -f <file>`. Each file is one transaction: it refuses anything but READ COMMITTED (SQLSTATE 0A000), then takes `pg_advisory_xact_lock(510, 2)` before any relation, so no two window 2 scripts interleave. Never add `--single-transaction` and never change the session isolation level.
* These are staged files, not ledger migrations: never `supabase db push` them and never run `supabase migration repair` in the window.
* Before each step: `psql "$DB_URL" -X -A -t -q -f scripts/window-1/ovd602-inventory.sql > /tmp/w2-before-<N>.json`. After it: the same into `/tmp/w2-after-<N>.json`, then `node scripts/window-1/ovd602-diff.mjs /tmp/w2-before-<N>.json /tmp/w2-after-<N>.json --expect docs/release/window-2/ovd602-expected/step-<N>-<id>.json`.
* **Pass:** the file prints `COMMIT` with no `ERROR`, and the diff prints `ovd602: difference matches ... exactly`. Then the next step.
* **Fail:** any `ERROR`, or any other diff output. A failed file changed nothing (one transaction). Stop. If a later step failed, reverse the steps already applied, strictly in the reverse order below, starting from the last one applied. Send the output.
* Never edit a pin, a preflight or a file in the window.

## Apply order (forward)

<!-- forward-order -->
| Step | File | Role | Rehearsed | Expected 602 diff |
| --- | --- | --- | --- | --- |
| 1 | `docs/release/ovd-558-verifier-authority-forward.sql` | `postgres` | 632 ms | `step-1-ovd-558.json`: 4 functions, 1 table, 2 Storage policies added; 73 existing functions lose only the PUBLIC grant (anon, authenticated and service_role keep explicit grants; no caller gains or loses access); 112 flags, all on those unchanged definer functions |
| 2 | `docs/release/ovd-560-result-registry-forward.sql` | `postgres` | 126 ms | `step-2-ovd-560.json`: 0 flags |
| 3 | `docs/release/ovd-561-finalization-forward.sql` | `postgres` | 119 ms | `step-3-ovd-561-finalization.json`: 0 flags |
| 4 | `docs/release/ovd561-pending-forward.sql` | `postgres` | 123 ms | `step-4-ovd-561-pending.json`: 0 flags |
| 5 | `docs/release/native-result-reader-forward.sql` | `postgres` | 120 ms | `step-5-native-result-reader.json`: 0 flags |
| 6 | `docs/release/private-artifact-forward.sql` | `postgres` | 111 ms | `step-6-private-artifact.json`: 0 flags |
| 7 | `docs/release/native-artifact-mapping-forward.sql` | `postgres` | 110 ms | `step-7-native-artifact-mapping.json`: 0 flags |
| 8 | `docs/release/ovd-563-step-review-forward.sql` | `postgres` | 103 ms | `step-8-ovd-563.json`: 1 flag, `api_read_native_step_review` executable by `authenticated` (intended) |
| 9 | `scripts/native/stop-observer/sql/store-native-observer-evidence-replay.staged.sql` | `postgres` | 110 ms | `step-9-ovd-649-observer-replay.json`: no inventory change (body only) |
<!-- end -->

After step 9 the whole window diff against the window 1 pin equals `ovd602-expected/window-2.json` (113 flags: the 112 of step 1 and the one of step 8).

Why this order: OVD-558 is first because its forward pins the exact prechange catalog. The OVD-649 observer replacement is last so that its restoration can run first: with the replacement live, the OVD-558 forward refuses and the OVD-558 reverse refuses (both proven with #702's real pins). #619's pending and reader forwards sit between OVD-561 and OVD-563, as #619 documents. The private artifact tables need OVD-560, and the mapping functions need the private artifact tables and OVD-561.

## Reverse order

Exactly the reverse of the steps applied, starting from the last one applied. Every reverse refuses (and changes nothing) if its history is not empty: never delete history to make a reverse pass.

<!-- reverse-order -->
| Step | File | Role | Rehearsed | Refuses when |
| --- | --- | --- | --- | --- |
| 9 | `scripts/native/stop-observer/sql/store-native-observer-evidence-restore.staged.sql` | `postgres` | 117 ms | the live body is not exactly the staged replacement |
| 8 | `docs/release/ovd-563-step-review-reverse.sql` | `postgres` | 97 ms | any step review exists |
| 7 | `docs/release/native-artifact-mapping-reverse.sql` | `postgres` | 90 ms | a mapping function is missing |
| 6 | `docs/release/private-artifact-reverse.sql` | `postgres` | 104 ms | any artifact mapping exists |
| 5 | `docs/release/native-result-reader-reverse.sql` | `postgres` | 94 ms | any read binding exists |
| 4 | `docs/release/ovd561-pending-reverse.sql` | `postgres` | 85 ms | any pending finalization exists |
| 3 | `docs/release/ovd-561-finalization-reverse.sql` | `postgres` | 91 ms | any finalization exists, or the pending table still exists (its envelopes are signed with the key this drops) |
| 2 | `docs/release/ovd-560-result-registry-reverse.sql` | `postgres` | 117 ms | any registration exists |
| 1 | `docs/release/ovd-558-verifier-authority-reverse.sql` | `postgres` | 585 ms | the registry is not empty, or the catalog is not exactly the post OVD-558 catalog |
<!-- end -->

After each reverse the 602 inventory must equal `/tmp/w2-before-<N>.json` of that step: `node scripts/window-1/ovd602-diff.mjs /tmp/w2-before-<N>.json <now.json>` prints `ovd602: no difference from the pin`.

A live registration that slipped past "worker stopped" cannot lose data: rehearsed, a registration holding its attempt makes the OVD-560 reverse wait and then refuse with the row kept, or time out after 5 s (55P03) and change nothing; the old lock orders reproduce a deadlock in the same harness (`rehearsal/ovd651-isolation-race-proof.json`, and `...pre-fix-26b0b76.json` for the unfixed source).

## Rehearsal

Disposable only: one exclusively owned Docker fixture (`public.ecr.aws/supabase/postgres:17.6.1.095`, PostgreSQL 17.6, with the pinned Storage and Auth images), synthetic rows, a fixture generated credential, an internal network with no egress. Command:

```
node scripts/ovd510-disposable-replay.mjs --reviewed-authority-baseline --durable-migration --ovd563 [--window2-main-suites]
```

Every OVD-558 and window 2 step runs as `postgres`, as on the hosted project. On main's 148 migrations it runs, in order: the reviewed OVD-558 checks (grant plan probe, drift and injected failure refusals, forward, authority assertions, reverse lock proof, reverse, reapply), OVD-560 (11/11), OVD-561 (24/24) with its 12 races, OVD-563 (25/25), OVD-520 (24/24), and then the window 2 stage (`window2-chain.json`, 55 gates):

* the read only digest file, run as `postgres` and as `supabase_admin` on the pristine baseline, prints the same pin for both;
* the baseline OVD-602 inventory equals the window 1 pin exactly;
* the observer replacement refuses REPEATABLE READ with 0A000, waits on a held (510, 2) lock, and with it live the verbatim OVD-558 forward refuses (`ovd558_prechange_catalog_mismatch`); the restoration refuses REPEATABLE READ with 0A000, returns the exact baseline, and a second run refuses;
* all 9 forwards in the order above, each 602 diff equal to `ovd602-expected/`; right after OVD-558, with the replacement live the verbatim OVD-558 reverse refuses (`ovd558_unknown_postchange_catalog`), and after the restoration it runs and the forward reapplies to the same catalog;
* on the full chain: OVD-560 11/11, OVD-561 24/24, OVD-563 25/25, the 5 compatibility pgTAP suites, and with `--window2-main-suites` every main pgTAP suite in its own clone: 48 of 71 pass at baseline and the same 48 pass on the full chain (no regression; the 23 others fail identically at baseline on this fixture, from pgTAP search path and `public` schema privileges of the harness);
* out of order reverses refuse and change nothing: OVD-561 while the pending table exists, OVD-558 while later steps are applied;
* all 9 reverses in reverse order, each back to the exact catalog and 602 inventory from before its forward, ending at the baseline catalog and the window 1 pin exactly; then all 9 forwards again, to the same full chain catalog, and OVD-563 25/25 again.

Timings above are from the run in `rehearsal/` (whole fixture about 4 minutes with all main suites, about 2 minutes without). The OVD-558 direct behavior checks now call one existing and one future Storage function as the verifier and assert `anon` can call them too; the 6 other direct calls stay denied. Separately: the OVD-651 isolation race proof (16/16, PostgreSQL 17.11), the OVD-575 registry test with the staged replacement (94 assertions), and the restore drill.

The shim based window 1 rehearsal is not reused here: OVD-558 pins the catalog of the Supabase image, so the rehearsal must run on that image.
