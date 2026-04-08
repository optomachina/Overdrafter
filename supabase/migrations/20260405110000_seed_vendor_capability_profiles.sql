-- Migration: seed vendor capability profiles
-- Purpose: Insert initial capability data for the 4 live vendors (OVD-138)
-- Date: 2026-04-05

-- Xometry
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
  'xometry',
  array['cnc_milling', 'cnc_turning', '3d_printing', 'injection_molding', 'sheet_metal']::public.process_types[],
  array['aluminum', 'steel', 'stainless_steel', 'titanium', 'brass', 'abs', 'pla', 'petg', 'nylon'],
  0.01,
  0.1,
  1500,
  1,
  null,
  'US',
  array['ISO9001', 'AS9100', 'ITAR'],
  80,
  75,
  70,
  true
) on conflict (vendor_name) do nothing;

-- Fictiv
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
  'fictiv',
  array['cnc_milling', 'cnc_turning', '3d_printing', 'sheet_metal']::public.process_types[],
  array['aluminum', 'steel', 'stainless_steel', 'titanium', 'brass', 'abs', 'petg'],
  0.02,
  0.15,
  1200,
  1,
  null,
  'US',
  array['ISO9001', 'ITAR'],
  78,
  80,
  75,
  true
) on conflict (vendor_name) do nothing;

-- Protolabs
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
  'protolabs',
  array['cnc_milling', 'cnc_turning', 'injection_molding', '3d_printing', 'sheet_metal']::public.process_types[],
  array['aluminum', 'steel', 'stainless_steel', 'titanium', 'brass', 'abs', 'pla', 'petg', 'nylon', 'polycarbonate'],
  0.005,
  0.05,
  1000,
  1,
  null,
  'US',
  array['ISO9001', 'AS9100', 'ITAR', 'ISO13485'],
  90,
  95,
  55,
  true
) on conflict (vendor_name) do nothing;

-- SendCutSend
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
  'sendcutsend',
  array['laser_cutting', 'sheet_metal']::public.process_types[],
  array['aluminum', 'steel', 'stainless_steel', 'brass'],
  0.05,
  0.25,
  3000,
  1,
  null,
  'US',
  array['ISO9001'],
  75,
  85,
  85,
  true
) on conflict (vendor_name) do nothing;
