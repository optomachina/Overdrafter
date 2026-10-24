## Linear issue ID

- Issue: OVD-888 (parent OVD-854, Done)
- Does this one bounded change satisfy the named issue's source acceptance criteria? Partly, by design. Criteria 1 (CODEOWNERS) and 3 (runbook status) have their repo changes in this diff. Criterion 2 (strict-mode `land` skill) is split to the new Linear issue OVD-889 because strict is not applied yet and two review rounds on the skill kept finding shell edge cases; this PR leaves `.codex/skills/land/SKILL.md` exactly as on `main`. The branch protection settings are not changed by this PR. Blaine approved Option B (strict) and `enforce_admins` on 2026-10-16 and they were applied the same day (record on OVD-854); a live read-back now shows `strict=true` and `enforce_admins=true` with 0 rulesets, so criterion 3's "applied" wording is met.
- Is this the issue's main PR? Yes. There is no earlier PR for OVD-888.
- Confirm the named issue is not a release-outcome parent. Confirmed: OVD-888 is a bounded follow-through task under OVD-854.

## Summary

Adds a visibility-only `.github/CODEOWNERS` and makes the branch-protection docs truthful: Option B (strict) and `enforce_admins` are approved and now in force, and the `land` skill does not handle strict mode yet (tracked in OVD-889). Until OVD-889 lands, the docs tell the operator to bring an out-of-date PR current with `gh pr update-branch` and re-check it by hand before `gh pr merge --match-head-commit`.

## Problem

OVD-854 Option B ("Require branches to be up to date before merging") and `enforce_admins` were approved by Blaine on 2026-10-16 and applied the same day. A protection read-back now shows `strict=true` and `enforce_admins=true`, with `ci` and `provider-go-live` as the required checks and no rulesets. Two things were missing or wrong:

- The runbook still said "drafted, not applied" and the Option B table did not include `enforce_admins`. A stale `ci.yml` comment and `docs/recurring-workflows.md` still pointed at "CODEOWNERS plus required code-owner review" and at a `land` skill update that is not part of this change.
- There was no CODEOWNERS. The handoff asked for one for visibility only, because agent PRs are authored from `@optomachina` and a required code-owner review would deadlock (an author cannot approve their own PR).

## Acceptance criteria addressed

- [x] 1. `.github/CODEOWNERS`, visibility-only: `@optomachina` owns `/.github/`, `/scripts/` and `/docs/sensitive-paths.json`; the header comment says branch protection must not require code-owner review and when to revisit, and that GitHub does not request review from a PR's own author, so for `@optomachina`-authored PRs it requests nobody.
- [ ] 2. `.codex/skills/land/SKILL.md` strict mode: not addressed here. Split to OVD-889. The skill is reverted to exactly `origin/main`'s content.
- [x] 3. `docs/runbooks/merge-queue.md` status: Option B (strict) and `enforce_admins` approved by Blaine on 2026-10-16 and in force, with the read-only command to re-verify the live settings; the `land` skill work is tracked in OVD-889; Option A still needs the org transfer.

## Files changed

- `.github/CODEOWNERS` (new)
- `docs/runbooks/merge-queue.md`: the Status paragraph, the Option B settings table and surrounding text, the verify diff expectation, the "Operating under strict" land-skill bullet (now the manual procedure plus the OVD-889 pointer) and the dry-run checklist line.
- `docs/recurring-workflows.md`: the merge-queue paragraph.
- `.github/workflows/ci.yml`: comment only (extraction-gate step, near line 551). No step, expression or trigger changed.
- `.codex/skills/land/SKILL.md`: no net change versus `main`. The earlier strict-mode edits on this branch were reverted in the latest commit.

## Scope

Included:

- The changes above.
- Runbook and `docs/recurring-workflows.md` say: Option B and `enforce_admins` approved and in force (confirmed by read-back), `enforce_admins` included in the Option B table, and the apply commands kept only as rollback/re-apply reference. They say the `land` skill does not handle strict mode yet (OVD-889) and that until it does, an out-of-date PR is brought current with `gh pr update-branch` and re-checked by hand (state, head, and `ci` and `provider-go-live` green on the new head) before `gh pr merge --match-head-commit <head>`.

Not included:

- Any change to `.codex/skills/land/SKILL.md`; the strict-mode land work moves to OVD-889.
- No GitHub settings, labels or branch protection were changed by this PR or by its author. Branch protection must keep "Require review from Code Owners" off; this PR does not change that.
- No new required check (separate approval) and no merge queue (needs org ownership).
- No change to `land_watch.py` or to any workflow step.
- No Linear changes by this PR.

## Verification

Commands run locally from a clean worktree at the head below (node_modules linked from the main checkout):

