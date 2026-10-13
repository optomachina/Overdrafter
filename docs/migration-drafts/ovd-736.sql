-- OVD-736: revoke anon and PUBLIC EXECUTE on SECURITY DEFINER functions.
--
-- PROPOSED migration draft. NOT APPLIED. This file is intentionally outside
-- supabase/migrations/ and is applied only in a migration window the lead runs.
-- When it is promoted, copy it byte for byte into
-- supabase/migrations/<npm run migration:next>_ovd736_revoke_anon_definer_execute.sql.
-- supabase/tests/fixtures/ovd736_anon_definer_privileges.inc is a byte copy of
-- this file, enforced by scripts/run-supabase-policy-tests.node-test.mjs.
-- Rollback: docs/migration-drafts/ovd-736.rollback.sql. Notes and evidence:
-- docs/migration-drafts/ovd-736-notes.md.
--
-- Transaction: this file has no begin/commit of its own. It relies on the
-- migration runner wrapping it in one transaction (the Supabase CLI does). If run
-- by hand, use `psql --single-transaction -v ON_ERROR_STOP=1 -f ovd-736.sql`.
-- Every statement is a REVOKE, so any failure leaves the prior grants in place.
--
-- Scope: expand only. No data change, no function body change, no DROP. One
-- search_path change (section 4, OVD-759). Before this file, each of the 56 functions below has the
-- ACL {=X/postgres, postgres=X, anon=X, authenticated=X, service_role=X}
-- (local stack and the 2026-10-12 production inventory agree).
--
-- After this file:
--   * PUBLIC and anon: no EXECUTE on any of the 56 functions. No logged out
--     app path calls them (see the notes file), and every one already refuses or
--     returns nothing for a caller without auth.uid(), so anon sees no change
--     beyond 42501 instead of an application error.
--   * authenticated: unchanged for the 37 client RPCs (api_*) and for the 11
--     internal helpers that an RLS policy for authenticated calls directly.
--     Revoked for the 8 internal helpers that no policy, view, invoker function
--     or client calls directly (they are reached only from other SECURITY
--     DEFINER functions, which run as the owner, or as triggers).
--   * service_role and postgres: unchanged.
--
-- Trigger functions: PostgreSQL checks EXECUTE on a trigger function only at
-- CREATE TRIGGER time, never when the trigger fires, so revoking it does not
-- stop the trigger for any writer. supabase/tests/ovd736_anon_definer_privileges.sql
-- proves this.

