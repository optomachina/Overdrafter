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

## Live Vendor Harness

### Step 1 — Bootstrap an Xometry session

```bash
XOMETRY_BROWSER_ENGINE=camoufox \
XOMETRY_USER_DATA_DIR="$PWD/worker/state/xometry-camoufox-user-data" \
npm --prefix worker run auth:xometry
# Opens Camoufox. Log in to Xometry manually.
# Confirm the authenticated dashboard loads, then press Enter.
# The persistent Firefox profile is saved in XOMETRY_USER_DATA_DIR.
```

Camoufox with a persistent profile is the preferred Xometry path after PR #236. Patchright
storage-state mode remains available for comparison, but it has been observed to silently
degrade behind Xometry's Cloudflare wall.

Legacy Patchright/storage-state bootstrap:

```bash
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

### Step 1c — Bootstrap hidden vendor candidate sessions

The hidden candidate adapters share a generic portal-upload workflow. They are not part of
default client quote fan-out and should only be enabled one at a time for internal validation.

```bash
# Supported vendors:
# oshcut, fabworks, ponoko, quickparts, rapiddirect, geomiq, weerg, protolabsnetwork
npm --prefix worker run auth:vendor -- all
# Or bootstrap one at a time / in smaller batches:
npm --prefix worker run auth:vendor -- oshcut
npm --prefix worker run auth:vendor -- fabworks
npm --prefix worker run auth:vendor -- ponoko
npm --prefix worker run auth:vendor -- quickparts
npm --prefix worker run auth:vendor -- rapiddirect
npm --prefix worker run auth:vendor -- geomiq
npm --prefix worker run auth:vendor -- weerg
npm --prefix worker run auth:vendor -- protolabsnetwork
```

This script opens the vendor login/signup page and saves Playwright storage state under
`worker/state/vendor-sessions/<vendor>-storage-state.json` by default. Create accounts
manually in the browser; do not commit passwords, session JSON, or `.env` files.
For batch mode, the script opens vendors sequentially and waits for Enter after each session is authenticated.

### Step 2 — Export the session paths

```bash
export XOMETRY_BROWSER_ENGINE="camoufox"
export XOMETRY_USER_DATA_DIR="$PWD/worker/state/xometry-camoufox-user-data"
export FICTIV_STORAGE_STATE_PATH="$PWD/worker/state/fictiv-storage-state.json"
export QUOTE_VENDOR_STORAGE_STATE_DIR="$PWD/worker/state/vendor-sessions"
export WORKER_LIVE_ADAPTERS="xometry"
```

Use `WORKER_LIVE_ADAPTERS=xometry` for the first controlled `dmrifles@gmail.com` app test.
Expand to `xometry,fictiv` after the Xometry app-triggered path passes.
For hidden candidates, set `WORKER_LIVE_ADAPTERS` to a narrow explicit list such as
`oshcut` or `oshcut,fabworks` only during internal validation.
These paths assume you are running commands from the repo root; adapt them for hosted or custom layouts.
Add these values to your shell profile or `.env` in `worker/` so you don't have to repeat them.

### Step 2b — Run a hidden vendor workflow smoke

```bash
QUOTE_VENDOR_STORAGE_STATE_DIR="$PWD/worker/state/vendor-sessions" \
WORKER_LIVE_ADAPTERS=oshcut \
npm --prefix worker run smoke:vendor-workflow -- \
  --vendor oshcut \
  --cad /path/to/part.step \
  --quantities 1
```

Use this smoke runner for `oshcut`, `fabworks`, `ponoko`, `quickparts`,
`rapiddirect`, `geomiq`, `weerg`, and `protolabsnetwork`. Pass `--vendor all`
or a comma-separated subset such as `--vendor oshcut,fabworks` for batch
validation after sessions have been bootstrapped. The runner writes a JSON result
file to `/tmp` and exits non-zero if any selected live portal flow fails.

Hidden vendor smoke statuses:

- `instant_quote_received`: the portal returned a non-zero price signal.
- `manual_review_pending`: the portal accepted the upload and explicitly routed the job to review.
- `manual_vendor_followup` with `detectedFlow: "configuration_required"`: the portal accepted the upload but still needs vendor-specific inputs such as material, size, ZIP, process, or part configuration before pricing. This is expected for public/guest smoke on vendors such as OSH Cut and Fabworks.
- `ERROR login_required`: the saved storage state is missing, expired, or the vendor requires account creation before upload.
- `ERROR selector_failure`: inspect the JSON `errorPayload.bodyExcerpt` and artifact paths to decide whether the workflow needs a vendor-specific upload or configuration selector.

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

# Require both vendors after the single-vendor app path is stable
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

### Quantity sweeps

```bash
XOMETRY_BROWSER_ENGINE=camoufox \
XOMETRY_USER_DATA_DIR="$PWD/worker/state/xometry-camoufox-user-data" \
npm --prefix worker run sweep:xometry-quantity -- --quantities 1

