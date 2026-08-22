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
- `live`: enables Playwright-backed vendor automation for adapters listed in `WORKER_LIVE_ADAPTERS`.
  Adapters that are still stubs fail closed and are routed to `manual_vendor_followup` with explicit failure metadata.

## Environment

Required:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Optional:

- `WORKER_MODE=simulate|live`
- `WORKER_LIVE_ADAPTERS=xometry` (required for every 1.0 beta run; additional
  adapters are internal/deferred validation only)
- `WORKER_NAME=quote-worker-1`
- `WORKER_POLL_INTERVAL_MS=5000`
- `WORKER_QUANTITY_PRICING_LADDER=1,10,100,1000`
- `WORKER_VENDOR_RATE_LIMIT_MS=0`
- `WORKER_PRICING_MODEL_ENABLED=false`
- `WORKER_PRICING_MODEL_MIN_CONFIDENCE=0.7`
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
- `XOMETRY_PROFILE_SNAPSHOT_BUCKET=private-xometry-profile-bucket`
- `XOMETRY_PROFILE_SNAPSHOT_OBJECT=profiles/production.tgz`
- `XOMETRY_PROFILE_SNAPSHOT_MAX_BYTES=268435456`
- `FICTIV_STORAGE_STATE_PATH=/absolute/path/to/fictiv-storage-state.json`
- `FICTIV_STORAGE_STATE_JSON={"cookies":[],"origins":[]}`
- `OPENAI_API_KEY=...` with `DRAWING_EXTRACTION_MODEL=gpt-5.4`
- `ANTHROPIC_API_KEY=...` with `DRAWING_EXTRACTION_MODEL=claude-sonnet-4-6`
- `DRAWING_EXTRACTION_ENABLE_MODEL_FALLBACK=true|false`

## Bootstrap Live Vendor Login State

Create a local env file first:

```bash
cd worker
cp .env.example .env
```

Fill in at least:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `XOMETRY_STORAGE_STATE_PATH`

For production secret managers, prefer `XOMETRY_STORAGE_STATE_JSON` when
mounting a stable file path is awkward. Fictiv state is required only for an
explicitly approved non-1.0 internal test.

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

Fictiv is not a 1.0 beta lane. For separately approved internal/deferred
validation only, create a Fictiv authenticated storage-state file:

```bash
cd worker
npm run auth:fictiv
```

Or save it to an explicit path:

```bash
cd worker
npm run auth:fictiv -- /absolute/path/to/fictiv-storage-state.json
```

The script will:

1. Open a Chromium window.
2. Let you log in to Fictiv manually.
3. Save the authenticated Playwright `storageState` file after you press Enter.

After that, point the worker at the saved file:

```bash
export XOMETRY_STORAGE_STATE_PATH=/absolute/path/to/xometry-storage-state.json
export WORKER_MODE=live
export WORKER_LIVE_ADAPTERS=xometry
```

Do not add Fictiv or another adapter to a 1.0 worker. A later roadmap release
must explicitly promote and certify each additional production lane. Use the
standalone evaluation command below for non-production live evaluation.

Re-auth the 1.0 Xometry session at least weekly with `npm run auth:xometry`.
Use `npm run auth:fictiv` only for an explicitly approved non-1.0 internal test.

### Standalone live-provider evaluation

`OVD-407` permits direct live-provider evaluation without Supabase production
routing, customer disclosure, provider admission, entitlement/rollout,
dispatch-permit/preflight, anti-bot-certification, or order-prevention
affirmations. The harness uses a dedicated evaluation adapter entry point,
passes `executionContext = "live_evaluation"`, uploads the operator-selected
local files, and writes its result JSON under the system temporary directory.
The normal production adapter entry point does not honor a caller-supplied
evaluation context as a bypass. The harness does not write customer quote rows
or canonical offers. Before reading or uploading files, it requires an explicit
non-export-controlled confirmation and binds that confirmation to SHA-256
digests of private staged copies of the exact CAD and optional drawing bytes.
The evaluation-only adapter registry captures the verified bytes into in-memory
upload payloads before browser work, then uploads those captured bytes after
any session, navigation, or selector waits. Xometry and Fictiv have verified
drawing flows. Generic portal adapters accept CAD only and fail before browser
launch when a drawing is selected, rather than silently omitting it.

