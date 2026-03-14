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

## Local and GitHub usage

- Before opening a PR, run local verification and use Codex CLI `/review` against the working tree, commit, or base branch.
- On GitHub, native automatic Codex review is the baseline PR review layer when enabled for the repository.
- `@codex review` is an optional follow-up path when maintainers want a fresh pass after updates.
- Codex review does not replace `npm run verify`, CI, or human approval.
- This repo does not use API-key Codex Actions for PR review or CI diagnosis.
