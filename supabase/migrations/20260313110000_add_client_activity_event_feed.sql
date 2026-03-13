create index if not exists idx_audit_events_job_created_at
on public.audit_events(job_id, created_at desc);

drop function if exists public.api_list_client_activity_events(uuid[], integer);

create or replace function public.api_list_client_activity_events(
  p_job_ids uuid[],
  p_limit_per_job integer default 6
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
  eligible_events as (
    select
      audit_event.id,
      audit_event.job_id,
      audit_event.package_id,
      audit_event.event_type,
      audit_event.payload,
      audit_event.created_at,
      row_number() over (
        partition by audit_event.job_id
        order by audit_event.created_at desc, audit_event.id desc
      ) as job_rank
    from public.audit_events audit_event
    join requested_jobs job on job.id = audit_event.job_id
    where audit_event.event_type = any (
      array[
        'job.created',
        'job.extraction_requested',
        'worker.extraction_completed',
        'worker.extraction_failed',
        'client.part_request_updated',
        'job.requirements_approved',
        'job.quote_run_started',
        'worker.quote_run_completed',
        'worker.quote_run_attention_needed',
        'worker.quote_run_failed',
        'job.quote_package_published',
        'client.quote_option_selected'
      ]
    )
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', event.id,
        'jobId', event.job_id,
        'packageId', event.package_id,
        'eventType', event.event_type,
        'payload', event.payload,
        'occurredAt', event.created_at
      )
      order by event.created_at desc, event.id desc
    ),
    '[]'::jsonb
  )
  from eligible_events event
  where event.job_rank <= greatest(coalesce(p_limit_per_job, 6), 1);
$$;

grant execute on function public.api_list_client_activity_events(uuid[], integer) to authenticated;
