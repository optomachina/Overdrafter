-- OVD-736: anon and PUBLIC must not execute any SECURITY DEFINER function in an
-- application schema. Pins the full catalog wide allowlist, proves every revoked
-- function now refuses anon (and authenticated where revoked), proves anon table
-- reads behave exactly as before, proves a signed in member still reaches their
-- own rows through the helper backed RLS policies, proves triggers still fire
-- when the writer lacks EXECUTE on the trigger function, and round trips the
-- rollback. Synthetic records only; everything rolls back.
begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(87);

\set user_a 73600000-0000-4000-8000-000000000001
\set user_b 73600000-0000-4000-8000-000000000002
\set org_a 73600000-0000-4000-8000-00000000000a
\set org_b 73600000-0000-4000-8000-00000000000b
\set project_a 73600000-0000-4000-8000-000000000020
\set job_a 73600000-0000-4000-8000-000000000011
\set part_a 73600000-0000-4000-8000-000000000013
\set request_a 73600000-0000-4000-8000-000000000014
\set run_a 73600000-0000-4000-8000-000000000015
\set result_a 73600000-0000-4000-8000-000000000016
\set absent 73600000-0000-4000-8000-0000000000ff

-- The 56 functions OVD-736 changes, with the exact ACL every one of them had
-- before (local stack and the 2026-10-12 production inventory agree).
create temp table ovd736_target (sig text primary key, keeps_authenticated boolean not null, call_sql text not null);
insert into ovd736_target values
  ('public.api_accept_project_invite(text)', true, $c$select * from public.api_accept_project_invite('ovd736')$c$),
  ('public.api_admin_list_all_jobs()', true, $c$select * from public.api_admin_list_all_jobs()$c$),
  ('public.api_admin_list_all_projects()', true, $c$select * from public.api_admin_list_all_projects()$c$),
  ('public.api_admin_list_all_users()', true, $c$select * from public.api_admin_list_all_users()$c$),
  ('public.api_admin_list_organizations()', true, $c$select * from public.api_admin_list_organizations()$c$),
  ('public.api_approve_job_requirements(uuid,jsonb)', true, $c$select * from public.api_approve_job_requirements('73600000-0000-4000-8000-0000000000ff'::uuid, '{}'::jsonb)$c$),
  ('public.api_archive_job(uuid)', true, $c$select * from public.api_archive_job('73600000-0000-4000-8000-0000000000ff'::uuid)$c$),
  ('public.api_archive_project(uuid)', true, $c$select * from public.api_archive_project('73600000-0000-4000-8000-0000000000ff'::uuid)$c$),
  ('public.api_assign_job_to_project(uuid,uuid)', true, $c$select * from public.api_assign_job_to_project('73600000-0000-4000-8000-0000000000ff'::uuid, '73600000-0000-4000-8000-0000000000ff'::uuid)$c$),
  ('public.api_cancel_quote_request(uuid)', true, $c$select * from public.api_cancel_quote_request('73600000-0000-4000-8000-0000000000ff'::uuid)$c$),
  ('public.api_create_project(text,text)', true, $c$select * from public.api_create_project('ovd736', 'ovd736')$c$),
  ('public.api_create_self_service_organization(text)', true, $c$select * from public.api_create_self_service_organization('ovd736')$c$),
  ('public.api_delete_project(uuid)', true, $c$select * from public.api_delete_project('73600000-0000-4000-8000-0000000000ff'::uuid)$c$),
  ('public.api_dissolve_project(uuid)', true, $c$select * from public.api_dissolve_project('73600000-0000-4000-8000-0000000000ff'::uuid)$c$),
  ('public.api_get_client_intake_compatibility()', true, $c$select * from public.api_get_client_intake_compatibility()$c$),
  ('public.api_get_is_platform_admin()', true, $c$select * from public.api_get_is_platform_admin()$c$),
  ('public.api_get_quote_run_readiness(uuid)', true, $c$select * from public.api_get_quote_run_readiness('73600000-0000-4000-8000-0000000000ff'::uuid)$c$),
  ('public.api_invite_project_member(uuid,text,public.project_role)', true, $c$select * from public.api_invite_project_member('73600000-0000-4000-8000-0000000000ff'::uuid, 'ovd736', 'editor'::public.project_role)$c$),
  ('public.api_list_client_activity_events(uuid[],integer)', true, $c$select * from public.api_list_client_activity_events(array['73600000-0000-4000-8000-0000000000ff']::uuid[], 1)$c$),
  ('public.api_list_client_part_metadata(uuid[])', true, $c$select * from public.api_list_client_part_metadata(array['73600000-0000-4000-8000-0000000000ff']::uuid[])$c$),
  ('public.api_list_client_quote_workspace(uuid[])', true, $c$select * from public.api_list_client_quote_workspace(array['73600000-0000-4000-8000-0000000000ff']::uuid[])$c$),
  ('public.api_list_organization_memberships(uuid)', true, $c$select * from public.api_list_organization_memberships('73600000-0000-4000-8000-0000000000ff'::uuid)$c$),
  ('public.api_list_project_assignee_profiles(uuid)', true, $c$select * from public.api_list_project_assignee_profiles('73600000-0000-4000-8000-0000000000ff'::uuid)$c$),
  ('public.api_publish_quote_package(uuid,uuid,text,boolean)', true, $c$select * from public.api_publish_quote_package('73600000-0000-4000-8000-0000000000ff'::uuid, '73600000-0000-4000-8000-0000000000ff'::uuid, 'ovd736', false)$c$),
  ('public.api_reconcile_job_parts(uuid)', true, $c$select * from public.api_reconcile_job_parts('73600000-0000-4000-8000-0000000000ff'::uuid)$c$),
  ('public.api_record_manual_vendor_quote(uuid,uuid,public.vendor_name,public.vendor_status,text,text,text,jsonb,jsonb)', true, $c$select * from public.api_record_manual_vendor_quote('73600000-0000-4000-8000-0000000000ff'::uuid, '73600000-0000-4000-8000-0000000000ff'::uuid, 'xometry'::public.vendor_name, 'queued'::public.vendor_status, 'ovd736', 'ovd736', 'ovd736', '{}'::jsonb, '{}'::jsonb)$c$),
  ('public.api_remove_job_from_project(uuid,uuid)', true, $c$select * from public.api_remove_job_from_project('73600000-0000-4000-8000-0000000000ff'::uuid, '73600000-0000-4000-8000-0000000000ff'::uuid)$c$),
  ('public.api_remove_project_member(uuid)', true, $c$select * from public.api_remove_project_member('73600000-0000-4000-8000-0000000000ff'::uuid)$c$),
  ('public.api_request_debug_extraction(uuid,text)', true, $c$select * from public.api_request_debug_extraction('73600000-0000-4000-8000-0000000000ff'::uuid, 'ovd736')$c$),
  ('public.api_request_extraction(uuid)', true, $c$select * from public.api_request_extraction('73600000-0000-4000-8000-0000000000ff'::uuid)$c$),
  ('public.api_reset_client_part_property_overrides(uuid,text[])', true, $c$select * from public.api_reset_client_part_property_overrides('73600000-0000-4000-8000-0000000000ff'::uuid, '{}'::text[])$c$),
  ('public.api_start_quote_run(uuid,boolean)', true, $c$select * from public.api_start_quote_run('73600000-0000-4000-8000-0000000000ff'::uuid, false)$c$),
  ('public.api_unarchive_job(uuid)', true, $c$select * from public.api_unarchive_job('73600000-0000-4000-8000-0000000000ff'::uuid)$c$),
  ('public.api_unarchive_project(uuid)', true, $c$select * from public.api_unarchive_project('73600000-0000-4000-8000-0000000000ff'::uuid)$c$),
  ('public.api_update_client_part_request(uuid,text[],text,text,text,text,text,text,text,text,numeric,text,text,integer,integer[],date,jsonb,jsonb,jsonb,jsonb)', true, $c$select * from public.api_update_client_part_request('73600000-0000-4000-8000-0000000000ff'::uuid, '{}'::text[], 'ovd736', 'ovd736', 'ovd736', 'ovd736', 'ovd736', 'ovd736', 'ovd736', 'ovd736', 1, 'ovd736', 'ovd736', 1, '{}'::integer[], current_date, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)$c$),
  ('public.api_update_organization_membership_role(uuid,public.app_role)', true, $c$select * from public.api_update_organization_membership_role('73600000-0000-4000-8000-0000000000ff'::uuid, 'client'::public.app_role)$c$),
  ('public.api_update_project(uuid,text,text)', true, $c$select * from public.api_update_project('73600000-0000-4000-8000-0000000000ff'::uuid, 'ovd736', 'ovd736')$c$),
  ('public.current_user_has_verified_auth()', false, $c$select * from public.current_user_has_verified_auth()$c$),
  ('public.current_user_home_organization_id()', false, $c$select * from public.current_user_home_organization_id()$c$),
  ('public.is_internal_user(uuid)', true, $c$select * from public.is_internal_user('73600000-0000-4000-8000-0000000000ff'::uuid)$c$),
  ('public.is_internal_user_any_org()', true, $c$select * from public.is_internal_user_any_org()$c$),
  ('public.is_org_admin(uuid)', true, $c$select * from public.is_org_admin('73600000-0000-4000-8000-0000000000ff'::uuid)$c$),
  ('public.is_platform_admin()', true, $c$select * from public.is_platform_admin()$c$),
  ('public.load_editable_project_part_context(uuid)', false, $c$select * from public.load_editable_project_part_context('73600000-0000-4000-8000-0000000000ff'::uuid)$c$),
  ('public.require_verified_auth()', false, $c$select * from public.require_verified_auth()$c$),
  ('public.sync_quote_request_status_from_vendor_result()', false, $c$select public.sync_quote_request_status_from_vendor_result()$c$),
  ('public.sync_service_request_line_item_status_from_quote_request()', false, $c$select public.sync_service_request_line_item_status_from_quote_request()$c$),
  ('public.user_can_access_job(uuid)', true, $c$select * from public.user_can_access_job('73600000-0000-4000-8000-0000000000ff'::uuid)$c$),
  ('public.user_can_access_job_via_project(uuid)', false, $c$select * from public.user_can_access_job_via_project('73600000-0000-4000-8000-0000000000ff'::uuid)$c$),
  ('public.user_can_access_org(uuid)', true, $c$select * from public.user_can_access_org('73600000-0000-4000-8000-0000000000ff'::uuid)$c$),
  ('public.user_can_access_package(uuid)', true, $c$select * from public.user_can_access_package('73600000-0000-4000-8000-0000000000ff'::uuid)$c$),
  ('public.user_can_access_project(uuid)', true, $c$select * from public.user_can_access_project('73600000-0000-4000-8000-0000000000ff'::uuid)$c$),
  ('public.user_can_destructively_edit_job(uuid)', false, $c$select * from public.user_can_destructively_edit_job('73600000-0000-4000-8000-0000000000ff'::uuid)$c$),
  ('public.user_can_edit_job(uuid)', true, $c$select * from public.user_can_edit_job('73600000-0000-4000-8000-0000000000ff'::uuid)$c$),
  ('public.user_can_edit_project(uuid)', true, $c$select * from public.user_can_edit_project('73600000-0000-4000-8000-0000000000ff'::uuid)$c$),
  ('public.user_is_project_owner(uuid)', true, $c$select * from public.user_is_project_owner('73600000-0000-4000-8000-0000000000ff'::uuid)$c$);

