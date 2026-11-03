-- OVD-994: narrow Need-by removal and explicit empty Threads. Apply only in an approved window.
-- Sorts after 20261101130100. Preconditions pin the 20260408120000 update RPC and resolver prosrc.
set local lock_timeout = '5s';

do $ovd994_precondition$
begin
  if (select pg_catalog.md5(prosrc) from pg_catalog.pg_proc
      where oid = pg_catalog.to_regprocedure('public.api_update_client_part_request(uuid,text[],text,text,text,text,text,text,text,text,numeric,text,text,integer,integer[],date,jsonb,jsonb,jsonb,jsonb)')) is distinct from '93b90366752f07ea233030e895873e73' then
    raise exception 'OVD-994 refused: unexpected body for public.api_update_client_part_request(uuid,text[],text,text,text,text,text,text,text,text,numeric,text,text,integer,integer[],date,jsonb,jsonb,jsonb,jsonb)' using errcode = '55000';
  end if;
end;
$ovd994_precondition$;

do $ovd994_resolver_precondition$
begin
  if (select pg_catalog.md5(prosrc) from pg_catalog.pg_proc
      where oid = pg_catalog.to_regprocedure('public.resolve_project_part_property_values(jsonb,jsonb)')) is distinct from 'c3228f0de730b7382f3f27bcb6139572' then
    raise exception 'OVD-994 refused: unexpected property resolver body' using errcode = '55000';
  end if;
end;
$ovd994_resolver_precondition$;

drop function public.api_update_client_part_request(uuid,text[],text,text,text,text,text,text,text,text,numeric,text,text,integer,integer[],date,jsonb,jsonb,jsonb,jsonb);

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
  p_release jsonb default '{}'::jsonb,
  p_clear_threads boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_context record;
  v_job public.jobs%rowtype;
  v_part public.parts%rowtype;
  v_requirement public.approved_part_requirements%rowtype;
  v_extraction public.drawing_extractions%rowtype;
  v_requested_service_kinds text[] := public.normalize_requested_service_kinds(p_requested_service_kinds, p_primary_service_kind);
  v_primary_service_kind text    := public.normalize_primary_service_kind(p_requested_service_kinds, p_primary_service_kind);
  v_requires_material boolean    := 'manufacturing_quote' = any(v_requested_service_kinds);
  v_quantity integer             := greatest(coalesce(p_quantity, 1), 1);
  v_quote_quantities integer[]   := public.normalize_positive_integer_array(p_requested_quote_quantities, v_quantity);
  v_applicable_vendors public.vendor_name[] := array[]::public.vendor_name[];
  v_spec_snapshot jsonb          := '{}'::jsonb;
  v_timestamp timestamptz        := timezone('utc', now());
  v_shipping jsonb               := coalesce(p_shipping, '{}'::jsonb);
  v_certifications jsonb         := coalesce(p_certifications, '{}'::jsonb);
  v_sourcing jsonb               := coalesce(p_sourcing, '{}'::jsonb);
  v_release jsonb                := coalesce(p_release, '{}'::jsonb);
  v_required_certifications text[] := array(
    select value from (
      select nullif(trim(item.value), '') as value
      from jsonb_array_elements_text(coalesce(v_certifications -> 'requiredCertifications', '[]'::jsonb)) as item(value)
    ) filtered where value is not null
  );
  v_preferred_suppliers text[] := array(
    select value from (
      select nullif(trim(item.value), '') as value
      from jsonb_array_elements_text(coalesce(v_sourcing -> 'preferredSuppliers', '[]'::jsonb)) as item(value)
    ) filtered where value is not null
  );
  v_packaging_notes text      := nullif(trim(coalesce(v_shipping ->> 'packagingNotes', '')), '');
  v_shipping_notes text       := nullif(trim(coalesce(v_shipping ->> 'shippingNotes', '')), '');
  v_material_cert_required boolean := case
    when jsonb_typeof(v_certifications -> 'materialCertificationRequired') = 'boolean'
      then (v_certifications ->> 'materialCertificationRequired')::boolean
    else null end;
  v_coc_required boolean := case
    when jsonb_typeof(v_certifications -> 'certificateOfConformanceRequired') = 'boolean'
      then (v_certifications ->> 'certificateOfConformanceRequired')::boolean
    else null end;
  v_inspection_level text := case
    when v_certifications ->> 'inspectionLevel' in ('standard', 'fai', 'custom')
      then v_certifications ->> 'inspectionLevel'
    else null end;
  v_certification_notes text  := nullif(trim(coalesce(v_certifications ->> 'notes', '')), '');
  v_region_preference text := case
    when v_sourcing ->> 'regionPreferenceOverride' in ('best_value', 'domestic_preferred', 'domestic_only', 'foreign_allowed')
      then v_sourcing ->> 'regionPreferenceOverride'
    else null end;
  v_material_provisioning text := case
    when v_sourcing ->> 'materialProvisioning' in ('supplier_to_source', 'customer_supplied', 'tbd')
      then v_sourcing ->> 'materialProvisioning'
    else null end;
  v_sourcing_notes text       := nullif(trim(coalesce(v_sourcing ->> 'notes', '')), '');
  v_release_status text := case
    when v_release ->> 'releaseStatus' in ('unknown', 'prototype', 'pre_release', 'released')
      then v_release ->> 'releaseStatus'
    else null end;
  v_release_notes text        := nullif(trim(coalesce(v_release ->> 'notes', '')), '');
  v_property_state jsonb      := '{}'::jsonb;
  v_property_defaults jsonb   := '{}'::jsonb;
  v_property_overrides jsonb  := '{}'::jsonb;
  v_property_created_at text;
  v_description_effective text;
  v_part_number_effective text;
  v_material_effective text;
  v_finish_effective text;
  v_threads_effective text;
  v_tightest_tolerance_effective numeric;
  v_revision_effective text;
  v_process_effective text;
  v_description_override text  := nullif(trim(coalesce(p_description, '')), '');
  v_part_number_override text  := nullif(trim(coalesce(p_part_number, '')), '');
  v_material_override text     := trim(coalesce(p_material, ''));
  v_finish_override text       := nullif(trim(coalesce(p_finish, '')), '');
  v_threads_override text      := nullif(trim(coalesce(p_threads, '')), '');
  v_revision_override text     := nullif(trim(coalesce(p_revision, '')), '');
  v_process_override text      := nullif(trim(coalesce(p_process, '')), '');
