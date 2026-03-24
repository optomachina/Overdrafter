# OverDrafter TODOs

Deferred work with context. Each item captures what, why, and where to start so it can be picked up independently.

---

## ~~TODO-001: Document quote_requests permanence vs service-request taxonomy relationship~~ ✅ DONE (local)

**Resolution:** Already documented in `ARCHITECTURE.md` under the quote orchestration layer. The architecture note explicitly defines `quote_requests` as intentional Phase 1 scaffolding rather than the permanent home for general service intent, while preserving it as a `manufacturing_quote`-scoped specialization that will coexist with the broader service-request line-item model described in `docs/service-request-taxonomy.md`.

**Verification evidence:** `ARCHITECTURE.md` now contains the architectural decision note clarifying the permanence boundary and taxonomy relationship, so `TODO-001` is resolved as doc-hygiene cleanup rather than new architecture work.

---

## TODO-002: Rate limiting and cost controls for client-triggered Xometry requests

**What:** Add per-user or per-org rate limiting and a cost ceiling or circuit breaker to `api_request_quote` before expanding client-triggered Xometry access beyond internal users.

**Why:** Phase 1 opens Xometry quote automation to client-triggered demand for the first time. The current idempotency check (unique index on active job per status) prevents duplicate active requests per job, but does not limit total throughput, per-user burst, or total cost. In a small closed beta this is low risk. At any real customer scale, a runaway client could generate unbounded Xometry API costs.

**Pros:** Prevents runaway Xometry API costs. Required before expanding beyond internal users or raising the per-user part count ceiling.
**Cons:** Requires a new migration (request count tracking or token bucket logic in Postgres), and adds per-request overhead. Not needed for phase 1 internal-only use.

**Context:** Codex flagged this independently during plan review (2026-03-23). Current `api_request_quote` migration has idempotency per job but no per-user rate limiting or per-org cost ceiling. Xometry is a browser-automation vendor — uncontrolled demand is operationally risky.

**Where to start:** `supabase/migrations/` — new migration adding a per-org or per-user request count and a configurable ceiling. Enforce in `api_request_quote` before the insert path.

**Depends on:** Phase 1 quote request feature shipped and in production.

---

## ~~TODO-003: Add 1093-05589 fixture and regression test for drawing extraction~~ ✅ DONE (b0f4839, #60)

**What:** Check in a sanitized fixture for the `1093-05589` drawing layout (or a text extraction snapshot) and add a regression test in `worker/src/extraction/pdfDrawing.test.ts` or `hybridExtraction.test.ts` asserting correct field extraction.

**Resolution:** Already shipped in `b0f4839` via the inline text snapshot fixture `PRIMARY_REGRESSION_FIXTURE` plus regression assertions in `worker/src/extraction/pdfDrawing.test.ts`.

**Verification evidence:** `npm run test -- --run worker/src/extraction/pdfDrawing.test.ts` passes on the current repo state, and the test asserts both positive extraction and rejection of known bad candidates for the `1093-05589` layout.

---

## ~~TODO-004: Optimistic disabled state for "Request Quote" button~~ ✅ DONE (dcd7f17, #104)

**What:** Disable the "Request Quote" CTA immediately after first click and restore it only when the RPC resolves (success or error), preventing double-click during slow network conditions.

**Resolution:** Already shipped in `dcd7f17` via controller-level duplicate-submit guards plus the existing pending-state button wiring. The part flow guards in `src/features/quotes/use-client-part-controller.ts` short-circuit repeat clicks while the mutation is pending, the project flow does the same in `src/features/quotes/use-client-project-controller.ts`, and the shared request CTA in `src/components/quotes/ClientWorkspacePanelContent.tsx` binds both `disabled` and `aria-disabled` to the busy/unavailable state.

**Verification evidence:** `npm test -- --run src/pages/ClientPart.test.tsx src/pages/ClientProject.test.tsx src/components/quotes/ClientWorkspacePanelContent.test.tsx` passes on the current repo state. The tests assert that the part request button blocks duplicate clicks while pending and re-enables after settlement, the project row and header request buttons disable during the same in-flight batch request, and the shared CTA exposes `aria-disabled` when unavailable.

---

## TODO-005: Accessibility attributes for new quote request UI surfaces

