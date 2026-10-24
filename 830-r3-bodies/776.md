## Summary

Records the approved 2026-10-15 production migration window in the repo at the seven prod versions (159 migrations total), moves the pending OVD-766 pgTAP suites into `supabase/tests`, removes the draft-only `ovd766-pending-pgtap.yml` workflow, flips the Cloud Run worker provider-session lease default to on, and updates `docs/staging-env-wiring.md` so staging deploy guidance matches the script: there is no `WORKER_PROVIDER_SESSION_LEASE=off` escape from the `-staging` namespace-key check, and staging ledger repair after the OVD-736 rename is two exact-version `supabase migration repair` commands only.

## Problem

Prod already applied the window at prod versions (including the OVD-736 rename `20261015074957` → `20261016013742` with identical bytes). The repo needed to match those versions, keep pgTAP coverage in the main suite, and document staging wiring so operators do not treat lease-off as an escape from the staging secret-name guard or reach for a broad migration repair / `db push --include-all`.

## Scope

Included:
- Seven window migrations at prod versions (ovd768, ovd771, ovd767, ovd769, ovd770, ovd736 rename, ovd766e), with ovd769/ovd770 begin/commit stripped to match prod bytes
- Pending pgTAP suites moved into `supabase/tests`; draft workflow `ovd766-pending-pgtap.yml` removed
- `deploy-cloud-run.sh` lease default on and default namespace-key secret name; staging must use a `-staging` name
- `docs/staging-env-wiring.md`: no lease-off escape; narrowly scoped staging repair commands for the rename drift case
- Free-quote CI fixture path updates for the rename; Sonar CPD exclusions for ovd771/ovd767 (Blaine card still open)

Intentionally not included: applying migrations to staging or prod from this PR; adding the `migration-edit-approved` label; adding the "Approved by Blaine" Sonar line (card items).

## Verification

Commands run (from QA PASS on `9489b78349368c7a05963ad6e729a728d7e8d93a`, issuecomment-6229846105; local disposable PG17.11 only, nothing applied to shared staging/prod):

```bash
# local PG17 apply of supabase/migrations/*.sql (autocommit, single-tx, upgrade-from-main)
pg_prove supabase/tests
vitest run scripts/deploy-cloud-run-contract.test.mjs
node scripts/generate-free-quote-fixtures.mjs --check
npm run test:portable-node
./scripts/preflight.sh lint typecheck
```

Results:
- [x] all listed verification passed
- PG17: all 159 migrations apply cleanly; schema dump byte-identical for three paths; 7 window files apply in single-transaction mode; 768+771+767+769 plus injected error leave no changes (atomic)
- Contract tests 108/108; portable-node 1703/1703; lint + typecheck PASS
- CI pgTAP on real Supabase Files=82, Tests=3591, PASS; 21/21 non-Vercel checks green (run 38996819987); SonarCloud green

Baseline failures or exceptions:
- 22 local pgTAP files fail identically at main (local setup gaps: no storage schema, no dblink); not regressions from this PR

## Tests

No new test files in the docs-only tip commit `a0789e5d` (docs/staging-env-wiring.md only). Earlier commits on this PR keep coverage via existing suites exercised by QA: `scripts/deploy-cloud-run-contract.test.mjs` (108/108, including OVD-838 staging refusal and OVD-462 lease-on/opt-out), pgTAP suites ovd766_a/c/d/e, ovd768, ovd771, ovd722, client_rpc_least_privilege, api_role_privilege_inventory, free-quote fixture `--check`, portable-node, and CI pgTAP Files=82 / Tests=3591.

## Migration notes

- [x] Migration impact exists and is described below

Repo records seven already-applied prod window migrations at prod versions (159 total). Notable ledger rename: `20261015074957_ovd736_revoke_anon_definer_execute` → `20261016013742_ovd736_revoke_anon_definer_execute` (bytes unchanged). If staging applied the old version before the rename, repair only those exact versions on staging (see Rollback / risk notes). Do not use a broad repair, `db push --include-all`, or a manual ledger insert. Rollbacks for the window remain in `docs/migration-drafts/*.rollback.sql`; order: e, 736, d, c, a, 771 (before any 722 rollback), b. Nothing in this PR applies SQL to staging or prod.

