---
name: land
description: |
  Safely land an approved OverDrafter PR from the current issue branch after
  Human Review has moved the issue to Merging.
---

# land

Use this skill when an OverDrafter issue has already passed Human Review and has been moved to `Merging`.

## Goal

Safely land the already-reviewed PR for the current branch and only then allow the issue to move to `Done`.

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

5. Find the PR for the current branch:

```bash
gh pr view --json number,url,state,isDraft,mergeStateStatus
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

11. After merge, report:
   - PR URL
   - merge method
   - final status

## Guardrails

- Do not write new product code while landing.
- Do not land a PR without a real review handoff.
- Do not mark the issue `Done` until GitHub shows the PR merged.
- Do not leave an issue in `Merging` when required checks are red and implementation changes are needed; move it back to `Rework`.
