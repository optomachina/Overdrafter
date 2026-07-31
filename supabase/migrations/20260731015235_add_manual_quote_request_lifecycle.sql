-- OVD-259: Add a customer manual-quote request lifecycle without vendor fan-out.
--
-- Historical and existing client quote RPCs remain automatic in this slice.
-- The new manual RPCs create the same client-visible request/run lineage but no
-- vendor result rows and no worker tasks. OVD-260 separately adds the Pro
-- entitlement boundary to the automatic RPCs.
--
-- Rollback: stop callers of the manual RPCs, revoke the functions, remove the
-- cancellation trigger, and drop the request_mode column/type in a forward
-- migration after exporting any manual request history that must be retained.

do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_type
    where typname = 'quote_request_mode'
      and typnamespace = 'public'::regnamespace
  ) then
    create type public.quote_request_mode as enum ('manual', 'automatic');
  end if;
end;
$$;

alter table public.quote_requests
add column if not exists request_mode public.quote_request_mode
not null default 'automatic';

create index if not exists idx_quote_requests_manual_inbox
on public.quote_requests(organization_id, status, created_at desc)
where request_mode = 'manual';

-- Preserve the existing automatic implementation behind a private boundary so
-- this migration can add a stable quoteMode result field without duplicating
-- the established vendor fan-out logic. OVD-260 will add the Pro entitlement
-- decision in the public wrapper before calling this implementation.
alter function public.api_request_quote(uuid, boolean)
set schema private;

alter function private.api_request_quote(uuid, boolean)
rename to request_automatic_quote_impl;

revoke all on function private.request_automatic_quote_impl(uuid, boolean)
from public, anon, authenticated, service_role;

create or replace function public.api_request_quote(
  p_job_id uuid,
  p_force_retry boolean default false
)
returns jsonb
language sql
security definer
set search_path = pg_catalog
as $$
  select private.request_automatic_quote_impl(
    p_job_id,
    p_force_retry
  ) || pg_catalog.jsonb_build_object(
    'quoteMode',
    'automatic'
  );
$$;

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
      coalesce(p_requested_vendors, array[]::public.vendor_name[])
    ),
    'quoteMode', p_quote_mode
  );
$$;

