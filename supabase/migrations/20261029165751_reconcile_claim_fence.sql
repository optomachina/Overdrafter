-- S1.1b stage A: additive only. Rollback callers before retiring these RPCs;
-- retain immutable receipts and pending follow-ups throughout caller rollback.
-- Down path: supabase/rollbacks/20261029165751_reconcile_claim_fence.rollback.sql
-- Both public RPCs must run as standalone READ COMMITTED transactions: their
-- SET CONSTRAINTS ALL IMMEDIATE affects the rest of the caller transaction.
set local lock_timeout = '1s';
create table if not exists private.vendor_quote_acceptance_receipts (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  work_queue_task_id uuid not null,
  claim_locked_by text,
  claim_locked_at timestamptz not null,
  claim_attempts integer not null,
  vendor_quote_result_id uuid not null,
  quote_run_id uuid,
  job_id uuid,
  payload_digest text not null,
  outcome text not null check (outcome in ('accepted', 'request_canceled')),
  created_at timestamptz not null default pg_catalog.timezone('utc', pg_catalog.now()),
  unique (work_queue_task_id, claim_attempts, claim_locked_at)
);
create function private.reject_vendor_quote_acceptance_receipt_mutation()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'Vendor quote acceptance receipts are append-only.';
end;
$$;
revoke all on function private.reject_vendor_quote_acceptance_receipt_mutation()
from public, anon, authenticated, service_role;
create trigger vendor_quote_acceptance_receipts_append_only
before update or delete on private.vendor_quote_acceptance_receipts
for each row execute function private.reject_vendor_quote_acceptance_receipt_mutation();

create table if not exists private.quote_run_rollup_followups (
  id bigint generated always as identity primary key,
  receipt_id uuid not null unique,
  job_id uuid not null,
  quote_run_id uuid not null,
  created_at timestamptz not null default pg_catalog.timezone('utc', pg_catalog.now()),
  processed_at timestamptz
);
create index if not exists quote_run_rollup_followups_pending on private.quote_run_rollup_followups(id)
where processed_at is null;
alter table private.vendor_quote_acceptance_receipts enable row level security;
alter table private.quote_run_rollup_followups enable row level security;
revoke all on private.vendor_quote_acceptance_receipts, private.quote_run_rollup_followups
from public, anon, authenticated, service_role;
revoke all on sequence private.quote_run_rollup_followups_id_seq from public, anon, authenticated, service_role;

