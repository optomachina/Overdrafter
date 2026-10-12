-- OVD-725 Stripe tier catalog: DRAFT ONLY. Not a migration.
--
-- Planned for migration window 2, not window 1. Do not copy into supabase/migrations/ or apply to
-- any hosted project without the window's own review and Blaine's approval.
-- The edge functions on PR #671 call these RPCs:
--   billing-sessions -> public.api_configure_stripe_catalog_price
--   stripe-events    -> public.api_disable_stripe_catalog_price
-- Until this lands, Checkout stays refused (flags off, and the configure RPC is
-- missing) and a failed webhook disable is logged, not retried.
--
-- Founding Team slots are capped at 8 (docs/business/business-model.md) and
-- must match tiers.founding_team.maxTeams in
-- supabase/functions/_shared/billingCatalogPrices.json. A slot belongs to one
-- organization; claiming twice is a no-op and release frees it.
--
-- The Pro lookup key also mirrors into private.stripe_pro_price_allowlist via
-- the existing api_configure_stripe_pro_price so subscription processing keeps
-- granting Pro; disabling the key turns off checkout on that mirrored Price.
-- Team, Founding Team, and Jarvis entitlement processing is not built here.
--
-- Proof: supabase/tests/ovd725_stripe_catalog_draft.sql runs this exact DDL in
-- CI (scripts/run-supabase-policy-tests.mjs) inside a rolled back transaction.
-- Regenerate both files together so they cannot drift.

-- ===================== FORWARD =====================
begin;

create table private.stripe_catalog_price_allowlist (
  lookup_key text primary key,
  stripe_price_id text not null check (stripe_price_id ~ '^price_[A-Za-z0-9]+$'),
  livemode boolean not null,
  disabled_at timestamptz,
  disable_reason text,
  updated_at timestamptz not null default pg_catalog.now()
);

create table private.founding_team_claims (
  organization_id uuid primary key
    references public.organizations(id) on delete cascade,
  claimed_at timestamptz not null default pg_catalog.now()
);

