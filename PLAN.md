# OverDrafter Execution Plan

Last updated: March 23, 2026

## Purpose

This document is the active execution plan for OverDrafter. It translates product and workflow intent into a sequence of concrete changes. It is not the same as the PRD. The PRD defines product intent. This plan defines what should be executed next and in what order.

## Planning objective

The active objective is to ship client-triggered quote requests and drawing extraction reliability. Repository hardening (Milestones 1–6) is complete.

Operational workflow alignment:
- Linear is the planning and status source of truth.
- Symphony is the orchestration and planning layer for issue execution.
- Codex CLI is the local implementation and pre-PR review agent.
- Codex GitHub review is the PR review layer.
- CI is the repeatable automation layer for verification.

## Active work

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

## Completed milestones

### Milestone 1 — Canonical root documentation ✓
`PRD.md`, `PLAN.md`, `ARCHITECTURE.md`, `TEST_STRATEGY.md`, `ACCEPTANCE_CRITERIA.md`, `README.md` repo map all exist and are current.

### Milestone 2 — Agent operating rules ✓
`AGENTS.md` includes source-of-truth hierarchy, verification commands, package manager policy, branch/worktree policy, test-first expectations, migration policy, doc update rules, generated/protected path rules, and directory-local override files.

### Milestone 3 — Toolchain and package cleanup ✓
`npm` is authoritative. Both `package-lock.json` files are committed. Standard scripts (`lint`, `typecheck`, `test`, `build`, `verify`) exist at root and in `worker/`.

### Milestone 4 — CI and verification hardening ✓
CI runs lint, typecheck, tests, build, and worker verification in parallel jobs with an aggregate gate. `push` triggers are scoped to `main`; `pull_request` triggers cover feature branches. Run cancellation is configured.

### Milestone 5 — Testing policy and enforcement ✓
`TEST_STRATEGY.md` defines change-type-based testing expectations with explicit verification lanes (A/B/C) and per-change-type requirements.

### Milestone 6 — PR, branch, and worktree discipline ✓
`.github/pull_request_template.md` exists. Branch naming, worktree guidance, verification evidence requirements, and Codex review expectations are documented in `AGENTS.md`.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 | issues_found | Plan staleness, domain decision gap, rate limiting gap, extraction guardrails gap |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 7 issues found, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |

**CODEX:** 9 findings — plan staleness (Milestones 1–6 already done), scope conflation, no sequencing, domain decision on `quote_requests` permanence, fake PR enforcement, Xometry rate limiting gap, extraction operational guardrails, package rename churn, output-based success criteria.

**CROSS-MODEL:** Eng Review found `api_request_quote` DECLARE ordering bug and `received_at` overwrite; Codex found `quote_requests` permanence decision gap and Xometry rate limiting — complementary, no direct contradictions.

**UNRESOLVED:** 0 unresolved decisions.

**VERDICT:** ENG CLEARED — all decisions resolved, 0 critical gaps. TODOS.md created with 3 deferred items. PLAN.md updated to reflect completed milestones.
