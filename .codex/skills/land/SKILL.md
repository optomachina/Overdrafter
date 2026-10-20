---
name: land
description: |
  Safely land a reviewed OverDrafter PR from the current issue branch when
  canonical authorization and verification gates allow the Merging transition.
---

# land

Use this skill when an OverDrafter issue has a verified review handoff and has been moved to `Merging` under `AGENTS.md`. Its standing development authorization covers routine landing without a fresh approval. Follow `docs/agent-development-control-plane.md` for lifecycle and projection mechanics; protected actions retain their exact authorization requirement.

## Goal

Safely land the already-reviewed PR for the current branch, record the result,
and close the issue automatically when the merge completes all acceptance criteria.

## Steps

1. Confirm `./scripts/symphony-preflight.sh` passes.
2. Determine the current branch:

```bash
git branch --show-current
```

3. Refuse to continue if the branch is `main` or if the working tree is dirty.
4. Ensure the branch is pushed:

```bash
git push -u origin "$(git branch --show-current)"
```

5. Find the PR for the current branch and retain its number so later checks do not depend on the source branch still existing:

```bash
PR_NUMBER="$(gh pr view --json number --jq .number)"
gh pr view "$PR_NUMBER" --json number,url,state,isDraft,mergeStateStatus
```

6. If no PR exists, stop and report that the issue was moved to `Merging` too early.
7. If the PR is still draft, mark it ready:

```bash
gh pr ready
```

8. Land through the strict-mode helper and keep its exit code. `REVIEWED_HEAD` is the full head SHA that the passing review and QA verdict name; never read it from the PR at landing time. The helper handles `main`'s strict branch protection ("require branches to be up to date") end to end:

```bash
REVIEWED_HEAD="<head SHA named by the passing review and QA verdict>"
LAND_EXIT=0
.codex/skills/land/land_strict_merge.sh "$PR_NUMBER" "$REVIEWED_HEAD" || LAND_EXIT=$?
echo "land_strict_merge.sh exit: $LAND_EXIT"
```

   - It reads the PR once and pins its head if it is `REVIEWED_HEAD`. It pins any other head only when that head is `REVIEWED_HEAD` brought up to date by update merges alone and the reviewable diff (`diff_id`, below) is unchanged. A changed diff stops with exit 11, and any other history stops with exit 5. So a re-run re-verifies an update that an earlier run sent but did not see finish, or one made with GitHub's "Update branch" button.
   - If the pinned head does not contain a freshly fetched `origin/main`, it updates the branch with the REST update-branch API, which always merges `main` into the branch and is sent with `expected_head_sha`, so GitHub refuses if the head moved. It never rebases and never force-pushes.
   - It waits for the new head and proves it is exactly that update merge: two parents, the old pin first and a commit already on `main` second. It then compares the reviewable diff (`diff_id`, the sha256 of the pinned `git diff --raw`, the same bytes as `computeDiffId`) of the new head against the newest `main` commit it contains, and of the old head against its merge-base with that commit. It uses that commit, not the last merge's second parent, so a chain whose later merge brings in an older `main` commit cannot hide dropped `main` content. If the diff changed, it stops with exit 11 and does not merge. Do not re-run land at the new head until a passing review and QA verdict exist at that head. If the diff is unchanged, it re-pins and continues. Exit 10 is reserved for the future ovd-merge-gate check (OVD-845) and this helper does not return it.
   - Required checks come from branch protection, failing closed if unreadable. `LAND_REQUIRED_CHECKS` and `LAND_REQUIRED_APP_ID` are fallback-only, enabled explicitly by `LAND_ALLOW_FALLBACK_CHECKS=1`. The latest run per name and required app counts; only `success` passes. For app-less contexts it also reads the latest commit status, and every present source must succeed. Missing checks remain pending. Every poll re-reads the head and stops if it changed.
   - `LAND_DEADLINE` (3600 seconds) bounds the whole run across polls and update rounds. Each gh call and git fetch is bounded by the lesser of `LAND_CALL_TIMEOUT` (60 seconds) and remaining time. `LAND_BASE` defaults to `main`; a non-main base requires setting it explicitly.
   - Each proven update logs its round, old/new heads, fetched base and the newest base commit in the new head; success prints the accumulated update chain (or `none`).
   - Right before merging it re-reads state, head and mergeability, then runs `gh pr merge --squash --match-head-commit <pin>`. If GitHub then reports `BEHIND`, it re-fetches `origin/main` and, only if `main` really moved, does another update round (at most 3 per run).
   - It reports success only when GitHub shows `MERGED` with `headRefOid` equal to the pin and a valid merge commit whose fetched tree equals the pinned head tree. A failed read-back stops with exit 9: do not mark Done, do NOT auto-revert, escalate to Human Review. A failed merge command is verified against the same pin; it never re-reads and re-pins the head. The repo deletes merged branches itself, so there is no `--delete-branch`.
   - Every unreadable, unknown, mismatched or timed-out state stops with `land: STOP: ...`.

9. Route on the exit code and summarize the `land: STOP:` line in the workpad:

