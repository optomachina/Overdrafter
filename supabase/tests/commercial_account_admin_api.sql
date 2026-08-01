begin;

create extension if not exists pgtap with schema extensions;

select plan(75);

create temporary table ovd233_context (
  billing_admin_user_id uuid not null,
  organization_admin_user_id uuid not null,
  organization_member_user_id uuid not null,
  order_admin_user_id uuid not null,
  expired_billing_admin_user_id uuid not null,
  revoked_billing_admin_user_id uuid not null,
  primary_organization_id uuid not null,
  secondary_organization_id uuid not null,
  percent_organization_id uuid not null,
  underscore_organization_id uuid not null,
  backslash_organization_id uuid not null,
  cursor_a_organization_id uuid not null,
  cursor_b_organization_id uuid not null,
  cursor_c_organization_id uuid not null,
  primary_job_id uuid not null,
  secondary_job_id uuid not null,
  manual_active_request_id uuid not null,
  manual_failed_request_id uuid not null,
  automatic_received_request_id uuid not null
) on commit drop;

insert into ovd233_context (
  billing_admin_user_id,
  organization_admin_user_id,
  organization_member_user_id,
  order_admin_user_id,
  expired_billing_admin_user_id,
  revoked_billing_admin_user_id,
  primary_organization_id,
  secondary_organization_id,
  percent_organization_id,
  underscore_organization_id,
  backslash_organization_id,
  cursor_a_organization_id,
  cursor_b_organization_id,
  cursor_c_organization_id,
  primary_job_id,
  secondary_job_id,
  manual_active_request_id,
  manual_failed_request_id,
  automatic_received_request_id
)
values (
  '00000000-0000-4000-8000-000000002331',
  '00000000-0000-4000-8000-000000002332',
  '00000000-0000-4000-8000-000000002333',
  '00000000-0000-4000-8000-000000002334',
  '00000000-0000-4000-8000-000000002335',
  '00000000-0000-4000-8000-000000002336',
  '00000000-0000-4000-8000-000000002341',
  '00000000-0000-4000-8000-000000002342',
  '00000000-0000-4000-8000-000000002343',
  '00000000-0000-4000-8000-000000002344',
  '00000000-0000-4000-8000-000000002345',
  '00000000-0000-4000-8000-000000002346',
  '00000000-0000-4000-8000-000000002347',
  '00000000-0000-4000-8000-000000002348',
  '00000000-0000-4000-8000-000000002351',
  '00000000-0000-4000-8000-000000002352',
  '00000000-0000-4000-8000-000000002361',
  '00000000-0000-4000-8000-000000002362',
  '00000000-0000-4000-8000-000000002363'
);

grant select on ovd233_context to authenticated;

create function public.ovd233_test_set_claims(
  p_user_id uuid,
  p_aal text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  perform pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.jsonb_build_object(
      'sub', p_user_id,
      'role', 'authenticated', -- NOSONAR: repeated pgTAP auth fixture
      'aal', p_aal
    )::text,
    true
  );
  perform pg_catalog.set_config(
    'request.jwt.claim.sub',
    p_user_id::text,
    true
  );
end;
$$;

revoke all on function public.ovd233_test_set_claims(uuid, text)
  from public, anon;
grant execute on function public.ovd233_test_set_claims(uuid, text)
  to authenticated;

create function public.ovd233_test_perform_repeated_reads(
  p_organization_id uuid
)
returns void
language plpgsql
set search_path = pg_catalog
as $$
begin
  perform public.api_admin_search_commercial_accounts(
    'ovd233', -- NOSONAR: deterministic search fixture
    null,
    25
  );
  perform public.api_admin_get_commercial_account(p_organization_id);
  perform public.api_admin_list_commercial_account_audit(
    p_organization_id,
    null,
    25
  );
end;
$$;

revoke all on function
  public.ovd233_test_perform_repeated_reads(uuid)
  from public, anon;
grant execute on function
  public.ovd233_test_perform_repeated_reads(uuid)
  to authenticated;

insert into auth.users (
  id,
  aud,
  role,
  email
)
values
  (
    (select billing_admin_user_id from ovd233_context),
    'authenticated',
    'authenticated',
    'ovd233-billing@example.com'
  ),
  (
    (select organization_admin_user_id from ovd233_context),
    'authenticated',
    'authenticated',
    'primary-admin@ovd233.example'
  ),
  (
    (select organization_member_user_id from ovd233_context),
    'authenticated',
    'authenticated',
    'find-member@ovd233.example' -- NOSONAR: deterministic member fixture
  ),
  (
    (select order_admin_user_id from ovd233_context),
    'authenticated',
    'authenticated',
    'ovd233-order@example.com'
  ),
  (
    (select expired_billing_admin_user_id from ovd233_context),
    'authenticated',
    'authenticated',
    'ovd233-expired@example.com'
  ),
  (
    (select revoked_billing_admin_user_id from ovd233_context),
    'authenticated',
    'authenticated',
    'ovd233-revoked@example.com'
  );

