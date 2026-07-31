-- OVD-260: Require the server-authoritative Pro entitlement before automatic
-- vendor quote collection can begin.
--
-- The decision occurs after authentication and job authorization, but before
-- the existing implementation resolves vendors or writes quote lifecycle rows.
-- Manual quote requests remain available to every authorized organization.
--
-- Rollback: restore the OVD-259 SQL wrapper around
-- private.request_automatic_quote_impl(uuid, boolean).

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
