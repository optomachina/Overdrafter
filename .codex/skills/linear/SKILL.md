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
- moving an issue between `Backlog`, `Todo`, `In Progress`, `Rework`, `Blocked`, `Human Review`, `Merging`, and `Done`
- attaching the PR URL or merge result

## Rules

Follow the canonical status and validation policy in `AGENTS.md`.

- `Human Review` means all required validation has passed and the current published PR is ready for a human to inspect.
- `Blocked` means currently admitted work cannot proceed because of a decision, dependency, or required decomposition.
- `Backlog` means work is deferred or dependency-sequenced and is not currently eligible.
- `Merging` means a real PR exists and is being landed.
- `Done` means the PR is merged and a human explicitly confirmed completion; neither merge nor local code completion is sufficient alone.
- If a PR does not exist yet, do not leave the issue in `Merging`.

## Preferred updates

- After implementation: add branch name, PR URL, changed files, verification results, and local Codex `/review` disposition.
- After landing: add the merge result and final PR URL, then wait for explicit human confirmation before moving the issue to `Done`.