insert into public.organizations (
  id,
  name,
  slug,
  created_at
)
values
  (
    (select primary_organization_id from ovd233_context),
    'OVD233 Acme Precision',
    'ovd233-acme-precision',
    '2026-07-01T10:00:00Z'
  ),
  (
    (select secondary_organization_id from ovd233_context),
    'OVD233 Secondary Fabrication',
    'ovd233-secondary-fabrication',
    '2026-07-01T11:00:00Z'
  ),
  (
    (select percent_organization_id from ovd233_context),
    'OVD233 Literal % Works',
    'ovd233-percent-works',
    '2026-07-01T12:00:00Z'
  ),
  (
    (select underscore_organization_id from ovd233_context),
    'OVD233 Literal _ Works',
    'ovd233-underscore-works',
    '2026-07-01T13:00:00Z'
  ),
  (
    (select backslash_organization_id from ovd233_context),
    E'OVD233 Literal \\ Works',
    'ovd233-backslash-works',
    '2026-07-01T14:00:00Z'
  ),
  (
    (select cursor_a_organization_id from ovd233_context),
    'OVD233 Cursor Alpha',
    'ovd233-cursor-alpha',
    '2026-07-01T15:00:00Z'
  ),
  (
    (select cursor_b_organization_id from ovd233_context),
    'OVD233 Cursor Bravo',
    'ovd233-cursor-bravo',
    '2026-07-01T16:00:00Z'
  ),
  (
    (select cursor_c_organization_id from ovd233_context),
    'OVD233 Cursor Charlie',
    'ovd233-cursor-charlie',
    '2026-07-01T17:00:00Z'
  );

insert into public.organization_memberships (
  organization_id,
  user_id,
  role,
  created_at
)
values
  (
    (select primary_organization_id from ovd233_context),
    (select organization_admin_user_id from ovd233_context),
    'internal_admin',
    '2026-07-02T10:00:00Z'
  ),
  (
    (select primary_organization_id from ovd233_context),
    (select organization_member_user_id from ovd233_context),
    'client', -- NOSONAR: deterministic membership fixture
    '2026-07-02T11:00:00Z'
  ),
  (
    (select cursor_a_organization_id from ovd233_context),
    (select organization_member_user_id from ovd233_context),
    'client',
    '2026-07-02T12:00:00Z'
  ),
  (
    (select cursor_b_organization_id from ovd233_context),
    (select organization_member_user_id from ovd233_context),
    'client',
    '2026-07-02T13:00:00Z'
  ),
  (
    (select cursor_c_organization_id from ovd233_context),
    (select organization_member_user_id from ovd233_context),
    'client',
    '2026-07-02T14:00:00Z'
  );

insert into private.platform_admin_capabilities (
  user_id,
  capability,
  granted_by_user_id,
  grant_reason,
  expires_at,
  revoked_at,
  revoked_by_user_id,
  revocation_reason,
  created_at
)
values
  (
    (select billing_admin_user_id from ovd233_context),
    'billing_admin', -- NOSONAR: explicit capability fixture
    (select billing_admin_user_id from ovd233_context),
    'OVD-233 commercial account read tests',
    null,
    null,
    null,
    null,
    '2026-07-01T00:00:00Z' -- NOSONAR: deterministic fixture timestamp
  ),
  (
    (select order_admin_user_id from ovd233_context),
    'order_admin',
    (select order_admin_user_id from ovd233_context),
    'OVD-233 capability isolation tests',
    null,
    null,
    null,
    null,
    '2026-07-01T00:00:00Z'
  ),
  (
    (select expired_billing_admin_user_id from ovd233_context),
    'billing_admin',
    (select billing_admin_user_id from ovd233_context),
    'OVD-233 expired capability tests',
    '2026-07-02T00:00:00Z',
    null,
    null,
    null,
    '2026-07-01T00:00:00Z'
  ),
  (
    (select revoked_billing_admin_user_id from ovd233_context),
    'billing_admin',
    (select billing_admin_user_id from ovd233_context),
    'OVD-233 revoked capability tests',
    null,
    '2026-07-02T00:00:00Z',
    (select billing_admin_user_id from ovd233_context),
    'Capability removed for authorization test',
    '2026-07-01T00:00:00Z'
  );

insert into private.organization_billing_accounts (
  organization_id,
  stripe_customer_id,
  created_at,
  updated_at
)
values
  (
    (select primary_organization_id from ovd233_context),
    'cus_OVD233Primary',
    '2026-07-03T00:00:00Z', -- NOSONAR: deterministic fixture timestamp
    '2026-07-03T00:00:00Z'
  ),
  (
    (select cursor_a_organization_id from ovd233_context),
    'cus_OVD233CursorA',
    '2026-07-03T00:00:00Z',
    '2026-07-03T00:00:00Z'
  )
