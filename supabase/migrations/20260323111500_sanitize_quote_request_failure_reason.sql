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
  select *
  into v_request
  from public.quote_requests
  where quote_run_id = p_quote_run_id
  order by created_at desc
  limit 1;

  if not found then
    raise exception 'quote_request_not_found_for_run';
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
    when 'Xometry could not return an automated quote and needs manual follow-up.' then v_trimmed_failure_reason
    when 'Xometry quote collection failed before a usable response was received.' then v_trimmed_failure_reason
    when 'Quote collection ended without a usable Xometry response.' then v_trimmed_failure_reason
    when 'Quote collection did not return a usable Xometry response.' then v_trimmed_failure_reason
    else null
  end;

  v_failure_reason := case
    when v_next_status <> 'failed' then null
    when v_client_safe_failure_reason is not null then v_client_safe_failure_reason
    when coalesce(v_has_manual, false) then 'Xometry could not return an automated quote and needs manual follow-up.'
    when coalesce(v_has_failed, false) then 'Xometry quote collection failed before a usable response was received.'
    when v_trimmed_failure_reason is not null then 'Quote collection did not return a usable Xometry response.'
    else 'Quote collection ended without a usable Xometry response.'
  end;

  update public.quote_requests
  set
    status = v_next_status,
    failure_reason = v_failure_reason,
    received_at = case
      when v_next_status = 'received' then timezone('utc', now())
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
