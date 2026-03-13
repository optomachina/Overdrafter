# OverDrafter Curated CNC Quote Platform

This repo now contains the portal layer for a curated CNC quote workflow:

- React + Vite frontend for internal estimators and client users
- Supabase schema, RLS, storage, and RPCs for jobs, extractions, quote runs, and published packages
- A separate `worker/` package for queue processing, hybrid extraction, and vendor adapter orchestration

`npm` is the authoritative package manager for both the repo root and `worker/`. Use the committed
`package-lock.json` files and do not introduce Bun, pnpm, or Yarn lockfiles unless the repo policy changes.
For nontrivial local changes, `npm run verify` is the canonical repo-level verification gate.

If your current workspace does not contain this `README.md`, plus root `PRD.md`, `PLAN.md`, `AGENTS.md`,
`package.json`, `worker/`, and `supabase/`, you are not in the correct OverDrafter repo root.

## Canonical Docs

Use repo documentation in this order when documents overlap:

1. `PRD.md` - canonical product intent
2. `PLAN.md` - active execution sequencing
3. `ARCHITECTURE.md` - system boundaries and subsystem model
4. `TEST_STRATEGY.md` - verification expectations
5. `ACCEPTANCE_CRITERIA.md` - hardening-phase definition of done
6. specialized docs for a specific area
7. `README.md` - repo entry point and setup guidance

If a lower-priority doc disagrees with one of the files above, the higher-priority doc wins.

## Planning Material Status

- `docs/reconstruction-prd.md` is retained as source material only and is superseded by `PRD.md`.
- `AwesomeNewPlan_DeleteMeLater.md` is an archived transitional checklist and is superseded by `PLAN.md` and the canonical root docs.
- `REPO_MAP.md` is a non-canonical orientation aid for navigating the repo layout.
- `ROADMAP.md` is currently a placeholder and is not an active planning surface.

Important specialized planning docs include:

- `docs/service-request-taxonomy.md` for service-type modeling and line-item boundaries
- `docs/assembly-workspace-foundation.md` for project-scoped assembly workspace planning and backlog placement
## Symphony Automation

OverDrafter includes a repo-local Symphony workflow contract in `WORKFLOW.md`, repo-local skills in
`.codex/skills/`, and a guard script at `scripts/symphony-preflight.sh`.

When launching Symphony, point the service at this repo's `WORKFLOW.md` explicitly. Do not rely on
Symphony's default local `./WORKFLOW.md` from the separate `openai/symphony` checkout.
For active implementation states, Symphony should switch off `main` in `hooks.before_run` using
`./scripts/symphony-ensure-branch.sh`, which derives a deterministic branch from the Linear issue
identifier.

For recurring planning, verification, and handoff motions, use `docs/recurring-workflows.md`.

## Active Repo Layout

The active runtime and ownership model for this repository is:

- `src/` - the production React + Vite web application
- `worker/` - the separate TypeScript worker package
- `supabase/` - migrations, local config, and Edge Functions
- `public/` - static assets served by the Vite app
- `scripts/` - repo automation, seed helpers, and Symphony guard scripts
- `e2e/` - Playwright coverage for end-to-end flows

There is no active tracked `apps/` or `packages/` source layout in this repository. If those directories
appear in old diffs or stale local artifacts, do not treat them as canonical runtime roots. Use
`REPO_MAP.md` for the current directory map.

## What Was Implemented

### Web app

- Role-aware dashboard at `/`
- Job intake at `/jobs/new`
- Internal review and compare view at `/internal/jobs/:jobId`
- Client package view at `/client/packages/:packageId`
- Supabase-backed service layer in [`src/features/quotes/api.ts`](src/features/quotes/api.ts)

### Supabase

- Domain schema and enums in [`supabase/migrations/20260303101500_curated_cnc_quote_platform.sql`](supabase/migrations/20260303101500_curated_cnc_quote_platform.sql)
- Buckets for `job-files` and `quote-artifacts`
- RLS for internal vs client access
- RPCs for:
  - `api_create_job`
  - `api_attach_job_file`
  - `api_reconcile_job_parts`
  - `api_request_extraction`
  - `api_approve_job_requirements`
  - `api_start_quote_run`
  - `api_get_quote_run_readiness`
  - `api_publish_quote_package`
  - `api_select_quote_option`

### Worker

- Queue claim/complete/fail flow
- Hybrid extraction scaffold
- Deterministic vendor adapter contracts
- Simulation mode so orchestration can run before live browser automation is filled in

## Local Setup

### 1. Frontend

```bash
npm install
cp .env.example .env
npm run generate:favicon
npm run dev
```

Required frontend environment variables:

