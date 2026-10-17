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

8. Wait for the PR to be mergeable:

```bash
python3 .codex/skills/land/land_watch.py
```

   - If `land_watch.py` reports failing required checks, stop landing work, summarize the failing checks in the workpad, and move the issue back to `Rework`.
   - If the PR is only waiting on in-flight checks, remain in `Merging` and prefer auto-merge when available.
   - If the PR is blocked because it was moved to `Merging` too early, move it back to `Human Review`.

9. Land the PR. `main` requires `ci` and `provider-go-live`. When strict mode is on (`required_status_checks.strict`; see `docs/runbooks/merge-queue.md` "Operating under strict"), a green PR can also be behind `main` (`mergeStateStatus` `BEHIND`). When strict mode is off, `BEHIND` never occurs and the update block below is simply skipped, so these steps are correct either way. `land_watch.py` does not treat `BEHIND` as blocked, so read the merge state here before merging. In the shell blocks, `exit 1` means stop landing and report; never continue to the next step after one:

```bash
MERGE_STATE="$(gh pr view "$PR_NUMBER" --json mergeStateStatus --jq .mergeStateStatus)"
echo "MERGE_STATE=$MERGE_STATE"
```

   - If `MERGE_STATE` is `DIRTY`, the branch conflicts with `main`. Stop and report "conflict: resolve manually". Do not update or merge.
   - If `MERGE_STATE` is `BEHIND`, or a merge is refused because the head branch is not up to date (another PR merged first), update the branch. `gh pr update-branch` is asynchronous, so wait for the head to move. This block fails closed: a non-zero exit from `update-branch` (for example a conflict) or a head that never moves stops landing, so it never falls through to a merge or a success report:

```bash
OLD_HEAD="$(gh pr view "$PR_NUMBER" --json headRefOid --jq .headRefOid || true)"
[[ -n "$OLD_HEAD" ]] || { echo "could not read the PR head; stop and report" >&2; exit 1; }
if ! gh pr update-branch "$PR_NUMBER"; then
  echo "update-branch failed (conflict or refused): resolve manually; not merging" >&2
  exit 1
fi
NEW_HEAD=""
for attempt in {1..24}; do
  NEW_HEAD="$(gh pr view "$PR_NUMBER" --json headRefOid --jq .headRefOid || true)"
  [[ -n "$NEW_HEAD" && "$NEW_HEAD" != "$OLD_HEAD" ]] && break
  sleep 5
done
if [[ -z "$NEW_HEAD" || "$NEW_HEAD" == "$OLD_HEAD" ]]; then
  echo "head did not move within 2 minutes of update-branch; stop and report, not merging" >&2
  exit 1
fi
```

   - After an update, repeat step 8's wait so `ci` and `provider-go-live` pass on the NEW head. A "not up to date" block means update and re-wait; it never moves the issue to `Rework`, which is only for failing checks that need implementation changes. Allow at most 3 update rounds per landing; a `main` that keeps moving past that is a blocker to report.
   - Merge only a head whose required checks are green, pinned to that head. Read the head SHA and the required-check result in ONE `gh` call so both describe the same head (the local branch is stale after an update), then merge with `--match-head-commit` so GitHub refuses to land any other head:

```bash
ROLLUP="$(gh pr view "$PR_NUMBER" --json headRefOid,statusCheckRollup --jq '
  . as $pr
  | (["ci", "provider-go-live"] | map(. as $n
      | [$pr.statusCheckRollup[] | select((.name // .context) == $n)]
      | length > 0 and all(.[]; (.conclusion // .state) == "SUCCESS")
    ) | all) as $green
  | "\($pr.headRefOid) \($green)"' || true)"
HEAD_SHA="${ROLLUP%% *}"
CHECKS_GREEN="${ROLLUP##* }"
echo "HEAD_SHA=$HEAD_SHA CHECKS_GREEN=$CHECKS_GREEN"
if [[ -n "$HEAD_SHA" && "$CHECKS_GREEN" == "true" ]]; then
  gh pr merge "$PR_NUMBER" --squash --delete-branch --match-head-commit "$HEAD_SHA" || {
    echo "merge refused (head moved, branch not up to date, or checks not satisfied); re-read MERGE_STATE: BEHIND means run the update block and this block again, anything else means stop and report" >&2
    exit 1
  }
else
  echo "ci and provider-go-live are not both SUCCESS on ${HEAD_SHA:-<unknown head>}; not merging directly" >&2
fi
```

   - If `CHECKS_GREEN` is not `true`: checks that are still running go to step 10 (keep `HEAD_SHA`); failing checks follow step 8's rule and go back to `Rework`.

