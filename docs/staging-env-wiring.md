# Staging environment wiring (OVD-838)

Vercel Preview deployments and the staging worker use the staging Supabase
project. Production keeps its current values. This document lists variable and
secret **names** only. Values are never committed: they live in Vercel project
environment variables, Google Secret Manager, or GitHub Actions secrets.

| Project | Supabase ref | Region |
| --- | --- | --- |
| production | `ozuatdcakezjtevztjlr` | — |
| `overdrafter-staging` | `ldmambwtksfvqdufhaam` | `us-west-1` |

A project ref is a public identifier, so it appears here and in code. Keys do
not appear anywhere in the repository except the public production publishable
key in `.env.example`, which is already shipped in the browser bundle.

## Vercel Preview

Preview reuses the existing names. Add each one in Vercel → Project → Settings
→ Environment Variables with **only Preview** checked, set to the staging
value. Leave the Production-scoped entry unchanged. If an existing entry is
scoped to both Production and Preview, split it into two entries first.

| Variable | Source | Notes |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | staging | `https://ldmambwtksfvqdufhaam.supabase.co`; inlined at build time |
| `VITE_SUPABASE_PROJECT_ID` | staging | `ldmambwtksfvqdufhaam` |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | staging | staging publishable (anon) key |
| `SUPABASE_URL` | staging | must equal `VITE_SUPABASE_URL` (mobile auth requires it) |
| `SUPABASE_PUBLISHABLE_KEY` | staging | must equal `VITE_SUPABASE_PUBLISHABLE_KEY` |
| `SUPABASE_SERVICE_ROLE_KEY` | staging | staging service-role key; Vercel "Sensitive" |
| `MOBILE_AUTH_ENVIRONMENT` | staging | `preview` |
| `MOBILE_AUTH_APP_ORIGIN` | staging | Preview origin; must match the staging Supabase Auth Site URL |
| `MOBILE_AUTH_KEYRING` | staging | a staging-only keyring, never the production keyring; Sensitive |
| `MOBILE_AUTH_CURRENT_KEY_VERSION` | staging | matches the staging keyring |
| `CRON_SECRET` | staging | a staging-only value; Vercel crons run only on Production |
| `OVERDRAFTER_APP_URL` | staging | Preview origin |
| `BILLING_SELF_SERVICE_ENABLED`, `VITE_BILLING_*` | staging | keep disabled on Preview |
| `STRIPE_EXPECTED_LIVEMODE` | staging | `false`; any `STRIPE_*` key on Preview is test mode only |

No new Vercel variable is required: `GET /api/health` derives the target from
the built-in `VERCEL_ENV` and the existing `SUPABASE_URL`/`VITE_SUPABASE_URL`.

## Vercel Production

Unchanged. Every name above keeps its existing Production-scoped value pointing
at `ozuatdcakezjtevztjlr`.

## Worker staging (Cloud Run)

The staging worker is a separate Cloud Run service deployed with the existing
`worker/scripts/deploy-cloud-run.sh`. Set `OVERDRAFTER_DEPLOY_ENV=staging`;
the script then refuses to deploy unless all of these hold, before any `gcloud`
call:

- `SUPABASE_URL` is `https://ldmambwtksfvqdufhaam.supabase.co`;
- `SERVICE_NAME` is not the production `overdrafter-cad-worker`;
- `SUPABASE_SERVICE_ROLE_SECRET_NAME` is not the production
  `supabase-service-role-key`.

| Deploy input | Source | Value or Secret Manager name |
| --- | --- | --- |
| `OVERDRAFTER_DEPLOY_ENV` | shell | `staging` |
| `SERVICE_NAME` | shell | `overdrafter-cad-worker-staging` |
| `SUPABASE_URL` | shell | staging URL |
| `SUPABASE_SERVICE_ROLE_SECRET_NAME` | Secret Manager | `supabase-service-role-key-staging` (mounted as `SUPABASE_SERVICE_ROLE_KEY`) |
| `WORKER_MODE` | shell | `simulate` until staging live dispatch is separately approved |
| `XOMETRY_STORAGE_STATE_SECRET_NAME`, `XOMETRY_PROFILE_SNAPSHOT_*`, `*_API_KEY_SECRET_NAME` | Secret Manager | leave unset, or use separate `-staging` secrets; never the production secrets |

Create the staging secret once, reading the key from your own shell so it never
lands in a file or history:

```bash
gcloud secrets create supabase-service-role-key-staging --replication-policy=automatic
# then add a version from stdin: gcloud secrets versions add supabase-service-role-key-staging --data-file=-
```

The worker `/health` and `/ready` payloads include `supabaseProjectRef` (ref
only) so the deployed target is visible.

## GitHub Actions

No workflow reads staging credentials today, so no new secret is required. The
`extraction-gate` job in `.github/workflows/ci.yml` reads the repository secrets
`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` only to satisfy the worker config
loader and falls back to placeholders. If those secrets are set, they must hold
staging values (or be removed), never production ones. A future workflow that
talks to staging should use `STAGING_SUPABASE_URL` and
`STAGING_SUPABASE_SERVICE_ROLE_KEY`.

## Supabase staging project

Edge Function secrets in `overdrafter-staging` (for example Stripe test keys)
are set in that project's dashboard and are out of scope here.

## Verification

1. Open `https://<preview-host>/api/health`. Expect `200` with
   `deployEnvironment: "preview"` and both `serverSupabaseRef` and
   `browserSupabaseRef` equal to `ldmambwtksfvqdufhaam`.
2. Open `https://<production-host>/api/health`. Expect `200` with both refs
   equal to `ozuatdcakezjtevztjlr`.
3. Any other combination answers `503` with
   `supabaseRefMatchesEnvironment: false`; a smoke check can use `curl -f`.
4. Secret scan, run by an operator with Vercel access. Pull Preview values to a
   temporary file outside the repository, search for the production ref
   (legacy Supabase JWT keys carry it in the payload's `ref` claim), and delete
   the file:

   ```bash
   tmp="$(mktemp)"; vercel env pull "$tmp" --environment=preview
   node -e 'const t=require("fs").readFileSync(process.argv[1],"utf8");const bad=t.includes("ozuatdcakezjtevztjlr")||[...t.matchAll(/eyJ[\w-]+\.([\w-]+)\.[\w-]+/g)].some(m=>Buffer.from(m[1],"base64url").toString().includes("ozuatdcakezjtevztjlr"));console.log(bad?"FAIL: prod ref in Preview":"PASS");process.exit(bad?1:0)' "$tmp"
   rm -f "$tmp"
   ```

   New-format `sb_secret_`/`sb_publishable_` keys do not embed a ref; for those,
   compare the key fingerprints shown in each Supabase project's dashboard.
5. Staging worker: `curl` its `/health` with an identity token and expect
   `supabaseProjectRef: "ldmambwtksfvqdufhaam"`.
