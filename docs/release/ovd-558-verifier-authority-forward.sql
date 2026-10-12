-- OVD-558 staged source migration. Do not add this file to the active migration tree.
-- Pinned prechange manifest SHA-256: 854ec2fc0f7141f9a770378a0290a9c71bc32389ba2c3d2ba585309fc4b99296
-- Pinned PostgreSQL jsonb catalog SHA-256 (search_path pg_catalog): e1947671b453122789c6ba947bac2a279973a8a429815a8a18f16f8c941e9d0b
-- Runs as postgres, the hosted Supabase owner role; no superuser is needed.
-- Storage functions are owned by supabase_storage_admin and keep their shipped
-- ACLs: the verifier may call exactly the storage functions anon can call.
-- READ COMMITTED and the shared window 2 lock come first, as in every staged
-- forward and reverse, so no two window 2 scripts interleave.
begin;
set local statement_timeout = '180s';
set local lock_timeout = '10s';
do $ovd558_forward_isolation$
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'ovd558_forward_read_committed_required' using errcode = '0A000';
  end if;
end $ovd558_forward_isolation$;
select pg_advisory_xact_lock(510, 2);
do $ovd558_preflight$ declare actual text; saved_search_path text := current_setting('search_path');
begin
  if current_user <> 'postgres'
     or to_regrole('engineering_native_verifier') is not null
     or to_regclass('engineering_private.native_verifier_registered_objects') is not null
     or to_regprocedure('public.api_load_native_verification(uuid,uuid)') is not null then
    raise exception 'ovd558_runner_or_object_preflight_mismatch';
  end if;
  perform set_config('search_path', 'pg_catalog', true);
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
  perform set_config('search_path', saved_search_path, true);
  if actual is distinct from 'e1947671b453122789c6ba947bac2a279973a8a429815a8a18f16f8c941e9d0b' then
    raise exception 'ovd558_prechange_catalog_mismatch:%', actual;
  end if;
end $ovd558_preflight$;
create role engineering_native_verifier
  nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;

set role postgres;
create table engineering_private.native_verifier_registered_objects (
  bucket_id text not null, object_name text not null,
  primary key (bucket_id, object_name));
alter table engineering_private.native_verifier_registered_objects enable row level security;
create function engineering_private.load_native_verification(p_task_id uuid, p_attempt_id uuid)
returns text language plpgsql security definer set search_path = '' as $body$
begin
  if current_setting('request.jwt.claim.role', true) is distinct from 'engineering_native_verifier' then
    raise exception 'ovd510_wrong_principal' using errcode = 'P0001';
  end if;
  raise exception 'ovd510_proof_only' using errcode = 'P0001';
end $body$;
create function engineering_private.complete_native_verification(p_attempt_id uuid, p_receipt text)
returns text language plpgsql security definer set search_path = '' as $body$
begin
  if current_setting('request.jwt.claim.role', true) is distinct from 'engineering_native_verifier' then
    raise exception 'ovd510_wrong_principal' using errcode = 'P0001';
  end if;
  raise exception 'ovd510_proof_only' using errcode = 'P0001';
end $body$;
create function engineering_private.reject_native_verification(p_attempt_id uuid, p_reason jsonb)
returns text language plpgsql security definer set search_path = '' as $body$
begin
  if current_setting('request.jwt.claim.role', true) is distinct from 'engineering_native_verifier' then
    raise exception 'ovd510_wrong_principal' using errcode = 'P0001';
  end if;
  raise exception 'ovd510_proof_only' using errcode = 'P0001';
end $body$;
create function engineering_private.native_verifier_can_read_object(p_bucket text, p_name text)
returns boolean language plpgsql security definer set search_path = '' as $body$
begin
  if current_setting('request.jwt.claim.role', true) is distinct from 'engineering_native_verifier' then
    return false;
  end if;
  return exists (select 1 from engineering_private.native_verifier_registered_objects
    where bucket_id = p_bucket and object_name = p_name);
end $body$;
create function public.api_load_native_verification(p_task_id uuid, p_attempt_id uuid)
returns text language sql security invoker set search_path = '' as $body$
  select engineering_private.load_native_verification($1, $2);
$body$;
create function public.api_complete_native_verification(p_attempt_id uuid, p_receipt text)
returns text language sql security invoker set search_path = '' as $body$
  select engineering_private.complete_native_verification($1, $2);
$body$;
create function public.api_reject_native_verification(p_attempt_id uuid, p_reason jsonb)
returns text language sql security invoker set search_path = '' as $body$
  select engineering_private.reject_native_verification($1, $2);
$body$;
revoke execute on function public.api_load_native_verification(uuid,uuid),
  public.api_complete_native_verification(uuid,text),
  public.api_reject_native_verification(uuid,jsonb),
  engineering_private.load_native_verification(uuid,uuid),
  engineering_private.complete_native_verification(uuid,text),
  engineering_private.reject_native_verification(uuid,jsonb),
  engineering_private.native_verifier_can_read_object(text,text)
  from public, anon, authenticated, service_role;
reset role;

alter default privileges for role postgres revoke execute on functions from public;
alter default privileges for role postgres in schema private, extensions grant execute on functions to public;
-- Storage functions belong to supabase_storage_admin, which a hosted postgres
-- runner cannot act as; their ACLs stay as Supabase ships them (anon callable).
revoke execute on all functions in schema public, engineering_private from public;

