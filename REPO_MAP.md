# OverDrafter Repo Map

Last updated: March 13, 2026

## Canonical docs

- `PRD.md` — product intent
- `PLAN.md` — active execution sequencing
- `ARCHITECTURE.md` — system boundaries
- `TEST_STRATEGY.md` — verification policy
- `ACCEPTANCE_CRITERIA.md` — definition of done for hardening phase
- `AGENTS.md` — operating manual for contributors and agents
- `CONTRIBUTING.md` — contribution workflow

## What lives where

### Active runtime roots

- `src/` - the only active web application source tree. The root `package.json` runs this Vite app.
- `worker/` - the only separate package in the repo. It owns async processing, vendor adapters, and worker-only tooling.
- `supabase/` - database migrations, local Supabase config, and Edge Functions.

### Web app layout

- `src/main.tsx` - Vite browser entrypoint.
- `src/App.tsx` - top-level route composition.
- `src/pages/` - route-level screens.
- `src/components/` - reusable UI, auth, project, and quote presentation components.
- `src/features/quotes/` - quote-domain controllers, API integration, request intake logic, and tests.
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
- `scripts/` - seed helpers and Symphony guard scripts.

### Tests and verification

- `src/**/*.test.ts(x)` - app-unit and component tests.
- `worker/src/**/*.test.ts` - worker tests.
- `e2e/` - Playwright end-to-end coverage.
- `npm run verify` - repo-wide verification gate.
- `npm run verify:worker` - worker-specific verification from repo root.

### Inactive or non-canonical layout clues

- There is no active `apps/` source layout in this repository.
- There is no `packages/` directory in this repository.
- Historical generated output such as `apps/web/.next/` is not part of the runtime model and should not be committed.

## How to use this map

Use this file when:
- the repo starts getting too large for `README.md`
- contributors need a fast orientation pass
- agent sessions need a quick directory overview before making edits
