-- Source-only additive repair; no database qualification has run here.
-- Filename generated with authorized Supabase CLI 2.78.1 on 2026-10-03T01:11:48Z.
-- Apply after both 20261002 free quote migrations; qualify before worker release.
-- No policy, customer limit, subject, window or enrollment is selected.
create index quote_access_admissions_reserved_scan on private.quote_access_admissions(id)
  where admission_source = 'free_beta' and state = 'reserved';
create index quote_access_admissions_reserved_job on private.quote_access_admissions(job_id)
  where admission_source = 'free_beta' and state = 'reserved';

-- Do not settle in a work_queue trigger: queue -> request/result reverses the
-- cancellation and canonical-result lock graph. This separate RPC runs after
-- the queue terminal update commits, and scans old failures on every pass.
create function public.api_reconcile_terminal_free_quote_tasks(
  p_after_admission_id uuid default null,
  p_limit integer default 100
) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog as $$
declare
  v_candidate record;
  v_receipt private.quote_access_admissions%rowtype;
  v_permit private.xometry_beta_dispatch_permits%rowtype;
  v_result public.vendor_quote_results%rowtype;
  v_request public.quote_requests%rowtype;
  v_task public.work_queue%rowtype;
  v_lane public.quote_request_lanes%rowtype;
  v_settlement jsonb;
  v_scanned integer := 0;
  v_reconciled integer := 0;
  v_indeterminate integer := 0;
  v_deferred integer := 0;
  v_last uuid;
