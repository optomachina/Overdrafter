-- OVD-95: Preserve received_at on re-sync
--
-- sync_quote_request_status_for_run was unconditionally overwriting received_at
-- on every sync call that resolved to 'received'. If a subsequent vendor result
-- update fired the trigger again, the original received_at timestamp was silently
-- replaced. This uses COALESCE to preserve the first-write timestamp.
--
-- canceled_at already used COALESCE correctly; this aligns received_at to match.

create or replace function public.sync_quote_request_status_for_run(
  p_quote_run_id uuid,
  p_failure_reason text default null
)
returns public.quote_request_status
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request public.quote_requests%rowtype;
  v_has_queued boolean := false;
  v_has_running boolean := false;
  v_has_success boolean := false;
  v_has_manual boolean := false;
  v_has_failed boolean := false;
  v_next_status public.quote_request_status;
  v_failure_reason text;
  v_trimmed_failure_reason text;
  v_client_safe_failure_reason text;
begin
  select request_row.*
  into v_request
  from public.quote_requests request_row
  join public.quote_runs quote_run on quote_run.quote_request_id = request_row.id
  where quote_run.id = p_quote_run_id
  limit 1;

  if v_request.id is null then
    return null;
  end if;

  if v_request.status = 'canceled' then
    return v_request.status;
  end if;

  select
    bool_or(result.status = 'queued'),
    bool_or(result.status = 'running'),
    bool_or(result.status in ('instant_quote_received', 'official_quote_received')),
    bool_or(result.status in ('manual_review_pending', 'manual_vendor_followup')),
    bool_or(result.status = 'failed')
  into
    v_has_queued,
    v_has_running,
    v_has_success,
    v_has_manual,
    v_has_failed
  from public.vendor_quote_results result
  where result.quote_run_id = p_quote_run_id;

  v_next_status := case
    when coalesce(v_has_running, false) then 'requesting'
    when coalesce(v_has_queued, false) and coalesce(v_has_success, false) then 'requesting'
    when coalesce(v_has_queued, false) then 'queued'
    when coalesce(v_has_success, false) then 'received'
    else 'failed'
  end;

  v_trimmed_failure_reason := nullif(trim(coalesce(p_failure_reason, '')), '');
  v_client_safe_failure_reason := case v_trimmed_failure_reason
    when 'Configured vendors could not return an automated quote and need manual follow-up.'
      then 'Configured vendors could not return an automated quote and need manual follow-up.'
    when 'Quote collection failed before a usable vendor response was received.'
      then 'Quote collection failed before a usable vendor response was received.'
    when 'Quote collection ended without a usable vendor response.'
      then 'Quote collection ended without a usable vendor response.'
    when 'Xometry could not return an automated quote and needs manual follow-up.'
      then 'Configured vendors could not return an automated quote and need manual follow-up.'
    when 'Xometry quote collection failed before a usable response was received.'
      then 'Quote collection failed before a usable vendor response was received.'
    when 'Quote collection ended without a usable Xometry response.'
      then 'Quote collection ended without a usable vendor response.'
    else null
  end;

  v_failure_reason := case
    when v_next_status <> 'failed' then null
    when v_client_safe_failure_reason is not null then v_client_safe_failure_reason
    when coalesce(v_has_manual, false) then 'Configured vendors could not return an automated quote and need manual follow-up.'
    when coalesce(v_has_failed, false) then 'Quote collection failed before a usable vendor response was received.'
    else 'Quote collection ended without a usable vendor response.'
  end;

  update public.quote_requests
  set
    status = v_next_status,
    failure_reason = v_failure_reason,
    received_at = case
      when v_next_status = 'received' then coalesce(v_request.received_at, timezone('utc', now()))
      else null
    end,
    failed_at = case
      when v_next_status = 'failed' then timezone('utc', now())
      else null
    end,
    canceled_at = case
      when v_next_status = 'canceled' then coalesce(v_request.canceled_at, timezone('utc', now()))
      else null
    end
  where id = v_request.id;

  return v_next_status;
end;
$$;
