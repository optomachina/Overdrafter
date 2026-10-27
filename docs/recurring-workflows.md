# Recurring Contributor and Codex Workflows

Last updated: August 15, 2026

## Purpose

This guide captures the repeatable OverDrafter motions that should not depend on a custom prompt or prior chat context. Use it for planning, verification-lane selection, PR evidence, and Symphony handoff.

## Canonical inputs for recurring work

Use the root source-of-truth hierarchy first:

1. `PRD.md`
2. `PLAN.md`
3. `ROADMAP.md`
4. `ARCHITECTURE.md`
5. `TEST_STRATEGY.md`
6. `ACCEPTANCE_CRITERIA.md`
7. specialized docs such as `docs/debugging-workflows.md`
8. `README.md`

`ROADMAP.md` precedence is limited to sequencing and classification. Use the
applicable architecture, security/privacy, test, acceptance, and specialized
documents for implementation constraints.

Use repo-local skills when the task is procedural rather than policy-oriented:

- `pull` for safely syncing the current branch or worktree
- `commit` for creating the focused issue commit after verification
- `push` for pushing the current issue branch and ensuring the PR exists
- `linear` for workpad updates, verification comments, and state transitions
- `land` only when an issue is already in `Merging`

Do not rely on pasted handoff snippets when the repo already documents the motion locally.

## Start of issue flow

For any nontrivial issue:

1. Confirm you are in the real OverDrafter repo root.
2. Run `./scripts/symphony-preflight.sh`.
3. Confirm you are not implementing on `main`.
4. Read the relevant source-of-truth docs and any local `AGENTS.override.md`.
5. Inspect the code or docs you plan to change before editing.
6. Make a short plan if the change is not trivial.

For Symphony issue runs:

- use this repo's `WORKFLOW.md`
- let the workspace hook switch to the deterministic issue branch
- keep the diff scoped to the current Linear issue

Before coding or opening a PR, check the issue/PR ownership rule in `AGENTS.md`:
the named issue must own this bounded change, not merely the larger release goal.
If another change can be merged independently, create its child issue first. A
direct repair of the same change is the narrow exception; document it when a
follow-up PR is needed after the original PR has merged. Do not reuse a release-
outcome parent's ID for a new source PR.

## Choose the lightest verification that still proves the change

See `TEST_STRATEGY.md` for the policy and `docs/debugging-workflows.md` for the lane details.

`bash scripts/preflight.sh test` locally skips three Docker-dependent OVD-417 validation cases when Docker is unavailable; CI always runs them (a non-empty `CI` or `GITHUB_ACTIONS` disables the skip).

Use these defaults:

- docs-only or repo-workflow documentation changes: verify the referenced commands, file paths, branch rules, and skill names still match the repo; rerun `./scripts/symphony-preflight.sh`; if the change touches PR workflow or validation scripts, run `npm run validate:pr-body` against passing and failing sample input; run broader app or worker verification only if the diff changes scripts, commands, or behavior
- cosmetic or fixture-friendly client UI changes: start with Lane A checks and the UI tuning lane
- UI behavior changes that need browser confirmation: use Lane B and add fixture mode or fast E2E coverage depending on whether real auth/data matters
- auth, RLS, membership, routing, and Supabase-backed data bugs: use the production-realistic lane
- reproducible browser regressions and smoke coverage updates: use the fast E2E lane
- worker, async processing, quote orchestration, or cross-package changes: verify the affected package early, then use `npm run verify` before handoff
- schema or migration changes: validate the migration path, run affected tests, and use the release-confidence lane before handoff

If a nontrivial change reaches handoff without `npm run verify`, the PR and workpad must explain why a narrower command set was sufficient.

## Verification evidence to reuse in PRs and workpads

Always record:

- the exact commands run
- whether each command passed, failed, or was intentionally skipped
- which debugging lane was used when browser or Supabase validation mattered
- whether the live PR body was validated with `npm run validate:pr-body` when the helper flow was used
- tests added or updated, or why none were practical
- docs updated, or why no doc update was needed
- migration impact and rollback notes when relevant
- any unrelated baseline failures separately from issue-scoped failures

Useful supporting evidence includes screenshots, fixture URLs, diagnostics snapshots, and Playwright artifacts when they materially support the change.

## Optional PR body helper flow

Do not open or refresh a PR with placeholder template text.

When you want a structured PR body and consistent template formatting, use this sequence:

1. Write a structured JSON payload for `npm run render:pr-body -- <path-to-json>`.
2. Include concrete values for `Summary`, `Problem`, `Scope`, `Verification`, `Tests`, `Migration notes`, `Rollback / risk notes`, and `Documentation`. Add `proof` lines for the `## Proof` section that `scripts/proof-check.mjs` reads (`Test: <path>`, `Command: <cmd>` with a fenced output block, `Live: <url>`, or `Screenshot: <image/url>`; UI changes need a Screenshot). The proof check runs in report mode and is not a required check; see `docs/proof-check.md` for the Command rules and JSON report.
3. Render the markdown to a temporary file, add the issue ownership answer from the PR template and an honest pending-review status, then validate it locally with `npm run validate:pr-body -- <path-to-rendered-markdown>`.
4. Create the PR with `gh pr create --base main --body-file <path-to-rendered-markdown>` or refresh it with `gh pr edit --body-file <path-to-rendered-markdown>`.
5. After hosted checks and reviews finish on the final head, replace pending review status with the findings and actual coverage, update the PR body, and optionally validate it with `gh pr view --json body --jq .body | npm run validate:pr-body -- --stdin`.

The renderer supplies the core evidence sections, not the ownership and review
checklist in `.github/pull_request_template.md`; add those answers manually.
Record the Sonar issue findings (including an observed zero) and which bot
reviews actually covered the final head. A passing badge, rate limit, or older
review does not stand in for inspecting findings and open threads.

Renderer input shape:

```json
{
  "summary": ["Short change summary"],
  "problem": ["Why the PR exists"],
  "scope": ["What changed", "What did not change"],
  "verification": {
    "allPassed": true,
    "usedVerify": false,
    "usedNarrowVerification": true,
    "hasOtherVerification": true,
    "commands": ["npm run test -- scripts/render-pr-body.test.mjs"],
    "results": ["Narrower verification was sufficient because no runtime code changed."],
    "baselineFailures": []
  },
  "proof": ["- Test: scripts/render-pr-body.test.mjs"],
  "tests": ["Added or updated test coverage, or why none were practical."],
  "migrationNotes": {
    "hasImpact": false,
    "details": []
  },
  "rollbackRisks": ["Primary risk and rollback path."],
  "documentation": {
    "updated": true,
    "details": ["Docs updated in the same change."]
  }
}
```

## Handoff sequence

Before moving a validated issue to `Human Review` with rolling-comment status
`Ready for review`:

1. Ensure the diff is coherent and scoped.
2. Run the required verification and record the outcomes.
3. Run `./scripts/symphony-preflight.sh` again.
4. Use the `commit` skill for the local git commit.
5. Use the `push` skill to publish the branch and ensure the PR exists with a concrete description that matches the diff. Use a rendered `--body-file` when the helper flow is useful.
6. If you used the helper flow, validate the live PR body with `gh pr view --json body --jq .body | npm run validate:pr-body -- --stdin`.
7. Inspect Sonar issues and review threads at the final head; record actual CodeRabbit, Codex, and other bot coverage or unavailability in the PR body. Resolve or explicitly disposition actionable findings before handoff.
8. Use the `linear` skill to add the branch, PR URL, changed files, verification evidence, and any PR-body helper validation result to the issue workpad or comments.
9. Move the issue to `Human Review` only after the commit, push, PR, workpad
   evidence, and every required validation checkbox is checked.

Following `AGENTS.md`, use Linear `Blocked` when currently admitted work cannot
proceed because of a decision, dependency, or decomposition. Use `Backlog` for
deferred or dependency-sequenced work that is not currently eligible. Neither
belongs in `Human Review`, which is reserved for work that satisfies the
complete validation, linked-PR, and `Ready for review` rolling-comment gate in
`AGENTS.md`.

If verification finds unrelated baseline failures outside the issue scope, document them precisely and still hand off. If the current change introduced the failure, keep the issue in an implementation state until it is resolved.

## Merge sequence

