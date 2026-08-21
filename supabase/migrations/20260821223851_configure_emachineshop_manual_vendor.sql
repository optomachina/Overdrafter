-- OVD-199: configure eMachineShop as a default-on manual RFQ source.
--
-- This migration deliberately does not approve browser automation, enable
-- generic dispatch, create organization-specific configuration, change the
-- automatic-provider resolver, or add a live adapter.
--
-- Capability evidence is intentionally conservative and limited to the public
-- eMachineShop CNC/STEP quote surface reviewed on 2026-08-21. Unknown tolerance,
-- size, geography, certification, and performance claims remain unset.
--
-- Operational rollback:
-- 1. Drop the three manual-request consistency triggers/functions and restore
--    the response helper so empty manual requests return an empty vendor list.
-- 2. Keep the admission policy disabled and remove eMachineShop from UI defaults.
-- 3. Preserve the enum, policy history, and historical quote rows.

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
  domestic_us,
  updated_at
)
values (
  'emachineshop'::public.vendor_name,
  array['cnc_milling', 'cnc_turning']::public.process_types[],
  array['aluminum']::text[],
  null,
  null,
  null,
  1,
  null,
  null,
  array[]::text[],
  null,
  null,
  null,
  false,
  timestamptz '2026-08-21 00:00:00+00'
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
  quality_score = excluded.quality_score,
  lead_time_reliability = excluded.lead_time_reliability,
  cost_competitiveness = excluded.cost_competitiveness,
  domestic_us = excluded.domestic_us,
  updated_at = excluded.updated_at;

insert into private.quote_provider_admission_policies (
  provider,
  admission_state,
  generic_dispatch_enabled,
  policy_revision,
  evidence_reference,
  permission_basis,
  supported_processes,
  accepted_file_extensions,
  session_owner,
  reviewed_by,
  reviewed_at,
  expires_at,
  change_reason
)
values (
  'emachineshop'::public.vendor_name,
  'disabled',
  false,
  'emachineshop-manual-2026-08-21.v1',
  'OVD-199',
  null,
  array[]::public.process_types[],
  array[]::text[],
  null,
  null,
  timestamptz '2026-08-21 00:00:00+00',
  null,
  'initial_seed'
)
on conflict (provider) do nothing;

alter table public.quote_requests
alter column requested_vendors
drop default;

create or replace function private.default_manual_quote_request_vendors()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if tg_op = 'UPDATE'
    and old.request_mode = 'manual'::public.quote_request_mode
    and new.requested_vendors is distinct from old.requested_vendors
    and exists (
      select 1
      from public.quote_runs quote_run
      join public.vendor_quote_results result_row
        on result_row.quote_run_id = quote_run.id
      where quote_run.quote_request_id = old.id
    ) then
    raise exception 'Manual quote request vendor scope cannot change after a result exists.';
  end if;

  if new.request_mode = 'manual'::public.quote_request_mode then
    if coalesce(pg_catalog.cardinality(new.requested_vendors), 0) = 0 then
      new.requested_vendors := array['emachineshop']::public.vendor_name[];
    elsif pg_catalog.cardinality(new.requested_vendors) <> 1 then
      raise exception 'Manual quote requests must name exactly one vendor.';
    end if;
  elsif new.requested_vendors is null then
    new.requested_vendors := array['xometry']::public.vendor_name[];
  end if;

  return new;
end;
$$;

revoke all on function private.default_manual_quote_request_vendors()
  from public, anon, authenticated, service_role;

drop trigger if exists default_manual_quote_request_vendors
  on public.quote_requests;
create trigger default_manual_quote_request_vendors
before insert or update of request_mode, requested_vendors on public.quote_requests
for each row execute function private.default_manual_quote_request_vendors();

create or replace function private.enforce_manual_quote_result_vendor()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_request_mode public.quote_request_mode;
  v_requested_vendors public.vendor_name[];
begin
  select
    request_row.request_mode,
    request_row.requested_vendors
  into v_request_mode, v_requested_vendors
  from public.quote_runs quote_run
  join public.quote_requests request_row
    on request_row.id = quote_run.quote_request_id
  where quote_run.id = new.quote_run_id;

  if v_request_mode = 'manual'::public.quote_request_mode
    and coalesce(pg_catalog.cardinality(v_requested_vendors), 0) > 0
    and coalesce(new.vendor = any(v_requested_vendors), false) is not true then
    raise exception 'Manual quote vendor does not match the requested vendor.';
  end if;

  return new;
end;
$$;

revoke all on function private.enforce_manual_quote_result_vendor()
  from public, anon, authenticated, service_role;

drop trigger if exists enforce_manual_quote_result_vendor
  on public.vendor_quote_results;
create trigger enforce_manual_quote_result_vendor
before insert or update of quote_run_id, vendor on public.vendor_quote_results
for each row execute function private.enforce_manual_quote_result_vendor();

create or replace function private.align_manual_quote_request_audit_vendors()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_requested_vendors public.vendor_name[];
begin
  if new.event_type <> 'job.manual_quote_requested' then
    return new;
  end if;

  select request_row.requested_vendors
  into v_requested_vendors
  from public.quote_requests request_row
  where request_row.id = (new.payload ->> 'quoteRequestId')::uuid
    and request_row.request_mode = 'manual'::public.quote_request_mode;

  if v_requested_vendors is not null then
    new.payload := new.payload || pg_catalog.jsonb_build_object(
      'requestedVendors', v_requested_vendors
    );
  end if;

  return new;
end;
$$;

revoke all on function private.align_manual_quote_request_audit_vendors()
  from public, anon, authenticated, service_role;

drop trigger if exists align_manual_quote_request_audit_vendors
  on public.audit_events;
create trigger align_manual_quote_request_audit_vendors
before insert on public.audit_events
for each row execute function private.align_manual_quote_request_audit_vendors();

create or replace function private.build_quote_request_submission_result(
  p_job_id uuid,
  p_accepted boolean,
  p_created boolean,
  p_deduplicated boolean,
  p_quote_request_id uuid,
  p_quote_run_id uuid,
  p_service_request_line_item_id uuid,
  p_status text,
  p_reason_code text,
  p_reason text,
  p_requested_vendors public.vendor_name[],
  p_quote_mode public.quote_request_mode
)
returns jsonb
language sql
immutable
set search_path = pg_catalog
as $$
  select pg_catalog.jsonb_build_object(
    'jobId', p_job_id,
    'accepted', p_accepted,
    'created', p_created,
    'deduplicated', p_deduplicated,
    'quoteRequestId', p_quote_request_id,
    'quoteRunId', p_quote_run_id,
    'serviceRequestLineItemId', p_service_request_line_item_id,
    'status', p_status,
    'reasonCode', p_reason_code,
    'reason', p_reason,
    'requestedVendors', pg_catalog.to_jsonb(
      case
        when p_quote_mode = 'manual'::public.quote_request_mode
          and coalesce(pg_catalog.cardinality(p_requested_vendors), 0) = 0
          then array['emachineshop']::public.vendor_name[]
        else coalesce(p_requested_vendors, array[]::public.vendor_name[])
      end
    ),
    'quoteMode', p_quote_mode
  );
$$;
