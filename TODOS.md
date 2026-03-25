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

## ~~TODO-010: Regenerate Supabase types to include `api_cancel_quote_request`~~ ✅ DONE

**Resolution:** `cancelQuoteRequest` in `src/features/quotes/api/quote-requests-api.ts:82` already uses `callRpc` — the type-safe wrapper. No type regeneration was needed; the implementation was correct from the start.

**Effort:** XS (human: ~15 min / CC: ~2 min after DB access) | **Priority:** P2

---

## ~~TODO-011: Worker observability — task duration and failure-rate metrics~~ ✅ DONE

**What:** Add structured logging for task duration (start time → end time) and failure rates. Options:
- Add `task_duration_ms` field to worker's existing structured log events (`worker.task.complete`, `worker.task.failure`)
- Add a running counter for failures-per-hour visible in the health server endpoint (`/health`)
- Or instrument via a Supabase scheduled function that reads `work_queue` failure counts

**Why:** Without duration/failure-rate visibility, production extraction and quote-request regressions are invisible until a client reports a problem. The dead-task reaper now logs reaped counts — extending that to task duration is the natural next step.

**Pros:** Proactive detection of degraded worker performance before it impacts clients.
**Cons:** Requires deciding between log-based vs. metric-based observability. Log-based is easier to ship.

**Context:** Identified during /autoplan (2026-03-23). TODO-006 covers extraction quality alerting; this TODO covers worker task-level observability.

**Where to start:** `worker/src/index.ts` — add `task_duration_ms: Date.now() - taskStartMs` to the `worker.task.complete` and `worker.task.failure` log payloads.

**Effort:** S (human: ~2 hours / CC: ~5 min) | **Priority:** P2

**Depends on:** Nothing.

**Resolution:** Added `task_duration_ms: Date.now() - taskStartMs` to the `worker.task.complete`, `worker.task.failure`, and `worker.task.retry` log event contexts in `worker/src/index.ts`. The start timestamp is captured immediately before `processTask` is called and spread into each exit-path log payload.

---

## ~~TODO-012: Loading skeleton for quote-request-in-flight UI state~~ ✅ DONE

**Resolution:** Skeleton already shipped in `src/components/quotes/ClientWorkspacePanelContent.tsx` — the `isBusy` prop triggers two `animate-pulse` skeleton lines in place of the status detail text, with an `aria-label="Submitting…"` wrapper for accessibility.

**Effort:** XS (human: ~30 min / CC: ~5 min) | **Priority:** P2

---

## ~~TODO-013: `service_request_line_items` schema + migration (Phase 2 core)~~ ✅ DONE (local)

**Resolution:** Shipped via `20260324000000_add_service_request_line_items.sql`, which adds `public.service_request_line_items` as the authoritative service-work table, links `quote_requests` through the new nullable `service_request_line_item_id` FK, backfills one part-scoped `manufacturing_quote` line item per existing quoted job, and replaces `api_request_quote` so new client-triggered quote requests create or reuse the linked line item and return its id in the RPC payload.

**Why:** ARCHITECTURE.md explicitly calls `quote_requests` "Phase 1 scaffolding scoped to manufacturing_quote." Service line items are the intended authoritative model. All Horizon 2 themes (assembly workflows, manufacturing review, fulfillment tracking) depend on this table existing.

**Verification evidence:** Added `src/features/quotes/service-request-line-items-migration.test.ts` to assert the new table, constraints, backfill, and RPC replacement SQL, and updated API/UI request tests to accept the new `serviceRequestLineItemId` field. Final verification should include `npm run db:reset` when local Supabase/Docker is available.

---

## TODO-014: Multi-vendor fan-out in `api_request_quote` (Phase 2 core) ✓

Completed on March 24, 2026.

Shipped scope:
- added `org_vendor_configs` plus `get_enabled_client_quote_vendors(...)`
- expanded `api_request_quote` to seed one request, one run, and many vendor lanes/tasks across enabled applicable vendors
- made pending-cost guardrails lane-based across all vendors
- generalized request lifecycle copy away from Xometry-only wording

