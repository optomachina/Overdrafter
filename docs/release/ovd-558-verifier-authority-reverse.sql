-- OVD-558 separate source-only reverse migration.
-- Exact forward SQL SHA-256: a1e6b52443cd1888ff0e287e3564d0c6090d77c6a75d6bd6ded5708b008c383c
-- Pinned prechange manifest SHA-256: 718d89bfa7ed8059cc1c5eb951e14466fac4fa71df8087723a7abe5697ce8bac
-- Only storage function raw proacl null-to-explicit normalization is permitted.
begin;
set local statement_timeout = '180s';
set local lock_timeout = '10s';
select pg_advisory_xact_lock(510, 2);
do $ovd558_reverse_preflight$ declare actual text;
begin
  if current_user <> 'supabase_admin'
     or not (select rolsuper from pg_roles where rolname = current_user)
     or to_regrole('engineering_native_verifier') is null
     or (select count(*) from engineering_private.native_verifier_registered_objects) <> 0 then
    raise exception 'ovd558_reverse_runner_or_registry_mismatch';
  end if;
  select digest_value into actual from (select encode(sha256(convert_to(catalog_value, 'UTF8')), 'hex') from (with selected_roles(role_name) as (
  select rolname from pg_roles where rolname not like 'pg_%'
), functions as (
  select n.nspname as schema_name, p.proname as function_name,
    pg_get_function_identity_arguments(p.oid) as identity_arguments,
    pg_get_userbyid(p.proowner) as owner, p.prosecdef as security_definer,
    p.prokind as kind, p.proacl::text as acl, p.proconfig as configuration,
    md5(p.prosrc) as body_md5,
    md5(pg_get_functiondef(p.oid)) as definition_md5,
    (select coalesce(jsonb_agg(jsonb_build_object(
      'grantor', pg_get_userbyid(a.grantor),
      'grantee', case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
      'privilege', a.privilege_type, 'grantable', a.is_grantable)
      order by a.grantee, a.grantor, a.privilege_type), '[]'::jsonb)
      from aclexplode(p.proacl) a) as explicit_grants,
    exists (select 1 from pg_depend dep where dep.classid = 'pg_proc'::regclass
      and dep.objid = p.oid and dep.deptype = 'e') as extension_owned,
    exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_execute,
    (select jsonb_object_agg(r.role_name, jsonb_build_object(
      'schemaUsage', has_schema_privilege(r.role_name, n.oid, 'USAGE'),
      'functionExecute', has_function_privilege(r.role_name, p.oid, 'EXECUTE')))
      from selected_roles r) as callers
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname not like 'pg_%' and n.nspname <> 'information_schema'
), defaults as (
  select pg_get_userbyid(d.defaclrole) as owner,
    coalesce(n.nspname, '*') as schema_name, d.defaclobjtype as object_type,
    d.defaclacl::text as acl
  from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace
), schemas as (
  select n.nspname as schema_name, pg_get_userbyid(n.nspowner) as owner,
    n.nspacl::text as acl,
    exists (select 1 from aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
      where a.grantee = 0 and a.privilege_type = 'USAGE') as public_usage,
    (select jsonb_object_agg(r.role_name,
      has_schema_privilege(r.role_name, n.oid, 'USAGE')) from selected_roles r) as usage
    , (select jsonb_object_agg(o.role_name, jsonb_build_object(
      'usage', has_schema_privilege(o.role_name, n.oid, 'USAGE'),
      'create', has_schema_privilege(o.role_name, n.oid, 'CREATE')))
      from (values ('postgres'), ('supabase_storage_admin')) o(role_name)) as owner_capabilities
  from pg_namespace n where n.nspname not like 'pg_%' and n.nspname <> 'information_schema'
), roles as (
  select rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin,
    rolreplication, rolbypassrls from pg_roles
  where rolname not like 'pg_%'
), memberships as (
  select parent.rolname as granted_role, member.rolname as member_role,
    m.admin_option, m.inherit_option, m.set_option
  from pg_auth_members m join pg_roles parent on parent.oid = m.roleid
    join pg_roles member on member.oid = m.member
  where parent.rolname not like 'pg_%' or member.rolname not like 'pg_%'
), policies as (
  select schemaname as schema_name, tablename as table_name, policyname as policy_name,
    permissive, roles, cmd, qual, with_check from pg_policies
  where schemaname not like 'pg_%' and schemaname <> 'information_schema'
), relations as (
  select n.nspname as schema_name, c.relname as relation_name, c.relkind as kind,
    pg_get_userbyid(c.relowner) as owner, c.relacl::text as acl,
    c.relrowsecurity as row_security, c.relforcerowsecurity as force_row_security,
    (select jsonb_object_agg(r.role_name, jsonb_build_object(
      'select', has_table_privilege(r.role_name, c.oid, 'SELECT'),
      'insert', has_table_privilege(r.role_name, c.oid, 'INSERT'),
      'update', has_table_privilege(r.role_name, c.oid, 'UPDATE'),
      'delete', has_table_privilege(r.role_name, c.oid, 'DELETE')))
      from selected_roles r) as callers
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname not like 'pg_%' and n.nspname <> 'information_schema'
    and c.relkind in ('r','p','v','m')
), sequences as (
  select n.nspname as schema_name, c.relname as sequence_name,
    pg_get_userbyid(c.relowner) as owner, c.relacl::text as acl,
    (select jsonb_object_agg(r.role_name, jsonb_build_object(
      'usage', has_sequence_privilege(r.role_name, c.oid, 'USAGE'),
      'select', has_sequence_privilege(r.role_name, c.oid, 'SELECT'),
      'update', has_sequence_privilege(r.role_name, c.oid, 'UPDATE')))
      from selected_roles r) as callers
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname not like 'pg_%' and n.nspname <> 'information_schema'
    and c.relkind = 'S'
)
select jsonb_build_object(
  'databaseVersion', current_setting('server_version'),
  'functions', (select coalesce(jsonb_agg(to_jsonb(f) order by schema_name,function_name,identity_arguments), '[]'::jsonb) from functions f),
  'defaults', (select coalesce(jsonb_agg(to_jsonb(d) order by owner,schema_name,object_type), '[]'::jsonb) from defaults d),
  'schemas', (select coalesce(jsonb_agg(to_jsonb(s) order by schema_name), '[]'::jsonb) from schemas s),
  'roles', (select coalesce(jsonb_agg(to_jsonb(r) order by rolname), '[]'::jsonb) from roles r),
  'memberships', (select coalesce(jsonb_agg(to_jsonb(m) order by granted_role,member_role), '[]'::jsonb) from memberships m),
  'policies', (select coalesce(jsonb_agg(to_jsonb(p) order by schema_name,table_name,policy_name), '[]'::jsonb) from policies p),
  'relations', (select coalesce(jsonb_agg(to_jsonb(t) order by schema_name,relation_name), '[]'::jsonb) from relations t),
  'sequences', (select coalesce(jsonb_agg(to_jsonb(s) order by schema_name,sequence_name), '[]'::jsonb) from sequences s)
)::text) snapshot(catalog_value)) as digest(digest_value);
  if actual is distinct from 'b5a5bbd163458c2ea4a519846ba6c25b3860e069900c788a01b48150a3e24d92' then
    raise exception 'ovd558_unknown_postchange_catalog:%', actual;
  end if;
end $ovd558_reverse_preflight$;
drop policy ovd510_verifier_registered_permissive on storage.objects;
drop policy ovd510_verifier_registered_restrictive on storage.objects;
revoke engineering_native_verifier from authenticator;
revoke execute on function public.api_load_native_verification(uuid,uuid),
  public.api_complete_native_verification(uuid,text),
  public.api_reject_native_verification(uuid,jsonb),
  engineering_private.load_native_verification(uuid,uuid),
  engineering_private.complete_native_verification(uuid,text),
  engineering_private.reject_native_verification(uuid,jsonb),
  engineering_private.native_verifier_can_read_object(text,text)
  from engineering_native_verifier;
revoke select on storage.objects from engineering_native_verifier;
revoke usage on schema public, engineering_private, storage from engineering_native_verifier;
set role postgres;
drop function public.api_load_native_verification(uuid,uuid),
  public.api_complete_native_verification(uuid,text),
  public.api_reject_native_verification(uuid,jsonb),
  engineering_private.load_native_verification(uuid,uuid),
  engineering_private.complete_native_verification(uuid,text),
  engineering_private.reject_native_verification(uuid,jsonb),
  engineering_private.native_verifier_can_read_object(text,text) restrict;
