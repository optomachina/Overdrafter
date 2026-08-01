-- OVD-228: organization-owned Stripe Checkout and Billing Portal sessions.
--
-- The oldest active membership is the launch billing owner. Internal
-- administrators retain billing-owner access. This gives every self-service
-- organization an unattended owner without widening internal application
-- roles or introducing launch-time account-administration UI.

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
      from public.organization_memberships membership
      where membership.organization_id = p_organization_id
        and membership.user_id = p_user_id
        and (
          membership.role = 'internal_admin'
          or membership.id = (
            select owner_membership.id
            from public.organization_memberships owner_membership
            where owner_membership.organization_id = p_organization_id
            order by
              owner_membership.created_at asc,
              owner_membership.id asc
            limit 1
          )
        )
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
        and subscription_row.status not in ('canceled', 'incomplete_expired')
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

  if v_organization_name is null then
    raise exception 'Organization was not found.';
  end if;

  insert into private.organization_billing_accounts (organization_id)
  values (p_organization_id)
  on conflict (organization_id) do nothing;

  select account_row.*
  into v_account
  from private.organization_billing_accounts account_row
  where account_row.organization_id = p_organization_id;

  return pg_catalog.jsonb_strip_nulls(
    pg_catalog.jsonb_build_object(
      'organizationId', p_organization_id,
      'organizationName', v_organization_name,
      'stripeCustomerId', v_account.stripe_customer_id,
      'stripeLivemode', v_account.stripe_livemode
    )
  );
end;
$$;

revoke all on function public.api_prepare_organization_billing_session(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.api_prepare_organization_billing_session(uuid)
  to authenticated;

alter table private.stripe_pro_price_allowlist
  add column if not exists checkout_enabled boolean not null default false;

create unique index if not exists stripe_pro_price_one_checkout_per_mode_idx
  on private.stripe_pro_price_allowlist (livemode)
  where checkout_enabled;

create or replace function public.api_configure_stripe_pro_price(
  p_stripe_price_id text,
  p_livemode boolean
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_price_id text := trim(p_stripe_price_id);
begin
  if v_price_id !~ '^price_[A-Za-z0-9]+$'
    or p_livemode is null
  then
    raise exception using
      errcode = '22023',
      message = 'A valid Stripe Price ID and mode are required.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'stripe_pro_launch_price:' || p_livemode::text,
      0
    )
  );

  update private.stripe_pro_price_allowlist price_row
  set
    checkout_enabled = false,
    updated_at = pg_catalog.now()
  where price_row.checkout_enabled
    and price_row.livemode = p_livemode;

  insert into private.stripe_pro_price_allowlist (
    stripe_price_id,
    livemode,
    checkout_enabled
  )
  values (
    v_price_id,
    p_livemode,
    true
  )
  on conflict (stripe_price_id) do update
    set livemode = excluded.livemode,
        checkout_enabled = true,
        updated_at = pg_catalog.now();

  return pg_catalog.jsonb_build_object(
    'stripePriceId', v_price_id,
    'livemode', p_livemode
  );
end;
$$;

revoke all on function public.api_configure_stripe_pro_price(text, boolean)
  from public, anon, authenticated;
grant execute on function public.api_configure_stripe_pro_price(text, boolean)
  to service_role;

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

  if not exists (
    select 1
    from public.organizations organization_row
    where organization_row.id = p_organization_id
  ) then
    raise exception 'Organization was not found.';
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

  insert into private.organization_billing_accounts (
    organization_id,
    stripe_customer_id,
    stripe_livemode
  )
  values (
    p_organization_id,
    v_customer_id,
    p_livemode
  )
  on conflict (organization_id) do update
    set
      stripe_customer_id = case
        when private.organization_billing_accounts.stripe_customer_id is null
          then excluded.stripe_customer_id
        else private.organization_billing_accounts.stripe_customer_id
      end,
      stripe_livemode = case
        when private.organization_billing_accounts.stripe_customer_id is null
          then excluded.stripe_livemode
        else private.organization_billing_accounts.stripe_livemode
      end,
      updated_at = pg_catalog.now()
  returning *
  into v_account;

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

