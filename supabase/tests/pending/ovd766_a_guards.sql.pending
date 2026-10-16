-- OVD-766 (group a) / OVD-767: verified auth + AAL2 on the platform admin
-- emergency controls.
--
-- Targets the draft docs/migration-drafts/ovd-766-a.sql.
-- PENDING: the draft is NOT applied (NEEDS BLAINE MIGRATION WINDOW). This file
-- carries a .pending suffix so the policy-test runner stages it but never
-- executes it. In the approved window, the draft is promoted and this file is
-- renamed to supabase/tests/ovd766_a_guards.sql in the same change.
-- Pre-apply observation: the AAL1 admin and unverified admin refusals fail
-- (the current bodies let those callers through), and the spend cap
-- search_path assertion fails (it is still search_path = public).
--
-- Per function:
--   public.api_admin_set_provider_kill_switch(public.vendor_name, boolean, text, bigint)
--   public.api_admin_set_global_kill_switch(boolean, text, bigint)
--   public.api_set_global_spend_cap(numeric, numeric, boolean)
--   public.api_review_export_control_block(uuid, text, text)
-- covers:
--   * pg_proc: SECURITY DEFINER and search_path = ''
--   * EXECUTE: not PUBLIC, not anon, authenticated yes
--   * anon is refused (permission denied)
--   * a verified non-admin at AAL2 is refused by the admin check
--   * an unverified platform admin at AAL2 is refused by require_verified_auth()
--   * a verified platform admin at AAL1 is refused by the AAL2 check
--   * a verified platform admin at AAL2 is allowed
--   * refused calls leave no audit row, no switch flip and no block review
begin;

create extension if not exists pgtap with schema extensions;

select plan(30);

create function pg_temp.set_ovd766a_request_identity(
  p_user_id uuid,
  p_role text,
  p_aal text default null
)
returns void
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_claims jsonb;
begin
  v_claims := pg_catalog.jsonb_build_object('sub', p_user_id, 'role', p_role);

  if p_aal is not null then
    v_claims := v_claims || pg_catalog.jsonb_build_object('aal', p_aal);
  end if;

  perform pg_catalog.set_config('request.jwt.claims', v_claims::text, true);
  perform pg_catalog.set_config('request.jwt.claim.sub', coalesce(p_user_id::text, ''), true);
end;
$$;

grant execute on function pg_temp.set_ovd766a_request_identity(uuid, text, text)
  to anon, authenticated;

-- admin: verified platform admin. member: verified, not an admin.
-- unverified: platform admin whose email is not confirmed.
insert into auth.users (id, aud, role, email, email_confirmed_at) values
  ('00000000-0000-4000-8000-000000766a01', 'authenticated', 'authenticated',
    'ovd766a-admin@example.test', pg_catalog.timezone('utc', pg_catalog.now())),
  ('00000000-0000-4000-8000-000000766a02', 'authenticated', 'authenticated',
    'ovd766a-member@example.test', pg_catalog.timezone('utc', pg_catalog.now())),
  ('00000000-0000-4000-8000-000000766a03', 'authenticated', 'authenticated',
    'ovd766a-unverified@example.test', null);

insert into private.platform_admin_emails (email) values
  ('ovd766a-admin@example.test'),
  ('ovd766a-unverified@example.test')
on conflict do nothing;

-- A pending marking block to review. The block and event tables carry no
-- foreign keys, so synthetic job and organization ids are enough.
insert into private.job_export_marking_blocks (id, job_id, organization_id, source, patterns)
values (
  '00000000-0000-4000-8000-000000766ab1',
  '00000000-0000-4000-8000-000000766ab2',
  '00000000-0000-4000-8000-000000766ab3',
  'drawing_text',
  array['ITAR']
);

-- ---------------------------------------------------------------------
-- pg_proc security posture and grants
-- ---------------------------------------------------------------------
create temporary table ovd766a_functions (sig text primary key) on commit drop;
insert into ovd766a_functions (sig) values
  ('public.api_admin_set_provider_kill_switch(public.vendor_name, boolean, text, bigint)'),
  ('public.api_admin_set_global_kill_switch(boolean, text, bigint)'),
  ('public.api_set_global_spend_cap(numeric, numeric, boolean)'),
  ('public.api_review_export_control_block(uuid, text, text)');

