## Linear issue ID

No separate issue assigned; this is the user-approved OverDrafter 1.0 orchestration policy update.

## Summary

Record standing authorization for routine 1.0 development and update the contradictory per-message and per-PR approval rules.

## Problem

The repository required repeated approval for routine GitHub/Linear operations and every PR merge after the user had explicitly authorized that workflow.

## Acceptance criteria addressed

- [x] Authorize scoped branches, commits, pushes, PR/Linear updates, automated review responses, qualified merges, normal CI/frontend deployments and existing-infrastructure builds without repeated approval.
- [x] Preserve technical gates, truthful failure reporting, one integrator, one rolling Linear comment, and exact approval for protected operations.
- [x] Accept normal GitHub automatic remote-branch deletion while preserving local evidence and historical approval receipts.

## Files changed

`AGENTS.md`, `WORKFLOW.md`, and `docs/linear-free-workflow.md`.

## Scope

This records the user's adopted standing authority and removes redundant optional-skill approval steps within that scope. Human/vendor outreach, provider/customer-file operations, production worker/database changes, credentials, purchases and destructive cleanup remain protected. No new infrastructure, unlimited spending or goal prerequisite is introduced. The two workflow consumers now explicitly defer to AGENTS.md for standing authorization, preserving exact protected-action approval and post-merge restrictions.

## Verification

- `git diff --cached --check`: passed before commit; `git diff 7f0c310e68a1f15fa17b1a7eb33a5cb1417d3335 --check`: passed after rebase.
- Subscription-backed native local Codex CLI review: no actionable findings, exit 0, 25.34 seconds.
- Parent reviewed the exact patch without a blocking finding. After PR447 merged, rebase preserved identical AGENTS.md contents and the reviewed patch bytes.
- CodeRabbit completed the original-head review and identified one valid consumer-policy inconsistency. The minimal two-document fix passed a fresh local Codex CLI review (exit 0, 22.5 seconds) and parent source review. CodeRabbit acknowledged the correction in-thread; the finding is resolved. Its full follow-up review status was rate-limited, which is not counted as a fresh full review.
- All hosted checks passed on final head `0a34eaecb2c43723d5140fdd4fe86f3ff408c59d`, including aggregate CI, unit/browser tests, builds, worker verification and Sonar. PR-scoped Sonar unresolved findings: 0. No local failures are being relabeled as successful checks.

## Tests

No local tests added or run: this is an instructions-only change with no application, build or schema behavior change. Full repository tests are not applicable to this patch.

## Migration notes

No migration impact.

## Rollback / risk notes

The main risk is interpreting standing authority more broadly than approved. The policy keeps current-head technical checks and actionable review resolution mandatory and explicitly lists protected operations. Revert AGENTS.md to restore the previous text; doing so does not retroactively change user authorization or historical evidence.

## Documentation

The canonical repository instructions are updated. The workflow wrapper and Linear handoff guide are aligned with the canonical policy. No global-policy changes are included.

## Screenshots or videos (if UI)

Not applicable: no UI change.

## Follow-up items

No unresolved actionable findings remain. Merge in the assigned integration slot; main CI observation remains with the release owner.
