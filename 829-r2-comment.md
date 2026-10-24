QA: FAIL on 58d4d8949e4ad9207ccd3cb165d814297fb8cda6
The repair budget is 2/2 used. These are the two criteria that still fail:
1. **A garbage SHA gets executed.** In a shallow clone, `scripts/vercel-ignore-build.sh:37` runs `git fetch --quiet --depth=100 origin "$previous_sha"` without a `--` guard. Repro: `VERCEL_GIT_PREVIOUS_SHA='--upload-pack=touch /tmp/PWN;'` in a `--depth=1` clone with a file:// origin. `bash -x` shows git reading the value as `--upload-pack`, and `/tmp/PWN` gets created. The script exits 1 (BUILD), but the command has already run. With an https origin it did not run. The value is set by Vercel, so the real-world risk is low, but this criterion was "never executed". Fix: `--end-of-options`/`--` before the SHA, or only accept `^[0-9a-f]{40}$`, which also stops `VERCEL_GIT_PREVIOUS_SHA=main` resolving and SKIPping. Opus flagged this as non-blocking in issuecomment-6228842081. The same line was already in 7c6c9a68, and my round-1 QA missed it.
2. **The PR body doesn't match the behavior.** It still says "Any error builds (exit 1): a missing or bogus SHA" and lists "missing SHA builds" among the tests. With `main`/`origin/main` present, an unset or empty SHA exits 0: `SKIP … vs merge-base with origin/main`.
Fixed and passing:
- With `main` and `origin/main` present, a set but unresolvable SHA builds: `deadbeef…`, `garbage`, `not-a-sha`, `; rm -rf /`, `$(…)`, backticks, `--output=…`.
- prod/`main`, empty diff, git diff failing, git failing, git missing, corrupt repo, not-a-repo, shallow bogus/unset, and a mixed `src` change all build.
- Unset uses the merge-base fallback.
- The script itself has no eval or unquoted use of the value.
- The skip list is unchanged since 7c6c9a68: no diff to `api/`, `src/`, `server/`, `shared/`, `vite.config.ts`, `package.json` or `vercel.json`.
- vitest 20/20. CI runs 38997351812/38997351810/38997351811/38997351854: 19 checks incl. `ci`, `test`, `browser-test` green; SonarCloud green. Gate: Opus re-review APPROVED @ 58d4d894.
Proof re-run: `npx vitest run scripts/vercel-ignore-build.test.mjs` + scratch-repo env matrix (full clone with main+origin/main, shallow file:// clone, `bash -x` trace) at 58d4d894 in a fresh worktree; CI run 38997351812.
Deploy config: the merge is on Blaine's card.
