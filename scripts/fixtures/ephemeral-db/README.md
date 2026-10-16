# Ephemeral DB fixtures (OVD-849)

Inputs for `scripts/ephemeral-db-apply.test.mjs` and for a manual fixture PR.
They live under `scripts/fixtures/` so migration lineage tooling
(`scripts/verify-migration-lineage.mjs`, `scripts/migration-timestamp.mjs`),
which reads only `supabase/migrations`, never sees them.

- `migrations/20990101000000_ephemeral_fixture_ok.sql`: applies cleanly.
- `migrations/20990101000100_ephemeral_fixture_fail.sql`: fails (missing table);
  the report must name this file.
- `pending/ephemeral_fixture_ok.sql.pending`: pgTAP for the ok migration.

## Fixture PR (proves the CI job end to end)

1. On a throwaway branch, copy the ok migration into `supabase/migrations/` and the
   pending test into `supabase/tests/pending/`. Open a draft PR. The
   `Ephemeral DB` check should report PASS with the migration under
   `migrations.applied` and the pending test passing.
2. Add the failing migration too. The check should report FAIL with
   `migrations.failed.file` set to the failing migration's path. In report mode
   the check stays green; the result is in the step summary and the
   `ephemeral-db-report` artifact.
3. Close the PR without merging and delete the branch. These files must never
   land in `supabase/migrations` on main.
