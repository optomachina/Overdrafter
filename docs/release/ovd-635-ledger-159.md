# OVD-635: frozen 159-migration production baseline and next-window suffix

Status: preparation only. Nothing here contacted a hosted database. The production apply stays Blaine's window.

This replaces the 152-row baseline from #752. The production ledger read on 2026-10-18 (read-only SELECT authorized by Blaine) had 159 rows. #776 (merged as 2a64791) recorded the Oct 15 window in `supabase/migrations` at the production versions, so the first 159 repository migrations now equal that ledger:

- 152 rows through `20261014191541` (OVD-414), unchanged from the 152 manifest;
- OVD-736 at its production version `20261016013742` (bytes identical to the old `20261015074957` file);
- the six Oct 15 window versions `20261015214135` (ovd768), `20261015221725` (ovd771), `20261016000156` (ovd767), `20261016002932` (ovd769), `20261016004826` (ovd770) and `20261016013832` (ovd766e).

## Files

- `ovd-635-ledger-159-manifest.json`: the 159 migrations in order, with version, filename and SHA-256, from source commit `826d17d2`. `versionListMd5` is the md5 of the newline-joined version list.
- `ovd-635-ledger-159-pre-check.sql`: read-only (`begin read only` ... `rollback`) and reads only `supabase_migrations.schema_migrations`. It returns count, head, version-list md5, statement fingerprint, and the versions missing or extra against the manifest.
- `ovd-635-next-window-suffix-manifest.json`: the next-window suffix, in order, with bytes, SHA-256, rollback file and rollback SHA-256, plus the expected ledger state after each prefix.
- `ovd-635-next-window-authorization.template.json`: the authorization template for Blaine's window. It is a template, not an authorization: Blaine fills `deployCommit` and the recorded fingerprint, signs it, and supplies its SHA-256 out of band.
- `scripts/verify-ovd635-ledger-manifest.mjs`, run by `scripts/verify-ovd635-ledger-manifest.test.mjs` in the default vitest suite. It fails when a frozen or suffix migration changes, when a migration is inserted inside the baseline or between the baseline and the suffix, when a suffix rollback changes, when a ledger state drifts, or when the pre-check version list drifts. Later migrations may follow the suffix.

## Owner step: read-only pre-check

```sh
psql "$PROD_DB_URL" -X -f docs/release/ovd-635-ledger-159-pre-check.sql
```

Use psql. The dashboard SQL editor shows only the last statement's result, which here is the empty `rollback`. Expected row:

```
count 159 | head 20261016013832 | version_list_md5 cf7baa5a7c40039afd8fde92a3ad39c6 | missing {} | extra {}
```

Record `statement_fingerprint` without asserting it: rows applied through the SQL editor can store different `statements` than a CLI apply. The local CLI value is `401483ce714ac69e066b2e3687090666`.

Main gained three migrations after the 2026-10-18 reading (the suffix below). The production ledger was not read again, so this baseline does not know whether any of them reached production. If `extra` lists exactly the first one, two or three suffix versions in order, that part of the suffix is already applied; compare count, head and md5 with the `states` in the suffix manifest and apply only the rest. Any other `missing` or `extra` value means production and the repository have diverged: stop before the window.

## Next-window suffix

Main at `826d17d2` carries three migrations that the 159 baseline does not have:

| # | Version | File | SHA-256 | Rollback |
|---|---|---|---|---|
| 1 | `20261025194414` | `ovd1097_refresh_job_extraction_status.sql` (OVD-1097) | `68bff741…8895ef` | `docs/migration-drafts/ovd-1097.rollback.sql` |
| 2 | `20261029165751` | `reconcile_claim_fence.sql` (OVD-1073 S1.1b stage A) | `67343518…8cb7ac` | `supabase/rollbacks/20261029165751_reconcile_claim_fence.rollback.sql` |
| 3 | `20261030204050` | `ovd1018_restrict_project_jobs_writes.sql` (OVD-1018) | `18bea12e…54e4f6` | `docs/migration-drafts/ovd-1018.rollback.sql` |

Expected ledger after each prefix: 160 / `20261025194414` / `c0a6fe5a09abdfb1325669ad41e826b1`, 161 / `20261029165751` / `60d3fdc3744e859521ba64ce62bcf980`, 162 / `20261030204050` / `389d5a142bc581131035eec1754b5a2e`. Suffix manifest SHA-256: `84828ebe520be99e3d71121b7e5a1dcbc6e035acc8a2547ee75ad4ed8e91bcd0`.

