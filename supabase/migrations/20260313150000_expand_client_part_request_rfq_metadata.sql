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
  date
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
