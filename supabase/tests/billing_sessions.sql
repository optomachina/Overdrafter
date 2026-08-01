begin;

select plan(32);

create function pg_temp.set_ovd292_request_identity(
  p_user_id uuid,
  p_role text default 'authenticated'
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
      'role', p_role
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

create temporary table ovd292_test_context (
  owner_user_id uuid not null,
  member_user_id uuid not null,
  internal_admin_user_id uuid not null,
  primary_organization_id uuid not null,
  second_organization_id uuid not null
) on commit drop;

insert into ovd292_test_context values (
  '00000000-0000-4000-8000-000000002921',
  '00000000-0000-4000-8000-000000002922',
  '00000000-0000-4000-8000-000000002923',
  '00000000-0000-4000-8000-000000002924',
  '00000000-0000-4000-8000-000000002925'
);

grant select on ovd292_test_context to authenticated, service_role;

insert into auth.users (id, aud, role, email)
values
  (
    (select owner_user_id from ovd292_test_context),
    'authenticated',
    'authenticated',
    'ovd292-owner@example.com'
  ),
  (
    (select member_user_id from ovd292_test_context),
    'authenticated',
    'authenticated',
    'ovd292-member@example.com'
  ),
  (
    (select internal_admin_user_id from ovd292_test_context),
    'authenticated',
    'authenticated',
    'ovd292-internal-admin@example.com'
  ),
  (
    '00000000-0000-4000-8000-000000002930',
    'authenticated',
    'authenticated',
    'ovd292-late-member@example.com'
  );

insert into public.organizations (id, name, slug)
values
  (
    (select primary_organization_id from ovd292_test_context),
    'OVD 292 Primary',
    'ovd-292-primary'
  ),
  (
    (select second_organization_id from ovd292_test_context),
    'OVD 292 Second',
    'ovd-292-second'
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
    '00000000-0000-4000-8000-000000002926',
    (select primary_organization_id from ovd292_test_context),
    (select owner_user_id from ovd292_test_context),
    'client',
    '2026-08-01T00:00:00Z'
  ),
  (
    '00000000-0000-4000-8000-000000002927',
    (select primary_organization_id from ovd292_test_context),
    (select member_user_id from ovd292_test_context),
    'client',
    '2026-08-01T00:01:00Z'
  ),
  (
    '00000000-0000-4000-8000-000000002928',
    (select primary_organization_id from ovd292_test_context),
    (select internal_admin_user_id from ovd292_test_context),
    'internal_admin',
    '2026-08-01T00:02:00Z'
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
    'public.api_configure_stripe_pro_catalog(text,text,boolean)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.api_acquire_organization_billing_checkout(uuid,boolean,text,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.api_finalize_organization_billing_checkout(uuid,uuid,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.api_record_billing_checkout_started(uuid,uuid,text,text,text)',
    'EXECUTE'
  ),
  'authenticated clients cannot bind Stripe objects, configure catalog, claim Checkout, or forge billing events'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.log_audit_event(uuid,text,jsonb,uuid,uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.log_audit_event(uuid,text,jsonb,uuid,uuid)',
    'EXECUTE'
  ),
  'legacy generic audit logging is not client-executable'
);

set local role authenticated;
select pg_temp.set_ovd292_request_identity(
  (select owner_user_id from ovd292_test_context)
);

select is(
  public.api_get_organization_entitlements(
    (select primary_organization_id from ovd292_test_context)
  ) ->> 'canManageBilling',
  'true',
  'the explicitly assigned organization billing owner can manage billing'
);

select is(
  public.api_prepare_organization_billing_session(
    (select primary_organization_id from ovd292_test_context)
  ) ->> 'organizationName',
  'OVD 292 Primary',
  'the billing owner can prepare the server-owned account'
);

select is(
  public.api_prepare_organization_billing_session(
    (select primary_organization_id from ovd292_test_context)
  ) ->> 'hasStripeSubscription',
  'false',
  'a new billing account is not presented as Stripe-backed'
);

select throws_ok(
  $$
    select public.log_audit_event(
      '00000000-0000-4000-8000-000000002924',
      'billing.upgrade_started',
      '{}'::jsonb
    )
  $$,
  '42501',
  'permission denied for function log_audit_event',
  'authenticated callers cannot forge protected billing events through the legacy definer function'
);

reset role;
set local role authenticated;
select pg_temp.set_ovd292_request_identity(
  (select member_user_id from ovd292_test_context)
);

select is(
  public.api_get_organization_entitlements(
    (select primary_organization_id from ovd292_test_context)
  ) ->> 'canManageBilling',
  'false',
  'an ordinary organization member cannot manage billing'
);

select throws_ok(
  $$
    select public.api_prepare_organization_billing_session(
      '00000000-0000-4000-8000-000000002924'
    )
  $$,
  'P0001',
  'Only the organization billing owner can manage this subscription.',
  'a non-owner member cannot prepare billing'
);

select throws_ok(
  $$
    select public.api_prepare_organization_billing_session(
      '00000000-0000-4000-8000-000000002925'
    )
  $$,
  'P0001',
  'Only the organization billing owner can manage this subscription.',
  'cross-organization preparation is denied'
);

