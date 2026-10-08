# Production database apply packet (v2, 2026-10-06 18:1xZ) — release integration branch `codex/recovered-release-free-safety-20261003` at 0924c56

Prepared 2026-10-06 ~15:50Z by the cloud coordinator. Nothing in this packet has been applied anywhere except local and CI databases. Applying it to the hosted/production database is a PROTECTED step that needs Blaine's explicit go at action time.

## 0. Correction in v2: the apply is larger than migrations 134-139

v1 assumed production already ends at migration 133. It does not. Per the OVD-418 runbook (`docs/workflows/ovd418-qualified-database-release.md`), the last qualified production ledger was 104 rows through `20260822213330` (fingerprint 28b8ae8752e5beb8e91505a2becfde86); the 2026-10-03 handoff put the live ledger at "about 112" with 21 candidate identities absent. Main today has 126 migrations and the integration branch 139. So the production apply is the whole suffix from the live ledger tip through migration 139, applied through the qualified-release process the repository already defines (frozen ordered SHA-256 manifest, OVD-417-style head verifier, disposable rehearsal from the exact production baseline, single-use authorization JSON with its SHA-256 supplied out of band, containment checks, post-audit readback). That process is production-capable tooling, not permission; every window needs your separately reviewed authorization.

What I can prepare now, as routine work (no production contact): read-only, the exact live ledger state is yours to read (section 3 adds the query); from whatever tip it reports, I prepare the frozen manifest for the suffix (ordered files, SHA-256 per file, statement hashes), rehearse the exact suffix on a disposable database restored to that baseline ledger, and write the authorization JSON for your signature. Linear issue OVD-635 tracks that preparation.

