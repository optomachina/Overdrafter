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
  manufacturing_quote_line_items as (
    select
      line_item.job_id,
      line_item.id as service_request_line_item_id
    from public.service_request_line_items line_item
    join requested_jobs job on job.id = line_item.job_id
    where line_item.service_type = 'manufacturing_quote'
      and line_item.scope = 'part'
  ),
  candidate_quote_runs as (
    select
      run.*, 
      request_row.status as request_status,
      request_row.service_request_line_item_id as request_service_request_line_item_id,
      line_item.service_request_line_item_id as canonical_service_request_line_item_id
    from public.quote_runs run
    join requested_jobs job on job.id = run.job_id
    left join public.quote_requests request_row on request_row.id = run.quote_request_id
    left join manufacturing_quote_line_items line_item on line_item.job_id = run.job_id
    where run.quote_request_id is null
      or request_row.status is distinct from 'canceled'
  ),
  latest_quote_runs as (
    select distinct on (run.job_id)
      run.*
    from candidate_quote_runs run
    where
      -- Legacy fallback: pre-line-item quote runs are still eligible.
      run.quote_request_id is null
      or run.canonical_service_request_line_item_id is null
      or run.request_service_request_line_item_id is null
      or run.request_service_request_line_item_id = run.canonical_service_request_line_item_id
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

grant execute on function public.api_list_client_quote_workspace(uuid[]) to authenticated;

comment on function public.build_manufacturing_quote_service_detail(uuid)
is 'Returns JSONB service_detail for manufacturing quote line items. Contract: { origin: text, requestBridge: { requestedServiceKinds: jsonb array, primaryServiceKind: text|null, serviceNotes: text|null }, quoteRequest: { requestedQuoteQuantities: jsonb array, requestedByDate: date|null } }.';
