# Refactor Stabilization Plan

This document now records the completed stabilization split for the quotes API surface and the internal job detail route. The goal remained behavior preservation while making the repo easier to debug and navigate.

## Completed Structural Changes

- `src/features/quotes/api.ts` was reduced to a deprecated compatibility shim.
- Concrete API logic now lives in `src/features/quotes/api/*`, with narrower barrels for internal review, session access, and workspace access.
- App-source imports were moved off `@/features/quotes/api` and onto narrower modules.
- `src/pages/InternalJobDetail.tsx` was reduced to a route shell.
- Route-specific query, mutation, view-model, and section modules now live in `src/pages/internal-job-detail/`.

## Final `src/features/quotes/api` Shape

- `archive-api.ts` owns archive and archived-delete behavior.
- `jobs-api.ts`, `projects-api.ts`, and `workspace-api.ts` own aggregate reads and workspace navigation data.
- `extraction-api.ts`, `quote-requests-api.ts`, `packages-api.ts`, and `uploads-api.ts` own mutations and quote orchestration calls.
- `internal-review.ts`, `session-access.ts`, and `workspace-access.ts` provide narrower usage-cluster barrels.
- `api.ts` remains only for compatibility while older tests or follow-on slices migrate.

## Final Internal Job Detail Split

- `use-internal-job-detail-query.ts` owns route data loading, polling, and readiness queries.
- `use-internal-job-detail-mutations.ts` owns page mutations plus email-verification actions.
- `internal-job-detail-view-model.ts` owns derived state, draft synchronization, and compare sorting helpers.
- Route sections are split into overview, requirements, debug, publication, worker queue, and vendor compare components.

## Guardrails Preserved

- Preserve current fallbacks, diagnostics, fixture mode, and schema-compatibility behavior.
- Preserve current query keys, polling rules, toast copy, publish/readiness behavior, and debug-tool visibility.
- Keep characterization coverage around fallback and schema-drift behavior.
- Add focused route-local selector or view-model tests when extracted logic creates a stable seam worth asserting.