**What:** Add accessibility annotations to the new UI surfaces introduced in Phase 1:
- `aria-disabled` (not just `disabled`) on the Request Quote button when blocked, so screen readers announce why it's unavailable
- `role="alert"` on the failure_reason display so screen readers announce errors when status changes to `failed`
- `aria-label="AI-assisted"` on the model-fallback provenance badge
- `aria-live="polite"` region wrapping the realtime quote request status display

**Why:** Client-facing UI requires accessibility. These are all 5-line additions. Screen readers will silently miss status changes and error states without them.

**Pros:** Accessibility compliance. Prevents silent UX failures for assistive technology users.
**Cons:** Minimal. Each is a 1-2 attribute addition.

**Context:** Identified during CEO plan review (2026-03-23), Section 11 (Design & UX). The base components (button, status display) don't have these attributes yet.

**Where to start:** `ClientWorkspacePanelContent.tsx` (request button, status display), extraction badge component (aria-label), status region (aria-live).

**Effort:** S (human: ~2 hours / CC: ~5 min) | **Priority:** P1

**Depends on:** Quote request UI features shipped.

---

## ~~TODO-009: Sanitize failure_reason before client exposure~~ ✅ DONE (local)

**What:** Add a sanitization layer to `sync_quote_request_status_for_run` (or a client-side strip in `quote-request.ts`) ensuring that `failure_reason` only exposes allowlisted strings to the client — never raw exception messages or stack traces.

**Resolution:** Shipped via `20260323111500_sanitize_quote_request_failure_reason.sql` for runtime allowlisting, plus a forward-only backfill migration to normalize legacy `quote_requests.failure_reason` values and a client-side fallback sanitizer in `buildQuoteRequestViewModel` so unsafe strings never render even if stale data exists.

**Why:** `sync_quote_request_status_for_run(uuid, text)` originally persisted the `p_failure_reason` parameter verbatim (after empty-string check) and is granted to `authenticated`. If the worker ever passed `error.message` or a raw exception string as `p_failure_reason`, it could land on the client UI.

**Pros:** Eliminates a latent path from internal stack traces to client UI. Small diff — an allowlist CASE in the SQL function or a strip in the TypeScript view model.
**Cons:** Requires defining the canonical allowlist of safe failure strings. Any new worker failure reason must be added to the allowlist explicitly.

**Context:** Identified by Codex during CEO plan review (2026-03-23). Confirmed in `20260315110000_add_client_quote_requests.sql` lines 114-120 and grant at line 580.

**Verification evidence:** `npx vitest run src/features/quotes/quote-request.test.ts`, `npm run lint`, and `npm run typecheck` pass on this branch. `npm run db:reset` remains the migration-path check, but requires Docker to be running locally.

**Effort:** S (human: ~2 hours / CC: ~5 min) | **Priority:** P1

**Depends on:** Quote request feature shipped.

---

## TODO-006: Extraction quality alert thresholds

**What:** Define and implement alert thresholds for the `extraction_quality_summary` view:
- Alert if model-fallback rate exceeds 30% of daily extractions
- Alert if auto-approve rate drops below 70% of daily extractions

This could be a Supabase scheduled function, a cron job, or at minimum a documented baseline in `ARCHITECTURE.md` that operators can manually monitor.

**Why:** Without thresholds, extraction quality degradation is invisible until a client reports a bad quote. The quality view ships in Phase 1 but alerts need real production data to calibrate baselines before threshold values are meaningful.

**Pros:** Turns extraction quality from reactive (incident-driven) to proactive (metric-driven).
**Cons:** Alert thresholds require at least 2-4 weeks of production data to calibrate. Premature thresholds cause alert fatigue.

**Context:** Identified during CEO plan review (2026-03-23), Section 8 (Observability). The `extraction_quality_summary` view ships in Phase 1; this TODO covers the alerting layer that should follow once baselines are established.

**Where to start:** After Phase 1 ships, run `SELECT * FROM extraction_quality_summary ORDER BY day DESC LIMIT 14;` to establish baselines. Then decide between a Supabase pg_cron job or an external cron checking the view.

**Effort:** S (human: ~3 hours / CC: ~10 min after baselines established) | **Priority:** P2

**Depends on:** `extraction_quality_summary` view in production for at least 2 weeks.

---

## TODO-007: Mobile layout for part workspace B2 rail