select ok(
  (select p.prosecdef and p.proconfig @> array['search_path=""']
   from pg_catalog.pg_proc p
   where p.oid = 'public.api_admin_set_provider_kill_switch(public.vendor_name, boolean, text, bigint)'::regprocedure),
  'api_admin_set_provider_kill_switch is SECURITY DEFINER with search_path = ''''');
select ok(
  (select p.prosecdef and p.proconfig @> array['search_path=""']
   from pg_catalog.pg_proc p
   where p.oid = 'public.api_admin_set_global_kill_switch(boolean, text, bigint)'::regprocedure),
  'api_admin_set_global_kill_switch is SECURITY DEFINER with search_path = ''''');
select ok(
  (select p.prosecdef and p.proconfig @> array['search_path=""']
   from pg_catalog.pg_proc p
   where p.oid = 'public.api_set_global_spend_cap(numeric, numeric, boolean)'::regprocedure),
  'api_set_global_spend_cap is SECURITY DEFINER with search_path = ''''');
select ok(
  (select p.prosecdef and p.proconfig @> array['search_path=""']
   from pg_catalog.pg_proc p
   where p.oid = 'public.api_review_export_control_block(uuid, text, text)'::regprocedure),
  'api_review_export_control_block is SECURITY DEFINER with search_path = ''''');

select is_empty(
  $$ select sig from ovd766a_functions
     where pg_catalog.has_function_privilege('anon', sig, 'EXECUTE') $$,
  'anon cannot execute any of the four functions');
