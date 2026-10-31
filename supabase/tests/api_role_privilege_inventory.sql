-- OVD-602: privilege inventory for the API roles in the application schemas.
--
-- Scope: SECURITY DEFINER functions in public, private and engineering_private;
-- tables, policies and grants in public. Platform schemas (graphql, net,
-- supabase_functions, auth, storage, extensions) are out of scope.
--
-- Characterization only: this file revokes nothing. Each check compares the
-- live catalog with a reviewed allowlist, so any new grant to PUBLIC, anon or
-- authenticated (Supabase grants EXECUTE on new functions to all three by
-- default) fails here until it is revoked or added with a guard_class and issue.
--
-- guard_class names how the function body refuses a caller it should not serve:
--   verified-auth+membership  signed in caller, checked against org/project/job membership or own rows
--   job-editor                verified auth plus user_can_edit_job on the target job
--   internal-role             platform admin or internal user
--   admin-aal2                platform admin with an AAL2 (MFA) check
--   intended-public-read      harmless answer about the caller, readable by any signed in user
--   known-debt                grant is wider than intended; the named issue removes it
-- Since OVD-736 (20261016013742) PUBLIC and anon execute no SECURITY DEFINER
-- function in these schemas, so their allowlists are empty.
begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(10);

create temporary table api_priv_definer_allowlist (
  sig text not null,
  grantee text not null check (grantee in ('PUBLIC', 'anon', 'authenticated')),
  guard_class text not null,
  issue text not null,
  primary key (sig, grantee)
) on commit drop;

