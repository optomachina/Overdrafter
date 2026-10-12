begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(8);

-- DRAFT ONLY. Not a migration. SECURITY DEFINER, pinned search_path.
-- EXECUTE revoked from PUBLIC, anon, and authenticated; grant to service_role only.

create table if not exists private.stripe_catalog_price_allowlist (
  lookup_key text primary key,
  stripe_price_id text not null check (stripe_price_id ~ '^price_[A-Za-z0-9]+$'),
  livemode boolean not null,
  disabled_at timestamptz,
  disable_reason text,
  updated_at timestamptz not null default pg_catalog.now()
);

create table if not exists private.founding_team_slots (
  id boolean primary key default true check (id),
  slots_used integer not null default 0 check (slots_used >= 0 and slots_used <= 12)
);

insert into private.founding_team_slots (id, slots_used)
values (true, 0)
on conflict (id) do nothing;

create or replace function public.api_configure_stripe_catalog_price(
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
  if p_lookup_key is null or p_stripe_price_id !~ '^price_[A-Za-z0-9]+$' then
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
end;
$$;

create or replace function public.api_disable_stripe_catalog_price(
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

create or replace function public.api_claim_founding_team_slot()
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
    and slots_used < 12
  returning slots_used into v_slots;

  if v_slots is null then
    raise exception using
      errcode = '22023',
      message = 'Founding Team is at capacity.';
  end if;

  return pg_catalog.jsonb_build_object('slotsUsed', v_slots, 'maxSlots', 12);
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

select ok(
  not has_function_privilege(
    'public',
    'public.api_configure_stripe_catalog_price(boolean,text,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.api_configure_stripe_catalog_price(boolean,text,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.api_configure_stripe_catalog_price(boolean,text,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.api_configure_stripe_catalog_price(boolean,text,text)',
    'EXECUTE'
  ),
  'configure catalog price is service_role only'
);

select ok(
  not has_function_privilege(
    'public',
    'public.api_disable_stripe_catalog_price(text,boolean,text,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.api_disable_stripe_catalog_price(text,boolean,text,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.api_disable_stripe_catalog_price(text,boolean,text,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.api_disable_stripe_catalog_price(text,boolean,text,text)',
    'EXECUTE'
  ),
  'disable catalog price is service_role only'
);

select ok(
  not has_function_privilege(
    'public',
    'public.api_claim_founding_team_slot()',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.api_claim_founding_team_slot()',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.api_claim_founding_team_slot()',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.api_claim_founding_team_slot()',
    'EXECUTE'
  ),
  'founding slot claim is service_role only'
);

select public.api_configure_stripe_catalog_price(
  false,
  'od_pro_month_v1',
  'price_OVD725A'
);
select public.api_disable_stripe_catalog_price(
  'od_pro_month_v1',
  false,
  'catalog_mismatch',
  'evt_OVD725'
);
select public.api_configure_stripe_catalog_price(
  false,
  'od_pro_month_v1',
  'price_OVD725B'
);

select ok(
  exists (
    select 1
    from private.stripe_catalog_price_allowlist
    where lookup_key = 'od_pro_month_v1'
      and stripe_price_id = 'price_OVD725B'
      and disabled_at is not null
      and disable_reason = 'catalog_mismatch'
  ),
  'configure does not clear a webhook-disabled catalog price'
);

do $$
begin
  for i in 1..12 loop
    perform public.api_claim_founding_team_slot();
  end loop;
end;
$$;

select is(
  (select slots_used from private.founding_team_slots where id),
  12,
  'twelve founding slots can be claimed'
);

select throws_ok(
  'select public.api_claim_founding_team_slot()',
  '22023',
  'Founding Team is at capacity.',
  'the thirteenth founding slot is refused'
);

select ok(
  not has_table_privilege(
    'authenticated',
    'private.stripe_catalog_price_allowlist',
    'SELECT'
  )
  and not has_table_privilege(
    'anon',
    'private.founding_team_slots',
    'SELECT'
  ),
  'catalog draft tables are not readable by anon or authenticated'
);

select ok(
  (select prosecdef from pg_proc
    where oid = 'public.api_claim_founding_team_slot()'::regprocedure)
  and (select prosecdef from pg_proc
    where oid = 'public.api_configure_stripe_catalog_price(boolean,text,text)'::regprocedure),
  'catalog draft RPCs stay security definer'
);

select * from finish();
rollback;
