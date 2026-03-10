# OverDrafter UI Integration Plan

## Current State Audit
- Active app: Vite + React Router under `src/`.
- Protected shell/sidebar surfaces:
  - `src/components/chat/ChatWorkspaceLayout.tsx`
  - `src/components/chat/WorkspaceSidebar.tsx`
  - `src/components/chat/WorkspaceAccountMenu.tsx`
  - `src/components/app/AppShell.tsx`
- Current client routes:
  - `/` -> `ClientHome`
  - `/parts/:jobId` -> `ClientPart`
  - `/projects/:projectId` -> `ClientProject`
  - `/client/packages/:packageId` -> legacy published-package client route
- Current intake flow:
  - `ClientHome` and `JobCreate` both use `parseRequestIntake(...)`
  - file uploads route through `createJobsFromUploadFiles(...)`
  - a single grouped upload navigates to `/parts/:jobId`
  - multi-part grouped uploads navigate to `/projects/:projectId`
- Current part view:
  - `ClientPart` already loads part detail, drawing preview assets, file downloads, revisions, and selected quote mutation.
  - quote comparison exists today, but it is lane-oriented and not optimized for preset-driven selection.
- Current project view:
  - `ClientProject` already owns project membership, add-part flow, filters, focus state, and project actions.
  - it does not yet have quote options for every line item, bulk preset selection, or a right-side procurement drawer.
- Current review/checkout state:
  - there is no pre-checkout review route between selection and payment/PO.
  - `ClientPackage` remains the legacy published package flow and should stay intact.
- Current state/data wiring:
  - React Query is the primary client state layer.
  - quoting state lives in `src/features/quotes/api.ts`, `types.ts`, `utils.ts`, `request-intake.ts`, and related helpers.
  - selection persistence today is `jobs.selected_vendor_quote_offer_id`.

## Protected Areas
- Do not alter desktop sidebar width, collapse behavior, rail behavior, icons, header chrome, top-level navigation, or the mobile sidebar entry model.
- Do not replace `ChatWorkspaceLayout`, `WorkspaceSidebar`, `WorkspaceAccountMenu`, or `AppShell`.
- Do not repurpose `ClientPackage` or the internal estimator route to serve the new client review flow.

## Reusable Building Blocks
- File/media:
  - `DrawingPreviewDialog`
  - `CadModelThumbnail`
  - `useClientJobFilePicker`
- Request metadata:
  - `RequestSummaryBadges`
  - `RequestedQuantityFilter`
  - `buildRequirementDraft(...)`
  - `parseRequestIntake(...)`
- UI primitives:
  - `Table`
  - `Sheet`
  - `Collapsible`
  - `Badge`
  - `Button`
  - `Input`
  - `Textarea`
  - `chart.tsx`

## Proposed Route And Component Map
- Keep:
  - `/`
  - `/parts/:jobId`
  - `/projects/:projectId`
  - `/client/packages/:packageId`
- Add:
  - `/parts/:jobId/review`
  - `/projects/:projectId/review`
- Add shared logic/components:
  - `src/features/quotes/selection.ts`
  - batch client workspace data fetch for project/review selection flows
  - shared client part request update API/RPC
  - shared quote list/chart/activity/review components
- Replace page bodies only:
  - `ClientPart` content region
  - `ClientProject` content region

## Reuse / Replace / Add
### Reuse
- Existing routes, React Query queries, Supabase mutations, drawing preview loading, file attach flow, and selected-offer mutation.
- Existing chat-style workspace shell/sidebar wrappers.

### Replace
- `ClientPart` content layout with a dedicated selection workspace:
  - preview panels
  - preset controls
  - scatter chart
  - ranked list
  - collapsible details editor
- `ClientProject` content layout with a dense table and right-side selection drawer.

### Add
- Shared preset logic and bulk revert logic.
- Local vendor exclusion persistence by job.
- Client-edit RPC for metadata/RFQ correction.
- Separate review routes.
- Lightweight activity log.

## Risks And Mitigations
- Risk: project bulk selection needs offer data for every line item, but current project queries only load selected summaries.
  - Mitigation: add a batched client workspace fetch for latest quote options across a project.
- Risk: client metadata edits currently have no client-safe persistence path.
  - Mitigation: add a narrow authenticated RPC that updates job request fields and upserts the existing requirement-like shape for the part.
- Risk: domestic/foreign signals are incomplete.
  - Mitigation: classify from current `sourcing`/raw payload signals and fall back to `Unknown`.
- Risk: due-date filtering can become inconsistent across part, project, and review views.
  - Mitigation: centralize eligibility and preset rules in `selection.ts`.
- Risk: shell/sidebar regressions from page rewrites.
  - Mitigation: keep all work inside the page content region and preserve existing workspace shell tests.
