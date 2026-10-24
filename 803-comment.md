## QA verdict: PASS_NOTES — `2f6c04fb4a02515347735748b5bb36e83bdf8a4b`

**Gate:** Opus APPROVED 4fd2fc18 (issuecomment-6229242530), after Sonnet and Opus CHANGES REQUIRED on earlier rounds. Carry-forward: `git diff 4fd2fc18 2f6c04fb -- <4 PR files>` is empty. The head is 4fd2fc18 plus a merge of main dc32b9c9 (#825). That merge is clean: `git merge-tree --write-tree` gives 8dad4b66, which equals the head tree. No earlier QA verdicts on this PR.

**Proof re-run:** in a fresh worktree at 2f6c04fb:
- `npx vitest run --maxWorkers=2 scripts/merge-readback.test.mjs`: 40/40 passed.
- `bash scripts/preflight.sh lint`: PASS.
- `bash scripts/preflight.sh typecheck`: PASS.
- `npm run test:agent-control-plane`: 47 tests, OK.
- I didn't re-run the full suite on the box (same box limits as the PR body); CI `test` is green at the exact head.

**Independent probes** (scratch vitest file and a scratch fixture repo, both deleted afterwards):
- **The `verified_base` override is gone.**
  - `readBack({verifiedBase})` throws `verified_base override is not accepted`.
  - `checkMergesAgainstPlan` with `verified_base` in merges.json returns `verified-base-override-not-allowed: 1`.
  - The real CLI `readback ... --verified-base <sha>` exits 2 with `--verified-base is not accepted`.
- **Bottom base equals merge-base(head, main).**
  - With a plan base of `head~1` on a full squash landing, the run stops with `bottom-base-differs-from-merge-base: plan base … != merge-base(head, main) …`.
  - The round 3 partial-landing repro (two commits, only the second cherry-picked to main) is tested at test.mjs:277 and stops.
- **GIT_* env scrub.**
  - Control: in plain git, each of these breaks or redirects the run:
    - `GIT_DIR` (another repo): exit 1.
    - `GIT_OBJECT_DIRECTORY`: exit 1.
    - `GIT_CONFIG_PARAMETERS=garbage`: 128, "bogus format".
    - `GIT_CONFIG_COUNT=1`: 128, "missing config key".
  - With each of those set one at a time, plus `GIT_WORK_TREE`, `GIT_INDEX_FILE` and `GIT_CONFIG_KEY_0`/`VALUE_0`, and with all of them together, `readBack` still returns `tree_match:true, mode:exact`.
  - `gitEnv()` drops `Git_Dir` (case-insensitive) and pins PATH.
  - The real CLI run with `GIT_DIR`, `GIT_CONFIG_PARAMETERS` and `GIT_CONFIG_COUNT` exported is also correct.
- **plan-not-in-log fails closed.**
  - An empty log gives `refused: plan-not-in-log…` with no row written.
  - When the latest row is `plan-stop`, the run is refused.
  - A matching `plan-land` row lets the run through.
- **Reverting a fix makes its test fail** (each mutation was applied and then restored):
  - Remove the gitEnv GIT_ filter: 1 failure (the GIT_DIR/INDEX/WORK_TREE test).
  - Disable bottomBaseError: 2 failures (the partial-landing repro and bottom-base).
  - Remove the planLogMismatch call: 1 failure.
  - Remove the merges.json `verified_base` refusal: 2 failures.
  - Remove the CLI `--verified-base` rejection: 2 failures.

**Acceptance criteria (OVD-857):** all covered by fixture tests:
- An identical-tree squash gives true.
- A tampered amend or an extra commit gives false and stops.
- In a stack of 3 with the middle PR unverified, only the bottom PR lands.
- The log is append-only, and a rewrite or truncation is detected.
- PR state is never treated as proof.

**CI @ exact head:** all 22 non-Vercel checks are green, and SonarCloud and SonarCloud Code Analysis both succeeded. Vercel failed; per policy it's ignored.

**Notes (non-blocking):**
1. `parseArgs` accepts unknown options. `--verified-base=<sha>` (the `=` form) becomes an unknown key `verified-base=<sha>`, and the CLI exits 0. This is harmless because no override path exists any more, but rejecting unknown options would fail closed.
2. The ENOBUFS limit on diffs over 1 MB and the land skill's verdict source are deferred to OVD-893, as the body says.

**Sensitive:** merge-gate tooling. `scripts/merge-readback.mjs` becomes the proof step the land skill requires after `MERGED`. It also changes governance/agent-skill files: `.codex/skills/land/SKILL.md` (steps 12–15 now require a plan-bound read-back before Done) and `docs/recurring-workflows.md`. These changes tighten the gate; none loosen it. No workflows, DB or branch-protection changes.

Draft. No labels changed; not merged.
