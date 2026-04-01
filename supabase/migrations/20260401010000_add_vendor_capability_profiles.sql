-- Vendor capability profile model (OVD-134)
-- Provides a durable, data-driven source of vendor capabilities that replaces
-- hardcoded DEFAULT_APPLICABLE_VENDORS fallbacks in the frontend.

-- Capability tag enum for normalized filtering
do $$
begin
  if not exists (select 1 from pg_type where typname = 'vendor_capability_tag') then
    create type public.vendor_capability_tag as enum (
      'cnc_milling',
      'cnc_turning',
      'sheet_metal',
      'injection_molding',
      '3d_printing',
      'laser_cutting',
      'waterjet',
      'edm',
      'urethane_casting',
      'metal_3d_printing',
      'finishing_anodize',
      'finishing_powder_coat',
      'finishing_bead_blast',
      'finishing_plating',
      'finishing_passivation',
      'material_aluminum',
      'material_steel',
      'material_stainless',
      'material_plastic_abs',
      'material_plastic_delrin',
      'material_plastic_peek',
      'material_plastic_nylon',
      'material_brass',
      'material_copper',
      'material_titanium',
      'tight_tolerance',
      'high_volume',
      'rapid_prototyping',
      'production_run'
    );
  end if;
end $$;

-- Vendor capability profiles table
create table if not exists public.vendor_capability_profiles (
  id uuid primary key default gen_random_uuid(),
  vendor public.vendor_name not null unique,
  display_name text not null,
  -- Service categories this vendor supports
  supported_processes text[] not null default array[]::text[],
  -- Materials the vendor can work with
  supported_materials text[] not null default array[]::text[],
  -- Finishes the vendor offers
  supported_finishes text[] not null default array[]::text[],
  -- Normalized capability tags for fast filtering
  capability_tags public.vendor_capability_tag[] not null default array[]::text[],
  -- Minimum tolerance the vendor can hold (in inches)
  min_tolerance_inch numeric,
  -- Minimum quantity the vendor accepts
  min_quantity integer not null default 1,
  -- Maximum quantity the vendor accepts (null = no limit)
  max_quantity integer,
  -- Typical lead time range (business days)
  typical_lead_min_days integer,
  typical_lead_max_days integer,
  -- Whether the vendor supports instant/automated quoting
  supports_instant_quote boolean not null default false,
  -- Whether the vendor is active for new quote requests
  active_for_quotes boolean not null default true,
  -- Optional notes about this vendor's capabilities
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.vendor_capability_profiles is
  'Durable vendor capability profiles used for deterministic vendor routing and filtering.';

-- Index for tag-based lookups
create index if not exists idx_vendor_capability_profiles_tags
  on public.vendor_capability_profiles using gin(capability_tags);

-- Index for process-based lookups
create index if not exists idx_vendor_capability_profiles_processes
  on public.vendor_capability_profiles using gin(supported_processes);

-- Seed initial capability profiles for all known vendors
insert into public.vendor_capability_profiles (
  vendor, display_name, supported_processes, supported_materials, supported_finishes,
  capability_tags, min_tolerance_inch, min_quantity, typical_lead_min_days, typical_lead_max_days,
  supports_instant_quote, active_for_quotes, notes
) values
  (
    'xometry',
    'Xometry',
    array['cnc_milling', 'cnc_turning', 'sheet_metal', 'injection_molding', '3d_printing', 'laser_cutting', 'waterjet', 'edm', 'urethane_casting', 'metal_3d_printing'],
    array['aluminum_6061', 'aluminum_7075', 'stainless_steel_304', 'stainless_steel_316', 'steel_1018', 'steel_4140', 'brass', 'copper', 'titanium_ti64', 'abs', 'delrin', 'peek', 'nylon', 'polycarbonate'],
    array['anodize_type_ii', 'anodize_type_iii', 'powder_coat', 'bead_blast', 'passivation', 'plating', 'chromate'],
    array['cnc_milling', 'cnc_turning', 'sheet_metal', 'injection_molding', '3d_printing', 'laser_cutting', 'waterjet', 'edm', 'urethane_casting', 'metal_3d_printing', 'finishing_anodize', 'finishing_powder_coat', 'finishing_bead_blast', 'finishing_plating', 'finishing_passivation', 'material_aluminum', 'material_steel', 'material_stainless', 'material_plastic_abs', 'material_plastic_delrin', 'material_plastic_peek', 'material_plastic_nylon', 'material_brass', 'material_copper', 'material_titanium', 'tight_tolerance', 'high_volume', 'rapid_prototyping', 'production_run'],
    0.0005,
    1,
    1, 20,
    true,
    true,
    'Full-service marketplace with broadest capability coverage.'
  ),
  (
    'fictiv',
    'Fictiv',
    array['cnc_milling', 'cnc_turning', 'sheet_metal', 'injection_molding', '3d_printing', 'urethane_casting'],
    array['aluminum_6061', 'aluminum_7075', 'stainless_steel_304', 'stainless_steel_316', 'steel_1018', 'brass', 'abs', 'delrin', 'peek', 'nylon', 'polycarbonate'],
    array['anodize_type_ii', 'anodize_type_iii', 'powder_coat', 'bead_blast', 'passivation', 'plating'],
    array['cnc_milling', 'cnc_turning', 'sheet_metal', 'injection_molding', '3d_printing', 'urethane_casting', 'finishing_anodize', 'finishing_powder_coat', 'finishing_bead_blast', 'finishing_plating', 'finishing_passivation', 'material_aluminum', 'material_steel', 'material_stainless', 'material_plastic_abs', 'material_plastic_delrin', 'material_plastic_peek', 'material_plastic_nylon', 'material_brass', 'tight_tolerance', 'rapid_prototyping', 'production_run'],
    0.001,
    1,
    2, 15,
    true,
    true,
    'Digital manufacturing platform focused on CNC and injection molding.'
  ),
  (
    'protolabs',
    'Protolabs',
    array['cnc_milling', 'cnc_turning', 'injection_molding', '3d_printing', 'sheet_metal'],
    array['aluminum_6061', 'aluminum_7075', 'stainless_steel_304', 'steel_1018', 'brass', 'abs', 'delrin', 'peek', 'nylon', 'polycarbonate', 'polypropylene'],
    array['anodize_type_ii', 'bead_blast', 'powder_coat', 'passivation'],
    array['cnc_milling', 'cnc_turning', 'injection_molding', '3d_printing', 'sheet_metal', 'finishing_anodize', 'finishing_powder_coat', 'finishing_bead_blast', 'finishing_passivation', 'material_aluminum', 'material_steel', 'material_stainless', 'material_plastic_abs', 'material_plastic_delrin', 'material_plastic_peek', 'material_plastic_nylon', 'material_brass', 'tight_tolerance', 'rapid_prototyping', 'production_run'],
    0.001,
    1,
    1, 15,
    true,
    true,
    'Rapid prototyping and low-volume production with automated quoting.'
  ),
  (
    'sendcutsend',
    'SendCutSend',
    array['laser_cutting', 'waterjet', 'sheet_metal'],
    array['aluminum_5052', 'aluminum_6061', 'stainless_steel_304', 'stainless_steel_316', 'steel_1018', 'brass', 'copper', 'titanium_ti64', 'acrylic', 'wood'],
    array['anodize_type_ii', 'anodize_type_iii', 'powder_coat', 'bead_blast', 'plating', 'chromate'],
    array['laser_cutting', 'waterjet', 'sheet_metal', 'finishing_anodize', 'finishing_powder_coat', 'finishing_bead_blast', 'finishing_plating', 'material_aluminum', 'material_steel', 'material_stainless', 'material_brass', 'material_copper', 'material_titanium', 'rapid_prototyping'],
    0.005,
    1,
    2, 10,
    true,
    true,
    'Specialized in laser-cut and sheet metal parts. Not suitable for tight tolerances.'
  ),
  (
    'partsbadger',
    'PartsBadger',
    array['cnc_milling', 'cnc_turning', 'sheet_metal'],
    array['aluminum_6061', 'stainless_steel_304', 'steel_1018', 'delrin'],
    array['anodize_type_ii', 'bead_blast'],
    array['cnc_milling', 'cnc_turning', 'sheet_metal', 'finishing_anodize', 'finishing_bead_blast', 'material_aluminum', 'material_steel', 'material_stainless', 'material_plastic_delrin'],
    0.002,
    1,
    3, 14,
    false,
    true,
    'Manual import vendor. CNC and sheet metal focus.'
  ),
  (
    'fastdms',
    'FastDMS',
    array['cnc_milling', 'cnc_turning', 'injection_molding'],
    array['aluminum_6061', 'stainless_steel_304', 'steel_1018', 'abs', 'delrin'],
    array['anodize_type_ii', 'bead_blast'],
    array['cnc_milling', 'cnc_turning', 'injection_molding', 'finishing_anodize', 'finishing_bead_blast', 'material_aluminum', 'material_steel', 'material_stainless', 'material_plastic_abs', 'material_plastic_delrin'],
    0.002,
    1,
    5, 20,
    false,
    true,
    'Manual import vendor. CNC and molding.'
  ),
  (
    'devzmanufacturing',
    'DEVZ Manufacturing',
    array['cnc_milling', 'cnc_turning', 'sheet_metal'],
    array['aluminum_6061', 'stainless_steel_304', 'steel_1018'],
    array['anodize_type_ii', 'bead_blast'],
    array['cnc_milling', 'cnc_turning', 'sheet_metal', 'finishing_anodize', 'finishing_bead_blast', 'material_aluminum', 'material_steel', 'material_stainless'],
    0.002,
    1,
    5, 21,
    false,
    true,
    'Manual import vendor. General CNC and fabrication.'
  ),
  (
    'infraredlaboratories',
    'Infrared Laboratories',
    array['cnc_milling', 'edm'],
    array['aluminum_6061', 'stainless_steel_304', 'titanium_ti64', 'peek'],
    array['anodize_type_ii', 'passivation'],
    array['cnc_milling', 'edm', 'finishing_anodize', 'finishing_passivation', 'material_aluminum', 'material_stainless', 'material_titanium', 'material_plastic_peek', 'tight_tolerance'],
    0.0005,
    1,
    7, 30,
    false,
    true,
    'Manual import vendor. Specialized precision and aerospace-grade work.'
  )
on conflict (vendor) do update set
  display_name = excluded.display_name,
  supported_processes = excluded.supported_processes,
  supported_materials = excluded.supported_materials,
  supported_finishes = excluded.supported_finishes,
  capability_tags = excluded.capability_tags,
  min_tolerance_inch = excluded.min_tolerance_inch,
  min_quantity = excluded.min_quantity,
  max_quantity = excluded.max_quantity,
  typical_lead_min_days = excluded.typical_lead_min_days,
  typical_lead_max_days = excluded.typical_lead_max_days,
  supports_instant_quote = excluded.supports_instant_quote,
  active_for_quotes = excluded.active_for_quotes,
  notes = excluded.notes,
  updated_at = now();

-- Function: resolve applicable vendors given part requirements
-- Returns the intersection of:
-- 1. Org-enabled vendors (from org_vendor_configs)
-- 2. Part-level applicable_vendors (from approved_part_requirements)
-- 3. Capability-filtered vendors (vendors that support the required process/material)
-- Falls back to all active vendors with instant quote support if no explicit config exists.
create or replace function public.resolve_applicable_vendors(
  p_organization_id uuid,
  p_part_applicable_vendors public.vendor_name[],
  p_required_process text default null,
  p_required_material text default null,
  p_tolerance_inch numeric default null
)
returns public.vendor_name[]
language plpgsql
as $$
declare
  result public.vendor_name[];
  org_enabled public.vendor_name[];
  capability_filtered public.vendor_name[];
begin
  -- Step 1: Get org-enabled vendors
  select array_agg(vendor)::public.vendor_name[]
  into org_enabled
  from public.org_vendor_configs
  where organization_id = p_organization_id
    and enabled_for_client_quote_requests = true;

  -- If no org config, fall back to all active vendors
  if org_enabled is null or array_length(org_enabled, 1) is null then
    select array_agg(vendor)::public.vendor_name[]
    into org_enabled
    from public.vendor_capability_profiles
    where active_for_quotes = true;
  end if;

  -- Step 2: Start with the intersection of org-enabled and part-level applicable vendors
  if p_part_applicable_vendors is not null and array_length(p_part_applicable_vendors, 1) > 0 then
    select array_agg(v)::public.vendor_name[]
    into result
    from unnest(org_enabled) as v
    where v = any(p_part_applicable_vendors);
  else
    result := org_enabled;
  end if;

  -- If result is empty, fall back to org_enabled
  if result is null or array_length(result, 1) is null then
    result := org_enabled;
  end if;

  -- Step 3: Filter by capability if process or material is specified
  if p_required_process is not null or p_required_material is not null then
    select array_agg(vcp.vendor)::public.vendor_name[]
    into capability_filtered
    from public.vendor_capability_profiles vcp
    where vcp.active_for_quotes = true
      and (
        p_required_process is null
        or p_required_process = any(vcp.supported_processes)
        or p_required_process = any(vcp.capability_tags)
      )
      and (
        p_required_material is null
        or exists (
          select 1
          from unnest(vcp.supported_materials) as mat
          where lower(mat) like '%' || lower(p_required_material) || '%'
        )
      )
      and (
        p_tolerance_inch is null
        or vcp.min_tolerance_inch is null
        or p_tolerance_inch >= vcp.min_tolerance_inch
      );

    if capability_filtered is not null and array_length(capability_filtered, 1) > 0 then
      -- Intersect capability-filtered with current result
      select array_agg(v)::public.vendor_name[]
      into result
      from unnest(result) as v
      where v = any(capability_filtered);

      -- If intersection is empty, keep original result (don't over-filter)
      if result is null or array_length(result, 1) is null then
        result := org_enabled;
      end if;
    end if;
  end if;

  return result;
end;
$$;

comment on function public.resolve_applicable_vendors is
  'Deterministic vendor resolver that combines org config, part-level applicability, and capability profiles.';
