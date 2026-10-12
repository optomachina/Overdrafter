-- OVD-736 DRAFT (not in supabase/migrations): revoke anon/PUBLIC EXECUTE on public functions.
-- Pattern: OVD-685 (#657). Lands only in a migration window Blaine approves.
-- Source: prod pg_proc ACL snapshot 2026-10-11 (73 anon-executable functions, 56 SECURITY DEFINER).
-- Reviewed anon allowlist: EMPTY (logged-out app makes no RPC calls; no RLS policy targets anon/public).
-- authenticated grants are unchanged (explicit grants already present on all 73).
-- Rollback: docs/migration-drafts/ovd-736-revoke-anon-execute.rollback.sql

begin;

revoke all on function public.api_accept_project_invite(text) from public, anon;
grant execute on function public.api_accept_project_invite(text) to authenticated;
revoke all on function public.api_admin_list_all_jobs() from public, anon;
grant execute on function public.api_admin_list_all_jobs() to authenticated;
revoke all on function public.api_admin_list_all_projects() from public, anon;
grant execute on function public.api_admin_list_all_projects() to authenticated;
revoke all on function public.api_admin_list_all_users() from public, anon;
grant execute on function public.api_admin_list_all_users() to authenticated;
revoke all on function public.api_admin_list_organizations() from public, anon;
grant execute on function public.api_admin_list_organizations() to authenticated;
revoke all on function public.api_approve_job_requirements(uuid, jsonb) from public, anon;
grant execute on function public.api_approve_job_requirements(uuid, jsonb) to authenticated;
revoke all on function public.api_archive_job(uuid) from public, anon;
grant execute on function public.api_archive_job(uuid) to authenticated;
revoke all on function public.api_archive_project(uuid) from public, anon;
grant execute on function public.api_archive_project(uuid) to authenticated;
revoke all on function public.api_assign_job_to_project(uuid, uuid) from public, anon;
grant execute on function public.api_assign_job_to_project(uuid, uuid) to authenticated;
revoke all on function public.api_cancel_quote_request(uuid) from public, anon;
grant execute on function public.api_cancel_quote_request(uuid) to authenticated;
revoke all on function public.api_create_project(text, text) from public, anon;
grant execute on function public.api_create_project(text, text) to authenticated;
revoke all on function public.api_create_self_service_organization(text) from public, anon;
grant execute on function public.api_create_self_service_organization(text) to authenticated;
revoke all on function public.api_delete_project(uuid) from public, anon;
grant execute on function public.api_delete_project(uuid) to authenticated;
revoke all on function public.api_dissolve_project(uuid) from public, anon;
grant execute on function public.api_dissolve_project(uuid) to authenticated;
revoke all on function public.api_get_client_intake_compatibility() from public, anon;
grant execute on function public.api_get_client_intake_compatibility() to authenticated;
revoke all on function public.api_get_is_platform_admin() from public, anon;
grant execute on function public.api_get_is_platform_admin() to authenticated;
revoke all on function public.api_get_quote_run_readiness(uuid) from public, anon;
grant execute on function public.api_get_quote_run_readiness(uuid) to authenticated;
revoke all on function public.api_invite_project_member(uuid, text, project_role) from public, anon;
grant execute on function public.api_invite_project_member(uuid, text, project_role) to authenticated;
revoke all on function public.api_list_client_activity_events(uuid[], integer) from public, anon;
grant execute on function public.api_list_client_activity_events(uuid[], integer) to authenticated;
revoke all on function public.api_list_client_part_metadata(uuid[]) from public, anon;
grant execute on function public.api_list_client_part_metadata(uuid[]) to authenticated;
revoke all on function public.api_list_client_quote_workspace(uuid[]) from public, anon;
grant execute on function public.api_list_client_quote_workspace(uuid[]) to authenticated;
revoke all on function public.api_list_organization_memberships(uuid) from public, anon;
grant execute on function public.api_list_organization_memberships(uuid) to authenticated;
revoke all on function public.api_list_project_assignee_profiles(uuid) from public, anon;
grant execute on function public.api_list_project_assignee_profiles(uuid) to authenticated;
revoke all on function public.api_publish_quote_package(uuid, uuid, text, boolean) from public, anon;
grant execute on function public.api_publish_quote_package(uuid, uuid, text, boolean) to authenticated;
revoke all on function public.api_reconcile_job_parts(uuid) from public, anon;
grant execute on function public.api_reconcile_job_parts(uuid) to authenticated;
revoke all on function public.api_record_manual_vendor_quote(uuid, uuid, vendor_name, vendor_status, text, text, text, jsonb, jsonb) from public, anon;
grant execute on function public.api_record_manual_vendor_quote(uuid, uuid, vendor_name, vendor_status, text, text, text, jsonb, jsonb) to authenticated;
revoke all on function public.api_remove_job_from_project(uuid, uuid) from public, anon;
grant execute on function public.api_remove_job_from_project(uuid, uuid) to authenticated;
revoke all on function public.api_remove_project_member(uuid) from public, anon;
grant execute on function public.api_remove_project_member(uuid) to authenticated;
revoke all on function public.api_request_debug_extraction(uuid, text) from public, anon;
grant execute on function public.api_request_debug_extraction(uuid, text) to authenticated;
revoke all on function public.api_request_extraction(uuid) from public, anon;
grant execute on function public.api_request_extraction(uuid) to authenticated;
revoke all on function public.api_reset_client_part_property_overrides(uuid, text[]) from public, anon;
grant execute on function public.api_reset_client_part_property_overrides(uuid, text[]) to authenticated;
revoke all on function public.api_start_quote_run(uuid, boolean) from public, anon;
grant execute on function public.api_start_quote_run(uuid, boolean) to authenticated;
revoke all on function public.api_unarchive_job(uuid) from public, anon;
grant execute on function public.api_unarchive_job(uuid) to authenticated;
revoke all on function public.api_unarchive_project(uuid) from public, anon;
grant execute on function public.api_unarchive_project(uuid) to authenticated;
revoke all on function public.api_update_client_part_request(uuid, text[], text, text, text, text, text, text, text, text, numeric, text, text, integer, integer[], date, jsonb, jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.api_update_client_part_request(uuid, text[], text, text, text, text, text, text, text, text, numeric, text, text, integer, integer[], date, jsonb, jsonb, jsonb, jsonb) to authenticated;
revoke all on function public.api_update_organization_membership_role(uuid, app_role) from public, anon;
grant execute on function public.api_update_organization_membership_role(uuid, app_role) to authenticated;
revoke all on function public.api_update_project(uuid, text, text) from public, anon;
grant execute on function public.api_update_project(uuid, text, text) to authenticated;
revoke all on function public.apply_markup(numeric, numeric, numeric) from public, anon;
grant execute on function public.apply_markup(numeric, numeric, numeric) to authenticated;
revoke all on function public.build_org_file_blob_storage_path(uuid, text, text) from public, anon;
grant execute on function public.build_org_file_blob_storage_path(uuid, text, text) to authenticated;
revoke all on function public.build_project_part_property_snapshot(jsonb, jsonb, jsonb, text, timestamp with time zone, text, text, text, text, text, numeric) from public, anon;
grant execute on function public.build_project_part_property_snapshot(jsonb, jsonb, jsonb, text, timestamp with time zone, text, text, text, text, text, numeric) to authenticated;
revoke all on function public.build_project_part_property_snapshot(jsonb, jsonb, jsonb, text, timestamp with time zone, text, text, text, text, text, numeric, text, text) from public, anon;
grant execute on function public.build_project_part_property_snapshot(jsonb, jsonb, jsonb, text, timestamp with time zone, text, text, text, text, text, numeric, text, text) to authenticated;
revoke all on function public.current_user_has_verified_auth() from public, anon;
grant execute on function public.current_user_has_verified_auth() to authenticated;
revoke all on function public.current_user_home_organization_id() from public, anon;
grant execute on function public.current_user_home_organization_id() to authenticated;
revoke all on function public.is_internal_user(uuid) from public, anon;
grant execute on function public.is_internal_user(uuid) to authenticated;
revoke all on function public.is_internal_user_any_org() from public, anon;
grant execute on function public.is_internal_user_any_org() to authenticated;
revoke all on function public.is_org_admin(uuid) from public, anon;
grant execute on function public.is_org_admin(uuid) to authenticated;
revoke all on function public.is_platform_admin() from public, anon;
grant execute on function public.is_platform_admin() to authenticated;
revoke all on function public.job_part_file_set(uuid) from public, anon;
grant execute on function public.job_part_file_set(uuid) to authenticated;
revoke all on function public.load_editable_project_part_context(uuid) from public, anon;
grant execute on function public.load_editable_project_part_context(uuid) to authenticated;
revoke all on function public.normalize_file_basename(text) from public, anon;
grant execute on function public.normalize_file_basename(text) to authenticated;
revoke all on function public.normalize_positive_integer_array(integer[], integer) from public, anon;
grant execute on function public.normalize_positive_integer_array(integer[], integer) to authenticated;
revoke all on function public.normalize_primary_service_kind(text[], text) from public, anon;
grant execute on function public.normalize_primary_service_kind(text[], text) to authenticated;
revoke all on function public.normalize_project_part_threads(jsonb) from public, anon;
grant execute on function public.normalize_project_part_threads(jsonb) to authenticated;
revoke all on function public.normalize_requested_service_kinds(text[], text) from public, anon;
grant execute on function public.normalize_requested_service_kinds(text[], text) to authenticated;
revoke all on function public.require_verified_auth() from public, anon;
grant execute on function public.require_verified_auth() to authenticated;
revoke all on function public.resolve_project_part_property_values(jsonb, jsonb) from public, anon;
grant execute on function public.resolve_project_part_property_values(jsonb, jsonb) to authenticated;
revoke all on function public.seed_project_part_property_defaults(approved_part_requirements, jsonb, jsonb) from public, anon;
grant execute on function public.seed_project_part_property_defaults(approved_part_requirements, jsonb, jsonb) to authenticated;
revoke all on function public.seed_revision_and_process_property_defaults(approved_part_requirements, jsonb, jsonb) from public, anon;
grant execute on function public.seed_revision_and_process_property_defaults(approved_part_requirements, jsonb, jsonb) to authenticated;
revoke all on function public.spend_default_daily_ceiling_usd() from public, anon;
grant execute on function public.spend_default_daily_ceiling_usd() to authenticated;
revoke all on function public.spend_default_per_run_ceiling_usd() from public, anon;
grant execute on function public.spend_default_per_run_ceiling_usd() to authenticated;
revoke all on function public.sync_quote_request_status_from_vendor_result() from public, anon;
grant execute on function public.sync_quote_request_status_from_vendor_result() to authenticated;
revoke all on function public.sync_service_request_line_item_status_from_quote_request() from public, anon;
grant execute on function public.sync_service_request_line_item_status_from_quote_request() to authenticated;
revoke all on function public.to_vendor_name_array(jsonb) from public, anon;
grant execute on function public.to_vendor_name_array(jsonb) to authenticated;
revoke all on function public.touch_updated_at() from public, anon;
grant execute on function public.touch_updated_at() to authenticated;
revoke all on function public.user_can_access_job(uuid) from public, anon;
grant execute on function public.user_can_access_job(uuid) to authenticated;
revoke all on function public.user_can_access_job_via_project(uuid) from public, anon;
grant execute on function public.user_can_access_job_via_project(uuid) to authenticated;
revoke all on function public.user_can_access_org(uuid) from public, anon;
grant execute on function public.user_can_access_org(uuid) to authenticated;
revoke all on function public.user_can_access_package(uuid) from public, anon;
grant execute on function public.user_can_access_package(uuid) to authenticated;
revoke all on function public.user_can_access_project(uuid) from public, anon;
grant execute on function public.user_can_access_project(uuid) to authenticated;
revoke all on function public.user_can_destructively_edit_job(uuid) from public, anon;
grant execute on function public.user_can_destructively_edit_job(uuid) to authenticated;
revoke all on function public.user_can_edit_job(uuid) from public, anon;
grant execute on function public.user_can_edit_job(uuid) to authenticated;
revoke all on function public.user_can_edit_project(uuid) from public, anon;
grant execute on function public.user_can_edit_project(uuid) to authenticated;
revoke all on function public.user_is_project_owner(uuid) from public, anon;
grant execute on function public.user_is_project_owner(uuid) to authenticated;

-- function_search_path_mutable (8)
alter function public.apply_markup(numeric, numeric, numeric) set search_path = public, pg_temp;
alter function public.normalize_file_basename(text) set search_path = public, pg_temp;
alter function public.normalize_primary_service_kind(text[], text) set search_path = public, pg_temp;
alter function public.normalize_requested_service_kinds(text[], text) set search_path = public, pg_temp;
alter function public.spend_default_daily_ceiling_usd() set search_path = public, pg_temp;
alter function public.spend_default_per_run_ceiling_usd() set search_path = public, pg_temp;
alter function public.to_vendor_name_array(jsonb) set search_path = public, pg_temp;
alter function public.touch_updated_at() set search_path = public, pg_temp;

-- guard: no public function may remain executable by anon outside the allowlist (currently empty)
do $$
declare v_bad text;
begin
  select string_agg(p.oid::regprocedure::text, ', ') into v_bad
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prokind = 'f'
    and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
    and has_function_privilege('anon', p.oid, 'EXECUTE');
  if v_bad is not null then
    raise exception 'OVD-736: anon still executes %', v_bad;
  end if;
end $$;

commit;
