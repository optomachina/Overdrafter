drop function if exists public.api_list_client_part_metadata(uuid[]);

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
      extraction.id as extraction_id,
      extraction.extraction,
      extraction.warnings,
      extraction.updated_at as extraction_updated_at,
      latest_task.status as latest_task_status,
      latest_task.last_error as latest_task_error,
      latest_task.payload as latest_task_payload,
      latest_task.updated_at as latest_task_updated_at,
      coalesce(jsonb_array_length(coalesce(extraction.warnings, '[]'::jsonb)), 0) as warning_count,
      coalesce(
        nullif(trim(coalesce(requirement.description, '')), ''),
        nullif(trim(coalesce(extraction.extraction ->> 'description', extraction.extraction ->> 'desc', '')), ''),
        null
      ) as resolved_description,
      coalesce(
        nullif(trim(coalesce(requirement.part_number, '')), ''),
        nullif(trim(coalesce(extraction.extraction ->> 'partNumber', extraction.extraction ->> 'pn', '')), ''),
        null
      ) as resolved_part_number,
      coalesce(
        nullif(trim(coalesce(requirement.revision, '')), ''),
        nullif(trim(coalesce(extraction.extraction ->> 'revision', extraction.extraction ->> 'rev', '')), ''),
        null
      ) as resolved_revision,
      coalesce(
        nullif(trim(coalesce(requirement.material, '')), ''),
        nullif(trim(coalesce(
          extraction.extraction #>> '{material,normalized}',
          extraction.extraction #>> '{material,raw}',
          extraction.extraction #>> '{material,raw_text}',
          extraction.extraction ->> 'material',
          ''
        )), ''),
        ''
      ) as resolved_material,
      coalesce(
        nullif(trim(coalesce(requirement.finish, '')), ''),
        nullif(trim(coalesce(
          extraction.extraction #>> '{finish,normalized}',
          extraction.extraction #>> '{finish,raw}',
          extraction.extraction #>> '{finish,raw_text}',
          extraction.extraction ->> 'finish',
          ''
        )), ''),
        null
      ) as resolved_finish,
      coalesce(
        requirement.tightest_tolerance_inch,
        nullif(extraction.extraction #>> '{tolerances,valueInch}', '')::numeric
      ) as resolved_tightest_tolerance_inch,
      coalesce(
        nullif(trim(coalesce(requirement.spec_snapshot ->> 'process', '')), ''),
        null
      ) as resolved_process,
      coalesce(
        nullif(trim(coalesce(requirement.spec_snapshot ->> 'notes', '')), ''),
        null
      ) as resolved_notes,
      coalesce(
        requirement.quantity,
        part.quantity,
        1
      ) as resolved_quantity,
      public.normalize_positive_integer_array(
        coalesce(requirement.quote_quantities, '{}'::integer[]),
        coalesce(requirement.quantity, part.quantity, 1)
      ) as resolved_quote_quantities,
      requirement.requested_by_date as resolved_requested_by_date,
      coalesce(nullif(extraction.extraction ->> 'pageCount', '')::integer, 0) as page_count
    from public.parts part
    join requested_jobs job on job.id = part.job_id
    left join public.approved_part_requirements requirement on requirement.part_id = part.id
    left join public.drawing_extractions extraction on extraction.part_id = part.id
    left join latest_extract_tasks latest_task on latest_task.part_id = part.id
  ),
  projection_with_missing as (
    select
      projection.*,
      array_remove(
        array[
          case when projection.resolved_description is null then 'description' end,
          case when projection.resolved_part_number is null then 'partNumber' end,
          case when projection.resolved_revision is null then 'revision' end,
          case when nullif(trim(coalesce(projection.resolved_material, '')), '') is null then 'material' end,
          case when projection.resolved_finish is null then 'finish' end,
          case when projection.resolved_tightest_tolerance_inch is null then 'tightestToleranceInch' end
        ],
        null
      ) as missing_fields
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
        'material', nullif(trim(coalesce(projection.resolved_material, '')), ''),
        'finish', projection.resolved_finish,
        'tightestToleranceInch', projection.resolved_tightest_tolerance_inch,
        'process', projection.resolved_process,
        'notes', projection.resolved_notes,
        'quantity', greatest(coalesce(projection.resolved_quantity, 1), 1),
        'quoteQuantities', projection.resolved_quote_quantities,
        'requestedByDate', projection.resolved_requested_by_date,
        'pageCount', projection.page_count,
        'warningCount', projection.warning_count,
        'warnings', coalesce(projection.warnings, '[]'::jsonb),
        'missingFields', to_jsonb(coalesce(projection.missing_fields, array[]::text[])),
        'lastFailureCode', nullif(trim(coalesce(projection.latest_task_payload ->> 'failureCode', '')), ''),
        'lastFailureMessage', nullif(trim(coalesce(projection.latest_task_error, projection.latest_task_payload ->> 'failureMessage', '')), ''),
        'extractedAt', projection.extraction_updated_at,
        'failedAt',
          case
            when projection.latest_task_status = 'failed' then projection.latest_task_updated_at
            else null
          end,
        'updatedAt',
          greatest(
            coalesce(projection.extraction_updated_at, '-infinity'::timestamptz),
            coalesce(projection.latest_task_updated_at, '-infinity'::timestamptz)
          ),
        'lifecycle',
          case
            when not projection.has_drawing_file then 'uploaded'
            when projection.latest_task_status = 'queued' then 'queued'
            when projection.latest_task_status = 'running' then 'extracting'
            when projection.latest_task_status = 'failed'
              and (
                projection.extraction_updated_at is null
                or projection.latest_task_updated_at >= projection.extraction_updated_at
              ) then 'failed'
            when projection.extraction_id is null and projection.has_drawing_file then 'extracting'
            when coalesce(array_length(projection.missing_fields, 1), 0) > 0 or projection.warning_count > 0 then 'partial'
            else 'succeeded'
          end
      )
      order by projection.job_id, projection.part_id
    ),
    '[]'::jsonb
  )
  from projection_with_missing projection;
