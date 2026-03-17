# OverDrafter Execution Plan

Last updated: March 13, 2026

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

Operational workflow alignment for this phase:
- Linear is the planning and status source of truth.
- Symphony is the orchestration and planning layer for issue execution.
- Codex CLI is the local implementation and pre-PR review agent.
- Codex GitHub review is the PR review layer.
- CI is the repeatable automation layer for verification.

## Milestones

### Current feature slice — Client-triggered quote requests
- add a client-safe quote request intent model distinct from quote run execution
- add idempotent single-part and project-bulk quote request RPCs
- restrict the client-triggered automation path to Xometry in phase 1
- persist request lifecycle states: `not_requested`, `queued`, `requesting`, `received`, `failed`, `canceled`
- expose quote request status and gating reasons in part and project client workspaces
- evolve the client workspace UI toward an artifact-first part and project surface while keeping chat contextual rather than primary
- keep quote publication and quote selection flows unchanged
- document follow-up backlog for multi-vendor expansion, cancellation, richer preflight gating, and successful rerun support

### Current bug-hardening slice — Drawing extraction reliability
- keep title-block extraction label-anchored rather than flat-text scanned
- keep deterministic extraction as the first pass, with `gpt-5.4` fallback only for missing, low-confidence, or conflicting critical fields
- preserve raw extracted drawing fields separately from normalized quote-facing fields
- gate low-confidence extraction behind review instead of silently persisting likely-wrong metadata
- cover known regressions with checked-in layout fixtures, including `1093-05589`
- keep quote normalization traceable through `approved_part_requirements.spec_snapshot` provenance fields

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
- require local Codex `/review` evidence before PR handoff
- require migration notes and rollback/risk notes where applicable
- add native GitHub Codex PR review as an advisory review layer
