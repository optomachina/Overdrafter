-- OVD-229: server-authoritative organization plans and effective entitlements.
--
-- Free is the absence-safe default. Pro is derived only from an active manual
-- grant or an eligible, server-written Stripe subscription projection.

create table private.organization_billing_accounts (
  organization_id uuid primary key
    references public.organizations(id) on delete cascade,
  stripe_customer_id text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organization_billing_accounts_customer_check
    check (
      stripe_customer_id is null
      or stripe_customer_id ~ '^cus_[A-Za-z0-9]+$'
    )
);

revoke all on private.organization_billing_accounts
  from public, anon, authenticated, service_role;
grant select, insert, update on private.organization_billing_accounts
  to service_role;

create table private.organization_subscription_projections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null
    references private.organization_billing_accounts(organization_id)
    on delete cascade,
  stripe_subscription_id text not null unique,
  status text not null,
  billing_interval text,
  current_period_end timestamptz,
  past_due_since timestamptz,
  cancel_at_period_end boolean not null default false,
  stripe_event_created_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organization_subscription_id_check
    check (stripe_subscription_id ~ '^sub_[A-Za-z0-9]+$'),
  constraint organization_subscription_status_check
    check (
      status in (
        'incomplete',
        'incomplete_expired',
        'trialing',
        'active',
        'past_due',
        'canceled',
        'unpaid',
        'paused'
      )
    ),
  constraint organization_subscription_interval_check
    check (
      billing_interval is null
      or billing_interval in ('month', 'year')
    ),
  constraint organization_subscription_period_check
    check (
      status not in ('active', 'trialing')
      or current_period_end is not null
    ),
  constraint organization_subscription_past_due_check
    check (
      status <> 'past_due'
      or past_due_since is not null
    )
);

create index organization_subscription_org_event_idx
  on private.organization_subscription_projections (
    organization_id,
    stripe_event_created_at desc
  );

revoke all on private.organization_subscription_projections
  from public, anon, authenticated, service_role;
grant select, insert, update on private.organization_subscription_projections
  to service_role;

create table private.organization_entitlement_grants (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null
    references public.organizations(id) on delete cascade,
  entitlement_key text not null default 'automatic_quote_collection',
  grant_type text not null,
  starts_at timestamptz not null,
  expires_at timestamptz,
  review_at timestamptz,
  grant_reason text not null,
  granted_by_user_id uuid not null,
  revoked_at timestamptz,
  revoked_by_user_id uuid,
  revocation_reason text,
  created_at timestamptz not null default now(),
  constraint organization_entitlement_key_check
    check (entitlement_key = 'automatic_quote_collection'),
  constraint organization_entitlement_grant_type_check
    check (grant_type in ('trial', 'complimentary')),
  constraint organization_entitlement_grant_reason_check
    check (length(trim(grant_reason)) between 1 and 1000),
  constraint organization_entitlement_trial_check
    check (
      grant_type <> 'trial'
      or (
        expires_at is not null
        and expires_at > starts_at
      )
    ),
  constraint organization_entitlement_complimentary_check
    check (
      grant_type <> 'complimentary'
      or (
        review_at is not null
        and review_at > starts_at
        and (
          expires_at is null
          or expires_at > starts_at
        )
      )
    ),
  constraint organization_entitlement_revocation_check
    check (
      (
        revoked_at is null
        and revoked_by_user_id is null
        and revocation_reason is null
      )
      or (
        revoked_at is not null
        and revoked_by_user_id is not null
        and revocation_reason is not null
        and length(trim(revocation_reason)) between 1 and 1000
      )
    )
);

create unique index organization_entitlement_current_type_unique
  on private.organization_entitlement_grants (organization_id, grant_type)
  where revoked_at is null;

create index organization_entitlement_org_time_idx
  on private.organization_entitlement_grants (
    organization_id,
    starts_at desc,
    created_at desc
  );

revoke all on private.organization_entitlement_grants
  from public, anon, authenticated, service_role;
grant select on private.organization_entitlement_grants to service_role;