begin
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'free_quote_reconciliation_limit_invalid';
  end if;
  if current_setting('transaction_isolation') is distinct from 'read committed' then
    raise exception 'free_quote_reconciliation_requires_read_committed';
  end if;
  for v_candidate in
    select admission.id, admission.permit_id, admission.quote_request_id
    from private.quote_access_admissions admission
    where admission.admission_source = 'free_beta' and admission.state = 'reserved'
      and (p_after_admission_id is null or admission.id > p_after_admission_id)
    order by admission.id limit p_limit
  loop
    v_scanned := v_scanned + 1;
    v_last := v_candidate.id;
    select * into v_permit from private.xometry_beta_dispatch_permits where id = v_candidate.permit_id;
    if v_permit.id is null then
      v_indeterminate := v_indeterminate + 1; continue;
    end if;
    -- Each statement gets a fresh READ COMMITTED snapshot. SKIP LOCKED avoids
    -- waiting behind active canonical writers or cancellation, including when
    -- this bounded batch already holds earlier candidates' locks.
    select * into v_result from public.vendor_quote_results
      where id = v_permit.vendor_quote_result_id for update skip locked;
    if v_result.id is null then
      if exists (select 1 from public.vendor_quote_results where id = v_permit.vendor_quote_result_id) then
        v_deferred := v_deferred + 1;
      else v_indeterminate := v_indeterminate + 1; end if;
      continue;
    end if;
    select * into v_request from public.quote_requests
      where id = v_candidate.quote_request_id for update skip locked;
    if v_request.id is null then
      if exists (select 1 from public.quote_requests where id = v_candidate.quote_request_id) then
        v_deferred := v_deferred + 1;
      else v_indeterminate := v_indeterminate + 1; end if;
      continue;
    end if;
    select * into v_task from public.work_queue
      where id = v_permit.work_queue_task_id for update skip locked;
    if v_task.id is null then
      if exists (select 1 from public.work_queue where id = v_permit.work_queue_task_id) then
        v_deferred := v_deferred + 1;
      else v_indeterminate := v_indeterminate + 1; end if;
      continue;
    end if;
    select * into v_receipt from private.quote_access_admissions where id = v_candidate.id;
    if v_receipt.state is distinct from 'reserved' then continue; end if;
    select * into v_lane from public.quote_request_lanes where id = v_permit.quote_request_lane_id;
    -- Resolve IDs from the immutable permit. Never trust work_queue payload IDs.
    if v_lane.id is null
      or v_receipt.admission_source is distinct from 'free_beta'
      or v_receipt.permit_id is distinct from v_permit.id
      or v_receipt.quote_request_id is distinct from v_request.id or v_permit.quote_request_id is distinct from v_request.id
      or v_receipt.quote_run_id is distinct from v_permit.quote_run_id or v_receipt.job_id is distinct from v_permit.job_id
      or v_receipt.organization_id is distinct from v_permit.organization_id or v_receipt.actor_user_id is distinct from v_permit.actor_user_id
      or v_receipt.approval_reference is distinct from v_permit.approval_reference
      or v_receipt.notice_revision is distinct from v_permit.notice_revision
      or v_receipt.scope_version is distinct from v_permit.scope_version or v_receipt.scope_fingerprint is distinct from v_permit.scope_fingerprint
      or v_request.organization_id is distinct from v_receipt.organization_id or v_request.job_id is distinct from v_receipt.job_id
      or v_request.requested_by is distinct from v_receipt.actor_user_id
      or v_result.organization_id is distinct from v_receipt.organization_id or v_result.quote_run_id is distinct from v_receipt.quote_run_id
      or v_result.part_id is distinct from v_permit.part_id or v_result.vendor is distinct from v_permit.provider or v_result.requested_quantity is distinct from 1
      or v_task.task_type is distinct from 'run_vendor_quote' or v_task.organization_id is distinct from v_receipt.organization_id
      or v_task.job_id is distinct from v_receipt.job_id or v_task.part_id is distinct from v_permit.part_id
      or v_task.quote_run_id is distinct from v_receipt.quote_run_id
      or v_lane.organization_id is distinct from v_receipt.organization_id or v_lane.quote_request_id is distinct from v_request.id
      or v_lane.quote_run_id is distinct from v_receipt.quote_run_id or v_lane.vendor_quote_result_id is distinct from v_result.id
      or v_lane.part_id is distinct from v_permit.part_id or v_lane.vendor is distinct from v_permit.provider or v_lane.requested_quantity is distinct from 1
      or v_lane.scope_version is distinct from v_receipt.scope_version or v_lane.scope_fingerprint is distinct from v_receipt.scope_fingerprint
      or (select count(*) from public.quote_request_lanes where quote_request_id = v_request.id) is distinct from 1
      or not exists (select 1 from public.quote_runs where id = v_receipt.quote_run_id
        and quote_request_id = v_request.id and job_id = v_receipt.job_id and organization_id = v_receipt.organization_id)
      or not exists (select 1 from public.jobs where id = v_receipt.job_id and organization_id = v_receipt.organization_id)
    then
      v_indeterminate := v_indeterminate + 1; continue;
    end if;
    -- A re-claimed/retried task has a new active state or lease. It is not a
    -- terminal failure, even if an earlier scan observed one. Never touch it.
    if v_task.status not in ('failed','cancelled') or v_task.locked_at is not null or v_task.locked_by is not null then
      v_deferred := v_deferred + 1; continue;
    end if;
    if v_request.status = 'canceled' then
      v_settlement := private.release_cancelled_free_quote_job(v_request.id);
    elsif v_result.status in ('queued','running') then
      if v_request.status not in ('queued','requesting') then
        v_indeterminate := v_indeterminate + 1; continue;
      end if;
      update public.vendor_quote_results set status = 'failed' where id = v_result.id;
      -- Existing result fence/reducer and finalizer remain authoritative.
      -- Explicit settlement also covers initially deferred constraint timing.
      v_settlement := private.finalize_free_quote_job(v_request.id);
    else
      -- Preserve canonical success and consume only an existing usable offer;
      -- never replace it with a failure because queue cleanup failed afterward.
      v_settlement := private.finalize_free_quote_job(v_request.id);
    end if;
    if v_settlement ->> 'state' in ('released','consumed') then
      v_reconciled := v_reconciled + 1;
    else
      v_indeterminate := v_indeterminate + 1;
    end if;
  end loop;
  return jsonb_build_object('scanned',v_scanned,'reconciled',v_reconciled,
    'indeterminate',v_indeterminate,'deferred',v_deferred,
    'nextCursor',case when v_scanned = p_limit then v_last else null end);
end;
$$;
revoke all on function public.api_reconcile_terminal_free_quote_tasks(uuid,integer)
  from public, anon, authenticated;
grant execute on function public.api_reconcile_terminal_free_quote_tasks(uuid,integer) to service_role;

-- Historical terminal receipts intentionally survive job deletion. A reserved
-- receipt still needs canonical identity, so refuse deletion rather than guess
-- its outcome, remove evidence, or acquire request/result locks in reverse order.
create function private.fence_reserved_free_quote_job_delete()
returns trigger language plpgsql volatile security definer set search_path = pg_catalog as $$
begin
  if exists (select 1 from private.quote_access_admissions
      where job_id = old.id and admission_source = 'free_beta' and state = 'reserved') then
    raise exception 'free_quote_reservation_unresolved';
  end if;
  return old;
end;
$$;
revoke all on function private.fence_reserved_free_quote_job_delete()
  from public, anon, authenticated, service_role;
create trigger fence_reserved_free_quote_job_delete before delete on public.jobs
  for each row execute function private.fence_reserved_free_quote_job_delete();