drop table engineering_private.native_verifier_registered_objects restrict;
reset role;
drop role engineering_native_verifier;
set role "postgres";
REVOKE EXECUTE ON FUNCTION "public"."api_accept_project_invite"(p_token text) FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."api_accept_project_invite"(p_token text) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."api_accept_project_invite"(p_token text) FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_accept_project_invite"(p_token text) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_accept_project_invite"(p_token text) FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."api_accept_project_invite"(p_token text) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."api_accept_project_invite"(p_token text) FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_accept_project_invite"(p_token text) FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_admin_list_all_jobs"() FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."api_admin_list_all_jobs"() FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."api_admin_list_all_jobs"() FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_admin_list_all_jobs"() FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_admin_list_all_jobs"() FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."api_admin_list_all_jobs"() FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."api_admin_list_all_jobs"() FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_admin_list_all_jobs"() FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_admin_list_all_projects"() FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."api_admin_list_all_projects"() FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."api_admin_list_all_projects"() FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_admin_list_all_projects"() FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_admin_list_all_projects"() FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."api_admin_list_all_projects"() FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."api_admin_list_all_projects"() FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_admin_list_all_projects"() FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_admin_list_all_users"() FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."api_admin_list_all_users"() FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."api_admin_list_all_users"() FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_admin_list_all_users"() FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_admin_list_all_users"() FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."api_admin_list_all_users"() FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."api_admin_list_all_users"() FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_admin_list_all_users"() FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_admin_list_organizations"() FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."api_admin_list_organizations"() FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."api_admin_list_organizations"() FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_admin_list_organizations"() FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_admin_list_organizations"() FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."api_admin_list_organizations"() FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."api_admin_list_organizations"() FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_admin_list_organizations"() FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_approve_job_requirements"(p_job_id uuid, p_requirements jsonb) FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."api_approve_job_requirements"(p_job_id uuid, p_requirements jsonb) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."api_approve_job_requirements"(p_job_id uuid, p_requirements jsonb) FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_approve_job_requirements"(p_job_id uuid, p_requirements jsonb) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_approve_job_requirements"(p_job_id uuid, p_requirements jsonb) FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."api_approve_job_requirements"(p_job_id uuid, p_requirements jsonb) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."api_approve_job_requirements"(p_job_id uuid, p_requirements jsonb) FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_approve_job_requirements"(p_job_id uuid, p_requirements jsonb) FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_archive_job"(p_job_id uuid) FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."api_archive_job"(p_job_id uuid) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."api_archive_job"(p_job_id uuid) FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_archive_job"(p_job_id uuid) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_archive_job"(p_job_id uuid) FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."api_archive_job"(p_job_id uuid) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."api_archive_job"(p_job_id uuid) FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_archive_job"(p_job_id uuid) FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_archive_project"(p_project_id uuid) FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."api_archive_project"(p_project_id uuid) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."api_archive_project"(p_project_id uuid) FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_archive_project"(p_project_id uuid) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_archive_project"(p_project_id uuid) FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."api_archive_project"(p_project_id uuid) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."api_archive_project"(p_project_id uuid) FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_archive_project"(p_project_id uuid) FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_assign_job_to_project"(p_job_id uuid, p_project_id uuid) FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."api_assign_job_to_project"(p_job_id uuid, p_project_id uuid) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."api_assign_job_to_project"(p_job_id uuid, p_project_id uuid) FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_assign_job_to_project"(p_job_id uuid, p_project_id uuid) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_assign_job_to_project"(p_job_id uuid, p_project_id uuid) FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."api_assign_job_to_project"(p_job_id uuid, p_project_id uuid) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."api_assign_job_to_project"(p_job_id uuid, p_project_id uuid) FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_assign_job_to_project"(p_job_id uuid, p_project_id uuid) FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_cancel_quote_request"(p_request_id uuid) FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."api_cancel_quote_request"(p_request_id uuid) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."api_cancel_quote_request"(p_request_id uuid) FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_cancel_quote_request"(p_request_id uuid) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_cancel_quote_request"(p_request_id uuid) FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."api_cancel_quote_request"(p_request_id uuid) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."api_cancel_quote_request"(p_request_id uuid) FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_cancel_quote_request"(p_request_id uuid) FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_create_project"(p_name text, p_description text) FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."api_create_project"(p_name text, p_description text) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."api_create_project"(p_name text, p_description text) FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_create_project"(p_name text, p_description text) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_create_project"(p_name text, p_description text) FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."api_create_project"(p_name text, p_description text) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."api_create_project"(p_name text, p_description text) FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_create_project"(p_name text, p_description text) FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_create_self_service_organization"(p_organization_name text) FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."api_create_self_service_organization"(p_organization_name text) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."api_create_self_service_organization"(p_organization_name text) FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_create_self_service_organization"(p_organization_name text) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_create_self_service_organization"(p_organization_name text) FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."api_create_self_service_organization"(p_organization_name text) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."api_create_self_service_organization"(p_organization_name text) FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_create_self_service_organization"(p_organization_name text) FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_delete_archived_job"(p_job_id uuid) FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."api_delete_archived_job"(p_job_id uuid) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."api_delete_archived_job"(p_job_id uuid) FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_delete_archived_job"(p_job_id uuid) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_delete_archived_job"(p_job_id uuid) FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."api_delete_archived_job"(p_job_id uuid) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."api_delete_archived_job"(p_job_id uuid) FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_delete_archived_job"(p_job_id uuid) FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_delete_archived_jobs"(p_job_ids uuid[]) FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."api_delete_archived_jobs"(p_job_ids uuid[]) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."api_delete_archived_jobs"(p_job_ids uuid[]) FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_delete_archived_jobs"(p_job_ids uuid[]) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_delete_archived_jobs"(p_job_ids uuid[]) FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."api_delete_archived_jobs"(p_job_ids uuid[]) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."api_delete_archived_jobs"(p_job_ids uuid[]) FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_delete_archived_jobs"(p_job_ids uuid[]) FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_delete_project"(p_project_id uuid) FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."api_delete_project"(p_project_id uuid) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."api_delete_project"(p_project_id uuid) FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_delete_project"(p_project_id uuid) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_delete_project"(p_project_id uuid) FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."api_delete_project"(p_project_id uuid) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."api_delete_project"(p_project_id uuid) FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_delete_project"(p_project_id uuid) FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_dissolve_project"(p_project_id uuid) FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."api_dissolve_project"(p_project_id uuid) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."api_dissolve_project"(p_project_id uuid) FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_dissolve_project"(p_project_id uuid) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_dissolve_project"(p_project_id uuid) FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."api_dissolve_project"(p_project_id uuid) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."api_dissolve_project"(p_project_id uuid) FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_dissolve_project"(p_project_id uuid) FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_get_client_intake_compatibility"() FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."api_get_client_intake_compatibility"() FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."api_get_client_intake_compatibility"() FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_get_client_intake_compatibility"() FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_get_client_intake_compatibility"() FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."api_get_client_intake_compatibility"() FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."api_get_client_intake_compatibility"() FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_get_client_intake_compatibility"() FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_get_is_platform_admin"() FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."api_get_is_platform_admin"() FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."api_get_is_platform_admin"() FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_get_is_platform_admin"() FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_get_is_platform_admin"() FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."api_get_is_platform_admin"() FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."api_get_is_platform_admin"() FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_get_is_platform_admin"() FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_get_quote_run_readiness"(p_quote_run_id uuid) FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."api_get_quote_run_readiness"(p_quote_run_id uuid) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."api_get_quote_run_readiness"(p_quote_run_id uuid) FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_get_quote_run_readiness"(p_quote_run_id uuid) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_get_quote_run_readiness"(p_quote_run_id uuid) FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."api_get_quote_run_readiness"(p_quote_run_id uuid) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."api_get_quote_run_readiness"(p_quote_run_id uuid) FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_get_quote_run_readiness"(p_quote_run_id uuid) FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_invite_project_member"(p_project_id uuid, p_email text, p_role project_role) FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."api_invite_project_member"(p_project_id uuid, p_email text, p_role project_role) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."api_invite_project_member"(p_project_id uuid, p_email text, p_role project_role) FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_invite_project_member"(p_project_id uuid, p_email text, p_role project_role) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_invite_project_member"(p_project_id uuid, p_email text, p_role project_role) FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."api_invite_project_member"(p_project_id uuid, p_email text, p_role project_role) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."api_invite_project_member"(p_project_id uuid, p_email text, p_role project_role) FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_invite_project_member"(p_project_id uuid, p_email text, p_role project_role) FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_list_client_activity_events"(p_job_ids uuid[], p_limit_per_job integer) FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."api_list_client_activity_events"(p_job_ids uuid[], p_limit_per_job integer) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."api_list_client_activity_events"(p_job_ids uuid[], p_limit_per_job integer) FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_list_client_activity_events"(p_job_ids uuid[], p_limit_per_job integer) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_list_client_activity_events"(p_job_ids uuid[], p_limit_per_job integer) FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."api_list_client_activity_events"(p_job_ids uuid[], p_limit_per_job integer) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."api_list_client_activity_events"(p_job_ids uuid[], p_limit_per_job integer) FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_list_client_activity_events"(p_job_ids uuid[], p_limit_per_job integer) FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_list_client_part_metadata"(p_job_ids uuid[]) FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."api_list_client_part_metadata"(p_job_ids uuid[]) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."api_list_client_part_metadata"(p_job_ids uuid[]) FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_list_client_part_metadata"(p_job_ids uuid[]) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_list_client_part_metadata"(p_job_ids uuid[]) FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."api_list_client_part_metadata"(p_job_ids uuid[]) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."api_list_client_part_metadata"(p_job_ids uuid[]) FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_list_client_part_metadata"(p_job_ids uuid[]) FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_list_client_quote_workspace"(p_job_ids uuid[]) FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."api_list_client_quote_workspace"(p_job_ids uuid[]) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."api_list_client_quote_workspace"(p_job_ids uuid[]) FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_list_client_quote_workspace"(p_job_ids uuid[]) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_list_client_quote_workspace"(p_job_ids uuid[]) FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."api_list_client_quote_workspace"(p_job_ids uuid[]) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."api_list_client_quote_workspace"(p_job_ids uuid[]) FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_list_client_quote_workspace"(p_job_ids uuid[]) FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_list_organization_memberships"(p_organization_id uuid) FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."api_list_organization_memberships"(p_organization_id uuid) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."api_list_organization_memberships"(p_organization_id uuid) FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_list_organization_memberships"(p_organization_id uuid) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_list_organization_memberships"(p_organization_id uuid) FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."api_list_organization_memberships"(p_organization_id uuid) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."api_list_organization_memberships"(p_organization_id uuid) FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_list_organization_memberships"(p_organization_id uuid) FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_list_project_assignee_profiles"(p_project_id uuid) FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."api_list_project_assignee_profiles"(p_project_id uuid) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."api_list_project_assignee_profiles"(p_project_id uuid) FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_list_project_assignee_profiles"(p_project_id uuid) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_list_project_assignee_profiles"(p_project_id uuid) FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."api_list_project_assignee_profiles"(p_project_id uuid) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."api_list_project_assignee_profiles"(p_project_id uuid) FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_list_project_assignee_profiles"(p_project_id uuid) FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_publish_quote_package"(p_job_id uuid, p_quote_run_id uuid, p_client_summary text, p_force boolean) FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."api_publish_quote_package"(p_job_id uuid, p_quote_run_id uuid, p_client_summary text, p_force boolean) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."api_publish_quote_package"(p_job_id uuid, p_quote_run_id uuid, p_client_summary text, p_force boolean) FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_publish_quote_package"(p_job_id uuid, p_quote_run_id uuid, p_client_summary text, p_force boolean) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_publish_quote_package"(p_job_id uuid, p_quote_run_id uuid, p_client_summary text, p_force boolean) FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."api_publish_quote_package"(p_job_id uuid, p_quote_run_id uuid, p_client_summary text, p_force boolean) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."api_publish_quote_package"(p_job_id uuid, p_quote_run_id uuid, p_client_summary text, p_force boolean) FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_publish_quote_package"(p_job_id uuid, p_quote_run_id uuid, p_client_summary text, p_force boolean) FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_reconcile_job_parts"(p_job_id uuid) FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."api_reconcile_job_parts"(p_job_id uuid) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."api_reconcile_job_parts"(p_job_id uuid) FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_reconcile_job_parts"(p_job_id uuid) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_reconcile_job_parts"(p_job_id uuid) FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."api_reconcile_job_parts"(p_job_id uuid) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."api_reconcile_job_parts"(p_job_id uuid) FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_reconcile_job_parts"(p_job_id uuid) FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_record_manual_vendor_quote"(p_job_id uuid, p_part_id uuid, p_vendor vendor_name, p_status vendor_status, p_summary_note text, p_source_text text, p_quote_url text, p_offers jsonb, p_artifacts jsonb) FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."api_record_manual_vendor_quote"(p_job_id uuid, p_part_id uuid, p_vendor vendor_name, p_status vendor_status, p_summary_note text, p_source_text text, p_quote_url text, p_offers jsonb, p_artifacts jsonb) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."api_record_manual_vendor_quote"(p_job_id uuid, p_part_id uuid, p_vendor vendor_name, p_status vendor_status, p_summary_note text, p_source_text text, p_quote_url text, p_offers jsonb, p_artifacts jsonb) FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_record_manual_vendor_quote"(p_job_id uuid, p_part_id uuid, p_vendor vendor_name, p_status vendor_status, p_summary_note text, p_source_text text, p_quote_url text, p_offers jsonb, p_artifacts jsonb) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_record_manual_vendor_quote"(p_job_id uuid, p_part_id uuid, p_vendor vendor_name, p_status vendor_status, p_summary_note text, p_source_text text, p_quote_url text, p_offers jsonb, p_artifacts jsonb) FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."api_record_manual_vendor_quote"(p_job_id uuid, p_part_id uuid, p_vendor vendor_name, p_status vendor_status, p_summary_note text, p_source_text text, p_quote_url text, p_offers jsonb, p_artifacts jsonb) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."api_record_manual_vendor_quote"(p_job_id uuid, p_part_id uuid, p_vendor vendor_name, p_status vendor_status, p_summary_note text, p_source_text text, p_quote_url text, p_offers jsonb, p_artifacts jsonb) FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_record_manual_vendor_quote"(p_job_id uuid, p_part_id uuid, p_vendor vendor_name, p_status vendor_status, p_summary_note text, p_source_text text, p_quote_url text, p_offers jsonb, p_artifacts jsonb) FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_remove_job_from_project"(p_job_id uuid, p_project_id uuid) FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."api_remove_job_from_project"(p_job_id uuid, p_project_id uuid) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."api_remove_job_from_project"(p_job_id uuid, p_project_id uuid) FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_remove_job_from_project"(p_job_id uuid, p_project_id uuid) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_remove_job_from_project"(p_job_id uuid, p_project_id uuid) FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."api_remove_job_from_project"(p_job_id uuid, p_project_id uuid) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."api_remove_job_from_project"(p_job_id uuid, p_project_id uuid) FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_remove_job_from_project"(p_job_id uuid, p_project_id uuid) FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_remove_project_member"(p_project_membership_id uuid) FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."api_remove_project_member"(p_project_membership_id uuid) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."api_remove_project_member"(p_project_membership_id uuid) FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_remove_project_member"(p_project_membership_id uuid) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_remove_project_member"(p_project_membership_id uuid) FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."api_remove_project_member"(p_project_membership_id uuid) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."api_remove_project_member"(p_project_membership_id uuid) FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_remove_project_member"(p_project_membership_id uuid) FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_request_debug_extraction"(p_part_id uuid, p_model text) FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."api_request_debug_extraction"(p_part_id uuid, p_model text) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."api_request_debug_extraction"(p_part_id uuid, p_model text) FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_request_debug_extraction"(p_part_id uuid, p_model text) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_request_debug_extraction"(p_part_id uuid, p_model text) FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."api_request_debug_extraction"(p_part_id uuid, p_model text) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."api_request_debug_extraction"(p_part_id uuid, p_model text) FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_request_debug_extraction"(p_part_id uuid, p_model text) FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_request_extraction"(p_job_id uuid) FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."api_request_extraction"(p_job_id uuid) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."api_request_extraction"(p_job_id uuid) FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_request_extraction"(p_job_id uuid) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_request_extraction"(p_job_id uuid) FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."api_request_extraction"(p_job_id uuid) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."api_request_extraction"(p_job_id uuid) FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_request_extraction"(p_job_id uuid) FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_reset_client_part_property_overrides"(p_job_id uuid, p_fields text[]) FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."api_reset_client_part_property_overrides"(p_job_id uuid, p_fields text[]) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."api_reset_client_part_property_overrides"(p_job_id uuid, p_fields text[]) FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_reset_client_part_property_overrides"(p_job_id uuid, p_fields text[]) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_reset_client_part_property_overrides"(p_job_id uuid, p_fields text[]) FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."api_reset_client_part_property_overrides"(p_job_id uuid, p_fields text[]) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."api_reset_client_part_property_overrides"(p_job_id uuid, p_fields text[]) FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_reset_client_part_property_overrides"(p_job_id uuid, p_fields text[]) FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_select_quote_option"(p_package_id uuid, p_option_id uuid, p_note text) FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."api_select_quote_option"(p_package_id uuid, p_option_id uuid, p_note text) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."api_select_quote_option"(p_package_id uuid, p_option_id uuid, p_note text) FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_select_quote_option"(p_package_id uuid, p_option_id uuid, p_note text) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_select_quote_option"(p_package_id uuid, p_option_id uuid, p_note text) FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."api_select_quote_option"(p_package_id uuid, p_option_id uuid, p_note text) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."api_select_quote_option"(p_package_id uuid, p_option_id uuid, p_note text) FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_select_quote_option"(p_package_id uuid, p_option_id uuid, p_note text) FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_start_quote_run"(p_job_id uuid, p_auto_publish_requested boolean) FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."api_start_quote_run"(p_job_id uuid, p_auto_publish_requested boolean) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."api_start_quote_run"(p_job_id uuid, p_auto_publish_requested boolean) FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_start_quote_run"(p_job_id uuid, p_auto_publish_requested boolean) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_start_quote_run"(p_job_id uuid, p_auto_publish_requested boolean) FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."api_start_quote_run"(p_job_id uuid, p_auto_publish_requested boolean) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."api_start_quote_run"(p_job_id uuid, p_auto_publish_requested boolean) FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_start_quote_run"(p_job_id uuid, p_auto_publish_requested boolean) FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_unarchive_job"(p_job_id uuid) FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."api_unarchive_job"(p_job_id uuid) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."api_unarchive_job"(p_job_id uuid) FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_unarchive_job"(p_job_id uuid) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_unarchive_job"(p_job_id uuid) FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."api_unarchive_job"(p_job_id uuid) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."api_unarchive_job"(p_job_id uuid) FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_unarchive_job"(p_job_id uuid) FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_unarchive_project"(p_project_id uuid) FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."api_unarchive_project"(p_project_id uuid) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."api_unarchive_project"(p_project_id uuid) FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_unarchive_project"(p_project_id uuid) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_unarchive_project"(p_project_id uuid) FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."api_unarchive_project"(p_project_id uuid) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."api_unarchive_project"(p_project_id uuid) FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_unarchive_project"(p_project_id uuid) FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_update_client_part_request"(p_job_id uuid, p_requested_service_kinds text[], p_primary_service_kind text, p_service_notes text, p_description text, p_part_number text, p_revision text, p_material text, p_finish text, p_threads text, p_tightest_tolerance_inch numeric, p_process text, p_notes text, p_quantity integer, p_requested_quote_quantities integer[], p_requested_by_date date, p_shipping jsonb, p_certifications jsonb, p_sourcing jsonb, p_release jsonb) FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."api_update_client_part_request"(p_job_id uuid, p_requested_service_kinds text[], p_primary_service_kind text, p_service_notes text, p_description text, p_part_number text, p_revision text, p_material text, p_finish text, p_threads text, p_tightest_tolerance_inch numeric, p_process text, p_notes text, p_quantity integer, p_requested_quote_quantities integer[], p_requested_by_date date, p_shipping jsonb, p_certifications jsonb, p_sourcing jsonb, p_release jsonb) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."api_update_client_part_request"(p_job_id uuid, p_requested_service_kinds text[], p_primary_service_kind text, p_service_notes text, p_description text, p_part_number text, p_revision text, p_material text, p_finish text, p_threads text, p_tightest_tolerance_inch numeric, p_process text, p_notes text, p_quantity integer, p_requested_quote_quantities integer[], p_requested_by_date date, p_shipping jsonb, p_certifications jsonb, p_sourcing jsonb, p_release jsonb) FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_update_client_part_request"(p_job_id uuid, p_requested_service_kinds text[], p_primary_service_kind text, p_service_notes text, p_description text, p_part_number text, p_revision text, p_material text, p_finish text, p_threads text, p_tightest_tolerance_inch numeric, p_process text, p_notes text, p_quantity integer, p_requested_quote_quantities integer[], p_requested_by_date date, p_shipping jsonb, p_certifications jsonb, p_sourcing jsonb, p_release jsonb) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_update_client_part_request"(p_job_id uuid, p_requested_service_kinds text[], p_primary_service_kind text, p_service_notes text, p_description text, p_part_number text, p_revision text, p_material text, p_finish text, p_threads text, p_tightest_tolerance_inch numeric, p_process text, p_notes text, p_quantity integer, p_requested_quote_quantities integer[], p_requested_by_date date, p_shipping jsonb, p_certifications jsonb, p_sourcing jsonb, p_release jsonb) FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."api_update_client_part_request"(p_job_id uuid, p_requested_service_kinds text[], p_primary_service_kind text, p_service_notes text, p_description text, p_part_number text, p_revision text, p_material text, p_finish text, p_threads text, p_tightest_tolerance_inch numeric, p_process text, p_notes text, p_quantity integer, p_requested_quote_quantities integer[], p_requested_by_date date, p_shipping jsonb, p_certifications jsonb, p_sourcing jsonb, p_release jsonb) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."api_update_client_part_request"(p_job_id uuid, p_requested_service_kinds text[], p_primary_service_kind text, p_service_notes text, p_description text, p_part_number text, p_revision text, p_material text, p_finish text, p_threads text, p_tightest_tolerance_inch numeric, p_process text, p_notes text, p_quantity integer, p_requested_quote_quantities integer[], p_requested_by_date date, p_shipping jsonb, p_certifications jsonb, p_sourcing jsonb, p_release jsonb) FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_update_client_part_request"(p_job_id uuid, p_requested_service_kinds text[], p_primary_service_kind text, p_service_notes text, p_description text, p_part_number text, p_revision text, p_material text, p_finish text, p_threads text, p_tightest_tolerance_inch numeric, p_process text, p_notes text, p_quantity integer, p_requested_quote_quantities integer[], p_requested_by_date date, p_shipping jsonb, p_certifications jsonb, p_sourcing jsonb, p_release jsonb) FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_update_organization_membership_role"(p_membership_id uuid, p_role app_role) FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."api_update_organization_membership_role"(p_membership_id uuid, p_role app_role) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."api_update_organization_membership_role"(p_membership_id uuid, p_role app_role) FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_update_organization_membership_role"(p_membership_id uuid, p_role app_role) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_update_organization_membership_role"(p_membership_id uuid, p_role app_role) FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."api_update_organization_membership_role"(p_membership_id uuid, p_role app_role) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."api_update_organization_membership_role"(p_membership_id uuid, p_role app_role) FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_update_organization_membership_role"(p_membership_id uuid, p_role app_role) FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_update_project"(p_project_id uuid, p_name text, p_description text) FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."api_update_project"(p_project_id uuid, p_name text, p_description text) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."api_update_project"(p_project_id uuid, p_name text, p_description text) FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_update_project"(p_project_id uuid, p_name text, p_description text) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_update_project"(p_project_id uuid, p_name text, p_description text) FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."api_update_project"(p_project_id uuid, p_name text, p_description text) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."api_update_project"(p_project_id uuid, p_name text, p_description text) FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."api_update_project"(p_project_id uuid, p_name text, p_description text) FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."apply_markup"(p_raw_amount numeric, p_markup_percent numeric, p_minor_unit numeric) FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."apply_markup"(p_raw_amount numeric, p_markup_percent numeric, p_minor_unit numeric) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."apply_markup"(p_raw_amount numeric, p_markup_percent numeric, p_minor_unit numeric) FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."apply_markup"(p_raw_amount numeric, p_markup_percent numeric, p_minor_unit numeric) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."apply_markup"(p_raw_amount numeric, p_markup_percent numeric, p_minor_unit numeric) FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."apply_markup"(p_raw_amount numeric, p_markup_percent numeric, p_minor_unit numeric) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."apply_markup"(p_raw_amount numeric, p_markup_percent numeric, p_minor_unit numeric) FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."apply_markup"(p_raw_amount numeric, p_markup_percent numeric, p_minor_unit numeric) FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."build_org_file_blob_storage_path"(p_organization_id uuid, p_content_sha256 text, p_original_name text) FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."build_org_file_blob_storage_path"(p_organization_id uuid, p_content_sha256 text, p_original_name text) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."build_org_file_blob_storage_path"(p_organization_id uuid, p_content_sha256 text, p_original_name text) FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."build_org_file_blob_storage_path"(p_organization_id uuid, p_content_sha256 text, p_original_name text) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."build_org_file_blob_storage_path"(p_organization_id uuid, p_content_sha256 text, p_original_name text) FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."build_org_file_blob_storage_path"(p_organization_id uuid, p_content_sha256 text, p_original_name text) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."build_org_file_blob_storage_path"(p_organization_id uuid, p_content_sha256 text, p_original_name text) FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."build_org_file_blob_storage_path"(p_organization_id uuid, p_content_sha256 text, p_original_name text) FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."build_project_part_property_snapshot"(p_spec_snapshot jsonb, p_defaults jsonb, p_overrides jsonb, p_created_at text, p_updated_at timestamp with time zone, p_description text, p_part_number text, p_material text, p_finish text, p_threads text, p_tightest_tolerance_inch numeric, p_revision text, p_process text) FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."build_project_part_property_snapshot"(p_spec_snapshot jsonb, p_defaults jsonb, p_overrides jsonb, p_created_at text, p_updated_at timestamp with time zone, p_description text, p_part_number text, p_material text, p_finish text, p_threads text, p_tightest_tolerance_inch numeric, p_revision text, p_process text) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."build_project_part_property_snapshot"(p_spec_snapshot jsonb, p_defaults jsonb, p_overrides jsonb, p_created_at text, p_updated_at timestamp with time zone, p_description text, p_part_number text, p_material text, p_finish text, p_threads text, p_tightest_tolerance_inch numeric, p_revision text, p_process text) FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."build_project_part_property_snapshot"(p_spec_snapshot jsonb, p_defaults jsonb, p_overrides jsonb, p_created_at text, p_updated_at timestamp with time zone, p_description text, p_part_number text, p_material text, p_finish text, p_threads text, p_tightest_tolerance_inch numeric, p_revision text, p_process text) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."build_project_part_property_snapshot"(p_spec_snapshot jsonb, p_defaults jsonb, p_overrides jsonb, p_created_at text, p_updated_at timestamp with time zone, p_description text, p_part_number text, p_material text, p_finish text, p_threads text, p_tightest_tolerance_inch numeric, p_revision text, p_process text) FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."build_project_part_property_snapshot"(p_spec_snapshot jsonb, p_defaults jsonb, p_overrides jsonb, p_created_at text, p_updated_at timestamp with time zone, p_description text, p_part_number text, p_material text, p_finish text, p_threads text, p_tightest_tolerance_inch numeric, p_revision text, p_process text) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."build_project_part_property_snapshot"(p_spec_snapshot jsonb, p_defaults jsonb, p_overrides jsonb, p_created_at text, p_updated_at timestamp with time zone, p_description text, p_part_number text, p_material text, p_finish text, p_threads text, p_tightest_tolerance_inch numeric, p_revision text, p_process text) FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."build_project_part_property_snapshot"(p_spec_snapshot jsonb, p_defaults jsonb, p_overrides jsonb, p_created_at text, p_updated_at timestamp with time zone, p_description text, p_part_number text, p_material text, p_finish text, p_threads text, p_tightest_tolerance_inch numeric, p_revision text, p_process text) FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."build_project_part_property_snapshot"(p_spec_snapshot jsonb, p_defaults jsonb, p_overrides jsonb, p_created_at text, p_updated_at timestamp with time zone, p_description text, p_part_number text, p_material text, p_finish text, p_threads text, p_tightest_tolerance_inch numeric) FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."build_project_part_property_snapshot"(p_spec_snapshot jsonb, p_defaults jsonb, p_overrides jsonb, p_created_at text, p_updated_at timestamp with time zone, p_description text, p_part_number text, p_material text, p_finish text, p_threads text, p_tightest_tolerance_inch numeric) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."build_project_part_property_snapshot"(p_spec_snapshot jsonb, p_defaults jsonb, p_overrides jsonb, p_created_at text, p_updated_at timestamp with time zone, p_description text, p_part_number text, p_material text, p_finish text, p_threads text, p_tightest_tolerance_inch numeric) FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."build_project_part_property_snapshot"(p_spec_snapshot jsonb, p_defaults jsonb, p_overrides jsonb, p_created_at text, p_updated_at timestamp with time zone, p_description text, p_part_number text, p_material text, p_finish text, p_threads text, p_tightest_tolerance_inch numeric) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."build_project_part_property_snapshot"(p_spec_snapshot jsonb, p_defaults jsonb, p_overrides jsonb, p_created_at text, p_updated_at timestamp with time zone, p_description text, p_part_number text, p_material text, p_finish text, p_threads text, p_tightest_tolerance_inch numeric) FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."build_project_part_property_snapshot"(p_spec_snapshot jsonb, p_defaults jsonb, p_overrides jsonb, p_created_at text, p_updated_at timestamp with time zone, p_description text, p_part_number text, p_material text, p_finish text, p_threads text, p_tightest_tolerance_inch numeric) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."build_project_part_property_snapshot"(p_spec_snapshot jsonb, p_defaults jsonb, p_overrides jsonb, p_created_at text, p_updated_at timestamp with time zone, p_description text, p_part_number text, p_material text, p_finish text, p_threads text, p_tightest_tolerance_inch numeric) FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."build_project_part_property_snapshot"(p_spec_snapshot jsonb, p_defaults jsonb, p_overrides jsonb, p_created_at text, p_updated_at timestamp with time zone, p_description text, p_part_number text, p_material text, p_finish text, p_threads text, p_tightest_tolerance_inch numeric) FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."current_user_has_verified_auth"() FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."current_user_has_verified_auth"() FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."current_user_has_verified_auth"() FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."current_user_has_verified_auth"() FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."current_user_has_verified_auth"() FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."current_user_has_verified_auth"() FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."current_user_has_verified_auth"() FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."current_user_has_verified_auth"() FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."current_user_home_organization_id"() FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."current_user_home_organization_id"() FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."current_user_home_organization_id"() FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."current_user_home_organization_id"() FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."current_user_home_organization_id"() FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."current_user_home_organization_id"() FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."current_user_home_organization_id"() FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."current_user_home_organization_id"() FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."is_internal_user_any_org"() FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."is_internal_user_any_org"() FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."is_internal_user_any_org"() FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."is_internal_user_any_org"() FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."is_internal_user_any_org"() FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."is_internal_user_any_org"() FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."is_internal_user_any_org"() FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."is_internal_user_any_org"() FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."is_internal_user"(p_organization_id uuid) FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."is_internal_user"(p_organization_id uuid) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."is_internal_user"(p_organization_id uuid) FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."is_internal_user"(p_organization_id uuid) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."is_internal_user"(p_organization_id uuid) FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."is_internal_user"(p_organization_id uuid) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."is_internal_user"(p_organization_id uuid) FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."is_internal_user"(p_organization_id uuid) FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."is_org_admin"(p_organization_id uuid) FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."is_org_admin"(p_organization_id uuid) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."is_org_admin"(p_organization_id uuid) FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."is_org_admin"(p_organization_id uuid) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."is_org_admin"(p_organization_id uuid) FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."is_org_admin"(p_organization_id uuid) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."is_org_admin"(p_organization_id uuid) FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."is_org_admin"(p_organization_id uuid) FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."is_platform_admin"() FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."is_platform_admin"() FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."is_platform_admin"() FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."is_platform_admin"() FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."is_platform_admin"() FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."is_platform_admin"() FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."is_platform_admin"() FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."is_platform_admin"() FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."job_part_file_set"(p_job_id uuid) FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."job_part_file_set"(p_job_id uuid) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."job_part_file_set"(p_job_id uuid) FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."job_part_file_set"(p_job_id uuid) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."job_part_file_set"(p_job_id uuid) FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."job_part_file_set"(p_job_id uuid) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."job_part_file_set"(p_job_id uuid) FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."job_part_file_set"(p_job_id uuid) FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."load_editable_project_part_context"(p_job_id uuid) FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."load_editable_project_part_context"(p_job_id uuid) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."load_editable_project_part_context"(p_job_id uuid) FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."load_editable_project_part_context"(p_job_id uuid) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."load_editable_project_part_context"(p_job_id uuid) FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."load_editable_project_part_context"(p_job_id uuid) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."load_editable_project_part_context"(p_job_id uuid) FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."load_editable_project_part_context"(p_job_id uuid) FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."log_audit_event"(p_organization_id uuid, p_event_type text, p_payload jsonb, p_job_id uuid, p_package_id uuid) FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."log_audit_event"(p_organization_id uuid, p_event_type text, p_payload jsonb, p_job_id uuid, p_package_id uuid) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."log_audit_event"(p_organization_id uuid, p_event_type text, p_payload jsonb, p_job_id uuid, p_package_id uuid) FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."log_audit_event"(p_organization_id uuid, p_event_type text, p_payload jsonb, p_job_id uuid, p_package_id uuid) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."log_audit_event"(p_organization_id uuid, p_event_type text, p_payload jsonb, p_job_id uuid, p_package_id uuid) FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."log_audit_event"(p_organization_id uuid, p_event_type text, p_payload jsonb, p_job_id uuid, p_package_id uuid) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."log_audit_event"(p_organization_id uuid, p_event_type text, p_payload jsonb, p_job_id uuid, p_package_id uuid) FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."log_audit_event"(p_organization_id uuid, p_event_type text, p_payload jsonb, p_job_id uuid, p_package_id uuid) FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."normalize_file_basename"(input_name text) FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."normalize_file_basename"(input_name text) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."normalize_file_basename"(input_name text) FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."normalize_file_basename"(input_name text) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."normalize_file_basename"(input_name text) FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."normalize_file_basename"(input_name text) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."normalize_file_basename"(input_name text) FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."normalize_file_basename"(input_name text) FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."normalize_positive_integer_array"(p_values integer[], p_fallback integer) FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."normalize_positive_integer_array"(p_values integer[], p_fallback integer) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."normalize_positive_integer_array"(p_values integer[], p_fallback integer) FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."normalize_positive_integer_array"(p_values integer[], p_fallback integer) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."normalize_positive_integer_array"(p_values integer[], p_fallback integer) FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."normalize_positive_integer_array"(p_values integer[], p_fallback integer) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."normalize_positive_integer_array"(p_values integer[], p_fallback integer) FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."normalize_positive_integer_array"(p_values integer[], p_fallback integer) FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."normalize_primary_service_kind"(p_requested_service_kinds text[], p_primary_service_kind text) FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."normalize_primary_service_kind"(p_requested_service_kinds text[], p_primary_service_kind text) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."normalize_primary_service_kind"(p_requested_service_kinds text[], p_primary_service_kind text) FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."normalize_primary_service_kind"(p_requested_service_kinds text[], p_primary_service_kind text) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."normalize_primary_service_kind"(p_requested_service_kinds text[], p_primary_service_kind text) FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."normalize_primary_service_kind"(p_requested_service_kinds text[], p_primary_service_kind text) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."normalize_primary_service_kind"(p_requested_service_kinds text[], p_primary_service_kind text) FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."normalize_primary_service_kind"(p_requested_service_kinds text[], p_primary_service_kind text) FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."normalize_project_part_threads"(p_extraction jsonb) FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."normalize_project_part_threads"(p_extraction jsonb) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."normalize_project_part_threads"(p_extraction jsonb) FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."normalize_project_part_threads"(p_extraction jsonb) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."normalize_project_part_threads"(p_extraction jsonb) FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."normalize_project_part_threads"(p_extraction jsonb) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."normalize_project_part_threads"(p_extraction jsonb) FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."normalize_project_part_threads"(p_extraction jsonb) FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."normalize_requested_service_kinds"(p_requested_service_kinds text[], p_primary_service_kind text) FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."normalize_requested_service_kinds"(p_requested_service_kinds text[], p_primary_service_kind text) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."normalize_requested_service_kinds"(p_requested_service_kinds text[], p_primary_service_kind text) FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."normalize_requested_service_kinds"(p_requested_service_kinds text[], p_primary_service_kind text) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."normalize_requested_service_kinds"(p_requested_service_kinds text[], p_primary_service_kind text) FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."normalize_requested_service_kinds"(p_requested_service_kinds text[], p_primary_service_kind text) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."normalize_requested_service_kinds"(p_requested_service_kinds text[], p_primary_service_kind text) FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."normalize_requested_service_kinds"(p_requested_service_kinds text[], p_primary_service_kind text) FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."require_verified_auth"() FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."require_verified_auth"() FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."require_verified_auth"() FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."require_verified_auth"() FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."require_verified_auth"() FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."require_verified_auth"() FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."require_verified_auth"() FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."require_verified_auth"() FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."resolve_project_part_property_values"(p_defaults jsonb, p_overrides jsonb) FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."resolve_project_part_property_values"(p_defaults jsonb, p_overrides jsonb) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."resolve_project_part_property_values"(p_defaults jsonb, p_overrides jsonb) FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."resolve_project_part_property_values"(p_defaults jsonb, p_overrides jsonb) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."resolve_project_part_property_values"(p_defaults jsonb, p_overrides jsonb) FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."resolve_project_part_property_values"(p_defaults jsonb, p_overrides jsonb) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."resolve_project_part_property_values"(p_defaults jsonb, p_overrides jsonb) FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."resolve_project_part_property_values"(p_defaults jsonb, p_overrides jsonb) FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."seed_project_part_property_defaults"(p_requirement approved_part_requirements, p_extraction jsonb, p_defaults jsonb) FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."seed_project_part_property_defaults"(p_requirement approved_part_requirements, p_extraction jsonb, p_defaults jsonb) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."seed_project_part_property_defaults"(p_requirement approved_part_requirements, p_extraction jsonb, p_defaults jsonb) FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."seed_project_part_property_defaults"(p_requirement approved_part_requirements, p_extraction jsonb, p_defaults jsonb) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."seed_project_part_property_defaults"(p_requirement approved_part_requirements, p_extraction jsonb, p_defaults jsonb) FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."seed_project_part_property_defaults"(p_requirement approved_part_requirements, p_extraction jsonb, p_defaults jsonb) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."seed_project_part_property_defaults"(p_requirement approved_part_requirements, p_extraction jsonb, p_defaults jsonb) FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."seed_project_part_property_defaults"(p_requirement approved_part_requirements, p_extraction jsonb, p_defaults jsonb) FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."seed_revision_and_process_property_defaults"(p_requirement approved_part_requirements, p_extraction jsonb, p_defaults jsonb) FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."seed_revision_and_process_property_defaults"(p_requirement approved_part_requirements, p_extraction jsonb, p_defaults jsonb) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."seed_revision_and_process_property_defaults"(p_requirement approved_part_requirements, p_extraction jsonb, p_defaults jsonb) FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."seed_revision_and_process_property_defaults"(p_requirement approved_part_requirements, p_extraction jsonb, p_defaults jsonb) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."seed_revision_and_process_property_defaults"(p_requirement approved_part_requirements, p_extraction jsonb, p_defaults jsonb) FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."seed_revision_and_process_property_defaults"(p_requirement approved_part_requirements, p_extraction jsonb, p_defaults jsonb) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."seed_revision_and_process_property_defaults"(p_requirement approved_part_requirements, p_extraction jsonb, p_defaults jsonb) FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."seed_revision_and_process_property_defaults"(p_requirement approved_part_requirements, p_extraction jsonb, p_defaults jsonb) FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."spend_default_daily_ceiling_usd"() FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."spend_default_daily_ceiling_usd"() FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."spend_default_daily_ceiling_usd"() FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."spend_default_daily_ceiling_usd"() FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."spend_default_daily_ceiling_usd"() FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."spend_default_daily_ceiling_usd"() FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."spend_default_daily_ceiling_usd"() FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."spend_default_daily_ceiling_usd"() FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."spend_default_per_run_ceiling_usd"() FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."spend_default_per_run_ceiling_usd"() FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."spend_default_per_run_ceiling_usd"() FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."spend_default_per_run_ceiling_usd"() FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."spend_default_per_run_ceiling_usd"() FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."spend_default_per_run_ceiling_usd"() FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."spend_default_per_run_ceiling_usd"() FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."spend_default_per_run_ceiling_usd"() FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."sync_quote_request_status_from_vendor_result"() FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."sync_quote_request_status_from_vendor_result"() FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."sync_quote_request_status_from_vendor_result"() FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."sync_quote_request_status_from_vendor_result"() FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."sync_quote_request_status_from_vendor_result"() FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."sync_quote_request_status_from_vendor_result"() FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."sync_quote_request_status_from_vendor_result"() FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."sync_quote_request_status_from_vendor_result"() FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."sync_service_request_line_item_status_from_quote_request"() FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."sync_service_request_line_item_status_from_quote_request"() FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."sync_service_request_line_item_status_from_quote_request"() FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."sync_service_request_line_item_status_from_quote_request"() FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."sync_service_request_line_item_status_from_quote_request"() FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."sync_service_request_line_item_status_from_quote_request"() FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."sync_service_request_line_item_status_from_quote_request"() FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."sync_service_request_line_item_status_from_quote_request"() FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."to_vendor_name_array"(payload jsonb) FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."to_vendor_name_array"(payload jsonb) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."to_vendor_name_array"(payload jsonb) FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."to_vendor_name_array"(payload jsonb) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."to_vendor_name_array"(payload jsonb) FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."to_vendor_name_array"(payload jsonb) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."to_vendor_name_array"(payload jsonb) FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."to_vendor_name_array"(payload jsonb) FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."touch_updated_at"() FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."touch_updated_at"() FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."touch_updated_at"() FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."touch_updated_at"() FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."touch_updated_at"() FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."touch_updated_at"() FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."touch_updated_at"() FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."touch_updated_at"() FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."user_can_access_job_via_project"(p_job_id uuid) FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."user_can_access_job_via_project"(p_job_id uuid) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."user_can_access_job_via_project"(p_job_id uuid) FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."user_can_access_job_via_project"(p_job_id uuid) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."user_can_access_job_via_project"(p_job_id uuid) FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."user_can_access_job_via_project"(p_job_id uuid) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."user_can_access_job_via_project"(p_job_id uuid) FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."user_can_access_job_via_project"(p_job_id uuid) FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."user_can_access_job"(p_job_id uuid) FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."user_can_access_job"(p_job_id uuid) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."user_can_access_job"(p_job_id uuid) FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."user_can_access_job"(p_job_id uuid) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."user_can_access_job"(p_job_id uuid) FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."user_can_access_job"(p_job_id uuid) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."user_can_access_job"(p_job_id uuid) FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."user_can_access_job"(p_job_id uuid) FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."user_can_access_org"(p_organization_id uuid) FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."user_can_access_org"(p_organization_id uuid) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."user_can_access_org"(p_organization_id uuid) FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."user_can_access_org"(p_organization_id uuid) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."user_can_access_org"(p_organization_id uuid) FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."user_can_access_org"(p_organization_id uuid) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."user_can_access_org"(p_organization_id uuid) FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."user_can_access_org"(p_organization_id uuid) FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."user_can_access_package"(p_package_id uuid) FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."user_can_access_package"(p_package_id uuid) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."user_can_access_package"(p_package_id uuid) FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."user_can_access_package"(p_package_id uuid) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."user_can_access_package"(p_package_id uuid) FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."user_can_access_package"(p_package_id uuid) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."user_can_access_package"(p_package_id uuid) FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."user_can_access_package"(p_package_id uuid) FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."user_can_access_project"(p_project_id uuid) FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."user_can_access_project"(p_project_id uuid) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."user_can_access_project"(p_project_id uuid) FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."user_can_access_project"(p_project_id uuid) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."user_can_access_project"(p_project_id uuid) FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."user_can_access_project"(p_project_id uuid) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."user_can_access_project"(p_project_id uuid) FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."user_can_access_project"(p_project_id uuid) FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."user_can_destructively_edit_job"(p_job_id uuid) FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."user_can_destructively_edit_job"(p_job_id uuid) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."user_can_destructively_edit_job"(p_job_id uuid) FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."user_can_destructively_edit_job"(p_job_id uuid) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."user_can_destructively_edit_job"(p_job_id uuid) FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."user_can_destructively_edit_job"(p_job_id uuid) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."user_can_destructively_edit_job"(p_job_id uuid) FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."user_can_destructively_edit_job"(p_job_id uuid) FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."user_can_edit_job"(p_job_id uuid) FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."user_can_edit_job"(p_job_id uuid) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."user_can_edit_job"(p_job_id uuid) FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."user_can_edit_job"(p_job_id uuid) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."user_can_edit_job"(p_job_id uuid) FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."user_can_edit_job"(p_job_id uuid) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."user_can_edit_job"(p_job_id uuid) FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."user_can_edit_job"(p_job_id uuid) FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."user_can_edit_project"(p_project_id uuid) FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."user_can_edit_project"(p_project_id uuid) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."user_can_edit_project"(p_project_id uuid) FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."user_can_edit_project"(p_project_id uuid) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."user_can_edit_project"(p_project_id uuid) FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."user_can_edit_project"(p_project_id uuid) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."user_can_edit_project"(p_project_id uuid) FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."user_can_edit_project"(p_project_id uuid) FROM "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "public"."user_is_project_owner"(p_project_id uuid) FROM "authenticator";
REVOKE EXECUTE ON FUNCTION "public"."user_is_project_owner"(p_project_id uuid) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "public"."user_is_project_owner"(p_project_id uuid) FROM "supabase_auth_admin";
REVOKE EXECUTE ON FUNCTION "public"."user_is_project_owner"(p_project_id uuid) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "public"."user_is_project_owner"(p_project_id uuid) FROM "supabase_privileged_role";
REVOKE EXECUTE ON FUNCTION "public"."user_is_project_owner"(p_project_id uuid) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "public"."user_is_project_owner"(p_project_id uuid) FROM "supabase_replication_admin";
REVOKE EXECUTE ON FUNCTION "public"."user_is_project_owner"(p_project_id uuid) FROM "supabase_storage_admin";
reset role;
set role "supabase_storage_admin";
REVOKE EXECUTE ON FUNCTION "storage"."can_insert_object"(bucketid text, name text, owner uuid, metadata jsonb) FROM "anon";
REVOKE EXECUTE ON FUNCTION "storage"."can_insert_object"(bucketid text, name text, owner uuid, metadata jsonb) FROM "authenticated";
REVOKE EXECUTE ON FUNCTION "storage"."can_insert_object"(bucketid text, name text, owner uuid, metadata jsonb) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "storage"."can_insert_object"(bucketid text, name text, owner uuid, metadata jsonb) FROM "postgres";
REVOKE EXECUTE ON FUNCTION "storage"."can_insert_object"(bucketid text, name text, owner uuid, metadata jsonb) FROM "service_role";
REVOKE EXECUTE ON FUNCTION "storage"."can_insert_object"(bucketid text, name text, owner uuid, metadata jsonb) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "storage"."can_insert_object"(bucketid text, name text, owner uuid, metadata jsonb) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "storage"."delete_leaf_prefixes"(bucket_ids text[], names text[]) FROM "anon";
REVOKE EXECUTE ON FUNCTION "storage"."delete_leaf_prefixes"(bucket_ids text[], names text[]) FROM "authenticated";
REVOKE EXECUTE ON FUNCTION "storage"."delete_leaf_prefixes"(bucket_ids text[], names text[]) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "storage"."delete_leaf_prefixes"(bucket_ids text[], names text[]) FROM "postgres";
REVOKE EXECUTE ON FUNCTION "storage"."delete_leaf_prefixes"(bucket_ids text[], names text[]) FROM "service_role";
REVOKE EXECUTE ON FUNCTION "storage"."delete_leaf_prefixes"(bucket_ids text[], names text[]) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "storage"."delete_leaf_prefixes"(bucket_ids text[], names text[]) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "storage"."enforce_bucket_name_length"() FROM "anon";
REVOKE EXECUTE ON FUNCTION "storage"."enforce_bucket_name_length"() FROM "authenticated";
REVOKE EXECUTE ON FUNCTION "storage"."enforce_bucket_name_length"() FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "storage"."enforce_bucket_name_length"() FROM "postgres";
REVOKE EXECUTE ON FUNCTION "storage"."enforce_bucket_name_length"() FROM "service_role";
REVOKE EXECUTE ON FUNCTION "storage"."enforce_bucket_name_length"() FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "storage"."enforce_bucket_name_length"() FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "storage"."extension"(name text) FROM "anon";
REVOKE EXECUTE ON FUNCTION "storage"."extension"(name text) FROM "authenticated";
REVOKE EXECUTE ON FUNCTION "storage"."extension"(name text) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "storage"."extension"(name text) FROM "postgres";
REVOKE EXECUTE ON FUNCTION "storage"."extension"(name text) FROM "service_role";
REVOKE EXECUTE ON FUNCTION "storage"."extension"(name text) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "storage"."extension"(name text) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "storage"."filename"(name text) FROM "anon";
REVOKE EXECUTE ON FUNCTION "storage"."filename"(name text) FROM "authenticated";
REVOKE EXECUTE ON FUNCTION "storage"."filename"(name text) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "storage"."filename"(name text) FROM "postgres";
REVOKE EXECUTE ON FUNCTION "storage"."filename"(name text) FROM "service_role";
REVOKE EXECUTE ON FUNCTION "storage"."filename"(name text) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "storage"."filename"(name text) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "storage"."foldername"(name text) FROM "anon";
REVOKE EXECUTE ON FUNCTION "storage"."foldername"(name text) FROM "authenticated";
REVOKE EXECUTE ON FUNCTION "storage"."foldername"(name text) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "storage"."foldername"(name text) FROM "postgres";
REVOKE EXECUTE ON FUNCTION "storage"."foldername"(name text) FROM "service_role";
REVOKE EXECUTE ON FUNCTION "storage"."foldername"(name text) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "storage"."foldername"(name text) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "storage"."get_common_prefix"(p_key text, p_prefix text, p_delimiter text) FROM "anon";
REVOKE EXECUTE ON FUNCTION "storage"."get_common_prefix"(p_key text, p_prefix text, p_delimiter text) FROM "authenticated";
REVOKE EXECUTE ON FUNCTION "storage"."get_common_prefix"(p_key text, p_prefix text, p_delimiter text) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "storage"."get_common_prefix"(p_key text, p_prefix text, p_delimiter text) FROM "postgres";
REVOKE EXECUTE ON FUNCTION "storage"."get_common_prefix"(p_key text, p_prefix text, p_delimiter text) FROM "service_role";
REVOKE EXECUTE ON FUNCTION "storage"."get_common_prefix"(p_key text, p_prefix text, p_delimiter text) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "storage"."get_common_prefix"(p_key text, p_prefix text, p_delimiter text) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "storage"."get_level"(name text) FROM "anon";
REVOKE EXECUTE ON FUNCTION "storage"."get_level"(name text) FROM "authenticated";
REVOKE EXECUTE ON FUNCTION "storage"."get_level"(name text) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "storage"."get_level"(name text) FROM "postgres";
REVOKE EXECUTE ON FUNCTION "storage"."get_level"(name text) FROM "service_role";
REVOKE EXECUTE ON FUNCTION "storage"."get_level"(name text) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "storage"."get_level"(name text) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "storage"."get_prefix"(name text) FROM "anon";
REVOKE EXECUTE ON FUNCTION "storage"."get_prefix"(name text) FROM "authenticated";
REVOKE EXECUTE ON FUNCTION "storage"."get_prefix"(name text) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "storage"."get_prefix"(name text) FROM "postgres";
REVOKE EXECUTE ON FUNCTION "storage"."get_prefix"(name text) FROM "service_role";
REVOKE EXECUTE ON FUNCTION "storage"."get_prefix"(name text) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "storage"."get_prefix"(name text) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "storage"."get_prefixes"(name text) FROM "anon";
REVOKE EXECUTE ON FUNCTION "storage"."get_prefixes"(name text) FROM "authenticated";
REVOKE EXECUTE ON FUNCTION "storage"."get_prefixes"(name text) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "storage"."get_prefixes"(name text) FROM "postgres";
REVOKE EXECUTE ON FUNCTION "storage"."get_prefixes"(name text) FROM "service_role";
REVOKE EXECUTE ON FUNCTION "storage"."get_prefixes"(name text) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "storage"."get_prefixes"(name text) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "storage"."get_size_by_bucket"() FROM "anon";
REVOKE EXECUTE ON FUNCTION "storage"."get_size_by_bucket"() FROM "authenticated";
REVOKE EXECUTE ON FUNCTION "storage"."get_size_by_bucket"() FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "storage"."get_size_by_bucket"() FROM "postgres";
REVOKE EXECUTE ON FUNCTION "storage"."get_size_by_bucket"() FROM "service_role";
REVOKE EXECUTE ON FUNCTION "storage"."get_size_by_bucket"() FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "storage"."get_size_by_bucket"() FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "storage"."list_multipart_uploads_with_delimiter"(bucket_id text, prefix_param text, delimiter_param text, max_keys integer, next_key_token text, next_upload_token text) FROM "anon";
REVOKE EXECUTE ON FUNCTION "storage"."list_multipart_uploads_with_delimiter"(bucket_id text, prefix_param text, delimiter_param text, max_keys integer, next_key_token text, next_upload_token text) FROM "authenticated";
REVOKE EXECUTE ON FUNCTION "storage"."list_multipart_uploads_with_delimiter"(bucket_id text, prefix_param text, delimiter_param text, max_keys integer, next_key_token text, next_upload_token text) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "storage"."list_multipart_uploads_with_delimiter"(bucket_id text, prefix_param text, delimiter_param text, max_keys integer, next_key_token text, next_upload_token text) FROM "postgres";
REVOKE EXECUTE ON FUNCTION "storage"."list_multipart_uploads_with_delimiter"(bucket_id text, prefix_param text, delimiter_param text, max_keys integer, next_key_token text, next_upload_token text) FROM "service_role";
REVOKE EXECUTE ON FUNCTION "storage"."list_multipart_uploads_with_delimiter"(bucket_id text, prefix_param text, delimiter_param text, max_keys integer, next_key_token text, next_upload_token text) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "storage"."list_multipart_uploads_with_delimiter"(bucket_id text, prefix_param text, delimiter_param text, max_keys integer, next_key_token text, next_upload_token text) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "storage"."list_objects_with_delimiter"(_bucket_id text, prefix_param text, delimiter_param text, max_keys integer, start_after text, next_token text, sort_order text) FROM "anon";
REVOKE EXECUTE ON FUNCTION "storage"."list_objects_with_delimiter"(_bucket_id text, prefix_param text, delimiter_param text, max_keys integer, start_after text, next_token text, sort_order text) FROM "authenticated";
REVOKE EXECUTE ON FUNCTION "storage"."list_objects_with_delimiter"(_bucket_id text, prefix_param text, delimiter_param text, max_keys integer, start_after text, next_token text, sort_order text) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "storage"."list_objects_with_delimiter"(_bucket_id text, prefix_param text, delimiter_param text, max_keys integer, start_after text, next_token text, sort_order text) FROM "postgres";
REVOKE EXECUTE ON FUNCTION "storage"."list_objects_with_delimiter"(_bucket_id text, prefix_param text, delimiter_param text, max_keys integer, start_after text, next_token text, sort_order text) FROM "service_role";
REVOKE EXECUTE ON FUNCTION "storage"."list_objects_with_delimiter"(_bucket_id text, prefix_param text, delimiter_param text, max_keys integer, start_after text, next_token text, sort_order text) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "storage"."list_objects_with_delimiter"(_bucket_id text, prefix_param text, delimiter_param text, max_keys integer, start_after text, next_token text, sort_order text) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "storage"."operation"() FROM "anon";
REVOKE EXECUTE ON FUNCTION "storage"."operation"() FROM "authenticated";
REVOKE EXECUTE ON FUNCTION "storage"."operation"() FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "storage"."operation"() FROM "postgres";
REVOKE EXECUTE ON FUNCTION "storage"."operation"() FROM "service_role";
REVOKE EXECUTE ON FUNCTION "storage"."operation"() FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "storage"."operation"() FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "storage"."protect_delete"() FROM "anon";
REVOKE EXECUTE ON FUNCTION "storage"."protect_delete"() FROM "authenticated";
REVOKE EXECUTE ON FUNCTION "storage"."protect_delete"() FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "storage"."protect_delete"() FROM "postgres";
REVOKE EXECUTE ON FUNCTION "storage"."protect_delete"() FROM "service_role";
REVOKE EXECUTE ON FUNCTION "storage"."protect_delete"() FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "storage"."protect_delete"() FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "storage"."search_by_timestamp"(p_prefix text, p_bucket_id text, p_limit integer, p_level integer, p_start_after text, p_sort_order text, p_sort_column text, p_sort_column_after text) FROM "anon";
REVOKE EXECUTE ON FUNCTION "storage"."search_by_timestamp"(p_prefix text, p_bucket_id text, p_limit integer, p_level integer, p_start_after text, p_sort_order text, p_sort_column text, p_sort_column_after text) FROM "authenticated";
REVOKE EXECUTE ON FUNCTION "storage"."search_by_timestamp"(p_prefix text, p_bucket_id text, p_limit integer, p_level integer, p_start_after text, p_sort_order text, p_sort_column text, p_sort_column_after text) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "storage"."search_by_timestamp"(p_prefix text, p_bucket_id text, p_limit integer, p_level integer, p_start_after text, p_sort_order text, p_sort_column text, p_sort_column_after text) FROM "postgres";
REVOKE EXECUTE ON FUNCTION "storage"."search_by_timestamp"(p_prefix text, p_bucket_id text, p_limit integer, p_level integer, p_start_after text, p_sort_order text, p_sort_column text, p_sort_column_after text) FROM "service_role";
REVOKE EXECUTE ON FUNCTION "storage"."search_by_timestamp"(p_prefix text, p_bucket_id text, p_limit integer, p_level integer, p_start_after text, p_sort_order text, p_sort_column text, p_sort_column_after text) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "storage"."search_by_timestamp"(p_prefix text, p_bucket_id text, p_limit integer, p_level integer, p_start_after text, p_sort_order text, p_sort_column text, p_sort_column_after text) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "storage"."search_legacy_v1"(prefix text, bucketname text, limits integer, levels integer, offsets integer, search text, sortcolumn text, sortorder text) FROM "anon";
REVOKE EXECUTE ON FUNCTION "storage"."search_legacy_v1"(prefix text, bucketname text, limits integer, levels integer, offsets integer, search text, sortcolumn text, sortorder text) FROM "authenticated";
REVOKE EXECUTE ON FUNCTION "storage"."search_legacy_v1"(prefix text, bucketname text, limits integer, levels integer, offsets integer, search text, sortcolumn text, sortorder text) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "storage"."search_legacy_v1"(prefix text, bucketname text, limits integer, levels integer, offsets integer, search text, sortcolumn text, sortorder text) FROM "postgres";
REVOKE EXECUTE ON FUNCTION "storage"."search_legacy_v1"(prefix text, bucketname text, limits integer, levels integer, offsets integer, search text, sortcolumn text, sortorder text) FROM "service_role";
REVOKE EXECUTE ON FUNCTION "storage"."search_legacy_v1"(prefix text, bucketname text, limits integer, levels integer, offsets integer, search text, sortcolumn text, sortorder text) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "storage"."search_legacy_v1"(prefix text, bucketname text, limits integer, levels integer, offsets integer, search text, sortcolumn text, sortorder text) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "storage"."search_v2"(prefix text, bucket_name text, limits integer, levels integer, start_after text, sort_order text, sort_column text, sort_column_after text) FROM "anon";
REVOKE EXECUTE ON FUNCTION "storage"."search_v2"(prefix text, bucket_name text, limits integer, levels integer, start_after text, sort_order text, sort_column text, sort_column_after text) FROM "authenticated";
REVOKE EXECUTE ON FUNCTION "storage"."search_v2"(prefix text, bucket_name text, limits integer, levels integer, start_after text, sort_order text, sort_column text, sort_column_after text) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "storage"."search_v2"(prefix text, bucket_name text, limits integer, levels integer, start_after text, sort_order text, sort_column text, sort_column_after text) FROM "postgres";
REVOKE EXECUTE ON FUNCTION "storage"."search_v2"(prefix text, bucket_name text, limits integer, levels integer, start_after text, sort_order text, sort_column text, sort_column_after text) FROM "service_role";
REVOKE EXECUTE ON FUNCTION "storage"."search_v2"(prefix text, bucket_name text, limits integer, levels integer, start_after text, sort_order text, sort_column text, sort_column_after text) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "storage"."search_v2"(prefix text, bucket_name text, limits integer, levels integer, start_after text, sort_order text, sort_column text, sort_column_after text) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "storage"."search"(prefix text, bucketname text, limits integer, levels integer, offsets integer, search text, sortcolumn text, sortorder text) FROM "anon";
REVOKE EXECUTE ON FUNCTION "storage"."search"(prefix text, bucketname text, limits integer, levels integer, offsets integer, search text, sortcolumn text, sortorder text) FROM "authenticated";
REVOKE EXECUTE ON FUNCTION "storage"."search"(prefix text, bucketname text, limits integer, levels integer, offsets integer, search text, sortcolumn text, sortorder text) FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "storage"."search"(prefix text, bucketname text, limits integer, levels integer, offsets integer, search text, sortcolumn text, sortorder text) FROM "postgres";
REVOKE EXECUTE ON FUNCTION "storage"."search"(prefix text, bucketname text, limits integer, levels integer, offsets integer, search text, sortcolumn text, sortorder text) FROM "service_role";
REVOKE EXECUTE ON FUNCTION "storage"."search"(prefix text, bucketname text, limits integer, levels integer, offsets integer, search text, sortcolumn text, sortorder text) FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "storage"."search"(prefix text, bucketname text, limits integer, levels integer, offsets integer, search text, sortcolumn text, sortorder text) FROM "supabase_read_only_user";
REVOKE EXECUTE ON FUNCTION "storage"."update_updated_at_column"() FROM "anon";
REVOKE EXECUTE ON FUNCTION "storage"."update_updated_at_column"() FROM "authenticated";
REVOKE EXECUTE ON FUNCTION "storage"."update_updated_at_column"() FROM "dashboard_user";
REVOKE EXECUTE ON FUNCTION "storage"."update_updated_at_column"() FROM "postgres";
REVOKE EXECUTE ON FUNCTION "storage"."update_updated_at_column"() FROM "service_role";
REVOKE EXECUTE ON FUNCTION "storage"."update_updated_at_column"() FROM "supabase_etl_admin";
REVOKE EXECUTE ON FUNCTION "storage"."update_updated_at_column"() FROM "supabase_read_only_user";
reset role;
set role "postgres";
revoke execute on function "public"."api_accept_project_invite"(p_token text) from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."api_accept_project_invite"(p_token text) to public;
grant execute on function "public"."api_accept_project_invite"(p_token text) to postgres;
grant execute on function "public"."api_accept_project_invite"(p_token text) to anon;
grant execute on function "public"."api_accept_project_invite"(p_token text) to authenticated;
grant execute on function "public"."api_accept_project_invite"(p_token text) to service_role;
revoke execute on function "public"."api_admin_list_all_jobs"() from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."api_admin_list_all_jobs"() to public;
grant execute on function "public"."api_admin_list_all_jobs"() to postgres;
grant execute on function "public"."api_admin_list_all_jobs"() to anon;
grant execute on function "public"."api_admin_list_all_jobs"() to authenticated;
grant execute on function "public"."api_admin_list_all_jobs"() to service_role;
revoke execute on function "public"."api_admin_list_all_projects"() from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."api_admin_list_all_projects"() to public;
grant execute on function "public"."api_admin_list_all_projects"() to postgres;
grant execute on function "public"."api_admin_list_all_projects"() to anon;
grant execute on function "public"."api_admin_list_all_projects"() to authenticated;
grant execute on function "public"."api_admin_list_all_projects"() to service_role;
revoke execute on function "public"."api_admin_list_all_users"() from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."api_admin_list_all_users"() to public;
grant execute on function "public"."api_admin_list_all_users"() to postgres;
grant execute on function "public"."api_admin_list_all_users"() to anon;
grant execute on function "public"."api_admin_list_all_users"() to authenticated;
grant execute on function "public"."api_admin_list_all_users"() to service_role;
revoke execute on function "public"."api_admin_list_organizations"() from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."api_admin_list_organizations"() to public;
grant execute on function "public"."api_admin_list_organizations"() to postgres;
grant execute on function "public"."api_admin_list_organizations"() to anon;
grant execute on function "public"."api_admin_list_organizations"() to authenticated;
grant execute on function "public"."api_admin_list_organizations"() to service_role;
revoke execute on function "public"."api_approve_job_requirements"(p_job_id uuid, p_requirements jsonb) from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."api_approve_job_requirements"(p_job_id uuid, p_requirements jsonb) to public;
grant execute on function "public"."api_approve_job_requirements"(p_job_id uuid, p_requirements jsonb) to postgres;
grant execute on function "public"."api_approve_job_requirements"(p_job_id uuid, p_requirements jsonb) to anon;
grant execute on function "public"."api_approve_job_requirements"(p_job_id uuid, p_requirements jsonb) to authenticated;
grant execute on function "public"."api_approve_job_requirements"(p_job_id uuid, p_requirements jsonb) to service_role;
revoke execute on function "public"."api_archive_job"(p_job_id uuid) from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."api_archive_job"(p_job_id uuid) to public;
grant execute on function "public"."api_archive_job"(p_job_id uuid) to postgres;
grant execute on function "public"."api_archive_job"(p_job_id uuid) to anon;
grant execute on function "public"."api_archive_job"(p_job_id uuid) to authenticated;
grant execute on function "public"."api_archive_job"(p_job_id uuid) to service_role;
revoke execute on function "public"."api_archive_project"(p_project_id uuid) from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."api_archive_project"(p_project_id uuid) to public;
grant execute on function "public"."api_archive_project"(p_project_id uuid) to postgres;
grant execute on function "public"."api_archive_project"(p_project_id uuid) to anon;
grant execute on function "public"."api_archive_project"(p_project_id uuid) to authenticated;
grant execute on function "public"."api_archive_project"(p_project_id uuid) to service_role;
revoke execute on function "public"."api_assign_job_to_project"(p_job_id uuid, p_project_id uuid) from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."api_assign_job_to_project"(p_job_id uuid, p_project_id uuid) to public;
grant execute on function "public"."api_assign_job_to_project"(p_job_id uuid, p_project_id uuid) to postgres;
grant execute on function "public"."api_assign_job_to_project"(p_job_id uuid, p_project_id uuid) to anon;
grant execute on function "public"."api_assign_job_to_project"(p_job_id uuid, p_project_id uuid) to authenticated;
grant execute on function "public"."api_assign_job_to_project"(p_job_id uuid, p_project_id uuid) to service_role;
revoke execute on function "public"."api_cancel_quote_request"(p_request_id uuid) from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."api_cancel_quote_request"(p_request_id uuid) to public;
grant execute on function "public"."api_cancel_quote_request"(p_request_id uuid) to postgres;
grant execute on function "public"."api_cancel_quote_request"(p_request_id uuid) to anon;
grant execute on function "public"."api_cancel_quote_request"(p_request_id uuid) to authenticated;
grant execute on function "public"."api_cancel_quote_request"(p_request_id uuid) to service_role;
revoke execute on function "public"."api_create_project"(p_name text, p_description text) from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."api_create_project"(p_name text, p_description text) to public;
grant execute on function "public"."api_create_project"(p_name text, p_description text) to postgres;
grant execute on function "public"."api_create_project"(p_name text, p_description text) to anon;
grant execute on function "public"."api_create_project"(p_name text, p_description text) to authenticated;
grant execute on function "public"."api_create_project"(p_name text, p_description text) to service_role;
revoke execute on function "public"."api_create_self_service_organization"(p_organization_name text) from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."api_create_self_service_organization"(p_organization_name text) to public;
grant execute on function "public"."api_create_self_service_organization"(p_organization_name text) to postgres;
grant execute on function "public"."api_create_self_service_organization"(p_organization_name text) to anon;
grant execute on function "public"."api_create_self_service_organization"(p_organization_name text) to authenticated;
grant execute on function "public"."api_create_self_service_organization"(p_organization_name text) to service_role;
revoke execute on function "public"."api_delete_archived_job"(p_job_id uuid) from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."api_delete_archived_job"(p_job_id uuid) to public;
grant execute on function "public"."api_delete_archived_job"(p_job_id uuid) to postgres;
grant execute on function "public"."api_delete_archived_job"(p_job_id uuid) to anon;
grant execute on function "public"."api_delete_archived_job"(p_job_id uuid) to authenticated;
grant execute on function "public"."api_delete_archived_job"(p_job_id uuid) to service_role;
revoke execute on function "public"."api_delete_archived_jobs"(p_job_ids uuid[]) from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."api_delete_archived_jobs"(p_job_ids uuid[]) to public;
grant execute on function "public"."api_delete_archived_jobs"(p_job_ids uuid[]) to postgres;
grant execute on function "public"."api_delete_archived_jobs"(p_job_ids uuid[]) to anon;
grant execute on function "public"."api_delete_archived_jobs"(p_job_ids uuid[]) to authenticated;
grant execute on function "public"."api_delete_archived_jobs"(p_job_ids uuid[]) to service_role;
revoke execute on function "public"."api_delete_project"(p_project_id uuid) from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."api_delete_project"(p_project_id uuid) to public;
grant execute on function "public"."api_delete_project"(p_project_id uuid) to postgres;
grant execute on function "public"."api_delete_project"(p_project_id uuid) to anon;
grant execute on function "public"."api_delete_project"(p_project_id uuid) to authenticated;
grant execute on function "public"."api_delete_project"(p_project_id uuid) to service_role;
revoke execute on function "public"."api_dissolve_project"(p_project_id uuid) from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."api_dissolve_project"(p_project_id uuid) to public;
grant execute on function "public"."api_dissolve_project"(p_project_id uuid) to postgres;
grant execute on function "public"."api_dissolve_project"(p_project_id uuid) to anon;
grant execute on function "public"."api_dissolve_project"(p_project_id uuid) to authenticated;
grant execute on function "public"."api_dissolve_project"(p_project_id uuid) to service_role;
revoke execute on function "public"."api_get_client_intake_compatibility"() from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."api_get_client_intake_compatibility"() to public;
grant execute on function "public"."api_get_client_intake_compatibility"() to postgres;
grant execute on function "public"."api_get_client_intake_compatibility"() to anon;
grant execute on function "public"."api_get_client_intake_compatibility"() to authenticated;
grant execute on function "public"."api_get_client_intake_compatibility"() to service_role;
revoke execute on function "public"."api_get_is_platform_admin"() from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."api_get_is_platform_admin"() to public;
grant execute on function "public"."api_get_is_platform_admin"() to postgres;
grant execute on function "public"."api_get_is_platform_admin"() to anon;
grant execute on function "public"."api_get_is_platform_admin"() to authenticated;
grant execute on function "public"."api_get_is_platform_admin"() to service_role;
revoke execute on function "public"."api_get_quote_run_readiness"(p_quote_run_id uuid) from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."api_get_quote_run_readiness"(p_quote_run_id uuid) to public;
grant execute on function "public"."api_get_quote_run_readiness"(p_quote_run_id uuid) to postgres;
grant execute on function "public"."api_get_quote_run_readiness"(p_quote_run_id uuid) to anon;
grant execute on function "public"."api_get_quote_run_readiness"(p_quote_run_id uuid) to authenticated;
grant execute on function "public"."api_get_quote_run_readiness"(p_quote_run_id uuid) to service_role;
revoke execute on function "public"."api_invite_project_member"(p_project_id uuid, p_email text, p_role project_role) from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."api_invite_project_member"(p_project_id uuid, p_email text, p_role project_role) to public;
grant execute on function "public"."api_invite_project_member"(p_project_id uuid, p_email text, p_role project_role) to postgres;
grant execute on function "public"."api_invite_project_member"(p_project_id uuid, p_email text, p_role project_role) to anon;
grant execute on function "public"."api_invite_project_member"(p_project_id uuid, p_email text, p_role project_role) to authenticated;
grant execute on function "public"."api_invite_project_member"(p_project_id uuid, p_email text, p_role project_role) to service_role;
revoke execute on function "public"."api_list_client_activity_events"(p_job_ids uuid[], p_limit_per_job integer) from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."api_list_client_activity_events"(p_job_ids uuid[], p_limit_per_job integer) to public;
grant execute on function "public"."api_list_client_activity_events"(p_job_ids uuid[], p_limit_per_job integer) to postgres;
grant execute on function "public"."api_list_client_activity_events"(p_job_ids uuid[], p_limit_per_job integer) to anon;
grant execute on function "public"."api_list_client_activity_events"(p_job_ids uuid[], p_limit_per_job integer) to authenticated;
grant execute on function "public"."api_list_client_activity_events"(p_job_ids uuid[], p_limit_per_job integer) to service_role;
revoke execute on function "public"."api_list_client_part_metadata"(p_job_ids uuid[]) from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."api_list_client_part_metadata"(p_job_ids uuid[]) to public;
grant execute on function "public"."api_list_client_part_metadata"(p_job_ids uuid[]) to postgres;
grant execute on function "public"."api_list_client_part_metadata"(p_job_ids uuid[]) to anon;
grant execute on function "public"."api_list_client_part_metadata"(p_job_ids uuid[]) to authenticated;
grant execute on function "public"."api_list_client_part_metadata"(p_job_ids uuid[]) to service_role;
revoke execute on function "public"."api_list_client_quote_workspace"(p_job_ids uuid[]) from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."api_list_client_quote_workspace"(p_job_ids uuid[]) to public;
grant execute on function "public"."api_list_client_quote_workspace"(p_job_ids uuid[]) to postgres;
grant execute on function "public"."api_list_client_quote_workspace"(p_job_ids uuid[]) to anon;
grant execute on function "public"."api_list_client_quote_workspace"(p_job_ids uuid[]) to authenticated;
grant execute on function "public"."api_list_client_quote_workspace"(p_job_ids uuid[]) to service_role;
revoke execute on function "public"."api_list_organization_memberships"(p_organization_id uuid) from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."api_list_organization_memberships"(p_organization_id uuid) to public;
grant execute on function "public"."api_list_organization_memberships"(p_organization_id uuid) to postgres;
grant execute on function "public"."api_list_organization_memberships"(p_organization_id uuid) to anon;
grant execute on function "public"."api_list_organization_memberships"(p_organization_id uuid) to authenticated;
grant execute on function "public"."api_list_organization_memberships"(p_organization_id uuid) to service_role;
revoke execute on function "public"."api_list_project_assignee_profiles"(p_project_id uuid) from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."api_list_project_assignee_profiles"(p_project_id uuid) to public;
grant execute on function "public"."api_list_project_assignee_profiles"(p_project_id uuid) to postgres;
grant execute on function "public"."api_list_project_assignee_profiles"(p_project_id uuid) to anon;
grant execute on function "public"."api_list_project_assignee_profiles"(p_project_id uuid) to authenticated;
grant execute on function "public"."api_list_project_assignee_profiles"(p_project_id uuid) to service_role;
revoke execute on function "public"."api_publish_quote_package"(p_job_id uuid, p_quote_run_id uuid, p_client_summary text, p_force boolean) from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."api_publish_quote_package"(p_job_id uuid, p_quote_run_id uuid, p_client_summary text, p_force boolean) to public;
grant execute on function "public"."api_publish_quote_package"(p_job_id uuid, p_quote_run_id uuid, p_client_summary text, p_force boolean) to postgres;
grant execute on function "public"."api_publish_quote_package"(p_job_id uuid, p_quote_run_id uuid, p_client_summary text, p_force boolean) to anon;
grant execute on function "public"."api_publish_quote_package"(p_job_id uuid, p_quote_run_id uuid, p_client_summary text, p_force boolean) to authenticated;
grant execute on function "public"."api_publish_quote_package"(p_job_id uuid, p_quote_run_id uuid, p_client_summary text, p_force boolean) to service_role;
revoke execute on function "public"."api_reconcile_job_parts"(p_job_id uuid) from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."api_reconcile_job_parts"(p_job_id uuid) to public;
grant execute on function "public"."api_reconcile_job_parts"(p_job_id uuid) to postgres;
grant execute on function "public"."api_reconcile_job_parts"(p_job_id uuid) to anon;
grant execute on function "public"."api_reconcile_job_parts"(p_job_id uuid) to authenticated;
grant execute on function "public"."api_reconcile_job_parts"(p_job_id uuid) to service_role;
revoke execute on function "public"."api_record_manual_vendor_quote"(p_job_id uuid, p_part_id uuid, p_vendor vendor_name, p_status vendor_status, p_summary_note text, p_source_text text, p_quote_url text, p_offers jsonb, p_artifacts jsonb) from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."api_record_manual_vendor_quote"(p_job_id uuid, p_part_id uuid, p_vendor vendor_name, p_status vendor_status, p_summary_note text, p_source_text text, p_quote_url text, p_offers jsonb, p_artifacts jsonb) to public;
grant execute on function "public"."api_record_manual_vendor_quote"(p_job_id uuid, p_part_id uuid, p_vendor vendor_name, p_status vendor_status, p_summary_note text, p_source_text text, p_quote_url text, p_offers jsonb, p_artifacts jsonb) to postgres;
grant execute on function "public"."api_record_manual_vendor_quote"(p_job_id uuid, p_part_id uuid, p_vendor vendor_name, p_status vendor_status, p_summary_note text, p_source_text text, p_quote_url text, p_offers jsonb, p_artifacts jsonb) to anon;
grant execute on function "public"."api_record_manual_vendor_quote"(p_job_id uuid, p_part_id uuid, p_vendor vendor_name, p_status vendor_status, p_summary_note text, p_source_text text, p_quote_url text, p_offers jsonb, p_artifacts jsonb) to authenticated;
grant execute on function "public"."api_record_manual_vendor_quote"(p_job_id uuid, p_part_id uuid, p_vendor vendor_name, p_status vendor_status, p_summary_note text, p_source_text text, p_quote_url text, p_offers jsonb, p_artifacts jsonb) to service_role;
revoke execute on function "public"."api_remove_job_from_project"(p_job_id uuid, p_project_id uuid) from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."api_remove_job_from_project"(p_job_id uuid, p_project_id uuid) to public;
grant execute on function "public"."api_remove_job_from_project"(p_job_id uuid, p_project_id uuid) to postgres;
grant execute on function "public"."api_remove_job_from_project"(p_job_id uuid, p_project_id uuid) to anon;
grant execute on function "public"."api_remove_job_from_project"(p_job_id uuid, p_project_id uuid) to authenticated;
grant execute on function "public"."api_remove_job_from_project"(p_job_id uuid, p_project_id uuid) to service_role;
revoke execute on function "public"."api_remove_project_member"(p_project_membership_id uuid) from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."api_remove_project_member"(p_project_membership_id uuid) to public;
grant execute on function "public"."api_remove_project_member"(p_project_membership_id uuid) to postgres;
grant execute on function "public"."api_remove_project_member"(p_project_membership_id uuid) to anon;
grant execute on function "public"."api_remove_project_member"(p_project_membership_id uuid) to authenticated;
grant execute on function "public"."api_remove_project_member"(p_project_membership_id uuid) to service_role;
revoke execute on function "public"."api_request_debug_extraction"(p_part_id uuid, p_model text) from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."api_request_debug_extraction"(p_part_id uuid, p_model text) to public;
grant execute on function "public"."api_request_debug_extraction"(p_part_id uuid, p_model text) to postgres;
grant execute on function "public"."api_request_debug_extraction"(p_part_id uuid, p_model text) to anon;
grant execute on function "public"."api_request_debug_extraction"(p_part_id uuid, p_model text) to authenticated;
grant execute on function "public"."api_request_debug_extraction"(p_part_id uuid, p_model text) to service_role;
revoke execute on function "public"."api_request_extraction"(p_job_id uuid) from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."api_request_extraction"(p_job_id uuid) to public;
grant execute on function "public"."api_request_extraction"(p_job_id uuid) to postgres;
grant execute on function "public"."api_request_extraction"(p_job_id uuid) to anon;
grant execute on function "public"."api_request_extraction"(p_job_id uuid) to authenticated;
grant execute on function "public"."api_request_extraction"(p_job_id uuid) to service_role;
revoke execute on function "public"."api_reset_client_part_property_overrides"(p_job_id uuid, p_fields text[]) from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."api_reset_client_part_property_overrides"(p_job_id uuid, p_fields text[]) to public;
grant execute on function "public"."api_reset_client_part_property_overrides"(p_job_id uuid, p_fields text[]) to postgres;
grant execute on function "public"."api_reset_client_part_property_overrides"(p_job_id uuid, p_fields text[]) to anon;
grant execute on function "public"."api_reset_client_part_property_overrides"(p_job_id uuid, p_fields text[]) to authenticated;
grant execute on function "public"."api_reset_client_part_property_overrides"(p_job_id uuid, p_fields text[]) to service_role;
revoke execute on function "public"."api_select_quote_option"(p_package_id uuid, p_option_id uuid, p_note text) from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."api_select_quote_option"(p_package_id uuid, p_option_id uuid, p_note text) to public;
grant execute on function "public"."api_select_quote_option"(p_package_id uuid, p_option_id uuid, p_note text) to postgres;
grant execute on function "public"."api_select_quote_option"(p_package_id uuid, p_option_id uuid, p_note text) to anon;
grant execute on function "public"."api_select_quote_option"(p_package_id uuid, p_option_id uuid, p_note text) to authenticated;
grant execute on function "public"."api_select_quote_option"(p_package_id uuid, p_option_id uuid, p_note text) to service_role;
revoke execute on function "public"."api_start_quote_run"(p_job_id uuid, p_auto_publish_requested boolean) from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."api_start_quote_run"(p_job_id uuid, p_auto_publish_requested boolean) to public;
grant execute on function "public"."api_start_quote_run"(p_job_id uuid, p_auto_publish_requested boolean) to postgres;
grant execute on function "public"."api_start_quote_run"(p_job_id uuid, p_auto_publish_requested boolean) to anon;
grant execute on function "public"."api_start_quote_run"(p_job_id uuid, p_auto_publish_requested boolean) to authenticated;
grant execute on function "public"."api_start_quote_run"(p_job_id uuid, p_auto_publish_requested boolean) to service_role;
revoke execute on function "public"."api_unarchive_job"(p_job_id uuid) from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."api_unarchive_job"(p_job_id uuid) to public;
grant execute on function "public"."api_unarchive_job"(p_job_id uuid) to postgres;
grant execute on function "public"."api_unarchive_job"(p_job_id uuid) to anon;
grant execute on function "public"."api_unarchive_job"(p_job_id uuid) to authenticated;
grant execute on function "public"."api_unarchive_job"(p_job_id uuid) to service_role;
revoke execute on function "public"."api_unarchive_project"(p_project_id uuid) from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."api_unarchive_project"(p_project_id uuid) to public;
grant execute on function "public"."api_unarchive_project"(p_project_id uuid) to postgres;
grant execute on function "public"."api_unarchive_project"(p_project_id uuid) to anon;
grant execute on function "public"."api_unarchive_project"(p_project_id uuid) to authenticated;
grant execute on function "public"."api_unarchive_project"(p_project_id uuid) to service_role;
revoke execute on function "public"."api_update_client_part_request"(p_job_id uuid, p_requested_service_kinds text[], p_primary_service_kind text, p_service_notes text, p_description text, p_part_number text, p_revision text, p_material text, p_finish text, p_threads text, p_tightest_tolerance_inch numeric, p_process text, p_notes text, p_quantity integer, p_requested_quote_quantities integer[], p_requested_by_date date, p_shipping jsonb, p_certifications jsonb, p_sourcing jsonb, p_release jsonb) from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."api_update_client_part_request"(p_job_id uuid, p_requested_service_kinds text[], p_primary_service_kind text, p_service_notes text, p_description text, p_part_number text, p_revision text, p_material text, p_finish text, p_threads text, p_tightest_tolerance_inch numeric, p_process text, p_notes text, p_quantity integer, p_requested_quote_quantities integer[], p_requested_by_date date, p_shipping jsonb, p_certifications jsonb, p_sourcing jsonb, p_release jsonb) to public;
grant execute on function "public"."api_update_client_part_request"(p_job_id uuid, p_requested_service_kinds text[], p_primary_service_kind text, p_service_notes text, p_description text, p_part_number text, p_revision text, p_material text, p_finish text, p_threads text, p_tightest_tolerance_inch numeric, p_process text, p_notes text, p_quantity integer, p_requested_quote_quantities integer[], p_requested_by_date date, p_shipping jsonb, p_certifications jsonb, p_sourcing jsonb, p_release jsonb) to postgres;
grant execute on function "public"."api_update_client_part_request"(p_job_id uuid, p_requested_service_kinds text[], p_primary_service_kind text, p_service_notes text, p_description text, p_part_number text, p_revision text, p_material text, p_finish text, p_threads text, p_tightest_tolerance_inch numeric, p_process text, p_notes text, p_quantity integer, p_requested_quote_quantities integer[], p_requested_by_date date, p_shipping jsonb, p_certifications jsonb, p_sourcing jsonb, p_release jsonb) to anon;
grant execute on function "public"."api_update_client_part_request"(p_job_id uuid, p_requested_service_kinds text[], p_primary_service_kind text, p_service_notes text, p_description text, p_part_number text, p_revision text, p_material text, p_finish text, p_threads text, p_tightest_tolerance_inch numeric, p_process text, p_notes text, p_quantity integer, p_requested_quote_quantities integer[], p_requested_by_date date, p_shipping jsonb, p_certifications jsonb, p_sourcing jsonb, p_release jsonb) to authenticated;
grant execute on function "public"."api_update_client_part_request"(p_job_id uuid, p_requested_service_kinds text[], p_primary_service_kind text, p_service_notes text, p_description text, p_part_number text, p_revision text, p_material text, p_finish text, p_threads text, p_tightest_tolerance_inch numeric, p_process text, p_notes text, p_quantity integer, p_requested_quote_quantities integer[], p_requested_by_date date, p_shipping jsonb, p_certifications jsonb, p_sourcing jsonb, p_release jsonb) to service_role;
revoke execute on function "public"."api_update_organization_membership_role"(p_membership_id uuid, p_role app_role) from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."api_update_organization_membership_role"(p_membership_id uuid, p_role app_role) to public;
grant execute on function "public"."api_update_organization_membership_role"(p_membership_id uuid, p_role app_role) to postgres;
grant execute on function "public"."api_update_organization_membership_role"(p_membership_id uuid, p_role app_role) to anon;
grant execute on function "public"."api_update_organization_membership_role"(p_membership_id uuid, p_role app_role) to authenticated;
grant execute on function "public"."api_update_organization_membership_role"(p_membership_id uuid, p_role app_role) to service_role;
revoke execute on function "public"."api_update_project"(p_project_id uuid, p_name text, p_description text) from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."api_update_project"(p_project_id uuid, p_name text, p_description text) to public;
grant execute on function "public"."api_update_project"(p_project_id uuid, p_name text, p_description text) to postgres;
grant execute on function "public"."api_update_project"(p_project_id uuid, p_name text, p_description text) to anon;
grant execute on function "public"."api_update_project"(p_project_id uuid, p_name text, p_description text) to authenticated;
grant execute on function "public"."api_update_project"(p_project_id uuid, p_name text, p_description text) to service_role;
revoke execute on function "public"."apply_markup"(p_raw_amount numeric, p_markup_percent numeric, p_minor_unit numeric) from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."apply_markup"(p_raw_amount numeric, p_markup_percent numeric, p_minor_unit numeric) to public;
grant execute on function "public"."apply_markup"(p_raw_amount numeric, p_markup_percent numeric, p_minor_unit numeric) to postgres;
grant execute on function "public"."apply_markup"(p_raw_amount numeric, p_markup_percent numeric, p_minor_unit numeric) to anon;
grant execute on function "public"."apply_markup"(p_raw_amount numeric, p_markup_percent numeric, p_minor_unit numeric) to authenticated;
grant execute on function "public"."apply_markup"(p_raw_amount numeric, p_markup_percent numeric, p_minor_unit numeric) to service_role;
revoke execute on function "public"."build_org_file_blob_storage_path"(p_organization_id uuid, p_content_sha256 text, p_original_name text) from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."build_org_file_blob_storage_path"(p_organization_id uuid, p_content_sha256 text, p_original_name text) to public;
grant execute on function "public"."build_org_file_blob_storage_path"(p_organization_id uuid, p_content_sha256 text, p_original_name text) to postgres;
grant execute on function "public"."build_org_file_blob_storage_path"(p_organization_id uuid, p_content_sha256 text, p_original_name text) to anon;
grant execute on function "public"."build_org_file_blob_storage_path"(p_organization_id uuid, p_content_sha256 text, p_original_name text) to authenticated;
grant execute on function "public"."build_org_file_blob_storage_path"(p_organization_id uuid, p_content_sha256 text, p_original_name text) to service_role;
revoke execute on function "public"."build_project_part_property_snapshot"(p_spec_snapshot jsonb, p_defaults jsonb, p_overrides jsonb, p_created_at text, p_updated_at timestamp with time zone, p_description text, p_part_number text, p_material text, p_finish text, p_threads text, p_tightest_tolerance_inch numeric) from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."build_project_part_property_snapshot"(p_spec_snapshot jsonb, p_defaults jsonb, p_overrides jsonb, p_created_at text, p_updated_at timestamp with time zone, p_description text, p_part_number text, p_material text, p_finish text, p_threads text, p_tightest_tolerance_inch numeric) to public;
grant execute on function "public"."build_project_part_property_snapshot"(p_spec_snapshot jsonb, p_defaults jsonb, p_overrides jsonb, p_created_at text, p_updated_at timestamp with time zone, p_description text, p_part_number text, p_material text, p_finish text, p_threads text, p_tightest_tolerance_inch numeric) to postgres;
grant execute on function "public"."build_project_part_property_snapshot"(p_spec_snapshot jsonb, p_defaults jsonb, p_overrides jsonb, p_created_at text, p_updated_at timestamp with time zone, p_description text, p_part_number text, p_material text, p_finish text, p_threads text, p_tightest_tolerance_inch numeric) to anon;
grant execute on function "public"."build_project_part_property_snapshot"(p_spec_snapshot jsonb, p_defaults jsonb, p_overrides jsonb, p_created_at text, p_updated_at timestamp with time zone, p_description text, p_part_number text, p_material text, p_finish text, p_threads text, p_tightest_tolerance_inch numeric) to authenticated;
grant execute on function "public"."build_project_part_property_snapshot"(p_spec_snapshot jsonb, p_defaults jsonb, p_overrides jsonb, p_created_at text, p_updated_at timestamp with time zone, p_description text, p_part_number text, p_material text, p_finish text, p_threads text, p_tightest_tolerance_inch numeric) to service_role;
revoke execute on function "public"."build_project_part_property_snapshot"(p_spec_snapshot jsonb, p_defaults jsonb, p_overrides jsonb, p_created_at text, p_updated_at timestamp with time zone, p_description text, p_part_number text, p_material text, p_finish text, p_threads text, p_tightest_tolerance_inch numeric, p_revision text, p_process text) from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."build_project_part_property_snapshot"(p_spec_snapshot jsonb, p_defaults jsonb, p_overrides jsonb, p_created_at text, p_updated_at timestamp with time zone, p_description text, p_part_number text, p_material text, p_finish text, p_threads text, p_tightest_tolerance_inch numeric, p_revision text, p_process text) to public;
grant execute on function "public"."build_project_part_property_snapshot"(p_spec_snapshot jsonb, p_defaults jsonb, p_overrides jsonb, p_created_at text, p_updated_at timestamp with time zone, p_description text, p_part_number text, p_material text, p_finish text, p_threads text, p_tightest_tolerance_inch numeric, p_revision text, p_process text) to postgres;
grant execute on function "public"."build_project_part_property_snapshot"(p_spec_snapshot jsonb, p_defaults jsonb, p_overrides jsonb, p_created_at text, p_updated_at timestamp with time zone, p_description text, p_part_number text, p_material text, p_finish text, p_threads text, p_tightest_tolerance_inch numeric, p_revision text, p_process text) to anon;
grant execute on function "public"."build_project_part_property_snapshot"(p_spec_snapshot jsonb, p_defaults jsonb, p_overrides jsonb, p_created_at text, p_updated_at timestamp with time zone, p_description text, p_part_number text, p_material text, p_finish text, p_threads text, p_tightest_tolerance_inch numeric, p_revision text, p_process text) to authenticated;
grant execute on function "public"."build_project_part_property_snapshot"(p_spec_snapshot jsonb, p_defaults jsonb, p_overrides jsonb, p_created_at text, p_updated_at timestamp with time zone, p_description text, p_part_number text, p_material text, p_finish text, p_threads text, p_tightest_tolerance_inch numeric, p_revision text, p_process text) to service_role;
revoke execute on function "public"."current_user_has_verified_auth"() from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."current_user_has_verified_auth"() to public;
grant execute on function "public"."current_user_has_verified_auth"() to postgres;
grant execute on function "public"."current_user_has_verified_auth"() to anon;
grant execute on function "public"."current_user_has_verified_auth"() to authenticated;
grant execute on function "public"."current_user_has_verified_auth"() to service_role;
revoke execute on function "public"."current_user_home_organization_id"() from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."current_user_home_organization_id"() to public;
grant execute on function "public"."current_user_home_organization_id"() to postgres;
grant execute on function "public"."current_user_home_organization_id"() to anon;
grant execute on function "public"."current_user_home_organization_id"() to authenticated;
grant execute on function "public"."current_user_home_organization_id"() to service_role;
revoke execute on function "public"."is_internal_user"(p_organization_id uuid) from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."is_internal_user"(p_organization_id uuid) to public;
grant execute on function "public"."is_internal_user"(p_organization_id uuid) to postgres;
grant execute on function "public"."is_internal_user"(p_organization_id uuid) to anon;
grant execute on function "public"."is_internal_user"(p_organization_id uuid) to authenticated;
grant execute on function "public"."is_internal_user"(p_organization_id uuid) to service_role;
revoke execute on function "public"."is_internal_user_any_org"() from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."is_internal_user_any_org"() to public;
grant execute on function "public"."is_internal_user_any_org"() to postgres;
grant execute on function "public"."is_internal_user_any_org"() to anon;
grant execute on function "public"."is_internal_user_any_org"() to authenticated;
grant execute on function "public"."is_internal_user_any_org"() to service_role;
revoke execute on function "public"."is_org_admin"(p_organization_id uuid) from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."is_org_admin"(p_organization_id uuid) to public;
grant execute on function "public"."is_org_admin"(p_organization_id uuid) to postgres;
grant execute on function "public"."is_org_admin"(p_organization_id uuid) to anon;
grant execute on function "public"."is_org_admin"(p_organization_id uuid) to authenticated;
grant execute on function "public"."is_org_admin"(p_organization_id uuid) to service_role;
revoke execute on function "public"."is_platform_admin"() from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."is_platform_admin"() to public;
grant execute on function "public"."is_platform_admin"() to postgres;
grant execute on function "public"."is_platform_admin"() to anon;
grant execute on function "public"."is_platform_admin"() to authenticated;
grant execute on function "public"."is_platform_admin"() to service_role;
revoke execute on function "public"."job_part_file_set"(p_job_id uuid) from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."job_part_file_set"(p_job_id uuid) to public;
grant execute on function "public"."job_part_file_set"(p_job_id uuid) to postgres;
grant execute on function "public"."job_part_file_set"(p_job_id uuid) to anon;
grant execute on function "public"."job_part_file_set"(p_job_id uuid) to authenticated;
grant execute on function "public"."job_part_file_set"(p_job_id uuid) to service_role;
revoke execute on function "public"."load_editable_project_part_context"(p_job_id uuid) from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."load_editable_project_part_context"(p_job_id uuid) to public;
grant execute on function "public"."load_editable_project_part_context"(p_job_id uuid) to postgres;
grant execute on function "public"."load_editable_project_part_context"(p_job_id uuid) to anon;
grant execute on function "public"."load_editable_project_part_context"(p_job_id uuid) to authenticated;
grant execute on function "public"."load_editable_project_part_context"(p_job_id uuid) to service_role;
revoke execute on function "public"."log_audit_event"(p_organization_id uuid, p_event_type text, p_payload jsonb, p_job_id uuid, p_package_id uuid) from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."log_audit_event"(p_organization_id uuid, p_event_type text, p_payload jsonb, p_job_id uuid, p_package_id uuid) to public;
grant execute on function "public"."log_audit_event"(p_organization_id uuid, p_event_type text, p_payload jsonb, p_job_id uuid, p_package_id uuid) to postgres;
grant execute on function "public"."log_audit_event"(p_organization_id uuid, p_event_type text, p_payload jsonb, p_job_id uuid, p_package_id uuid) to anon;
grant execute on function "public"."log_audit_event"(p_organization_id uuid, p_event_type text, p_payload jsonb, p_job_id uuid, p_package_id uuid) to authenticated;
grant execute on function "public"."log_audit_event"(p_organization_id uuid, p_event_type text, p_payload jsonb, p_job_id uuid, p_package_id uuid) to service_role;
revoke execute on function "public"."normalize_file_basename"(input_name text) from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."normalize_file_basename"(input_name text) to public;
grant execute on function "public"."normalize_file_basename"(input_name text) to postgres;
grant execute on function "public"."normalize_file_basename"(input_name text) to anon;
grant execute on function "public"."normalize_file_basename"(input_name text) to authenticated;
grant execute on function "public"."normalize_file_basename"(input_name text) to service_role;
revoke execute on function "public"."normalize_positive_integer_array"(p_values integer[], p_fallback integer) from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."normalize_positive_integer_array"(p_values integer[], p_fallback integer) to public;
grant execute on function "public"."normalize_positive_integer_array"(p_values integer[], p_fallback integer) to postgres;
grant execute on function "public"."normalize_positive_integer_array"(p_values integer[], p_fallback integer) to anon;
grant execute on function "public"."normalize_positive_integer_array"(p_values integer[], p_fallback integer) to authenticated;
grant execute on function "public"."normalize_positive_integer_array"(p_values integer[], p_fallback integer) to service_role;
revoke execute on function "public"."normalize_primary_service_kind"(p_requested_service_kinds text[], p_primary_service_kind text) from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."normalize_primary_service_kind"(p_requested_service_kinds text[], p_primary_service_kind text) to public;
grant execute on function "public"."normalize_primary_service_kind"(p_requested_service_kinds text[], p_primary_service_kind text) to postgres;
grant execute on function "public"."normalize_primary_service_kind"(p_requested_service_kinds text[], p_primary_service_kind text) to anon;
grant execute on function "public"."normalize_primary_service_kind"(p_requested_service_kinds text[], p_primary_service_kind text) to authenticated;
grant execute on function "public"."normalize_primary_service_kind"(p_requested_service_kinds text[], p_primary_service_kind text) to service_role;
revoke execute on function "public"."normalize_project_part_threads"(p_extraction jsonb) from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."normalize_project_part_threads"(p_extraction jsonb) to public;
grant execute on function "public"."normalize_project_part_threads"(p_extraction jsonb) to postgres;
grant execute on function "public"."normalize_project_part_threads"(p_extraction jsonb) to anon;
grant execute on function "public"."normalize_project_part_threads"(p_extraction jsonb) to authenticated;
grant execute on function "public"."normalize_project_part_threads"(p_extraction jsonb) to service_role;
revoke execute on function "public"."normalize_requested_service_kinds"(p_requested_service_kinds text[], p_primary_service_kind text) from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."normalize_requested_service_kinds"(p_requested_service_kinds text[], p_primary_service_kind text) to public;
grant execute on function "public"."normalize_requested_service_kinds"(p_requested_service_kinds text[], p_primary_service_kind text) to postgres;
grant execute on function "public"."normalize_requested_service_kinds"(p_requested_service_kinds text[], p_primary_service_kind text) to anon;
grant execute on function "public"."normalize_requested_service_kinds"(p_requested_service_kinds text[], p_primary_service_kind text) to authenticated;
grant execute on function "public"."normalize_requested_service_kinds"(p_requested_service_kinds text[], p_primary_service_kind text) to service_role;
revoke execute on function "public"."require_verified_auth"() from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."require_verified_auth"() to public;
grant execute on function "public"."require_verified_auth"() to postgres;
grant execute on function "public"."require_verified_auth"() to anon;
grant execute on function "public"."require_verified_auth"() to authenticated;
grant execute on function "public"."require_verified_auth"() to service_role;
revoke execute on function "public"."resolve_project_part_property_values"(p_defaults jsonb, p_overrides jsonb) from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."resolve_project_part_property_values"(p_defaults jsonb, p_overrides jsonb) to public;
grant execute on function "public"."resolve_project_part_property_values"(p_defaults jsonb, p_overrides jsonb) to postgres;
grant execute on function "public"."resolve_project_part_property_values"(p_defaults jsonb, p_overrides jsonb) to anon;
grant execute on function "public"."resolve_project_part_property_values"(p_defaults jsonb, p_overrides jsonb) to authenticated;
grant execute on function "public"."resolve_project_part_property_values"(p_defaults jsonb, p_overrides jsonb) to service_role;
revoke execute on function "public"."seed_project_part_property_defaults"(p_requirement approved_part_requirements, p_extraction jsonb, p_defaults jsonb) from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."seed_project_part_property_defaults"(p_requirement approved_part_requirements, p_extraction jsonb, p_defaults jsonb) to public;
grant execute on function "public"."seed_project_part_property_defaults"(p_requirement approved_part_requirements, p_extraction jsonb, p_defaults jsonb) to postgres;
grant execute on function "public"."seed_project_part_property_defaults"(p_requirement approved_part_requirements, p_extraction jsonb, p_defaults jsonb) to anon;
grant execute on function "public"."seed_project_part_property_defaults"(p_requirement approved_part_requirements, p_extraction jsonb, p_defaults jsonb) to authenticated;
grant execute on function "public"."seed_project_part_property_defaults"(p_requirement approved_part_requirements, p_extraction jsonb, p_defaults jsonb) to service_role;
revoke execute on function "public"."seed_revision_and_process_property_defaults"(p_requirement approved_part_requirements, p_extraction jsonb, p_defaults jsonb) from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."seed_revision_and_process_property_defaults"(p_requirement approved_part_requirements, p_extraction jsonb, p_defaults jsonb) to public;
grant execute on function "public"."seed_revision_and_process_property_defaults"(p_requirement approved_part_requirements, p_extraction jsonb, p_defaults jsonb) to postgres;
grant execute on function "public"."seed_revision_and_process_property_defaults"(p_requirement approved_part_requirements, p_extraction jsonb, p_defaults jsonb) to anon;
grant execute on function "public"."seed_revision_and_process_property_defaults"(p_requirement approved_part_requirements, p_extraction jsonb, p_defaults jsonb) to authenticated;
grant execute on function "public"."seed_revision_and_process_property_defaults"(p_requirement approved_part_requirements, p_extraction jsonb, p_defaults jsonb) to service_role;
revoke execute on function "public"."spend_default_daily_ceiling_usd"() from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."spend_default_daily_ceiling_usd"() to public;
grant execute on function "public"."spend_default_daily_ceiling_usd"() to postgres;
grant execute on function "public"."spend_default_daily_ceiling_usd"() to anon;
grant execute on function "public"."spend_default_daily_ceiling_usd"() to authenticated;
grant execute on function "public"."spend_default_daily_ceiling_usd"() to service_role;
revoke execute on function "public"."spend_default_per_run_ceiling_usd"() from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."spend_default_per_run_ceiling_usd"() to public;
grant execute on function "public"."spend_default_per_run_ceiling_usd"() to postgres;
grant execute on function "public"."spend_default_per_run_ceiling_usd"() to anon;
grant execute on function "public"."spend_default_per_run_ceiling_usd"() to authenticated;
grant execute on function "public"."spend_default_per_run_ceiling_usd"() to service_role;
revoke execute on function "public"."sync_quote_request_status_from_vendor_result"() from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."sync_quote_request_status_from_vendor_result"() to public;
grant execute on function "public"."sync_quote_request_status_from_vendor_result"() to postgres;
grant execute on function "public"."sync_quote_request_status_from_vendor_result"() to anon;
grant execute on function "public"."sync_quote_request_status_from_vendor_result"() to authenticated;
grant execute on function "public"."sync_quote_request_status_from_vendor_result"() to service_role;
revoke execute on function "public"."sync_service_request_line_item_status_from_quote_request"() from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."sync_service_request_line_item_status_from_quote_request"() to public;
grant execute on function "public"."sync_service_request_line_item_status_from_quote_request"() to postgres;
grant execute on function "public"."sync_service_request_line_item_status_from_quote_request"() to anon;
grant execute on function "public"."sync_service_request_line_item_status_from_quote_request"() to authenticated;
grant execute on function "public"."sync_service_request_line_item_status_from_quote_request"() to service_role;
revoke execute on function "public"."to_vendor_name_array"(payload jsonb) from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."to_vendor_name_array"(payload jsonb) to public;
grant execute on function "public"."to_vendor_name_array"(payload jsonb) to postgres;
grant execute on function "public"."to_vendor_name_array"(payload jsonb) to anon;
grant execute on function "public"."to_vendor_name_array"(payload jsonb) to authenticated;
grant execute on function "public"."to_vendor_name_array"(payload jsonb) to service_role;
revoke execute on function "public"."touch_updated_at"() from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."touch_updated_at"() to public;
grant execute on function "public"."touch_updated_at"() to postgres;
grant execute on function "public"."touch_updated_at"() to anon;
grant execute on function "public"."touch_updated_at"() to authenticated;
grant execute on function "public"."touch_updated_at"() to service_role;
revoke execute on function "public"."user_can_access_job"(p_job_id uuid) from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."user_can_access_job"(p_job_id uuid) to public;
grant execute on function "public"."user_can_access_job"(p_job_id uuid) to postgres;
grant execute on function "public"."user_can_access_job"(p_job_id uuid) to anon;
grant execute on function "public"."user_can_access_job"(p_job_id uuid) to authenticated;
grant execute on function "public"."user_can_access_job"(p_job_id uuid) to service_role;
revoke execute on function "public"."user_can_access_job_via_project"(p_job_id uuid) from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."user_can_access_job_via_project"(p_job_id uuid) to public;
grant execute on function "public"."user_can_access_job_via_project"(p_job_id uuid) to postgres;
grant execute on function "public"."user_can_access_job_via_project"(p_job_id uuid) to anon;
grant execute on function "public"."user_can_access_job_via_project"(p_job_id uuid) to authenticated;
grant execute on function "public"."user_can_access_job_via_project"(p_job_id uuid) to service_role;
revoke execute on function "public"."user_can_access_org"(p_organization_id uuid) from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."user_can_access_org"(p_organization_id uuid) to public;
grant execute on function "public"."user_can_access_org"(p_organization_id uuid) to postgres;
grant execute on function "public"."user_can_access_org"(p_organization_id uuid) to anon;
grant execute on function "public"."user_can_access_org"(p_organization_id uuid) to authenticated;
grant execute on function "public"."user_can_access_org"(p_organization_id uuid) to service_role;
revoke execute on function "public"."user_can_access_package"(p_package_id uuid) from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."user_can_access_package"(p_package_id uuid) to public;
grant execute on function "public"."user_can_access_package"(p_package_id uuid) to postgres;
grant execute on function "public"."user_can_access_package"(p_package_id uuid) to anon;
grant execute on function "public"."user_can_access_package"(p_package_id uuid) to authenticated;
grant execute on function "public"."user_can_access_package"(p_package_id uuid) to service_role;
revoke execute on function "public"."user_can_access_project"(p_project_id uuid) from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."user_can_access_project"(p_project_id uuid) to public;
grant execute on function "public"."user_can_access_project"(p_project_id uuid) to postgres;
grant execute on function "public"."user_can_access_project"(p_project_id uuid) to anon;
grant execute on function "public"."user_can_access_project"(p_project_id uuid) to authenticated;
grant execute on function "public"."user_can_access_project"(p_project_id uuid) to service_role;
revoke execute on function "public"."user_can_destructively_edit_job"(p_job_id uuid) from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."user_can_destructively_edit_job"(p_job_id uuid) to public;
grant execute on function "public"."user_can_destructively_edit_job"(p_job_id uuid) to postgres;
grant execute on function "public"."user_can_destructively_edit_job"(p_job_id uuid) to anon;
grant execute on function "public"."user_can_destructively_edit_job"(p_job_id uuid) to authenticated;
grant execute on function "public"."user_can_destructively_edit_job"(p_job_id uuid) to service_role;
revoke execute on function "public"."user_can_edit_job"(p_job_id uuid) from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."user_can_edit_job"(p_job_id uuid) to public;
grant execute on function "public"."user_can_edit_job"(p_job_id uuid) to postgres;
grant execute on function "public"."user_can_edit_job"(p_job_id uuid) to anon;
grant execute on function "public"."user_can_edit_job"(p_job_id uuid) to authenticated;
grant execute on function "public"."user_can_edit_job"(p_job_id uuid) to service_role;
revoke execute on function "public"."user_can_edit_project"(p_project_id uuid) from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."user_can_edit_project"(p_project_id uuid) to public;
grant execute on function "public"."user_can_edit_project"(p_project_id uuid) to postgres;
grant execute on function "public"."user_can_edit_project"(p_project_id uuid) to anon;
grant execute on function "public"."user_can_edit_project"(p_project_id uuid) to authenticated;
grant execute on function "public"."user_can_edit_project"(p_project_id uuid) to service_role;
revoke execute on function "public"."user_is_project_owner"(p_project_id uuid) from public, postgres, anon, authenticated, service_role;
grant execute on function "public"."user_is_project_owner"(p_project_id uuid) to public;
grant execute on function "public"."user_is_project_owner"(p_project_id uuid) to postgres;
grant execute on function "public"."user_is_project_owner"(p_project_id uuid) to anon;
grant execute on function "public"."user_is_project_owner"(p_project_id uuid) to authenticated;
grant execute on function "public"."user_is_project_owner"(p_project_id uuid) to service_role;
reset role;
set role "supabase_storage_admin";
grant execute on function "storage"."can_insert_object"(bucketid text, name text, owner uuid, metadata jsonb) to public;
grant execute on function "storage"."delete_leaf_prefixes"(bucket_ids text[], names text[]) to public;
grant execute on function "storage"."enforce_bucket_name_length"() to public;
grant execute on function "storage"."extension"(name text) to public;
grant execute on function "storage"."filename"(name text) to public;
grant execute on function "storage"."foldername"(name text) to public;
grant execute on function "storage"."get_common_prefix"(p_key text, p_prefix text, p_delimiter text) to public;
grant execute on function "storage"."get_level"(name text) to public;
grant execute on function "storage"."get_prefix"(name text) to public;
grant execute on function "storage"."get_prefixes"(name text) to public;
grant execute on function "storage"."get_size_by_bucket"() to public;
grant execute on function "storage"."list_multipart_uploads_with_delimiter"(bucket_id text, prefix_param text, delimiter_param text, max_keys integer, next_key_token text, next_upload_token text) to public;
grant execute on function "storage"."list_objects_with_delimiter"(_bucket_id text, prefix_param text, delimiter_param text, max_keys integer, start_after text, next_token text, sort_order text) to public;
grant execute on function "storage"."operation"() to public;
grant execute on function "storage"."protect_delete"() to public;
grant execute on function "storage"."search"(prefix text, bucketname text, limits integer, levels integer, offsets integer, search text, sortcolumn text, sortorder text) to public;
grant execute on function "storage"."search_by_timestamp"(p_prefix text, p_bucket_id text, p_limit integer, p_level integer, p_start_after text, p_sort_order text, p_sort_column text, p_sort_column_after text) to public;
grant execute on function "storage"."search_legacy_v1"(prefix text, bucketname text, limits integer, levels integer, offsets integer, search text, sortcolumn text, sortorder text) to public;
grant execute on function "storage"."search_v2"(prefix text, bucket_name text, limits integer, levels integer, start_after text, sort_order text, sort_column text, sort_column_after text) to public;
grant execute on function "storage"."update_updated_at_column"() to public;
reset role;
alter default privileges for role postgres in schema private, extensions revoke execute on functions from public;
alter default privileges for role postgres grant execute on functions to public;
alter default privileges for role supabase_storage_admin grant execute on functions to public;
do $ovd558_reverse_postflight$ declare actual text;
begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'storage' and not exists (
      select 1 from aclexplode(p.proacl) a
      where a.grantee = 0 and a.grantor = p.proowner
        and a.privilege_type = 'EXECUTE' and not a.is_grantable))
     or exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       cross join lateral aclexplode(p.proacl) a
       where n.nspname = 'storage' and
         (a.grantor <> p.proowner or a.privilege_type <> 'EXECUTE'
          or a.is_grantable or a.grantee not in (0, p.proowner))) then
    raise exception 'ovd558_storage_expanded_acl_mismatch';
  end if;
  select digest_value into actual from (select encode(sha256(convert_to(
    jsonb_set(catalog_value, '{functions}',
      (select jsonb_agg(case when item->>'schema_name' = 'storage'
        then jsonb_set(jsonb_set(item, '{acl}', 'null'::jsonb),
          '{explicit_grants}', '[]'::jsonb) else item end order by ordinal)
       from jsonb_array_elements(catalog_value->'functions') with ordinality as f(item, ordinal)))::text,
    'UTF8')), 'hex') from (with selected_roles(role_name) as (
  select rolname from pg_roles where rolname not like 'pg_%'
), functions as (
  select n.nspname as schema_name, p.proname as function_name,
    pg_get_function_identity_arguments(p.oid) as identity_arguments,
    pg_get_userbyid(p.proowner) as owner, p.prosecdef as security_definer,
    p.prokind as kind, p.proacl::text as acl, p.proconfig as configuration,
    md5(p.prosrc) as body_md5,
    md5(pg_get_functiondef(p.oid)) as definition_md5,
    (select coalesce(jsonb_agg(jsonb_build_object(
      'grantor', pg_get_userbyid(a.grantor),
      'grantee', case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
      'privilege', a.privilege_type, 'grantable', a.is_grantable)
      order by a.grantee, a.grantor, a.privilege_type), '[]'::jsonb)
      from aclexplode(p.proacl) a) as explicit_grants,
    exists (select 1 from pg_depend dep where dep.classid = 'pg_proc'::regclass
      and dep.objid = p.oid and dep.deptype = 'e') as extension_owned,
    exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_execute,
    (select jsonb_object_agg(r.role_name, jsonb_build_object(
      'schemaUsage', has_schema_privilege(r.role_name, n.oid, 'USAGE'),
      'functionExecute', has_function_privilege(r.role_name, p.oid, 'EXECUTE')))
      from selected_roles r) as callers
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname not like 'pg_%' and n.nspname <> 'information_schema'
), defaults as (
  select pg_get_userbyid(d.defaclrole) as owner,
    coalesce(n.nspname, '*') as schema_name, d.defaclobjtype as object_type,
    d.defaclacl::text as acl
  from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace
), schemas as (
  select n.nspname as schema_name, pg_get_userbyid(n.nspowner) as owner,
    n.nspacl::text as acl,
    exists (select 1 from aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
      where a.grantee = 0 and a.privilege_type = 'USAGE') as public_usage,
    (select jsonb_object_agg(r.role_name,
      has_schema_privilege(r.role_name, n.oid, 'USAGE')) from selected_roles r) as usage
    , (select jsonb_object_agg(o.role_name, jsonb_build_object(
      'usage', has_schema_privilege(o.role_name, n.oid, 'USAGE'),
      'create', has_schema_privilege(o.role_name, n.oid, 'CREATE')))
      from (values ('postgres'), ('supabase_storage_admin')) o(role_name)) as owner_capabilities
  from pg_namespace n where n.nspname not like 'pg_%' and n.nspname <> 'information_schema'
), roles as (
  select rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin,
    rolreplication, rolbypassrls from pg_roles
  where rolname not like 'pg_%'
), memberships as (
  select parent.rolname as granted_role, member.rolname as member_role,
    m.admin_option, m.inherit_option, m.set_option
  from pg_auth_members m join pg_roles parent on parent.oid = m.roleid
    join pg_roles member on member.oid = m.member
  where parent.rolname not like 'pg_%' or member.rolname not like 'pg_%'
), policies as (
  select schemaname as schema_name, tablename as table_name, policyname as policy_name,
    permissive, roles, cmd, qual, with_check from pg_policies
  where schemaname not like 'pg_%' and schemaname <> 'information_schema'
), relations as (
  select n.nspname as schema_name, c.relname as relation_name, c.relkind as kind,
    pg_get_userbyid(c.relowner) as owner, c.relacl::text as acl,
    c.relrowsecurity as row_security, c.relforcerowsecurity as force_row_security,
    (select jsonb_object_agg(r.role_name, jsonb_build_object(
      'select', has_table_privilege(r.role_name, c.oid, 'SELECT'),
      'insert', has_table_privilege(r.role_name, c.oid, 'INSERT'),
      'update', has_table_privilege(r.role_name, c.oid, 'UPDATE'),
      'delete', has_table_privilege(r.role_name, c.oid, 'DELETE')))
      from selected_roles r) as callers
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname not like 'pg_%' and n.nspname <> 'information_schema'
    and c.relkind in ('r','p','v','m')
), sequences as (
  select n.nspname as schema_name, c.relname as sequence_name,
    pg_get_userbyid(c.relowner) as owner, c.relacl::text as acl,
    (select jsonb_object_agg(r.role_name, jsonb_build_object(
      'usage', has_sequence_privilege(r.role_name, c.oid, 'USAGE'),
      'select', has_sequence_privilege(r.role_name, c.oid, 'SELECT'),
      'update', has_sequence_privilege(r.role_name, c.oid, 'UPDATE')))
      from selected_roles r) as callers
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname not like 'pg_%' and n.nspname <> 'information_schema'
    and c.relkind = 'S'
)
select jsonb_build_object(
  'databaseVersion', current_setting('server_version'),
  'functions', (select coalesce(jsonb_agg(to_jsonb(f) order by schema_name,function_name,identity_arguments), '[]'::jsonb) from functions f),
  'defaults', (select coalesce(jsonb_agg(to_jsonb(d) order by owner,schema_name,object_type), '[]'::jsonb) from defaults d),
  'schemas', (select coalesce(jsonb_agg(to_jsonb(s) order by schema_name), '[]'::jsonb) from schemas s),
  'roles', (select coalesce(jsonb_agg(to_jsonb(r) order by rolname), '[]'::jsonb) from roles r),
  'memberships', (select coalesce(jsonb_agg(to_jsonb(m) order by granted_role,member_role), '[]'::jsonb) from memberships m),
  'policies', (select coalesce(jsonb_agg(to_jsonb(p) order by schema_name,table_name,policy_name), '[]'::jsonb) from policies p),
  'relations', (select coalesce(jsonb_agg(to_jsonb(t) order by schema_name,relation_name), '[]'::jsonb) from relations t),
  'sequences', (select coalesce(jsonb_agg(to_jsonb(s) order by schema_name,sequence_name), '[]'::jsonb) from sequences s)
)) snapshot(catalog_value)) as digest(digest_value);
  if actual is distinct from 'ee81feb70d8a72cb1baa3c73109c311504b9079603b51954a3f6d50a8a763dc1' then
    raise exception 'ovd558_reverse_catalog_mismatch:%', actual;
  end if;
end $ovd558_reverse_postflight$;
commit;
