# OVD-635: frozen 152-migration production baseline

Status: preparation only. Nothing here contacted a hosted database.

## Why 152

The original OVD-635 suffix (the #564 integration branch, migrations 127-139) is no longer pending: every repository migration is recorded as applied in production. In order:

| Date | Ledger | Source |
|---|---|---|
| Oct 12 | 148, then 149 with `20261012212325` (OVD-462) | window 1 packet README, branch `claude/window-1-packet` |
| Oct 13 | 151 with `20261013043000` (OVD-723 expand) and `20261013043100` (OVD-722) | commit e514f2ca (#728) |
| Oct 14 | 152 with `20261014191541` (OVD-414) | commit e12a4726 (#733) |

The last direct count anywhere is 149, on Oct 12. The 151 and 152 figures are sums of the applied records. `ovd-635-ledger-152-pre-check.sql` turns that inference into a check the owner can run.

## Files

- `ovd-635-ledger-152-manifest.json`: the 152 migrations in order, with version, filename and SHA-256, from source commit `2cb6e66c`. `versionListMd5` is the md5 of the newline-joined version list.
- `ovd-635-ledger-152-pre-check.sql`: read-only (`begin read only` ... `rollback`), and it reads only `supabase_migrations.schema_migrations`. It returns the count, head, version-list md5, statement fingerprint, and the versions that are missing or extra against the manifest.
- `scripts/verify-ovd635-ledger-manifest.mjs`, run by `scripts/verify-ovd635-ledger-manifest.test.mjs` in the default suite. It fails when a frozen migration changes, when a migration is inserted inside the prefix, or when the pre-check version list drifts. Later migrations may follow the prefix.

## Owner step

Run the pre-check read-only against production. The expected row is:

```
count 152 | head 20261014191541 | version_list_md5 dea629f567cdcbf87a5f9d83d9215979 | missing {} | extra {}
```

Record `statement_fingerprint` without asserting it. Rows applied through the SQL editor on Oct 13 can store different `statements` than a CLI apply would, so they can differ from the local value below. Any missing or extra version means production and the repository have diverged. In that case stop before any migration window.

## Disposable rehearsal (local, Oct 15 2026)

Setup: Supabase CLI 2.75.0 and `public.ecr.aws/supabase/postgres:17.6.1.075` on a local Docker stack owned by this task. `supabase db reset --local` was run from source commit `2cb6e66c` and applied all 152 migrations from an empty database.

- The pre-check SQL against the rehearsal database returned `152 | 20261014191541 | dea629f567cdcbf87a5f9d83d9215979 | 4f047c5e45916a435521cb8621bfb814 | {} | {}`.
- All 74 pgTAP files in `supabase/tests` were run with psql: 74 of 74 pass, 3331 planned assertions, 0 `not ok`, 0 errors. `capability_runtime_persistence_concurrency.sql` was excluded because CI routes it to the separate independent-session lane.
- The next candidate change, the OVD-736 draft (#718), is rehearsed inside its own pgTAP suite against this baseline. The suite installs the draft, rolls it back and reapplies it, and passes 106 of 106.

This rehearsal starts from an empty database and replays the repository files. It does not restore the production ledger's history, which includes rows applied through the SQL editor, so it does not prove historical equivalence.

## Not applied yet (needs a migration window and Blaine's OK)

These are drafts or staged SQL. None is in `supabase/migrations`:

- `docs/migration-drafts/ovd-736.sql`: revokes anon and PUBLIC EXECUTE on 56 SECURITY DEFINER functions and adds the OVD-759 invite search_path fix (#718).
- `docs/migration-drafts/ovd-723-contract.sql`: the OVD-723 contract step (window 2).
- `docs/migration-drafts/ovd-725-stripe-catalog.sql`: window 2.
- `docs/migration-drafts/ovd-762-xometry-fanout-scope.sql`: draft only.
- `docs/migration-drafts/ovd-678-provider-daily-quote-cap.sql`: not applied.
- Window 2 staged SQL (OVD-649 order, `docs/release/ovd-649-window-2-order.md`): `ovd-558-verifier-authority-forward.sql`, `ovd-560-result-registry-forward.sql`, `ovd-561-finalization-forward.sql`, `ovd561-pending-forward.sql`, `native-result-reader-forward.sql`, `private-artifact-forward.sql`, `native-artifact-mapping-forward.sql`, `ovd-563-step-review-forward.sql`, then `scripts/native/stop-observer/sql/store-native-observer-evidence-replay.staged.sql`.

## Still open for OVD-635

- The owner's read-only pre-check against production.
- The synthetic R1/R2 runner, cached platform extraction and CLI session capture (OVD-658, OVD-659, OVD-660). PRs #627, #628 and #629 were closed unmerged, and their target was the superseded #564 candidate.