-- Exact legacy mutation body, with fencing/finalization owned by the caller.
create function private.apply_vendor_quote_result_offers(
  p_vendor_quote_result_id uuid, p_result jsonb, p_offers jsonb
) returns void language plpgsql set search_path = '' as $$
declare v_offers jsonb := coalesce(p_offers, '[]'::jsonb);
begin
  if pg_catalog.jsonb_typeof(p_result) <> 'object' then
    raise exception 'Vendor quote result finalization must be a JSON object.';
  end if;

  if pg_catalog.jsonb_typeof(v_offers) <> 'array' then
    raise exception 'Vendor quote offers must be a JSON array.';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(v_offers) as entry(value)
    where nullif(entry.value ->> 'vendor_quote_result_id', '')::uuid
      is distinct from p_vendor_quote_result_id
  ) then
    raise exception 'Every offer must belong to vendor quote result %.', p_vendor_quote_result_id;
  end if;

  update public.vendor_quote_results
  set status = (p_result ->> 'status')::public.vendor_status,
      unit_price_usd = (p_result ->> 'unit_price_usd')::numeric,
      total_price_usd = (p_result ->> 'total_price_usd')::numeric,
      lead_time_business_days = (p_result ->> 'lead_time_business_days')::integer,
      quote_url = p_result ->> 'quote_url',
      dfm_issues = p_result -> 'dfm_issues',
      notes = p_result -> 'notes',
      raw_payload = p_result -> 'raw_payload',
      updated_at = pg_catalog.timezone('utc', pg_catalog.now())
  where id = p_vendor_quote_result_id;

  if not found then
    raise exception 'Vendor quote result % was not found.', p_vendor_quote_result_id;
  end if;

  insert into public.vendor_quote_offers (
    vendor_quote_result_id,
    organization_id,
    offer_key,
    supplier,
    lane_label,
    sourcing,
    geographic_origin,
    tier,
    quote_ref,
    quote_date,
    quoted_at,
    valid_until,
    validity_duration_days,
    validity_source,
    validity_terms,
    provenance_status,
    unit_price_usd,
    total_price_usd,
    lead_time_business_days,
    ship_receive_by,
    process,
    material,
    finish,
    tightest_tolerance,
    notes,
    sort_rank,
    raw_payload
  )
  select
    offer.vendor_quote_result_id,
    offer.organization_id,
    offer.offer_key,
    offer.supplier,
    offer.lane_label,
    offer.sourcing,
    offer.geographic_origin,
    offer.tier,
    offer.quote_ref,
    offer.quote_date,
    offer.quoted_at,
    offer.valid_until,
    offer.validity_duration_days,
    offer.validity_source,
    offer.validity_terms,
    offer.provenance_status,
    offer.unit_price_usd,
    offer.total_price_usd,
    offer.lead_time_business_days,
    offer.ship_receive_by,
    offer.process,
    offer.material,
    offer.finish,
    offer.tightest_tolerance,
    offer.notes,
    offer.sort_rank,
    offer.raw_payload
  from pg_catalog.jsonb_populate_recordset(
    null::public.vendor_quote_offers,
    v_offers
  ) as offer
  on conflict (vendor_quote_result_id, offer_key) do update
  set organization_id = excluded.organization_id,
      supplier = excluded.supplier,
      lane_label = excluded.lane_label,
      sourcing = excluded.sourcing,
      geographic_origin = excluded.geographic_origin,
      tier = excluded.tier,
      quote_ref = excluded.quote_ref,
      quote_date = excluded.quote_date,
      quoted_at = excluded.quoted_at,
      valid_until = excluded.valid_until,
      validity_duration_days = excluded.validity_duration_days,
      validity_source = excluded.validity_source,
      validity_terms = excluded.validity_terms,
      provenance_status = excluded.provenance_status,
      unit_price_usd = excluded.unit_price_usd,
      total_price_usd = excluded.total_price_usd,
      lead_time_business_days = excluded.lead_time_business_days,
      ship_receive_by = excluded.ship_receive_by,
      process = excluded.process,
      material = excluded.material,
      finish = excluded.finish,
      tightest_tolerance = excluded.tightest_tolerance,
      notes = excluded.notes,
      sort_rank = excluded.sort_rank,
      raw_payload = excluded.raw_payload,
      updated_at = pg_catalog.timezone('utc', pg_catalog.now());

  delete from public.vendor_quote_offers as existing
  where existing.vendor_quote_result_id = p_vendor_quote_result_id
    and not exists (
      select 1
      from pg_catalog.jsonb_array_elements(v_offers) as entry(value)
      where entry.value ->> 'offer_key' = existing.offer_key
    );
end;
$$;
revoke all on function private.apply_vendor_quote_result_offers(uuid,jsonb,jsonb)
from public, anon, authenticated, service_role;

-- Discovery only. Conflicting authoritative linkages fail closed; never use
-- payload IDs, including vendorQuoteResultId and quoteRequestId.
create function private.vendor_quote_acceptance_request_ids(p_result_id uuid)
returns uuid[] language sql stable set search_path = '' as $$
  select coalesce(pg_catalog.array_agg(distinct id order by id) filter (where id is not null), '{}'::uuid[])
  from (
    select run.quote_request_id as id from public.vendor_quote_results result
      join public.quote_runs run on run.id = result.quote_run_id where result.id = p_result_id
    union all
    select quote_request_id from private.quote_access_admissions where quote_run_id =
      (select quote_run_id from public.vendor_quote_results where id = p_result_id)
    union all
    select quote_request_id from private.xometry_beta_dispatch_permits where vendor_quote_result_id = p_result_id
    union all
    select quote_request_id from private.provider_dispatch_permits where vendor_quote_result_id = p_result_id
    union all
    select quote_request_id from public.quote_request_lanes where vendor_quote_result_id = p_result_id
  ) links;
