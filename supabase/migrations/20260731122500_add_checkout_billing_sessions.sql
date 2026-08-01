-- OVD-292: server-owned monthly/annual Pro Checkout and Billing Portal.
--
-- Stripe remains economic truth. The signed-webhook projection plus active
-- grants remains access truth; a successful Checkout redirect never grants Pro.

alter table private.organization_billing_accounts
  add column billing_owner_membership_id uuid
    references public.organization_memberships(id) on delete restrict;

create index organization_billing_accounts_owner_idx
  on private.organization_billing_accounts (billing_owner_membership_id)
  where billing_owner_membership_id is not null;

insert into private.organization_billing_accounts (
  organization_id,
  billing_owner_membership_id
)
select
  organization_row.id,
  owner_membership.id
from public.organizations organization_row
join lateral (
  select membership.id
  from public.organization_memberships membership
  where membership.organization_id = organization_row.id
    and membership.role = 'client'
  order by membership.created_at asc, membership.id asc
  limit 1
) owner_membership on true
on conflict (organization_id) do update
  set billing_owner_membership_id = excluded.billing_owner_membership_id,
      updated_at = pg_catalog.now()
  where private.organization_billing_accounts.billing_owner_membership_id
    is null;

create or replace function private.assign_initial_organization_billing_owner()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if new.role = 'client' then
    insert into private.organization_billing_accounts (
      organization_id,
      billing_owner_membership_id
    )
    values (new.organization_id, new.id)
    on conflict (organization_id) do update
      set billing_owner_membership_id = excluded.billing_owner_membership_id,
          updated_at = pg_catalog.now()
      where private.organization_billing_accounts.billing_owner_membership_id
        is null;
  end if;

  return new;
end;
$$;

revoke all on function private.assign_initial_organization_billing_owner()
  from public, anon, authenticated, service_role;

drop trigger if exists assign_initial_organization_billing_owner
  on public.organization_memberships;
create trigger assign_initial_organization_billing_owner
after insert on public.organization_memberships
for each row execute function private.assign_initial_organization_billing_owner();

