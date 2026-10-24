Implements **OVD-849 part 1 only** (OVD-840): a throwaway CI database that applies the PR's migrations and runs pgTAP. Report mode first.

## Summary
- `.github/workflows/ephemeral-db.yml`: runs on PRs that touch Supabase migrations or tests, and can also be started by hand or from another workflow. Like pr-body-gate, it runs the base commit's scripts (`HEAD^1`) and falls back to head. It has `continue-on-error` unless called with `enforce: true`, uses no secrets, and uploads the `ephemeral-db-report` JSON for OVD-845.
- `scripts/ephemeral-db-apply.mjs`: starts the database with `supabase start` from the base commit's `supabase/` folder, so main's migrations come first. It then applies the PR's new migrations in timestamp order, one transaction each, and stops at the first failure, naming the failing migration. After that it runs the policy pgTAP suite and the PR's touched `*.sql.pending` tests.
- `scripts/supabase-target-guard.mjs`: `assertAllowedTarget(ref)` always refuses the prod ref `ozuatdcakezjtevztjlr`, and refuses any ref outside the allowlist. The allowlist stays empty until OVD-836. This is groundwork for part 2.
- Fixtures are in `scripts/fixtures/ephemeral-db/`, outside `supabase/migrations`. There are 25 vitest tests covering selection, ordering, naming the failed migration, and the ref guard.

## Not in this PR
- Part 2, the staging project apply, waits on OVD-836. No staging secret is added or referenced; that needs Blaine.
- The five per-issue `ovdNNN-pending-pgtap.yml` workflows are left in place. They can be retired later.

## Proof
- `bash scripts/preflight.sh lint`: PASS. `bash scripts/preflight.sh typecheck`: PASS. `npm run verify:migration-lineage`: PASS.
- `npx vitest run --maxWorkers=2`: 11622 passed, 3 failed. All 3 failures are the known docker `qualify-ovd417` tests.
- Nothing under `supabase/migrations/` changed, no SQL was applied to any real project, and branch protection is unchanged.