$$;
revoke all on function private.vendor_quote_acceptance_request_ids(uuid)
from public, anon, authenticated, service_role;

-- Acceptance reads a run's job without locking the run; its binding must stay fixed.
create function private.reject_quote_run_job_reassignment()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.job_id is distinct from old.job_id then
    raise exception 'Quote run job_id is immutable.';
  end if;
  return new;
end;
$$;
revoke all on function private.reject_quote_run_job_reassignment()
from public, anon, authenticated, service_role;
create trigger quote_runs_job_id_immutable
before update on public.quote_runs
for each row execute function private.reject_quote_run_job_reassignment();

create function public.accept_vendor_quote_result(
  p_task_id uuid, p_locked_by text, p_locked_at timestamptz, p_attempts integer,
  p_vendor_quote_result_id uuid, p_result jsonb, p_offers jsonb,
  p_task_payload_patch jsonb default '{}'
) returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '1s' as $$
declare
  v_digest text := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
    'vendor_quote_result_id', p_vendor_quote_result_id, 'result', p_result,
    'offers', coalesce(p_offers, '[]'::jsonb),
    'task_payload_patch', coalesce(p_task_payload_patch, '{}'::jsonb))::text, 'UTF8')), 'hex');
  v_receipt private.vendor_quote_acceptance_receipts%rowtype;
  v_result public.vendor_quote_results%rowtype;
  v_task public.work_queue%rowtype;
  v_request public.quote_requests%rowtype;
  v_run public.quote_runs%rowtype;
  v_admission private.quote_access_admissions%rowtype;
  v_requests uuid[];
  v_outcome text;
  v_followup bigint;