**What:** Define and implement the mobile layout for `ClientPart.tsx` when the B2 labeled-rail split (2:1 columns) doesn't fit on small screens. The most likely correct behavior is single-column collapse with the right rail (part info + request form) appearing below the quote content.

**Why:** The design doc specifies the desktop B2 layout but is silent on mobile. Without a spec, the implementation will either guess or skip mobile handling, leading to post-ship layout bugs on mobile browsers.

**Pros:** Completes the responsive story for the part workspace.
**Cons:** Requires a design decision on column ordering (quote content first vs. part info first on mobile). The existing `ClientProject.tsx` uses a `Sheet` drawer pattern for mobile — the part page may want a similar approach.

**Context:** Identified during CEO plan review (2026-03-23), Section 11. The `project-workspace.md` design doc specifies `Sheet` drawer for mobile on the project page but `part-workspace.md` is silent on mobile.

**Where to start:** `src/pages/ClientPart.tsx` — determine whether the B2 rail uses Tailwind responsive classes (`lg:grid-cols-[2fr_1fr]`) with single-column fallback, or a drawer pattern like the project page.

**Effort:** S decision + S implementation (human: ~3 hours / CC: ~10 min) | **Priority:** P2

**Depends on:** Part workspace B2 layout implemented in this PR.

---

## TODO-008: Cancellation UX for in-flight quote requests

**What:** Add a "Cancel request" action to the quote request status display when the status is `queued` or `requesting`. The lifecycle already includes a `canceled` terminal state; the UI does not yet expose the path to reach it.

**Why:** A client who submits a quote request for the wrong part configuration, or who uploads revised files and wants to restart, currently has no self-service way to cancel. This forces an estimator to manually update the database or wait for the request to fail.

**Pros:** Closes the lifecycle loop for clients. Reduces estimator interruptions.
**Cons:** Requires a new `cancel_quote_request` RPC and UI affordance. The worker may need to handle cancellation mid-run (Xometry adapter already in-flight). This is the complex part — cancellation race conditions require careful state handling.

**Context:** The `canceled` state is part of the Phase 1 lifecycle model (see `ARCHITECTURE.md`). Identified during CEO plan review (2026-03-23) as a deferred item.

**Where to start:** New migration `cancel_quote_request(p_request_id)` — validate caller owns the request, update status to `canceled` only if status is `queued` or `requesting`. Worker should check `canceled` before advancing to `received`. UI: add "Cancel" action in the quote request status card when status is `queued` or `requesting`.

**Effort:** M (human: ~1 week / CC: ~30 min) | **Priority:** P2

**Depends on:** Quote request feature shipped and stable in production.

---

## ~~TODO-DR-001: App UI layout — replace metric Card wrappers with compact stat grid [CODEX-001]~~ ✅ DONE (fd735ef, #99)

**What:** InternalHome.tsx uses shadcn `Card`/`CardHeader`/`CardContent` wrappers for its 4 metric stats (Total jobs, In review, Active quote runs, Published packages). These should be replaced with the same compact raw-div stat grid pattern already used in ClientProject.tsx (`rounded-[16px] border border-ws-border-subtle bg-ws-card p-[16px]`).

**Scope (eng review 2026-03-23):**
- Replace the 4 shadcn Card metric blocks in `InternalHome.tsx:222-259` with a compact raw stat grid matching ClientProject's pattern
- No shared component extraction — QuoteStatBar (3-col, data-derived), InternalHome (4-col, scalar props), and ClientProject (4-col, raw divs) have different enough data shapes and visual scales that forced unification is a design decision, not a cleanup task
- Parts-list table refactor and ClientPartReview 2-column split are deferred (see TODO-DR-001b below)

**Why:** Cards as generic section wrappers flatten visual hierarchy. The compact stat grid pattern already exists in ClientProject — InternalHome should match it.

**Where to start:** `src/pages/InternalHome.tsx:222` — replace the `<section className="grid gap-4 lg:grid-cols-4">` block. Remove `CardHeader`/`CardContent`/`CardTitle` from the import once the metric section no longer needs them (the Team Access section still uses `Card`/`CardContent`).

**Effort:** S (human: ~2 hours / CC: ~10 min) | **Priority:** P2

**Source:** /design-review on main, 2026-03-23 | Scoped by /plan-eng-review, 2026-03-23

---

