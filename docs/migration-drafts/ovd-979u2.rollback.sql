-- OVD-979 U2 rollback: restore prior bodies byte for byte and existing grants.
-- No data changes or explicit transaction wrapper.

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

revoke all on function public.api_approve_job_requirements(uuid, jsonb) from public, anon;
grant execute on function public.api_approve_job_requirements(uuid, jsonb) to authenticated, service_role;

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
  v_context record;
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
  v_revision_effective text;
  v_process_effective text;
begin
  select *
  into v_context
  from public.load_editable_project_part_context(p_job_id);

  v_job := v_context.job;
  v_part := v_context.part;
  v_requirement := v_context.requirement;
  v_extraction := v_context.extraction;

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
    if v_field in (
      'description', 'partNumber', 'material', 'finish',
      'tightestToleranceInch', 'threads', 'revision', 'process'
    ) then
      v_property_overrides := v_property_overrides - v_field;
    end if;
  end loop;

  select
    resolved.description,
    resolved.part_number,
    resolved.material,
    resolved.finish,
    resolved.threads,
    resolved.tightest_tolerance_inch,
    resolved.revision,
    resolved.process
  into
    v_description_effective,
    v_part_number_effective,
    v_material_effective,
    v_finish_effective,
    v_threads_effective,
    v_tightest_tolerance_effective,
    v_revision_effective,
    v_process_effective
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
    v_tightest_tolerance_effective,
    v_revision_effective,
    v_process_effective
  );

  update public.approved_part_requirements
  set
    approved_by            = auth.uid(),
    description            = coalesce(v_description_effective, public.approved_part_requirements.description),
    part_number            = coalesce(v_part_number_effective, public.approved_part_requirements.part_number),
    revision               = v_revision_effective,
    material               = coalesce(v_material_effective, public.approved_part_requirements.material, ''),
    finish                 = coalesce(v_finish_effective, public.approved_part_requirements.finish),
    tightest_tolerance_inch = coalesce(
      v_tightest_tolerance_effective,
      public.approved_part_requirements.tightest_tolerance_inch
    ),
    spec_snapshot          = coalesce(v_requirement.spec_snapshot, public.approved_part_requirements.spec_snapshot),
    approved_at            = v_timestamp,
    updated_at             = v_timestamp
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
      'jobId',   v_job.id,
      'partId',  v_part.id,
      'fields',  coalesce(p_fields, '{}'::text[])
    ),
    v_job.id,
    null
  );

  return v_job.id;
end;
$$;

revoke all on function public.api_reset_client_part_property_overrides(uuid, text[]) from public, anon;
grant execute on function public.api_reset_client_part_property_overrides(uuid, text[]) to authenticated, service_role;

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
  v_extraction_newer boolean := false;
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
    v_extraction_newer := v_extraction.id is not null and (
      v_requirement.id is null
      or v_requirement.updated_at is null
      or v_extraction.updated_at > v_requirement.updated_at
    );

    v_description_source := coalesce(
      nullif(trim(coalesce(v_requirement.spec_snapshot #>> '{fieldSources,description}', '')), ''),
      'auto'
    );
    v_part_number_source := coalesce(
      nullif(trim(coalesce(v_requirement.spec_snapshot #>> '{fieldSources,partNumber}', '')), ''),
      'auto'
    );
    v_revision_source := coalesce(
      nullif(trim(coalesce(v_requirement.spec_snapshot #>> '{fieldSources,revision}', '')), ''),
      'auto'
    );
    v_finish_source := coalesce(
      nullif(trim(coalesce(v_requirement.spec_snapshot #>> '{fieldSources,finish}', '')), ''),
      'auto'
    );

    v_description := case
      when v_description_source = 'auto' and v_extraction_newer and not v_description_review_needed then
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
      when v_part_number_source = 'auto' and v_extraction_newer and not v_part_number_review_needed then
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
      when v_revision_source = 'auto' and v_extraction_newer and not v_revision_review_needed then
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
      when v_finish_source = 'auto' and v_extraction_newer and not v_finish_review_needed then
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
    v_quote_description := case
      when v_description_source = 'auto' and v_extraction_newer and not v_description_review_needed then
        coalesce(
          nullif(trim(coalesce(v_extraction.extraction ->> 'quoteDescription', '')), ''),
          nullif(trim(coalesce(v_extraction.extraction ->> 'description', v_extraction.extraction ->> 'desc', '')), ''),
          nullif(trim(coalesce(v_requirement.spec_snapshot ->> 'quoteDescription', '')), ''),
          v_description
        )
      else
        coalesce(
          nullif(trim(coalesce(v_requirement.spec_snapshot ->> 'quoteDescription', '')), ''),
          v_description
        )
    end;
    v_quote_finish := case
      when v_finish_source = 'auto' and v_extraction_newer and not v_finish_review_needed then
        coalesce(
          nullif(trim(coalesce(v_extraction.extraction ->> 'quoteFinish', '')), ''),
          nullif(trim(coalesce(
            v_extraction.extraction #>> '{finish,normalized}',
            v_extraction.extraction #>> '{finish,raw}',
            v_extraction.extraction #>> '{finish,raw_text}',
            ''
          )), ''),
          nullif(trim(coalesce(v_requirement.spec_snapshot ->> 'quoteFinish', '')), ''),
          v_finish
        )
      else
        coalesce(
          nullif(trim(coalesce(v_requirement.spec_snapshot ->> 'quoteFinish', '')), ''),
          v_finish
        )
    end;
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

revoke all on function public.api_auto_approve_job_requirements(uuid) from public, anon, authenticated;
grant execute on function public.api_auto_approve_job_requirements(uuid) to service_role;

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

revoke all on function public.api_reuse_trusted_part_version_artifacts(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.api_reuse_trusted_part_version_artifacts(uuid, uuid, uuid) to service_role;
