begin;

-- Existing selections are append-only through the guarded RPC. Revoke both
-- table and column grants so service_role cannot bypass checks via UPDATE.
revoke update on public.client_selections from public, anon, authenticated, service_role;
revoke update (id, package_id, option_id, organization_id, selected_by, note, created_at)
on public.client_selections from public, anon, authenticated, service_role;

-- Historical source-less options are retained as evidence but retired from new
-- selection. Do not backfill guessed links or rewrite selection/audit history.
create or replace function public.insert_published_quote_option(
  p_package_id uuid,
  p_option_kind public.client_option_kind,
  p_vendor_quote_id uuid,
  p_requested_quantity integer,
  p_markup_percent numeric,
  p_minor_unit numeric,
  p_markup_version text,
  p_vendor_quote_offer_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_option_id uuid;
  v_record public.vendor_quote_results%rowtype;
  v_package_org uuid;
  v_label text;
  v_source_offer_id uuid;
  v_source_offer_ids uuid[];
  v_package public.published_quote_packages%rowtype;
  v_offer public.vendor_quote_offers%rowtype;
begin
  select package.* into v_package
  from public.published_quote_packages package
  where package.id = p_package_id
  for share;

  select result.* into v_record
  from public.vendor_quote_results result
  join public.parts part on part.id = result.part_id
  where result.id = p_vendor_quote_id
    and result.quote_run_id = v_package.quote_run_id
    and result.organization_id = v_package.organization_id
    and part.organization_id = v_package.organization_id
    and part.job_id = v_package.job_id
  for share of result, part;

  if v_package.id is null or v_record.id is null
    or v_record.requested_quantity is distinct from p_requested_quantity then
    raise exception 'Publication requires one exact matching source offer.';
  end if;
  v_package_org := v_package.organization_id;

  -- Without an explicit identity there must be exactly one variant for this
  -- result. Never infer identity from sort order or choose among equal prices.
  select array_agg(candidate.id) into v_source_offer_ids
  from (
    select offer.id from public.vendor_quote_offers offer
    where offer.vendor_quote_result_id = v_record.id
      and (p_vendor_quote_offer_id is null or offer.id = p_vendor_quote_offer_id)
    for share of offer
  ) candidate;

  if v_source_offer_ids is null or cardinality(v_source_offer_ids) <> 1 then
    raise exception 'Publication requires one exact matching source offer.';
  end if;
  select offer.* into v_offer from public.vendor_quote_offers offer
  where offer.id = v_source_offer_ids[1];

  -- The publication still uses the result's commercial fields. Confirm those
  -- fields describe this exact variant before retaining the existing markup.
  if v_offer.organization_id is distinct from v_package.organization_id
    or v_record.total_price_usd is null
    or v_offer.total_price_usd is distinct from v_record.total_price_usd
    or v_offer.unit_price_usd is distinct from v_record.unit_price_usd
    or v_offer.lead_time_business_days is distinct from v_record.lead_time_business_days then
    raise exception 'Publication requires one exact matching source offer.';
  end if;
  if v_offer.invalidated_at is not null then
    raise exception 'Quote offer has been invalidated and cannot be published.';
  end if;
  -- The parent publishes several options before updating the job. Do not take
  -- its job lock here: a later option could invert invalidation lock ordering.
  if not private.quote_offer_valid_at(v_offer.valid_until, pg_catalog.clock_timestamp()) then
    raise exception 'Quote offer has expired and cannot be published.';
  end if;
  v_source_offer_id := v_offer.id;

  v_label := case p_option_kind
    when 'lowest_cost' then 'Lowest Cost'
    when 'fastest_delivery' then 'Fastest Delivery'
    else 'Balanced'
  end;

  insert into public.published_quote_options (
    package_id,
    organization_id,
    requested_quantity,
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
    p_requested_quantity,
    p_option_kind,
    v_label,
    public.apply_markup(v_record.total_price_usd, p_markup_percent, p_minor_unit),
    v_record.lead_time_business_days,
    format('%s option generated from the internal vendor comparison for qty %s.', v_label, p_requested_quantity),
    v_record.id,
    v_source_offer_id,
    p_markup_version
  )
  on conflict (package_id, requested_quantity, option_kind) do update
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

revoke all on function public.insert_published_quote_option(
  uuid, public.client_option_kind, uuid, integer, numeric, numeric, text, uuid
) from public, anon, authenticated, service_role;

commit;
