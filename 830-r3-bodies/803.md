## Linear issue ID
- Issue: [OVD-857](https://linear.app/overdrafter/issue/OVD-857/decision-log-for-release-bot-merge-plans) (child of OVD-840). This is the main PR for the issue.

## Summary
Builds the plan §6 design for the Release bot merge plan:
- **Bottom-up landing:** `planContiguousVerified` lands only the contiguous run of PRs that have a valid OVD-845 verdict at their current SHA. It stops at the first PR without one. OVD-845 doesn't exist yet, so verdicts are passed in as JSON.
- **Read-back of every merge:** `readBack` checks three things:
  - the merge commit is on main and has a single parent;
  - `git rev-parse <merge>^{tree}` equals the tree of the verified head;
  - after a rebase, the patch-id is identical and the tree equals the verified head rebased onto the parent.

  PR state alone never counts as merged.
- **Append-only TSV log:** columns are `ts, pr, head_sha, patch_id, verdict_ref, action, merge_sha, tree_match, result`. `tree_match=false` stops the run and flags it to Grok Bot/Blaine, with no auto-revert. `verifyAppendOnly` and `logDigest` detect a rewritten or truncated log.
- The script runs local git plumbing only. It never merges, pushes, or contacts a remote.

## Files changed
- `scripts/merge-readback.mjs` (CLI commands: `init-log`, `plan`, `readback`, `readback-run`, `digest`, `verify-log`)
- `scripts/merge-readback.test.mjs` (40 tests, most against a temporary git fixture repo)
- `docs/recurring-workflows.md` (merge-plan procedure and TSV template)
- `.codex/skills/land/SKILL.md` (new read-back step after MERGED)

## Tests
The fixture repo covers these cases:
- A squash merge with an identical tree gives true.
- A squash after main moved on passes by patch-id.
- An extra commit, a tampered amend, or a commit not on main each give false.
- In a stack of 3 with the middle PR unverified, only the bottom PR lands.
- A run stops at the first mismatch.
- A rewritten or truncated log is detected.
- The CLI works end to end.
- Round 4: a `verified_base` / `--verified-base` override is rejected; a partial landing with a bottom base of `head~1` stops; `GIT_DIR`, `GIT_INDEX_FILE` and `GIT_WORK_TREE` in the parent env don't change the result; a hand-written or edited `plan.json` is refused.

## Round 4 (after Opus @ 67b8a160)
- **No base override.** The `verified_base` override is gone: `readBack` throws on `verifiedBase`, a `merges.json` entry with `verified_base` is refused (`verified-base-override-not-allowed`), and the CLI rejects `--verified-base`. The base is always derived: the plan's `base` for the bottom PR, and the verified head below for every PR above it. It is checked with `git merge-base --is-ancestor`. The bottom PR's base must also equal `git merge-base <head> <main>`. Before, a mismatch only warned; now it stops with `bottom-base-differs-from-merge-base`, so a base of `head~1` can't pass a partial landing.
- **Scrubbed git env.** Every git subprocess, and the test fixture helper, runs with all `GIT_*` variables removed. The tool sets none of its own.
- **Plan must match the log.** `readback-run` and plan-bound `readback` refuse when the latest plan row for a PR in the same log isn't a `plan-land` row with the same `head_sha` and `verdict_ref` (`plan-not-in-log`).
- **Not fixed here:** diffs over 1 MB (`ENOBUFS`) and the land skill's verdict source. Both are tracked in [OVD-893](https://linear.app/overdrafter/issue/OVD-893).

## Verification
Round 4 @ 4fd2fc18, on the box. Head is now 2f6c04fb, which only merges `origin/main` (#825) and doesn't touch this PR's files:
- `npx vitest run --maxWorkers=2 scripts/merge-readback.test.mjs`: 40 passed (40).
- `bash scripts/preflight.sh lint`: PASS
- `bash scripts/preflight.sh typecheck`: PASS
- `npx vitest run --maxWorkers=2` (full suite): 11555 passed, 38 failed, 76 skipped. The failures are in 47 files, none of which this PR touches. The box worktree has no `worker/node_modules` (`Cannot find module 'camoufox-js'`), and there are no browser or docker fixtures (browser-session probe, default-deny suites, OVD-417 harness). CI runs the full suite.

Earlier rounds: `npx vitest run --maxWorkers=2`: 11611 passed, 3 failed (known OVD-417 docker tests); `npm run test:agent-control-plane`: OK.

## Migration notes
- [x] No migration impact

## Rollback / risk notes
The change adds a script, docs and one land-skill step. Roll back by reverting the PR.