```bash
bash scripts/preflight.sh lint
bash scripts/preflight.sh typecheck
npx vitest run scripts/merge-queue-workflows.test.mjs scripts/test-lane-contract.test.mjs scripts/extraction-gate-decision.test.mjs scripts/validate-pr-body.test.mjs scripts/proof-check.test.mjs src/features/quotes/multi-provider-release-contract.test.ts scripts/verify-overdrafter-skill.test.mjs
node scripts/validate-agent-contract.mjs
node --test scripts/validate-agent-contract.node-test.mjs
npm run test:agent-control-plane
gh api "repos/optomachina/Overdrafter/codeowners/errors?ref=feature/ovd-888-codeowners-strict-land"
gh api repos/optomachina/Overdrafter/branches/main/protection --jq '{strict: .required_status_checks.strict, enforce_admins: .enforce_admins.enabled}'
gh api repos/optomachina/Overdrafter/rulesets --jq length
git diff --quiet origin/main HEAD -- .codex/skills/land/SKILL.md
```

Results:

- `preflight: lint PASS` and `preflight: typecheck PASS`. No `.js` or `.mjs` file changed, so there was nothing for a scoped eslint run.
- The seven-file vitest command: 7 files, 209 tests passed. That includes `scripts/merge-queue-workflows.test.mjs`, which pins the runbook's required-checks row, `DO NOT RUN`, the strict `PATCH` call and the absence of a quoted `enforce_admins` key.
- `agent-contract: valid`; the node test file passed 2 of 2; `npm run test:agent-control-plane` passed (3 node tests, contract valid, 47 Python tests OK).
- GitHub's CODEOWNERS validation at the pushed branch returned `{"errors":[]}`.
- The live protection read-back at head 1d81cec5 returns `strict=true` and `enforce_admins=true` (checks `ci`, `provider-go-live`), and `gh api repos/optomachina/Overdrafter/rulesets` returns 0 rulesets. The docs say exactly that.
- `.codex/skills/land/SKILL.md` is byte-identical to `origin/main` (`3bd6726a`), checked with `git diff --quiet origin/main HEAD -- .codex/skills/land/SKILL.md`. A trial merge of `origin/main` is conflict-free, so no merge commit was needed.
- [x] all listed verification passed
- [x] unrelated baseline failures are described below

Baseline failures or exceptions: none observed in the commands above. Not run: the full `npm run verify` and the wider `npx vitest run scripts`, because the diff is docs, a data file and one workflow comment, and no code changed.

## Proof

Test: scripts/merge-queue-workflows.test.mjs

Command: bash scripts/preflight.sh lint

```text
preflight: lint start
preflight: lint PASS
```

## Review findings and coverage

- Final PR head SHA: c71efe1eadc142c45176ef17321e87b215695424
- Earlier reviews (Codex at `1b86a50e` and `8d71dba5`) found shell edge cases in the strict-mode land-skill rewrite. That rewrite is no longer in this PR; it moves to OVD-889. Those findings do not apply to this head and are not counted as clean for it.
- Sonar issue findings: not yet available for this head; not counted as clean.
- CodeRabbit: not yet available for this head; not counted as clean.
- Codex and other reviewers: not yet re-run on this head; not counted as clean.
- [ ] Inspected findings and threads on the final head; actionable current-change findings are resolved or have evidence-backed dispositions. Missing or stale review is not counted as clean.

## Tests

- No tests were added or updated in the repository. The change is a data file (CODEOWNERS), runbook and doc prose, and a workflow comment. The existing `scripts/merge-queue-workflows.test.mjs` pins the runbook wording and was run unchanged and passes.

## Migration notes

- [x] No migration impact
- [ ] Migration impact exists and is described below

## Rollback / risk notes

- Risk: CODEOWNERS requests `@optomachina` as reviewer on PRs from other authors (for example Hexseeker) that touch `.github/`, `scripts/` or `docs/sensitive-paths.json`; for `@optomachina`'s own PRs GitHub requests nobody. If anyone later turns on "Require review from Code Owners", every such PR authored by `@optomachina` would deadlock; the file header says not to.
- Risk: until OVD-889 lands, merging under strict depends on the operator following the manual procedure in the runbook. The docs say so instead of claiming the skill handles it.
- Rollback: `git revert` of the squash commit. It changes no settings, so a revert restores the previous runbook, doc and comment and the absence of CODEOWNERS.

## Documentation

- [x] Docs updated
- [ ] No doc updates needed

## Follow-up items

- [ ] OVD-889: teach `.codex/skills/land/SKILL.md` to handle strict branch protection (a `BEHIND` PR, a head-pinned merge, and a verified merged head), before strict is applied.
- [x] Apply Option B (`strict: true`) and `enforce_admins` on `main`: applied 2026-10-16 (record on OVD-854), and the runbook Status paragraph and `docs/recurring-workflows.md` now say in force (commit 1d81cec5).

🤖 Generated with [Claude Code](https://claude.com/claude-code)

