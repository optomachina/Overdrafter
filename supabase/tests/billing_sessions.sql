begin;

select plan(21);

create function pg_temp.set_ovd228_request_identity(p_user_id uuid)
returns void
language plpgsql
set search_path = pg_catalog
as $$
begin
  perform pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.jsonb_build_object(
      'sub', p_user_id,
      'role', 'authenticated'
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

create temporary table ovd228_test_context (
  owner_user_id uuid not null,
  member_user_id uuid not null,
  internal_admin_user_id uuid not null,
  primary_organization_id uuid not null,
  second_organization_id uuid not null
) on commit drop;

insert into ovd228_test_context values (
  '00000000-0000-4000-8000-000000002281',
  '00000000-0000-4000-8000-000000002282',
  '00000000-0000-4000-8000-000000002283',
  '00000000-0000-4000-8000-000000002284',
  '00000000-0000-4000-8000-000000002285'
);

grant select on ovd228_test_context to authenticated, service_role;

insert into auth.users (id, aud, role, email)
values
  (
    (select owner_user_id from ovd228_test_context),
    'authenticated',
    'authenticated',
    'ovd228-owner@example.com'
  ),
  (
    (select member_user_id from ovd228_test_context),
    'authenticated',
    'authenticated',
    'ovd228-member@example.com'
  ),
  (
    (select internal_admin_user_id from ovd228_test_context),
    'authenticated',
    'authenticated',
    'ovd228-internal-admin@example.com'
  );

insert into public.organizations (id, name, slug)
values
  (
    (select primary_organization_id from ovd228_test_context),
    'OVD 228 Primary',
    'ovd-228-primary'
  ),
  (
    (select second_organization_id from ovd228_test_context),
    'OVD 228 Second',
    'ovd-228-second'
  );

insert into public.organization_memberships (
  id,
  organization_id,
  user_id,
  role,
  created_at
)
values
  (
    '00000000-0000-4000-8000-000000002286',
    (select primary_organization_id from ovd228_test_context),
    (select owner_user_id from ovd228_test_context),
    'client',
    '2026-07-30T00:00:00Z'
  ),
  (
    '00000000-0000-4000-8000-000000002287',
    (select primary_organization_id from ovd228_test_context),
    (select member_user_id from ovd228_test_context),
    'client',
    '2026-07-30T00:01:00Z'
  ),
  (
    '00000000-0000-4000-8000-000000002288',
    (select primary_organization_id from ovd228_test_context),
    (select internal_admin_user_id from ovd228_test_context),
    'internal_admin',
    '2026-07-30T00:02:00Z'
  );

select ok(
  has_function_privilege(
    'authenticated',
    'public.api_prepare_organization_billing_session(uuid)',
    'EXECUTE'
  ),
  'authenticated users can reach the guarded preparation boundary'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.api_bind_organization_stripe_customer(uuid,text,boolean)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.api_record_billing_checkout_started(uuid,uuid,text)',
    'EXECUTE'
  ),
  'authenticated clients cannot bind Stripe IDs or forge billing funnel events'
);

set local role authenticated;
select pg_temp.set_ovd228_request_identity(
  (select owner_user_id from ovd228_test_context)
);

select is(
  public.api_get_organization_entitlements(
    (select primary_organization_id from ovd228_test_context)
  ) ->> 'canManageBilling',
  'true',
  'the self-service organization owner can manage billing'
);

select is(
  public.api_get_organization_entitlements(
    (select primary_organization_id from ovd228_test_context)
  ) ->> 'hasStripeSubscription',
  'false',
  'a new organization does not advertise a Stripe-backed subscription'
);

select is(
  public.api_prepare_organization_billing_session(
    (select primary_organization_id from ovd228_test_context)
  ) ->> 'organizationName',
  'OVD 228 Primary',
  'the billing owner can prepare its organization billing account'
);

reset role;

select ok(
  (
    select count(*) = 1
    from private.organization_billing_accounts account_row
    where account_row.organization_id =
      (select primary_organization_id from ovd228_test_context)
      and account_row.stripe_customer_id is null
  ),
  'preparation creates an empty server-owned billing account'
);

set local role authenticated;
select pg_temp.set_ovd228_request_identity(
  (select member_user_id from ovd228_test_context)
);

select is(
  public.api_get_organization_entitlements(
    (select primary_organization_id from ovd228_test_context)
  ) ->> 'canManageBilling',
  'false',
  'an ordinary later member cannot manage organization billing'
);

select throws_ok(
  $$
    select public.api_prepare_organization_billing_session(
      '00000000-0000-4000-8000-000000002284'
    )
  $$,
  'P0001',
  'Only the organization billing owner can manage this subscription.',
  'a non-owner member cannot prepare billing'
);

select throws_ok(
  $$
    select public.api_prepare_organization_billing_session(
      '00000000-0000-4000-8000-000000002285'
    )
  $$,
  'P0001',
  'Only the organization billing owner can manage this subscription.',
  'cross-organization billing preparation is denied'
);

