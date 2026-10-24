Closes OVD-875 (parent OVD-870). https://linear.app/optomachina/issue/OVD-875

Model: opus per Release

## What changed
- `scripts/lint-rls-new-tables.mjs` adds a new rule to #797's lint family. Any `CREATE TABLE` in `public` or `overdrafter` must have `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` in the same file. It **reuses #797's tokenizer and statement splitter**: `scripts/lint-security-definer.mjs` now exports them, and the SECURITY DEFINER rule behaves exactly as before.
- Exempt: partitions, temp tables, and unlogged tables that are created and dropped in the same file. Escape hatch: `-- lint-allow: rls-off reason="..."` on the CREATE line. A reason is required, and adding a hatch in a diff is reported as `gate_loosening`.
- History is covered by `scripts/rls-new-tables-baseline.json`, which regenerates byte-identical from main and has a test for that. New files are enforced.
- **Wiring:** `scripts/lint-rls-new-tables.node-test.mjs` runs inside `test:portable-node` with `--report`. No workflow edit.
- **Why a separate file and not more code in `lint-security-definer.mjs`:** they share a parser, but this rule has its own baseline key (table, not function signature), report schema and escape hatch. Keeping them apart means loosening one rule can't change the other's baseline or gate-loosening checks. One side effect: adding the exports makes #797's report flag this PR as `checker_changed`. That's report-only and expected.
- Based on main; it doesn't depend on #800. Nothing under `.github/` or `supabase/migrations/` changed, and there are no new deps.

## Checks
- `bash scripts/preflight.sh lint`: PASS. `bash scripts/preflight.sh typecheck`: PASS.
- `npm run test:portable-node`: 1701 pass, 0 fail.
- `npx vitest run --maxWorkers=2`: 11828 pass. The 3 failures are the expected OVD-417 docker-only ones.

## Card drafts (not in this PR)
1. After one week in report mode, switch the node-test wrapper from `--report` to `--enforce`.
2. A separate required check for the RLS lint, if wanted, would need its own workflow job and branch-protection change.
