# OVD-572 design note: sourcing decisions across invalidity and refresh

Status: blocked. This note records why OVD-572 cannot meet its acceptance
criteria as a client only change, and what a later approved migration window
must carry. No code, schema or migration file changes ship with it.

Audited against `origin/main` at `3e27c25`.

## What the criteria need versus what exists

| Criterion | Current source | Gap |
| --- | --- | --- |
| Zero or one current decision; invalidity never silently substitutes another offer | `api_admin_invalidate_vendor_quote_offer` (`20260812045000_add_quote_offer_invalidation.sql`) sets `jobs.selected_vendor_quote_offer_id = null` when it invalidates the selected offer. The part controller (`src/features/quotes/use-client-part-controller.ts`, `selectedQuoteOption`) falls back to the first eligible option, then the first option, when the stored selection is not found. | The server erases the decision, so the client cannot show a visibly invalid selected state. The client fallback shows a substitute offer as selected. Only the client half can be fixed without schema. |
| Failed requote preserves prior generation; successful requote leaves fresh choices unselected | `api_list_client_quote_workspace` (`20260816015500_restore_production_first_quote_contracts.sql`, `latest_quote_runs`) picks the newest run by `created_at` with no status filter. `jobs.selected_vendor_quote_offer_id` carries no generation. | A failed newer run replaces the prior generation in the projection. There is no record of which generation a decision belongs to, so supersession on a successful run cannot be stated truthfully. Needs a projection change (migration). |
| Prior exact evidence remains accessible; selection history truthful and authorized | Only `client_selections` (published package path) and audit events exist. The job pointer path keeps no history. The projection returns one run only. | Needs an append only decision history table with RLS and a read API, plus a way to list prior generations. Needs a migration. |
| Migration/API/UI checks cover invalidation, lost response and refresh races | n/a | The criterion itself names migration checks. |
| Required checks and evidence | n/a | Follows the above. |

## Dependency on OVD-460

OVD-572 lists OVD-460 (exact automatic revision and requote confirmation) as a
blocker, and its October 8 planning note says to settle that baseline before
removing the dependency. OVD-460 is in the post beta backlog and unshipped, so
no client requote action exists to drive "failed requote" and "successful
requote" end to end. Generation supersession can still be defined at the run
level without OVD-460, but the requote UI races in the fourth criterion cannot.

## Proposed shape for the migration window

1. `public.job_quote_decisions`: append only rows `(id, job_id, organization_id,
   vendor_quote_offer_id null, quote_run_id, action select|clear|superseded|invalidated,
   actor, created_at)`. RLS: read via `user_can_access_job`; no direct writes.
   pgTAP: anon and other organization reads denied, direct insert/update/delete denied.
2. `api_set_job_selected_vendor_quote_offer`: append a decision row in the same
   transaction under the existing `jobs` row lock.
3. `api_admin_invalidate_vendor_quote_offer`: keep the selection pointer, append
   an `invalidated` row, and let the projection expose the selected offer with
   its public `invalidated_at`, so the UI shows it as invalid instead of
   clearing it. Selection of an invalidated offer stays rejected.
4. `latest_quote_runs`: choose the newest run that completed successfully for
   offers, and expose the newest run status separately so a failed requote is
   visible without hiding the prior generation. When a newer successful run
   lands, append `superseded` and clear the pointer in the same transaction.
5. `api_list_job_quote_generations(job_id)`: prior runs with their offers and
   decision rows, for previous version navigation.
6. Rollback: drop the new function and table, restore the prior function
   bodies from `20261002041305` and `20260816015500`.

## Work that can ship now as a separate child

Removing the client fallback in `selectedQuoteOption` (no selection shown when
the stored offer is absent, expired or not in the current options) is
independently testable and needs no schema. It satisfies part of the first
criterion only, so it should land under its own child issue rather than close
OVD-572.
