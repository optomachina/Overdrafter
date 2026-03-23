# OverDrafter TODOs

Deferred work with context. Each item captures what, why, and where to start so it can be picked up independently.

---

## TODO-001: Document quote_requests permanence vs service-request taxonomy relationship

**What:** Add a one-paragraph architectural decision note in `ARCHITECTURE.md` clarifying whether `quote_requests` is a permanent foundational table or a transitional record that will eventually merge with the service-request line-item model.

**Why:** `ARCHITECTURE.md` (line 13) states that the next-phase authoritative unit should be service request line items. The `quote_requests` table introduces a parallel intent record. Without an explicit decision, two developers could build in opposite directions — one treating `quote_requests` as permanent schema, another treating it as temporary scaffolding. This is how throwaway schema accumulates.

**Pros:** Prevents architectural confusion. Aligns future work on service taxonomy against a clear stake in the ground.
**Cons:** One paragraph. No risk.

**Context:** `ARCHITECTURE.md` § "Request-model boundary" describes the intended separation between quote-request intent and quote-run execution, but does not say whether this model is the permanent solution or a stepping stone toward the service-request taxonomy described in `docs/service-request-taxonomy.md`. Codex independently flagged this as a blind spot during plan review (2026-03-23).

**Where to start:** `ARCHITECTURE.md` § "Quote orchestration layer" — add a note below the phase 1 lifecycle description.

**Depends on:** Nothing.

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

## TODO-003: Add 1093-05589 fixture and regression test for drawing extraction

**What:** Check in a sanitized fixture for the `1093-05589` drawing layout (or a text extraction snapshot) and add a regression test in `worker/src/extraction/pdfDrawing.test.ts` or `hybridExtraction.test.ts` asserting correct field extraction.

**Why:** The plan explicitly names `1093-05589` as a known regression. Without a fixture, the same extraction failure can silently recur with any parser change.

**Pros:** Prevents regression recurrence. The plan calls it out as a required deliverable.
**Cons:** Requires access to the original drawing or a sanitized snapshot. If the file contains sensitive customer data, it needs to be redacted or replaced with a synthetic equivalent before check-in.

**Context:** `PLAN.md` drawing extraction slice calls out this layout explicitly. `TEST_STRATEGY.md` states that drawing extraction changes must "add or update regression coverage for the failing layout." No fixture currently exists.

**Where to start:** `worker/src/extraction/` — add a fixtures directory with the sanitized drawing text payload. Use the `extractDrawingSmoke.ts` tool to capture the raw extraction output as the baseline.

**Depends on:** Access to the original drawing or a sanitized capture of its text extraction output.

---

## TODO-004: Optimistic disabled state for "Request Quote" button

**What:** Disable the "Request Quote" CTA immediately after first click and restore it only when the RPC resolves (success or error), preventing double-click during slow network conditions.

**Why:** The DB idempotency check prevents duplicate active requests, but a second click during a slow RPC call creates a confusing UX (two in-flight requests, one ignored). The button should respond immediately to the click rather than waiting for RPC completion.

**Pros:** Prevents user confusion on slow networks. Standard pattern for async form submissions.
**Cons:** Requires tracking in-flight state (a `useState<boolean>` or leveraging TanStack Mutation `isPending`). Zero schema changes.

**Context:** Identified during CEO plan review (2026-03-23). The DB-level idempotency is correct but UX-level protection is a distinct concern. Using TanStack Mutation's `isPending` state is the idiomatic approach already in use for other actions in this codebase.

**Where to start:** `ClientWorkspacePanelContent.tsx` or the quote request CTA component — bind `disabled` and `aria-disabled` to the mutation's `isPending` state.

**Effort:** S (human: ~1 hour / CC: ~5 min) | **Priority:** P2

**Depends on:** Quote request CTA shipped in this PR.

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

## TODO-009: Sanitize failure_reason before client exposure

**What:** Add a sanitization layer to `sync_quote_request_status_for_run` (or a client-side strip in `quote-request.ts`) ensuring that `failure_reason` only exposes allowlisted strings to the client — never raw exception messages or stack traces.

**Why:** `sync_quote_request_status_for_run(uuid, text)` persists the `p_failure_reason` parameter verbatim (after empty-string check) and is granted to `authenticated`. If the worker ever passes `error.message` or a raw exception string as `p_failure_reason`, it lands on the client UI. Currently the worker only uses hardcoded strings — but this is a latent injection path for any future worker change.

**Pros:** Eliminates a latent path from internal stack traces to client UI. Small diff — an allowlist CASE in the SQL function or a strip in the TypeScript view model.
**Cons:** Requires defining the canonical allowlist of safe failure strings. Any new worker failure reason must be added to the allowlist explicitly.

**Context:** Identified by Codex during CEO plan review (2026-03-23). Confirmed in `20260315110000_add_client_quote_requests.sql` lines 114-120 and grant at line 580.

**Where to start:** Option A: add a CASE allowlist in `v_failure_reason` computation in the migration, returning a generic message for any string not in the allowlist. Option B: add a client-side strip in `quote-request.ts` `buildQuoteRequestViewModel` before exposing `failure_reason`.

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

## TODO-DR-001: App UI layout — replace stacked card composition with layout primitives [CODEX-001]

**What:** The internal dashboard, client project view, and part review flow use stacked card grids as the primary layout pattern rather than purpose-built layout systems. Identified by Codex design audit as hard rejection trigger 7 ("App UI made of stacked cards instead of layout").

