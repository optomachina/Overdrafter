# OverDrafter Runbook

Operational commands for development, testing, and live vendor automation.
Keep this file updated when adding new scripts or env vars.

For the controlled 1.0 beta, `docs/1-0-beta-runbook.md` is the release-specific
authority. Xometry remains the current pre-release certification baseline; an
Xometry-only worker is not a releasable 1.0 configuration. Release requires all
12 named integrations to be admitted, production-certified for their applicable
envelopes, customer-enabled, and included in eligible fan-out. Fictiv examples
below remain solely for explicitly approved internal or future validation.

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
WORKER_LIVE_ADAPTERS=xometry \
XOMETRY_STORAGE_STATE_PATH=/path/to/xometry-storage-state.json \
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

Camoufox is the explicit anti-bot compatibility engine for Xometry. PR #236
added it after Patchright sessions appeared authenticated but Cloudflare
silently neutralized the quote interaction; Camoufox plus a persistent profile
reached the real configurator and returned live pricing. That was controlled
local proof, not unattended reliability: repeated attempts degraded after
roughly ten quotes. Use this path for local compatibility validation and as the
rollback candidate when the hosted engine shows the same failure mode:

```bash
XOMETRY_BROWSER_ENGINE=camoufox \
XOMETRY_USER_DATA_DIR="$PWD/worker/state/xometry-camoufox-user-data" \
npm --prefix worker run auth:xometry
# Opens Camoufox. Log in to Xometry manually.
# Confirm the authenticated dashboard loads, then press Enter.
# The persistent Firefox profile is saved in XOMETRY_USER_DATA_DIR.
```

PR #277 later made standard Playwright the default after it loaded Xometry's
material options with the same production storage state while Patchright
returned `401`. The current private Cloud Run deployment instead uses Camoufox
snapshot mode. It restores one closed-browser profile archive and its pinned
launch identity from a private, versioned object into local ephemeral storage;
it does not mount a live browser profile on network storage or use the legacy
`XOMETRY_STORAGE_STATE_JSON` production binding.

