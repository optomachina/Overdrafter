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
  - anonymized vendor label
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
