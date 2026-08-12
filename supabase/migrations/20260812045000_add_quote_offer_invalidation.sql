begin;

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
