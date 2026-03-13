# OverDrafter Test Strategy

Last updated: March 11, 2026

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

## Change-type expectations

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

## CI policy
Minimum CI target:
- lint
- typecheck
- automated tests
- build
