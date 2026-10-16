-- OVD-766 group d (OVD-770): quote selection RPCs require a verified caller who
-- can edit the job.
--
-- Targets the DRAFT docs/migration-drafts/ovd-766-d.sql.
-- PENDING: the draft is NOT applied (NEEDS BLAINE MIGRATION WINDOW). This file
-- carries a .pending suffix so the policy-test runner stages it but never
-- executes it. In the approved window, the draft is promoted and this file is
-- renamed to supabase/tests/ovd766_d_guards.sql in the same change.
-- Pre-apply observation: the two proconfig assertions fail (search_path is
-- pg_catalog today), and the unverified and signed-out api_select_quote_option
-- cases fail because the current body has no require_verified_auth.
--
-- Coverage, per function:
--   * catalog: prosecdef, proconfig search_path="", EXECUTE for authenticated
--     only (no PUBLIC, no anon)
--   * anon is denied (permission denied, 42501)
--   * a signed-out authenticated request is denied
--   * a verified user outside the job's org and projects is denied
--   * an unverified org member is denied
--   * read-only member: TODO, not constructible today. public.project_role is
--     ('owner', 'editor') and user_can_edit_job grants every org member via
--     user_can_access_org, so every caller user_can_access_job admits is also an
--     editor. Two premise assertions pin this, so a viewer role or a narrower
--     user_can_edit_job makes this file fail until real denial cases replace them.
--   * an org-member editor is allowed and the write lands
--   * AAL1 admin: not applicable; neither function requires AAL2.
-- Every denial is followed by a full-row snapshot comparison (job, client
-- selections, audit events) taken as postgres, so RLS cannot hide a write.
-- Synthetic local records only.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(34);

create function pg_temp.set_ovd766d_identity(p_user_id uuid)
returns void
language plpgsql
set search_path = pg_catalog
as $$
begin
  if p_user_id is null then
    perform pg_catalog.set_config('request.jwt.claim.sub', '', true);
    perform pg_catalog.set_config('request.jwt.claims',
      '{"role":"authenticated","aal":"aal1"}', true);
  else
    perform pg_catalog.set_config('request.jwt.claim.sub', p_user_id::text, true);
    perform pg_catalog.set_config('request.jwt.claims',
      pg_catalog.jsonb_build_object('sub', p_user_id, 'role', 'authenticated', 'aal', 'aal1')::text,
      true);
  end if;
end;
$$;

-- Catalog shape.
select ok((select prosecdef from pg_catalog.pg_proc
    where oid = 'public.api_set_job_selected_vendor_quote_offer(uuid,uuid)'::regprocedure),
  'api_set_job_selected_vendor_quote_offer is SECURITY DEFINER');
select is((select proconfig from pg_catalog.pg_proc
    where oid = 'public.api_set_job_selected_vendor_quote_offer(uuid,uuid)'::regprocedure),
  array['search_path=""']::text[],
  'api_set_job_selected_vendor_quote_offer pins an empty search_path');
select ok(
  not has_function_privilege('anon', 'public.api_set_job_selected_vendor_quote_offer(uuid,uuid)', 'EXECUTE')
  and not exists (
    select 1 from pg_catalog.pg_proc p,
      pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
    where p.oid = 'public.api_set_job_selected_vendor_quote_offer(uuid,uuid)'::regprocedure
      and a.grantee = 0 and a.privilege_type = 'EXECUTE'),
  'api_set_job_selected_vendor_quote_offer: no EXECUTE for anon or PUBLIC');
select ok(has_function_privilege('authenticated', 'public.api_set_job_selected_vendor_quote_offer(uuid,uuid)', 'EXECUTE'),
  'api_set_job_selected_vendor_quote_offer: authenticated may execute');

select ok((select prosecdef from pg_catalog.pg_proc
    where oid = 'public.api_select_quote_option(uuid,uuid,text)'::regprocedure),
  'api_select_quote_option is SECURITY DEFINER');
select is((select proconfig from pg_catalog.pg_proc
    where oid = 'public.api_select_quote_option(uuid,uuid,text)'::regprocedure),
  array['search_path=""']::text[],
  'api_select_quote_option pins an empty search_path');
select ok(
  not has_function_privilege('anon', 'public.api_select_quote_option(uuid,uuid,text)', 'EXECUTE')
  and not exists (
    select 1 from pg_catalog.pg_proc p,
      pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
    where p.oid = 'public.api_select_quote_option(uuid,uuid,text)'::regprocedure
      and a.grantee = 0 and a.privilege_type = 'EXECUTE'),
  'api_select_quote_option: no EXECUTE for anon or PUBLIC');
