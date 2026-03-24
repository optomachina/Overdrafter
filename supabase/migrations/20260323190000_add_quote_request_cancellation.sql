create or replace function public.api_cancel_quote_request(
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request public.quote_requests%rowtype;
  v_quote_run public.quote_runs%rowtype;
  v_has_terminal_vendor_outcome boolean := false;
  v_canceled_at timestamptz := timezone('utc', now());
begin
  perform public.require_verified_auth();

  select *
  into v_request
  from public.quote_requests
  where id = p_request_id
  for update;

  if v_request.id is null then
    return jsonb_build_object(
      'jobId', null,
      'accepted', false,
      'canceled', false,
      'quoteRequestId', null,
      'quoteRunId', null,
      'status', 'not_requested',
      'reasonCode', 'not_found',
      'reason', 'Quote request not found.'
    );
  end if;

  if not public.user_can_edit_job(v_request.job_id) then
    return jsonb_build_object(
      'jobId', v_request.job_id,
      'accepted', false,
      'canceled', false,
      'quoteRequestId', v_request.id,
      'quoteRunId', null,
      'status', v_request.status,
      'reasonCode', 'forbidden',
      'reason', 'You do not have permission to cancel this quote request.'
    );
  end if;

  select *
  into v_quote_run
  from public.quote_runs
  where quote_request_id = v_request.id
  order by created_at desc, id desc
  limit 1
  for update;

  if v_request.status = 'canceled' then
    return jsonb_build_object(
      'jobId', v_request.job_id,
      'accepted', false,
      'canceled', false,
      'quoteRequestId', v_request.id,
      'quoteRunId', v_quote_run.id,
      'status', v_request.status,
      'reasonCode', 'already_canceled',
      'reason', 'This quote request is already canceled.'
    );
  end if;

  if v_request.status = 'received' then
    return jsonb_build_object(
      'jobId', v_request.job_id,
      'accepted', false,
      'canceled', false,
      'quoteRequestId', v_request.id,
      'quoteRunId', v_quote_run.id,
      'status', v_request.status,
      'reasonCode', 'already_received',
      'reason', 'A quote response has already been received for this request.'
    );
  end if;

  if v_request.status not in ('queued', 'requesting') then
    return jsonb_build_object(
      'jobId', v_request.job_id,
      'accepted', false,
      'canceled', false,
      'quoteRequestId', v_request.id,
      'quoteRunId', v_quote_run.id,
      'status', v_request.status,
      'reasonCode', 'not_cancelable',
      'reason', 'Only queued or requesting quote requests can be canceled.'
    );
  end if;

  if v_quote_run.id is not null then
    select exists(
      select 1
      from public.vendor_quote_results result
      where result.quote_run_id = v_quote_run.id
        and result.status in (
          'instant_quote_received',
          'official_quote_received',
          'manual_review_pending',
          'manual_vendor_followup'
        )
    )
    into v_has_terminal_vendor_outcome;
  end if;

  if v_has_terminal_vendor_outcome then
    return jsonb_build_object(
      'jobId', v_request.job_id,
      'accepted', false,
      'canceled', false,
      'quoteRequestId', v_request.id,
      'quoteRunId', v_quote_run.id,
      'status', v_request.status,
      'reasonCode', 'not_cancelable',
      'reason', 'This quote request already produced a terminal vendor outcome and cannot be canceled.'
    );
  end if;

  update public.quote_requests
  set
    status = 'canceled',
    failure_reason = null,
    received_at = null,
    failed_at = null,
    canceled_at = v_canceled_at
  where id = v_request.id;

  if v_quote_run.id is not null then
    update public.work_queue
    set
      status = 'cancelled',
      locked_at = null,
      locked_by = null,
      last_error = 'Canceled by client request.',
      payload = coalesce(payload, '{}'::jsonb) || jsonb_build_object(
        'canceledAt', v_canceled_at,
        'canceledBy', auth.uid(),
        'cancellationSource', 'client-request'
      )
    where quote_run_id = v_quote_run.id
      and task_type = 'run_vendor_quote'
      and status = 'queued';

    update public.quote_runs
    set status = 'failed'
    where id = v_quote_run.id;
  end if;

  update public.jobs
  set status = case
    when status in ('closed', 'client_selected') then status
    when status = 'quoting' then 'ready_to_quote'
    else status
  end
  where id = v_request.job_id;

  perform public.log_audit_event(
    v_request.organization_id,
    'job.quote_request_canceled',
    jsonb_build_object(
      'quoteRequestId', v_request.id,
      'quoteRunId', v_quote_run.id,
      'requestedVendors', v_request.requested_vendors,
      'canceledAt', v_canceled_at,
      'clientTriggered', true
    ),
    v_request.job_id,
    null
  );

  return jsonb_build_object(
    'jobId', v_request.job_id,
    'accepted', true,
    'canceled', true,
    'quoteRequestId', v_request.id,
    'quoteRunId', v_quote_run.id,
    'status', 'canceled',
    'reasonCode', 'canceled',
    'reason', 'Quote request canceled.'
  );
end;
$$;

grant execute on function public.api_cancel_quote_request(uuid) to authenticated;

create or replace function public.api_list_client_quote_workspace(
  p_job_ids uuid[]
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with requested_jobs as (
    select distinct job.id
    from public.jobs job
    where job.id = any(coalesce(p_job_ids, '{}'::uuid[]))
      and public.user_can_access_job(job.id)
  ),
  latest_quote_runs as (
    select distinct on (run.job_id)
      run.*
    from public.quote_runs run
    join requested_jobs job on job.id = run.job_id
    left join public.quote_requests request_row on request_row.id = run.quote_request_id
    where run.quote_request_id is null
      or request_row.status is distinct from 'canceled'
    order by run.job_id, run.created_at desc, run.id desc
  ),
  selected_offers as (
    select
      job.id as job_id,
      offer.id as offer_id,
      case
        when offer.id is null then null
        else to_jsonb(offer)
      end as selected_offer
    from requested_jobs job
    join public.jobs job_row on job_row.id = job.id
    left join public.vendor_quote_offers offer on offer.id = job_row.selected_vendor_quote_offer_id
  ),
  vendor_quote_projection as (
    select
      run.job_id,
      coalesce(
        jsonb_agg(
          to_jsonb(result) || jsonb_build_object(
            'offers',
            coalesce(
              (
                select jsonb_agg(to_jsonb(offer) order by offer.sort_rank, offer.total_price_usd, offer.id)
                from public.vendor_quote_offers offer
                where offer.vendor_quote_result_id = result.id
              ),
              '[]'::jsonb
            ),
            'artifacts',
            coalesce(
              (
                select jsonb_agg(to_jsonb(artifact) order by artifact.created_at, artifact.id)
                from public.vendor_quote_artifacts artifact
                where artifact.vendor_quote_result_id = result.id
              ),
              '[]'::jsonb
            )
          )
          order by result.requested_quantity, result.part_id, result.vendor
        ),
        '[]'::jsonb
      ) as vendor_quotes
    from latest_quote_runs run
    join public.vendor_quote_results result on result.quote_run_id = run.id
    group by run.job_id
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'jobId', job.id,
        'latestQuoteRun',
        case
          when run.id is null then null
          else to_jsonb(run)
        end,
        'selectedOffer', selected.selected_offer,
        'vendorQuotes', coalesce(projection.vendor_quotes, '[]'::jsonb)
      )
      order by job.id
    ),
    '[]'::jsonb
  )
  from requested_jobs job
  left join latest_quote_runs run on run.job_id = job.id
  left join selected_offers selected on selected.job_id = job.id
  left join vendor_quote_projection projection on projection.job_id = job.id;
$$;
