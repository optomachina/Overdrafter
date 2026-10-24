Warning: no stdin data received in 3s, proceeding without it. If piping from a slow command, redirect stdin explicitly: < /dev/null to skip, or wait longer.
Generated files are confirmed in sync; I'm now writing up the verdict.

## Verdict: **APPROVE**, with non-blockers to fix soon

What I checked:
- **Generated files match the registry.** I rendered both files from `provider-registry.v1.json` and compared them to the checked-in copies. `worker/src/generated/providerRegistry.ts` and `worker/scripts/generated/provider-secrets.sh` are both in sync.
- **Tests were not run.** `provider-check.mjs` and the vitest suites need `node_modules`, which isn't installed. I didn't run `bash -n` either, because it needed approval.
- **No `supabase/migrations` or RLS changes.** No file under `supabase/` is touched.

### BLOCKERS
None.

### Security and parity summary
- **Shell injection into the generated script is constrained.** Every value written into it is validated first:
  - provider key: `^[a-z][a-z0-9]{1,49}$`
  - env names: `^[A-Z][A-Z0-9_]{1,80}$`
  - mount path: `^/var/secrets/[a-z0-9-]+/storage-state\.json$`

  These checks are at `scripts/provider-registry.mjs:26-28`, and fixed strings are quoted with `bashQuote`. No double-quote, `$` or backtick can reach the generated script.
- **Only secret names are emitted, never values.** Secrets bind as `NAME:latest` references. Mount paths stay fixed and can't be overridden from the environment, as before.
- **Deploy behaviour matches the removed logic** (`worker/scripts/deploy-cloud-run.sh:136-137,152,291`):
  - The adapter allow-list is the same.
  - Duplicate and empty-field rejection is the same, and so are the error messages.
  - Fictiv, Quickparts and Weerg still require a secret name and have no defaults.
  - When an adapter is disabled, its stale secret bindings are still removed.
  - The stable-egress canonical order is unchanged: `xometry,fictiv,quickparts,weerg`.
  - Under `set -u`, every `*_live_enabled` flag is initialised before `${!enabled_var}` reads it.
- **The 16 disabled providers stay off.** They are `liveAdapter:false` with no secrets and egress `none`, and the validator rejects `stable_nat` or session secrets while `liveAdapter` is false (`provider-registry.mjs:213-218`).

### NON-BLOCKERS
1. **A mount-path variable can overwrite the secret-name variable.** `mountPathVarName` (`scripts/provider-registry.mjs:410-412`) only rewrites env names ending in `_SECRET_NAME`. I tested a `secretNameEnv` of `GEOMIQ_STATE` with a `mountPath`:
   - The generator printed `GEOMIQ_STATE="${GEOMIQ_STATE:-}"` and then `GEOMIQ_STATE="/var/secrets/…"`.
   - The required-secret check then always passes, and the output contains `secret_vars+=("${GEOMIQ_STATE}=${GEOMIQ_STATE}:latest")`.

   In practice gcloud should reject that secret name, so the deploy fails rather than leaking anything. Still, the required-secret check is bypassed. **Fix:** require `secretNameEnv` to end in `_SECRET_NAME` and reject names that collide with variables the deploy script already uses (`WORKER_MODE`, `WORKER_LIVE_ADAPTERS`, `SUPABASE_*`, `PATH`, …).
2. **QA note confirmed: `liveAdapter:true` is accepted without secrets or egress** (`provider-registry.mjs:199-225`). I flipped `geomiq` to `liveAdapter:true` with `sessionSecrets:[]` and egress `none`, and validation passed. That puts geomiq on the deploy and worker allow-list (`PRODUCTION_LIVE_ADAPTERS` feeds `validateLiveAdapterReadiness` at `worker/src/runtimeSecrets.ts:296`) with no session preflight. Database dispatch policy still gates it, so this isn't a blocker. **Fix:** require at least one `requiredWhenListed:true` secret (or an explicit opt-out field), and add a test that keeps the TS readiness validators in step with the live list.
3. **Secrets with `requiredWhenListed:false` are silently skipped** (`provider-registry.mjs:441-445`). They are filtered out of the require, apply and remove steps, so such a secret is never mounted and its stale binding is never removed. This only works today because `deploy-cloud-run.sh` handles Xometry by hand. Either document the flag as meaning "deploy script handles this manually", or still generate the apply/remove step for these secrets.
4. **QA note confirmed: `SECRET_VALUE_LIKE` is too narrow** (`provider-registry.mjs:32`). It only catches `xometry-storage-state`, `sk-`, `-----BEGIN` and `supabase-service-role`. A pasted value in `secretNameEnv` that fits the env-name pattern, such as an AWS-style `AKIA…` key, would pass. It can also false-positive: a mount path like `/var/secrets/desk-…` contains `sk-` and would block a sync. This is defense in depth, since the schema already limits which fields exist. **Fix:** add JWT (`eyJ`), `AKIA`, `ghp_`/`gho_` and long high-entropy checks, and anchor `sk-` to a word boundary.
5. **The stable-egress error message is still hardcoded** to "Fictiv, Quickparts, and/or Weerg" (`worker/scripts/deploy-cloud-run.sh:154`). It will drift from the registry; it could be built from `PROVIDER_REGISTRY_STABLE_EGRESS_OPTIONAL_ADAPTERS`.
6. **An orphaned JSDoc block** sits at `worker/src/runtimeSecrets.ts:289-294`. The comment now precedes another doc comment instead of the export it described; move it to the re-export at line 18.
7. **The egress contract reads the registry at import time** (`scripts/xometry-stable-egress-contract.mjs:10-11`). A missing or invalid registry now breaks every importer at load. That's acceptable fail-closed behaviour, but worth knowing.
8. **QA note on image pull retry is out of scope.** This PR touches no image-pull code. The retry logic for `toomanyrequests` lives in `scripts/ovd591-image-pull.mjs:10` and `.github/workflows/native-sql-proofs.yml:128-137`, and neither is in the diff. Track it as its own ticket.
