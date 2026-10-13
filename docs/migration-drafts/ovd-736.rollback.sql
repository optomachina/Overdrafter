-- OVD-736 ROLLBACK for docs/migration-drafts/ovd-736.sql.
--
-- NOT APPLIED. Run only inside a migration window, as a forward migration, if
-- the revoke must be withdrawn. It restores the exact prior ACL of all 56
-- functions: {=X/postgres, postgres=X, anon=X, authenticated=X, service_role=X},
-- and the prior search_path of api_invite_project_member (OVD-759).
-- supabase/tests/fixtures/ovd736_anon_definer_privileges_rollback.inc is a byte
-- copy of this file, enforced by scripts/run-supabase-policy-tests.node-test.mjs.
--
-- Transaction: no begin/commit of its own; the migration runner wraps it. If run
-- by hand, use `psql --single-transaction -v ON_ERROR_STOP=1 -f ovd-736.rollback.sql`.
-- GRANT statements and one ALTER FUNCTION; no DROP, no data change. Rolling back reopens the
-- OVD-736 exposure (anon can call every function below again).

grant execute on function public.api_accept_project_invite(text) to public, anon;
grant execute on function public.api_admin_list_all_jobs() to public, anon;
grant execute on function public.api_admin_list_all_projects() to public, anon;
grant execute on function public.api_admin_list_all_users() to public, anon;
grant execute on function public.api_admin_list_organizations() to public, anon;
grant execute on function public.api_approve_job_requirements(uuid,jsonb) to public, anon;
grant execute on function public.api_archive_job(uuid) to public, anon;
grant execute on function public.api_archive_project(uuid) to public, anon;
grant execute on function public.api_assign_job_to_project(uuid,uuid) to public, anon;
grant execute on function public.api_cancel_quote_request(uuid) to public, anon;
grant execute on function public.api_create_project(text,text) to public, anon;
grant execute on function public.api_create_self_service_organization(text) to public, anon;
grant execute on function public.api_delete_project(uuid) to public, anon;
grant execute on function public.api_dissolve_project(uuid) to public, anon;
grant execute on function public.api_get_client_intake_compatibility() to public, anon;
grant execute on function public.api_get_is_platform_admin() to public, anon;
grant execute on function public.api_get_quote_run_readiness(uuid) to public, anon;
grant execute on function public.api_invite_project_member(uuid,text,public.project_role) to public, anon;
grant execute on function public.api_list_client_activity_events(uuid[],integer) to public, anon;
grant execute on function public.api_list_client_part_metadata(uuid[]) to public, anon;
grant execute on function public.api_list_client_quote_workspace(uuid[]) to public, anon;
grant execute on function public.api_list_organization_memberships(uuid) to public, anon;
grant execute on function public.api_list_project_assignee_profiles(uuid) to public, anon;
grant execute on function public.api_publish_quote_package(uuid,uuid,text,boolean) to public, anon;
grant execute on function public.api_reconcile_job_parts(uuid) to public, anon;
grant execute on function public.api_record_manual_vendor_quote(uuid,uuid,public.vendor_name,public.vendor_status,text,text,text,jsonb,jsonb) to public, anon;
grant execute on function public.api_remove_job_from_project(uuid,uuid) to public, anon;
grant execute on function public.api_remove_project_member(uuid) to public, anon;
grant execute on function public.api_request_debug_extraction(uuid,text) to public, anon;
grant execute on function public.api_request_extraction(uuid) to public, anon;
grant execute on function public.api_reset_client_part_property_overrides(uuid,text[]) to public, anon;
grant execute on function public.api_start_quote_run(uuid,boolean) to public, anon;
grant execute on function public.api_unarchive_job(uuid) to public, anon;
grant execute on function public.api_unarchive_project(uuid) to public, anon;
grant execute on function public.api_update_client_part_request(uuid,text[],text,text,text,text,text,text,text,text,numeric,text,text,integer,integer[],date,jsonb,jsonb,jsonb,jsonb) to public, anon;
grant execute on function public.api_update_organization_membership_role(uuid,public.app_role) to public, anon;
grant execute on function public.api_update_project(uuid,text,text) to public, anon;

grant execute on function public.is_internal_user(uuid) to public, anon;
grant execute on function public.is_internal_user_any_org() to public, anon;
grant execute on function public.is_org_admin(uuid) to public, anon;
grant execute on function public.is_platform_admin() to public, anon;
grant execute on function public.user_can_access_job(uuid) to public, anon;
grant execute on function public.user_can_access_org(uuid) to public, anon;
grant execute on function public.user_can_access_package(uuid) to public, anon;
grant execute on function public.user_can_access_project(uuid) to public, anon;
grant execute on function public.user_can_edit_job(uuid) to public, anon;
grant execute on function public.user_can_edit_project(uuid) to public, anon;
grant execute on function public.user_is_project_owner(uuid) to public, anon;

grant execute on function public.current_user_has_verified_auth() to public, anon, authenticated;
grant execute on function public.current_user_home_organization_id() to public, anon, authenticated;
grant execute on function public.load_editable_project_part_context(uuid) to public, anon, authenticated;
grant execute on function public.require_verified_auth() to public, anon, authenticated;
grant execute on function public.sync_quote_request_status_from_vendor_result() to public, anon, authenticated;
grant execute on function public.sync_service_request_line_item_status_from_quote_request() to public, anon, authenticated;
grant execute on function public.user_can_access_job_via_project(uuid) to public, anon, authenticated;
grant execute on function public.user_can_destructively_edit_job(uuid) to public, anon, authenticated;

-- OVD-759: restore the prior search_path (reintroduces the invite failure).
alter function public.api_invite_project_member(uuid, text, public.project_role)
  set search_path = public, auth;
