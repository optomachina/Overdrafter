# OverDrafter Execution Plan

Last updated: March 11, 2026

## Purpose

This document is the active execution plan for the current OverDrafter repository hardening phase. It translates product and workflow intent into a sequence of concrete repository improvements. It is not the same as the PRD. The PRD defines product intent. This plan defines what should be executed next and in what order.

## Planning objective

The immediate objective is to make the repository easier to understand, verify, and evolve. This phase is not about broad feature expansion. It is about strengthening the engineering control plane around the existing product.

## Phase name

**Repository Hardening and Workflow Standardization**

## Phase outcome

This phase is complete when:
- canonical root documentation exists
- repo instructions are explicit enough for repeated agent use
- local verification is standardized
- CI is stronger and more representative
- PR structure is standardized
- package manager ambiguity is removed
- test expectations are documented and enforceable

## Milestones

### Milestone 1 — Canonical root documentation
- Create `PRD.md`
- Create `PLAN.md`
- Create `ARCHITECTURE.md`
- Create `TEST_STRATEGY.md`
- Create `ACCEPTANCE_CRITERIA.md`
- Update `README.md` with a repo map to canonical docs
- Label older docs as source material, archived, or superseded where needed

### Milestone 2 — Agent operating rules
- add source-of-truth hierarchy
- add required verification commands
- add package manager policy
- add branch/worktree policy
- add test-first expectations
- add migration policy
- add doc update rules
- add generated/protected path rules
- identify where nested `AGENTS.override.md` files are needed

### Milestone 3 — Toolchain and package cleanup
- choose authoritative package manager
- remove unused lockfile
- rename package appropriately
- remove generated artifacts from version control where needed
- standardize scripts: lint, typecheck, test, build, verify

### Milestone 4 — CI and verification hardening
- extend CI to run lint
- extend CI to run typecheck
- ensure test expectations are represented in CI
- add smoke coverage where feasible
- add worker verification if needed
- add migration validation where relevant

### Milestone 5 — Testing policy and enforcement
- define change-type-based testing expectations
- require test evidence or omission rationale in PRs
- document fixture-mode or lightweight verification where applicable

### Milestone 6 — PR, branch, and worktree discipline
- add PR template
- define branch naming convention
- define worktree usage guidance
- require local verification evidence
- require migration notes and rollback/risk notes where applicable
