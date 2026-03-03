create or replace function public.current_user_has_verified_auth()
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
    from auth.users app_user
    where app_user.id = auth.uid()
      and (
        app_user.email_confirmed_at is not null
        or coalesce(app_user.raw_app_meta_data ->> 'provider', '') in ('google', 'azure', 'apple')
      )
  );
$$;

create or replace function public.require_verified_auth()
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'You must be signed in to perform this action.';
  end if;

  if not public.current_user_has_verified_auth() then
    raise exception 'Verify your email or sign in with Google, Microsoft, or Apple before performing this action.';
  end if;
end;
$$;

create or replace function public.api_create_self_service_organization(
  p_organization_name text
)
returns uuid
language plpgsql
security definer
set search_path = public, auth, private
as $$
declare
  v_trimmed_name text := trim(coalesce(p_organization_name, ''));
  v_base_slug text;
  v_slug text;
  v_organization_id uuid;
  v_role public.app_role;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in to create an organization.';
  end if;

  perform public.require_verified_auth();
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text, 0));

  if exists (
    select 1
    from public.organization_memberships membership
    where membership.user_id = auth.uid()
  ) then
    raise exception 'Your account already has an organization membership.';
  end if;

  if v_trimmed_name = '' then
    raise exception 'Organization name is required.';
  end if;

  v_base_slug := trim(
    both '-'
    from regexp_replace(lower(v_trimmed_name), '[^a-z0-9]+', '-', 'g')
  );

  if v_base_slug = '' then
    v_base_slug := 'organization';
  end if;

  v_slug := v_base_slug;

  while exists (
    select 1
    from public.organizations organization_row
    where organization_row.slug = v_slug
  ) loop
    v_slug := v_base_slug || '-' || substring(replace(gen_random_uuid()::text, '-', '') from 1 for 6);
  end loop;

  v_role := public.get_self_service_membership_role(auth.uid());

  insert into public.organizations (name, slug)
  values (v_trimmed_name, v_slug)
  returning id into v_organization_id;

  insert into public.organization_memberships (
    organization_id,
    user_id,
    role
  )
  values (
    v_organization_id,
    auth.uid(),
    v_role
  );

  perform public.log_audit_event(
    v_organization_id,
    'organization.self_service_bootstrapped',
    jsonb_build_object(
      'organizationName', v_trimmed_name,
      'organizationSlug', v_slug,
      'role', v_role
    ),
    null,
    null
  );

  return v_organization_id;
end;
$$;

