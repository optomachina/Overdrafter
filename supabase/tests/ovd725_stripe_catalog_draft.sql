begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(16);

-- DRAFT ONLY. Not a migration. The DDL below is generated together with
-- docs/migration-drafts/ovd-725-stripe-catalog.sql and must stay identical.
-- SECURITY DEFINER, pinned search_path. Founding Team cap is 8.

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
  if v_lookup_key is null
    or p_livemode is null
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
  from public, anon, authenticated;
revoke all on table private.founding_team_claims
  from public, anon, authenticated;
grant execute on function public.api_configure_stripe_catalog_price(boolean, text, text)
  to service_role;
grant execute on function public.api_disable_stripe_catalog_price(text, boolean, text, text)
  to service_role;
grant execute on function public.api_claim_founding_team_slot(uuid)
  to service_role;
grant execute on function public.api_release_founding_team_slot(uuid)
  to service_role;

insert into public.organizations (id, name, slug)
values
  ('00000000-0000-4000-8000-000000072501', 'OVD-725 org 1', 'ovd725-org-1'),
  ('00000000-0000-4000-8000-000000072502', 'OVD-725 org 2', 'ovd725-org-2'),
  ('00000000-0000-4000-8000-000000072503', 'OVD-725 org 3', 'ovd725-org-3'),
  ('00000000-0000-4000-8000-000000072504', 'OVD-725 org 4', 'ovd725-org-4'),
  ('00000000-0000-4000-8000-000000072505', 'OVD-725 org 5', 'ovd725-org-5'),
  ('00000000-0000-4000-8000-000000072506', 'OVD-725 org 6', 'ovd725-org-6'),
  ('00000000-0000-4000-8000-000000072507', 'OVD-725 org 7', 'ovd725-org-7'),
  ('00000000-0000-4000-8000-000000072508', 'OVD-725 org 8', 'ovd725-org-8'),
  ('00000000-0000-4000-8000-000000072509', 'OVD-725 org 9', 'ovd725-org-9'),
  ('00000000-0000-4000-8000-000000072510', 'OVD-725 org 10', 'ovd725-org-10');

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
    'public.api_claim_founding_team_slot(uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.api_claim_founding_team_slot(uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.api_claim_founding_team_slot(uuid)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.api_claim_founding_team_slot(uuid)',
    'EXECUTE'
  ),
  'founding slot claim is service_role only'
);

select ok(
  not has_function_privilege(
    'public',
    'public.api_release_founding_team_slot(uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.api_release_founding_team_slot(uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.api_release_founding_team_slot(uuid)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.api_release_founding_team_slot(uuid)',
    'EXECUTE'
  ),
  'founding slot release is service_role only'
);

select public.api_configure_stripe_catalog_price(
  false,
  'od_pro_month_v1',
  'price_OVD725A'
);

select ok(
  exists (
    select 1
    from private.stripe_pro_price_allowlist
    where stripe_price_id = 'price_OVD725A'
      and livemode = false
      and checkout_enabled
  ),
  'the Pro lookup key mirrors into the existing Pro price allowlist'
);

select public.api_disable_stripe_catalog_price(
  'od_pro_month_v1',
  false,
  'amount_mismatch',
  'evt_OVD725'
);

select ok(
  exists (
    select 1
    from private.stripe_catalog_price_allowlist
    where lookup_key = 'od_pro_month_v1'
      and disabled_at is not null
      and disable_reason = 'amount_mismatch'
  ),
  'the webhook disable marks the catalog key disabled'
);

select ok(
  not (select checkout_enabled
    from private.stripe_pro_price_allowlist
    where stripe_price_id = 'price_OVD725A'),
  'disabling the Pro key turns off checkout on the mirrored Pro price'
);

select throws_ok(
  $$select public.api_configure_stripe_catalog_price(false, 'od_pro_month_v1', 'price_OVD725B')$$,
  '55000',
  'Catalog price is disabled.',
  'configure refuses a webhook-disabled catalog key'
);

select ok(
  not exists (
    select 1
    from private.stripe_pro_price_allowlist
    where stripe_price_id = 'price_OVD725B'
  ),
  'a disabled key is not mirrored into the Pro allowlist'
);

do $$
begin
  for i in 1..8 loop
    perform public.api_claim_founding_team_slot(
      ('00000000-0000-4000-8000-0000000725' || pg_catalog.lpad(i::text, 2, '0'))::uuid
    );
  end loop;
end;
$$;

select is(
  (select count(*)::integer from private.founding_team_claims),
  8,
  'eight organizations can claim founding slots'
);

select is(
  public.api_claim_founding_team_slot('00000000-0000-4000-8000-000000072501'::uuid)
    ->> 'alreadyClaimed',
  'true',
  'a repeated claim by the same organization does not use another slot'
);

select throws_ok(
  $$select public.api_claim_founding_team_slot('00000000-0000-4000-8000-000000072509'::uuid)$$,
  '22023',
  'Founding Team is at capacity.',
  'the ninth organization is refused'
);

select is(
  public.api_release_founding_team_slot('00000000-0000-4000-8000-000000072502'::uuid)
    ->> 'released',
  'true',
  'a cancelled founding team releases its slot'
);

select is(
  public.api_claim_founding_team_slot('00000000-0000-4000-8000-000000072509'::uuid)
    ->> 'slotsUsed',
  '8',
  'a released slot can be claimed by another organization'
);

select ok(
  not has_table_privilege(
    'authenticated',
    'private.stripe_catalog_price_allowlist',
    'SELECT'
  )
  and not has_table_privilege(
    'anon',
    'private.founding_team_claims',
    'SELECT'
  ),
  'catalog draft tables are not readable by anon or authenticated'
);

select ok(
  (select prosecdef from pg_proc
    where oid = 'public.api_claim_founding_team_slot(uuid)'::regprocedure)
  and (select prosecdef from pg_proc
    where oid = 'public.api_release_founding_team_slot(uuid)'::regprocedure)
  and (select prosecdef from pg_proc
    where oid = 'public.api_configure_stripe_catalog_price(boolean,text,text)'::regprocedure),
  'catalog draft RPCs stay security definer'
);

select * from finish();
rollback;