## TODO-DR-002: Spacing system — replace magic number spacing brackets with Tailwind scale [CODEX-002]

**What:** `ClientHome.tsx` and `ClientProject.tsx` use arbitrary spacing bracket values (`mb-[22px]`, `gap-[14px]`, `p-[24px]`, etc.) not drawn from the 4/8px grid. Replace with nearest Tailwind scale steps.

**Scope (eng review 2026-03-23):**
- Replace **spacing brackets only**: `mb-`, `mt-`, `p-`, `px-`, `py-`, `gap-` values
- **Leave font-size brackets alone** (`text-[12px]`, `text-[13px]`, etc.) — these are a deliberate dense data-display type scale that Tailwind's preset steps don't cover
- ~168 bracket values across the two files; spacing-only is roughly half that count

**Risk:** No visual regression tests exist. Individual substitutions (e.g., `mb-[22px]` → `mb-5` = 22→20px) are small; compounding effect on dense layouts is unknown. **Run `/design-review` on ClientHome and ClientProject before merging** to catch compound drift.

**Where to start:** `src/pages/ClientHome.tsx:91` — hero section spacing first, then work down. Repeat for `ClientProject.tsx`.

**Effort:** S (human: ~1 day / CC: ~15 min) | **Priority:** P3

**Source:** /design-review on main, 2026-03-23 | Scoped by /plan-eng-review, 2026-03-23

---

## TODO-DR-003: App shell viewport height — replace h-screen with svh units [CODEX-005]

**What:** App shells use `min-h-screen`/`h-screen` (= `100vh`) rather than `100svh` (small viewport height). On mobile browsers, `100vh` includes the browser chrome height, causing the app to be taller than the visible area.

**Why:** Mobile browser address bars collapse on scroll, making the visible viewport shorter than `100vh`. `svh` (small viewport height) measures the smallest viewport (with all browser chrome visible), which is the safe value for fixed-height shell layouts.

**Where to start:** `src/components/workspace/ClientWorkspaceShell.tsx:369,380` and `src/components/auth/GuestAppShell.tsx:56`.

**Effort:** S (human: ~2 hours / CC: ~10 min) | **Priority:** P2

**Source:** /design-review on main, 2026-03-23

---

## TODO-DR-004: Color system consistency — tokenize hardcoded shell backgrounds [CODEX-004]

**What:** App shells bypass the CSS variable token system with hardcoded hex backgrounds. Key locations: `AppShell.tsx:53,62`, `GuestAppShell.tsx:56,145`, `AuthPanel.tsx:281`, `ClientWorkspaceShell.tsx:17,369`.

**Critical note (eng review 2026-03-23):** The existing `ws-surface-*` tokens do NOT map to the shell hex values:
- Shell uses `#0f0f0f` (OKLCH L≈0.035), `#171717` (L≈0.077), `#212121` (L≈0.127)
- Nearest existing token is `ws-surface-inset` (L=0.12) — still 50% brighter than `#171717`
- Mapping to existing tokens **will visibly change** the shell backgrounds, which are the dominant surface on every authenticated page

**Correct approach — define new tokens first:**
1. Add to `index.css`:
   - `--ws-surface-shell: #171717` (main sidebar/panel backgrounds)
   - `--ws-surface-deep: #0f0f0f` (tooltip labels, deepest insets)
   - `--ws-surface-overlay: #212121` (mobile full-page overlay)
2. Extend `tailwind.config.ts` with `ws-shell`, `ws-deep`, `ws-overlay` color aliases
3. Replace hardcoded hex in the 4 shell files with the new tokens
4. Also tokenize `#1c64f2`/`#1d5de0` (blue CTA in GuestAppShell) → `var(--primary)`
5. **Leave Google SVG brand colors alone** (`#EA4335`, `#34A853`, `#4A90E2`, `#FBBC05` — these are fixed brand values in inline SVG paths)

**Why:** Bypassing tokens makes future theme changes inconsistent. Without the right token values, "tokenizing" the shells would change their appearance — this is a prerequisite step.

**Where to start:** `src/index.css` — add the three new shell surface tokens. Then `src/tailwind.config.ts` — add ws-shell/ws-deep/ws-overlay. Then replace in the 4 files.

**Effort:** M (human: ~1 day / CC: ~20 min) | **Priority:** P3