on conflict (organization_id) do update
  set stripe_customer_id = excluded.stripe_customer_id,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at;

insert into private.organization_entitlement_grants (
  id,
  organization_id,
  entitlement_key,
  grant_type,
  starts_at,
  expires_at,
  review_at,
  grant_reason,
  granted_by_user_id,
  revoked_at,
  revoked_by_user_id,
  revocation_reason,
  created_at
)
values
  (
    '00000000-0000-4000-8000-000000002371', -- NOSONAR: deterministic grant fixture
    (select primary_organization_id from ovd233_context),
    'automatic_quote_collection',
    'trial',
    pg_catalog.now() - interval '1 day',
    pg_catalog.now() + interval '30 days',
    null,
    'Active OVD-233 support trial',
    (select billing_admin_user_id from ovd233_context),
    null,
    null,
    null,
    pg_catalog.now() - interval '1 day'
  ),
  (
    '00000000-0000-4000-8000-000000002372',
    (select primary_organization_id from ovd233_context),
    'automatic_quote_collection',
    'complimentary',
    '2026-06-01T00:00:00Z',
    null,
    '2026-12-01T00:00:00Z',
    'Revoked OVD-233 complimentary access',
    (select billing_admin_user_id from ovd233_context),
    '2026-07-01T00:00:00Z',
    (select billing_admin_user_id from ovd233_context),
    'Changed to a time-limited trial',
    '2026-06-01T00:00:00Z'
  );

insert into private.organization_subscription_projections (
  id,
  organization_id,
  stripe_subscription_id,
  status,
  billing_interval,
  current_period_end,
  past_due_since,
  cancel_at_period_end,
  stripe_event_created_at,
  created_at,
  updated_at
)
values
  (
    '00000000-0000-4000-8000-000000002373',
    (select primary_organization_id from ovd233_context),
    'sub_OVD233Active',
    'active',
    'month',
    pg_catalog.now() + interval '30 days',
    null,
    false,
    '2026-07-10T00:00:00Z', -- NOSONAR: deterministic fixture timestamp
    '2026-07-10T00:00:00Z',
    '2026-07-10T00:00:00Z'
  ),
  (
    '00000000-0000-4000-8000-000000002374',
    (select primary_organization_id from ovd233_context),
    'sub_OVD233Canceled',
    'canceled',
    'year',
    '2026-07-01T00:00:00Z',
    null,
    true,
    '2026-07-11T00:00:00Z', -- NOSONAR: deterministic fixture timestamp
    '2026-07-11T00:00:00Z',
    '2026-07-11T00:00:00Z'
  ),
  (
    '00000000-0000-4000-8000-000000002375',
    (select cursor_a_organization_id from ovd233_context),
    'sub_OVD233CursorActive',
    'active',
    'year',
    pg_catalog.now() + interval '1 year',
    null,
    false,
    '2026-07-12T00:00:00Z', -- NOSONAR: deterministic fixture timestamp
    '2026-07-12T00:00:00Z',
    '2026-07-12T00:00:00Z'
  );

insert into public.jobs (
  id,
  organization_id,
  created_by,
  title,
  status,
  created_at,
  updated_at
)
values
  (
    (select primary_job_id from ovd233_context),
    (select primary_organization_id from ovd233_context),
    (select organization_member_user_id from ovd233_context),
    'OVD233 Primary Fixture Job',
    'awaiting_vendor_manual_review',
    '2026-07-15T00:00:00Z',
    '2026-07-15T00:00:00Z'
  ),
  (
    (select secondary_job_id from ovd233_context),
    (select secondary_organization_id from ovd233_context),
    (select organization_member_user_id from ovd233_context),
    'OVD233 Secondary Fixture Job',
    'ready_to_quote',
    '2026-07-15T01:00:00Z',
    '2026-07-15T01:00:00Z'
  );

insert into public.quote_requests (
  id,
  organization_id,
  job_id,
  requested_by,
  requested_vendors,
  request_mode,
  status,
  failure_reason,
  received_at,
  failed_at,
  created_at,
  updated_at
)
values
  (
    (select manual_active_request_id from ovd233_context),
    (select primary_organization_id from ovd233_context),
    (select primary_job_id from ovd233_context),
    (select organization_member_user_id from ovd233_context),
    '{}'::public.vendor_name[],
    'manual',
    'queued',
    null,
    null,
    null,
    '2026-07-20T10:00:00Z',
    '2026-07-20T10:00:00Z'
  ),
  (
    (select manual_failed_request_id from ovd233_context),
    (select primary_organization_id from ovd233_context),
    (select primary_job_id from ovd233_context),
    (select organization_member_user_id from ovd233_context),
    '{}'::public.vendor_name[],
    'manual',
    'failed',
    'Fixture failure',
    null,
    '2026-07-20T11:00:00Z', -- NOSONAR: deterministic fixture timestamp
    '2026-07-20T11:00:00Z',
    '2026-07-20T11:00:00Z'
  ),
  (
    (select automatic_received_request_id from ovd233_context),
    (select primary_organization_id from ovd233_context),
    (select primary_job_id from ovd233_context),
    (select organization_member_user_id from ovd233_context),
    '{xometry}'::public.vendor_name[],
    'automatic',
    'received',
    null,
    '2026-07-20T12:00:00Z', -- NOSONAR: deterministic fixture timestamp
    null,
    '2026-07-20T12:00:00Z',
    '2026-07-20T12:00:00Z'
  );