npm --prefix worker run sweep:fictiv-quantity -- --quantities 1,5,25,100
```

PR #236 validated a real Xometry qty=1 result through Camoufox. Repeated Xometry sweeps can
degrade after multiple quote attempts in one session, so use them for diagnosis, not as the
first app-flow gate.

### Session maintenance

Sessions expire. Re-run `auth:xometry` and `auth:fictiv` at least weekly in production.
`login_required` errors in worker logs mean the session is stale — re-auth immediately.
Check `/health` before customer-visible tests; `xometry_session_age_days` should be present
when a session path or persistent profile is configured.

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
| `WORKER_LIVE_ADAPTERS` | no | `xometry` | Comma-separated list of live-enabled vendors (e.g. `xometry,fictiv`; hidden candidates require explicit opt-in) |
| `WORKER_QUANTITY_PRICING_LADDER` | no | `1,10,100,1000` | Comma/slash/space-separated quantity ladder used for quantity-pricing sweeps |
| `WORKER_VENDOR_RATE_LIMIT_MS` | no | `0` | Optional delay after each vendor quote task for live vendor-session throttling |
| `WORKER_PRICING_MODEL_ENABLED` | no | `false` | Enables internal-only estimate helpers; estimates still require live vendor verification |
| `WORKER_PRICING_MODEL_MIN_CONFIDENCE` | no | `0.7` | Minimum confidence required before internal routing may consider estimate-only hints |
| `QUOTE_VENDOR_STORAGE_STATE_DIR` | hidden live adapters | — | Directory containing `<vendor>-storage-state.json` files for generic portal adapters |
| `QUOTE_VENDOR_STORAGE_STATE_PATHS` | hidden live adapters | — | JSON object mapping vendor name to a Playwright storage-state path |
| `QUOTE_VENDOR_STORAGE_STATE_JSON` | hidden live adapters | — | JSON object mapping vendor name to inline Playwright storage-state JSON |
| `WORKER_NAME` | no | `quote-worker-1` | Worker identity for logging |
| `WORKER_POLL_INTERVAL_MS` | no | `5000` | Task poll interval in ms |
| `XOMETRY_STORAGE_STATE_PATH` | live mode | — | Path to Xometry Playwright session JSON |
| `XOMETRY_STORAGE_STATE_JSON` | live mode | — | Session JSON as a string (alternative to path, for prod secrets) |
| `XOMETRY_BROWSER_ENGINE` | no | `patchright` | Xometry browser engine: `patchright` or `camoufox`. Prefer `camoufox` for current live Xometry tests. |
| `XOMETRY_USER_DATA_DIR` | camoufox mode | — | Persistent Camoufox/Firefox profile directory for Xometry. Required for reliable Cloudflare session continuity. |
| `XOMETRY_SESSION_FRESHNESS_WARN_DAYS` | no | `7` | Session-age warning threshold surfaced by worker startup logs and health checks. |
| `FICTIV_STORAGE_STATE_PATH` | live mode | — | Path to Fictiv Playwright session JSON |
| `FICTIV_STORAGE_STATE_JSON` | live mode | — | Session JSON as a string (alternative to path, for prod secrets) |
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
| Hidden vendor logs `login_required` | Generic vendor session missing or expired | Re-run `auth:vendor -- <vendor>` and confirm `QUOTE_VENDOR_STORAGE_STATE_DIR` or path map is set |
| Hidden vendor smoke returns `manual_vendor_followup` with `configuration_required` | Upload succeeded but the portal needs material/process/shipping/configuration input before pricing | Use the JSON `bodyExcerpt` and HTML/screenshot artifacts to add a vendor-specific configuration step |
| Hidden vendor smoke returns `selector_failure` | Generic portal workflow could not find upload/configuration/quote state | Inspect the JSON `errorPayload.bodyExcerpt` and artifacts, then add a vendor-specific trigger or selector |
| Xometry dashboard renders but clicks do nothing | Patchright/storage-state session silently degraded behind Cloudflare | Re-bootstrap with `XOMETRY_BROWSER_ENGINE=camoufox` and persistent `XOMETRY_USER_DATA_DIR` |
| Gate returns `fail_stub_or_simulation` | `WORKER_MODE` not set to `live`, or session path missing | Check env vars |
| Gate returns `fail_anti_detection` | Vendor portal blocked automation | Do not retry. Research vendor partner API. |
| `XOMETRY_STORAGE_STATE_PATH is not configured` error | Env var not exported | `export XOMETRY_STORAGE_STATE_PATH=...` |
| `FICTIV_STORAGE_STATE_PATH is not configured` error | Env var not exported | `export FICTIV_STORAGE_STATE_PATH=...` |
| E2E tests fail with auth errors | Session fixtures stale | `npm run e2e:prepare` |
| `db:reset` fails | Docker not running | Start Docker Desktop |
| Typecheck fails after migration | DB types stale | `npm run db:types` |

### Production rollout notes

- Keep CI and staging on explicit `WORKER_MODE=simulate`.
- Set production worker env to `WORKER_MODE=live`.
- Start with `WORKER_LIVE_ADAPTERS=xometry` for the no-Stripe MVP; expand to `xometry,fictiv` after the app-triggered Xometry path is stable.
- Prefer `XOMETRY_BROWSER_ENGINE=camoufox` with persistent `XOMETRY_USER_DATA_DIR` for current Xometry live runs.
- Enable Fictiv live credentials when two-vendor validation is required.
- Keep hidden vendor candidates out of client quote fan-out until their live portal flow has been validated with real quote evidence.
- Provide vendor sessions via either mounted file paths or inline secret JSON:
  - `XOMETRY_STORAGE_STATE_PATH` or `XOMETRY_STORAGE_STATE_JSON`
  - `FICTIV_STORAGE_STATE_PATH` or `FICTIV_STORAGE_STATE_JSON`
  - `QUOTE_VENDOR_STORAGE_STATE_DIR`, `QUOTE_VENDOR_STORAGE_STATE_PATHS`, or `QUOTE_VENDOR_STORAGE_STATE_JSON`
- Confirm startup logs include `Starting worker in live mode`.
- Within 10 minutes of deploy, run one real quote and confirm quote URLs are not `simulated://`.
- Refresh vendor sessions at least weekly with `auth:xometry`, `auth:fictiv`, and `auth:vendor`.
