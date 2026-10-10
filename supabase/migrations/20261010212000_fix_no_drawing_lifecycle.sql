-- Fix OVD-670: When a part has no drawing file, lifecycle should be 'succeeded' not 'uploaded'
-- The 'uploaded' state causes "Waiting for drawing metadata" to show forever.
-- Parts without drawings are valid and should show a terminal state.

create or replace function public.api_list_client_part_metadata(
  p_job_ids uuid[]
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with requested_jobs as (
    select distinct job.id, job.organization_id, job.status
    from public.jobs job
    where job.id = any(coalesce(p_job_ids, '{}'::uuid[]))
      and public.user_can_access_job(job.id)
  ),
  latest_extract_tasks as (
    select distinct on (queue.part_id)
      queue.part_id,
      queue.status,
      queue.last_error,
      queue.payload,
      queue.created_at,
      queue.updated_at
    from public.work_queue queue
    join requested_jobs job on job.id = queue.job_id
    where queue.task_type = 'extract_part'
      and queue.part_id is not null
    order by queue.part_id, queue.created_at desc, queue.id desc
  ),
  part_projection as (
    select
      part.id as part_id,
      part.job_id,
      part.organization_id,
      part.quantity as part_quantity,
      (part.cad_file_id is not null) as has_cad_file,
      (part.drawing_file_id is not null) as has_drawing_file,
      requirement.id as requirement_id,
      requirement.description as requirement_description,
      requirement.part_number as requirement_part_number,
      requirement.revision as requirement_revision,
      requirement.material as requirement_material,
      requirement.finish as requirement_finish,
      requirement.tightest_tolerance_inch as requirement_tightest_tolerance_inch,
      requirement.quantity as requirement_quantity,
      requirement.quote_quantities as requirement_quote_quantities,
      requirement.requested_by_date as requirement_requested_by_date,
      nullif(trim(coalesce(requirement.spec_snapshot ->> 'process', '')), '') as requirement_process,
      nullif(trim(coalesce(requirement.spec_snapshot ->> 'notes', '')), '') as requirement_notes,
      nullif(trim(coalesce(requirement.spec_snapshot ->> 'quoteDescription', '')), '') as requirement_quote_description,
      nullif(trim(coalesce(requirement.spec_snapshot ->> 'quoteFinish', '')), '') as requirement_quote_finish,
      nullif(trim(coalesce(requirement.spec_snapshot ->> 'threads', '')), '') as requirement_threads,
      extraction.id as extraction_id,
      extraction.updated_at as extraction_updated_at,
      coalesce(
        (extraction.extraction -> 'missingFields')::jsonb,
        '[]'::jsonb
      ) as missing_fields,
      coalesce(
        (extraction.extraction -> 'reviewFields')::jsonb,
        '[]'::jsonb
      ) as review_fields,
      coalesce((extraction.extraction ->> 'warnings')::jsonb, '[]'::jsonb) as warnings,
      jsonb_array_length(coalesce((extraction.extraction ->> 'warnings')::jsonb, '[]'::jsonb)) as warning_count,
      (extraction.extraction ->> 'pageCount')::integer as extraction_page_count,
      task.status as latest_task_status,
      task.last_error as latest_task_error,
      task.payload as latest_task_payload,
      task.updated_at as latest_task_updated_at
    from requested_jobs job
    inner join public.parts part on part.job_id = job.id
    left join public.approved_part_requirements requirement on requirement.part_id = part.id
    left join public.drawing_extractions extraction on extraction.part_id = part.id
    left join latest_extract_tasks task on task.part_id = part.id
  ),
  projection_with_missing as (
    select
      projection.*,
      case
        when jsonb_array_length(projection.missing_fields) > 0 then
          jsonb_build_array(
            jsonb_build_object(
              'field', 'material',
              'extracted', coalesce(projection.requirement_material, 'Unknown material'),
              'missing', 'material' = any(
                array(select jsonb_array_elements_text(projection.missing_fields))
              )
            ),
            jsonb_build_object(
              'field', 'finish',
              'extracted', projection.requirement_finish,
              'missing', 'finish' = any(
                array(select jsonb_array_elements_text(projection.missing_fields))
              )
            ),
            jsonb_build_object(
              'field', 'tightestToleranceInch',
              'extracted', projection.requirement_tightest_tolerance_inch,
              'missing', 'tightestToleranceInch' = any(
                array(select jsonb_array_elements_text(projection.missing_fields))
              )
            )
          )
        else '[]'::jsonb
      end as missing_field_details,
      case
        when nullif(trim(coalesce(projection.requirement_material, '')), '') is null
          or trim(coalesce(projection.requirement_material, '')) = 'Unknown material' then 'Unknown material'
        else projection.requirement_material
      end as resolved_material,
      coalesce(
        nullif(trim(coalesce(projection.requirement_description, '')), ''),
        nullif(trim(coalesce(projection.requirement_part_number, '')), ''),
        'Untitled part'
      ) as resolved_description,
      nullif(trim(coalesce(projection.requirement_part_number, '')), '') as resolved_part_number,
      nullif(trim(coalesce(projection.requirement_revision, '')), '') as resolved_revision,
      nullif(trim(coalesce(projection.requirement_finish, '')), '') as resolved_finish,
      nullif(trim(coalesce(projection.requirement_process, '')), '') as resolved_process,
      nullif(trim(coalesce(projection.requirement_notes, '')), '') as resolved_notes,
      projection.requirement_tightest_tolerance_inch as resolved_tightest_tolerance_inch,
      greatest(coalesce(projection.requirement_quantity, projection.part_quantity, 1), 1) as resolved_quantity,
      coalesce(
        projection.requirement_quote_quantities,
        case
          when projection.part_quantity is not null and projection.part_quantity > 0
            then array[projection.part_quantity]::integer[]
          else array[1]::integer[]
        end
      ) as resolved_quote_quantities
    from part_projection projection
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'partId', projection.part_id,
        'jobId', projection.job_id,
        'organizationId', projection.organization_id,
        'hasCadFile', projection.has_cad_file,
        'hasDrawingFile', projection.has_drawing_file,
        'description', projection.resolved_description,
        'partNumber', projection.resolved_part_number,
        'revision', projection.resolved_revision,
        'quoteDescription', projection.requirement_quote_description,
        'material', nullif(trim(coalesce(projection.resolved_material, '')), ''),
        'finish', projection.resolved_finish,
        'quoteFinish', projection.requirement_quote_finish,
        'threads', projection.requirement_threads,
        'tightestToleranceInch', projection.resolved_tightest_tolerance_inch,
        'process', projection.resolved_process,
        'notes', projection.resolved_notes,
        'quantity', projection.resolved_quantity,
        'quoteQuantities', projection.resolved_quote_quantities,
        'requestedByDate', projection.requirement_requested_by_date,
        'clientExtraction', jsonb_build_object(
          'warningCount', coalesce(projection.warning_count, 0),
        'warnings', coalesce(projection.warnings, '[]'::jsonb),
        'missingFields', coalesce(
          (
            select jsonb_agg(m.value)
            from jsonb_array_elements_text(projection.missing_fields) m(value)
            where nullif(trim(m.value), '') is not null
          ),
          '[]'::jsonb
        ),
        'reviewFields', coalesce(
          (
            select jsonb_agg(r.value)
            from jsonb_array_elements_text(projection.review_fields) r(value)
            where nullif(trim(r.value), '') is not null
          ),
          '[]'::jsonb
        ),
        'lastFailureCode', nullif(trim(coalesce(projection.latest_task_payload ->> 'failureCode', '')), ''),
        'lastFailureMessage', nullif(trim(coalesce(projection.latest_task_error, projection.latest_task_payload ->> 'failureMessage', '')), ''),
        'extractedAt', projection.extraction_updated_at,
        'failedAt',
          case
            when projection.latest_task_status = 'failed' then projection.latest_task_updated_at
            else null
          end,
          'updatedAt', greatest(
            coalesce(projection.extraction_updated_at, '-infinity'::timestamptz),
            coalesce(projection.latest_task_updated_at, '-infinity'::timestamptz)
          ),
        'lifecycle',
          case
            when not projection.has_drawing_file then 'succeeded'
            when projection.latest_task_status = 'queued' then 'queued'
            when projection.latest_task_status = 'running' then 'extracting'
            when projection.latest_task_status = 'failed'
              and (
                projection.extraction_updated_at is null
                or projection.latest_task_updated_at >= projection.extraction_updated_at
              ) then 'failed'
            when projection.extraction_id is null and projection.has_drawing_file then 'extracting'
            when jsonb_array_length(projection.missing_fields) > 0
              or jsonb_array_length(projection.review_fields) > 0
              or projection.warning_count > 0 then 'partial'
            else 'succeeded'
          end,
          'pageCount', coalesce(projection.extraction_page_count, 0),
          'hasCadFile', projection.has_cad_file,
          'hasDrawingFile', projection.has_drawing_file
        )
      )
      order by projection.job_id, projection.part_id
    ),
    '[]'::jsonb
  )
  from projection_with_missing projection;
$$;