create table private.organization_billing_checkout_reservations (
  organization_id uuid primary key
    references private.organization_billing_accounts(organization_id)
    on delete cascade,
  reservation_token uuid not null unique default pg_catalog.gen_random_uuid(),
  stripe_price_id text not null,
  stripe_livemode boolean not null,
  stripe_checkout_session_id text,
  expires_at timestamptz not null,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint organization_billing_checkout_price_check
    check (stripe_price_id ~ '^price_[A-Za-z0-9]+$'),
  constraint organization_billing_checkout_session_check
    check (
      stripe_checkout_session_id is null
      or stripe_checkout_session_id ~ '^cs_(test_|live_)?[A-Za-z0-9]+$'
    )
);

revoke all on private.organization_billing_checkout_reservations
  from public, anon, authenticated, service_role;

create or replace function public.api_acquire_organization_billing_checkout(
  p_organization_id uuid,
  p_actor_user_id uuid,
  p_stripe_price_id text,
  p_livemode boolean
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_price_id text := trim(p_stripe_price_id);
  v_reservation_token uuid;
  v_existing private.organization_billing_checkout_reservations%rowtype;
begin
  if p_organization_id is null
    or p_actor_user_id is null
    or v_price_id is null
    or v_price_id !~ '^price_[A-Za-z0-9]+$'
    or p_livemode is null
  then
    raise exception using
      errcode = '22023',
      message = 'A valid organization, actor, Stripe Price ID, and mode are required.';
  end if;

  if not private.user_can_manage_organization_billing(
    p_organization_id,
    p_actor_user_id
  ) then
    raise exception 'Billing actor is not an organization billing owner.';
  end if;

  if not exists (
    select 1
    from private.organization_billing_accounts account_row
    where account_row.organization_id = p_organization_id
      and account_row.stripe_customer_id is not null
      and account_row.stripe_livemode = p_livemode
  ) then
    raise exception 'Organization does not have a verified Stripe customer.';
  end if;

  if not exists (
    select 1
    from private.stripe_pro_price_allowlist price_row
    where price_row.stripe_price_id = v_price_id
      and price_row.livemode = p_livemode
      and price_row.checkout_enabled
  ) then
    raise exception 'Stripe Price is not the active Checkout price.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'organization_billing_checkout:' || p_organization_id::text,
      0
    )
  );

  delete from private.organization_billing_checkout_reservations reservation_row
  where reservation_row.organization_id = p_organization_id
    and reservation_row.expires_at <= pg_catalog.now();

  select reservation_row.*
  into v_existing
  from private.organization_billing_checkout_reservations reservation_row
  where reservation_row.organization_id = p_organization_id;

  if v_existing.reservation_token is not null then
    return pg_catalog.jsonb_strip_nulls(
      pg_catalog.jsonb_build_object(
        'acquired', false,
        'reservationToken', v_existing.reservation_token,
        'stripeCheckoutSessionId', v_existing.stripe_checkout_session_id,
        'retryAfterSeconds',
          greatest(
            1,
            ceil(
              extract(epoch from (v_existing.expires_at - pg_catalog.now()))
            )::integer
          )
      )
    );
  end if;

  insert into private.organization_billing_checkout_reservations (
    organization_id,
    stripe_price_id,
    stripe_livemode,
    expires_at
  )
  values (
    p_organization_id,
    v_price_id,
    p_livemode,
    pg_catalog.now() + interval '2 minutes'
  )
  returning reservation_token into v_reservation_token;

  return pg_catalog.jsonb_build_object(
    'acquired', true,
    'reservationToken', v_reservation_token,
    'retryAfterSeconds', 0
  );
end;
$$;

revoke all on function public.api_acquire_organization_billing_checkout(
  uuid,
  uuid,
  text,
  boolean
) from public, anon, authenticated;
grant execute on function public.api_acquire_organization_billing_checkout(
  uuid,
  uuid,
  text,
  boolean
) to service_role;

