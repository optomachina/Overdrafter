# Contributing to OverDrafter

Last updated: March 11, 2026

## Purpose

This document explains how to contribute to OverDrafter in a way that matches the repository’s intended workflow. It applies to both human contributors and coding agents.

## Read these first

Before starting nontrivial work, read:
- `PRD.md`
- `PLAN.md`
- `ARCHITECTURE.md`
- `TEST_STRATEGY.md`
- `ACCEPTANCE_CRITERIA.md`
- `AGENTS.md`

## Source-of-truth rules

Use this hierarchy:
1. `PRD.md`
2. `PLAN.md`
3. `ARCHITECTURE.md`
4. `TEST_STRATEGY.md`
5. `ACCEPTANCE_CRITERIA.md`
6. specialized docs
7. `README.md`

Do not let a lower-priority doc silently override a higher-priority one.

## Before you start

For meaningful work:
- create an isolated branch or worktree
- understand the relevant subsystem before editing
- check whether the task affects product behavior, architecture, testing, or repo workflow
- identify which docs may need updates

Before you start editing, confirm you are in the real OverDrafter repo root.
Minimum check:
- `README.md` starts with `# OverDrafter`
- root contains `PRD.md`, `PLAN.md`, `AGENTS.md`, and `package.json`
- root contains `worker/` and `supabase/`

If that check fails, stop and correct the workspace instead of trying to interpret the ticket from the wrong repo.
If you are using Symphony, launch it against this repo's `WORKFLOW.md` and keep the repo-local
skills in `.codex/skills/` and `scripts/symphony-preflight.sh` in sync with that workflow.
Symphony issue runs must create or switch to the issue branch before any edits; they must not make
implementation changes on `main`.
## Package manager

- Use `npm` for both the repo root and the `worker/` package.
- Treat the committed `package-lock.json` files as authoritative.
- Do not introduce Bun, pnpm, or Yarn lockfiles unless the repo docs are intentionally changed first.

## Recommended branch naming

- `feature/...`
- `fix/...`
- `refactor/...`
- `docs/...`
- `spike/...`

Keep one focused problem per branch whenever practical.

## When to use a worktree

Use a worktree for:
- larger feature work
- risky refactors
- concurrent threads of work
- schema or migration changes
- any task where clean isolation is helpful

Skip a worktree only for small, clearly safe edits.

## Verification expectations

See `TEST_STRATEGY.md` for the full policy.

Typical nontrivial change:
- run lint
- run typecheck
- run relevant tests
- run build if affected
- run broader verification for high-risk changes

Do not rely on “it compiles” as your only signal.

## Tests

General rules:
- bug fixes should add or update tests when practical
- behavior changes should include test evidence or explain why tests were omitted
- access control, async workflows, quote logic, and publication flows deserve extra care

## Documentation updates

Update docs in the same change when you modify:
- product behavior
- workflow rules
- testing expectations
- architecture boundaries
- contributor/agent workflow

Likely docs to touch:
- `PRD.md`
- `PLAN.md`
- `ARCHITECTURE.md`
- `TEST_STRATEGY.md`
- `ACCEPTANCE_CRITERIA.md`
- `AGENTS.md`
- `README.md`

## Pull requests

Every meaningful PR should include:
- problem statement
- scope
- verification evidence
- tests added or updated
- migration notes where applicable
- rollback/risk notes where applicable
- docs updated or explicit reason none were needed

Use the repo PR template.

## What not to do

- do not mix unrelated work into one PR
- do not casually modify lockfiles or migrations
- do not change product behavior without checking source-of-truth docs
- do not leave verification implicit
- do not assume prior chat context is enough when the repo should hold the instruction

## High-risk areas

Be especially careful in:
- auth and access control
- workspace/project visibility boundaries
- internal vs client data separation
- file upload and reconciliation
- worker and async processing
- quote normalization and publication
- schema and migration history

## If you find drift

If docs, code, and behavior disagree:
- prefer the source-of-truth hierarchy
- correct the stale doc or flag the drift clearly
- do not paper over the inconsistency
