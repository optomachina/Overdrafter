QA: PASS on 2c4eeba227dad854a0c06e9c85b28e3b9e58828c
**Pending list.** `jarvis-front-door` moved to `PENDING_SPECS` with OVD-805. It is not run and is listed only under "Pending (not run, not counted as passing)" and on stderr. The judge diff vs main is output-only (`pendingSpecs` plus a summary section); `reasons` and the verdict logic are unchanged.
**Before/after** (`run --modes fixture --features provider`, `VERIFY_WORKERS=1`; the manifests show `--workers=1`; clean trees):
- main 213b62a0: FAIL 13/15, from the 2 jarvis expected-failures.
- this head: PASS 9/9, with jarvis listed as pending.
- `admin-operations` 6/6 (0 skipped) under `e2e/admin-operations.config.ts` in both runs. The new test pins that config.
**Guard probes** (scratch worktree; each mutation turns the skill test red):
- `test.fixme` added to a mapped spec, and `test.fail` added to a mapped spec.
- A pending entry with no issue, `issue: "TBD"`, and `TBD` with the pinned list also updated (caught by the `^OVD-\d+$` check).
- `test.fail` removed from the jarvis spec, swapped for `test.skip`, or no longer naming OVD-805.
- **A pending journey that runs anyway FAILs:** the PR judge on main's evidence gives FAIL (expected-failure plus a manifest mismatch).
**Can it hide a real failure?** No, not without visible test edits.
- Moving a real spec (`engineering-admin-route`) to pending without `test.fail` is red, and adding a `// test.fail( OVD-999 )` comment doesn't help.
- Minor: a template-string line starting `test.fail( OVD-999 )` does satisfy the text check, and only the pinned `specsFor` list catches it. So the control is really the two pinned lists in `scripts/verify-overdrafter-skill.test.mjs`, which any hide has to edit in plain view.
- CI judges with the base map, so a PR can't hide its own failure.
- The jarvis boot guard and OVD-805 guard still run in `ci` (`e2e:fixture`, @fixture tag).
- Opus minor 1 (a feature left with only pending specs becomes SKIPPED) is still open and doesn't block.
**Not gate loosening of a required gate.** Read-only `GET branches/main`: the only required checks are `ci` and `provider-go-live`. `verify` is not required and runs in report mode. On this PR, `verify` logged the expected `FAIL … (report mode, not failing the job)` warning from main's map (job 117313723672).
**Tests and CI.** vitest 116/116; preflight lint and typecheck PASS. CI run 39003927850 (`ci`, `test`, `browser-test`, `build`, `lint`, `typecheck` …) plus `provider-go-live`, `proof-check`, `secret-scan`, `security-definer-lint` and `verify (run journeys at head)`: all 23 check runs green. SonarCloud green. Gate: Opus APPROVED @ 2c4eeba2 (issuecomment-6229823842).
Proof re-run: `npx vitest run scripts/verify-overdrafter-skill.test.mjs scripts/verify-result-judge.test.mjs scripts/verify-skill-drift.test.mjs` + `bash scripts/preflight.sh lint`/`typecheck` + `VERIFY_WORKERS=1 .agents/skills/verify-overdrafter/run --modes fixture --features provider` and `verify-result-judge.mjs` at 2c4eeba2 and 213b62a0 in fresh worktrees + guard mutation probes; CI run 39003927850.
