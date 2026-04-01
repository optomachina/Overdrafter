<!-- /autoplan restore point: /Users/blainewilson/.gstack/projects/optomachina-Overdrafter/claude-quizzical-williams-autoplan-restore-20260331-213648.md -->
# OverDrafter Execution Plan

Last updated: March 31, 2026

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

### Immediate next steps (Phase 2 foundation — sequenced by dependency)

> **Strategy:** Prove value first. Ship live OpenClaw harness and validate real quotes before building CAD distribution layer. Decomposed from the original 6-step block per /autoplan review (2026-03-31).

**Task C: Service-request line item RPC updates** *(prerequisite — ships first)*
- Schema already landed: `service_request_line_items` + FK on `quote_requests` (migration `20260324000000`)
- Update/add RPCs: `api_request_quote` return shape includes `service_request_line_item_id`; `api_list_client_quote_workspace` joins through line items
- Regenerate Supabase TypeScript types after RPC changes
- Add SQL contract comment to `build_manufacturing_quote_service_detail`
- Acceptance: TypeScript compile passes; existing integration tests pass

**Task A: OpenClaw anti-detection validation gate** *(prerequisite — must PASS before Task B ships to production)*
- Test Xometry and Fictiv adapters against real vendor portals using Playwright headless browser
- Pass criterion: ≥2 vendors return real quote with price + lead time persisted in DB
- Fail criterion: If portals block on ≥2 vendors → research Xometry/Fictiv API alternatives before proceeding
- Scope: Xometry + Fictiv only (Protolabs/SendCutSend are instant-quote providers deferred to TODO-017)
- Include concurrent-session scenario in test suite
- Document go/no-go result before enabling production traffic

**Task B: Live OpenClaw harness (Xometry + Fictiv)** *(gated on Task A passing)*
- Xometry: already has live Playwright automation (`worker/src/adapters/xometry.ts:477+`); enable in production
- Fictiv: implement live Playwright automation to match Xometry's pattern
- Protolabs, SendCutSend: add `VendorAutomationError("not_implemented")` guards → `manual_vendor_followup` with clear reason code (no simulated prices in live mode)
- Add `WORKER_LIVE_ADAPTERS` config field for per-adapter rollout control
- Session security: `runtimeSecrets.ts` writes session file with `0o600` mode
- Session resilience: health endpoint surfaces `xometry_auth_failure` on N consecutive `login_required` failures; Xometry task claiming suspends when auth is known-bad
- Disable simulation mode by default (feature flag preserved for CI/staging)
- Production-env assertion: warns if `WORKER_MODE=simulate` in production env
- Acceptance criteria: see Phase 3 Eng Review section below; test plan at `~/.gstack/projects/optomachina-Overdrafter/blainewilson-claude-quizzical-williams-eng-review-test-plan-20260331-215444.md`

### Phase 2 (following immediate steps)

- Full cross-CAD plugin coverage (after live quote value validated with customers).
- PDM versioning and revision-aware agents.
- Fulfillment coordination agents.
- Production hardening (observability, rate-limiting, self-healing harness).
- NL overlay + 3D-first viewer (after agent orchestration layer exists).
- Agent orchestration blackboard (re-evaluate at ≥50 real quotes/week).
- DFM heatmap, quote scatter, revision diff visualizations.
- Protolabs and SendCutSend live automation (TODO-017 — see TODOS.md).

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

---

## /autoplan Review — 2026-03-31

### Phase 1: CEO Review

**Mode:** SELECTIVE EXPANSION | **Voices:** Claude subagent only (Codex unavailable) `[subagent-only]`

**Premises reviewed:**
- Phase 2 "2-4 week" timeline for 6 steps: accepted as aspirational (not literal sprint plan)
- CAD plugins as distribution layer: flagged as forward-looking risk (CAD vendors could compete)
- NL as sole control surface: flagged as design-phase concern (GD&T precision gap)
- OpenClaw anti-detection: added as EXISTENTIAL risk + explicit gate (Task A)
- Schema step 6 as background task: reclassified as prerequisite for step 1

**User direction confirmed:** "Prove value first" — live OpenClaw harness before CAD plugins.