Use the `land` skill only when the issue is already in `Merging` and a real PR
exists. After GitHub shows the approved PR merged and the
[merge read-back](#release-bot-merge-plan-and-decision-log) passes, record the
merge and move the issue to `Done` automatically unless an acceptance criterion
still requires deployment, live verification, an external operation, or other
post-merge work.

The drafted merge queue for `main` (required checks, settings, re-run policy,
rollback, and the rule that every required check triggers on `merge_group`)
lives in [docs/runbooks/merge-queue.md](runbooks/merge-queue.md). A merge queue
needs an organization-owned repo, so it is not applied. The runbook also covers
the applicable fallback, Option B (`strict: true` up to date checks), which
Blaine approved on 2026-10-16 together with `enforce_admins`. Both are now in
force (confirmed by a protection read-back on 2026-10-16), so an out-of-date PR
cannot merge until it is brought current. The read-only command in the
runbook's Status paragraph re-verifies the live settings. The `land` skill
handles strict mode through `.codex/skills/land/land_strict_merge.sh`
(OVD-889). An update that changes the reviewable diff stops without merging
(exit 11). Do not re-run land at the new head until a passing review and QA
verdict exist at that head. An unchanged diff is re-checked and merged in
that run. As a manual fallback, bring an
out-of-date PR current with `gh pr update-branch` and re-check it by hand
before `gh pr merge --match-head-commit`.

### Release bot merge plan and decision log

Every Release bot merge plan carries a show-me-your-work TSV decision log
(OVD-857). `scripts/merge-readback.mjs` builds the plan and the read-back rows
from local git only. It never merges, pushes, fetches, moves a ref, or touches a
remote, so run `git fetch origin main` yourself before reading back. The rebased
read-back uses `git merge-tree --write-tree` (git 2.38 or later), which writes
loose objects but no refs.

The script runs on Linux or macOS only: git is resolved from `/usr/bin`, `/bin`
or `/usr/local/bin`, never from `PATH`. On Windows it refuses to start; run it
inside WSL. A missing or failing git, or a SHA that names a non-commit object,
is an error (exit 2, and no row is written for that read-back), never a
`merge-commit-missing` or not-an-ancestor result. A lower PR's logged merge that
is missing from the local clone stops with `lower-merge-missing`.

Keep one log per stack, for example `.audit/merge-plans/<stack>.tsv`, and append
every plan cycle for that stack to the same file. The stop guard in step 4 only
sees its own log. Only one operator runs this procedure at a time. The log has
no lock, so two operators planning or reading back at once can interleave rows
and race past the stop guard.

1. **Plan bottom-up.** Write `stack.json` with the commit the bottom PR's branch
   starts from and the PRs bottom-up at their current head SHAs
   (`{"base":"<sha>","prs":[{"pr":101,"head_sha":"…"},{"pr":102,"head_sha":"…"}]}`),
   and the OVD-845 verdict lookup
   (`{"101":{"sha":"…","verdict_ref":"…","valid":true}}`). The plan lands only the
   contiguous verified run and stops at the first PR with no verdict, an invalid
   verdict, or a verdict for an older SHA. A duplicate or missing PR number, or a
   `base` that is not a hex SHA, fails the plan. Save stdout as the plan:
   `node scripts/merge-readback.mjs plan --stack stack.json --verdicts verdicts.json --log .audit/merge-plans/<stack>.tsv --digest-out digest.json > plan.json`
2. **Merge one PR.** For each PR in `plan.land`, bottom-up, use the normal
   squash pinned with `--match-head-commit <verified head sha>`.
3. **Read that merge back before merging the next PR.** A queued merge or an
   armed auto-merge is not a merge, and PR state alone is never enough. Run
   `git fetch origin main`, then read the landed merge back:
   `node scripts/merge-readback.mjs readback-run --repo . --main origin/main --merges merges.json --plan plan.json --log .audit/merge-plans/<stack>.tsv --prior digest.json --digest-out digest.json`
   with `merges.json` listing only the merges landed so far, for example
   `[{"pr":101,"merge_sha":"…"}]` after the first merge. Passed merges are
   skipped on later runs. Merge the next PR only after it exits 0 with `tree_match=true`, then
   repeat steps 2–3. Never merge the whole stack and then read it back: a stop
   leaves the PRs above it unmerged.
   `--plan` is required. The verified head SHA and verdict ref come from
   `plan.json`, and so does the verified base: the plan's `base` for the bottom
   PR, and the verified head of the PR below for every PR above it. There is
   no override: a `merges.json` entry that carries `"verified_base"` is refused,
   and the CLI rejects `--verified-base`. The run refuses (exit 1, no row
   written) any PR outside the plan's `land` list, a `head_sha` other than the
   verified one, or a merge out of bottom-up order. It also refuses a merge above
   a PR that has no passing read-back in the log, and a `plan.json` that does not
   match the log: for each merge, the latest plan row for that PR in the same log
   must be a `plan-land` row with the same `head_sha` and `verdict_ref`. A
   hand-written or edited `plan.json`, or one superseded by a later `plan-stop`
   for that PR, is refused. `plan` also logs a `plan-digest` row: SHA-256 of
   the base, ordered `land` list, and `stop`. A different digest, including a
   dropped lower PR or changed base, is refused with `plan-digest-mismatch`.
   Each lower PR's merge SHA must be an ancestor of the upper merge's parent;
   otherwise read-back stops with `lower-merge-not-ancestor-of-parent`. A
   PR that already read back true at the same head and merge SHA is skipped
   with no new row; the same PR and head at a different merge SHA is refused.
   SHAs must be hex, and `--main` must not start with `-`. Without `--main`, the
   script uses `origin/main` when it exists, otherwise local `main`. A stale
   local `main` would otherwise report `not-on-main` for a good merge.

   A merge passes in one of two ways. It is a single-parent commit on `main`
   whose parent is the verified base and whose tree equals the verified head's
   tree. In rebased mode, it passes only when the tree produced by
   `git merge-tree --write-tree --merge-base=<verified base> <merge parent> <verified head>`
   equals the merge commit's tree. The patch-id is a context-free (`-U0`)
   diagnostic logged for forensics; it never passes, stops, or skips a merge. A commit
   with the verified head's tree on top of any other parent fails, because it
   would silently revert what landed in between. In both cases the verified
   base must be an ancestor of the verified head
   (`git merge-base --is-ancestor`). If it is not, the read-back fails with
   `verified-base-not-ancestor-of-head`. This catches a base set to the current
   `main` tip instead of the commit the branch started from, which would
   otherwise pass a squash that reverts `main` since that start. For the bottom
   PR, the plan's `base` must also equal `git merge-base <head> <main>`, or the
   read-back fails with `bottom-base-differs-from-merge-base`. That catches an
   ancestor such as `head~1` that would hide the commits below it and pass a
   partial landing.

   Every git subprocess runs with all `GIT_*` variables removed from its
   environment (`GIT_DIR`, `GIT_INDEX_FILE`, `GIT_WORK_TREE`,
   `GIT_OBJECT_DIRECTORY`, `GIT_CONFIG_PARAMETERS`, and the rest), so a hook or
   wrapper cannot point the read-back at another repo than `--repo`.

   For a single merge, use
   `readback --repo . --main origin/main --merge-sha <sha> --verified-head <sha> --log <tsv> --plan plan.json --pr <n> --prior digest.json --digest-out digest.json`.
   Only the plan-bound read-back (`readback-run`, or `readback` with `--log`,
   `--plan`, and `--pr`) counts as proof that a merge landed. `readback`
   without `--log` is a diagnostic: it does not check plan order, writes no
   row, and derives the base as `git merge-base <merge parent> <head>`, which
   is only right for an unstacked PR.

   A restacked PR has a new head SHA, so it needs a fresh verdict and a fresh
   plan. If it is now the bottom PR, set `stack.json`'s `base` to
   `git merge-base <new head> origin/main` once the PR below has squashed in.
   Do not reuse the old base or the old head of the PR below: that commit is no
   longer an ancestor of the new head, so the read-back fails.
4. **Stop on `tree_match=false`.** The run stops at that row (exit 1) and later
   merges are not reported as landed. Flag it to Grok Bot, who brings it to
   Blaine. Do not auto-revert. While the log's latest failed read-back is
   unacknowledged, `plan`, `readback`, and `readback-run` refuse to run on that
   log. After Blaine decides, record the decision with
   `stop-ack --log <tsv> --pr <n> --by <who> --note "<decision>"`.
5. **Keep the log append-only.** Pass `--digest-out digest.json` on `plan`,
   `readback`, `readback-run`, and `stop-ack`. After every plan, read-back, and
   stop acknowledgement, record the latest digest outside the log in the
   merge-plan comment. Pass that saved digest as `--prior digest.json` on the
   next command. Before relying on the log, run
   `verify-log --log <tsv> --prior digest.json` against the latest saved digest.
   It fails if any earlier byte was rewritten or truncated. It proves continuity
   only from the saved digest onward and cannot detect edits made before the
   digest was taken. Correct a wrong row with a new row and never edit history.
   Each row is one append. The script refuses to append after a partial last
   row, such as one left by a crash with no trailing newline. Inspect that row,
   then append a newline yourself and continue.

Template (`init-log --log <tsv>` writes the header row; columns are exact):

```tsv
ts	pr	head_sha	patch_id	verdict_ref	action	merge_sha	tree_match	result
2026-10-16T09:00:00.000Z	101	<head sha>		<verdict ref>	plan-land			verified-at-head
2026-10-16T09:00:00.000Z	102	<head sha>		<verdict ref>	plan-stop			stop: verdict-not-valid
2026-10-16T09:00:00.000Z					plan-digest			plan-sha256:<digest>
2026-10-16T09:20:00.000Z	101	<head sha>	<patch-id>	<verdict ref>	readback	<merge sha>	true	landed (exact)
```

`action` is `plan-land`, `plan-stop`, `plan-digest`, `readback`, or `stop-ack`. Cells are
single-line: tabs and newlines become spaces. A cell that starts with `=`, `+`,
`-`, or `@` gets a leading `'` so spreadsheets do not run it as a formula, which
means a value like `-1` is logged as `'-1`. Attach the TSV, or link it, in the
merge plan.