insert into public.commercial_admin_audit_events (
  id,
  organization_id,
  actor_user_id,
  required_capability,
  action,
  target_type,
  target_id,
  reason,
  before_state,
  after_state,
  request_metadata,
  idempotency_scope,
  idempotency_key,
  created_at
)
values
  (
    '00000000-0000-4000-8000-000000002381',
    (select primary_organization_id from ovd233_context),
    (select billing_admin_user_id from ovd233_context),
    'billing_admin',
    'commercial.entitlement.grant',
    'organization_entitlement_grant', -- NOSONAR: stable audit fixture
    '00000000-0000-4000-8000-000000002371',
    'Grant support trial',
    null,
    '{"grantType":"trial"}'::jsonb,
    '{"source":"ovd233-test"}'::jsonb,
    'ovd233-primary-grant',
    'ovd233-primary-grant',
    '2026-07-21T10:00:00Z'
  ),
  (
    '00000000-0000-4000-8000-000000002382',
    (select primary_organization_id from ovd233_context),
    (select billing_admin_user_id from ovd233_context),
    'billing_admin',
    'commercial.entitlement.review',
    'organization_entitlement_grant',
    '00000000-0000-4000-8000-000000002371',
    'Review support trial',
    '{"reviewed":false}'::jsonb,
    '{"reviewed":true}'::jsonb,
    '{}'::jsonb,
    'ovd233-primary-review',
    'ovd233-primary-review',
    '2026-07-21T11:00:00Z'
  ),
  (
    '00000000-0000-4000-8000-000000002383',
    (select primary_organization_id from ovd233_context),
    (select order_admin_user_id from ovd233_context),
    'order_admin',
    'commercial.order.transition',
    'order',
    'ovd233-order-fixture',
    'Move order into review',
    '{"status":"draft"}'::jsonb,
    '{"status":"review"}'::jsonb,
    '{}'::jsonb,
    'ovd233-primary-order',
    'ovd233-primary-order',
    '2026-07-21T12:00:00Z'
  ),
  (
    '00000000-0000-4000-8000-000000002384',
    (select secondary_organization_id from ovd233_context),
    (select billing_admin_user_id from ovd233_context),
    'billing_admin',
    'commercial.entitlement.grant',
    'organization_entitlement_grant',
    'secondary-grant',
    'Grant secondary support trial',
    null,
    '{"grantType":"trial"}'::jsonb,
    '{}'::jsonb,
    'ovd233-secondary-grant',
    'ovd233-secondary-grant',
    '2026-07-21T13:00:00Z'
  );

select ok(
  pg_catalog.to_regprocedure(
    'public.api_admin_search_commercial_accounts(text,text,integer)' -- NOSONAR: asserted RPC signature
  ) is not null,
  'commercial account search RPC exists'
);

select ok(
  pg_catalog.to_regprocedure(
    'public.api_admin_get_commercial_account(uuid)' -- NOSONAR: asserted RPC signature
  ) is not null,
  'commercial account detail RPC exists'
);

select ok(
  pg_catalog.to_regprocedure(
    'public.api_admin_list_commercial_account_audit(uuid,text,integer)' -- NOSONAR: asserted RPC signature
  ) is not null,
  'commercial account audit RPC exists'
);

select ok(
  pg_catalog.has_function_privilege(
    'authenticated',
    'public.api_admin_search_commercial_accounts(text,text,integer)',
    'EXECUTE' -- NOSONAR: asserted function privilege
  ),
  'authenticated callers may invoke the guarded search RPC'
);

select ok(
  pg_catalog.has_function_privilege(
    'authenticated',
    'public.api_admin_get_commercial_account(uuid)',
    'EXECUTE'
  ),
  'authenticated callers may invoke the guarded detail RPC'
);

select ok(
  pg_catalog.has_function_privilege(
    'authenticated',
    'public.api_admin_list_commercial_account_audit(uuid,text,integer)',
    'EXECUTE'
  ),
  'authenticated callers may invoke the guarded audit RPC'
);

