insert into public.work_queue (
  organization_id,
  job_id,
  part_id,
  task_type,
  payload
)
select
  part.organization_id,
  part.job_id,
  part.id,
  'generate_cad_preview',
  jsonb_build_object(
    'source', 'cad_preview_backfill',
    'partId', part.id,
    'jobId', part.job_id,
    'cadFileId', cad_file.id
  )
from public.parts part
join public.job_files cad_file on cad_file.id = part.cad_file_id
where lower(cad_file.original_name) ~ '\.(step|stp)$'
  and not exists (
    select 1
    from public.cad_preview_assets asset
    where asset.part_id = part.id
      and asset.display_style = 'hidden_lines_removed'
      and asset.view_orientation = 'isometric'
  )
  and not exists (
    select 1
    from public.work_queue queue
    where queue.part_id = part.id
      and queue.task_type = 'generate_cad_preview'
      and queue.status in ('queued', 'running')
  );
