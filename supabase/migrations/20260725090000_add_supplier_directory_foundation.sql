-- Migration: supplier directory foundation
-- Purpose: Add provenance-first companies, facilities, claims, and verification
-- without changing the fixed instant-quote vendor execution model (OVD-214).

create table public.supplier_companies (
  id uuid primary key default gen_random_uuid(),
  legal_name text,
  display_name text not null check (btrim(display_name) <> ''),
  website_domain text,
  lifecycle_status text not null default 'candidate' -- NOSONAR: shared supplier lifecycle vocabulary
    check (lifecycle_status in ('candidate', 'verified', 'inactive', 'merged', 'rejected')), -- NOSONAR: repeated deliberately across company and facility boundaries
  origin text not null
    check (origin in ('imported', 'internal', 'customer_suggested')),
  suggested_by uuid references auth.users(id) on delete set null,
  merged_into_id uuid references public.supplier_companies(id) on delete restrict,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  check (
    (lifecycle_status = 'merged' and merged_into_id is not null)
    or (lifecycle_status <> 'merged' and merged_into_id is null)
  ),
  check (merged_into_id is null or merged_into_id <> id)
);

create unique index supplier_companies_website_domain_unique
on public.supplier_companies (lower(website_domain))
where website_domain is not null and lifecycle_status <> 'merged';

create index supplier_companies_status_idx
on public.supplier_companies (lifecycle_status, display_name);

