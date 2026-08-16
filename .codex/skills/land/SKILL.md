---
name: land
description: |
  Safely land an approved OverDrafter PR from the current issue branch after
  Human Review has moved the issue to Merging.
---

# land

Use this skill when an OverDrafter issue has already passed Human Review and has been moved to `Merging`.

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

9. Land the PR:

```bash
gh pr merge --squash --delete-branch
```

10. If checks are still running but the PR is otherwise healthy, prefer enabling auto-merge instead:

```bash
gh pr merge --auto --squash --delete-branch
```

11. After either merge command, wait for required checks and poll GitHub for up to 20 minutes until the PR state is explicitly `MERGED`:

```bash
for attempt in {1..80}; do
  PR_STATE="$(gh pr view "$PR_NUMBER" --json state --jq .state)"
  [[ "$PR_STATE" == "MERGED" ]] && break
  [[ "$PR_STATE" == "CLOSED" ]] && exit 1
  CHECK_EXIT=0
  gh pr checks "$PR_NUMBER" --required >/dev/null || CHECK_EXIT=$?
  [[ "$CHECK_EXIT" -ne 0 && "$CHECK_EXIT" -ne 8 ]] && exit 1
  sleep 15
done
[[ "$(gh pr view "$PR_NUMBER" --json state --jq .state)" == "MERGED" ]]
```

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
