# Recurring Contributor and Codex Workflows

Last updated: March 13, 2026

## Purpose

This guide captures the repeatable OverDrafter motions that should not depend on a custom prompt or prior chat context. Use it for planning, verification-lane selection, PR evidence, and Symphony handoff.

## Canonical inputs for recurring work

Use the root source-of-truth hierarchy first:

1. `PRD.md`
2. `PLAN.md`
3. `ARCHITECTURE.md`
4. `TEST_STRATEGY.md`
5. `ACCEPTANCE_CRITERIA.md`
6. specialized docs such as `docs/debugging-workflows.md`
7. `README.md`

Use repo-local skills when the task is procedural rather than policy-oriented:

- `pull` for safely syncing the current branch or worktree
- `commit` for creating the focused issue commit after verification
- `push` for pushing the current issue branch and ensuring the PR exists
- `linear` for workpad updates, verification comments, and state transitions
- `land` only when an issue is already in `Merging`

Do not rely on pasted handoff snippets when the repo already documents the motion locally.

## Start of issue flow

For any nontrivial issue:

1. Confirm you are in the real OverDrafter repo root.
2. Run `./scripts/symphony-preflight.sh`.
3. Confirm you are not implementing on `main`.
4. Read the relevant source-of-truth docs and any local `AGENTS.override.md`.
5. Inspect the code or docs you plan to change before editing.
6. Make a short plan if the change is not trivial.

For Symphony issue runs:

- use this repo's `WORKFLOW.md`
- let the workspace hook switch to the deterministic issue branch
- keep the diff scoped to the current Linear issue

## Choose the lightest verification that still proves the change

See `TEST_STRATEGY.md` for the policy and `docs/debugging-workflows.md` for the lane details.

Use these defaults:

- docs-only or repo-workflow documentation changes: verify the referenced commands, file paths, branch rules, and skill names still match the repo; rerun `./scripts/symphony-preflight.sh`; if the change touches PR workflow or validation scripts, run `npm run validate:pr-body` against passing and failing sample input; run broader app or worker verification only if the diff changes scripts, commands, or behavior
- cosmetic or fixture-friendly client UI changes: start with Lane A checks and the UI tuning lane
- UI behavior changes that need browser confirmation: use Lane B and add fixture mode or fast E2E coverage depending on whether real auth/data matters
- auth, RLS, membership, routing, and Supabase-backed data bugs: use the production-realistic lane
- reproducible browser regressions and smoke coverage updates: use the fast E2E lane
- worker, async processing, quote orchestration, or cross-package changes: verify the affected package early, then use `npm run verify` before handoff
- schema or migration changes: validate the migration path, run affected tests, and use the release-confidence lane before handoff

If a nontrivial change reaches handoff without `npm run verify`, the PR and workpad must explain why a narrower command set was sufficient.

## Verification evidence to reuse in PRs and workpads

Always record:

- the exact commands run
- whether each command passed, failed, or was intentionally skipped
- which debugging lane was used when browser or Supabase validation mattered
- whether the live PR body passed `npm run validate:pr-body`
- tests added or updated, or why none were practical
- docs updated, or why no doc update was needed
- migration impact and rollback notes when relevant
- any unrelated baseline failures separately from issue-scoped failures

Useful supporting evidence includes screenshots, fixture URLs, diagnostics snapshots, and Playwright artifacts when they materially support the change.

## PR body generation flow

Do not open or refresh a PR with placeholder template text.

Use this sequence instead:

1. Write a structured JSON payload for `npm run render:pr-body -- <path-to-json>`.
2. Include concrete values for `Summary`, `Problem`, `Scope`, `Verification`, `Tests`, `Migration notes`, `Rollback / risk notes`, and `Documentation`.
3. Render the markdown to a temporary file and validate it locally with `npm run validate:pr-body -- <path-to-rendered-markdown>`.
4. Create the PR with `gh pr create --base main --body-file <path-to-rendered-markdown>` or refresh it with `gh pr edit --body-file <path-to-rendered-markdown>`.
5. Validate the live PR body with `gh pr view --json body --jq .body | npm run validate:pr-body -- --stdin`.

Renderer input shape:

```json
{
  "summary": ["Short change summary"],
  "problem": ["Why the PR exists"],
  "scope": ["What changed", "What did not change"],
  "verification": {
    "allPassed": true,
    "usedVerify": false,
    "usedNarrowVerification": true,
    "hasOtherVerification": true,
    "commands": ["npm run test -- scripts/render-pr-body.test.mjs"],
    "results": ["Narrower verification was sufficient because no runtime code changed."],
    "baselineFailures": []
  },
  "tests": ["Added or updated test coverage, or why none were practical."],
  "migrationNotes": {
    "hasImpact": false,
    "details": []
  },
  "rollbackRisks": ["Primary risk and rollback path."],
  "documentation": {
    "updated": true,
    "details": ["Docs updated in the same change."]
  }
}
```

## Handoff sequence

Before moving an issue to `Human Review`:

1. Ensure the diff is coherent and scoped.
2. Run the required verification and record the outcomes.
3. Run `./scripts/symphony-preflight.sh` again.
4. Use the `commit` skill for the local git commit.
5. Use the `push` skill to publish the branch and ensure the PR exists with a rendered `--body-file`.
6. Validate the live PR body with `gh pr view --json body --jq .body | npm run validate:pr-body -- --stdin`.
7. Use the `linear` skill to add the branch, PR URL, changed files, verification evidence, and PR body validation result to the issue workpad or comments.
8. Move the issue to `Human Review` only after the commit, push, PR, validated PR body, and workpad evidence all exist.

If verification finds unrelated baseline failures outside the issue scope, document them precisely and still hand off. If the current change introduced the failure, keep the issue in an implementation state until it is resolved.

## Merge sequence

Use the `land` skill only when the issue is already in `Merging` and a real PR exists. Do not mark the issue `Done` until GitHub shows the PR merged.