Authenticate the provider session with the existing `auth:xometry`,
`auth:fictiv`, or `auth:vendor` command, configure that session through the
corresponding storage-state/profile variables, then run:

```bash
npm run eval:live-provider -- --vendor xometry --cad /absolute/path/part.step --confirm-non-export-controlled
npm run eval:live-provider -- --vendor fictiv --cad /absolute/path/part.step --drawing /absolute/path/drawing.pdf --confirm-non-export-controlled
npm run eval:live-provider -- --vendor oshcut,weerg --cad /absolute/path/part.step --quantities 1,5 --confirm-non-export-controlled
```

The command sets its own live adapter selection. Provider login expiry,
CAPTCHA, anti-detection behavior, selector drift, and portal failures are
reported with local evidence; they do not require a production rollout or
provider-admission change before another evaluation attempt.

Camoufox is the Xometry anti-bot compatibility engine added in PR #236 after
Patchright sessions were silently degraded by Cloudflare. PR #277 later made
standard Playwright the default because it loaded the material API correctly
with the same production storage state. The current Cloud Run image injects
that storage state and supports Playwright; it does not install and persist a
Camoufox profile, and its ordinary writable filesystem is disposable across
instances and revisions. Treat any hosted production Playwright anti-bot/no-op
or material `401` as a stop condition for the production lane. A hosted
Camoufox rollback requires its runtime,
durable profile storage, and a separately verified deployment. The controlled
PR #236 result did not establish unattended reliability; repeated attempts
degraded after roughly ten quotes.

### Durable hosted profile snapshots

When Xometry rejects a fresh storage-state browser, use snapshot mode instead
of mounting a live browser profile on network storage. The worker downloads one
exact generation of a closed-browser profile archive, validates and extracts it
to `WORKER_TEMP_DIR/xometry-profile`, runs the browser only from that local
directory, closes the browser, and replaces the object with a generation
precondition. A conflict or snapshot failure stops the task without an
automatic resend when provider mutation may already have occurred.

Configure `XOMETRY_PROFILE_SNAPSHOT_BUCKET` and
`XOMETRY_PROFILE_SNAPSHOT_OBJECT` together. Do not also configure
`XOMETRY_STORAGE_STATE_PATH`, `XOMETRY_STORAGE_STATE_JSON`, or
`XOMETRY_USER_DATA_DIR`; snapshot mode manages the local directory. The deploy
script sets the service environment with `--set-env-vars`, which replaces the
service's entire variable set, so any legacy plain
`XOMETRY_STORAGE_STATE_PATH`, `XOMETRY_STORAGE_STATE_JSON`, or
`XOMETRY_USER_DATA_DIR` bindings are dropped on a snapshot-mode deploy, and it
removes the old storage-state secret binding with `--remove-secrets`. Treat
the archive as a credential: keep the bucket private, prevent public access,
enable object versioning with lifecycle cleanup, and grant the worker only the
required object read/write permissions.

Never use a Cloud Storage FUSE or NFS mount as Chromium's live user-data
directory. Those paths do not provide the locking semantics its profile
databases require. Seed and verify the snapshot under the exact production
Linux browser/runtime while rollout is disabled, then prove a fresh-instance
authenticated dashboard with a no-upload probe before requesting permission
for any provider transmission.

### Required snapshot bucket controls

A snapshot bucket must satisfy all five of the following before any
snapshot-mode deployment may proceed:

- The bucket belongs to the same Google Cloud project passed as
  `GOOGLE_CLOUD_PROJECT`.
- Public access prevention is `enforced`.
- Uniform bucket-level access is enabled.
- Object versioning is enabled.
- A lifecycle configuration with well-formed rules and at least one cleanup
  action whose `action.type` is `Delete`; an absent, empty, malformed, or
  non-deleting lifecycle configuration does not satisfy the gate.

`./scripts/deploy-cloud-run.sh` enforces this gate: when snapshot mode is
configured it resolves the target project's numeric identifier, describes the
bucket, and pipes both values through
`../scripts/verify-snapshot-bucket-controls.mjs`, refusing to deploy when any
control is absent, the project identifiers differ, or either metadata source
cannot be read. The preflight reads the installed gcloud storage CLI's raw API
metadata (`projectNumber`, `iamConfiguration.publicAccessPrevention`,
`iamConfiguration.uniformBucketLevelAccess.enabled`, `versioning.enabled`,
`lifecycle.rule`) and normalizes it in memory before evaluation. It fails
closed on absent fields, unexpected types, a bucket owned by another project,
malformed lifecycle rules, or lifecycle policies without a deletion action. The
explicit `--project` on the bucket lookup is not treated as ownership proof;
the returned bucket project number must equal the resolved target project
number. Cross-project buckets are not supported. Enable a missing control with:

```bash
gcloud storage buckets update gs://PRIVATE_BUCKET --public-access-prevention
gcloud storage buckets update gs://PRIVATE_BUCKET --uniform-bucket-level-access
gcloud storage buckets update gs://PRIVATE_BUCKET --versioning
gcloud storage buckets update gs://PRIVATE_BUCKET --lifecycle-file=/path/to/lifecycle.json
```

### Rollback and snapshot-credential revocation

Rollback (documented only; never run automatically):

1. Confirm automatic quote rollout is disabled and the work queue is empty.
2. List revisions with `gcloud run revisions list --service overdrafter-cad-worker`
   and pick the last-known-good revision.
3. Verify that revision's secret/env bindings still resolve (a snapshot-mode
   deploy removes the `XOMETRY_STORAGE_STATE_JSON` binding, so a pre-snapshot
   revision needs that secret to still exist), then shift traffic with
   `gcloud run services update-traffic overdrafter-cad-worker --region "$CLOUD_RUN_REGION" --to-revisions=REVISION=100`.
4. After rollback, treat stored provider credentials as unauthenticated until
   re-proven, keep `max-instances=1` and `concurrency=1`, and leave rollout
   disabled. Fail closed: do not retry provider work automatically.

Snapshot-credential revocation (documented only; preserves fail-closed
readiness):

1. Disable rollout and confirm the work queue is empty with no probe or quote
   task running.
2. Revoke the worker service account's object role on the bucket so no further
   restore or persist can succeed.
3. Terminate or replace every existing worker instance. Deleting or revoking
   bucket access does not erase a profile that a running instance already
   restored into its memory or local disk.
4. Delete every object version of the profile archive; versioning keeps old
   generations, so delete each one.
5. Rotate the Xometry session by re-authenticating so prior cookies stop
   working.
6. Call revocation proven only after a fresh instance, started without bucket
   access or profile, fails readiness/authentication closed while rollout
   remains disabled. Re-seed an absent object exactly once with
   `--if-generation-match=0` before any deployment uses it again.

The production image installs pinned Playwright, Patchright, Camoufox, GeoIP,
and uBlock Origin artifacts and verifies the downloaded Camoufox assets by
SHA-256 during the image build. A Camoufox profile export excludes Firefox's
singleton `lock` only after confirming its owner process has stopped, alongside
Chromium's `Singleton*` links; all other links remain invalid and fail snapshot
validation.

Bootstrap, export, restore, probe, and live profile operations use one atomic
sidecar lock directory for the full credential lifecycle. A sidecar left by a
crashed process is not reclaimed automatically: first prove no browser or worker
still owns the profile, then remove only that exact sidecar before retrying.

Camoufox profiles also include a private, versioned launch-identity file. The
bootstrap holds the profile lifecycle lock, then atomically moves any existing
verified identity to a recovery-only path before it opens the interactive
browser. This keeps the exact fingerprint available after an interrupted or
failed attempt without allowing export, probing, or live use. If the interactive
dashboard classifier passes, the bootstrap closes that browser and
cold-relaunches the same profile and fingerprint under the production probe's
bounded request, browser-worker, WebSocket, WebRTC, WebTransport,
service-worker, and timeout guards.
The fresh context starts offline, closes restored tabs, disables page-created
network workers, and is brought online only after HTTP and WebSocket guards are
installed. It recreates the verified identity marker and confirms export
eligibility only after that fresh context also positively classifies the
authenticated dashboard. A positive
interactive bootstrap by itself is insufficient. Any bootstrap or cold-proof
failure leaves the marker absent. Export, restore, probing, and live quoting
fail closed when the identity is absent, invalid, or the cold relaunch returns
login, anonymous, provider-error, CAPTCHA, or ambiguous evidence. Hosted
Camoufox uses its virtual display rather than true headless mode, so the restored
launch keeps the headed rendering characteristics used during bootstrap while
reusing the exact saved fingerprint configuration. Local recovery and probing
on non-Linux hosts keep that same headed rendering mode without requesting the
Linux-only virtual display; the browser window remains visible for the bounded
cold-relaunch proof.

