-- =====================================================================
-- NEEDS BLAINE MIGRATION WINDOW - not applied
-- =====================================================================
-- OVD-979 (part b) ROLLBACK for docs/migration-drafts/ovd-979-b.sql.
--
-- DRAFT. Not applied. Restores public.api_request_extraction(uuid) verbatim
-- from supabase/migrations/20260812042000_add_canonical_part_identity.sql
-- (set search_path = public, SECURITY DEFINER) and the OVD-736 ACL
-- (EXECUTE for authenticated and service_role; none for PUBLIC or anon), and
-- public.api_reuse_trusted_part_version_artifacts(uuid, uuid, uuid) verbatim
-- from the same migration (ON CONFLICT DO NOTHING; service_role only).
-- Idempotent: replays cleanly. extract_part tasks the draft queued are left in
-- work_queue (ordinary tasks; the worker completes or fails them). Extractions
-- the reuse wrote over a CAD-only row while the draft was live keep their values.
-- Since fix round 7 it also drops the trigger release_deferred_drawing_extractions
-- on public.work_queue and its function private.release_deferred_drawing_extractions(),
-- which the draft added (nothing existed before). A drawing task the draft
-- deferred behind a running task and that is still waiting keeps its
-- available_at backstop (one hour after it was queued) and is claimed then.
-- =====================================================================

begin;

-- OVD-979 (fix round 7): the settlement trigger and its function did not exist
-- before the draft.
drop trigger if exists release_deferred_drawing_extractions on public.work_queue;
drop function if exists private.release_deferred_drawing_extractions();

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

-- Restated exactly as 20260812042000_add_canonical_part_identity.sql left it.
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
  on conflict (part_id) do nothing;

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

commit;