create or replace function public.api_finalize_organization_billing_checkout(
  p_organization_id uuid,
  p_reservation_token uuid,
  p_stripe_checkout_session_id text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_session_id text := trim(p_stripe_checkout_session_id);
  v_reservation private.organization_billing_checkout_reservations%rowtype;
begin
  if p_organization_id is null
    or p_reservation_token is null
    or v_session_id is null
    or v_session_id !~ '^cs_(test_|live_)?[A-Za-z0-9]+$'
  then
    raise exception using
      errcode = '22023',
      message = 'A valid Checkout reservation and Session ID are required.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'organization_billing_checkout:' || p_organization_id::text,
      0
    )
  );

  update private.organization_billing_checkout_reservations reservation_row
  set
    stripe_checkout_session_id = v_session_id,
    expires_at = pg_catalog.now() + interval '2 minutes',
    updated_at = pg_catalog.now()
  where reservation_row.organization_id = p_organization_id
    and reservation_row.reservation_token = p_reservation_token
    and (
      reservation_row.stripe_checkout_session_id is null
      or reservation_row.stripe_checkout_session_id = v_session_id
    )
  returning * into v_reservation;

  if v_reservation.reservation_token is null then
    raise exception 'Checkout reservation could not be finalized.';
  end if;

  return pg_catalog.jsonb_build_object(
    'organizationId', v_reservation.organization_id,
    'reservationToken', v_reservation.reservation_token,
    'stripeCheckoutSessionId', v_reservation.stripe_checkout_session_id
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

create or replace function public.api_release_organization_billing_checkout(
  p_organization_id uuid,
  p_reservation_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_deleted_count integer;
begin
  if p_organization_id is null or p_reservation_token is null then
    raise exception using
      errcode = '22023',
      message = 'A valid Checkout reservation is required.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'organization_billing_checkout:' || p_organization_id::text,
      0
    )
  );

  delete from private.organization_billing_checkout_reservations reservation_row
  where reservation_row.organization_id = p_organization_id
    and reservation_row.reservation_token = p_reservation_token
    and reservation_row.stripe_checkout_session_id is null;

  get diagnostics v_deleted_count = row_count;
  return v_deleted_count = 1;
end;
$$;

revoke all on function public.api_release_organization_billing_checkout(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.api_release_organization_billing_checkout(uuid, uuid)
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

  if tg_op = 'UPDATE'
    and (
      old.event_type = any(v_billing_event_types)
      or new.event_type = any(v_billing_event_types)
    )
  then
    raise exception using
      errcode = '42501',
      message = 'Billing audit events are append-only.';
  end if;

  if tg_op = 'DELETE' then
    if old.event_type = any(v_billing_event_types)
      and pg_catalog.pg_trigger_depth() <= 1
    then
      raise exception using
        errcode = '42501',
        message = 'Billing audit events are append-only.';
    end if;
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
  p_stripe_checkout_session_id text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_session_id text := trim(p_stripe_checkout_session_id);
  v_event_id uuid;
begin
  if v_session_id !~ '^cs_(test_|live_)?[A-Za-z0-9]+$' then
    raise exception using
      errcode = '22023',
      message = 'A valid Stripe Checkout Session ID is required.';
  end if;

  if not private.user_can_manage_organization_billing(
    p_organization_id,
    p_actor_user_id
  ) then
    raise exception 'Billing actor is not an organization billing owner.';
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
      'plan', 'pro',
      'billingInterval', 'month'
    )
  )
  returning id into v_event_id;

  return v_event_id;
end;
$$;

revoke all on function public.api_record_billing_checkout_started(
  uuid,
  uuid,
  text
) from public, anon, authenticated;
grant execute on function public.api_record_billing_checkout_started(
  uuid,
  uuid,
  text
) to service_role;

create or replace function private.audit_subscription_activation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if new.status = 'active'
    and (
      tg_op = 'INSERT'
      or old.status is distinct from 'active'
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

-- Rollback:
-- 1. Disable the billing-sessions Edge Function.
-- 2. Drop audit_subscription_activation, guard_billing_audit_events, and
--    their private trigger functions.
-- 3. Revoke/drop the seven public billing-session, reservation, and audit
--    recording functions.
-- 4. Drop private.organization_billing_checkout_reservations.
-- 5. Drop stripe_pro_price_one_checkout_per_mode_idx and remove
--    private.stripe_pro_price_allowlist.checkout_enabled only after restoring
--    the prior price-configuration function. Preserve historical allowlist
--    rows while Stripe subscriptions still reference them.
-- 6. Restore api_get_organization_entitlements from OVD-229.
-- 7. Drop private.user_can_manage_organization_billing.