begin
  select * into v_context from public.load_editable_project_part_context(p_job_id);
  v_job         := v_context.job;
  v_part        := v_context.part;
  v_requirement := v_context.requirement;
  v_extraction  := v_context.extraction;

  v_property_state      := coalesce(v_requirement.spec_snapshot -> 'projectPartProperties', '{}'::jsonb);
  v_property_defaults   := coalesce(v_property_state -> 'defaults', '{}'::jsonb);
  v_property_overrides  := coalesce(v_property_state -> 'overrides', '{}'::jsonb);
  v_property_created_at := nullif(trim(coalesce(v_property_state ->> 'createdAt', '')), '');
  v_property_defaults   := public.seed_project_part_property_defaults(v_requirement, v_extraction.extraction, v_property_defaults);

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

  if v_material_override is distinct from coalesce(nullif(trim(coalesce(v_property_defaults ->> 'material', '')), ''), '') then
    v_property_overrides := v_property_overrides || jsonb_build_object('material', to_jsonb(v_material_override));
  else
    v_property_overrides := v_property_overrides - 'material';
  end if;

  if v_finish_override is distinct from nullif(trim(coalesce(v_property_defaults ->> 'finish', '')), '') then
    v_property_overrides := v_property_overrides || jsonb_build_object('finish', to_jsonb(v_finish_override));
  else
    v_property_overrides := v_property_overrides - 'finish';
  end if;

  if p_clear_threads or (v_threads_override is null and v_property_overrides ->> 'threads' = '') then
    -- Empty string is an explicit empty override, distinct from no override.
    v_property_overrides := v_property_overrides || jsonb_build_object('threads', '');
  elsif v_threads_override is distinct from nullif(trim(coalesce(v_property_defaults ->> 'threads', '')), '') then
    v_property_overrides := v_property_overrides || jsonb_build_object('threads', to_jsonb(v_threads_override));
  else
    v_property_overrides := v_property_overrides - 'threads';
  end if;

  if p_tightest_tolerance_inch is distinct from nullif(v_property_defaults ->> 'tightestToleranceInch', '')::numeric then
    v_property_overrides := v_property_overrides || jsonb_build_object('tightestToleranceInch', to_jsonb(p_tightest_tolerance_inch));
  else
    v_property_overrides := v_property_overrides - 'tightestToleranceInch';
  end if;

  if v_revision_override is distinct from nullif(trim(coalesce(v_property_defaults ->> 'revision', '')), '') then
    v_property_overrides := v_property_overrides || jsonb_build_object('revision', to_jsonb(v_revision_override));
  else
    v_property_overrides := v_property_overrides - 'revision';
  end if;

  if v_process_override is distinct from nullif(trim(coalesce(v_property_defaults ->> 'process', '')), '') then
    v_property_overrides := v_property_overrides || jsonb_build_object('process', to_jsonb(v_process_override));
  else
    v_property_overrides := v_property_overrides - 'process';
  end if;

  select
    resolved.description, resolved.part_number, resolved.material,
    resolved.finish, resolved.threads, resolved.tightest_tolerance_inch,
    resolved.revision, resolved.process
  into
    v_description_effective, v_part_number_effective, v_material_effective,
    v_finish_effective, v_threads_effective, v_tightest_tolerance_effective,
    v_revision_effective, v_process_effective
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
    v_property_defaults, v_property_overrides,
    coalesce(v_property_created_at, v_timestamp::text), v_timestamp,
    v_description_effective, v_part_number_effective, v_material_effective,
    v_finish_effective, v_threads_effective, v_tightest_tolerance_effective,
    v_revision_effective, v_process_effective
  ) || jsonb_build_object(
    'requestedServiceKinds', v_requested_service_kinds,
    'primaryServiceKind',    v_primary_service_kind,
    'serviceNotes',          nullif(trim(coalesce(p_service_notes, '')), ''),
    'revision',              v_revision_effective,
    'quantity',              v_quantity,
    'quoteQuantities',       v_quote_quantities,
    'requestedByDate',       p_requested_by_date,
    'process',               v_process_effective,
    'notes',                 nullif(trim(coalesce(p_notes, '')), ''),
    'shipping', coalesce(v_requirement.spec_snapshot -> 'shipping', '{}'::jsonb)
      || jsonb_build_object('packagingNotes', v_packaging_notes, 'shippingNotes', v_shipping_notes),
    'certifications', coalesce(v_requirement.spec_snapshot -> 'certifications', '{}'::jsonb)
      || jsonb_build_object(
        'requiredCertifications',          to_jsonb(coalesce(v_required_certifications, array[]::text[])),
        'materialCertificationRequired',   v_material_cert_required,
        'certificateOfConformanceRequired', v_coc_required,
        'inspectionLevel',                 v_inspection_level,
        'notes',                           v_certification_notes
      ),
    'sourcing', coalesce(v_requirement.spec_snapshot -> 'sourcing', '{}'::jsonb)
      || jsonb_build_object(
        'regionPreferenceOverride', v_region_preference,
        'preferredSuppliers',       to_jsonb(coalesce(v_preferred_suppliers, array[]::text[])),
        'materialProvisioning',     v_material_provisioning,
        'notes',                    v_sourcing_notes
      ),
    'release', coalesce(v_requirement.spec_snapshot -> 'release', '{}'::jsonb)
      || jsonb_build_object('releaseStatus', v_release_status, 'notes', v_release_notes)
  );

  update public.jobs
  set
    requested_service_kinds  = v_requested_service_kinds,
    primary_service_kind     = v_primary_service_kind,
    service_notes            = nullif(trim(coalesce(p_service_notes, '')), ''),
    requested_quote_quantities = v_quote_quantities,
    requested_by_date        = p_requested_by_date,
    updated_at               = v_timestamp
  where id = v_job.id;

  update public.parts
  set quantity = v_quantity, updated_at = v_timestamp
  where id = v_part.id;

  insert into public.approved_part_requirements (
    part_id, organization_id, approved_by,
    description, part_number, revision, material, finish,
    tightest_tolerance_inch, quantity, quote_quantities, requested_by_date,
    applicable_vendors, spec_snapshot, approved_at, updated_at
  )
  values (
    v_part.id, v_job.organization_id, auth.uid(),
    v_description_effective, v_part_number_effective, v_revision_effective,
    coalesce(v_material_effective, ''), v_finish_effective,
    v_tightest_tolerance_effective, v_quantity, v_quote_quantities, p_requested_by_date,
    v_applicable_vendors, v_spec_snapshot, v_timestamp, v_timestamp
  )
  on conflict (part_id) do update
    set approved_by             = auth.uid(),
        description             = excluded.description,
        part_number             = excluded.part_number,
        revision                = excluded.revision,
        material                = excluded.material,
        finish                  = excluded.finish,
        tightest_tolerance_inch = excluded.tightest_tolerance_inch,
        quantity                = excluded.quantity,
        quote_quantities        = excluded.quote_quantities,
        requested_by_date       = excluded.requested_by_date,
        applicable_vendors      = excluded.applicable_vendors,
        spec_snapshot           = excluded.spec_snapshot,
        approved_at             = excluded.approved_at,
        updated_at              = excluded.updated_at;

  perform public.log_audit_event(
    v_job.organization_id,
    'client.part_request_updated',
    jsonb_build_object(
      'jobId',                        v_job.id,
      'partId',                       v_part.id,
      'requestedServiceKinds',        v_requested_service_kinds,
      'primaryServiceKind',           v_primary_service_kind,
      'quantity',                     v_quantity,
      'requestedQuoteQuantities',     v_quote_quantities,
      'requestedByDate',              p_requested_by_date,
      'releaseStatus',                v_release_status,
      'requiredCertifications',       coalesce(v_required_certifications, array[]::text[]),
      'projectPartPropertyOverrides', v_property_overrides
    ),
    v_job.id,
    null
  );

  return v_job.id;