begin
  select * into v_receipt from private.vendor_quote_acceptance_receipts
  where work_queue_task_id = p_task_id and claim_attempts = p_attempts and claim_locked_at = p_locked_at;
  if found then
    return case when v_receipt.claim_locked_by is not distinct from p_locked_by and v_receipt.payload_digest = v_digest
      then pg_catalog.jsonb_build_object('outcome', 'replayed', 'original_outcome', v_receipt.outcome, 'receipt_id', v_receipt.id)
      else pg_catalog.jsonb_build_object('outcome', 'payload_mismatch', 'receipt_id', v_receipt.id) end;
  end if;
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'vendor_quote_acceptance_requires_read_committed';
  end if;
  begin
    select * into v_result from public.vendor_quote_results where id = p_vendor_quote_result_id for update nowait;
    if not found then return pg_catalog.jsonb_build_object('outcome', 'stale'); end if;
    v_requests := private.vendor_quote_acceptance_request_ids(v_result.id);
    if pg_catalog.cardinality(v_requests) > 1 then return pg_catalog.jsonb_build_object('outcome', 'stale'); end if;
    select * into v_request from public.quote_requests where id = v_requests[1] for update nowait;
    select * into v_task from public.work_queue where id = p_task_id for update nowait;

    -- Actual UPDATE/status footprint (catalog at 20261025194414):
    -- fence_free_quote_result locks request; sync_quote_request_status_on_vendor_result
    -- calls sync_quote_request_status_for_run, UPDATEs request; its service-line
    -- trigger UPDATEs service_request_line_items. reset_job_after_manual_quote_cancellation
    -- only writes job on a transition TO canceled (not made by this reducer).
    -- Deferred settle_terminal_free_quote_result calls finalize_free_quote_job:
    -- locks request + quote_access_admissions, reads permit/lane/result/offers
    -- and quote_lane_candidates (job, scope parts/requirements/files), writes admission.
    -- Offer anchor/normalize/touch triggers only read result / alter NEW.
    -- Offer INSERT/UPSERT FKs take KEY SHARE on result + supplied organization;
    -- invalidated_by is preserved, never assigned. Result FK keys never change.
    -- Stale-offer DELETE has ON DELETE SET NULL into jobs.selected_vendor_quote_offer_id,
    -- quote_request_lanes.cooldown_released_by_offer_id and published_quote_options.
    -- Their touch/selection triggers add no row locks. New receipts/outbox have no FKs.
    --
    -- Legacy reconcile writers lock/update this result before writing its offers;
    -- holding the result FOR UPDATE serializes absent offer keys too. S2.4
    -- importers are a documented bypass, outside this legacy-writer guarantee.
    -- New incoming offer FKs require KEY SHARE on the offer rows held FOR UPDATE,
    -- so they cannot race stale-offer deletion. No explicit table locks are needed.
    -- finalize_free_quote_job and its quote_lane_candidates/scope helpers only
    -- read jobs, runs, parts, requirements and files; none locks or writes them.
    -- Acceptance/result/offer triggers do not lock or write quote_runs either.
    -- Only referencing jobs need prelocks for stale-offer ON DELETE SET NULL;
    -- the run's own job is read only. Organization INSERT FKs need KEY SHARE.
    -- Final-strength row prelocks, table order from the plan, IDs within each table.
    perform 1 from private.xometry_beta_dispatch_permits where vendor_quote_result_id = v_result.id
      or work_queue_task_id = p_task_id order by id for update nowait;
    perform 1 from private.provider_dispatch_permits where vendor_quote_result_id = v_result.id
      or work_queue_task_id = p_task_id order by id for update nowait;
    select * into v_run from public.quote_runs where id = v_result.quote_run_id;
    perform 1 from public.jobs where selected_vendor_quote_offer_id in
      (select id from public.vendor_quote_offers where vendor_quote_result_id = v_result.id)
      order by id for update nowait;
    perform 1 from public.quote_request_lanes where vendor_quote_result_id = v_result.id
      or cooldown_released_by_offer_id in
      (select id from public.vendor_quote_offers where vendor_quote_result_id = v_result.id)
      order by id for update nowait;
    perform 1 from public.service_request_line_items where id = v_request.service_request_line_item_id
      order by id for update nowait;
    perform 1 from public.organizations where id = v_result.organization_id or id in
      (select (entry->>'organization_id')::uuid from pg_catalog.jsonb_array_elements(
        case when pg_catalog.jsonb_typeof(p_offers) = 'array' then p_offers else '[]'::jsonb end) entry)
      order by id for key share nowait;
    perform 1 from public.vendor_quote_offers where vendor_quote_result_id = v_result.id
      order by id for update nowait;
    perform 1 from public.published_quote_options where source_vendor_quote_offer_id in
      (select id from public.vendor_quote_offers where vendor_quote_result_id = v_result.id)
      order by id for update nowait;
    perform 1 from private.quote_access_admissions where quote_run_id = v_result.quote_run_id
      order by id for update nowait;

    -- Fresh authoritative re-read after the complete footprint is held.
    select * into v_result from public.vendor_quote_results where id = p_vendor_quote_result_id;
    select * into v_task from public.work_queue where id = p_task_id;
    select * into v_run from public.quote_runs where id = v_result.quote_run_id;
    select * into v_request from public.quote_requests where id = v_requests[1];
    select * into v_admission from private.quote_access_admissions where quote_run_id = v_result.quote_run_id;
    select * into v_receipt from private.vendor_quote_acceptance_receipts
      where work_queue_task_id = p_task_id and claim_attempts = p_attempts and claim_locked_at = p_locked_at;
    if found then
      return case when v_receipt.claim_locked_by is not distinct from p_locked_by and v_receipt.payload_digest = v_digest
        then pg_catalog.jsonb_build_object('outcome', 'replayed', 'original_outcome', v_receipt.outcome, 'receipt_id', v_receipt.id)
        else pg_catalog.jsonb_build_object('outcome', 'payload_mismatch', 'receipt_id', v_receipt.id) end;
    end if;
    if v_task.id is null or v_task.status <> 'running' or v_task.locked_by is distinct from p_locked_by
      or v_task.locked_at is distinct from p_locked_at or p_locked_at is null
      or v_task.attempts is distinct from p_attempts or v_task.task_type <> 'run_vendor_quote'
      or v_task.organization_id is distinct from v_result.organization_id
      or v_task.quote_run_id is distinct from v_result.quote_run_id
      or v_run.organization_id is distinct from v_result.organization_id
      or not exists (select 1 from public.jobs where id = v_run.job_id and organization_id = v_result.organization_id)
      or not exists (select 1 from public.parts where id = v_result.part_id and job_id = v_run.job_id
        and organization_id = v_result.organization_id)
      or v_task.job_id is distinct from v_run.job_id or v_task.part_id is distinct from v_result.part_id
      or (not exists (select 1 from private.xometry_beta_dispatch_permits where work_queue_task_id = p_task_id)
        and not exists (select 1 from private.provider_dispatch_permits where work_queue_task_id = p_task_id)
        and case when nullif(v_task.payload->>'vendor', '') is not null
          and nullif(v_task.payload->>'requestedQuantity', '') is not null
        then v_result.vendor::text is distinct from v_task.payload->>'vendor'
          or pg_catalog.to_jsonb(v_result.requested_quantity) is distinct from v_task.payload->'requestedQuantity'
        else (select pg_catalog.count(*) from public.vendor_quote_results where quote_run_id = v_task.quote_run_id
          and part_id = v_task.part_id) <> 1 end)
      or v_requests is distinct from private.vendor_quote_acceptance_request_ids(v_result.id)
      or (v_request.id is not null and (v_request.job_id is distinct from v_run.job_id
        or v_request.organization_id is distinct from v_result.organization_id))
      or exists (
        select 1 from (
          select work_queue_task_id, vendor_quote_result_id, organization_id, job_id,
            quote_run_id, part_id, provider, 1 requested_quantity, quote_request_id, quote_request_lane_id
          from private.xometry_beta_dispatch_permits
          union all
          select work_queue_task_id, vendor_quote_result_id, organization_id, job_id,
            quote_run_id, part_id, provider, requested_quantity, quote_request_id, quote_request_lane_id
          from private.provider_dispatch_permits
        ) permit where (permit.work_queue_task_id = p_task_id or permit.vendor_quote_result_id = v_result.id)
        and ((permit.work_queue_task_id, permit.vendor_quote_result_id, permit.organization_id,
          permit.job_id, permit.quote_run_id, permit.part_id, permit.provider, permit.requested_quantity, permit.quote_request_id)
          is distinct from (p_task_id, v_result.id, v_result.organization_id, v_run.job_id,
            v_run.id, v_result.part_id, v_result.vendor, v_result.requested_quantity, v_request.id)
          or not exists (select 1 from public.quote_request_lanes lane
            where lane.id = permit.quote_request_lane_id and lane.quote_request_id = v_request.id
              and lane.vendor_quote_result_id = v_result.id and lane.quote_run_id = v_run.id
              and lane.organization_id = v_result.organization_id and lane.part_id = v_result.part_id
              and lane.vendor = v_result.vendor and lane.requested_quantity = v_result.requested_quantity))
      )
    then return pg_catalog.jsonb_build_object('outcome', 'stale'); end if;
    if v_admission.admission_source = 'free_beta' and
      (v_request.status = 'canceled' or v_admission.state = 'released') then
      return pg_catalog.jsonb_build_object('outcome', 'fenced');
    end if;
    if p_result->>'status' in ('queued','running') then
      raise exception 'Vendor quote acceptance requires a terminal result.';
    end if;
    if pg_catalog.jsonb_typeof(coalesce(p_task_payload_patch, '{}'::jsonb)) <> 'object' then
      raise exception 'Task payload patch must be a JSON object.';
    end if;
    if pg_catalog.jsonb_typeof(p_offers) = 'array' and exists (
      select 1 from pg_catalog.jsonb_array_elements(p_offers) offer
      where (offer->>'organization_id')::uuid is distinct from v_result.organization_id
    ) then raise exception 'Every offer must belong to the result organization.'; end if;
    perform private.apply_vendor_quote_result_offers(v_result.id, p_result, p_offers);
    v_outcome := case when v_request.status = 'canceled' then 'request_canceled' else 'accepted' end;
    update public.work_queue set
      status = case when v_outcome = 'request_canceled' then 'cancelled'::public.queue_task_status else 'completed'::public.queue_task_status end,
      locked_at = null, locked_by = null,
      last_error = case when v_outcome = 'request_canceled' then 'Canceled while vendor automation was in flight.' else null end,
      payload = payload || coalesce(p_task_payload_patch, '{}'::jsonb) ||
        case when v_outcome = 'request_canceled' then '{"ignoredDueToCanceledRequest":true}'::jsonb else '{}'::jsonb end
      where id = p_task_id;
    if v_admission.admission_source = 'free_beta' then
      perform private.finalize_free_quote_job(v_request.id);
    end if;
    insert into private.vendor_quote_acceptance_receipts(work_queue_task_id, claim_locked_by,
      claim_locked_at, claim_attempts, vendor_quote_result_id, quote_run_id, job_id, payload_digest, outcome)
    values (p_task_id, p_locked_by, p_locked_at, p_attempts, v_result.id, v_run.id, v_run.job_id, v_digest, v_outcome)
    returning * into v_receipt;
    insert into private.quote_run_rollup_followups(receipt_id, job_id, quote_run_id)
    values (v_receipt.id, v_run.job_id, v_run.id) returning id into v_followup;
    set constraints all immediate;
    return pg_catalog.jsonb_build_object('outcome', v_outcome, 'receipt_id', v_receipt.id, 'followup_id', v_followup);
  exception when lock_not_available then
    -- PL/pgSQL rolls back the entire candidate, including every acquired lock.
    return pg_catalog.jsonb_build_object('outcome', 'busy');
  end;
