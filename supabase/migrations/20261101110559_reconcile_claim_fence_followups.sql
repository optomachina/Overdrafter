-- S1.1b follow-ups: immutable run/job binding and non-starving drain batches.
-- Rollback: supabase/rollbacks/20261101110559_reconcile_claim_fence_followups.rollback.sql
-- CREATE OR REPLACE retains the drain function identity and existing owner.
set local lock_timeout = '1s';

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

create or replace function public.drain_quote_run_rollup_followups(p_limit integer default 50)
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