select ok(
  not pg_catalog.has_function_privilege(
    'anon',
    'public.api_admin_search_commercial_accounts(text,text,integer)',
    'EXECUTE'
  ),
  'anonymous callers cannot invoke commercial account search'
);

select ok(
  not pg_catalog.has_function_privilege(
    'anon',
    'public.api_admin_get_commercial_account(uuid)',
    'EXECUTE'
  ),
  'anonymous callers cannot invoke commercial account detail'
);

select ok(
  not pg_catalog.has_function_privilege(
    'anon',
    'public.api_admin_list_commercial_account_audit(uuid,text,integer)',
    'EXECUTE'
  ),
  'anonymous callers cannot invoke commercial account audit'
);

set local role authenticated;
select public.ovd233_test_set_claims(
  (select organization_admin_user_id from ovd233_context),
  'aal2'
);

select throws_ok(
  $$
    select public.api_admin_search_commercial_accounts('ovd233', null, 25)
  $$,
  'P0001', -- NOSONAR: asserted PostgreSQL exception code
  'You do not have the required commercial capability.', -- NOSONAR: asserted authorization error
  'organization admins cannot search commercial accounts'
);

select throws_ok(
  $$
    select public.api_admin_get_commercial_account(
      (select primary_organization_id from ovd233_context)
    )
  $$,
  'P0001',
  'You do not have the required commercial capability.',
  'organization admins cannot read commercial account detail'
);

select throws_ok(
  $$
    select public.api_admin_list_commercial_account_audit(
      (select primary_organization_id from ovd233_context),
      null,
      25
    )
  $$,
  'P0001',
  'You do not have the required commercial capability.',
  'organization admins cannot read commercial account audit'
);

select public.ovd233_test_set_claims(
  (select order_admin_user_id from ovd233_context),
  'aal2'
);

select throws_ok(
  $$
    select public.api_admin_search_commercial_accounts('ovd233', null, 25)
  $$,
  'P0001',
  'You do not have the required commercial capability.',
  'order admins cannot search commercial accounts'
);

select throws_ok(
  $$
    select public.api_admin_get_commercial_account(
      (select primary_organization_id from ovd233_context)
    )
  $$,
  'P0001',
  'You do not have the required commercial capability.',
  'order admins cannot read commercial account detail'
);

select throws_ok(
  $$
    select public.api_admin_list_commercial_account_audit(
      (select primary_organization_id from ovd233_context),
      null,
      25
    )
  $$,
  'P0001',
  'You do not have the required commercial capability.',
  'order admins cannot read commercial account audit'
);

select public.ovd233_test_set_claims(
  (select expired_billing_admin_user_id from ovd233_context),
  'aal1'
);

select throws_ok(
  $$
    select public.api_admin_search_commercial_accounts('ovd233', null, 25)
  $$,
  'P0001',
  'You do not have the required commercial capability.',
  'expired billing admins cannot search commercial accounts'
);

select throws_ok(
  $$
    select public.api_admin_get_commercial_account(
      (select primary_organization_id from ovd233_context)
    )
  $$,
  'P0001',
  'You do not have the required commercial capability.',
  'expired billing admins cannot read commercial account detail'
);

select throws_ok(
  $$
    select public.api_admin_list_commercial_account_audit(
      (select primary_organization_id from ovd233_context),
      null,
      25
    )
  $$,
  'P0001',
  'You do not have the required commercial capability.',
  'expired billing admins cannot read commercial account audit'
);

select public.ovd233_test_set_claims(
  (select revoked_billing_admin_user_id from ovd233_context),
  'aal1'
);

select throws_ok(
  $$
    select public.api_admin_search_commercial_accounts('ovd233', null, 25)
  $$,
  'P0001',
  'You do not have the required commercial capability.',
  'revoked billing admins cannot search commercial accounts'
);

select throws_ok(
  $$
    select public.api_admin_get_commercial_account(
      (select primary_organization_id from ovd233_context)
    )
  $$,
  'P0001',
  'You do not have the required commercial capability.',
  'revoked billing admins cannot read commercial account detail'
);

select throws_ok(
  $$
    select public.api_admin_list_commercial_account_audit(
      (select primary_organization_id from ovd233_context),
      null,
      25
    )
  $$,
  'P0001',
  'You do not have the required commercial capability.',
  'revoked billing admins cannot read commercial account audit'
);

select public.ovd233_test_set_claims(
  (select billing_admin_user_id from ovd233_context),
  'aal1'
);

select lives_ok(
  $$
    select public.api_admin_search_commercial_accounts('ovd233', null, 25)
  $$,
  'billing admins may search commercial accounts at AAL1'
);

select lives_ok(
  format(
    'select public.api_admin_get_commercial_account(%L)',
    (select primary_organization_id from ovd233_context)
  ),
  'billing admins may read commercial account detail at AAL1'
);

