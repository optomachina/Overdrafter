-- OVD-570: reuse organization shipping fields and approved part requested dates.
-- Existing values are inferred. Only an exact, authorized confirmation becomes
-- active; edits and revisions append history and revoke that confirmation.
-- Rollout: apply schema and deploy the matching frontend/worker together; legacy
-- pending permits lack the confirmation revision and fail closed until replaced
-- by a newly reviewed request. This source migration does not deploy the worker.
-- Fingerprints intentionally change when inferred date fields leave scope or
-- a confirmed destination is added. Existing lane/offer evidence stays immutable
-- under its original scope; it must not cover a different confirmed scope.
-- The new scope can become requestable instead of matching an old active/valid/
-- cooldown lane. Audit these expected re-requests and their budgets in the
-- coordinated rollout; this migration itself enqueues no requests.
-- Recovery: fix forward while retaining private history and fail-closed scope
-- checks. Do not restore the old scope builder or delete confirmation evidence.
-- A transaction-abort rehearsal verifies failed application leaves no partial DDL.

create table private.sourcing_destination_history (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  state text not null check (state in ('inferred', 'confirmed')), -- NOSONAR: exact PostgreSQL contract/fixture literal intentionally repeats across independent statements.
  address jsonb not null check (pg_catalog.jsonb_typeof(address) = 'object'), -- NOSONAR: exact PostgreSQL contract/fixture literal intentionally repeats across independent statements.
  actor_id uuid references auth.users(id) on delete set null,
  recorded_at timestamptz not null default pg_catalog.clock_timestamp()
);
create index sourcing_destination_history_current
  on private.sourcing_destination_history (organization_id, id desc);
alter table private.sourcing_destination_history enable row level security;
alter table private.sourcing_destination_history force row level security;
revoke all on private.sourcing_destination_history from public, anon, authenticated, service_role;
revoke all on sequence private.sourcing_destination_history_id_seq from public, anon, authenticated, service_role;

create table private.part_deadline_history (
  id bigint generated always as identity primary key,
  part_id uuid not null references public.parts(id) on delete cascade,
  requirement_id uuid not null references public.approved_part_requirements(id) on delete cascade,
  state text not null check (state in ('inferred', 'confirmed')),
  part_revision text,
  requested_by_date date,
  actor_id uuid references auth.users(id) on delete set null,
  recorded_at timestamptz not null default pg_catalog.clock_timestamp(),
  constraint confirmed_part_deadline_has_date check (state <> 'confirmed' or requested_by_date is not null)
);
create index part_deadline_history_current
  on private.part_deadline_history (part_id, id desc);
alter table private.part_deadline_history enable row level security;
alter table private.part_deadline_history force row level security;
revoke all on private.part_deadline_history from public, anon, authenticated, service_role;
revoke all on sequence private.part_deadline_history_id_seq from public, anon, authenticated, service_role;

create or replace function private.sourcing_address_from_row(p_org public.organizations)
returns jsonb
language sql stable security definer
set search_path = pg_catalog
as $$
  select pg_catalog.jsonb_build_object(
    'street', nullif(pg_catalog.btrim(case when p_org.shipping_same_as_billing then p_org.billing_street else p_org.shipping_street end), ''),
    'city', nullif(pg_catalog.btrim(case when p_org.shipping_same_as_billing then p_org.billing_city else p_org.shipping_city end), ''),
    'region', nullif(pg_catalog.btrim(case when p_org.shipping_same_as_billing then p_org.billing_state else p_org.shipping_state end), ''),
    'postalCode', nullif(pg_catalog.btrim(case when p_org.shipping_same_as_billing then p_org.billing_zip else p_org.shipping_zip end), ''),
    'country', nullif(pg_catalog.btrim(case when p_org.shipping_same_as_billing then p_org.billing_country else p_org.shipping_country end), '') -- NOSONAR: exact PostgreSQL contract/fixture literal intentionally repeats across independent statements.
  );
$$;

create or replace function private.effective_sourcing_address(p_organization_id uuid)
returns jsonb
language sql stable security definer
set search_path = pg_catalog
as $$
  select private.sourcing_address_from_row(org)
  from public.organizations org
  where org.id = p_organization_id;
$$;

