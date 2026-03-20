# OverDrafter Repo Map

Last updated: March 19, 2026

> Status: Non-canonical support document. Use this file for orientation only.
>
> Canonical repo guidance lives in `PRD.md`, `PLAN.md`, `ARCHITECTURE.md`, `TEST_STRATEGY.md`, `ACCEPTANCE_CRITERIA.md`, and `AGENTS.md`. If this map conflicts with those docs, the canonical docs win.

## Canonical docs

- `PRD.md` - product intent
- `PLAN.md` - active execution sequencing
- `ARCHITECTURE.md` - system boundaries
- `TEST_STRATEGY.md` - verification policy
- `ACCEPTANCE_CRITERIA.md` - hardening-phase definition of done
- `AGENTS.md` - operating manual for contributors and agents
- `README.md` - repo setup and entry-point guidance

## Repo layout

### Active runtime roots

- `src/` - the only active web application source tree. The root `package.json` runs this Vite app.
- `worker/` - the only separate package in the repo. It owns async processing, vendor adapters, and worker-only tooling.
- `supabase/` - database migrations, local Supabase config, and Edge Functions.

### Web app layout

- `src/main.tsx` - Vite browser entrypoint.
- `src/App.tsx` - top-level route composition.
- `src/pages/` - route-level screens.
- `src/pages/internal-job-detail/` - route-local query, mutation, view-model, and section modules for `/internal/jobs/:jobId`.
- `src/components/` - reusable UI, auth, project, and quote presentation components.
- `src/features/quotes/` - quote-domain controllers, request intake logic, selectors, shared utilities, and tests.
- `src/features/quotes/api/` - concrete quote API modules and narrow barrels; `src/features/quotes/api.ts` remains only as a deprecated compatibility shim.
- `src/lib/` and `src/integrations/` - shared utilities and Supabase client wiring.
- `public/` - static assets emitted directly by the web app.

### Worker layout

- `worker/src/index.ts` - worker entrypoint.
- `worker/src/httpServer.ts` - worker HTTP surface.
- `worker/src/adapters/` - vendor-specific quoting adapters.
- `worker/src/extraction/` - extraction and drawing-processing logic.
- `worker/src/tools/` - operational scripts for imports and cleanup.

### Database and platform layout

- `supabase/migrations/` - canonical schema history.
- `supabase/functions/` - deployed Edge Functions.
- `.github/` - CI and pull request workflow configuration.
- `.codex/skills/` - repo-local Codex skills used by the Symphony workflow.
- `docs/` - supporting documentation and historical source material, not root canonical docs.
- `scripts/` - seed helpers and Symphony guard scripts.

### Tests and verification

- `src/**/*.test.ts(x)` - app-unit and component tests.
- `worker/src/**/*.test.ts` - worker tests.
- `e2e/` - Playwright end-to-end coverage.
- `npm run verify` - repo-wide verification gate.
- `npm run verify:worker` - worker-specific verification from repo root.

### Inactive or non-canonical layout clues

- There is no active `apps/` source layout in this repository.
- There is no tracked `packages/` source layout in this repository.
- Historical generated output such as `apps/web/.next/` is not part of the runtime model and should not be committed.

## How to use this map

Use this file when you need a quick directory-level orientation before editing. Do not use it to resolve product intent, execution priority, or workflow policy questions; those belong to the canonical docs.
