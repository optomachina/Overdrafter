-- OVD-979 U4: attempt-bound auto approval and preserved client corrections.
-- ovd: idempotent
-- Apply after U2 and U3, in one transaction; no schema/backfill/scheduling changes.

create or replace function public.api_auto_approve_job_requirements(p_job_id uuid)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
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
  -- Ownership comes from legacy provenance OR an editor override key.
  v_property_overrides jsonb := '{}'::jsonb;
  v_property_defaults jsonb;
  v_description_user_owned boolean;
  v_part_number_user_owned boolean;
  v_revision_user_owned boolean;
  v_finish_user_owned boolean;
  v_description_refresh boolean;
  v_part_number_refresh boolean;
  v_revision_refresh boolean;
  v_finish_refresh boolean;
  v_extracted_description text;
  v_extracted_part_number text;
  v_extracted_revision text;
  v_extracted_finish text;
  v_material_placeholder_replaced boolean;
  v_description_review_needed boolean := false;
  v_part_number_review_needed boolean := false;
  v_revision_review_needed boolean := false;
  v_finish_review_needed boolean := false;
  v_has_review_blocker boolean := false;
  v_extraction_newer boolean := false;
  v_part_writes public.parts[] := '{}';
  v_requirement_writes public.approved_part_requirements[] := '{}';
  v_write public.approved_part_requirements%rowtype;
  v_approved_part_ids uuid[] := '{}';
  v_review_part_ids uuid[] := '{}';
  v_count integer := 0;
  v_timestamp timestamptz := timezone('utc', now());
  v_pending_extract_tasks integer := 0;
  v_failed_extract_tasks integer := 0;
  v_unapproved_parts integer := 0;