Migrations 127-133 (the recovered release's own appends; all qualified by the hosted free-quote-sql job on every merged head) with SHA-256 at 0924c56:

| # | Migration file | SHA-256 |
|---|---|---|
| 127 | 20261002041305_enforce_quote_selection_expiry.sql | 30b0e6c41d1c727df269177bb90292d0117674d7b05bc92cdc4dc2fc84ef3da6 |
| 128 | 20261002053133_align_selection_and_publication_sources.sql | 70359183621feca322414cd4a2968c3611578ac7b571cbbf455603cd272aa3bf |
| 129 | 20261002090339_add_atomic_capability_window_attention_persistence.sql | 6ca3a955b01fa7781c616f850778c7e76b1dd7a34cb57fa9f0677dfc1fd27297 |
| 130 | 20261002133713_add_capability_preparation_retention.sql | 9ccc23d277d901a5808a65d7b622536fe761a29e490c6d74200b35e311196214 |
| 131 | 20261002182714_free_quote_job_meter.sql | 32ea33b168021233cd5e3ed8414ec0c94f97d5fc3cc6ee7c35f6423a81c98db2 |
| 132 | 20261002182910_free_confirmed_quote_access.sql | d0c25c26d8fa2275bc554d6089665d350ef9cc5a5323ae27a4e7e3671b7a2676 |
| 133 | 20261003011148_reconcile_free_quote_job_reservations.sql | e2e940492e2c9bb3220cd31471a43fb8711db532311f225c794c245aced671ea |

Migrations between the live ledger tip and 127 (the 105th through 126th files, already on main) are part of the same suffix and will be listed in the frozen manifest once the live tip is known. Sections 1, 5 and 6 below stay valid for 134-139.

## 1. What the integration branch now carries (migrations beyond the 133-file contract tree)

| # | Migration file | Issue | PR (merge commit) | SHA-256 (pinned in `scripts/free-quote-ci-profile.mjs` and `scripts/fixtures/free-quote-ci-source.json`) |
|---|---|---|---|---|
| 134 | `supabase/migrations/20261003150000_ovd536_restrict_audit_event_writer.sql` | OVD-536 (narrow route) | #571 (fce8ba3) | a625b16028242489c5e86e723815f1ee2d7e49f9c8d885d4cf6de12c1308bfa5 |
| 135 | `supabase/migrations/20261003160000_ovd458_generic_provider_dispatch_permits.sql` | OVD-458 | #573 (cc2d41e) | a991e6560d784c9f27516e1cba554ffcf1df440891d4ab22e523827752f472fc |
| 136 | `supabase/migrations/20261003170000_ovd459_provider_dispatch_preflight.sql` | OVD-459 | #574 (d474317) | 7e6d7ce55d2badd3bedc745ab5fe6adb51413160965d49db15ddf3e6fe1bcb10 |
| 137 | `supabase/migrations/20261004100000_ovd598_serialize_legacy_xometry_admission.sql` | OVD-598 | #580 -> #574 (d474317) | 666863ee3aada933945fcb14caa6821e711c5d16651d1781f66f6d0415dcbebd |
| 138 | `supabase/migrations/20261004110000_reject_empty_job_file_uploads.sql` | OVD-601 | #592 -> #574 (d474317) | 4029cba9743f4b80cba4f058345636e1d8f41264a26cad9efc49f89b38384277 |
| 139 | `supabase/migrations/20261004130000_ovd628_generic_admission_nowait.sql` | OVD-628 | #596 -> #574 (d474317) | 441494e77b7e09d9e931ed2f458dfff719ece8fc45fb2cc3a886466b93374da5 |

Also on the branch from earlier merges: #572 (OVD-593 worker browser runtime hardening, no migration) and #568 (OVD-457 envelope contract, no migration).

Hosted evidence of record for the SQL: the `free-quote-sql-qualification / free-quote-sql` job replays all 139 migrations against the closed profile (plus 18 independent-session lifecycle races) and is green at every merged head; the `test` job runs the full pgTAP suite (55+ files) at every merged head.

## 2. What is NOT in the migrations (separate, later packet)

The phone-loop activation SQL is still staged, not active: `docs/release/ovd-558-verifier-authority-forward.sql`, `ovd-560-result-registry-forward.sql`, `ovd-561-finalization-forward.sql`, `ovd-563-step-review-forward.sql` (plus four more SQL sets that exist only in draft PR #565). They belong to the OVD-520 backend activation packet (section X2 of the readiness packet), which also needs an OVD-558 manifest refresh against migrations 134-139 first. They are not part of this release apply.

## 3. Pre-apply, read-only operator checks (run against production BEFORE anything is applied)

From PR #571 (OVD-536). Expected: `function_owner = postgres`, and exactly the rows `postgres`, `service_role`, `supabase_admin`. Any other row is a BYPASSRLS/superuser role that can delete jobs and would lose EXECUTE on the audit writer; the migration's own guard would abort on it, so review it first.

```sql
select r.rolname, r.rolsuper, r.rolbypassrls,
  pg_get_userbyid(p.proowner) as function_owner,
  p.proacl::text as current_acl,
  has_function_privilege(r.oid, p.oid, 'EXECUTE') as executes_now
from pg_roles r
cross join pg_proc p
where p.oid = 'public.log_audit_event(uuid,text,jsonb,uuid,uuid)'::regprocedure
  and (r.rolsuper or r.rolbypassrls
       or r.oid = (select relowner from pg_class where oid = 'public.jobs'::regclass))
  and has_table_privilege(r.oid, 'public.jobs', 'DELETE')
order by r.rolname;
```

The second read-only query (owners of the 36 SECURITY DEFINER callers of `log_audit_event`) is in the PR #571 body, section "Rollback / risk notes". Expected: every owner is `postgres`.

Also confirm, read-only, the live ledger state FIRST (this decides the suffix): `select count(*), max(version) from supabase_migrations.schema_migrations;` plus the fingerprint the OVD-418 runbook defines (`md5(string_agg(version, ',' order by version))`). Expected per the runbook: 104 rows through 20260822213330 (fingerprint 28b8ae8752e5beb8e91505a2becfde86); the 2026-10-03 handoff said about 112. Any other state is reported, not assumed.

## 4. Apply (PROTECTED; owner-executed or owner-authorized at action time)

Through the qualified-release process (OVD-418 runbook): frozen manifest for the exact suffix (ledger tip + 1 through 139), disposable rehearsal from the exact baseline, single-use authorization JSON, containment checks (rollout controls disabled, billing self-service disabled), then the exact plan, then post-audit. Never a linked default, history repair, seed application or dashboard SQL.

Forward-only, in order 134 -> 139, through the repository's documented release procedure (the lock-holder scripts `scripts/hold-ovd373-production-locks.sql` / `scripts/hold-ovd418-production-locks.sql` take the `commercial-rollout:automatic_quote_collection` advisory lock exclusively for the release window; migration 137's header documents that fresh legacy admissions wait on that lock during the window, bounded by their statement_timeout). All six are additive: grants, new private helpers, `create or replace` of existing RPCs with byte-for-byte restates plus guards, two new functions, one new table set (135). No table data changes.

## 5. Post-apply readback

1. `log_audit_event` ACL: PUBLIC/anon/authenticated denied; postgres, service_role, supabase_admin keep EXECUTE (re-run the query in section 3; the `executes_now` column flips only for roles outside the three).
2. Function definitions present and matching the pinned bytes: `md5(pg_get_functiondef(...))` for `api_request_xometry_beta_dispatch`, `private.lock_xometry_beta_dispatch_scope_rows`, `api_request_provider_dispatch`, `private.lock_provider_dispatch_scope_rows`, `private.resolve_provider_dispatch_scope`, `api_authorize_provider_worker_dispatch`, `api_prepare_job_file_upload`, `api_finalize_job_file_upload`; compare against a local `supabase db reset` at the same commit.
3. Synthetic denials with a throwaway verified user: direct `log_audit_event` call -> 42501; empty-file prepare -> P0001 `file_upload_empty`; a fresh legacy request while another session holds the job row -> P0001 `xometry_beta_job_busy`; generic equivalent -> `provider_dispatch_job_busy`. (All read-only or rolled back; no customer rows.)
4. The generic preflight is admitted for nothing today (no reviewed generic envelope exists in code), so `api_authorize_provider_worker_dispatch` can only deny; verify one denial.

## 6. Rollback (per migration, forward-only in production)

- 134: `grant execute on function public.log_audit_event(uuid,text,jsonb,uuid,uuid) to public, anon, authenticated;` (re-opens the forgeable writer; preferred recovery is granting EXECUTE to the exact failing role).
- 135: disable the generic path (revoke execute on `api_request_provider_dispatch` from the API roles); the Xometry path is unaffected.
- 136: `revoke execute on function public.api_authorize_provider_worker_dispatch(uuid, uuid, jsonb, text, timestamptz) from service_role`, then drop both functions; the Xometry preflight is unaffected (note from #574: revoke the SECURITY DEFINER wrapper too).
- 137: re-apply the `20261002182910` definition of `api_request_xometry_beta_dispatch` with its revoke/grant; drop `private.lock_xometry_beta_dispatch_scope_rows(uuid)`.
- 138: re-run the two `create or replace` statements from `20260815093000` for prepare and finalize.
- 139: re-apply the `20261003160000` definitions of `api_request_provider_dispatch` and `private.resolve_provider_dispatch_scope`; drop `private.lock_provider_dispatch_scope_rows`.

## 7. State of the release PR #564 (integration branch -> main) at 0924c56

- Main is merged in (#597, merge commit 0924c56): 30 commits ahead of main, 0 behind, conflict-free merge into main. PR body rewritten to the current state; ready for review; 14/14 Actions jobs green (ci, test, browser-test, lint, typecheck, build, verify-worker, extraction-gate, ovd591 capability-sql and retention-sql, free-quote-sql, ovd420 egress, Disposable staged SQL proof, Vercel). SonarCloud quality gate RED on new-code ratings (reliability D, security D): 1,427 issues read through the API; 327 are cited to the merged PRs' dispositions, 1,100 are pre-existing recovered-source issues dispositioned by rule and file family, the four VULNERABILITY rows have written dispositions; marking them in the Sonar UI is your protected action. CodeRabbit SKIPPED the PR (418 files exceed its 100-file limit); every stacked PR had its own CodeRabbit review.
- #564 -> main remains protected: it is the release and applies these migrations to production. This packet is the input to that decision.
