alter table public.vendor_quote_offers
add column if not exists geographic_origin text;

update public.vendor_quote_offers
set geographic_origin = 'unknown'
where geographic_origin is null;

alter table public.vendor_quote_offers
alter column geographic_origin set default 'unknown',
alter column geographic_origin set not null;

alter table public.vendor_quote_offers
drop constraint if exists vendor_quote_offers_geographic_origin_check;

alter table public.vendor_quote_offers
add constraint vendor_quote_offers_geographic_origin_check
check (geographic_origin in ('domestic', 'foreign', 'unknown'));

comment on column public.vendor_quote_offers.geographic_origin is
  'Evidence-backed manufacturing origin. Unknown is required when provider provenance is absent or ambiguous; legacy sourcing text is never used to infer this value.';

create or replace function public.reconcile_vendor_quote_offers(
  p_vendor_quote_result_id uuid,
  p_result jsonb,
  p_offers jsonb
)
returns void
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_offers jsonb := coalesce(p_offers, '[]'::jsonb);
begin
  if pg_catalog.jsonb_typeof(p_result) <> 'object' then
    raise exception 'Vendor quote result finalization must be a JSON object.';
  end if;

  if pg_catalog.jsonb_typeof(v_offers) <> 'array' then
    raise exception 'Vendor quote offers must be a JSON array.';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(v_offers) as entry(value)
    where nullif(entry.value ->> 'vendor_quote_result_id', '')::uuid
      is distinct from p_vendor_quote_result_id
  ) then
    raise exception 'Every offer must belong to vendor quote result %.', p_vendor_quote_result_id;
  end if;

  update public.vendor_quote_results
  set status = (p_result ->> 'status')::public.vendor_status,
      unit_price_usd = (p_result ->> 'unit_price_usd')::numeric,
      total_price_usd = (p_result ->> 'total_price_usd')::numeric,
      lead_time_business_days = (p_result ->> 'lead_time_business_days')::integer,
      quote_url = p_result ->> 'quote_url',
      dfm_issues = p_result -> 'dfm_issues',
      notes = p_result -> 'notes',
      raw_payload = p_result -> 'raw_payload',
      updated_at = pg_catalog.timezone('utc', pg_catalog.now())
  where id = p_vendor_quote_result_id;

  if not found then
    raise exception 'Vendor quote result % was not found.', p_vendor_quote_result_id;
  end if;

  insert into public.vendor_quote_offers (
    vendor_quote_result_id,
    organization_id,
    offer_key,
    supplier,
    lane_label,
    sourcing,
    geographic_origin,
    tier,
    quote_ref,
    quote_date,
    quoted_at,
    valid_until,
    validity_duration_days,
    validity_source,
    validity_terms,
    provenance_status,
    unit_price_usd,
    total_price_usd,
    lead_time_business_days,
    ship_receive_by,
    process,
    material,
    finish,
    tightest_tolerance,
    notes,
    sort_rank,
    raw_payload
  )
  select
    offer.vendor_quote_result_id,
    offer.organization_id,
    offer.offer_key,
    offer.supplier,
    offer.lane_label,
    offer.sourcing,
    offer.geographic_origin,
    offer.tier,
    offer.quote_ref,
    offer.quote_date,
    offer.quoted_at,
    offer.valid_until,
    offer.validity_duration_days,
    offer.validity_source,
    offer.validity_terms,
    offer.provenance_status,
    offer.unit_price_usd,
    offer.total_price_usd,
    offer.lead_time_business_days,
    offer.ship_receive_by,
    offer.process,
    offer.material,
    offer.finish,
    offer.tightest_tolerance,
    offer.notes,
    offer.sort_rank,
    offer.raw_payload
  from pg_catalog.jsonb_populate_recordset(
    null::public.vendor_quote_offers,
    v_offers
  ) as offer
  on conflict (vendor_quote_result_id, offer_key) do update
  set organization_id = excluded.organization_id,
      supplier = excluded.supplier,
      lane_label = excluded.lane_label,
      sourcing = excluded.sourcing,
      geographic_origin = excluded.geographic_origin,
      tier = excluded.tier,
      quote_ref = excluded.quote_ref,
      quote_date = excluded.quote_date,
      quoted_at = excluded.quoted_at,
      valid_until = excluded.valid_until,
      validity_duration_days = excluded.validity_duration_days,
      validity_source = excluded.validity_source,
      validity_terms = excluded.validity_terms,
      provenance_status = excluded.provenance_status,
      unit_price_usd = excluded.unit_price_usd,
      total_price_usd = excluded.total_price_usd,
      lead_time_business_days = excluded.lead_time_business_days,
      ship_receive_by = excluded.ship_receive_by,
      process = excluded.process,
      material = excluded.material,
      finish = excluded.finish,
      tightest_tolerance = excluded.tightest_tolerance,
      notes = excluded.notes,
      sort_rank = excluded.sort_rank,
      raw_payload = excluded.raw_payload,
      updated_at = pg_catalog.timezone('utc', pg_catalog.now());

  delete from public.vendor_quote_offers as existing
  where existing.vendor_quote_result_id = p_vendor_quote_result_id
    and not exists (
      select 1
      from pg_catalog.jsonb_array_elements(v_offers) as entry(value)
      where entry.value ->> 'offer_key' = existing.offer_key
    );
end;
$$;

revoke all on function public.reconcile_vendor_quote_offers(uuid, jsonb, jsonb)
from public, anon, authenticated;
grant execute on function public.reconcile_vendor_quote_offers(uuid, jsonb, jsonb)
to service_role;

comment on function public.reconcile_vendor_quote_offers(uuid, jsonb, jsonb) is
  'Atomically finalizes the parent quote result, upserts its complete current offer set, and removes stale rows while preserving administrative invalidation fields on stable keys.';
