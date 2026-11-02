-- OVD-1097: settle extraction status after the worker's task update commits.
-- Additive, service-role-only RPC; no approvals, tables, enums or triggers change.
-- search_path is pinned to pg_catalog (repo lint-security-definer rule); every
-- relation, type and helper is schema-qualified as public.<name>.
-- ROLLBACK (requires separate authorization to apply):
--   drop function public.api_refresh_job_extraction_status(uuid);
-- Runnable down path: docs/migration-drafts/ovd-1097.rollback.sql.
-- The rollback has no forward draft counterpart: do not double-apply this migration.

create or replace function public.api_refresh_job_extraction_status(p_job_id uuid)
returns text
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_job public.jobs%rowtype;
  v_status public.job_status;
  v_pending integer;
  v_failed integer;
  v_file_parts integer;
  v_unapproved integer;
begin
  select * into v_job
  from public.jobs
  where id = p_job_id
  for update;

  if not found then
    raise exception 'Job not found';
  end if;

  if v_job.status <> 'extracting' then
    return v_job.status::text;
  end if;

  -- Historical failures/retries must not outweigh the latest attempt per part.
  with latest_extract_tasks as (
    select distinct on (queue.part_id) queue.part_id, queue.status
    from public.work_queue queue
    where queue.job_id = p_job_id
      and queue.task_type = 'extract_part'
      and queue.part_id is not null
    order by queue.part_id, queue.created_at desc, queue.id desc
  )
  select count(*) filter (where status in ('queued', 'running'))::integer,
         count(*) filter (where status = 'failed')::integer
  into v_pending, v_failed
  from latest_extract_tasks;

  select count(*)::integer,
         count(*) filter (where requirement.id is null)::integer
  into v_file_parts, v_unapproved
  from public.parts part
  left join public.approved_part_requirements requirement on requirement.part_id = part.id
  where part.job_id = p_job_id
    and (part.cad_file_id is not null or part.drawing_file_id is not null);

  v_status := v_job.status;
  if v_pending > 0 then
    return v_job.status::text;
  elsif v_failed > 0 or v_unapproved > 0 then
    v_status := 'needs_spec_review';
  elsif v_file_parts > 0 and v_unapproved = 0 then
    v_status := 'ready_to_quote';
  end if;

  if v_status <> v_job.status then
    update public.jobs set status = v_status where id = p_job_id;
    perform public.log_audit_event(
      v_job.organization_id,
      'job.extraction_status_refreshed',
      jsonb_build_object(
        'fromStatus', v_job.status,
        'toStatus', v_status,
        'pendingExtractTasks', v_pending,
        'failedExtractTasks', v_failed,
        'fileBearingParts', v_file_parts,
        'unapprovedParts', v_unapproved
      ),
      p_job_id,
      null
    );
  end if;

  return v_status::text;
end;
$$;

revoke execute on function public.api_refresh_job_extraction_status(uuid) from public;
revoke execute on function public.api_refresh_job_extraction_status(uuid) from anon, authenticated;
grant execute on function public.api_refresh_job_extraction_status(uuid) to service_role;
