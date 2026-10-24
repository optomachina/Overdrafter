Closes OVD-838 (repo side). Staging Supabase: `overdrafter-staging`, ref `ldmambwtksfvqdufhaam` (us-west-1). Production unchanged.

## What
- `.env.example`: staging wiring notes (names only). Preview reuses existing names with Preview-scoped staging values; only new name is `OVERDRAFTER_DEPLOY_ENV`.
- `docs/staging-env-wiring.md`: every var name per target (Vercel Preview / Production, worker staging, GitHub Actions, staging project), source, Secret Manager name, verification + Preview secret scan.
- `GET /api/health` (`api/health.ts`, `server/operations/deploy-diagnostics.ts`): reports `VERCEL_ENV` + Supabase project ref from URL (never keys); 503 if Preview isn't on staging ref or Production isn't on prod ref. `vercel.json` rewrite added.
- Worker `/health` + `/ready` include `supabaseProjectRef`.
- `worker/scripts/deploy-cloud-run.sh`: `OVERDRAFTER_DEPLOY_ENV=staging` refuses to deploy (before any gcloud call) unless staging `SUPABASE_URL`, non-prod `SERVICE_NAME`, non-prod service-role secret name.

Infra/deploy files touched (`vercel.json`, `deploy-cloud-run.sh`) → infra review category.

## Checks
- `preflight.sh lint` PASS, `preflight.sh typecheck` PASS
- `npx vitest run --maxWorkers=2`: all pass except `scripts/qualify-ovd417-four-migration-suffix.test.mjs` (3, known OVD-417 docker).

## Draft for Blaine's approval card — NOT created by this PR (names only)
**New Vercel env vars:** none (`/api/health` uses built-in `VERCEL_ENV`).
**Existing Vercel vars needing a Preview-scoped staging value** (Production entries unchanged; split any entry scoped to both):
`VITE_SUPABASE_URL`, `VITE_SUPABASE_PROJECT_ID`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (sensitive), `MOBILE_AUTH_ENVIRONMENT`, `MOBILE_AUTH_APP_ORIGIN`, `MOBILE_AUTH_KEYRING` (sensitive), `MOBILE_AUTH_CURRENT_KEY_VERSION`, `CRON_SECRET` (sensitive), `OVERDRAFTER_APP_URL`, `BILLING_SELF_SERVICE_ENABLED` / `VITE_BILLING_SELF_SERVICE_ENABLED` / `BILLING_TIER_CATALOG_ENABLED` / `VITE_BILLING_TIER_CATALOG_ENABLED` (disabled), `STRIPE_EXPECTED_LIVEMODE`=false (any `STRIPE_*` on Preview test-mode only).
**New Google Secret Manager secrets:** `supabase-service-role-key-staging`, `xometry-storage-state-staging` (empty storage state; staging worker is forced to `WORKER_MODE=simulate`).
**Worker deploy inputs (shell, not stored):** `OVERDRAFTER_DEPLOY_ENV=staging`, `WORKER_MODE=simulate`, `XOMETRY_STORAGE_STATE_SECRET_NAME=xometry-storage-state-staging`, `SERVICE_NAME=overdrafter-cad-worker-staging`, `SUPABASE_SERVICE_ROLE_SECRET_NAME`.
**New GitHub secrets:** none required. Existing `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` used by `extraction-gate` in `ci.yml` should be staging values or unset. Future names if needed: `STAGING_SUPABASE_URL`, `STAGING_SUPABASE_SERVICE_ROLE_KEY`.


## Review round 1 fixes (176c1133)
Staging deploy now refuses `WORKER_MODE=live` and any prod provider-session secret / snapshot bucket; service + secret names must end `-staging`; non-staging deploys refuse the staging `SUPABASE_URL`; ref-drift test; `/api/health` gets only 3 env keys.