$$;

grant execute on function public.api_list_client_part_metadata(uuid[]) to authenticated;

create or replace function public.api_auto_approve_job_requirements(p_job_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.jobs%rowtype;
  v_part public.parts%rowtype;
  v_requirement public.approved_part_requirements%rowtype;
  v_extraction public.drawing_extractions%rowtype;
  v_requested_service_kinds text[];
  v_primary_service_kind text;
  v_requires_material boolean;
  v_material text;
  v_finish text;
  v_tightest_tolerance_inch numeric;
  v_quantity integer;
  v_quote_quantities integer[];
  v_requested_by_date date;
  v_applicable_vendors public.vendor_name[] := array[]::public.vendor_name[];
  v_spec_snapshot jsonb;
  v_process text;
  v_notes text;
  v_description text;
  v_part_number text;
  v_revision text;
  v_count integer := 0;
  v_timestamp timestamptz := timezone('utc', now());
  v_pending_extract_tasks integer := 0;
  v_failed_extract_tasks integer := 0;
  v_unapproved_parts integer := 0;
begin
  select *
  into v_job
  from public.jobs
  where id = p_job_id;

  if v_job.id is null then
    raise exception 'Job % not found.', p_job_id;
  end if;

  v_requested_service_kinds := public.normalize_requested_service_kinds(
    v_job.requested_service_kinds,
    v_job.primary_service_kind
  );
  v_primary_service_kind := public.normalize_primary_service_kind(
    v_job.requested_service_kinds,
    v_job.primary_service_kind
  );
  v_requires_material := 'manufacturing_quote' = any(v_requested_service_kinds);

  for v_part in
    select *
    from public.parts
    where job_id = p_job_id
    order by created_at asc
  loop
    select *
    into v_requirement
    from public.approved_part_requirements
    where part_id = v_part.id;

    select *
    into v_extraction
    from public.drawing_extractions
    where part_id = v_part.id;

    if v_requirement.id is null and v_extraction.id is null then
      continue;
    end if;

    v_description := coalesce(
      nullif(trim(coalesce(v_requirement.description, '')), ''),
      nullif(trim(coalesce(v_extraction.extraction ->> 'description', v_extraction.extraction ->> 'desc', '')), ''),
      null
    );
    v_part_number := coalesce(
      nullif(trim(coalesce(v_requirement.part_number, '')), ''),
      nullif(trim(coalesce(v_extraction.extraction ->> 'partNumber', v_extraction.extraction ->> 'pn', '')), ''),
      null
    );
    v_revision := coalesce(
      nullif(trim(coalesce(v_requirement.revision, '')), ''),
      nullif(trim(coalesce(v_extraction.extraction ->> 'revision', v_extraction.extraction ->> 'rev', '')), ''),
      null
    );
    v_material := coalesce(
      nullif(trim(coalesce(v_requirement.material, '')), ''),
      nullif(trim(coalesce(
        v_extraction.extraction #>> '{material,normalized}',
        v_extraction.extraction #>> '{material,raw}',
        v_extraction.extraction #>> '{material,raw_text}',
        ''
      )), ''),
      case when v_requires_material then 'Unknown material' else '' end
    );
    v_finish := coalesce(
      nullif(trim(coalesce(v_requirement.finish, '')), ''),
      nullif(trim(coalesce(
        v_extraction.extraction #>> '{finish,normalized}',
        v_extraction.extraction #>> '{finish,raw}',
        v_extraction.extraction #>> '{finish,raw_text}',
        ''
      )), ''),
      null
    );
    v_tightest_tolerance_inch := coalesce(
      v_requirement.tightest_tolerance_inch,
      nullif(v_extraction.extraction #>> '{tolerances,valueInch}', '')::numeric
    );
    v_quantity := greatest(
      coalesce(v_requirement.quantity, v_part.quantity, v_job.requested_quote_quantities[1], 1),
      1
    );
    v_quote_quantities := public.normalize_positive_integer_array(
      coalesce(v_requirement.quote_quantities, v_job.requested_quote_quantities, '{}'::integer[]),
      v_quantity
    );
    v_quantity := coalesce(v_quote_quantities[1], v_quantity, 1);
    v_requested_by_date := coalesce(v_requirement.requested_by_date, v_job.requested_by_date);
    v_process := nullif(trim(coalesce(v_requirement.spec_snapshot ->> 'process', '')), '');
    v_notes := nullif(trim(coalesce(v_requirement.spec_snapshot ->> 'notes', '')), '');

    if coalesce(array_length(v_requirement.applicable_vendors, 1), 0) > 0 then
      v_applicable_vendors := v_requirement.applicable_vendors;
    else
      v_applicable_vendors := array['xometry', 'fictiv', 'protolabs']::public.vendor_name[];

      if coalesce(v_tightest_tolerance_inch, 0.005) >= 0.005 then
        v_applicable_vendors := array_append(v_applicable_vendors, 'sendcutsend'::public.vendor_name);
      end if;
    end if;

    v_spec_snapshot := coalesce(v_requirement.spec_snapshot, '{}'::jsonb)
      || jsonb_build_object(
        'requestedServiceKinds', v_requested_service_kinds,
        'primaryServiceKind', v_primary_service_kind,
        'serviceNotes', nullif(trim(coalesce(v_job.service_notes, '')), ''),
        'description', v_description,
        'partNumber', v_part_number,
        'revision', v_revision,
        'material', nullif(v_material, ''),
        'finish', v_finish,
        'tightestToleranceInch', v_tightest_tolerance_inch,
        'quantity', v_quantity,
        'quoteQuantities', v_quote_quantities,
        'requestedByDate', v_requested_by_date,
        'process', v_process,
        'notes', v_notes,
        'shipping', coalesce(v_requirement.spec_snapshot -> 'shipping', '{}'::jsonb),
        'certifications', coalesce(v_requirement.spec_snapshot -> 'certifications', '{}'::jsonb),
        'sourcing', coalesce(v_requirement.spec_snapshot -> 'sourcing', '{}'::jsonb),
        'release', coalesce(v_requirement.spec_snapshot -> 'release', '{}'::jsonb)
      );

    update public.parts
    set
      quantity = v_quantity,
      updated_at = v_timestamp
    where id = v_part.id;

    insert into public.approved_part_requirements (
      part_id,
      organization_id,
      approved_by,
      description,
      part_number,
      revision,
      material,
      finish,
      tightest_tolerance_inch,
      quantity,
      quote_quantities,
      requested_by_date,
      applicable_vendors,
      spec_snapshot,
      approved_at,
      updated_at
    )
    values (
      v_part.id,
      v_job.organization_id,
      coalesce(v_requirement.approved_by, v_job.created_by),
      v_description,
      v_part_number,
      v_revision,
      coalesce(v_material, ''),
      v_finish,
      v_tightest_tolerance_inch,
      v_quantity,
      v_quote_quantities,
      v_requested_by_date,
      v_applicable_vendors,
      v_spec_snapshot,
      v_timestamp,
      v_timestamp
    )
    on conflict (part_id) do update
      set approved_by = excluded.approved_by,
          description = excluded.description,
          part_number = excluded.part_number,
          revision = excluded.revision,
          material = excluded.material,
          finish = excluded.finish,
          tightest_tolerance_inch = excluded.tightest_tolerance_inch,
          quantity = excluded.quantity,
          quote_quantities = excluded.quote_quantities,
          requested_by_date = excluded.requested_by_date,
          applicable_vendors = excluded.applicable_vendors,
          spec_snapshot = excluded.spec_snapshot,
          approved_at = excluded.approved_at,
          updated_at = excluded.updated_at;

    if v_extraction.id is not null then
      update public.drawing_extractions
      set status = 'approved'
      where part_id = v_part.id;
    end if;

    v_count := v_count + 1;
  end loop;

  select count(*)::integer
  into v_pending_extract_tasks
  from public.work_queue queue
  where queue.job_id = p_job_id
    and queue.task_type = 'extract_part'
    and queue.status in ('queued', 'running');

  select count(*)::integer
  into v_failed_extract_tasks
  from public.work_queue queue
  where queue.job_id = p_job_id
    and queue.task_type = 'extract_part'
    and queue.status = 'failed';

  select count(*)::integer
  into v_unapproved_parts
  from public.parts part
  left join public.approved_part_requirements requirement on requirement.part_id = part.id
  where part.job_id = p_job_id
    and (part.cad_file_id is not null or part.drawing_file_id is not null)
    and requirement.id is null;

  if v_pending_extract_tasks > 0 then
    update public.jobs
    set status = 'extracting'
    where id = p_job_id;
  elsif v_failed_extract_tasks > 0 or v_unapproved_parts > 0 then
    update public.jobs
    set status = 'needs_spec_review'
    where id = p_job_id;
  elsif v_count > 0 then
    update public.jobs
    set status = 'ready_to_quote'
    where id = p_job_id;
  end if;

  perform public.log_audit_event(
    v_job.organization_id,
    'job.requirements_auto_approved',
    jsonb_build_object(
      'jobId', p_job_id,
      'approvedParts', v_count,
      'approvedBy', v_job.created_by,
      'pendingExtractTasks', v_pending_extract_tasks,
      'failedExtractTasks', v_failed_extract_tasks,
      'unapprovedParts', v_unapproved_parts
    ),
    p_job_id,
    null
  );

  return v_count;
end;
$$;

grant execute on function public.api_auto_approve_job_requirements(uuid) to service_role;