create or replace function private.user_can_manage_organization_billing(
  p_organization_id uuid,
  p_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select
    p_organization_id is not null
    and p_user_id is not null
    and exists (
      select 1
      from private.organization_billing_accounts account_row
      join public.organization_memberships membership
        on membership.id = account_row.billing_owner_membership_id
      where account_row.organization_id = p_organization_id
        and membership.organization_id = p_organization_id
        and membership.user_id = p_user_id
        and membership.role = 'client'
    );
$$;

revoke all on function private.user_can_manage_organization_billing(uuid, uuid)
  from public, anon, authenticated, service_role;

create or replace function public.api_get_organization_entitlements(
  p_organization_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  v_entitlements jsonb;
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

  v_entitlements := private.resolve_organization_entitlements_at(
    p_organization_id,
    pg_catalog.now()
  );

  return v_entitlements || pg_catalog.jsonb_build_object(
    'canManageBilling',
    private.user_can_manage_organization_billing(
      p_organization_id,
      auth.uid()
    ),
    'hasStripeSubscription',
    exists (
      select 1
      from private.organization_subscription_projections subscription_row
      where subscription_row.organization_id = p_organization_id
    )
  );
end;
$$;

revoke all on function public.api_get_organization_entitlements(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.api_get_organization_entitlements(uuid)
  to authenticated;

create or replace function public.api_prepare_organization_billing_session(
  p_organization_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_organization_name text;
  v_account private.organization_billing_accounts%rowtype;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in to manage organization billing.';
  end if;

  if not private.user_can_manage_organization_billing(
    p_organization_id,
    auth.uid()
  ) then
    raise exception 'Only the organization billing owner can manage this subscription.';
  end if;

  select organization_row.name
  into v_organization_name
  from public.organizations organization_row
  where organization_row.id = p_organization_id;

  select account_row.*
  into v_account
  from private.organization_billing_accounts account_row
  where account_row.organization_id = p_organization_id;

  if v_organization_name is null or v_account.organization_id is null then
    raise exception 'Organization billing account was not found.';
  end if;

  return pg_catalog.jsonb_strip_nulls(
    pg_catalog.jsonb_build_object(
      'organizationId', p_organization_id,
      'organizationName', v_organization_name,
      'stripeCustomerId', v_account.stripe_customer_id,
      'stripeLivemode', v_account.stripe_livemode,
      'hasStripeSubscription',
      exists (
        select 1
        from private.organization_subscription_projections subscription_row
        where subscription_row.organization_id = p_organization_id
      )
    )
  );
end;
$$;

revoke all on function public.api_prepare_organization_billing_session(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.api_prepare_organization_billing_session(uuid)
  to authenticated;

create table private.stripe_pro_checkout_catalog (
  billing_interval text primary key,
  lookup_key text not null unique,
  stripe_price_id text not null unique,
  livemode boolean not null,
  updated_at timestamptz not null default now(),
  constraint stripe_pro_checkout_catalog_interval_check
    check (billing_interval in ('month', 'year')),
  constraint stripe_pro_checkout_catalog_lookup_check
    check (
      (billing_interval = 'month'
        and lookup_key = 'overdrafter_pro_monthly_v1')
      or
      (billing_interval = 'year'
        and lookup_key = 'overdrafter_pro_annual_v1')
    ),
  constraint stripe_pro_checkout_catalog_price_check
    check (stripe_price_id ~ '^price_[A-Za-z0-9]+$')
);

revoke all on private.stripe_pro_checkout_catalog
  from public, anon, authenticated, service_role;
grant select, insert, update on private.stripe_pro_checkout_catalog
  to service_role;

create or replace function public.api_configure_stripe_pro_catalog(
  p_monthly_stripe_price_id text,
  p_annual_stripe_price_id text,
  p_livemode boolean
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_monthly_price_id text := trim(p_monthly_stripe_price_id);
  v_annual_price_id text := trim(p_annual_stripe_price_id);
begin
  if v_monthly_price_id !~ '^price_[A-Za-z0-9]+$'
    or v_annual_price_id !~ '^price_[A-Za-z0-9]+$'
    or v_monthly_price_id = v_annual_price_id
    or p_livemode is null
  then
    raise exception using
      errcode = '22023',
      message = 'Distinct monthly and annual Stripe Price IDs and a mode are required.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stripe_pro_checkout_catalog', 0)
  );

  if exists (
    select 1
    from private.stripe_pro_price_allowlist price_row
    where price_row.stripe_price_id in (
      v_monthly_price_id,
      v_annual_price_id
    )
      and price_row.livemode is distinct from p_livemode
  ) then
    raise exception 'Stripe Price mode conflicts with the historical allowlist.';
  end if;

  insert into private.stripe_pro_price_allowlist (
    stripe_price_id,
    livemode
  )
  values
    (v_monthly_price_id, p_livemode),
    (v_annual_price_id, p_livemode)
  on conflict (stripe_price_id) do update
    set livemode = excluded.livemode,
        updated_at = pg_catalog.now();

  insert into private.stripe_pro_checkout_catalog (
    billing_interval,
    lookup_key,
    stripe_price_id,
    livemode
  )
  values
    (
      'month',
      'overdrafter_pro_monthly_v1',
      v_monthly_price_id,
      p_livemode
    ),
    (
      'year',
      'overdrafter_pro_annual_v1',
      v_annual_price_id,
      p_livemode
    )
  on conflict (billing_interval) do update
    set lookup_key = excluded.lookup_key,
        stripe_price_id = excluded.stripe_price_id,
        livemode = excluded.livemode,
        updated_at = pg_catalog.now();

  return pg_catalog.jsonb_build_object(
    'monthlyStripePriceId', v_monthly_price_id,
    'annualStripePriceId', v_annual_price_id,
    'livemode', p_livemode
  );
end;
$$;

revoke all on function public.api_configure_stripe_pro_catalog(
  text,
  text,
  boolean
) from public, anon, authenticated;
grant execute on function public.api_configure_stripe_pro_catalog(
  text,
  text,
  boolean
) to service_role;

create table private.organization_billing_checkout_intents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null
    references private.organization_billing_accounts(organization_id)
    on delete cascade,
  livemode boolean not null,
  billing_interval text not null,
  catalog_key text not null,
  state text not null default 'pending',
  stripe_checkout_session_id text,
  lease_expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organization_billing_checkout_interval_check
    check (billing_interval in ('month', 'year')),
  constraint organization_billing_checkout_catalog_check
    check (
      (billing_interval = 'month'
        and catalog_key = 'overdrafter_pro_monthly_v1')
      or
      (billing_interval = 'year'
        and catalog_key = 'overdrafter_pro_annual_v1')
    ),
  constraint organization_billing_checkout_state_check
    check (state in ('pending', 'open', 'expired', 'failed', 'completed')),
  constraint organization_billing_checkout_session_check
    check (
      stripe_checkout_session_id is null
      or stripe_checkout_session_id ~ '^cs_(test_|live_)?[A-Za-z0-9]+$'
    ),
  constraint organization_billing_checkout_open_session_check
    check (state <> 'open' or stripe_checkout_session_id is not null)
);

create unique index organization_billing_checkout_active_unique
  on private.organization_billing_checkout_intents (
    organization_id,
    livemode
  )
  where state in ('pending', 'open');

create index organization_billing_checkout_expiry_idx
  on private.organization_billing_checkout_intents (lease_expires_at)
  where state in ('pending', 'open');

revoke all on private.organization_billing_checkout_intents
  from public, anon, authenticated, service_role;
grant select, insert, update on private.organization_billing_checkout_intents
  to service_role;

create or replace function public.api_acquire_organization_billing_checkout(
  p_organization_id uuid,
  p_livemode boolean,
  p_billing_interval text,
  p_catalog_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_interval text := trim(p_billing_interval);
  v_catalog_key text := trim(p_catalog_key);
  v_intent private.organization_billing_checkout_intents%rowtype;
begin
  if p_organization_id is null
    or p_livemode is null
    or not (
      (v_interval = 'month'
        and v_catalog_key = 'overdrafter_pro_monthly_v1')
      or
      (v_interval = 'year'
        and v_catalog_key = 'overdrafter_pro_annual_v1')
    )
  then
    raise exception using
      errcode = '22023',
      message = 'A valid organization, mode, interval, and catalog key are required.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'organization_billing_checkout:'
        || p_organization_id::text
        || ':'
        || p_livemode::text,
      0
    )
  );

  update private.organization_billing_checkout_intents intent_row
  set state = 'expired',
      updated_at = pg_catalog.now()
  where intent_row.organization_id = p_organization_id
    and intent_row.livemode = p_livemode
    and intent_row.state in ('pending', 'open')
    and intent_row.lease_expires_at <= pg_catalog.now();

  select intent_row.*
  into v_intent
  from private.organization_billing_checkout_intents intent_row
  where intent_row.organization_id = p_organization_id
    and intent_row.livemode = p_livemode
    and intent_row.state in ('pending', 'open')
  order by intent_row.created_at desc, intent_row.id desc
  limit 1
  for update;

  if v_intent.id is not null then
    return pg_catalog.jsonb_build_object(
      'acquired',
      v_intent.billing_interval = v_interval
        and v_intent.catalog_key = v_catalog_key,
      'intentId', v_intent.id,
      'resumed', true,
      'state', v_intent.state,
      'billingInterval', v_intent.billing_interval
    );
  end if;

  insert into private.organization_billing_checkout_intents (
    organization_id,
    livemode,
    billing_interval,
    catalog_key,
    state,
    lease_expires_at
  )
  values (
    p_organization_id,
    p_livemode,
    v_interval,
    v_catalog_key,
    'pending',
    pg_catalog.now() + interval '5 minutes'
  )
  returning * into v_intent;

  return pg_catalog.jsonb_build_object(
    'acquired', true,
    'intentId', v_intent.id,
    'resumed', false,
    'state', v_intent.state,
    'billingInterval', v_intent.billing_interval
  );
end;
$$;

revoke all on function public.api_acquire_organization_billing_checkout(
  uuid,
  boolean,
  text,
  text
) from public, anon, authenticated;
grant execute on function public.api_acquire_organization_billing_checkout(
  uuid,
  boolean,
  text,
  text
) to service_role;

create or replace function public.api_finalize_organization_billing_checkout(
  p_organization_id uuid,
  p_intent_id uuid,
  p_stripe_checkout_session_id text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_session_id text := trim(p_stripe_checkout_session_id);
  v_intent private.organization_billing_checkout_intents%rowtype;
begin
  if v_session_id !~ '^cs_(test_|live_)?[A-Za-z0-9]+$' then
    raise exception using
      errcode = '22023',
      message = 'A valid Stripe Checkout Session ID is required.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'organization_billing_checkout:' || p_organization_id::text,
      0
    )
  );

  select intent_row.*
  into v_intent
  from private.organization_billing_checkout_intents intent_row
  where intent_row.id = p_intent_id
    and intent_row.organization_id = p_organization_id
    and intent_row.state in ('pending', 'open')
  for update;

  if v_intent.id is null then
    raise exception 'Billing Checkout intent was not found or is no longer active.';
  end if;
  if v_intent.stripe_checkout_session_id is not null
    and v_intent.stripe_checkout_session_id <> v_session_id
  then
    raise exception 'Billing Checkout intent is bound to a different Stripe Session.';
  end if;

  update private.organization_billing_checkout_intents intent_row
  set state = 'open',
      stripe_checkout_session_id = v_session_id,
      lease_expires_at = pg_catalog.now() + interval '24 hours',
      updated_at = pg_catalog.now()
  where intent_row.id = p_intent_id
  returning * into v_intent;

  return pg_catalog.jsonb_build_object(
    'intentId', v_intent.id,
    'state', v_intent.state,
    'stripeCheckoutSessionId', v_intent.stripe_checkout_session_id
  );
end;
$$;

revoke all on function public.api_finalize_organization_billing_checkout(
  uuid,
  uuid,
  text
) from public, anon, authenticated;
grant execute on function public.api_finalize_organization_billing_checkout(
  uuid,
  uuid,
  text
) to service_role;

create or replace function public.api_bind_organization_stripe_customer(
  p_organization_id uuid,
  p_stripe_customer_id text,
  p_livemode boolean
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_customer_id text := trim(p_stripe_customer_id);
  v_account private.organization_billing_accounts%rowtype;
begin
  if v_customer_id !~ '^cus_[A-Za-z0-9]+$'
    or p_livemode is null
  then
    raise exception using
      errcode = '22023',
      message = 'A valid Stripe customer and mode are required.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'organization_stripe_customer:' || p_organization_id::text,
      0
    )
  );

  if exists (
    select 1
    from private.organization_billing_accounts account_row
    where account_row.stripe_customer_id = v_customer_id
      and account_row.organization_id <> p_organization_id
  ) then
    raise exception 'Stripe customer is already bound to another organization.';
  end if;

  update private.organization_billing_accounts account_row
  set stripe_customer_id = coalesce(
        account_row.stripe_customer_id,
        v_customer_id
      ),
      stripe_livemode = case
        when account_row.stripe_customer_id is null then p_livemode
        else account_row.stripe_livemode
      end,
      updated_at = pg_catalog.now()
  where account_row.organization_id = p_organization_id
  returning * into v_account;

  if v_account.organization_id is null then
    raise exception 'Organization billing account was not found.';
  end if;
  if v_account.stripe_customer_id is distinct from v_customer_id
    or v_account.stripe_livemode is distinct from p_livemode
  then
    raise exception 'Organization is already bound to a different Stripe customer or mode.';
  end if;

  return pg_catalog.jsonb_build_object(
    'organizationId', p_organization_id,
    'stripeCustomerId', v_account.stripe_customer_id,
    'stripeLivemode', v_account.stripe_livemode
  );