select is_empty(
  $$ select sig from ovd766a_functions f
     where exists (
       select 1
       from pg_catalog.pg_proc p,
         pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
       where p.oid = f.sig::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE') $$,
  'PUBLIC holds EXECUTE on none of the four functions');
select is_empty(
  $$ select sig from ovd766a_functions
     where not pg_catalog.has_function_privilege('authenticated', sig, 'EXECUTE') $$,
  'authenticated can execute all four functions');
select ok(
  not pg_catalog.has_function_privilege('service_role',
      'public.api_admin_set_provider_kill_switch(public.vendor_name, boolean, text, bigint)', 'EXECUTE')
    and not pg_catalog.has_function_privilege('service_role',
      'public.api_admin_set_global_kill_switch(boolean, text, bigint)', 'EXECUTE'),
  'service_role still cannot execute either kill switch RPC');

-- ---------------------------------------------------------------------
-- anon: permission denied
-- ---------------------------------------------------------------------
set local role anon;
select pg_temp.set_ovd766a_request_identity(null, 'anon');

select throws_ok(
  $$select public.api_admin_set_provider_kill_switch('fictiv', true, 'anon should never flip this')$$,
  '42501', null, 'anon is refused by api_admin_set_provider_kill_switch');
select throws_ok(
  $$select public.api_admin_set_global_kill_switch(true, 'anon should never flip this')$$,
  '42501', null, 'anon is refused by api_admin_set_global_kill_switch');
select throws_ok(
  $$select public.api_set_global_spend_cap(null, null, true)$$,
  '42501', null, 'anon is refused by api_set_global_spend_cap');
select throws_ok(
  $$select public.api_review_export_control_block('00000000-0000-4000-8000-000000766ab1', 'cleared_by_admin', 'anon review')$$,
  '42501', null, 'anon is refused by api_review_export_control_block');

reset role;

-- ---------------------------------------------------------------------
-- Verified non-admin at AAL2: refused by the admin check
-- ---------------------------------------------------------------------
set local role authenticated;
select pg_temp.set_ovd766a_request_identity('00000000-0000-4000-8000-000000766a02', 'authenticated', 'aal2');

select throws_ok(
  $$select public.api_admin_set_provider_kill_switch('fictiv', true, 'member should never flip this')$$,
  '42501', 'platform_admin_required', 'a non-admin is refused by api_admin_set_provider_kill_switch');
select throws_ok(
  $$select public.api_admin_set_global_kill_switch(true, 'member should never flip this')$$,
  '42501', 'platform_admin_required', 'a non-admin is refused by api_admin_set_global_kill_switch');
select throws_ok(
  $$select public.api_set_global_spend_cap(null, null, true)$$,
  'P0001', 'Not authorized', 'a non-admin is refused by api_set_global_spend_cap');
select throws_ok(
  $$select public.api_review_export_control_block('00000000-0000-4000-8000-000000766ab1', 'cleared_by_admin', 'member review')$$,
  '42501', 'export_review_admin_required', 'a non-admin is refused by api_review_export_control_block');

-- ---------------------------------------------------------------------
-- Unverified platform admin at AAL2: refused by require_verified_auth()
-- ---------------------------------------------------------------------
select pg_temp.set_ovd766a_request_identity('00000000-0000-4000-8000-000000766a03', 'authenticated', 'aal2');

select throws_ok(
  $$select public.api_admin_set_provider_kill_switch('fictiv', true, 'unverified admin flip')$$,
  'P0001', 'Verify your email or sign in with Google, Microsoft, or Apple before performing this action.',
  'an unverified admin is refused by api_admin_set_provider_kill_switch');
select throws_ok(
  $$select public.api_admin_set_global_kill_switch(true, 'unverified admin flip')$$,
  'P0001', 'Verify your email or sign in with Google, Microsoft, or Apple before performing this action.',
  'an unverified admin is refused by api_admin_set_global_kill_switch');
select throws_ok(
  $$select public.api_set_global_spend_cap(null, null, true)$$,
  'P0001', 'Verify your email or sign in with Google, Microsoft, or Apple before performing this action.',
  'an unverified admin is refused by api_set_global_spend_cap');
select throws_ok(
  $$select public.api_review_export_control_block('00000000-0000-4000-8000-000000766ab1', 'cleared_by_admin', 'unverified review')$$,
  'P0001', 'Verify your email or sign in with Google, Microsoft, or Apple before performing this action.',
  'an unverified admin is refused by api_review_export_control_block');

-- ---------------------------------------------------------------------
-- Verified platform admin at AAL1: refused by the AAL2 check
-- ---------------------------------------------------------------------
select pg_temp.set_ovd766a_request_identity('00000000-0000-4000-8000-000000766a01', 'authenticated', 'aal1');

select throws_ok(
  $$select public.api_admin_set_provider_kill_switch('fictiv', true, 'AAL1 admin should not flip this')$$,
  'P0001', 'Multi-factor authentication is required for provider kill switch administration.',
  'an AAL1 admin is refused by api_admin_set_provider_kill_switch');
select throws_ok(
  $$select public.api_admin_set_global_kill_switch(true, 'AAL1 admin should not flip this')$$,
  'P0001', 'Multi-factor authentication is required for provider kill switch administration.',
  'an AAL1 admin is refused by api_admin_set_global_kill_switch');
select throws_ok(
  $$select public.api_set_global_spend_cap(null, null, true)$$,
  'P0001', 'Multi-factor authentication is required for spend cap administration.',
  'an AAL1 admin is refused by api_set_global_spend_cap');
select throws_ok(
  $$select public.api_review_export_control_block('00000000-0000-4000-8000-000000766ab1', 'cleared_by_admin', 'AAL1 review')$$,
  'P0001', 'Multi-factor authentication is required for export-control review.',
  'an AAL1 admin is refused by api_review_export_control_block');

reset role;

-- ---------------------------------------------------------------------
-- Refusals changed nothing
-- ---------------------------------------------------------------------
select ok(
  not exists (
    select 1 from private.provider_kill_switch_audit
    where actor in ('00000000-0000-4000-8000-000000766a01',
                    '00000000-0000-4000-8000-000000766a02',
                    '00000000-0000-4000-8000-000000766a03'))
    and not exists (select 1 from private.provider_kill_switches where engaged)
    and not exists (select 1 from private.provider_global_kill_switch where engaged)
    and not coalesce((select s.kill_switch from public.spend_caps s where s.organization_id is null), false),
  'refused calls wrote no kill switch audit row and flipped no switch or spend kill switch');
select is(
  (select b.state from private.job_export_marking_blocks b
   where b.id = '00000000-0000-4000-8000-000000766ab1'),
  'blocked_pending_review',
  'refused calls left the marking block pending');

-- ---------------------------------------------------------------------
-- Verified platform admin at AAL2: allowed
-- ---------------------------------------------------------------------
set local role authenticated;
select pg_temp.set_ovd766a_request_identity('00000000-0000-4000-8000-000000766a01', 'authenticated', 'aal2');

select is(
  public.api_admin_set_provider_kill_switch('fictiv', true, 'OVD-766 test: AAL2 admin engages') ->> 'engaged',
  'true',
  'an AAL2 admin engages the fictiv kill switch');
select is(
  public.api_admin_set_global_kill_switch(true, 'OVD-766 test: AAL2 admin engages') ->> 'engaged',
  'true',
  'an AAL2 admin engages the global kill switch');
select is(
  public.api_set_global_spend_cap(null, null, true) ->> 'killSwitch',
  'true',
  'an AAL2 admin sets the global spend kill switch');
select is(
  public.api_review_export_control_block(
    '00000000-0000-4000-8000-000000766ab1', 'confirmed_controlled', 'OVD-766 test: AAL2 admin review'
  ) ->> 'state',
  'confirmed_controlled',
  'an AAL2 admin reviews the marking block');

reset role;

select * from finish();
rollback;