create or replace function private.sourcing_address_complete(p_address jsonb)
returns boolean
language sql immutable security definer
set search_path = pg_catalog
as $$
  select p_address is not null
    and pg_catalog.jsonb_typeof(p_address) = 'object'
    and nullif(pg_catalog.btrim(p_address ->> 'street'), '') is not null
    and nullif(pg_catalog.btrim(p_address ->> 'city'), '') is not null
    and nullif(pg_catalog.btrim(p_address ->> 'postalCode'), '') is not null
    and nullif(pg_catalog.btrim(p_address ->> 'country'), '') is not null
    and (p_address ->> 'country' <> 'US'
      or nullif(pg_catalog.btrim(p_address ->> 'region'), '') is not null);
$$;

insert into private.sourcing_destination_history (organization_id, state, address)
select org.id, 'inferred', private.sourcing_address_from_row(org)
from public.organizations org;

create or replace function private.record_sourcing_address_change()
returns trigger
language plpgsql security definer
set search_path = pg_catalog
as $$
declare
  v_address jsonb := private.sourcing_address_from_row(new);
begin
  if tg_op = 'INSERT' then
    insert into private.sourcing_destination_history (organization_id, state, address, actor_id)
    values (new.id, 'inferred', v_address, auth.uid());
  elsif v_address is distinct from private.sourcing_address_from_row(old) then
    insert into private.sourcing_destination_history (organization_id, state, address, actor_id)
    values (new.id, 'inferred', v_address, auth.uid());
  end if;
  return new;
end;
$$;
create trigger record_sourcing_address_change
after insert or update on public.organizations
for each row execute function private.record_sourcing_address_change();

