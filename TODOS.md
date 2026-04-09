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

## ~~TODO-014: Multi-vendor fan-out in `api_request_quote` (Phase 2 core)~~ ✅ DONE

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

## TODO-017: Protolabs and SendCutSend live adapter automation

**What:** Implement real Playwright automation for Protolabs and SendCutSend adapters (currently simulation-only). These are instant-quote providers that have more tractable APIs than Xometry.

**Why:** Phase 2 Task B ships Xometry + Fictiv live automation. Protolabs and SendCutSend are deferred because they are instant-quote providers that may have programmatic APIs or simpler automation surfaces. Phase 2 multi-vendor live value is proven with Xometry + Fictiv first.

**Blocking state:** Current adapter behavior (pre-Task-B) differs by adapter:
- **Protolabs** (`worker/src/adapters/protolabs.ts`): returns `status: "official_quote_received"` with **simulated non-null prices** (`unitPriceUsd`/`totalPriceUsd`) in `WORKER_MODE=live`. No `VendorAutomationError` guard exists — fake prices are indistinguishable from real quotes in the DB.
- **SendCutSend** (`worker/src/adapters/sendcutsend.ts`): returns `status: "manual_vendor_followup"` with null prices, but no `"not_implemented"` reason code.

Task B must add a `VendorAutomationError("not_implemented")` guard to both adapters so they route to `manual_vendor_followup` in live mode instead of returning simulated data.

**Where to start:** `worker/src/adapters/protolabs.ts` and `worker/src/adapters/sendcutsend.ts` — investigate whether instant-quote API endpoints exist before building Playwright automation. SendCutSend has a known instant-quote API.

**Effort:** M each (human: ~1 week / CC: ~1 day) | **Priority:** P2

**Depends on:** Task B (live harness + adapter guard pattern established)

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

**Resolution:** Shipped as PR #117. New `api_claim_next_task(p_worker_name text)` PL/pgSQL function using `FOR UPDATE SKIP LOCKED` now performs atomic, race-free task claiming in a single round-trip. `claimNextTask` in `worker/src/queue.ts` was updated to call `supabase.rpc("api_claim_next_task", { p_worker_name: workerName }).maybeSingle()`, replacing the prior SELECT+UPDATE two-step. The calling site in `worker/src/index.ts` is unchanged at the call level.

**Artifacts shipped:**
- Migration: `supabase/migrations/20260324120000_add_api_claim_next_task.sql`
- Updated: `worker/src/queue.ts` → `claimNextTask` now delegates to `api_claim_next_task` RPC
- Tests: `worker/src/queue.test.ts` — 3 `claimNextTask` tests verify RPC call shape, null return, and error propagation

**Verification:** `npm test -- --run worker/src/queue.test.ts` — 3/3 passing.

---

## ~~TODO-006: Extraction quality alert evaluation activation~~ ✅ DONE (local)

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

**Resolution:** Shipped via `20260406000000_add_extraction_quality_alerts.sql`, which adds `public.extraction_quality_alerts` (unique on `organization_id, alert_day, alert_type` for idempotent reruns) and `public.evaluate_extraction_quality_alerts(p_day)` — a `security definer` function that reads `extraction_quality_summary` for the given day and inserts one alert row per triggered metric per org, with `ON CONFLICT DO NOTHING`. Starting thresholds (`> 0.3000` fallback rate, `< 0.7000` auto-approve rate) are annotated with `-- CALIBRATE` comments. Types added to `src/integrations/supabase/types.ts`.

**Verification evidence:** `npm run typecheck` passes. `npm test -- --run src/features/quotes/extraction-quality-alerts.test.ts` — 16/16 passing, covering SQL contract assertions, threshold boundary conditions, zero-extraction skip, idempotency, and multi-org isolation.

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

---

## ~~TODO-023: Internal-only view for extraction provenance and worker queue details~~ ✅ DONE (local)

**Resolution:** Added a dedicated internal diagnostics panel to each part card on the internal job detail route. `InternalJobPartRequirementCard.tsx` now surfaces extraction provenance as a field-level table (source selector, confidence, review-needed), extractor/model metadata, and the approved requirement `spec_snapshot` JSON. It also shows part-scoped worker queue diagnostics (status, attempts, lock state, timestamps, last error, and payload) so internal staff can inspect extraction/queue state without direct DB queries. The diagnostics surface is internal-only and does not alter client-facing part UI.