After authenticating a dedicated profile under the exact production Linux
browser/runtime and closing the browser, create the seed archive with:

```bash
cd worker
XOMETRY_USER_DATA_DIR=/absolute/path/to/dedicated-profile \
XOMETRY_BROWSER_ENGINE=camoufox \
npm run export:xometry-profile -- /secure/temp/xometry-profile.tgz
```

The exporter refuses an active browser profile, writes the required manifest,
checks the engine-specific cookie database, excludes Chromium singleton links,
and validates archive paths, entry types, and size. During the separately
approved infrastructure step, seed an absent object exactly once:

```bash
gcloud storage cp --if-generation-match=0 \
  /secure/temp/xometry-profile.tgz \
  gs://PRIVATE_BUCKET/profiles/production.tgz
```

Delete the local archive securely after verifying the private object. Never
overwrite an existing seed without first disabling rollout and following the
credential-revocation procedure.

Before any CAD transmission, run the exact deployed image as a single-task
Cloud Run Job with the snapshot bucket/object and the same worker service
account. Configure the Job with `--tasks=1`, `--parallelism=1`, and
`--max-retries=0` so a failed or ambiguous probe is never repeated
automatically. Override its command with:

```text
node dist/tools/probeXometryProfileAuth.js
```

The probe restores one exact snapshot generation, launches the configured
production Playwright or Camoufox persistent context offline, closes restored
tabs, disables page-created network workers, installs its HTTP and WebSocket
guards, brings the guarded context online, and navigates only to the quote
dashboard. It allows only Xometry-owned HTTPS GET/HEAD/OPTIONS requests plus
query-only GraphQL POSTs to Xometry's two dashboard endpoints, blocks
WebSockets, WebRTC, and WebTransport, disables Camoufox service workers before
the restored profile starts, performs no click or file-selection action, does not
persist the locally changed profile, and emits only sanitized JSON
(classification, bounded route category, engine, generation, and blocked method
names). It fails closed on login, anonymous quote-home, CAPTCHA, provider-error,
missing/corrupt/incompatible snapshot, or ambiguous dashboard evidence. Do not
capture a screenshot, DOM, trace, request body, cookie, or account identifier
for this credential proof.

This evidence proves the worker's client-side transport allowlist, disabled
alternate page transports, and absence of user-input interaction or file
selection. It does not claim knowledge of arbitrary server-side behavior behind
an allowed provider GET or query-only resolver; record the result as "no
client-observed mutating request," not as absolute proof of provider internals.

For a local dry run against the same environment contract:

```bash
cd worker
XOMETRY_PROFILE_SNAPSHOT_BUCKET=PRIVATE_BUCKET \
XOMETRY_PROFILE_SNAPSHOT_OBJECT=profiles/production.tgz \
XOMETRY_BROWSER_ENGINE=camoufox \
npm run probe:xometry-auth
```

The Cloud Run job must use the worker service account so metadata-server
credentials can read the private object; it does not need the Supabase service
role secret. Keep automatic quote rollout disabled and confirm the work queue
is empty before and after every probe.

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

- `/health`
- `/healthz` for non-Cloud Run environments
- `/ready`
- `/readyz` for non-Cloud Run environments

Cloud Run reserves some paths ending in `z`, and its frontend can intercept
those requests before they reach the container. Use `/health` for Cloud Run
liveness checks and `/ready` for worker readiness.

Debug routes are intentionally not part of the deployed contract. `/debug/events`,
`/debug/extraction/models`, `/debug/extraction/models/refresh`, and
`/debug/extraction/preview` are available only from loopback clients while the worker
is running in a non-live mode. When `WORKER_MODE=live`, those routes return HTTP 403.

## Cloud Run Deployment

This worker is packaged for Cloud Run as a service, not a Cloud Run job.

Why:

- The runtime is a long-lived queue poller.
- Browser automation runs longer than a typical webhook request.
- The service uses `--no-cpu-throttling` while an instance is active.
- The deploy script defaults to `min-instances=1` so the queue poller continues to
  make progress without an external trigger.
