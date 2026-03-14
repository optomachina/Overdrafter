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
9. Ensure a PR exists for the branch:
   - if there is no PR, create one
   - if there is an open PR, update its title/body if the scope changed
   - if the current branch points at a closed or merged PR, stop and create a fresh branch from `origin/main`
10. Write or refresh the PR body using `.github/pull_request_template.md`.
11. Report:
   - branch name
   - whether the push created or updated the remote branch
   - PR URL
   - verification results
   - local Codex `/review` status

## Guardrails

- Never push `main` directly from issue automation.
- If the branch has no local commit yet, stop and use the `commit` skill first.
- Do not use `--force`; only use `--force-with-lease` if history was intentionally rewritten.
- Do not leave an issue in `Human Review` unless the PR exists and matches the current diff.
