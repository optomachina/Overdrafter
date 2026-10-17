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

9. Land the PR. `main` requires `ci` and `provider-go-live`. When strict mode is on (`required_status_checks.strict`; see `docs/runbooks/merge-queue.md` "Operating under strict"), a green PR can also be behind `main` (`mergeStateStatus` `BEHIND`). With strict off `BEHIND` never occurs, so these steps are correct either way. `land_watch.py` does not treat `BEHIND` as blocked, so this step reads it.

   The safety comes from GitHub, not from loops in this skill. The merge is pinned with `--match-head-commit`, so GitHub refuses it if the head moved after the read below, and under strict it also refuses a branch that is behind `main`. Every stop in steps 9 to 11 prints why and exits 1. Never continue to a later step after a stop; the message says what to do next. Shell variables may not survive between blocks, so each block checks what it needs: `PR_NUMBER` from step 5, and in steps 10 and 11 the `HEAD_SHA` this step prints.

   This block reads the state, `mergeStateStatus`, head and required-check results in ONE `gh` call, so the green verdict and the SHA describe the same head:

```bash
: "${PR_NUMBER:?set PR_NUMBER from step 5}"
PR_LINE="$(gh pr view "$PR_NUMBER" --json state,mergeStateStatus,headRefOid,statusCheckRollup --jq '
  . as $pr
  | (["ci", "provider-go-live"] | map(. as $n
      | [($pr.statusCheckRollup // [])[] | select((.name // .context) == $n)]
      | length > 0 and all(.[]; (.conclusion // .state) == "SUCCESS")
    ) | all) as $green
  | "\($pr.state) \($pr.mergeStateStatus) \($pr.headRefOid) \($green)"')" || {
  echo "could not read PR $PR_NUMBER; not merging; stop and report" >&2; exit 1; }
read -r PR_STATE MERGE_STATE HEAD_SHA CHECKS_GREEN <<<"$PR_LINE"
echo "state=$PR_STATE mergeStateStatus=$MERGE_STATE HEAD_SHA=$HEAD_SHA checks_green=$CHECKS_GREEN"
if [[ "$PR_STATE" != "OPEN" ]]; then
  echo "PR is $PR_STATE, not OPEN; not merging; stop and report (if MERGED, run step 11 to verify the merged head)" >&2; exit 1
fi
if [[ ! "$HEAD_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "could not read the PR head; not merging; stop and report" >&2; exit 1
fi
if [[ "$MERGE_STATE" == "DIRTY" ]]; then
  echo "conflict: resolve manually; not merging" >&2; exit 1
fi
if [[ "$MERGE_STATE" == "BEHIND" ]]; then
  gh pr update-branch "$PR_NUMBER" || {
    echo "update-branch failed (conflict or refused): resolve manually; not merging" >&2; exit 1; }
  echo "branch updated; re-run land once checks pass on the new head" >&2; exit 1
fi
if [[ "$CHECKS_GREEN" != "true" ]]; then
  echo "ci and provider-go-live are not both SUCCESS on $HEAD_SHA; not merging (see: gh pr checks $PR_NUMBER --required)" >&2; exit 1
fi
gh pr merge "$PR_NUMBER" --squash --delete-branch --match-head-commit "$HEAD_SHA" || {
  echo "merge of $HEAD_SHA refused or failed (head moved, branch behind main, or requirements not met); not reporting success; re-run land from step 8" >&2; exit 1; }
echo "merge requested for $HEAD_SHA; run step 11 to verify it"
```

   - "conflict: resolve manually": stop and report. Do not update or merge.
   - "branch updated; re-run land once checks pass on the new head": go back to step 8, which waits for `ci` and `provider-go-live` on the new head, then run this step again. This is not `Rework`. Allow at most 3 update rounds per landing (the skill does not count them for you); a branch that is `BEHIND` a fourth time means `main` is moving too fast, so stop and report.
   - "not both SUCCESS": if `gh pr checks --required` shows them still running and the PR is otherwise healthy, use step 10 with the `HEAD_SHA` printed above. If one failed, follow step 8's rule and move the issue back to `Rework`.
   - "merge ... refused or failed": do not report success. Re-run land from step 8. A branch that fell behind is updated by this step on the re-run, and if the PR did merge (for example `gh` failed only while deleting the local branch), this step then reports `MERGED` and step 11 verifies it.

10. Auto-merge, only when step 9 stopped because the checks are still running on an `OPEN` PR that is neither `BEHIND` nor `DIRTY`. It is pinned to step 9's `HEAD_SHA`, and it refuses to run on a `gh` whose `gh pr merge --help` does not list `--match-head-commit`:

