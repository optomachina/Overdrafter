alter table public.jobs
add column if not exists requested_quote_quantities integer[] not null default '{}'::integer[],
add column if not exists requested_by_date date;

alter table public.approved_part_requirements
add column if not exists quote_quantities integer[] not null default '{}'::integer[],
add column if not exists requested_by_date date;

alter table public.vendor_quote_results
add column if not exists requested_quantity integer;

alter table public.published_quote_options
add column if not exists requested_quantity integer;

update public.approved_part_requirements
set quote_quantities = array[quantity]
where coalesce(array_length(quote_quantities, 1), 0) = 0;

update public.vendor_quote_results result
set requested_quantity = coalesce(requirement.quantity, part.quantity, 1)
from public.parts part
left join public.approved_part_requirements requirement on requirement.part_id = part.id
where result.part_id = part.id
  and result.requested_quantity is null;

update public.published_quote_options option
set requested_quantity = coalesce(result.requested_quantity, 1)
from public.vendor_quote_results result
where option.source_vendor_quote_id = result.id
  and option.requested_quantity is null;

alter table public.vendor_quote_results
alter column requested_quantity set default 1,
alter column requested_quantity set not null;

alter table public.published_quote_options
alter column requested_quantity set default 1,
alter column requested_quantity set not null;

create or replace function public.normalize_positive_integer_array(
  p_values integer[],
  p_fallback integer default null
)
returns integer[]
language sql
immutable
set search_path = public
as $$
  select coalesce(
    (
      select array_agg(value order by first_position)
      from (
        select value, min(position) as first_position
        from unnest(coalesce(p_values, array[]::integer[])) with ordinality as item(value, position)
        where value is not null
          and value > 0
        group by value
      ) normalized
    ),
    case
      when p_fallback is not null and p_fallback > 0 then array[p_fallback]
      else array[]::integer[]
    end
  );
$$;

alter table public.vendor_quote_results
drop constraint if exists vendor_quote_results_quote_run_id_part_id_vendor_key;

alter table public.vendor_quote_results
add constraint vendor_quote_results_quote_run_id_part_id_vendor_requested_quantity_key
unique (quote_run_id, part_id, vendor, requested_quantity);

alter table public.published_quote_options
drop constraint if exists published_quote_options_package_id_option_kind_key;

alter table public.published_quote_options
add constraint published_quote_options_package_id_requested_quantity_option_kind_key
unique (package_id, requested_quantity, option_kind);

create index if not exists idx_vendor_quotes_run_quantity
on public.vendor_quote_results(quote_run_id, part_id, requested_quantity, vendor, status);

create index if not exists idx_published_quote_options_package_quantity
on public.published_quote_options(package_id, requested_quantity, option_kind);

drop function if exists public.api_create_job(uuid, text, text, text, text[]);

create function public.api_create_job(
  p_organization_id uuid,
  p_title text,
  p_description text default null,
  p_source text default 'client',
  p_tags text[] default '{}'::text[],
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
      'requestedQuoteQuantities', v_requested_quote_quantities,
      'requestedByDate', p_requested_by_date
    ),
    v_job_id,
    null
  );

  return v_job_id;
end;
$$;

drop function if exists public.api_create_client_draft(text, text, uuid, text[]);

