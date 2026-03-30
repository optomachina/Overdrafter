# OverDrafter Execution Plan

Last updated: March 27, 2026

## Purpose

This document is the active execution plan for OverDrafter. It translates product and workflow intent into a sequence of concrete changes. It is not the same as the PRD. The PRD defines product intent. This plan defines what should be executed next and in what order.

## North Star – Ideal Multi-Agent UX for OverDrafter

The active north star is the multi-agent manufacturing co-pilot described in PRD.md.
All future work must align to:
- Hide every piece of complexity (jobs, queues, extraction steps, vendor tabs, cards) until the exact moment it adds value.
- Make the primary canvas the user’s CAD tool (plugins) or a live 3D viewer.
- Use natural language as the only control surface.
- Keep OpenClaw browser automation 100 % invisible.
- Deliver DFM, quoting, modeling updates, drafting, assembly, fulfillment, and PDM as parallel invisible agents.

This replaces the previous quote-centric scaffolding as the guiding objective.

## Planning objective

The active objective is to harden Phase 1 gaps and continue Phase 2 (multi-vendor quote fan-out + service-request line-item model).

Operational workflow alignment:
- Linear is the planning and status source of truth.
- Symphony is the orchestration and planning layer for issue execution.
- Codex CLI is the local implementation and pre-PR review agent.
- Codex GitHub review is the PR review layer.
- CI is the repeatable automation layer for verification.

## Active objective

Implement the ideal multi-agent UX (see PRD.md North Star).

### Immediate next steps (next 2–4 weeks)

1. Wrap existing worker vendor adapters in full live OpenClaw harness (remove simulation mode).
2. Build thin CAD plugins (SolidWorks, Fusion, Onshape first) that talk to existing RPCs and open the live 3D workspace.
3. Replace current job-intake/review UI with natural-language overlay + 3D-first viewer (hide extraction queue, status cards, etc.).
4. Add internal blackboard + agent orchestration layer on top of the existing worker queue.
5. Ship on-demand visualizations (DFM heatmap, quote scatter, revision diff) as pull-out tools only.
6. Update Supabase schema/RPCs to support service-request line items as the new authoritative unit (manufacturing_quote becomes one specialized type).

### Phase 2 (following immediate steps)

- Full cross-CAD plugin coverage.
- PDM versioning and revision-aware agents.
- Fulfillment coordination agents.
- Production hardening (observability, rate-limiting, self-healing harness).

All previous Phase 1/2 quote-run items are now considered scaffolding that will be progressively hidden or repurposed under the new UX.

## Completed milestones

### Milestone 7 — Client-triggered quote requests ✓
Single-part and project-bulk quote request RPCs (`api_request_quote`, `api_request_quotes`). Phase 1 shipped the request lifecycle scaffolding, and Phase 2 now expands request fan-out across org-enabled applicable vendors while preserving one request and one run per client action. Lifecycle states: `not_requested`, `queued`, `requesting`, `received`, `failed`, `canceled`. Client cancel + retry. Rate limiting and org cost ceiling guardrails. Failure reason sanitization. Double-submit protection. Accessibility (aria-live, role=alert, aria-disabled). TODO-014 shipped; remaining Phase 2 work is comparison UI and per-job vendor preferences.

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
