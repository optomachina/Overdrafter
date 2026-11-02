# OVD-635: frozen 161-migration production baseline and next-window suffix

Status: preparation only. Nothing here contacted a hosted database. The production apply stays Blaine's window.

This replaces the 152-row baseline from #752 and the 159-row baseline this PR first froze. Two production readings define it:

- 2026-10-18 (read-only SELECT authorized by Blaine): 159 rows, head `20261016013832`. #776 (merged as 2a64791) recorded the Oct 15 window in `supabase/migrations` at the production versions, so the first 159 repository migrations equal that ledger: 152 rows through `20261014191541` (OVD-414); OVD-736 at its production version `20261016013742` (bytes identical to the old `20261015074957` file); and the six Oct 15 window versions `20261015214135` (ovd768), `20261015221725` (ovd771), `20261016000156` (ovd767), `20261016002932` (ovd769), `20261016004826` (ovd770) and `20261016013832` (ovd766e).
- 2026-10-31T19:14Z (Release, read-only, [#1002 comment](https://github.com/optomachina/Overdrafter/pull/1002#issuecomment-6547950256)): the 159 pre-check returned count 161, head `20261029165751`, version-list md5 `60d3fdc3744e859521ba64ce62bcf980`, `missing {}`, `extra {20261025194414,20261029165751}`, statement fingerprint `e96ac4929ea7aa5b853479f2f82ebe64` (recorded only). Those two extra rows are OVD-1097 and the OVD-1073 claim fence, the first two migrations of the earlier three-migration suffix, in order. `20261030204050` (OVD-1018) is not applied.

The first 161 repository migrations therefore equal the production ledger, and the next-window suffix is OVD-1018 alone.

## Files

- `ovd-635-ledger-161-manifest.json`: the 161 migrations in order, with version, filename and SHA-256, from source commit `826d17d2`. `versionListMd5` is the md5 of the newline-joined version list.
- `ovd-635-ledger-161-pre-check.sql`: read-only (`begin read only` ... `rollback`) and reads only `supabase_migrations.schema_migrations`. It returns count, head, version-list md5, statement fingerprint, and the versions missing or extra against the manifest.
- `ovd-635-next-window-suffix-manifest.json`: the next-window suffix, in order, with bytes, SHA-256, rollback file and rollback SHA-256, plus the expected ledger state after each prefix.
- `ovd-635-next-window-authorization.template.json`: the authorization template for Blaine's window. It is a template, not an authorization: Blaine fills `deployCommit` and the recorded fingerprint, signs it, and supplies its SHA-256 out of band.
- `scripts/verify-ovd635-ledger-manifest.mjs`, run by `scripts/verify-ovd635-ledger-manifest.test.mjs` in the default vitest suite. It fails when a frozen or suffix migration changes, when a migration is inserted inside the baseline or between the baseline and the suffix, when a suffix rollback changes, when a ledger state drifts, when the pre-check version list drifts, or when the authorization template's suffix pins drift. Later migrations may follow the suffix. With `--exact` it also fails unless `supabase/migrations` holds exactly the baseline plus the suffix: run it at `deployCommit` before the window, because `supabase migration up` applies every pending file in that commit.

## Owner step: read-only pre-check

```sh
psql "$PROD_DB_URL" -X -f docs/release/ovd-635-ledger-161-pre-check.sql
```

Use psql. The dashboard SQL editor shows only the last statement's result, which here is the empty `rollback`. (If the statements are run one at a time, as Release did through `execute_sql`, run only the `with ... select` body.) Expected row:

```
count 161 | head 20261029165751 | version_list_md5 60d3fdc3744e859521ba64ce62bcf980 | missing {} | extra {}
```

Record `statement_fingerprint` without asserting it: rows applied through the SQL editor can store different `statements` than a CLI apply. Production read `e96ac4929ea7aa5b853479f2f82ebe64` on 2026-10-31; the local CLI value is in the rehearsal below.

If `extra` is exactly `{20261030204050}`, the suffix is already applied: compare count, head and md5 with the `after-1` state and skip the apply. Any other `missing` or `extra` value means production and the repository have diverged: stop before the window.

## Next-window suffix

| # | Version | File | SHA-256 | Rollback |
|---|---|---|---|---|
| 1 | `20261030204050` | `ovd1018_restrict_project_jobs_writes.sql` (OVD-1018) | `18bea12e…54e4f6` | `docs/migration-drafts/ovd-1018.rollback.sql` |

Expected ledger after it: 162 / `20261030204050` / `389d5a142bc581131035eec1754b5a2e`. Suffix manifest SHA-256: `4e6cc39a88505e1457723b175720f9bf9c2ddf2c3a3bba3052efe0877b245e3e`.

The window Blaine named on 2026-10-20 was OVD-979 (#874) and OVD-987 P3 (#886), with OVD-978 (#873) later. Those PRs are still unmerged drafts, and their versions (`20261020002126`, `20261020002127`, `20261020100000`) now sort before main's head. Before they can join a window they must be renamed after `20261030204050`, as #874's migration notes already require, and this suffix manifest regenerated with them appended. Until then this manifest covers only what main actually holds.

## Disposable rehearsal (local, 2026-10-31, from the 161 baseline)

Setup: Supabase CLI 2.78.1 (the CI version) and `supabase/postgres:17.6.1.095` on a local Docker stack owned by this task. The registry mirror refused pulls in this sandbox, so the same image tags were pulled from Docker Hub and retagged to the `public.ecr.aws` names. A scratch copy of `supabase/` from this branch with only the first 161 migrations was started with `supabase db start`; the suffix file was held back. Realtime was disabled in the scratch `config.toml` because its container cannot bind IPv6 in this sandbox; no migration or test touches realtime.

Pre-check rows below are `count | head | version_list_md5 | statement_fingerprint | missing | extra`.

1. Baseline: `161 | 20261029165751 | 60d3fdc3744e859521ba64ce62bcf980 | 1e7ec867142713c1559584b22deda3af | {} | {}`. Count, head and md5 equal Release's production reading. The local fingerprint differs from production's `e96ac492…`; rows applied through the SQL editor can store different statements than a CLI apply, so it is recorded, not asserted.
2. Apply: the suffix file was copied in and applied with `supabase migration up --local`. Pre-check: `162 | 20261030204050 | 389d5a142bc581131035eec1754b5a2e | e26967538c2ff3790433762e4fe47a39 | {} | {20261030204050}`, matching the `after-1` state. The fingerprint equals the 159-baseline rehearsal's final fingerprint, as expected for the same 162 files.
3. Rollback drill: `docs/migration-drafts/ovd-1018.rollback.sql` with `psql -X -v ON_ERROR_STOP=1 --single-transaction`, then `supabase migration repair --local --status reverted 20261030204050`. The pre-check returned exactly the baseline row, fingerprint included. A schema-only `pg_dump` (excluding `supabase_migrations`) after the rollback is identical to a dump of a fresh `supabase db reset` to the 161 baseline.
4. Reapply: `supabase migration up --local` again returned the `after-1` row and fingerprint, and the schema dump is identical to the first apply.
5. Tests on the applied database: the policy suite staged by `stagePolicyTests` and run with `supabase test db --local --debug`: 86 of 86 files, 3,804 assertions, `Result: PASS`, 0 `not ok`, 0 SKIP or TODO. That includes `project_jobs_write_path.sql`, the OVD-1018 regression.

The 159-baseline rehearsal on 2026-10-31 already applied, rolled back and reapplied OVD-1097 and the claim fence, which production now holds, with `scripts/test-reconcile-claim-fence.mjs --ci-local` PASS (73 assertions) and the same 86 / 3,804 policy PASS.

CLI transaction behavior (2.78.1), checked in a throwaway local database: each migration file runs as one implicit transaction. A file whose last statement fails leaves no objects and no ledger row. The `WARNING (25P01): SET LOCAL can only be used in transaction blocks` printed for the suffix is cosmetic: the next statement in the same file saw the `SET LOCAL` value, so its `lock_timeout` guard applies.

The policy suite is not re-runnable against one database (committing concurrency suites leave rows behind), so each result above comes from a single run on its database. Like the earlier rehearsals, this starts from an empty database replaying repository files. It does not restore production history or its SQL-editor rows, so it does not prove historical equivalence.

## Staging reconciliation (coordinator, staging only)

Agents do not contact staging. The coordinator applies these steps after `node scripts/staging-reset-guard.mjs ldmambwtksfvqdufhaam`, and each staging apply needs rollback-drill evidence (OVD-839 table: apply, roll back, reapply, smoke).

Staging on 2026-10-20 had 156 rows, head `20261020100000`: the 152 baseline, OVD-736 at the old repo version `20261015074957`, OVD-979 (`20261020002126`, `20261020002127`) and OVD-987 P3 (`20261020100000`). It lacked the six window versions and the two migrations production gained since. Read staging with the pre-check before step 1, and skip any step whose rows are already present. Target: staging equals production plus the pending suffix.

1. Rename OVD-736 to its production version (bytes confirmed identical), exactly as `docs/staging-env-wiring.md` records from #776:

   ```sh
   supabase migration repair --db-url "$STAGING_DB_URL" --status reverted --yes 20261015074957
   supabase migration repair --db-url "$STAGING_DB_URL" --status applied --yes 20261016013742
   ```

2. Apply the six window migrations, then `20261025194414` (OVD-1097) and `20261029165751` (claim fence), in version order, one transaction each, with a history row, as earlier staging applies did (`execute_sql` plus history row, or `psql -X -v ON_ERROR_STOP=1 --single-transaction -f <file>` then `supabase migration repair --status applied <version>`). Do not use `supabase migration up` or `--include-all`; these versions sort before the staging head. Rollback drill files: ovd768 `docs/migration-drafts/ovd-766-b.rollback.sql`, ovd771 `ovd-771.rollback.sql`, ovd767 `ovd-766-a.rollback.sql`, ovd769 `ovd-766-c.rollback.sql`, ovd770 `ovd-766-d.rollback.sql`, ovd766e `ovd-766-e.rollback.sql`, OVD-1097 `docs/migration-drafts/ovd-1097.rollback.sql`, claim fence `supabase/rollbacks/20261029165751_reconcile_claim_fence.rollback.sql`. Roll back newest first, then reapply.
   If a file applied but its `supabase migration repair` failed, do not run the file again. Confirm with the step 3 pre-check that only that version is missing, confirm the file's objects exist, then repair that exact version. Reset staging only if the objects are partial or their state is unknown.
3. Run the 161 pre-check against staging. Expected: `missing {}` and `extra {20261020002126,20261020002127,20261020100000}`, count 164. Those three rows are drafts that are not on main.
4. Apply the suffix (`20261030204050`) to staging with the step 2 method and drill, then rerun the pre-check: count 165, `extra` = `20261030204050` plus the three draft rows.
5. When #874 and #886 are renamed after `20261030204050`, repair the three draft rows to their new versions with exact-version `migration repair` (old version `reverted`, new version `applied`, bytes confirmed identical), never a broad repair.

## Still open for OVD-635

- Blaine's read-only production pre-check is recorded at 161 rows (Release, 2026-10-31); rerun it with the 161 pre-check before the window. Staging reconciliation evidence above is still open.
- Blaine's review of the authorization template.
- OVD-658, OVD-659 and OVD-660 (R1/R2 runner, cached platform extraction, CLI session capture) targeted the superseded #564 candidate; PRs #627, #628 and #629 closed unmerged. The CLI transaction behavior they were to capture is recorded above; the rest is proposed for 1.1.
