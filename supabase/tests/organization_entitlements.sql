begin;

select plan(35);

create temporary table ovd229_context (
  organization_id uuid not null,
  second_organization_id uuid not null,
  member_user_id uuid not null,
  platform_viewer_user_id uuid not null,
  billing_admin_user_id uuid not null,
  order_admin_user_id uuid not null
) on commit drop;

insert into ovd229_context values (
  '00000000-0000-4000-8000-000000002291',
  '00000000-0000-4000-8000-000000002292',
  '00000000-0000-4000-8000-000000002293',
  '00000000-0000-4000-8000-000000002294',
  '00000000-0000-4000-8000-000000002295',
  '00000000-0000-4000-8000-000000002296'
);

grant select on ovd229_context to authenticated;

create function public.ovd229_test_set_claims(
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
      'role', 'authenticated',
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

revoke all on function public.ovd229_test_set_claims(uuid, text)
  from public, anon;
grant execute on function public.ovd229_test_set_claims(uuid, text)
  to authenticated;

insert into auth.users (id, aud, role, email)
values
  (
    (select member_user_id from ovd229_context),
    'authenticated',
    'authenticated',
    'ovd229-member@example.com'
  ),
  (
    (select platform_viewer_user_id from ovd229_context),
    'authenticated',
    'authenticated',
    'ovd229-platform-viewer@example.com'
  ),
  (
    (select billing_admin_user_id from ovd229_context),
    'authenticated',
    'authenticated',
    'ovd229-billing@example.com'
  ),
  (
    (select order_admin_user_id from ovd229_context),
    'authenticated',
    'authenticated',
    'ovd229-order@example.com'
  );

insert into public.organizations (id, name, slug)
values
  (
    (select organization_id from ovd229_context),
    'OVD 229 Primary',
    'ovd-229-primary'
  ),
  (
    (select second_organization_id from ovd229_context),
    'OVD 229 Secondary',
    'ovd-229-secondary'
  );

insert into public.organization_memberships (
  organization_id,
  user_id,
  role
)
values (
  (select organization_id from ovd229_context),
  (select member_user_id from ovd229_context),
  'internal_admin'
);

insert into private.platform_admin_emails (email)
values ('ovd229-platform-viewer@example.com');

insert into private.platform_admin_capabilities (
  user_id,
  capability,
  granted_by_user_id,
  grant_reason
)
values
  (
    (select billing_admin_user_id from ovd229_context),
    'billing_admin',
    (select billing_admin_user_id from ovd229_context),
    'OVD-229 billing authorization test'
  ),
  (
    (select order_admin_user_id from ovd229_context),
    'order_admin',
    (select order_admin_user_id from ovd229_context),
    'OVD-229 order authorization test'
  );

select is(
  private.resolve_organization_entitlements_at(
    (select organization_id from ovd229_context),
    '2026-08-01T00:00:00Z'
  ) ->> 'plan',
  'free',
  'an existing organization defaults to Free without a billing row'
);

select is(
  (
    private.resolve_organization_entitlements_at(
      '00000000-0000-4000-8000-000000002299',
      '2026-08-01T00:00:00Z'
    ) ->> 'automaticQuoteCollection'
  )::boolean,
  false,
  'missing organizations fail closed without automatic quote access'
);

set local role authenticated;
select public.ovd229_test_set_claims(
  (select member_user_id from ovd229_context),
  'aal2'
);

select throws_ok(
  format(
    'select public.api_admin_grant_organization_entitlement(%L,%L,%L,%L,%L,%L,%L)',
    (select organization_id from ovd229_context),
    'trial',
    '2026-07-01T00:00:00Z',
    '2026-09-01T00:00:00Z',
    null,
    'Organization role must not grant Pro',
    'member-denied'
  ),
  'P0001',
  'You do not have the required commercial capability.',
  'organization admins cannot grant Pro'
);

select public.ovd229_test_set_claims(
  (select platform_viewer_user_id from ovd229_context),
  'aal2'
);

select throws_ok(
  format(
    'select public.api_admin_grant_organization_entitlement(%L,%L,%L,%L,%L,%L,%L)',
    (select organization_id from ovd229_context),
    'trial',
    '2026-07-01T00:00:00Z',
    '2026-09-01T00:00:00Z',
    null,
    'Platform viewers remain read-only',
    'viewer-denied'
  ),
  'P0001',
  'You do not have the required commercial capability.',
  'legacy platform viewers cannot grant Pro'
);

select public.ovd229_test_set_claims(
  (select order_admin_user_id from ovd229_context),
  'aal2'
);

select throws_ok(
  format(
    'select public.api_admin_grant_organization_entitlement(%L,%L,%L,%L,%L,%L,%L)',
    (select organization_id from ovd229_context),
    'trial',
    '2026-07-01T00:00:00Z',
    '2026-09-01T00:00:00Z',
    null,
    'Order authority must stay separate',
    'order-denied'
  ),
  'P0001',
  'You do not have the required commercial capability.',
  'order admins cannot grant Pro'
);

select public.ovd229_test_set_claims(
  (select billing_admin_user_id from ovd229_context),
  'aal1'
);

select throws_ok(
  format(
    'select public.api_admin_grant_organization_entitlement(%L,%L,%L,%L,%L,%L,%L)',
    (select organization_id from ovd229_context),
    'trial',
    '2026-07-01T00:00:00Z',
    '2026-09-01T00:00:00Z',
    null,
    'AAL1 must fail closed',
    'aal1-denied'
  ),
  'P0001',
  'Multi-factor authentication is required for this commercial operation.',
  'billing admins at AAL1 cannot grant Pro'
);

select public.ovd229_test_set_claims(
  (select billing_admin_user_id from ovd229_context),
  'aal2'
);

select throws_ok(
  format(
    'select public.api_admin_grant_organization_entitlement(%L,%L,%L,null,%L,%L,%L)',
    (select organization_id from ovd229_context),
    'trial',
    '2026-07-01T00:00:00Z',
    null,
    'Trials must expire',
    'trial-no-expiry'
  ),
  'P0001',
  'Trial grants require an expiration after their start.',
  'trial grants require expiration'
);

select throws_ok(
  format(
    'select public.api_admin_grant_organization_entitlement(%L,%L,%L,null,null,%L,%L)',
    (select organization_id from ovd229_context),
    'complimentary',
    '2026-07-01T00:00:00Z',
    'Complimentary grants require review',
    'comp-no-review'
  ),
  'P0001',
  'Complimentary grants require a review date after their start.',
  'complimentary grants require a review date'
);

select is(
  (
    public.api_admin_grant_organization_entitlement(
      (select organization_id from ovd229_context),
      'trial',
      '2026-07-01T00:00:00Z',
      '2026-09-01T00:00:00Z',
      null,
      'Support trial for evaluation',
      'trial-success'
    ) ->> 'replayed'
  )::boolean,
  false,
  'billing admins at AAL2 can grant a trial'
);

reset role;

select is(
  private.resolve_organization_entitlements_at(
    (select organization_id from ovd229_context),
    '2026-08-01T00:00:00Z'
  ) ->> 'source',
  'manual_trial',
  'an active trial resolves to Pro before subscription state'
);

select is(
  (
    private.resolve_organization_entitlements_at(
      (select organization_id from ovd229_context),
      '2026-09-01T00:00:00Z'
    ) ->> 'automaticQuoteCollection'
  )::boolean,
  false,
  'a trial is inactive at its exact expiration'
);

set local role authenticated;
select public.ovd229_test_set_claims(
  (select billing_admin_user_id from ovd229_context),
  'aal2'
);

select is(
  (
    public.api_admin_grant_organization_entitlement(
      (select organization_id from ovd229_context),
      'trial',
      '2026-07-01T00:00:00Z',
      '2026-09-01T00:00:00Z',
      null,
      'Support trial for evaluation',
      'trial-success'
    ) ->> 'replayed'
  )::boolean,
  true,
  'an exact grant retry returns the original result'
);

select is(
  (
    select count(*)
    from public.commercial_admin_audit_events
    where action = 'commercial.entitlement.grant'
      and idempotency_key = 'trial-success'
  ),
  1::bigint,
  'an exact grant retry creates one audit event'
);

select throws_ok(
  format(
    'select public.api_admin_grant_organization_entitlement(%L,%L,%L,%L,null,%L,%L)',
    (select organization_id from ovd229_context),
    'trial',
    '2026-07-01T00:00:00Z',
    '2026-10-01T00:00:00Z',
    'Changed intent',
    'trial-success'
  ),
  'P0001',
  'Idempotency key has already been used for a different entitlement grant.',
  'grant idempotency-key reuse with changed intent is rejected'
);

reset role;

insert into private.organization_billing_accounts (
  organization_id,
  stripe_customer_id
)
values (
  (select organization_id from ovd229_context),
  'cus_OVD229'
);

insert into private.organization_subscription_projections (
  organization_id,
  stripe_subscription_id,
  status,
  billing_interval,
  current_period_end,
  stripe_event_created_at
)
values (
  (select organization_id from ovd229_context),
  'sub_OVD229',
  'active',
  'month',
  '2026-10-01T00:00:00Z',
  '2026-07-15T00:00:00Z'
);

select is(
  private.resolve_organization_entitlements_at(
    (select organization_id from ovd229_context),
    '2026-08-01T00:00:00Z'
  ) ->> 'source',
  'manual_trial',
  'an active manual grant takes precedence over a subscription'
);

set local role authenticated;
select public.ovd229_test_set_claims(
  (select billing_admin_user_id from ovd229_context),
  'aal2'
);

select is(
  (
    public.api_admin_revoke_organization_entitlement(
      (
        select target_id::uuid
        from public.commercial_admin_audit_events
        where idempotency_key = 'trial-success'
      ),
      'Trial no longer needed',
      'trial-revoke'
    ) ->> 'replayed'
  )::boolean,
  false,
  'billing admins at AAL2 can revoke a grant'
);

select is(
  public.api_admin_revoke_organization_entitlement(
    (
      select target_id::uuid
      from public.commercial_admin_audit_events
      where idempotency_key = 'trial-success'
    ),
    'Trial no longer needed',
    'trial-revoke'
  ) ->> 'replayed',
  'true',
  'an exact revoke retry returns the original result'
);

select throws_ok(
  format(
    'select public.api_admin_revoke_organization_entitlement(%L,%L,%L)',
    (
      select target_id::uuid
      from public.commercial_admin_audit_events
      where idempotency_key = 'trial-success'
    ),
    'Changed revoke intent',
    'trial-revoke'
  ),
  'P0001',
  'Idempotency key has already been used for a different entitlement revocation.',
  'revoke idempotency-key reuse with changed intent is rejected'
);

reset role;

select is(
  private.resolve_organization_entitlements_at(
    (select organization_id from ovd229_context),
    '2026-08-01T00:00:00Z'
  ) ->> 'source',
  'subscription_active',
  'an eligible active subscription resolves to Pro after revocation'
);

update private.organization_subscription_projections
set
  status = 'past_due',
  past_due_since = '2026-07-25T00:00:00Z',
  current_period_end = null,
  updated_at = now()
where stripe_subscription_id = 'sub_OVD229';

select is(
  private.resolve_organization_entitlements_at(
    (select organization_id from ovd229_context),
    '2026-07-31T23:59:59.999999Z'
  ) ->> 'source',
  'subscription_past_due_grace',
  'past-due subscriptions retain Pro immediately before seven days'
);

select is(
  private.resolve_organization_entitlements_at(
    (select organization_id from ovd229_context),
    '2026-08-01T00:00:00Z'
  ) ->> 'plan',
  'free',
  'past-due subscriptions resolve to Free at exactly seven days'
);

update private.organization_subscription_projections
set
  status = 'canceled',
  past_due_since = null,
  updated_at = now()
where stripe_subscription_id = 'sub_OVD229';

select is(
  private.resolve_organization_entitlements_at(
    (select organization_id from ovd229_context),
    '2026-07-31T00:00:00Z'
  ) ->> 'plan',
  'free',
  'canceled subscriptions do not grant Pro'
);

update private.organization_subscription_projections
set
  status = 'trialing',
  current_period_end = '2026-10-01T00:00:00Z',
  updated_at = now()
where stripe_subscription_id = 'sub_OVD229';

select is(
  private.resolve_organization_entitlements_at(
    (select organization_id from ovd229_context),
    '2026-07-31T00:00:00Z'
  ) ->> 'plan',
  'free',
  'Stripe trialing state does not bypass audited manual trial grants'
);

set local role authenticated;
select public.ovd229_test_set_claims(
  (select billing_admin_user_id from ovd229_context),
  'aal2'
);

select is(
  (
    public.api_admin_grant_organization_entitlement(
      (select organization_id from ovd229_context),
      'complimentary',
      '2026-07-01T00:00:00Z',
      null,
      '2026-07-15T00:00:00Z',
      'Complimentary access for partner support',
      'comp-success'
    ) -> 'effective' ->> 'reviewDue'
  )::boolean,
  true,
  'complimentary grants can omit expiry and remain active when review is due'
);

select is(
  (
    public.api_admin_grant_organization_entitlement(
      (select organization_id from ovd229_context),
      'trial',
      '2026-07-20T00:00:00Z',
      '2026-12-01T00:00:00Z',
      null,
      'A later trial must not outrank complimentary access',
      'later-trial'
    ) ->> 'replayed'
  )::boolean,
  false,
  'a later trial can coexist with a complimentary grant'
);

select is(
  public.api_admin_get_organization_entitlement_state(
    (select organization_id from ovd229_context)
  ) -> 'effective' ->> 'source',
  'manual_complimentary',
  'complimentary grants have deterministic display precedence over trials'
);

select is(
  public.api_admin_get_organization_entitlement_state(
    (select organization_id from ovd229_context)
  ) -> 'effective' ->> 'source',
  'manual_complimentary',
  'billing admins can read effective state and grant history at AAL2'
);

reset role;

select ok(
  (
    select count(*) = 1
    from private.organization_entitlement_grants
    where organization_id = (select organization_id from ovd229_context)
      and grant_type = 'complimentary'
      and revoked_at is null
  ),
  'only one current grant per organization and type remains unrevoked'
);

set local role authenticated;
select public.ovd229_test_set_claims(
  (select billing_admin_user_id from ovd229_context),
  'aal2'
);

select throws_ok(
  $$
    insert into private.organization_entitlement_grants (
      organization_id,
      grant_type,
      starts_at,
      expires_at,
      grant_reason,
      granted_by_user_id
    )
    values (
      '00000000-0000-4000-8000-000000002291',
      'trial',
      now(),
      now() + interval '1 day',
      'forged',
      '00000000-0000-4000-8000-000000002295'
    )
  $$,
  '42501',
  'permission denied for schema private',
  'authenticated users cannot mutate grant records directly'
);

reset role;

select ok(
  not has_table_privilege(
    'service_role',
    'private.organization_entitlement_grants',
    'INSERT'
  )
  and not has_table_privilege(
    'service_role',
    'private.organization_entitlement_grants',
    'UPDATE'
  )
  and not has_table_privilege(
    'service_role',
    'private.organization_entitlement_grants',
    'DELETE'
  )
  and not has_table_privilege(
    'service_role',
    'private.organization_entitlement_grants',
    'TRUNCATE'
  ),
  'service role cannot bypass audited manual grant operations'
);

select ok(
  not has_table_privilege(
    'authenticated',
    'private.organization_subscription_projections',
    'SELECT'
  )
  and not has_table_privilege(
    'authenticated',
    'private.organization_subscription_projections',
    'INSERT'
  ),
  'authenticated users cannot read or forge subscription projections'
);

set local role authenticated;
select public.ovd229_test_set_claims(
  (select member_user_id from ovd229_context),
  'aal1'
);

select is(
  public.api_get_organization_entitlements(
    (select organization_id from ovd229_context)
  ) ->> 'plan',
  'pro',
  'organization members can read their server-resolved effective plan'
);

select throws_ok(
  format(
    'select public.api_get_organization_entitlements(%L)',
    (select second_organization_id from ovd229_context)
  ),
  'P0001',
  'You do not have access to this organization.',
  'organization members cannot read another organization plan'
);

reset role;

select is(
  (
    select count(*)
    from public.commercial_admin_audit_events
    where organization_id = (select organization_id from ovd229_context)
      and action in (
        'commercial.entitlement.grant',
        'commercial.entitlement.revoke'
      )
  ),
  4::bigint,
  'successful grants and revocation produce immutable commercial audit rows'
);

select ok(
  (
    select bool_and(
      actor_user_id = (select billing_admin_user_id from ovd229_context)
      and required_capability = 'billing_admin'
      and reason <> ''
      and before_state is not null
      and after_state is not null
      and idempotency_key <> ''
    )
    from public.commercial_admin_audit_events
    where organization_id = (select organization_id from ovd229_context)
      and action in (
        'commercial.entitlement.grant',
        'commercial.entitlement.revoke'
      )
  ),
  'entitlement audit rows retain actor, reason, state, and idempotency evidence'
);

select * from finish();

rollback;
