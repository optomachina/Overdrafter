alter table public.cad_preview_assets
drop constraint if exists cad_preview_assets_display_style_check;

alter table public.cad_preview_assets
add constraint cad_preview_assets_display_style_check
check (display_style in ('hidden_lines_removed', 'sketch'));

alter table public.cad_preview_assets
alter column display_style set default 'sketch';

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
    'source', 'cad_preview_sketch_backfill',
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
      and asset.display_style <> 'hidden_lines_removed'
      and asset.view_orientation = 'isometric'
  )
  and not exists (
    select 1
    from public.work_queue queue
    where queue.part_id = part.id
      and queue.task_type = 'generate_cad_preview'
      and queue.status in ('queued', 'running')
  );