reset role;
set local role authenticated;
select pg_temp.set_ovd292_request_identity(
  (select internal_admin_user_id from ovd292_test_context)
);

select is(
  public.api_get_organization_entitlements(
    (select primary_organization_id from ovd292_test_context)
  ) ->> 'canManageBilling',
  'false',
  'platform internal staff cannot open a customer billing session'
);

reset role;

insert into public.organization_memberships (
  id,
  organization_id,
  user_id,
  role,
  created_at
)
values (
  '00000000-0000-4000-8000-000000002929',
  (select primary_organization_id from ovd292_test_context),
  '00000000-0000-4000-8000-000000002930',
  'client',
  '2026-07-01T00:00:00Z'
);

select is(
  (
    select account_row.billing_owner_membership_id
    from private.organization_billing_accounts account_row
    where account_row.organization_id =
      (select primary_organization_id from ovd292_test_context)
  ),
  '00000000-0000-4000-8000-000000002926'::uuid,
  'later membership inserts never silently transfer the explicit billing owner'
);

select throws_ok(
  $$
    delete from public.organization_memberships
    where id = '00000000-0000-4000-8000-000000002926'
  $$,
  '23503',
  null,
  'the billing-owner membership cannot be deleted before an explicit reassignment'
);

insert into auth.users (id, aud, role, email)
values (
  '00000000-0000-4000-8000-000000002931',
  'authenticated',
  'authenticated',
  'ovd292-deleted-org-owner@example.com'
);

insert into public.organizations (id, name, slug)
values (
  '00000000-0000-4000-8000-000000002932',
  'OVD 292 Deleted Organization',
  'ovd-292-deleted-organization'
);

insert into public.organization_memberships (
  id,
  organization_id,
  user_id,
  role
)
values (
  '00000000-0000-4000-8000-000000002933',
  '00000000-0000-4000-8000-000000002932',
  '00000000-0000-4000-8000-000000002931',
  'client'
);

delete from public.organizations
where id = '00000000-0000-4000-8000-000000002932';

select is(
  (
    select count(*)
    from private.organization_billing_accounts account_row
    where account_row.organization_id =
      '00000000-0000-4000-8000-000000002932'
  ),
  0::bigint,
  'organization deletion cascades through its billing-owner assignment'
);

set local role service_role;
select pg_temp.set_ovd292_request_identity(
  (select owner_user_id from ovd292_test_context),
  'service_role'
);

select is(
  public.api_configure_stripe_pro_catalog(
    'price_OVD292MonthlyOld',
    'price_OVD292AnnualOld',
    false
  ) ->> 'livemode',
  'false',
  'the service configures the exact monthly and annual Checkout catalog'
);

select public.api_configure_stripe_pro_catalog(
  'price_OVD292Monthly',
  'price_OVD292Annual',
  false
);

reset role;

select is(
  (
    select count(*)
    from private.stripe_pro_checkout_catalog catalog_row
    where (
      catalog_row.billing_interval = 'month'
      and catalog_row.lookup_key = 'overdrafter_pro_monthly_v1'
      and catalog_row.stripe_price_id = 'price_OVD292Monthly'
      and catalog_row.livemode = false
    ) or (
      catalog_row.billing_interval = 'year'
      and catalog_row.lookup_key = 'overdrafter_pro_annual_v1'
      and catalog_row.stripe_price_id = 'price_OVD292Annual'
      and catalog_row.livemode = false
    )
  ),
  2::bigint,
  'monthly and annual active catalog slots coexist'
);

select is(
  (
    select count(*)
    from private.stripe_pro_price_allowlist price_row
    where price_row.stripe_price_id in (
      'price_OVD292MonthlyOld',
      'price_OVD292AnnualOld',
      'price_OVD292Monthly',
      'price_OVD292Annual'
    )
      and price_row.livemode = false
  ),
  4::bigint,
  'catalog rotation retains historical entitlement Price IDs'
);

set local role service_role;
select pg_temp.set_ovd292_request_identity(
  (select owner_user_id from ovd292_test_context),
  'service_role'
);

create temporary table ovd292_intent as
select public.api_acquire_organization_billing_checkout(
  (select primary_organization_id from ovd292_test_context),
  false,
  'month',
  'overdrafter_pro_monthly_v1'
) as result;

select is(
  (select result ->> 'acquired' from ovd292_intent),
  'true',
  'the first monthly Checkout request acquires a durable intent'
);

select is(
  public.api_acquire_organization_billing_checkout(
    (select primary_organization_id from ovd292_test_context),
    false,
    'month',
    'overdrafter_pro_monthly_v1'
  ) ->> 'intentId',
  (select result ->> 'intentId' from ovd292_intent),
  'concurrent same-plan requests resume one Stripe idempotency intent'
);

select is(
  public.api_acquire_organization_billing_checkout(
    (select primary_organization_id from ovd292_test_context),
    false,
    'year',
    'overdrafter_pro_annual_v1'
  ) ->> 'acquired',
  'false',
  'a concurrent annual request cannot race the active monthly intent'
);

