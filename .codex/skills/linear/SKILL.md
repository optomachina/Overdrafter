---
name: linear
description: |
  Keep OverDrafter Linear issues aligned with the real repo, branch, PR, and
  merge state during Symphony execution.
---

# linear

Use this skill when an OverDrafter issue needs an explicit tracker update in the Symphony Linear project.

## Goal

Keep the Linear issue state, comments, and merge handoff aligned with the actual repo and PR state.

## Use it for

- adding a workpad or progress comment
- reporting verification results
- moving an issue between `Todo`, `In Progress`, `Rework`, `Human Review`, `Merging`, and `Done`
- attaching the PR URL or merge result

## Rules

- `Human Review` means the branch and PR are ready for a human to inspect.
- `Merging` means a real PR exists and is being landed.
- `Done` means the PR is merged, not merely code-complete locally.
- If a PR does not exist yet, do not leave the issue in `Merging`.

## Preferred updates

- After implementation: add branch name, PR URL, changed files, and verification results.
- After landing: add the merge result and final PR URL, then move the issue to `Done`.