**CEO plan written to:** `~/.gstack/projects/optomachina-Overdrafter/ceo-plans/2026-03-31-phase2-multi-agent-pivot.md`

**Accepted scope (Phase 2 near-term):**
- Task A: OpenClaw anti-detection validation gate (prerequisite)
- Task B: Live OpenClaw harness wrapping vendor adapters (after Task A passes)
- Task C: Service-request line item RPC updates (prerequisite for Task B; schema already landed)

**Deferred:**
- CAD plugins (SolidWorks, Fusion, Onshape) — after live quote validation
- NL overlay + 3D viewer replacement
- Agent orchestration blackboard (re-evaluate at ≥50 real quotes/week)
- DFM/quote/revision visualizations
- Client comparison UI
- Extraction quality alerts (TODO-006 — needs 14 days production baseline)

**Error & Rescue Registry:**

| Error | Trigger | Catch | Tested? |
|---|---|---|---|
| OpenClaw anti-detection block | Vendor portal CAPTCHA/403 | Task A gate (pre-ship) | Gate itself |
| Live quote adapter timeout | Vendor portal slow | Existing adapter error handling | Partial |
| RPC type mismatch after Task C | Missing `service_request_line_item_id` in TS types | TypeScript compile | Automated |
| Simulation mode ON in production | Env var misconfiguration | None (silent failure) | **GAP** |
| Quote with no line item ID | Old code path runs before Task C | DB constraint (nullable) | **GAP** |

**Failure Modes Registry:**

| Failure | Impact | Mitigation | Status |
|---|---|---|---|
| Anti-detection blocks ≥2 vendors | Entire Phase 2 quote automation collapses | Task A gate + Xometry API fallback research | PLANNED |
| Simulation mode left ON in production | No real quotes generated; appears to work | Production env assertion in Task B acceptance criteria | **OPEN** |
| `service_request_line_item_id` NOT NULL added prematurely | Breaks existing insert paths | Must remain nullable until backfill complete | **OPEN** |
| Vendor credentials not using `runtimeSecrets.ts` pattern | Credentials exposed if worker compromised | Enforce pattern in Task B implementation | NOTED |

**Dream state delta:**
- CURRENT: Hardened web app, simulation mode, multi-vendor fan-out architecture, Phase 1 schema shipped
- THIS PLAN: Live quote harness proven (2 vendors), line item RPCs updated, anti-detection validated
- 12-MONTH IDEAL: Full CAD plugin coverage, NL-first interface, parallel agent swarm, live DFM

**CEO Dual Voices — Consensus:**
```
  Dimension                              Claude Subagent  Consensus
  Premises valid?                        PARTIALLY        FLAGGED
  Right problem to solve?                YES w/reorder    CONFIRMED
  Scope calibration correct?             NO (fixed)       FIXED
  Alternatives explored?                 NO (3 missing)   NOTED
  Competitive risks covered?             NO (2 critical)  ADDED
  6-month trajectory sound?              YES w/reorder    CONFIRMED
```

---

### Decision Audit Trail

