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
        nullif(trim(coalesce(requirement.spec_snapshot ->> 'quoteDescription', '')), ''),
        nullif(trim(coalesce(requirement.description, '')), ''),
        nullif(trim(coalesce(extraction.extraction ->> 'quoteDescription', '')), ''),
        nullif(trim(coalesce(extraction.extraction ->> 'description', extraction.extraction ->> 'desc', '')), ''),
        null
      ) as resolved_description,
      coalesce(
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
  v_requested_service_kinds text[] := public.normalize_requested_service_kinds(
    p_requested_service_kinds,
    p_primary_service_kind
  );
  v_primary_service_kind text := public.normalize_primary_service_kind(
    p_requested_service_kinds,
    p_primary_service_kind
  );
  v_requires_material boolean := 'manufacturing_quote' = any(v_requested_service_kinds);
  v_material text := trim(coalesce(p_material, ''));
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

  if v_material = '' then
    v_material := trim(coalesce(v_requirement.material, ''));
  end if;

  if v_requires_material and v_material = '' then
    raise exception 'Material is required for manufacturing quote requests.';
  end if;

  v_quantity := coalesce(v_quote_quantities[1], v_quantity, 1);

  if coalesce(array_length(v_requirement.applicable_vendors, 1), 0) > 0 then
    v_applicable_vendors := v_requirement.applicable_vendors;
  else
    v_applicable_vendors := array['xometry', 'fictiv', 'protolabs']::public.vendor_name[];

    if coalesce(p_tightest_tolerance_inch, v_requirement.tightest_tolerance_inch, 0.005) >= 0.005 then
      v_applicable_vendors := array_append(v_applicable_vendors, 'sendcutsend'::public.vendor_name);
    end if;
  end if;

  v_spec_snapshot := coalesce(v_requirement.spec_snapshot, '{}'::jsonb)
    || jsonb_build_object(
      'requestedServiceKinds', v_requested_service_kinds,
      'primaryServiceKind', v_primary_service_kind,
      'serviceNotes', nullif(trim(coalesce(p_service_notes, '')), ''),
      'description', nullif(trim(coalesce(p_description, '')), ''),
      'partNumber', nullif(trim(coalesce(p_part_number, '')), ''),
      'revision', nullif(trim(coalesce(p_revision, '')), ''),
      'material', nullif(v_material, ''),
      'finish', nullif(trim(coalesce(p_finish, '')), ''),
      'quoteDescription', nullif(trim(coalesce(p_description, '')), ''),
      'quoteFinish', nullif(trim(coalesce(p_finish, '')), ''),
      'fieldSources', jsonb_build_object(
        'description', 'user',
        'partNumber', 'user',
        'revision', 'user',
        'finish', 'user'
      ),
      'fieldOverrides', jsonb_build_object(
        'description', true,
        'partNumber', true,
        'revision', true,
        'finish', true
      ),
      'tightestToleranceInch', p_tightest_tolerance_inch,
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
    nullif(trim(coalesce(p_description, '')), ''),
    nullif(trim(coalesce(p_part_number, '')), ''),
    nullif(trim(coalesce(p_revision, '')), ''),
    coalesce(v_material, ''),
    nullif(trim(coalesce(p_finish, '')), ''),
    p_tightest_tolerance_inch,
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
      'requiredCertifications', coalesce(v_required_certifications, array[]::text[])
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

create or replace function public.api_approve_job_requirements(
  p_job_id uuid,
  p_requirements jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.jobs%rowtype;
  v_item jsonb;
  v_part_id uuid;
  v_count integer := 0;
  v_vendors public.vendor_name[];
  v_quantity integer;
  v_quote_quantities integer[];
  v_requested_by_date date;
  v_snapshot jsonb;
begin
  perform public.require_verified_auth();

  select *
  into v_job
  from public.jobs
  where id = p_job_id;

  if v_job.id is null then
    raise exception 'Job % not found', p_job_id;
  end if;

  if not public.is_internal_user(v_job.organization_id) then
    raise exception 'Only internal users can approve requirements for job %', p_job_id;
  end if;

  for v_item in
    select value
    from jsonb_array_elements(coalesce(p_requirements, '[]'::jsonb))
  loop
    v_part_id := (v_item ->> 'partId')::uuid;
    v_vendors := public.to_vendor_name_array(v_item -> 'applicableVendors');
    v_quantity := greatest(coalesce(nullif(v_item ->> 'quantity', '')::integer, 1), 1);
    v_quote_quantities := public.normalize_positive_integer_array(
      array(
        select value::integer
        from jsonb_array_elements_text(coalesce(v_item -> 'quoteQuantities', '[]'::jsonb)) as item(value)
        where value ~ '^\d+$'
      ),
      v_quantity
    );
    v_quantity := coalesce(v_quote_quantities[1], v_quantity, 1);
    v_requested_by_date := case
      when nullif(v_item ->> 'requestedByDate', '') ~ '^\d{4}-\d{2}-\d{2}$' then (v_item ->> 'requestedByDate')::date
      else null
    end;

    if not exists (
      select 1
      from public.parts part
      where part.id = v_part_id
        and part.job_id = p_job_id
    ) then
      raise exception 'Part % does not belong to job %', v_part_id, p_job_id;
    end if;

    v_snapshot := coalesce(v_item, '{}'::jsonb)
      || jsonb_build_object(
        'quoteDescription', nullif(v_item ->> 'description', ''),
        'quoteFinish', nullif(v_item ->> 'finish', ''),
        'fieldSources', jsonb_build_object(
          'description', 'user',
          'partNumber', 'user',
          'revision', 'user',
          'finish', 'user'
        ),
        'fieldOverrides', jsonb_build_object(
          'description', true,
          'partNumber', true,
          'revision', true,
          'finish', true
        )
      );

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
      spec_snapshot
    )
    values (
      v_part_id,
      v_job.organization_id,
      auth.uid(),
      nullif(v_item ->> 'description', ''),
      nullif(v_item ->> 'partNumber', ''),
      nullif(v_item ->> 'revision', ''),
      coalesce(v_item ->> 'material', ''),
      nullif(v_item ->> 'finish', ''),
      nullif(v_item ->> 'tightestToleranceInch', '')::numeric,
      v_quantity,
      v_quote_quantities,
      v_requested_by_date,
      v_vendors,
      v_snapshot
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
          approved_at = timezone('utc', now()),
          updated_at = timezone('utc', now());

    update public.parts
    set quantity = v_quantity
    where id = v_part_id;

    update public.drawing_extractions
    set status = 'approved'
    where part_id = v_part_id;

    v_count := v_count + 1;
  end loop;

  update public.jobs
  set status = 'ready_to_quote'
  where id = p_job_id;

  perform public.log_audit_event(
    v_job.organization_id,
    'job.requirements_approved',
    jsonb_build_object('approvedParts', v_count),
    p_job_id,
    null
  );

  return v_count;
end;
$$;

grant execute on function public.api_approve_job_requirements(uuid, jsonb) to authenticated;

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
  v_quote_description text;
  v_quote_finish text;
  v_description_source text;
  v_part_number_source text;
  v_revision_source text;
  v_finish_source text;
  v_description_review_needed boolean := false;
  v_part_number_review_needed boolean := false;
  v_revision_review_needed boolean := false;
  v_finish_review_needed boolean := false;
  v_has_review_blocker boolean := false;
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

    v_description_review_needed := coalesce(nullif(v_extraction.extraction #>> '{extractedDescriptionRaw,reviewNeeded}', '')::boolean, false);
    v_part_number_review_needed := coalesce(nullif(v_extraction.extraction #>> '{extractedPartNumberRaw,reviewNeeded}', '')::boolean, false);
    v_revision_review_needed := coalesce(nullif(v_extraction.extraction #>> '{extractedRevisionRaw,reviewNeeded}', '')::boolean, false);
    v_finish_review_needed := coalesce(nullif(v_extraction.extraction #>> '{extractedFinishRaw,reviewNeeded}', '')::boolean, false);
    v_has_review_blocker := v_description_review_needed or v_part_number_review_needed or v_revision_review_needed or v_finish_review_needed;

    v_description_source := coalesce(
      nullif(trim(coalesce(v_requirement.spec_snapshot #>> '{fieldSources,description}', '')), ''),
      case when v_requirement.id is null then 'auto' else 'user' end
    );
    v_part_number_source := coalesce(
      nullif(trim(coalesce(v_requirement.spec_snapshot #>> '{fieldSources,partNumber}', '')), ''),
      case when v_requirement.id is null then 'auto' else 'user' end
    );
    v_revision_source := coalesce(
      nullif(trim(coalesce(v_requirement.spec_snapshot #>> '{fieldSources,revision}', '')), ''),
      case when v_requirement.id is null then 'auto' else 'user' end
    );
    v_finish_source := coalesce(
      nullif(trim(coalesce(v_requirement.spec_snapshot #>> '{fieldSources,finish}', '')), ''),
      case when v_requirement.id is null then 'auto' else 'user' end
    );

    v_description := case
      when v_description_source = 'auto' and not v_description_review_needed then
        coalesce(
          nullif(trim(coalesce(v_extraction.extraction ->> 'quoteDescription', '')), ''),
          nullif(trim(coalesce(v_extraction.extraction ->> 'description', v_extraction.extraction ->> 'desc', '')), ''),
          nullif(trim(coalesce(v_requirement.description, '')), ''),
          null
        )
      else
        coalesce(
          nullif(trim(coalesce(v_requirement.description, '')), ''),
          nullif(trim(coalesce(v_requirement.spec_snapshot ->> 'quoteDescription', '')), ''),
          nullif(trim(coalesce(v_extraction.extraction ->> 'quoteDescription', '')), ''),
          nullif(trim(coalesce(v_extraction.extraction ->> 'description', v_extraction.extraction ->> 'desc', '')), ''),
          null
        )
    end;
    v_part_number := case
      when v_part_number_source = 'auto' and not v_part_number_review_needed then
        coalesce(
          nullif(trim(coalesce(v_extraction.extraction ->> 'partNumber', v_extraction.extraction ->> 'pn', '')), ''),
          nullif(trim(coalesce(v_requirement.part_number, '')), ''),
          null
        )
      else
        coalesce(
          nullif(trim(coalesce(v_requirement.part_number, '')), ''),
          nullif(trim(coalesce(v_extraction.extraction ->> 'partNumber', v_extraction.extraction ->> 'pn', '')), ''),
          null
        )
    end;
    v_revision := case
      when v_revision_source = 'auto' and not v_revision_review_needed then
        coalesce(
          nullif(trim(coalesce(v_extraction.extraction ->> 'revision', v_extraction.extraction ->> 'rev', '')), ''),
          nullif(trim(coalesce(v_requirement.revision, '')), ''),
          null
        )
      else
        coalesce(
          nullif(trim(coalesce(v_requirement.revision, '')), ''),
          nullif(trim(coalesce(v_extraction.extraction ->> 'revision', v_extraction.extraction ->> 'rev', '')), ''),
          null
        )
    end;
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
    v_finish := case
      when v_finish_source = 'auto' and not v_finish_review_needed then
        coalesce(
          nullif(trim(coalesce(v_extraction.extraction ->> 'quoteFinish', '')), ''),
          nullif(trim(coalesce(
            v_extraction.extraction #>> '{finish,normalized}',
            v_extraction.extraction #>> '{finish,raw}',
            v_extraction.extraction #>> '{finish,raw_text}',
            ''
          )), ''),
          nullif(trim(coalesce(v_requirement.finish, '')), ''),
          null
        )
      else
        coalesce(
          nullif(trim(coalesce(v_requirement.finish, '')), ''),
          nullif(trim(coalesce(v_requirement.spec_snapshot ->> 'quoteFinish', '')), ''),
          nullif(trim(coalesce(v_extraction.extraction ->> 'quoteFinish', '')), ''),
          nullif(trim(coalesce(
            v_extraction.extraction #>> '{finish,normalized}',
            v_extraction.extraction #>> '{finish,raw}',
            v_extraction.extraction #>> '{finish,raw_text}',
            ''
          )), ''),
          null
        )
    end;
    v_quote_description := coalesce(
      nullif(trim(coalesce(v_requirement.spec_snapshot ->> 'quoteDescription', '')), ''),
      v_description
    );
    v_quote_finish := coalesce(
      nullif(trim(coalesce(v_requirement.spec_snapshot ->> 'quoteFinish', '')), ''),
      v_finish
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

    update public.parts
    set
      quantity = v_quantity,
      updated_at = v_timestamp
    where id = v_part.id;

    if v_requirement.id is null and v_has_review_blocker then
      if v_extraction.id is not null then
        update public.drawing_extractions
        set status = 'needs_review'
        where part_id = v_part.id;
      end if;

      continue;
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
        'quoteDescription', coalesce(v_quote_description, v_description),
        'quoteFinish', coalesce(v_quote_finish, v_finish),
        'fieldSources', jsonb_build_object(
          'description', v_description_source,
          'partNumber', v_part_number_source,
          'revision', v_revision_source,
          'finish', v_finish_source
        ),
        'fieldOverrides', jsonb_build_object(
          'description', v_description_source <> 'auto',
          'partNumber', v_part_number_source <> 'auto',
          'revision', v_revision_source <> 'auto',
          'finish', v_finish_source <> 'auto'
        ),
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
