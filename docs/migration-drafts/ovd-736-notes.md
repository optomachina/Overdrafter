# OVD-736 notes: anon EXECUTE on SECURITY DEFINER functions

Draft only. Nothing here is applied. Files:

- `docs/migration-drafts/ovd-736.sql`: the revoke (56 REVOKE statements, no DROP, no data change, no body or search_path change).
- `docs/migration-drafts/ovd-736.rollback.sql`: restores the exact prior grants (56 GRANT statements).
- `supabase/tests/ovd736_anon_definer_privileges.sql`: pgTAP suite (87 assertions). It installs byte copies of both drafts from `supabase/tests/fixtures/ovd736_anon_definer_privileges*.inc`; `scripts/run-supabase-policy-tests.node-test.mjs` enforces the byte equality.

## Verdict

No emergency. None of the 56 functions returns tenant data or performs a write for a caller without `auth.uid()`. One function returns data to anon, and it is schema metadata only (`api_get_client_intake_compatibility`: which `api_create_job` signatures and `jobs` columns exist).

## Prior state

Local stack (`supabase db reset --local` on main 5773decb, CLI 2.78.1) matches the 2026-10-12 production inventory exactly: the same 56 signatures, each with the ACL `{=X/postgres, postgres=X, anon=X, authenticated=X, service_role=X}`. Every other SECURITY DEFINER function in `public`, `private` and `engineering_private` (123 of them) already has no PUBLIC or anon grant.

## Phase A: gate per function for a caller without auth.uid()

Method: each function was called as `set local role anon; set local request.jwt.claims to '{}'` inside a rolled back transaction, against the `npm run seed:dev` data, with real seeded ids (org `...0001`, project `...0020`/`...0021`, job `...0101`/`...0103`, part `...0201`, quote run `...0600`, package `...0900`, membership `...0310`/`...0301`, and a freshly inserted pending invite token). "Definition" is the migration that holds the latest `CREATE OR REPLACE` of the function.

