create table if not exists public.vendor_quote_offers (
  id uuid primary key default gen_random_uuid(),
  vendor_quote_result_id uuid not null references public.vendor_quote_results(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  offer_key text not null,
  supplier text not null,
  lane_label text not null,
  sourcing text,
  tier text,
  quote_ref text,
  quote_date date,
  unit_price_usd numeric(12, 2),
  total_price_usd numeric(12, 2),
  lead_time_business_days integer,
  ship_receive_by text,
  due_date text,
  process text,
  material text,
  finish text,
  tightest_tolerance text,
  tolerance_source text,
  thread_callouts text,
  thread_match_notes text,
  notes text,
  sort_rank integer not null default 0,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (vendor_quote_result_id, offer_key)
);

create index if not exists idx_vendor_quote_offers_result
on public.vendor_quote_offers(vendor_quote_result_id, sort_rank, total_price_usd);

alter table public.published_quote_options
add column if not exists source_vendor_quote_offer_id uuid
references public.vendor_quote_offers(id)
on delete set null;

drop trigger if exists touch_vendor_quote_offers_updated_at on public.vendor_quote_offers;
create trigger touch_vendor_quote_offers_updated_at
before update on public.vendor_quote_offers
for each row execute procedure public.touch_updated_at();

insert into public.vendor_quote_offers (
  vendor_quote_result_id,
  organization_id,
  offer_key,
  supplier,
  lane_label,
  sourcing,
  tier,
  quote_ref,
  quote_date,
  unit_price_usd,
  total_price_usd,
  lead_time_business_days,
  ship_receive_by,
  due_date,
  process,
  material,
  finish,
  tightest_tolerance,
  tolerance_source,
  thread_callouts,
  thread_match_notes,
  notes,
  sort_rank,
  raw_payload
)
select
  result.id,
  result.organization_id,
  coalesce(nullif(offer ->> 'offerId', ''), format('offer-%s', offer_ordinality)),
  coalesce(nullif(offer ->> 'supplier', ''), initcap(result.vendor::text)),
  coalesce(
    nullif(offer ->> 'laneLabel', ''),
    nullif(concat_ws(' / ', nullif(offer ->> 'sourcing', ''), nullif(offer ->> 'tier', '')), ''),
    coalesce(nullif(offer ->> 'supplier', ''), initcap(result.vendor::text))
  ),
  nullif(offer ->> 'sourcing', ''),
  nullif(offer ->> 'tier', ''),
  nullif(offer ->> 'quoteRef', ''),
  case
    when nullif(offer ->> 'quoteDateIso', '') ~ '^\d{4}-\d{2}-\d{2}$' then (offer ->> 'quoteDateIso')::date
    else null
  end,
  nullif(offer ->> 'unitPriceUsd', '')::numeric,
  nullif(offer ->> 'totalPriceUsd', '')::numeric,
  nullif(offer ->> 'leadTimeBusinessDays', '')::integer,
  nullif(offer ->> 'shipReceiveBy', ''),
  nullif(offer ->> 'dueDate', ''),
  nullif(offer ->> 'process', ''),
  nullif(offer ->> 'material', ''),
  nullif(offer ->> 'finish', ''),
  nullif(offer ->> 'tightestTolerance', ''),
  nullif(offer ->> 'toleranceSource', ''),
  nullif(offer ->> 'threadCallouts', ''),
  nullif(offer ->> 'threadMatchNotes', ''),
  nullif(offer ->> 'notes', ''),
  offer_ordinality - 1,
  offer
from public.vendor_quote_results result
cross join lateral jsonb_array_elements(coalesce(result.raw_payload -> 'offers', '[]'::jsonb)) with ordinality as offer_rows(offer, offer_ordinality)
on conflict (vendor_quote_result_id, offer_key) do update
set supplier = excluded.supplier,
    lane_label = excluded.lane_label,
    sourcing = excluded.sourcing,
    tier = excluded.tier,
    quote_ref = excluded.quote_ref,
    quote_date = excluded.quote_date,
    unit_price_usd = excluded.unit_price_usd,
    total_price_usd = excluded.total_price_usd,
    lead_time_business_days = excluded.lead_time_business_days,
    ship_receive_by = excluded.ship_receive_by,
    due_date = excluded.due_date,
    process = excluded.process,
    material = excluded.material,
    finish = excluded.finish,
    tightest_tolerance = excluded.tightest_tolerance,
    tolerance_source = excluded.tolerance_source,
    thread_callouts = excluded.thread_callouts,
    thread_match_notes = excluded.thread_match_notes,
    notes = excluded.notes,
    sort_rank = excluded.sort_rank,
    raw_payload = excluded.raw_payload,
    updated_at = timezone('utc', now());

alter table public.vendor_quote_offers enable row level security;

drop policy if exists "vendor_quote_offers_internal_only" on public.vendor_quote_offers;
create policy "vendor_quote_offers_internal_only"
on public.vendor_quote_offers
for select
to authenticated
using (public.is_internal_user(organization_id));

drop policy if exists "vendor_quote_offers_manage_internal" on public.vendor_quote_offers;
create policy "vendor_quote_offers_manage_internal"
on public.vendor_quote_offers
for all
to authenticated
using (public.is_internal_user(organization_id))
with check (public.is_internal_user(organization_id));

drop function if exists public.insert_published_quote_option(
  uuid,
  public.client_option_kind,
  uuid,
  numeric,
  numeric,
  text
);

drop function if exists public.insert_published_quote_option(
  uuid,
  public.client_option_kind,
  uuid,
  numeric,
  numeric,
  text,
  uuid
);

create function public.insert_published_quote_option(
  p_package_id uuid,
  p_option_kind public.client_option_kind,
  p_vendor_quote_id uuid,
  p_markup_percent numeric,
  p_minor_unit numeric,
  p_markup_version text,
  p_vendor_quote_offer_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_option_id uuid;
  v_record public.vendor_quote_results%rowtype;
  v_package_org uuid;
  v_label text;
begin
  select *
  into v_record
  from public.vendor_quote_results
  where id = p_vendor_quote_id;

  if v_record.id is null then
    raise exception 'Vendor quote result % not found', p_vendor_quote_id;
  end if;

  select organization_id into v_package_org
  from public.published_quote_packages
  where id = p_package_id;

  v_label := case p_option_kind
    when 'lowest_cost' then 'Lowest Cost'
    when 'fastest_delivery' then 'Fastest Delivery'
    else 'Balanced'
  end;

  insert into public.published_quote_options (
    package_id,
    organization_id,
    option_kind,
    label,
    published_price_usd,
    lead_time_business_days,
    comparison_summary,
    source_vendor_quote_id,
    source_vendor_quote_offer_id,
    markup_policy_version
  )
  values (
    p_package_id,
    v_package_org,
    p_option_kind,
    v_label,
    public.apply_markup(v_record.total_price_usd, p_markup_percent, p_minor_unit),
    v_record.lead_time_business_days,
    format('%s option generated from the internal vendor comparison.', v_label),
    v_record.id,
    p_vendor_quote_offer_id,
    p_markup_version
  )
  on conflict (package_id, option_kind) do update
    set label = excluded.label,
        published_price_usd = excluded.published_price_usd,
        lead_time_business_days = excluded.lead_time_business_days,
        comparison_summary = excluded.comparison_summary,
        source_vendor_quote_id = excluded.source_vendor_quote_id,
        source_vendor_quote_offer_id = excluded.source_vendor_quote_offer_id,
        markup_policy_version = excluded.markup_policy_version
  returning id into v_option_id;

  return v_option_id;
end;
$$;
