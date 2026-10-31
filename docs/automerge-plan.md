# Automerge enforcement plan

This plan covers the gate and merge machinery only. #972 must land first; it owns the writer cancellation and ENOTEMPTY repairs. Preserve its concurrency and checkout behavior.

## Decision contract

The default-branch workflow executes trusted code and reads PR content as data. It never checks out, installs or executes PR head code. The off-only repo/org Actions variable `DOOR_AUTOMERGE` enables a merge attempt only when its value is exactly `true`. Missing or any other value disables merging without changing gate conclusions.

`evaluate()` combines durable blocking verdict history with current-head evidence. Opus, Sonnet, Jev, CI and QA are separate gates. Opus is required at every tier because the Jev marker is written by the builder identity and must not lower the review requirement; a non-builder Jev writer is a card item. QA remains required at every tier. Opus and Sonnet passes must come from distinct verifier ids. An unknown builder model in the Built-by line is unattributed and blocks. Only `overdrafter-verifier[bot]` verdict comments count. Explicit `opus` and `sonnet` model families, or normalized `claude` families with distinct `opus-reviewer` and `sonnet-reviewer` ids, distinguish the review gates. Generic Claude is insufficient.

Reviewer verdicts follow the Architect ruling on hardening checklist item 6 (PR #993 comment 6538018662). A reviewer comment counts only when its first line is exactly `Architect review (<opus|sonnet|codex|jev>) @ <40-hex head SHA>` and its second is `VERDICT: PASS|PASS_NOTES|CHANGES_REQUIRED`. The header must agree with the JSON verdict block below it, which is unchanged. Only `overdrafter-verifier[bot]` comments count; header text from any other author, or quoted later in a body, is ignored. Per model the newest App verdict at the head counts, and `CHANGES_REQUIRED` blocks. A malformed header, an edited verdict comment or a same-time disagreement fails closed. Same-family review is accepted only for a Claude-built PR reviewed by Opus whose header adds `Context: fresh-session; no-build-context` and a `Reviewer-Run: <id>` line, where that id appears nowhere in the PR body or commit messages. Same-family Sonnet, Codex and Grok reviews still block. A same-family review never replaces the other required gates. Open question for the Architect: Sonnet is Claude-family, so a Claude-built PR cannot pass the Sonnet gate under this rule. A malformed header blocks only the head it names. Header-only `CHANGES_REQUIRED` and malformed headers enter the durable history, so deleting them does not clear the block.

The Jev writer is `scripts/jev-pr-screen.mjs`; its existing commit-status context is `jev-screen`. Its trusted author and strict v3 marker format come from `scripts/lib/jev-screen-marker.mjs`. Missing, malformed, uncertain, `no_verdict` and risky Jev decisions block. The final tier can be raised by deterministic sensitivity while Jev itself remains non-risky. Positive verdicts must use the exact current SHA even when an earlier SHA has an equal `diff_id`. Existing FAIL history still follows equal `diff_id` values.

Hosted `ci`, `provider-go-live` and `secret-scan` must complete successfully at the head from GitHub Actions. Review evidence must resolve to allowed successful CI/Verify Actions runs. Builder independence, complete classification, no actionable findings and a complete resolved-thread snapshot are mandatory.

## Held work

Production database migrations/apply, removals, vendor/spend paths, branch protection/rulesets, gate loosenings, Sonar safe marks, gate machinery and unclassified work cannot use this lane. The detector adds `gate_machinery` from trusted base configuration, preserving all shared sensitive classes. It includes workflows, governance, gate dependencies and their tests. Narrowing its paths is itself gate loosening. Full head content is scanned as data for held operation indicators; unreadable or oversized input fails closed. The report-only door cannot waive a hold. Fixture-heal behavior is unchanged and excluded from this work.

Other sensitive-list work can qualify only after Opus, Sonnet, Jev, QA and CI pass and Blaine's approval record names the head; the approval requirement is never waived. Held gate machinery also covers secret-scan allowlists, RLS/definer baselines, migration and target guards, git hooks and agent settings. Source merge grants no production execution, database apply, credential, provider, customer-data or spending authority.

## Enablement and proof

Requires Blaine card before undraft/enable (workflow, AGENTS.md, required-check changes).

1. Land #972 and obtain independent review, QA and current-head hosted checks for this machinery. Keep the switch absent or off during deployment.
2. Blaine manually makes `ovd-merge-gate` required, pinned to GitHub Actions. Keep existing required checks; the writer/history job names are not substitutes. No API call in this change modifies protection, checks, labels or variables.
3. After exact enablement approval, prepare a one-file docs PR changing `docs/recurring-workflows.md`. Obtain Sonnet and Jev passes, the existing QA pass and green hosted checks at the same head. Confirm it is non-held. Allow the squash merge and record the evaluated SHA and resulting commit.
4. Negative control: push after reviews and before merge. The old review SHA must block until all required evidence is renewed at the new head. The atomic `--match-head-commit` must reject a last-moment push.
5. Negative control: leave the switch unset, empty or false. Re-evaluate the otherwise passing docs PR and confirm there is no merge attempt. Only exact `true` enables attempts.
6. If CI/Jev completes after the last comment, use trusted default-branch `workflow_dispatch` with the PR number. This workflow intentionally retains the existing event/dispatch pattern; it does not add a completion-trigger workflow.

Known limits, all fail closed: a merge made with `GITHUB_TOKEN` does not trigger `push` workflows on `main`, so post-merge CI or deploys must not depend on them; `mergeable_state` is computed lazily, so a passing PR may need a `workflow_dispatch` re-evaluation to merge; and a binary or unreadable head file blocks the content scan, so such PRs never auto-merge.

The runtime rereads the head before publishing the gate and again before merging, and refuses if the PR comments or body changed after evaluation, then invokes `gh pr merge --squash --match-head-commit <sha>`. It never uses deferred auto-merge or admin bypass. These local tests do not claim a live merge, hosted acceptance or enablement proof. Switch off to stop new attempts; revert a squash commit to roll back source changes. Required-check changes are a separate manual action.