end;
$$;

revoke all on function public.api_bind_organization_stripe_customer(
  uuid,
  text,
  boolean
) from public, anon, authenticated;
grant execute on function public.api_bind_organization_stripe_customer(
  uuid,
  text,
  boolean
) to service_role;

revoke all on function public.log_audit_event(uuid, text, jsonb, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.log_audit_event(uuid, text, jsonb, uuid, uuid)
  to service_role;

create or replace function private.guard_billing_audit_events()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_billing_event_types constant text[] := array[
    'billing.upgrade_started',
    'billing.subscription_activated'
  ];
begin
  if tg_op = 'INSERT' then
    if new.event_type = any(v_billing_event_types)
      and coalesce(auth.role(), '') <> 'service_role'
      and not (
        new.event_type = 'billing.subscription_activated'
        and pg_catalog.pg_trigger_depth() > 1
      )
    then
      raise exception using
        errcode = '42501',
        message = 'Billing audit events may only be appended by the billing service.';
    end if;
    return new;
  end if;

  if old.event_type = any(v_billing_event_types)
    and not (
      tg_op = 'DELETE'
      and pg_catalog.pg_trigger_depth() > 1
    )
  then
    raise exception using
      errcode = '42501',
      message = 'Billing audit events are append-only.';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function private.guard_billing_audit_events()
  from public, anon, authenticated, service_role;

drop trigger if exists guard_billing_audit_events on public.audit_events;
create trigger guard_billing_audit_events
before insert or update or delete on public.audit_events
for each row execute function private.guard_billing_audit_events();

create or replace function public.api_record_billing_checkout_started(
  p_organization_id uuid,
  p_actor_user_id uuid,
  p_stripe_checkout_session_id text,
  p_billing_interval text,
  p_stripe_price_id text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_session_id text := trim(p_stripe_checkout_session_id);
  v_interval text := trim(p_billing_interval);
  v_price_id text := trim(p_stripe_price_id);
  v_event_id uuid;
begin
  if v_session_id !~ '^cs_(test_|live_)?[A-Za-z0-9]+$'
    or v_interval not in ('month', 'year')
    or v_price_id !~ '^price_[A-Za-z0-9]+$'
  then
    raise exception using
      errcode = '22023',
      message = 'A valid Checkout Session, interval, and Price are required.';
  end if;

  if not private.user_can_manage_organization_billing(
    p_organization_id,
    p_actor_user_id
  ) then
    raise exception 'Billing actor is not the organization billing owner.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'billing_checkout_session:' || v_session_id,
      0
    )
  );

  select audit_event.id
  into v_event_id
  from public.audit_events audit_event
  where audit_event.organization_id = p_organization_id
    and audit_event.actor_user_id = p_actor_user_id
    and audit_event.event_type = 'billing.upgrade_started'
    and audit_event.payload ->> 'stripeCheckoutSessionId' = v_session_id
  order by audit_event.created_at asc, audit_event.id asc
  limit 1;

  if v_event_id is not null then
    return v_event_id;
  end if;

  insert into public.audit_events (
    organization_id,
    actor_user_id,
    event_type,
    payload
  )
  values (
    p_organization_id,
    p_actor_user_id,
    'billing.upgrade_started',
    pg_catalog.jsonb_build_object(
      'stripeCheckoutSessionId', v_session_id,
      'stripePriceId', v_price_id,
      'plan', 'pro',
      'billingInterval', v_interval
    )
  )
  returning id into v_event_id;

  return v_event_id;
