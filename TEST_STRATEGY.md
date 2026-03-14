# OverDrafter Test Strategy

Last updated: March 13, 2026

## Purpose

This document defines how OverDrafter should be verified locally, in CI, and during agent-driven development.

## Verification layers

### Layer 1 — Static verification
- lint
- type checking
- format checks if used
- build-time sanity checks where cheap

### Layer 2 — Unit and component verification
- pure business logic tests
- utility tests
- reducer/state tests
- component tests where logic is isolated

### Layer 3 — Integration verification
- flows spanning multiple modules
- data-flow validation across boundaries
- workflow state transitions

### Layer 4 — UI smoke and end-to-end verification
- core navigation
- intake happy path
- project or part workspace smoke coverage
- critical internal review surfaces

## Verification lanes

### Lane A — Fast local verification
- `npm run lint`
- `npm run typecheck`
- relevant unit/component tests
- `npm run build` when needed
- `npm run verify:worker` when worker changes are in scope

### Lane B — Feature verification
- all fast local verification
- relevant integration tests
- targeted UI smoke checks

### Lane C — Release-confidence verification
- `npm run verify` from the repo root
- CI-equivalent checks
- broader smoke or E2E coverage
- worker verification is included in the root `verify` command
- migration validation if affected

## Debugging lane selection

Use `docs/debugging-workflows.md` for the exact commands and setup details. Pick the fastest lane that still exercises the behavior under test:

- production-realistic lane for auth, RLS, memberships, routing, and real Supabase-backed behavior
- fast E2E lane for repeatable browser regressions, smoke coverage, and saved-session flows
- UI tuning lane for deterministic client workspace states that do not need live Supabase data

## Change-type expectations

### Docs-only or repo-workflow documentation changes
- verify that referenced commands, paths, branch rules, issue states, and skill names still match the repo
- rerun `./scripts/symphony-preflight.sh`
- run broader app or worker verification only when the change also updates scripts, commands, or behavior

### Cosmetic or copy-only changes
- lint
- typecheck
- build if affected
- manual screen check

### UI behavior changes
- lint
- typecheck
- targeted automated tests where practical
- smoke verification of the affected flow

### Bug fixes
- reproduce the bug or define the failure clearly
- add or update a failing automated test where practical
- implement the fix
- prove the new or updated test passes

### Schema or migration changes
- validate the migration path
- run static verification
- run tests touching the affected data flow
- include migration notes in the PR

## Verification evidence

Before handoff, PR creation, or a Linear workpad update, record:

- the exact commands run
- the outcome of each command
- any unrelated baseline failures separately from issue-scoped failures
- why a narrower verification lane was sufficient when `npm run verify` was not used

## CI policy
Minimum CI target:
- lint
- typecheck
- automated tests
- build
- worker verification when the worker package remains part of the repo gate
- install dependencies for both the repo root and `worker/`
- use canonical package scripts so CI remains aligned with local verification
- keep the root `verify` command covering the full repo gate for local release-confidence checks

Preferred CI shape:
- run lint, typecheck, tests, build, and worker verification in separate parallel jobs
- keep one final aggregate gate job for branch protection
- cancel superseded runs for the same branch or PR to avoid stale feedback
- run PR validation from `pull_request`, and reserve `push` runs for `main` or merge-queue events so feature branches do not double-report the same checks
