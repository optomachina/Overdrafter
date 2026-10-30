-- OVD-979 U5 rollback: restore U4-era request/claim bodies byte for byte.
-- Apply transactionally; retain all task history and nullable U3 identities.
DROP TRIGGER IF EXISTS merge_pending_drawing_extraction ON public.work_queue;
DROP FUNCTION IF EXISTS private.merge_pending_drawing_extraction();
DROP INDEX IF EXISTS public.work_queue_one_active_extract_per_part;

create or replace function public.api_request_extraction(p_job_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.jobs%rowtype;
  v_count integer := 0;
begin
  perform public.require_verified_auth();

  select * into v_job from public.jobs where id = p_job_id;
  if v_job.id is null then
    raise exception 'Job % not found', p_job_id;
  end if;
  if not public.user_can_edit_job(v_job.id) then
    raise exception 'You do not have access to job %', p_job_id;
  end if;

  perform public.api_reconcile_job_parts(p_job_id);

  with enqueued as (
    insert into public.work_queue (
      organization_id, job_id, part_id, task_type, payload
    )
    select
      v_job.organization_id, p_job_id, part.id, 'extract_part',
      jsonb_build_object('partId', part.id, 'jobId', p_job_id)
    from public.parts part
    where part.job_id = p_job_id
      and not exists (
        select 1 from public.drawing_extractions placement_extraction
        where placement_extraction.part_id = part.id
      )
      and not exists (
        select 1 from public.work_queue queue
        where queue.part_id = part.id
          and queue.task_type = 'extract_part'
          and queue.status in ('queued', 'running')
      )
    returning id
  )
  select count(*)::integer into v_count from enqueued;

  update public.jobs
  set status = case when v_count > 0 then 'extracting' else status end
  where id = p_job_id;

  perform public.log_audit_event(
    v_job.organization_id,
    'job.extraction_requested',
    jsonb_build_object('jobId', p_job_id, 'tasksQueued', v_count),
    p_job_id,
    null
  );
  return v_count;
end;
$$;
REVOKE ALL ON FUNCTION public.api_request_extraction(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.api_request_extraction(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.api_claim_next_task(p_worker_name text)
RETURNS SETOF public.work_queue
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_task public.work_queue;
BEGIN
  SELECT *
    INTO v_task
    FROM public.work_queue
   WHERE status = 'queued'
     AND available_at <= now()
   ORDER BY created_at ASC
   LIMIT 1
     FOR UPDATE SKIP LOCKED;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  UPDATE public.work_queue
     SET status     = 'running',
         locked_at  = now(),
         locked_by  = p_worker_name,
         attempts   = attempts + 1,
         attempt_id = gen_random_uuid()
   WHERE id = v_task.id
  RETURNING * INTO v_task;

  RETURN NEXT v_task;
END;
$$;

REVOKE ALL ON FUNCTION public.api_claim_next_task(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_claim_next_task(text) TO service_role;
