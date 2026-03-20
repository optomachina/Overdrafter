# AGENTS.md

Last updated: March 13, 2026

## Purpose

This file is the operating manual for contributors and coding agents working in the OverDrafter repository. It defines how work should be executed, verified, and documented. Durable instructions belong here instead of being re-explained in prompts.

## Review guidelines

- Flag P0/P1 security, auth, data loss, and privacy regressions first.
- Flag broken API or schema contracts.
- Flag missing validation on external inputs.
- Flag risky dependency additions or permission expansions.
- Flag tests that no longer cover changed critical paths.
- Prefer minimal, localized fixes over broad refactors.
- Preserve existing UX and layout contracts unless the task explicitly changes them.
- Treat undocumented behavior changes as review findings.
- Do not introduce logging of secrets, tokens, or PII.
- Preserve existing authentication and authorization boundaries.
- Require tests for changed critical paths, or document why tests were not feasible.
- Surface schema, migration, and public API changes explicitly in review output.
- Flag missing TSDoc on shared exported utilities, worker orchestration helpers, repo scripts, and non-obvious domain helpers when the behavior is not clear from the signature alone.
- Do not require boilerplate docstrings for routine React components, trivial formatters, or obvious local helpers.

For recurring review expectations and GitHub-side Codex guidance, also read `docs/code-review.md`.
This repo uses subscription-backed local Codex CLI review and native GitHub Codex review, not API-key Codex Actions.

## Repository routing

- Read `README.md`, `ARCHITECTURE.md`, and `TEST_STRATEGY.md` before proposing structural changes.
- For UI changes, inspect existing component and layout patterns before introducing new ones.
- For backend or data changes, inspect schema, migrations, and authorization rules first.
- For PR review, apply the closest matching `AGENTS.override.md` file for the area touched by the diff.

## Source-of-truth hierarchy

Use this order when documents overlap:

1. `PRD.md`
2. `PLAN.md`
3. `ARCHITECTURE.md`
4. `TEST_STRATEGY.md`
5. `ACCEPTANCE_CRITERIA.md`
6. specialized docs for a specific area
7. `README.md`

If you find a conflict:
- do not guess
- prefer the higher-priority document
- update or flag the lower-priority document if it has drifted

## Workspace identity check

Before doing issue work, confirm you are in the actual OverDrafter repository rather than a different local clone or an unrelated workspace.

Minimum fingerprints of the correct repo root:
- `README.md` starts with `# OverDrafter`
- root contains `PRD.md`, `PLAN.md`, `AGENTS.md`, and `package.json`
- root contains `worker/` and `supabase/`

If those fingerprints do not match, stop and fix the workspace selection before making changes or reporting blockers.

## Core repo expectations

- Preserve product intent. Do not “improve” the product by silently changing requirements.
- Prefer small, isolated changes.
- For nontrivial work, use an isolated branch or worktree.
- Do not rely on memory of prior chats when the repo should contain the instruction.
- When behavior changes, update documentation that describes the behavior.
- Do not declare work complete based only on a successful build.

## Package manager policy

- `npm` is the authoritative package manager for this repository.
- Use the committed `package-lock.json` files at the repo root and in `worker/` as the lockfile source of truth.
- Do not introduce Bun, pnpm, or Yarn lockfiles without an explicit repo-wide decision.
- Inspect the lockfiles and scripts before changing dependency-related files.
- Do not change lockfiles casually.
- Do not add dependencies without a clear reason tied to the task.

## Branch and worktree policy

Use isolated work for:
- behavior changes
- schema or migration changes
- changes touching multiple files
- risky refactors
- concurrent efforts

Direct local edits are acceptable only for:
- trivial one-file fixes
- typo or copy changes
- clearly safe non-behavioral edits

Recommended naming:
- `feature/...`
- `fix/...`
- `refactor/...`
- `spike/...`
- `docs/...`

One problem per branch/worktree whenever practical.

## Verification policy

Before calling work complete, run the narrowest sufficient verification early, then the broader required verification before handoff.

Expected verification layers are defined in `TEST_STRATEGY.md`.

At minimum, for most nontrivial changes, expect to run:
- `npm run verify`
- narrower commands early in the loop when helpful

Canonical local commands:
- repo gate: `npm run verify`
- root app loop: `npm run lint`, `npm run typecheck`, `npm run test`, `npm run build`
- worker loop: `npm run verify:worker` from repo root or `npm --prefix worker run verify`

## Testing policy

Follow `TEST_STRATEGY.md`.

High-level rules:
- bug fixes should be test-first when practical
- behavior changes should carry test evidence or an explicit rationale for omission
- auth, access control, async workflows, quote logic, and publication paths are high-risk areas
- cosmetic-only changes may not need automated tests, but still require appropriate verification

## Migration and schema policy

For schema, migration, or data-boundary changes:
- inspect the related schema and migration files before editing
- make the change intentionally and minimally
- document migration implications in the PR
- include rollback notes where meaningful
- do not mix unrelated schema work into a feature branch

If a directory-specific override exists for database-related files, follow it.

## Documentation update policy

When you change:
- product behavior
- workflow expectations
- test expectations
- repo operating rules
- architecture boundaries

you must update the relevant doc in the same change or explicitly state why no documentation update is needed.

Common doc targets:
- `PRD.md`
- `PLAN.md`
- `ARCHITECTURE.md`
- `TEST_STRATEGY.md`
- `ACCEPTANCE_CRITERIA.md`
- `README.md`
- `CONTRIBUTING.md`

## Protected and generated paths

Treat these with care:
- lockfiles
- generated build output
- environment/config secrets
- migration history
- large generated assets
- files produced by external tools

Do not edit generated output directly unless the task explicitly requires it.
If generated artifacts are committed accidentally, prefer removing them from tracked state rather than maintaining them manually.

## Task completion standard

A task is not complete until:
1. the requested change is implemented
2. relevant verification has been run
3. the diff is coherent
4. docs are updated if needed
5. important risks or follow-ups are noted
6. the result matches the source-of-truth docs

## Pull request expectations

PRs should include:
- problem
- scope
- verification evidence
- tests added or updated
- migration notes where applicable
- rollback/risk notes where applicable
- docs updated or reason none were needed
- every required section from `.github/pull_request_template.md` filled with concrete content; do not leave template boilerplate, partial sections, or autogenerated summaries as the only content
- use `npm run render:pr-body -- <path-to-json>` plus `gh pr create --body-file` or `gh pr edit --body-file` instead of opening a blank PR first
- a PR body that passes `gh pr view --json body --jq .body | npm run validate:pr-body -- --stdin`

See `.github/pull_request_template.md`.
For recurring Codex and Symphony issue motions, use `docs/recurring-workflows.md` as the concise cross-reference for planning, verification-lane selection, skill usage, and handoff evidence.

## When to stop and flag

Stop and surface the issue instead of improvising when:
- source-of-truth docs conflict materially
- the task implies a product decision not documented anywhere
- a migration is risky or unclear
- access-control behavior is ambiguous
- a requested shortcut would bypass a protected workflow boundary

## Preferred workflow for agents

1. read the relevant source-of-truth docs
2. inspect the local area you will change
3. make a short plan for nontrivial work
4. implement in a focused way
5. verify
6. update docs if needed
7. render the PR body from structured input, update the live PR with `--body-file`, and validate it before `Human Review`
8. summarize what changed and what was verified

## Directory-local overrides

If present, local override files take precedence for their directory:
- `supabase/AGENTS.override.md`
- `worker/AGENTS.override.md`
- `src/features/quotes/AGENTS.override.md`

If no override exists, follow this root file.