create table public.supplier_sources (
  id uuid primary key default gen_random_uuid(),
  source_kind text not null
    check (source_kind in ('official_website', 'government_directory', 'association_directory', 'approved_supplier_list', 'customer_submission', 'internal_research', 'other')),
  title text not null check (btrim(title) <> ''),
  source_uri text,
  publisher text,
  effective_date date,
  retrieved_at timestamptz,
  content_sha256 text check (content_sha256 is null or content_sha256 ~ '^[0-9a-f]{64}$'),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create table public.supplier_source_records (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.supplier_sources(id) on delete cascade,
  external_key text,
  record_sha256 text not null check (record_sha256 ~ '^[0-9a-f]{64}$'),
  raw_record jsonb not null,
  import_status text not null default 'pending'
    check (import_status in ('pending', 'matched', 'created', 'needs_review', 'rejected')),
  supplier_company_id uuid references public.supplier_companies(id) on delete set null,
  rejection_reason text,
  imported_at timestamptz not null default timezone('utc', now()),
  unique (source_id, record_sha256)
);

create index supplier_source_records_company_idx
on public.supplier_source_records (supplier_company_id);

create table public.supplier_company_aliases (
  id uuid primary key default gen_random_uuid(),
  supplier_company_id uuid not null references public.supplier_companies(id) on delete cascade,
  alias text not null check (btrim(alias) <> ''),
  source_record_id uuid references public.supplier_source_records(id) on delete set null,
  created_at timestamptz not null default timezone('utc', now())
);

create unique index supplier_company_aliases_unique
on public.supplier_company_aliases (supplier_company_id, lower(alias));

create table public.supplier_facilities (
  id uuid primary key default gen_random_uuid(),
  supplier_company_id uuid not null references public.supplier_companies(id) on delete cascade,
  facility_name text,
  address_line_1 text,
  address_line_2 text,
  city text,
  region_code text,
  postal_code text,
  country_code text not null default 'US' check (country_code = 'US'),
  latitude numeric(9, 6) check (latitude between -90 and 90),
  longitude numeric(9, 6) check (longitude between -180 and 180),
  lifecycle_status text not null default 'candidate'
    check (lifecycle_status in ('candidate', 'verified', 'inactive', 'merged', 'rejected')),
  commercial_availability text not null default 'unknown'
    check (commercial_availability in ('unknown', 'accepting_work', 'not_accepting_work', 'private_only')),
  suggested_by uuid references auth.users(id) on delete set null,
  merged_into_id uuid references public.supplier_facilities(id) on delete restrict,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  check (
    (latitude is null and longitude is null)
    or (latitude is not null and longitude is not null)
  ),
  check (
    (lifecycle_status = 'merged' and merged_into_id is not null)
    or (lifecycle_status <> 'merged' and merged_into_id is null)
  ),
  check (merged_into_id is null or merged_into_id <> id)
);

alter table public.supplier_facilities
add constraint supplier_facilities_company_id_id_unique
unique (supplier_company_id, id);

create index supplier_facilities_company_idx
on public.supplier_facilities (supplier_company_id);

create index supplier_facilities_location_idx
on public.supplier_facilities (country_code, region_code, city, postal_code);

create index supplier_facilities_coordinates_idx
on public.supplier_facilities (latitude, longitude)
where latitude is not null and longitude is not null;

alter table public.supplier_source_records
add column supplier_facility_id uuid;

alter table public.supplier_source_records
add constraint supplier_source_records_facility_requires_company
check (supplier_facility_id is null or supplier_company_id is not null);

alter table public.supplier_source_records
add constraint supplier_source_records_company_facility_fk
foreign key (supplier_company_id, supplier_facility_id)
references public.supplier_facilities (supplier_company_id, id)
on delete set null (supplier_facility_id);

create index supplier_source_records_facility_idx
on public.supplier_source_records (supplier_facility_id);

create table public.supplier_capabilities (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[a-z0-9]+(?:_[a-z0-9]+)*$'),
  name text not null check (btrim(name) <> ''),
  category text not null check (btrim(category) <> ''),
  is_active boolean not null default true,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table public.supplier_certifications (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z0-9][A-Z0-9._:/-]*$'),
  name text not null check (btrim(name) <> ''),
  issuing_body text,
  is_active boolean not null default true,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table public.supplier_facility_capability_claims (
  id uuid primary key default gen_random_uuid(),
  supplier_facility_id uuid not null references public.supplier_facilities(id) on delete cascade,
  capability_id uuid not null references public.supplier_capabilities(id) on delete restrict,
  source_record_id uuid references public.supplier_source_records(id) on delete set null,
  observed_at date,
  effective_from date,
  effective_to date,
  verification_status text not null default 'unverified' -- NOSONAR: shared claim verification vocabulary
    check (verification_status in ('unverified', 'verified', 'disputed', 'expired')), -- NOSONAR: repeated deliberately across claim boundaries
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  check (effective_to is null or effective_from is null or effective_to >= effective_from)
);

create index supplier_facility_capability_lookup_idx
on public.supplier_facility_capability_claims (
  capability_id,
  verification_status,
  supplier_facility_id
);

create table public.supplier_facility_certification_claims (
  id uuid primary key default gen_random_uuid(),
  supplier_facility_id uuid not null references public.supplier_facilities(id) on delete cascade,
  certification_id uuid not null references public.supplier_certifications(id) on delete restrict,
  source_record_id uuid references public.supplier_source_records(id) on delete set null,
  certificate_identifier text,
  observed_at date,
  effective_from date,
  effective_to date,
  verification_status text not null default 'unverified'
    check (verification_status in ('unverified', 'verified', 'disputed', 'expired')),
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  check (effective_to is null or effective_from is null or effective_to >= effective_from)
);

create index supplier_facility_certification_lookup_idx
on public.supplier_facility_certification_claims (
  certification_id,
  verification_status,
  supplier_facility_id
);

create table public.supplier_verification_events (
  id uuid primary key default gen_random_uuid(),
  supplier_company_id uuid references public.supplier_companies(id) on delete restrict,
  supplier_facility_id uuid references public.supplier_facilities(id) on delete restrict,
  capability_claim_id uuid references public.supplier_facility_capability_claims(id) on delete restrict,
  certification_claim_id uuid references public.supplier_facility_certification_claims(id) on delete restrict,
  source_record_id uuid references public.supplier_source_records(id) on delete set null,
  verification_status text not null
    check (verification_status in ('verified', 'disputed', 'expired', 'unreachable')),
  field_name text,
  verified_by uuid references auth.users(id) on delete set null,
  verified_at timestamptz not null default timezone('utc', now()),
  notes text,
  created_at timestamptz not null default timezone('utc', now()),
  check (
    num_nonnulls(
      supplier_company_id,
      supplier_facility_id,
      capability_claim_id,
      certification_claim_id
    ) = 1
  )
);

create index supplier_verification_events_company_idx
on public.supplier_verification_events (supplier_company_id, verified_at desc);

create index supplier_verification_events_facility_idx
on public.supplier_verification_events (supplier_facility_id, verified_at desc);

create trigger touch_supplier_companies_updated_at
before update on public.supplier_companies
for each row execute function public.touch_updated_at();

create trigger touch_supplier_facilities_updated_at
before update on public.supplier_facilities
for each row execute function public.touch_updated_at();

create trigger touch_supplier_capabilities_updated_at
before update on public.supplier_capabilities
for each row execute function public.touch_updated_at();

create trigger touch_supplier_certifications_updated_at
before update on public.supplier_certifications
for each row execute function public.touch_updated_at();

create trigger touch_supplier_facility_capability_claims_updated_at
before update on public.supplier_facility_capability_claims
for each row execute function public.touch_updated_at();

create trigger touch_supplier_facility_certification_claims_updated_at
before update on public.supplier_facility_certification_claims
for each row execute function public.touch_updated_at();

alter table public.supplier_companies enable row level security;
alter table public.supplier_sources enable row level security;
alter table public.supplier_source_records enable row level security;
alter table public.supplier_company_aliases enable row level security;
alter table public.supplier_facilities enable row level security;
alter table public.supplier_capabilities enable row level security;
alter table public.supplier_certifications enable row level security;
alter table public.supplier_facility_capability_claims enable row level security;
alter table public.supplier_facility_certification_claims enable row level security;
alter table public.supplier_verification_events enable row level security;

create policy "supplier_companies_internal_access"
on public.supplier_companies for all to authenticated
using (public.is_internal_user_any_org())
with check (public.is_internal_user_any_org());

create policy "supplier_sources_internal_access"
on public.supplier_sources for all to authenticated
using (public.is_internal_user_any_org())
with check (public.is_internal_user_any_org());

create policy "supplier_source_records_internal_access"
on public.supplier_source_records for all to authenticated
using (public.is_internal_user_any_org())
with check (public.is_internal_user_any_org());

create policy "supplier_company_aliases_internal_access"
on public.supplier_company_aliases for all to authenticated
using (public.is_internal_user_any_org())
with check (public.is_internal_user_any_org());

create policy "supplier_facilities_internal_access"
on public.supplier_facilities for all to authenticated
using (public.is_internal_user_any_org())
with check (public.is_internal_user_any_org());

create policy "supplier_capabilities_authenticated_select"
on public.supplier_capabilities for select to authenticated
using (is_active);

create policy "supplier_capabilities_internal_manage"
on public.supplier_capabilities for all to authenticated
using (public.is_internal_user_any_org())
with check (public.is_internal_user_any_org());

create policy "supplier_certifications_authenticated_select"
on public.supplier_certifications for select to authenticated
using (is_active);

create policy "supplier_certifications_internal_manage"
on public.supplier_certifications for all to authenticated
using (public.is_internal_user_any_org())
with check (public.is_internal_user_any_org());

create policy "supplier_facility_capability_claims_internal_access"
on public.supplier_facility_capability_claims for all to authenticated
using (public.is_internal_user_any_org())
with check (public.is_internal_user_any_org());

create policy "supplier_facility_certification_claims_internal_access"
on public.supplier_facility_certification_claims for all to authenticated
using (public.is_internal_user_any_org())
with check (public.is_internal_user_any_org());

create policy "supplier_verification_events_internal_access"
on public.supplier_verification_events for all to authenticated
using (public.is_internal_user_any_org())
with check (public.is_internal_user_any_org());

grant select, insert, update, delete on
  public.supplier_companies,
  public.supplier_sources,
  public.supplier_source_records,
  public.supplier_company_aliases,
  public.supplier_facilities,
  public.supplier_capabilities,
  public.supplier_certifications,
  public.supplier_facility_capability_claims,
  public.supplier_facility_certification_claims,
  public.supplier_verification_events
to authenticated;

-- Rollback: drop these tables in reverse dependency order. This migration does
-- not mutate vendor_name, vendor_capability_profiles, quote runs, or quote data.
