create extension if not exists pgcrypto;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'app_role') then
    create type public.app_role as enum ('client', 'internal_estimator', 'internal_admin');
  end if;

  if not exists (select 1 from pg_type where typname = 'job_status') then
    create type public.job_status as enum (
      'uploaded',
      'extracting',
      'needs_spec_review',
      'ready_to_quote',
      'quoting',
      'awaiting_vendor_manual_review',
      'internal_review',
      'published',
      'client_selected',
      'closed'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'vendor_name') then
    create type public.vendor_name as enum ('xometry', 'fictiv', 'protolabs', 'sendcutsend');
  end if;

  if not exists (select 1 from pg_type where typname = 'vendor_status') then
    create type public.vendor_status as enum (
      'queued',
      'running',
      'instant_quote_received',
      'official_quote_received',
      'manual_review_pending',
      'manual_vendor_followup',
      'failed',
      'stale'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'client_option_kind') then
    create type public.client_option_kind as enum ('lowest_cost', 'fastest_delivery', 'balanced');
  end if;

  if not exists (select 1 from pg_type where typname = 'job_file_kind') then
    create type public.job_file_kind as enum ('cad', 'drawing', 'artifact', 'other');
  end if;

  if not exists (select 1 from pg_type where typname = 'extraction_status') then
    create type public.extraction_status as enum ('needs_review', 'approved');
  end if;

  if not exists (select 1 from pg_type where typname = 'quote_run_status') then
    create type public.quote_run_status as enum ('queued', 'running', 'completed', 'failed', 'published');
  end if;

  if not exists (select 1 from pg_type where typname = 'queue_task_type') then
    create type public.queue_task_type as enum (
      'extract_part',
      'run_vendor_quote',
      'poll_vendor_quote',
      'publish_package',
      'repair_adapter_candidate'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'queue_task_status') then
    create type public.queue_task_status as enum ('queued', 'running', 'completed', 'failed', 'cancelled');
  end if;
end
$$;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

create or replace function public.normalize_file_basename(input_name text)
returns text
language sql
immutable
as $$
  select trim(
    both '-'
    from regexp_replace(
      lower(regexp_replace(coalesce(input_name, ''), '\.[^.]+$', '')),
      '[^a-z0-9]+',
      '-',
      'g'
    )
  );
$$;

create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.organization_memberships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.app_role not null,
  created_at timestamptz not null default timezone('utc', now()),
  unique (organization_id, user_id)
);

create table if not exists public.pricing_policies (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete cascade,
  version text not null,
  markup_percent numeric(8, 4) not null default 20.0,
  currency_minor_unit numeric(10, 4) not null default 0.01,
  is_active boolean not null default true,
  notes text,
  created_at timestamptz not null default timezone('utc', now()),
  unique (organization_id, version)
);

