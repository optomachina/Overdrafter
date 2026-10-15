-- OVD-768 (OVD-766 group b): verified auth guard on the four platform admin
-- list RPCs.
--
-- Targets the draft docs/migration-drafts/ovd-766-b.sql.
-- PENDING: the draft is NOT applied (NEEDS BLAINE MIGRATION WINDOW). This file
-- carries a .pending suffix so the policy-test runner stages it but never
-- executes it. In the approved window, the draft is promoted and this file is
-- moved unchanged to supabase/tests/ovd768_admin_list_guards.sql in the same
-- change. Plain SQL with no psql meta-commands.
-- Pre-apply observation: anon still holds EXECUTE (PUBLIC and anon grants), the
-- unverified admin is allowed, and search_path is public, auth, private, so the
-- anon, unverified-admin and search_path assertions fail.
--
-- Per function: SECURITY DEFINER with search_path '', anon holds no EXECUTE and
-- is refused (42501), a verified non-admin and an unverified platform admin are
-- refused by the function body, a verified platform admin is allowed.
-- Synthetic records only; everything rolls back.
begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(29);

create function pg_temp.act_as(p_user_id uuid)
returns void
language plpgsql
set search_path = pg_catalog
as $$
begin
  perform pg_catalog.set_config(
    'request.jwt.claims',
    case
      when p_user_id is null then pg_catalog.jsonb_build_object('role', 'anon')
      else pg_catalog.jsonb_build_object('sub', p_user_id, 'role', 'authenticated', 'aal', 'aal1')
    end::text,
    true
  );
  perform pg_catalog.set_config('request.jwt.claim.sub', coalesce(p_user_id::text, ''), true);
end;
$$;

-- A verified admin, an admin with no confirmed email and no OAuth provider,
-- and a verified user who is not on the platform admin allowlist.
insert into auth.users (id, aud, role, email, email_confirmed_at, raw_app_meta_data)
select fixture.id, 'authenticated', 'authenticated', fixture.email,
  case when fixture.verified then timezone('utc', now()) end, '{"provider":"email"}'::jsonb
from (values
  ('76b00000-0000-4000-8000-000000000001'::uuid, 'ovd768-admin@example.test', true),
  ('76b00000-0000-4000-8000-000000000002'::uuid, 'ovd768-unverified-admin@example.test', false),
  ('76b00000-0000-4000-8000-000000000003'::uuid, 'ovd768-member@example.test', true)
) as fixture(id, email, verified);

insert into private.platform_admin_emails (email)
values ('ovd768-admin@example.test'), ('ovd768-unverified-admin@example.test');

insert into public.organizations (id, name, slug)
values ('76b00000-0000-4000-8000-00000000000a', 'OVD 768 organization', 'ovd-768-admin-list-guards');

insert into public.organization_memberships (organization_id, user_id, role)
values ('76b00000-0000-4000-8000-00000000000a', '76b00000-0000-4000-8000-000000000003', 'client');

-- 1-12. Definer flag, pinned empty search_path, and no anon EXECUTE.
select ok(p.prosecdef, p.oid::regprocedure::text || ' is SECURITY DEFINER')
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('api_admin_list_organizations', 'api_admin_list_all_users',
    'api_admin_list_all_jobs', 'api_admin_list_all_projects')
order by p.proname;

select is(p.proconfig, array['search_path=""']::text[],
  p.oid::regprocedure::text || ' pins search_path to empty')
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('api_admin_list_organizations', 'api_admin_list_all_users',
    'api_admin_list_all_jobs', 'api_admin_list_all_projects')
order by p.proname;

select ok(not has_function_privilege('anon', 'public.api_admin_list_organizations()', 'EXECUTE'),
  'anon has no EXECUTE on api_admin_list_organizations');
select ok(not has_function_privilege('anon', 'public.api_admin_list_all_users()', 'EXECUTE'),
  'anon has no EXECUTE on api_admin_list_all_users');