**Source:** /design-review on main, 2026-03-23 | Scoped by /plan-eng-review, 2026-03-23

---

## TODO-DR-005: Hardcoded OpenAI green (#10a37f) in WorkspaceAccountMenu [subagent]

**What:** `WorkspaceAccountMenu.tsx` uses hardcoded `#10a37f` / `#7be0c0` / `#9ef0d6` — the OpenAI brand green — for a "powered by" badge or similar indicator. This is neither in the design token system nor a brand color for OverDrafter.

**Why:** Bypasses the token system and will look inconsistent if the app's accent color ever changes. Should use a token, or be removed if it's a vestigial GPT badge.

**Where to start:** `src/components/chat/WorkspaceAccountMenu.tsx:116,138,155` — identify what the color is used for, then either tokenize it or replace with the appropriate semantic token.

**Effort:** S (human: ~30 min / CC: ~5 min) | **Priority:** P2

**Source:** /design-review subagent on main, 2026-03-23

---

## TODO-DR-006: Arbitrary border-radius values — establish radius scale [subagent]

**What:** Components use a wide range of arbitrary `rounded-[Xpx]` values (22 distinct values, top usages: `rounded-[10px]`×27, `rounded-[24px]`×23, `rounded-[22px]`×20, `rounded-[16px]`×18). Consolidate to a two-token semantic scale.

**Token design (eng review 2026-03-23):**
- **New tokens in `index.css`**: `--radius-surface-sm: 8px` (chips, badges, small controls), `--radius-surface-lg: 24px` (large panels, modals, drawers)
- **Existing token**: `--radius: 0.625rem` (10px) covers the mid tier — do not rename or replace it
- **Naming**: use `rounded-surface-sm` / `rounded-surface-lg` in Tailwind config to avoid colliding with shadcn's existing `rounded-sm`/`rounded-lg` (which derive from `--radius` and would break if overridden)

**Mapping rule (explicit threshold):**
- `≤19px` → `rounded` (uses existing `--radius` = 10px) — covers: 2px, 5px, 6px, 8px, 9px, 10px, 12px, 14px, 16px, 18px
- `≥20px` → `rounded-surface-lg` (24px) — covers: 20px, 22px, 24px, 26px, 28px, 30px, 34px, 36px
- `rounded-[2px]` uses (used for hairline separators/insets) — map to `rounded-surface-sm` (8px) or leave as-is if intentionally tight; judge per context

**Files:** `QuoteList.tsx`, `WorkspaceAccountMenu.tsx`, `CadModelThumbnail.tsx`, and any file touched by DR-001/004 — note that DR-006 should ship **after** DR-001 and DR-004, since those PRs will introduce/modify files that also need radius cleanup.

**Why:** 22 distinct radii with no semantic relationship produce visual noise. The two-token scale reduces these to three tiers (tight/card/sheet) that an implementer can apply consistently.

**Effort:** M (human: ~2 days / CC: ~20 min) | **Priority:** P3

**Source:** /design-review subagent on main, 2026-03-23 | Scoped by /plan-eng-review, 2026-03-23

---

## TODO-DR-001b: Parts list table layout + ClientPartReview 2-column split [deferred from DR-001]

**What:** Two structural layout changes deferred from DR-001 scope reduction:
1. `ClientProject.tsx` parts list: replace the card-panel row composition with a proper `<table>` or CSS grid table layout. Currently `overflow-hidden rounded-[24px] border bg-ws-card` wraps a list of job rows — these should be `<table>` markup for semantic correctness and a more data-dense appearance.
2. `ClientPartReview.tsx:151`: the review panels use stacked cards — replace with a 2-column split layout (quote option left, pricing/metadata right).

**Why:** These are structural HTML changes with real regression risk in heavily-tested files (ClientProject has 12 tests including row-rendering assertions). They warrant their own PR with dedicated visual QA, not bundling with the stat bar cleanup.

**Where to start:** `ClientProject.tsx` — the parts list rendering loop starts around line 800. Determine whether `<Table>` from shadcn/ui is appropriate or a CSS grid is simpler. Run the full test suite after.

**Effort:** M (human: ~1 week / CC: ~30 min) | **Priority:** P2

**Depends on:** DR-001 (metric stat cards) shipped and visually verified.

**Source:** Deferred from TODO-DR-001 by /plan-eng-review, 2026-03-23