end;
$$;

create or replace function public.api_clear_client_part_requested_by_date(p_job_id uuid)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_context record;
  v_job public.jobs%rowtype;
  v_part public.parts%rowtype;
  v_changed boolean := false;
  v_rows integer;
begin
  -- Same verified-auth and edit access checks as the full-save RPC.
  select * into v_context from public.load_editable_project_part_context(p_job_id);
  v_job := v_context.job;
  v_part := v_context.part;

  -- Canonical writer order: job, part, approved requirement. Read/modify
  -- the current snapshot under the row lock, never the context's stale copy.
  perform 1 from public.jobs where id = v_job.id for no key update;
  perform 1 from public.parts where id = v_part.id for no key update;
  perform 1 from public.approved_part_requirements where part_id = v_part.id for no key update;

  update public.jobs set requested_by_date = null
  where id = v_job.id and requested_by_date is not null;
  get diagnostics v_rows = row_count;
  v_changed := v_rows > 0;

  update public.approved_part_requirements
  set requested_by_date = null,
      spec_snapshot = case when spec_snapshot ->> 'requestedByDate' is not null
        then jsonb_set(spec_snapshot, '{requestedByDate}', 'null'::jsonb)
        else spec_snapshot end
  where part_id = v_part.id
    and (requested_by_date is not null or spec_snapshot ->> 'requestedByDate' is not null);
  get diagnostics v_rows = row_count;
  v_changed := v_changed or v_rows > 0;

  -- Dedicated event, only for a real change; this is not a new approval.
  if v_changed then
    perform public.log_audit_event(v_job.organization_id,
      'client.part_requested_by_date_cleared',
      jsonb_build_object('jobId', v_job.id, 'partId', v_part.id), v_job.id, null);
  end if;
  return v_job.id;
