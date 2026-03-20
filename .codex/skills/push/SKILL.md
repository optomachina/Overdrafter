---
name: push
description: |
  Publish the current OverDrafter issue branch to origin and create or refresh
  the corresponding PR for review and merge automation.
---

# push

Use this skill when the current OverDrafter issue branch has a coherent local commit and needs to be published for review.

## Goal

Push the current issue branch to `origin`, keep it in sync safely, and ensure a matching PR exists and reflects the current scope.

## Steps

1. Confirm `./scripts/symphony-preflight.sh` passes.
2. Confirm `gh auth status` succeeds for GitHub operations in this repo.
3. Confirm the working tree is clean or intentionally staged.
4. Determine the current branch with `git branch --show-current`.
5. Refuse to continue on `main`.
6. Confirm local Codex `/review` has been run against the current change and that any material findings were either fixed or are ready to be explained in the PR handoff.
7. Push with upstream tracking:

```bash
git push -u origin "$(git branch --show-current)"
```

8. If push is rejected because the remote moved, use the `pull` skill, rerun verification, and push again.
9. Build a complete PR body before any PR create or edit call:
   - write a structured JSON payload for `npm run render:pr-body -- <path-to-json>`
   - include concrete content for `Summary`, `Problem`, `Scope`, `Verification`, `Tests`, `Migration notes`, `Rollback / risk notes`, and `Documentation`
   - render the markdown to a temporary file and validate it locally with `npm run validate:pr-body -- <path-to-rendered-markdown>`
10. Ensure a PR exists for the branch:
   - if there is no PR, create one
   - if there is an open PR, update its title/body if the scope changed
   - if the current branch points at a closed or merged PR, stop and create a fresh branch from `origin/main`
11. Create or refresh the PR with that rendered body:

```bash
gh pr create --base main --body-file /tmp/overdrafter-pr-body.md
gh pr edit --body-file /tmp/overdrafter-pr-body.md
```

12. Validate the live PR body before handoff:

```bash
gh pr view --json body --jq .body | npm run validate:pr-body -- --stdin
```

13. If validation fails, fix the JSON input or rendered markdown, update the PR body, and rerun the validator before moving the issue to `Human Review`.
14. Report:
   - branch name
   - whether the push created or updated the remote branch
   - PR URL
   - verification results
   - PR body validation status
   - local Codex `/review` status

## Guardrails

- Never push `main` directly from issue automation.
- If the branch has no local commit yet, stop and use the `commit` skill first.
- Do not use `--force`; only use `--force-with-lease` if history was intentionally rewritten.
- Do not create a PR with a blank body or placeholder template text when `render:pr-body` can be used first.
- Do not leave an issue in `Human Review` unless the PR exists and matches the current diff.
- Do not leave an issue in `Human Review` unless the PR body passes `npm run validate:pr-body` against the live PR body.