The window Blaine named on 2026-10-20 was OVD-979 (#874) and OVD-987 P3 (#886), with OVD-978 (#873) later. Those PRs are still unmerged drafts, and their versions (`20261020002126`, `20261020002127`, `20261020100000`) now sort before main's head. Before they can join a window they must be renamed after `20261030204050`, as #874's migration notes already require, and this suffix manifest regenerated with them appended. Until then this manifest covers only what main actually holds.

## Disposable rehearsal (local, 2026-10-31)

Setup: Supabase CLI 2.78.1 (the CI version) and `public.ecr.aws/supabase/postgres` on a local Docker stack owned by this task. A scratch copy of `supabase/` from `826d17d2` with only the first 159 migrations was started with `supabase db start`; the suffix files were held back. Realtime was disabled in the scratch `config.toml` because its container cannot bind IPv6 in this sandbox; no migration or test touches realtime.

1. Baseline: the pre-check returned `159 | 20261016013832 | cf7baa5a7c40039afd8fde92a3ad39c6 | 401483ce714ac69e066b2e3687090666 | {} | {}`.
2. Apply: the three suffix files were copied in and applied in order with `supabase migration up --local`. The pre-check returned `162 | 20261030204050 | 389d5a142bc581131035eec1754b5a2e | e26967538c2ff3790433762e4fe47a39 | {} | {20261025194414,20261029165751,20261030204050}`, matching the `final` state.
3. Rollback drill: the three rollbacks newest first with `psql -X -v ON_ERROR_STOP=1 --single-transaction`, then `supabase migration repair --local --status reverted` for the three versions. The ledger returned to the baseline exactly, statement fingerprint included (`401483ce…`). A schema-only `pg_dump` against the baseline differs only by `private.vendor_quote_acceptance_receipts` and `private.quote_run_rollup_followups` (tables, identity, constraints, index, RLS), which the claim-fence rollback retains by design. A second OVD-1018 rollback pass also succeeds (it is replayable; the other two intentionally error when their objects are absent).
4. Reapply: `supabase migration up --local` again. The schema dump is identical to the first apply, and the ledger fingerprint is again `e26967538c2ff3790433762e4fe47a39`.
5. Tests on the reapplied database, in CI order: `scripts/test-reconcile-claim-fence.mjs --ci-local` PASS (73 assertions, dependency check 118 columns and 30 types); then the policy suite staged by `stagePolicyTests` and run with `supabase test db --local --debug`: 86 of 86 files, 3,804 assertions, `Result: PASS`, 0 `not ok`, 0 SKIP or TODO. The first apply, before the drill, gave the same 86 / 3,804 PASS.

The policy suite is not re-runnable against one database: committing concurrency suites leave rows behind, and a second run fails `capability_observation_ledger.sql`, `free_confirmed_quote_access.sql` and `xometry_beta_dispatch_permits_concurrency.sql`. This happens with or without the drill, so every result above comes from a single run on its database. CI runs the suite once per reset.

CLI transaction behavior (2.78.1), checked in a throwaway local database: each migration file runs as one implicit transaction. A file whose last statement fails leaves no objects and no ledger row. The `WARNING (25P01): SET LOCAL can only be used in transaction blocks` printed for migrations 2 and 3 is cosmetic: the next statement in the same file saw the `SET LOCAL` value, so their `lock_timeout` guards apply.

Like the 152 rehearsal, this starts from an empty database replaying repository files. It does not restore production history or its SQL-editor rows, so it does not prove historical equivalence.

## Staging reconciliation (coordinator, staging only)

Agents do not contact staging. The coordinator applies these steps after `node scripts/staging-reset-guard.mjs ldmambwtksfvqdufhaam`, and each staging apply needs rollback-drill evidence (OVD-839 table: apply, roll back, reapply, smoke).

Staging on 2026-10-20 had 156 rows, head `20261020100000`: the 152 baseline, OVD-736 at the old repo version `20261015074957`, OVD-979 (`20261020002126`, `20261020002127`) and OVD-987 P3 (`20261020100000`). It lacks the six window versions. Target: staging equals production plus the pending suffix.

1. Rename OVD-736 to its production version (bytes confirmed identical), exactly as `docs/runbooks/staging.md` records from #776:

   ```sh
   supabase migration repair --db-url "$STAGING_DB_URL" --status reverted --yes 20261015074957
   supabase migration repair --db-url "$STAGING_DB_URL" --status applied --yes 20261016013742
   ```

2. Apply the six window migrations in version order, one transaction each, with a history row, as earlier staging applies did (`execute_sql` plus history row, or `psql -X -v ON_ERROR_STOP=1 --single-transaction -f <file>` then `supabase migration repair --status applied <version>`). Do not use `supabase migration up --include-all`; these versions sort before the staging head. Rollback drill files: ovd768 `docs/migration-drafts/ovd-766-b.rollback.sql`, ovd771 `ovd-771.rollback.sql`, ovd767 `ovd-766-a.rollback.sql`, ovd769 `ovd-766-c.rollback.sql`, ovd770 `ovd-766-d.rollback.sql`, ovd766e `ovd-766-e.rollback.sql`. Roll back newest first, then reapply.
3. Run the 159 pre-check against staging. Expected: `missing {}` and `extra {20261020002126,20261020002127,20261020100000}`, count 162. Those three rows are drafts that are not on main.
4. Apply the next-window suffix to staging with the same drill, then rerun the pre-check: count 165, `extra` = the three suffix versions plus the three draft rows.
5. When #874 and #886 are renamed after `20261030204050`, repair the three draft rows to their new versions with exact-version `migration repair` (old version `reverted`, new version `applied`, bytes confirmed identical), never a broad repair.

## Still open for OVD-635

- Blaine's read-only pre-check against production, and the staging reconciliation evidence above.
- Blaine's review of the authorization template.
- OVD-658, OVD-659 and OVD-660 (R1/R2 runner, cached platform extraction, CLI session capture) targeted the superseded #564 candidate; PRs #627, #628 and #629 closed unmerged. The CLI transaction behavior they were to capture is recorded above; the rest is proposed for 1.1.