-- OVD-510 exact replacement grants from the pinned pre-change manifest.
-- Requires an asserted, exclusively owned disposable replay and one outer transaction.
SET ROLE "postgres";
GRANT EXECUTE ON FUNCTION "public"."api_accept_project_invite"(p_token text) TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."api_accept_project_invite"(p_token text) TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."api_accept_project_invite"(p_token text) TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."api_accept_project_invite"(p_token text) TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."api_accept_project_invite"(p_token text) TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."api_accept_project_invite"(p_token text) TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."api_accept_project_invite"(p_token text) TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."api_accept_project_invite"(p_token text) TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."api_accept_project_invite"(p_token text) TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."api_accept_project_invite"(p_token text) TO "supabase_storage_admin";
GRANT EXECUTE ON FUNCTION "public"."api_admin_list_all_jobs"() TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."api_admin_list_all_jobs"() TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."api_admin_list_all_jobs"() TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."api_admin_list_all_jobs"() TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."api_admin_list_all_jobs"() TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."api_admin_list_all_jobs"() TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."api_admin_list_all_jobs"() TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."api_admin_list_all_jobs"() TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."api_admin_list_all_jobs"() TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."api_admin_list_all_jobs"() TO "supabase_storage_admin";
GRANT EXECUTE ON FUNCTION "public"."api_admin_list_all_projects"() TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."api_admin_list_all_projects"() TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."api_admin_list_all_projects"() TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."api_admin_list_all_projects"() TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."api_admin_list_all_projects"() TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."api_admin_list_all_projects"() TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."api_admin_list_all_projects"() TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."api_admin_list_all_projects"() TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."api_admin_list_all_projects"() TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."api_admin_list_all_projects"() TO "supabase_storage_admin";
GRANT EXECUTE ON FUNCTION "public"."api_admin_list_all_users"() TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."api_admin_list_all_users"() TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."api_admin_list_all_users"() TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."api_admin_list_all_users"() TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."api_admin_list_all_users"() TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."api_admin_list_all_users"() TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."api_admin_list_all_users"() TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."api_admin_list_all_users"() TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."api_admin_list_all_users"() TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."api_admin_list_all_users"() TO "supabase_storage_admin";
GRANT EXECUTE ON FUNCTION "public"."api_admin_list_organizations"() TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."api_admin_list_organizations"() TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."api_admin_list_organizations"() TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."api_admin_list_organizations"() TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."api_admin_list_organizations"() TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."api_admin_list_organizations"() TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."api_admin_list_organizations"() TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."api_admin_list_organizations"() TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."api_admin_list_organizations"() TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."api_admin_list_organizations"() TO "supabase_storage_admin";
GRANT EXECUTE ON FUNCTION "public"."api_approve_job_requirements"(p_job_id uuid, p_requirements jsonb) TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."api_approve_job_requirements"(p_job_id uuid, p_requirements jsonb) TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."api_approve_job_requirements"(p_job_id uuid, p_requirements jsonb) TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."api_approve_job_requirements"(p_job_id uuid, p_requirements jsonb) TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."api_approve_job_requirements"(p_job_id uuid, p_requirements jsonb) TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."api_approve_job_requirements"(p_job_id uuid, p_requirements jsonb) TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."api_approve_job_requirements"(p_job_id uuid, p_requirements jsonb) TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."api_approve_job_requirements"(p_job_id uuid, p_requirements jsonb) TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."api_approve_job_requirements"(p_job_id uuid, p_requirements jsonb) TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."api_approve_job_requirements"(p_job_id uuid, p_requirements jsonb) TO "supabase_storage_admin";
GRANT EXECUTE ON FUNCTION "public"."api_archive_job"(p_job_id uuid) TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."api_archive_job"(p_job_id uuid) TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."api_archive_job"(p_job_id uuid) TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."api_archive_job"(p_job_id uuid) TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."api_archive_job"(p_job_id uuid) TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."api_archive_job"(p_job_id uuid) TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."api_archive_job"(p_job_id uuid) TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."api_archive_job"(p_job_id uuid) TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."api_archive_job"(p_job_id uuid) TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."api_archive_job"(p_job_id uuid) TO "supabase_storage_admin";
GRANT EXECUTE ON FUNCTION "public"."api_archive_project"(p_project_id uuid) TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."api_archive_project"(p_project_id uuid) TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."api_archive_project"(p_project_id uuid) TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."api_archive_project"(p_project_id uuid) TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."api_archive_project"(p_project_id uuid) TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."api_archive_project"(p_project_id uuid) TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."api_archive_project"(p_project_id uuid) TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."api_archive_project"(p_project_id uuid) TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."api_archive_project"(p_project_id uuid) TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."api_archive_project"(p_project_id uuid) TO "supabase_storage_admin";
GRANT EXECUTE ON FUNCTION "public"."api_assign_job_to_project"(p_job_id uuid, p_project_id uuid) TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."api_assign_job_to_project"(p_job_id uuid, p_project_id uuid) TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."api_assign_job_to_project"(p_job_id uuid, p_project_id uuid) TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."api_assign_job_to_project"(p_job_id uuid, p_project_id uuid) TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."api_assign_job_to_project"(p_job_id uuid, p_project_id uuid) TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."api_assign_job_to_project"(p_job_id uuid, p_project_id uuid) TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."api_assign_job_to_project"(p_job_id uuid, p_project_id uuid) TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."api_assign_job_to_project"(p_job_id uuid, p_project_id uuid) TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."api_assign_job_to_project"(p_job_id uuid, p_project_id uuid) TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."api_assign_job_to_project"(p_job_id uuid, p_project_id uuid) TO "supabase_storage_admin";
GRANT EXECUTE ON FUNCTION "public"."api_cancel_quote_request"(p_request_id uuid) TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."api_cancel_quote_request"(p_request_id uuid) TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."api_cancel_quote_request"(p_request_id uuid) TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."api_cancel_quote_request"(p_request_id uuid) TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."api_cancel_quote_request"(p_request_id uuid) TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."api_cancel_quote_request"(p_request_id uuid) TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."api_cancel_quote_request"(p_request_id uuid) TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."api_cancel_quote_request"(p_request_id uuid) TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."api_cancel_quote_request"(p_request_id uuid) TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."api_cancel_quote_request"(p_request_id uuid) TO "supabase_storage_admin";
GRANT EXECUTE ON FUNCTION "public"."api_create_project"(p_name text, p_description text) TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."api_create_project"(p_name text, p_description text) TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."api_create_project"(p_name text, p_description text) TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."api_create_project"(p_name text, p_description text) TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."api_create_project"(p_name text, p_description text) TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."api_create_project"(p_name text, p_description text) TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."api_create_project"(p_name text, p_description text) TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."api_create_project"(p_name text, p_description text) TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."api_create_project"(p_name text, p_description text) TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."api_create_project"(p_name text, p_description text) TO "supabase_storage_admin";
GRANT EXECUTE ON FUNCTION "public"."api_create_self_service_organization"(p_organization_name text) TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."api_create_self_service_organization"(p_organization_name text) TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."api_create_self_service_organization"(p_organization_name text) TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."api_create_self_service_organization"(p_organization_name text) TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."api_create_self_service_organization"(p_organization_name text) TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."api_create_self_service_organization"(p_organization_name text) TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."api_create_self_service_organization"(p_organization_name text) TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."api_create_self_service_organization"(p_organization_name text) TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."api_create_self_service_organization"(p_organization_name text) TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."api_create_self_service_organization"(p_organization_name text) TO "supabase_storage_admin";
GRANT EXECUTE ON FUNCTION "public"."api_delete_project"(p_project_id uuid) TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."api_delete_project"(p_project_id uuid) TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."api_delete_project"(p_project_id uuid) TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."api_delete_project"(p_project_id uuid) TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."api_delete_project"(p_project_id uuid) TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."api_delete_project"(p_project_id uuid) TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."api_delete_project"(p_project_id uuid) TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."api_delete_project"(p_project_id uuid) TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."api_delete_project"(p_project_id uuid) TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."api_delete_project"(p_project_id uuid) TO "supabase_storage_admin";
GRANT EXECUTE ON FUNCTION "public"."api_dissolve_project"(p_project_id uuid) TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."api_dissolve_project"(p_project_id uuid) TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."api_dissolve_project"(p_project_id uuid) TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."api_dissolve_project"(p_project_id uuid) TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."api_dissolve_project"(p_project_id uuid) TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."api_dissolve_project"(p_project_id uuid) TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."api_dissolve_project"(p_project_id uuid) TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."api_dissolve_project"(p_project_id uuid) TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."api_dissolve_project"(p_project_id uuid) TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."api_dissolve_project"(p_project_id uuid) TO "supabase_storage_admin";
GRANT EXECUTE ON FUNCTION "public"."api_get_client_intake_compatibility"() TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."api_get_client_intake_compatibility"() TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."api_get_client_intake_compatibility"() TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."api_get_client_intake_compatibility"() TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."api_get_client_intake_compatibility"() TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."api_get_client_intake_compatibility"() TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."api_get_client_intake_compatibility"() TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."api_get_client_intake_compatibility"() TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."api_get_client_intake_compatibility"() TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."api_get_client_intake_compatibility"() TO "supabase_storage_admin";
GRANT EXECUTE ON FUNCTION "public"."api_get_is_platform_admin"() TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."api_get_is_platform_admin"() TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."api_get_is_platform_admin"() TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."api_get_is_platform_admin"() TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."api_get_is_platform_admin"() TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."api_get_is_platform_admin"() TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."api_get_is_platform_admin"() TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."api_get_is_platform_admin"() TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."api_get_is_platform_admin"() TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."api_get_is_platform_admin"() TO "supabase_storage_admin";
GRANT EXECUTE ON FUNCTION "public"."api_get_quote_run_readiness"(p_quote_run_id uuid) TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."api_get_quote_run_readiness"(p_quote_run_id uuid) TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."api_get_quote_run_readiness"(p_quote_run_id uuid) TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."api_get_quote_run_readiness"(p_quote_run_id uuid) TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."api_get_quote_run_readiness"(p_quote_run_id uuid) TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."api_get_quote_run_readiness"(p_quote_run_id uuid) TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."api_get_quote_run_readiness"(p_quote_run_id uuid) TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."api_get_quote_run_readiness"(p_quote_run_id uuid) TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."api_get_quote_run_readiness"(p_quote_run_id uuid) TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."api_get_quote_run_readiness"(p_quote_run_id uuid) TO "supabase_storage_admin";
GRANT EXECUTE ON FUNCTION "public"."api_invite_project_member"(p_project_id uuid, p_email text, p_role project_role) TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."api_invite_project_member"(p_project_id uuid, p_email text, p_role project_role) TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."api_invite_project_member"(p_project_id uuid, p_email text, p_role project_role) TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."api_invite_project_member"(p_project_id uuid, p_email text, p_role project_role) TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."api_invite_project_member"(p_project_id uuid, p_email text, p_role project_role) TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."api_invite_project_member"(p_project_id uuid, p_email text, p_role project_role) TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."api_invite_project_member"(p_project_id uuid, p_email text, p_role project_role) TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."api_invite_project_member"(p_project_id uuid, p_email text, p_role project_role) TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."api_invite_project_member"(p_project_id uuid, p_email text, p_role project_role) TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."api_invite_project_member"(p_project_id uuid, p_email text, p_role project_role) TO "supabase_storage_admin";
GRANT EXECUTE ON FUNCTION "public"."api_list_client_activity_events"(p_job_ids uuid[], p_limit_per_job integer) TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."api_list_client_activity_events"(p_job_ids uuid[], p_limit_per_job integer) TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."api_list_client_activity_events"(p_job_ids uuid[], p_limit_per_job integer) TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."api_list_client_activity_events"(p_job_ids uuid[], p_limit_per_job integer) TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."api_list_client_activity_events"(p_job_ids uuid[], p_limit_per_job integer) TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."api_list_client_activity_events"(p_job_ids uuid[], p_limit_per_job integer) TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."api_list_client_activity_events"(p_job_ids uuid[], p_limit_per_job integer) TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."api_list_client_activity_events"(p_job_ids uuid[], p_limit_per_job integer) TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."api_list_client_activity_events"(p_job_ids uuid[], p_limit_per_job integer) TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."api_list_client_activity_events"(p_job_ids uuid[], p_limit_per_job integer) TO "supabase_storage_admin";
GRANT EXECUTE ON FUNCTION "public"."api_list_client_part_metadata"(p_job_ids uuid[]) TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."api_list_client_part_metadata"(p_job_ids uuid[]) TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."api_list_client_part_metadata"(p_job_ids uuid[]) TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."api_list_client_part_metadata"(p_job_ids uuid[]) TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."api_list_client_part_metadata"(p_job_ids uuid[]) TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."api_list_client_part_metadata"(p_job_ids uuid[]) TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."api_list_client_part_metadata"(p_job_ids uuid[]) TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."api_list_client_part_metadata"(p_job_ids uuid[]) TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."api_list_client_part_metadata"(p_job_ids uuid[]) TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."api_list_client_part_metadata"(p_job_ids uuid[]) TO "supabase_storage_admin";
GRANT EXECUTE ON FUNCTION "public"."api_list_client_quote_workspace"(p_job_ids uuid[]) TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."api_list_client_quote_workspace"(p_job_ids uuid[]) TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."api_list_client_quote_workspace"(p_job_ids uuid[]) TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."api_list_client_quote_workspace"(p_job_ids uuid[]) TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."api_list_client_quote_workspace"(p_job_ids uuid[]) TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."api_list_client_quote_workspace"(p_job_ids uuid[]) TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."api_list_client_quote_workspace"(p_job_ids uuid[]) TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."api_list_client_quote_workspace"(p_job_ids uuid[]) TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."api_list_client_quote_workspace"(p_job_ids uuid[]) TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."api_list_client_quote_workspace"(p_job_ids uuid[]) TO "supabase_storage_admin";
GRANT EXECUTE ON FUNCTION "public"."api_list_organization_memberships"(p_organization_id uuid) TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."api_list_organization_memberships"(p_organization_id uuid) TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."api_list_organization_memberships"(p_organization_id uuid) TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."api_list_organization_memberships"(p_organization_id uuid) TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."api_list_organization_memberships"(p_organization_id uuid) TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."api_list_organization_memberships"(p_organization_id uuid) TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."api_list_organization_memberships"(p_organization_id uuid) TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."api_list_organization_memberships"(p_organization_id uuid) TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."api_list_organization_memberships"(p_organization_id uuid) TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."api_list_organization_memberships"(p_organization_id uuid) TO "supabase_storage_admin";
GRANT EXECUTE ON FUNCTION "public"."api_list_project_assignee_profiles"(p_project_id uuid) TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."api_list_project_assignee_profiles"(p_project_id uuid) TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."api_list_project_assignee_profiles"(p_project_id uuid) TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."api_list_project_assignee_profiles"(p_project_id uuid) TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."api_list_project_assignee_profiles"(p_project_id uuid) TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."api_list_project_assignee_profiles"(p_project_id uuid) TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."api_list_project_assignee_profiles"(p_project_id uuid) TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."api_list_project_assignee_profiles"(p_project_id uuid) TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."api_list_project_assignee_profiles"(p_project_id uuid) TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."api_list_project_assignee_profiles"(p_project_id uuid) TO "supabase_storage_admin";
GRANT EXECUTE ON FUNCTION "public"."api_publish_quote_package"(p_job_id uuid, p_quote_run_id uuid, p_client_summary text, p_force boolean) TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."api_publish_quote_package"(p_job_id uuid, p_quote_run_id uuid, p_client_summary text, p_force boolean) TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."api_publish_quote_package"(p_job_id uuid, p_quote_run_id uuid, p_client_summary text, p_force boolean) TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."api_publish_quote_package"(p_job_id uuid, p_quote_run_id uuid, p_client_summary text, p_force boolean) TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."api_publish_quote_package"(p_job_id uuid, p_quote_run_id uuid, p_client_summary text, p_force boolean) TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."api_publish_quote_package"(p_job_id uuid, p_quote_run_id uuid, p_client_summary text, p_force boolean) TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."api_publish_quote_package"(p_job_id uuid, p_quote_run_id uuid, p_client_summary text, p_force boolean) TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."api_publish_quote_package"(p_job_id uuid, p_quote_run_id uuid, p_client_summary text, p_force boolean) TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."api_publish_quote_package"(p_job_id uuid, p_quote_run_id uuid, p_client_summary text, p_force boolean) TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."api_publish_quote_package"(p_job_id uuid, p_quote_run_id uuid, p_client_summary text, p_force boolean) TO "supabase_storage_admin";
GRANT EXECUTE ON FUNCTION "public"."api_reconcile_job_parts"(p_job_id uuid) TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."api_reconcile_job_parts"(p_job_id uuid) TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."api_reconcile_job_parts"(p_job_id uuid) TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."api_reconcile_job_parts"(p_job_id uuid) TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."api_reconcile_job_parts"(p_job_id uuid) TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."api_reconcile_job_parts"(p_job_id uuid) TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."api_reconcile_job_parts"(p_job_id uuid) TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."api_reconcile_job_parts"(p_job_id uuid) TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."api_reconcile_job_parts"(p_job_id uuid) TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."api_reconcile_job_parts"(p_job_id uuid) TO "supabase_storage_admin";
GRANT EXECUTE ON FUNCTION "public"."api_record_manual_vendor_quote"(p_job_id uuid, p_part_id uuid, p_vendor vendor_name, p_status vendor_status, p_summary_note text, p_source_text text, p_quote_url text, p_offers jsonb, p_artifacts jsonb) TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."api_record_manual_vendor_quote"(p_job_id uuid, p_part_id uuid, p_vendor vendor_name, p_status vendor_status, p_summary_note text, p_source_text text, p_quote_url text, p_offers jsonb, p_artifacts jsonb) TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."api_record_manual_vendor_quote"(p_job_id uuid, p_part_id uuid, p_vendor vendor_name, p_status vendor_status, p_summary_note text, p_source_text text, p_quote_url text, p_offers jsonb, p_artifacts jsonb) TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."api_record_manual_vendor_quote"(p_job_id uuid, p_part_id uuid, p_vendor vendor_name, p_status vendor_status, p_summary_note text, p_source_text text, p_quote_url text, p_offers jsonb, p_artifacts jsonb) TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."api_record_manual_vendor_quote"(p_job_id uuid, p_part_id uuid, p_vendor vendor_name, p_status vendor_status, p_summary_note text, p_source_text text, p_quote_url text, p_offers jsonb, p_artifacts jsonb) TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."api_record_manual_vendor_quote"(p_job_id uuid, p_part_id uuid, p_vendor vendor_name, p_status vendor_status, p_summary_note text, p_source_text text, p_quote_url text, p_offers jsonb, p_artifacts jsonb) TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."api_record_manual_vendor_quote"(p_job_id uuid, p_part_id uuid, p_vendor vendor_name, p_status vendor_status, p_summary_note text, p_source_text text, p_quote_url text, p_offers jsonb, p_artifacts jsonb) TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."api_record_manual_vendor_quote"(p_job_id uuid, p_part_id uuid, p_vendor vendor_name, p_status vendor_status, p_summary_note text, p_source_text text, p_quote_url text, p_offers jsonb, p_artifacts jsonb) TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."api_record_manual_vendor_quote"(p_job_id uuid, p_part_id uuid, p_vendor vendor_name, p_status vendor_status, p_summary_note text, p_source_text text, p_quote_url text, p_offers jsonb, p_artifacts jsonb) TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."api_record_manual_vendor_quote"(p_job_id uuid, p_part_id uuid, p_vendor vendor_name, p_status vendor_status, p_summary_note text, p_source_text text, p_quote_url text, p_offers jsonb, p_artifacts jsonb) TO "supabase_storage_admin";
GRANT EXECUTE ON FUNCTION "public"."api_remove_job_from_project"(p_job_id uuid, p_project_id uuid) TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."api_remove_job_from_project"(p_job_id uuid, p_project_id uuid) TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."api_remove_job_from_project"(p_job_id uuid, p_project_id uuid) TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."api_remove_job_from_project"(p_job_id uuid, p_project_id uuid) TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."api_remove_job_from_project"(p_job_id uuid, p_project_id uuid) TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."api_remove_job_from_project"(p_job_id uuid, p_project_id uuid) TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."api_remove_job_from_project"(p_job_id uuid, p_project_id uuid) TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."api_remove_job_from_project"(p_job_id uuid, p_project_id uuid) TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."api_remove_job_from_project"(p_job_id uuid, p_project_id uuid) TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."api_remove_job_from_project"(p_job_id uuid, p_project_id uuid) TO "supabase_storage_admin";
GRANT EXECUTE ON FUNCTION "public"."api_remove_project_member"(p_project_membership_id uuid) TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."api_remove_project_member"(p_project_membership_id uuid) TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."api_remove_project_member"(p_project_membership_id uuid) TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."api_remove_project_member"(p_project_membership_id uuid) TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."api_remove_project_member"(p_project_membership_id uuid) TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."api_remove_project_member"(p_project_membership_id uuid) TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."api_remove_project_member"(p_project_membership_id uuid) TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."api_remove_project_member"(p_project_membership_id uuid) TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."api_remove_project_member"(p_project_membership_id uuid) TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."api_remove_project_member"(p_project_membership_id uuid) TO "supabase_storage_admin";
GRANT EXECUTE ON FUNCTION "public"."api_request_debug_extraction"(p_part_id uuid, p_model text) TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."api_request_debug_extraction"(p_part_id uuid, p_model text) TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."api_request_debug_extraction"(p_part_id uuid, p_model text) TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."api_request_debug_extraction"(p_part_id uuid, p_model text) TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."api_request_debug_extraction"(p_part_id uuid, p_model text) TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."api_request_debug_extraction"(p_part_id uuid, p_model text) TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."api_request_debug_extraction"(p_part_id uuid, p_model text) TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."api_request_debug_extraction"(p_part_id uuid, p_model text) TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."api_request_debug_extraction"(p_part_id uuid, p_model text) TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."api_request_debug_extraction"(p_part_id uuid, p_model text) TO "supabase_storage_admin";
GRANT EXECUTE ON FUNCTION "public"."api_request_extraction"(p_job_id uuid) TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."api_request_extraction"(p_job_id uuid) TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."api_request_extraction"(p_job_id uuid) TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."api_request_extraction"(p_job_id uuid) TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."api_request_extraction"(p_job_id uuid) TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."api_request_extraction"(p_job_id uuid) TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."api_request_extraction"(p_job_id uuid) TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."api_request_extraction"(p_job_id uuid) TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."api_request_extraction"(p_job_id uuid) TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."api_request_extraction"(p_job_id uuid) TO "supabase_storage_admin";
GRANT EXECUTE ON FUNCTION "public"."api_reset_client_part_property_overrides"(p_job_id uuid, p_fields text[]) TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."api_reset_client_part_property_overrides"(p_job_id uuid, p_fields text[]) TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."api_reset_client_part_property_overrides"(p_job_id uuid, p_fields text[]) TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."api_reset_client_part_property_overrides"(p_job_id uuid, p_fields text[]) TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."api_reset_client_part_property_overrides"(p_job_id uuid, p_fields text[]) TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."api_reset_client_part_property_overrides"(p_job_id uuid, p_fields text[]) TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."api_reset_client_part_property_overrides"(p_job_id uuid, p_fields text[]) TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."api_reset_client_part_property_overrides"(p_job_id uuid, p_fields text[]) TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."api_reset_client_part_property_overrides"(p_job_id uuid, p_fields text[]) TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."api_reset_client_part_property_overrides"(p_job_id uuid, p_fields text[]) TO "supabase_storage_admin";
GRANT EXECUTE ON FUNCTION "public"."api_start_quote_run"(p_job_id uuid, p_auto_publish_requested boolean) TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."api_start_quote_run"(p_job_id uuid, p_auto_publish_requested boolean) TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."api_start_quote_run"(p_job_id uuid, p_auto_publish_requested boolean) TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."api_start_quote_run"(p_job_id uuid, p_auto_publish_requested boolean) TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."api_start_quote_run"(p_job_id uuid, p_auto_publish_requested boolean) TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."api_start_quote_run"(p_job_id uuid, p_auto_publish_requested boolean) TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."api_start_quote_run"(p_job_id uuid, p_auto_publish_requested boolean) TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."api_start_quote_run"(p_job_id uuid, p_auto_publish_requested boolean) TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."api_start_quote_run"(p_job_id uuid, p_auto_publish_requested boolean) TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."api_start_quote_run"(p_job_id uuid, p_auto_publish_requested boolean) TO "supabase_storage_admin";
GRANT EXECUTE ON FUNCTION "public"."api_unarchive_job"(p_job_id uuid) TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."api_unarchive_job"(p_job_id uuid) TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."api_unarchive_job"(p_job_id uuid) TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."api_unarchive_job"(p_job_id uuid) TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."api_unarchive_job"(p_job_id uuid) TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."api_unarchive_job"(p_job_id uuid) TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."api_unarchive_job"(p_job_id uuid) TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."api_unarchive_job"(p_job_id uuid) TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."api_unarchive_job"(p_job_id uuid) TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."api_unarchive_job"(p_job_id uuid) TO "supabase_storage_admin";
GRANT EXECUTE ON FUNCTION "public"."api_unarchive_project"(p_project_id uuid) TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."api_unarchive_project"(p_project_id uuid) TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."api_unarchive_project"(p_project_id uuid) TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."api_unarchive_project"(p_project_id uuid) TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."api_unarchive_project"(p_project_id uuid) TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."api_unarchive_project"(p_project_id uuid) TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."api_unarchive_project"(p_project_id uuid) TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."api_unarchive_project"(p_project_id uuid) TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."api_unarchive_project"(p_project_id uuid) TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."api_unarchive_project"(p_project_id uuid) TO "supabase_storage_admin";
GRANT EXECUTE ON FUNCTION "public"."api_update_client_part_request"(p_job_id uuid, p_requested_service_kinds text[], p_primary_service_kind text, p_service_notes text, p_description text, p_part_number text, p_revision text, p_material text, p_finish text, p_threads text, p_tightest_tolerance_inch numeric, p_process text, p_notes text, p_quantity integer, p_requested_quote_quantities integer[], p_requested_by_date date, p_shipping jsonb, p_certifications jsonb, p_sourcing jsonb, p_release jsonb) TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."api_update_client_part_request"(p_job_id uuid, p_requested_service_kinds text[], p_primary_service_kind text, p_service_notes text, p_description text, p_part_number text, p_revision text, p_material text, p_finish text, p_threads text, p_tightest_tolerance_inch numeric, p_process text, p_notes text, p_quantity integer, p_requested_quote_quantities integer[], p_requested_by_date date, p_shipping jsonb, p_certifications jsonb, p_sourcing jsonb, p_release jsonb) TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."api_update_client_part_request"(p_job_id uuid, p_requested_service_kinds text[], p_primary_service_kind text, p_service_notes text, p_description text, p_part_number text, p_revision text, p_material text, p_finish text, p_threads text, p_tightest_tolerance_inch numeric, p_process text, p_notes text, p_quantity integer, p_requested_quote_quantities integer[], p_requested_by_date date, p_shipping jsonb, p_certifications jsonb, p_sourcing jsonb, p_release jsonb) TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."api_update_client_part_request"(p_job_id uuid, p_requested_service_kinds text[], p_primary_service_kind text, p_service_notes text, p_description text, p_part_number text, p_revision text, p_material text, p_finish text, p_threads text, p_tightest_tolerance_inch numeric, p_process text, p_notes text, p_quantity integer, p_requested_quote_quantities integer[], p_requested_by_date date, p_shipping jsonb, p_certifications jsonb, p_sourcing jsonb, p_release jsonb) TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."api_update_client_part_request"(p_job_id uuid, p_requested_service_kinds text[], p_primary_service_kind text, p_service_notes text, p_description text, p_part_number text, p_revision text, p_material text, p_finish text, p_threads text, p_tightest_tolerance_inch numeric, p_process text, p_notes text, p_quantity integer, p_requested_quote_quantities integer[], p_requested_by_date date, p_shipping jsonb, p_certifications jsonb, p_sourcing jsonb, p_release jsonb) TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."api_update_client_part_request"(p_job_id uuid, p_requested_service_kinds text[], p_primary_service_kind text, p_service_notes text, p_description text, p_part_number text, p_revision text, p_material text, p_finish text, p_threads text, p_tightest_tolerance_inch numeric, p_process text, p_notes text, p_quantity integer, p_requested_quote_quantities integer[], p_requested_by_date date, p_shipping jsonb, p_certifications jsonb, p_sourcing jsonb, p_release jsonb) TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."api_update_client_part_request"(p_job_id uuid, p_requested_service_kinds text[], p_primary_service_kind text, p_service_notes text, p_description text, p_part_number text, p_revision text, p_material text, p_finish text, p_threads text, p_tightest_tolerance_inch numeric, p_process text, p_notes text, p_quantity integer, p_requested_quote_quantities integer[], p_requested_by_date date, p_shipping jsonb, p_certifications jsonb, p_sourcing jsonb, p_release jsonb) TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."api_update_client_part_request"(p_job_id uuid, p_requested_service_kinds text[], p_primary_service_kind text, p_service_notes text, p_description text, p_part_number text, p_revision text, p_material text, p_finish text, p_threads text, p_tightest_tolerance_inch numeric, p_process text, p_notes text, p_quantity integer, p_requested_quote_quantities integer[], p_requested_by_date date, p_shipping jsonb, p_certifications jsonb, p_sourcing jsonb, p_release jsonb) TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."api_update_client_part_request"(p_job_id uuid, p_requested_service_kinds text[], p_primary_service_kind text, p_service_notes text, p_description text, p_part_number text, p_revision text, p_material text, p_finish text, p_threads text, p_tightest_tolerance_inch numeric, p_process text, p_notes text, p_quantity integer, p_requested_quote_quantities integer[], p_requested_by_date date, p_shipping jsonb, p_certifications jsonb, p_sourcing jsonb, p_release jsonb) TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."api_update_client_part_request"(p_job_id uuid, p_requested_service_kinds text[], p_primary_service_kind text, p_service_notes text, p_description text, p_part_number text, p_revision text, p_material text, p_finish text, p_threads text, p_tightest_tolerance_inch numeric, p_process text, p_notes text, p_quantity integer, p_requested_quote_quantities integer[], p_requested_by_date date, p_shipping jsonb, p_certifications jsonb, p_sourcing jsonb, p_release jsonb) TO "supabase_storage_admin";
GRANT EXECUTE ON FUNCTION "public"."api_update_organization_membership_role"(p_membership_id uuid, p_role app_role) TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."api_update_organization_membership_role"(p_membership_id uuid, p_role app_role) TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."api_update_organization_membership_role"(p_membership_id uuid, p_role app_role) TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."api_update_organization_membership_role"(p_membership_id uuid, p_role app_role) TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."api_update_organization_membership_role"(p_membership_id uuid, p_role app_role) TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."api_update_organization_membership_role"(p_membership_id uuid, p_role app_role) TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."api_update_organization_membership_role"(p_membership_id uuid, p_role app_role) TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."api_update_organization_membership_role"(p_membership_id uuid, p_role app_role) TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."api_update_organization_membership_role"(p_membership_id uuid, p_role app_role) TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."api_update_organization_membership_role"(p_membership_id uuid, p_role app_role) TO "supabase_storage_admin";
GRANT EXECUTE ON FUNCTION "public"."api_update_project"(p_project_id uuid, p_name text, p_description text) TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."api_update_project"(p_project_id uuid, p_name text, p_description text) TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."api_update_project"(p_project_id uuid, p_name text, p_description text) TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."api_update_project"(p_project_id uuid, p_name text, p_description text) TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."api_update_project"(p_project_id uuid, p_name text, p_description text) TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."api_update_project"(p_project_id uuid, p_name text, p_description text) TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."api_update_project"(p_project_id uuid, p_name text, p_description text) TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."api_update_project"(p_project_id uuid, p_name text, p_description text) TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."api_update_project"(p_project_id uuid, p_name text, p_description text) TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."api_update_project"(p_project_id uuid, p_name text, p_description text) TO "supabase_storage_admin";
GRANT EXECUTE ON FUNCTION "public"."apply_markup"(p_raw_amount numeric, p_markup_percent numeric, p_minor_unit numeric) TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."apply_markup"(p_raw_amount numeric, p_markup_percent numeric, p_minor_unit numeric) TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."apply_markup"(p_raw_amount numeric, p_markup_percent numeric, p_minor_unit numeric) TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."apply_markup"(p_raw_amount numeric, p_markup_percent numeric, p_minor_unit numeric) TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."apply_markup"(p_raw_amount numeric, p_markup_percent numeric, p_minor_unit numeric) TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."apply_markup"(p_raw_amount numeric, p_markup_percent numeric, p_minor_unit numeric) TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."apply_markup"(p_raw_amount numeric, p_markup_percent numeric, p_minor_unit numeric) TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."apply_markup"(p_raw_amount numeric, p_markup_percent numeric, p_minor_unit numeric) TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."apply_markup"(p_raw_amount numeric, p_markup_percent numeric, p_minor_unit numeric) TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."apply_markup"(p_raw_amount numeric, p_markup_percent numeric, p_minor_unit numeric) TO "supabase_storage_admin";
GRANT EXECUTE ON FUNCTION "public"."build_org_file_blob_storage_path"(p_organization_id uuid, p_content_sha256 text, p_original_name text) TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."build_org_file_blob_storage_path"(p_organization_id uuid, p_content_sha256 text, p_original_name text) TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."build_org_file_blob_storage_path"(p_organization_id uuid, p_content_sha256 text, p_original_name text) TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."build_org_file_blob_storage_path"(p_organization_id uuid, p_content_sha256 text, p_original_name text) TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."build_org_file_blob_storage_path"(p_organization_id uuid, p_content_sha256 text, p_original_name text) TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."build_org_file_blob_storage_path"(p_organization_id uuid, p_content_sha256 text, p_original_name text) TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."build_org_file_blob_storage_path"(p_organization_id uuid, p_content_sha256 text, p_original_name text) TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."build_org_file_blob_storage_path"(p_organization_id uuid, p_content_sha256 text, p_original_name text) TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."build_org_file_blob_storage_path"(p_organization_id uuid, p_content_sha256 text, p_original_name text) TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."build_org_file_blob_storage_path"(p_organization_id uuid, p_content_sha256 text, p_original_name text) TO "supabase_storage_admin";
GRANT EXECUTE ON FUNCTION "public"."build_project_part_property_snapshot"(p_spec_snapshot jsonb, p_defaults jsonb, p_overrides jsonb, p_created_at text, p_updated_at timestamp with time zone, p_description text, p_part_number text, p_material text, p_finish text, p_threads text, p_tightest_tolerance_inch numeric, p_revision text, p_process text) TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."build_project_part_property_snapshot"(p_spec_snapshot jsonb, p_defaults jsonb, p_overrides jsonb, p_created_at text, p_updated_at timestamp with time zone, p_description text, p_part_number text, p_material text, p_finish text, p_threads text, p_tightest_tolerance_inch numeric, p_revision text, p_process text) TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."build_project_part_property_snapshot"(p_spec_snapshot jsonb, p_defaults jsonb, p_overrides jsonb, p_created_at text, p_updated_at timestamp with time zone, p_description text, p_part_number text, p_material text, p_finish text, p_threads text, p_tightest_tolerance_inch numeric, p_revision text, p_process text) TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."build_project_part_property_snapshot"(p_spec_snapshot jsonb, p_defaults jsonb, p_overrides jsonb, p_created_at text, p_updated_at timestamp with time zone, p_description text, p_part_number text, p_material text, p_finish text, p_threads text, p_tightest_tolerance_inch numeric, p_revision text, p_process text) TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."build_project_part_property_snapshot"(p_spec_snapshot jsonb, p_defaults jsonb, p_overrides jsonb, p_created_at text, p_updated_at timestamp with time zone, p_description text, p_part_number text, p_material text, p_finish text, p_threads text, p_tightest_tolerance_inch numeric, p_revision text, p_process text) TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."build_project_part_property_snapshot"(p_spec_snapshot jsonb, p_defaults jsonb, p_overrides jsonb, p_created_at text, p_updated_at timestamp with time zone, p_description text, p_part_number text, p_material text, p_finish text, p_threads text, p_tightest_tolerance_inch numeric, p_revision text, p_process text) TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."build_project_part_property_snapshot"(p_spec_snapshot jsonb, p_defaults jsonb, p_overrides jsonb, p_created_at text, p_updated_at timestamp with time zone, p_description text, p_part_number text, p_material text, p_finish text, p_threads text, p_tightest_tolerance_inch numeric, p_revision text, p_process text) TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."build_project_part_property_snapshot"(p_spec_snapshot jsonb, p_defaults jsonb, p_overrides jsonb, p_created_at text, p_updated_at timestamp with time zone, p_description text, p_part_number text, p_material text, p_finish text, p_threads text, p_tightest_tolerance_inch numeric, p_revision text, p_process text) TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."build_project_part_property_snapshot"(p_spec_snapshot jsonb, p_defaults jsonb, p_overrides jsonb, p_created_at text, p_updated_at timestamp with time zone, p_description text, p_part_number text, p_material text, p_finish text, p_threads text, p_tightest_tolerance_inch numeric, p_revision text, p_process text) TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."build_project_part_property_snapshot"(p_spec_snapshot jsonb, p_defaults jsonb, p_overrides jsonb, p_created_at text, p_updated_at timestamp with time zone, p_description text, p_part_number text, p_material text, p_finish text, p_threads text, p_tightest_tolerance_inch numeric, p_revision text, p_process text) TO "supabase_storage_admin";
GRANT EXECUTE ON FUNCTION "public"."build_project_part_property_snapshot"(p_spec_snapshot jsonb, p_defaults jsonb, p_overrides jsonb, p_created_at text, p_updated_at timestamp with time zone, p_description text, p_part_number text, p_material text, p_finish text, p_threads text, p_tightest_tolerance_inch numeric) TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."build_project_part_property_snapshot"(p_spec_snapshot jsonb, p_defaults jsonb, p_overrides jsonb, p_created_at text, p_updated_at timestamp with time zone, p_description text, p_part_number text, p_material text, p_finish text, p_threads text, p_tightest_tolerance_inch numeric) TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."build_project_part_property_snapshot"(p_spec_snapshot jsonb, p_defaults jsonb, p_overrides jsonb, p_created_at text, p_updated_at timestamp with time zone, p_description text, p_part_number text, p_material text, p_finish text, p_threads text, p_tightest_tolerance_inch numeric) TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."build_project_part_property_snapshot"(p_spec_snapshot jsonb, p_defaults jsonb, p_overrides jsonb, p_created_at text, p_updated_at timestamp with time zone, p_description text, p_part_number text, p_material text, p_finish text, p_threads text, p_tightest_tolerance_inch numeric) TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."build_project_part_property_snapshot"(p_spec_snapshot jsonb, p_defaults jsonb, p_overrides jsonb, p_created_at text, p_updated_at timestamp with time zone, p_description text, p_part_number text, p_material text, p_finish text, p_threads text, p_tightest_tolerance_inch numeric) TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."build_project_part_property_snapshot"(p_spec_snapshot jsonb, p_defaults jsonb, p_overrides jsonb, p_created_at text, p_updated_at timestamp with time zone, p_description text, p_part_number text, p_material text, p_finish text, p_threads text, p_tightest_tolerance_inch numeric) TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."build_project_part_property_snapshot"(p_spec_snapshot jsonb, p_defaults jsonb, p_overrides jsonb, p_created_at text, p_updated_at timestamp with time zone, p_description text, p_part_number text, p_material text, p_finish text, p_threads text, p_tightest_tolerance_inch numeric) TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."build_project_part_property_snapshot"(p_spec_snapshot jsonb, p_defaults jsonb, p_overrides jsonb, p_created_at text, p_updated_at timestamp with time zone, p_description text, p_part_number text, p_material text, p_finish text, p_threads text, p_tightest_tolerance_inch numeric) TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."build_project_part_property_snapshot"(p_spec_snapshot jsonb, p_defaults jsonb, p_overrides jsonb, p_created_at text, p_updated_at timestamp with time zone, p_description text, p_part_number text, p_material text, p_finish text, p_threads text, p_tightest_tolerance_inch numeric) TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."build_project_part_property_snapshot"(p_spec_snapshot jsonb, p_defaults jsonb, p_overrides jsonb, p_created_at text, p_updated_at timestamp with time zone, p_description text, p_part_number text, p_material text, p_finish text, p_threads text, p_tightest_tolerance_inch numeric) TO "supabase_storage_admin";
GRANT EXECUTE ON FUNCTION "public"."current_user_has_verified_auth"() TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."current_user_has_verified_auth"() TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."current_user_has_verified_auth"() TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."current_user_has_verified_auth"() TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."current_user_has_verified_auth"() TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."current_user_has_verified_auth"() TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."current_user_has_verified_auth"() TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."current_user_has_verified_auth"() TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."current_user_has_verified_auth"() TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."current_user_has_verified_auth"() TO "supabase_storage_admin";
GRANT EXECUTE ON FUNCTION "public"."current_user_home_organization_id"() TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."current_user_home_organization_id"() TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."current_user_home_organization_id"() TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."current_user_home_organization_id"() TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."current_user_home_organization_id"() TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."current_user_home_organization_id"() TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."current_user_home_organization_id"() TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."current_user_home_organization_id"() TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."current_user_home_organization_id"() TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."current_user_home_organization_id"() TO "supabase_storage_admin";
GRANT EXECUTE ON FUNCTION "public"."is_internal_user_any_org"() TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."is_internal_user_any_org"() TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."is_internal_user_any_org"() TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."is_internal_user_any_org"() TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."is_internal_user_any_org"() TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."is_internal_user_any_org"() TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."is_internal_user_any_org"() TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."is_internal_user_any_org"() TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."is_internal_user_any_org"() TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."is_internal_user_any_org"() TO "supabase_storage_admin";
GRANT EXECUTE ON FUNCTION "public"."is_internal_user"(p_organization_id uuid) TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."is_internal_user"(p_organization_id uuid) TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."is_internal_user"(p_organization_id uuid) TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."is_internal_user"(p_organization_id uuid) TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."is_internal_user"(p_organization_id uuid) TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."is_internal_user"(p_organization_id uuid) TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."is_internal_user"(p_organization_id uuid) TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."is_internal_user"(p_organization_id uuid) TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."is_internal_user"(p_organization_id uuid) TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."is_internal_user"(p_organization_id uuid) TO "supabase_storage_admin";
GRANT EXECUTE ON FUNCTION "public"."is_org_admin"(p_organization_id uuid) TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."is_org_admin"(p_organization_id uuid) TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."is_org_admin"(p_organization_id uuid) TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."is_org_admin"(p_organization_id uuid) TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."is_org_admin"(p_organization_id uuid) TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."is_org_admin"(p_organization_id uuid) TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."is_org_admin"(p_organization_id uuid) TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."is_org_admin"(p_organization_id uuid) TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."is_org_admin"(p_organization_id uuid) TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."is_org_admin"(p_organization_id uuid) TO "supabase_storage_admin";
GRANT EXECUTE ON FUNCTION "public"."is_platform_admin"() TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."is_platform_admin"() TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."is_platform_admin"() TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."is_platform_admin"() TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."is_platform_admin"() TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."is_platform_admin"() TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."is_platform_admin"() TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."is_platform_admin"() TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."is_platform_admin"() TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."is_platform_admin"() TO "supabase_storage_admin";
GRANT EXECUTE ON FUNCTION "public"."job_part_file_set"(p_job_id uuid) TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."job_part_file_set"(p_job_id uuid) TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."job_part_file_set"(p_job_id uuid) TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."job_part_file_set"(p_job_id uuid) TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."job_part_file_set"(p_job_id uuid) TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."job_part_file_set"(p_job_id uuid) TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."job_part_file_set"(p_job_id uuid) TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."job_part_file_set"(p_job_id uuid) TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."job_part_file_set"(p_job_id uuid) TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."job_part_file_set"(p_job_id uuid) TO "supabase_storage_admin";
GRANT EXECUTE ON FUNCTION "public"."load_editable_project_part_context"(p_job_id uuid) TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."load_editable_project_part_context"(p_job_id uuid) TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."load_editable_project_part_context"(p_job_id uuid) TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."load_editable_project_part_context"(p_job_id uuid) TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."load_editable_project_part_context"(p_job_id uuid) TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."load_editable_project_part_context"(p_job_id uuid) TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."load_editable_project_part_context"(p_job_id uuid) TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."load_editable_project_part_context"(p_job_id uuid) TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."load_editable_project_part_context"(p_job_id uuid) TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."load_editable_project_part_context"(p_job_id uuid) TO "supabase_storage_admin";
GRANT EXECUTE ON FUNCTION "public"."normalize_file_basename"(input_name text) TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."normalize_file_basename"(input_name text) TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."normalize_file_basename"(input_name text) TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."normalize_file_basename"(input_name text) TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."normalize_file_basename"(input_name text) TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."normalize_file_basename"(input_name text) TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."normalize_file_basename"(input_name text) TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."normalize_file_basename"(input_name text) TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."normalize_file_basename"(input_name text) TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."normalize_file_basename"(input_name text) TO "supabase_storage_admin";
GRANT EXECUTE ON FUNCTION "public"."normalize_positive_integer_array"(p_values integer[], p_fallback integer) TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."normalize_positive_integer_array"(p_values integer[], p_fallback integer) TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."normalize_positive_integer_array"(p_values integer[], p_fallback integer) TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."normalize_positive_integer_array"(p_values integer[], p_fallback integer) TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."normalize_positive_integer_array"(p_values integer[], p_fallback integer) TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."normalize_positive_integer_array"(p_values integer[], p_fallback integer) TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."normalize_positive_integer_array"(p_values integer[], p_fallback integer) TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."normalize_positive_integer_array"(p_values integer[], p_fallback integer) TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."normalize_positive_integer_array"(p_values integer[], p_fallback integer) TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."normalize_positive_integer_array"(p_values integer[], p_fallback integer) TO "supabase_storage_admin";
GRANT EXECUTE ON FUNCTION "public"."normalize_primary_service_kind"(p_requested_service_kinds text[], p_primary_service_kind text) TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."normalize_primary_service_kind"(p_requested_service_kinds text[], p_primary_service_kind text) TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."normalize_primary_service_kind"(p_requested_service_kinds text[], p_primary_service_kind text) TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."normalize_primary_service_kind"(p_requested_service_kinds text[], p_primary_service_kind text) TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."normalize_primary_service_kind"(p_requested_service_kinds text[], p_primary_service_kind text) TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."normalize_primary_service_kind"(p_requested_service_kinds text[], p_primary_service_kind text) TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."normalize_primary_service_kind"(p_requested_service_kinds text[], p_primary_service_kind text) TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."normalize_primary_service_kind"(p_requested_service_kinds text[], p_primary_service_kind text) TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."normalize_primary_service_kind"(p_requested_service_kinds text[], p_primary_service_kind text) TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."normalize_primary_service_kind"(p_requested_service_kinds text[], p_primary_service_kind text) TO "supabase_storage_admin";
GRANT EXECUTE ON FUNCTION "public"."normalize_project_part_threads"(p_extraction jsonb) TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."normalize_project_part_threads"(p_extraction jsonb) TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."normalize_project_part_threads"(p_extraction jsonb) TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."normalize_project_part_threads"(p_extraction jsonb) TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."normalize_project_part_threads"(p_extraction jsonb) TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."normalize_project_part_threads"(p_extraction jsonb) TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."normalize_project_part_threads"(p_extraction jsonb) TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."normalize_project_part_threads"(p_extraction jsonb) TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."normalize_project_part_threads"(p_extraction jsonb) TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."normalize_project_part_threads"(p_extraction jsonb) TO "supabase_storage_admin";
GRANT EXECUTE ON FUNCTION "public"."normalize_requested_service_kinds"(p_requested_service_kinds text[], p_primary_service_kind text) TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."normalize_requested_service_kinds"(p_requested_service_kinds text[], p_primary_service_kind text) TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."normalize_requested_service_kinds"(p_requested_service_kinds text[], p_primary_service_kind text) TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."normalize_requested_service_kinds"(p_requested_service_kinds text[], p_primary_service_kind text) TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."normalize_requested_service_kinds"(p_requested_service_kinds text[], p_primary_service_kind text) TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."normalize_requested_service_kinds"(p_requested_service_kinds text[], p_primary_service_kind text) TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."normalize_requested_service_kinds"(p_requested_service_kinds text[], p_primary_service_kind text) TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."normalize_requested_service_kinds"(p_requested_service_kinds text[], p_primary_service_kind text) TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."normalize_requested_service_kinds"(p_requested_service_kinds text[], p_primary_service_kind text) TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."normalize_requested_service_kinds"(p_requested_service_kinds text[], p_primary_service_kind text) TO "supabase_storage_admin";
GRANT EXECUTE ON FUNCTION "public"."require_verified_auth"() TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."require_verified_auth"() TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."require_verified_auth"() TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."require_verified_auth"() TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."require_verified_auth"() TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."require_verified_auth"() TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."require_verified_auth"() TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."require_verified_auth"() TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."require_verified_auth"() TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."require_verified_auth"() TO "supabase_storage_admin";
GRANT EXECUTE ON FUNCTION "public"."resolve_project_part_property_values"(p_defaults jsonb, p_overrides jsonb) TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."resolve_project_part_property_values"(p_defaults jsonb, p_overrides jsonb) TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."resolve_project_part_property_values"(p_defaults jsonb, p_overrides jsonb) TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."resolve_project_part_property_values"(p_defaults jsonb, p_overrides jsonb) TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."resolve_project_part_property_values"(p_defaults jsonb, p_overrides jsonb) TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."resolve_project_part_property_values"(p_defaults jsonb, p_overrides jsonb) TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."resolve_project_part_property_values"(p_defaults jsonb, p_overrides jsonb) TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."resolve_project_part_property_values"(p_defaults jsonb, p_overrides jsonb) TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."resolve_project_part_property_values"(p_defaults jsonb, p_overrides jsonb) TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."resolve_project_part_property_values"(p_defaults jsonb, p_overrides jsonb) TO "supabase_storage_admin";
GRANT EXECUTE ON FUNCTION "public"."seed_project_part_property_defaults"(p_requirement approved_part_requirements, p_extraction jsonb, p_defaults jsonb) TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."seed_project_part_property_defaults"(p_requirement approved_part_requirements, p_extraction jsonb, p_defaults jsonb) TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."seed_project_part_property_defaults"(p_requirement approved_part_requirements, p_extraction jsonb, p_defaults jsonb) TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."seed_project_part_property_defaults"(p_requirement approved_part_requirements, p_extraction jsonb, p_defaults jsonb) TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."seed_project_part_property_defaults"(p_requirement approved_part_requirements, p_extraction jsonb, p_defaults jsonb) TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."seed_project_part_property_defaults"(p_requirement approved_part_requirements, p_extraction jsonb, p_defaults jsonb) TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."seed_project_part_property_defaults"(p_requirement approved_part_requirements, p_extraction jsonb, p_defaults jsonb) TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."seed_project_part_property_defaults"(p_requirement approved_part_requirements, p_extraction jsonb, p_defaults jsonb) TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."seed_project_part_property_defaults"(p_requirement approved_part_requirements, p_extraction jsonb, p_defaults jsonb) TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."seed_project_part_property_defaults"(p_requirement approved_part_requirements, p_extraction jsonb, p_defaults jsonb) TO "supabase_storage_admin";
GRANT EXECUTE ON FUNCTION "public"."seed_revision_and_process_property_defaults"(p_requirement approved_part_requirements, p_extraction jsonb, p_defaults jsonb) TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."seed_revision_and_process_property_defaults"(p_requirement approved_part_requirements, p_extraction jsonb, p_defaults jsonb) TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."seed_revision_and_process_property_defaults"(p_requirement approved_part_requirements, p_extraction jsonb, p_defaults jsonb) TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."seed_revision_and_process_property_defaults"(p_requirement approved_part_requirements, p_extraction jsonb, p_defaults jsonb) TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."seed_revision_and_process_property_defaults"(p_requirement approved_part_requirements, p_extraction jsonb, p_defaults jsonb) TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."seed_revision_and_process_property_defaults"(p_requirement approved_part_requirements, p_extraction jsonb, p_defaults jsonb) TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."seed_revision_and_process_property_defaults"(p_requirement approved_part_requirements, p_extraction jsonb, p_defaults jsonb) TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."seed_revision_and_process_property_defaults"(p_requirement approved_part_requirements, p_extraction jsonb, p_defaults jsonb) TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."seed_revision_and_process_property_defaults"(p_requirement approved_part_requirements, p_extraction jsonb, p_defaults jsonb) TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."seed_revision_and_process_property_defaults"(p_requirement approved_part_requirements, p_extraction jsonb, p_defaults jsonb) TO "supabase_storage_admin";
GRANT EXECUTE ON FUNCTION "public"."spend_default_daily_ceiling_usd"() TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."spend_default_daily_ceiling_usd"() TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."spend_default_daily_ceiling_usd"() TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."spend_default_daily_ceiling_usd"() TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."spend_default_daily_ceiling_usd"() TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."spend_default_daily_ceiling_usd"() TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."spend_default_daily_ceiling_usd"() TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."spend_default_daily_ceiling_usd"() TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."spend_default_daily_ceiling_usd"() TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."spend_default_daily_ceiling_usd"() TO "supabase_storage_admin";
GRANT EXECUTE ON FUNCTION "public"."spend_default_per_run_ceiling_usd"() TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."spend_default_per_run_ceiling_usd"() TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."spend_default_per_run_ceiling_usd"() TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."spend_default_per_run_ceiling_usd"() TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."spend_default_per_run_ceiling_usd"() TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."spend_default_per_run_ceiling_usd"() TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."spend_default_per_run_ceiling_usd"() TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."spend_default_per_run_ceiling_usd"() TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."spend_default_per_run_ceiling_usd"() TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."spend_default_per_run_ceiling_usd"() TO "supabase_storage_admin";
GRANT EXECUTE ON FUNCTION "public"."sync_quote_request_status_from_vendor_result"() TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."sync_quote_request_status_from_vendor_result"() TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."sync_quote_request_status_from_vendor_result"() TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."sync_quote_request_status_from_vendor_result"() TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."sync_quote_request_status_from_vendor_result"() TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."sync_quote_request_status_from_vendor_result"() TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."sync_quote_request_status_from_vendor_result"() TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."sync_quote_request_status_from_vendor_result"() TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."sync_quote_request_status_from_vendor_result"() TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."sync_quote_request_status_from_vendor_result"() TO "supabase_storage_admin";
GRANT EXECUTE ON FUNCTION "public"."sync_service_request_line_item_status_from_quote_request"() TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."sync_service_request_line_item_status_from_quote_request"() TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."sync_service_request_line_item_status_from_quote_request"() TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."sync_service_request_line_item_status_from_quote_request"() TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."sync_service_request_line_item_status_from_quote_request"() TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."sync_service_request_line_item_status_from_quote_request"() TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."sync_service_request_line_item_status_from_quote_request"() TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."sync_service_request_line_item_status_from_quote_request"() TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."sync_service_request_line_item_status_from_quote_request"() TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."sync_service_request_line_item_status_from_quote_request"() TO "supabase_storage_admin";
GRANT EXECUTE ON FUNCTION "public"."to_vendor_name_array"(payload jsonb) TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."to_vendor_name_array"(payload jsonb) TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."to_vendor_name_array"(payload jsonb) TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."to_vendor_name_array"(payload jsonb) TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."to_vendor_name_array"(payload jsonb) TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."to_vendor_name_array"(payload jsonb) TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."to_vendor_name_array"(payload jsonb) TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."to_vendor_name_array"(payload jsonb) TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."to_vendor_name_array"(payload jsonb) TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."to_vendor_name_array"(payload jsonb) TO "supabase_storage_admin";
GRANT EXECUTE ON FUNCTION "public"."touch_updated_at"() TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."touch_updated_at"() TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."touch_updated_at"() TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."touch_updated_at"() TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."touch_updated_at"() TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."touch_updated_at"() TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."touch_updated_at"() TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."touch_updated_at"() TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."touch_updated_at"() TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."touch_updated_at"() TO "supabase_storage_admin";
GRANT EXECUTE ON FUNCTION "public"."user_can_access_job_via_project"(p_job_id uuid) TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."user_can_access_job_via_project"(p_job_id uuid) TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."user_can_access_job_via_project"(p_job_id uuid) TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."user_can_access_job_via_project"(p_job_id uuid) TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."user_can_access_job_via_project"(p_job_id uuid) TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."user_can_access_job_via_project"(p_job_id uuid) TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."user_can_access_job_via_project"(p_job_id uuid) TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."user_can_access_job_via_project"(p_job_id uuid) TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."user_can_access_job_via_project"(p_job_id uuid) TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."user_can_access_job_via_project"(p_job_id uuid) TO "supabase_storage_admin";
GRANT EXECUTE ON FUNCTION "public"."user_can_access_job"(p_job_id uuid) TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."user_can_access_job"(p_job_id uuid) TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."user_can_access_job"(p_job_id uuid) TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."user_can_access_job"(p_job_id uuid) TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."user_can_access_job"(p_job_id uuid) TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."user_can_access_job"(p_job_id uuid) TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."user_can_access_job"(p_job_id uuid) TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."user_can_access_job"(p_job_id uuid) TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."user_can_access_job"(p_job_id uuid) TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."user_can_access_job"(p_job_id uuid) TO "supabase_storage_admin";
GRANT EXECUTE ON FUNCTION "public"."user_can_access_org"(p_organization_id uuid) TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."user_can_access_org"(p_organization_id uuid) TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."user_can_access_org"(p_organization_id uuid) TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."user_can_access_org"(p_organization_id uuid) TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."user_can_access_org"(p_organization_id uuid) TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."user_can_access_org"(p_organization_id uuid) TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."user_can_access_org"(p_organization_id uuid) TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."user_can_access_org"(p_organization_id uuid) TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."user_can_access_org"(p_organization_id uuid) TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."user_can_access_org"(p_organization_id uuid) TO "supabase_storage_admin";
GRANT EXECUTE ON FUNCTION "public"."user_can_access_package"(p_package_id uuid) TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."user_can_access_package"(p_package_id uuid) TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."user_can_access_package"(p_package_id uuid) TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."user_can_access_package"(p_package_id uuid) TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."user_can_access_package"(p_package_id uuid) TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."user_can_access_package"(p_package_id uuid) TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."user_can_access_package"(p_package_id uuid) TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."user_can_access_package"(p_package_id uuid) TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."user_can_access_package"(p_package_id uuid) TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."user_can_access_package"(p_package_id uuid) TO "supabase_storage_admin";
GRANT EXECUTE ON FUNCTION "public"."user_can_access_project"(p_project_id uuid) TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."user_can_access_project"(p_project_id uuid) TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."user_can_access_project"(p_project_id uuid) TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."user_can_access_project"(p_project_id uuid) TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."user_can_access_project"(p_project_id uuid) TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."user_can_access_project"(p_project_id uuid) TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."user_can_access_project"(p_project_id uuid) TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."user_can_access_project"(p_project_id uuid) TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."user_can_access_project"(p_project_id uuid) TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."user_can_access_project"(p_project_id uuid) TO "supabase_storage_admin";
GRANT EXECUTE ON FUNCTION "public"."user_can_destructively_edit_job"(p_job_id uuid) TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."user_can_destructively_edit_job"(p_job_id uuid) TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."user_can_destructively_edit_job"(p_job_id uuid) TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."user_can_destructively_edit_job"(p_job_id uuid) TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."user_can_destructively_edit_job"(p_job_id uuid) TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."user_can_destructively_edit_job"(p_job_id uuid) TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."user_can_destructively_edit_job"(p_job_id uuid) TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."user_can_destructively_edit_job"(p_job_id uuid) TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."user_can_destructively_edit_job"(p_job_id uuid) TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."user_can_destructively_edit_job"(p_job_id uuid) TO "supabase_storage_admin";
GRANT EXECUTE ON FUNCTION "public"."user_can_edit_job"(p_job_id uuid) TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."user_can_edit_job"(p_job_id uuid) TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."user_can_edit_job"(p_job_id uuid) TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."user_can_edit_job"(p_job_id uuid) TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."user_can_edit_job"(p_job_id uuid) TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."user_can_edit_job"(p_job_id uuid) TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."user_can_edit_job"(p_job_id uuid) TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."user_can_edit_job"(p_job_id uuid) TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."user_can_edit_job"(p_job_id uuid) TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."user_can_edit_job"(p_job_id uuid) TO "supabase_storage_admin";
GRANT EXECUTE ON FUNCTION "public"."user_can_edit_project"(p_project_id uuid) TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."user_can_edit_project"(p_project_id uuid) TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."user_can_edit_project"(p_project_id uuid) TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."user_can_edit_project"(p_project_id uuid) TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."user_can_edit_project"(p_project_id uuid) TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."user_can_edit_project"(p_project_id uuid) TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."user_can_edit_project"(p_project_id uuid) TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."user_can_edit_project"(p_project_id uuid) TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."user_can_edit_project"(p_project_id uuid) TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."user_can_edit_project"(p_project_id uuid) TO "supabase_storage_admin";
GRANT EXECUTE ON FUNCTION "public"."user_is_project_owner"(p_project_id uuid) TO "authenticator";
GRANT EXECUTE ON FUNCTION "public"."user_is_project_owner"(p_project_id uuid) TO "dashboard_user";
GRANT EXECUTE ON FUNCTION "public"."user_is_project_owner"(p_project_id uuid) TO "ovd575_observer_validator";
GRANT EXECUTE ON FUNCTION "public"."user_is_project_owner"(p_project_id uuid) TO "ovd576_stop_validator";
GRANT EXECUTE ON FUNCTION "public"."user_is_project_owner"(p_project_id uuid) TO "supabase_auth_admin";
GRANT EXECUTE ON FUNCTION "public"."user_is_project_owner"(p_project_id uuid) TO "supabase_etl_admin";
GRANT EXECUTE ON FUNCTION "public"."user_is_project_owner"(p_project_id uuid) TO "supabase_privileged_role";
GRANT EXECUTE ON FUNCTION "public"."user_is_project_owner"(p_project_id uuid) TO "supabase_read_only_user";
GRANT EXECUTE ON FUNCTION "public"."user_is_project_owner"(p_project_id uuid) TO "supabase_replication_admin";
GRANT EXECUTE ON FUNCTION "public"."user_is_project_owner"(p_project_id uuid) TO "supabase_storage_admin";
RESET ROLE;

