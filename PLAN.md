<!-- /autoplan restore point: /Users/blainewilson/.gstack/projects/optomachina-Overdrafter/claude-quizzical-williams-autoplan-restore-20260331-213648.md -->
# OverDrafter Execution Plan

Last updated: August 7, 2026

## Purpose

This document is the active execution plan for OverDrafter. It translates product and workflow intent into a sequence of concrete changes. It is not the same as the PRD. The PRD defines product intent. This plan defines what should be executed next and in what order.

## North Star – Ideal Multi-Agent UX for OverDrafter

The active north star is the multi-agent manufacturing co-pilot described in PRD.md.
All future work must align to:
- Hide every piece of complexity (jobs, queues, extraction steps, vendor tabs, cards) until the exact moment it adds value.
- Make the primary canvas the user’s CAD tool (plugins) or a live 3D viewer.
- Use natural language as the primary orchestration surface while preserving direct geometry selection and structured precision controls for engineering work.
- Keep OpenClaw browser automation 100 % invisible.
- Deliver DFM, quoting, modeling updates, drafting, assembly, fulfillment, and PDM as parallel invisible agents.

This replaces the previous quote-centric scaffolding as the guiding objective.

## Planning objective

The active objective is a web-first customer-interest and pricing-validation
phase. Put the existing responsive product in front of prospective users,
learn which sourcing outcome they value, and test pricing before activating
self-service billing or the unattended production rollout.

The multi-agent, CAD-native North Star remains the long-term direction, but it
does not define current launch work. iOS production readiness, CAD-native
workspace expansion, supplier-network development, and manufacturing estimates
are deferred and must not consume launch work in progress.

Operational workflow alignment:

- The agent's current execution plan is the implementation source of truth.
- Linear is the issue identity, human-visible status, and durable history layer.
- Codex owns bounded planning, implementation, verification, and handoff work.
- GitHub pull requests and CI provide review and repeatable verification.

## Active objective

Use the responsive-web `Parts | Quotes | Search` experience to demonstrate the
current upload and quote-comparison path and gather customer-interest and pricing
feedback. Free workspaces may preview supported sourcing coverage; selecting
recipients and sending part data for quote collection is a Pro action.

The production launch dependency chain remains:

1. `OVD-228` — finalize and validate the product-owner-approved monthly Stripe configuration after the pricing decision.
2. `OVD-206` — validate the hosted Xometry automatic-quote path under its spend and no-order guardrails.
3. `OVD-319` — certify and enable the unattended production launch after both prerequisites pass.
4. `OVD-320` — onboard the first external paid organization after certification.

Execution of this chain is paused by product-owner direction as of August 3,
2026 while customer interest and pricing are evaluated. Do not resume
`OVD-228`, `OVD-206`, `OVD-319`, or `OVD-320` without explicit direction.
Controlled demonstrations of the existing web product may continue, but they
must not enable billing, automatic-quote production rollout, manufacturing
payment, or supplier ordering.

iOS production release is explicitly deferred. Draft PR #271 was closed
unmerged with its branch preserved for a later re-authorized iOS cycle.
Implementation and release acceptance reference material remains in
`docs/quote-intelligence-release.md`.

## Commercial account administration track

Build commercial access around the organization boundary without adding customer-facing usage anxiety or coupling account subscriptions to manufacturing orders.

Current product behavior and operating constraints:

- Free organizations can upload parts without a customer-facing quota and preview supported sourcing coverage without sending part data externally.
- Pro organizations have an automatic vendor quote capability, but production enablement remains off during the current hold.
- The Part Quote action first selects current vendor integrations and then confirms the recipients, files, and requirements before sending.
- The automatic-quote toggle remains visible to Free users; attempting to enable it opens an upgrade dialog and leaves it off.
- Existing request throttles and organization cost ceilings remain invisible operational safeguards rather than plan quotas.
- Billing admins may issue audited trial and complimentary Pro grants under step-up authentication.
- Self-service Pro subscriptions use one monthly Stripe price, webhook-synchronized local state, and a seven-day payment-failure grace period.
- The PRD's current $49 monthly price remains the canonical offer and the active pricing hypothesis during customer discovery; keep production Checkout disabled until the product owner approves launch activation or updates the canonical contract.
- Annual pricing, promotion codes, and order administration remain deferred until the web product records revenue.

Execution sequence:

1. Demonstrate the current web experience and collect structured interest and pricing feedback.
2. Record the approved monthly price before resuming billing activation.
3. Resume only `OVD-228` and `OVD-206`; do not open additional implementation work while either can progress.
4. Execute `OVD-319` only after both prerequisite issues pass their acceptance gates.
5. Execute `OVD-320` only after production certification.
6. Revisit annual pricing, promotions, order administration, and deferred product tracks after the web product records revenue.

The Commercial Account Administration initiative is tracked by Linear parent `OVD-227`. The parent remains High complexity and is executed only through its bounded child issues.