end;
$$;

revoke all on function public.api_record_billing_checkout_started(
  uuid,
  uuid,
  text,
  text,
  text
) from public, anon, authenticated;
grant execute on function public.api_record_billing_checkout_started(
  uuid,
  uuid,
  text,
  text,
  text
) to service_role;

create or replace function private.audit_subscription_activation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if new.status in ('active', 'trialing')
    and (
      tg_op = 'INSERT'
      or old.status not in ('active', 'trialing')
    )
  then
    insert into public.audit_events (
      organization_id,
      actor_user_id,
      event_type,
      payload
    )
    values (
      new.organization_id,
      null,
      'billing.subscription_activated',
      pg_catalog.jsonb_strip_nulls(
        pg_catalog.jsonb_build_object(
          'stripeSubscriptionId', new.stripe_subscription_id,
          'stripePriceId', new.stripe_price_id,
          'stripeEventId', new.stripe_event_id,
          'billingInterval', new.billing_interval,
          'status', new.status,
          'livemode', new.stripe_livemode
        )
      )
    );
  end if;

  return new;
end;
$$;

revoke all on function private.audit_subscription_activation()
  from public, anon, authenticated, service_role;

drop trigger if exists audit_subscription_activation
  on private.organization_subscription_projections;
create trigger audit_subscription_activation
after insert or update of status
on private.organization_subscription_projections
for each row
execute function private.audit_subscription_activation();

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
    and exists (
      select 1
      from private.stripe_pro_price_allowlist price_row
      where price_row.stripe_price_id = subscription_row.stripe_price_id
        and price_row.livemode = subscription_row.stripe_livemode
    )
    and (
      (
        subscription_row.status in ('active', 'trialing')
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
            when 'trialing' then 'subscription_trialing'
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
      'organizationExists', true
    );
end;
$$;

-- Rollback notes:
-- 1. Disable BILLING_SELF_SERVICE_ENABLED before reverting this migration.
-- 2. Keep stripe_pro_price_allowlist rows: existing webhook projections depend
--    on that historical entitlement allowlist and removing rows can revoke Pro.
-- 3. Drop the Checkout/activation triggers and their private functions; drop
--    the intent/catalog tables and public billing-session RPCs.
-- 4. Restore api_get_organization_entitlements and
--    resolve_organization_entitlements_at from the immediately prior migration.
-- 5. Re-grant log_audit_event only if the legacy security exposure is explicitly
--    accepted; retaining the revocation is the safe rollback behavior.
