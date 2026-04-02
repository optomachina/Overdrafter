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
      requirement.created_at as requirement_created_at,
      requirement.updated_at as requirement_updated_at,
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
      coalesce(requirement.spec_snapshot -> 'projectPartProperties', '{}'::jsonb) as project_property_state,
      coalesce(requirement.spec_snapshot #> '{projectPartProperties,defaults}', '{}'::jsonb) as project_property_defaults,
      coalesce(requirement.spec_snapshot #> '{projectPartProperties,overrides}', '{}'::jsonb) as project_property_overrides,
      nullif(trim(coalesce(requirement.spec_snapshot #>> '{projectPartProperties,createdAt}', '')), '') as project_property_created_at,
      nullif(trim(coalesce(requirement.spec_snapshot #>> '{projectPartProperties,updatedAt}', '')), '') as project_property_updated_at,
      extraction.id as extraction_id,
      extraction.extraction,
      extraction.warnings,
      extraction.updated_at as extraction_updated_at,
      latest_task.status as latest_task_status,
      latest_task.last_error as latest_task_error,
      latest_task.payload as latest_task_payload,
      latest_task.updated_at as latest_task_updated_at,
      coalesce(jsonb_array_length(coalesce(extraction.warnings, '[]'::jsonb)), 0) as warning_count,
      array_to_string(
        array(
          select trimmed_thread
          from (
            select nullif(trim(value), '') as trimmed_thread
            from jsonb_array_elements_text(coalesce(extraction.extraction -> 'threads', '[]'::jsonb)) as thread_values(value)
          ) trimmed_threads
          where trimmed_thread is not null
        ),
        ', '
      ) as extracted_threads,
      coalesce(
        nullif(trim(coalesce(requirement.spec_snapshot #>> '{projectPartProperties,overrides,description}', '')), ''),
        nullif(trim(coalesce(requirement.spec_snapshot ->> 'quoteDescription', '')), ''),
        nullif(trim(coalesce(requirement.description, '')), ''),
        nullif(trim(coalesce(extraction.extraction ->> 'quoteDescription', '')), ''),
        nullif(trim(coalesce(extraction.extraction ->> 'description', extraction.extraction ->> 'desc', '')), ''),
        null
      ) as resolved_description,
      coalesce(
        nullif(trim(coalesce(requirement.spec_snapshot #>> '{projectPartProperties,overrides,partNumber}', '')), ''),
        nullif(trim(coalesce(requirement.part_number, '')), ''),
        nullif(trim(coalesce(requirement.spec_snapshot ->> 'partNumber', '')), ''),
        nullif(trim(coalesce(extraction.extraction ->> 'partNumber', extraction.extraction ->> 'pn', '')), ''),
        null
      ) as resolved_part_number,
      coalesce(
        nullif(trim(coalesce(requirement.revision, '')), ''),
        nullif(trim(coalesce(requirement.spec_snapshot ->> 'revision', '')), ''),
        nullif(trim(coalesce(extraction.extraction ->> 'revision', extraction.extraction ->> 'rev', '')), ''),
        null
      ) as resolved_revision,
      coalesce(
        nullif(trim(coalesce(requirement.spec_snapshot #>> '{projectPartProperties,overrides,material}', '')), ''),
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
        nullif(trim(coalesce(requirement.spec_snapshot #>> '{projectPartProperties,overrides,finish}', '')), ''),
        nullif(trim(coalesce(requirement.spec_snapshot ->> 'quoteFinish', '')), ''),
        nullif(trim(coalesce(requirement.finish, '')), ''),
        nullif(trim(coalesce(
          extraction.extraction ->> 'quoteFinish',
          extraction.extraction #>> '{finish,normalized}',
          extraction.extraction #>> '{finish,raw}',
          extraction.extraction #>> '{finish,raw_text}',
          extraction.extraction ->> 'finish',
          ''
        )), ''),
        null
      ) as resolved_finish,
      coalesce(
        nullif(trim(coalesce(requirement.spec_snapshot #>> '{projectPartProperties,overrides,threads}', '')), ''),
        nullif(trim(coalesce(requirement.spec_snapshot ->> 'threads', '')), ''),
        array_to_string(
          array(
            select trimmed_thread
            from (
              select nullif(trim(value), '') as trimmed_thread
              from jsonb_array_elements_text(coalesce(extraction.extraction -> 'threads', '[]'::jsonb)) as thread_values(value)
            ) trimmed_threads
            where trimmed_thread is not null
          ),
          ', '
        ),
        null
      ) as resolved_threads,
      coalesce(
        nullif(requirement.spec_snapshot #>> '{projectPartProperties,overrides,tightestToleranceInch}', '')::numeric,
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
      coalesce(nullif(extraction.extraction ->> 'pageCount', '')::integer, 0) as page_count,
      array_remove(
        array[
          case when coalesce(nullif(extraction.extraction #>> '{extractedDescriptionRaw,reviewNeeded}', '')::boolean, false) then 'description' end,
          case when coalesce(nullif(extraction.extraction #>> '{extractedPartNumberRaw,reviewNeeded}', '')::boolean, false) then 'partNumber' end,
          case when coalesce(nullif(extraction.extraction #>> '{extractedRevisionRaw,reviewNeeded}', '')::boolean, false) then 'revision' end,
          case when coalesce(nullif(extraction.extraction #>> '{material,reviewNeeded}', '')::boolean, false) then 'material' end,
          case when coalesce(nullif(extraction.extraction #>> '{extractedFinishRaw,reviewNeeded}', '')::boolean, false) then 'finish' end
        ],
        null
      ) as review_fields
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
        'quoteDescription', projection.requirement_quote_description,
        'material', nullif(trim(coalesce(projection.resolved_material, '')), ''),
        'finish', projection.resolved_finish,
        'quoteFinish', projection.requirement_quote_finish,
        'threads', projection.resolved_threads,
        'tightestToleranceInch', projection.resolved_tightest_tolerance_inch,
        'process', projection.resolved_process,
        'notes', projection.resolved_notes,
        'quantity', greatest(coalesce(projection.resolved_quantity, 1), 1),
        'quoteQuantities', projection.resolved_quote_quantities,
        'requestedByDate', projection.resolved_requested_by_date,
        'projectPartProperties',
          case
            when projection.project_property_created_at is null
              and projection.project_property_updated_at is null
              and projection.project_property_defaults = '{}'::jsonb
              and projection.project_property_overrides = '{}'::jsonb
              then null
            else jsonb_build_object(
              'defaults', projection.project_property_defaults,
              'overrides', projection.project_property_overrides,
              'createdAt', projection.project_property_created_at,
              'updatedAt', projection.project_property_updated_at
            )
          end,
        'pageCount', projection.page_count,
        'warningCount', projection.warning_count,
        'warnings', coalesce(projection.warnings, '[]'::jsonb),
        'missingFields', to_jsonb(coalesce(projection.missing_fields, array[]::text[])),
        'reviewFields', to_jsonb(coalesce(projection.review_fields, array[]::text[])),
        'lastFailureCode', nullif(trim(coalesce(projection.latest_task_payload ->> 'failureCode', '')), ''),
        'lastFailureMessage', nullif(trim(coalesce(projection.latest_task_error, projection.latest_task_payload ->> 'failureMessage', '')), ''),
        'extractedAt', projection.extraction_updated_at,
        'failedAt',
          case
            when projection.latest_task_status = 'failed' then projection.latest_task_updated_at
            else null
          end,
        'updatedAt',
          nullif(
            greatest(
              coalesce(projection.requirement_updated_at, '-infinity'::timestamptz),
              coalesce(projection.extraction_updated_at, '-infinity'::timestamptz),
              coalesce(projection.latest_task_updated_at, '-infinity'::timestamptz),
              coalesce(projection.requirement_created_at, '-infinity'::timestamptz)
            ),
            '-infinity'::timestamptz
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
            when coalesce(array_length(projection.missing_fields, 1), 0) > 0
              or coalesce(array_length(projection.review_fields, 1), 0) > 0
              or projection.warning_count > 0 then 'partial'
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

create or replace function public.normalize_project_part_threads(
  p_extraction jsonb
)
returns text
language sql
immutable
set search_path = public
as $$
  select array_to_string(
    array(
      select trimmed_thread
      from (
        select nullif(trim(value), '') as trimmed_thread
        from jsonb_array_elements_text(coalesce(p_extraction -> 'threads', '[]'::jsonb)) as thread_values(value)
      ) trimmed_threads
      where trimmed_thread is not null
    ),
    ', '
  );
$$;

create or replace function public.seed_project_part_property_defaults(
  p_requirement public.approved_part_requirements,
  p_extraction jsonb,
  p_defaults jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  v_defaults jsonb := coalesce(p_defaults, '{}'::jsonb);
begin
  if not (v_defaults ? 'description') then
    v_defaults := v_defaults || jsonb_build_object(
      'description',
      to_jsonb(
        coalesce(
          nullif(trim(coalesce(p_requirement.spec_snapshot ->> 'quoteDescription', '')), ''),
          nullif(trim(coalesce(p_requirement.description, '')), ''),
          nullif(trim(coalesce(p_extraction ->> 'quoteDescription', '')), ''),
          nullif(trim(coalesce(p_extraction ->> 'description', p_extraction ->> 'desc', '')), ''),
          null
        )
      )
    );
  end if;

  if not (v_defaults ? 'partNumber') then
    v_defaults := v_defaults || jsonb_build_object(
      'partNumber',
      to_jsonb(
        coalesce(
          nullif(trim(coalesce(p_requirement.part_number, '')), ''),
          nullif(trim(coalesce(p_requirement.spec_snapshot ->> 'partNumber', '')), ''),
          nullif(trim(coalesce(p_extraction ->> 'partNumber', p_extraction ->> 'pn', '')), ''),
          null
        )
      )
    );
  end if;

  if not (v_defaults ? 'material') then
    v_defaults := v_defaults || jsonb_build_object(
      'material',
      to_jsonb(
        coalesce(
          nullif(trim(coalesce(p_requirement.material, '')), ''),
          nullif(trim(coalesce(
            p_extraction #>> '{material,normalized}',
            p_extraction #>> '{material,raw}',
            p_extraction #>> '{material,raw_text}',
            p_extraction ->> 'material',
            ''
          )), ''),
          ''
        )
      )
    );
  end if;

  if not (v_defaults ? 'finish') then
    v_defaults := v_defaults || jsonb_build_object(
      'finish',
      to_jsonb(
        coalesce(
          nullif(trim(coalesce(p_requirement.spec_snapshot ->> 'quoteFinish', '')), ''),
          nullif(trim(coalesce(p_requirement.finish, '')), ''),
          nullif(trim(coalesce(
            p_extraction ->> 'quoteFinish',
            p_extraction #>> '{finish,normalized}',
            p_extraction #>> '{finish,raw}',
            p_extraction #>> '{finish,raw_text}',
            p_extraction ->> 'finish',
            ''
          )), ''),
          null
        )
      )
    );
  end if;

  if not (v_defaults ? 'threads') then
    v_defaults := v_defaults || jsonb_build_object(
      'threads',
      to_jsonb(
        coalesce(
          nullif(trim(coalesce(p_requirement.spec_snapshot ->> 'threads', '')), ''),
          public.normalize_project_part_threads(p_extraction),
          null
        )
      )
    );
  end if;

  if not (v_defaults ? 'tightestToleranceInch') then
    v_defaults := v_defaults || jsonb_build_object(
      'tightestToleranceInch',
      to_jsonb(
        coalesce(
          p_requirement.tightest_tolerance_inch,
          nullif(p_extraction #>> '{tolerances,valueInch}', '')::numeric
        )
      )
    );
  end if;

  return v_defaults;
end;
$$;

create or replace function public.resolve_project_part_property_values(
  p_defaults jsonb,
  p_overrides jsonb
)
returns table (
  description text,
  part_number text,
  material text,
  finish text,
  threads text,
  tightest_tolerance_inch numeric
)
language sql
stable
set search_path = public
as $$
  select
    coalesce(
      nullif(trim(coalesce(p_overrides ->> 'description', '')), ''),
      nullif(trim(coalesce(p_defaults ->> 'description', '')), ''),
      null
    ) as description,
    coalesce(
      nullif(trim(coalesce(p_overrides ->> 'partNumber', '')), ''),
      nullif(trim(coalesce(p_defaults ->> 'partNumber', '')), ''),
      null
    ) as part_number,
    coalesce(
      nullif(trim(coalesce(p_overrides ->> 'material', '')), ''),
      nullif(trim(coalesce(p_defaults ->> 'material', '')), ''),
      ''
    ) as material,
    coalesce(
      nullif(trim(coalesce(p_overrides ->> 'finish', '')), ''),
      nullif(trim(coalesce(p_defaults ->> 'finish', '')), ''),
      null
    ) as finish,
    coalesce(
      nullif(trim(coalesce(p_overrides ->> 'threads', '')), ''),
      nullif(trim(coalesce(p_defaults ->> 'threads', '')), ''),
      null
    ) as threads,
    coalesce(
      nullif(p_overrides ->> 'tightestToleranceInch', '')::numeric,
      nullif(p_defaults ->> 'tightestToleranceInch', '')::numeric
    ) as tightest_tolerance_inch;
$$;

create or replace function public.build_project_part_property_snapshot(
  p_spec_snapshot jsonb,
  p_defaults jsonb,
  p_overrides jsonb,
  p_created_at text,
  p_updated_at timestamptz,
  p_description text,
  p_part_number text,
  p_material text,
  p_finish text,
  p_threads text,
  p_tightest_tolerance_inch numeric
)
returns jsonb
language sql
stable
set search_path = public
as $$
  select coalesce(p_spec_snapshot, '{}'::jsonb)
    || jsonb_build_object(
      'description', p_description,
      'partNumber', p_part_number,
      'material', nullif(p_material, ''),
      'finish', p_finish,
      'threads', p_threads,
      'quoteDescription', p_description,
      'quoteFinish', p_finish,
      'tightestToleranceInch', p_tightest_tolerance_inch,
      'projectPartProperties',
      jsonb_build_object(
        'defaults', p_defaults,
        'overrides', p_overrides,
        'createdAt', p_created_at,
        'updatedAt', p_updated_at::text
      )
    );
$$;

create or replace function public.load_editable_project_part_context(
  p_job_id uuid
)
returns table (
  job public.jobs,
  part public.parts,
  requirement public.approved_part_requirements,
  extraction public.drawing_extractions
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_job public.jobs%rowtype;
  v_part public.parts%rowtype;
  v_requirement public.approved_part_requirements%rowtype;
  v_extraction public.drawing_extractions%rowtype;
begin
  select
    context.job,
    context.part,
    context.requirement,
    context.extraction
  into
    v_job,
    v_part,
    v_requirement,
    v_extraction
  from public.load_editable_project_part_context(p_job_id) context;

  job := v_job;
  part := v_part;
  requirement := v_requirement;
  extraction := v_extraction;
  return next;
end;
$$;

drop function if exists public.api_update_client_part_request(
  uuid,
  text[],
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  numeric,
  text,
  text,
  integer,
  integer[],
  date,
  jsonb,
  jsonb,
  jsonb,
  jsonb
);

create or replace function public.api_update_client_part_request(
  p_job_id uuid,
  p_requested_service_kinds text[] default null,
  p_primary_service_kind text default null,
  p_service_notes text default null,
  p_description text default null,
  p_part_number text default null,
  p_revision text default null,
  p_material text default '',
  p_finish text default null,
  p_threads text default null,
  p_tightest_tolerance_inch numeric default null,
  p_process text default null,
  p_notes text default null,
  p_quantity integer default 1,
  p_requested_quote_quantities integer[] default '{}'::integer[],
  p_requested_by_date date default null,
  p_shipping jsonb default '{}'::jsonb,
  p_certifications jsonb default '{}'::jsonb,
  p_sourcing jsonb default '{}'::jsonb,
  p_release jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.jobs%rowtype;
  v_part public.parts%rowtype;
  v_requirement public.approved_part_requirements%rowtype;
  v_extraction public.drawing_extractions%rowtype;
  v_requested_service_kinds text[] := public.normalize_requested_service_kinds(
    p_requested_service_kinds,
    p_primary_service_kind
  );
  v_primary_service_kind text := public.normalize_primary_service_kind(
    p_requested_service_kinds,
    p_primary_service_kind
  );
  v_requires_material boolean := 'manufacturing_quote' = any(v_requested_service_kinds);
  v_quantity integer := greatest(coalesce(p_quantity, 1), 1);
  v_quote_quantities integer[] := public.normalize_positive_integer_array(
    p_requested_quote_quantities,
    v_quantity
  );
  v_applicable_vendors public.vendor_name[] := array[]::public.vendor_name[];
  v_spec_snapshot jsonb := '{}'::jsonb;
  v_timestamp timestamptz := timezone('utc', now());
  v_shipping jsonb := coalesce(p_shipping, '{}'::jsonb);
  v_certifications jsonb := coalesce(p_certifications, '{}'::jsonb);
  v_sourcing jsonb := coalesce(p_sourcing, '{}'::jsonb);
  v_release jsonb := coalesce(p_release, '{}'::jsonb);
  v_required_certifications text[] := array(
    select value
    from (
      select nullif(trim(item.value), '') as value
      from jsonb_array_elements_text(coalesce(v_certifications -> 'requiredCertifications', '[]'::jsonb)) as item(value)
    ) filtered
    where value is not null
  );
  v_preferred_suppliers text[] := array(
    select value
    from (
      select nullif(trim(item.value), '') as value
      from jsonb_array_elements_text(coalesce(v_sourcing -> 'preferredSuppliers', '[]'::jsonb)) as item(value)
    ) filtered
    where value is not null
  );
  v_packaging_notes text := nullif(trim(coalesce(v_shipping ->> 'packagingNotes', '')), '');
  v_shipping_notes text := nullif(trim(coalesce(v_shipping ->> 'shippingNotes', '')), '');
  v_material_cert_required boolean := case
    when jsonb_typeof(v_certifications -> 'materialCertificationRequired') = 'boolean'
      then (v_certifications ->> 'materialCertificationRequired')::boolean
    else null
  end;
  v_coc_required boolean := case
    when jsonb_typeof(v_certifications -> 'certificateOfConformanceRequired') = 'boolean'
      then (v_certifications ->> 'certificateOfConformanceRequired')::boolean
    else null
  end;
  v_inspection_level text := case
    when v_certifications ->> 'inspectionLevel' in ('standard', 'fai', 'custom')
      then v_certifications ->> 'inspectionLevel'
    else null
  end;
  v_certification_notes text := nullif(trim(coalesce(v_certifications ->> 'notes', '')), '');
  v_region_preference text := case
    when v_sourcing ->> 'regionPreferenceOverride' in ('best_value', 'domestic_preferred', 'domestic_only', 'foreign_allowed')
      then v_sourcing ->> 'regionPreferenceOverride'
    else null
  end;
  v_material_provisioning text := case
    when v_sourcing ->> 'materialProvisioning' in ('supplier_to_source', 'customer_supplied', 'tbd')
      then v_sourcing ->> 'materialProvisioning'
    else null
  end;
  v_sourcing_notes text := nullif(trim(coalesce(v_sourcing ->> 'notes', '')), '');
  v_release_status text := case
    when v_release ->> 'releaseStatus' in ('unknown', 'prototype', 'pre_release', 'released')
      then v_release ->> 'releaseStatus'
    else null
  end;
  v_release_notes text := nullif(trim(coalesce(v_release ->> 'notes', '')), '');
  v_property_state jsonb := '{}'::jsonb;
  v_property_defaults jsonb := '{}'::jsonb;
  v_property_overrides jsonb := '{}'::jsonb;
  v_property_created_at text;
  v_description_effective text;
  v_part_number_effective text;
  v_material_effective text;
  v_finish_effective text;
  v_threads_effective text;
  v_tightest_tolerance_effective numeric;
  v_description_override text := nullif(trim(coalesce(p_description, '')), '');
  v_part_number_override text := nullif(trim(coalesce(p_part_number, '')), '');
  v_material_override text := trim(coalesce(p_material, ''));
  v_finish_override text := nullif(trim(coalesce(p_finish, '')), '');
  v_threads_override text := nullif(trim(coalesce(p_threads, '')), '');
begin
  perform public.require_verified_auth();

  select *
  into v_job
  from public.jobs
  where id = p_job_id;

  if v_job.id is null then
    raise exception 'Job % not found.', p_job_id;
  end if;

  if not public.user_can_edit_job(v_job.id) then
    raise exception 'You do not have permission to edit job %.', p_job_id;
  end if;

  select *
  into v_part
  from public.parts
  where job_id = v_job.id
  order by created_at asc
  limit 1;

  if v_part.id is null then
    raise exception 'Job % has no part revisions yet.', p_job_id;
  end if;

  select *
  into v_requirement
  from public.approved_part_requirements
  where part_id = v_part.id;

  select *
  into v_extraction
  from public.drawing_extractions
  where part_id = v_part.id;

  v_property_state := coalesce(v_requirement.spec_snapshot -> 'projectPartProperties', '{}'::jsonb);
  v_property_defaults := coalesce(v_property_state -> 'defaults', '{}'::jsonb);
  v_property_overrides := coalesce(v_property_state -> 'overrides', '{}'::jsonb);
  v_property_created_at := nullif(trim(coalesce(v_property_state ->> 'createdAt', '')), '');
  v_property_defaults := public.seed_project_part_property_defaults(
    v_requirement,
    v_extraction.extraction,
    v_property_defaults
  );

  if v_description_override is distinct from nullif(trim(coalesce(v_property_defaults ->> 'description', '')), '') then
    v_property_overrides := v_property_overrides || jsonb_build_object('description', to_jsonb(v_description_override));
  else
    v_property_overrides := v_property_overrides - 'description';
  end if;

  if v_part_number_override is distinct from nullif(trim(coalesce(v_property_defaults ->> 'partNumber', '')), '') then
    v_property_overrides := v_property_overrides || jsonb_build_object('partNumber', to_jsonb(v_part_number_override));
  else
    v_property_overrides := v_property_overrides - 'partNumber';
  end if;

  if v_material_override is distinct from coalesce(
    nullif(trim(coalesce(v_property_defaults ->> 'material', '')), ''),
    ''
  ) then
    v_property_overrides := v_property_overrides || jsonb_build_object('material', to_jsonb(v_material_override));
  else
    v_property_overrides := v_property_overrides - 'material';
  end if;

  if v_finish_override is distinct from nullif(trim(coalesce(v_property_defaults ->> 'finish', '')), '') then
    v_property_overrides := v_property_overrides || jsonb_build_object('finish', to_jsonb(v_finish_override));
  else
    v_property_overrides := v_property_overrides - 'finish';
  end if;

  if v_threads_override is distinct from nullif(trim(coalesce(v_property_defaults ->> 'threads', '')), '') then
    v_property_overrides := v_property_overrides || jsonb_build_object('threads', to_jsonb(v_threads_override));
  else
    v_property_overrides := v_property_overrides - 'threads';
  end if;

  if p_tightest_tolerance_inch is distinct from nullif(v_property_defaults ->> 'tightestToleranceInch', '')::numeric then
    v_property_overrides := v_property_overrides || jsonb_build_object('tightestToleranceInch', to_jsonb(p_tightest_tolerance_inch));
  else
    v_property_overrides := v_property_overrides - 'tightestToleranceInch';
  end if;

  select
    resolved.description,
    resolved.part_number,
    resolved.material,
    resolved.finish,
    resolved.threads,
    resolved.tightest_tolerance_inch
  into
    v_description_effective,
    v_part_number_effective,
    v_material_effective,
    v_finish_effective,
    v_threads_effective,
    v_tightest_tolerance_effective
  from public.resolve_project_part_property_values(v_property_defaults, v_property_overrides) resolved;

  if v_requires_material and v_material_effective = '' then
    raise exception 'Material is required for manufacturing quote requests.';
  end if;

  v_quantity := coalesce(v_quote_quantities[1], v_quantity, 1);

  if coalesce(array_length(v_requirement.applicable_vendors, 1), 0) > 0 then
    v_applicable_vendors := v_requirement.applicable_vendors;
  else
    v_applicable_vendors := array['xometry', 'fictiv', 'protolabs']::public.vendor_name[];

    if coalesce(v_tightest_tolerance_effective, 0.005) >= 0.005 then
      v_applicable_vendors := array_append(v_applicable_vendors, 'sendcutsend'::public.vendor_name);
    end if;
  end if;

  v_spec_snapshot := public.build_project_part_property_snapshot(
    v_requirement.spec_snapshot,
    v_property_defaults,
    v_property_overrides,
    coalesce(v_property_created_at, v_timestamp::text),
    v_timestamp,
    v_description_effective,
    v_part_number_effective,
    v_material_effective,
    v_finish_effective,
    v_threads_effective,
    v_tightest_tolerance_effective
  ) || jsonb_build_object(
    'requestedServiceKinds', v_requested_service_kinds,
    'primaryServiceKind', v_primary_service_kind,
    'serviceNotes', nullif(trim(coalesce(p_service_notes, '')), ''),
    'revision', nullif(trim(coalesce(p_revision, '')), ''),
    'quantity', v_quantity,
    'quoteQuantities', v_quote_quantities,
    'requestedByDate', p_requested_by_date,
    'process', nullif(trim(coalesce(p_process, '')), ''),
    'notes', nullif(trim(coalesce(p_notes, '')), ''),
    'shipping', coalesce(v_requirement.spec_snapshot -> 'shipping', '{}'::jsonb)
      || jsonb_build_object(
        'packagingNotes', v_packaging_notes,
        'shippingNotes', v_shipping_notes
      ),
    'certifications', coalesce(v_requirement.spec_snapshot -> 'certifications', '{}'::jsonb)
      || jsonb_build_object(
        'requiredCertifications', to_jsonb(coalesce(v_required_certifications, array[]::text[])),
        'materialCertificationRequired', v_material_cert_required,
        'certificateOfConformanceRequired', v_coc_required,
        'inspectionLevel', v_inspection_level,
        'notes', v_certification_notes
      ),
    'sourcing', coalesce(v_requirement.spec_snapshot -> 'sourcing', '{}'::jsonb)
      || jsonb_build_object(
        'regionPreferenceOverride', v_region_preference,
        'preferredSuppliers', to_jsonb(coalesce(v_preferred_suppliers, array[]::text[])),
        'materialProvisioning', v_material_provisioning,
        'notes', v_sourcing_notes
      ),
    'release', coalesce(v_requirement.spec_snapshot -> 'release', '{}'::jsonb)
      || jsonb_build_object(
        'releaseStatus', v_release_status,
        'notes', v_release_notes
      )
  );

  update public.jobs
  set
    requested_service_kinds = v_requested_service_kinds,
    primary_service_kind = v_primary_service_kind,
    service_notes = nullif(trim(coalesce(p_service_notes, '')), ''),
    requested_quote_quantities = v_quote_quantities,
    requested_by_date = p_requested_by_date,
    updated_at = v_timestamp
  where id = v_job.id;

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
    auth.uid(),
    v_description_effective,
    v_part_number_effective,
    nullif(trim(coalesce(p_revision, '')), ''),
    coalesce(v_material_effective, ''),
    v_finish_effective,
    v_tightest_tolerance_effective,
    v_quantity,
    v_quote_quantities,
    p_requested_by_date,
    v_applicable_vendors,
    v_spec_snapshot,
    v_timestamp,
    v_timestamp
  )
  on conflict (part_id) do update
    set approved_by = auth.uid(),
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

  perform public.log_audit_event(
    v_job.organization_id,
    'client.part_request_updated',
    jsonb_build_object(
      'jobId', v_job.id,
      'partId', v_part.id,
      'requestedServiceKinds', v_requested_service_kinds,
      'primaryServiceKind', v_primary_service_kind,
      'quantity', v_quantity,
      'requestedQuoteQuantities', v_quote_quantities,
      'requestedByDate', p_requested_by_date,
      'releaseStatus', v_release_status,
      'requiredCertifications', coalesce(v_required_certifications, array[]::text[]),
      'projectPartPropertyOverrides', v_property_overrides
    ),
    v_job.id,
    null
  );

  return v_job.id;
end;
$$;

grant execute on function public.api_update_client_part_request(
  uuid,
  text[],
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  numeric,
  text,
  text,
  integer,
  integer[],
  date,
  jsonb,
  jsonb,
  jsonb,
  jsonb
) to authenticated;

create or replace function public.api_reset_client_part_property_overrides(
  p_job_id uuid,
  p_fields text[] default '{}'::text[]
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.jobs%rowtype;
  v_part public.parts%rowtype;
  v_requirement public.approved_part_requirements%rowtype;
  v_extraction public.drawing_extractions%rowtype;
  v_timestamp timestamptz := timezone('utc', now());
  v_property_state jsonb := '{}'::jsonb;
  v_property_defaults jsonb := '{}'::jsonb;
  v_property_overrides jsonb := '{}'::jsonb;
  v_field text;
  v_description_effective text;
  v_part_number_effective text;
  v_material_effective text;
  v_finish_effective text;
  v_threads_effective text;
  v_tightest_tolerance_effective numeric;
begin
  select
    context.job,
    context.part,
    context.requirement,
    context.extraction
  into
    v_job,
    v_part,
    v_requirement,
    v_extraction
  from public.load_editable_project_part_context(p_job_id) context;

  if v_requirement.id is null then
    return v_job.id;
  end if;

  v_property_state := coalesce(v_requirement.spec_snapshot -> 'projectPartProperties', '{}'::jsonb);
  v_property_defaults := coalesce(v_property_state -> 'defaults', '{}'::jsonb);
  v_property_overrides := coalesce(v_property_state -> 'overrides', '{}'::jsonb);
  v_property_defaults := public.seed_project_part_property_defaults(
    v_requirement,
    v_extraction.extraction,
    v_property_defaults
  );

  foreach v_field in array coalesce(p_fields, '{}'::text[])
  loop
    if v_field in ('description', 'partNumber', 'material', 'finish', 'tightestToleranceInch', 'threads') then
      v_property_overrides := v_property_overrides - v_field;
    end if;
  end loop;

  select
    resolved.description,
    resolved.part_number,
    resolved.material,
    resolved.finish,
    resolved.threads,
    resolved.tightest_tolerance_inch
  into
    v_description_effective,
    v_part_number_effective,
    v_material_effective,
    v_finish_effective,
    v_threads_effective,
    v_tightest_tolerance_effective
  from public.resolve_project_part_property_values(v_property_defaults, v_property_overrides) resolved;

  if 'manufacturing_quote' = any(coalesce(v_job.requested_service_kinds, '{}'::text[]))
    and v_material_effective = '' then
    raise exception 'Material is required for manufacturing quote requests.';
  end if;

  v_requirement.spec_snapshot := public.build_project_part_property_snapshot(
    v_requirement.spec_snapshot,
    v_property_defaults,
    v_property_overrides,
    nullif(trim(coalesce(v_property_state ->> 'createdAt', '')), ''),
    v_timestamp,
    v_description_effective,
    v_part_number_effective,
    v_material_effective,
    v_finish_effective,
    v_threads_effective,
    v_tightest_tolerance_effective
  );

  update public.approved_part_requirements
  set
    approved_by = auth.uid(),
    description = coalesce(v_description_effective, public.approved_part_requirements.description),
    part_number = coalesce(v_part_number_effective, public.approved_part_requirements.part_number),
    material = coalesce(v_material_effective, public.approved_part_requirements.material, ''),
    finish = coalesce(v_finish_effective, public.approved_part_requirements.finish),
    tightest_tolerance_inch = coalesce(
      v_tightest_tolerance_effective,
      public.approved_part_requirements.tightest_tolerance_inch
    ),
    spec_snapshot = coalesce(v_requirement.spec_snapshot, public.approved_part_requirements.spec_snapshot),
    approved_at = v_timestamp,
    updated_at = v_timestamp
  where part_id = v_part.id;

  update public.parts
  set updated_at = v_timestamp
  where id = v_part.id;

  update public.jobs
  set updated_at = v_timestamp
  where id = v_job.id;

  perform public.log_audit_event(
    v_job.organization_id,
    'client.project_part_properties_reset',
    jsonb_build_object(
      'jobId', v_job.id,
      'partId', v_part.id,
      'fields', coalesce(p_fields, '{}'::text[])
    ),
    v_job.id,
    null
  );

  return v_job.id;
end;
$$;

grant execute on function public.api_reset_client_part_property_overrides(uuid, text[]) to authenticated;
