begin;

-- The client workspace projection predates administrative invalidation fields
-- and used to serialize the full offer row. Redefine it in this migration so
-- billing-admin identity and internal invalidation reasons never cross the
-- client boundary while the public invalidation timestamp remains available.
do $$
declare
  v_definition text;
begin
  select pg_catalog.pg_get_functiondef(
    'public.api_list_client_quote_workspace(uuid[])'::pg_catalog.regprocedure
  ) into v_definition;

  if v_definition is null then
    raise exception 'Client quote workspace projection was not found.';
  end if;

  v_definition := pg_catalog.replace(
    v_definition,
    'to_jsonb(offer) order by offer.sort_rank, offer.total_price_usd, offer.id',
    '(to_jsonb(offer) - ''invalidated_by'' - ''invalidation_reason'') order by offer.sort_rank, offer.total_price_usd, offer.id'
  );
  v_definition := pg_catalog.replace(
    v_definition,
    'else to_jsonb(offer)',
    'else (to_jsonb(offer) - ''invalidated_by'' - ''invalidation_reason'')'
  );

  if pg_catalog.strpos(
    v_definition,
    '(to_jsonb(offer) - ''invalidated_by'' - ''invalidation_reason'')'
  ) = 0
    or pg_catalog.strpos(
      v_definition,
      'to_jsonb(offer) order by offer.sort_rank, offer.total_price_usd, offer.id'
    ) > 0
    or pg_catalog.strpos(v_definition, 'else to_jsonb(offer)') > 0 then
    raise exception 'Unable to harden the client quote offer projection.';
  end if;

  execute v_definition;
end;
$$;

create or replace function private.anchor_operator_quote_validity()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_raw_duration text := coalesce(
    nullif(new.raw_payload ->> 'validityDurationDays', ''),
    nullif(new.raw_payload ->> 'validForDays', '')
  );
  v_source text := coalesce(
    new.validity_source,
    nullif(new.raw_payload ->> 'validitySource', '')
  );
begin
  -- Operator-entered durations without a vendor quote date are anchored to
  -- the trusted manual-capture timestamp. This preserves explicit duration
  -- terms without inventing validity for imported historical offers.
  if v_source = 'operator_duration'
    and (
      new.validity_duration_days is not null
      or v_raw_duration ~ '^[1-9]\d*$'
    )
    and new.quoted_at is null then
    new.quoted_at := coalesce(new.created_at, pg_catalog.now());
  end if;

  return new;
end;
$$;

revoke all on function private.anchor_operator_quote_validity()
from public, anon, authenticated, service_role;

drop trigger if exists anchor_operator_quote_validity
on public.vendor_quote_offers;
create trigger anchor_operator_quote_validity
before insert or update of quoted_at, validity_duration_days, validity_source
on public.vendor_quote_offers
for each row execute function private.anchor_operator_quote_validity();