create or replace function private.resolve_organization_entitlements_at(
  p_organization_id uuid,
  p_as_of timestamptz
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  v_grant private.organization_entitlement_grants%rowtype;
  v_subscription private.organization_subscription_projections%rowtype;
  v_grace_ends_at timestamptz;
begin
  if p_organization_id is null
    or p_as_of is null
    or not exists (
      select 1
      from public.organizations organization_row
      where organization_row.id = p_organization_id
    )
  then
    return pg_catalog.jsonb_build_object(
      'plan', 'free',
      'source', 'default',
      'automaticQuoteCollection', false,
      'organizationExists', false
    );
  end if;

  select grant_row.*
  into v_grant
  from private.organization_entitlement_grants grant_row
  where grant_row.organization_id = p_organization_id
    and grant_row.entitlement_key = 'automatic_quote_collection'
    and grant_row.revoked_at is null
    and grant_row.starts_at <= p_as_of
    and (
      grant_row.expires_at is null
      or grant_row.expires_at > p_as_of
    )
  order by
    case grant_row.grant_type
      when 'complimentary' then 0
      else 1
    end,
    grant_row.starts_at desc,
    grant_row.created_at desc,
    grant_row.id desc
  limit 1;

  if v_grant.id is not null then
    return pg_catalog.jsonb_strip_nulls(
      pg_catalog.jsonb_build_object(
        'plan', 'pro',
        'source', 'manual_' || v_grant.grant_type,
        'sourceId', v_grant.id,
        'automaticQuoteCollection', true,
        'validUntil', v_grant.expires_at,
        'reviewAt', v_grant.review_at,
        'reviewDue',
          v_grant.review_at is not null and v_grant.review_at <= p_as_of,
        'organizationExists', true
      )
    );
  end if;

  select subscription_row.*
  into v_subscription
  from private.organization_subscription_projections subscription_row
  where subscription_row.organization_id = p_organization_id
    and (
      (
        subscription_row.status = 'active'
        and subscription_row.current_period_end > p_as_of
      )
      or (
        subscription_row.status = 'past_due'
        and p_as_of <
          subscription_row.past_due_since + interval '7 days'
      )
    )
  order by
    subscription_row.stripe_event_created_at desc,
    subscription_row.updated_at desc,
    subscription_row.id desc
  limit 1;

  if v_subscription.id is not null then
    if v_subscription.status = 'past_due' then
      v_grace_ends_at :=
        v_subscription.past_due_since + interval '7 days';
    end if;

    return pg_catalog.jsonb_strip_nulls(
      pg_catalog.jsonb_build_object(
        'plan', 'pro',
        'source',
          case v_subscription.status
            when 'past_due' then 'subscription_past_due_grace'
            else 'subscription_active'
          end,
        'sourceId', v_subscription.id,
        'automaticQuoteCollection', true,
        'validUntil', v_subscription.current_period_end,
        'graceEndsAt', v_grace_ends_at,
        'organizationExists', true
      )
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'plan', 'free',
    'source', 'default',
    'automaticQuoteCollection', false,
    'organizationExists', true
  );
exception
  when others then
    return pg_catalog.jsonb_build_object(
      'plan', 'free',
      'source', 'resolver_error',
      'automaticQuoteCollection', false,
      'organizationExists', false
    );
end;
$$;

revoke all on function private.resolve_organization_entitlements_at(
  uuid,
  timestamptz
) from public, anon, authenticated, service_role;

create or replace function public.api_get_organization_entitlements(
  p_organization_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
begin
  if auth.uid() is null then
    raise exception 'You must be signed in to view organization entitlements.';
  end if;

  if not exists (
      select 1
      from public.organization_memberships membership
      where membership.organization_id = p_organization_id
        and membership.user_id = auth.uid()
    )
    and not public.current_user_has_commercial_capability('billing_admin')
  then
    raise exception 'You do not have access to this organization.';
  end if;

  return private.resolve_organization_entitlements_at(
    p_organization_id,
    pg_catalog.now()
  );
end;
$$;

revoke all on function public.api_get_organization_entitlements(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.api_get_organization_entitlements(uuid)
  to authenticated;

create or replace function public.api_admin_get_organization_entitlement_state(
  p_organization_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  v_grants jsonb;
  v_subscriptions jsonb;
begin
  perform private.require_commercial_admin_capability('billing_admin');

  if not exists (
    select 1
    from public.organizations organization_row
    where organization_row.id = p_organization_id
  ) then
    raise exception 'Organization was not found.';
  end if;

  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_strip_nulls(
        pg_catalog.jsonb_build_object(
          'id', grant_row.id,
          'type', grant_row.grant_type,
          'startsAt', grant_row.starts_at,
          'expiresAt', grant_row.expires_at,
          'reviewAt', grant_row.review_at,
          'reason', grant_row.grant_reason,
          'grantedByUserId', grant_row.granted_by_user_id,
          'revokedAt', grant_row.revoked_at,
          'revokedByUserId', grant_row.revoked_by_user_id,
          'revocationReason', grant_row.revocation_reason,
          'createdAt', grant_row.created_at
        )
      )
      order by grant_row.created_at desc
    ),
    '[]'::jsonb
  )
  into v_grants
  from private.organization_entitlement_grants grant_row
  where grant_row.organization_id = p_organization_id;

  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_strip_nulls(
        pg_catalog.jsonb_build_object(
          'id', subscription_row.id,
          'stripeSubscriptionId',
            subscription_row.stripe_subscription_id,
          'status', subscription_row.status,
          'billingInterval', subscription_row.billing_interval,
          'currentPeriodEnd', subscription_row.current_period_end,
          'pastDueSince', subscription_row.past_due_since,
          'cancelAtPeriodEnd',
            subscription_row.cancel_at_period_end,
          'stripeEventCreatedAt',
            subscription_row.stripe_event_created_at,
          'updatedAt', subscription_row.updated_at
        )
      )
      order by subscription_row.stripe_event_created_at desc
    ),
    '[]'::jsonb
  )
  into v_subscriptions
  from private.organization_subscription_projections subscription_row
  where subscription_row.organization_id = p_organization_id;

  return pg_catalog.jsonb_build_object(
    'effective',
      private.resolve_organization_entitlements_at(
        p_organization_id,
        pg_catalog.now()
      ),
    'grants', v_grants,
    'subscriptions', v_subscriptions
  );
