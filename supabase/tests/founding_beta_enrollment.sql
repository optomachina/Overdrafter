begin;

select plan(27);

create function pg_temp.set_ovd364_request_identity(
  p_user_id uuid,
  p_aal text default 'aal1'
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
      'role', 'authenticated', -- NOSONAR: repeated JWT fixture claim
      'aal', p_aal
    )::text,
    true
  );
  perform pg_catalog.set_config('request.jwt.claim.sub', p_user_id::text, true);
  perform pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true);
end;
$$;

create temporary table ovd364_test_context (
  admin_user_id uuid not null,
  member_user_id uuid not null,
  outsider_user_id uuid not null,
  organization_id uuid not null,
  second_organization_id uuid not null
) on commit drop;

insert into ovd364_test_context values (
  '00000000-0000-4000-8000-000000003641',
  '00000000-0000-4000-8000-000000003642',
  '00000000-0000-4000-8000-000000003643',
  '00000000-0000-4000-8000-000000003644',
  '00000000-0000-4000-8000-000000003645'
);

grant select on ovd364_test_context to authenticated;

insert into auth.users (id, aud, role, email, email_confirmed_at)
values
  (
    (select admin_user_id from ovd364_test_context),
    'authenticated',
    'authenticated',
    'ovd364-admin@example.com',
    timezone('utc', now())
  ),
  (
    (select member_user_id from ovd364_test_context),
    'authenticated',
    'authenticated',
    'ovd364-member@example.com',
    timezone('utc', now())
  ),
  (
    (select outsider_user_id from ovd364_test_context),
    'authenticated',
    'authenticated',
    'ovd364-outsider@example.com',
    timezone('utc', now())
  );

insert into private.platform_admin_emails (email)
values ('ovd364-admin@example.com');

insert into public.organizations (id, name, slug)
values
  (
    (select organization_id from ovd364_test_context),
    'OVD 364 Primary',
    'ovd-364-primary'
  ),
  (
    (select second_organization_id from ovd364_test_context),
    'OVD 364 Secondary',
    'ovd-364-secondary'
  );

insert into public.organization_memberships (organization_id, user_id, role)
values
  (
    (select organization_id from ovd364_test_context),
    (select admin_user_id from ovd364_test_context),
    'internal_admin'
  ),
  (
    (select organization_id from ovd364_test_context),
    (select member_user_id from ovd364_test_context),
    'client'
  ),
  (
    (select second_organization_id from ovd364_test_context),
    (select outsider_user_id from ovd364_test_context),
    'client'
  );

set local role authenticated;
select pg_temp.set_ovd364_request_identity(
  (select member_user_id from ovd364_test_context)
);

select is(
  public.api_get_founding_beta_access_state(
    (select organization_id from ovd364_test_context)
  ) ->> 'state', -- NOSONAR: stable public state field
  'not_enrolled',
  'membership does not implicitly enroll an organization'
);

select is(
  public.api_get_founding_beta_access_state(
    (select organization_id from ovd364_test_context)
  ) ->> 'policyRevision',
  'founding-beta-2026-08-15', -- NOSONAR: canonical notice revision fixture
  'member state returns the current policy revision'
);

select throws_ok(
  format(
    $$select public.api_create_job(%L::uuid, 'Denied before enrollment')$$,
    (select organization_id from ovd364_test_context)
  ),
  'P0001', -- NOSONAR: repeated PostgreSQL exception code assertion
  'Founding Beta access and current notice acceptance are required.',
  'the job RPC fails closed before enrollment'
);

select throws_ok(
  format(
    $$insert into public.jobs (organization_id, created_by, title)
      values (%L::uuid, %L::uuid, 'Direct insert denied')$$,
    (select organization_id from ovd364_test_context),
    (select member_user_id from ovd364_test_context)
  ),
  '42501',
  'new row violates row-level security policy for table "jobs"',
  'direct job inserts fail closed before enrollment'
);

select throws_ok(
  format(
    $$select public.api_admin_set_founding_beta_enrollment(
      %L::uuid, true, 'Unauthorized grant', 'member-grant')$$,
    (select organization_id from ovd364_test_context)
  ),
  'P0001',
  'Platform administrator access is required.',
  'ordinary organization members cannot grant enrollment'
);

select throws_ok(
  format(
    $$select public.api_get_founding_beta_access_state(%L::uuid)$$,
    (select second_organization_id from ovd364_test_context)
  ),
  'P0001',
  'You do not have access to this Founding Beta organization.',
  'member-safe state reads deny cross-organization access'
);

reset role;
set local role authenticated;
select pg_temp.set_ovd364_request_identity(
  (select admin_user_id from ovd364_test_context),
  'aal1'
);

select ok(
  public.is_platform_admin(),
  'the test administrator has the platform role used by the admin RPC'
);

select is(
  public.api_get_founding_beta_access_state(
    (select organization_id from ovd364_test_context)
  ) ->> 'state',
  'not_enrolled',
  'platform administrator role alone does not imply beta enrollment'
);

select throws_ok(
  format(
    $$select public.api_admin_set_founding_beta_enrollment(
      %L::uuid, true, 'AAL1 grant denied', 'aal1-grant')$$,
    (select organization_id from ovd364_test_context)
  ),
  'P0001',
  'Multi-factor authentication is required for Founding Beta administration.',
  'AAL1 platform administrators cannot change enrollment'
);

select pg_temp.set_ovd364_request_identity(
  (select admin_user_id from ovd364_test_context),
  'aal2'
);