## Rollback / risk notes

Fail-forward: do not reverse the recorded prod window from this PR. If staging migration history drifted because staging applied `20261015074957` before the rename to `20261016013742`, repair staging only with these exact commands (and only when bytes are confirmed identical):

```sh
supabase migration repair --db-url "$STAGING_DB_URL" --status reverted --yes 20261015074957
supabase migration repair --db-url "$STAGING_DB_URL" --status applied --yes 20261016013742
```

Use `$STAGING_DB_URL` only — never a production DB URL. Every apply (including any staging repair) goes through Grok Bot with Blaine's approval. Risks if mis-run: broad repair or `db push --include-all` could rewrite the wrong ledger; leaving the production lease namespace-key default on a staging deploy is refused by `deploy-cloud-run.sh` (lease-off is not an escape). Open card risks before merge: Sonar CPD exclusion lacks "Approved by Blaine"; OVD-736 rename needs `migration-edit-approved`.

## Documentation

- [x] Docs updated

`docs/staging-env-wiring.md`: documents that `WORKER_PROVIDER_SESSION_LEASE=off` does not clear the default namespace-key secret name and that an empty name falls back to the production default, so the staging `-staging` guard still refuses; adds the narrowly scoped staging repair commands for the OVD-736 rename drift case and warns against broad repair.

## Proof

From QA's PASS comment on 9489b78349368c7a05963ad6e729a728d7e8d93a (https://github.com/optomachina/Overdrafter/pull/776#issuecomment-6229846105):

- **PG17 three-path apply (local disposable PG17.11 only):** all 159 migrations apply cleanly from scratch. "The schema dump is byte-identical for three paths: fresh autocommit, fresh single-tx, and main's 153 + the 7 files." The 7 window files also apply in single-transaction mode, and 768+771+767+769 plus an injected error leave no changes (atomic).
- **Hash match:** the free-quote fixtures pass `generate-free-quote-fixtures.mjs --check` with the hashes pinned; an earlier QA comment recomputed the sha256 of all 7 files and they match `free-quote-ci-source.json` and `free-quote-ci-profile.mjs` (https://github.com/optomachina/Overdrafter/pull/776#issuecomment-6207086255).
- **Contract tests:** `scripts/deploy-cloud-run-contract.test.mjs` passes 108/108, including the OVD-838 staging refusal test and the OVD-462 lease-on and opt-out tests.
- **CI:** pgTAP on real Supabase Files=82, Tests=3591, PASS; 21/21 non-Vercel checks green (run 38996819987); SonarCloud green. Nothing was applied anywhere except the throwaway local PG17.

## Blaine decisions (card)

a. **Sonar CPD exclusion note:** `.sonarcloud.properties` excludes `20261015221725_ovd771_service_kill_switch.sql` and `20261016000156_ovd767_admin_write_aal2_guards.sql` from CPD, without the "Approved by Blaine" line the OVD-462/722/723 entries carry. Needs Blaine's approval line or a Linear approval link.
b. **`migration-edit-approved` label for the OVD-736 rename:** `20261015074957` → `20261016013742` (bytes unchanged) trips the migration-immutability check (report mode). Needs the label from Blaine after the last push. QA did not add it.
c. **Removing the `ovd766-pending-pgtap` workflow:** `.github/workflows/ovd766-pending-pgtap.yml` is deleted; its suites now run in the main pgTAP job.
d. **Lease default flip:** `deploy-cloud-run.sh` now defaults `WORKER_PROVIDER_SESSION_LEASE=on` and the namespace-key secret name to `worker-provider-session-namespace-key`. Staging must set a `-staging` name; `LEASE=off` is not an escape from that check (see `docs/staging-env-wiring.md`).

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->
## Summary by CodeRabbit

* **Bug Fixes**
  * Quote and job-part actions now require appropriate edit permissions. Members who can only view a job, or whose accounts are unverified, are denied these actions.
* **Changes**
  * Provider session leasing is now enabled by default for Cloud Run deployments. Deployments use a default namespace-key secret, and the lease can still be explicitly disabled.
* **Chores**
  * Removed the automated workflow for applying pending database migrations and running their associated tests.
<!-- end of auto-generated comment: release notes by coderabbit.ai -->