- `VITE_APP_URL` for the canonical public app URL used in Supabase email links in deployed environments
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`

If you replace `src/assets/logo.png`, regenerate the favicon assets before committing:

```bash
npm run generate:favicon
```

The script refreshes `public/favicon.ico`, `public/favicon-32x32.png`, and `public/apple-touch-icon.png`.

If you want Google, Microsoft, and Apple sign-in enabled in the UI, also turn on the `Google`,
`Azure`, and `Apple` providers in Supabase Auth and add your app URL from `VITE_APP_URL` to the
allowed redirect URLs.

### 2. Supabase

Apply the repo's full migration head before using the app. Do not apply a single migration file in isolation.

For local development:

```bash
npm run db:start
npm run db:reset
```

For the linked hosted dev project:

```bash
npm run db:push
```

After either flow, verify the latest migrations have been applied and that `public.projects.archived_at`
and `public.jobs.archived_at` exist before debugging app-layer query failures.

Then create memberships for your users in `organization_memberships`.

Minimum bootstrap flow:

1. Create an organization row.
2. Add one `internal_admin` or `internal_estimator` membership for your own auth user.
3. Add any client users with role `client`.

### 3. Worker

```bash
cd worker
npm install
npm run dev
```

Required worker environment variables:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Optional worker environment variables:

- `WORKER_MODE=simulate|live`
- `WORKER_NAME=quote-worker-1`
- `WORKER_POLL_INTERVAL_MS=5000`

## Local Verification

Install dependencies in both packages before using the repo-wide verification gate:

```bash
npm install
npm --prefix worker install
npm run verify
```

Use narrower commands when you are iterating on one area:

- root app: `npm run lint`, `npm run typecheck`, `npm run test`, `npm run build`
- worker from repo root: `npm run verify:worker`
- worker in `worker/`: `npm run typecheck`, `npm run build`, or `npm run verify`

## Debugging Workflows

Use the lane that matches the problem you are chasing:

- production-realistic: real local Supabase auth plus seeded app data
- fast E2E: Playwright with saved authenticated sessions
- UI tuning: dev-only fixture mode for stable client workspace states

### Quickstart

Production-realistic local setup:

```bash
npm run db:start
npm run db:reset
npm run seed:dev
npm run dev
```

Docker note:

- `npm run db:start` and `npm run db:reset` require Docker Desktop because local Supabase runs in Docker
- if `supabase start` fails with `Cannot connect to the Docker daemon`, start Docker Desktop first
- if you do not want to use Docker, use fixture mode instead

Typical usage:

- first local setup or after Docker restart:

```bash
npm run db:start
npm run db:reset
npm run seed:dev
npm run dev
```

- normal frontend work when local Supabase is already running and seeded:

```bash
npm run dev
```

- reset local data back to the known demo state:

```bash
npm run db:reset
npm run seed:dev
npm run dev
```

Seeded local users:

- `client.demo@overdrafter.local`
- `estimator.demo@overdrafter.local`
- `admin.demo@overdrafter.local`
- password: `Overdrafter123!`

Fast E2E setup:

```bash
npm run e2e:prepare
npm run e2e
```

Notes:

- `npm run e2e:prepare` resets the local database, reseeds demo data, and writes saved auth sessions to `playwright/.auth/`
- Playwright starts its own dev server on `http://127.0.0.1:4173`
- failure artifacts are written to `test-results/` and `playwright-report/`

Fixture mode:

```bash
VITE_ENABLE_FIXTURE_MODE=1 npm run dev
```

Then open one of these URLs:

- `http://127.0.0.1:5173/?fixture=landing-anonymous&debug=1`
- `http://127.0.0.1:5173/?fixture=client-empty&debug=1`
- `http://127.0.0.1:5173/parts/fx-job-needs-attention?fixture=client-needs-attention&debug=1`
- `http://127.0.0.1:5173/projects/fx-project-quoted?fixture=client-quoted&debug=1`
- `http://127.0.0.1:5173/projects/fx-project-published/review?fixture=client-published&debug=1`

The floating `Fixtures` launcher is only available in dev/test when `VITE_ENABLE_FIXTURE_MODE=1`.

For a longer walkthrough, see `docs/debugging-workflows.md`.

### Which Lane To Use

- use production-realistic when you need real auth, real memberships, real Supabase queries, or seeded demo data
- use fast E2E when you want repeatable browser coverage with saved sessions
- use fixture mode when you want to tune client workspace UI without Docker or Supabase state

### Recurring Codex Workflows

Use `docs/recurring-workflows.md` instead of relying on pasted handoff snippets. It connects:

- recurring issue flow and handoff expectations from `WORKFLOW.md`
- change-type verification guidance from `TEST_STRATEGY.md`
- debugging lane selection from `docs/debugging-workflows.md`
- PR evidence expectations from `.github/pull_request_template.md`
- repo-local procedural skills in `.codex/skills/`

## Current State

The portal and Supabase foundation are implemented. The worker is executable in simulation mode and structured for live Playwright-based vendor adapters, but live vendor automation and production-grade extraction still need to be filled in.

## Favicon Verification

When checking a favicon change locally or after deploy:

```bash
npm run build
npm run preview
```

Then verify:

- `/favicon.ico`
- `/favicon-32x32.png`
- `/apple-touch-icon.png`

If the browser still shows an old icon, use a hard refresh or a fresh/private browser profile. Favicons are commonly cached independently from the page HTML.