select ok(not has_function_privilege('anon', 'public.api_admin_list_all_jobs()', 'EXECUTE'),
  'anon has no EXECUTE on api_admin_list_all_jobs');
select ok(not has_function_privilege('anon', 'public.api_admin_list_all_projects()', 'EXECUTE'),
  'anon has no EXECUTE on api_admin_list_all_projects');

-- 13-16. Anonymous callers are refused.
select pg_temp.act_as(null);
set local role anon;
select throws_ok('select public.api_admin_list_organizations()',
  '42501', 'permission denied for function api_admin_list_organizations',
  'anon cannot execute api_admin_list_organizations');
select throws_ok('select public.api_admin_list_all_users()',
  '42501', 'permission denied for function api_admin_list_all_users',
  'anon cannot execute api_admin_list_all_users');
select throws_ok('select public.api_admin_list_all_jobs()',
  '42501', 'permission denied for function api_admin_list_all_jobs',
  'anon cannot execute api_admin_list_all_jobs');
select throws_ok('select public.api_admin_list_all_projects()',
  '42501', 'permission denied for function api_admin_list_all_projects',
  'anon cannot execute api_admin_list_all_projects');
reset role;

-- 17-20. A verified user who is not a platform admin.
select pg_temp.act_as('76b00000-0000-4000-8000-000000000003');
set local role authenticated;
select throws_ok('select public.api_admin_list_organizations()',
  'P0001', 'Platform admin access required.',
  'verified non-admin cannot list organizations');
select throws_ok('select public.api_admin_list_all_users()',
  'P0001', 'Platform admin access required.',
  'verified non-admin cannot list users');
select throws_ok('select public.api_admin_list_all_jobs()',
  'P0001', 'Platform admin access required.',
  'verified non-admin cannot list jobs');
select throws_ok('select public.api_admin_list_all_projects()',
  'P0001', 'Platform admin access required.',
  'verified non-admin cannot list projects');
reset role;

-- 21-24. A platform admin without verified auth (require_verified_auth()).
select pg_temp.act_as('76b00000-0000-4000-8000-000000000002');
set local role authenticated;
select throws_ok('select public.api_admin_list_organizations()',
  'P0001', 'Verify your email or sign in with Google, Microsoft, or Apple before performing this action.',
  'unverified platform admin cannot list organizations');
select throws_ok('select public.api_admin_list_all_users()',
  'P0001', 'Verify your email or sign in with Google, Microsoft, or Apple before performing this action.',
  'unverified platform admin cannot list users');
select throws_ok('select public.api_admin_list_all_jobs()',
  'P0001', 'Verify your email or sign in with Google, Microsoft, or Apple before performing this action.',
  'unverified platform admin cannot list jobs');
select throws_ok('select public.api_admin_list_all_projects()',
  'P0001', 'Verify your email or sign in with Google, Microsoft, or Apple before performing this action.',
  'unverified platform admin cannot list projects');
reset role;

-- 25-29. A verified platform admin (AAL1 is enough: no AAL2 on these reads).
select pg_temp.act_as('76b00000-0000-4000-8000-000000000001');
set local role authenticated;
select lives_ok('select public.api_admin_list_organizations()',
  'verified platform admin can list organizations');
select lives_ok('select public.api_admin_list_all_users()',
  'verified platform admin can list users');
select lives_ok('select public.api_admin_list_all_jobs()',
  'verified platform admin can list jobs');
select lives_ok('select public.api_admin_list_all_projects()',
  'verified platform admin can list projects');
select ok(
  public.api_admin_list_organizations()
    @> jsonb_build_array(jsonb_build_object(
      'id', '76b00000-0000-4000-8000-00000000000a'::uuid, 'memberCount', 1)),
  'verified platform admin sees the fixture organization unchanged in shape');
reset role;

select * from finish();
rollback;