Bootstrap and promote the controlled 1.0 profile only through the exact-runtime
snapshot and no-upload probe procedure in
[`worker/README.md`](worker/README.md#durable-hosted-profile-snapshots). Keep
rollout disabled. The latest fresh hosted probe failed closed with
`login_required`, so `OVD-410` must prove the selected outbound-network contract
before certification resumes. The High-complexity and cloud-cost approval is
recorded; provision and verify only through
[`docs/workflows/ovd410-stable-egress.md`](docs/workflows/ovd410-stable-egress.md).
The bounded live configuration now passes that workflow's verifier. Do not
retry the provider probe under the infrastructure authorization; each required
no-upload authentication probe needs separate approval.

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

### Step 2 — Export local evaluation session paths

```bash
export XOMETRY_BROWSER_ENGINE="playwright"
export XOMETRY_STORAGE_STATE_PATH="$PWD/worker/state/xometry-storage-state.json"
export WORKER_LIVE_ADAPTERS="xometry"
```

These Playwright variables are for local or legacy evaluation only. The current
private hosted 1.0 deployment uses the Camoufox snapshot settings documented
above and in `worker/README.md`; do not copy this storage-state export into that
service.

Use `WORKER_LIVE_ADAPTERS=xometry` only for the current Xometry baseline
certification window. The current worker intentionally rejects an all-12 live
configuration; `OVD-199` must first implement and verify the provider-neutral
registry, runtime-secret validation, routing, and adapters. Only after that code
lands may the release configuration name all 12 admitted and production-
certified integrations. Each adapter still participates only for requests
matching its applicable envelope. Do not add Fictiv without separate promotion
and certification.
For hidden candidates, set `WORKER_LIVE_ADAPTERS` to a narrow explicit list such as
`oshcut` or `oshcut,fabworks` only during internal validation.
These paths assume commands run from the repo root. Until a candidate is
admitted and production-certified as one of the named 12, its session variables
belong only to separately approved internal tests and must not enter the
controlled-beta worker configuration.

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

# Internal/deferred two-vendor diagnostic; never a 1.0 beta gate
npm --prefix worker run validate:openclaw-gate -- --quote-run-id <id> --required-vendors xometry,fictiv
```

**Task A pass criteria (default):** `xometry` must return a real quote with non-null
`total_price_usd` and `lead_time_business_days`, and `quote_url` must not start with `simulated://`.

**Internal/deferred two-vendor gate (`--required-vendors xometry,fictiv`):** both `xometry` and `fictiv`
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
npm --prefix worker run sweep:xometry-quantity -- --quantities 1 --confirm-non-export-controlled

npm --prefix worker run sweep:fictiv-quantity -- --quantities 1,5,25,100 --confirm-non-export-controlled
```

The Xometry sweep is a standalone live evaluation. The confirmation flag is
required and binds the selected CAD and optional drawing bytes to the operator's
non-export-controlled affirmation before any browser upload.

PR #236 validated a real Xometry qty=1 result through Camoufox. Repeated Xometry sweeps can
degrade after multiple quote attempts in one session, so use them for diagnosis, not as the
first app-flow gate.

### Session maintenance

Hosted sessions expire, but a Xometry `login_required` result is not authority to
retry or refresh a local storage-state file. Keep rollout disabled and use the
governed snapshot revocation, exact-runtime re-authentication, generation-zero
reseed, and two independent fresh-instance no-upload probes in
`worker/README.md`. Fictiv re-authentication is allowed only in a separately
approved internal or future-release environment. Check `/health` before any
customer-visible test; `xometry_session_age_days` should be present when a
session path or persistent profile is configured.

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
| `WORKER_LIVE_ADAPTERS` | no | `xometry` | Comma-separated list of live-enabled vendors. The 1.0 beta requires exactly `xometry`; every additional adapter is an explicit internal/deferred opt-in. |
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
| `XOMETRY_BROWSER_ENGINE` | no | `playwright` | Configured values are `playwright`, `patchright`, or `camoufox`. The current private hosted 1.0 deployment explicitly sets `camoufox` with profile snapshot mode. Patchright remains internal/deferred only. |
| `XOMETRY_USER_DATA_DIR` | local camoufox mode | — | Local persistent Camoufox/Firefox profile directory. Snapshot mode manages its own restored directory and must not also set this variable. |
| `XOMETRY_PROFILE_SNAPSHOT_BUCKET` | hosted snapshot mode | — | Private bucket containing the governed closed-browser Xometry profile archive. Configure with `XOMETRY_PROFILE_SNAPSHOT_OBJECT`. |
| `XOMETRY_PROFILE_SNAPSHOT_OBJECT` | hosted snapshot mode | — | Versioned object name for the governed profile archive. Configure with `XOMETRY_PROFILE_SNAPSHOT_BUCKET`. |
| `XOMETRY_SESSION_FRESHNESS_WARN_DAYS` | no | `7` | Session-age warning threshold surfaced by worker startup logs and health checks. |
| `FICTIV_STORAGE_STATE_PATH` | live mode | — | Path to Fictiv Playwright session JSON |
| `FICTIV_STORAGE_STATE_JSON` | live mode | — | Session JSON as a string (alternative to path, for prod secrets) |
| `OPENAI_API_KEY` | extraction | — | For drawing extraction (primary model) |
| `ANTHROPIC_API_KEY` | extraction | — | For drawing extraction (fallback model) |
| `OPENROUTER_API_KEY` | extraction | — | For drawing extraction (OpenRouter fallback) |
| `PLAYWRIGHT_HEADLESS` | no | `true` | Set `false` to watch automation in a browser window |
| `PLAYWRIGHT_CAPTURE_TRACE` | no | `false` | Capture Playwright traces for debugging |
| `PLAYWRIGHT_BROWSER_TIMEOUT_MS` | no | `30000` | Per-action browser timeout |
| `DRAWING_EXTRACTION_MODEL` | no | `gpt-5.4` | Primary extraction model; OpenRouter qualifies unqualified OpenAI names automatically |
| `DRAWING_EXTRACTION_ENABLE_MODEL_FALLBACK` | no | — | Enable fallback to secondary model on extraction failure |

---

## Common Failure Modes

| Symptom | Likely cause | Fix |
|---|---|---|
| Xometry worker or fresh probe logs `login_required` | Hosted session/network contract is not authenticated | Stop without retry, keep rollout disabled, and investigate under the owning issue; do not re-authenticate or provision network resources implicitly. |
| Fictiv worker logs `login_required` | Fictiv session expired | Re-run `auth:fictiv` only in a separately approved internal or future-release environment. |
| Hidden vendor logs `login_required` | Generic vendor session missing or expired | Re-run `auth:vendor -- <vendor>` and confirm `QUOTE_VENDOR_STORAGE_STATE_DIR` or path map is set |
| Hidden vendor smoke returns `manual_vendor_followup` with `configuration_required` | Upload succeeded but the portal needs material/process/shipping/configuration input before pricing | Use the JSON `bodyExcerpt` and HTML/screenshot artifacts to add a vendor-specific configuration step |
| Hidden vendor smoke returns `selector_failure` | Generic portal workflow could not find upload/configuration/quote state | Inspect the JSON `errorPayload.bodyExcerpt` and artifacts, then add a vendor-specific trigger or selector |
| Xometry dashboard renders but clicks do nothing | Browser session silently degraded behind Cloudflare | Stop the beta run; reproduce with persistent-profile Camoufox, then either deploy and certify that path or restore and re-certify a working hosted Playwright session |
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
- Keep `WORKER_LIVE_ADAPTERS=xometry` only for the Xometry baseline certification
  window. The current runtime rejects the future all-12 configuration by design.
  Do not release 1.0 until `OVD-199` adds and verifies the required runtime
  support and the resulting production configuration includes all 12 admitted,
  production-certified, customer-enabled integrations, with provider-envelope
  eligibility enforced before fan-out.
- Use `XOMETRY_BROWSER_ENGINE=camoufox` with the governed profile snapshot bucket
  and object for the current private hosted 1.0 path. The browser runs only from
  the restored local directory; never mount the object store as a live profile.
- Enable Fictiv credentials only for a separately approved internal or future-
  release environment, never the 1.0 beta worker.
- Keep hidden vendor candidates out of client quote fan-out until their live portal flow has been validated with real quote evidence.
- Provide vendor sessions through the deployment contract appropriate to that lane:
  - controlled 1.0 Xometry: `XOMETRY_PROFILE_SNAPSHOT_BUCKET` and `XOMETRY_PROFILE_SNAPSHOT_OBJECT`
  - local or legacy Xometry testing only: `XOMETRY_STORAGE_STATE_PATH` or `XOMETRY_STORAGE_STATE_JSON`
  - `FICTIV_STORAGE_STATE_PATH` or `FICTIV_STORAGE_STATE_JSON`
  - `QUOTE_VENDOR_STORAGE_STATE_DIR`, `QUOTE_VENDOR_STORAGE_STATE_PATHS`, or `QUOTE_VENDOR_STORAGE_STATE_JSON`
- Confirm startup logs include `Starting worker in live mode`.
- Before a 1.0 window, verify the named organization has explicit vendor-config
  rows and its effective enabled vendor list is exactly `xometry`; the no-row
  multi-vendor default is unsafe for the beta.
- Only after `OVD-410` resolves the selected network contract, both independent
  fresh-instance no-upload probes pass, and the merged `OVD-408` migration and
  worker revision are deployed, run the separately owner-authorized real quote
  within 10 minutes and confirm quote URLs are not `simulated://`.
- Treat the Xometry session-age signal as a stop-and-review trigger. Refresh the
  governed profile only through the snapshot revocation, exact-runtime
  re-authentication, generation-zero reseed, and two-probe procedure; other
  session tools are internal/deferred only.