create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete restrict,
  title text not null,
  description text,
  status public.job_status not null default 'uploaded',
  source text not null default 'client',
  active_pricing_policy_id uuid references public.pricing_policies(id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.job_files (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  uploaded_by uuid not null references auth.users(id) on delete restrict,
  storage_bucket text not null default 'job-files',
  storage_path text not null unique,
  original_name text not null,
  normalized_name text not null,
  file_kind public.job_file_kind not null,
  mime_type text,
  size_bytes bigint,
  matched_part_key text,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.parts (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  normalized_key text not null,
  cad_file_id uuid references public.job_files(id) on delete set null,
  drawing_file_id uuid references public.job_files(id) on delete set null,
  quantity integer not null default 1,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (job_id, normalized_key)
);

create table if not exists public.drawing_extractions (
  id uuid primary key default gen_random_uuid(),
  part_id uuid not null unique references public.parts(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  extractor_version text not null default 'v1',
  extraction jsonb not null default '{}'::jsonb,
  confidence numeric(6, 4),
  warnings jsonb not null default '[]'::jsonb,
  evidence jsonb not null default '[]'::jsonb,
  status public.extraction_status not null default 'needs_review',
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.approved_part_requirements (
  id uuid primary key default gen_random_uuid(),
  part_id uuid not null unique references public.parts(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  approved_by uuid not null references auth.users(id) on delete restrict,
  description text,
  part_number text,
  revision text,
  material text not null,
  finish text,
  tightest_tolerance_inch numeric(10, 4),
  quantity integer not null default 1,
  applicable_vendors public.vendor_name[] not null default array[]::public.vendor_name[],
  spec_snapshot jsonb not null default '{}'::jsonb,
  approved_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.quote_runs (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  initiated_by uuid not null references auth.users(id) on delete restrict,
  status public.quote_run_status not null default 'queued',
  requested_auto_publish boolean not null default false,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.vendor_quote_results (
  id uuid primary key default gen_random_uuid(),
  quote_run_id uuid not null references public.quote_runs(id) on delete cascade,
  part_id uuid not null references public.parts(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  vendor public.vendor_name not null,
  status public.vendor_status not null default 'queued',
  unit_price_usd numeric(12, 2),
  total_price_usd numeric(12, 2),
  lead_time_business_days integer,
  quote_url text,
  dfm_issues jsonb not null default '[]'::jsonb,
  notes jsonb not null default '[]'::jsonb,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (quote_run_id, part_id, vendor)
);

create table if not exists public.vendor_quote_artifacts (
  id uuid primary key default gen_random_uuid(),
  vendor_quote_result_id uuid not null references public.vendor_quote_results(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  artifact_type text not null,
  storage_bucket text not null default 'quote-artifacts',
  storage_path text not null unique,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.published_quote_packages (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  quote_run_id uuid not null unique references public.quote_runs(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  published_by uuid not null references auth.users(id) on delete restrict,
  pricing_policy_id uuid not null references public.pricing_policies(id) on delete restrict,
  auto_published boolean not null default false,
  client_summary text,
  created_at timestamptz not null default timezone('utc', now()),
  published_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.published_quote_options (
  id uuid primary key default gen_random_uuid(),
  package_id uuid not null references public.published_quote_packages(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  option_kind public.client_option_kind not null,
  label text not null,
  published_price_usd numeric(12, 2) not null,
  lead_time_business_days integer,
  comparison_summary text,
  source_vendor_quote_id uuid not null references public.vendor_quote_results(id) on delete restrict,
  markup_policy_version text not null,
  created_at timestamptz not null default timezone('utc', now()),
  unique (package_id, option_kind)
);

create table if not exists public.client_selections (
  id uuid primary key default gen_random_uuid(),
  package_id uuid not null references public.published_quote_packages(id) on delete cascade,
  option_id uuid not null references public.published_quote_options(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  selected_by uuid not null references auth.users(id) on delete restrict,
  note text,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.audit_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,
  job_id uuid references public.jobs(id) on delete set null,
  package_id uuid references public.published_quote_packages(id) on delete set null,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.work_queue (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  job_id uuid references public.jobs(id) on delete cascade,
  part_id uuid references public.parts(id) on delete cascade,
  quote_run_id uuid references public.quote_runs(id) on delete cascade,
  package_id uuid references public.published_quote_packages(id) on delete cascade,
  task_type public.queue_task_type not null,
  status public.queue_task_status not null default 'queued',
  payload jsonb not null default '{}'::jsonb,
  attempts integer not null default 0,
  available_at timestamptz not null default timezone('utc', now()),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_memberships_user on public.organization_memberships(user_id);
create index if not exists idx_jobs_org on public.jobs(organization_id, status, created_at desc);
create index if not exists idx_job_files_job on public.job_files(job_id, file_kind, normalized_name);
create index if not exists idx_parts_job on public.parts(job_id);
create index if not exists idx_extractions_org on public.drawing_extractions(organization_id, status);
create index if not exists idx_requirements_org on public.approved_part_requirements(organization_id, part_number, revision);
create index if not exists idx_quote_runs_job on public.quote_runs(job_id, created_at desc);
create index if not exists idx_vendor_quotes_run on public.vendor_quote_results(quote_run_id, vendor, status);
create index if not exists idx_packages_org on public.published_quote_packages(organization_id, published_at desc);
create index if not exists idx_work_queue_dispatch on public.work_queue(status, task_type, available_at);

drop trigger if exists touch_organizations_updated_at on public.organizations;
create trigger touch_organizations_updated_at
before update on public.organizations
for each row execute function public.touch_updated_at();

drop trigger if exists touch_jobs_updated_at on public.jobs;
create trigger touch_jobs_updated_at
before update on public.jobs
for each row execute function public.touch_updated_at();

drop trigger if exists touch_parts_updated_at on public.parts;
create trigger touch_parts_updated_at
before update on public.parts
for each row execute function public.touch_updated_at();

drop trigger if exists touch_drawing_extractions_updated_at on public.drawing_extractions;
create trigger touch_drawing_extractions_updated_at
before update on public.drawing_extractions
for each row execute function public.touch_updated_at();

drop trigger if exists touch_approved_part_requirements_updated_at on public.approved_part_requirements;
create trigger touch_approved_part_requirements_updated_at
before update on public.approved_part_requirements
for each row execute function public.touch_updated_at();

drop trigger if exists touch_quote_runs_updated_at on public.quote_runs;
create trigger touch_quote_runs_updated_at
before update on public.quote_runs
for each row execute function public.touch_updated_at();

drop trigger if exists touch_vendor_quote_results_updated_at on public.vendor_quote_results;
create trigger touch_vendor_quote_results_updated_at
before update on public.vendor_quote_results
for each row execute function public.touch_updated_at();

drop trigger if exists touch_work_queue_updated_at on public.work_queue;
create trigger touch_work_queue_updated_at
before update on public.work_queue
for each row execute function public.touch_updated_at();

create or replace function public.user_can_access_org(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.organization_memberships membership
    where membership.organization_id = p_organization_id
      and membership.user_id = auth.uid()
  );
$$;

create or replace function public.is_internal_user(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.organization_memberships membership
    where membership.organization_id = p_organization_id
      and membership.user_id = auth.uid()
      and membership.role in ('internal_estimator', 'internal_admin')
  );
$$;

create or replace function public.to_vendor_name_array(payload jsonb)
returns public.vendor_name[]
language sql
immutable
as $$
  select coalesce(
    array_agg(value::public.vendor_name order by value::text),
    array[]::public.vendor_name[]
  )
  from jsonb_array_elements_text(coalesce(payload, '[]'::jsonb)) as value;
$$;

create or replace function public.log_audit_event(
  p_organization_id uuid,
  p_event_type text,
  p_payload jsonb default '{}'::jsonb,
  p_job_id uuid default null,
  p_package_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event_id uuid;
begin
  insert into public.audit_events (
    organization_id,
    actor_user_id,
    job_id,
    package_id,
    event_type,
    payload
  )
  values (
    p_organization_id,
    auth.uid(),
    p_job_id,
    p_package_id,
    p_event_type,
    coalesce(p_payload, '{}'::jsonb)
  )
  returning id into v_event_id;

  return v_event_id;
end;
$$;

create or replace function public.get_active_pricing_policy_id(p_organization_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select policy.id
  from public.pricing_policies policy
  where policy.is_active
    and (policy.organization_id = p_organization_id or policy.organization_id is null)
  order by
    case when policy.organization_id = p_organization_id then 0 else 1 end,
    policy.created_at desc
  limit 1;
$$;

create or replace function public.apply_markup(
  p_raw_amount numeric,
  p_markup_percent numeric,
  p_minor_unit numeric
)
returns numeric
language sql
immutable
as $$
  select round(
    ceil(((coalesce(p_raw_amount, 0) * (1 + (coalesce(p_markup_percent, 0) / 100))) / greatest(coalesce(p_minor_unit, 0.01), 0.0001)))
    * greatest(coalesce(p_minor_unit, 0.01), 0.0001),
    2
  );
$$;

create or replace function public.insert_published_quote_option(
  p_package_id uuid,
  p_option_kind public.client_option_kind,
  p_vendor_quote_id uuid,
  p_markup_percent numeric,
  p_minor_unit numeric,
  p_markup_version text
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
begin
  select *
  into v_record
  from public.vendor_quote_results
  where id = p_vendor_quote_id;

  if v_record.id is null then
    raise exception 'Vendor quote result % not found', p_vendor_quote_id;
  end if;

  select organization_id into v_package_org
  from public.published_quote_packages
  where id = p_package_id;

  v_label := case p_option_kind
    when 'lowest_cost' then 'Lowest Cost'
    when 'fastest_delivery' then 'Fastest Delivery'
    else 'Balanced'
  end;

  insert into public.published_quote_options (
    package_id,
    organization_id,
    option_kind,
    label,
    published_price_usd,
    lead_time_business_days,
    comparison_summary,
    source_vendor_quote_id,
    markup_policy_version
  )
  values (
    p_package_id,
    v_package_org,
    p_option_kind,
    v_label,
    public.apply_markup(v_record.total_price_usd, p_markup_percent, p_minor_unit),
    v_record.lead_time_business_days,
    format('%s option generated from the internal vendor comparison.', v_label),
    v_record.id,
    p_markup_version
  )
  on conflict (package_id, option_kind) do update
    set label = excluded.label,
        published_price_usd = excluded.published_price_usd,
        lead_time_business_days = excluded.lead_time_business_days,
        comparison_summary = excluded.comparison_summary,
        source_vendor_quote_id = excluded.source_vendor_quote_id,
        markup_policy_version = excluded.markup_policy_version
  returning id into v_option_id;

  return v_option_id;
end;
$$;

alter table public.organizations enable row level security;
alter table public.organization_memberships enable row level security;
alter table public.pricing_policies enable row level security;
alter table public.jobs enable row level security;
alter table public.job_files enable row level security;
alter table public.parts enable row level security;
alter table public.drawing_extractions enable row level security;
alter table public.approved_part_requirements enable row level security;
alter table public.quote_runs enable row level security;
alter table public.vendor_quote_results enable row level security;
alter table public.vendor_quote_artifacts enable row level security;
alter table public.published_quote_packages enable row level security;
alter table public.published_quote_options enable row level security;
alter table public.client_selections enable row level security;
alter table public.audit_events enable row level security;
alter table public.work_queue enable row level security;

drop policy if exists "organizations_select_members" on public.organizations;
create policy "organizations_select_members"
on public.organizations
for select
to authenticated
using (public.user_can_access_org(id));

drop policy if exists "organizations_manage_internal_admins" on public.organizations;
create policy "organizations_manage_internal_admins"
on public.organizations
for all
to authenticated
using (public.is_internal_user(id))
with check (public.is_internal_user(id));

drop policy if exists "memberships_select_own_or_admin" on public.organization_memberships;
create policy "memberships_select_own_or_admin"
on public.organization_memberships
for select
to authenticated
using (user_id = auth.uid() or public.is_internal_user(organization_id));

drop policy if exists "memberships_manage_internal_admins" on public.organization_memberships;
create policy "memberships_manage_internal_admins"
on public.organization_memberships
for all
to authenticated
using (public.is_internal_user(organization_id))
with check (public.is_internal_user(organization_id));

drop policy if exists "pricing_policies_internal_only" on public.pricing_policies;
create policy "pricing_policies_internal_only"
on public.pricing_policies
for select
to authenticated
using (
  exists (
    select 1
    from public.organization_memberships membership
    where membership.user_id = auth.uid()
      and membership.role in ('internal_estimator', 'internal_admin')
      and (
        public.pricing_policies.organization_id is null
        or membership.organization_id = public.pricing_policies.organization_id
      )
  )
);

drop policy if exists "pricing_policies_manage_internal_admins" on public.pricing_policies;
create policy "pricing_policies_manage_internal_admins"
on public.pricing_policies
for all
to authenticated
using (
  exists (
    select 1
    from public.organization_memberships membership
    where membership.user_id = auth.uid()
      and membership.role in ('internal_estimator', 'internal_admin')
      and (
        public.pricing_policies.organization_id is null
        or membership.organization_id = public.pricing_policies.organization_id
      )
  )
)
with check (
  exists (
    select 1
    from public.organization_memberships membership
    where membership.user_id = auth.uid()
      and membership.role in ('internal_estimator', 'internal_admin')
      and (
        public.pricing_policies.organization_id is null
        or membership.organization_id = public.pricing_policies.organization_id
      )
  )
);

drop policy if exists "jobs_select_members" on public.jobs;
create policy "jobs_select_members"
on public.jobs
for select
to authenticated
using (public.user_can_access_org(organization_id));

drop policy if exists "jobs_insert_members" on public.jobs;
create policy "jobs_insert_members"
on public.jobs
for insert
to authenticated
with check (public.user_can_access_org(organization_id));

drop policy if exists "jobs_update_internal" on public.jobs;
create policy "jobs_update_internal"
on public.jobs
for update
to authenticated
using (public.is_internal_user(organization_id))
with check (public.is_internal_user(organization_id));

drop policy if exists "job_files_select_members" on public.job_files;
create policy "job_files_select_members"
on public.job_files
for select
to authenticated
using (public.user_can_access_org(organization_id));

drop policy if exists "job_files_insert_members" on public.job_files;
create policy "job_files_insert_members"
on public.job_files
for insert
to authenticated
with check (public.user_can_access_org(organization_id));

drop policy if exists "job_files_update_internal" on public.job_files;
create policy "job_files_update_internal"
on public.job_files
for update
to authenticated
using (public.is_internal_user(organization_id))
with check (public.is_internal_user(organization_id));

drop policy if exists "job_files_delete_internal" on public.job_files;
create policy "job_files_delete_internal"
on public.job_files
for delete
to authenticated
using (public.is_internal_user(organization_id));

drop policy if exists "parts_select_members" on public.parts;
create policy "parts_select_members"
on public.parts
for select
to authenticated
using (public.user_can_access_org(organization_id));

drop policy if exists "parts_manage_internal" on public.parts;
create policy "parts_manage_internal"
on public.parts
for all
to authenticated
using (public.is_internal_user(organization_id))
with check (public.is_internal_user(organization_id));

drop policy if exists "drawing_extractions_internal_only" on public.drawing_extractions;
create policy "drawing_extractions_internal_only"
on public.drawing_extractions
for select
to authenticated
using (public.is_internal_user(organization_id));

drop policy if exists "drawing_extractions_manage_internal" on public.drawing_extractions;
create policy "drawing_extractions_manage_internal"
on public.drawing_extractions
for all
to authenticated
using (public.is_internal_user(organization_id))
with check (public.is_internal_user(organization_id));

drop policy if exists "approved_requirements_internal_only" on public.approved_part_requirements;
create policy "approved_requirements_internal_only"
on public.approved_part_requirements
for select
to authenticated
using (public.is_internal_user(organization_id));

drop policy if exists "approved_requirements_manage_internal" on public.approved_part_requirements;
create policy "approved_requirements_manage_internal"
on public.approved_part_requirements
for all
to authenticated
using (public.is_internal_user(organization_id))
with check (public.is_internal_user(organization_id));

drop policy if exists "quote_runs_internal_only" on public.quote_runs;
create policy "quote_runs_internal_only"
on public.quote_runs
for select
to authenticated
using (public.is_internal_user(organization_id));

drop policy if exists "quote_runs_manage_internal" on public.quote_runs;
create policy "quote_runs_manage_internal"
on public.quote_runs
for all
to authenticated
using (public.is_internal_user(organization_id))
with check (public.is_internal_user(organization_id));

drop policy if exists "vendor_quote_results_internal_only" on public.vendor_quote_results;
create policy "vendor_quote_results_internal_only"
on public.vendor_quote_results
for select
to authenticated
using (public.is_internal_user(organization_id));

drop policy if exists "vendor_quote_results_manage_internal" on public.vendor_quote_results;
create policy "vendor_quote_results_manage_internal"
on public.vendor_quote_results
for all
to authenticated
using (public.is_internal_user(organization_id))
with check (public.is_internal_user(organization_id));

drop policy if exists "vendor_quote_artifacts_internal_only" on public.vendor_quote_artifacts;
create policy "vendor_quote_artifacts_internal_only"
on public.vendor_quote_artifacts
for select
to authenticated
using (public.is_internal_user(organization_id));

drop policy if exists "vendor_quote_artifacts_manage_internal" on public.vendor_quote_artifacts;
create policy "vendor_quote_artifacts_manage_internal"
on public.vendor_quote_artifacts
for all
to authenticated
using (public.is_internal_user(organization_id))
with check (public.is_internal_user(organization_id));

drop policy if exists "packages_select_members" on public.published_quote_packages;
create policy "packages_select_members"
on public.published_quote_packages
for select
to authenticated
using (public.user_can_access_org(organization_id));

drop policy if exists "packages_manage_internal" on public.published_quote_packages;
create policy "packages_manage_internal"
on public.published_quote_packages
for all
to authenticated
using (public.is_internal_user(organization_id))
with check (public.is_internal_user(organization_id));

drop policy if exists "package_options_select_members" on public.published_quote_options;
create policy "package_options_select_members"
on public.published_quote_options
for select
to authenticated
using (public.user_can_access_org(organization_id));

drop policy if exists "package_options_manage_internal" on public.published_quote_options;
create policy "package_options_manage_internal"
on public.published_quote_options
for all
to authenticated
using (public.is_internal_user(organization_id))
with check (public.is_internal_user(organization_id));

drop policy if exists "client_selections_select_members" on public.client_selections;
create policy "client_selections_select_members"
on public.client_selections
for select
to authenticated
using (public.user_can_access_org(organization_id));

drop policy if exists "client_selections_insert_members" on public.client_selections;
create policy "client_selections_insert_members"
on public.client_selections
for insert
to authenticated
with check (
  public.user_can_access_org(organization_id)
  and selected_by = auth.uid()
);

drop policy if exists "audit_events_internal_only" on public.audit_events;
create policy "audit_events_internal_only"
on public.audit_events
for select
to authenticated
using (public.is_internal_user(organization_id));

drop policy if exists "audit_events_manage_internal" on public.audit_events;
create policy "audit_events_manage_internal"
on public.audit_events
for all
to authenticated
using (public.is_internal_user(organization_id))
with check (public.is_internal_user(organization_id));

drop policy if exists "work_queue_internal_only" on public.work_queue;
create policy "work_queue_internal_only"
on public.work_queue
for select
to authenticated
using (public.is_internal_user(organization_id));

drop policy if exists "work_queue_manage_internal" on public.work_queue;
create policy "work_queue_manage_internal"
on public.work_queue
for all
to authenticated
using (public.is_internal_user(organization_id))
with check (public.is_internal_user(organization_id));

insert into storage.buckets (id, name, public)
select 'job-files', 'job-files', false
where not exists (
  select 1 from storage.buckets where id = 'job-files'
);

insert into storage.buckets (id, name, public)
select 'quote-artifacts', 'quote-artifacts', false
where not exists (
  select 1 from storage.buckets where id = 'quote-artifacts'
);

drop policy if exists "job_files_storage_insert" on storage.objects;
create policy "job_files_storage_insert"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'job-files'
  and exists (
    select 1
    from public.jobs job
    where job.id::text = split_part(name, '/', 1)
      and public.user_can_access_org(job.organization_id)
  )
);

drop policy if exists "job_files_storage_read" on storage.objects;
create policy "job_files_storage_read"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'job-files'
  and exists (
    select 1
    from public.job_files file
    where file.storage_path = name
      and public.user_can_access_org(file.organization_id)
  )
);

drop policy if exists "job_files_storage_delete_internal" on storage.objects;
create policy "job_files_storage_delete_internal"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'job-files'
  and exists (
    select 1
    from public.job_files file
    where file.storage_path = name
      and public.is_internal_user(file.organization_id)
  )
);

drop policy if exists "quote_artifacts_storage_read_internal" on storage.objects;
create policy "quote_artifacts_storage_read_internal"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'quote-artifacts'
  and exists (
    select 1
    from public.vendor_quote_artifacts artifact
    where artifact.storage_path = name
      and public.is_internal_user(artifact.organization_id)
  )
);

insert into public.pricing_policies (
  organization_id,
  version,
  markup_percent,
  currency_minor_unit,
  is_active,
  notes
)
select
  null,
  'v1_markup_20',
  20.0,
  0.01,
  true,
  'Default flat markup for curated CNC quote packages.'
where not exists (
  select 1
  from public.pricing_policies
  where organization_id is null
    and version = 'v1_markup_20'
);

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
    'running',
    coalesce(p_auto_publish_requested, false)
  )
  returning id into v_quote_run_id;

  insert into public.vendor_quote_results (
    quote_run_id,
    part_id,
    organization_id,
    vendor,
    status
  )
  select
    v_quote_run_id,
    part.id,
    v_job.organization_id,
    vendor_name,
    'queued'
  from public.parts part
  join public.approved_part_requirements requirement on requirement.part_id = part.id
  cross join lateral unnest(requirement.applicable_vendors) as vendor_name
  where part.job_id = p_job_id
  on conflict (quote_run_id, part_id, vendor) do nothing;

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
      'vendor', result.vendor
    )
  from public.vendor_quote_results result
  where result.quote_run_id = v_quote_run_id;

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
        and previous_requirement.applicable_vendors = current_requirement.applicable_vendors
    ) as has_prior_match
    from public.approved_part_requirements current_requirement
    join public.parts current_part on current_part.id = current_requirement.part_id
    where current_part.job_id = v_quote_run.job_id
  ) comparison;

  if v_success_count < 2 then
    v_reasons := array_append(v_reasons, 'At least two successful vendor quotes are required.');
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

  v_ready := (
    v_success_count >= 2
    and v_failed_count = 0
    and v_blocking_vendor_states = 0
    and v_unapproved_extractions = 0
    and v_repair_tasks = 0
    and v_prior_requirements_match
  );

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
  v_seen uuid[] := array[]::uuid[];
  v_is_ready boolean := false;
begin
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

grant execute on function public.api_create_job(uuid, text, text, text) to authenticated;
grant execute on function public.api_attach_job_file(uuid, text, text, text, public.job_file_kind, text, bigint) to authenticated;
grant execute on function public.api_reconcile_job_parts(uuid) to authenticated;
grant execute on function public.api_request_extraction(uuid) to authenticated;
grant execute on function public.api_approve_job_requirements(uuid, jsonb) to authenticated;
grant execute on function public.api_start_quote_run(uuid, boolean) to authenticated;
grant execute on function public.api_get_quote_run_readiness(uuid) to authenticated;
grant execute on function public.api_publish_quote_package(uuid, uuid, text, boolean) to authenticated;
grant execute on function public.api_select_quote_option(uuid, uuid, text) to authenticated;