**Why:** Cards are appropriate when the card IS the interaction (e.g., selecting a quote). They're not appropriate as generic section wrappers. Using cards everywhere flattens visual hierarchy and makes the app look like generic SaaS. A dense table/split-pane layout with strong typography would give the internal dashboard a more purpose-built feel.

**How to apply:** `InternalHome.tsx:224` — the metric card row should be a compact stat bar above the main table, not 4 separate cards. `ClientProject.tsx:693,755` — parts list should anchor on a table layout, not nested card panels. `ClientPartReview.tsx:151` — review panels should use a 2-column split, not stacked cards.

**Where to start:** Start with `InternalHome.tsx` — it's the clearest case.

**Effort:** L (human: ~2 weeks / CC: ~2 hours) | **Priority:** P2

**Source:** /design-review on main, 2026-03-23

---

## TODO-DR-002: Spacing system — replace magic number one-offs with Tailwind scale [CODEX-002]

**What:** Pages like `ClientHome.tsx` and `ClientProject.tsx` use arbitrary bracket values (`mb-[22px]`, `gap-[14px]`, `p-[50px_30px]`, `w-[44%]`) throughout. These are not drawn from the 4/8px grid.

**Why:** Magic numbers make future spacing changes inconsistent and slow. One-off values accumulate into visual noise across the app. The color system is tokenized — spacing should be too.

**How to apply:** Audit `ClientHome.tsx` and `ClientProject.tsx` for all `[Xpx]` bracket values. Replace with nearest Tailwind scale steps (e.g., `mb-5` instead of `mb-[22px]`). Visual difference will be negligible; consistency benefit is real.

**Where to start:** `src/pages/ClientHome.tsx:91` — start with the hero section spacing, then work down.

**Effort:** M (human: ~3 days / CC: ~30 min) | **Priority:** P3

**Source:** /design-review on main, 2026-03-23

---

## TODO-DR-003: App shell viewport height — replace h-screen with svh units [CODEX-005]

**What:** App shells use `min-h-screen`/`h-screen` (= `100vh`) rather than `100svh` (small viewport height). On mobile browsers, `100vh` includes the browser chrome height, causing the app to be taller than the visible area.

**Why:** Mobile browser address bars collapse on scroll, making the visible viewport shorter than `100vh`. `svh` (small viewport height) measures the smallest viewport (with all browser chrome visible), which is the safe value for fixed-height shell layouts.

**Where to start:** `src/components/workspace/ClientWorkspaceShell.tsx:369,380` and `src/components/auth/GuestAppShell.tsx:56`.

**Effort:** S (human: ~2 hours / CC: ~10 min) | **Priority:** P2

**Source:** /design-review on main, 2026-03-23

---

## TODO-DR-004: Color system consistency — tokenize hardcoded values in app shells [CODEX-004]

**What:** Several shells and auth surfaces bypass the CSS variable token system with hardcoded hex, raw alpha percentages, and custom gradients. Key locations: `AppShell.tsx:53,62`, `GuestAppShell.tsx:56,145`, `AuthPanel.tsx:281`, `ClientWorkspaceShell.tsx:17,369`.

**Why:** Bypassing tokens makes future theme changes inconsistent and creates maintenance overhead. The token system exists — use it.

**Where to start:** `src/components/auth/GuestAppShell.tsx` — map the hardcoded values to the nearest token, add new tokens if needed.

**Effort:** M (human: ~1 week / CC: ~30 min) | **Priority:** P3

**Source:** /design-review on main, 2026-03-23

---

## TODO-DR-005: Hardcoded OpenAI green (#10a37f) in WorkspaceAccountMenu [subagent]

**What:** `WorkspaceAccountMenu.tsx` uses hardcoded `#10a37f` / `#7be0c0` / `#9ef0d6` — the OpenAI brand green — for a "powered by" badge or similar indicator. This is neither in the design token system nor a brand color for OverDrafter.

**Why:** Bypasses the token system and will look inconsistent if the app's accent color ever changes. Should use a token, or be removed if it's a vestigial GPT badge.

**Where to start:** `src/components/chat/WorkspaceAccountMenu.tsx:116,138,155` — identify what the color is used for, then either tokenize it or replace with the appropriate semantic token.

**Effort:** S (human: ~30 min / CC: ~5 min) | **Priority:** P2

**Source:** /design-review subagent on main, 2026-03-23

---

## TODO-DR-006: Arbitrary border-radius values — establish radius scale [subagent]

**What:** Components use a wide range of custom border-radius values (`rounded-[2px]`, `rounded-[10px]`, `rounded-[14px]`, `rounded-[16px]`, `rounded-[18px]`, `rounded-[20px]`, `rounded-[22px]`, `rounded-[24px]`, `rounded-[28px]`, `rounded-[30px]`, `rounded-[34px]`) with no pattern. The design system has `--radius: 0.625rem` but it's not enforced.

**Why:** Inconsistent border radii are a subtle but persistent source of visual noise. A 3-level scale (sm/md/lg) covers 90% of cases and makes the UI feel more intentional.

**Where to start:** Audit `QuoteList.tsx`, `ActivityLog.tsx`, `WorkspaceAccountMenu.tsx`, `CadModelThumbnail.tsx`. Map each arbitrary value to the nearest semantic size, add `--radius-sm`/`--radius-lg` tokens to `index.css` if needed.

**Effort:** M (human: ~2 days / CC: ~20 min) | **Priority:** P3

**Source:** /design-review subagent on main, 2026-03-23
