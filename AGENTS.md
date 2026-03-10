# Agent Instructions

## Debugging Workflows

This repo has three supported debugging lanes. Use the lightest lane that fits the task.

### 1. Production-Realistic Local Workflow
Use this lane when the task requires real Supabase-backed behavior.

Commands:
- `npm run db:start`
- `npm run db:reset`
- `npm run seed:dev`
- `npm run dev`

Requirements:
- Docker Desktop must be running because local Supabase uses Docker.
- If `supabase start` fails with `Cannot connect to the Docker daemon`, do not keep retrying setup steps blindly. Treat Docker as unavailable.

Seeded local users:
- `client.demo@overdrafter.local`
- `estimator.demo@overdrafter.local`
- `admin.demo@overdrafter.local`

Shared password:
- `Overdrafter123!`

Use this lane for:
- real auth behavior
- RLS and membership behavior
- seeded local quote/project/job states
- true Supabase query and mutation behavior

### 2. Fast E2E Workflow
Use this lane for browser regression coverage and reproducible automated repros.

Commands:
- `npm run e2e:prepare`
- `npm run e2e`

Rules:
- `npm run e2e:prepare` is the intended command for reset + reseed + Playwright auth setup.
- Do not manually substitute repeated `db:reset` + `seed:dev` + login steps if `e2e:prepare` fits the task.
- Assume Playwright captures trace, video, screenshot, and diagnostics JSON on failure.

### 3. Fixture-Mode Workflow
Use this lane when the task is UI-focused and does not require real Supabase state.

Command:
- `VITE_ENABLE_FIXTURE_MODE=1 npm run dev`

Rules:
- This lane does not require Docker or local Supabase data.
- Use normal app URLs with `?fixture=<scenarioId>&debug=1`.

Supported scenarios:
- `landing-anonymous`
- `client-empty`
- `client-needs-attention`
- `client-quoted`
- `client-published`

Use this lane for:
- client workspace UI tuning
- deterministic repros
- debugging when Docker is unavailable
- tasks that do not require real auth, RLS, or Supabase mutations

## Default Agent Behavior

- Before recommending commands, explicitly state which debugging lane you are using and why.
- Do not tell the user to run `db:start`, `db:reset`, and `seed:dev` every time.
- Prefer the lightest viable lane:
  - fixture mode first for UI-only work
  - fast E2E for regression verification
  - production-realistic only when real backend behavior matters
- If Docker is unavailable, prefer fixture mode unless the task explicitly requires real Supabase behavior.
- If the task requires real backend behavior and Docker is unavailable, say that Docker is a blocker instead of pretending fixture mode is equivalent.

## Diagnostics

When debugging locally, prefer URLs with `?debug=1`.

Diagnostics are available through:
- `window.__OVERDRAFTER_DEBUG__?.getSnapshot()`
- `window.__OVERDRAFTER_DEBUG__?.exportJson()`

When guiding the user or writing repro steps, prefer the existing diagnostics surface over inventing a new one.

## Source Of Truth

- Human-facing setup and examples live in `README.md`
- Detailed workflow usage lives in `docs/debugging-workflows.md`
- `AGENTS.md` should remain focused on agent decision rules and workflow selection