### Deferred iOS follow-on sequence

The mobile redesign is deferred until explicit product-owner re-authorization.
Its issues are Low priority during the web-first launch phase. When resumed, it
is High complexity as one unit and must remain split into
the following bounded Linear issues:

1. `OVD-220` defines the website-mediated browser-auth and one-time session
   handoff contract.
2. `OVD-219` implements that authentication bridge only after explicit
   High-complexity approval and security review.
3. `OVD-221` adds the native welcome screen, claimed HTTPS
   `ASWebAuthenticationSession` callback, bootstrap, logout, and account
   switching.
4. `OVD-224` changes the native shell to
   `Inbox | Parts | Quotes | More` plus a separate Ask action.
5. `OVD-222` makes Inbox a client-safe queue of unresolved quote actions.
6. `OVD-223` adds contextual, read-only Ask OverDrafter with structured results
   after the command grammar and validator foundations are ready.

`OVD-226` must define authorization, exact confirmation, idempotency, and audit
contracts before any agent write or external action is enabled. `OVD-225`
separately defines the licensing, edition, and citation boundary for
engineering-standards content. Neither guardrail is satisfied by a chat UI.

`OVD-220` established the approved contract in
[`docs/mobile-authentication-contract.md`](docs/mobile-authentication-contract.md).
The server/browser implementation is the dependency-ordered `OVD-219` slice;
native adoption remains isolated to `OVD-221`.

## Deferred supplier discovery track

This track is Low priority during the web-first launch phase. When resumed,
build a complementary sourcing path that begins in Tucson and can expand across the United States:

1. Establish a provenance-first supplier, facility, capability, certification, and verification schema without changing the current instant-vendor execution model.
2. Import the supplied historical SpaceX approved-supplier data as dated source evidence, with deterministic deduplication and no implied current approval.
3. Add Tucson-area discovery and verification workflows, including customer-submitted shop information.
4. Add capability- and proximity-based organic search for manufacturing requests that need independent-shop sourcing.
5. Add assisted RFQ preparation and response intake for directory suppliers.
6. Consider clearly labeled sponsored placement only after organic eligibility, matching, and ranking are independently testable.

The supplier-discovery track must not precede or delay web validation and the
preserved launch dependency chain. Instant vendor quotes and directory-assisted
sourcing remain complementary future lanes presented from the same part or
project context.

### Current launch control

> **Strategy:** Learn whether prospective users value the current sourcing
> experience and what they will pay before activating billing or unattended
> automatic quotes.

- Use the responsive web product for controlled customer demonstrations and interviews.
- Keep `BILLING_SELF_SERVICE_ENABLED=false` and all commercial rollout controls off.
- Keep manufacturing payment, promotion, order-administration, and supplier-order actions disabled.
- Present the current $49/month PRD price as the pricing hypothesis being tested and record customer response to it.
- Record a product-owner pricing decision before resuming `OVD-228`; any price change must update the PRD, acceptance criteria, customer copy, billing guard, and Stripe catalog together.
- Preserve the existing manual procurement handoff; it must not collect manufacturing payment or place supplier orders.
- Resume the dependency chain only through `OVD-228` and `OVD-206`, followed by `OVD-319` and then `OVD-320`.

### Deferred capabilities

- Full cross-CAD plugin coverage (after live quote value validated with customers).
- Bidirectional CAD and drawing completion: editable drawing generation from CAD, editable geometry reconstruction from drawings, associative co-editing, and eventual user-selectable CAD backends. This includes the product-owner-reported drawing-only customer segment that needs replacement geometry, quotes, and later purchasing; quantify the segment through customer discovery before prioritizing implementation. See `docs/bidirectional-cad-drawing-roadmap.md`.
- PDM versioning and revision-aware agents.
- Fulfillment coordination agents.
- Production hardening (observability, rate-limiting, self-healing harness).
- NL overlay + 3D-first viewer (after agent orchestration layer exists).
- Agent orchestration blackboard (re-evaluate at ≥50 real quotes/week).
- DFM heatmap, quote scatter, revision diff visualizations.
- Canonical manufacturing-process classification: preserve raw drawing text, propose a normalized process with confidence and provenance, require the user to confirm or correct it before quote dispatch, and route quote fan-out through vendor capability profiles.
- Protolabs and SendCutSend live automation (TODO-017 — see TODOS.md).
- Hidden extended vendor workflow hardening: OSH Cut, Fabworks, Ponoko, Quickparts, RapidDirect, Geomiq, Weerg, and Protolabs Network have a shared portal-upload adapter, auth bootstrap, smoke tooling, and public/guest probe evidence. Remaining work is authenticated session setup plus vendor-specific selector/configuration tuning.

All previous Phase 1/2 quote-run items are now considered scaffolding that will be progressively hidden or repurposed under the new UX.

### Later capabilities (after geometry, review, and pricing-data foundations)