insert into api_priv_definer_allowlist (sig, grantee, guard_class, issue) values
  ('engineering_private.cancel_engineering_suffix(uuid,bigint,uuid,uuid[],text)', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('engineering_private.control_worker_session(uuid,bigint,uuid,text,uuid)', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('engineering_private.create_worker_pairing(uuid,uuid,uuid,bigint,uuid,text)', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('engineering_private.engineering_access(uuid,uuid)', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('engineering_private.owner_record_native_stop(uuid,uuid,uuid,uuid,uuid,bigint,uuid)', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('engineering_private.owner_request_native_retry(uuid,uuid,uuid,uuid,bigint,uuid,text)', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('engineering_private.submit_engineering_message(uuid,uuid,uuid,uuid,bigint,uuid,text)', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('public.api_accept_founding_beta_notice(uuid,text)', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('public.api_accept_project_invite(text)', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('public.api_admin_complete_manual_quote_request(uuid,uuid,uuid,uuid,public.vendor_name,text,text,public.vendor_status,text,text,text,jsonb,jsonb)', 'authenticated', 'admin-aal2', 'OVD-602'),
  ('public.api_admin_get_commercial_account(uuid)', 'authenticated', 'internal-role', 'OVD-602'),
  ('public.api_admin_get_founding_beta_enrollment(uuid)', 'authenticated', 'internal-role', 'OVD-602'),
  ('public.api_admin_get_organization_entitlement_state(uuid)', 'authenticated', 'internal-role', 'OVD-602'),
  ('public.api_admin_grant_organization_entitlement(uuid,text,timestamp with time zone,timestamp with time zone,timestamp with time zone,text,text)', 'authenticated', 'admin-aal2', 'OVD-602'),
  ('public.api_admin_invalidate_vendor_quote_offer(uuid,text,text)', 'authenticated', 'admin-aal2', 'OVD-602'),
  ('public.api_admin_list_all_jobs()', 'authenticated', 'internal-role', 'OVD-768'),
  ('public.api_admin_list_all_projects()', 'authenticated', 'internal-role', 'OVD-768'),
  ('public.api_admin_list_all_users()', 'authenticated', 'internal-role', 'OVD-768'),
  ('public.api_admin_list_commercial_account_audit(uuid,text,integer)', 'authenticated', 'internal-role', 'OVD-602'),
  ('public.api_admin_list_manual_quote_requests(text,integer)', 'authenticated', 'internal-role', 'OVD-602'),
  ('public.api_admin_list_organizations()', 'authenticated', 'internal-role', 'OVD-768'),
  ('public.api_admin_list_platform_notifications(integer)', 'authenticated', 'internal-role', 'OVD-602'),
  ('public.api_admin_list_provider_kill_switches()', 'authenticated', 'internal-role', 'OVD-602'),
  ('public.api_admin_revoke_organization_entitlement(uuid,text,text)', 'authenticated', 'admin-aal2', 'OVD-602'),
  ('public.api_admin_search_commercial_accounts(text,text,integer)', 'authenticated', 'internal-role', 'OVD-602'),
  ('public.api_admin_set_founding_beta_enrollment(uuid,boolean,text,text)', 'authenticated', 'admin-aal2', 'OVD-602'),
  ('public.api_admin_set_global_kill_switch(boolean,text,bigint)', 'authenticated', 'admin-aal2', 'OVD-767'),
  ('public.api_admin_set_provider_kill_switch(public.vendor_name,boolean,text,bigint)', 'authenticated', 'admin-aal2', 'OVD-767'),
  ('public.api_approve_job_requirements(uuid,jsonb)', 'authenticated', 'internal-role', 'OVD-602'),
  ('public.api_archive_job(uuid)', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('public.api_archive_project(uuid)', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('public.api_assign_job_to_project(uuid,uuid)', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('public.api_attach_job_file(uuid,text,text,text,public.job_file_kind,text,bigint)', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('public.api_cancel_quote_request(uuid)', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('public.api_confirm_part_deadline(uuid,text,date)', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('public.api_confirm_sourcing_destination(uuid,jsonb)', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('public.api_create_client_draft(text,text,uuid,text[],text[],text,text,integer[],date)', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('public.api_create_job(uuid,text,text,text,text[],text[],text,text,integer[],date)', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('public.api_create_project(text,text)', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('public.api_create_self_service_organization(text)', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('public.api_declare_job_export_status(uuid,text,text,uuid)', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('public.api_delete_archived_job(uuid)', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('public.api_delete_archived_jobs(uuid[])', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('public.api_delete_project(uuid)', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('public.api_dissolve_project(uuid)', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('public.api_enqueue_debug_vendor_quote(uuid,uuid,public.vendor_name,integer)', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('public.api_finalize_job_file_upload(uuid,text,text,text,public.job_file_kind,text,bigint,text)', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('public.api_finalize_job_file_upload(uuid,text,text,text,public.job_file_kind,text,bigint,text,uuid)', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('public.api_get_client_intake_compatibility()', 'authenticated', 'intended-public-read', 'OVD-602'),
  ('public.api_get_founding_beta_access_state(uuid)', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('public.api_get_is_platform_admin()', 'authenticated', 'intended-public-read', 'OVD-602'),
  ('public.api_get_job_export_control_status(uuid)', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('public.api_get_job_vendor_preferences(uuid)', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('public.api_get_organization_entitlements(uuid)', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('public.api_get_part_deadline(uuid)', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('public.api_get_provider_dispatch_scope(uuid,public.vendor_name,text)', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('public.api_get_quote_access(uuid)', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('public.api_get_quote_lane_eligibility(uuid,public.vendor_name[])', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('public.api_get_quote_run_readiness(uuid)', 'authenticated', 'internal-role', 'OVD-602'),
  ('public.api_get_sourcing_destination(uuid)', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('public.api_get_xometry_beta_dispatch_scope(uuid,text)', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('public.api_invite_project_member(uuid,text,public.project_role)', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('public.api_list_client_activity_events(uuid[],integer)', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('public.api_list_client_part_metadata(uuid[])', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('public.api_list_client_quote_workspace(uuid[])', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('public.api_list_organization_memberships(uuid)', 'authenticated', 'internal-role', 'OVD-602'),
  ('public.api_list_project_assignee_profiles(uuid)', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('public.api_prepare_job_file_upload(uuid,text,public.job_file_kind,text,bigint,text)', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('public.api_prepare_job_file_upload(uuid,text,public.job_file_kind,text,bigint,text,uuid)', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('public.api_prepare_organization_billing_session(uuid)', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('public.api_prepare_part_intake(text,text)', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('public.api_publish_quote_package(uuid,uuid,text,boolean)', 'authenticated', 'internal-role', 'OVD-602'),
  -- Guard comes from docs/migration-drafts/ovd-766-c.sql (option b); until that
  -- draft is applied the 20260308113000 body checks org membership only.
  ('public.api_reconcile_job_parts(uuid)', 'authenticated', 'job-editor', 'OVD-769'),
  ('public.api_record_manual_vendor_quote(uuid,uuid,public.vendor_name,public.vendor_status,text,text,text,jsonb,jsonb)', 'authenticated', 'internal-role', 'OVD-602'),
  ('public.api_remove_job_from_project(uuid,uuid)', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('public.api_remove_project_member(uuid)', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('public.api_request_debug_extraction(uuid,text)', 'authenticated', 'internal-role', 'OVD-602'),
  ('public.api_request_export_marking_rescan(uuid)', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('public.api_request_extraction(uuid)', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('public.api_request_manual_quote(uuid,boolean)', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('public.api_request_manual_quotes(uuid[],boolean)', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('public.api_request_provider_dispatch(uuid,public.vendor_name,text,text,text,text,uuid,boolean,boolean,boolean)', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('public.api_request_quote(uuid,boolean)', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('public.api_request_quote_scoped(uuid,public.vendor_name[])', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('public.api_request_quotes(uuid[],boolean)', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('public.api_request_xometry_beta_dispatch(uuid,text,text,text,uuid,boolean,boolean,boolean)', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('public.api_reset_client_part_property_overrides(uuid,text[])', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('public.api_review_export_control_block(uuid,text,text)', 'authenticated', 'admin-aal2', 'OVD-767'),
  ('public.api_select_quote_option(uuid,uuid,text)', 'authenticated', 'verified-auth+membership', 'OVD-770'),
  ('public.api_set_global_spend_cap(numeric,numeric,boolean)', 'authenticated', 'admin-aal2', 'OVD-767'),
  ('public.api_set_job_selected_vendor_quote_offer(uuid,uuid)', 'authenticated', 'verified-auth+membership', 'OVD-770'),
  ('public.api_set_job_vendor_preferences(uuid,public.vendor_name[],public.vendor_name[])', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('public.api_set_project_vendor_preferences(uuid,public.vendor_name[],public.vendor_name[])', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('public.api_spend_summary()', 'authenticated', 'internal-role', 'OVD-602'),
  ('public.api_start_quote_run(uuid,boolean)', 'authenticated', 'internal-role', 'OVD-602'),
  ('public.api_unarchive_job(uuid)', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('public.api_unarchive_project(uuid)', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('public.api_update_client_part_request(uuid,text[],text,text,text,text,text,text,text,text,numeric,text,text,integer,integer[],date,jsonb,jsonb,jsonb,jsonb)', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('public.api_update_organization_addresses(uuid,jsonb)', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('public.api_update_organization_membership_role(uuid,public.app_role)', 'authenticated', 'internal-role', 'OVD-602'),
  ('public.api_update_project(uuid,text,text)', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('public.current_user_can_access_manual_quote_artifact(uuid,text,text,boolean,boolean)', 'authenticated', 'internal-role', 'OVD-602'),
  ('public.current_user_can_delete_unregistered_manual_quote_upload(text,text,text,timestamp with time zone)', 'authenticated', 'admin-aal2', 'OVD-602'),
  ('public.current_user_has_commercial_capability(text)', 'authenticated', 'internal-role', 'OVD-602'),
  ('public.current_user_has_current_founding_beta_access(uuid)', 'authenticated', 'intended-public-read', 'OVD-602'),
  ('public.current_user_has_export_cleared_upload(text,text)', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('public.is_internal_user(uuid)', 'authenticated', 'internal-role', 'OVD-602'),
  ('public.is_internal_user_any_org()', 'authenticated', 'internal-role', 'OVD-602'),
  ('public.is_org_admin(uuid)', 'authenticated', 'internal-role', 'OVD-602'),
  ('public.is_platform_admin()', 'authenticated', 'internal-role', 'OVD-602'),
  ('public.user_can_access_job(uuid)', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('public.user_can_access_org(uuid)', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('public.user_can_access_package(uuid)', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('public.user_can_access_project(uuid)', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('public.user_can_edit_job(uuid)', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('public.user_can_edit_project(uuid)', 'authenticated', 'verified-auth+membership', 'OVD-602'),
  ('public.user_is_project_owner(uuid)', 'authenticated', 'verified-auth+membership', 'OVD-602');

-- Q35 (owner decision): anon still holds TRUNCATE on these public tables.
create temporary table api_priv_anon_truncate_debt (rel text primary key) on commit drop;
insert into api_priv_anon_truncate_debt (rel) values
  ('public.approved_part_requirements'),
  ('public.audit_events'),
  ('public.client_selections'),
  ('public.debug_extraction_runs'),
  ('public.drawing_extractions'),
  ('public.drawing_preview_assets'),
  ('public.job_files'),
  ('public.jobs'),
  ('public.org_vendor_configs'),
  ('public.organization_file_blobs'),
  ('public.organization_memberships'),
  ('public.organizations'),
  ('public.parts'),
  ('public.payments'),
  ('public.pricing_policies'),
  ('public.project_invites'),
  ('public.project_memberships'),
  ('public.projects'),
  ('public.published_quote_options'),
  ('public.published_quote_packages'),
  ('public.quote_request_guardrails'),
  ('public.quote_requests'),
  ('public.quote_runs'),
  ('public.service_request_line_items'),
  ('public.spend_caps'),
  ('public.spend_ledger'),
  ('public.supplier_capabilities'),
  ('public.supplier_certifications'),
  ('public.supplier_companies'),
  ('public.supplier_company_aliases'),
  ('public.supplier_facilities'),
  ('public.supplier_facility_capability_claims'),
  ('public.supplier_facility_certification_claims'),
  ('public.supplier_source_records'),
  ('public.supplier_sources'),
  ('public.supplier_verification_events'),
  ('public.user_pinned_jobs'),
  ('public.user_pinned_projects'),
  ('public.vendor_capability_profiles'),
  ('public.vendor_quote_artifacts'),
  ('public.vendor_quote_offers'),
  ('public.vendor_quote_results'),
  ('public.vendor_routing_scores'),
  ('public.work_queue');

create temporary table api_priv_engineering_grants (grant_row text primary key) on commit drop;
insert into api_priv_engineering_grants (grant_row) values
  ('public.engineering_change_queues:authenticated:SELECT'),
  ('public.engineering_conversations:authenticated:SELECT'),
  ('public.engineering_decisions:authenticated:SELECT'),
  ('public.engineering_events:authenticated:SELECT'),
  ('public.engineering_execution_attempts:authenticated:SELECT'),
  ('public.engineering_interpretation_reservations:authenticated:SELECT'),
  ('public.engineering_interpretations:authenticated:SELECT'),
  ('public.engineering_messages:authenticated:SELECT'),
  ('public.engineering_requests:authenticated:SELECT'),
  ('public.engineering_snapshots:authenticated:SELECT'),
  ('public.engineering_task_execution:authenticated:SELECT'),
  ('public.engineering_tasks:authenticated:SELECT'),
  ('public.engineering_worker_events:authenticated:SELECT'),
  ('public.engineering_worker_sessions:authenticated:SELECT'),
  ('public.engineering_workers:authenticated:SELECT');

-- Signatures print schema qualified only with pg_catalog alone on the path.
create function pg_temp.api_priv_definers()
returns table (sig text, pub boolean, anon boolean, authn boolean)
language sql stable set search_path = pg_catalog as $$
  select p.oid::regprocedure::text,
    exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
            where a.grantee = 0 and a.privilege_type = 'EXECUTE'),
    has_function_privilege('anon', p.oid, 'EXECUTE'),
    has_function_privilege('authenticated', p.oid, 'EXECUTE')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where p.prosecdef and n.nspname in ('public', 'private', 'engineering_private')
$$;

create function pg_temp.api_priv_public_tables()
returns table (rel text, oid oid, rls boolean)
language sql stable set search_path = pg_catalog as $$
  select c.oid::regclass::text, c.oid, c.relrowsecurity
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p')
$$;

-- 1-3. SECURITY DEFINER functions each API role can execute.
select set_eq($$ select sig from pg_temp.api_priv_definers() where anon $$,
  $$ select sig from api_priv_definer_allowlist where grantee = 'anon' $$,
  'anon may execute exactly the allowlisted SECURITY DEFINER functions');
select set_eq($$ select sig from pg_temp.api_priv_definers() where authn $$,
  $$ select sig from api_priv_definer_allowlist where grantee = 'authenticated' $$,
  'authenticated may execute exactly the allowlisted SECURITY DEFINER functions');
select set_eq($$ select sig from pg_temp.api_priv_definers() where pub $$,
  $$ select sig from api_priv_definer_allowlist where grantee = 'PUBLIC' $$,
  'PUBLIC holds EXECUTE on exactly the allowlisted SECURITY DEFINER functions');

-- 4. Every public table has row level security enabled.
select is_empty($$ select rel from pg_temp.api_priv_public_tables() where not rls $$,
  'every public table has row level security enabled');

-- 5. No policy on a public table applies to anon or PUBLIC.
select is_empty($$
  select format('%I.%I.%I', n.nspname, c.relname, pol.polname)
  from pg_policy pol join pg_class c on c.oid = pol.polrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and (0 = any (pol.polroles) or 'anon'::regrole = any (pol.polroles)) $$,
  'no policy on a public table applies to anon or PUBLIC');

-- 6. anon and authenticated privileges on the engineering_* relations.
select set_eq($$
  select format('%I.%I', n.nspname, c.relname) || ':' || r || ':' || pr
  from pg_class c join pg_namespace n on n.oid = c.relnamespace,
    unnest(array['anon', 'authenticated']) r,
    unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) pr
  where n.nspname = 'public' and c.relname like 'engineering\_%'
    and c.relkind in ('r', 'p', 'v', 'm', 'f') and has_table_privilege(r, c.oid, pr) $$,
  $$ select grant_row from api_priv_engineering_grants $$,
  'anon and authenticated hold exactly the pinned privileges on engineering_* relations');

-- 7. anon TRUNCATE is exactly the known-debt list.
select set_eq($$ select rel from pg_temp.api_priv_public_tables() where has_table_privilege('anon', oid, 'TRUNCATE') $$,
  $$ select rel from api_priv_anon_truncate_debt $$,
  'anon holds TRUNCATE on exactly the Q35 known-debt public tables');

-- Allowlist hygiene.
select is_empty($$ select sig || ':' || grantee from api_priv_definer_allowlist
  where guard_class not in ('verified-auth+membership', 'job-editor', 'internal-role',
    'admin-aal2', 'intended-public-read', 'known-debt') or issue !~ '^OVD-[0-9]+$' $$,
  'every allowlist row has a known guard_class and an OVD issue');
select is_empty($$ select sig || ':' || grantee from api_priv_definer_allowlist
  where grantee in ('PUBLIC', 'anon') and guard_class <> 'known-debt' $$,
  'every PUBLIC or anon definer grant is classified as known debt');
select is_empty($$ select sig from api_priv_definer_allowlist where to_regprocedure(sig) is null $$,
  'every allowlisted signature resolves to an existing function');

select * from finish();
rollback;
