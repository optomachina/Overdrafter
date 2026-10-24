<!-- CURSOR_AGENT_PR_BODY_BEGIN -->
## Linear issue ID

- Issue: Refs [OVD-896](https://linear.app/overdrafter/issue/OVD-896/make-model-labels-real-routing-config-check-for-missing-model-label) (AC1-2 only). This PR does not close OVD-896.
- This bounded change meets OVD-896 AC1 (the routing file maps all four labels to a provider and model) and AC2 (`AGENTS.md` names the file as the source of truth, and a test fails if the two disagree).
- Remaining after merge: OVD-896 AC3-6 (the missing-label check, report mode, flagging unknown `model:*` labels, and the Blaine-approval items for GitHub repo labels and the required check). These move to the follow-up [OVD-919](https://linear.app/overdrafter/issue/OVD-919/agent-graph-capability-tiers-and-automatic-modelprovider-failover-when), which absorbs them.
- This is OVD-896's main PR. OVD-896 is not a release-outcome parent.

## Summary

Add `docs/agent-graph/model-routing.yaml` as the source of truth for the four Linear model labels. `AGENTS.md` now names that file as the source of truth and lists the four labels. A new test, `scripts/model-routing-drift.test.mjs`, fails when `AGENTS.md` and the YAML disagree. Labels decide routing, and Lead sets them with the usage balancer. Opus, Sonnet, Codex, and Cursor are pools. `use_for` is a typical fit, not an exclusive assignment. `model:grok-overflow` keeps its historical name for the Cursor pool.

## Problem

Dispatch model labels were only described in prose. Nothing mapped `model:opus`, `model:sonnet`, `model:codex`, and `model:grok-overflow` to a provider and model, and nothing caught `AGENTS.md` drifting from that mapping.

## Acceptance criteria addressed

- [x] OVD-896 AC1: `docs/agent-graph/model-routing.yaml` maps all four labels to a provider and model, with `label`, `provider`, `model`, `use_for`, and `notes`.
- [x] OVD-896 AC2: `AGENTS.md` names `docs/agent-graph/model-routing.yaml` as the source of truth for the four labels. `scripts/model-routing-drift.test.mjs` fails if the two disagree.
- [x] The YAML header says it is the source of truth for model labels. A top-level note says `model:` labels decide routing and Lead sets them using the usage balancer (`pstack-project-template scripts/usage-balancer`).
- [x] Codex, Claude Code, and Cursor are peer build pools. Work goes to whichever pool is furthest behind its weekly pace, leaning toward Codex/GPT.
- [x] `model:grok-overflow` keeps its name and notes that the name is historical. It describes the Cursor pool as Grok-model cloud agents only, on included plan usage, stopping around 90%, with no on-demand spend and no Claude-model cloud agents.
- [ ] OVD-896 AC3-6 are not in this PR. They move to OVD-919.

## Files changed

- `docs/agent-graph/model-routing.yaml` (new)
- `AGENTS.md` (one sentence in the review-sizing bullet)
- `scripts/model-routing-drift.test.mjs` (new)
- Merge of `origin/main` at `5f36b3e4` (no rebase)

## Scope

Included: the routing config, the source-of-truth sentence in `AGENTS.md`, and the drift test.

Not included: the missing-label check, report mode, unknown-label flagging, GitHub repo labels, any required check (OVD-896 AC3-6, now OVD-919), the usage balancer, workflows, CI config, app code, database changes, and migrations. This PR does not change agent runtime, billing, or on-demand usage.

## Verification

Commands run at `da4455ab`:

```bash
npx vitest run scripts/model-routing-drift.test.mjs
node scripts/validate-agent-contract.mjs
npm run preflight
```

Results:

- [ ] all listed verification passed: the drift test and agent contract passed, and preflight lint and typecheck passed. The preflight test stage failed only on the 3 Docker-only baseline cases below.
- [x] unrelated baseline failures are described below

Baseline failures or exceptions:

`npm run preflight`: lint PASS, typecheck PASS. The test stage reports 12788 passed and 3 failed. All 3 failures are in `scripts/qualify-ovd417-four-migration-suffix.test.mjs` ('a routing override', 'duplicate databases', and 'non-empty evidence'). That test needs Docker, which this box does not have. This is a known baseline failure, and this PR does not touch that file.

## Proof

Test: scripts/model-routing-drift.test.mjs

Command: npx vitest run scripts/model-routing-drift.test.mjs (head da4455ab379f408b6a9cecbbd01704f14bfa7956)

```text
 ✓ scripts/model-routing-drift.test.mjs (8 tests)
 Test Files  1 passed (1)
      Tests  8 passed (8)
```

Command: node scripts/validate-agent-contract.mjs (head da4455ab379f408b6a9cecbbd01704f14bfa7956)

```text
agent-contract: valid
```

## Review findings and coverage

- Final PR head SHA: da4455ab379f408b6a9cecbbd01704f14bfa7956
- Jev: hand-judged tier HIGH (`model:opus` route). The repo screen (`scripts/jev-pr-screen.mjs`) at `da4455ab` returned risky (det=risky because `AGENTS.md` is a sensitive path; jev=low@0.3). The box screen (`screen.py 831`) returned low. Jev is raise-only, so HIGH stands.
- Sonar issue findings: Quality Gate passed on `da4455ab` (the SonarCloud check passed on this head). It reported 0 new issues on the earlier head, and those findings have not been re-read on this head.
- CodeRabbit: skipped because the PR is a draft. No review exists.
- Codex: read-only review on `da4455ab` returned APPROVED with 4 nits and no blocking findings (see the PR comment). The PR body nit is fixed. The 3 test-robustness nits are left for the Opus review.
- Opus: required by tier HIGH. It is queued and not done yet. QA and Blaine's card follow it.
- [ ] Inspected findings and threads on the final head; actionable current-change findings are resolved or have evidence-backed dispositions. Missing or stale review is not counted as clean.

## Tests

Added `scripts/model-routing-drift.test.mjs` (vitest, run by `npm test`). It has 8 cases. One checks that the real `AGENTS.md` and YAML agree. The other 7 are drift cases built by editing the real file text: a label removed from the YAML, an extra YAML label, an unknown `model:*` label in `AGENTS.md`, the source-of-truth sentence removed, a missing `provider`, a duplicate label, and the Opus model renamed.

## Migration notes

- [x] No migration impact

## Rollback / risk notes

Revert the branch commits. The YAML is documentation that the app does not load. The new test reads only `AGENTS.md` and the YAML.

`AGENTS.md` is on the sensitive-path list (`infra_ci`). This is governance, so it needs Blaine's approval card before merge. The added sentence does not change merge gates, globs, or the sensitive-path list.

## Documentation

- [x] Docs updated

## Follow-up items

- [ ] OVD-919: OVD-896 AC3-6. These are the report-mode check for a dispatched issue or PR with no `model:*` label, flagging unknown labels, and the Blaine-approval items (GitHub repo labels, and making the check required).

<!-- CURSOR_AGENT_PR_BODY_END -->

<div><a href="https://cursor.com/agents/bc-77a3811a-0ae4-599b-8e28-f70752de874c?cursor_ref=pr_footer&cursor_cta=open_in_web"><picture><source media="(prefers-color-scheme: dark)" srcset="https://cursor.com/assets/images/open-in-web-dark.png"><source media="(prefers-color-scheme: light)" srcset="https://cursor.com/assets/images/open-in-web-light.png"><img alt="Open in Web" width="114" height="28" src="https://cursor.com/assets/images/open-in-web-dark.png"></picture></a>&nbsp;<a href="https://cursor.com/background-agent?bcId=bc-77a3811a-0ae4-599b-8e28-f70752de874c&cursor_ref=pr_footer&cursor_cta=open_in_cursor"><picture><source media="(prefers-color-scheme: dark)" srcset="https://cursor.com/assets/images/open-in-cursor-dark.png"><source media="(prefers-color-scheme: light)" srcset="https://cursor.com/assets/images/open-in-cursor-light.png"><img alt="Open in Cursor" width="131" height="28" src="https://cursor.com/assets/images/open-in-cursor-dark.png"></picture></a>&nbsp;</div>


