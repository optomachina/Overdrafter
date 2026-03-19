# Refactor Stabilization Plan

This pass captures the current baseline before any structural refactor. The goal is to preserve behavior while making later extraction safer to review.

## Highest-Risk Monolith Files

- `src/features/quotes/api.ts`
- `src/pages/InternalJobDetail.tsx`
- `src/features/quotes/client-workspace-fixtures.ts`
- `src/components/chat/WorkspaceSidebar.tsx`
- `src/components/chat/WorkspaceAccountMenu.tsx`
- `src/features/quotes/use-client-project-controller.ts`

## `src/features/quotes/api.ts` Responsibility Clusters

- Supabase/RPC transport helpers and untyped shims
- Schema-drift and compatibility detection with cached availability state
- Archive, unarchive, and archived-delete fallback ladders with reporting
- Client intake compatibility fallback across `api_create_client_draft` and `api_create_job`
- Upload hashing, duplicate detection, storage upload, and finalize flow
- Client quote workspace and part-detail aggregation with normalization
- Quote request submission, worker readiness shaping, and publication readiness accessors

## `src/pages/InternalJobDetail.tsx` Responsibility Clusters

- Auth gating and email-verification actions
- Query wiring, polling, and derived memo state
- Draft synchronization and approved-requirement normalization
- Part requirement editing surface
- Debug extraction, manual quote intake, and vendor debug tools
- Publication readiness and publish controls
- Worker queue and vendor compare rendering

## Proposed Extraction Order

1. Pure shaping and classification helpers in `src/features/quotes/api.ts`
2. Aggregation and map-building helpers in `src/features/quotes/api.ts`
3. Mutation fallback ladders in `src/features/quotes/api.ts`
4. Derived-state hook for `src/pages/InternalJobDetail.tsx`
5. Section components for `src/pages/InternalJobDetail.tsx`
6. Mutation and action hooks for `src/pages/InternalJobDetail.tsx`

## Notes For The Next Pass

- Preserve current fallbacks, diagnostics, fixture mode, and schema-compatibility behavior.
- If a branch is unclear, keep the runtime behavior and add a characterization test first.
- This stabilization pass does not refactor `src/pages/InternalJobDetail.tsx`; it only documents the extraction seams.
