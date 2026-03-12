---
name: open-pr
description: |
  Legacy compatibility wrapper for explicit PR operations. Prefer the `push`
  skill, which now handles PR creation and refresh as part of publish flow.
---

# open-pr

Use this skill only when a workflow step explicitly asks for PR-only work. In normal OverDrafter Symphony flow, use `push` instead.

## Goal

Create or update the PR for the current branch when publish already happened separately.

## Steps

1. Confirm `./scripts/symphony-preflight.sh` passes.
2. Confirm the branch is not `main`.
3. Use the `push` skill first if the branch is only local or if no remote PR exists yet.
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

- Prefer `push` over `open-pr` in unattended issue execution.
- Do not create duplicate PRs for the same branch.
- Do not move an issue to `Human Review` until the PR exists.
- If GitHub auth is missing, stop and report that explicitly.
