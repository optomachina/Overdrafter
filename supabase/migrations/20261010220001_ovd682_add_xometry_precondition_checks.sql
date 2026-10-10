-- OVD-679, OVD-682: Add named precondition checks for Xometry beta dispatch

-- Add specific precondition check for confirmed sourcing address before calling quote_lane_candidates
-- This replaces the silent 0-candidate filtering with explicit named errors

-- This function will be called by resolve_xometry_beta_dispatch_scope to provide clear error messages
create or replace function private.check_xometry_beta_preconditions(
  p_organization_id uuid,
  p_part_id uuid,
  p_requirement_id uuid
)
returns void
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_requirement public.approved_part_requirements%rowtype;
  v_sourcing_address jsonb;
begin
  -- Check for confirmed sourcing address (required for Xometry)
  v_sourcing_address := private.current_confirmed_sourcing_address(p_organization_id);
  if v_sourcing_address is null then
    raise exception 'xometry_beta_confirmed_sourcing_address_required';
  end if;

  -- Check that Xometry is in applicable vendors
  select * into v_requirement 
  from public.approved_part_requirements 
  where id = p_requirement_id;
  
  if v_requirement.id is null then
    raise exception 'xometry_beta_exact_scope_required';
  end if;

  if not ('xometry'::public.vendor_name = any(v_requirement.applicable_vendors)) then
    raise exception 'xometry_beta_exact_scope_required';
  end if;

  -- Check for tightest tolerance (required field for Xometry)
  if v_requirement.tightest_tolerance_inch is null or v_requirement.tightest_tolerance_inch < 0 then
    raise exception 'xometry_beta_tightest_tolerance_required';
  end if;
end;
$$;

revoke all on function private.check_xometry_beta_preconditions(uuid, uuid, uuid) 
  from public, anon, authenticated, service_role;
