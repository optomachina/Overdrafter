-- Seed eMachineShop capabilities that are represented by its instant-quote
-- surface. Individual designs or materials may still fall back to manual review.

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
) values (
  'emachineshop',
  array[
    'cnc_milling',
    'cnc_turning',
    'laser_cutting',
    'waterjet_cutting',
    'sheet_metal',
    'injection_molding',
    '3d_printing'
  ]::public.process_types[],
  array[
    'aluminum',
    'steel',
    'stainless_steel',
    'titanium',
    'brass',
    'bronze',
    'copper',
    'abs',
    'acetal',
    'acrylic',
    'nylon',
    'polycarbonate',
    'polyethylene',
    'polypropylene',
    'ptfe',
    'pvc'
  ],
  null,
  null,
  null,
  1,
  1000000,
  'US',
  array['ITAR'],
  null,
  null,
  null,
  true
)
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

-- Rollback: delete from public.vendor_capability_profiles
-- where vendor_name = 'emachineshop', then disable the enum value operationally.