select pg_temp.set_ovd228_request_identity(
  (select internal_admin_user_id from ovd228_test_context)
);

select is(
  public.api_get_organization_entitlements(
    (select primary_organization_id from ovd228_test_context)
  ) ->> 'canManageBilling',
  'true',
  'an internal organization administrator retains billing-owner access'
);

reset role;
set local role service_role;

select public.api_configure_stripe_pro_price(
  'price_OVD228Old',
  false
);
select public.api_configure_stripe_pro_price(
  'price_OVD228Pro',
  false
);

reset role;

select is(
  (
    select pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'priceId', price_row.stripe_price_id,
        'livemode', price_row.livemode
      )
      order by price_row.stripe_price_id
    )
    from private.stripe_pro_price_allowlist price_row
  ),
  '[{"priceId": "price_OVD228Pro", "livemode": false}]'::jsonb,
  'the launch catalog retains exactly one configured Pro price'
);

set local role service_role;

select is(
  public.api_bind_organization_stripe_customer(
    (select primary_organization_id from ovd228_test_context),
    'cus_OVD228Primary',
    false
  ) ->> 'stripeCustomerId',
  'cus_OVD228Primary',
  'the service boundary binds the Stripe customer once'
);

select is(
  public.api_bind_organization_stripe_customer(
    (select primary_organization_id from ovd228_test_context),
    'cus_OVD228Primary',
    false
  ) ->> 'stripeCustomerId',
  'cus_OVD228Primary',
  'replaying the same customer binding is idempotent'
);

select throws_ok(
  $$
    select public.api_bind_organization_stripe_customer(
      '00000000-0000-4000-8000-000000002284',
      'cus_OVD228Different',
      false
    )
  $$,
  'P0001',
  'Organization is already bound to a different Stripe customer or mode.',
  'an organization cannot be rebound to a different Stripe customer'
);

select is(
  public.api_record_billing_checkout_started(
    (select primary_organization_id from ovd228_test_context),
    (select owner_user_id from ovd228_test_context),
    'cs_test_OVD228'
  ) is not null,
  true,
  'the service records an authenticated upgrade-start event'
);

select public.api_record_billing_checkout_started(
  (select primary_organization_id from ovd228_test_context),
  (select owner_user_id from ovd228_test_context),
  'cs_test_OVD228'
);

select is(
  (
    select count(*)
    from public.audit_events audit_event
    where audit_event.organization_id =
      (select primary_organization_id from ovd228_test_context)
      and audit_event.event_type = 'billing.upgrade_started'
      and audit_event.payload ->> 'stripeCheckoutSessionId' =
        'cs_test_OVD228'
  ),
  1::bigint,
  'replaying a Checkout session records one upgrade-start funnel event'
);

reset role;

insert into private.organization_subscription_projections (
  organization_id,
  stripe_subscription_id,
  status,
  billing_interval,
  current_period_end,
  cancel_at_period_end,
  stripe_event_created_at,
  stripe_event_id,
  stripe_livemode,
  stripe_price_id
)
values (
  (select primary_organization_id from ovd228_test_context),
  'sub_OVD228Primary',
  'active',
  'month',
  '2026-09-01T00:00:00Z',
  false,
  '2026-08-01T00:00:00Z',
  'evt_OVD228Activation',
  false,
  'price_OVD228Pro'
);

select is(
  (
    select count(*)
    from public.audit_events audit_event
    where audit_event.organization_id =
      (select primary_organization_id from ovd228_test_context)
      and audit_event.event_type = 'billing.subscription_activated'
      and audit_event.payload ->> 'stripeEventId' = 'evt_OVD228Activation'
  ),
  1::bigint,
  'webhook-synchronized activation emits the server-side funnel event once'
);

set local role authenticated;
select pg_temp.set_ovd228_request_identity(
  (select internal_admin_user_id from ovd228_test_context)
);

select is(
  public.api_get_organization_entitlements(
    (select primary_organization_id from ovd228_test_context)
  ) ->> 'hasStripeSubscription',
  'true',
  'the entitlement contract exposes a synchronized Stripe subscription'
);

select throws_ok(
  $$
    insert into public.audit_events (
      organization_id,
      actor_user_id,
      event_type,
      payload
    )
    values (
      '00000000-0000-4000-8000-000000002284',
      '00000000-0000-4000-8000-000000002283',
      'billing.upgrade_started',
      '{}'::jsonb
    )
  $$,
  '42501',
  'Billing audit events may only be appended by the billing service.',
  'internal users cannot forge billing funnel history'
);

select throws_ok(
  $$
    update public.audit_events
    set payload = '{}'::jsonb
    where event_type = 'billing.upgrade_started'
  $$,
  '42501',
  'Billing audit events are append-only.',
  'internal users cannot rewrite billing funnel history'
);

select throws_ok(
  $$
    delete from public.audit_events
    where event_type = 'billing.subscription_activated'
  $$,
  '42501',
  'Billing audit events are append-only.',
  'internal users cannot delete billing activation history'
);

select * from finish();

rollback;
