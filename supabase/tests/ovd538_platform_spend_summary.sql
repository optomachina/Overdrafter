begin;

select plan(7);

create function pg_temp.set_ovd538_request_identity(
  p_user_id uuid,
  p_auth_role text
)
returns void
language plpgsql
set search_path = pg_catalog
as $$
begin
  perform pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.jsonb_build_object(
      'sub', p_user_id,
      'role', p_auth_role
    )::text,
    true
  );
  perform pg_catalog.set_config('request.jwt.claim.sub', p_user_id::text, true);
  perform pg_catalog.set_config('request.jwt.claim.role', p_auth_role, true);
end;
$$;

create temporary table ovd538_context (
  first_organization_id uuid not null,
  second_organization_id uuid not null,
  internal_user_id uuid not null,
  platform_admin_user_id uuid not null,
  auth_role text not null,
  platform_admin_email text not null,
  by_organization_key text not null,
  organization_id_key text not null,
  spend_usd_key text not null
) on commit drop;

insert into ovd538_context values (
  '00000000-0000-4000-8000-000000005381',
  '00000000-0000-4000-8000-000000005382',
  '00000000-0000-4000-8000-000000005383',
  '00000000-0000-4000-8000-000000005384',
  'authenticated',
  'ovd538-platform-admin@example.com',
  'byOrganization',
  'organizationId',
  'spendUsd'
);

grant select on ovd538_context to authenticated;

insert into auth.users (id, aud, role, email)
values
  (
    (select internal_user_id from ovd538_context),
    (select auth_role from ovd538_context),
    (select auth_role from ovd538_context),
    'ovd538-internal@example.com'
  ),
  (
    (select platform_admin_user_id from ovd538_context),
    (select auth_role from ovd538_context),
    (select auth_role from ovd538_context),
    (select platform_admin_email from ovd538_context)
  );

insert into public.organizations (id, name, slug)
values
  (
    (select first_organization_id from ovd538_context),
    'OVD 538 First',
    'ovd-538-first'
  ),
  (
    (select second_organization_id from ovd538_context),
    'OVD 538 Second',
    'ovd-538-second'
  );

insert into public.organization_memberships (organization_id, user_id, role)
values (
  (select first_organization_id from ovd538_context),
  (select internal_user_id from ovd538_context),
  'internal_admin'
);

insert into private.platform_admin_emails (email)
select platform_admin_email from ovd538_context;

insert into public.spend_ledger (organization_id, category, amount_usd)
values
  ((select first_organization_id from ovd538_context), 'llm_extraction', 1.25),
  ((select second_organization_id from ovd538_context), 'vendor_automation', 2.50);

set local role authenticated;
select pg_temp.set_ovd538_request_identity(
  (select internal_user_id from ovd538_context),
  (select auth_role from ovd538_context)
);

select is(
  public.is_platform_admin(),
  false,
  'an ordinary internal administrator is not a platform administrator'
);

select throws_ok(
  'select public.api_spend_summary()',
  'P0001',
  'Not authorized',
  'an internal administrator cannot read global cross-organization spend'
);

reset role;

set local role authenticated;
select pg_temp.set_ovd538_request_identity(
  (select platform_admin_user_id from ovd538_context),
  (select auth_role from ovd538_context)
);

select is(
  public.is_platform_admin(),
  true,
  'an allowlisted user remains a platform administrator without membership'
);

select ok(
  public.api_spend_summary() ?& array[
    'since',
    'totalSpendUsd',
    'globalDailyCeilingUsd',
    'perRunCeilingUsd',
    'killSwitch',
    'byCategory',
    (select by_organization_key from ovd538_context)
  ],
  'the platform administrator receives the unchanged summary shape'
);

select is(
  (
    select (organization_spend.value ->> (select spend_usd_key from ovd538_context))::numeric
    from jsonb_array_elements(
      public.api_spend_summary() -> (select by_organization_key from ovd538_context)
    )
      as organization_spend(value)
    where organization_spend.value ->> (select organization_id_key from ovd538_context) =
      (select first_organization_id::text from ovd538_context)
  ),
  1.25::numeric,
  'the platform administrator sees the first organization spend'
);

select is(
  (
    select (organization_spend.value ->> (select spend_usd_key from ovd538_context))::numeric
    from jsonb_array_elements(
      public.api_spend_summary() -> (select by_organization_key from ovd538_context)
    )
      as organization_spend(value)
    where organization_spend.value ->> (select organization_id_key from ovd538_context) =
      (select second_organization_id::text from ovd538_context)
  ),
  2.50::numeric,
  'the platform administrator sees the second organization spend'
);

select is(
  (
    select pg_catalog.count(*)
    from public.organization_memberships membership
    where membership.user_id =
      (select platform_admin_user_id from ovd538_context)
  ),
  0::bigint,
  'the allowlisted platform administrator did not need an organization membership'
);

select * from finish();
rollback;
