# Worker Service

This package is the long-running orchestration worker for the curated CNC quote platform.

Use `npm` as the authoritative package manager here. Install and run worker dependencies from `worker/`
with `npm`, and do not add alternate lockfiles unless the repo policy changes.

## Responsibilities

- Claim queue items from `public.work_queue`
- Run hybrid extraction for `extract_part`
- Execute deterministic vendor adapters for `run_vendor_quote`
- Support readiness-driven publish automation in later iterations
- Record adapter failures for offline repair analysis

## Runtime Modes

- `simulate` (default): produces deterministic extraction and vendor quote data so the full orchestration loop can be exercised without live credentials.
- `live`: reserved for Playwright-backed vendor automation and model-assisted extraction. The interfaces are in place, but real selectors and login state still need to be filled in.

## Environment

Required:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Optional:

- `WORKER_MODE=simulate|live`
- `WORKER_NAME=quote-worker-1`
- `WORKER_POLL_INTERVAL_MS=5000`
- `WORKER_HTTP_HOST=0.0.0.0`
- `WORKER_TEMP_DIR=/tmp/overdrafter-worker`
- `QUOTE_ARTIFACT_BUCKET=quote-artifacts`
- `PORT=8080`
- `PLAYWRIGHT_HEADLESS=true`
- `PLAYWRIGHT_CAPTURE_TRACE=false`
- `PLAYWRIGHT_BROWSER_TIMEOUT_MS=30000`
- `PLAYWRIGHT_DISABLE_SANDBOX=false`
- `PLAYWRIGHT_DISABLE_DEV_SHM_USAGE=true`
- `XOMETRY_STORAGE_STATE_PATH=/absolute/path/to/xometry-storage-state.json`
- `XOMETRY_STORAGE_STATE_JSON={"cookies":[],"origins":[]}`

## Bootstrap Xometry Login State

Create a local env file first:

```bash
cd worker
cp .env.example .env
```

Fill in at least:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `XOMETRY_STORAGE_STATE_PATH`

Install the Playwright Chromium browser once:

```bash
cd worker
npm run install:browsers
```

Create a Xometry authenticated storage-state file:

```bash
cd worker
npm run auth:xometry
```

Or save it to an explicit path:

```bash
cd worker
npm run auth:xometry -- /absolute/path/to/xometry-storage-state.json
```

The script will:

1. Open a Chromium window.
2. Let you log in to Xometry manually.
3. Save the authenticated Playwright `storageState` file after you press Enter.

After that, point the worker at the saved file:

```bash
export XOMETRY_STORAGE_STATE_PATH=/absolute/path/to/xometry-storage-state.json
export WORKER_MODE=live
```

## Production Build

Build the production bundle:

```bash
cd worker
npm run build
```

Run the production entrypoint locally:

```bash
cd worker
node dist/index.js
```

The worker now starts a lightweight HTTP server on `PORT` and exposes:

- `/healthz`
- `/readyz`

This is required for Cloud Run services.

## Cloud Run Deployment

This worker is packaged for Cloud Run as a service, not a Cloud Run job.

Why:

- The runtime is a long-lived queue poller.
- Browser automation runs longer than a typical webhook request.
- The service can stay warm with `min-instances=1` and `--no-cpu-throttling`.

Create the secrets once:

```bash
printf '%s' "$SUPABASE_SERVICE_ROLE_KEY" | gcloud secrets create supabase-service-role-key \
  --replication-policy=automatic \
  --data-file=-

gcloud secrets create xometry-storage-state --replication-policy=automatic
gcloud secrets versions add xometry-storage-state \
  --data-file=/absolute/path/to/xometry-storage-state.json
```

If the secret already exists, add a new version instead:

```bash
printf '%s' "$SUPABASE_SERVICE_ROLE_KEY" | gcloud secrets versions add supabase-service-role-key \
  --data-file=-
```

Deploy from the `worker/` directory:

```bash
cd worker
GOOGLE_CLOUD_PROJECT=your-project-id \
CLOUD_RUN_REGION=us-west1 \
SUPABASE_URL=https://your-project.supabase.co \
./scripts/deploy-cloud-run.sh
```

The deploy script:

- builds from `worker/Dockerfile`
- configures a single-instance Cloud Run service
- injects `SUPABASE_SERVICE_ROLE_KEY` from Secret Manager
- injects `XOMETRY_STORAGE_STATE_JSON` from Secret Manager
- enables the Chromium flags that are typically needed in Cloud Run

Recommended first-pass settings:

- `min-instances=1`
- `max-instances=1`
- `concurrency=1`
- `cpu=2`
- `memory=2Gi`
- `timeout=3600`

Notes:

- The worker service should stay private. The deploy script uses `--no-allow-unauthenticated`.
- `XOMETRY_STORAGE_STATE_JSON` is written to a temporary file on startup so Playwright can consume it as a normal `storageState` file.
- When the Xometry session expires, refresh the local storage-state file and upload it as a new Secret Manager version.

## Notes

- The web app in the repo uses Supabase RPCs and direct table access.
- This worker intentionally lives outside the Vite app so browser automation can run in a proper long-lived process.
- `sendcutsend` is modeled as a CNC manual-follow-up lane in v1.
- The live Xometry adapter fails closed if login or captcha is encountered.

## Spreadsheet Quote Import

Use the generic workbook importer for spreadsheets shaped like `Quotes Spreadsheet.xlsx`:

```bash
cd worker
npm run import:quotes -- --workbook /absolute/path/to/Quotes\ Spreadsheet.xlsx --organization-id <org-id> --existing-shared-project-jobs
```

Notes:

- `All Quotes` is the source of truth for scatter-chart quote data.
- `Finishing Quotes` is not imported into `vendor_quote_results` or `vendor_quote_offers`.
- `--existing-shared-project-jobs` resolves workbook batches like `QB00001` to existing shared-project jobs by project name, part number, and normalized revision, replaces quote data in place for overlapping jobs, and creates a missing shared-project job inside the existing batch project when the workbook contains a new part that does not already exist there.
- Batches with no supported `All Quotes` supplier rows are skipped explicitly.