end;
$$;
revoke all on function public.accept_vendor_quote_result(uuid,text,timestamptz,integer,uuid,jsonb,jsonb,jsonb)
from public, anon, authenticated;
grant execute on function public.accept_vendor_quote_result(uuid,text,timestamptz,integer,uuid,jsonb,jsonb,jsonb) to service_role;

-- Matches aggregateQuoteRunStatus, including empty/all-failed => failed/quoting
-- and pending > manual > success precedence. Old runs cannot change job state.
create function private.aggregate_quote_run_status(p_statuses public.vendor_status[])
returns table(run_status public.quote_run_status, job_status public.job_status,
  successful bigint, manual_review bigint, failed bigint)
language sql immutable set search_path = '' as $$
  with counts as (
    select pg_catalog.count(*) filter (where status in ('queued','running')) pending,
      pg_catalog.count(*) filter (where status in ('instant_quote_received','official_quote_received')) successful,
      pg_catalog.count(*) filter (where status in ('manual_review_pending','manual_vendor_followup')) manual_review,
      pg_catalog.count(*) filter (where status = 'failed') failed
    from pg_catalog.unnest(p_statuses) status
  )
  select (case when pending > 0 then 'running' when successful + manual_review > 0 then 'completed' else 'failed' end)::public.quote_run_status,
    (case when pending > 0 then 'quoting' when manual_review > 0 then 'awaiting_vendor_manual_review'
      when successful > 0 then 'internal_review' else 'quoting' end)::public.job_status,
    successful, manual_review, failed from counts;