create function public.api_create_client_draft(
  p_title text,
  p_description text default null,
  p_project_id uuid default null,
  p_tags text[] default '{}'::text[],
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

    if v_project.id is null then
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

drop function if exists public.insert_published_quote_option(
  uuid,
  public.client_option_kind,
  uuid,
  numeric,
  numeric,
  text
);

drop function if exists public.insert_published_quote_option(
  uuid,
  public.client_option_kind,
  uuid,
  numeric,
  numeric,
  text,
  uuid
);

create function public.insert_published_quote_option(
  p_package_id uuid,
  p_option_kind public.client_option_kind,
  p_vendor_quote_id uuid,
  p_requested_quantity integer,
  p_markup_percent numeric,
  p_minor_unit numeric,
  p_markup_version text,
  p_vendor_quote_offer_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_option_id uuid;
  v_record public.vendor_quote_results%rowtype;
  v_package_org uuid;
  v_label text;
  v_source_offer_id uuid;
begin
  select *
  into v_record
  from public.vendor_quote_results
  where id = p_vendor_quote_id;

  if v_record.id is null then
    raise exception 'Vendor quote result % not found', p_vendor_quote_id;
  end if;

  if v_record.requested_quantity <> p_requested_quantity then
    raise exception 'Vendor quote result % does not match requested quantity %', p_vendor_quote_id, p_requested_quantity;
  end if;

  select organization_id into v_package_org
  from public.published_quote_packages
  where id = p_package_id;

  if p_vendor_quote_offer_id is not null then
    v_source_offer_id := p_vendor_quote_offer_id;
  else
    select offer.id
    into v_source_offer_id
    from public.vendor_quote_offers offer
    where offer.vendor_quote_result_id = p_vendor_quote_id
    order by offer.sort_rank asc, coalesce(offer.total_price_usd, 999999999) asc
    limit 1;
  end if;

  v_label := case p_option_kind
    when 'lowest_cost' then 'Lowest Cost'
    when 'fastest_delivery' then 'Fastest Delivery'
    else 'Balanced'
  end;

  insert into public.published_quote_options (
    package_id,
    organization_id,
    requested_quantity,
    option_kind,
    label,
    published_price_usd,
    lead_time_business_days,
    comparison_summary,
    source_vendor_quote_id,
    source_vendor_quote_offer_id,
    markup_policy_version
  )
  values (
    p_package_id,
    v_package_org,
    p_requested_quantity,
    p_option_kind,
    v_label,
    public.apply_markup(v_record.total_price_usd, p_markup_percent, p_minor_unit),
    v_record.lead_time_business_days,
    format('%s option generated from the internal vendor comparison for qty %s.', v_label, p_requested_quantity),
    v_record.id,
    v_source_offer_id,
    p_markup_version
  )
  on conflict (package_id, requested_quantity, option_kind) do update
    set label = excluded.label,
        published_price_usd = excluded.published_price_usd,
        lead_time_business_days = excluded.lead_time_business_days,
        comparison_summary = excluded.comparison_summary,
        source_vendor_quote_id = excluded.source_vendor_quote_id,
        source_vendor_quote_offer_id = excluded.source_vendor_quote_offer_id,
        markup_policy_version = excluded.markup_policy_version
  returning id into v_option_id;

  return v_option_id;
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
    raise exception 'All parts must have approved requirements before quoting can start.';
  end if;

  insert into public.quote_runs (
    job_id,
    organization_id,
    initiated_by,
    status,
    requested_auto_publish
  )
  values (
    p_job_id,
    v_job.organization_id,
    auth.uid(),
    'queued',
    coalesce(p_auto_publish_requested, false)
  )
  returning id into v_quote_run_id;

  insert into public.vendor_quote_results (
    quote_run_id,
    part_id,
    organization_id,
    vendor,
    requested_quantity,
    status
  )
  select
    v_quote_run_id,
    part.id,
    v_job.organization_id,
    vendor_name,
    requested_quantity,
    'queued'
  from public.parts part
  join public.approved_part_requirements requirement on requirement.part_id = part.id
  cross join lateral unnest(public.normalize_positive_integer_array(requirement.quote_quantities, requirement.quantity))
    as requested_quantity
  cross join lateral unnest(requirement.applicable_vendors) as vendor_name
  where part.job_id = p_job_id
  on conflict (quote_run_id, part_id, vendor, requested_quantity) do nothing;

  insert into public.work_queue (
    organization_id,
    job_id,
    part_id,
    quote_run_id,
    task_type,
    payload
  )
  select
    v_job.organization_id,
    p_job_id,
    result.part_id,
    v_quote_run_id,
    'run_vendor_quote',
    jsonb_build_object(
      'quoteRunId', v_quote_run_id,
      'partId', result.part_id,
      'vendor', result.vendor,
      'vendorQuoteResultId', result.id,
      'requestedQuantity', result.requested_quantity
    )
  from public.vendor_quote_results result
  where result.quote_run_id = v_quote_run_id;

  update public.jobs
  set status = 'quoting'
  where id = p_job_id;

  perform public.log_audit_event(
    v_job.organization_id,
    'job.quote_run_started',
    jsonb_build_object(
      'quoteRunId', v_quote_run_id,
      'autoPublishRequested', coalesce(p_auto_publish_requested, false)
    ),
    p_job_id,
    null
  );

  return v_quote_run_id;
end;
$$;

create or replace function public.api_get_quote_run_readiness(p_quote_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quote_run public.quote_runs%rowtype;
  v_success_count integer := 0;
  v_failed_count integer := 0;
  v_blocking_vendor_states integer := 0;
  v_unapproved_extractions integer := 0;
  v_repair_tasks integer := 0;
  v_prior_requirements_match boolean := false;
  v_ready boolean := false;
  v_expected_quantity_groups integer := 0;
  v_ready_quantity_groups integer := 0;
  v_reasons text[] := array[]::text[];
begin
  select *
  into v_quote_run
  from public.quote_runs
  where id = p_quote_run_id;

  if v_quote_run.id is null then
    raise exception 'Quote run % not found', p_quote_run_id;
  end if;

  if not public.is_internal_user(v_quote_run.organization_id) then
    raise exception 'Only internal users can inspect quote run readiness.';
  end if;

  select count(*)::integer
  into v_success_count
  from public.vendor_quote_results result
  where result.quote_run_id = p_quote_run_id
    and result.status in ('instant_quote_received', 'official_quote_received');

  select count(*)::integer
  into v_failed_count
  from public.vendor_quote_results result
  where result.quote_run_id = p_quote_run_id
    and result.status = 'failed';

  select count(*)::integer
  into v_blocking_vendor_states
  from public.vendor_quote_results result
  where result.quote_run_id = p_quote_run_id
    and result.status in ('manual_review_pending', 'manual_vendor_followup');

  select count(*)::integer
  into v_expected_quantity_groups
  from (
    select part.id, requested_quantity
    from public.parts part
    join public.approved_part_requirements requirement on requirement.part_id = part.id
    cross join lateral unnest(public.normalize_positive_integer_array(requirement.quote_quantities, requirement.quantity))
      as requested_quantity
    where part.job_id = v_quote_run.job_id
  ) groups;

  select count(*)::integer
  into v_ready_quantity_groups
  from (
    select result.part_id, result.requested_quantity
    from public.vendor_quote_results result
    where result.quote_run_id = p_quote_run_id
      and result.status in ('instant_quote_received', 'official_quote_received')
    group by result.part_id, result.requested_quantity
    having count(*) >= 2
  ) groups;

  select count(*)::integer
  into v_unapproved_extractions
  from public.parts part
  left join public.drawing_extractions extraction on extraction.part_id = part.id
  where part.job_id = v_quote_run.job_id
    and part.drawing_file_id is not null
    and coalesce(extraction.status::text, 'needs_review') <> 'approved';

  select count(*)::integer
  into v_repair_tasks
  from public.work_queue queue
  where queue.quote_run_id = p_quote_run_id
    and queue.task_type = 'repair_adapter_candidate'
    and queue.status in ('queued', 'running');

  select coalesce(bool_and(has_prior_match), false)
  into v_prior_requirements_match
  from (
    select exists (
      select 1
      from public.approved_part_requirements previous_requirement
      join public.parts previous_part on previous_part.id = previous_requirement.part_id
      join public.jobs previous_job on previous_job.id = previous_part.job_id
      join public.published_quote_packages previous_package on previous_package.job_id = previous_job.id
      where previous_requirement.organization_id = current_requirement.organization_id
        and previous_requirement.part_id <> current_requirement.part_id
        and coalesce(previous_requirement.part_number, '') = coalesce(current_requirement.part_number, '')
        and coalesce(previous_requirement.revision, '') = coalesce(current_requirement.revision, '')
        and coalesce(previous_requirement.description, '') = coalesce(current_requirement.description, '')
        and previous_requirement.material = current_requirement.material
        and coalesce(previous_requirement.finish, '') = coalesce(current_requirement.finish, '')
        and coalesce(previous_requirement.tightest_tolerance_inch, -1) = coalesce(current_requirement.tightest_tolerance_inch, -1)
        and previous_requirement.quantity = current_requirement.quantity
        and previous_requirement.quote_quantities = current_requirement.quote_quantities
        and coalesce(previous_requirement.requested_by_date::text, '') = coalesce(current_requirement.requested_by_date::text, '')
        and previous_requirement.applicable_vendors = current_requirement.applicable_vendors
    ) as has_prior_match
    from public.approved_part_requirements current_requirement
    join public.parts current_part on current_part.id = current_requirement.part_id
    where current_part.job_id = v_quote_run.job_id
  ) comparison;

  if v_ready_quantity_groups < v_expected_quantity_groups then
    v_reasons := array_append(v_reasons, 'At least two successful vendor quotes are required for each requested quantity.');
  end if;

  if v_failed_count > 0 then
    v_reasons := array_append(v_reasons, 'Failed vendor quotes block auto-publication.');
  end if;

  if v_blocking_vendor_states > 0 then
    v_reasons := array_append(v_reasons, 'Manual review or follow-up vendor states must be resolved first.');
  end if;

  if v_unapproved_extractions > 0 then
    v_reasons := array_append(v_reasons, 'All drawing extractions must be internally approved.');
  end if;

  if v_repair_tasks > 0 then
    v_reasons := array_append(v_reasons, 'Pending adapter repair tasks block auto-publication.');
  end if;

  if not v_prior_requirements_match then
    v_reasons := array_append(v_reasons, 'Auto-publication requires a prior published package with unchanged approved requirements.');
  end if;

  v_ready :=
    v_expected_quantity_groups > 0
    and v_ready_quantity_groups = v_expected_quantity_groups
    and v_failed_count = 0
    and v_blocking_vendor_states = 0
    and v_unapproved_extractions = 0
    and v_repair_tasks = 0
    and v_prior_requirements_match;

  return jsonb_build_object(
    'ready', v_ready,
    'successfulVendorQuotes', v_success_count,
    'failedVendorQuotes', v_failed_count,
    'blockingVendorStates', v_blocking_vendor_states,
    'unapprovedExtractions', v_unapproved_extractions,
    'repairTasks', v_repair_tasks,
    'priorRequirementsMatch', v_prior_requirements_match,
    'reasons', to_jsonb(v_reasons)
  );
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
  v_requested_quantity integer;
  v_seen uuid[];
  v_is_ready boolean := false;
  v_has_any_options boolean := false;
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

  for v_requested_quantity in
    select distinct result.requested_quantity
    from public.vendor_quote_results result
    where result.quote_run_id = p_quote_run_id
      and result.status in ('instant_quote_received', 'official_quote_received')
      and result.total_price_usd is not null
    order by result.requested_quantity
  loop
    v_seen := array[]::uuid[];
    v_lowest_id := null;
    v_fastest_id := null;
    v_balanced_id := null;
    v_fastest_days := null;

    select result.id
    into v_lowest_id
    from public.vendor_quote_results result
    where result.quote_run_id = p_quote_run_id
      and result.requested_quantity = v_requested_quantity
      and result.status in ('instant_quote_received', 'official_quote_received')
      and result.total_price_usd is not null
    order by result.total_price_usd asc, coalesce(result.lead_time_business_days, 999999) asc
    limit 1;

    select result.id, result.lead_time_business_days
    into v_fastest_id, v_fastest_days
    from public.vendor_quote_results result
    where result.quote_run_id = p_quote_run_id
      and result.requested_quantity = v_requested_quantity
      and result.status in ('instant_quote_received', 'official_quote_received')
      and result.total_price_usd is not null
    order by coalesce(result.lead_time_business_days, 999999) asc, result.total_price_usd asc
    limit 1;

    select result.id
    into v_balanced_id
    from public.vendor_quote_results result
    where result.quote_run_id = p_quote_run_id
      and result.requested_quantity = v_requested_quantity
      and result.status in ('instant_quote_received', 'official_quote_received')
      and result.total_price_usd is not null
      and (
        v_fastest_days is null
        or result.lead_time_business_days is null
        or result.lead_time_business_days <= v_fastest_days + 2
      )
    order by result.total_price_usd asc, coalesce(result.lead_time_business_days, 999999) asc
    limit 1;

    if v_lowest_id is not null and not (v_lowest_id = any(v_seen)) then
      perform public.insert_published_quote_option(
        v_package_id,
        'lowest_cost',
        v_lowest_id,
        v_requested_quantity,
        v_pricing_policy.markup_percent,
        v_pricing_policy.currency_minor_unit,
        v_pricing_policy.version
      );
      v_seen := array_append(v_seen, v_lowest_id);
      v_has_any_options := true;
    end if;

    if v_fastest_id is not null and not (v_fastest_id = any(v_seen)) then
      perform public.insert_published_quote_option(
        v_package_id,
        'fastest_delivery',
        v_fastest_id,
        v_requested_quantity,
        v_pricing_policy.markup_percent,
        v_pricing_policy.currency_minor_unit,
        v_pricing_policy.version
      );
      v_seen := array_append(v_seen, v_fastest_id);
      v_has_any_options := true;
    end if;

    if v_balanced_id is not null and not (v_balanced_id = any(v_seen)) then
      perform public.insert_published_quote_option(
        v_package_id,
        'balanced',
        v_balanced_id,
        v_requested_quantity,
        v_pricing_policy.markup_percent,
        v_pricing_policy.currency_minor_unit,
        v_pricing_policy.version
      );
      v_has_any_options := true;
    end if;
  end loop;

  if not v_has_any_options then
    raise exception 'No successful vendor quotes are available to publish.';
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

create or replace function public.api_record_manual_vendor_quote(
  p_job_id uuid,
  p_part_id uuid,
  p_vendor public.vendor_name,
  p_status public.vendor_status default 'official_quote_received',
  p_summary_note text default null,
  p_source_text text default null,
  p_quote_url text default null,
  p_offers jsonb default '[]'::jsonb,
  p_artifacts jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.jobs%rowtype;
  v_part public.parts%rowtype;
  v_quote_run public.quote_runs%rowtype;
  v_result public.vendor_quote_results%rowtype;
  v_offer jsonb;
  v_artifact jsonb;
  v_summary_offer jsonb;
  v_summary_total numeric;
  v_summary_unit numeric;
  v_summary_lead integer;
  v_offer_id uuid;
  v_created_new_quote_run boolean := false;
  v_sort_rank integer := 0;
  v_has_pending boolean := false;
  v_has_manual boolean := false;
  v_has_success boolean := false;
  v_supplier text;
  v_requested_quantity integer := 1;
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
    raise exception 'Only internal users can record manual vendor quotes.';
  end if;

  select *
  into v_part
  from public.parts
  where id = p_part_id
    and job_id = p_job_id;

  if v_part.id is null then
    raise exception 'Part % does not belong to job %', p_part_id, p_job_id;
  end if;

  if jsonb_typeof(coalesce(p_offers, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_offers, '[]'::jsonb)) = 0 then
    raise exception 'At least one offer lane is required for manual quote intake.';
  end if;

  select quote_run.*
  into v_quote_run
  from public.quote_runs quote_run
  left join public.published_quote_packages package
    on package.quote_run_id = quote_run.id
  where quote_run.job_id = p_job_id
    and package.id is null
  order by quote_run.created_at desc
  limit 1;

  if v_quote_run.id is null then
    insert into public.quote_runs (
      job_id,
      organization_id,
      initiated_by,
      status,
      requested_auto_publish
    )
    values (
      p_job_id,
      v_job.organization_id,
      auth.uid(),
      'completed',
      false
    )
    returning * into v_quote_run;

    v_created_new_quote_run := true;
  end if;

  select offer
  into v_summary_offer
  from jsonb_array_elements(p_offers) offer
  order by
    coalesce(nullif(offer ->> 'totalPriceUsd', '')::numeric, 999999999),
    coalesce(nullif(offer ->> 'leadTimeBusinessDays', '')::integer, 999999)
  limit 1;

  if v_summary_offer is null then
    raise exception 'Unable to determine a summary offer for manual quote intake.';
  end if;

  v_summary_total := nullif(v_summary_offer ->> 'totalPriceUsd', '')::numeric;
  v_summary_unit := nullif(v_summary_offer ->> 'unitPriceUsd', '')::numeric;
  v_summary_lead := nullif(v_summary_offer ->> 'leadTimeBusinessDays', '')::integer;
  v_requested_quantity := greatest(
    coalesce(nullif(v_summary_offer ->> 'requestedQuantity', '')::integer, v_part.quantity, 1),
    1
  );
  v_supplier := case
    when p_vendor = 'sendcutsend' then 'SendCutSend'
    when p_vendor = 'protolabs' then 'Protolabs'
    when p_vendor = 'partsbadger' then 'PartsBadger'
    when p_vendor = 'fastdms' then 'FastDMS'
    else initcap(p_vendor::text)
  end;

  insert into public.vendor_quote_results (
    quote_run_id,
    part_id,
    organization_id,
    vendor,
    requested_quantity,
    status,
    unit_price_usd,
    total_price_usd,
    lead_time_business_days,
    quote_url,
    dfm_issues,
    notes,
    raw_payload
  )
  values (
    v_quote_run.id,
    p_part_id,
    v_job.organization_id,
    p_vendor,
    v_requested_quantity,
    p_status,
    v_summary_unit,
    v_summary_total,
    v_summary_lead,
    p_quote_url,
    '[]'::jsonb,
    to_jsonb(
      array_remove(
        array[
          'Recorded through manual quote intake.',
          nullif(trim(coalesce(p_summary_note, '')), '')
        ],
        null
      )
    ),
    jsonb_build_object(
      'source', 'manual-quote-intake',
      'sourceText', p_source_text,
      'summaryOfferKey', coalesce(nullif(v_summary_offer ->> 'offerId', ''), 'offer-0'),
      'offerCount', jsonb_array_length(p_offers),
      'requestedQuantity', v_requested_quantity
    )
  )
  on conflict (quote_run_id, part_id, vendor, requested_quantity) do update
    set status = excluded.status,
        unit_price_usd = excluded.unit_price_usd,
        total_price_usd = excluded.total_price_usd,
        lead_time_business_days = excluded.lead_time_business_days,
        quote_url = excluded.quote_url,
        dfm_issues = excluded.dfm_issues,
        notes = excluded.notes,
        raw_payload = excluded.raw_payload,
        updated_at = timezone('utc', now())
  returning * into v_result;

  delete from public.vendor_quote_offers
  where vendor_quote_result_id = v_result.id;

  for v_offer in
    select value
    from jsonb_array_elements(p_offers)
  loop
    insert into public.vendor_quote_offers (
      vendor_quote_result_id,
      organization_id,
      offer_key,
      supplier,
      lane_label,
      sourcing,
      tier,
      quote_ref,
      quote_date,
      unit_price_usd,
      total_price_usd,
      lead_time_business_days,
      ship_receive_by,
      due_date,
      process,
      material,
      finish,
      tightest_tolerance,
      tolerance_source,
      thread_callouts,
      thread_match_notes,
      notes,
      sort_rank,
      raw_payload
    )
    values (
      v_result.id,
      v_job.organization_id,
      coalesce(nullif(v_offer ->> 'offerId', ''), format('offer-%s', v_sort_rank)),
      coalesce(nullif(v_offer ->> 'supplier', ''), v_supplier),
      coalesce(
        nullif(v_offer ->> 'laneLabel', ''),
        nullif(concat_ws(' / ', nullif(v_offer ->> 'sourcing', ''), nullif(v_offer ->> 'tier', '')), ''),
        coalesce(nullif(v_offer ->> 'supplier', ''), v_supplier)
      ),
      nullif(v_offer ->> 'sourcing', ''),
      nullif(v_offer ->> 'tier', ''),
      nullif(v_offer ->> 'quoteRef', ''),
      case
        when nullif(v_offer ->> 'quoteDateIso', '') ~ '^\d{4}-\d{2}-\d{2}$' then (v_offer ->> 'quoteDateIso')::date
        else null
      end,
      nullif(v_offer ->> 'unitPriceUsd', '')::numeric,
      nullif(v_offer ->> 'totalPriceUsd', '')::numeric,
      nullif(v_offer ->> 'leadTimeBusinessDays', '')::integer,
      nullif(v_offer ->> 'shipReceiveBy', ''),
      nullif(v_offer ->> 'dueDate', ''),
      nullif(v_offer ->> 'process', ''),
      nullif(v_offer ->> 'material', ''),
      nullif(v_offer ->> 'finish', ''),
      nullif(v_offer ->> 'tightestTolerance', ''),
      nullif(v_offer ->> 'toleranceSource', ''),
      nullif(v_offer ->> 'threadCallouts', ''),
      nullif(v_offer ->> 'threadMatchNotes', ''),
      nullif(v_offer ->> 'notes', ''),
      v_sort_rank,
      v_offer
    )
    returning id into v_offer_id;

    if v_sort_rank = 0 then
      update public.published_quote_options
      set source_vendor_quote_offer_id = v_offer_id
      where source_vendor_quote_id = v_result.id
        and requested_quantity = v_requested_quantity
        and source_vendor_quote_offer_id is null;
    end if;

    v_sort_rank := v_sort_rank + 1;
  end loop;

  insert into public.vendor_quote_artifacts (
    vendor_quote_result_id,
    organization_id,
    artifact_type,
    storage_bucket,
    storage_path,
    metadata
  )
  select
    v_result.id,
    v_job.organization_id,
    coalesce(nullif(artifact ->> 'artifactType', ''), 'uploaded_evidence'),
    coalesce(nullif(artifact ->> 'storageBucket', ''), 'quote-artifacts'),
    artifact ->> 'storagePath',
    coalesce(artifact -> 'metadata', '{}'::jsonb)
  from jsonb_array_elements(coalesce(p_artifacts, '[]'::jsonb)) artifact
  where nullif(artifact ->> 'storagePath', '') is not null
  on conflict (storage_path) do update
    set metadata = excluded.metadata;

  select
    bool_or(status in ('queued', 'running')),
    bool_or(status in ('manual_review_pending', 'manual_vendor_followup')),
    bool_or(status in ('instant_quote_received', 'official_quote_received'))
  into
    v_has_pending,
    v_has_manual,
    v_has_success
  from public.vendor_quote_results
  where quote_run_id = v_quote_run.id;

  update public.quote_runs
  set status = case
    when coalesce(v_has_pending, false) then 'running'
    when coalesce(v_has_success, false) or coalesce(v_has_manual, false) then 'completed'
    else 'failed'
  end
  where id = v_quote_run.id;

  update public.jobs
  set status = case
    when coalesce(v_has_pending, false) then 'quoting'
    when coalesce(v_has_manual, false) then 'awaiting_vendor_manual_review'
    when coalesce(v_has_success, false) then 'internal_review'
    else 'quoting'
  end
  where id = p_job_id;

  perform public.log_audit_event(
    v_job.organization_id,
    'job.manual_vendor_quote_recorded',
    jsonb_build_object(
      'partId', p_part_id,
      'vendor', p_vendor,
      'quoteRunId', v_quote_run.id,
      'vendorQuoteResultId', v_result.id,
      'requestedQuantity', v_requested_quantity,
      'createdNewQuoteRun', v_created_new_quote_run
    ),
    p_job_id,
    null
  );

  return jsonb_build_object(
    'quoteRunId', v_quote_run.id,
    'vendorQuoteResultId', v_result.id,
    'createdNewQuoteRun', v_created_new_quote_run
  );
end;
$$;

grant execute on function public.api_create_job(
  uuid,
  text,
  text,
  text,
  text[],
  integer[],
  date
) to authenticated;

grant execute on function public.api_create_client_draft(
  text,
  text,
  uuid,
  text[],
  integer[],
  date
) to authenticated;