select ok(has_function_privilege('authenticated', 'public.api_select_quote_option(uuid,uuid,text)', 'EXECUTE'),
  'api_select_quote_option: authenticated may execute');

-- Users: 01 editor (org client, verified), 02 outsider (verified, other org),
-- 03 unverified org client.
insert into auth.users (id, aud, role, email, email_confirmed_at, raw_app_meta_data) values
  ('e766d000-0766-4000-8000-000000000001', 'authenticated', 'authenticated', 'ovd766d-editor@example.test', now(), '{"provider":"email"}'::jsonb),
  ('e766d000-0766-4000-8000-000000000002', 'authenticated', 'authenticated', 'ovd766d-outsider@example.test', now(), '{"provider":"email"}'::jsonb),
  ('e766d000-0766-4000-8000-000000000003', 'authenticated', 'authenticated', 'ovd766d-unverified@example.test', null, '{"provider":"email"}'::jsonb);
insert into public.organizations (id, name, slug) values
  ('e766d000-0766-4000-8000-000000000010', 'OVD-766 d fixture', 'ovd766d-fixture-e766d000'),
  ('e766d000-0766-4000-8000-000000000011', 'OVD-766 d other org', 'ovd766d-other-e766d000');
insert into public.organization_memberships (organization_id, user_id, role) values
  ('e766d000-0766-4000-8000-000000000010', 'e766d000-0766-4000-8000-000000000001', 'client'),
  ('e766d000-0766-4000-8000-000000000011', 'e766d000-0766-4000-8000-000000000002', 'client'),
  ('e766d000-0766-4000-8000-000000000010', 'e766d000-0766-4000-8000-000000000003', 'client');
insert into public.pricing_policies (id, organization_id, version, markup_percent, currency_minor_unit)
values ('e766d000-0766-4000-8000-000000000020', 'e766d000-0766-4000-8000-000000000010', 'ovd766d-fixture', 20, 0.01);
insert into public.jobs (id, organization_id, created_by, title, status, active_pricing_policy_id)
values ('e766d000-0766-4000-8000-000000000030', 'e766d000-0766-4000-8000-000000000010', 'e766d000-0766-4000-8000-000000000001', 'OVD-766 d selection', 'internal_review', 'e766d000-0766-4000-8000-000000000020');
insert into public.parts (id, job_id, organization_id, name, normalized_key)
values ('e766d000-0766-4000-8000-000000000031', 'e766d000-0766-4000-8000-000000000030', 'e766d000-0766-4000-8000-000000000010', 'OVD-766 d part', 'ovd766d-part');
insert into public.quote_runs (id, job_id, organization_id, initiated_by, status)
values ('e766d000-0766-4000-8000-000000000032', 'e766d000-0766-4000-8000-000000000030', 'e766d000-0766-4000-8000-000000000010', 'e766d000-0766-4000-8000-000000000001', 'completed');
insert into public.vendor_quote_results (id, quote_run_id, part_id, organization_id, vendor, requested_quantity, status, total_price_usd)
values ('e766d000-0766-4000-8000-000000000033', 'e766d000-0766-4000-8000-000000000032', 'e766d000-0766-4000-8000-000000000031', 'e766d000-0766-4000-8000-000000000010', 'xometry', 1, 'instant_quote_received', 100);
insert into public.vendor_quote_offers (
  id, vendor_quote_result_id, organization_id, offer_key, supplier, lane_label,
  unit_price_usd, total_price_usd, valid_until, provenance_status, raw_payload
) values
  ('e766d000-0766-4000-8000-000000000034', 'e766d000-0766-4000-8000-000000000033', 'e766d000-0766-4000-8000-000000000010', 'ovd766d-current', 'Synthetic supplier', 'Current', 100, 100, clock_timestamp() + interval '7 days', 'trusted_adapter', '{"source":"synthetic-ovd766d-fixture"}'::jsonb),
  ('e766d000-0766-4000-8000-000000000035', 'e766d000-0766-4000-8000-000000000033', 'e766d000-0766-4000-8000-000000000010', 'ovd766d-target', 'Synthetic supplier', 'Target', 100, 100, clock_timestamp() + interval '7 days', 'trusted_adapter', '{"source":"synthetic-ovd766d-fixture"}'::jsonb);
