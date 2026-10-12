begin;

-- Source-only until the controlled migration deployment gate is approved.
-- Unknown validity retains the historical selection behavior for a linked offer;
-- a known deadline is inclusive. Never use caller time or transaction-start time.
create or replace function private.quote_offer_valid_at(
  p_valid_until timestamptz,
  p_at timestamptz
)
returns boolean
language sql
immutable
set search_path = pg_catalog
as $$
  select p_at is not null and (p_valid_until is null or p_valid_until >= p_at);
$$;

revoke all on function private.quote_offer_valid_at(timestamptz, timestamptz)
from public, anon, authenticated, service_role;

create or replace function public.api_set_job_selected_vendor_quote_offer(
  p_job_id uuid,
  p_vendor_quote_offer_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_job public.jobs%rowtype;
  v_part_id uuid;
  v_offer public.vendor_quote_offers%rowtype;
begin
  perform public.require_verified_auth();

  select job_row.*
  into v_job
  from public.jobs job_row
  where job_row.id = p_job_id;

  if v_job.id is null then
    raise exception 'Job % not found.', p_job_id;
  end if;

  if not public.user_can_access_job(v_job.id) then
    raise exception 'You do not have access to job %.', p_job_id;
  end if;

  if p_vendor_quote_offer_id is null then
    update public.jobs
    set selected_vendor_quote_offer_id = null,
        updated_at = pg_catalog.timezone('utc', pg_catalog.now())
    where id = v_job.id;

    return v_job.id;
  end if;

  select part.id
  into v_part_id
  from public.parts part
  where part.job_id = v_job.id
  order by part.created_at asc
  limit 1;

  if v_part_id is null then
    raise exception 'Job % has no part revisions yet.', p_job_id;
  end if;

  -- Serialize selection against administrative invalidation. If selection
  -- wins the lock, invalidation clears it before committing; if invalidation
  -- wins, this statement observes the invalidated offer and rejects it.
  select offer.*
  into v_offer
  from public.vendor_quote_offers offer
  join public.vendor_quote_results result
    on result.id = offer.vendor_quote_result_id
  where offer.id = p_vendor_quote_offer_id
    and result.part_id = v_part_id
  for share of offer;

  if v_offer.id is null then
    raise exception 'Offer % is not valid for job %.', p_vendor_quote_offer_id, p_job_id;
  end if;

  if v_offer.invalidated_at is not null then
    raise exception 'Offer % has been invalidated and cannot be selected.', p_vendor_quote_offer_id;
  end if;

  -- Lock the write target before sampling wall time: a queued lock wait may
  -- outlive commercial validity even within a transaction started earlier.
  perform 1 from public.jobs where id = v_job.id for update;
  if not private.quote_offer_valid_at(v_offer.valid_until, pg_catalog.clock_timestamp()) then
    raise exception 'Quote offer has expired and cannot be selected.';
  end if;

  update public.jobs
  set selected_vendor_quote_offer_id = v_offer.id,
      updated_at = pg_catalog.timezone('utc', pg_catalog.now())
  where id = v_job.id;

  return v_job.id;
end;
$$;

revoke all on function public.api_set_job_selected_vendor_quote_offer(uuid, uuid)
from public, anon, authenticated, service_role;
grant execute on function public.api_set_job_selected_vendor_quote_offer(uuid, uuid)
to authenticated;

create or replace function public.api_select_quote_option(
  p_package_id uuid,
  p_option_id uuid,
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_package public.published_quote_packages%rowtype;
  v_option public.published_quote_options%rowtype;
  v_selection_id uuid;
  v_offer public.vendor_quote_offers%rowtype;
begin
  select *
  into v_package
  from public.published_quote_packages
  where id = p_package_id
  for share;

  if v_package.id is null then
    raise exception 'Package % not found', p_package_id;
  end if;

  if not public.user_can_access_package(v_package.id) then
    raise exception 'You do not have access to package %', p_package_id;
  end if;

  select *
  into v_option
  from public.published_quote_options
  where id = p_option_id
    and package_id = p_package_id
  for share;

  if v_option.id is null then
    raise exception 'Option % does not belong to package %', p_option_id, p_package_id;
  end if;

  -- Never substitute another variant when the exact published source is absent.
  select offer.* into v_offer
  from public.vendor_quote_offers offer
  join public.vendor_quote_results result on result.id = offer.vendor_quote_result_id
  join public.parts part on part.id = result.part_id
  where offer.id = v_option.source_vendor_quote_offer_id
    and result.id = v_option.source_vendor_quote_id
    and result.quote_run_id = v_package.quote_run_id
    and part.job_id = v_package.job_id
    and offer.organization_id = v_package.organization_id
    and result.organization_id = v_package.organization_id
    and v_option.organization_id = v_package.organization_id
  for share of offer;

  if v_offer.id is null then
    raise exception 'Published option has no matching source offer and cannot be selected.';
  end if;
  if v_offer.invalidated_at is not null then
    raise exception 'Quote offer has been invalidated and cannot be selected.';
  end if;

  perform 1 from public.jobs where id = v_package.job_id for update;
  if not private.quote_offer_valid_at(v_offer.valid_until, pg_catalog.clock_timestamp()) then
    raise exception 'Quote offer has expired and cannot be selected.';
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

revoke all on function public.api_select_quote_option(uuid, uuid, text)
from public, anon, authenticated, service_role;
grant execute on function public.api_select_quote_option(uuid, uuid, text)
to authenticated;

-- Selection writes must enter through the guarded RPC. Keep SELECT/RLS intact.
revoke insert on public.client_selections from public, anon, authenticated, service_role;
drop policy if exists "client_selections_insert_members" on public.client_selections;

-- Jobs still support unrelated direct edits. Block only non-null selection
-- assignments from API roles; RPCs execute as their privileged owner. This
-- trigger must remain SECURITY INVOKER so current_user is the actual writer.
create or replace function private.guard_direct_job_offer_selection()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $$
begin
  if current_user in ('anon', 'authenticated', 'service_role')
     and new.selected_vendor_quote_offer_id is not null then
    if tg_op = 'INSERT' then
      raise exception 'Select quote offers through the guarded selection API.';
    elsif new.selected_vendor_quote_offer_id is distinct from old.selected_vendor_quote_offer_id then
      raise exception 'Select quote offers through the guarded selection API.';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function private.guard_direct_job_offer_selection()
from public, anon, authenticated, service_role;
create trigger guard_direct_job_offer_selection
before insert or update of selected_vendor_quote_offer_id on public.jobs
for each row execute function private.guard_direct_job_offer_selection();

commit;