- Guarded validation environments can explicitly set `CLOUD_RUN_MIN_INSTANCES=0`
  to avoid idle-instance charges. A zero-idle service must be awakened with an
  authenticated request while queued work is waiting.

Grant the validation caller `roles/run.invoker`, then wake the private worker while
queued work is waiting:

```bash
gcloud run services add-iam-policy-binding overdrafter-cad-worker \
  --region "$CLOUD_RUN_REGION" \
  --member "user:your-email@example.com" \
  --role roles/run.invoker

SERVICE_URL="$(gcloud run services describe overdrafter-cad-worker \
  --region "$CLOUD_RUN_REGION" \
  --format='value(status.url)')"

curl -fsS \
  -H "Authorization: Bearer $(gcloud auth print-identity-token)" \
  "$SERVICE_URL/health"
```

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

Drawing model fallback can use the direct OpenAI or Anthropic API. Create one
provider secret and pass its name during deployment:

```bash
printf '%s' "$ANTHROPIC_API_KEY" | gcloud secrets create anthropic-api-key \
  --replication-policy=automatic \
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

For a guarded validation deployment with no idle instance, explicitly opt into zero:

```bash
CLOUD_RUN_MIN_INSTANCES=0 \
GOOGLE_CLOUD_PROJECT=your-project-id \
CLOUD_RUN_REGION=us-west1 \
SUPABASE_URL=https://your-project.supabase.co \
./scripts/deploy-cloud-run.sh
```

To inject a provider key from Secret Manager, add either
`OPENAI_API_KEY_SECRET_NAME=openai-api-key` or
`ANTHROPIC_API_KEY_SECRET_NAME=anthropic-api-key`. Production deployments
remove any previously configured `OPENROUTER_API_KEY` secret binding.

The deploy script:

- builds from `worker/Dockerfile`
- configures a single-instance Cloud Run service
- injects `SUPABASE_SERVICE_ROLE_KEY` from Secret Manager
- injects `XOMETRY_STORAGE_STATE_JSON` from Secret Manager by default
- or, when both snapshot settings are present, configures the private profile object and removes the storage-state binding
- optionally injects direct `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` credentials from Secret Manager
- enables the Chromium flags that are typically needed in Cloud Run

In Cloud Run, treat `/health` and `/ready` as the only supported HTTP endpoints.
The worker debug routes are disabled because the deployed service runs with
`WORKER_MODE=live`.

Recommended first-pass settings:

- `min-instances=1` for continuous polling; explicitly use `0` only for guarded validation with an authenticated wake request
- `max-instances=1`
- `concurrency=1`
- `cpu=2`
- `memory=2Gi`
- `timeout=3600`

Notes:

- The worker service should stay private. The deploy script uses `--no-allow-unauthenticated`.
- `XOMETRY_STORAGE_STATE_JSON` is written to a temporary file on startup so Playwright can consume it as a normal `storageState` file. Snapshot mode is mutually exclusive.
- When the Xometry session expires, refresh the local storage-state file and upload a new secret version. Fictiv requires a separately reviewed deployment.
- If production runs with `WORKER_MODE=simulate`, the worker logs an explicit warning at startup.

## Notes

- The web app in the repo uses Supabase RPCs and direct table access.
- This worker intentionally lives outside the Vite app so browser automation can run in a proper long-lived process.
- `sendcutsend` is modeled as a CNC manual-follow-up lane in v1.
- The live Xometry and Fictiv adapters fail closed if login or captcha is encountered.

## OpenClaw Task A Gate

Use the OpenClaw validation gate after a live quote run to decide if Task B can proceed.
The gate inspects persisted `vendor_quote_results` rows for `xometry` and `fictiv` and classifies each vendor as:

- `real_quote`
- `blocked`
- `synthetic_or_stub`
- `insufficient_evidence`

Run:

```bash
cd worker
npm run validate:openclaw-gate -- --quote-run-id <quote-run-id>
```

Optional report file:

```bash
cd worker
npm run validate:openclaw-gate -- --quote-run-id <quote-run-id> --out /tmp/openclaw-gate-report.json
```

Exit codes:

- `0`: gate pass (both target vendors have real quote evidence with persisted price + lead time)
- `1`: gate fail (anti-detection, stub/simulation, or insufficient evidence)
- `2`: invalid CLI input or runtime error

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
