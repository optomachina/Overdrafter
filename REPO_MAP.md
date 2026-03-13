# OverDrafter Repo Map

Last updated: March 13, 2026

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

- `src/` - main React application code
- `src/pages/` - route-level pages
- `src/components/` - shared UI and workflow components
- `src/features/quotes/` - quote-domain service and feature logic
- `src/integrations/supabase/` - Supabase client integration layer
- `e2e/` - end-to-end and smoke coverage
- `public/` - static assets and fixture payloads used by the app
- `worker/src/` - queue worker, extraction flow, adapters, and repair tooling
- `worker/scripts/` - worker-specific development and verification scripts
- `supabase/migrations/` - schema and RPC migration history
- `supabase/functions/` - Supabase edge functions
- `scripts/` - repo workflow and verification helpers, including Symphony hooks
- `.github/` - CI workflows and PR templates
- `.codex/skills/` - repo-local Codex skills used by the Symphony workflow
- `docs/` - supporting documentation and historical source material, not root canonical docs

## How to use this map

Use this file when you need a quick directory-level orientation before editing. Do not use it to resolve product intent, execution priority, or workflow policy questions; those belong to the canonical docs.
