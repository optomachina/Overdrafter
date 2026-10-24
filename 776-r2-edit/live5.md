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

Commands run (QA pre-check on the current head `3240eab17f01cedd3c980b54067fcc723d399dac`, 2026-10-16 MST, log `/workspace/qa-batch/776-r2.log`, section "R2b"; local disposable PG17.11 cluster on a unix socket only, nothing applied to shared staging or prod):

```bash
# delta: git diff 9489b783..3240eab1 (first parent: a0789e5d, 87e954f9, merge of origin/main d7489665)
# local PG17 apply of supabase/migrations/*.sql: fresh autocommit x2, fresh with the 7 window files single-tx (-1),
#   main d7489665 (153) + the 7 window files, and 768+771+767+769 + injected error in one tx (atomicity)
pg_prove supabase/tests   # at head and at main d7489665, same local cluster
npx vitest run scripts/deploy-cloud-run-contract.test.mjs src/features/quotes/server-quote-expiry-migration.test.ts
node scripts/generate-free-quote-fixtures.mjs --check
npm run test:portable-node
npm run lint
npm run typecheck
npx vitest run
node scripts/validate-pr-body.mjs <body>   # full 8-section check, and CI mode (--skip-unless-enabling --verify-links)
```

Results:
- [x] all listed verification passed
- [x] unrelated baseline failures are described below
- Delta since the last QA PASS (9489b783): docs only. a0789e5d and 87e954f9 touch only `docs/staging-env-wiring.md`; the origin/main merge is the automatic merge tree and changes none of the 28 PR-touched files (no migrations, no `supabase/tests`, no Sonar props).
- PG17: all 159 migrations replay deterministically. The schema dump (md5 `426edbbe`) is byte-identical across a repeated fresh apply, the single-tx window apply and main's 153 + the 7, and matches the 9489b783 dump apart from two pg_dump version header lines. 768+771+767+769 plus an injected error in one transaction leave 0 changed or new public function definitions (atomic).
- pgTAP (local): head Files=83 Tests=3233, main Files=77 Tests=3091. Every file that fails at head also fails at main, so there are no new failures versus main. The PR suites (ovd766_a/c/d/e, ovd768, ovd771, ovd722, client_rpc_least_privilege, api_role_privilege_inventory) pass.
- Contract + expiry tests 108/108; fixtures `--check` exit 0; portable-node 1704 pass / 0 fail / 2 skip; lint and typecheck exit 0.
- CI @3240eab1: 26 check runs completed, 25 success + 1 cancelled proof-check superseded by a green rerun (run 39005389705). CI run 39005373647 `test` job: pgTAP Files=82 Tests=3591 PASS, vitest 12729 tests passed. ephemeral-db, Disposable staged SQL proof, verify and secret-scan green. SonarCloud quality gate passed on commit 3240eab1 (duplication on new code 0.0%).

Baseline failures or exceptions:
- Local full `npx vitest run`: 46 files / 15 tests fail, all environment (no `worker/node_modules`, a missing ovd417 harness tool, and timing flakes that pass on an isolated rerun). The same 8 non-worker failures reproduce identically at 9489b783. In CI the full run is green.
- Local pgTAP: 21 files fail at head (22 at main) from local setup gaps (storage stub permissions, dblink to host.docker.internal, cross-file pollution); none are head-only.
- The migration-immutability check (report mode, not failing) has 1 finding, the OVD-736 rename (see Migration notes).

## Tests

No tests were added or changed after 9489b783: the two non-merge commits since then (a0789e5d, 87e954f9) touch only `docs/staging-env-wiring.md`, and the origin/main merge touches no PR file. Earlier commits on this PR keep coverage through existing suites, re-run by QA at 3240eab1: `scripts/deploy-cloud-run-contract.test.mjs` with `src/features/quotes/server-quote-expiry-migration.test.ts` (108/108, including the OVD-838 staging refusal and the OVD-462 lease-on and opt-out tests), pgTAP suites ovd766_a/c/d/e, ovd768, ovd771, ovd722, client_rpc_least_privilege and api_role_privilege_inventory, free-quote fixture `--check`, portable-node, and CI pgTAP Files=82 / Tests=3591 (run 39005373647).

## Migration notes