select throws_ok(
  format(
    $$select public.api_admin_set_founding_beta_enrollment(
      %L::uuid, null, 'Missing intent denied', 'null-intent')$$,
    (select organization_id from ovd364_test_context)
  ),
  'P0001',
  'Founding Beta enrollment intent is required.',
  'a null enrollment intent fails closed'
);

select lives_ok(
  format(
    $$select public.api_admin_set_founding_beta_enrollment(
      %L::uuid, true, 'Approved Founding Beta participant', 'grant-primary')$$, -- NOSONAR: idempotency replay fixture
    (select organization_id from ovd364_test_context)
  ),
  'an AAL2 platform administrator can grant enrollment'
);

select is(
  (
    public.api_admin_set_founding_beta_enrollment(
      (select organization_id from ovd364_test_context),
      true,
      'Approved Founding Beta participant',
      'grant-primary'
    ) ->> 'replayed'
  )::boolean,
  true,
  'repeating the same grant is idempotent'
);

reset role;

select is(
  (
    select count(*)::integer
    from private.founding_beta_enrollment_events
    where organization_id = (select organization_id from ovd364_test_context)
  ),
  1,
  'an idempotent replay does not append duplicate evidence'
);

set local role authenticated;
select pg_temp.set_ovd364_request_identity(
  (select admin_user_id from ovd364_test_context),
  'aal2'
);

select throws_ok(
  format(
    $$select public.api_admin_set_founding_beta_enrollment(
      %L::uuid, false, 'Conflicting operation', 'grant-primary')$$,
    (select organization_id from ovd364_test_context)
  ),
  'P0001',
  'Idempotency key has already been used for a different Founding Beta operation.',
  'an idempotency key cannot be reused for a different operation'
);

reset role;
set local role authenticated;
select pg_temp.set_ovd364_request_identity(
  (select member_user_id from ovd364_test_context)
);

select is(
  public.api_get_founding_beta_access_state(
    (select organization_id from ovd364_test_context)
  ) ->> 'state',
  'notice_required',
  'an enrolled member must still accept the current notice'
);

select throws_ok(
  format(
    $$select public.api_accept_founding_beta_notice(
      %L::uuid, 'outdated-revision')$$,
    (select organization_id from ovd364_test_context)
  ),
  'P0001',
  'The current Founding Beta notice must be accepted.',
  'stale notice revisions fail closed'
);

select is(
  public.api_accept_founding_beta_notice(
    (select organization_id from ovd364_test_context),
    'founding-beta-2026-08-15'
  ) ->> 'state',
  'eligible',
  'a current per-user notice acceptance makes the member eligible'
);

select is(
  public.api_accept_founding_beta_notice(
    (select organization_id from ovd364_test_context),
    'founding-beta-2026-08-15'
  ) ->> 'state',
  'eligible',
  'repeating notice acceptance is idempotent'
);

reset role;

select is(
  (
    select count(*)::integer
    from private.founding_beta_notice_acceptances
    where organization_id = (select organization_id from ovd364_test_context)
      and user_id = (select member_user_id from ovd364_test_context)
  ),
  1,
  'idempotent acceptance stores one immutable record'
);

set local role authenticated;
select pg_temp.set_ovd364_request_identity(
  (select member_user_id from ovd364_test_context)
);

select lives_ok(
  format(
    $$insert into public.jobs (organization_id, created_by, title)
      values (%L::uuid, %L::uuid, 'Eligible direct insert')$$,
    (select organization_id from ovd364_test_context),
    (select member_user_id from ovd364_test_context)
  ),
  'the direct insert policy allows an eligible accepted member'
);

select lives_ok(
  format(
    $$select public.api_create_client_draft('Eligible RPC draft')$$
  ),
  'the current client draft RPC allows an eligible accepted member'
);

reset role;
set local role authenticated;
select pg_temp.set_ovd364_request_identity(
  (select admin_user_id from ovd364_test_context),
  'aal2'
);

select lives_ok(
  format(
    $$select public.api_admin_set_founding_beta_enrollment(
      %L::uuid, false, 'Participant withdrew', 'revoke-primary')$$,
    (select organization_id from ovd364_test_context)
  ),
  'an AAL2 platform administrator can revoke enrollment'
);

reset role;
set local role authenticated;
select pg_temp.set_ovd364_request_identity(
  (select member_user_id from ovd364_test_context)
);

select is(
  public.api_get_founding_beta_access_state(
    (select organization_id from ovd364_test_context)
  ) ->> 'state',
  'revoked',
  'revocation takes effect immediately'
);

select throws_ok(
  format(
    $$select public.api_create_job(%L::uuid, 'Denied after revocation')$$,
    (select organization_id from ovd364_test_context)
  ),
  'P0001',
  'Founding Beta access and current notice acceptance are required.',
  'the job RPC fails closed after revocation'
);

select ok(
  exists (
    select 1
    from public.jobs
    where organization_id = (select organization_id from ovd364_test_context)
      and title = 'Eligible RPC draft'
  ),
  'revoked members retain read access to existing jobs'
);

reset role;

select throws_ok(
  $$update private.founding_beta_enrollment_events set reason = 'mutated'$$,
  'P0001',
  'Founding Beta evidence is append-only.',
  'enrollment evidence rejects updates'
);

select throws_ok(
  $$delete from private.founding_beta_notice_acceptances$$,
  'P0001',
  'Founding Beta evidence is append-only.',
  'notice acceptance evidence rejects deletes'
);

select * from finish();

rollback;