$$;
revoke all on function private.aggregate_quote_run_status(public.vendor_status[]) from public, anon, authenticated, service_role;

create function public.drain_quote_run_rollup_followups(p_limit integer default 50)
returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '1s' as $$
declare
  v_id bigint;
  v_followup private.quote_run_rollup_followups%rowtype;
  v_job public.jobs%rowtype;
  v_run public.quote_runs%rowtype;
  v_aggregate record;
  v_job_status public.job_status;
  v_run_status public.quote_run_status;
  v_event text;
  v_scanned integer := 0;
  v_processed integer := 0;
  v_deferred integer := 0;
begin
  if p_limit is null or p_limit < 1 or p_limit > 500 then raise exception 'quote_run_rollup_limit_invalid'; end if;
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'quote_run_rollup_requires_read_committed';
  end if;
  -- Skip busy follow-ups/jobs/runs before applying the batch limit. Selection
  -- locks last until transaction end; later contention still defers the candidate.
  -- Deleted targets cannot be repaired by retrying; retain their immutable
  -- diagnostic rows without letting them starve the actionable ordered batch.
  for v_id in select f.id from private.quote_run_rollup_followups f
    join public.jobs j on j.id = f.job_id
    join public.quote_runs r on r.id = f.quote_run_id and r.job_id = j.id
    where f.processed_at is null order by f.id limit p_limit
    for update of f, j, r skip locked
  loop
    v_scanned := v_scanned + 1;
    begin
      select * into v_followup from private.quote_run_rollup_followups
        where id = v_id and processed_at is null for update skip locked;
      if not found then continue; end if;
      select * into v_job from public.jobs where id = v_followup.job_id for update nowait;
      select * into v_run from public.quote_runs where id = v_followup.quote_run_id for update nowait;
      if v_job.id is null or v_run.id is null or v_run.job_id <> v_job.id then
        -- Immutable IDs intentionally survive deletion; retain diagnostic backlog.
        raise sqlstate '55P03' using message = 'rollup_target_missing';
      end if;
      perform 1 from public.organizations where id = v_job.organization_id for key share nowait;
      select * into v_aggregate from private.aggregate_quote_run_status(
        array(select status from public.vendor_quote_results where quote_run_id = v_run.id));
      -- Only active runs advance; never reopen completed/failed/published runs.
      v_run_status := case when v_run.status in ('queued','running')
        then v_aggregate.run_status else v_run.status end;
      -- A delayed older run must not overwrite a newer run's job status.
      -- Within quoting, manual review can advance to internal review but cannot
      -- regress to quoting. All other user/admin lifecycle states are preserved.
      v_job_status := v_job.status;
      if v_run.id = (select id from public.quote_runs where job_id = v_job.id
          order by created_at desc, id desc limit 1)
        and (v_job.status = 'quoting' or (v_job.status = 'awaiting_vendor_manual_review'
          and v_aggregate.job_status = 'internal_review')) then
        v_job_status := v_aggregate.job_status;
      end if;
      if v_run.status is distinct from v_run_status or v_job.status is distinct from v_job_status then
        update public.quote_runs set status = v_run_status where id = v_run.id and status is distinct from v_run_status;
        update public.jobs set status = v_job_status where id = v_job.id and status is distinct from v_job_status;
        v_event := case when v_aggregate.run_status = 'failed' then 'worker.quote_run_failed'
          when v_aggregate.job_status = 'awaiting_vendor_manual_review' then 'worker.quote_run_attention_needed'
          when v_aggregate.job_status = 'internal_review' then 'worker.quote_run_completed' end;
        if v_event is not null then
          insert into public.audit_events(organization_id, job_id, actor_user_id, event_type, payload)
          values (v_job.organization_id, v_job.id, null, v_event,
            pg_catalog.jsonb_build_object('quoteRunId', v_run.id, 'successfulVendorQuotes', v_aggregate.successful,
              'manualReviewVendorQuotes', v_aggregate.manual_review, 'failedVendorQuotes', v_aggregate.failed));
        end if;
      end if;
      update private.quote_run_rollup_followups set processed_at = pg_catalog.clock_timestamp() where id = v_id;
      set constraints all immediate;
      v_processed := v_processed + 1;
    exception when lock_not_available then
      v_deferred := v_deferred + 1;
    end;
  end loop;
  return pg_catalog.jsonb_build_object('scanned', v_scanned, 'processed', v_processed, 'deferred', v_deferred);
end;
$$;
revoke all on function public.drain_quote_run_rollup_followups(integer) from public, anon, authenticated;
grant execute on function public.drain_quote_run_rollup_followups(integer) to service_role;