- Feature-level costing heatmap: combine deterministic geometry/DFM features, tolerances, material, finish, quantity, lead time, origin, and observed vendor quantity-price curves into an estimated range plus ranked approximate cost drivers. Keep uncertainty internal, widen the range when evidence is sparse, expose no customer confidence score, and automatically score each prediction against later firm quotes.
- Closed-event supplier outcome benchmarking: after data-purpose terms, cohort/privacy safeguards, and competition review are approved, show each participating supplier its anonymized relative price, ready-to-ship lead time, and response latency without revealing competing supplier or buyer identities.

## Completed milestones

### Milestone 10 — Live adapter breakthrough ✓
Recent merged PRs changed the live-quote baseline:

- PR #231: worker `/health` now exposes `xometry_session_age_days` with a configurable freshness warning threshold.
- PR #235: Fictiv live automation was repaired against the current portal and validated with real quote data; quantity sweep tooling now exists.
- PR #236: Xometry live automation gained `XOMETRY_BROWSER_ENGINE=camoufox` and persistent profile support; a real Xometry quote was validated at `$194.13` / 8 business days.

Older planning notes below that describe Fictiv as a stub, Xometry as blocked by Patchright/storage-state behavior, or manufacturing-payment Stripe work as pre-Frank blocking are historical and superseded by the active objectives above.

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
```text
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

1. **[RESOLVED/SUPERSEDED] Fictiv/Protolabs/SendCutSend silently return simulated prices in live mode.** The original finding applied to the March 31 code state. Current state: Fictiv live automation was repaired in PR #235; Protolabs and SendCutSend now throw `VendorAutomationError("not_implemented")` in live mode and route to manual follow-up.

2. **[RESOLVED] Single WORKER_MODE toggle gates all 4 adapters.** `WORKER_LIVE_ADAPTERS` now exists and should be used for narrow rollout. The historical no-Stripe MVP started with `WORKER_LIVE_ADAPTERS=xometry`.

3. **[HIGH] Session file permissions not hardened** (`runtimeSecrets.ts:44-57`). `XOMETRY_STORAGE_STATE_JSON` written with default umask permissions. Fix: `fs.writeFile(path, data, { mode: 0o600 })`. **Required before production deployment.**

4. **[HIGH] Session expiry mid-run has no circuit-breaker** (`vendorTaskRetry.ts`). `login_required` errors are non-retryable but there's no mechanism to pause Xometry task claiming after N consecutive failures. Health endpoint doesn't surface auth failure state. Fix: add health endpoint flag + advisory lock or worker-level suspend flag. **Task B acceptance criteria.**

5. **[HIGH] api_request_quote defined in two migrations** (`20260324000000`, `20260324103000`). Cross-migration function dependency is undocumented. Fix: add SQL comment to `build_manufacturing_quote_service_detail`. **Task C pre-condition.**

**Additional findings logged in audit trail:** F6 (Task A harness scope), F7 (RegExp flag stripping), F8 (concurrent session), F9 (JSONB contract), F10 (8 missing tests).

**Test plan artifact:** `~/.gstack/projects/optomachina-Overdrafter/blainewilson-claude-quizzical-williams-eng-review-test-plan-20260331-215444.md`

**Test coverage:** 36% (8/22 paths). 14 gaps identified. 8 critical test scenarios missing.

**Historical Task B acceptance criteria (current status):**
- [x] Protolabs and SendCutSend throw `VendorAutomationError("not_implemented")` in live mode.
- [x] Fictiv no longer needs a `not_implemented` live guard for MVP; PR #235 repaired live automation.
- [x] `WORKER_LIVE_ADAPTERS` config field implemented and respected by adapter dispatch.
- [x] Worker health exposes `xometry_session_age_days` from PR #231.
- [ ] Consecutive `xometry_auth_failure` state on repeated `login_required` failures remains hardening.
- [ ] Production env assertion for `WORKER_MODE=simulate` remains hardening.

**Updated Task C acceptance criteria (additions from Eng Review):**
- [ ] SQL comment added to `build_manufacturing_quote_service_detail` documenting JSONB contract
- [ ] Supabase types regenerated after RPC changes (TypeScript compile passes)

**Eng Dual Voices — Consensus:**
```text
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
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 4 | partially_superseded | Original stub findings were resolved/superseded by PRs #235 and #236. Remaining risks are operational hardening, live worker hosting, and app-triggered live-flow validation. |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | clean | DR-001 through DR-006 + DR-001b all shipped. No UI scope in current plan. |

**HISTORICAL VERDICT — 2026-05-12:** PHASE 1 COMPLETE. At that date the execution plan was the no-Stripe live-quote MVP: sync the merged live-adapter PRs, run an app-triggered Xometry quote as `dmrifles@gmail.com`, then expand to Fictiv/two-vendor validation after the single-vendor path was stable. Account subscription billing is now sequenced separately under `OVD-227`; manufacturing payments remain deferred. Long-lived worker hosting remains required for unattended use.