end;
$$;

revoke all on function
  public.api_admin_get_organization_entitlement_state(uuid)
  from public, anon, authenticated, service_role;
grant execute on function
  public.api_admin_get_organization_entitlement_state(uuid)
  to authenticated;

create or replace function public.api_admin_grant_organization_entitlement(
  p_organization_id uuid,
  p_grant_type text,
  p_starts_at timestamptz,
  p_expires_at timestamptz,
  p_review_at timestamptz,
  p_reason text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_actor_user_id uuid;
  v_scope text;
  v_lock_scope text;
  v_request jsonb;
  v_existing_event public.commercial_admin_audit_events%rowtype;
  v_before jsonb;
  v_after jsonb;
  v_superseded jsonb;
  v_grant_id uuid;
  v_event_id uuid;
begin
  v_actor_user_id :=
    private.require_commercial_admin_capability('billing_admin');

  if not exists (
    select 1
    from public.organizations organization_row
    where organization_row.id = p_organization_id
  ) then
    raise exception 'Organization was not found.';
  end if;

  if p_grant_type not in ('trial', 'complimentary') then
    raise exception 'Grant type must be trial or complimentary.';
  end if;

  if p_starts_at is null then
    raise exception 'Grant start time is required.';
  end if;

  if p_grant_type = 'trial'
    and (p_expires_at is null or p_expires_at <= p_starts_at)
  then
    raise exception 'Trial grants require an expiration after their start.';
  end if;

  if p_grant_type = 'complimentary'
    and (p_review_at is null or p_review_at <= p_starts_at)
  then
    raise exception 'Complimentary grants require a review date after their start.';
  end if;

  if p_expires_at is not null and p_expires_at <= p_starts_at then
    raise exception 'Grant expiration must be after its start.';
  end if;

  if nullif(trim(p_reason), '') is null then
    raise exception 'A reason is required for entitlement grants.';
  end if;

  if nullif(trim(p_idempotency_key), '') is null then
    raise exception 'An idempotency key is required for entitlement grants.';
  end if;

  v_scope :=
    'organization_entitlement_grant:'
    || p_organization_id::text
    || ':'
    || p_grant_type;
  v_lock_scope :=
    'organization_entitlement:'
    || p_organization_id::text;
  v_request := pg_catalog.jsonb_strip_nulls(
    pg_catalog.jsonb_build_object(
      'organizationId', p_organization_id,
      'grantType', p_grant_type,
      'startsAt', p_starts_at,
      'expiresAt', p_expires_at,
      'reviewAt', p_review_at
    )
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_lock_scope, 0)
  );

  select *
  into v_existing_event
  from public.commercial_admin_audit_events event_row
  where event_row.idempotency_scope = v_scope
    and event_row.idempotency_key = trim(p_idempotency_key);

  if v_existing_event.id is not null then
    if v_existing_event.actor_user_id is distinct from v_actor_user_id
      or v_existing_event.organization_id is distinct from p_organization_id
      or v_existing_event.action is distinct from
        'commercial.entitlement.grant'
      or v_existing_event.reason is distinct from trim(p_reason)
      or v_existing_event.request_metadata is distinct from v_request
    then
      raise exception 'Idempotency key has already been used for a different entitlement grant.';
    end if;

    return v_existing_event.after_state
      || pg_catalog.jsonb_build_object(
        'eventId', v_existing_event.id,
        'replayed', true
      );
  end if;

  v_before := pg_catalog.jsonb_build_object(
    'effective',
    private.resolve_organization_entitlements_at(
      p_organization_id,
      pg_catalog.now()
    )
  );

  with superseded as (
    update private.organization_entitlement_grants grant_row
    set
      revoked_at = pg_catalog.now(),
      revoked_by_user_id = v_actor_user_id,
      revocation_reason = 'Superseded by a newer ' || p_grant_type || ' grant'
    where grant_row.organization_id = p_organization_id
      and grant_row.grant_type = p_grant_type
      and grant_row.revoked_at is null
    returning grant_row.id
  )
  select coalesce(
    pg_catalog.jsonb_agg(superseded.id),
    '[]'::jsonb
  )
  into v_superseded
  from superseded;

  insert into private.organization_entitlement_grants (
    organization_id,
    grant_type,
    starts_at,
    expires_at,
    review_at,
    grant_reason,
    granted_by_user_id
  )
  values (
    p_organization_id,
    p_grant_type,
    p_starts_at,
    p_expires_at,
    p_review_at,
    trim(p_reason),
    v_actor_user_id
  )
  returning id into v_grant_id;

  v_after := pg_catalog.jsonb_build_object(
    'grantId', v_grant_id,
    'supersededGrantIds', v_superseded,
    'effective',
    private.resolve_organization_entitlements_at(
      p_organization_id,
      pg_catalog.now()
    )
  );

  v_event_id := private.append_commercial_admin_audit_event(
    p_organization_id,
    'billing_admin',
    'commercial.entitlement.grant',
    'organization_entitlement_grant',
    v_grant_id::text,
    trim(p_reason),
    v_before,
    v_after,
    v_request,
    v_scope,
    trim(p_idempotency_key)
  );

  return v_after
    || pg_catalog.jsonb_build_object(
      'eventId', v_event_id,
      'replayed', false
    );