create or replace function private.get_manual_quote_request_blocker(
  p_job_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  v_job public.jobs%rowtype;
  v_requested_service_kinds text[];
begin
  select job_row.*
  into v_job
  from public.jobs job_row
  where job_row.id = p_job_id;

  if v_job.id is null then
    raise exception 'Job % not found.', p_job_id;
  end if;

  if v_job.archived_at is not null then
    return pg_catalog.jsonb_build_object(
      'reasonCode', 'archived',
      'reason', 'Archived parts cannot request quotes.'
    );
  end if;

  if v_job.status in ('internal_review', 'published', 'client_selected', 'closed') then
    return pg_catalog.jsonb_build_object(
      'reasonCode', 'already_received',
      'reason', 'A quote has already been requested for this part.'
    );
  end if;

  if not exists (
    select 1
    from public.parts part_row
    where part_row.job_id = p_job_id
  ) then
    return pg_catalog.jsonb_build_object(
      'reasonCode', 'missing_part',
      'reason', 'This job does not have a part revision ready for quoting yet.'
    );
  end if;

  v_requested_service_kinds := public.normalize_requested_service_kinds(
    v_job.requested_service_kinds,
    v_job.primary_service_kind
  );

  if not exists (
    select 1
    from pg_catalog.unnest(v_requested_service_kinds) as requested_service_kind(value)
    where requested_service_kind.value in ('manufacturing_quote', 'sourcing_only')
  ) then
    return pg_catalog.jsonb_build_object(
      'reasonCode', 'unsupported_service_kind',
      'reason', 'Only manufacturing quote and sourcing-only requests can start quote collection.'
    );
  end if;

  if exists (
    select 1
    from public.parts part_row
    where part_row.job_id = p_job_id
      and part_row.cad_file_id is null
  ) then
    return pg_catalog.jsonb_build_object(
      'reasonCode', 'missing_cad',
      'reason', 'Upload a CAD model before requesting a quote.'
    );
  end if;

  if exists (
    select 1
    from public.parts part_row
    where part_row.job_id = p_job_id
      and not exists (
        select 1
        from public.approved_part_requirements requirement
        where requirement.part_id = part_row.id
      )
  ) then
    return pg_catalog.jsonb_build_object(
      'reasonCode', 'missing_requirements',
      'reason', 'Finish the request details so OverDrafter can create approved quote requirements first.'
    );
  end if;

  return null;
end;
$$;

create or replace function public.api_request_manual_quote(
  p_job_id uuid,
  p_force_retry boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_job public.jobs%rowtype;
  v_existing_request public.quote_requests%rowtype;
  v_existing_quote_run public.quote_runs%rowtype;
  v_existing_mode public.quote_request_mode;
  v_request_id uuid;
  v_quote_run_id uuid;
  v_service_request_line_item_id uuid;
  v_blocker jsonb;
  v_manual_vendors public.vendor_name[] := array[]::public.vendor_name[];
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
    raise exception 'You do not have permission to request quotes for job %.', p_job_id;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('quote-request:' || p_job_id::text, 0)
  );

  select job_row.*
  into v_job
  from public.jobs job_row
  where job_row.id = p_job_id
  for update;

  select request_row.*
  into v_existing_request
  from public.quote_requests request_row
  where request_row.job_id = p_job_id
  order by request_row.created_at desc, request_row.id desc
  limit 1;

  if v_existing_request.id is not null then
    v_existing_mode := v_existing_request.request_mode;
    v_service_request_line_item_id := v_existing_request.service_request_line_item_id;

    if v_service_request_line_item_id is null then
      select line_item.id
      into v_service_request_line_item_id
      from public.service_request_line_items line_item
      where line_item.job_id = p_job_id
        and line_item.service_type = 'manufacturing_quote'
        and line_item.scope = 'part'
      limit 1;
    end if;

    select quote_run.*
    into v_existing_quote_run
    from public.quote_runs quote_run
    where quote_run.quote_request_id = v_existing_request.id
    order by quote_run.created_at desc, quote_run.id desc
    limit 1;

    if v_existing_request.status in ('queued', 'requesting') then
      return private.build_quote_request_submission_result(
        p_job_id,
        true,
        false,
        true,
        v_existing_request.id,
        v_existing_quote_run.id,
        v_service_request_line_item_id,
        v_existing_request.status::text,
        'already_in_progress',
        'A quote request is already active for this part.',
        v_existing_request.requested_vendors,
        v_existing_mode
      );
    end if;

    if v_existing_request.status = 'received' then
      return private.build_quote_request_submission_result(
        p_job_id,
        false,
        false,
        false,
        v_existing_request.id,
        v_existing_quote_run.id,
        v_service_request_line_item_id,
        v_existing_request.status::text,
        'already_received',
        'A quote response has already been received for this part.',
        v_existing_request.requested_vendors,
        v_existing_mode
      );
    end if;

    if v_existing_request.status in ('failed', 'canceled')
       and not coalesce(p_force_retry, false) then
      return private.build_quote_request_submission_result(
        p_job_id,
        false,
        false,
        false,
        v_existing_request.id,
        v_existing_quote_run.id,
        v_service_request_line_item_id,
        v_existing_request.status::text,
        'retry_required',
        coalesce(
          v_existing_request.failure_reason,
          'Retry the quote request to start a new manual quote request.'
        ),
        v_existing_request.requested_vendors,
        v_existing_mode
      );
    end if;
  end if;

  if v_existing_request.id is null then
    select quote_run.*
    into v_existing_quote_run
    from public.quote_runs quote_run
    where quote_run.job_id = p_job_id
    order by quote_run.created_at desc, quote_run.id desc
    limit 1;

    if v_existing_quote_run.id is not null then
      if v_job.status in ('quoting', 'awaiting_vendor_manual_review')
         or v_existing_quote_run.status in ('queued', 'running') then
        return private.build_quote_request_submission_result(
          p_job_id,
          false,
          false,
          false,
          null,
          v_existing_quote_run.id,
          null,
          'requesting',
          'already_in_progress',
          'Quote collection is already in progress for this part.',
          v_manual_vendors,
          'automatic'
        );
      end if;

      if v_job.status in ('internal_review', 'published', 'client_selected', 'closed')
         or v_existing_quote_run.status in ('completed', 'published') then
        return private.build_quote_request_submission_result(
          p_job_id,
          false,
          false,
          false,
          null,
          v_existing_quote_run.id,
          null,
          'received',
          'already_received',
          'A quote has already been requested for this part.',
          v_manual_vendors,
          'automatic'
        );
      end if;

      if v_existing_quote_run.status = 'failed'
         and not coalesce(p_force_retry, false) then
        return private.build_quote_request_submission_result(
          p_job_id,
          false,
          false,
          false,
          null,
          v_existing_quote_run.id,
          null,
          'failed',
          'retry_required',
          'A previous quote attempt failed. Retry to start a new manual quote request.',
          v_manual_vendors,
          'automatic'
        );
      end if;
    end if;
  end if;

  v_blocker := private.get_manual_quote_request_blocker(p_job_id);

  if v_blocker is not null then
    return private.build_quote_request_submission_result(
      p_job_id,
      false,
      false,
      false,
      null,
      null,
      null,
      'not_requested',
      v_blocker ->> 'reasonCode',
      v_blocker ->> 'reason',
      v_manual_vendors,
      'manual'
    );
  end if;

  insert into public.service_request_line_items (
    organization_id,
    project_id,
    job_id,
    service_type,
    scope,
    status,
    service_detail
  )
  values (
    v_job.organization_id,
    v_job.project_id,
    p_job_id,
    'manufacturing_quote',
    'part',
    'open',
    public.build_manufacturing_quote_service_detail(p_job_id)
      || pg_catalog.jsonb_build_object('quoteRequestMode', 'manual')
  )
  on conflict (job_id, service_type, scope) where job_id is not null do update
  set
    organization_id = excluded.organization_id,
    project_id = coalesce(
      excluded.project_id,
      public.service_request_line_items.project_id
    ),
    service_detail = coalesce(
      public.service_request_line_items.service_detail,
      '{}'::jsonb
    ) || excluded.service_detail,
    updated_at = pg_catalog.timezone('utc', pg_catalog.now())
  returning id into v_service_request_line_item_id;

  insert into public.quote_requests (
    organization_id,
    job_id,
    requested_by,
    requested_vendors,
    service_request_line_item_id,
    request_mode,
    status
  )
  values (
    v_job.organization_id,
    p_job_id,
    auth.uid(),
    v_manual_vendors,
    v_service_request_line_item_id,
    'manual',
    'queued'
  )
  returning id into v_request_id;

  insert into public.quote_runs (
    quote_request_id,
    job_id,
    organization_id,
    initiated_by,
    status,
    requested_auto_publish
  )
  values (
    v_request_id,
    p_job_id,
    v_job.organization_id,
    auth.uid(),
    'queued',
    false
  )
  returning id into v_quote_run_id;

  update public.jobs
  set status = 'awaiting_vendor_manual_review'
  where id = p_job_id;

  perform public.log_audit_event(
    v_job.organization_id,
    'job.manual_quote_requested',
    pg_catalog.jsonb_build_object(
      'quoteRequestId', v_request_id,
      'quoteRunId', v_quote_run_id,
      'serviceRequestLineItemId', v_service_request_line_item_id,
      'quoteMode', 'manual',
      'clientTriggered', true,
      'requestedVendors', v_manual_vendors
    ),
    p_job_id,
    null
  );

  return private.build_quote_request_submission_result(
    p_job_id,
    true,
    true,
    false,
    v_request_id,
    v_quote_run_id,
    v_service_request_line_item_id,
    'queued',
    null,
    null,
    v_manual_vendors,
    'manual'
  );
end;
$$;

create or replace function public.api_request_manual_quotes(
  p_job_ids uuid[],
  p_force_retry boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_job_id uuid;
  v_results jsonb := '[]'::jsonb;
begin
  perform public.require_verified_auth();

  foreach v_job_id in array coalesce(p_job_ids, '{}'::uuid[])
  loop
    v_results := v_results || pg_catalog.jsonb_build_array(
      public.api_request_manual_quote(v_job_id, p_force_retry)
    );
  end loop;

  return v_results;
end;
$$;

create or replace function private.reset_job_after_manual_quote_cancellation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if new.request_mode = 'manual'
     and new.status = 'canceled'
     and old.status is distinct from new.status then
    update public.jobs
    set status = 'ready_to_quote'
    where id = new.job_id
      and status = 'awaiting_vendor_manual_review';
  end if;

  return new;
end;
$$;

drop trigger if exists reset_job_after_manual_quote_cancellation
on public.quote_requests;

create trigger reset_job_after_manual_quote_cancellation
after update of status on public.quote_requests
for each row execute function private.reset_job_after_manual_quote_cancellation();

revoke all on function private.build_quote_request_submission_result(
  uuid,
  boolean,
  boolean,
  boolean,
  uuid,
  uuid,
  uuid,
  text,
  text,
  text,
  public.vendor_name[],
  public.quote_request_mode
) from public, anon, authenticated, service_role;

revoke all on function private.get_manual_quote_request_blocker(uuid)
from public, anon, authenticated, service_role;

revoke all on function private.reset_job_after_manual_quote_cancellation()
from public, anon, authenticated, service_role;

revoke all on function public.api_request_manual_quote(uuid, boolean)
from public, anon, authenticated, service_role;

revoke all on function public.api_request_manual_quotes(uuid[], boolean)
from public, anon, authenticated, service_role;

revoke all on function public.api_request_quote(uuid, boolean)
from public, anon, authenticated, service_role;

grant execute on function public.api_request_quote(uuid, boolean)
to authenticated;

grant execute on function public.api_request_manual_quote(uuid, boolean)
to authenticated;

grant execute on function public.api_request_manual_quotes(uuid[], boolean)
to authenticated;
