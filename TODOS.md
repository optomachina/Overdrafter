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
