-- Seed capability profiles for hidden live-quote vendor candidates.
-- This is separate from the enum-add migration because PostgreSQL cannot use
-- newly added enum values safely until the adding transaction has committed.

with
  base_process_groups as (
    select
      array['cnc_milling', 'cnc_turning']::public.process_types[] as cnc_processes,
      array['laser_cutting', 'sheet_metal']::public.process_types[] as sheet_processes
  ),
  process_groups as (
    select
      sheet_processes,
      cnc_processes || array['injection_molding', '3d_printing', 'sheet_metal']::public.process_types[] as multi_processes,
      cnc_processes || array['3d_printing', 'laser_cutting']::public.process_types[] as weerg_processes
    from base_process_groups
  ),
  base_material_groups as (
    select
      array['aluminum', 'steel', 'stainless_steel'] as metal_base,
      array['abs', 'nylon'] as plastic_base
  ),
  material_groups as (
    select
      metal_base as metal_basic,
      metal_base || array['brass', 'copper'] as metal_full,
      metal_base || array['acrylic', 'delrin', 'wood'] as ponoko_materials,
      metal_base || array['titanium', 'brass'] || plastic_base as multi_lite,
      metal_base || array['titanium', 'brass'] || plastic_base || array['polycarbonate'] as multi_full,
      metal_base || plastic_base as weerg_materials
    from base_material_groups
  ),
  certification_groups as (
    select
      array['ISO9001'] as iso9001,
      array['ISO9001', 'ISO13485'] as iso13485,
      array[]::text[] as none
  ),
  vendor_rows (
    vendor_name,
    process_code,
    material_code,
    tolerance_code,
    max_part_size_mm,
    region_code,
    certification_code,
    domestic_us
  ) as (
    values
      ('oshcut'::public.vendor_name, 1, 1, 1, 3000, 1, 1, true),
      ('fabworks'::public.vendor_name, 1, 2, 1, 3000, 1, 0, true),
      ('ponoko'::public.vendor_name, 1, 3, 2, 3000, 1, 0, true),
      ('quickparts'::public.vendor_name, 2, 4, 3, 1200, 2, 1, false),
      ('rapiddirect'::public.vendor_name, 2, 4, 3, 1500, 3, 1, false),
      ('geomiq'::public.vendor_name, 2, 5, 3, 1200, 2, 2, false),
      ('weerg'::public.vendor_name, 3, 6, 3, 1000, 4, 1, false),
      ('protolabsnetwork'::public.vendor_name, 2, 4, 3, 1500, 2, 1, false)
  ),
  capability_profiles as (
    select
      row.vendor_name,
      case row.process_code
        when 1 then process_groups.sheet_processes
        when 2 then process_groups.multi_processes
        else process_groups.weerg_processes
      end as process_types,
      case row.material_code
        when 1 then material_groups.metal_full
        when 2 then material_groups.metal_basic
        when 3 then material_groups.ponoko_materials
        when 4 then material_groups.multi_full
        when 5 then material_groups.multi_lite
        else material_groups.weerg_materials
      end as materials,
      case row.tolerance_code
        when 2 then 0.08
        when 1 then 0.05
        else 0.01
      end as tolerance_min_mm,
      case row.tolerance_code
        when 3 then 0.1
        else 0.25
      end as tolerance_max_mm,
      row.max_part_size_mm,
      1 as min_quantity,
      null::integer as max_quantity,
      case row.region_code
        when 1 then 'US'
        when 3 then 'China'
        when 4 then 'EU'
        else 'Global'
      end as geographic_region,
      case row.certification_code
        when 1 then certification_groups.iso9001
        when 2 then certification_groups.iso13485
        else certification_groups.none
      end as certifications,
      null::numeric as quality_score,
      null::numeric as lead_time_reliability,
      null::numeric as cost_competitiveness,
      row.domestic_us
    from vendor_rows row
    cross join process_groups
    cross join material_groups
    cross join certification_groups
  )
insert into public.vendor_capability_profiles (
  vendor_name,
  process_types,
  materials,
  tolerance_min_mm,
  tolerance_max_mm,
  max_part_size_mm,
  min_quantity,
  max_quantity,
  geographic_region,
  certifications,
  quality_score,
  lead_time_reliability,
  cost_competitiveness,
  domestic_us
)
select
  vendor_name,
  process_types,
  materials,
  tolerance_min_mm,
  tolerance_max_mm,
  max_part_size_mm,
  min_quantity,
  max_quantity,
  geographic_region,
  certifications,
  quality_score,
  lead_time_reliability,
  cost_competitiveness,
  domestic_us
from capability_profiles
on conflict (vendor_name) do update
set
  process_types = excluded.process_types,
  materials = excluded.materials,
  tolerance_min_mm = excluded.tolerance_min_mm,
  tolerance_max_mm = excluded.tolerance_max_mm,
  max_part_size_mm = excluded.max_part_size_mm,
  min_quantity = excluded.min_quantity,
  max_quantity = excluded.max_quantity,
  geographic_region = excluded.geographic_region,
  certifications = excluded.certifications,
  domestic_us = excluded.domestic_us,
  updated_at = timezone('utc', now());