| # | Phase | Decision | Classification | Principle | Rationale | Rejected |
|---|-------|----------|----------------|-----------|-----------|---------|
| 1 | CEO | Treat Phase 2 timeline as aspirational, not literal sprint plan | Mechanical | P6 (bias toward action) | User confirmed; premise accepted | N/A |
| 2 | CEO | Reorder: prove live quotes before CAD plugins | User direction | User confirmed | "Reorder: prove value first" selected | Full 6-step block |
| 3 | CEO | Add Task A (anti-detection gate) as explicit prerequisite | Mechanical | P1 (completeness) | Existential risk with no mitigation | No gate |
| 4 | CEO | Keep simulation mode as feature flag, not delete | Mechanical | P5 (explicit over clever) | Silent failure risk if flag misconfigured | Delete simulation mode |
| 5 | CEO | Classify `service_request_line_item_id` as nullable (not NOT NULL) | Mechanical | P3 (pragmatic) | Old insert paths break if NOT NULL added before backfill | NOT NULL constraint |
| 6 | CEO | Defer CAD plugins until Task B validates live quotes | Taste | P2 (boil lakes) | User direction + subagent Finding 3 | Parallel development |
| 7 | CEO | Add Supabase types regen to Task C acceptance criteria | Mechanical | P1 (completeness) | Prior pattern (TODO-010): types must update after RPC changes | Deferred |
| 8 | CEO | Defer ERP/PDM integration alternatives to forward-looking notes | Taste | P3 (pragmatic) | Valid alternatives but outside validated scope | N/A |
| 9 | Eng | Add VendorAutomationError stubs for Fictiv/Protolabs/SCS in live mode | Mechanical | P1 (completeness) | Silent simulated prices in live mode is a data integrity failure | No guard |
| 10 | Eng | Introduce WORKER_LIVE_ADAPTERS config field for per-adapter readiness | Mechanical | P5 (explicit) | Single WORKER_MODE toggle creates cliff-edge risk across 4 adapters | Single flag only |
| 11 | Eng | Session file permissions: add 0o600 to fs.writeFile in runtimeSecrets.ts | Mechanical | P1 (completeness) | Default permissions leak session to group/world on shared hosts | Skip |
| 12 | Eng | Session expiry circuit-breaker: add health endpoint flag on login_required | Taste | P2 (boil lake) | Silent session expiry fails all Xometry tasks with no recovery path | Document-only |
| 13 | Eng | Flag dual-migration function dependency in SQL comments | Mechanical | P5 (explicit) | build_manufacturing_quote_service_detail defined in 20260324000000, called in 20260324103000 | N/A |
| 14 | Eng | Task A harness must error fast for stub adapters (Fictiv/Protolabs/SCS) | Mechanical | P1 (completeness) | Running harness against non-implemented adapters produces false-positive success | N/A |
| 15 | Eng | Document concurrent worker Xometry session constraint; add to Task A test | Taste | P3 (pragmatic) | Advisory lock is overhead for current scale; document constraint is sufficient | Advisory lock |
| 16 | Eng | Add SQL comment to build_manufacturing_quote_service_detail for JSONB contract | Mechanical | P5 (explicit) | Cross-migration function dependency has no contract documentation | N/A |

---

### Cross-Phase Themes

**Theme: "Silent synthetic data masquerading as live data"** — flagged independently in Phase 1 (CEO) and Phase 3 (Eng). High-confidence signal.

- CEO: flagged risk of simulation mode ON in production (no guard exists) → added to failure modes registry + Task B acceptance criteria
- Eng: discovered Fictiv/Protolabs/SCS adapters return simulated prices with real URLs in `WORKER_MODE=live` → critical gap requiring `VendorAutomationError("not_implemented")` guards

Same root cause: the system has multiple paths where "looks like live data" and "is actually simulated" are indistinguishable without code inspection. Fix is consistent: explicit guards, explicit error codes, and a production-env assertion.

---

### Phase 3: Eng Review

**Mode:** SELECTIVE EXPANSION | **Voices:** Claude subagent only (Codex unavailable) `[subagent-only]`

**Architecture ASCII diagram:** See above in Decision Audit section.

**Critical findings:**

1. **[CRITICAL] Fictiv/Protolabs/SendCutSend silently return simulated prices in live mode** (`fictiv.ts:43-46`, `protolabs.ts:17`, `sendcutsend.ts:15`). When `WORKER_MODE=live`, these adapters call `simulatedBaseAmount()` and return `instant_quote_received` with real vendor URLs but fake prices. The `rawPayload.mode="live"` makes DB rows look like real quotes. Fix: add `VendorAutomationError("not_implemented")` guard → routes to `manual_vendor_followup`. **Blocks Task B.**

2. **[HIGH] Single WORKER_MODE toggle gates all 4 adapters** (`config.ts:32`). Flipping to `live` makes Xometry real but makes Fictiv/Protolabs/SCS silent-stub simultaneously. Fix: add `WORKER_LIVE_ADAPTERS` config field. **Required for Task B.**

3. **[HIGH] Session file permissions not hardened** (`runtimeSecrets.ts:44-57`). `XOMETRY_STORAGE_STATE_JSON` written with default umask permissions. Fix: `fs.writeFile(path, data, { mode: 0o600 })`. **Required before production deployment.**

