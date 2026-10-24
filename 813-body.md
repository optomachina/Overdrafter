## Linear issue ID

- Issue: OVD-844 (https://linear.app/overdrafter/issue/OVD-844)
- Implements the Architect design in the issue description. Blocked by OVD-854 (merge queue); blocks OVD-845.
- Main PR for this issue. Not a release-outcome parent.

## Summary

Adds `scripts/sensitive-classes.json` (single source of truth: AGENTS.md sensitive list + auto-merge categories, shared with OVD-845) and `scripts/sensitive-class-detect.mjs`, which runs from the base checkout, classifies changed files by path and SQL content, and writes head-SHA-keyed JSON. Fails closed: unmatched paths are `unclassified`, any error gives `status: error`. Gate-loosening edits to `sensitive-classes.json` are flagged `gate_loosening`. Report-mode workflow `.github/workflows/sensitive-class.yml`.

## Problem

OVD-845 auto-merge eligibility needs a machine-readable, fail-closed classification of what a PR touches.

## Acceptance criteria addressed

- [x] Single config source of truth, drift test against AGENTS.md
- [x] Path + SQL-content classification, fail closed
- [x] Head-SHA-keyed JSON report for OVD-845
- [x] Report mode only; not a required check (needs Blaine's approval card)
- [x] Dry run on #790, #792, #794

## Files changed

`scripts/sensitive-classes.json`, `scripts/sensitive-class-detect.mjs`, its test, `.github/workflows/sensitive-class.yml`.

## Scope

Included: detector, config, tests, report-mode workflow. Not included: branch protection / required-check change, OVD-845 gate. No new dependencies.

## Verification

Commands run:

```bash
bash scripts/preflight.sh lint
bash scripts/preflight.sh typecheck
npx vitest run --maxWorkers=2
```

Results:

- [x] lint and typecheck pass; new suites pass
- [x] unrelated baseline failures are described below

Baseline failures or exceptions: only the 3 known OVD-417 Docker qualification tests.

## Proof

Test: scripts/sensitive-class-detect.test.mjs

## Review findings and coverage

- Final PR head SHA: see the Opus review comment
- Sonar issue findings: pending CI
- CodeRabbit: pending
- Codex and other reviewers: Opus review (2 rounds) posted as a PR comment
- [ ] Inspected findings and threads on the final head