-- A non-null starting selection lets the clear-to-null denial prove nothing moved.
update public.jobs set selected_vendor_quote_offer_id = 'e766d000-0766-4000-8000-000000000034'
where id = 'e766d000-0766-4000-8000-000000000030';
insert into public.published_quote_packages (id, job_id, quote_run_id, organization_id, published_by, pricing_policy_id)
values ('e766d000-0766-4000-8000-000000000040', 'e766d000-0766-4000-8000-000000000030', 'e766d000-0766-4000-8000-000000000032', 'e766d000-0766-4000-8000-000000000010', 'e766d000-0766-4000-8000-000000000001', 'e766d000-0766-4000-8000-000000000020');
insert into public.published_quote_options (
  id, package_id, organization_id, option_kind, label, published_price_usd,
  source_vendor_quote_id, source_vendor_quote_offer_id, markup_policy_version
) values ('e766d000-0766-4000-8000-000000000041', 'e766d000-0766-4000-8000-000000000040', 'e766d000-0766-4000-8000-000000000010', 'lowest_cost', 'OVD-766 d option', 120,
  'e766d000-0766-4000-8000-000000000033', 'e766d000-0766-4000-8000-000000000035', 'ovd766d-fixture');

create function pg_temp.ovd766d_state() returns jsonb language sql as $$
  select jsonb_build_object(
    'job', (select to_jsonb(j) from public.jobs j where j.id = 'e766d000-0766-4000-8000-000000000030'),
    'selections', (select coalesce(jsonb_agg(to_jsonb(s) order by s.id), '[]'::jsonb)
      from public.client_selections s where s.package_id = 'e766d000-0766-4000-8000-000000000040'),
    'audit', (select coalesce(jsonb_agg(to_jsonb(a) order by a.id), '[]'::jsonb)
      from public.audit_events a where a.organization_id = 'e766d000-0766-4000-8000-000000000010')
  );
$$;
create temporary table ovd766d_before (state jsonb) on commit drop;
insert into ovd766d_before select pg_temp.ovd766d_state();

-- TODO(read-only member): not constructible today (see header). A pgTAP skip()
-- is not used because run-supabase-policy-tests rejects SKIP/TODO output. These
-- premises fail when an access-without-edit state becomes possible; replace
-- them then with denial cases for both functions.
select is(enum_range(null::public.project_role)::text[], array['owner', 'editor']::text[],
  'premise: project_role has no read-only value, so every project member can edit');
select pg_temp.set_ovd766d_identity('e766d000-0766-4000-8000-000000000003');
select ok(public.user_can_access_job('e766d000-0766-4000-8000-000000000030')
    and public.user_can_edit_job('e766d000-0766-4000-8000-000000000030'),
  'premise: a client org member with job access can also edit it');

-- anon.
set local role anon;
select throws_ok($$select public.api_set_job_selected_vendor_quote_offer('e766d000-0766-4000-8000-000000000030', 'e766d000-0766-4000-8000-000000000035')$$,
  '42501', null, 'anon cannot execute api_set_job_selected_vendor_quote_offer');
reset role;
select is(pg_temp.ovd766d_state(), (select state from ovd766d_before),
  'anon direct selection: no job, selection, or audit writes');
set local role anon;
select throws_ok($$select public.api_select_quote_option('e766d000-0766-4000-8000-000000000040', 'e766d000-0766-4000-8000-000000000041', 'ovd766d')$$,
  '42501', null, 'anon cannot execute api_select_quote_option');
reset role;
select is(pg_temp.ovd766d_state(), (select state from ovd766d_before),
  'anon published selection: no job, selection, or audit writes');

-- Signed-out authenticated request.
select pg_temp.set_ovd766d_identity(null);
set local role authenticated;
select throws_ok($$select public.api_set_job_selected_vendor_quote_offer('e766d000-0766-4000-8000-000000000030', 'e766d000-0766-4000-8000-000000000035')$$,
  'P0001', 'You must be signed in to perform this action.', 'signed-out direct selection is denied');
reset role;
select is(pg_temp.ovd766d_state(), (select state from ovd766d_before),
  'signed-out direct selection: no job, selection, or audit writes');
set local role authenticated;
select throws_ok($$select public.api_select_quote_option('e766d000-0766-4000-8000-000000000040', 'e766d000-0766-4000-8000-000000000041', 'ovd766d')$$,
  'P0001', 'You must be signed in to perform this action.', 'signed-out published selection is denied');
