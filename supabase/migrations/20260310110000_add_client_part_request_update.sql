create or replace function public.api_update_client_part_request(
  p_job_id uuid,
  p_description text default null,
  p_part_number text default null,
  p_revision text default null,
  p_material text default null,
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

  if v_material = '' then
    raise exception 'Material is required.';
  end if;

  v_quantity := coalesce(v_quote_quantities[1], v_quantity, 1);

  select *
  into v_requirement
  from public.approved_part_requirements
  where part_id = v_part.id;

  if coalesce(array_length(v_requirement.applicable_vendors, 1), 0) > 0 then
    v_applicable_vendors := v_requirement.applicable_vendors;
  else
    v_applicable_vendors := array['xometry', 'fictiv', 'protolabs']::public.vendor_name[];

    if coalesce(p_tightest_tolerance_inch, v_requirement.tightest_tolerance_inch, 0.005) >= 0.005 then
      v_applicable_vendors := array_append(v_applicable_vendors, 'sendcutsend'::public.vendor_name);
    end if;
  end if;

  v_spec_snapshot := coalesce(v_requirement.spec_snapshot, '{}'::jsonb) || jsonb_build_object(
    'description', nullif(trim(coalesce(p_description, '')), ''),
    'partNumber', nullif(trim(coalesce(p_part_number, '')), ''),
    'revision', nullif(trim(coalesce(p_revision, '')), ''),
    'material', v_material,
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
    v_material,
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