```bash
: "${PR_NUMBER:?set PR_NUMBER from step 5}"
if [[ ! "${HEAD_SHA:-}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "set HEAD_SHA to the head step 9 printed; not enabling auto-merge" >&2; exit 1
fi
gh pr merge --help | grep -q -- '--match-head-commit' || {
  echo "this gh cannot pin a merge to a head, so auto-merge would not be pinned; wait for the checks and use step 9" >&2; exit 1; }
gh pr merge "$PR_NUMBER" --auto --squash --delete-branch --match-head-commit "$HEAD_SHA" || {
  echo "could not enable auto-merge pinned to $HEAD_SHA; stop and report" >&2; exit 1; }
echo "auto-merge enabled, pinned to $HEAD_SHA; run step 11 to verify it"
```

    `gh pr merge --help` (gh 2.100.0) lists `--match-head-commit` as a general flag, not limited to the non-`--auto` form. Against a local stub API (no GitHub call), gh 2.100.0 sent the SHA as `expectedHeadOid` in its `enablePullRequestAutoMerge` mutation, which is a field of GitHub's `EnablePullRequestAutoMergeInput`. GitHub refusing to auto-merge a different head has not been exercised against a live PR, so step 11 checks the merged head itself. If your `gh pr merge --help` does not list `--match-head-commit`, auto-merge is not pinned: skip this step and use step 9 once the checks pass. Auto-merge never updates a `BEHIND` branch by itself; step 11 stops on `BEHIND`, and step 9 updates the branch on the re-run.

11. After step 9's merge or step 10's auto-merge, poll GitHub for up to 20 minutes for a terminal state, then verify the merge before reporting success. `PINNED_SHA` is the head the merge was pinned to (`HEAD_SHA` printed by step 9). This loop never updates the branch: `CLOSED`, `BEHIND`, `DIRTY` and a moved head stop and report, and an unreadable poll never counts as merged. On `MERGED`, the same read must show a merge commit and a `headRefOid` equal to `PINNED_SHA`, or the landing is reported as a failure:

```bash
: "${PR_NUMBER:?set PR_NUMBER from step 5}"
PINNED_SHA="${HEAD_SHA:-}"
if [[ ! "$PINNED_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "set HEAD_SHA to the head step 9 printed; cannot verify the merge" >&2; exit 1
fi
PR_STATE=""
for attempt in {1..80}; do
  PR_LINE="$(gh pr view "$PR_NUMBER" --json state,mergeStateStatus,headRefOid,mergeCommit \
    --jq '"\(.state) \(.mergeStateStatus) \(.headRefOid) \(.mergeCommit.oid // "none")"')" || PR_LINE="UNREADABLE"
  read -r PR_STATE MERGE_STATE PR_HEAD MERGE_OID <<<"$PR_LINE"
  echo "poll $attempt: state=$PR_STATE mergeStateStatus=${MERGE_STATE:-?} head=${PR_HEAD:-?} mergeCommit=${MERGE_OID:-?}"
  [[ "$PR_STATE" == "MERGED" ]] && break
  if [[ "$PR_STATE" == "CLOSED" ]]; then
    echo "PR closed without merging; stop and report" >&2; exit 1
  fi
  if [[ "$PR_STATE" == "OPEN" && "$PR_HEAD" != "$PINNED_SHA" ]]; then
    echo "head moved from $PINNED_SHA to $PR_HEAD; the pinned merge will not land it; stop, then re-run land from step 8" >&2; exit 1
  fi
  if [[ "$PR_STATE" == "OPEN" && "$MERGE_STATE" == "BEHIND" ]]; then
    echo "branch is behind main and auto-merge will not update it; stop, then re-run land from step 8" >&2; exit 1
  fi
  if [[ "$PR_STATE" == "OPEN" && "$MERGE_STATE" == "DIRTY" ]]; then
    echo "conflict: resolve manually; stop and report" >&2; exit 1
  fi
  sleep 15
done
if [[ "$PR_STATE" != "MERGED" ]]; then
  echo "not merged after 20 minutes (last state=$PR_STATE); stop and report (see: gh pr checks $PR_NUMBER --required)" >&2; exit 1
fi
if [[ ! "$MERGE_OID" =~ ^[0-9a-f]{40}$ || "$PR_HEAD" != "$PINNED_SHA" ]]; then
  echo "PR merged but NOT verified: merged head $PR_HEAD, pinned $PINNED_SHA, mergeCommit $MERGE_OID; do not mark Done; stop and report" >&2; exit 1
fi
echo "merged and verified: head $PR_HEAD landed as $MERGE_OID"
```

    - The loop does not watch the required checks. A failing check leaves the PR `OPEN` until the wait expires; `gh pr checks --required` then shows whether one failed (move the issue to `Rework`) or is still running (re-run land later).
    - Only "merged and verified" is success. "NOT verified" means GitHub merged a head other than the pinned one or reported no merge commit: report it, and do not mark the issue `Done`.
12. After merge, report:
   - PR URL
   - merge method
   - final status
13. If no acceptance criterion requires post-merge work, update the rolling comment to `Complete` and move the issue to `Done` after step 11 printed "merged and verified".
14. If deployment, live verification, an external operation, or another acceptance criterion remains, record that work and keep the issue in the appropriate active/review state.

## Guardrails

- Do not write new product code while landing.
- Do not land a PR without a real review handoff.
- Do not mark the issue `Done` before step 11 printed "merged and verified" (GitHub shows the PR merged, with a merge commit, at the pinned head).
- Do not mark it `Done` after merge when an acceptance criterion still requires post-merge work.
- Do not leave an issue in `Merging` when required checks are red and implementation changes are needed; move it back to `Rework`.
- Do not move an issue to `Rework` because the branch is behind `main` or a merge was refused as not up to date; step 9 updates the branch, then re-run land.
- Do not merge a head other than the one whose `ci` and `provider-go-live` were both `SUCCESS`, and do not continue past a stop in steps 9 to 11 (a failed `update-branch`, a `DIRTY` branch, a refused merge, or a merged head that differs from the pinned one); stop and report.