reset role;
select is(pg_temp.ovd766d_state(), (select state from ovd766d_before),
  'signed-out published selection: no job, selection, or audit writes');

-- Verified user outside the org and its projects.
select pg_temp.set_ovd766d_identity('e766d000-0766-4000-8000-000000000002');
set local role authenticated;
select throws_ok($$select public.api_set_job_selected_vendor_quote_offer('e766d000-0766-4000-8000-000000000030', 'e766d000-0766-4000-8000-000000000035')$$,
  'P0001', 'You do not have access to job e766d000-0766-4000-8000-000000000030.', 'non-member direct selection is denied');
reset role;
select is(pg_temp.ovd766d_state(), (select state from ovd766d_before),
  'non-member direct selection: no job, selection, or audit writes');
set local role authenticated;
select throws_ok($$select public.api_set_job_selected_vendor_quote_offer('e766d000-0766-4000-8000-000000000030', null)$$,
  'P0001', 'You do not have access to job e766d000-0766-4000-8000-000000000030.', 'non-member cannot clear the selected offer');
reset role;
select is(pg_temp.ovd766d_state(), (select state from ovd766d_before),
  'non-member clear: selected offer unchanged');
set local role authenticated;
select throws_ok($$select public.api_select_quote_option('e766d000-0766-4000-8000-000000000040', 'e766d000-0766-4000-8000-000000000041', 'ovd766d')$$,
  'P0001', 'You do not have access to package e766d000-0766-4000-8000-000000000040', 'non-member published selection is denied');
reset role;
select is(pg_temp.ovd766d_state(), (select state from ovd766d_before),
  'non-member published selection: no job, selection, or audit writes');

-- Unverified org member.
select pg_temp.set_ovd766d_identity('e766d000-0766-4000-8000-000000000003');
set local role authenticated;
select throws_ok($$select public.api_set_job_selected_vendor_quote_offer('e766d000-0766-4000-8000-000000000030', 'e766d000-0766-4000-8000-000000000035')$$,
  'P0001', 'Verify your email or sign in with Google, Microsoft, or Apple before performing this action.', 'unverified direct selection is denied');
reset role;
select is(pg_temp.ovd766d_state(), (select state from ovd766d_before),
  'unverified direct selection: no job, selection, or audit writes');
set local role authenticated;
select throws_ok($$select public.api_select_quote_option('e766d000-0766-4000-8000-000000000040', 'e766d000-0766-4000-8000-000000000041', 'ovd766d')$$,
  'P0001', 'Verify your email or sign in with Google, Microsoft, or Apple before performing this action.', 'unverified published selection is denied');
reset role;
select is(pg_temp.ovd766d_state(), (select state from ovd766d_before),
  'unverified published selection: no job, selection, or audit writes');

-- Editor.
select pg_temp.set_ovd766d_identity('e766d000-0766-4000-8000-000000000001');
set local role authenticated;
select lives_ok($$select public.api_set_job_selected_vendor_quote_offer('e766d000-0766-4000-8000-000000000030', 'e766d000-0766-4000-8000-000000000035')$$,
  'editor direct selection is allowed');
select lives_ok($$select public.api_select_quote_option('e766d000-0766-4000-8000-000000000040', 'e766d000-0766-4000-8000-000000000041', 'ovd766d')$$,
  'editor published selection is allowed');
reset role;
select is((select selected_vendor_quote_offer_id from public.jobs where id = 'e766d000-0766-4000-8000-000000000030'),
  'e766d000-0766-4000-8000-000000000035'::uuid, 'editor direct selection persists the offer');
select is((select status::text from public.jobs where id = 'e766d000-0766-4000-8000-000000000030'),
  'client_selected', 'editor published selection sets the job status');
select is((select count(*)::integer from public.client_selections
    where package_id = 'e766d000-0766-4000-8000-000000000040'
      and option_id = 'e766d000-0766-4000-8000-000000000041'
      and selected_by = 'e766d000-0766-4000-8000-000000000001'), 1,
  'editor published selection records one selection by the editor');
select is((select count(*)::integer from public.audit_events
    where package_id = 'e766d000-0766-4000-8000-000000000040'
      and event_type = 'client.quote_option_selected'), 1,
  'editor published selection emits one audit event');

select * from finish();
rollback;
