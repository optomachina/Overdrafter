---
name: commit
description: |
  Create a focused git commit for the current OverDrafter issue branch after
  verification and scope checks are complete.
---

# commit

Use this skill when an OverDrafter issue is implemented and ready to be captured in git.

## Goal

Create a focused commit for the current issue branch with a coherent message and no unrelated changes.

## Steps

1. Confirm `./scripts/symphony-preflight.sh` passes.
2. Review the current diff and remove unrelated changes before committing.
3. Check `git status --short` and `git diff --stat`.
4. Commit with a message that starts with the Linear identifier when available, for example:
   - `OVD-29 Standardize root and worker verification scripts`
   - `OVD-30 Remove tracked generated artifacts from the repo`
5. After committing, report:
   - commit SHA
   - commit message
   - files changed

## Guardrails

- Do not commit unrelated local edits.
- Do not amend someone else's commit unless the workflow explicitly calls for it.
- If the branch is still missing required docs or verification, stop and fix that before committing.