select is(
  public.api_finalize_organization_billing_checkout(
    (select primary_organization_id from ovd292_test_context),
    (select (result ->> 'intentId')::uuid from ovd292_intent),
    'cs_test_OVD292Monthly'
  ) ->> 'state',
  'open',
  'the durable intent records the exact open Stripe Session'
);

select is(
  public.api_acquire_organization_billing_checkout(
    (select primary_organization_id from ovd292_test_context),
    false,
    'year',
    'overdrafter_pro_annual_v1'
  ) ->> 'acquired',
  'false',
  'an open monthly Session continues to block interval switching'
);

reset role;
update private.organization_billing_checkout_intents
set lease_expires_at = pg_catalog.now() - interval '1 second'
where organization_id =
  (select primary_organization_id from ovd292_test_context);

set local role service_role;
select pg_temp.set_ovd292_request_identity(
  (select owner_user_id from ovd292_test_context),
  'service_role'
);

select is(
  public.api_acquire_organization_billing_checkout(
    (select primary_organization_id from ovd292_test_context),
    false,
    'year',
    'overdrafter_pro_annual_v1'
  ) ->> 'acquired',
  'true',
  'an expired Checkout intent permits a replacement interval'
);

select is(
  public.api_bind_organization_stripe_customer(
    (select primary_organization_id from ovd292_test_context),
    'cus_OVD292Primary',
    false
  ) ->> 'stripeCustomerId',
  'cus_OVD292Primary',
  'the service binds one Stripe Customer to the organization'
);

select is(
  public.api_bind_organization_stripe_customer(
    (select primary_organization_id from ovd292_test_context),
    'cus_OVD292Primary',
    false
  ) ->> 'stripeCustomerId',
  'cus_OVD292Primary',
  'replaying the same Customer binding is idempotent'
);

select throws_ok(
  $$
    select public.api_bind_organization_stripe_customer(
      '00000000-0000-4000-8000-000000002924',
      'cus_OVD292Different',
      false
    )
  $$,
  'P0001',
  'Organization is already bound to a different Stripe customer or mode.',
  'an organization cannot be rebound to a different Stripe Customer'
);

select is(
  public.api_record_billing_checkout_started(
    (select primary_organization_id from ovd292_test_context),
    (select owner_user_id from ovd292_test_context),
    'cs_test_OVD292Monthly',
    'month',
    'price_OVD292Monthly'
  ) is not null,
  true,
  'the service records a truthful monthly upgrade-start event'
);

select public.api_record_billing_checkout_started(
  (select primary_organization_id from ovd292_test_context),
  (select owner_user_id from ovd292_test_context),
  'cs_test_OVD292Monthly',
  'month',
  'price_OVD292Monthly'
);

reset role;

select is(
  (
    select count(*)
    from public.audit_events audit_event
    where audit_event.organization_id =
      (select primary_organization_id from ovd292_test_context)
      and audit_event.event_type = 'billing.upgrade_started'
      and audit_event.payload ->> 'stripeCheckoutSessionId' =
        'cs_test_OVD292Monthly'
      and audit_event.payload ->> 'billingInterval' = 'month'
      and audit_event.payload ->> 'stripePriceId' = 'price_OVD292Monthly'
  ),
  1::bigint,
  'replaying a Checkout Session records one append-only funnel event'
);

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
  (select primary_organization_id from ovd292_test_context),
  'sub_OVD292Trial',
  'trialing',
  'year',
  pg_catalog.now() + interval '14 days',
  false,
  pg_catalog.now(),
  'evt_OVD292Trial',
  false,
  'price_OVD292Annual'
);

select is(
  private.resolve_organization_entitlements_at(
    (select primary_organization_id from ovd292_test_context),
    pg_catalog.now()
  ) ->> 'source',
  'subscription_trialing',
  'a signed-webhook trialing projection grants Pro until its period ends'
);

select is(
  (
    select count(*)
    from public.audit_events audit_event
    where audit_event.organization_id =
      (select primary_organization_id from ovd292_test_context)
      and audit_event.event_type = 'billing.subscription_activated'
      and audit_event.payload ->> 'stripeEventId' = 'evt_OVD292Trial'
      and audit_event.payload ->> 'status' = 'trialing'
  ),
  1::bigint,
  'a webhook-synchronized trial start emits one server-side activation event'
);

set local role authenticated;
select pg_temp.set_ovd292_request_identity(
  (select internal_admin_user_id from ovd292_test_context)
);

reset role;

select throws_ok(
  $$
    update public.audit_events
    set payload = '{}'::jsonb
    where event_type = 'billing.upgrade_started'
  $$,
  '42501',
  'Billing audit events are append-only.',
  'even privileged database paths cannot rewrite billing funnel history'
);

select throws_ok(
  $$
    delete from public.audit_events
    where event_type = 'billing.subscription_activated'
  $$,
  '42501',
  'Billing audit events are append-only.',
  'even privileged database paths cannot delete billing activation history'
);

select * from finish();

rollback;
