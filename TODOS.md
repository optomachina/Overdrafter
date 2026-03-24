# OverDrafter TODOs

Deferred work with context. Each item captures what, why, and where to start so it can be picked up independently.

---

## ~~TODO-001: Document quote_requests permanence vs service-request taxonomy relationship~~ ✅ DONE (local)

**Resolution:** Already documented in `ARCHITECTURE.md` under the quote orchestration layer. The architecture note explicitly defines `quote_requests` as intentional Phase 1 scaffolding rather than the permanent home for general service intent, while preserving it as a `manufacturing_quote`-scoped specialization that will coexist with the broader service-request line-item model described in `docs/service-request-taxonomy.md`.

**Verification evidence:** `ARCHITECTURE.md` now contains the architectural decision note clarifying the permanence boundary and taxonomy relationship, so `TODO-001` is resolved as doc-hygiene cleanup rather than new architecture work.

---

## ~~TODO-002: Rate limiting and cost controls for client-triggered Xometry requests~~ ✅ DONE (local)

**Resolution:** Shipped via `20260323190000_add_quote_request_guardrails.sql`, which adds a dedicated `quote_request_guardrails` table, helper functions for effective guardrails and pending estimated cost, and a forward-only `api_request_quote` replacement that enforces both per-user rolling-window throttling and an org-level pending-cost circuit breaker before new client-triggered Xometry work is queued.

**Verification evidence:** Targeted quote-request API and page tests now cover the new blocked `reasonCode` paths (`rate_limited_user`, `org_cost_ceiling_reached`), and the architecture/test strategy docs now explicitly describe the new guardrail behavior and verification expectations.

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

## ~~TODO-005: Accessibility attributes for new quote request UI surfaces~~ ✅ DONE (2d3c7a0, #102)

**Resolution:** Shipped in `2d3c7a0` via accessibility updates to the quote request UI and extraction provenance display. The request status card now uses `aria-live="polite"` for status updates, failed request detail uses `role="alert"`, blocked actions expose `aria-disabled`, and the model-fallback provenance badge exposes `aria-label="AI-assisted"`.

**Verification evidence:** `src/components/quotes/ClientWorkspacePanelContent.tsx` contains the `aria-live`, `role="alert"`, and `aria-disabled` attributes, `src/pages/internal-job-detail/InternalJobPartRequirementCard.tsx` renders the `AI-assisted` aria label, and the commit also added focused tests in `ClientWorkspacePanelContent.test.tsx` and `InternalJobPartRequirementCard.test.tsx`.

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

## ~~TODO-007: Mobile layout for part workspace B2 rail~~ ✅ DONE (23fb73f)

**Resolution:** The B2 part workspace shipped with a responsive single-column fallback. `ClientPart.tsx` renders the quote content first and the right rail below it by default, then promotes the layout to the 2:1 labeled-rail split only at `xl` via `xl:grid-cols-[2fr_1fr]`.

**Verification evidence:** `src/pages/ClientPart.tsx` contains the responsive grid breakpoint implementation, and commit `23fb73f` (`OVD-77 Implement B2 labeled-rail part workspace`) shipped the route refactor together with `ClientPart.test.tsx` updates and the companion `docs/part-workspace.md` layout spec refresh.

---

## ~~TODO-008: Cancellation UX for in-flight quote requests~~ ✅ DONE (local)

**Resolution:** Shipped via a new quote-request cancellation flow across Supabase, worker orchestration, and the client part/project status cards. Clients can now cancel `queued` and `requesting` quote requests from the status card UI with an explicit confirmation dialog. The backend adds `api_cancel_quote_request(p_request_id)`, marks the request `canceled`, cancels queued worker tasks for the linked run, and moves the quote run to the existing terminal `failed` state. The worker now treats canceled requests as terminal and skips re-promoting them after cancellation, including best-effort handling when cancellation happens mid-run.

**Shipped scope:** Status-card cancellation only; project table-row actions remain unchanged. Confirmation is required before cancellation. Client quote workspace projection now ignores runs whose linked quote request is `canceled`, so stale vendor results from a canceled request do not reappear in client UI.

**Verification evidence:** `npm run typecheck` passes. `npm test -- --run src/features/quotes/quote-request.test.ts src/components/quotes/ClientWorkspacePanelContent.test.tsx src/pages/ClientPart.test.tsx src/pages/ClientProject.test.tsx worker/src/queue.test.ts worker/src/httpServer.test.ts` passes, covering the new cancel view-model behavior, client confirmation flows, and worker queue cancellation guards.

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