- [x] Migration impact exists and is described below

Repo records seven already-applied prod window migrations at prod versions (159 total). Notable ledger rename: `20261015074957_ovd736_revoke_anon_definer_execute` → `20261016013742_ovd736_revoke_anon_definer_execute` (bytes unchanged). If staging applied the old version before the rename, repair only those exact versions on staging (see Rollback / risk notes). Do not use a broad repair, `db push --include-all`, or a manual ledger insert. Rollbacks for the window remain in `docs/migration-drafts/*.rollback.sql`; order: e, 736, d, c, a, 771 (before any 722 rollback), b. Nothing in this PR applies SQL to staging or prod.

**Staging status of the seven window migrations: none of the seven is applied on staging** (staging `ldmambwtksfvqdufhaam` migration ledger, read-only `list_migrations`, 2026-10-17 05:49 UTC). The latest staging version is the OLD `20261015074957` ovd736_revoke_anon_definer_execute, so staging already has the pre-rename OVD-736 migration and a staging apply of this PR must account for the rename. QA proofs ran only on a throwaway local PG17 and on CI's ephemeral databases; nothing was applied to staging or prod.

| Version | Migration | Staging status |
| --- | --- | --- |
| `20261015214135` | ovd768_admin_list_guards | not applied on staging (staging ledger read 2026-10-17 05:49 UTC via read-only `list_migrations`) |
| `20261015221725` | ovd771_service_kill_switch | not applied on staging (staging ledger read 2026-10-17 05:49 UTC via read-only `list_migrations`) |
| `20261016000156` | ovd767_admin_write_aal2_guards | not applied on staging (staging ledger read 2026-10-17 05:49 UTC via read-only `list_migrations`) |
| `20261016002932` | ovd769_reconcile_job_parts_guard | not applied on staging (staging ledger read 2026-10-17 05:49 UTC via read-only `list_migrations`) |
| `20261016004826` | ovd770_quote_select_editor_guard | not applied on staging (staging ledger read 2026-10-17 05:49 UTC via read-only `list_migrations`) |
| `20261016013742` | ovd736_revoke_anon_definer_execute (renamed from `20261015074957`, which is on main since #766) | not applied on staging; the OLD `20261015074957` ovd736_revoke_anon_definer_execute IS applied on staging (ledger read 2026-10-17 05:49 UTC, read-only `list_migrations`), so a staging apply must account for the rename |
| `20261016013832` | ovd766e_job_editor_scope | not applied on staging (staging ledger read 2026-10-17 05:49 UTC via read-only `list_migrations`) |

Before any staging apply or repair, read the staging ledger first (read-only), for example `supabase migration list --db-url "$STAGING_DB_URL"`, and only then pick the step. Any staging apply or repair goes through Grok Bot with Blaine's approval.

**`begin;`/`commit;` removed in ovd769 and ovd770.** `20261016002932_ovd769_reconcile_job_parts_guard.sql` and `20261016004826_ovd770_quote_select_editor_guard.sql` are not byte-identical to their drafts: each lost only its explicit `begin;` and `commit;` and has no other transaction-control or non-transactional statements (QA issuecomment-6207086255 and issuecomment-6229846105). The Supabase CLI wraps each migration in a transaction anyway (Opus issuecomment-6229492279), and QA's single-tx (`-1`) apply of all 7 files and the atomicity check pass at 3240eab1. The new hashes (`c20052fc…`, `e1ccedb3…`) are pinned in `scripts/fixtures/free-quote-ci-source.json` and `scripts/free-quote-ci-profile.mjs`. That these bytes equal what prod recorded is the PR's claim; reviewers could not check it against the live prod DB (Opus issuecomment-6229492279).

## Rollback / risk notes

Fail-forward: do not reverse the recorded prod window from this PR. If staging migration history drifted because staging applied `20261015074957` before the rename to `20261016013742`, repair staging only with these exact commands (and only when bytes are confirmed identical):

```sh
supabase migration repair --db-url "$STAGING_DB_URL" --status reverted --yes 20261015074957
supabase migration repair --db-url "$STAGING_DB_URL" --status applied --yes 20261016013742
```

Use `$STAGING_DB_URL` only — never a production DB URL. Every apply (including any staging repair) goes through Grok Bot with Blaine's approval. Risks if mis-run: broad repair or `db push --include-all` could rewrite the wrong ledger; leaving the production lease namespace-key default on a staging deploy is refused by `deploy-cloud-run.sh` (lease-off is not an escape). Open card risks before merge: Sonar CPD exclusion lacks "Approved by Blaine"; OVD-736 rename needs `migration-edit-approved`.

### Lease default flip (OVD-462, `worker/scripts/deploy-cloud-run.sh`)

- **Does `worker-provider-session-namespace-key` exist in prod Secret Manager? Yes, verified 2026-10-17 06:13 UTC (metadata only, value never read).** Grok Bot checked with Blaine's gcloud: it exists in project `overdrafter-worker-9133` (created 2026-10-15 21:25 UTC), version 1 is ENABLED, and the Cloud Run service `overdrafter-cad-worker` runs as `overdrafter-worker-runner@overdrafter-worker-9133.iam.gserviceaccount.com`, which holds `roles/secretmanager.secretAccessor` on it. This matches `docs/provider-session-lease.md` (#774, a7c75a7d). Prod was not queried by this PR's bots beyond that metadata check.
- **What could go wrong:** every prod deploy now binds `WORKER_PROVIDER_SESSION_NAMESPACE_KEY=worker-provider-session-namespace-key:latest` through `--update-secrets` (`deploy-cloud-run.sh:353–354`, deploy call at line 382). **Prod secret existence: VERIFIED (metadata only, value never read)** by Grok Bot on 2026-10-17 06:13 UTC with Blaine's gcloud: `worker-provider-session-namespace-key` exists in project overdrafter-worker-9133 (created 2026-10-15 21:25 UTC); version 1 is ENABLED; `overdrafter-worker-runner@overdrafter-worker-9133.iam.gserviceaccount.com`, the runtime service account of Cloud Run service `overdrafter-cad-worker`, holds `roles/secretmanager.secretAccessor` on it. So the binding resolves at deploy today; the failure mode below applies only if the secret, its version or the accessor grant is later removed. **What actually happens if it is missing, disabled, or unreadable by the runtime service account at deploy:** Cloud Run cannot resolve the secret reference, so the new revision fails to become ready and `gcloud run deploy` exits non-zero; the script runs under `set -euo pipefail`, so the deploy step fails. Cloud Run only shifts traffic to a revision once it is ready, so the previously serving revision keeps serving. Net effect: the deploy is blocked and prod stays on the old worker; it is not an outage, but no new worker code ships until the secret exists or the binding is removed. The DB migrations in this PR are already applied in prod (see Migration notes), so a blocked deploy does not leave schema and code out of step any worse than today.
- **Turning the lease off does not undo the flip.** `WORKER_PROVIDER_SESSION_LEASE=off` only changes the env var. The script still binds the namespace-key secret whenever the name is non-empty (`deploy-cloud-run.sh:353–354`), and an empty `WORKER_PROVIDER_SESSION_NAMESPACE_KEY_SECRET_NAME` falls back to the default through `${VAR:-default}` (line 28). So a missing secret breaks lease-off deploys too. Rollback means one of these two:
  1. **Name a different secret that exists** (no code change, per deploy). With the lease off the worker doesn't require the key (`worker/src/config.ts` only throws when the lease is `on`):
     ```sh
     WORKER_PROVIDER_SESSION_LEASE=off \
     WORKER_PROVIDER_SESSION_NAMESPACE_KEY_SECRET_NAME=<existing-secret-name> \
     worker/scripts/deploy-cloud-run.sh   # plus the usual prod deploy env
     ```
  2. **Revert the default flip in a new PR off main** (fail forward: no force-push, no history rewrite). Checked in a scratch clone at 3240eab1: `git revert f1168d83` applies cleanly, but then 1 of 97 contract tests fails ("refuses a staging deploy that leaves the production lease namespace key default", added in 9489b783), and `git revert 9489b783` conflicts in `docs/staging-env-wiring.md`. So:
     ```sh
     git switch -c revert-ovd462-lease-default origin/main
     git revert --no-edit f1168d83   # if #776 is squash-merged, instead restore the two pre-flip defaults:
     # sed -i 's/:-worker-provider-session-namespace-key}"/:-}"/; s/WORKER_PROVIDER_SESSION_LEASE:-on}"/WORKER_PROVIDER_SESSION_LEASE:-}"/' worker/scripts/deploy-cloud-run.sh
     # then drop or adjust that 9489b783 staging test and the matching docs/staging-env-wiring.md text by hand
     npx vitest run scripts/deploy-cloud-run-contract.test.mjs
     ```
     After that PR merges, redeploy with `worker/scripts/deploy-cloud-run.sh`.
- Every apply, including any prod or staging deploy or redeploy above, goes through Grok Bot with Blaine's approval.

### Sonar CPD exclusion (`.sonarcloud.properties`, gate loosening)

- **Risk:** `supabase/migrations/20261015221725_ovd771_service_kill_switch.sql` and `supabase/migrations/20261016000156_ovd767_admin_write_aal2_guards.sql` are added to `sonar.cpd.exclusions`, so Sonar no longer reports duplication in them. The exclusion lists exact paths, not a glob, so later migrations that copy the same guard shape are still scanned (Opus issuecomment-6229492279). The "Approved by Blaine" note for this entry is **pending Blaine** (card item a).
- **Rollback:** remove the two paths (and the OVD-771/OVD-767 comment line) from `sonar.cpd.exclusions` in a new commit. On this branch that brings back the Sonar failure QA saw on ecb94057: 6.6% duplication on new code against a 3% limit (issuecomment-6207086255).

### Removed workflow (`.github/workflows/ovd766-pending-pgtap.yml`, gate edit)

- **Risk:** the non-required, draft-only workflow is deleted. Its pending suites now run in the main pgTAP job (CI run 39005373647: Files=82 Tests=3591 PASS). It also replayed `docs/migration-drafts/ovd-766-*.rollback.sql` and `ovd-771*.rollback.sql` on an ephemeral database. I found no other CI job that replays those rollbacks.
- **Rollback:** restore the file from the pre-merge base in a new commit (`git checkout d7489665 -- .github/workflows/ovd766-pending-pgtap.yml`). As written it would then exit with "no drafts or pending tests selected", because the drafts and `.pending` tests moved, so it needs adapting to apply from `supabase/migrations` before it is useful again.

## Documentation

- [x] Docs updated

`docs/staging-env-wiring.md`: documents that `WORKER_PROVIDER_SESSION_LEASE=off` does not clear the default namespace-key secret name and that an empty name falls back to the production default, so the staging `-staging` guard still refuses; adds the narrowly scoped staging repair commands for the OVD-736 rename drift case and warns against broad repair.

## Proof

Current head `3240eab17f01cedd3c980b54067fcc723d399dac`, from QA's pre-check (log `/workspace/qa-batch/776-r2.log`, section "R2b"; the QA PASS comment for this head is drafted but not yet posted) and Codex's re-review (APPROVED @3240eab1, https://github.com/optomachina/Overdrafter/pull/776#issuecomment-6230022828):

- **Delta since 9489b783 is docs only:** a0789e5d and 87e954f9 touch only `docs/staging-env-wiring.md`; the origin/main merge (d7489665) is the automatic merge tree and changes no PR-touched file.
- **PG17 replay (local disposable PG17.11 only):** all 159 migrations replay deterministically. The schema dump is byte-identical across a repeated fresh apply, a fresh apply with the 7 window files single-tx, and main's 153 + the 7, and it matches the 9489b783 dump. 768+771+767+769 plus an injected error in one tx leave 0 function changes (atomic).
- **pgTAP:** no new failures versus main locally (head 83 files / 3233 tests, main 77 / 3091; every file failing at head also fails at main). CI pgTAP on real Supabase Files=82, Tests=3591, PASS (https://github.com/optomachina/Overdrafter/actions/runs/39005373647).
- **Hash match:** the free-quote fixtures pass `generate-free-quote-fixtures.mjs --check` with the hashes pinned (re-run at 3240eab1, exit 0); an earlier QA comment recomputed the sha256 of all 7 files and they match `free-quote-ci-source.json` and `free-quote-ci-profile.mjs` (https://github.com/optomachina/Overdrafter/pull/776#issuecomment-6207086255). That comment was on ecb94057; all 7 window migration files are blob-identical between ecb94057 and 3240eab1, so it still applies.
- **Contract tests:** `scripts/deploy-cloud-run-contract.test.mjs` with `server-quote-expiry-migration.test.ts` passes 108/108 at 3240eab1, including the OVD-838 staging refusal test and the OVD-462 lease-on and opt-out tests.
- **CI and Sonar:** 26 check runs completed at 3240eab1: 25 green, plus one cancelled proof-check superseded by green run 39005389705; SonarCloud quality gate passed on 3240eab1. Nothing was applied anywhere except the throwaway local PG17.

Test: scripts/deploy-cloud-run-contract.test.mjs
Test: src/features/quotes/server-quote-expiry-migration.test.ts
Test: supabase/tests/ovd766_d_guards.sql

Earlier evidence, kept for history: QA PASS on 9489b78349368c7a05963ad6e729a728d7e8d93a (https://github.com/optomachina/Overdrafter/pull/776#issuecomment-6229846105), with the same three-path apply and atomicity results, contract 108/108, CI pgTAP Files=82 / Tests=3591 PASS and 21/21 non-Vercel checks green (run 38996819987).

## Blaine decisions (card)

a. **Sonar CPD exclusion note:** `.sonarcloud.properties` excludes `20261015221725_ovd771_service_kill_switch.sql` and `20261016000156_ovd767_admin_write_aal2_guards.sql` from CPD, without the "Approved by Blaine" line the OVD-462/722/723 entries carry. Needs Blaine's approval line or a Linear approval link.
b. **`migration-edit-approved` label for the OVD-736 rename:** `20261015074957` → `20261016013742` (bytes unchanged) trips the migration-immutability check (report mode). Needs the label from Blaine after the last push. QA did not add it.
c. **Removing the `ovd766-pending-pgtap` workflow:** `.github/workflows/ovd766-pending-pgtap.yml` is deleted; its suites now run in the main pgTAP job.
d. **Lease default flip:** `deploy-cloud-run.sh` now defaults `WORKER_PROVIDER_SESSION_LEASE=on` and the namespace-key secret name to `worker-provider-session-namespace-key`. Staging must set a `-staging` name; `LEASE=off` is not an escape from that check (see `docs/staging-env-wiring.md`).

## Gate change review

This PR loosens or edits gates. Declared by hand: `validate-pr-body.mjs` in CI mode (`--skip-unless-enabling --verify-links`) reports "No provider enablement or gate edit in this diff", because its gate list (`GATE_FILES` in `scripts/provider-enablement-detect.mjs`) covers only the PR body gate's own files, not Sonar settings or workflow deletions.

gate_loosening: detected (declared manually)
- `.sonarcloud.properties` (M): adds `supabase/migrations/20261015221725_ovd771_service_kill_switch.sql` and `supabase/migrations/20261016000156_ovd767_admin_write_aal2_guards.sql` to `sonar.cpd.exclusions`.
- `.github/workflows/ovd766-pending-pgtap.yml` (D): deletes the draft-only pending pgTAP workflow. (Opus @9489b783 judged this deletion "not a loosening" because its suites moved into the main pgTAP job; it is declared here as a gate edit anyway.)
- requires: grokbot_countersign + blaine_card

Reviewer: PENDING Blaine (card). Not reviewed or approved yet.
- "Approved by Blaine" note for the CPD exclusion: **pending Blaine**, not filled in.
- `migration-edit-approved` label for the OVD-736 rename: **pending Blaine**, not added.

Evidence: Opus review calling out the gate loosening, https://github.com/optomachina/Overdrafter/pull/776#issuecomment-6229492279; rollbacks for both are in Rollback / risk notes.

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->
## Summary by CodeRabbit

* **Bug Fixes**
  * Quote and job-part actions now require appropriate edit permissions. Members who can only view a job, or whose accounts are unverified, are denied these actions.
* **Changes**
  * Provider session leasing is now enabled by default for Cloud Run deployments. Deployments use a default namespace-key secret, and the lease can still be explicitly disabled.
* **Chores**
  * Removed the automated workflow for applying pending database migrations and running their associated tests.
<!-- end of auto-generated comment: release notes by coderabbit.ai -->