| Function | Definition | Gate for anon | Observed result as anon |
| --- | --- | --- | --- |
| `public.api_accept_project_invite(text)` | 20260304010000 | raises | `You must be signed in to perform this action.` |
| `public.api_admin_list_all_jobs()` | 20260325120000 | raises | `Platform admin access required.` |
| `public.api_admin_list_all_projects()` | 20260325120000 | raises | `Platform admin access required.` |
| `public.api_admin_list_all_users()` | 20260325120000 | raises | `Platform admin access required.` |
| `public.api_admin_list_organizations()` | 20260325120000 | raises | `Platform admin access required.` |
| `public.api_approve_job_requirements(uuid,jsonb)` | 20260316170500 | raises | `You must be signed in to perform this action.` |
| `public.api_archive_job(uuid)` | 20260330144838 | raises | `You must be signed in to perform this action.` |
| `public.api_archive_project(uuid)` | 20260308110000 | raises | `You must be signed in to perform this action.` |
| `public.api_assign_job_to_project(uuid,uuid)` | 20260308110000 | raises | `You must be signed in to perform this action.` |
| `public.api_cancel_quote_request(uuid)` | 20261002182714 | raises | `You must be signed in to perform this action.` |
| `public.api_create_project(text,text)` | 20260304010000 | raises | `You must be signed in to perform this action.` |
| `public.api_create_self_service_organization(text)` | 20260303133000 | raises | `You must be signed in to create an organization.` |
| `public.api_delete_project(uuid)` | 20260304010000 | raises | `You must be signed in to perform this action.` |
| `public.api_dissolve_project(uuid)` | 20260308110000 | raises | `You must be signed in to perform this action.` |
| `public.api_get_client_intake_compatibility()` | 20260314100000 | returns data: schema capability flags only, no tenant data | `{"missing": [], "supportsCurrentCreateJob": true, ...}` |
| `public.api_get_is_platform_admin()` | 20260325120000 | returns false | `f` |
| `public.api_get_quote_run_readiness(uuid)` | 20260307190000 | raises | `Only internal users can inspect quote run readiness.` |
| `public.api_invite_project_member(uuid,text,public.project_role)` | 20260304010000 | raises (require_verified_auth is the first statement; see note 1) | `gen_random_bytes(integer) does not exist` (with a shim: `You must be signed in to perform this action.`) |
| `public.api_list_client_activity_events(uuid[],integer)` | 20260313110000 | returns empty (filters on user_can_access_job) | `[]` |
| `public.api_list_client_part_metadata(uuid[])` | 20261011170000 | returns empty (filters on user_can_access_job) | `[]` |
| `public.api_list_client_quote_workspace(uuid[])` | 20260816015500 | returns empty (filters on user_can_access_job) | `[]` |
| `public.api_list_organization_memberships(uuid)` | 20260303123000 | raises | `You do not have admin access to organization 00000000-0000-4000-8000-000000000001` |
| `public.api_list_project_assignee_profiles(uuid)` | 20260323103000 | raises | `You do not have access to project 00000000-0000-4000-8000-000000000021.` |
| `public.api_publish_quote_package(uuid,uuid,text,boolean)` | 20260307190000 | raises | `You must be signed in to perform this action.` |
| `public.api_reconcile_job_parts(uuid)` | 20260308113000 | raises | `You do not have access to job seeded id 01` |
| `public.api_record_manual_vendor_quote(uuid,uuid,public.vendor_name,public.vendor_status,text,text,text,jsonb,jsonb)` | 20260307190000 | raises | `You must be signed in to perform this action.` |
| `public.api_remove_job_from_project(uuid,uuid)` | 20260307160000 | raises | `You must be signed in to perform this action.` |
| `public.api_remove_project_member(uuid)` | 20260304010000 | raises | `You must be signed in to perform this action.` |
| `public.api_request_debug_extraction(uuid,text)` | 20260317113000 | raises | `You must be signed in to perform this action.` |
| `public.api_request_extraction(uuid)` | 20260812042000 | raises | `You must be signed in to perform this action.` |
| `public.api_reset_client_part_property_overrides(uuid,text[])` | 20260408120000 | raises | `You must be signed in to perform this action.` |
| `public.api_start_quote_run(uuid,boolean)` | 20260307190000 | raises | `You must be signed in to perform this action.` |
| `public.api_unarchive_job(uuid)` | 20260330144838 | raises | `You must be signed in to perform this action.` |
| `public.api_unarchive_project(uuid)` | 20260309110000 | raises | `You must be signed in to perform this action.` |
| `public.api_update_client_part_request(uuid,text[],text,text,text,text,text,text,text,text,numeric,text,text,integer,integer[],date,jsonb,jsonb,jsonb,jsonb)` | 20260408120000 | raises | `You must be signed in to perform this action.` |
| `public.api_update_organization_membership_role(uuid,public.app_role)` | 20260303133000 | raises | `You must be signed in to perform this action.` |
| `public.api_update_project(uuid,text,text)` | 20260308110000 | raises | `You must be signed in to perform this action.` |
| `public.current_user_has_verified_auth()` | 20260303133000 | returns false | `f` |
| `public.current_user_home_organization_id()` | 20260304010000 | returns null | null |
| `public.is_internal_user(uuid)` | 20260303101500 | returns false | `f` |
| `public.is_internal_user_any_org()` | 20260405100000 | returns false | `f` |
| `public.is_org_admin(uuid)` | 20260303123000 | returns false | `f` |
| `public.is_platform_admin()` | 20260325120000 | returns false | `f` |
| `public.load_editable_project_part_context(uuid)` | 20260402120000 | raises | `You must be signed in to perform this action.` |
| `public.require_verified_auth()` | 20260303133000 | raises | `You must be signed in to perform this action.` |
| `public.sync_quote_request_status_from_vendor_result()` | 20260315110000 | trigger only (cannot be called directly) | `trigger functions can only be called as triggers` |
| `public.sync_service_request_line_item_status_from_quote_request()` | 20260331010000 | trigger only (cannot be called directly) | `trigger functions can only be called as triggers` |
| `public.user_can_access_job(uuid)` | 20260304010000 | returns false | `f` |
| `public.user_can_access_job_via_project(uuid)` | 20260307160000 | returns false | `f` |
| `public.user_can_access_org(uuid)` | 20260303101500 | returns false | `f` |
| `public.user_can_access_package(uuid)` | 20260304010000 | returns false | `f` |
| `public.user_can_access_project(uuid)` | 20260304010000 | returns false | `f` |
| `public.user_can_destructively_edit_job(uuid)` | 20260330144838 | returns false | `f` |
| `public.user_can_edit_job(uuid)` | 20260307160000 | returns false | `f` |
| `public.user_can_edit_project(uuid)` | 20260304010000 | returns false | `f` |
| `public.user_is_project_owner(uuid)` | 20260304010000 | returns false | `f` |

