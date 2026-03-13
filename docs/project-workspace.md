# Project Workspace

## Scope
- Refactors the existing client project route at `src/pages/ClientProject.tsx`.
- Leaves the protected sidebar and shell untouched.
- Reuses the existing project dialogs for add part, rename, archive, dissolve, and membership management.

## Layout
- Top bar with project name, request summary, bulk actions, and review CTA.
- Summary strip showing selected total, selected line count, domestic count, and foreign/unknown count.
- Main content:
  - dense procurement table
  - desktop right-side detail rail
  - mobile `Sheet` drawer for the same detail content

## Data Model
- New batch fetch: `fetchClientQuoteWorkspaceByJobIds(jobIds)`
- Each table row now has:
  - job record
  - summary metadata
  - selected quote option
  - preview metadata
  - latest quote run reference

## Table Columns
- part
- rev
- qty
- process
- material
- finish
- source
- vendor
- price
- lead time / delivery
- status

## Bulk Selection
- Bulk presets use the shared selection utility:
  - `Cheapest`
  - `Fastest`
  - `Domestic`
- Rules:
  - excluded vendors are ignored
  - late options are ignored when a due date exists
  - only eligible persisted offers are selected
- Revert behavior:
  - only the most recent bulk action is stored
  - rows manually changed after bulk apply are not overwritten on revert

## Detail Drawer
- Inline drawing preview
- CAD/isometric preview
- Editable metadata/RFQ form
- Manual quote option selection
- Vendor exclusion toggles
- Revised upload action for the focused line item
- Activity log
- The drawer reuses the same client-safe RFQ metadata subset as the part page, including shipping, certification, sourcing, and release-status sections. Internal-only release review controls remain restricted to internal review surfaces. The broader project-vs-line-item RFQ contract is defined in [docs/rfq-metadata-model.md](/Users/blainewilson/code/overdrafter-symphony-workspaces/OVD-38/docs/rfq-metadata-model.md).

## State Notes
- Selected quote totals update immediately via local optimistic overrides, then reconcile against the persisted server value.
- Vendor exclusions are stored in localStorage per job.
- Editable request drafts are stored per focused line item and saved through `updateClientPartRequest(...)`.

## Empty States
- Empty project filter result
- No quote options for a line item
- No selected quote on a row
- Missing preview assets
