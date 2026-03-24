# OverDrafter Execution Plan

Last updated: March 23, 2026

## Purpose

This document is the active execution plan for OverDrafter. It translates product and workflow intent into a sequence of concrete changes. It is not the same as the PRD. The PRD defines product intent. This plan defines what should be executed next and in what order.

## Planning objective

The active objective is to harden Phase 1 (fix critical dead-task reaper gap) and begin Phase 2 (multi-vendor quote fan-out + service-request line-item model).

Operational workflow alignment:
- Linear is the planning and status source of truth.
- Symphony is the orchestration and planning layer for issue execution.
- Codex CLI is the local implementation and pre-PR review agent.
- Codex GitHub review is the PR review layer.
- CI is the repeatable automation layer for verification.

## Active work

### Immediate — Phase 1 gap remediation

- [x] add dead-task reaper to worker — `reapStaleTasks()` in `worker/src/queue.ts`, called every 60s from main loop
- [x] add `canceled` state test to `src/features/quotes/quote-request.test.ts`
- [x] fix duplicate migration timestamps — renamed `20260323190000_add_quote_request_cancellation.sql` → `20260323190001_*`
- [ ] regenerate Supabase types to include `api_cancel_quote_request` (requires `supabase db diff` / `supabase gen types`) — see TODO-010b

### Phase 2 — Multi-vendor quote fan-out + service-request line-item model

The architecture docs explicitly call `quote_requests` "Phase 1 scaffolding scoped to manufacturing_quote." Phase 2 introduces the service-request line-item model as the authoritative unit of work and enables multi-vendor quote collection.

Phase 2 work items (order matters):
1. [x] Add `service_request_line_items` table migration — `id, project_id, job_id?, service_type, status, scope, service_detail (jsonb)` — see TODO-013
2. [x] Backfill existing jobs → implicit `manufacturing_quote` line items
3. Update `api_request_quote` to fan out across multiple enabled vendors per org (not just Xometry) — see TODO-014
4. Promote vendor preferences from localStorage (`vendor-exclusions.ts`) to server-persisted per-job or per-project preferences
5. Update client workspace UI to show multi-vendor quote comparison and vendor-level status per lane
6. Add worker observability — task duration and failure-rate metrics — see TODO-011
7. Add loading skeleton to quote-request-in-flight UI states — see TODO-012

## Completed milestones

### Milestone 7 — Client-triggered quote requests ✓
Single-part and project-bulk quote request RPCs (`api_request_quote`, `api_request_quotes`). Xometry-only Phase 1. Lifecycle states: `not_requested`, `queued`, `requesting`, `received`, `failed`, `canceled`. Client cancel + retry. Rate limiting and org cost ceiling guardrails. Failure reason sanitization. Double-submit protection. Accessibility (aria-live, role=alert, aria-disabled). All TODOs 001–009 closed.

### Milestone 8 — Drawing extraction reliability ✓
Label-anchored title-block extraction as first pass, `gpt-5.4` fallback for missing/low-confidence/conflicting critical fields. Raw extracted fields preserved separately from normalized quote-facing fields. Low-confidence extraction gated behind review. `1093-05589` layout fixture + regression test (b0f4839). Quote normalization traceable through `approved_part_requirements.spec_snapshot` provenance fields.

### Milestone 9 — Client workspace design polish ✓
DR-001 through DR-006 + DR-001b all shipped: compact stat grid, tokenized spacing and shell colors, svh units, emerald token (no hardcoded OpenAI green), semantic radius scale. Two-column ClientPartReview layout. Semantic parts-list table in ClientProject.

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
| CEO Review | `/plan-ceo-review` | Scope & strategy | 2 | clean | Phase 1 validated complete. 1 critical gap (dead-task reaper — fixed). Phase 2 scope defined. |
| Codex Review | `/codex review` | Independent 2nd opinion | 2 | issues_found | Prior items 2/3/4 confirmed shipped. failure_reason trust boundary fixed (TODO-009). |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 3 | clean | 9 issues found. Dead-task reaper fixed. Migration timestamp fixed. Canceled state test added. |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | clean | DR-001 through DR-006 + DR-001b all shipped. 1 minor deferred item (loading skeleton, TODO-012). |

**VERDICT:** PHASE 1 COMPLETE. Phase 2 foundation started. Next: regenerate Supabase types (TODO-010b), then begin multi-vendor fan-out on top of `service_request_line_items` (TODO-014).
