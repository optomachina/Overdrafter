-- OVD-314: Gate eligible Pro automatic quote collection behind the independent,
-- default-off rollout registry before vendor resolution or lifecycle writes.
--
-- Authentication and job authorization remain first. The Pro entitlement
-- decision remains ahead of rollout inspection so Free callers retain the
-- stable pro_required result and unauthorized callers cannot discover rollout
-- state. Eligible Pro calls take a shared transaction lock on the exact key
-- used exclusively by api_set_commercial_rollout_control. An audited disable
-- therefore waits for an already-authorized request transaction to finish;
-- new requests wait for the disable and then return the bounded fallback.
--
-- Operational rollback: leave this enforcement installed and set
-- automatic_quote_collection off through the audited rollout-control API.
-- Manual quote requests and provider recommendations remain available.
--
-- Schema rollback: restore the public wrapper from
-- 20260731015240_gate_automatic_quotes_by_entitlement.sql and revoke/drop
-- private.automatic_quote_rollout_enabled_with_lock(). This re-enables eligible
-- Pro automatic collection independently of the rollout registry, so it is a
-- reviewed forward migration rather than incident containment.

create function private.automatic_quote_rollout_enabled_with_lock()
returns boolean
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended(
      'commercial-rollout:automatic_quote_collection',
      0
    )
  );

  return private.commercial_rollout_enabled(
    'automatic_quote_collection'
  );
end;
$$;

revoke all on function private.automatic_quote_rollout_enabled_with_lock()
from public, anon, authenticated, service_role;

create or replace function public.api_request_quote(
  p_job_id uuid,
  p_force_retry boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_job public.jobs%rowtype;
  v_entitlements jsonb;
begin
  perform public.require_verified_auth();

  select job_row.*
  into v_job
  from public.jobs job_row
  where job_row.id = p_job_id;

  if v_job.id is null then
    raise exception 'Job % not found.', p_job_id;
  end if;

  if not public.user_can_edit_job(v_job.id) then
    raise exception 'You do not have permission to request quotes for job %.', p_job_id;
  end if;

  v_entitlements := private.resolve_organization_entitlements_at(
    v_job.organization_id,
    pg_catalog.now()
  );

  if coalesce(
    v_entitlements -> 'automaticQuoteCollection' = 'true'::jsonb,
    false
  ) is not true then
    return pg_catalog.jsonb_build_object(
      'jobId', v_job.id,
      'accepted', false,
      'created', false,
      'deduplicated', false,
      'quoteRequestId', null,
      'quoteRunId', null,
      'serviceRequestLineItemId', null,
      'status', 'not_requested',
      'reasonCode', 'pro_required',
      'reason', 'Automatic quote collection requires a Pro account.',
      'requestedVendors', pg_catalog.jsonb_build_array(),
      'quoteMode', 'automatic'
    );
  end if;

  if not private.automatic_quote_rollout_enabled_with_lock() then
    return pg_catalog.jsonb_build_object(
      'jobId', v_job.id,
      'accepted', false,
      'created', false,
      'deduplicated', false,
      'quoteRequestId', null,
      'quoteRunId', null,
      'serviceRequestLineItemId', null,
      'status', 'not_requested',
      'reasonCode', 'automatic_quote_disabled',
      'reason', 'Automatic quote collection is temporarily unavailable. You can still request a manual quote.',
      'requestedVendors', pg_catalog.jsonb_build_array(),
      'quoteMode', 'automatic'
    );
  end if;

  return private.request_automatic_quote_impl(
    p_job_id,
    p_force_retry
  ) || pg_catalog.jsonb_build_object(
    'quoteMode',
    'automatic'
  );
end;
$$;

revoke all on function public.api_request_quote(uuid, boolean)
from public, anon, authenticated, service_role;

grant execute on function public.api_request_quote(uuid, boolean)
to authenticated;