**Verification evidence:** `InternalJobDetail.tsx` now passes `job.workQueue` into `InternalJobRequirementsSection`, which filters tasks by `part_id` and passes them into `InternalJobPartRequirementCard`. `InternalJobPartRequirementCard.test.tsx` includes coverage for rendering the internal diagnostics panel, approved spec snapshot content, and part queue details.

---

## TODO-018: Editable spec fields on part page

**Status:** ✅ **COMPLETE** (2026-04-07)

**What:** Add editable fields for material, finish, and quantity to the part page (`ClientPart.tsx`). Currently these are read-only after extraction. Frank needs to correct misextracted values without going to an internal admin view.

**Resolution:** The `ClientPartRequestEditor` component already provides full editing for material, finish, quantity, and all other spec fields on the part page (visible in `PartInfoPanel`). Fields are fully wired to the `api_update_client_part_request` RPC and use the existing mutation + query-invalidation pattern via `use-client-part-controller.ts`. No additional work needed.

**Evidence:**
- `src/components/quotes/ClientPartRequestEditor.tsx` lines 83–153: Material, Finish, and Quantity inputs
- `src/components/workspace/PartInfoPanel.tsx` lines 158–169: Editor integrated into part page
- `src/features/quotes/use-client-part-controller.ts` lines 308–317: Mutation already wired
- `src/features/quotes/api/jobs-api.ts` lines 1216–1290: `updateClientPartRequest` API function

**Context:** Deferred from Frank-Ready Sprint Track 3 as a layout-only change. Track 3 merged and delivered the part page redesign. Editing was added post-Track 3 and is now fully functional.

---

## TODO-019: "Reset to extracted" button on part spec fields

**Status:** ✅ **COMPLETE** (2026-04-08)

**What:** After editable spec fields (TODO-018) are added, provide a "reset to extracted" action per field that restores the original GPT-extracted value from `approved_part_requirements.spec_snapshot`.

**Why:** Frank may edit a field incorrectly and want to go back to what was extracted. Without a reset path, the original extracted value is effectively lost once overwritten.

**Resolution:** Client part request editing now supports per-field reset affordances plus a "Reset all to extracted" action. Resets are wired from `ClientPartRequestEditor` through the part-page controller to `api_reset_client_part_property_overrides`, which clears property overrides and re-resolves defaults from the requirement snapshot state.

**Evidence:**
- `src/components/quotes/ClientPartRequestEditor.tsx`: per-field reset buttons and reset-all CTA.
- `src/pages/ClientPart.tsx`: passes reset handlers + extracted defaults into `PartInfoPanel`.
- `src/features/quotes/use-client-part-controller.ts`: invokes `resetClientPartPropertyOverrides` and invalidates workspace queries.
- `src/features/quotes/api/jobs-api.ts`: dedicated RPC client call to `api_reset_client_part_property_overrides`.
- `supabase/migrations/20260402120000_persist_project_part_property_overrides.sql` and `supabase/migrations/20260408120000_add_revision_process_to_property_overrides.sql`: reset RPC implementation.
- `src/components/quotes/ClientPartRequestEditor.test.tsx`, `src/features/quotes/client-workspace-fixtures.test.ts`, and `src/features/quotes/api.test.ts`: reset behavior coverage.

**Pros:** Safety net for edits. Makes editing feel low-risk — Frank can try a correction and undo it. Provenance is already stored in `spec_snapshot`.

**Cons:** Requires surfacing per-field reset affordance in the UI without adding visual noise. UX judgment needed.

**Context:** Deferred from Frank-Ready Sprint Track 3. Explicitly called out as out of scope in the design doc. Identified as "NOT in scope" during /plan-eng-review on 2026-03-31.

**Where to start:** `approved_part_requirements.spec_snapshot` already stores the raw extracted values. The reset action is a targeted write back to the editable fields from the snapshot.

**Effort:** S (human: ~2 hours / CC: ~10 min) | **Priority:** P2

**Depends on:** TODO-018 (editable spec fields).

---

## TODO-020: Stripe card payment integration (pre-Frank)

**Status:** 🔄 **IN PROGRESS** — escalated to pre-Frank priority (2026-04-08)