select lives_ok(
  format(
    'select public.api_admin_get_organization_entitlement_state(%L)',
    (select primary_organization_id from ovd233_context)
  ),
  'billing admins may read the existing entitlement-state projection at AAL1'
);

select lives_ok(
  format(
    'select public.api_admin_list_commercial_account_audit(%L,null,25)',
    (select primary_organization_id from ovd233_context)
  ),
  'billing admins may read commercial account audit at AAL1'
);

select is(
  public.api_admin_search_commercial_accounts(
    'acme precision',
    null,
    25
  ) #>> '{items,0,organizationId}', -- NOSONAR: stable JSON contract path
  (select primary_organization_id::text from ovd233_context),
  'search matches organization names case-insensitively'
);

select is(
  public.api_admin_search_commercial_accounts(
    'ACME-PRECISION',
    null,
    25
  ) #>> '{items,0,organizationId}',
  (select primary_organization_id::text from ovd233_context),
  'search matches organization slugs case-insensitively'
);

select is(
  public.api_admin_search_commercial_accounts(
    'FIND-MEMBER@OVD233.EXAMPLE',
    null,
    25
  ) #>> '{items,0,organizationId}',
  (select primary_organization_id::text from ovd233_context),
  'search matches member email case-insensitively'
);

select is(
  pg_catalog.jsonb_array_length(
    public.api_admin_search_commercial_accounts('%', null, 25) -> 'items' -- NOSONAR: literal wildcard fixture
  ),
  1,
  'percent signs are literal commercial account search input'
);

select is(
  public.api_admin_search_commercial_accounts('%', null, 25)
    #>> '{items,0,organizationId}',
  (select percent_organization_id::text from ovd233_context),
  'literal percent search returns only the matching organization'
);

select is(
  public.api_admin_search_commercial_accounts('%', null, 25)
    #>> '{items,0,effective,reviewDue}',
  'false',
  'free commercial account projections always include reviewDue'
);

select is(
  pg_catalog.jsonb_array_length(
    public.api_admin_search_commercial_accounts('_', null, 25) -> 'items'
  ),
  1,
  'underscores are literal commercial account search input'
);

select is(
  public.api_admin_search_commercial_accounts('_', null, 25)
    #>> '{items,0,organizationId}',
  (select underscore_organization_id::text from ovd233_context),
  'literal underscore search returns only the matching organization'
);

select is(
  pg_catalog.jsonb_array_length(
    public.api_admin_search_commercial_accounts(E'\\', null, 25) -> 'items'
  ),
  1,
  'backslashes are literal commercial account search input'
);

select is(
  public.api_admin_search_commercial_accounts(E'\\', null, 25)
    #>> '{items,0,organizationId}',
  (select backslash_organization_id::text from ovd233_context),
  'literal backslash search returns only the matching organization'
);

select is(
  pg_catalog.jsonb_array_length(
    public.api_admin_search_commercial_accounts(
      'ovd233-cursor', -- NOSONAR: deterministic cursor fixture
      null,
      2
    ) -> 'items'
  ),
  2,
  'commercial account search applies bounded page size'
);

select ok(
  nullif(
    public.api_admin_search_commercial_accounts(
      'ovd233-cursor',
      null,
      2
    ) ->> 'nextCursor', -- NOSONAR: stable JSON contract key
    ''
  ) is not null,
  'a full commercial account page returns an opaque cursor'
);

select is(
  public.api_admin_search_commercial_accounts(
    'ovd233-cursor',
    null,
    2
  ),
  public.api_admin_search_commercial_accounts(
    'ovd233-cursor',
    null,
    2
  ),
  'commercial account page ordering and cursor encoding are deterministic'
);

select is(
  pg_catalog.jsonb_array_length(
    public.api_admin_search_commercial_accounts(
      'ovd233-cursor',
      public.api_admin_search_commercial_accounts(
        'ovd233-cursor',
        null,
        2
      ) ->> 'nextCursor',
      2
    ) -> 'items'
  ),
  1,
  'commercial account cursor advances without duplicating the first page'
);

select lives_ok(
  $$
    select public.api_admin_search_commercial_accounts(
      '  OVD233-CURSOR  ',
      public.api_admin_search_commercial_accounts(
        'ovd233-cursor',
        null,
        2
      ) ->> 'nextCursor',
      2
    )
  $$,
  'search cursors accept the same normalized search'
);

select ok(
  pg_catalog.strpos(
    pg_catalog.convert_from(
      pg_catalog.decode(
        public.api_admin_search_commercial_accounts(
          'find-member@ovd233.example',
          null,
          1
        ) ->> 'nextCursor',
        'base64'
      ),
      'UTF8'
    ),
    'find-member@ovd233.example'
  ) = 0,
  'opaque search cursors do not disclose searched member emails'
);