| Exit | Meaning | Action |
| --- | --- | --- |
| 0 | Merged and verified against the pinned head | Continue to step 12 |
| 2 | Usage or precondition (not OPEN, draft, wrong base, missing tool, malformed `REVIEWED_HEAD`) | Stop; fix the precondition, then re-run from step 8 |
| 3 | A required check failed on the pinned head | Move to `Rework` |
| 4 | A bounded wait timed out (head, checks, mergeability, merge confirmation) | Stay in `Merging`; report, then re-run from step 8 |
| 5 | Head changed, head is neither `REVIEWED_HEAD` nor a proven update of it, malformed SHA, unexpected history, unknown state, merge refused or not verified | Stop; do not mark `Done`; move to `Human Review` and report |
| 6 | Merge conflict with `main` | Move to `Rework` |
| 7 | `main` kept moving through 3 update rounds | Stay in `Merging`; report, then re-run from step 8 |
| 8 | Overall deadline exceeded | Stay in `Merging`; if the message says the merge command was sent, check the PR by hand before re-running |
| 9 | Merged but tree read-back failed | Do not mark `Done`, do not revert; move to `Human Review` |
| 11 | The head is an update of `REVIEWED_HEAD` (made by this run or earlier) and the PR diff changed | Stay in `Merging`; do not merge. Do not re-run land at the new head until a passing review and QA verdict exist at that head; then re-run with that head as `REVIEWED_HEAD` |
| other | Unexpected failure | Treat as 5 |

10. A re-run starts from step 8 with the same `REVIEWED_HEAD`, not step 4: after an update-branch the local branch is behind its remote, so step 4's push would be rejected. A re-run reads the head afresh from GitHub and pins it only if it is `REVIEWED_HEAD` or a proven, diff-unchanged update of it, so an update an earlier run sent is verified before any merge. A PR that already merged stops at the precondition check (exit 2) instead of verifying a head against itself, so check a merged PR's head by hand against the SHA the earlier run pinned.
11. `python3 .codex/skills/land/land_watch.py` is an optional read-only status view. It does not merge and does not replace step 8. It never reports mergeable for behind, closed, draft or conflicted PRs.

12. Read the merge back. `MERGED` is PR state, not proof. After exit 0, the helper's last line is `land: merged and verified: head <pin> landed as <squash sha>`. Pass that `<squash sha>`, and pass `REVIEWED_HEAD` as `<verified head sha>`, because the plan binds the head its verdict names. A pin that the helper brought up to date has an unchanged `diff_id`, so the rebased read-back checks it against `REVIEWED_HEAD`. Run `git fetch origin main`, then run `node scripts/merge-readback.mjs readback --repo . --main origin/main --merge-sha <squash sha> --verified-head <verified head sha> --log <stack tsv> --plan <plan json> --pr "$PR_NUMBER" --prior <latest digest json> --digest-out <digest json>` as described in [the merge plan procedure](../../../docs/recurring-workflows.md#release-bot-merge-plan-and-decision-log). Only this plan-bound form counts as proof; `readback` without `--log` is a diagnostic. Whatever the exit code, record the digest the command wrote to `--digest-out` (it is written on a pass and on a `tree_match=false` stop) in the merge-plan comment before doing anything else, and use that recorded digest as `--prior` on the next `plan`, `readback`, `readback-run`, or `stop-ack` for this log. A refusal writes no digest and appends nothing, so the previous recorded digest stays current. If it exits non-zero (`tree_match=false`, including `verified-base-not-ancestor-of-head`, `bottom-base-differs-from-merge-base`, or `lower-merge-not-ancestor-of-parent`, or a refusal because the PR is not in the plan at that SHA, `plan.json` does not match the log's `plan-land` or `plan-digest` row, the log no longer matches the latest saved digest, or an earlier stop is unacknowledged), stop, flag it to Grok Bot, and do not auto-revert. Merge the next PR in the stack only after this read-back passes.
13. After merge and read-back, report:
   - PR URL
   - merge method
   - merge SHA and read-back result
   - final status
14. If no acceptance criterion requires post-merge work, update the rolling comment to `Complete` and move the issue to `Done` after GitHub confirms the merge and the read-back passes.
15. If deployment, live verification, an external operation, or another acceptance criterion remains, record that work and keep the issue in the appropriate active/review state.

## Guardrails

- Do not write new product code while landing.
- Do not land a PR without a real review handoff.
- Do not mark the issue `Done` before GitHub shows the PR merged.
- Do not mark it `Done` after merge when an acceptance criterion still requires post-merge work.
- Do not leave an issue in `Merging` when required checks are red and implementation changes are needed; move it back to `Rework`.
- Never rebase or force-push to update a PR.
- Never merge without `--match-head-commit`; never use `--admin`.
- A "behind" or "not up to date" block is never a reason for `Rework`; it means update and re-check (step 8 does this).
- When that update changes the diff, stop. Do not merge the new head in the same run. Do not re-run land at the new head until a passing review and QA verdict exist at that head.
- Pass as `REVIEWED_HEAD` only a SHA that a passing review and QA verdict name, never the PR's current head read at landing time.
- Never re-pin by re-reading the head after a failed merge; verify against the pin the run already holds.

## First live run

Until a supervised first landing on a low-risk PR is recorded in the PR or Linear (OVD-889 checklist), run the helper only under supervision by Release.
