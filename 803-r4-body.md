## Linear issue ID
- Issue: [OVD-857](https://linear.app/overdrafter/issue/OVD-857/decision-log-for-release-bot-merge-plans) (child of OVD-840). This is the main PR for the issue.

## Summary
Builds the plan §6 design for the Release bot merge plan:
- **Bottom-up landing:** `planContiguousVerified` lands only the contiguous run of PRs that have a valid OVD-845 verdict at their current SHA. It stops at the first PR without one. OVD-845 doesn't exist yet, so verdicts are passed in as JSON.
- **Read-back of every merge:** `readBack` checks three things:
  - the merge commit is on main and has a single parent;
  - `git rev-parse <merge>^{tree}` equals the tree of the verified head;
  - after a rebase, the tree equals the verified head rebased onto the parent (`git merge-tree --merge-base=<verified base> <parent> <head>`). This rebased-tree comparison is the only pass/stop check; a context-free (`-U0`) patch-id is logged as a diagnostic only (Architect amendment, F2).

  PR state alone never counts as merged.
- **Append-only TSV log:** columns are `ts, pr, head_sha, patch_id, verdict_ref, action, merge_sha, tree_match, result`. `tree_match=false` stops the run and flags it to Grok Bot/Blaine, with no auto-revert. `verifyAppendOnly` and `logDigest` detect a rewritten or truncated log.
- The script runs local git plumbing only. It never merges, pushes, or contacts a remote.

## Problem
A queued merge, an armed auto-merge, or `MERGED` PR state is not proof that the verified content landed on main. Release bot merge plans had no read-back of the merged tree and no append-only record of each landing decision.

## Scope
- Included: `scripts/merge-readback.mjs`, its tests, the merge-plan procedure in `docs/recurring-workflows.md`, and the land skill's read-back step.
- Not included: gate follow-ups F6 (re-check a cached passing row is still on main), F8 (formula-escape compare) and F9 (technical enforcement of who acks a stop); OVD-845 verdicts; any CI wiring.

## Files changed
- `scripts/merge-readback.mjs` (CLI commands: `init-log`, `plan`, `readback`, `readback-run`, `digest`, `verify-log`)
- `scripts/merge-readback.test.mjs` (47 tests, most against a temporary git fixture repo)
- `docs/recurring-workflows.md` (merge-plan procedure and TSV template)
- `.codex/skills/land/SKILL.md` (new read-back step after MERGED)

## Tests
The fixture repo covers these cases:
- A squash merge with an identical tree gives true.
- A squash after main moved on passes by the rebased-tree comparison.
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
- **Not fixed in round 4:** diffs over 1 MB (`ENOBUFS`, fixed in the gate repair below as F7) and the land skill's verdict source (tracked in [OVD-893](https://linear.app/overdrafter/issue/OVD-893)).

## Proof: gate repair F1–F5, F7 (Architect gate @ 4833c3dd, fix commit 9732ee32)
- **F1 (runbook order):** `docs/recurring-workflows.md` steps 2–3 and land skill step 12 now interleave per PR: merge → `git fetch origin main` → plan-bound read-back → next PR only after `tree_match=true`. Never merge all then read back; a stop leaves the PRs above unmerged.
- **F2 (patch-id false stops):** per the Architect amendment on OVD-857, patch-id can no longer pass, stop or skip. The only pass/stop check is `git merge-tree --merge-base=<verified base> <parent> <head>` tree == merge tree (reason `rebased-tree-matches` / `tree-mismatch-after-rebase`); a `-U0` patch-id is logged as a diagnostic. Tests: `F2: rebased-tree comparison is the only pass/stop check > passes a correct squash rebased onto a main that changed a nearby line (5-line repro)` and `> still stops a rebased squash that carries a real content difference`.
- **F3 (order vs git history):** each lower PR's merge SHA must be an ancestor of the upper merge's parent, else the read-back stops with `lower-merge-not-ancestor-of-parent` (logged `tree_match=false`, open stop). Test: `F3: landing order is checked against git ancestry > stops a reversed landing where the upper PR merged first` (B→H1(+a)→H2(+b), main B→M2(+b)→M1(+a), merges=[M1,M2]; in one run and one PR per run).
- **F4 (whole plan bound):** `plan` logs a `plan-digest` row (sha256 of base + ordered land + stop); `planLogMismatch` refuses a plan.json whose digest differs (`plan-digest-mismatch`), with no row written. Tests: `F4: the whole ordered plan is bound to the log > refuses a plan.json with a lower PR deleted from land` and `> refuses a plan.json with a changed base` (both via `readback-run` and plan-bound `readback`).
- **F5 (digest after every append):** `plan`, `readback`, `readback-run` and `stop-ack` take `--prior <digest.json>` (refuse if the log no longer extends it) and `--digest-out`, and print `log_digest` after each append; the runbook keeps the latest digest in the merge-plan comment. Test: `F5: the log digest is refreshed after every append > detects a failed read-back flipped to true after the post-read-back digest` (flip fails verify-log as `log-truncated`; a same-length flip fails as `prior-rows-rewritten`; `readback-run --prior` refuses).
- **F7 (maxBuffer):** git subprocess `maxBuffer` is 256 MiB. Test: `F7: large diffs > reads back a ~2 MB diff without ENOBUFS` (~2.4 MB file).
- No existing check was loosened. Existing tests that expected `tree-mismatch-patch-id-differs` now expect `tree-mismatch-after-rebase` (still `tree_match=false`). The standalone diagnostic `readback` (no `--log`, not proof) now matches a stacked squash whose lower change replays cleanly; the plan-bound run is unchanged in what it binds.

## Verification
Gate repair @ 9732ee32, on the box:

```bash
npx vitest run scripts/merge-readback.test.mjs   # 47 passed (47)
npx eslint scripts/merge-readback.mjs scripts/merge-readback.test.mjs   # clean
npm run preflight   # lint PASS, typecheck PASS, test: 12832 passed, 3 failed (known docker-only qualify-ovd417 tests), 19 skipped
```

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

## Documentation
- [x] Docs updated

`docs/recurring-workflows.md` (merge-plan procedure, F1/F2/F3/F4/F5 text and template) and `.codex/skills/land/SKILL.md` step 12.


<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **Workflow**
  * Merges in a stacked pull request sequence are now checked against the approved plan before the next merge can proceed.
  * Failed checks halt the sequence and require acknowledgement; merges are not automatically reverted.
  * Issues move to Done only after the merge is confirmed and the checks pass.
* **Documentation**
  * Added guidance on merge planning, validation, decision records, and handling failed checks.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->