begin
  select *
  into v_job
  from public.jobs
  where id = p_job_id
  for no key update;

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

    -- Active work may still hold an older result. Only a running, non-legacy
    -- attempt that produced this row is evidence for the current extraction.
    -- Do not refresh fields or stamp stale extraction status while it is pending.
    if exists (
      select 1 from public.work_queue queue
      where queue.job_id = p_job_id
        and queue.part_id = v_part.id
        and queue.task_type = 'extract_part'
        and queue.status in ('queued', 'running')
        and not (
          queue.status = 'running'
          and queue.attempt_id is not null
          and coalesce(v_extraction.source_attempt_id = queue.attempt_id, false)
        )
    ) then
      v_extraction := null;
    end if;

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

    v_property_overrides := case
      when jsonb_typeof(v_requirement.spec_snapshot #> '{projectPartProperties,overrides}') = 'object'
        then v_requirement.spec_snapshot #> '{projectPartProperties,overrides}'
      else '{}'::jsonb
    end;
    v_description_user_owned := v_description_source <> 'auto' or v_property_overrides ? 'description';
    v_part_number_user_owned := v_part_number_source <> 'auto' or v_property_overrides ? 'partNumber';
    v_revision_user_owned := v_revision_source <> 'auto' or v_property_overrides ? 'revision';
    v_finish_user_owned := v_finish_source <> 'auto' or v_property_overrides ? 'finish';
    v_description_refresh := not v_description_user_owned and v_extraction_newer and not v_description_review_needed;
    v_part_number_refresh := not v_part_number_user_owned and v_extraction_newer and not v_part_number_review_needed;
    v_revision_refresh := not v_revision_user_owned and v_extraction_newer and not v_revision_review_needed;
    v_finish_refresh := not v_finish_user_owned and v_extraction_newer and not v_finish_review_needed;
    v_material_placeholder_replaced := trim(coalesce(v_requirement.material, '')) = 'Unknown material'
      and not (v_property_overrides ? 'material')
      and coalesce(nullif(trim(coalesce(v_requirement.spec_snapshot #>> '{fieldSources,material}', '')), ''), 'auto') = 'auto'
      and nullif(trim(coalesce(
        v_extraction.extraction #>> '{material,normalized}',
        v_extraction.extraction #>> '{material,raw}',
        v_extraction.extraction #>> '{material,raw_text}',
        ''
      )), '') is not null;
    v_extracted_description := coalesce(
      nullif(trim(coalesce(v_extraction.extraction ->> 'quoteDescription', '')), ''),
      nullif(trim(coalesce(v_extraction.extraction ->> 'description', v_extraction.extraction ->> 'desc', '')), '')
    );
    v_extracted_part_number := nullif(trim(coalesce(v_extraction.extraction ->> 'partNumber', v_extraction.extraction ->> 'pn', '')), '');
    v_extracted_revision := nullif(trim(coalesce(v_extraction.extraction ->> 'revision', v_extraction.extraction ->> 'rev', '')), '');
    v_extracted_finish := coalesce(
      nullif(trim(coalesce(v_extraction.extraction ->> 'quoteFinish', '')), ''),
      nullif(trim(coalesce(
        v_extraction.extraction #>> '{finish,normalized}',
        v_extraction.extraction #>> '{finish,raw}',
        v_extraction.extraction #>> '{finish,raw_text}',
        ''
      )), '')
    );

    v_description := case
      when v_description_refresh then
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
      when v_part_number_refresh then
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
      when v_revision_refresh then
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
      case when v_material_placeholder_replaced then null
        else nullif(trim(coalesce(v_requirement.material, '')), '') end,
      nullif(trim(coalesce(
        v_extraction.extraction #>> '{material,normalized}',
        v_extraction.extraction #>> '{material,raw}',
        v_extraction.extraction #>> '{material,raw_text}',
        ''
      )), ''),
      case when v_requires_material then 'Unknown material' else '' end
    );
    v_finish := case
      when v_finish_refresh then
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
      when v_description_refresh then
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
      when v_finish_refresh then
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

    v_part.quantity := v_quantity;
    v_part_writes := array_append(v_part_writes, v_part);

    if v_requirement.id is null and v_has_review_blocker then
      if v_extraction.id is not null then
        v_review_part_ids := array_append(v_review_part_ids, v_part.id);
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
        'fieldSources', case
          when jsonb_typeof(v_requirement.spec_snapshot -> 'fieldSources') = 'object'
            then v_requirement.spec_snapshot -> 'fieldSources'
          else '{}'::jsonb
        end || jsonb_build_object(
          'description', v_description_source,
          'partNumber', v_part_number_source,
          'revision', v_revision_source,
          'finish', v_finish_source
        ),
        'fieldOverrides', case
          when jsonb_typeof(v_requirement.spec_snapshot -> 'fieldOverrides') = 'object'
            then v_requirement.spec_snapshot -> 'fieldOverrides'
          else '{}'::jsonb
        end || jsonb_build_object(
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

    -- Keep editor defaults in sync without turning override ownership into
    -- sticky legacy provenance. Reset can then return to the drawing value.
    if jsonb_typeof(v_spec_snapshot #> '{projectPartProperties,defaults}') = 'object' then
      v_property_defaults := v_spec_snapshot #> '{projectPartProperties,defaults}';
      if v_description_refresh then
        v_property_defaults := v_property_defaults || jsonb_build_object('description', coalesce(v_quote_description, v_description));
      elsif v_property_overrides ? 'description' and v_extraction_newer
        and not v_description_review_needed and v_extracted_description is not null then
        v_property_defaults := v_property_defaults || jsonb_build_object('description', v_extracted_description);
      end if;
      if v_part_number_refresh then
        v_property_defaults := v_property_defaults || jsonb_build_object('partNumber', v_part_number);
      elsif v_property_overrides ? 'partNumber' and v_extraction_newer
        and not v_part_number_review_needed and v_extracted_part_number is not null then
        v_property_defaults := v_property_defaults || jsonb_build_object('partNumber', v_extracted_part_number);
      end if;
      if v_revision_refresh then
        v_property_defaults := v_property_defaults || jsonb_build_object('revision', v_revision);
      elsif v_property_overrides ? 'revision' and v_extraction_newer
        and not v_revision_review_needed and v_extracted_revision is not null then
        v_property_defaults := v_property_defaults || jsonb_build_object('revision', v_extracted_revision);
      end if;
      if v_finish_refresh then
        v_property_defaults := v_property_defaults || jsonb_build_object('finish', coalesce(v_quote_finish, v_finish));
      elsif v_property_overrides ? 'finish' and v_extraction_newer
        and not v_finish_review_needed and v_extracted_finish is not null then
        v_property_defaults := v_property_defaults || jsonb_build_object('finish', v_extracted_finish);
      end if;
      if v_material_placeholder_replaced then
        v_property_defaults := v_property_defaults || jsonb_build_object('material', coalesce(v_material, ''));
      end if;
      v_spec_snapshot := jsonb_set(v_spec_snapshot, '{projectPartProperties,defaults}', v_property_defaults);
    end if;

    v_write.part_id := v_part.id;
    v_write.organization_id := v_job.organization_id;
    v_write.approved_by := coalesce(v_requirement.approved_by, v_job.created_by);
    v_write.description := v_description;
    v_write.part_number := v_part_number;
    v_write.revision := v_revision;
    v_write.material := coalesce(v_material, '');
    v_write.finish := v_finish;
    v_write.tightest_tolerance_inch := v_tightest_tolerance_inch;
    v_write.quantity := v_quantity;
    v_write.quote_quantities := v_quote_quantities;
    v_write.requested_by_date := v_requested_by_date;
    v_write.applicable_vendors := v_applicable_vendors;
    v_write.spec_snapshot := v_spec_snapshot;
    v_write.approved_at := v_timestamp;
    v_write.updated_at := v_timestamp;
    v_requirement_writes := array_append(v_requirement_writes, v_write);

    if v_extraction.id is not null then
      v_approved_part_ids := array_append(v_approved_part_ids, v_part.id);
    end if;

    v_count := v_count + 1;
  end loop;

  select count(*)::integer
  into v_pending_extract_tasks
  from public.work_queue queue
  where queue.job_id = p_job_id
    and queue.task_type = 'extract_part'
    and queue.status in ('queued', 'running')
    and not (
      queue.status = 'running'
      and queue.attempt_id is not null
      and exists (
        select 1 from public.drawing_extractions stored
        where stored.part_id = queue.part_id
          and stored.source_attempt_id = queue.attempt_id
      )
    );

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
    and requirement.id is null
    and not exists (
      select 1 from unnest(v_requirement_writes) staged where staged.part_id = part.id
    );

  if v_pending_extract_tasks > 0 then
    update public.jobs
    set status = 'extracting'
    where id = p_job_id
      and status in ('uploaded', 'extracting', 'needs_spec_review', 'ready_to_quote');
  elsif v_failed_extract_tasks > 0 or v_unapproved_parts > 0 then
    update public.jobs
    set status = 'needs_spec_review'
    where id = p_job_id
      and status in ('uploaded', 'extracting', 'needs_spec_review', 'ready_to_quote');
  elsif v_count > 0 then
    update public.jobs
    set status = 'ready_to_quote'
    where id = p_job_id
      and status in ('uploaded', 'extracting', 'needs_spec_review', 'ready_to_quote');
  end if;

  -- Writes acquire L2, L3 and L4 in phases.
  perform 1 from public.parts where job_id = p_job_id order by id for update;
  for v_part in select staged.* from unnest(v_part_writes) staged order by staged.id
  loop
    update public.parts
    set quantity = v_part.quantity, updated_at = v_timestamp
    where id = v_part.id;
  end loop;

  perform 1 from public.approved_part_requirements requirement
  join public.parts part on part.id = requirement.part_id
  where part.job_id = p_job_id
  order by requirement.part_id for update of requirement;
  for v_write in
    select staged.* from unnest(v_requirement_writes) staged order by staged.part_id
  loop
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
      v_write.part_id,
      v_write.organization_id,
      v_write.approved_by,
      v_write.description,
      v_write.part_number,
      v_write.revision,
      v_write.material,
      v_write.finish,
      v_write.tightest_tolerance_inch,
      v_write.quantity,
      v_write.quote_quantities,
      v_write.requested_by_date,
      v_write.applicable_vendors,
      v_write.spec_snapshot,
      v_write.approved_at,
      v_write.updated_at
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

  end loop;

  perform 1 from public.drawing_extractions extraction
  join public.parts part on part.id = extraction.part_id
  where part.job_id = p_job_id
  order by extraction.part_id for update of extraction;
  update public.drawing_extractions set status = 'needs_review'
  where part_id = any(v_review_part_ids);
  update public.drawing_extractions set status = 'approved'
  where part_id = any(v_approved_part_ids);

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
