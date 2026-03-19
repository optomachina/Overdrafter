# Selection Logic

## Scope
- Shared quote-selection rules for both the single-part and project workspaces.
- Covers normalization, domestic classification, due-date eligibility, preset ranking, project bulk application, revert behavior, and totals.

## Normalized Option Model
- Each client-facing option is normalized from a vendor quote result plus one offer lane.
- Normalized fields include:
  - stable option key
  - persisted offer id when selectable
  - vendor key
  - stored vendor and lane context
  - requested quantity
  - unit price
  - total price
  - lead time
  - resolved delivery date
  - domestic status
  - expedite flag
  - due-date eligibility
  - exclusion state

## Eligibility Rules
- Presets only consider options that:
  - have a selectable offer id
  - are not excluded for that job
  - are on time when a requested due date exists
- Delivery resolution order:
  1. `shipReceiveBy`
  2. `dueDate`
  3. `quoteDateIso + leadTimeBusinessDays`
  4. `today + leadTimeBusinessDays`
- If a due date exists and no delivery date can be resolved, the option is ineligible for presets.

## Presets
- `Cheapest`: eligible options sorted by total price ascending, then lead time.
- `Fastest`: eligible options sorted by resolved delivery date / lead time ascending, then total price.
- `Domestic`: eligible domestic options sorted by total price ascending, then lead time.
- If no candidate exists for a preset, the current manual selection is preserved.

## Vendor Exclusions
- Exclusions are stored locally per job.
- Excluding a vendor does not remove a previously selected manual option from the job.
- Exclusions only affect preset ranking and bulk selection.

## Bulk Apply And Revert
- Bulk apply evaluates each job independently with the shared preset helper.
- The last bulk action snapshot stores `{ jobId, previousOfferId, appliedOfferId }`.
- Revert restores only jobs still on the bulk-applied offer, so later manual overrides are not clobbered.

## Totals
- Project and review totals sum selected option total prices.
- Domestic/foreign summary counts are derived from selected options:
  - `domestic`
  - `foreign`
  - `unknown`

## Client-Facing State Vocabulary
- Client workspaces reuse three client-safe state tones:
  - `ready`
  - `warning`
  - `blocked`
- `ready` means the current workspace has a usable next step for the client, such as comparing eligible quotes or reviewing a completed selection.
- `warning` means the client can keep moving, but an important operational cue is still visible, such as extraction warnings, failed quote lanes with fallback options still available, vendor follow-up still in progress, or some options missing the requested date.
- `blocked` means the client cannot complete the next quote-selection step yet, such as missing CAD for quote comparison, no eligible option remaining, quote responses not yet selectable, or a review route missing a required selection.

## Client-Facing Reason Rules
- Part, project, review, and sidebar surfaces should derive client-facing reasons from the same underlying signals rather than inventing route-specific labels.
- Quote-option rows surface the stored vendor and lane context alongside selection constraints:
  - `Needs review before selection`
  - `Misses requested date <date>`
  - `Excluded from presets`
  - `Not eligible for Domestic preset`
- Preset failure copy should stay actionable and client-safe:
  - due-date misses explain that no quote currently meets the requested date
  - domestic preset failures explain that no domestic quote is ready
  - non-selectable responses explain that quote responses still need review
  - excluded-only states explain that current lanes are excluded from presets

## Review Surface Rule
- Review routes require a completed selection for each line item.
- A line item may be `ready to select` inside part or project workspaces but still appear as `blocked` in review until a quote is actually selected.
