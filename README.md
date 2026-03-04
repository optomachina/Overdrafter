# OverDrafter Curated CNC Quote Platform

This repo now contains the portal layer for a curated CNC quote workflow:

- React + Vite frontend for internal estimators and client users
- Supabase schema, RLS, storage, and RPCs for jobs, extractions, quote runs, and published packages
- A separate `worker/` package for queue processing, hybrid extraction, and vendor adapter orchestration

## What Was Implemented

### Web app

- Role-aware dashboard at `/`
- Job intake at `/jobs/new`
- Internal review and compare view at `/internal/jobs/:jobId`
- Client package view at `/client/packages/:packageId`
- Supabase-backed service layer in [`src/features/quotes/api.ts`](/Users/blainewilson/Documents/GitHub/overdrafter-cad-opus/src/features/quotes/api.ts)

### Supabase

- Domain schema and enums in [`supabase/migrations/20260303101500_curated_cnc_quote_platform.sql`](/Users/blainewilson/Documents/GitHub/overdrafter-cad-opus/supabase/migrations/20260303101500_curated_cnc_quote_platform.sql)
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
npm run dev
```

Required frontend environment variables:

- `VITE_APP_URL` for the canonical public app URL used in Supabase email links in deployed environments
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`

If you want Google, Microsoft, and Apple sign-in enabled in the UI, also turn on the `Google`,
`Azure`, and `Apple` providers in Supabase Auth and add your app URL from `VITE_APP_URL` to the
allowed redirect URLs.

### 2. Supabase

Run the new migration against your project, then create memberships for your users in `organization_memberships`.

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

## Current State

The portal and Supabase foundation are implemented. The worker is executable in simulation mode and structured for live Playwright-based vendor adapters, but live vendor automation and production-grade extraction still need to be filled in.
