-- Migration: vendor_capability_profiles
-- Purpose: Store static capability data for each vendor (OVD-138)
-- Date: 2026-04-05

-- Create process_types enum if it doesn't exist
do $$
begin
  if not exists (select 1 from pg_type where typname = 'process_types') then
    create type public.process_types as enum (
      'cnc_milling',
      'cnc_turning',
      'laser_cutting',
      'sheet_metal',
      'injection_molding',
      '3d_printing'
    );
  end if;
end
$$;

-- Vendor capability profiles: static capability data per vendor
create table if not exists public.vendor_capability_profiles (
  -- Vendor identifier (one row per vendor)
  vendor_name public.vendor_name not null primary key,

  -- Manufacturing processes the vendor supports
  process_types public.process_types[] not null default array[]::public.process_types[],

  -- Materials the vendor works with (e.g., aluminum, steel, stainless_steel, titanium, brass, abs, pla, petg)
  materials text[] not null default array[]::text[],

  -- Tolerance range capability in millimeters
  tolerance_min_mm numeric(10, 4),
  tolerance_max_mm numeric(10, 4),

  -- Maximum part size capability in millimeters
  max_part_size_mm numeric(10, 2),

  -- Quantity range the vendor can fulfill
  min_quantity integer not null default 1,
  max_quantity integer,

  -- Geographic region of the vendor (e.g., "US", "China", "EU", "Global")
  geographic_region text,

  -- Certifications held by the vendor (e.g., ISO9001, AS9100, ITAR)
  certifications text[] not null default array[]::text[],

  -- Historical quality metric (0-100)
  quality_score numeric(5, 2),

  -- Historical on-time delivery rate (0-100)
  lead_time_reliability numeric(5, 2),

  -- Relative cost positioning (0-100, higher = more competitive)
  cost_competitiveness numeric(5, 2),

  -- Whether the vendor is US-based
  domestic_us boolean not null default false,

  -- When this profile was last updated
  updated_at timestamptz not null default timezone('utc', now())
);

-- Trigger to auto-update updated_at
drop trigger if exists touch_vendor_capability_profiles_updated_at on public.vendor_capability_profiles;
create trigger touch_vendor_capability_profiles_updated_at
before update on public.vendor_capability_profiles
for each row execute function public.touch_updated_at();

-- RLS
alter table public.vendor_capability_profiles enable row level security;

-- All authenticated users can read vendor capability profiles (used for routing decisions)
drop policy if exists "vendor_capability_profiles_select_authenticated" on public.vendor_capability_profiles;
create policy "vendor_capability_profiles_select_authenticated"
on public.vendor_capability_profiles
for select
to authenticated
using (true);

-- Helper: check if current user is an internal user in any organization
create or replace function public.is_internal_user_any_org()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.organization_memberships membership
    where membership.user_id = auth.uid()
      and membership.role in ('internal_estimator', 'internal_admin')
  );
$$;

-- Only internal users can manage vendor capability profiles
drop policy if exists "vendor_capability_profiles_manage_internal" on public.vendor_capability_profiles;
create policy "vendor_capability_profiles_manage_internal"
on public.vendor_capability_profiles
for all
to authenticated
using (public.is_internal_user_any_org())
with check (public.is_internal_user_any_org());

-- Grant read access to authenticated users
grant select on public.vendor_capability_profiles to authenticated;