select throws_ok(
  $$
    select public.api_admin_search_commercial_accounts(
      'different-search',
      public.api_admin_search_commercial_accounts(
        'ovd233-cursor',
        null,
        2
      ) ->> 'nextCursor',
      2
    )
  $$,
  'P0001',
  'Commercial account cursor is invalid.',
  'search cursors cannot be replayed against a different search'
);

select throws_ok(
  $$
    select public.api_admin_search_commercial_accounts(
      'ovd233',
      'not-base64',
      25
    )
  $$,
  'P0001',
  'Commercial account cursor is invalid.',
  'malformed commercial account search cursors fail closed'
);

select throws_ok(
  $$
    select public.api_admin_search_commercial_accounts(
      repeat('x', 321),
      null,
      25
    )
  $$,
  'P0001',
  'Commercial account search is too long.',
  'oversized commercial account searches fail closed'
);

select throws_ok(
  $$
    select public.api_admin_search_commercial_accounts('ovd233', null, 101)
  $$,
  'P0001',
  'Commercial account page size must be between 1 and 100.',
  'oversized commercial account pages fail closed'
);

select is(
  public.api_admin_get_commercial_account(
    (select primary_organization_id from ovd233_context)
  ) #>> '{organization,id}',
  (select primary_organization_id::text from ovd233_context),
  'commercial account detail returns the exact organization'
);

select is(
  public.api_admin_get_commercial_account(
    (select primary_organization_id from ovd233_context)
  ) #>> '{organization,name}',
  'OVD233 Acme Precision',
  'commercial account detail exposes organization identity'
);

select is(
  pg_catalog.jsonb_array_length(
    public.api_admin_get_commercial_account(
      (select primary_organization_id from ovd233_context)
    ) -> 'members'
  ),
  2,
  'commercial account detail includes exact-organization members'
);

select ok(
  public.api_admin_get_commercial_account(
    (select primary_organization_id from ovd233_context)
  ) -> 'members' @> '[{"email":"find-member@ovd233.example","role":"client"}]'::jsonb,
  'commercial account members include server-owned email and role'
);

select is(
  public.api_admin_get_commercial_account(
    (select primary_organization_id from ovd233_context)
  ) #>> '{billingAccount,stripeCustomerId}',
  'cus_OVD233Primary',
  'commercial account detail includes the server-owned billing account'
);

select is(
  public.api_admin_get_commercial_account(
    (select primary_organization_id from ovd233_context)
  ) #>> '{effective,plan}',
  'pro',
  'commercial account detail includes the effective Pro plan'
);

select is(
  public.api_admin_get_commercial_account(
    (select primary_organization_id from ovd233_context)
  ) #>> '{effective,source}',
  'manual_trial',
  'commercial account effective access truthfully identifies a manual trial'
);

select is(
  pg_catalog.jsonb_array_length(
    public.api_admin_get_commercial_account(
      (select primary_organization_id from ovd233_context)
    ) -> 'grants'
  ),
  2,
  'commercial account detail includes active and historical grants'
);

select ok(
  public.api_admin_get_commercial_account(
    (select primary_organization_id from ovd233_context)
  ) -> 'grants'
    @> '[{"entitlementKey":"automatic_quote_collection"}]'::jsonb,
  'commercial account grants include their entitlement key'
);

select is(
  pg_catalog.jsonb_array_length(
    public.api_admin_get_commercial_account(
      (select primary_organization_id from ovd233_context)
    ) -> 'subscriptions'
  ),
  2,
  'commercial account detail includes active and historical subscriptions'
);

select is(
  public.api_admin_get_commercial_account(
    (select cursor_a_organization_id from ovd233_context)
  ) #>> '{effective,reviewDue}',
  'false',
  'subscription commercial account projections always include reviewDue'
);

select is(
  (
    public.api_admin_get_commercial_account(
      (select primary_organization_id from ovd233_context)
    ) #>> '{quoteActivity,manualRequestCount}'
  )::integer,
  2,
  'commercial account detail counts manual quote requests'
);

select is(
  (
    public.api_admin_get_commercial_account(
      (select primary_organization_id from ovd233_context)
    ) #>> '{quoteActivity,automaticRequestCount}'
  )::integer,
  1,
  'commercial account detail counts automatic quote requests'
);

select is(
  (
    public.api_admin_get_commercial_account(
      (select primary_organization_id from ovd233_context)
    ) #>> '{quoteActivity,activeManualRequestCount}'
  )::integer,
  1,
  'commercial account detail counts active manual requests'
);

select is(
  (
    public.api_admin_get_commercial_account(
      (select primary_organization_id from ovd233_context)
    ) #>> '{quoteActivity,receivedRequestCount}'
  )::integer,
  1,
  'commercial account detail counts received requests'
);

select is(
  (
    public.api_admin_get_commercial_account(
      (select primary_organization_id from ovd233_context)
    ) #>> '{quoteActivity,failedRequestCount}'
  )::integer,
  1,
  'commercial account detail counts failed requests'
);

