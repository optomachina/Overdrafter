-- OVD-725 Stripe tier catalog: DRAFT ONLY. Not a migration.
--
-- Joins migration window 1. Do not copy into supabase/migrations/ or apply to
-- any hosted project without the window's own review and Blaine's approval.
-- The edge functions on PR #671 call these RPCs:
--   billing-sessions -> public.api_configure_stripe_catalog_price
--   stripe-events    -> public.api_disable_stripe_catalog_price
-- Until this lands, Checkout stays refused (flags off, and the configure RPC is
-- missing) and the webhook disable call fails closed only when the tier catalog
-- flag is on.
--
-- Founding Team slots are capped at 8 (docs/business/business-model.md).
-- The cap must match tiers.founding_team.maxTeams in
-- supabase/functions/_shared/billingCatalogPrices.json.
--
-- The Pro lookup key also mirrors into private.stripe_pro_price_allowlist via
-- the existing api_configure_stripe_pro_price so subscription processing keeps
-- granting Pro. Team, Founding Team, and Jarvis entitlement processing is not
-- built here.
--
-- Proof: supabase/tests/ovd725_stripe_catalog_draft.sql (pgTAP, rolls back).

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

create table private.founding_team_slots (
  id boolean primary key default true check (id),
  slots_used integer not null default 0 check (slots_used >= 0 and slots_used <= 8)
);

insert into private.founding_team_slots (id, slots_used)
values (true, 0)
on conflict (id) do nothing;

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
begin
  if p_lookup_key is null
    or p_livemode is null
    or p_stripe_price_id !~ '^price_[A-Za-z0-9]+$'
  then
    raise exception using errcode = '22023', message = 'Invalid catalog price.';
  end if;
  insert into private.stripe_catalog_price_allowlist (
    lookup_key, stripe_price_id, livemode, disabled_at, disable_reason, updated_at
  ) values (
    trim(p_lookup_key), trim(p_stripe_price_id), p_livemode, null, null, pg_catalog.now()
  )
  on conflict (lookup_key) do update
    set stripe_price_id = excluded.stripe_price_id,
        livemode = excluded.livemode,
        updated_at = pg_catalog.now();
  if trim(p_lookup_key) = 'od_pro_month_v1' then
    perform public.api_configure_stripe_pro_price(trim(p_stripe_price_id), p_livemode);
  end if;
end;
$$;

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
begin
  update private.stripe_catalog_price_allowlist
  set disabled_at = pg_catalog.now(),
      disable_reason = left(coalesce(p_reason, 'catalog_mismatch'), 200),
      updated_at = pg_catalog.now()
  where lookup_key = trim(p_lookup_key)
    and livemode = p_livemode;
  return pg_catalog.jsonb_build_object(
    'lookupKey', trim(p_lookup_key),
    'disabled', true,
    'stripeEventId', p_stripe_event_id
  );
end;
$$;

create function public.api_claim_founding_team_slot()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_slots integer;
begin
  update private.founding_team_slots
  set slots_used = slots_used + 1
  where id
    and slots_used < 8
  returning slots_used into v_slots;

  if v_slots is null then
    raise exception using
      errcode = '22023',
      message = 'Founding Team is at capacity.';
  end if;

  return pg_catalog.jsonb_build_object('slotsUsed', v_slots, 'maxSlots', 8);
end;
$$;

revoke all on function public.api_configure_stripe_catalog_price(boolean, text, text)
  from public, anon, authenticated;
revoke all on function public.api_disable_stripe_catalog_price(text, boolean, text, text)
  from public, anon, authenticated;
revoke all on function public.api_claim_founding_team_slot()
  from public, anon, authenticated;
revoke all on table private.stripe_catalog_price_allowlist
  from public, anon, authenticated;
revoke all on table private.founding_team_slots
  from public, anon, authenticated;
grant execute on function public.api_configure_stripe_catalog_price(boolean, text, text)
  to service_role;
grant execute on function public.api_disable_stripe_catalog_price(text, boolean, text, text)
  to service_role;
grant execute on function public.api_claim_founding_team_slot()
  to service_role;

commit;

-- ===================== ROLLBACK =====================
-- Run only if the forward block was applied and must be reverted. Rows mirrored
-- into private.stripe_pro_price_allowlist by the Pro lookup key stay; remove
-- them by Price ID only if that Price was never used for a subscription.
--
-- begin;
-- drop function if exists public.api_claim_founding_team_slot();
-- drop function if exists public.api_disable_stripe_catalog_price(text, boolean, text, text);
-- drop function if exists public.api_configure_stripe_catalog_price(boolean, text, text);
-- drop table if exists private.founding_team_slots;
-- drop table if exists private.stripe_catalog_price_allowlist;
-- commit;