**What:** Add Stripe card payment to `ClientProjectReview.tsx`. Frank completes the `ProcurementHandoffPanel` (shipping/billing/PO context), then sees a payment step below it. Stripe Elements card input. Payment Intent with delayed capture: authorize at checkout, capture after Xometry order placement confirms. Stripe webhook handler with signature verification and idempotency.

**Why:** Frank has agreed to pay in full for the first order. The `ProcurementHandoffPanel` "manual follow-up" stub is not a real payment path. Stripe must ship BEFORE Frank's first real session, not after — the prior deferral was wrong.

**Pros:** Converts the first real quote into a transaction. Real revenue. Frank sees a complete loop.

**Cons:** Stripe integration, webhook handling, payment migration, and delayed capture are non-trivial. Must ship alongside live harness (Task B) — don't build Stripe before Task A passes.

**Context:** Priority escalated from "after Frank's first paid session" in /plan-eng-review on 2026-04-08. Design doc: `blainewilson-claude-gracious-ritchie-design-20260408-175506.md`. Enable Stripe Chargeback Protection ($0.25/txn) in Stripe dashboard.

**Implementation notes:**
- Preserve `ProcurementHandoffPanel` — add payment step below it, don't replace it
- New Supabase edge function: `create-payment-intent` (server-side, keeps Stripe secret key off client)
- New Supabase edge function: `stripe-webhook` (signature verification via `stripe.webhooks.constructEvent()` required)
- New migration: `payments` table with state machine (authorized → captured / canceled / failed), `stripe_payment_intent_id` unique constraint for idempotency
- Session-expiry guard before capture: if Playwright session stale → cancel Payment Intent → create `manual_vendor_followup` record
- Lazy-load `@stripe/stripe-js` via `loadStripe()` on user action (don't bundle eagerly)
- Add Stripe test keys to CI before writing E2E tests
- Client-side error state: if `create-payment-intent` returns 500, show "Payment setup failed. Try again or contact support."

**Payment state machine:**
```
AUTHORIZED → CAPTURED (Xometry order placed)
           → CANCELED (session stale or order failed)
           → FAILED (Stripe error)
```

**Where to start:** `src/pages/ClientProjectReview.tsx` — add payment section below `ProcurementHandoffPanel`. Then `supabase/functions/create-payment-intent/` → `supabase/functions/stripe-webhook/` → migration.

**Effort:** L (human: ~2 weeks / CC: ~2 hours) | **Priority:** P0 (pre-Frank, blocks first transaction)

**Depends on:** Task A gate pass. Stripe account configured with Chargeback Protection. `XOMETRY_STORAGE_STATE_PATH` set in production.

---

## TODO-021: Per-job and per-project vendor preferences

**Status:** ✅ **COMPLETE** (2026-04-08)

**What:** Allow Frank to pin or exclude specific vendors per job or per project. Currently `api_request_quote` fans out to all org-enabled applicable vendors. Frank may want to always use vendor X for aluminum parts or exclude vendor Y for a specific project.

**Why:** Frank manages multiple RFQ batches with different vendor relationships. Blanket org-level vendor config is too coarse for his workflow once he's using the system regularly.

**Resolution:** Added persisted `project_vendor_preferences` and `job_vendor_preferences` with client-safe API setters/getter, then merged those preferences into quote fan-out before `vendor_quote_results` and `work_queue` rows are created. The project inspector now exposes vendor controls for both project defaults and part-specific overrides (Default/Pin/Exclude per vendor).

**Evidence:**
- `supabase/migrations/20260408193000_add_project_and_job_vendor_preferences.sql`: new preference tables, RPC APIs, preference-aware helper overload, and updated `api_request_quote`.
- `src/features/quotes/api/vendor-preferences-api.ts`: client API for loading and saving project/job vendor preferences.
- `src/features/quotes/use-client-project-controller.ts`: query/mutation wiring for inspector preference controls.
- `src/pages/ClientProject.tsx`: project inspector vendor preference UI and interactions.
- `src/features/quotes/vendor-preferences-migration.test.ts`, `src/features/quotes/api/vendor-preferences-api.test.ts`, `src/pages/ClientProject.test.tsx`: migration/API/UI coverage for the new behavior.

**Pros:** Reduces noise from irrelevant vendor quotes. Matches how Frank already manages vendor relationships manually (some vendors are better for certain materials or lead times).

**Cons:** Adds preference persistence (new table or JSON column), UI for preference editing, and logic in `api_request_quote` to merge org-level config with job/project overrides.

**Context:** Listed as remaining adjacent work under TODO-014. Identified as "NOT in scope" during /plan-eng-review on 2026-03-31. Phase 2 core.

**Where to start:** `supabase/migrations/` — add `job_vendor_preferences` or `project_vendor_preferences` table. Update `get_enabled_client_quote_vendors()` to accept and merge override preferences. UI: a vendor selector in the part or project inspector panel.

**Effort:** M (human: ~1 week / CC: ~45 min) | **Priority:** P2

**Depends on:** Multi-vendor fan-out (TODO-014, shipped). Frank-Ready Sprint merged.

---

## ~~TODO-022: Client comparison UI for vendor-level in-flight state and results~~ ✅ DONE (b27a91c, #212)

**Resolution:** Shipped in `b27a91c` via vendor-level in-flight status indicators in `ClientQuoteDecisionPanel` (pending, fetching, failed, review, follow-up, stale), plus `vendorStatus` propagation from `vendor_quote_results.status` in quote selection option building.

**Verification evidence:** `src/features/quotes/selection.ts` now includes `vendorStatus` in `ClientQuoteSelectionOption` and sets it from each quote row, while `src/components/quotes/ClientQuoteDecisionPanel.tsx` renders `VendorStatusBadge` in table, card, and mobile layouts.

---

## TODO-023: Fictiv live automation (recon + implementation)

**What:** Build real Playwright automation for the Fictiv adapter (`worker/src/adapters/fictiv.ts`). The adapter currently throws `VendorAutomationError("not_implemented")` in live mode. Phase 2 Task B requires both Xometry and Fictiv live quotes to pass the openclaw gate.

**Why:** `openclawGate.ts` requires `realQuoteVendorCount >= TARGET_VENDORS.length` where `TARGET_VENDORS = ["xometry", "fictiv"]`. Without Fictiv live automation, Task A gate will never pass regardless of Xometry working.

**Blocking state:** Current `fictiv.ts` is a 67-line stub. Xometry adapter is 777 lines of full Playwright automation built through prior openclaw usage. Fictiv has been quoted through openclaw previously — that experience is the primary reference for mapping the automation surface.

**Recon first:** Before writing the adapter, map Fictiv's quoting flow:
- Session model (cookies, localStorage, headers)
- Auth sequence (login flow, session storage path)
- Quote form selectors (file upload, material/process selection, quantity)
- Quote result extraction (price, lead time, quote URL)
- Anti-detection patterns (rate limits, bot detection signals)

**Where to start:** Run `npm --prefix worker run auth:xometry` as the model — replicate the pattern for a `xometryAuth`-equivalent tool for Fictiv. Map the Fictiv quoting UI manually in a Chromium session before writing selectors.

**Effort:** M-L (human: ~1 week / CC: ~2 hours after recon) | **Priority:** P1 (required for Task A gate pass)

**Depends on:** Prior openclaw Fictiv quote runs as reference. Xometry live automation complete (to establish pattern).

---

## TODO-024: Xometry session freshness health signal

**What:** Add a proactive "session is stale" health signal to the worker, so operators can detect Xometry auth expiry before it fails a live quote run. Currently, session expiry is only caught at quote time via `login_required` error (non-retryable, task fails).

**Why:** The design doc (2026-04-08) identifies session rotation as a known risk for live mode. Session expiry mid-capture-window is a payment-state risk. A proactive health signal turns a reactive failure into an operational alert.

**Pros:** Operators can re-auth before a quote run starts. Reduces "payment authorized, order failed" incidents.
**Cons:** Requires a lightweight session validation step on the health server poll interval, or a cron-style pre-flight check.

**Context:** Identified during /plan-eng-review 2026-04-08. The health server (`worker/src/index.ts:1264`) already exists — this adds a session freshness field to its response.

**Where to start:** `worker/src/index.ts` health server or a standalone session-check helper that loads the storage state file, checks its mtime vs. a configurable threshold (e.g., 7 days), and surfaces `xometry_session_age_days` in the `/health` response.

**Effort:** S (human: ~2 hours / CC: ~10 min) | **Priority:** P2

**Depends on:** Xometry live mode enabled (Task B).
