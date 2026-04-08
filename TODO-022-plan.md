# TODO-022: Client Comparison UI for Vendor-Level In-Flight State

## Context

After `api_request_quote` fans out to multiple vendors in parallel, the UI needs to show real-time status of each vendor lane—which vendors have responded, which are pending, and what each quote looks like side-by-side before selection. Currently, the `ClientQuoteDecisionPanel` only shows options when they have complete quote data.

The database has `vendor_quote_results.status` with values: `queued`, `running`, `instant_quote_received`, `official_quote_received`, `manual_review_pending`, `manual_vendor_followup`, `failed`, `stale`.

## Current State

- `ClientQuoteSelectionOption` (in `src/features/quotes/selection.ts`) has no `status` field
- UI only shows options with complete quote data
- Polling checks extraction lifecycle, not quote fan-out status

## Implementation Plan

### 1. Add vendor status to ClientQuoteSelectionOption
**File:** `src/features/quotes/selection.ts`
- Add `vendorStatus?: VendorStatus` to the `ClientQuoteSelectionOption` type

### 2. Update buildClientQuoteSelectionOptions to include status
**File:** `src/features/quotes/selection.ts`
- Map `vendorQuote.status` to the new `vendorStatus` field in options
- Handle case where vendor quote might not exist (shows as "pending")

### 3. Add vendor status indicator to UI components
**Files:** `src/components/quotes/ClientQuoteDecisionPanel.tsx`

Add visual indicators for status:
- `queued`: gray spinner or "pending" label
- `running`: animated spinner or "fetching..."
- `instant_quote_received` / `official_quote_received`: show price/delivery
- `failed`: error indicator
- `manual_review_pending` / `manual_vendor_followup`: warning indicator

The status should appear in the table/cards next to the vendor name.

### 4. Extend polling for quote fan-out
**File:** `src/features/quotes/use-client-project-controller.ts`

Add polling for vendor quote statuses:
- Check if any vendor has status in `['queued', 'running']`
- If so, continue polling at 5s intervals

### 5. Add test coverage
- Add tests for vendor status in selection.test.ts
- Add tests for UI components showing pending states

## Critical Files to Modify

- `src/features/quotes/selection.ts` — Add status to type and mapping
- `src/components/quotes/ClientQuoteDecisionPanel.tsx` — Add status indicators
- `src/features/quotes/use-client-project-controller.ts` — Extend polling logic

## Verification

1. Run `npm run typecheck` to verify types
2. Run `npm run test` to verify tests pass
3. Test manually: request a quote and verify UI shows pending vendors with status indicators before they respond

## Effort Estimate

M (human: ~1 week / CC: ~30 min) — This aligns with the TODO-022 estimate.