create or replace function private.current_confirmed_sourcing_address(p_organization_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog
as $$
declare
  v_latest private.sourcing_destination_history%rowtype;
  v_current jsonb := private.effective_sourcing_address(p_organization_id);
begin
  select * into v_latest
  from private.sourcing_destination_history history
  where history.organization_id = p_organization_id
  order by history.id desc limit 1;

  if v_latest.state = 'confirmed'
    and v_latest.address = v_current
    and private.sourcing_address_complete(v_current) then
    return v_current || pg_catalog.jsonb_build_object(
      'state', 'confirmed', 'confirmationRevision', v_latest.id::text -- NOSONAR: exact PostgreSQL contract/fixture literal intentionally repeats across independent statements.
    );
  end if;
  return null;
end;
$$;

create or replace function private.require_confirmed_sourcing_destination(p_organization_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog
as $$
declare
  v_address jsonb := private.current_confirmed_sourcing_address(p_organization_id);
begin
  if v_address is null then
    raise exception 'sourcing_destination_confirmation_required';
  end if;
  return v_address;
end;
$$;

create or replace function public.api_get_sourcing_destination(p_organization_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog
as $$
declare
  v_address jsonb;
  v_confirmed jsonb;
begin
  perform public.require_verified_auth();
  if not public.user_can_access_org(p_organization_id) then
    raise exception 'sourcing_destination_access_denied'; -- NOSONAR: exact PostgreSQL contract/fixture literal intentionally repeats across independent statements.
  end if;
  v_address := private.effective_sourcing_address(p_organization_id);
  v_confirmed := private.current_confirmed_sourcing_address(p_organization_id);
  return pg_catalog.jsonb_build_object(
    'address', v_address,
    'state', case when v_confirmed is null then 'inferred' else 'confirmed' end
  );
end;
$$;

create or replace function public.api_confirm_sourcing_destination(
  p_organization_id uuid,
  p_expected_address jsonb
)
returns bigint
language plpgsql security definer
set search_path = pg_catalog
as $$
declare
  v_org public.organizations%rowtype;
  v_address jsonb;
  v_event_id bigint;
begin
  perform public.require_verified_auth();
  if not public.is_org_admin(p_organization_id) then
    raise exception 'sourcing_destination_access_denied';
  end if;
  select * into v_org from public.organizations where id = p_organization_id for update;
  -- Lock waits can outlive a membership or verified-auth revocation.
  perform public.require_verified_auth();
  if v_org.id is null or not public.is_org_admin(p_organization_id) then
    raise exception 'sourcing_destination_access_denied';
  end if;
  v_address := private.sourcing_address_from_row(v_org);
  if p_expected_address is distinct from v_address then
    raise exception 'sourcing_destination_changed';
  end if;
  if not private.sourcing_address_complete(v_address) then
    raise exception 'sourcing_destination_incomplete';
  end if;
  insert into private.sourcing_destination_history (organization_id, state, address, actor_id)
  values (p_organization_id, 'confirmed', v_address, auth.uid())
  returning id into v_event_id;
  return v_event_id;
end;
$$;

insert into private.part_deadline_history (
  part_id, requirement_id, state, part_revision, requested_by_date
)
select requirement.part_id, requirement.id, 'inferred', requirement.revision, requirement.requested_by_date
from public.approved_part_requirements requirement;

create or replace function private.record_part_deadline_change()
returns trigger
language plpgsql security definer
set search_path = pg_catalog
as $$
begin
  if tg_op = 'INSERT' then
    insert into private.part_deadline_history (
      part_id, requirement_id, state, part_revision, requested_by_date, actor_id
    ) values (
      new.part_id, new.id, 'inferred', new.revision, new.requested_by_date, auth.uid()
    );
  elsif new.revision is distinct from old.revision
    or new.requested_by_date is distinct from old.requested_by_date then
    insert into private.part_deadline_history (
      part_id, requirement_id, state, part_revision, requested_by_date, actor_id
    ) values (
      new.part_id, new.id, 'inferred', new.revision, new.requested_by_date, auth.uid()
    );
  end if;
  return new;
end;
$$;
create trigger record_part_deadline_change
after insert or update on public.approved_part_requirements
for each row execute function private.record_part_deadline_change();

create or replace function private.current_confirmed_part_deadline(
  p_part_id uuid,
  p_at_date date default current_date
)
returns date
language plpgsql stable security definer
set search_path = pg_catalog
as $$
declare
  v_requirement public.approved_part_requirements%rowtype;
  v_latest private.part_deadline_history%rowtype;
begin
  select * into v_requirement
  from public.approved_part_requirements requirement
  where requirement.part_id = p_part_id;
  select * into v_latest
  from private.part_deadline_history history
  where history.part_id = p_part_id
  order by history.id desc limit 1;

  if v_latest.state = 'confirmed'
    and v_latest.requirement_id = v_requirement.id
    and v_latest.part_revision is not distinct from v_requirement.revision
    and v_latest.requested_by_date is not distinct from v_requirement.requested_by_date
    and v_latest.requested_by_date >= p_at_date then
    return v_latest.requested_by_date;
  end if;
  return null;
end;
$$;

create or replace function public.api_get_part_deadline(p_part_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog
as $$
declare
  v_part public.parts%rowtype;
  v_requirement public.approved_part_requirements%rowtype;
  v_latest private.part_deadline_history%rowtype;
  v_active date;
begin
  perform public.require_verified_auth();
  select * into v_part from public.parts where id = p_part_id;
  if v_part.id is null or not public.user_can_access_job(v_part.job_id) then
    raise exception 'part_deadline_access_denied'; -- NOSONAR: exact PostgreSQL contract/fixture literal intentionally repeats across independent statements.
  end if;
  select * into v_requirement
  from public.approved_part_requirements where part_id = p_part_id;
  select * into v_latest
  from private.part_deadline_history where part_id = p_part_id order by id desc limit 1;
  v_active := private.current_confirmed_part_deadline(p_part_id);
  return pg_catalog.jsonb_build_object(
    'partId', p_part_id,
    'revision', v_requirement.revision,
    'recordedDate', v_requirement.requested_by_date,
    'activeDate', v_active,
    'state', case
      when v_active is not null then 'confirmed'
      when v_latest.state = 'confirmed' and v_latest.requested_by_date < current_date then 'expired'
      else 'inferred' end
  );
end;
$$;

create or replace function public.api_confirm_part_deadline(
  p_part_id uuid,
  p_expected_revision text,
  p_expected_date date
)
returns bigint
language plpgsql security definer
set search_path = pg_catalog
as $$
declare
  v_part public.parts%rowtype;
  v_requirement public.approved_part_requirements%rowtype;
  v_event_id bigint;
begin
  perform public.require_verified_auth();
  select * into v_part from public.parts where id = p_part_id;
  if v_part.id is null or not public.user_can_edit_job(v_part.job_id) then
    raise exception 'part_deadline_access_denied';
  end if;
  select * into v_requirement
  from public.approved_part_requirements
  where part_id = p_part_id for update;
  -- Refresh both the part's job and access after waiting on the requirement.
  perform public.require_verified_auth();
  select * into v_part from public.parts where id = p_part_id;
  if v_part.id is null or not public.user_can_edit_job(v_part.job_id) then
    raise exception 'part_deadline_access_denied';
  end if;
  if v_requirement.id is null
    or v_requirement.revision is distinct from p_expected_revision
    or v_requirement.requested_by_date is distinct from p_expected_date then
    raise exception 'part_deadline_changed';
  end if;
  if p_expected_date is null or p_expected_date < current_date then
    raise exception 'part_deadline_expired';
  end if;
  insert into private.part_deadline_history (
    part_id, requirement_id, state, part_revision, requested_by_date, actor_id
  ) values (
    p_part_id, v_requirement.id, 'confirmed', v_requirement.revision,
    v_requirement.requested_by_date, auth.uid()
  ) returning id into v_event_id;
  return v_event_id;
end;
$$;

-- The existing specification may contain a historical or inferred date. Keep
-- the active confirmed deadline only in requestedDeliveryDate, never in a
-- second unconfirmed JSON field sent as part of a provider scope.
create or replace function private.sourcing_scope_specification(p_snapshot jsonb)
returns jsonb
language sql immutable security definer
set search_path = pg_catalog
as $$
  select case
    when pg_catalog.jsonb_typeof(coalesce(p_snapshot, '{}'::jsonb) -> 'shipping') = 'object'
      then pg_catalog.jsonb_set(
        coalesce(p_snapshot, '{}'::jsonb) - 'requestedByDate',
        '{shipping}',
        (p_snapshot -> 'shipping') - 'requestedByDateOverride',
        false
      )
    else coalesce(p_snapshot, '{}'::jsonb) - 'requestedByDate'
  end;
$$;

create or replace function private.build_quote_lane_scope_snapshot(
  p_part_id uuid,
  p_vendor public.vendor_name,
  p_requested_quantity integer
)
returns jsonb
language sql stable security definer
set search_path = pg_catalog
as $$
  select pg_catalog.jsonb_build_object(
      'schema', 'quote-lane-scope.v1',
      'vendor', p_vendor,
      'quantity', p_requested_quantity,
      'part', pg_catalog.jsonb_build_object(
        'id', part.id,
        'cad', case when cad_file.id is null then null else pg_catalog.jsonb_build_object(
          'fileId', cad_file.id,
          'sha256', cad_file.trusted_content_sha256,
          'name', cad_file.original_name,
          'mimeType', cad_file.mime_type,
          'sizeBytes', cad_file.size_bytes
        ) end,
        'drawing', case when drawing_file.id is null then null else pg_catalog.jsonb_build_object(
          'fileId', drawing_file.id,
          'sha256', drawing_file.trusted_content_sha256,
          'name', drawing_file.original_name,
          'mimeType', drawing_file.mime_type,
          'sizeBytes', drawing_file.size_bytes
        ) end
      ),
      'requirements', pg_catalog.jsonb_build_object(
        'id', requirement.id,
        'capturedAt', requirement.updated_at,
        'description', requirement.description,
        'partNumber', requirement.part_number,
        'revision', requirement.revision,
        'material', requirement.material,
        'finish', requirement.finish,
        'tightestToleranceInch', requirement.tightest_tolerance_inch,
        'requestedDeliveryDate', private.current_confirmed_part_deadline(part.id),
        'specification', private.sourcing_scope_specification(requirement.spec_snapshot)
      )
    ) || case when private.current_confirmed_sourcing_address(part.organization_id) is null
      then '{}'::jsonb
      else pg_catalog.jsonb_build_object(
        'destination', private.current_confirmed_sourcing_address(part.organization_id)
      ) end
  from public.parts part
  join public.approved_part_requirements requirement on requirement.part_id = part.id
  left join public.job_files cad_file on cad_file.id = part.cad_file_id
  left join public.job_files drawing_file on drawing_file.id = part.drawing_file_id
  where part.id = p_part_id;
$$;

-- Xometry requires an exact shipping destination for its controlled beta.
-- This is the shared candidate path used by preview, permit, and the worker's
-- immediate pre-disclosure check. Other providers retain their own admission
-- policy; no new provider route is enabled here.
create or replace function private.quote_lane_candidates(
  p_job_id uuid,
  p_selected_vendors public.vendor_name[] default null
)
returns table (
  organization_id uuid,
  part_id uuid,
  vendor public.vendor_name,
  requested_quantity integer,
  scope_version integer,
  scope_fingerprint text,
  scope_snapshot jsonb
)
language sql stable security definer
set search_path = pg_catalog
as $$
  with requested as (
    select case
      when p_selected_vendors is null then public.get_enabled_client_quote_vendors(job.organization_id)
      else p_selected_vendors
    end as vendors
    from public.jobs job
    where job.id = p_job_id
  ), candidate as (
    select
      part.organization_id,
      part.id as part_id,
      selected_vendor.vendor,
      quantity.value as requested_quantity,
      1 as scope_version,
      private.build_quote_lane_scope_snapshot(part.id, selected_vendor.vendor, quantity.value) as scope_snapshot
    from public.parts part
    join public.approved_part_requirements requirement on requirement.part_id = part.id
    cross join requested
    cross join lateral unnest(coalesce(requested.vendors, array[]::public.vendor_name[]))
      as selected_vendor(vendor)
    cross join lateral unnest(
      public.normalize_positive_integer_array(requirement.quote_quantities, requirement.quantity)
    ) as quantity(value)
    where part.job_id = p_job_id
      and selected_vendor.vendor = any(requirement.applicable_vendors)
      and (
        selected_vendor.vendor <> 'xometry'::public.vendor_name
        or private.current_confirmed_sourcing_address(part.organization_id) is not null
      )
  )
  select
    candidate.organization_id,
    candidate.part_id,
    candidate.vendor,
    candidate.requested_quantity,
    candidate.scope_version,
    private.quote_scope_fingerprint(candidate.scope_snapshot),
    candidate.scope_snapshot
  from candidate;
$$;

-- Service workers need the same current confirmation state as the candidate
-- while independently binding staged file digests and approved requirements.
create or replace function public.api_get_worker_sourcing_intent(
  p_job_id uuid,
  p_part_id uuid
)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog
as $$
declare
  v_part public.parts%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception 'worker_sourcing_intent_service_role_required';
  end if;
  select * into v_part from public.parts where id = p_part_id;
  if v_part.id is null or v_part.job_id <> p_job_id then
    raise exception 'worker_sourcing_intent_part_mismatch';
  end if;
  return pg_catalog.jsonb_build_object(
    'destination', private.current_confirmed_sourcing_address(v_part.organization_id),
    'activeDeadline', private.current_confirmed_part_deadline(v_part.id)
  );
end;
$$;

revoke all on function private.sourcing_address_from_row(public.organizations) from public, anon, authenticated, service_role;
revoke all on function private.effective_sourcing_address(uuid) from public, anon, authenticated, service_role;
revoke all on function private.sourcing_address_complete(jsonb) from public, anon, authenticated, service_role;
revoke all on function private.record_sourcing_address_change() from public, anon, authenticated, service_role;
revoke all on function private.current_confirmed_sourcing_address(uuid) from public, anon, authenticated, service_role;
revoke all on function private.require_confirmed_sourcing_destination(uuid) from public, anon, authenticated, service_role;
revoke all on function private.record_part_deadline_change() from public, anon, authenticated, service_role;
revoke all on function private.current_confirmed_part_deadline(uuid,date) from public, anon, authenticated, service_role;
revoke all on function private.sourcing_scope_specification(jsonb) from public, anon, authenticated, service_role;
revoke all on function private.build_quote_lane_scope_snapshot(uuid,public.vendor_name,integer) from public, anon, authenticated, service_role;
revoke all on function private.quote_lane_candidates(uuid,public.vendor_name[]) from public, anon, authenticated, service_role;

revoke all on function public.api_get_sourcing_destination(uuid) from public, anon, service_role;
revoke all on function public.api_confirm_sourcing_destination(uuid,jsonb) from public, anon, service_role;
revoke all on function public.api_get_part_deadline(uuid) from public, anon, service_role;
revoke all on function public.api_confirm_part_deadline(uuid,text,date) from public, anon, service_role;
grant execute on function public.api_get_sourcing_destination(uuid) to authenticated;
grant execute on function public.api_confirm_sourcing_destination(uuid,jsonb) to authenticated;
grant execute on function public.api_get_part_deadline(uuid) to authenticated;
grant execute on function public.api_confirm_part_deadline(uuid,text,date) to authenticated;
revoke all on function public.api_get_worker_sourcing_intent(uuid,uuid) from public, anon, authenticated;
grant execute on function public.api_get_worker_sourcing_intent(uuid,uuid) to service_role;
