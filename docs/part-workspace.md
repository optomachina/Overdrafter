# Part Workspace

## Scope
- Refactors the client part route at `src/pages/ClientPart.tsx` without changing `ChatWorkspaceLayout`, `WorkspaceSidebar`, `WorkspaceAccountMenu`, or `AppShell`.
- Keeps existing sidebar actions, search, archive, project membership, and file attach flows intact.

## Layout
- Header with part title, project/batch badges, request summary badges, and actions for project membership, file attach, and review.
- Upper comparison region with adjacent drawing and CAD/isometric panels.
- Quote comparison section with preset controls, scatter chart, and ranked quote list.
- Lower detail region with a collapsible editable metadata/RFQ form and a lightweight activity log.

## Quote Selection
- Uses `src/features/quotes/selection.ts` for normalized client-facing quote options.
- Presets:
  - `Cheapest`
  - `Fastest`
  - `Domestic`
- Presets ignore excluded vendors and any quote that cannot satisfy the requested due date.
- Manual row or chart selection clears the active preset and persists through `api_set_job_selected_vendor_quote_offer`.
- Vendor labels are anonymized per workspace as `Vendor A`, `Vendor B`, and so on.

## Preview Panels
- Drawing panel uses `ClientDrawingPreviewPanel` with inline page switching and a download action.
- CAD panel uses `ClientCadPreviewPanel` and reuses `CadModelThumbnail` for STEP/STP previews.
- Missing PDF and missing CAD are explicit empty states instead of silent gaps.

## Editable Metadata
- Shared request form component: `src/components/quotes/ClientPartRequestEditor.tsx`
- Editable fields:
  - part number
  - description
  - revision
  - material
  - finish
  - tightest tolerance
  - process
  - notes
  - qty
  - quote quantities
  - due date
  - packaging notes
  - shipping notes
  - certification requirements
  - sourcing preferences
  - release status
- Save path:
  - client page calls `updateClientPartRequest(...)`
  - backend persists through `api_update_client_part_request`
- Revised files still attach to the same job/line item via the existing upload and reconcile flow.
- The editor now exposes the approved client-safe subset of the broader RFQ model defined in [docs/rfq-metadata-model.md](/Users/blainewilson/code/overdrafter-symphony-workspaces/OVD-38/docs/rfq-metadata-model.md). Internal-only release review fields still stay on internal surfaces and are stripped from client fetches.

## Empty States
- No quotes yet
- No eligible quotes after due-date filtering
- Missing drawing preview
- Missing CAD preview

## Extension Points
- Quote list rows already surface domestic/foreign state, expedite hints, and exclusion toggles.
- Detail form now stores client-safe RFQ metadata sections in `spec_snapshot`, leaving internal-only release review controls on the estimator path.