Note 1: `api_invite_project_member` declares `v_token text := encode(gen_random_bytes(24), 'hex')`, and its pinned `search_path` is `public, auth`, while `pgcrypto` lives in `extensions`. On the local stack the function therefore fails for every caller, signed in or not, before its body runs. With a temporary `public.gen_random_bytes` shim the anon call raises `You must be signed in to perform this action.` from `require_verified_auth()`, its first statement. Whether production has the same failure depends on where `gen_random_bytes` resolves there; it is a separate bug (residual R3).

## Logged out app calls

The logged out app talks only to GoTrue (`supabase.auth.*`). No `.rpc()`, PostgREST table read or write, storage call or Realtime channel runs while `user` is null:

- Routes mounted for everyone: `useAppSession` and `fetchAppSessionData` (`src/features/quotes/api/session-api.ts`) return early for `anonymous`, `invalid_session` and no user before they read `organization_memberships` or call `api_get_is_platform_admin`.
- `/` (landing): every workspace query is `enabled` only with a signed in user; the intake compatibility probe (`api_get_client_intake_compatibility`) needs a user, a membership and verified auth (`use-client-home-controller.ts`).
- `/shared/:inviteToken`: `api_accept_project_invite` runs only after `user` and `isVerifiedAuth` (`src/pages/SharedInvite.tsx`).
- `/client/packages/:id`, `/engineering`, all workspace routes: queries are gated on `user`.
- `/signin`, `/auth/callback`, `/legal/*`, NotFound: auth only or no Supabase call.
- `/dev-login`: invokes the `dev-login` edge function, DEV build only, loopback only.
- Edge functions reachable without a session (`stripe-webhook`, `stripe-events`, `engineering-worker*`, `engineering-interpretation`) authenticate by signature or shared secret and use the service role; the user scoped ones return 401 without a user. None calls the 56 functions as anon.
- `src/`, `worker/src/` and `supabase/functions/` never call any of the 19 internal helpers directly.

So the logged out app needs none of the 56 functions, and the draft revokes PUBLIC and anon on all of them.

## RLS interactions

- 103 policies call one of the 56 functions. All 103 are `TO authenticated`. No policy anywhere in the database has `anon` or `public` in its roles (local catalog: 131 policies for authenticated, 1 for service_role).
- No view, column default, check constraint or SECURITY INVOKER function references any of the 56 functions, so no anon or authenticated query reaches them except through those policies or through other SECURITY DEFINER functions (which run as `postgres`, the owner).
- Consequence: revoking anon does not change any anon table read. The suite captures anon `select` on all 51 helper guarded tables before and after the draft: 45 return 0 rows and 6 raise 42501 (no table grant), identically.
- Helpers kept for authenticated because a policy calls them directly: `is_internal_user`, `is_internal_user_any_org`, `is_org_admin`, `is_platform_admin`, `user_can_access_job`, `user_can_access_org`, `user_can_access_package`, `user_can_access_project`, `user_can_edit_job`, `user_can_edit_project`, `user_is_project_owner`.
- Internal only, revoked from authenticated too (no policy, view, invoker function or client calls them directly): `current_user_has_verified_auth`, `current_user_home_organization_id`, `load_editable_project_part_context`, `require_verified_auth`, `user_can_access_job_via_project`, `user_can_destructively_edit_job`, and the two trigger functions.
- Trigger functions: PostgreSQL checks EXECUTE on a trigger function only at CREATE TRIGGER time. The suite proves it twice: a synthetic trigger fires for an anon writer that lacks EXECUTE, and with EXECUTE also revoked from service_role, a service_role update of `vendor_quote_results` still fires `sync_quote_request_status_from_vendor_result` (the linked request moves to `received`) and a `quote_requests` update still succeeds.

