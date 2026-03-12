---
name: pull
description: |
  Sync the current OverDrafter issue workspace with the latest upstream main
  state without destroying in-progress work.
---

# pull

Use this skill when an issue workspace needs to sync from the default branch before starting work or before rebasing a PR branch.

## Goal

Refresh local branch state safely without destroying in-progress issue work.

## Steps

1. Confirm `./scripts/symphony-preflight.sh` passes.
2. Determine the current branch.
3. If you are on `main`, update it with:

```bash
git fetch origin
git pull --ff-only origin main
```

4. If you are on an issue branch, rebase or merge from `origin/main` only when the workflow requires it and the branch is clean.
5. Report what was updated and whether conflicts occurred.

## Guardrails

- Do not use destructive reset commands.
- Do not rebase a dirty branch.
- If sync is blocked, report the exact conflict instead of guessing.
