QA: PASS on 3e9d5df4fb8b06a0149366ca5e3969fb99e56b68
**Fail closed (verified by hand).** A `tokenizer_unknown_char` file gets `rls`, `definer` and `auth` plus the `sql:tokenizer_unknown_char` reason. I checked NUL/SOH/ESC/DEL at top level, inside `'…'` and inside `$é$…$é$`. A DEL file with a commented-out SUPERUSER still gets `auth_role_superuser`.
**Non-ASCII.** `ALTER ROLE x PASSWORD $—$;$—$ SUPERUSER;` → `auth`/`auth_role_superuser`. The same result holds for:
- tags `$é$`, `$😀$`, `$NBSP$`, `$BOM$`, `$a—1$`, `$漢字$`, ZWJ+RLO, U+2028 and `$𝔘$`
- identifiers `é`, `x—y`, `😀`, `é$`, `"é—"` and `U&"\00e9"`
- `a—$$` / `—$$` / `é$t$` (not quotes) and `ée'`/`Ée'`/`éU&'`/`éB'` (not prefixed strings)
- CREATEROLE, REPLICATION, BYPASSRLS, GRANT postgres, `set role anon<NBSP>`, definer and rls inside non-ASCII tags

The three unflagged probes are not fail-opens, because Postgres errors or the text is inside a string: a `$<VT>$` "tag", a precomposed/decomposed é tag mismatch, and fullwidth SUPERUSER.
**Sweep.** 352 `.sql` files at this head, scanned with each head's own detector: 0a747458 gives 1796/306/3, and 3e9d5df4 gives 1401/701/3 (sensitive/exempt/informational).
- 0 new sensitive hits by (file, rule, line), and 0 unknown-char files.
- The only change is 395 `auth_reset_role` hits in `supabase/tests/**` now exempted by `tests_reset_role`. Per-rule hit totals are identical.
- `RESET ROLE` is still flagged outside tests: fixtures 40, docs/release 22, scripts/qualification 2, plus the DO block in tests/ovd736. My probes also flag it in migrations, under `supabase/tests/../`, as `reset "role"`, inside DO/EXECUTE, and in a file with an unknown character.

**Tests, lint and CI.** 384/384; preflight lint and typecheck PASS. CI run 39000720113: `ci`, `test`, `browser-test`, `build`, `lint`, `typecheck` all green, and `sensitive-class`, `provider-go-live` and `proof-check` green. The cancelled duplicates re-ran green. SonarCloud green. Gate: Opus re-review APPROVED @ 3e9d5df4 (issuecomment-6229353564).
**Before merge.** This is a draft stacked on #817, not merged with main. It is `gate_loosening` (two tests-only exemptions), so it still needs the Grok Bot countersign and Blaine's card at merge.
Proof re-run: `npx vitest run scripts/sensitive-class-detect.test.mjs` + `bash scripts/preflight.sh lint` + `bash scripts/preflight.sh typecheck` + classifySql probes + 352-file sweep (0a747458 vs 3e9d5df4) at 3e9d5df4 in a fresh worktree; CI run 39000720113.
