# Production database apply packet (v1, 2026-10-06 16:1xZ; all six migrations merged) — release integration branch `codex/recovered-release-free-safety-20261003`

Prepared 2026-10-06 ~15:50Z by the cloud coordinator. Nothing in this packet has been applied anywhere except local and CI databases. Applying it to the hosted/production database is a PROTECTED step that needs Blaine's explicit go at action time.

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

Also confirm, read-only: the production migration table ends at the 133rd contract migration (`20261003011148_reconcile_free_quote_job_reservations.sql`) and contains none of 134-139; and the deployed `job-archive-fallback` Edge Function's database role is one of the three roles above (its effective SQL identity cannot be read from metadata; the OVD-536 guard protects against the unknown case by aborting atomically).

## 4. Apply (PROTECTED; owner-executed or owner-authorized at action time)

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

## 7. Open decisions before the release itself (#564 -> main)

- The integration branch is 27 commits ahead of main and 10 behind (main gained the staged-proof units and the Jev client this weekend). `git merge-tree` reports ONE conflict: `scripts/ovd510-disposable-replay.mjs` (the #564 branch split the runner into a 24-line launcher plus `scripts/ovd510-replay-body.mjs`; main's OVD-520 proof units edit the old runner and pin its line numbers). Updating the integration branch from main is routine branch work, but the conflict touches the replay runner that every OVD-520 proof cites, so it gets its own verification lane (xhigh) before the release PR can be green.
- #564 -> main remains protected: it is the release and applies these migrations to production. This packet is the input to that decision.
