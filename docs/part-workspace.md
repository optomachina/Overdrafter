# Part Workspace

## Scope
- Refactors the client part route at `src/pages/ClientPart.tsx` without changing `ChatWorkspaceLayout`, `WorkspaceSidebar`, `WorkspaceAccountMenu`, or `AppShell`.
- Keeps existing sidebar actions, search, archive, project membership, and file attach flows intact.
- Basic client part flows must remain available when optional project-collaboration schema is missing. In that mode, part loading and archive/unarchive continue to work, while project labels and project-management affordances degrade cleanly instead of blocking the workspace.
- Optional client activity/history surfaces must also degrade cleanly. If the client activity feed RPC is unavailable in an older environment, the part workspace and notification center render with empty activity state instead of failing the page.
- Raw client read queries must not directly select optional request-intent columns such as `jobs.requested_service_kinds`. Client quote/workspace reads must go through the compatibility accessor in `src/features/quotes/api.ts` so older schemas keep loading with normalized defaults.

## Layout
- The application header owns the part title. The part surface adds description and project context, one primary file-attach action, and an overflow menu for favorite and project actions. Revision navigation lives in the inspector.
- The main workspace is a linear manufacturing record: part identity, one dominant artifact preview, compact part information, quote criteria, scatter chart, ranked quote list, then secondary activity/history.
- The artifact preview uses a `CAD | Drawing` switch. Previewable STEP/STP CAD is selected by default; drawing is the fallback when CAD cannot be previewed. Native CAD remains selectable for download.
- Quote comparison is always present in the main flow rather than hidden behind a tab. Criteria stay immediately above the chart, and the chart and ranked list continue to share selection state.
- Unsupported-package guidance appears before comparison when the user must resolve a blocker. Provider-only recommendations also precede an otherwise empty comparison; fallback recommendations accompanying live offers follow the comparison.
- Editable requirements, revisions, extraction state, and quote-request status remain in the right inspector. The inspector is a persistent rail on wide screens and a full-screen sheet on phones.
- Activity and comments remain available in a collapsed secondary section below quote comparison.

## Quote Selection
- Uses `src/features/quotes/selection.ts` for normalized client-facing quote options.
- Presets:
  - `Cheapest`
  - `Fastest`
  - `Domestic`
- Presets ignore excluded vendors and any quote that cannot satisfy the requested due date.
- Manual row or chart selection clears the active preset and persists through `api_set_job_selected_vendor_quote_offer`.
- Vendor labels use real vendor names, and comparison rows keep the stored lane and sourcing text visible to the client.

## Preview Panels
- `ClientArtifactWorkspace` presents one selected artifact at a time and owns the `CAD | Drawing` switch.
- Drawing uses `ClientDrawingPreviewPanel` with inline page switching and a download action.
- CAD uses `ClientCadPreviewPanel` and reuses `CadModelThumbnail` for STEP/STP previews.
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
