# Ephemeral DB fixtures (OVD-849)

Inputs for `scripts/ephemeral-db-apply.test.mjs` and for a manual fixture PR.
They live under `scripts/fixtures/` so migration lineage tooling
(`scripts/verify-migration-lineage.mjs`, `scripts/migration-timestamp.mjs`),
which reads only `supabase/migrations`, never sees them.

- `migrations/20990101000000_ephemeral_fixture_ok.sql`: applies cleanly.
- `migrations/20990101000100_ephemeral_fixture_fail.sql`: fails (missing table);
  the report must name this file.
- `pending/ephemeral_fixture_ok.sql.pending`: pgTAP for the ok migration.
- `drafts/ovd-9901-fixture.sql` (+ rollback) and `pending/ovd9901_fixture.sql.pending`:
  a draft family that applies and passes.
- `drafts/ovd-9902-fixture-fail.sql` and `pending/ovd9902_fixture_fail.sql.pending`:
  a draft family whose draft fails; the report must name the draft.
- `drafts/ovd-9903-fixture-superseded.sql`: a retired (SUPERSEDED) draft that is
  never applied.
- `drafts/ovd-9904-idempotent.sql` through `ovd-9909-*.sql`: OVD-924 rollback-stage
  fixtures (clean idempotent apply, re-apply failure, second-pass failure,
  DM-1R extra column, no rollback file, newest-first order).
- `replay-792/`: header-only snapshot of `docs/migration-drafts` and
  `supabase/tests/pending` at d2b7981b (#792, OVD-829). The replay tests run real
  historical diffs through draft-family selection against it. Bodies are omitted;
  only the leading comment blocks matter for selection. Do not refresh it to the
  current tree: it pins the state the replay assertions describe.

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
