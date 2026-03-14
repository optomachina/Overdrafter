# Part Workspace

## Scope
- Refactors the client part route at `src/pages/ClientPart.tsx` without changing `ChatWorkspaceLayout`, `WorkspaceSidebar`, `WorkspaceAccountMenu`, or `AppShell`.
- Keeps existing sidebar actions, search, archive, project membership, and file attach flows intact.
- Basic client part flows must remain available when optional project-collaboration schema is missing. In that mode, part loading and archive/unarchive continue to work, while project labels and project-management affordances degrade cleanly instead of blocking the workspace.
- Optional client activity/history surfaces must also degrade cleanly. If the client activity feed RPC is unavailable in an older environment, the part workspace and notification center render with empty activity state instead of failing the page.
- Raw client read queries must not directly select optional request-intent columns such as `jobs.requested_service_kinds`. Client quote/workspace reads must go through the compatibility accessor in `src/features/quotes/api.ts` so older schemas keep loading with normalized defaults.

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
- The editor now exposes the approved client-safe subset of the broader RFQ model defined in [docs/rfq-metadata-model.md](./rfq-metadata-model.md). Internal-only release review fields still stay on internal surfaces and are stripped from client fetches.

## Empty States
- No quotes yet
- No eligible quotes after due-date filtering
- Missing drawing preview
- Missing CAD preview

## Extension Points
- Quote list rows already surface domestic/foreign state, expedite hints, and exclusion toggles.
- Detail form now stores client-safe RFQ metadata sections in `spec_snapshot`, leaving internal-only release review controls on the estimator path.
- Future manufacturing review UI should stay on internal-only surfaces and consume derived service-line-item review state such as DFM/DFA summaries, blocker rollups, and engineering checkpoints instead of extending the client-safe request editor with review-only fields.
