alter table public.jobs
add column if not exists requested_service_kinds text[] not null default '{manufacturing_quote}'::text[],
add column if not exists primary_service_kind text default 'manufacturing_quote',
add column if not exists service_notes text;

update public.jobs
set requested_service_kinds = array['manufacturing_quote']::text[]
where coalesce(array_length(requested_service_kinds, 1), 0) = 0;

update public.jobs
set primary_service_kind = 'manufacturing_quote'
where nullif(trim(coalesce(primary_service_kind, '')), '') is null;

create or replace function public.normalize_requested_service_kinds(
  p_requested_service_kinds text[] default '{}'::text[],
  p_primary_service_kind text default null
)
returns text[]
language plpgsql
immutable
as $$
declare
  v_valid_kinds constant text[] := array[
    'manufacturing_quote',
    'cad_modeling',
    'drawing_redraft',
    'fea_analysis',
    'dfm_review',
    'dfa_review',
    'assembly_support',
    'sourcing_only'
  ];
  v_normalized text[] := array[]::text[];
  v_item text;
  v_primary text := nullif(trim(coalesce(p_primary_service_kind, '')), '');
begin
  foreach v_item in array coalesce(p_requested_service_kinds, '{}'::text[])
  loop
    v_item := nullif(trim(coalesce(v_item, '')), '');

    if v_item is null or not (v_item = any(v_valid_kinds)) or v_item = any(v_normalized) then
      continue;
    end if;

    v_normalized := array_append(v_normalized, v_item);
  end loop;

  if coalesce(array_length(v_normalized, 1), 0) > 0 then
    return v_normalized;
  end if;

  if v_primary is not null and v_primary = any(v_valid_kinds) then
    return array[v_primary];
  end if;

  return array['manufacturing_quote']::text[];
end;
$$;

create or replace function public.normalize_primary_service_kind(
  p_requested_service_kinds text[] default '{}'::text[],
  p_primary_service_kind text default null
)
returns text
language plpgsql
immutable
as $$
declare
  v_requested_service_kinds text[] := public.normalize_requested_service_kinds(
    p_requested_service_kinds,
    p_primary_service_kind
  );
  v_primary text := nullif(trim(coalesce(p_primary_service_kind, '')), '');
begin
  if v_primary is not null and v_primary = any(v_requested_service_kinds) then
    return v_primary;
  end if;

  return coalesce(v_requested_service_kinds[1], 'manufacturing_quote');
end;
$$;

drop function if exists public.api_create_job(uuid, text, text, text, text[], integer[], date);