grant usage on schema public, engineering_private, storage to engineering_native_verifier;
grant select on storage.objects to engineering_native_verifier;
grant execute on function public.api_load_native_verification(uuid,uuid),
  public.api_complete_native_verification(uuid,text),
  public.api_reject_native_verification(uuid,jsonb),
  engineering_private.load_native_verification(uuid,uuid),
  engineering_private.complete_native_verification(uuid,text),
  engineering_private.reject_native_verification(uuid,jsonb),
  engineering_private.native_verifier_can_read_object(text,text)
  to engineering_native_verifier;
grant engineering_native_verifier to authenticator
  with inherit false, set true, admin false;
create policy ovd510_verifier_registered_permissive on storage.objects
  as permissive for select to engineering_native_verifier
  using (engineering_private.native_verifier_can_read_object(bucket_id, name));
create policy ovd510_verifier_registered_restrictive on storage.objects
  as restrictive for select to engineering_native_verifier
  using (engineering_private.native_verifier_can_read_object(bucket_id, name));

do $ovd558_postflight$ declare actual text; found text[]; anon_found text[];
  saved_search_path text := current_setting('search_path');
begin
  perform set_config('search_path', 'pg_catalog', true);
  select (select coalesce(array_agg(p.oid::regprocedure::text
      order by p.oid::regprocedure::text collate "C"), '{}')
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public','engineering_private') and has_schema_privilege('engineering_native_verifier', n.oid, 'USAGE')
      and has_function_privilege('engineering_native_verifier', p.oid, 'EXECUTE')) into found;
  if found is distinct from array['engineering_private.complete_native_verification(uuid,text)',
    'engineering_private.load_native_verification(uuid,uuid)',
    'engineering_private.native_verifier_can_read_object(text,text)',
    'engineering_private.reject_native_verification(uuid,jsonb)',
    'public.api_complete_native_verification(uuid,text)',
    'public.api_load_native_verification(uuid,uuid)',
    'public.api_reject_native_verification(uuid,jsonb)']::text[] then
    raise exception 'ovd558_verifier_app_allowlist_mismatch:%', found;
  end if;
  select (select coalesce(array_agg(p.oid::regprocedure::text
      order by p.oid::regprocedure::text collate "C"), '{}')
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'storage' and has_schema_privilege('engineering_native_verifier', n.oid, 'USAGE')
      and has_function_privilege('engineering_native_verifier', p.oid, 'EXECUTE')) into found;
  select (select coalesce(array_agg(p.oid::regprocedure::text
      order by p.oid::regprocedure::text collate "C"), '{}')
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'storage' and has_schema_privilege('anon', n.oid, 'USAGE')
      and has_function_privilege('anon', p.oid, 'EXECUTE')) into anon_found;
  if found is distinct from anon_found then
    raise exception 'ovd558_verifier_storage_functions_exceed_anon:%', found;
  end if;
  -- Fails closed when a Supabase Storage upgrade adds or changes a function.
  if anon_found is distinct from array['storage.can_insert_object(text,text,uuid,jsonb)',
    'storage.delete_leaf_prefixes(text[],text[])',
    'storage.enforce_bucket_name_length()',
    'storage.extension(text)',
    'storage.filename(text)',
    'storage.foldername(text)',
    'storage.get_common_prefix(text,text,text)',
    'storage.get_level(text)',
    'storage.get_prefix(text)',
    'storage.get_prefixes(text)',
    'storage.get_size_by_bucket()',
    'storage.list_multipart_uploads_with_delimiter(text,text,text,integer,text,text)',
    'storage.list_objects_with_delimiter(text,text,text,integer,text,text,text)',
    'storage.operation()',
    'storage.protect_delete()',
    'storage.search(text,text,integer,integer,integer,text,text,text)',
    'storage.search_by_timestamp(text,text,integer,integer,text,text,text,text)',
    'storage.search_legacy_v1(text,text,integer,integer,integer,text,text,text)',
    'storage.search_v2(text,text,integer,integer,text,text,text,text)',
    'storage.update_updated_at_column()']::text[] then
    raise exception 'ovd558_storage_anon_functions_changed:%', anon_found;
  end if;
  if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) as priv(name)
      where n.nspname = 'storage' and c.relkind in ('r','p','v','m','f')
        and has_table_privilege('engineering_native_verifier', c.oid, priv.name)
        and not has_table_privilege('anon', c.oid, priv.name)) then
    raise exception 'ovd558_verifier_storage_table_exceeds_anon';
  end if;
  if exists (select 1 from pg_namespace n where n.nspname not like 'pg_%' and n.nspname <> 'information_schema'
      and (has_schema_privilege('engineering_native_verifier', n.oid, 'CREATE')
        or has_schema_privilege('engineering_native_verifier', n.oid, 'USAGE')
          <> (n.nspname in ('public','engineering_private','storage')))) then
    raise exception 'ovd558_verifier_schema_authority_mismatch';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public','engineering_private')
      and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f',p.proowner))) a
        where a.grantee = 0 and a.privilege_type = 'EXECUTE')) then
    raise exception 'ovd558_public_execute_leak';
  end if;
  perform set_config('search_path', saved_search_path, true);
  perform set_config('search_path', 'pg_catalog', true);
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
  perform set_config('search_path', saved_search_path, true);
  if actual is distinct from 'be97ed54f5f3f97d4c25f1709a6ed415c6edc912a0237c36471c45e327d981a8' then
    raise exception 'ovd558_postchange_catalog_mismatch:%', actual;
  end if;
end $ovd558_postflight$;
commit;