Remaining adjacent work:
- per-job or per-project persisted vendor preferences
- client comparison UI that surfaces vendor-level in-flight state and results
- richer internal tooling for editing org vendor config

---

## ~~TODO-016: Add `locked_at` index to `work_queue` for reaper query performance~~ ✅ DONE (local)

**What:** Add a partial index to `work_queue` supporting the reaper's access pattern:
```sql
create index concurrently idx_work_queue_reaper on public.work_queue(locked_at)
  where status = 'running';
```
This makes the `reapStaleTasks()` query efficient even as the table grows.

**Resolution:** Shipped via `20260324010000_add_work_queue_reaper_index.sql`, which adds the partial index covering `(locked_at)` WHERE `status='running'` using `CREATE INDEX CONCURRENTLY` so queue writes are not blocked while the index is built. This eliminates the sequential scan of the running partition when `reapStaleTasks()` queries for stale locked tasks.

**Why:** `reapStaleTasks()` queries `WHERE status='running' AND locked_at < cutoff`. The current index `idx_work_queue_dispatch(status, task_type, available_at)` doesn't cover `locked_at`, forcing a sequential scan of the `running` partition. Fine now (running set is tiny), but becomes a performance issue under load.

**Verification evidence:** The migration file `supabase/migrations/20260324010000_add_work_queue_reaper_index.sql` is in place. The partial index covers the exact query pattern used by `worker/src/queue.ts:reapStaleTasks()`.

---

## ~~TODO-015: Worker `FOR UPDATE SKIP LOCKED` task claiming~~ ✅ DONE

**What:** Replace the current `claimNextTask` SELECT+UPDATE pattern in `worker/src/queue.ts` with a Supabase RPC that uses `SELECT ... FOR UPDATE SKIP LOCKED` for atomic, race-free task claiming.

**Why:** The current pattern does a SELECT then UPDATE with `.eq("status", "queued")` as an optimistic concurrency check. Two worker instances could both SELECT the same task simultaneously; the second UPDATE would get 0 rows and return null — silently losing the claim. This is safe for a single worker deployment but fragile for multi-worker.

**When:** Before multi-worker deployment. Not needed for single-instance.

**Where to start:** New `api_claim_next_task(p_worker_name text)` PL/pgSQL function using `FOR UPDATE SKIP LOCKED`. Replace `claimNextTask` call in `worker/src/index.ts`.

**Effort:** S (human: ~3 hours / CC: ~10 min) | **Priority:** P2

**Depends on:** Multi-worker deployment decision.

---

## TODO-006: Extraction quality alert evaluation activation

**What:** Groundwork is shipped locally for extraction-quality thresholding:
- `worker.extraction_completed` now carries immutable observability fields needed for calibration
- `public.extraction_quality_summary` rolls up daily UTC metrics from append-only `audit_events`
- architecture and test strategy docs now define the calibration boundary

The remaining follow-up is to activate alert evaluation after production has at least 14 full UTC days of summary data:
- alert if `model_fallback_rate > 0.3000`
- alert if `auto_approve_rate < 0.7000`

**Why:** Without thresholds, extraction quality degradation is invisible until a client reports a bad quote. But hard-coding live alerts before a baseline exists would create noisy thresholds with weak operational signal.

**Next implementation slice:** Add:
- `public.extraction_quality_alerts`
- `public.evaluate_extraction_quality_alerts(p_day date default current_date - 1)`
- optional scheduler after the evaluator contract is validated

Recommended evaluator behavior:
- evaluate the previous UTC day only
- insert one row per triggered metric per org per day
- persist alerts first; notification fan-out can follow in a separate task

**Calibration step before activation:** Run `SELECT * FROM extraction_quality_summary ORDER BY day DESC LIMIT 14;` after 14 full UTC days of production data, then confirm or revise the `30%` / `70%` starting thresholds before implementing the evaluator.

**Effort:** S (human: ~3 hours / CC: ~10 min after baselines established) | **Priority:** P2

**Depends on:** `extraction_quality_summary` view in production for at least 14 full UTC days.

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
