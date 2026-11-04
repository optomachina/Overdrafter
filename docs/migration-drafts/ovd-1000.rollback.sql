-- OVD-1000 rollback draft: authorized migration window only, one transaction.
-- Restores the 20261029165751_reconcile_claim_fence.sql body of
-- public.accept_vendor_quote_result byte for byte (md5
-- c72d8ca87d6da4d3ae0448497b14e52f), which compares Xometry beta permits with
-- a literal quantity 1 again. While it is live, a Xometry beta result above
-- quantity 1 settles as `stale`: keep the controlled_beta_user_quantity switch
-- off and issue no OVD-1007 quantity grant. No stored data changes.

set local lock_timeout = '5s';

do $ovd1000_guard$
declare
  v_md5 text;
begin
  select pg_catalog.md5(p.prosrc) into v_md5
  from pg_catalog.pg_proc p
  where p.oid = pg_catalog.to_regprocedure('public.accept_vendor_quote_result(uuid,text,timestamptz,integer,uuid,jsonb,jsonb,jsonb)');
  if v_md5 is null or v_md5 not in ('c79ef7028326dbe470428af844af1bbd', 'c72d8ca87d6da4d3ae0448497b14e52f') then
    raise exception 'OVD-1000 rollback refused: public.accept_vendor_quote_result has an unexpected body (md5 %)', coalesce(v_md5, 'missing')
      using errcode = '55000';
  end if;
  -- Drain rule (docs/migration-drafts/ovd-987-notes.md): the restored body settles a
  -- quantity-above-1 Xometry beta result as stale, so refuse while one is in flight.
  -- The SHARE lock holds new permits back until this transaction ends.
  lock table private.xometry_beta_dispatch_permits in share mode;
  if exists (
    select 1
    from private.xometry_beta_dispatch_permits permit
    join public.quote_request_lanes lane on lane.id = permit.quote_request_lane_id
    left join public.quote_requests request_row on request_row.id = permit.quote_request_id
    left join public.work_queue task on task.id = permit.work_queue_task_id
    left join private.quote_access_admissions admission on admission.permit_id = permit.id
    where lane.requested_quantity <> 1
      and (admission.state = 'reserved'
        or request_row.status::text in ('queued', 'requesting')
        or task.status::text in ('queued', 'running'))
  ) then
    raise exception 'OVD-1000 rollback refused: a quantity-above-1 Xometry beta permit is in flight'
      using errcode = '55000';
  end if;
end;
$ovd1000_guard$;

create or replace function public.accept_vendor_quote_result(
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