4. **[HIGH] Session expiry mid-run has no circuit-breaker** (`vendorTaskRetry.ts`). `login_required` errors are non-retryable but there's no mechanism to pause Xometry task claiming after N consecutive failures. Health endpoint doesn't surface auth failure state. Fix: add health endpoint flag + advisory lock or worker-level suspend flag. **Task B acceptance criteria.**

5. **[HIGH] api_request_quote defined in two migrations** (`20260324000000`, `20260324103000`). Cross-migration function dependency is undocumented. Fix: add SQL comment to `build_manufacturing_quote_service_detail`. **Task C pre-condition.**

**Additional findings logged in audit trail:** F6 (Task A harness scope), F7 (RegExp flag stripping), F8 (concurrent session), F9 (JSONB contract), F10 (8 missing tests).

**Test plan artifact:** `~/.gstack/projects/optomachina-Overdrafter/blainewilson-claude-quizzical-williams-eng-review-test-plan-20260331-215444.md`

**Test coverage:** 36% (8/22 paths). 14 gaps identified. 8 critical test scenarios missing.

**Updated Task B acceptance criteria (additions from Eng Review):**
- [ ] `FictivAdapter.quote()` throws `VendorAutomationError("not_implemented")` when `workerMode === "live"` (same for Protolabs, SendCutSend)
- [ ] `WORKER_LIVE_ADAPTERS` config field implemented and respected by adapter dispatch
- [ ] `runtimeSecrets.ts` writes session file with `0o600` mode
- [ ] Health endpoint exposes `xometry_auth_failure` state on consecutive `login_required` failures
- [ ] Unit tests for stubs-in-live-mode (see test plan)
- [ ] Integration test for empty enabled vendors in `api_request_quote`
- [ ] Integration test for mixed vendor result status (Fictiv received + Xometry failed)
- [ ] Production env assertion: `WORKER_MODE=simulate` in production logs warning

**Updated Task C acceptance criteria (additions from Eng Review):**
- [ ] SQL comment added to `build_manufacturing_quote_service_detail` documenting JSONB contract
- [ ] Supabase types regenerated after RPC changes (TypeScript compile passes)

**Eng Dual Voices — Consensus:**
```
  Dimension                            Claude Subagent    Consensus
  Architecture sound?                  PARTIALLY (3 gaps)  FLAGGED
  Test coverage sufficient?            NO (36%, 14 gaps)   FLAGGED
  Performance risks addressed?         MEDIUM              NOTED
  Security threats covered?            NO (session perms)  FLAGGED
  Error paths handled?                 NO (stubs silent)   CRITICAL
  Deployment risk manageable?          YES w/guards         NOTED
```

**Eng NOT in scope:** CAD plugins, NL overlay, agent blackboard, DFM visualizations, extraction quality alerts.

**Eng What Already Exists:** Xometry live Playwright automation (already fully implemented), multi-vendor fan-out (TODO-014 shipped), service_request_line_items schema (TODO-013 shipped), atomic task claiming, dead-task reaper, ovd-98 integration tests for gating paths, runtimeSecrets.ts pattern.

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 3 | issues_open | Phase 2 scope decomposed. 6-step block → Task A/B/C. 2 open gaps (simulation-OFF assertion, nullable constraint). Cross-phase theme: silent synthetic data. |
| Codex Review | `/codex review` | Independent 2nd opinion | 2 | issues_found | Prior items 2/3/4 confirmed shipped. failure_reason trust boundary fixed (TODO-009). |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 4 | issues_open | 10 issues (1 critical, 4 high, 5 medium). Fictiv/Protolabs/SCS stubs critical. Session security HIGH. Test coverage 36% (14 gaps). Test plan written. |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | clean | DR-001 through DR-006 + DR-001b all shipped. No UI scope in current plan. |

**VERDICT:** PHASE 1 COMPLETE. PHASE 2 PLAN APPROVED (/autoplan 2026-03-31). Next: Task C (RPC updates) → Task A (anti-detection gate, Xometry + Fictiv) → Task B (live harness, add Fictiv automation + stubs for remaining). Session circuit-breaker and per-adapter liveness flag required before production flip.
