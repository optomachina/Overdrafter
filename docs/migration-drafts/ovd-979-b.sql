-- =====================================================================
-- OVD-979 (part b, finding 1b-b): public.api_request_extraction(uuid)
-- queues one extraction when a drawing is attached to a part whose only
-- extraction was made without a drawing (CAD-only), and
-- public.api_reuse_trusted_part_version_artifacts(uuid, uuid, uuid) lets the
-- reuse of an identical package replace that CAD-only extraction. Since fix
-- round 7 a trigger on public.work_queue releases a drawing extraction that
-- api_request_extraction deferred behind a running extract_part task.
--
-- This file and docs/migration-drafts/ovd-979-b.sql are byte-identical copies
-- of one reviewed definition. It is not applied to production: that is a
-- protected action that needs a Blaine-approved migration window. Apply it
-- only AFTER part a (20261020002126, which makes the re-extraction unable to
-- revert user corrections). Rollback: docs/migration-drafts/ovd-979-b.rollback.sql.
-- Notes: docs/migration-drafts/ovd-979-notes.md.
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
--      ('v1' default, importers, pdf extractions) are never re-queued, except
--      as rule 7 says.
--   2. That task's payload adds reason = 'drawing_attached' and drawingFileId;
--      the original payload for a never-extracted part is byte-identical.
--   3. Dedupe: the existing rule (no extract_part queued or running for the
--      part) still applies to both branches; the new branch is also skipped
--      when an extract_part task for the same part and the same drawingFileId
--      already completed (exactly one extraction per attached drawing). A
--      failed task may be queued again by a later call, as for a new part (and,
--      for an attach task, also after its extraction was stored: rule 7).
--   4. A transaction-scoped advisory lock per job, taken after the access
--      checks, serializes concurrent calls for the same job so the not-exists
--      dedupe also holds under concurrency (same pattern as
--      private.lock_job_export_state). Since fix round 7 the function then
--      locks the job row before api_reconcile_job_parts locks parts, which is
--      the LOCK ORDER of 20261020002126 (job, parts, requirements, extractions,
--      work_queue); before, it locked parts first and the job last, which
--      auto-approval no longer does.
--   5. Job status: a request that queued at least one never-extracted part
--      sets 'extracting' exactly as before. A request that queued only
--      drawing_attached tasks sets 'extracting' only for a job in uploaded,
--      extracting, needs_spec_review or ready_to_quote; a job in quoting or a
--      later state keeps its status (the task is still queued and runs).
--   6. Review r2: when the attached CAD + drawing package equals a complete
--      version elsewhere in the organization, the worker reuses that version's
--      artifacts instead of extracting. api_reuse_trusted_part_version_artifacts
--      copied the source extraction with ON CONFLICT DO NOTHING, so a part that
--      already held a CAD-only extraction kept it, completed its task and (by
--      rule 3) was never extracted again. The reuse now replaces the row of a
--      part that has a drawing when that row is CAD-only (worker-sim-%) with
--      the source version's extraction. Every other row stays as it was. Apart
--      from rules 8 and 9, the rest of that function is verbatim from
--      20260812042000, ACL restated.
--   7. Review r6 (Codex): the worker stores the drawing_extractions row
--      (extractor_version 'worker-pdf-v3', so no longer worker-sim-%) before it
--      persists the previews and auto-approves (handleExtractTask in
--      worker/src/index.ts). An attach task that failed or was cancelled after
--      that point left a row that rule 1 no longer matched: the part could not
--      be retried, this function returned 0, and the approval and the previews
--      never finished. A part with a drawing is therefore also queued when a
--      failed or cancelled extract_part task for the same part and the same
--      drawingFileId exists, whatever extractor_version the row now has. Rule 3
--      still holds for it: nothing is queued while a task is queued or running,
--      and nothing once a task for this drawing has completed.
--   8. Review r10 (Codex): the worker assigns the canonical version before it
--      extracts, so a source placement whose attach task failed before it stored
--      anything owns a complete version and still holds the CAD-only extraction
--      it got before its drawing existed. The reuse (rule 6) copied that row
--      over the target's own CAD-only row and reported success: the target's
--      attach task completed without drawing data and, by rule 3, was never
--      extracted again. The reuse now returns artifactsReady false with
--      extractTargetIndependently true, and copies nothing, when the target has a
--      drawing and the source's extraction is CAD-only (worker-sim-%). The worker
--      then extracts the target from its own drawing (the path it already takes
--      when the source has no extraction). A package with no drawing is still
--      reused, and so is a source that holds a drawing extraction.
--   9. Review r11 (Codex): the worker stores the drawing_extractions row first
--      and persists the previews, auto-approves and marks the task completed
--      afterwards (handleExtractTask in worker/src/index.ts), so a source task
--      that failed or was cancelled in between leaves a drawing-derived row
--      (not CAD-only, so rule 8 does not apply) with possibly missing previews.
--      The reuse copied it, reported artifactsReady true and completed the
--      target's task, and rule 3 then kept the target from ever being repaired.
--      The reuse now trusts a source extraction only when the task that produced
--      it completed: the source needs an extract_part task with status
--      completed that no extract_part task of the same part that failed or was
--      cancelled and was created at or after it (a tie counts against the
--      source) follows. Otherwise (including a source with no extract_part task
--      at all) it returns artifactsReady false with extractTargetIndependently
--      true and copies nothing, and the worker extracts the target itself. The
--      check follows the pending checks, so a source whose retry is queued or
--      running is still waited for, and a source whose failed task was retried
--      to completion is reused again.
--  10. Fix round 7 (Codex, medium): a drawing attached while the part's
--      extract_part task was running (typically the CAD-only extraction, after
--      it stored its worker-sim row and before it completed) was skipped by the
--      queued-or-running dedupe, and nothing queued it when that task settled,
--      so the drawing was never extracted. Such a part now gets one deferred
--      drawing_attached task: status queued, payload.awaitingTaskId naming the
--      running task, available_at one hour ahead so api_claim_next_task cannot
--      take it while the running task can still write the part's extraction.
--      A new trigger on work_queue (release_deferred_drawing_extractions) sets
--      its available_at to now when the awaited task leaves queued or running
--      (completed, failed or cancelled), so it runs next. Nothing is deferred
--      when a task for the current drawing is running or has completed, or when
--      another task of the part is queued (the queued task reads the part when
--      it is claimed, and the deferred task is itself queued, so a second
--      request adds nothing). The function locks the job's running extract_part
--      tasks before it decides, so a settlement cannot slip between the
--      decision and the commit. The hour is a backstop for a missed release
--      (for example after the rollback drops the trigger): the reaper fails any
--      task left running for ten minutes.
--  11. Fix round 7 (Codex, medium; see item 11 of 20261020002126): the trusted
--      reuse stamps the target's drawing_extractions row (updated_at = now) when
--      the target has a drawing, after the copy, so the auto-approval that the
--      worker runs next sees a row written during its own claim. A kept row
--      (stored by a failed attempt) and a copied row (which carries the
--      source's timestamps) would otherwise read as older than the claim.
-- ORDERING (blocks apply): apply this file only after OVD-976 (unit-aware
-- drawing tolerance parsing in the worker) is deployed, and only after
-- ovd-979-a.sql. Part a also stops a drawing-attach extraction from filling a
-- null tolerance, but OVD-976 is the fix for the mis-scaled value itself.
-- Security: SECURITY DEFINER kept; set search_path = pg_catalog, public
-- (Blaine decision, 2026-10-18: the previous "public" fails the security-definer
-- lint; every relation in the body is schema-qualified, so behavior is the
-- same); require_verified_auth() and user_can_edit_job() unchanged and still run
-- before anything else; CREATE OR REPLACE keeps owner and ACL; the OVD-736
-- revoke/grant is restated verbatim (EXECUTE for authenticated and
-- service_role, not PUBLIC or anon). The reuse function keeps SECURITY DEFINER,
-- set search_path = pg_catalog and the service_role-only check of
-- 20260812042000, and its revoke/grant is restated verbatim. The trigger function
-- private.release_deferred_drawing_extractions() (fix round 7) is SECURITY
-- DEFINER with search_path = pg_catalog, so the release does not depend on the
-- privileges of whoever settles the task; EXECUTE is revoked from PUBLIC, anon
-- and authenticated and granted to service_role only (a trigger function is
-- never called directly). No grant is widened.
-- =====================================================================

begin;

-- Reused versions already have technical extraction/preview data. New versions
-- still queue one extraction per placement as before; exact reuse does not.
create or replace function public.api_request_extraction(p_job_id uuid)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
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

  -- OVD-979 (fix round 7): lock 1 of the LOCK ORDER of 20261020002126 (the job
  -- row) before api_reconcile_job_parts locks parts, as auto-approval does.
  perform 1 from public.jobs where id = p_job_id for no key update;

  perform public.api_reconcile_job_parts(p_job_id);

  -- OVD-979 (fix round 7, rule 10): lock 5, the job's running extract_part
  -- tasks. A settlement that commits after this waits for this request and then
  -- releases the task deferred below (the settlement trigger); one that
  -- committed before is seen as settled by the insert, which queues normally.
  perform 1 from public.work_queue running
  where running.job_id = p_job_id
    and running.task_type = 'extract_part'
    and running.status = 'running'
  for no key update;

  with enqueued as (
    insert into public.work_queue (
      organization_id, job_id, part_id, task_type, payload, available_at
    )
    select
      v_job.organization_id, p_job_id, part.id, 'extract_part',
      case
        when placement_extraction.id is null and running_task.id is null then
          jsonb_build_object('partId', part.id, 'jobId', p_job_id)
        else
          jsonb_build_object(
            'partId', part.id,
            'jobId', p_job_id,
            'reason', 'drawing_attached',
            'drawingFileId', part.drawing_file_id
          )
          -- OVD-979 (fix round 7, rule 10): the task this one waits for.
          || case
            when running_task.id is null then '{}'::jsonb
            else jsonb_build_object('awaitingTaskId', running_task.id)
          end
      end,
      -- A deferred task is not claimable (api_claim_next_task needs
      -- available_at <= now()) until the task it waits for settles; the
      -- settlement trigger below releases it then. The hour is only a backstop:
      -- the worker's reaper fails a task left running for more than ten minutes.
      case
        when running_task.id is null then timezone('utc', now())
        else timezone('utc', now()) + interval '1 hour'
      end
    from public.parts part
    left join public.drawing_extractions placement_extraction
      on placement_extraction.part_id = part.id
    -- OVD-979 (fix round 7, rule 10): the part's running extract_part task, if
    -- any (the dedupe allows at most one).
    left join lateral (
      select running.id
      from public.work_queue running
      where running.job_id = p_job_id
        and running.part_id = part.id
        and running.task_type = 'extract_part'
        and running.status = 'running'
      order by running.created_at desc, running.id desc
      limit 1
    ) running_task on true
    where part.job_id = p_job_id
      and (
        placement_extraction.id is null
        -- OVD-979: a drawing attached after a CAD-only extraction.
        or (
          part.drawing_file_id is not null
          and (
            placement_extraction.extractor_version like 'worker-sim-%'
            -- OVD-979 (review r6): the worker stores the extraction row before it
            -- persists the previews and auto-approves, so an attach task that
            -- failed or was cancelled after that point left a row that is no
            -- longer CAD-only. The part is retried for as long as no task for
            -- this drawing has completed. Only attach tasks carry drawingFileId.
            or exists (
              select 1 from public.work_queue unsuccessful
              where unsuccessful.job_id = p_job_id
                and unsuccessful.part_id = part.id
                and unsuccessful.task_type = 'extract_part'
                and unsuccessful.status in ('failed', 'cancelled')
                and unsuccessful.payload ->> 'drawingFileId' = part.drawing_file_id::text
            )
          )
          and not exists (
            select 1 from public.work_queue done
            where done.job_id = p_job_id
              and done.part_id = part.id
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
          and queue.status = 'queued'
      )
      -- OVD-979 (fix round 7, rule 10): nothing is queued while a task runs,
      -- except one deferred drawing task when the running task does not read
      -- the current drawing (a CAD-only extraction claimed before the drawing
      -- was attached). Nothing is deferred once a task for this drawing runs
      -- or has completed.
      and (
        running_task.id is null
        or (
          part.drawing_file_id is not null
          and not exists (
            select 1 from public.work_queue same_drawing
            where same_drawing.job_id = p_job_id
              and same_drawing.part_id = part.id
              and same_drawing.task_type = 'extract_part'
              and same_drawing.status in ('running', 'completed')
              and same_drawing.payload ->> 'drawingFileId' = part.drawing_file_id::text
          )
        )
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

-- OVD-979 (review r2): verbatim from 20260812042000_add_canonical_part_identity.sql
-- except the conflict clause of the drawing_extractions insert and, since reviews
-- r10 and r11, the two early returns before that insert (all marked below).
create or replace function public.api_reuse_trusted_part_version_artifacts(
  p_target_part_id uuid,
  p_source_part_id uuid,
  p_part_version_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_target public.parts%rowtype;
  v_source public.parts%rowtype;
  v_version public.part_versions%rowtype;
  v_target_cad public.job_files%rowtype;
  v_target_drawing public.job_files%rowtype;
  v_source_cad public.job_files%rowtype;
  v_source_drawing public.job_files%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Trusted part reuse may only be completed by the worker.';
  end if;

  select part.* into v_target from public.parts part where part.id = p_target_part_id for update;
  select part.* into v_source from public.parts part where part.id = p_source_part_id;
  select version.* into v_version from public.part_versions version where version.id = p_part_version_id;

  if v_target.id is null or v_source.id is null or v_version.id is null
    or v_target.id = v_source.id
    or v_target.organization_id <> v_source.organization_id
    or v_target.part_version_id <> v_version.id
    or v_source.part_version_id <> v_version.id
    or v_version.version_state <> 'complete' then
    raise exception 'The trusted part reuse lineage is invalid.';
  end if;

  select file.* into v_target_cad from public.job_files file where file.id = v_target.cad_file_id;
  select file.* into v_target_drawing from public.job_files file where file.id = v_target.drawing_file_id;
  select file.* into v_source_cad from public.job_files file where file.id = v_source.cad_file_id;
  select file.* into v_source_drawing from public.job_files file where file.id = v_source.drawing_file_id;

  if v_target_cad.trusted_content_sha256 is distinct from v_source_cad.trusted_content_sha256
    or v_target_drawing.trusted_content_sha256 is distinct from v_source_drawing.trusted_content_sha256 then
    raise exception 'The trusted part package no longer matches its source version.';
  end if;

  -- An identical upload can finish hashing while the source placement is still
  -- extracting. Wait for that task to publish all extraction/preview artifacts
  -- instead of duplicating work or copying a partially written projection.
  if not exists (
      select 1 from public.drawing_extractions extraction
      where extraction.part_id = v_source.id
    ) then
    if not exists (
      select 1 from public.work_queue queue
      where queue.part_id = v_source.id
        and queue.task_type = 'extract_part'
        and queue.status in ('queued', 'running')
    ) then
      return pg_catalog.jsonb_build_object(
        'result', 'source_unavailable',
        'partId', v_target.id,
        'partVersionId', v_version.id,
        'sourcePartId', v_source.id,
        'artifactsReady', false,
        'extractTargetIndependently', true
      );
    end if;

    return pg_catalog.jsonb_build_object(
      'result', 'existing_version_pending',
      'partId', v_target.id,
      'partVersionId', v_version.id,
      'sourcePartId', v_source.id,
      'artifactsReady', false,
      'extractTargetIndependently', false
    );
  end if;

  if exists (
      select 1 from public.work_queue queue
      where queue.part_id = v_source.id
        and queue.task_type = 'extract_part'
        and queue.status in ('queued', 'running')
    ) then
    return pg_catalog.jsonb_build_object(
      'result', 'existing_version_pending',
      'partId', v_target.id,
      'partVersionId', v_version.id,
      'sourcePartId', v_source.id,
      'artifactsReady', false,
      'extractTargetIndependently', false
    );
  end if;

  -- OVD-979 (review r10, Codex): a part that has a drawing never takes the
  -- CAD-only extraction a source placement got before its own drawing existed
  -- (its attach task can fail after the version was assigned and before the
  -- drawing was extracted). Nothing is copied and the worker extracts the target
  -- from its own drawing, as it does when the source has no extraction.
  if v_target.drawing_file_id is not null
    and exists (
      select 1 from public.drawing_extractions extraction
      where extraction.part_id = v_source.id
        and extraction.extractor_version like 'worker-sim-%'
    ) then
    return pg_catalog.jsonb_build_object(
      'result', 'source_cad_only',
      'partId', v_target.id,
      'partVersionId', v_version.id,
      'sourcePartId', v_source.id,
      'artifactsReady', false,
      'extractTargetIndependently', true
    );
  end if;

  -- OVD-979 (review r11, Codex): the source's extraction is trusted only when the
  -- task that produced it completed. The worker stores the extraction row before
  -- it persists the previews and auto-approves, so a task that failed or was
  -- cancelled after that point leaves a drawing-derived row with possibly
  -- missing previews and nothing queued or running. The source therefore needs
  -- an extract_part task that completed and that no task of the same part that
  -- failed or was cancelled follows (created at or after it, so a tie counts
  -- against the source); a source with no such task is not trusted either.
  -- Nothing is copied and the worker extracts the target from its own files, as
  -- it does when the source has no extraction.
  if not exists (
      select 1 from public.work_queue finished
      where finished.job_id = v_source.job_id
        and finished.part_id = v_source.id
        and finished.task_type = 'extract_part'
        and finished.status = 'completed'
        and not exists (
          select 1 from public.work_queue unsuccessful
          where unsuccessful.job_id = v_source.job_id
            and unsuccessful.part_id = v_source.id
            and unsuccessful.task_type = 'extract_part'
            and unsuccessful.status in ('failed', 'cancelled')
            and unsuccessful.created_at >= finished.created_at
        )
    ) then
    return pg_catalog.jsonb_build_object(
      'result', 'source_extraction_unfinished',
      'partId', v_target.id,
      'partVersionId', v_version.id,
      'sourcePartId', v_source.id,
      'artifactsReady', false,
      'extractTargetIndependently', true
    );
  end if;

  insert into public.drawing_extractions (
    part_id, organization_id, extractor_version, extraction, confidence,
    warnings, evidence, status, created_at, updated_at
  )
  select
    v_target.id, extraction.organization_id, extraction.extractor_version,
    extraction.extraction, extraction.confidence, extraction.warnings,
    extraction.evidence, extraction.status, extraction.created_at, extraction.updated_at
  from public.drawing_extractions extraction
  where extraction.part_id = v_source.id
  -- OVD-979 (review r2): a part that has a drawing and still holds the CAD-only
  -- extraction the worker wrote before the drawing existed takes the source's
  -- drawing extraction. Any other existing row is kept, as before.
  on conflict (part_id) do update
  set extractor_version = excluded.extractor_version,
      extraction = excluded.extraction,
      confidence = excluded.confidence,
      warnings = excluded.warnings,
      evidence = excluded.evidence,
      status = excluded.status,
      updated_at = timezone('utc', now())
  where v_target.drawing_file_id is not null
    and public.drawing_extractions.extractor_version like 'worker-sim-%';

  -- OVD-979 (fix round 7, rule 11): the row of a part that has a drawing (copied,
  -- replaced or kept) is stamped now, inside the worker's claim, so the
  -- auto-approval the worker runs next has the per-claim completion evidence of
  -- 20261020002126 (stored.updated_at > queue.locked_at). A kept row was stored
  -- by an earlier, failed attempt and a copied row carries the source's time.
  update public.drawing_extractions extraction
  set updated_at = timezone('utc', now())
  where extraction.part_id = v_target.id
    and v_target.drawing_file_id is not null;

  insert into public.drawing_preview_assets (
    part_id, organization_id, page_number, kind, storage_bucket, storage_path,
    width, height, created_at
  )
  select
    v_target.id, asset.organization_id, asset.page_number, asset.kind,
    asset.storage_bucket, asset.storage_path, asset.width, asset.height, asset.created_at
  from public.drawing_preview_assets asset
  where asset.part_id = v_source.id
  on conflict (part_id, page_number, kind) do nothing;

  insert into public.cad_preview_assets (
    part_id, organization_id, source_cad_file_id, source_content_sha256,
    display_style, view_orientation, renderer_version, storage_bucket,
    storage_path, mime_type, width, height, generated_at, created_at, updated_at
  )
  select
    v_target.id, asset.organization_id, v_target.cad_file_id, asset.source_content_sha256,
    asset.display_style, asset.view_orientation, asset.renderer_version, asset.storage_bucket,
    asset.storage_path, asset.mime_type, asset.width, asset.height,
    asset.generated_at, asset.created_at, asset.updated_at
  from public.cad_preview_assets asset
  where asset.part_id = v_source.id
    and v_target.cad_file_id is not null
  on conflict (part_id, display_style, view_orientation) do nothing;

  perform public.log_audit_event(
    v_target.organization_id,
    'part.exact_version_reused',
    pg_catalog.jsonb_build_object(
      'jobId', v_target.job_id,
      'partId', v_target.id,
      'partVersionId', v_version.id
    ),
    v_target.job_id,
    null
  );

  return pg_catalog.jsonb_build_object(
    'result', 'existing_version',
    'partId', v_target.id,
    'partVersionId', v_version.id,
    'sourcePartId', v_source.id,
    'artifactsReady', true,
    'artifactsReused', true
  );
end;
$$;

revoke all on function public.api_reuse_trusted_part_version_artifacts(uuid, uuid, uuid)
from public, anon, authenticated;
grant execute on function public.api_reuse_trusted_part_version_artifacts(uuid, uuid, uuid)
to service_role;

-- OVD-979 (fix round 7, rule 10): when an extract_part task settles (the worker's
-- markTaskCompleted, markTaskFailed or markTaskCancelled, the reaper, or any
-- other status change out of queued or running), the drawing task that
-- api_request_extraction deferred behind it becomes claimable at once. Lock
-- order: this only locks work_queue rows of the settled task's part (lock 5).
create or replace function private.release_deferred_drawing_extractions()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  update public.work_queue deferred
  set available_at = timezone('utc', now())
  where deferred.job_id = new.job_id
    and deferred.part_id = new.part_id
    and deferred.task_type = 'extract_part'
    and deferred.status = 'queued'
    and deferred.payload ->> 'awaitingTaskId' = new.id::text
    and deferred.available_at > timezone('utc', now());
  return null;
end;
$$;

revoke all on function private.release_deferred_drawing_extractions()
from public, anon, authenticated;
grant execute on function private.release_deferred_drawing_extractions()
to service_role;

drop trigger if exists release_deferred_drawing_extractions on public.work_queue;
create trigger release_deferred_drawing_extractions
after update of status on public.work_queue
for each row
when (
  new.task_type = 'extract_part'
  and old.status in ('queued', 'running')
  and new.status in ('completed', 'failed', 'cancelled')
)
execute function private.release_deferred_drawing_extractions();

commit;
