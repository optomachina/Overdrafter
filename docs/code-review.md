# Code Review Policy

Last updated: March 13, 2026

Use this document with `AGENTS.md` when reviewing changes locally with Codex CLI or in GitHub via Codex review.

## Priorities

Reviewers should prioritize:

1. security, privacy, auth, and data-loss regressions
2. broken schema, API, or workflow contracts
3. missing validation or unsafe handling of external input
4. risky dependency additions or expanded permissions
5. critical-path testing gaps

## Review stance

- Treat Codex review as advisory input for a human reviewer.
- Prefer a few high-signal findings over style-only noise.
- Preserve current product behavior unless the task explicitly changes it.
- Prefer minimal fixes over broad refactors when addressing review findings.
- Treat undocumented behavior changes as findings until the matching docs are updated.

## Targeted TSDoc expectations

- Flag missing TSDoc when shared or exported utilities, worker orchestration helpers, CLI or repo scripts, or non-obvious domain helpers are easy to misuse without written intent.
- Do not require boilerplate docstrings for routine React components, trivial formatters, or obvious local helpers whose behavior is clear from the signature and surrounding code.
- Treat generic docstring-coverage warnings as non-authoritative unless they match this repo policy or a concrete reviewer concern.

## Local and GitHub usage

- Before opening a PR, run local verification and use Codex CLI `/review` against the working tree, commit, or base branch.
- Before handing a PR off for review, validate the live PR body with `gh pr view --json body --jq .body | npm run validate:pr-body -- --stdin`.
- On GitHub, native automatic Codex review is the baseline PR review layer when enabled for the repository.
- `@codex review` is an optional follow-up path when maintainers want a fresh pass after updates.
- Codex review does not replace `npm run verify`, CI, or human approval.
- This repo does not use API-key Codex Actions for PR review or CI diagnosis.