select is(
  public.api_admin_get_commercial_account(
    (select primary_organization_id from ovd233_context)
  ) #>> '{quoteActivity,recentRequests,0,requestId}',
  (select automatic_received_request_id::text from ovd233_context),
  'recent quote activity is deterministic and newest-first'
);

select throws_ok(
  $$
    select public.api_admin_get_commercial_account(
      '00000000-0000-4000-8000-000000002399'
    )
  $$,
  'P0001',
  'Organization was not found.',
  'commercial account detail fails closed for a missing organization'
);

select is(
  pg_catalog.jsonb_array_length(
    public.api_admin_list_commercial_account_audit(
      (select primary_organization_id from ovd233_context),
      null,
      25
    ) -> 'items'
  ),
  2,
  'commercial account audit returns only billing-lane events'
);

select is(
  public.api_admin_list_commercial_account_audit(
    (select primary_organization_id from ovd233_context),
    null,
    25
  ) #>> '{items,0,eventId}',
  '00000000-0000-4000-8000-000000002382',
  'commercial account audit is deterministic and newest-first'
);

select ok(
  public.api_admin_list_commercial_account_audit(
    (select primary_organization_id from ovd233_context),
    null,
    25
  ) -> 'items'
    @> '[{"actorEmail":"ovd233-billing@example.com","idempotencyKey":"ovd233-primary-review"}]'::jsonb,
  'commercial account audit includes actor identity and idempotency metadata'
);

select is(
  pg_catalog.jsonb_array_length(
    public.api_admin_list_commercial_account_audit(
      (select primary_organization_id from ovd233_context),
      null,
      1
    ) -> 'items'
  ),
  1,
  'commercial account audit applies bounded page size'
);

select ok(
  nullif(
    public.api_admin_list_commercial_account_audit(
      (select primary_organization_id from ovd233_context),
      null,
      1
    ) ->> 'nextCursor',
    ''
  ) is not null,
  'a full commercial account audit page returns an opaque cursor'
);

select is(
  public.api_admin_list_commercial_account_audit(
    (select primary_organization_id from ovd233_context),
    public.api_admin_list_commercial_account_audit(
      (select primary_organization_id from ovd233_context),
      null,
      1
    ) ->> 'nextCursor',
    1
  ) #>> '{items,0,eventId}',
  '00000000-0000-4000-8000-000000002381',
  'commercial account audit cursor advances without duplication'
);

select throws_ok(
  $$
    select public.api_admin_list_commercial_account_audit(
      (select secondary_organization_id from ovd233_context),
      public.api_admin_list_commercial_account_audit(
        (select primary_organization_id from ovd233_context),
        null,
        1
      ) ->> 'nextCursor',
      1
    )
  $$,
  'P0001',
  'Commercial account audit cursor is invalid.',
  'commercial account audit cursors are bound to one organization'
);

select throws_ok(
  $$
    select public.api_admin_list_commercial_account_audit(
      (select primary_organization_id from ovd233_context),
      'not-base64',
      25
    )
  $$,
  'P0001',
  'Commercial account audit cursor is invalid.',
  'malformed commercial account audit cursors fail closed'
);

create temporary table ovd233_audit_count_before_reads (
  event_count bigint not null
) on commit drop;

insert into ovd233_audit_count_before_reads (event_count)
select pg_catalog.count(*)
from public.commercial_admin_audit_events;

select public.ovd233_test_perform_repeated_reads(
  (select primary_organization_id from ovd233_context)
);
select public.ovd233_test_perform_repeated_reads(
  (select primary_organization_id from ovd233_context)
);

select is(
  (
    select pg_catalog.count(*)
    from public.commercial_admin_audit_events
  ),
  (
    select event_count
    from ovd233_audit_count_before_reads
  ),
  'repeated commercial account reads do not append audit mutations'
);

reset role;

set local role authenticated;
select public.ovd233_test_set_claims(
  (select billing_admin_user_id from ovd233_context),
  'aal2'
);

select lives_ok(
  $$
    select public.api_admin_search_commercial_accounts('ovd233', null, 25)
  $$,
  'billing admins may search commercial accounts at AAL2'
);

select lives_ok(
  format(
    'select public.api_admin_get_commercial_account(%L)',
    (select primary_organization_id from ovd233_context)
  ),
  'billing admins may read commercial account detail at AAL2'
);

select lives_ok(
  format(
    'select public.api_admin_list_commercial_account_audit(%L,null,25)',
    (select primary_organization_id from ovd233_context)
  ),
  'billing admins may read commercial account audit at AAL2'
);

reset role;

drop function public.ovd233_test_set_claims(uuid, text);
drop function public.ovd233_test_perform_repeated_reads(uuid);

select * from finish();

rollback;
