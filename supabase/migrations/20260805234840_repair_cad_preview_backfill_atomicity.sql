alter table public.cad_preview_assets
drop constraint if exists cad_preview_assets_display_style_check;

alter table public.cad_preview_assets
add constraint cad_preview_assets_display_style_check
check (display_style in ('hidden_lines_removed', 'sketch')); -- NOSONAR: immutable enum literals must match stored values.

alter table public.cad_preview_assets
alter column display_style set default 'sketch'; -- NOSONAR: immutable enum literals must match stored values.

with ranked_active_preview_tasks as (
  select
    id,
    row_number() over (
      partition by part_id
      order by (status = 'running') desc, created_at, id -- NOSONAR: queue status literals are part of the persisted contract.
    ) as active_rank
  from public.work_queue
  where part_id is not null
    and task_type = 'generate_cad_preview' -- NOSONAR: task-type predicates intentionally repeat across DDL and DML.
    and status in ('queued', 'running') -- NOSONAR: partial-index and conflict predicates must be identical.
)
update public.work_queue queue
set
  status = 'cancelled',
  locked_at = null,
  locked_by = null,
  last_error = coalesce(queue.last_error, 'Superseded by another active CAD preview task.'),
  updated_at = timezone('utc', now())
from ranked_active_preview_tasks ranked
where queue.id = ranked.id
  and ranked.active_rank > 1;

create unique index if not exists idx_work_queue_active_cad_preview_per_part
on public.work_queue(part_id)
where task_type = 'generate_cad_preview' -- NOSONAR: task-type predicates intentionally repeat across DDL and DML.
  and status in ('queued', 'running'); -- NOSONAR: partial-index and conflict predicates must be identical.

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
  'generate_cad_preview', -- NOSONAR: persisted task type must match the index predicate.
  jsonb_build_object(
    'source', 'cad_preview_atomic_backfill',
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
      and asset.display_style = 'sketch' -- NOSONAR: immutable enum literals must match stored values.
      and asset.view_orientation = 'isometric'
  )
on conflict (part_id)
where task_type = 'generate_cad_preview' -- NOSONAR: task-type predicates intentionally repeat across DDL and DML.
  and status in ('queued', 'running') -- NOSONAR: partial-index and conflict predicates must be identical.
do nothing;
