# OverDrafter Repo Map

Last updated: March 12, 2026

## Status

Supporting orientation document. This file helps contributors find major areas of the repository quickly, but it is not a canonical planning surface.

For decisions, priorities, or workflow rules, use the source-of-truth hierarchy in `AGENTS.md` and `CONTRIBUTING.md`. If this map ever conflicts with a canonical doc, the canonical doc wins.

## Canonical docs

- `PRD.md` — product intent
- `PLAN.md` — active execution sequencing
- `ARCHITECTURE.md` — system boundaries
- `TEST_STRATEGY.md` — verification policy
- `ACCEPTANCE_CRITERIA.md` — definition of done for hardening phase
- `AGENTS.md` — operating manual for contributors and agents
- `CONTRIBUTING.md` — contribution workflow

## What lives where

### Application code

- `src/` — main web app source for routes, features, shared UI, integrations, and utilities
- `src/features/` — domain-specific frontend features such as quote workflows
- `src/pages/` — route-level page entry points
- `src/components/` — shared UI building blocks
- `src/lib/`, `src/hooks/`, `src/types/` — shared utilities, hooks, and types
- `apps/web/` — secondary app-specific workspace material when present

### Worker and async processing

- `worker/src/` — queue worker, extraction flow, and vendor adapter orchestration
- `worker/scripts/` — worker-specific support scripts

### Database and backend boundary

- `supabase/migrations/` — schema history and SQL migrations
- `supabase/functions/` — Supabase edge functions and backend-adjacent logic

### Tests and verification

- `e2e/` — end-to-end coverage
- `.github/workflows/` — CI workflows
- `scripts/` — repo support scripts, including Symphony preflight and development helpers

### Documentation and contributor workflow

- `docs/` — specialized supporting docs for particular features or workflows
- `.codex/skills/` — repo-local Symphony and Codex skills
- `WORKFLOW.md` — Symphony workflow contract for this repository

### Static assets

- `public/` — frontend static assets and fixture data
- `src/assets/` — imported app assets bundled with the frontend

## How to use this map

Use this file when:
- you need a quick directory overview before changing code
- a contributor needs fast orientation after reading the canonical docs
- an agent needs a lightweight map of the repo layout without inferring authority from it