## Allowlist after the draft

PUBLIC and anon: no SECURITY DEFINER function in any application schema (every schema except PostgreSQL, Supabase platform and extension schemas). authenticated: exactly these 107, pinned in the suite with the same reasons. Any new SECURITY DEFINER function created with default grants (Supabase grants anon and authenticated EXECUTE by default) fails the suite until it is revoked or added here with a reason.

| Function | Reason authenticated keeps EXECUTE |
| --- | --- |
| `engineering_private.cancel_engineering_suffix(uuid,bigint,uuid,uuid[],text)` | engineering helper: called by the SECURITY INVOKER wrapper public.api_cancel_engineering_suffix that signed in operators use |
| `engineering_private.control_worker_session(uuid,bigint,uuid,text,uuid)` | engineering helper: called by the SECURITY INVOKER wrapper public.api_control_worker_session that signed in operators use |
| `engineering_private.create_worker_pairing(uuid,uuid,uuid,bigint,uuid,text)` | engineering helper: called by the SECURITY INVOKER wrapper public.api_create_worker_pairing that signed in operators use |
| `engineering_private.engineering_access(uuid,uuid)` | RLS helper: called by authenticated policies on public.engineering_change_queues, public.engineering_conversations, public.engineering_decisions and 12 more |
| `engineering_private.owner_record_native_stop(uuid,uuid,uuid,uuid,uuid,bigint,uuid)` | engineering helper: called by the SECURITY INVOKER wrapper public.api_reconcile_native_stop that signed in operators use |
| `engineering_private.owner_request_native_retry(uuid,uuid,uuid,uuid,bigint,uuid,text)` | engineering helper: called by the SECURITY INVOKER wrapper public.api_retry_native_task that signed in operators use |
| `engineering_private.submit_engineering_message(uuid,uuid,uuid,uuid,bigint,uuid,text)` | engineering helper: called by the SECURITY INVOKER wrapper public.api_submit_engineering_message that signed in operators use |
| `public.api_accept_founding_beta_notice(uuid,text)` | signed in RPC: called from src/features/quotes/api/founding-beta-api.ts |
| `public.api_accept_project_invite(text)` | signed in RPC: called from src/features/quotes/api/projects-api.ts |
| `public.api_admin_complete_manual_quote_request(uuid,uuid,uuid,uuid,public.vendor_name,text,text,public.vendor_status,text,text,text,jsonb,jsonb)` | signed in RPC: called from src/features/quotes/api/manual-quote-admin-api.ts |
| `public.api_admin_get_commercial_account(uuid)` | signed in RPC: called from src/features/quotes/api/commercial-account-admin-api.ts |
| `public.api_admin_get_founding_beta_enrollment(uuid)` | signed in RPC: called from src/features/quotes/api/founding-beta-admin-api.ts |
| `public.api_admin_get_organization_entitlement_state(uuid)` | signed in RPC: pre existing grant, no direct caller in src, worker or edge functions (residual in ovd-736-notes.md) |
| `public.api_admin_grant_organization_entitlement(uuid,text,timestamp with time zone,timestamp with time zone,timestamp with time zone,text,text)` | signed in RPC: called from src/features/quotes/api/commercial-account-admin-api.ts |
| `public.api_admin_invalidate_vendor_quote_offer(uuid,text,text)` | signed in RPC: called from src/features/quotes/api/manual-quote-admin-api.ts |
| `public.api_admin_list_all_jobs()` | signed in RPC: called from src/features/quotes/api/platform-admin-api.ts |
| `public.api_admin_list_all_projects()` | signed in RPC: called from src/features/quotes/api/platform-admin-api.ts |
| `public.api_admin_list_all_users()` | signed in RPC: called from src/features/quotes/api/platform-admin-api.ts |
| `public.api_admin_list_commercial_account_audit(uuid,text,integer)` | signed in RPC: called from src/features/quotes/api/commercial-account-admin-api.ts |
| `public.api_admin_list_manual_quote_requests(text,integer)` | signed in RPC: called from src/features/quotes/api/manual-quote-admin-api.ts |
| `public.api_admin_list_organizations()` | signed in RPC: called from src/features/quotes/api/platform-admin-api.ts |
| `public.api_admin_list_platform_notifications(integer)` | signed in RPC: called from src/features/quotes/api/platform-admin-api.ts |
| `public.api_admin_revoke_organization_entitlement(uuid,text,text)` | signed in RPC: called from src/features/quotes/api/commercial-account-admin-api.ts |
| `public.api_admin_search_commercial_accounts(text,text,integer)` | signed in RPC: called from src/features/quotes/api/commercial-account-admin-api.ts |
| `public.api_admin_set_founding_beta_enrollment(uuid,boolean,text,text)` | signed in RPC: called from src/features/quotes/api/founding-beta-admin-api.ts |
| `public.api_approve_job_requirements(uuid,jsonb)` | signed in RPC: called from src/features/quotes/api/extraction-api.ts |
| `public.api_archive_job(uuid)` | signed in RPC: called from src/features/quotes/api/archive-api.ts |
| `public.api_archive_project(uuid)` | signed in RPC: called from src/features/quotes/api/projects-api.ts |
| `public.api_assign_job_to_project(uuid,uuid)` | signed in RPC: called from src/features/quotes/api/projects-api.ts |
| `public.api_attach_job_file(uuid,text,text,text,public.job_file_kind,text,bigint)` | signed in RPC: pre existing grant, no direct caller in src, worker or edge functions (residual in ovd-736-notes.md) |
| `public.api_cancel_quote_request(uuid)` | signed in RPC: called from src/features/quotes/api/quote-requests-api.ts |
| `public.api_confirm_part_deadline(uuid,text,date)` | signed in RPC: pre existing grant, no direct caller in src, worker or edge functions (residual in ovd-736-notes.md) |
| `public.api_confirm_sourcing_destination(uuid,jsonb)` | signed in RPC: called from src/features/quotes/api/organizations-api.ts |
| `public.api_create_client_draft(text,text,uuid,text[],text[],text,text,integer[],date)` | signed in RPC: called from src/features/quotes/api/jobs-api.ts |
| `public.api_create_job(uuid,text,text,text,text[],text[],text,text,integer[],date)` | signed in RPC: called from src/features/quotes/api/jobs-api.ts |
| `public.api_create_project(text,text)` | signed in RPC: called from src/features/quotes/api/projects-api.ts |
| `public.api_create_self_service_organization(text)` | signed in RPC: called from src/features/quotes/api/organizations-api.ts |
| `public.api_delete_archived_job(uuid)` | signed in RPC: called from src/features/quotes/api/archive-api.ts |
| `public.api_delete_archived_jobs(uuid[])` | signed in RPC: called from src/features/quotes/api/archive-api.ts |
| `public.api_delete_project(uuid)` | signed in RPC: called from src/features/quotes/api/projects-api.ts |
| `public.api_dissolve_project(uuid)` | signed in RPC: called from src/features/quotes/api/projects-api.ts |
| `public.api_enqueue_debug_vendor_quote(uuid,uuid,public.vendor_name,integer)` | signed in RPC: called from src/features/quotes/api/quote-requests-api.ts |
| `public.api_finalize_job_file_upload(uuid,text,text,text,public.job_file_kind,text,bigint,text)` | signed in RPC: called from src/features/quotes/api/uploads-api.ts |
| `public.api_get_client_intake_compatibility()` | signed in RPC: called from src/features/quotes/api/compatibility-api.ts |
| `public.api_get_founding_beta_access_state(uuid)` | signed in RPC: called from src/features/quotes/api/founding-beta-api.ts |
| `public.api_get_is_platform_admin()` | signed in RPC: called from src/features/quotes/api/session-api.ts |
| `public.api_get_job_vendor_preferences(uuid)` | signed in RPC: called from src/features/quotes/api/vendor-preferences-api.ts |
| `public.api_get_organization_entitlements(uuid)` | signed in RPC: called from src/features/quotes/organization-entitlements.ts |
| `public.api_get_part_deadline(uuid)` | signed in RPC: called from src/features/quotes/api/part-deadline-api.ts |
| `public.api_get_provider_dispatch_scope(uuid,public.vendor_name,text)` | signed in RPC: called from src/features/quotes/api/quote-requests-api.ts |
| `public.api_get_quote_access(uuid)` | signed in RPC: called from src/features/quotes/quote-access.ts |
| `public.api_get_quote_lane_eligibility(uuid,public.vendor_name[])` | signed in RPC: called from src/features/quotes/api/quote-requests-api.ts |
| `public.api_get_quote_run_readiness(uuid)` | signed in RPC: called from src/features/quotes/api/quote-requests-api.ts |
| `public.api_get_sourcing_destination(uuid)` | signed in RPC: called from src/features/quotes/api/organizations-api.ts |
| `public.api_get_xometry_beta_dispatch_scope(uuid,text)` | signed in RPC: called from src/features/quotes/api/quote-requests-api.ts |
| `public.api_invite_project_member(uuid,text,public.project_role)` | signed in RPC: called from src/features/quotes/api/projects-api.ts |
| `public.api_list_client_activity_events(uuid[],integer)` | signed in RPC: called from src/features/quotes/api/workspace-api.ts |
| `public.api_list_client_part_metadata(uuid[])` | signed in RPC: called from src/features/quotes/api/jobs-api.ts |
| `public.api_list_client_quote_workspace(uuid[])` | signed in RPC: called from src/features/quotes/api/jobs-api.ts |
| `public.api_list_organization_memberships(uuid)` | signed in RPC: called from src/features/quotes/api/organizations-api.ts |
| `public.api_list_project_assignee_profiles(uuid)` | signed in RPC: called from src/features/quotes/api/projects-api.ts |
| `public.api_prepare_job_file_upload(uuid,text,public.job_file_kind,text,bigint,text)` | signed in RPC: called from src/features/quotes/api/uploads-api.ts |
| `public.api_prepare_organization_billing_session(uuid)` | signed in RPC: called from supabase/functions/billing-sessions/index.ts |
| `public.api_prepare_part_intake(text,text)` | signed in RPC: called from src/features/quotes/api/uploads-api.ts |
| `public.api_publish_quote_package(uuid,uuid,text,boolean)` | signed in RPC: called from src/features/quotes/api/packages-api.ts |
| `public.api_reconcile_job_parts(uuid)` | signed in RPC: called from src/features/quotes/api/extraction-api.ts |
| `public.api_record_manual_vendor_quote(uuid,uuid,public.vendor_name,public.vendor_status,text,text,text,jsonb,jsonb)` | signed in RPC: called from src/features/quotes/api/packages-api.ts |
| `public.api_remove_job_from_project(uuid,uuid)` | signed in RPC: called from src/features/quotes/api/projects-api.ts |
| `public.api_remove_project_member(uuid)` | signed in RPC: called from src/features/quotes/api/projects-api.ts |
| `public.api_request_debug_extraction(uuid,text)` | signed in RPC: called from src/features/quotes/api/extraction-api.ts |
| `public.api_request_extraction(uuid)` | signed in RPC: called from src/features/quotes/api/extraction-api.ts |
| `public.api_request_manual_quote(uuid,boolean)` | signed in RPC: called from src/features/quotes/api/quote-requests-api.ts |
| `public.api_request_manual_quotes(uuid[],boolean)` | signed in RPC: called from src/features/quotes/api/quote-requests-api.ts |
| `public.api_request_provider_dispatch(uuid,public.vendor_name,text,text,text,text,uuid,boolean,boolean,boolean)` | signed in RPC: called from src/features/quotes/api/quote-requests-api.ts |
| `public.api_request_quote(uuid,boolean)` | signed in RPC: pre existing grant, no direct caller in src, worker or edge functions (residual in ovd-736-notes.md) |
| `public.api_request_quote_scoped(uuid,public.vendor_name[])` | signed in RPC: called from src/features/quotes/api/quote-requests-api.ts |
| `public.api_request_quotes(uuid[],boolean)` | signed in RPC: called from src/features/quotes/api/quote-requests-api.ts |
| `public.api_request_xometry_beta_dispatch(uuid,text,text,text,uuid,boolean,boolean,boolean)` | signed in RPC: called from src/features/quotes/api/quote-requests-api.ts |
| `public.api_reset_client_part_property_overrides(uuid,text[])` | signed in RPC: called from src/features/quotes/api/jobs-api.ts |
| `public.api_select_quote_option(uuid,uuid,text)` | signed in RPC: called from src/features/quotes/api/packages-api.ts |
| `public.api_set_global_spend_cap(numeric,numeric,boolean)` | signed in RPC: called from src/features/quotes/api/platform-admin-api.ts |
| `public.api_set_job_selected_vendor_quote_offer(uuid,uuid)` | signed in RPC: called from src/features/quotes/api/quote-requests-api.ts |
| `public.api_set_job_vendor_preferences(uuid,public.vendor_name[],public.vendor_name[])` | signed in RPC: called from src/features/quotes/api/vendor-preferences-api.ts |
| `public.api_set_project_vendor_preferences(uuid,public.vendor_name[],public.vendor_name[])` | signed in RPC: called from src/features/quotes/api/vendor-preferences-api.ts |
| `public.api_spend_summary()` | signed in RPC: called from src/features/quotes/api/platform-admin-api.ts |
| `public.api_start_quote_run(uuid,boolean)` | signed in RPC: called from src/features/quotes/api/quote-requests-api.ts |
| `public.api_unarchive_job(uuid)` | signed in RPC: called from src/features/quotes/api/archive-api.ts |
| `public.api_unarchive_project(uuid)` | signed in RPC: called from src/features/quotes/api/projects-api.ts |
| `public.api_update_client_part_request(uuid,text[],text,text,text,text,text,text,text,text,numeric,text,text,integer,integer[],date,jsonb,jsonb,jsonb,jsonb)` | signed in RPC: called from src/features/quotes/api/jobs-api.ts |
| `public.api_update_organization_addresses(uuid,jsonb)` | signed in RPC: called from src/features/quotes/api/organizations-api.ts |
| `public.api_update_organization_membership_role(uuid,public.app_role)` | signed in RPC: called from src/features/quotes/api/organizations-api.ts |
| `public.api_update_project(uuid,text,text)` | signed in RPC: called from src/features/quotes/api/projects-api.ts |
| `public.current_user_can_access_manual_quote_artifact(uuid,text,text,boolean,boolean)` | RLS helper: called by authenticated policies on public.vendor_quote_artifacts, storage.objects |
| `public.current_user_can_delete_unregistered_manual_quote_upload(text,text,text,timestamp with time zone)` | RLS helper: called by authenticated policies on storage.objects |
| `public.current_user_has_commercial_capability(text)` | RLS helper: called by authenticated policies on public.commercial_admin_audit_events |
| `public.current_user_has_current_founding_beta_access(uuid)` | RLS helper: called by authenticated policies on public.jobs, storage.objects |
| `public.is_internal_user(uuid)` | RLS helper: called by authenticated policies on public.approved_part_requirements, public.audit_events, public.debug_extraction_runs and 21 more |
| `public.is_internal_user_any_org()` | RLS helper: called by authenticated policies on public.supplier_capabilities, public.supplier_certifications, public.supplier_companies and 8 more |
| `public.is_org_admin(uuid)` | RLS helper: called by authenticated policies on public.organization_memberships, public.organizations |
| `public.is_platform_admin()` | RLS helper: called by authenticated policies on public.approved_part_requirements, public.client_selections, public.debug_extraction_runs and 19 more |
| `public.user_can_access_job(uuid)` | RLS helper: called by authenticated policies on public.cad_preview_assets, public.canonical_parts, public.drawing_preview_assets and 9 more |
| `public.user_can_access_org(uuid)` | RLS helper: called by authenticated policies on public.jobs, public.organizations |
| `public.user_can_access_package(uuid)` | RLS helper: called by authenticated policies on public.client_selections, public.published_quote_options, public.published_quote_packages |
| `public.user_can_access_project(uuid)` | RLS helper: called by authenticated policies on public.project_jobs, public.project_memberships, public.project_vendor_preferences and 3 more |
| `public.user_can_edit_job(uuid)` | RLS helper: called by authenticated policies on storage.objects |
| `public.user_can_edit_project(uuid)` | RLS helper: called by authenticated policies on public.project_jobs |
| `public.user_is_project_owner(uuid)` | RLS helper: called by authenticated policies on public.project_invites |