10. If checks are still running but the PR is otherwise healthy, prefer enabling auto-merge pinned to the same head (`HEAD_SHA` from step 9's single `gh` call). Auto-merge does not update an out-of-date branch by itself: it waits until someone does, so run step 9's update block first when the PR is `BEHIND`, then read `HEAD_SHA` again with step 9's `gh` call:

```bash
gh pr merge "$PR_NUMBER" --auto --squash --delete-branch --match-head-commit "${HEAD_SHA:?read HEAD_SHA in step 9 first}"
```

    `gh pr merge --help` (gh 2.100.0) lists `--match-head-commit` with no restriction to the non-`--auto` form, and GitHub's `EnablePullRequestAutoMergeInput` has an `expectedHeadOid` field that this gh build's auto-merge input carries, so the flag is passed with `--auto`. It was not exercised against a live PR, so step 11 also checks the head itself and never relies on the pin alone.

11. After either merge command, poll GitHub for up to 20 minutes until the PR state is explicitly `MERGED`. Every poll reads the state, `mergeStateStatus` and the head and prints them, so a `BEHIND` or `DIRTY` PR is handled instead of waited out silently. `PINNED_SHA` is the head the merge or auto-merge was pinned to (`HEAD_SHA` from step 9):

```bash
PINNED_SHA="${HEAD_SHA:?read HEAD_SHA in step 9 first}"
UPDATES=0
for attempt in {1..80}; do
  PR_LINE="$(gh pr view "$PR_NUMBER" --json state,mergeStateStatus,headRefOid --jq '"\(.state) \(.mergeStateStatus) \(.headRefOid)"' || true)"
  read -r PR_STATE MERGE_STATE PR_HEAD <<<"$PR_LINE"
  echo "poll $attempt: state=$PR_STATE mergeStateStatus=$MERGE_STATE head=$PR_HEAD"
  [[ "$PR_STATE" == "MERGED" ]] && break
  if [[ "$PR_STATE" == "CLOSED" ]]; then
    echo "PR closed without merging; stop and report" >&2
    exit 1
  fi
  if [[ "$MERGE_STATE" == "DIRTY" ]]; then
    echo "conflict: resolve manually (branch conflicts with main); stop and report" >&2
    exit 1
  fi
  if [[ -n "$PR_HEAD" && "$PR_HEAD" != "$PINNED_SHA" ]]; then
    echo "head moved from $PINNED_SHA to $PR_HEAD after the merge was pinned; stop and re-run from step 8" >&2
    exit 1
  fi
  if [[ "$MERGE_STATE" == "BEHIND" ]]; then
    UPDATES=$((UPDATES + 1))
    if (( UPDATES > 3 )); then
      echo "branch fell behind main again after 3 updates; stop and report" >&2
      exit 1
    fi
    if ! gh pr update-branch "$PR_NUMBER"; then
      echo "update-branch failed (conflict or refused): resolve manually; not merging" >&2
      exit 1
    fi
    NEW_HEAD=""
    for w in {1..24}; do
      NEW_HEAD="$(gh pr view "$PR_NUMBER" --json headRefOid --jq .headRefOid || true)"
      [[ -n "$NEW_HEAD" && "$NEW_HEAD" != "$PR_HEAD" ]] && break
      sleep 5
    done
    if [[ -z "$NEW_HEAD" || "$NEW_HEAD" == "$PR_HEAD" ]]; then
      echo "head did not move within 2 minutes of update-branch; stop and report" >&2
      exit 1
    fi
    PINNED_SHA="$NEW_HEAD"
    gh pr merge "$PR_NUMBER" --auto --squash --delete-branch --match-head-commit "$PINNED_SHA" || {
      echo "could not re-pin auto-merge to the new head $PINNED_SHA; stop and report" >&2
      exit 1
    }
    continue
  fi
  CHECK_EXIT=0
  gh pr checks "$PR_NUMBER" --required >/dev/null || CHECK_EXIT=$?
  [[ "$CHECK_EXIT" -ne 0 && "$CHECK_EXIT" -ne 8 ]] && exit 1
  sleep 15
done
[[ "$(gh pr view "$PR_NUMBER" --json state --jq .state)" == "MERGED" ]]
```

    - A `BEHIND` PR during the wait (another PR merged first) stalls auto-merge. The loop updates the branch (at most 3 times), waits for the head to move, re-pins auto-merge to the new head and keeps waiting while the required checks rerun on it.
    - `DIRTY` stops with "conflict: resolve manually". A failed `update-branch`, a head that never moves, or a head that changed to something other than the one pinned also stop.
    - If required checks fail, the PR closes without merging, or the bounded wait expires, stop and report the blocker.
12. After merge, report:
   - PR URL
   - merge method
   - final status
13. If no acceptance criterion requires post-merge work, update the rolling comment to `Complete` and move the issue to `Done` after GitHub confirms the merge.
14. If deployment, live verification, an external operation, or another acceptance criterion remains, record that work and keep the issue in the appropriate active/review state.

## Guardrails

- Do not write new product code while landing.
- Do not land a PR without a real review handoff.
- Do not mark the issue `Done` before GitHub shows the PR merged.
- Do not mark it `Done` after merge when an acceptance criterion still requires post-merge work.
- Do not leave an issue in `Merging` when required checks are red and implementation changes are needed; move it back to `Rework`.
- Do not move an issue to `Rework` because the branch is behind `main` or a merge was refused as not up to date; update the branch and re-wait.
- Do not merge a head other than the one whose `ci` and `provider-go-live` were both `SUCCESS`, and do not continue to a merge or report success after a failed `update-branch`, a head that never moves, or a `DIRTY` branch; stop and report.