grant select on ovd736_target to anon, authenticated;

-- Every SECURITY DEFINER function in an application schema (anything that is not
-- a PostgreSQL, Supabase platform or extension schema) with its EXECUTE state for
-- PUBLIC, anon and authenticated.
create function pg_temp.ovd736_definers()
returns table (sig text, pub boolean, anon boolean, authn boolean)
language sql stable set search_path = pg_catalog as $$
  select p.oid::regprocedure::text,
    has_function_privilege('public', p.oid, 'EXECUTE'),
    has_function_privilege('anon', p.oid, 'EXECUTE'),
    has_function_privilege('authenticated', p.oid, 'EXECUTE')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where p.prosecdef
    and n.nspname !~ '^pg_'
    and n.nspname not in ('information_schema', 'auth', 'storage', 'extensions', 'graphql',
      'graphql_public', 'realtime', '_realtime', 'net', 'pgbouncer', 'supabase_functions',
      'supabase_migrations', 'vault', 'pgsodium', 'pgsodium_masks', 'cron', 'pgtle', '_analytics')
$$;

-- Sorted (grantee, privilege, grantable) entries of a function ACL.
create function pg_temp.ovd736_acl(p_sig text) returns text[]
language sql stable set search_path = pg_catalog as $$
  select array_agg(e.entry order by e.entry)
  from (select case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end
          || ':' || a.privilege_type || ':' || a.is_grantable as entry
        from pg_proc p, aclexplode(p.proacl) a
        where p.oid = p_sig::regprocedure) e