-- 1. Client RPCs (api_*): signed in only. Keep authenticated and service_role.
revoke execute on function public.api_accept_project_invite(text) from public, anon;
revoke execute on function public.api_admin_list_all_jobs() from public, anon;
revoke execute on function public.api_admin_list_all_projects() from public, anon;
revoke execute on function public.api_admin_list_all_users() from public, anon;
revoke execute on function public.api_admin_list_organizations() from public, anon;
revoke execute on function public.api_approve_job_requirements(uuid,jsonb) from public, anon;
revoke execute on function public.api_archive_job(uuid) from public, anon;
revoke execute on function public.api_archive_project(uuid) from public, anon;
revoke execute on function public.api_assign_job_to_project(uuid,uuid) from public, anon;
revoke execute on function public.api_cancel_quote_request(uuid) from public, anon;
revoke execute on function public.api_create_project(text,text) from public, anon;
revoke execute on function public.api_create_self_service_organization(text) from public, anon;
revoke execute on function public.api_delete_project(uuid) from public, anon;
revoke execute on function public.api_dissolve_project(uuid) from public, anon;
revoke execute on function public.api_get_client_intake_compatibility() from public, anon;
revoke execute on function public.api_get_is_platform_admin() from public, anon;
revoke execute on function public.api_get_quote_run_readiness(uuid) from public, anon;
revoke execute on function public.api_invite_project_member(uuid,text,public.project_role) from public, anon;
revoke execute on function public.api_list_client_activity_events(uuid[],integer) from public, anon;
revoke execute on function public.api_list_client_part_metadata(uuid[]) from public, anon;
revoke execute on function public.api_list_client_quote_workspace(uuid[]) from public, anon;
revoke execute on function public.api_list_organization_memberships(uuid) from public, anon;
revoke execute on function public.api_list_project_assignee_profiles(uuid) from public, anon;
revoke execute on function public.api_publish_quote_package(uuid,uuid,text,boolean) from public, anon;
revoke execute on function public.api_reconcile_job_parts(uuid) from public, anon;
revoke execute on function public.api_record_manual_vendor_quote(uuid,uuid,public.vendor_name,public.vendor_status,text,text,text,jsonb,jsonb) from public, anon;
revoke execute on function public.api_remove_job_from_project(uuid,uuid) from public, anon;
revoke execute on function public.api_remove_project_member(uuid) from public, anon;
revoke execute on function public.api_request_debug_extraction(uuid,text) from public, anon;
revoke execute on function public.api_request_extraction(uuid) from public, anon;
revoke execute on function public.api_reset_client_part_property_overrides(uuid,text[]) from public, anon;
revoke execute on function public.api_start_quote_run(uuid,boolean) from public, anon;
revoke execute on function public.api_unarchive_job(uuid) from public, anon;
revoke execute on function public.api_unarchive_project(uuid) from public, anon;
revoke execute on function public.api_update_client_part_request(uuid,text[],text,text,text,text,text,text,text,text,numeric,text,text,integer,integer[],date,jsonb,jsonb,jsonb,jsonb) from public, anon;
revoke execute on function public.api_update_organization_membership_role(uuid,public.app_role) from public, anon;
revoke execute on function public.api_update_project(uuid,text,text) from public, anon;

-- 2. Internal helpers called directly by RLS policies for authenticated. Keep
-- authenticated (the policies evaluate them as the querying role) and service_role.
revoke execute on function public.is_internal_user(uuid) from public, anon;
revoke execute on function public.is_internal_user_any_org() from public, anon;
revoke execute on function public.is_org_admin(uuid) from public, anon;
revoke execute on function public.is_platform_admin() from public, anon;
revoke execute on function public.user_can_access_job(uuid) from public, anon;
revoke execute on function public.user_can_access_org(uuid) from public, anon;
revoke execute on function public.user_can_access_package(uuid) from public, anon;
revoke execute on function public.user_can_access_project(uuid) from public, anon;
revoke execute on function public.user_can_edit_job(uuid) from public, anon;
revoke execute on function public.user_can_edit_project(uuid) from public, anon;
revoke execute on function public.user_is_project_owner(uuid) from public, anon;

-- 3. Internal only helpers and trigger functions. No policy, view, invoker
-- function or client calls them directly. Keep service_role.
revoke execute on function public.current_user_has_verified_auth() from public, anon, authenticated;
revoke execute on function public.current_user_home_organization_id() from public, anon, authenticated;
revoke execute on function public.load_editable_project_part_context(uuid) from public, anon, authenticated;
revoke execute on function public.require_verified_auth() from public, anon, authenticated;
revoke execute on function public.sync_quote_request_status_from_vendor_result() from public, anon, authenticated;
revoke execute on function public.sync_service_request_line_item_status_from_quote_request() from public, anon, authenticated;
revoke execute on function public.user_can_access_job_via_project(uuid) from public, anon, authenticated;
revoke execute on function public.user_can_destructively_edit_job(uuid) from public, anon, authenticated;

-- 4. OVD-759: api_invite_project_member declares gen_random_bytes(24), which
-- pgcrypto installs in the extensions schema, but its pinned search_path is
-- public, auth, so every invite fails before the body runs (confirmed read only
-- in production by the lead). One line, no body change.
alter function public.api_invite_project_member(uuid, text, public.project_role)
  set search_path = public, auth, extensions;
