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

6. Write or refresh the PR body using `.github/pull_request_template.md`.
7. Fill every required template section before handoff:
   - `Summary`
   - `Problem`
   - `Scope`
   - `Verification` with exact commands and outcomes
   - `Tests`
   - `Migration notes`
   - `Rollback / risk notes`
   - `Documentation`
8. Validate the live PR body:

```bash
gh pr view --json body --jq .body | npm run validate:pr-body -- --stdin
```

9. If validation fails, fix the PR body before reporting handoff.
10. Report the PR URL and PR body validation status back to the issue thread or tracker comment.

## Guardrails

- Prefer `push` over `open-pr` in unattended issue execution.
- Do not create duplicate PRs for the same branch.
- Do not move an issue to `Human Review` until the PR exists.
- Do not move an issue to `Human Review` until the PR body passes `npm run validate:pr-body`.
- If GitHub auth is missing, stop and report that explicitly.
