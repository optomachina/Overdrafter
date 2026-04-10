# OverDrafter Runbook

Operational commands for development, testing, and live vendor automation.
Keep this file updated when adding new scripts or env vars.

---

## Local Development

```bash
# Start the web app (Vite dev server)
npm run dev

# Open the dev login shortcut in browser
npm run dev:login

# Start the worker in simulate mode (safe, no real vendor calls)
npm --prefix worker run dev

# Start the worker in live mode (real vendor calls — requires session + env vars)
WORKER_MODE=live \
WORKER_LIVE_ADAPTERS=xometry,fictiv \
XOMETRY_STORAGE_STATE_PATH=/path/to/xometry-storage-state.json \
FICTIV_STORAGE_STATE_PATH=/path/to/fictiv-storage-state.json \
npm --prefix worker run dev
```

---

## Database

```bash
# Start local Supabase (Docker required)
npm run db:start

# Reset DB and re-run all migrations
npm run db:reset

# Push local migrations to remote
npm run db:push

# Regenerate TypeScript types from DB schema
npm run db:types

# Seed dev fixtures
npm run seed:dev
```

---

## Verification

```bash
# Full repo gate (lint + typecheck + test + build + worker verify)
npm run verify

# Individual steps
npm run lint
npm run typecheck
npm run test
npm run build

# Worker only
npm run verify:worker
# or
npm --prefix worker run verify
```

---

## E2E Tests

```bash
# Run all E2E tests (headless)
npm run e2e

# Run E2E tests with Playwright UI
npm run e2e:ui

# Prepare E2E auth fixtures (run once after db:reset)
npm run e2e:prepare
# What it does: db:reset + seed:dev + generates playwright/.auth/*.json session files
```

---

## Live Vendor Harness (Xometry + Fictiv)

### Step 1 — Bootstrap a Playwright session

```bash
npm --prefix worker run auth:xometry
# Opens a Chromium window. Log in to Xometry manually.
# Navigate to https://www.xometry.com/quoting/home/ and confirm you're authenticated.
# Press Enter. Session saved to worker/state/xometry-storage-state.json by default.
# Or pass a custom path as the first argument:
npm --prefix worker run auth:xometry -- /custom/path/xometry.json
```

### Step 1b — Bootstrap Fictiv session

```bash
npm --prefix worker run auth:fictiv
# Opens Chromium. Log in to Fictiv manually.
# Navigate to https://app.fictiv.com/quotes (or /quotes/upload) and confirm authentication.
# Press Enter. Session saved to worker/state/fictiv-storage-state.json by default.
# Or pass a custom path:
npm --prefix worker run auth:fictiv -- /custom/path/fictiv.json
```

### Step 2 — Export the session paths

```bash
export XOMETRY_STORAGE_STATE_PATH="/Users/$(whoami)/Documents/GitHub/Overdrafter/worker/state/xometry-storage-state.json"
export FICTIV_STORAGE_STATE_PATH="/Users/$(whoami)/Documents/GitHub/Overdrafter/worker/state/fictiv-storage-state.json"
export WORKER_LIVE_ADAPTERS="xometry,fictiv"
```

Add this to your shell profile or `.env` in `worker/` so you don't have to repeat it.

### Step 3 — Trigger a real quote run

1. Start the worker in live mode (see above).
2. Open the app, navigate to a part, and click **Request Quote**.
3. The worker will pick up the task and run live vendor automation for adapters in `WORKER_LIVE_ADAPTERS`.
4. Grab the `quote_run_id` from Supabase → Table Editor → `quote_runs` → most recent row.

### Step 4 — Validate the openclaw gate

```bash
npm --prefix worker run validate:openclaw-gate -- --quote-run-id <quote_run_id>
# Pass: exit 0, prints { "decision": "pass" } with real price + lead time
# Default required vendor set: xometry (Task A prerequisite mode)
# Fail: exit 1, prints { "decision": "fail_..." } with reason

# Save output to a file
npm --prefix worker run validate:openclaw-gate -- --quote-run-id <id> --out gate-report.json

# Require both vendors (Task B / full openclaw gate)
npm --prefix worker run validate:openclaw-gate -- --quote-run-id <id> --required-vendors xometry,fictiv
```

**Task A pass criteria (default):** `xometry` must return a real quote with non-null
`total_price_usd` and `lead_time_business_days`, and `quote_url` must not start with `simulated://`.