## Verification

- `supabase test db --local` on the suite: 87 of 87 pass with the draft installed from the fixture.
- Mutation 1 (scratch copy, deleted after): removing `revoke execute on function public.api_archive_job(uuid) from public, anon;` from the fixture fails tests 1 (no PUBLIC or anon definer), 12 (anon denied on `api_archive_job`) and 86 (reapply after rollback).
- Mutation 2 (scratch copy, deleted after): appending `create function public.ovd736_mutant_definer() ... security definer` with default grants fails tests 1 and 2 (allowlist).
- Whole repository suite with the draft applied for real to a fresh local stack (`supabase db reset --local`, then the draft with `psql --single-transaction`, then all 72 staged pgTAP files): 71 pass; the only failure is `client_rpc_least_privilege.sql`, which stops at its anon characterization step with `permission denied for function api_list_client_part_metadata` (residual R4). The same 72 files pass on the same fresh stack without the draft.
- Byte equality: changing one byte of a fixture fails `scripts/run-supabase-policy-tests.node-test.mjs`.
- Rollback round trip in the suite: after the rollback all 56 ACLs equal the prior ACL exactly and anon can execute all 56; reapplying the draft removes PUBLIC and anon again and restores the authenticated allowlist.

## Residuals

- R1 search_path: left unchanged on all 56 functions. Each already pins a path (`public`; `public, auth`; or `public, auth, private`). anon and authenticated have no CREATE on `public`, and no caller can create a temp object through PostgREST, so appending `pg_temp` would buy little for this urgent change. Candidates for a later one line `ALTER FUNCTION ... SET search_path` hardening: all 56.
- R2 `api_get_is_platform_admin` race: in the rare `session_error` path, `fetchAppSessionData` can call it with a stored session whose refresh fails, so it may reach PostgREST as anon. Before the draft anon got `false`; after it gets 42501, which `isNonRetriablePlatformAdminRpcError` treats as "unavailable" for the rest of the browser session, so a platform admin in that race sees non admin mode until a reload. Data exposure is nil either way. A small client fix (do not cache 42501 as unavailable) is a follow up.
- R3 `api_invite_project_member` cannot resolve `gen_random_bytes` with its pinned `search_path` on a fresh local stack (note 1). Separate bug; check production before relying on invites.
- R4 Existing characterization test `supabase/tests/client_rpc_least_privilege.sql` pins anon outcomes from function bodies and calls `load_editable_project_part_context` directly as authenticated. It runs against the real schema, so it is unaffected while this is a draft, but its expectations must change from the body errors to 42501 in the same PR that promotes the draft into `supabase/migrations/`.
- R5 Four signed in RPCs keep pre existing authenticated grants with no direct caller in `src`, `worker` or edge functions: `api_admin_get_organization_entitlement_state`, `api_attach_job_file`, `api_confirm_part_deadline`, `api_request_quote`. Out of scope here; listed in the allowlist so any change is deliberate.
- R6 The allowlist pins 107 functions. Every future migration that adds or regrants a SECURITY DEFINER function to authenticated must add a row here. That is the intended guard, at the cost of one line per new function.

## Rollback

Apply `docs/migration-drafts/ovd-736.rollback.sql` as a forward migration in a window (`psql --single-transaction -v ON_ERROR_STOP=1 -f ...` if by hand). It grants EXECUTE back to PUBLIC and anon on all 56 and back to authenticated on the 8 internal helpers, restoring the exact prior ACL. It reopens the exposure, so use it only if a signed in flow breaks and cannot be fixed forward.