## ~~TODO-DR-002: Spacing system — replace magic number spacing brackets with Tailwind scale [CODEX-002]~~ ✅ DONE (6f8c160, #100)

**Resolution:** Shipped in `6f8c160` as part of the design cleanup pass across `ClientHome.tsx` and `ClientProject.tsx`, replacing the targeted arbitrary spacing bracket values with the intended Tailwind spacing scale while preserving the deliberate bracketed font-size scale.

**Verification evidence:** Current `ClientHome.tsx` and `ClientProject.tsx` use the normalized spacing classes introduced by `6f8c160`, which was merged as `style(design): DR-002 + DR-004 + DR-006 — tokenize shell colors, spacing, and border-radius (#100)`.

---

## ~~TODO-DR-003: App shell viewport height — replace h-screen with svh units [CODEX-005]~~ ✅ DONE (73f26e4)

**Resolution:** Shipped in `73f26e4` by replacing the affected `h-screen` and `min-h-screen` shell usage with `h-svh` and `min-h-svh` in the client workspace shell and guest auth shell.

**Verification evidence:** `src/components/workspace/ClientWorkspaceShell.tsx` now uses `min-h-svh` and `h-svh`, `src/components/auth/GuestAppShell.tsx` uses `min-h-svh`, and `git log` shows the dedicated commit `style(design): DR-003 — replace h-screen / min-h-screen with svh units`.

---

## ~~TODO-DR-004: Color system consistency — tokenize hardcoded shell backgrounds [CODEX-004]~~ ✅ DONE (6f8c160, #100)

**Resolution:** Shipped in `6f8c160` by introducing `--ws-surface-shell`, `--ws-surface-deep`, and `--ws-surface-overlay` in `src/index.css`, wiring matching `ws.shell`, `ws.deep`, and `ws.overlay` aliases in `tailwind.config.ts`, and updating the shell components to use the new tokens instead of hardcoded hex backgrounds.

**Verification evidence:** The new shell tokens are defined in `src/index.css`, exposed through `tailwind.config.ts`, and consumed in `AppShell.tsx`, `AuthPanel.tsx`, `GuestAppShell.tsx`, and `ClientWorkspaceShell.tsx` on the current branch.

---

## ~~TODO-DR-005: Hardcoded OpenAI green (#10a37f) in WorkspaceAccountMenu [subagent]~~ ✅ DONE (cc86175)

**Resolution:** Shipped in `cc86175` by removing the hardcoded OpenAI-green treatment from `WorkspaceAccountMenu.tsx` and replacing it with the app's emerald token styling.

**Verification evidence:** `git log` shows the dedicated commit `style(design): DR-005 — replace hardcoded OpenAI green with emerald-500 tokens`, and the current `WorkspaceAccountMenu.tsx` notification badge classes use `emerald-500` token-based styling rather than the old hardcoded hex values.

---

## ~~TODO-DR-006: Arbitrary border-radius values — establish radius scale [subagent]~~ ✅ DONE (6f8c160, #100)

**Resolution:** Shipped in `6f8c160` by establishing `--radius-surface-sm` and `--radius-surface-lg`, exposing `rounded-surface-sm` / `rounded-surface-lg`, and migrating the targeted design-review files onto that radius scale.

**Verification evidence:** `src/index.css` defines the new radius tokens, `tailwind.config.ts` exposes the semantic radius classes, and current `ClientHome.tsx`, `ClientProject.tsx`, `CadModelThumbnail.tsx`, and `WorkspaceAccountMenu.tsx` now use `rounded-surface-sm` and `rounded-surface-lg` in the paths called out by the TODO.

---

## ~~TODO-DR-001b: Parts list table layout + ClientPartReview 2-column split [deferred from DR-001]~~ ✅ DONE (399a6a1, #106)

**Resolution:** Shipped in `399a6a1` by converting the `ClientProject.tsx` parts list to semantic table markup and updating `ClientPartReview.tsx` to use the deferred two-column review split.

**Verification evidence:** `ClientProject.tsx` now imports and renders `Table`, `TableHeader`, `TableBody`, `TableRow`, and `TableCell` for the parts list, `ClientPartReview.tsx` now uses the `xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]` two-column review layout, and the commit also updated `ClientProject.test.tsx` and `ClientReviews.test.tsx`.