create or replace function public.api_set_job_selected_vendor_quote_offer(
  p_job_id uuid,
  p_vendor_quote_offer_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_job public.jobs%rowtype;
  v_part_id uuid;
  v_offer public.vendor_quote_offers%rowtype;
begin
  perform public.require_verified_auth();

  select job_row.*
  into v_job
  from public.jobs job_row
  where job_row.id = p_job_id;

  if v_job.id is null then
    raise exception 'Job % not found.', p_job_id;
  end if;

  if not public.user_can_access_job(v_job.id) then
    raise exception 'You do not have access to job %.', p_job_id;
  end if;

  if p_vendor_quote_offer_id is null then
    update public.jobs
    set selected_vendor_quote_offer_id = null,
        updated_at = pg_catalog.timezone('utc', pg_catalog.now())
    where id = v_job.id;

    return v_job.id;
  end if;

  select part.id
  into v_part_id
  from public.parts part
  where part.job_id = v_job.id
  order by part.created_at asc
  limit 1;

  if v_part_id is null then
    raise exception 'Job % has no part revisions yet.', p_job_id;
  end if;

  -- Serialize selection against administrative invalidation. If selection
  -- wins the lock, invalidation clears it before committing; if invalidation
  -- wins, this statement observes the invalidated offer and rejects it.
  select offer.*
  into v_offer
  from public.vendor_quote_offers offer
  join public.vendor_quote_results result
    on result.id = offer.vendor_quote_result_id
  where offer.id = p_vendor_quote_offer_id
    and result.part_id = v_part_id
  for share of offer;

  if v_offer.id is null then
    raise exception 'Offer % is not valid for job %.', p_vendor_quote_offer_id, p_job_id;
  end if;

  if v_offer.invalidated_at is not null then
    raise exception 'Offer % has been invalidated and cannot be selected.', p_vendor_quote_offer_id;
  end if;

  update public.jobs
  set selected_vendor_quote_offer_id = v_offer.id,
      updated_at = pg_catalog.timezone('utc', pg_catalog.now())
  where id = v_job.id;

  return v_job.id;
end;
$$;

revoke all on function public.api_set_job_selected_vendor_quote_offer(uuid, uuid)
from public, anon, authenticated, service_role;
grant execute on function public.api_set_job_selected_vendor_quote_offer(uuid, uuid)
to authenticated;

create or replace function public.api_admin_invalidate_vendor_quote_offer(
  p_offer_id uuid,
  p_reason text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_offer public.vendor_quote_offers%rowtype;
  v_event_id uuid;
  v_invalidated_at timestamptz := timezone('utc', now());
begin
  perform private.require_commercial_admin_mutation('billing_admin');

  if length(trim(coalesce(p_reason, ''))) = 0 then
    raise exception 'A reason is required to invalidate a quote offer.';
  end if;
  if length(trim(coalesce(p_idempotency_key, ''))) = 0 then
    raise exception 'An idempotency key is required.';
  end if;

  select offer.* into v_offer
  from public.vendor_quote_offers offer
  where offer.id = p_offer_id
  for update;

  if v_offer.id is null then
    raise exception 'Quote offer % not found.', p_offer_id;
  end if;

  if v_offer.invalidated_at is not null then
    return pg_catalog.jsonb_build_object(
      'offerId', v_offer.id,
      'invalidatedAt', v_offer.invalidated_at,
      'alreadyInvalidated', true,
      'auditEventId', null
    );
  end if;

  v_event_id := private.append_commercial_admin_audit_event(
    v_offer.organization_id,
    'billing_admin',
    'commercial.quote_offer.invalidate',
    'vendor_quote_offer',
    v_offer.id::text,
    trim(p_reason),
    pg_catalog.jsonb_build_object(
      'invalidatedAt', v_offer.invalidated_at,
      'validUntil', v_offer.valid_until
    ),
    pg_catalog.jsonb_build_object(
      'invalidatedAt', v_invalidated_at,
      'validUntil', v_offer.valid_until
    ),
    pg_catalog.jsonb_build_object(),
    'quote_offer_invalidate:' || v_offer.id::text,
    trim(p_idempotency_key)
  );

  update public.vendor_quote_offers
  set invalidated_at = v_invalidated_at,
      invalidated_by = auth.uid(),
      invalidation_reason = trim(p_reason)
  where id = v_offer.id;

  update public.jobs
  set selected_vendor_quote_offer_id = null,
      updated_at = v_invalidated_at
  where selected_vendor_quote_offer_id = v_offer.id;

  update public.quote_request_lanes lane
  set cooldown_released_at = v_invalidated_at,
      cooldown_released_by_offer_id = v_offer.id
  where lane.vendor_quote_result_id = v_offer.vendor_quote_result_id;

  return pg_catalog.jsonb_build_object(
    'offerId', v_offer.id,
    'invalidatedAt', v_invalidated_at,
    'alreadyInvalidated', false,
    'auditEventId', v_event_id
  );
end;
$$;

revoke all on function public.api_admin_invalidate_vendor_quote_offer(uuid, text, text)
from public, anon, authenticated, service_role;
grant execute on function public.api_admin_invalidate_vendor_quote_offer(uuid, text, text)
to authenticated;

commit;
