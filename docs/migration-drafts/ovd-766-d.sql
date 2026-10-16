-- OVD-766 group d (tracked as OVD-770): quote selection RPCs require a verified
-- caller with edit rights on the job.
--
-- DRAFT ONLY. Not a migration and not applied anywhere. It needs a
-- Blaine-approved migration window before it is promoted into
-- supabase/migrations. Rollback: docs/migration-drafts/ovd-766-d.rollback.sql.
-- pgTAP: supabase/tests/pending/ovd766_d_guards.sql.pending (rename to
-- supabase/tests/ovd766_d_guards.sql in the promoting change).
--
-- Idempotent: every statement is create or replace, revoke, or grant, so it can
-- run more than once and in either order with the OVD-736 anon revoke. Both
-- functions already lack anon and PUBLIC EXECUTE since
-- 20261002041305_enforce_quote_selection_expiry.sql; the revoke below restates it.
--
-- Source of each body: 20261002041305_enforce_quote_selection_expiry.sql (the
-- latest definition of both). What changes:
--   * api_set_job_selected_vendor_quote_offer: user_can_access_job ->
--     user_can_edit_job. It already called require_verified_auth.
--   * api_select_quote_option: adds require_verified_auth before any read or
--     lock, and user_can_access_package -> user_can_edit_job(v_package.job_id).
--   * Both: set search_path = '' (was pg_catalog) with every reference schema
--     qualified, including the job_status cast.
-- Error messages, lookup order, locking, expiry and invalidation checks, writes
-- and the audit event are unchanged. user_can_edit_job itself is not changed
-- (finding 5 is held for Blaine); today it grants every org member and every
-- project owner/editor, so legitimate callers see no difference.
begin;

create or replace function public.api_set_job_selected_vendor_quote_offer(
  p_job_id uuid,
  p_vendor_quote_offer_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
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

  if not public.user_can_edit_job(v_job.id) then
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
set search_path = ''
as $$
declare
  v_package public.published_quote_packages%rowtype;
  v_option public.published_quote_options%rowtype;
  v_selection_id uuid;
  v_offer public.vendor_quote_offers%rowtype;
begin
  -- Refuse unverified callers before taking any row lock.
  perform public.require_verified_auth();

  select *
  into v_package
  from public.published_quote_packages
  where id = p_package_id
  for share;

  if v_package.id is null then
    raise exception 'Package % not found', p_package_id;
  end if;

  if not public.user_can_edit_job(v_package.job_id) then
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
  set status = 'client_selected'::public.job_status
  where id = v_package.job_id;

  perform public.log_audit_event(
    v_package.organization_id,
    'client.quote_option_selected',
    pg_catalog.jsonb_build_object('selectionId', v_selection_id, 'optionId', p_option_id),
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

commit;