-- Refuses a lookup key the webhook disabled; a disabled key stays disabled
-- until an operator clears disabled_at after review.
create function public.api_configure_stripe_catalog_price(
  p_livemode boolean,
  p_lookup_key text,
  p_stripe_price_id text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_lookup_key text := trim(p_lookup_key);
  v_disabled_at timestamptz;
begin
  if v_lookup_key is null or v_lookup_key = '' then
    raise exception using errcode = '22023', message = 'Lookup key is required.';
  end if;
  if p_livemode is null
    or p_stripe_price_id is null
    or p_stripe_price_id !~ '^price_[A-Za-z0-9]+$'
  then
    raise exception using errcode = '22023', message = 'Invalid catalog price.';
  end if;

  select disabled_at into v_disabled_at
  from private.stripe_catalog_price_allowlist
  where lookup_key = v_lookup_key
  for update;
  if v_disabled_at is not null then
    raise exception using errcode = '55000', message = 'Catalog price is disabled.';
  end if;

  insert into private.stripe_catalog_price_allowlist (
    lookup_key, stripe_price_id, livemode, disabled_at, disable_reason, updated_at
  ) values (
    v_lookup_key, trim(p_stripe_price_id), p_livemode, null, null, pg_catalog.now()
  )
  on conflict (lookup_key) do update
    set stripe_price_id = excluded.stripe_price_id,
        livemode = excluded.livemode,
        updated_at = pg_catalog.now();
  if v_lookup_key = 'od_pro_month_v1' then
    perform public.api_configure_stripe_pro_price(trim(p_stripe_price_id), p_livemode);
  end if;
end;
$$;

-- Marks the key disabled and, for Pro, turns off checkout on the mirrored
-- Price in the existing Pro allowlist.
create function public.api_disable_stripe_catalog_price(
  p_lookup_key text,
  p_livemode boolean,
  p_reason text,
  p_stripe_event_id text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_price_id text;
begin
  update private.stripe_catalog_price_allowlist
  set disabled_at = coalesce(disabled_at, pg_catalog.now()),
      disable_reason = left(coalesce(p_reason, 'catalog_mismatch'), 200),
      updated_at = pg_catalog.now()
  where lookup_key = trim(p_lookup_key)
    and livemode = p_livemode
  returning stripe_price_id into v_price_id;

  if trim(p_lookup_key) = 'od_pro_month_v1' and v_price_id is not null then
    update private.stripe_pro_price_allowlist
    set checkout_enabled = false,
        updated_at = pg_catalog.now()
    where stripe_price_id = v_price_id
      and livemode = p_livemode;
  end if;

  return pg_catalog.jsonb_build_object(
    'lookupKey', trim(p_lookup_key),
    'disabled', v_price_id is not null,
    'stripeEventId', p_stripe_event_id
  );
end;
$$;

-- One slot per organization, at most 8. Claiming twice is a no-op.
create function public.api_claim_founding_team_slot(p_organization_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_slots integer;
begin
  if p_organization_id is null then
    raise exception using errcode = '22023', message = 'Organization is required.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('founding_team_claims', 0)
  );

  if exists (
    select 1 from private.founding_team_claims
    where organization_id = p_organization_id
  ) then
    select pg_catalog.count(*) into v_slots from private.founding_team_claims;
    return pg_catalog.jsonb_build_object(
      'alreadyClaimed', true, 'slotsUsed', v_slots, 'maxSlots', 8
    );
  end if;

  select pg_catalog.count(*) into v_slots from private.founding_team_claims;
  if v_slots >= 8 then
    raise exception using
      errcode = '22023',
      message = 'Founding Team is at capacity.';
  end if;

  insert into private.founding_team_claims (organization_id)
  values (p_organization_id);

  return pg_catalog.jsonb_build_object(
    'alreadyClaimed', false, 'slotsUsed', v_slots + 1, 'maxSlots', 8
  );
end;
$$;

-- Frees the organization's slot when its Founding Team subscription ends.
create function public.api_release_founding_team_slot(p_organization_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_released boolean;
  v_slots integer;
begin
  if p_organization_id is null then
    raise exception using errcode = '22023', message = 'Organization is required.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('founding_team_claims', 0)
  );

  delete from private.founding_team_claims
  where organization_id = p_organization_id;
  v_released := found;

  select pg_catalog.count(*) into v_slots from private.founding_team_claims;
  return pg_catalog.jsonb_build_object(
    'released', v_released, 'slotsUsed', v_slots, 'maxSlots', 8
  );
end;
$$;

revoke all on function public.api_configure_stripe_catalog_price(boolean, text, text)
  from public, anon, authenticated;
revoke all on function public.api_disable_stripe_catalog_price(text, boolean, text, text)
  from public, anon, authenticated;
revoke all on function public.api_claim_founding_team_slot(uuid)
  from public, anon, authenticated;
revoke all on function public.api_release_founding_team_slot(uuid)
  from public, anon, authenticated;
revoke all on table private.stripe_catalog_price_allowlist
  from public, anon, authenticated, service_role;
revoke all on table private.founding_team_claims
  from public, anon, authenticated, service_role;
grant execute on function public.api_configure_stripe_catalog_price(boolean, text, text)
  to service_role;
grant execute on function public.api_disable_stripe_catalog_price(text, boolean, text, text)
  to service_role;
grant execute on function public.api_claim_founding_team_slot(uuid)
  to service_role;
grant execute on function public.api_release_founding_team_slot(uuid)
  to service_role;

commit;

-- ===================== ROLLBACK =====================
-- Run only if the forward block was applied and must be reverted. Rows mirrored
-- into private.stripe_pro_price_allowlist by the Pro lookup key stay; remove
-- them by Price ID only if that Price was never used for a subscription.
--
-- begin;
-- drop function if exists public.api_release_founding_team_slot(uuid);
-- drop function if exists public.api_claim_founding_team_slot(uuid);
-- drop function if exists public.api_disable_stripe_catalog_price(text, boolean, text, text);
-- drop function if exists public.api_configure_stripe_catalog_price(boolean, text, text);
-- drop table if exists private.founding_team_claims;
-- drop table if exists private.stripe_catalog_price_allowlist;
-- commit;
