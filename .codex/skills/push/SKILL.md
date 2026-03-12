---
name: push
description: |
  Publish the current OverDrafter issue branch to origin so review and merge
  automation operate on a real remote branch and PR.
---

# push

Use this skill when the current issue branch has a coherent local commit and needs to be published.

## Goal

Push the current issue branch to `origin` so PR automation and merge automation have something real to operate on.

## Steps

1. Confirm `./scripts/symphony-preflight.sh` passes.
2. Confirm the working tree is clean or intentionally staged.
3. Determine the current branch with `git branch --show-current`.
4. Push with upstream tracking:

```bash
git push -u origin "$(git branch --show-current)"
```

5. Report the branch name and whether the push created or updated the remote branch.

## Guardrails

- Never push `main` directly from issue automation.
- If the branch has no local commit yet, stop and use the `commit` skill first.
