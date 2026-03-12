---
name: open-pr
description: |
  Create or refresh the GitHub pull request for the current OverDrafter issue
  branch before handoff to Human Review.
---

# open-pr

Use this skill when an OverDrafter issue branch is committed, pushed, and ready for Human Review.

## Goal

Create or update the PR for the current branch so `Human Review` and `Merging` correspond to a real GitHub review flow.

## Steps

1. Confirm `./scripts/symphony-preflight.sh` passes.
2. Confirm the branch is not `main`.
3. Use the `push` skill first if the branch is only local.
4. Check whether a PR already exists:

```bash
gh pr view --json number,url,state,isDraft,headRefName,baseRefName
```

5. If no PR exists, create one against `main`:

```bash
gh pr create --base main
```

6. In the PR body, include:
   - problem
   - scope
   - verification
   - docs updated
   - risks or residual blockers
7. Report the PR URL back to the issue thread or tracker comment.

## Guardrails

- Do not create duplicate PRs for the same branch.
- Do not move an issue to `Human Review` until the PR exists.
- If GitHub auth is missing, stop and report that explicitly.