$$;

-- Runs p_sql as anon (PostgREST claims, no sub) and returns the row count or the
-- SQLSTATE it raised. Used to compare anon table reads before and after.
create function pg_temp.ovd736_anon_outcome(p_sql text) returns text language plpgsql as $$
declare
  v_count bigint;
  v_outcome text;
begin
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform set_config('request.jwt.claim.sub', '', true);
  execute 'set local role anon';
  begin
    execute 'select count(*) from (' || p_sql || ') q' into v_count;
    v_outcome := 'rows:' || v_count;
  exception when others then
    v_outcome := 'error:' || sqlstate;
  end;
  execute 'set local role postgres';
  return v_outcome;
end;
$$;

create function pg_temp.act_as(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claim.sub', p_user::text, true),
    set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;
grant execute on function pg_temp.act_as(uuid) to authenticated;

-- Synthetic tenants: verified client A owns project A with job A; client B is in org B.
insert into auth.users (id, aud, role, email, email_confirmed_at, raw_app_meta_data)
values (:'user_a', 'authenticated', 'authenticated', 'ovd736-a@example.test', timezone('utc', now()), '{"provider":"email"}'),
  (:'user_b', 'authenticated', 'authenticated', 'ovd736-b@example.test', timezone('utc', now()), '{"provider":"email"}');
insert into public.organizations (id, name, slug)
values (:'org_a', 'OVD-736 org A', 'ovd736-org-a'), (:'org_b', 'OVD-736 org B', 'ovd736-org-b');
insert into public.organization_memberships (organization_id, user_id, role)
values (:'org_a', :'user_a', 'client'), (:'org_b', :'user_b', 'client');
insert into public.projects (id, organization_id, owner_user_id, name)
values (:'project_a', :'org_a', :'user_a', 'OVD-736 project A');
insert into public.project_memberships (project_id, user_id, role) values (:'project_a', :'user_a', 'owner');
insert into public.jobs (id, organization_id, project_id, created_by, title, status, requested_service_kinds)
values (:'job_a', :'org_a', :'project_a', :'user_a', 'OVD-736 job A', 'ready_to_quote', '{manufacturing_quote}');
insert into public.project_jobs (project_id, job_id, created_by) values (:'project_a', :'job_a', :'user_a');
insert into public.parts (id, job_id, organization_id, name, normalized_key, quantity)
values (:'part_a', :'job_a', :'org_a', 'OVD-736 part A', 'ovd736-part-a', 1);
insert into public.quote_requests (id, organization_id, job_id, requested_by, requested_vendors, status)
values (:'request_a', :'org_a', :'job_a', :'user_a', '{xometry}', 'queued');
insert into public.quote_runs (id, job_id, organization_id, initiated_by, status, quote_request_id)
values (:'run_a', :'job_a', :'org_a', :'user_a', 'running', :'request_a');
insert into public.vendor_quote_results (id, quote_run_id, part_id, organization_id, vendor, requested_quantity, status)
values (:'result_a', :'run_a', :'part_a', :'org_a', 'xometry', 1, 'queued');

-- Anon reads of every table guarded by a policy that calls one of the 56
-- functions, captured before the draft is installed.
create temp table ovd736_anon_reads (rel text primary key, before text, after text);
insert into ovd736_anon_reads (rel)
select distinct quote_ident(schemaname) || '.' || quote_ident(tablename) from pg_policies
where coalesce(qual, '') || ' ' || coalesce(with_check, '') ~
  ('\m(' || (select string_agg(regexp_replace(sig, '^public\.|\(.*$', '', 'g'), '|') from ovd736_target) || ')\(');
update ovd736_anon_reads set before = pg_temp.ovd736_anon_outcome('select 1 from ' || rel);

-- OVD-736 is a proposed migration that is intentionally NOT in supabase/migrations
-- yet. fixtures/ holds a byte copy of docs/migration-drafts/ovd-736.sql, kept
-- identical by scripts/run-supabase-policy-tests.node-test.mjs, and it is installed
-- inside this rolled back transaction only while every target still has its old
-- anon grant. Once the migration is promoted, the guard is false and every
-- assertion runs against the real schema. No assertion is skipped in either case.
select count(*) = 56 as ovd736_install_draft
from ovd736_target t where has_function_privilege('anon', t.sig, 'EXECUTE') \gset
\if :ovd736_install_draft
\ir fixtures/ovd736_anon_definer_privileges.inc
\endif

-- ---------------------------------------------------------------- (a) catalog allowlist
-- The full set of SECURITY DEFINER functions that PUBLIC, anon or authenticated
-- may execute in an application schema. PUBLIC and anon: none. A new definer
-- function created with default grants (Supabase grants anon and authenticated
-- EXECUTE by default) fails here until it is revoked or added with a reason.
create temp table ovd736_authenticated_allowlist (sig text primary key, reason text not null);
insert into ovd736_authenticated_allowlist (sig, reason) values
  ('engineering_private.cancel_engineering_suffix(uuid,bigint,uuid,uuid[],text)', 'engineering helper: called by the SECURITY INVOKER wrapper public.api_cancel_engineering_suffix that signed in operators use'),
  ('engineering_private.control_worker_session(uuid,bigint,uuid,text,uuid)', 'engineering helper: called by the SECURITY INVOKER wrapper public.api_control_worker_session that signed in operators use'),
  ('engineering_private.create_worker_pairing(uuid,uuid,uuid,bigint,uuid,text)', 'engineering helper: called by the SECURITY INVOKER wrapper public.api_create_worker_pairing that signed in operators use'),
  ('engineering_private.engineering_access(uuid,uuid)', 'RLS helper: called by authenticated policies on public.engineering_change_queues, public.engineering_conversations, public.engineering_decisions and 12 more'),
  ('engineering_private.owner_record_native_stop(uuid,uuid,uuid,uuid,uuid,bigint,uuid)', 'engineering helper: called by the SECURITY INVOKER wrapper public.api_reconcile_native_stop that signed in operators use'),
  ('engineering_private.owner_request_native_retry(uuid,uuid,uuid,uuid,bigint,uuid,text)', 'engineering helper: called by the SECURITY INVOKER wrapper public.api_retry_native_task that signed in operators use'),
  ('engineering_private.submit_engineering_message(uuid,uuid,uuid,uuid,bigint,uuid,text)', 'engineering helper: called by the SECURITY INVOKER wrapper public.api_submit_engineering_message that signed in operators use'),
  ('public.api_accept_founding_beta_notice(uuid,text)', 'signed in RPC: called from src/features/quotes/api/founding-beta-api.ts'),
  ('public.api_accept_project_invite(text)', 'signed in RPC: called from src/features/quotes/api/projects-api.ts'),
  ('public.api_admin_complete_manual_quote_request(uuid,uuid,uuid,uuid,public.vendor_name,text,text,public.vendor_status,text,text,text,jsonb,jsonb)', 'signed in RPC: called from src/features/quotes/api/manual-quote-admin-api.ts'),
  ('public.api_admin_get_commercial_account(uuid)', 'signed in RPC: called from src/features/quotes/api/commercial-account-admin-api.ts'),
  ('public.api_admin_get_founding_beta_enrollment(uuid)', 'signed in RPC: called from src/features/quotes/api/founding-beta-admin-api.ts'),
  ('public.api_admin_get_organization_entitlement_state(uuid)', 'signed in RPC: pre existing grant, no direct caller in src, worker or edge functions (residual in ovd-736-notes.md)'),
  ('public.api_admin_grant_organization_entitlement(uuid,text,timestamp with time zone,timestamp with time zone,timestamp with time zone,text,text)', 'signed in RPC: called from src/features/quotes/api/commercial-account-admin-api.ts'),
  ('public.api_admin_invalidate_vendor_quote_offer(uuid,text,text)', 'signed in RPC: called from src/features/quotes/api/manual-quote-admin-api.ts'),
  ('public.api_admin_list_all_jobs()', 'signed in RPC: called from src/features/quotes/api/platform-admin-api.ts'),
  ('public.api_admin_list_all_projects()', 'signed in RPC: called from src/features/quotes/api/platform-admin-api.ts'),
  ('public.api_admin_list_all_users()', 'signed in RPC: called from src/features/quotes/api/platform-admin-api.ts'),
  ('public.api_admin_list_commercial_account_audit(uuid,text,integer)', 'signed in RPC: called from src/features/quotes/api/commercial-account-admin-api.ts'),
  ('public.api_admin_list_manual_quote_requests(text,integer)', 'signed in RPC: called from src/features/quotes/api/manual-quote-admin-api.ts'),
  ('public.api_admin_list_organizations()', 'signed in RPC: called from src/features/quotes/api/platform-admin-api.ts'),
  ('public.api_admin_list_platform_notifications(integer)', 'signed in RPC: called from src/features/quotes/api/platform-admin-api.ts'),
  ('public.api_admin_revoke_organization_entitlement(uuid,text,text)', 'signed in RPC: called from src/features/quotes/api/commercial-account-admin-api.ts'),
  ('public.api_admin_search_commercial_accounts(text,text,integer)', 'signed in RPC: called from src/features/quotes/api/commercial-account-admin-api.ts'),
  ('public.api_admin_set_founding_beta_enrollment(uuid,boolean,text,text)', 'signed in RPC: called from src/features/quotes/api/founding-beta-admin-api.ts'),
  ('public.api_approve_job_requirements(uuid,jsonb)', 'signed in RPC: called from src/features/quotes/api/extraction-api.ts'),
  ('public.api_archive_job(uuid)', 'signed in RPC: called from src/features/quotes/api/archive-api.ts'),
  ('public.api_archive_project(uuid)', 'signed in RPC: called from src/features/quotes/api/projects-api.ts'),
  ('public.api_assign_job_to_project(uuid,uuid)', 'signed in RPC: called from src/features/quotes/api/projects-api.ts'),
  ('public.api_attach_job_file(uuid,text,text,text,public.job_file_kind,text,bigint)', 'signed in RPC: pre existing grant, no direct caller in src, worker or edge functions (residual in ovd-736-notes.md)'),
  ('public.api_cancel_quote_request(uuid)', 'signed in RPC: called from src/features/quotes/api/quote-requests-api.ts'),
  ('public.api_confirm_part_deadline(uuid,text,date)', 'signed in RPC: pre existing grant, no direct caller in src, worker or edge functions (residual in ovd-736-notes.md)'),
  ('public.api_confirm_sourcing_destination(uuid,jsonb)', 'signed in RPC: called from src/features/quotes/api/organizations-api.ts'),
  ('public.api_create_client_draft(text,text,uuid,text[],text[],text,text,integer[],date)', 'signed in RPC: called from src/features/quotes/api/jobs-api.ts'),
  ('public.api_create_job(uuid,text,text,text,text[],text[],text,text,integer[],date)', 'signed in RPC: called from src/features/quotes/api/jobs-api.ts'),
  ('public.api_create_project(text,text)', 'signed in RPC: called from src/features/quotes/api/projects-api.ts'),
  ('public.api_create_self_service_organization(text)', 'signed in RPC: called from src/features/quotes/api/organizations-api.ts'),
  ('public.api_delete_archived_job(uuid)', 'signed in RPC: called from src/features/quotes/api/archive-api.ts'),
  ('public.api_delete_archived_jobs(uuid[])', 'signed in RPC: called from src/features/quotes/api/archive-api.ts'),
  ('public.api_delete_project(uuid)', 'signed in RPC: called from src/features/quotes/api/projects-api.ts'),
  ('public.api_dissolve_project(uuid)', 'signed in RPC: called from src/features/quotes/api/projects-api.ts'),
  ('public.api_enqueue_debug_vendor_quote(uuid,uuid,public.vendor_name,integer)', 'signed in RPC: called from src/features/quotes/api/quote-requests-api.ts'),
  ('public.api_finalize_job_file_upload(uuid,text,text,text,public.job_file_kind,text,bigint,text)', 'signed in RPC: called from src/features/quotes/api/uploads-api.ts'),
  ('public.api_get_client_intake_compatibility()', 'signed in RPC: called from src/features/quotes/api/compatibility-api.ts'),
  ('public.api_get_founding_beta_access_state(uuid)', 'signed in RPC: called from src/features/quotes/api/founding-beta-api.ts'),
  ('public.api_get_is_platform_admin()', 'signed in RPC: called from src/features/quotes/api/session-api.ts'),
  ('public.api_get_job_vendor_preferences(uuid)', 'signed in RPC: called from src/features/quotes/api/vendor-preferences-api.ts'),
  ('public.api_get_organization_entitlements(uuid)', 'signed in RPC: called from src/features/quotes/organization-entitlements.ts'),
  ('public.api_get_part_deadline(uuid)', 'signed in RPC: called from src/features/quotes/api/part-deadline-api.ts'),
  ('public.api_get_provider_dispatch_scope(uuid,public.vendor_name,text)', 'signed in RPC: called from src/features/quotes/api/quote-requests-api.ts'),
  ('public.api_get_quote_access(uuid)', 'signed in RPC: called from src/features/quotes/quote-access.ts'),
  ('public.api_get_quote_lane_eligibility(uuid,public.vendor_name[])', 'signed in RPC: called from src/features/quotes/api/quote-requests-api.ts'),
  ('public.api_get_quote_run_readiness(uuid)', 'signed in RPC: called from src/features/quotes/api/quote-requests-api.ts'),
  ('public.api_get_sourcing_destination(uuid)', 'signed in RPC: called from src/features/quotes/api/organizations-api.ts'),
  ('public.api_get_xometry_beta_dispatch_scope(uuid,text)', 'signed in RPC: called from src/features/quotes/api/quote-requests-api.ts'),
  ('public.api_invite_project_member(uuid,text,public.project_role)', 'signed in RPC: called from src/features/quotes/api/projects-api.ts'),
  ('public.api_list_client_activity_events(uuid[],integer)', 'signed in RPC: called from src/features/quotes/api/workspace-api.ts'),
  ('public.api_list_client_part_metadata(uuid[])', 'signed in RPC: called from src/features/quotes/api/jobs-api.ts'),
  ('public.api_list_client_quote_workspace(uuid[])', 'signed in RPC: called from src/features/quotes/api/jobs-api.ts'),
  ('public.api_list_organization_memberships(uuid)', 'signed in RPC: called from src/features/quotes/api/organizations-api.ts'),
  ('public.api_list_project_assignee_profiles(uuid)', 'signed in RPC: called from src/features/quotes/api/projects-api.ts'),
  ('public.api_prepare_job_file_upload(uuid,text,public.job_file_kind,text,bigint,text)', 'signed in RPC: called from src/features/quotes/api/uploads-api.ts'),
  ('public.api_prepare_organization_billing_session(uuid)', 'signed in RPC: called from supabase/functions/billing-sessions/index.ts'),
  ('public.api_prepare_part_intake(text,text)', 'signed in RPC: called from src/features/quotes/api/uploads-api.ts'),
  ('public.api_publish_quote_package(uuid,uuid,text,boolean)', 'signed in RPC: called from src/features/quotes/api/packages-api.ts'),
  ('public.api_reconcile_job_parts(uuid)', 'signed in RPC: called from src/features/quotes/api/extraction-api.ts'),
  ('public.api_record_manual_vendor_quote(uuid,uuid,public.vendor_name,public.vendor_status,text,text,text,jsonb,jsonb)', 'signed in RPC: called from src/features/quotes/api/packages-api.ts'),
  ('public.api_remove_job_from_project(uuid,uuid)', 'signed in RPC: called from src/features/quotes/api/projects-api.ts'),
  ('public.api_remove_project_member(uuid)', 'signed in RPC: called from src/features/quotes/api/projects-api.ts'),
  ('public.api_request_debug_extraction(uuid,text)', 'signed in RPC: called from src/features/quotes/api/extraction-api.ts'),
  ('public.api_request_extraction(uuid)', 'signed in RPC: called from src/features/quotes/api/extraction-api.ts'),
  ('public.api_request_manual_quote(uuid,boolean)', 'signed in RPC: called from src/features/quotes/api/quote-requests-api.ts'),
  ('public.api_request_manual_quotes(uuid[],boolean)', 'signed in RPC: called from src/features/quotes/api/quote-requests-api.ts'),
  ('public.api_request_provider_dispatch(uuid,public.vendor_name,text,text,text,text,uuid,boolean,boolean,boolean)', 'signed in RPC: called from src/features/quotes/api/quote-requests-api.ts'),
  ('public.api_request_quote(uuid,boolean)', 'signed in RPC: pre existing grant, no direct caller in src, worker or edge functions (residual in ovd-736-notes.md)'),
  ('public.api_request_quote_scoped(uuid,public.vendor_name[])', 'signed in RPC: called from src/features/quotes/api/quote-requests-api.ts'),
  ('public.api_request_quotes(uuid[],boolean)', 'signed in RPC: called from src/features/quotes/api/quote-requests-api.ts'),
  ('public.api_request_xometry_beta_dispatch(uuid,text,text,text,uuid,boolean,boolean,boolean)', 'signed in RPC: called from src/features/quotes/api/quote-requests-api.ts'),
  ('public.api_reset_client_part_property_overrides(uuid,text[])', 'signed in RPC: called from src/features/quotes/api/jobs-api.ts'),
  ('public.api_select_quote_option(uuid,uuid,text)', 'signed in RPC: called from src/features/quotes/api/packages-api.ts'),
  ('public.api_set_global_spend_cap(numeric,numeric,boolean)', 'signed in RPC: called from src/features/quotes/api/platform-admin-api.ts'),
  ('public.api_set_job_selected_vendor_quote_offer(uuid,uuid)', 'signed in RPC: called from src/features/quotes/api/quote-requests-api.ts'),
  ('public.api_set_job_vendor_preferences(uuid,public.vendor_name[],public.vendor_name[])', 'signed in RPC: called from src/features/quotes/api/vendor-preferences-api.ts'),
  ('public.api_set_project_vendor_preferences(uuid,public.vendor_name[],public.vendor_name[])', 'signed in RPC: called from src/features/quotes/api/vendor-preferences-api.ts'),
  ('public.api_spend_summary()', 'signed in RPC: called from src/features/quotes/api/platform-admin-api.ts'),
  ('public.api_start_quote_run(uuid,boolean)', 'signed in RPC: called from src/features/quotes/api/quote-requests-api.ts'),
  ('public.api_unarchive_job(uuid)', 'signed in RPC: called from src/features/quotes/api/archive-api.ts'),
  ('public.api_unarchive_project(uuid)', 'signed in RPC: called from src/features/quotes/api/projects-api.ts'),
  ('public.api_update_client_part_request(uuid,text[],text,text,text,text,text,text,text,text,numeric,text,text,integer,integer[],date,jsonb,jsonb,jsonb,jsonb)', 'signed in RPC: called from src/features/quotes/api/jobs-api.ts'),
  ('public.api_update_organization_addresses(uuid,jsonb)', 'signed in RPC: called from src/features/quotes/api/organizations-api.ts'),
  ('public.api_update_organization_membership_role(uuid,public.app_role)', 'signed in RPC: called from src/features/quotes/api/organizations-api.ts'),
  ('public.api_update_project(uuid,text,text)', 'signed in RPC: called from src/features/quotes/api/projects-api.ts'),
  ('public.current_user_can_access_manual_quote_artifact(uuid,text,text,boolean,boolean)', 'RLS helper: called by authenticated policies on public.vendor_quote_artifacts, storage.objects'),
  ('public.current_user_can_delete_unregistered_manual_quote_upload(text,text,text,timestamp with time zone)', 'RLS helper: called by authenticated policies on storage.objects'),
  ('public.current_user_has_commercial_capability(text)', 'RLS helper: called by authenticated policies on public.commercial_admin_audit_events'),
  ('public.current_user_has_current_founding_beta_access(uuid)', 'RLS helper: called by authenticated policies on public.jobs, storage.objects'),
  ('public.is_internal_user(uuid)', 'RLS helper: called by authenticated policies on public.approved_part_requirements, public.audit_events, public.debug_extraction_runs and 21 more'),
  ('public.is_internal_user_any_org()', 'RLS helper: called by authenticated policies on public.supplier_capabilities, public.supplier_certifications, public.supplier_companies and 8 more'),
  ('public.is_org_admin(uuid)', 'RLS helper: called by authenticated policies on public.organization_memberships, public.organizations'),
  ('public.is_platform_admin()', 'RLS helper: called by authenticated policies on public.approved_part_requirements, public.client_selections, public.debug_extraction_runs and 19 more'),
  ('public.user_can_access_job(uuid)', 'RLS helper: called by authenticated policies on public.cad_preview_assets, public.canonical_parts, public.drawing_preview_assets and 9 more'),
  ('public.user_can_access_org(uuid)', 'RLS helper: called by authenticated policies on public.jobs, public.organizations'),
  ('public.user_can_access_package(uuid)', 'RLS helper: called by authenticated policies on public.client_selections, public.published_quote_options, public.published_quote_packages'),
  ('public.user_can_access_project(uuid)', 'RLS helper: called by authenticated policies on public.project_jobs, public.project_memberships, public.project_vendor_preferences and 3 more'),
  ('public.user_can_edit_job(uuid)', 'RLS helper: called by authenticated policies on storage.objects'),
  ('public.user_can_edit_project(uuid)', 'RLS helper: called by authenticated policies on public.project_jobs'),
  ('public.user_is_project_owner(uuid)', 'RLS helper: called by authenticated policies on public.project_invites');

select is_empty($$ select sig from pg_temp.ovd736_definers() where pub or anon order by sig $$,
  'no SECURITY DEFINER function in an application schema is executable by PUBLIC or anon');
select set_eq($$ select sig from pg_temp.ovd736_definers() where authn $$,
  $$ select sig from ovd736_authenticated_allowlist $$,
  'authenticated may execute exactly the pinned SECURITY DEFINER allowlist');
select is_empty($$ select sig from ovd736_authenticated_allowlist where length(trim(reason)) < 20 $$,
  'every allowlisted function carries a reason');
select is((select count(*)::integer from ovd736_target where to_regprocedure(sig) is not null), 56,
  'all 56 OVD-736 functions still exist with their exact signatures');
select ok((select bool_and(has_function_privilege('service_role', sig, 'EXECUTE')
                       and has_function_privilege('authenticated', sig, 'EXECUTE') = keeps_authenticated)
           from ovd736_target),
  'service_role keeps EXECUTE on all 56; authenticated keeps it on exactly the 48 still needed');

-- ---------------------------------------------------------------- (b) denials
-- The privilege check runs before the body, so absent ids are enough.
select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;
select throws_ok(t.call_sql, '42501', null, 'anon cannot execute ' || t.sig)
from ovd736_target t order by t.sig;
reset role;

select pg_temp.act_as(:'user_a');
set local role authenticated;
select throws_ok(t.call_sql, '42501', null, 'authenticated cannot execute internal only ' || t.sig)
from ovd736_target t where not t.keeps_authenticated order by t.sig;
reset role;

-- ---------------------------------------------------------------- (c) logged out flows
-- The logged out app makes no PostgREST call (GoTrue only; see ovd-736-notes.md).
-- What anon can still reach is direct table reads, and every policy that calls one
-- of these helpers is TO authenticated, so anon never evaluates them: each read
-- must give exactly the outcome it gave before the revoke.
update ovd736_anon_reads set after = pg_temp.ovd736_anon_outcome('select 1 from ' || rel);
select is_empty($$ select rel, before, after from ovd736_anon_reads where before is distinct from after $$,
  'anon reads of every helper guarded table behave exactly as before the revoke');

-- ---------------------------------------------------------------- (d) signed in members
select pg_temp.act_as(:'user_a');
set local role authenticated;
select is((select count(*)::integer from public.jobs where id = :'job_a'), 1,
  'member A reads own job through user_can_access_job');
select is((select count(*)::integer from public.parts where job_id = :'job_a'), 1,
  'member A reads own part through user_can_access_job');
select is((select count(*)::integer from public.projects where id = :'project_a'), 1,
  'member A reads own project through user_can_access_project');
select is((select count(*)::integer from public.organizations where id = :'org_a'), 1,
  'member A reads own organization through user_can_access_org');
select is(jsonb_array_length(public.api_list_client_part_metadata(array[:'job_a'::uuid])), 1,
  'member A still gets own part metadata from the client RPC');
reset role;
select pg_temp.act_as(:'user_b');
set local role authenticated;
select is((select count(*)::integer from public.jobs where id = :'job_a'), 0,
  'member B cannot read job A');
select is(jsonb_array_length(public.api_list_client_part_metadata(array[:'job_a'::uuid])), 0,
  'member B gets no part metadata for job A');
reset role;

-- ---------------------------------------------------------------- (e) triggers
-- PostgreSQL checks EXECUTE on a trigger function only at CREATE TRIGGER time.
-- Synthetic proof: a trigger function nobody but its owner may execute still
-- fires for an anon writer.
create temp table ovd736_trigger_target (id integer);
create temp table ovd736_trigger_log (id integer);
create function pg_temp.ovd736_log_insert() returns trigger language plpgsql security definer as $$
begin
  insert into pg_temp.ovd736_trigger_log values (new.id);
  return new;
end;
$$;
create trigger ovd736_log after insert on pg_temp.ovd736_trigger_target
  for each row execute function pg_temp.ovd736_log_insert();
revoke all on function pg_temp.ovd736_log_insert() from public;
grant insert on pg_temp.ovd736_trigger_target to anon;
select ok(not has_function_privilege('anon', 'pg_temp.ovd736_log_insert()', 'EXECUTE'),
  'anon lacks EXECUTE on the synthetic trigger function');
set local role anon;
select lives_ok($$ insert into pg_temp.ovd736_trigger_target values (736) $$,
  'anon insert succeeds although anon cannot execute the trigger function');
reset role;
select is((select count(*)::integer from pg_temp.ovd736_trigger_log where id = 736), 1,
  'the trigger fired for the anon writer');

-- Real triggers: take EXECUTE away from service_role too, then write as service_role.
savepoint ovd736_triggers;
revoke execute on function public.sync_quote_request_status_from_vendor_result() from service_role;
revoke execute on function public.sync_service_request_line_item_status_from_quote_request() from service_role;
set local role service_role;
select lives_ok(format($$ update public.vendor_quote_results set status = 'instant_quote_received' where id = %L $$, :'result_a'),
  'service_role updates a vendor result without EXECUTE on its sync trigger function');
reset role;
select is((select status::text from public.quote_requests where id = :'request_a'), 'received',
  'sync_quote_request_status_from_vendor_result fired and moved the request to received');
set local role service_role;
select lives_ok(format($$ update public.quote_requests set status = 'canceled' where id = %L $$, :'request_a'),
  'service_role updates a quote request without EXECUTE on its line item sync trigger function');
reset role;
rollback to savepoint ovd736_triggers;

-- ---------------------------------------------------------------- (f) rollback round trip
-- fixtures/ovd736_anon_definer_privileges_rollback.inc is a byte copy of
-- docs/migration-drafts/ovd-736.rollback.sql.
\ir fixtures/ovd736_anon_definer_privileges_rollback.inc
select is_empty($$ select sig from ovd736_target
  where cardinality(pg_temp.ovd736_acl(sig)) <> 5
     or not pg_temp.ovd736_acl(sig) @> array['PUBLIC:EXECUTE:false', 'anon:EXECUTE:false',
       'authenticated:EXECUTE:false', 'postgres:EXECUTE:false', 'service_role:EXECUTE:false'] $$,
  'rollback restores the exact prior ACL on all 56 functions');
select ok((select bool_and(has_function_privilege('anon', sig, 'EXECUTE')) from ovd736_target),
  'after rollback anon can execute all 56 again (the pre OVD-736 state)');
\ir fixtures/ovd736_anon_definer_privileges.inc
select is_empty($$ select sig from pg_temp.ovd736_definers() where pub or anon $$,
  'reapplying the draft after rollback removes PUBLIC and anon again');
select set_eq($$ select sig from pg_temp.ovd736_definers() where authn $$,
  $$ select sig from ovd736_authenticated_allowlist $$,
  'reapplying the draft after rollback restores the authenticated allowlist');

select * from finish();

rollback;