end;
$$;

revoke all on function
  public.api_admin_grant_organization_entitlement(
    uuid,
    text,
    timestamptz,
    timestamptz,
    timestamptz,
    text,
    text
  )
  from public, anon, authenticated, service_role;
grant execute on function
  public.api_admin_grant_organization_entitlement(
    uuid,
    text,
    timestamptz,
    timestamptz,
    timestamptz,
    text,
    text
  )
  to authenticated;

create or replace function public.api_admin_revoke_organization_entitlement(
  p_grant_id uuid,
  p_reason text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_actor_user_id uuid;
  v_grant private.organization_entitlement_grants%rowtype;
  v_scope text;
  v_request jsonb;
  v_existing_event public.commercial_admin_audit_events%rowtype;
  v_before jsonb;
  v_after jsonb;
  v_event_id uuid;
begin
  v_actor_user_id :=
    private.require_commercial_admin_capability('billing_admin');

  if nullif(trim(p_reason), '') is null then
    raise exception 'A reason is required for entitlement revocation.';
  end if;

  if nullif(trim(p_idempotency_key), '') is null then
    raise exception 'An idempotency key is required for entitlement revocation.';
  end if;

  select *
  into v_grant
  from private.organization_entitlement_grants grant_row
  where grant_row.id = p_grant_id;

  if v_grant.id is null then
    raise exception 'Entitlement grant was not found.';
  end if;

  v_scope := 'organization_entitlement_revoke:' || p_grant_id::text;
  v_request := pg_catalog.jsonb_build_object('grantId', p_grant_id);

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'organization_entitlement:'
      || v_grant.organization_id::text,
      0
    )
  );

  select *
  into v_existing_event
  from public.commercial_admin_audit_events event_row
  where event_row.idempotency_scope = v_scope
    and event_row.idempotency_key = trim(p_idempotency_key);

  if v_existing_event.id is not null then
    if v_existing_event.actor_user_id is distinct from v_actor_user_id
      or v_existing_event.organization_id is distinct from
        v_grant.organization_id
      or v_existing_event.action is distinct from
        'commercial.entitlement.revoke'
      or v_existing_event.reason is distinct from trim(p_reason)
      or v_existing_event.request_metadata is distinct from v_request
    then
      raise exception 'Idempotency key has already been used for a different entitlement revocation.';
    end if;

    return v_existing_event.after_state
      || pg_catalog.jsonb_build_object(
        'eventId', v_existing_event.id,
        'replayed', true
      );
  end if;

  select *
  into v_grant
  from private.organization_entitlement_grants grant_row
  where grant_row.id = p_grant_id
  for update;

  if v_grant.revoked_at is not null then
    raise exception 'Entitlement grant is already revoked.';
  end if;

  v_before := pg_catalog.jsonb_build_object(
    'grant',
      pg_catalog.jsonb_build_object(
        'id', v_grant.id,
        'type', v_grant.grant_type,
        'startsAt', v_grant.starts_at,
        'expiresAt', v_grant.expires_at,
        'reviewAt', v_grant.review_at,
        'revokedAt', v_grant.revoked_at
      ),
    'effective',
      private.resolve_organization_entitlements_at(
        v_grant.organization_id,
        pg_catalog.now()
      )
  );

  update private.organization_entitlement_grants grant_row
  set
    revoked_at = pg_catalog.now(),
    revoked_by_user_id = v_actor_user_id,
    revocation_reason = trim(p_reason)
  where grant_row.id = p_grant_id
  returning * into v_grant;

  v_after := pg_catalog.jsonb_build_object(
    'grantId', v_grant.id,
    'revokedAt', v_grant.revoked_at,
    'effective',
      private.resolve_organization_entitlements_at(
        v_grant.organization_id,
        pg_catalog.now()
      )
  );

  v_event_id := private.append_commercial_admin_audit_event(
    v_grant.organization_id,
    'billing_admin',
    'commercial.entitlement.revoke',
    'organization_entitlement_grant',
    v_grant.id::text,
    trim(p_reason),
    v_before,
    v_after,
    v_request,
    v_scope,
    trim(p_idempotency_key)
  );

  return v_after
    || pg_catalog.jsonb_build_object(
      'eventId', v_event_id,
      'replayed', false
    );
end;
$$;

revoke all on function
  public.api_admin_revoke_organization_entitlement(uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function
  public.api_admin_revoke_organization_entitlement(uuid, text, text)
  to authenticated;

-- Rollback:
-- 1. Remove downstream callers of the entitlement APIs.
-- 2. Drop the public read/grant/revoke functions and private resolver.
-- 3. Drop organization_entitlement_grants and subscription projections.
-- 4. Drop organization_billing_accounts last.
-- The legacy project payment-intent table remains unrelated and untouched.
