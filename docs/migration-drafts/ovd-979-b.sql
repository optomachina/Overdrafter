-- =====================================================================
-- NEEDS BLAINE MIGRATION WINDOW - not applied
-- =====================================================================
-- OVD-979 (part b, finding 1b-b): public.api_request_extraction(uuid)
-- queues one extraction when a drawing is attached to a part whose only
-- extraction was made without a drawing (CAD-only).
--
-- This file is a DRAFT. It is not under supabase/migrations/, is not part of
-- migration lineage and has not been applied to any database. Promote it only
-- inside a Blaine-approved migration window, AFTER ovd-979-a.sql (part a makes
-- the re-extraction unable to revert user corrections). Rollback:
-- ovd-979-b.rollback.sql. Notes: docs/migration-drafts/ovd-979-notes.md.
--
-- Problem: attaching a drawing to an existing job is upload ->
-- api_reconcile_job_parts (sets parts.drawing_file_id through its upsert) ->
-- api_request_extraction (latest definition 20260812042000). That function
-- queues extract_part only for parts with NO drawing_extractions row, so a part
-- first extracted CAD-only (worker extractor_version 'worker-sim-v1') is never
-- extracted from its new drawing.
--
-- Change (and nothing else):
--   1. A part is also queued when it now has a drawing_file_id and its
--      extraction row was written by the worker without a drawing
--      (extractor_version like 'worker-sim-%'; the worker sets
--      currentExtractorVersion(false) = SIM_EXTRACTOR_VERSION in
--      worker/src/extraction/sharedResult.ts). Rows from other producers
--      ('v1' default, importers, pdf extractions) are never re-queued.
--   2. That task's payload adds reason = 'drawing_attached' and drawingFileId;
--      the original payload for a never-extracted part is byte-identical.
--   3. Dedupe: the existing rule (no extract_part queued or running for the
--      part) still applies to both branches; the new branch is also skipped
--      when an extract_part task for the same part and the same drawingFileId
--      already completed (exactly one extraction per attached drawing, even if
--      the trusted-reuse path completed without replacing the CAD-only row).
--      A failed task may be queued again by a later call, as for a new part.
--   4. A transaction-scoped advisory lock per job, taken after the access
--      checks, serializes concurrent calls for the same job so the not-exists
--      dedupe also holds under concurrency (same pattern as
--      private.lock_job_export_state). It takes no row lock, so it cannot
--      invert the parts -> jobs lock order that api_auto_approve uses.
--   5. Job status: a request that queued at least one never-extracted part
--      sets 'extracting' exactly as before. A request that queued only
--      drawing_attached tasks sets 'extracting' only for a job in uploaded,
--      extracting, needs_spec_review or ready_to_quote; a job in quoting or a
--      later state keeps its status (the task is still queued and runs).
-- ORDERING (blocks apply): apply this file only after OVD-976 (unit-aware
-- drawing tolerance parsing in the worker) is deployed, and only after
-- ovd-979-a.sql. Part a also stops a drawing-attach extraction from filling a
-- null tolerance, but OVD-976 is the fix for the mis-scaled value itself.
-- Security: SECURITY DEFINER and set search_path = public kept exactly;
-- require_verified_auth() and user_can_edit_job() unchanged and still run
-- before anything else; CREATE OR REPLACE keeps owner and ACL; the OVD-736
-- revoke/grant is restated verbatim (EXECUTE for authenticated and
-- service_role, not PUBLIC or anon). No grant is widened.
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
  v_new_part_count integer := 0;
begin
  perform public.require_verified_auth();

  select * into v_job from public.jobs where id = p_job_id;
  if v_job.id is null then
    raise exception 'Job % not found', p_job_id;
  end if;
  if not public.user_can_edit_job(v_job.id) then
    raise exception 'You do not have access to job %', p_job_id;
  end if;

  -- OVD-979: one request per job at a time, so the dedupe below cannot race.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('ovd979:extract-request:' || p_job_id::text, 0)
  );

  perform public.api_reconcile_job_parts(p_job_id);

  with enqueued as (
    insert into public.work_queue (
      organization_id, job_id, part_id, task_type, payload
    )
    select
      v_job.organization_id, p_job_id, part.id, 'extract_part',
      case
        when placement_extraction.id is null then
          jsonb_build_object('partId', part.id, 'jobId', p_job_id)
        else
          jsonb_build_object(
            'partId', part.id,
            'jobId', p_job_id,
            'reason', 'drawing_attached',
            'drawingFileId', part.drawing_file_id
          )
      end
    from public.parts part
    left join public.drawing_extractions placement_extraction
      on placement_extraction.part_id = part.id
    where part.job_id = p_job_id
      and (
        placement_extraction.id is null
        -- OVD-979: a drawing attached after a CAD-only extraction.
        or (
          part.drawing_file_id is not null
          and placement_extraction.extractor_version like 'worker-sim-%'
          and not exists (
            select 1 from public.work_queue done
            where done.part_id = part.id
              and done.task_type = 'extract_part'
              and done.status = 'completed'
              and done.payload ->> 'drawingFileId' = part.drawing_file_id::text
          )
        )
      )
      and not exists (
        select 1 from public.work_queue queue
        where queue.part_id = part.id
          and queue.task_type = 'extract_part'
          and queue.status in ('queued', 'running')
      )
    returning id, payload ->> 'reason' as reason
  )
  select count(*)::integer, (count(*) filter (where reason is null))::integer
  into v_count, v_new_part_count
  from enqueued;

  -- OVD-979: a queued new part sets 'extracting' as before. A request that
  -- queued only drawing_attached tasks changes the status only for a job that
  -- has not started quoting; quoting and later keep their status, and the
  -- queued extraction still runs.
  update public.jobs
  set status = case
    when v_new_part_count > 0 then 'extracting'
    when v_count > 0 and status in ('uploaded', 'extracting', 'needs_spec_review', 'ready_to_quote')
      then 'extracting'
    else status
  end
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