**Full gate pass criteria (`--required-vendors xometry,fictiv`):** both `xometry` and `fictiv`
must return real quotes with non-null `total_price_usd` and `lead_time_business_days`, and
`quote_url` must not start with `simulated://`.

**Gate fail codes:**
- `fail_anti_detection` — Xometry or Fictiv blocked the automation (CAPTCHA, login wall). Stop and research the vendor's partner API before rebuilding.
- `fail_stub_or_simulation` — at least one vendor returned simulated data. `WORKER_MODE` may not be `live`, or a required storage-state path is missing.
- `fail_insufficient_data` — not enough quote rows found for the run ID. Check the run ID is correct and the worker completed.

### Session maintenance

Sessions expire. Re-run `auth:xometry` and `auth:fictiv` at least weekly in production.
`login_required` errors in worker logs mean the session is stale — re-auth immediately.

---

## Drawing Extraction

```bash
# Smoke test extraction on a single PDF
npm --prefix worker run extract:smoke -- /absolute/path/to/drawing.pdf

# Run the full extraction eval suite (requires AI API keys)
npm --prefix worker run extract:eval
```

---

## Demo Data

```bash
# Import Dmrifles historical quotes into the DB
npm --prefix worker run import:dmrifles-quotes

# Import quotes from a spreadsheet
npm --prefix worker run import:quotes -- /path/to/quotes.xlsx

# Clean up Dmrifles demo data
npm --prefix worker run cleanup:dmrifles-demo
```

---

## Playwright Browser

```bash
# Install Chromium for Playwright (run once after cloning or after Playwright upgrades)
npm --prefix worker run install:browsers
```

---

## Worker Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `SUPABASE_URL` | yes | — | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | — | Service role key (never expose to client) |
| `WORKER_MODE` | no | `simulate` | `simulate` or `live`. Live makes real vendor calls. |
| `WORKER_LIVE_ADAPTERS` | no | `xometry` | Comma-separated list of live-enabled vendors (e.g. `xometry,fictiv`) |
| `WORKER_NAME` | no | `quote-worker-1` | Worker identity for logging |
| `WORKER_POLL_INTERVAL_MS` | no | `5000` | Task poll interval in ms |
| `XOMETRY_STORAGE_STATE_PATH` | live mode | — | Path to Xometry Playwright session JSON |
| `XOMETRY_STORAGE_STATE_JSON` | live mode | — | Session JSON as a string (alternative to path, for prod secrets) |
| `FICTIV_STORAGE_STATE_PATH` | live mode | — | Path to Fictiv Playwright session JSON |
| `OPENAI_API_KEY` | extraction | — | For drawing extraction (primary model) |
| `ANTHROPIC_API_KEY` | extraction | — | For drawing extraction (fallback model) |
| `OPENROUTER_API_KEY` | extraction | — | For drawing extraction (OpenRouter fallback) |
| `PLAYWRIGHT_HEADLESS` | no | `true` | Set `false` to watch automation in a browser window |
| `PLAYWRIGHT_CAPTURE_TRACE` | no | `false` | Capture Playwright traces for debugging |
| `PLAYWRIGHT_BROWSER_TIMEOUT_MS` | no | `30000` | Per-action browser timeout |
| `DRAWING_EXTRACTION_MODEL` | no | `gpt-5.4` | Primary extraction model |
| `DRAWING_EXTRACTION_ENABLE_MODEL_FALLBACK` | no | — | Enable fallback to secondary model on extraction failure |

---

## Common Failure Modes

| Symptom | Likely cause | Fix |
|---|---|---|
| Worker logs `login_required` | Xometry or Fictiv session expired | Re-run `auth:xometry` and/or `auth:fictiv` |
| Gate returns `fail_stub_or_simulation` | `WORKER_MODE` not set to `live`, or session path missing | Check env vars |
| Gate returns `fail_anti_detection` | Vendor portal blocked automation | Do not retry. Research vendor partner API. |
| `XOMETRY_STORAGE_STATE_PATH is not configured` error | Env var not exported | `export XOMETRY_STORAGE_STATE_PATH=...` |
| `FICTIV_STORAGE_STATE_PATH is not configured` error | Env var not exported | `export FICTIV_STORAGE_STATE_PATH=...` |
| E2E tests fail with auth errors | Session fixtures stale | `npm run e2e:prepare` |
| `db:reset` fails | Docker not running | Start Docker Desktop |
| Typecheck fails after migration | DB types stale | `npm run db:types` |
