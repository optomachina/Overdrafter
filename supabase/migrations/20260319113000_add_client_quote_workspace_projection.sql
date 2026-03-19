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
            '[]'::jsonb
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