create or replace function public.api_create_job(
  p_organization_id uuid,
  p_title text,
  p_description text default null,
  p_source text default 'client',
  p_tags text[] default '{}'::text[],
  p_requested_service_kinds text[] default '{manufacturing_quote}'::text[],
  p_primary_service_kind text default null,
  p_service_notes text default null,
  p_requested_quote_quantities integer[] default '{}'::integer[],
  p_requested_by_date date default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job_id uuid;
  v_pricing_policy_id uuid;
  v_requested_service_kinds text[] := public.normalize_requested_service_kinds(
    p_requested_service_kinds,
    p_primary_service_kind
  );
  v_primary_service_kind text := public.normalize_primary_service_kind(
    p_requested_service_kinds,
    p_primary_service_kind
  );
  v_requested_quote_quantities integer[] := public.normalize_positive_integer_array(
    p_requested_quote_quantities,
    null
  );
begin
  perform public.require_verified_auth();

  if not public.user_can_access_org(p_organization_id) then
    raise exception 'You do not have access to organization %', p_organization_id;
  end if;

  v_pricing_policy_id := public.get_active_pricing_policy_id(p_organization_id);

  insert into public.jobs (
    organization_id,
    created_by,
    title,
    description,
    source,
    active_pricing_policy_id,
    tags,
    requested_service_kinds,
    primary_service_kind,
    service_notes,
    requested_quote_quantities,
    requested_by_date
  )
  values (
    p_organization_id,
    auth.uid(),
    p_title,
    p_description,
    coalesce(nullif(trim(p_source), ''), 'client'),
    v_pricing_policy_id,
    coalesce(p_tags, '{}'::text[]),
    v_requested_service_kinds,
    v_primary_service_kind,
    nullif(trim(coalesce(p_service_notes, '')), ''),
    v_requested_quote_quantities,
    p_requested_by_date
  )
  returning id into v_job_id;

  perform public.log_audit_event(
    p_organization_id,
    'job.created',
    jsonb_build_object(
      'title', p_title,
      'source', coalesce(p_source, 'client'),
      'requestedServiceKinds', v_requested_service_kinds,
      'primaryServiceKind', v_primary_service_kind,
      'requestedQuoteQuantities', v_requested_quote_quantities,
      'requestedByDate', p_requested_by_date
    ),
    v_job_id,
    null
  );

  return v_job_id;
end;
$$;

grant execute on function public.api_create_job(
  uuid,
  text,
  text,
  text,
  text[],
  text[],
  text,
  text,
  integer[],
  date
) to authenticated;

drop function if exists public.api_create_client_draft(text, text, uuid, text[], integer[], date);

create or replace function public.api_create_client_draft(
  p_title text,
  p_description text default null,
  p_project_id uuid default null,
  p_tags text[] default '{}'::text[],
  p_requested_service_kinds text[] default '{manufacturing_quote}'::text[],
  p_primary_service_kind text default null,
  p_service_notes text default null,
  p_requested_quote_quantities integer[] default '{}'::integer[],
  p_requested_by_date date default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_title text := trim(coalesce(p_title, ''));
  v_project public.projects%rowtype;
  v_organization_id uuid;
  v_job_id uuid;
begin
  perform public.require_verified_auth();

  if v_title = '' then
    raise exception 'Draft title is required.';
  end if;

  if p_project_id is not null then
    select *
    into v_project
    from public.projects
    where id = p_project_id;

    if v_project.id is null or v_project.archived_at is not null then
      raise exception 'Project % not found.', p_project_id;
    end if;

    if not public.user_can_edit_project(v_project.id) then
      raise exception 'You do not have permission to add drafts to this project.';
    end if;

    v_organization_id := v_project.organization_id;
  else
    v_organization_id := public.current_user_home_organization_id();
  end if;

  if v_organization_id is null then
    raise exception 'A home workspace is still being prepared for this account.';
  end if;

  v_job_id := public.api_create_job(
    v_organization_id,
    v_title,
    p_description,
    case when p_project_id is null then 'client_home' else 'shared_project' end,
    p_tags,
    p_requested_service_kinds,
    p_primary_service_kind,
    p_service_notes,
    p_requested_quote_quantities,
    p_requested_by_date
  );

  if p_project_id is not null then
    update public.jobs
    set project_id = p_project_id
    where id = v_job_id;

    insert into public.project_jobs (project_id, job_id, created_by)
    values (p_project_id, v_job_id, auth.uid())
    on conflict (project_id, job_id) do nothing;
  end if;

  return v_job_id;
end;
$$;

grant execute on function public.api_create_client_draft(
  text,
  text,
  uuid,
  text[],
  text[],
  text,
  text,
  integer[],
  date
) to authenticated;

drop function if exists public.api_update_client_part_request(
  uuid,
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
  p_requested_service_kinds text[] default '{manufacturing_quote}'::text[],
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
  p_requested_by_date date default null
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
  v_quote_compatible boolean := exists (
    select 1
    from unnest(v_requested_service_kinds) as requested_service_kind(value)
    where value in ('manufacturing_quote', 'sourcing_only')
  );
  v_material text := trim(coalesce(p_material, ''));
  v_quantity integer := greatest(coalesce(p_quantity, 1), 1);
  v_quote_quantities integer[] := public.normalize_positive_integer_array(
    p_requested_quote_quantities,
    v_quantity
  );
  v_applicable_vendors public.vendor_name[] := array[]::public.vendor_name[];
  v_spec_snapshot jsonb := '{}'::jsonb;
  v_timestamp timestamptz := timezone('utc', now());
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

  v_spec_snapshot := coalesce(v_requirement.spec_snapshot, '{}'::jsonb) || jsonb_build_object(
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
    'notes', nullif(trim(coalesce(p_notes, '')), '')
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
      'requestedByDate', p_requested_by_date
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
  date
) to authenticated;