create or replace function public.api_update_organization_membership_role(
  p_membership_id uuid,
  p_role public.app_role
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_membership public.organization_memberships%rowtype;
  v_admin_count integer;
begin
  perform public.require_verified_auth();

  select *
  into v_membership
  from public.organization_memberships
  where id = p_membership_id;

  if v_membership.id is null then
    raise exception 'Membership % not found', p_membership_id;
  end if;

  if not public.is_org_admin(v_membership.organization_id) then
    raise exception 'You do not have admin access to organization %', v_membership.organization_id;
  end if;

  if v_membership.role = p_role then
    return v_membership.id;
  end if;

  if v_membership.role = 'internal_admin' and p_role <> 'internal_admin' then
    select count(*)
    into v_admin_count
    from public.organization_memberships membership
    where membership.organization_id = v_membership.organization_id
      and membership.role = 'internal_admin';

    if v_admin_count <= 1 then
      raise exception 'Each organization must keep at least one internal admin.';
    end if;
  end if;

  update public.organization_memberships
  set role = p_role
  where id = v_membership.id;

  perform public.log_audit_event(
    v_membership.organization_id,
    'organization_membership.role_updated',
    jsonb_build_object(
      'membershipId', v_membership.id,
      'userId', v_membership.user_id,
      'previousRole', v_membership.role,
      'newRole', p_role
    ),
    null,
    null
  );

  return v_membership.id;
end;
$$;

create or replace function public.api_create_job(
  p_organization_id uuid,
  p_title text,
  p_description text default null,
  p_source text default 'client'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job_id uuid;
  v_pricing_policy_id uuid;
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
    active_pricing_policy_id
  )
  values (
    p_organization_id,
    auth.uid(),
    p_title,
    p_description,
    coalesce(nullif(trim(p_source), ''), 'client'),
    v_pricing_policy_id
  )
  returning id into v_job_id;

  perform public.log_audit_event(
    p_organization_id,
    'job.created',
    jsonb_build_object('title', p_title, 'source', coalesce(p_source, 'client')),
    v_job_id,
    null
  );

  return v_job_id;
end;
$$;

create or replace function public.api_attach_job_file(
  p_job_id uuid,
  p_storage_bucket text,
  p_storage_path text,
  p_original_name text,
  p_file_kind public.job_file_kind,
  p_mime_type text default null,
  p_size_bytes bigint default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.jobs%rowtype;
  v_file_id uuid;
begin
  perform public.require_verified_auth();

  select *
  into v_job
  from public.jobs
  where id = p_job_id;

  if v_job.id is null then
    raise exception 'Job % not found', p_job_id;
  end if;

  if not public.user_can_access_org(v_job.organization_id) then
    raise exception 'You do not have access to job %', p_job_id;
  end if;

  insert into public.job_files (
    job_id,
    organization_id,
    uploaded_by,
    storage_bucket,
    storage_path,
    original_name,
    normalized_name,
    file_kind,
    mime_type,
    size_bytes
  )
  values (
    p_job_id,
    v_job.organization_id,
    auth.uid(),
    coalesce(nullif(p_storage_bucket, ''), 'job-files'),
    p_storage_path,
    p_original_name,
    public.normalize_file_basename(p_original_name),
    p_file_kind,
    p_mime_type,
    p_size_bytes
  )
  returning id into v_file_id;

  perform public.log_audit_event(
    v_job.organization_id,
    'job.file_attached',
    jsonb_build_object('fileId', v_file_id, 'originalName', p_original_name, 'kind', p_file_kind),
    p_job_id,
    null
  );

  return v_file_id;
end;
$$;

create or replace function public.api_reconcile_job_parts(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.jobs%rowtype;
  v_total_parts integer := 0;
  v_matched_pairs integer := 0;
  v_missing_drawings integer := 0;
  v_missing_cad integer := 0;
begin
  perform public.require_verified_auth();

  select *
  into v_job
  from public.jobs
  where id = p_job_id;

  if v_job.id is null then
    raise exception 'Job % not found', p_job_id;
  end if;

  if not public.user_can_access_org(v_job.organization_id) then
    raise exception 'You do not have access to job %', p_job_id;
  end if;

  with file_set as (
    select
      file.normalized_name,
      max(file.id) filter (where file.file_kind = 'cad') as cad_file_id,
      max(file.id) filter (where file.file_kind = 'drawing') as drawing_file_id
    from public.job_files file
    where file.job_id = p_job_id
      and file.file_kind in ('cad', 'drawing')
    group by file.normalized_name
  )
  delete from public.parts part
  where part.job_id = p_job_id
    and not exists (
      select 1
      from file_set fs
      where fs.normalized_name = part.normalized_key
    );

  with file_set as (
    select
      file.normalized_name,
      max(file.id) filter (where file.file_kind = 'cad') as cad_file_id,
      max(file.id) filter (where file.file_kind = 'drawing') as drawing_file_id
    from public.job_files file
    where file.job_id = p_job_id
      and file.file_kind in ('cad', 'drawing')
    group by file.normalized_name
  )
  insert into public.parts (
    job_id,
    organization_id,
    name,
    normalized_key,
    cad_file_id,
    drawing_file_id,
    quantity
  )
  select
    p_job_id,
    v_job.organization_id,
    fs.normalized_name,
    fs.normalized_name,
    fs.cad_file_id,
    fs.drawing_file_id,
    1
  from file_set fs
  on conflict (job_id, normalized_key) do update
    set cad_file_id = excluded.cad_file_id,
        drawing_file_id = excluded.drawing_file_id,
        updated_at = timezone('utc', now());

  update public.job_files
  set matched_part_key = normalized_name
  where job_id = p_job_id
    and file_kind in ('cad', 'drawing');

  with file_set as (
    select
      file.normalized_name,
      max(file.id) filter (where file.file_kind = 'cad') as cad_file_id,
      max(file.id) filter (where file.file_kind = 'drawing') as drawing_file_id
    from public.job_files file
    where file.job_id = p_job_id
      and file.file_kind in ('cad', 'drawing')
    group by file.normalized_name
  )
  select
    count(*)::integer,
    count(*) filter (where cad_file_id is not null and drawing_file_id is not null)::integer,
    count(*) filter (where cad_file_id is not null and drawing_file_id is null)::integer,
    count(*) filter (where cad_file_id is null and drawing_file_id is not null)::integer
  into
    v_total_parts,
    v_matched_pairs,
    v_missing_drawings,
    v_missing_cad
  from file_set;

  perform public.log_audit_event(
    v_job.organization_id,
    'job.parts_reconciled',
    jsonb_build_object(
      'totalParts', coalesce(v_total_parts, 0),
      'matchedPairs', coalesce(v_matched_pairs, 0),
      'missingDrawings', coalesce(v_missing_drawings, 0),
      'missingCad', coalesce(v_missing_cad, 0)
    ),
    p_job_id,
    null
  );

  return jsonb_build_object(
    'totalParts', coalesce(v_total_parts, 0),
    'matchedPairs', coalesce(v_matched_pairs, 0),
    'missingDrawings', coalesce(v_missing_drawings, 0),
    'missingCad', coalesce(v_missing_cad, 0)
  );
end;
$$;

create or replace function public.api_request_extraction(p_job_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.jobs%rowtype;
  v_count integer := 0;
begin
  perform public.require_verified_auth();

  select *
  into v_job
  from public.jobs
  where id = p_job_id;

  if v_job.id is null then
    raise exception 'Job % not found', p_job_id;
  end if;

  if not public.user_can_access_org(v_job.organization_id) then
    raise exception 'You do not have access to job %', p_job_id;
  end if;

  perform public.api_reconcile_job_parts(p_job_id);

  with enqueued as (
    insert into public.work_queue (
      organization_id,
      job_id,
      part_id,
      task_type,
      payload
    )
    select
      v_job.organization_id,
      p_job_id,
      part.id,
      'extract_part',
      jsonb_build_object('partId', part.id, 'jobId', p_job_id)
    from public.parts part
    where part.job_id = p_job_id
      and not exists (
        select 1
        from public.work_queue queue
        where queue.part_id = part.id
          and queue.task_type = 'extract_part'
          and queue.status in ('queued', 'running')
      )
    returning id
  )
  select count(*)::integer into v_count from enqueued;

  update public.jobs
  set status = 'extracting'
  where id = p_job_id;

  perform public.log_audit_event(
    v_job.organization_id,
    'job.extraction_requested',
    jsonb_build_object('queuedTasks', v_count),
    p_job_id,
    null
  );

  return coalesce(v_count, 0);
end;
$$;

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

    if not exists (
      select 1
      from public.parts part
      where part.id = v_part_id
        and part.job_id = p_job_id
    ) then
      raise exception 'Part % does not belong to job %', v_part_id, p_job_id;
    end if;

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
      coalesce(nullif(v_item ->> 'quantity', '')::integer, 1),
      v_vendors,
      v_item
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
          applicable_vendors = excluded.applicable_vendors,
          spec_snapshot = excluded.spec_snapshot,
          approved_at = timezone('utc', now()),
          updated_at = timezone('utc', now());

    update public.parts
    set quantity = coalesce(nullif(v_item ->> 'quantity', '')::integer, 1)
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

create or replace function public.api_start_quote_run(
  p_job_id uuid,
  p_auto_publish_requested boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.jobs%rowtype;
  v_quote_run_id uuid;
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
    raise exception 'Only internal users can start quote runs for job %', p_job_id;
  end if;

  if exists (
    select 1
    from public.parts part
    where part.job_id = p_job_id
      and not exists (
        select 1
        from public.approved_part_requirements requirement
        where requirement.part_id = part.id
      )
  ) then
    raise exception 'All parts must have approved requirements before starting a quote run.';
  end if;

  insert into public.quote_runs (
    job_id,
    organization_id,
    initiated_by,
    status,
    auto_publish_requested
  )
  values (
    p_job_id,
    v_job.organization_id,
    auth.uid(),
    'queued',
    coalesce(p_auto_publish_requested, false)
  )
  returning id into v_quote_run_id;

  insert into public.work_queue (
    organization_id,
    job_id,
    quote_run_id,
    task_type,
    payload
  )
  values (
    v_job.organization_id,
    p_job_id,
    v_quote_run_id,
    'vendor_quote',
    jsonb_build_object(
      'jobId', p_job_id,
      'quoteRunId', v_quote_run_id,
      'autoPublishRequested', coalesce(p_auto_publish_requested, false)
    )
  );

  update public.jobs
  set status = 'quoting'
  where id = p_job_id;

  perform public.log_audit_event(
    v_job.organization_id,
    'job.quote_run_started',
    jsonb_build_object('quoteRunId', v_quote_run_id, 'autoPublishRequested', coalesce(p_auto_publish_requested, false)),
    p_job_id,
    null
  );

  return v_quote_run_id;
end;
$$;

create or replace function public.api_publish_quote_package(
  p_job_id uuid,
  p_quote_run_id uuid,
  p_client_summary text default null,
  p_force boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.jobs%rowtype;
  v_readiness jsonb;
  v_pricing_policy public.pricing_policies%rowtype;
  v_package_id uuid;
  v_lowest_id uuid;
  v_fastest_id uuid;
  v_balanced_id uuid;
  v_fastest_days integer;
  v_seen uuid[] := array[]::uuid[];
  v_is_ready boolean := false;
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
    raise exception 'Only internal users can publish quote packages.';
  end if;

  v_readiness := public.api_get_quote_run_readiness(p_quote_run_id);
  v_is_ready := coalesce((v_readiness ->> 'ready')::boolean, false);

  if not p_force and not v_is_ready then
    raise exception 'Quote run % is not eligible for auto-publication', p_quote_run_id;
  end if;

  select *
  into v_pricing_policy
  from public.pricing_policies
  where id = coalesce(v_job.active_pricing_policy_id, public.get_active_pricing_policy_id(v_job.organization_id));

  if v_pricing_policy.id is null then
    raise exception 'No active pricing policy found for organization %', v_job.organization_id;
  end if;

  insert into public.published_quote_packages (
    job_id,
    quote_run_id,
    organization_id,
    published_by,
    pricing_policy_id,
    auto_published,
    client_summary
  )
  values (
    p_job_id,
    p_quote_run_id,
    v_job.organization_id,
    auth.uid(),
    v_pricing_policy.id,
    v_is_ready and not p_force,
    p_client_summary
  )
  on conflict (quote_run_id) do update
    set published_by = excluded.published_by,
        pricing_policy_id = excluded.pricing_policy_id,
        auto_published = excluded.auto_published,
        client_summary = excluded.client_summary,
        published_at = timezone('utc', now())
  returning id into v_package_id;

  delete from public.published_quote_options where package_id = v_package_id;

  select result.id
  into v_lowest_id
  from public.vendor_quote_results result
  where result.quote_run_id = p_quote_run_id
    and result.status in ('instant_quote_received', 'official_quote_received')
    and result.total_price_usd is not null
  order by result.total_price_usd asc, coalesce(result.lead_time_business_days, 999999) asc
  limit 1;

  select result.id, result.lead_time_business_days
  into v_fastest_id, v_fastest_days
  from public.vendor_quote_results result
  where result.quote_run_id = p_quote_run_id
    and result.status in ('instant_quote_received', 'official_quote_received')
    and result.total_price_usd is not null
  order by coalesce(result.lead_time_business_days, 999999) asc, result.total_price_usd asc
  limit 1;

  select result.id
  into v_balanced_id
  from public.vendor_quote_results result
  where result.quote_run_id = p_quote_run_id
    and result.status in ('instant_quote_received', 'official_quote_received')
    and result.total_price_usd is not null
    and (
      v_fastest_days is null
      or result.lead_time_business_days is null
      or result.lead_time_business_days <= v_fastest_days + 2
    )
  order by result.total_price_usd asc, coalesce(result.lead_time_business_days, 999999) asc
  limit 1;

  if v_lowest_id is null and v_fastest_id is null and v_balanced_id is null then
    raise exception 'No successful vendor quotes are available to publish.';
  end if;

  if v_lowest_id is not null and not (v_lowest_id = any(v_seen)) then
    perform public.insert_published_quote_option(
      v_package_id,
      'lowest_cost',
      v_lowest_id,
      v_pricing_policy.markup_percent,
      v_pricing_policy.currency_minor_unit,
      v_pricing_policy.version
    );
    v_seen := array_append(v_seen, v_lowest_id);
  end if;

  if v_fastest_id is not null and not (v_fastest_id = any(v_seen)) then
    perform public.insert_published_quote_option(
      v_package_id,
      'fastest_delivery',
      v_fastest_id,
      v_pricing_policy.markup_percent,
      v_pricing_policy.currency_minor_unit,
      v_pricing_policy.version
    );
    v_seen := array_append(v_seen, v_fastest_id);
  end if;

  if v_balanced_id is not null and not (v_balanced_id = any(v_seen)) then
    perform public.insert_published_quote_option(
      v_package_id,
      'balanced',
      v_balanced_id,
      v_pricing_policy.markup_percent,
      v_pricing_policy.currency_minor_unit,
      v_pricing_policy.version
    );
  end if;

  update public.jobs
  set status = 'published'
  where id = p_job_id;

  update public.quote_runs
  set status = 'published'
  where id = p_quote_run_id;

  perform public.log_audit_event(
    v_job.organization_id,
    'job.quote_package_published',
    jsonb_build_object(
      'packageId', v_package_id,
      'quoteRunId', p_quote_run_id,
      'forced', coalesce(p_force, false),
      'autoPublished', v_is_ready and not p_force
    ),
    p_job_id,
    v_package_id
  );

  return v_package_id;
end;
$$;

create or replace function public.api_select_quote_option(
  p_package_id uuid,
  p_option_id uuid,
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_package public.published_quote_packages%rowtype;
  v_option public.published_quote_options%rowtype;
  v_selection_id uuid;
begin
  perform public.require_verified_auth();

  select *
  into v_package
  from public.published_quote_packages
  where id = p_package_id;

  if v_package.id is null then
    raise exception 'Package % not found', p_package_id;
  end if;

  if not public.user_can_access_org(v_package.organization_id) then
    raise exception 'You do not have access to package %', p_package_id;
  end if;

  select *
  into v_option
  from public.published_quote_options
  where id = p_option_id
    and package_id = p_package_id;

  if v_option.id is null then
    raise exception 'Option % does not belong to package %', p_option_id, p_package_id;
  end if;

  insert into public.client_selections (
    package_id,
    option_id,
    organization_id,
    selected_by,
    note
  )
  values (
    p_package_id,
    p_option_id,
    v_package.organization_id,
    auth.uid(),
    p_note
  )
  returning id into v_selection_id;

  update public.jobs
  set status = 'client_selected'
  where id = v_package.job_id;

  perform public.log_audit_event(
    v_package.organization_id,
    'client.quote_option_selected',
    jsonb_build_object('selectionId', v_selection_id, 'optionId', p_option_id),
    v_package.job_id,
    p_package_id
  );

  return v_selection_id;
end;
$$;
