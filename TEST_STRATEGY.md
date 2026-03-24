# OverDrafter Test Strategy

Last updated: March 19, 2026

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
- when refactoring a large route into route-local modules, add focused tests for extracted view-model hooks or pure selectors so derived state stays covered outside JSX

### Client-triggered quote request changes
- validate request gating and lifecycle rendering in client part and project workspace tests
- validate RPC behavior for single-part and bulk quote requests
- validate authorization and idempotency outcomes
- validate per-user rate-limit blockers and org-level pending-cost ceiling blockers
- validate worker- or queue-adjacent state transitions where the request lifecycle depends on asynchronous vendor updates
- run `npm run verify:worker` when worker payload or queue integration changes

### Bug fixes
- reproduce the bug or define the failure clearly
- add or update a failing automated test where practical
- implement the fix
- prove the new or updated test passes

### Drawing extraction changes
- add or update regression coverage for the failing layout or title-block pattern
- cover field-specific rejection rules when a nearby bad candidate could contaminate another field
- verify raw extracted fields separately from normalized quote-facing fields when both layers are affected
- validate review-needed behavior when confidence is low or candidate ranking is ambiguous
- when model fallback is in scope, verify both parser-only and parser-plus-model branches, including disagreement fail-closed behavior
- when stale approved metadata is part of the failure, verify both the extraction payload and the approved-requirement precedence layer
- when fixture coverage is insufficient, run the worker smoke harness against the real drawing file and capture the printed raw extraction payload as verification evidence
- when preview-only debug reruns are in scope, verify that `debug_extract_part` persists to `debug_extraction_runs`, respects the model allowlist, and does not mutate canonical `drawing_extractions` or `approved_part_requirements`
- for internal Extraction Lab UI changes, verify model selection, status polling, and side-by-side rendering of canonical extraction versus preview-only debug output

### Schema or migration changes
- validate the migration path
- run static verification
- run tests touching the affected data flow
- include migration notes in the PR

### Extraction observability changes
- verify worker-emitted `worker.extraction_completed` payload shape when new extraction metrics or provenance fields are added
- verify summary or alerting SQL reads from immutable `audit_events`, not mutable `drawing_extractions`
- add a migration-definition or snapshot-style test for new observability views or functions
- add a seeded semantic test for per-day grouping, counter formulas, and zero-safe rate math when summary views or evaluators are introduced
- prefer Lane B unless the change also alters broader extraction behavior, RLS, or shared RPCs

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
