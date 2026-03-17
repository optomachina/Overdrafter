alter type public.queue_task_type add value if not exists 'debug_extract_part';

create table if not exists public.debug_extraction_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  job_id uuid not null references public.jobs(id) on delete cascade,
  part_id uuid not null references public.parts(id) on delete cascade,
  requested_by uuid not null,
  status public.queue_task_status not null default 'queued',
  requested_model text not null,
  effective_model text null,
  worker_build_version text null,
  extractor_version text null,
  model_fallback_used boolean null,
  model_prompt_version text null,
  result jsonb not null default '{}'::jsonb,
  error text null,
  started_at timestamptz null,
  completed_at timestamptz null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_debug_extraction_runs_part_created
on public.debug_extraction_runs(part_id, created_at desc);

create index if not exists idx_debug_extraction_runs_job_created
on public.debug_extraction_runs(job_id, created_at desc);

create index if not exists idx_debug_extraction_runs_status
on public.debug_extraction_runs(status, created_at desc);

drop trigger if exists touch_debug_extraction_runs_updated_at on public.debug_extraction_runs;
create trigger touch_debug_extraction_runs_updated_at
before update on public.debug_extraction_runs
for each row execute function public.touch_updated_at();

alter table public.debug_extraction_runs enable row level security;

drop policy if exists "debug_extraction_runs_internal_only" on public.debug_extraction_runs;
create policy "debug_extraction_runs_internal_only"
on public.debug_extraction_runs
for select
to authenticated
using (public.is_internal_user(organization_id));

drop policy if exists "debug_extraction_runs_manage_internal" on public.debug_extraction_runs;
create policy "debug_extraction_runs_manage_internal"
on public.debug_extraction_runs
for all
to authenticated
using (public.is_internal_user(organization_id))
with check (public.is_internal_user(organization_id));

create or replace function public.api_request_debug_extraction(
  p_part_id uuid,
  p_model text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_part public.parts%rowtype;
  v_job public.jobs%rowtype;
  v_default_model constant text := 'gpt-5.4';
  v_allowed_models constant text[] := array['gpt-5.4', 'gpt-5.4-mini'];
  v_requested_model text;
  v_debug_run_id uuid;
begin
  perform public.require_verified_auth();

  select *
  into v_part
  from public.parts
  where id = p_part_id;

  if v_part.id is null then
    raise exception 'Part % not found', p_part_id;
  end if;

  select *
  into v_job
  from public.jobs
  where id = v_part.job_id;

  if v_job.id is null then
    raise exception 'Job % not found for part %', v_part.job_id, p_part_id;
  end if;

  if not public.is_internal_user(v_job.organization_id) then
    raise exception 'You do not have access to debug extraction for part %', p_part_id;
  end if;

  v_requested_model := nullif(trim(coalesce(p_model, '')), '');

  if v_requested_model is not null and not (v_requested_model = any(v_allowed_models)) then
    raise exception 'Requested debug extraction model "%" is not allowed', v_requested_model;
  end if;

  insert into public.debug_extraction_runs (
    organization_id,
    job_id,
    part_id,
    requested_by,
    requested_model
  ) values (
    v_job.organization_id,
    v_job.id,
    v_part.id,
    auth.uid(),
    coalesce(v_requested_model, v_default_model)
  )
  returning id into v_debug_run_id;

  insert into public.work_queue (
    organization_id,
    job_id,
    part_id,
    task_type,
    payload
  ) values (
    v_job.organization_id,
    v_job.id,
    v_part.id,
    'debug_extract_part',
    jsonb_build_object(
      'jobId', v_job.id,
      'partId', v_part.id,
      'debugRunId', v_debug_run_id,
      'requestedModel', coalesce(v_requested_model, v_default_model)
    )
  );

  perform public.log_audit_event(
    v_job.organization_id,
    'job.debug_extraction_requested',
    jsonb_build_object(
      'jobId', v_job.id,
      'partId', v_part.id,
      'debugRunId', v_debug_run_id,
      'requestedModel', coalesce(v_requested_model, v_default_model)
    ),
    v_job.id,
    null
  );

  return v_debug_run_id;
end;
$$;

grant execute on function public.api_request_debug_extraction(uuid, text) to authenticated;
