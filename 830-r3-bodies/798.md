Implements **OVD-847** (OVD-840): RLS deny-case coverage check, report mode first.

## Summary
- `scripts/check-rls-deny-coverage.mjs`: reads `CREATE`/`ALTER`/`DROP POLICY` and `ALTER TABLE ... ENABLE/DISABLE/FORCE ROW LEVEL SECURITY` in changed migrations. It ignores comments, strings and `$$` bodies. Each changed table or policy needs a `supabase/tests/*.sql` file with `-- deny: anon|other_user|role_boundary <schema.table>` blocks that contain pgTAP deny assertions. `DISABLE` or `NO FORCE` RLS always fails (needs Blaine). Output is human-readable, plus JSON (`ovd847.rls-deny-coverage.v1`) for OVD-845.
- `scripts/rls-deny-baseline.json`: 244 entries (135 policies, 109 RLS-enabled tables). It can only shrink: growth compared with the base commit's baseline fails.
- `ci.yml`: new `rls-deny-coverage` job. It runs the base commit's script with head fallback, has `continue-on-error: true`, is not in the `ci` aggregate, and uploads the JSON artifact.
- `docs/rls-deny-coverage.md` documents the tag convention. Fixtures are under `scripts/fixtures/rls-deny/`, with 18 vitest tests that follow the issue's test plan.

## Proof
- `bash scripts/preflight.sh lint`: PASS. `bash scripts/preflight.sh typecheck`: PASS.
- `npx vitest run --maxWorkers=2`: 11615 passed, 3 failed. All 3 failures are the known docker `qualify-ovd417` tests.
- Nothing under `supabase/migrations/` changed, no SQL was applied anywhere, no secrets were added, and branch protection is unchanged.


<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **New Features**
  * Added checks for row-level security (RLS) deny-test coverage, including cases for anonymous access, other users, and role boundaries.
  * Coverage reports identify missing tests, baseline changes, and potential gate-loosening changes. Reports are available in CI summaries and as downloadable artifacts.
* **Documentation**
  * Added guidance on coverage requirements, baseline behavior, validation findings, and command-line options.
* **Chores**
  * Added automated tests for coverage checks and reporting behavior.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->