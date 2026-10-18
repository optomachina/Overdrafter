-- =====================================================================
-- NEEDS BLAINE MIGRATION WINDOW - not applied
-- =====================================================================
-- OVD-979 (part b) ROLLBACK for docs/migration-drafts/ovd-979-b.sql.
--
-- DRAFT. Not applied. Restores public.api_request_extraction(uuid) verbatim
-- from supabase/migrations/20260812042000_add_canonical_part_identity.sql
-- (set search_path = public, SECURITY DEFINER) and the OVD-736 ACL
-- (EXECUTE for authenticated and service_role; none for PUBLIC or anon).
-- Idempotent: replays cleanly. extract_part tasks the draft queued are left in
-- work_queue (ordinary tasks; the worker completes or fails them).
-- =====================================================================

begin;

-- Reused versions already have technical extraction/preview data. New versions
-- still queue one extraction per placement as before; exact reuse does not.
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

-- Restated exactly as 20261015074957_ovd736_revoke_anon_definer_execute.sql left it.
revoke execute on function public.api_request_extraction(uuid) from public, anon;
grant execute on function public.api_request_extraction(uuid) to authenticated, service_role;

commit;