end;
$$;

revoke all on function public.api_update_client_part_request(uuid,text[],text,text,text,text,text,text,text,text,numeric,text,text,integer,integer[],date,jsonb,jsonb,jsonb,jsonb,boolean) from public, anon;
grant execute on function public.api_update_client_part_request(uuid,text[],text,text,text,text,text,text,text,text,numeric,text,text,integer,integer[],date,jsonb,jsonb,jsonb,jsonb,boolean) to authenticated, service_role;
revoke all on function public.api_clear_client_part_requested_by_date(uuid) from public, anon, service_role;
grant execute on function public.api_clear_client_part_requested_by_date(uuid) to authenticated;

-- Honor explicit empty Threads when resetting another property, too.
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
  tightest_tolerance_inch numeric,
  revision text,
  process text
)
language sql
stable
set search_path = pg_catalog
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
    case when p_overrides ->> 'threads' = '' then '' else
    coalesce(
      nullif(trim(coalesce(p_overrides ->> 'threads', '')), ''),
      nullif(trim(coalesce(p_defaults ->> 'threads', '')), ''),
      null
    ) end as threads,
    coalesce(
      nullif(p_overrides ->> 'tightestToleranceInch', '')::numeric,
      nullif(p_defaults ->> 'tightestToleranceInch', '')::numeric
    ) as tightest_tolerance_inch,
    coalesce(
      nullif(trim(coalesce(p_overrides ->> 'revision', '')), ''),
      nullif(trim(coalesce(p_defaults ->> 'revision', '')), ''),
      null
    ) as revision,
    coalesce(
      nullif(trim(coalesce(p_overrides ->> 'process', '')), ''),
      nullif(trim(coalesce(p_defaults ->> 'process', '')), ''),
      null
    ) as process;
$$;
