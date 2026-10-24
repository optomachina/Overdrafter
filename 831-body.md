<!-- CURSOR_AGENT_PR_BODY_BEGIN -->
## Linear issue ID

- Issue: none named for this docs change
- This PR is the routing config only. The report-mode check that fails when a dispatched issue or PR has no model label stays in a separate Linear issue and is not implemented here.
- No Linear issue was named, so this is not a release-outcome parent and not a follow-up to an existing main PR.

## Summary

Add `docs/agent-graph/model-routing.yaml` as the source of truth for the four Linear model labels, and point the Sonnet/Opus review-sizing sentence in `AGENTS.md` at that file. Labels decide routing. Lead sets them with the usage balancer. Opus, Sonnet, Codex, and Cursor are pools; `use_for` is a typical fit, not an exclusive assignment. `model:grok-overflow` keeps its historical name for the Cursor pool.

## Problem

Dispatch model labels were only described in prose. There was no single mapping from `model:opus`, `model:sonnet`, `model:codex`, and `model:grok-overflow` to a provider and model, or a record of how Lead chooses a pool.

## Acceptance criteria addressed

- [x] `docs/agent-graph/model-routing.yaml` lists the four labels with `label`, `provider`, `model`, `use_for`, and `notes`.
- [x] The file header says it is the source of truth for model labels, and that a report-mode missing-label check is planned in a separate Linear issue.
- [x] A top-level note says `model:` labels decide routing and Lead sets them using the usage balancer (`pstack-project-template scripts/usage-balancer`).
- [x] Codex, Claude Code, and Cursor are peer build pools. Work goes to whichever pool is furthest behind its weekly pace, leaning toward Codex/GPT.
- [x] `model:grok-overflow` keeps its name, notes that the name is historical, and describes the Cursor pool as Grok-model cloud agents only, on included plan usage, stopping around 90%, with no on-demand spend and no Claude-model cloud agents.
- [x] Opus, Sonnet, and Codex `use_for` values are typical fits, not exclusive assignments.
- [x] `AGENTS.md` Sonnet/Opus routing prose points at the new file.

## Files changed

- `docs/agent-graph/model-routing.yaml`
- `AGENTS.md`

## Scope

Included: the routing config and one pointer sentence in the existing Sonnet/Opus review-sizing bullet.

Not included: the missing-label report-mode check, the usage balancer itself, workflows, CI config, app code, database changes, or migrations. This PR does not change agent runtime, billing, or on-demand usage.

## Verification

Commands run:

```bash
python3 -c 'import yaml; data=yaml.safe_load(open("docs/agent-graph/model-routing.yaml")); assert [row["label"] for row in data]==["model:opus","model:sonnet","model:codex","model:grok-overflow"]; grok=data[3]; assert "historical" in grok["notes"] and "overflow builds only" not in grok["use_for"]'
node scripts/validate-agent-contract.mjs
```

Results:

- [x] all listed verification passed
- [x] unrelated baseline failures are described below

Baseline failures or exceptions:

`npm run preflight` was not run locally. This environment has no `node_modules`, and the diff is docs only (`AGENTS.md` and `docs/agent-graph/model-routing.yaml`). The wording update touched only the routing file. `node scripts/validate-agent-contract.mjs` was run on the first commit; this follow-up did not change `AGENTS.md`.

## Proof

Command: python3 YAML parse of docs/agent-graph/model-routing.yaml

```text
yaml-ok
```

Command: node scripts/validate-agent-contract.mjs

```text
agent-contract: valid
```

## Review findings and coverage

- Final PR head SHA: 70f4aa6e6a568fc2a8abbe11379bb16bfe6df8bd
- Sonar issue findings: not inspected; no Sonar result is available for this head yet.
- CodeRabbit: unavailable at this update.
- Codex and other reviewers: unavailable at this update.
- [ ] Inspected findings and threads on the final head; actionable current-change findings are resolved or have evidence-backed dispositions. Missing or stale review is not counted as clean.

## Tests

No tests were added. The change is a documentation mapping and one sentence in `AGENTS.md`. `scripts/validate-agent-contract.mjs` still passed after that sentence.

## Migration notes

- [x] No migration impact

## Rollback / risk notes

Revert the branch commits. The only behavior risk is agents reading a wrong provider mapping; the file is documentation and is not loaded by CI or the app.

`AGENTS.md` is on the sensitive-path list (`infra_ci`). This stays a draft until that edit is explicitly approved. The added sentence does not change merge gates, globs, or the sensitive-path list.

## Documentation

- [x] Docs updated

## Follow-up items

- [ ] Report-mode check that fails when a dispatched issue or PR has no model label, in a separate Linear issue.

<!-- CURSOR_AGENT_PR_BODY_END -->

<div><a href="https://cursor.com/agents/bc-77a3811a-0ae4-599b-8e28-f70752de874c?cursor_ref=pr_footer&cursor_cta=open_in_web"><picture><source media="(prefers-color-scheme: dark)" srcset="https://cursor.com/assets/images/open-in-web-dark.png"><source media="(prefers-color-scheme: light)" srcset="https://cursor.com/assets/images/open-in-web-light.png"><img alt="Open in Web" width="114" height="28" src="https://cursor.com/assets/images/open-in-web-dark.png"></picture></a>&nbsp;<a href="https://cursor.com/background-agent?bcId=bc-77a3811a-0ae4-599b-8e28-f70752de874c&cursor_ref=pr_footer&cursor_cta=open_in_cursor"><picture><source media="(prefers-color-scheme: dark)" srcset="https://cursor.com/assets/images/open-in-cursor-dark.png"><source media="(prefers-color-scheme: light)" srcset="https://cursor.com/assets/images/open-in-cursor-light.png"><img alt="Open in Cursor" width="131" height="28" src="https://cursor.com/assets/images/open-in-cursor-dark.png"></picture></a>&nbsp;</div>

