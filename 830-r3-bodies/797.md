Implements **OVD-846** (OVD-840): SECURITY DEFINER lint in CI, report mode first.

## Summary
- `scripts/lint-security-definer.mjs`: dependency-free linter with a tolerant SQL tokenizer (`$$`/`$tag$` bodies, nested comments, quoted identifiers, `E''` strings). For each `CREATE [OR REPLACE] FUNCTION ... SECURITY DEFINER` it requires a pinned `search_path`, a `REVOKE ... FROM PUBLIC` and `FROM anon`, and an explicit `GRANT EXECUTE`, all in the same migration. It prints per-violation `file:line sig: missing ...` messages and writes JSON for OVD-845.
- `scripts/security-definer-baseline.json`: 245 existing violations, generated from main `d2b7981`. An entry covers a function only while its CREATE statement is byte-identical. A re-created or edited definer must be fully compliant. In CI only the base commit's baseline counts, so the baseline can only shrink; a new entry is reported as growth.
- `.github/workflows/security-definer-lint.yml`: job `security-definer-lint`. Like pr-body-gate, it runs the base commit's script (`HEAD^1`) and falls back to head when the base has none. It runs with `continue-on-error: true` and without `--enforce`, and uploads the JSON artifact.
- Fixtures under `scripts/fixtures/security-definer/` and 21 vitest tests that follow the issue's test plan.

## Proof
- `bash scripts/preflight.sh lint`: PASS. `bash scripts/preflight.sh typecheck`: PASS.
- `npx vitest run --maxWorkers=2`: 11618 passed, 3 failed. All 3 failures are the known docker `qualify-ovd417` tests.
- Full tree: 410 definer functions, 0 failing, 245 baselined, 0 stale.
- Nothing under `supabase/migrations/` changed, no SQL was applied anywhere, no secrets were added, and branch protection is unchanged.
