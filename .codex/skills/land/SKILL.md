---
name: land
description: |
  Safely land a reviewed OverDrafter PR from the current issue branch when
  canonical authorization and verification gates allow the Merging transition.
---

# land

Use this skill when an OverDrafter issue has a verified review handoff and has been moved to `Merging` under `AGENTS.md`. Its standing development authorization covers routine landing without a fresh approval. Follow `docs/agent-development-control-plane.md` for lifecycle and projection mechanics; protected actions retain their exact authorization requirement.

## Goal

Safely land the already-reviewed PR for the current branch, record the result,
and close the issue automatically when the merge completes all acceptance criteria.

## Steps

1. Confirm `./scripts/symphony-preflight.sh` passes.
2. Determine the current branch:

```bash
git branch --show-current
```

3. Refuse to continue if the branch is `main` or if the working tree is dirty.
4. Ensure the branch is pushed:

```bash
git push -u origin "$(git branch --show-current)"
```

5. Find the PR for the current branch and retain its number so later checks do not depend on the source branch still existing:

```bash
PR_NUMBER="$(gh pr view --json number --jq .number)"
gh pr view "$PR_NUMBER" --json number,url,state,isDraft,mergeStateStatus
```

6. If no PR exists, stop and report that the issue was moved to `Merging` too early.
7. If the PR is still draft, mark it ready:

```bash
gh pr ready
```

8. Land through the strict-mode helper and keep its exit code. It handles `main`'s strict branch protection ("require branches to be up to date") end to end:

```bash
LAND_EXIT=0
.codex/skills/land/land_strict_merge.sh "$PR_NUMBER" || LAND_EXIT=$?
echo "land_strict_merge.sh exit: $LAND_EXIT"
```

   - It pins the PR head SHA once. If that head does not contain a freshly fetched `origin/main`, it updates the branch with the REST update-branch API, which always merges `main` into the branch and is sent with `expected_head_sha`, so GitHub refuses if the head moved. It never rebases and never force-pushes.
   - It waits for the new head and proves it is exactly that update merge: two parents, the old pin first and a commit already on `main` second. Only then does it re-pin.
   - Required checks come from branch protection, failing closed if unreadable. `LAND_REQUIRED_CHECKS` and `LAND_REQUIRED_APP_ID` are fallback-only, enabled explicitly by `LAND_ALLOW_FALLBACK_CHECKS=1`. The latest run per name and required app counts; only `success` passes. For app-less contexts it also reads the latest commit status, and every present source must succeed. Missing checks remain pending. Every poll re-reads the head and stops if it changed.
   - `LAND_DEADLINE` (3600 seconds) bounds the whole run across polls and update rounds. Each gh call and git fetch is bounded by the lesser of `LAND_CALL_TIMEOUT` (60 seconds) and remaining time. `LAND_BASE` defaults to `main`; a non-main base requires setting it explicitly.
   - Each proven update logs its round, old/new heads, fetched base and second parent; success prints the accumulated update chain (or `none`).
   - Right before merging it re-reads state, head and mergeability, then runs `gh pr merge --squash --match-head-commit <pin>`. If GitHub then reports `BEHIND`, it re-fetches `origin/main` and, only if `main` really moved, does another update round (at most 3 per run).
   - It reports success only when GitHub shows `MERGED` with `headRefOid` equal to the pin and a valid merge commit whose fetched tree equals the pinned head tree. A failed read-back stops with exit 9: do not mark Done, do NOT auto-revert, escalate to Human Review. A failed merge command is verified against the same pin; it never re-reads and re-pins the head. The repo deletes merged branches itself, so there is no `--delete-branch`.
   - Every unreadable, unknown, mismatched or timed-out state stops with `land: STOP: ...`.

9. Route on the exit code and summarize the `land: STOP:` line in the workpad:

| Exit | Meaning | Action |
| --- | --- | --- |
| 0 | Merged and verified against the pinned head | Continue to step 12 |
| 2 | Usage or precondition (not OPEN, draft, wrong base, missing tool) | Stop; fix the precondition, then re-run from step 8 |
| 3 | A required check failed on the pinned head | Move to `Rework` |
| 4 | A bounded wait timed out (head, checks, mergeability, merge confirmation) | Stay in `Merging`; report, then re-run from step 8 |
| 5 | Head changed, malformed SHA, unexpected history, unknown state, merge refused or not verified | Stop; do not mark `Done`; move to `Human Review` and report |
| 6 | Merge conflict with `main` | Move to `Rework` |
| 7 | `main` kept moving through 3 update rounds | Stay in `Merging`; report, then re-run from step 8 |
| 8 | Overall deadline exceeded | Stay in `Merging`; if the message says the merge command was sent, check the PR by hand before re-running |
| 9 | Merged but tree read-back failed | Do not mark `Done`, do not revert; move to `Human Review` |
| other | Unexpected failure | Treat as 5 |

10. A re-run starts from step 8, not step 4: after an update-branch the local branch is behind its remote, so step 4's push would be rejected. A re-run pins afresh from GitHub; a PR that already merged stops at the precondition check (exit 2) instead of verifying a head against itself, so check a merged PR's head by hand against the SHA the earlier run pinned.
11. `python3 .codex/skills/land/land_watch.py` is an optional read-only status view. It does not merge and does not replace step 8. It never reports mergeable for behind, closed, draft or conflicted PRs.

12. After merge, report:
   - PR URL
   - merge method
   - final status
13. If no acceptance criterion requires post-merge work, update the rolling comment to `Complete` and move the issue to `Done` after GitHub confirms the merge.
14. If deployment, live verification, an external operation, or another acceptance criterion remains, record that work and keep the issue in the appropriate active/review state.

## Guardrails

- Do not write new product code while landing.
- Do not land a PR without a real review handoff.
- Do not mark the issue `Done` before GitHub shows the PR merged.
- Do not mark it `Done` after merge when an acceptance criterion still requires post-merge work.
- Do not leave an issue in `Merging` when required checks are red and implementation changes are needed; move it back to `Rework`.
- Never rebase or force-push to update a PR.
- Never merge without `--match-head-commit`; never use `--admin`.
- A "behind" or "not up to date" block is never a reason for `Rework`; it means update and re-check (step 8 does this).
- Never re-pin by re-reading the head after a failed merge; verify against the pin the run already holds.

## First live run

Until a supervised first landing on a low-risk PR is recorded in the PR or Linear (OVD-889 checklist), run the helper only under supervision by Release.
