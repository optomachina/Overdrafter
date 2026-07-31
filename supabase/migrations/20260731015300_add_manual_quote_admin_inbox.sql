-- OVD-262: add a capability-scoped manual-quote operations inbox.
--
-- The customer-facing same-organization manual intake RPC remains unchanged.
-- This migration adds a separate platform billing-admin boundary for listing
-- active manual requests and completing one exact request/run/job lineage.
--
-- Rollback: disable callers, revoke and drop the two public RPCs, remove the
-- three billing-admin storage policies and the artifact read policy, then drop
-- the partial inbox index. Quote/result/audit rows created before rollback are
-- durable business records and must not be deleted.
--
-- Deployment: create the partial inbox index during a low-traffic window
-- because this transactional migration can briefly block writes to
-- public.quote_requests. For a large production table, pre-create the same
-- index concurrently out of band before applying this migration.

create index if not exists idx_quote_requests_manual_admin_inbox
on public.quote_requests (created_at asc, id asc)
where request_mode = 'manual' -- NOSONAR: intentional lifecycle contract literal
  and status in ('queued', 'requesting'); -- NOSONAR: intentional lifecycle contract literal

create or replace function public.api_admin_list_manual_quote_requests(
  p_cursor text default null,
  p_limit integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  v_cursor_payload jsonb;
  v_cursor_created_at timestamptz;
  v_cursor_id uuid;
  v_items jsonb := '[]'::jsonb;
  v_has_more boolean := false;
  v_next_created_at timestamptz;
  v_next_id uuid;
  v_next_cursor text;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in to view manual quote requests.';
  end if;

  if not public.current_user_has_commercial_capability('billing_admin') then -- NOSONAR: explicit capability boundary
    raise exception 'You do not have the required commercial capability.';
  end if;

  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'Manual quote request page size must be between 1 and 100.';
  end if;

  if nullif(trim(coalesce(p_cursor, '')), '') is not null then
    if pg_catalog.length(p_cursor) > 2000 then
      raise exception 'Manual quote request cursor is invalid.'; -- NOSONAR: stable API error
    end if;

    begin
      v_cursor_payload := pg_catalog.convert_from(
        pg_catalog.decode(p_cursor, 'base64'),
        'UTF8'
      )::jsonb;
      v_cursor_created_at :=
        (v_cursor_payload ->> 'createdAt')::timestamptz; -- NOSONAR: stable cursor contract
      v_cursor_id := (v_cursor_payload ->> 'id')::uuid;
    exception
      when others then
        raise exception 'Manual quote request cursor is invalid.';
    end;

    if v_cursor_created_at is null or v_cursor_id is null then
      raise exception 'Manual quote request cursor is invalid.';
    end if;
  end if;

  with candidates as (
    select
      request_row.id as request_id,
      request_row.organization_id,
      organization_row.name as organization_name,
      job_row.project_id,
      project_row.name as project_name,
      request_row.job_id,
      job_row.title as job_title,
      job_row.status::text as job_status,
      job_row.archived_at,
      quote_run.id as quote_run_id,
      quote_run.status::text as quote_run_status,
      request_row.status::text as request_status,
      request_row.requested_by as requested_by_user_id,
      app_user.email as requested_by_email,
      request_row.created_at,
      request_row.updated_at,
      greatest(
        pg_catalog.floor(
          pg_catalog.date_part(
            'epoch',
            pg_catalog.timezone('utc', pg_catalog.now())
            - request_row.created_at
          )
        ),
        0
      )::bigint as request_age_seconds,
      coalesce(part_counts.part_count, 0) as part_count,
      part_counts.part_ids,
      case
        when job_row.archived_at is not null then
          'job_archived'
        when quote_run.id is null then
          'missing_quote_run'
        when quote_run.status not in ('queued', 'running') then -- NOSONAR: explicit lifecycle states
          'quote_run_not_active'
        when job_row.status <> 'awaiting_vendor_manual_review' then -- NOSONAR: explicit lifecycle state
          'job_not_awaiting_manual_review'
        else null
      end as stale_reason
    from public.quote_requests request_row
    join public.organizations organization_row
      on organization_row.id = request_row.organization_id
    join public.jobs job_row
      on job_row.id = request_row.job_id
    left join public.projects project_row
      on project_row.id = job_row.project_id
    left join public.quote_runs quote_run
      on quote_run.quote_request_id = request_row.id
    left join auth.users app_user
      on app_user.id = request_row.requested_by
    left join lateral (
      select
        pg_catalog.count(*)::integer as part_count,
        coalesce(
          pg_catalog.jsonb_agg(
            part_row.id
            order by part_row.created_at, part_row.id
          ),
          '[]'::jsonb
        ) as part_ids
      from public.parts part_row
      where part_row.job_id = request_row.job_id
    ) part_counts on true
    where request_row.request_mode = 'manual'
      and request_row.status in ('queued', 'requesting')
      and (
        v_cursor_created_at is null
        or (request_row.created_at, request_row.id)
          > (v_cursor_created_at, v_cursor_id)
      )
    order by request_row.created_at asc, request_row.id asc
    limit p_limit + 1
  ),
  numbered as (
    select
      candidate.*,
      pg_catalog.row_number() over (
        order by candidate.created_at asc, candidate.request_id asc
      ) as row_number
    from candidates candidate
  )
  select
    coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'requestId', numbered.request_id,
          'organizationId', numbered.organization_id,
          'organizationName', numbered.organization_name,
          'projectId', numbered.project_id,
          'projectName', numbered.project_name,
          'jobId', numbered.job_id, -- NOSONAR: stable JSON contract key
          'jobTitle', numbered.job_title,
          'jobStatus', numbered.job_status, -- NOSONAR: stable JSON contract key
          'quoteRunId', numbered.quote_run_id, -- NOSONAR: stable JSON contract key
          'quoteRunStatus', numbered.quote_run_status, -- NOSONAR: stable JSON contract key
          'requestStatus', numbered.request_status, -- NOSONAR: stable JSON contract key
          'requestedByUserId', numbered.requested_by_user_id,
          'requestedByEmail', numbered.requested_by_email,
          'partCount', numbered.part_count,
          'partIds', numbered.part_ids,
          'createdAt', numbered.created_at,
          'updatedAt', numbered.updated_at,
          'requestAgeSeconds', numbered.request_age_seconds,
          'isStale', numbered.stale_reason is not null,
          'staleReason', numbered.stale_reason
        )
        order by numbered.created_at asc, numbered.request_id asc
      ) filter (where numbered.row_number <= p_limit),
      '[]'::jsonb
    ),
    pg_catalog.count(*) > p_limit,
    pg_catalog.max(numbered.created_at)
      filter (where numbered.row_number = p_limit),
    (
      pg_catalog.max(numbered.request_id::text)
        filter (where numbered.row_number = p_limit)
    )::uuid
  into
    v_items,
    v_has_more,
    v_next_created_at,
    v_next_id
  from numbered;

  if v_has_more then
    v_next_cursor := pg_catalog.replace(
      pg_catalog.encode(
        pg_catalog.convert_to(
          pg_catalog.jsonb_build_object(
            'createdAt', v_next_created_at,
            'id', v_next_id
          )::text,
          'UTF8'
        ),
        'base64'
      ),
      E'\n',
      ''
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'items', v_items,
    'nextCursor', v_next_cursor
  );
end;
$$;

revoke all on function
  public.api_admin_list_manual_quote_requests(text, integer)
  from public, anon, authenticated, service_role;
grant execute on function
  public.api_admin_list_manual_quote_requests(text, integer)
  to authenticated;

create or replace function public.api_admin_complete_manual_quote_request(
  p_quote_request_id uuid,
  p_quote_run_id uuid,
  p_job_id uuid,
  p_part_id uuid,
  p_vendor public.vendor_name,
  p_reason text,
  p_idempotency_key text,
  p_status public.vendor_status default 'official_quote_received',
  p_summary_note text default null,
  p_source_text text default null,
  p_quote_url text default null,
  p_offers jsonb default '[]'::jsonb,
  p_artifacts jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_actor_user_id uuid;
  v_request public.quote_requests%rowtype;
  v_quote_run public.quote_runs%rowtype;
  v_job public.jobs%rowtype;
  v_part public.parts%rowtype;
  v_result public.vendor_quote_results%rowtype;
  v_existing_event public.commercial_admin_audit_events%rowtype;
  v_offer jsonb;
  v_offer_key text;
  v_offer_keys text[] := '{}'::text[];
  v_offer_total numeric;
  v_offer_unit numeric;
  v_offer_lead integer;
  v_offer_quantity integer;
  v_offer_ordinality bigint;
  v_artifact jsonb;
  v_artifact_paths text[] := '{}'::text[];
  v_summary_offer jsonb;
  v_summary_total numeric;
  v_summary_unit numeric;
  v_summary_lead integer;
  v_offer_id uuid;
  v_sort_rank integer := 0;
  v_requested_quantity integer := 1;
  v_supplier text;
  v_scope text;
  v_request_metadata jsonb;
  v_before jsonb;
  v_after jsonb;
  v_event_id uuid;
begin
  v_actor_user_id :=
    private.require_commercial_admin_capability('billing_admin');

  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'A reason is required to complete a manual quote request.';
  end if;

  if nullif(trim(coalesce(p_idempotency_key, '')), '') is null then
    raise exception 'An idempotency key is required to complete a manual quote request.';
  end if;

  if p_status not in (
    'instant_quote_received',
    'official_quote_received'
  ) then
    raise exception 'Manual quote completion requires a received quote status.';
  end if;

  if pg_catalog.jsonb_typeof(coalesce(p_offers, '[]'::jsonb)) <> 'array'
    or pg_catalog.jsonb_array_length(coalesce(p_offers, '[]'::jsonb)) = 0
  then
    raise exception 'At least one offer lane is required for manual quote completion.';
  end if;

  if pg_catalog.jsonb_typeof(coalesce(p_artifacts, '[]'::jsonb)) <> 'array' then
    raise exception 'Manual quote artifacts must be a JSON array.';
  end if;

  if pg_catalog.jsonb_array_length(p_offers) > 100 then
    raise exception 'Manual quote completion supports at most 100 offer lanes.';
  end if;

  select request_row.*
  into v_request
  from public.quote_requests request_row
  where request_row.id = p_quote_request_id;

  if v_request.id is null then
    raise exception 'Manual quote request was not found.';
  end if;

  if v_request.job_id is distinct from p_job_id then
    raise exception 'Manual quote request does not belong to the supplied job.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'manual-quote-request:' || p_quote_request_id::text,
      0
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'quote-request:' || p_job_id::text,
      0
    )
  );

  select job_row.*
  into v_job
  from public.jobs job_row
  where job_row.id = p_job_id
  for update;

  select request_row.*
  into v_request
  from public.quote_requests request_row
  where request_row.id = p_quote_request_id
  for update;

  select quote_run.*
  into v_quote_run
  from public.quote_runs quote_run
  where quote_run.id = p_quote_run_id
  for update;

  if v_job.id is null then
    raise exception 'Job was not found.';
  end if;

  if v_request.id is null
    or v_request.job_id is distinct from v_job.id
    or v_request.organization_id is distinct from v_job.organization_id
  then
    raise exception 'Manual quote request lineage changed before completion.';
  end if;

  if v_quote_run.id is null
    or v_quote_run.quote_request_id is distinct from v_request.id
    or v_quote_run.job_id is distinct from v_job.id
    or v_quote_run.organization_id is distinct from v_job.organization_id
  then
    raise exception 'Quote run does not belong to the supplied manual quote request and job.';
  end if;

  select part_row.*
  into v_part
  from public.parts part_row
  where part_row.id = p_part_id
    and part_row.job_id = v_job.id
    and part_row.organization_id = v_job.organization_id;

  if v_part.id is null then
    raise exception 'Part does not belong to the supplied manual quote request job.';
  end if;

  v_scope := 'manual_quote_request_complete:' || v_request.id::text;
  v_request_metadata := pg_catalog.jsonb_build_object(
    'quoteRequestId', v_request.id, -- NOSONAR: stable JSON contract key
    'quoteRunId', v_quote_run.id,
    'jobId', v_job.id,
    'partId', v_part.id, -- NOSONAR: stable JSON contract key
    'vendor', p_vendor,
    'status', p_status,
    'payloadFingerprint',
      pg_catalog.md5(
        pg_catalog.jsonb_build_object(
          'summaryNote', p_summary_note,
          'sourceText', p_source_text,
          'quoteUrl', p_quote_url,
          'offers', p_offers,
          'artifacts', p_artifacts
        )::text
      )
  );

  select event_row.*
  into v_existing_event
  from public.commercial_admin_audit_events event_row
  where event_row.idempotency_scope = v_scope
    and event_row.idempotency_key = trim(p_idempotency_key);

  if v_existing_event.id is not null then
    if v_existing_event.actor_user_id is distinct from v_actor_user_id
      or v_existing_event.organization_id is distinct from v_job.organization_id
      or v_existing_event.action is distinct from
        'commercial.manual_quote.complete'
      or v_existing_event.target_type is distinct from 'manual_quote_request'
      or v_existing_event.target_id is distinct from v_request.id::text
      or v_existing_event.reason is distinct from trim(p_reason)
      or v_existing_event.request_metadata is distinct from v_request_metadata
    then
      raise exception 'Idempotency key has already been used for a different manual quote completion.';
    end if;

    return v_existing_event.after_state
      || pg_catalog.jsonb_build_object(
        'eventId', v_existing_event.id,
        'replayed', true
      );
  end if;

  if v_request.request_mode <> 'manual' then
    raise exception 'Only manual quote requests can be completed through this operation.';
  end if;

  if v_request.status not in ('queued', 'requesting') then
    raise exception 'Manual quote request is no longer active.';
  end if;

  if v_quote_run.status not in ('queued', 'running') then
    raise exception 'Manual quote run is no longer active.';
  end if;

  if v_job.archived_at is not null then
    raise exception 'Archived jobs cannot receive manual quote completion.';
  end if;

  if v_job.status <> 'awaiting_vendor_manual_review' then
    raise exception 'Job is no longer awaiting manual quote review.';
  end if;

  if exists (
    select 1
    from public.published_quote_packages package_row
    where package_row.quote_run_id = v_quote_run.id
  ) then
    raise exception 'Published quote runs cannot receive manual quote completion.';
  end if;

  for v_offer, v_offer_ordinality in
    select offer_row.value, offer_row.ordinality
    from pg_catalog.jsonb_array_elements(p_offers)
      with ordinality as offer_row(value, ordinality)
  loop
    if pg_catalog.jsonb_typeof(v_offer) <> 'object' then
      raise exception 'Each manual quote offer must be a JSON object.';
    end if;

    if v_offer ? 'offerId' then -- NOSONAR: stable offer contract key
      v_offer_key := nullif(trim(v_offer ->> 'offerId'), '');
      if v_offer_key is null then
        raise exception 'Manual quote offer keys must be nonempty.';
      end if;
    else
      v_offer_key := pg_catalog.format(
        'offer-%s',
        v_offer_ordinality - 1
      );
    end if;

    if pg_catalog.length(v_offer_key) > 200 then
      raise exception 'Manual quote offer keys must be at most 200 characters.';
    end if;

    if v_offer_key = any(v_offer_keys) then
      raise exception 'Manual quote offer keys must be unique.';
    end if;
    v_offer_keys := pg_catalog.array_append(v_offer_keys, v_offer_key);

    if nullif(v_offer ->> 'totalPriceUsd', '') is null -- NOSONAR: stable offer contract key
      or (v_offer ->> 'totalPriceUsd')
        !~ '^[0-9]{1,10}([.][0-9]{1,2})?$'
    then
      raise exception 'Every manual quote offer requires a total price from 0 to 9999999999.99.';
    end if;
    v_offer_total := (v_offer ->> 'totalPriceUsd')::numeric;
    if v_offer_total > 9999999999.99 then
      raise exception 'Every manual quote offer requires a total price from 0 to 9999999999.99.';
    end if;

    if v_offer ? 'unitPriceUsd' -- NOSONAR: stable offer contract key
      and pg_catalog.jsonb_typeof(v_offer -> 'unitPriceUsd') <> 'null'
    then
      if nullif(v_offer ->> 'unitPriceUsd', '') is null
        or (v_offer ->> 'unitPriceUsd')
          !~ '^[0-9]{1,10}([.][0-9]{1,2})?$'
      then
        raise exception 'Manual quote unit prices must be from 0 to 9999999999.99.';
      end if;
      v_offer_unit := (v_offer ->> 'unitPriceUsd')::numeric;
      if v_offer_unit > 9999999999.99 then
        raise exception 'Manual quote unit prices must be from 0 to 9999999999.99.';
      end if;
    end if;

    if v_offer ? 'leadTimeBusinessDays' -- NOSONAR: stable offer contract key
      and pg_catalog.jsonb_typeof(
        v_offer -> 'leadTimeBusinessDays'
      ) <> 'null'
    then
      if nullif(v_offer ->> 'leadTimeBusinessDays', '') is null
        or (v_offer ->> 'leadTimeBusinessDays') !~ '^[0-9]{1,4}$'
      then
        raise exception 'Manual quote lead time must be from 0 to 3650 business days.';
      end if;
      v_offer_lead :=
        (v_offer ->> 'leadTimeBusinessDays')::integer;
      if v_offer_lead > 3650 then
        raise exception 'Manual quote lead time must be from 0 to 3650 business days.';
      end if;
    end if;

    if v_offer ? 'requestedQuantity' -- NOSONAR: stable offer contract key
      and pg_catalog.jsonb_typeof(v_offer -> 'requestedQuantity') <> 'null'
    then
      if nullif(v_offer ->> 'requestedQuantity', '') is null
        or (v_offer ->> 'requestedQuantity') !~ '^[0-9]{1,7}$'
      then
        raise exception 'Manual quote requested quantity must be from 1 to 1000000.';
      end if;
      v_offer_quantity := (v_offer ->> 'requestedQuantity')::integer;
      if v_offer_quantity < 1 or v_offer_quantity > 1000000 then
        raise exception 'Manual quote requested quantity must be from 1 to 1000000.';
      end if;
    end if;
  end loop;

  for v_artifact in
    select artifact_row.value
    from pg_catalog.jsonb_array_elements(
      coalesce(p_artifacts, '[]'::jsonb)
    ) artifact_row(value)
  loop
    if coalesce(
      nullif(v_artifact ->> 'storageBucket', ''),
      'quote-artifacts' -- NOSONAR: stable storage bucket contract
    ) <> 'quote-artifacts'
    then
      raise exception 'Manual quote evidence must use the quote-artifacts bucket.';
    end if;

    if nullif(v_artifact ->> 'storagePath', '') is null -- NOSONAR: stable artifact contract key
      or (v_artifact ->> 'storagePath')
        not like
          'manual-completions/'
          || v_request.id::text
          || '/'
          || v_quote_run.id::text
          || '/'
          || v_job.id::text
          || '/%'
      or nullif(
        split_part(v_artifact ->> 'storagePath', '/', 5),
        ''
      ) is null
      or split_part(v_artifact ->> 'storagePath', '/', 5) in ('.', '..')
      or nullif(
        split_part(v_artifact ->> 'storagePath', '/', 6),
        ''
      ) is not null
    then
      raise exception 'Manual quote evidence path does not match the supplied request, run, and job.';
    end if;

    if (v_artifact ->> 'storagePath') = any(v_artifact_paths) then
      raise exception 'Manual quote evidence paths must be unique.';
    end if;
    v_artifact_paths :=
      pg_catalog.array_append(
        v_artifact_paths,
        v_artifact ->> 'storagePath'
      );
  end loop;

  select offer_row.value
  into v_summary_offer
  from pg_catalog.jsonb_array_elements(p_offers) offer_row(value)
  order by
    coalesce(
      nullif(offer_row.value ->> 'totalPriceUsd', '')::numeric,
      999999999
    ),
    coalesce(
      nullif(offer_row.value ->> 'leadTimeBusinessDays', '')::integer,
      999999
    )
  limit 1;

  v_summary_total :=
    nullif(v_summary_offer ->> 'totalPriceUsd', '')::numeric;
  v_summary_unit :=
    nullif(v_summary_offer ->> 'unitPriceUsd', '')::numeric;
  v_summary_lead :=
    nullif(v_summary_offer ->> 'leadTimeBusinessDays', '')::integer;
  v_requested_quantity := greatest(
    coalesce(
      nullif(v_summary_offer ->> 'requestedQuantity', '')::integer,
      v_part.quantity,
      1
    ),
    1
  );

  if (v_summary_total is null and v_summary_unit is null)
    or coalesce(v_summary_total, 0) < 0
    or coalesce(v_summary_unit, 0) < 0
    or coalesce(v_summary_lead, 0) < 0
  then
    raise exception 'Manual quote summary pricing and lead time must be valid non-negative values.';
  end if;

  v_supplier := case
    when p_vendor = 'sendcutsend' then 'SendCutSend'
    when p_vendor = 'protolabs' then 'Protolabs'
    else pg_catalog.initcap(p_vendor::text)
  end;

  v_before := pg_catalog.jsonb_build_object(
    'requestStatus', v_request.status,
    'quoteRunStatus', v_quote_run.status,
    'jobStatus', v_job.status
  );

  insert into public.vendor_quote_results (
    quote_run_id,
    part_id,
    organization_id,
    vendor,
    requested_quantity,
    status,
    unit_price_usd,
    total_price_usd,
    lead_time_business_days,
    quote_url,
    dfm_issues,
    notes,
    raw_payload
  )
  values (
    v_quote_run.id,
    v_part.id,
    v_job.organization_id,
    p_vendor,
    v_requested_quantity,
    p_status,
    v_summary_unit,
    v_summary_total,
    v_summary_lead,
    p_quote_url,
    '[]'::jsonb,
    pg_catalog.to_jsonb(
      pg_catalog.array_remove(
        array[
          'Recorded through exact manual quote administration.',
          nullif(trim(coalesce(p_summary_note, '')), '')
        ],
        null
      )
    ),
    pg_catalog.jsonb_build_object(
      'source', 'manual-quote-admin-inbox',
      'sourceText', p_source_text,
      'summaryOfferKey',
        coalesce(nullif(v_summary_offer ->> 'offerId', ''), 'offer-0'),
      'offerCount', pg_catalog.jsonb_array_length(p_offers),
      'requestedQuantity', v_requested_quantity,
      'quoteRequestId', v_request.id
    )
  )
  on conflict (
    quote_run_id,
    part_id,
    vendor,
    requested_quantity
  ) do update
  set
    status = excluded.status,
    unit_price_usd = excluded.unit_price_usd,
    total_price_usd = excluded.total_price_usd,
    lead_time_business_days = excluded.lead_time_business_days,
    quote_url = excluded.quote_url,
    dfm_issues = excluded.dfm_issues,
    notes = excluded.notes,
    raw_payload = excluded.raw_payload,
    updated_at = pg_catalog.timezone('utc', pg_catalog.now())
  returning * into v_result;

  delete from public.vendor_quote_offers offer_row
  where offer_row.vendor_quote_result_id = v_result.id;

  for v_offer in
    select offer_row.value
    from pg_catalog.jsonb_array_elements(p_offers) offer_row(value)
  loop
    insert into public.vendor_quote_offers (
      vendor_quote_result_id,
      organization_id,
      offer_key,
      supplier,
      lane_label,
      sourcing,
      tier,
      quote_ref,
      quote_date,
      unit_price_usd,
      total_price_usd,
      lead_time_business_days,
      ship_receive_by,
      due_date,
      process,
      material,
      finish,
      tightest_tolerance,
      tolerance_source,
      thread_callouts,
      thread_match_notes,
      notes,
      sort_rank,
      raw_payload
    )
    values (
      v_result.id,
      v_job.organization_id,
      coalesce(
        nullif(v_offer ->> 'offerId', ''),
        pg_catalog.format('offer-%s', v_sort_rank)
      ),
      coalesce(nullif(v_offer ->> 'supplier', ''), v_supplier),
      coalesce(
        nullif(v_offer ->> 'laneLabel', ''),
        nullif(
          pg_catalog.concat_ws(
            ' / ',
            nullif(v_offer ->> 'sourcing', ''),
            nullif(v_offer ->> 'tier', '')
          ),
          ''
        ),
        coalesce(nullif(v_offer ->> 'supplier', ''), v_supplier)
      ),
      nullif(v_offer ->> 'sourcing', ''),
      nullif(v_offer ->> 'tier', ''),
      nullif(v_offer ->> 'quoteRef', ''),
      case
        when nullif(v_offer ->> 'quoteDateIso', '')
          ~ '^\d{4}-\d{2}-\d{2}$'
          then (v_offer ->> 'quoteDateIso')::date
        else null
      end,
      nullif(v_offer ->> 'unitPriceUsd', '')::numeric,
      nullif(v_offer ->> 'totalPriceUsd', '')::numeric,
      nullif(v_offer ->> 'leadTimeBusinessDays', '')::integer,
      nullif(v_offer ->> 'shipReceiveBy', ''),
      nullif(v_offer ->> 'dueDate', ''),
      nullif(v_offer ->> 'process', ''),
      nullif(v_offer ->> 'material', ''),
      nullif(v_offer ->> 'finish', ''),
      nullif(v_offer ->> 'tightestTolerance', ''),
      nullif(v_offer ->> 'toleranceSource', ''),
      nullif(v_offer ->> 'threadCallouts', ''),
      nullif(v_offer ->> 'threadMatchNotes', ''),
      nullif(v_offer ->> 'notes', ''),
      v_sort_rank,
      v_offer
    )
    returning id into v_offer_id;

    v_sort_rank := v_sort_rank + 1;
  end loop;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(
      coalesce(p_artifacts, '[]'::jsonb)
    ) artifact_row(value)
    join public.vendor_quote_artifacts existing_artifact
      on existing_artifact.storage_path =
        artifact_row.value ->> 'storagePath'
    where existing_artifact.vendor_quote_result_id <> v_result.id
  ) then
    raise exception 'Manual quote evidence path is already attached to another quote.';
  end if;

  insert into public.vendor_quote_artifacts (
    vendor_quote_result_id,
    organization_id,
    artifact_type,
    storage_bucket,
    storage_path,
    metadata
  )
  select
    v_result.id,
    v_job.organization_id,
    coalesce(
      nullif(artifact_row.value ->> 'artifactType', ''),
      'uploaded_evidence'
    ),
    'quote-artifacts',
    artifact_row.value ->> 'storagePath',
    coalesce(artifact_row.value -> 'metadata', '{}'::jsonb)
  from pg_catalog.jsonb_array_elements(
    coalesce(p_artifacts, '[]'::jsonb)
  ) artifact_row(value)
  on conflict (storage_path) do update
  set metadata = excluded.metadata;

  update public.quote_requests request_row
  set
    status = 'received',
    failure_reason = null,
    received_at = coalesce(
      request_row.received_at,
      pg_catalog.timezone('utc', pg_catalog.now())
    ),
    failed_at = null,
    canceled_at = null
  where request_row.id = v_request.id;

  update public.quote_runs quote_run
  set status = 'completed'
  where quote_run.id = v_quote_run.id;

  update public.jobs job_row
  set status = 'internal_review'
  where job_row.id = v_job.id;

  v_after := pg_catalog.jsonb_build_object(
    'quoteRequestId', v_request.id,
    'quoteRunId', v_quote_run.id,
    'jobId', v_job.id,
    'partId', v_part.id,
    'vendorQuoteResultId', v_result.id,
    'requestStatus', 'received',
    'quoteRunStatus', 'completed',
    'jobStatus', 'internal_review'
  );

  v_event_id := private.append_commercial_admin_audit_event(
    v_job.organization_id,
    'billing_admin',
    'commercial.manual_quote.complete',
    'manual_quote_request',
    v_request.id::text,
    trim(p_reason),
    v_before,
    v_after,
    v_request_metadata,
    v_scope,
    trim(p_idempotency_key)
  );

  perform public.log_audit_event(
    v_job.organization_id,
    'job.manual_vendor_quote_recorded',
    pg_catalog.jsonb_build_object(
      'partId', v_part.id,
      'vendor', p_vendor,
      'quoteRequestId', v_request.id,
      'quoteRunId', v_quote_run.id,
      'vendorQuoteResultId', v_result.id,
      'requestedQuantity', v_requested_quantity,
      'adminInbox', true
    ),
    v_job.id,
    null
  );

  return v_after
    || pg_catalog.jsonb_build_object(
      'eventId', v_event_id,
      'replayed', false
    );
end;
$$;

revoke all on function
  public.api_admin_complete_manual_quote_request(
    uuid,
    uuid,
    uuid,
    uuid,
    public.vendor_name,
    text,
    text,
    public.vendor_status,
    text,
    text,
    text,
    jsonb,
    jsonb
  )
  from public, anon, authenticated, service_role;
grant execute on function
  public.api_admin_complete_manual_quote_request(
    uuid,
    uuid,
    uuid,
    uuid,
    public.vendor_name,
    text,
    text,
    public.vendor_status,
    text,
    text,
    text,
    jsonb,
    jsonb
  )
  to authenticated;

create or replace function public.current_user_can_access_manual_quote_artifact(
  p_vendor_quote_result_id uuid,
  p_storage_bucket text,
  p_storage_path text,
  p_require_registered boolean,
  p_require_aal2 boolean
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  v_request_id uuid;
  v_quote_run_id uuid;
  v_job_id uuid;
begin
  if not public.current_user_has_commercial_capability('billing_admin') then
    return false;
  end if;

  if coalesce(p_require_aal2, false)
    and not public.current_user_has_aal2()
  then
    return false;
  end if;

  if p_storage_bucket is distinct from 'quote-artifacts'
    or split_part(coalesce(p_storage_path, ''), '/', 1)
      <> 'manual-completions'
    or nullif(split_part(coalesce(p_storage_path, ''), '/', 5), '') is null
    or split_part(coalesce(p_storage_path, ''), '/', 5) in ('.', '..')
    or nullif(split_part(coalesce(p_storage_path, ''), '/', 6), '') is not null
  then
    return false;
  end if;

  begin
    v_request_id := split_part(p_storage_path, '/', 2)::uuid;
    v_quote_run_id := split_part(p_storage_path, '/', 3)::uuid;
    v_job_id := split_part(p_storage_path, '/', 4)::uuid;
  exception
    when others then
      return false;
  end;

  if not coalesce(p_require_registered, false) then
    return
      p_vendor_quote_result_id is null
      and exists (
        select 1
        from public.quote_requests request_row
        join public.quote_runs quote_run
          on quote_run.id = v_quote_run_id
         and quote_run.quote_request_id = request_row.id
         and quote_run.job_id = request_row.job_id
         and quote_run.organization_id = request_row.organization_id
        join public.jobs job_row
          on job_row.id = request_row.job_id
         and job_row.organization_id = request_row.organization_id
        where request_row.id = v_request_id
          and request_row.job_id = v_job_id
          and request_row.request_mode = 'manual'
          and request_row.status in ('queued', 'requesting')
          and quote_run.status in ('queued', 'running')
          and job_row.archived_at is null
          and job_row.status = 'awaiting_vendor_manual_review'
      );
  end if;

  return exists (
    select 1
    from public.vendor_quote_artifacts artifact_row
    join public.vendor_quote_results result_row
      on result_row.id = artifact_row.vendor_quote_result_id
    join public.quote_runs quote_run
      on quote_run.id = result_row.quote_run_id
    join public.quote_requests request_row
      on request_row.id = quote_run.quote_request_id
    where artifact_row.storage_bucket = p_storage_bucket
      and artifact_row.storage_path = p_storage_path
      and (
        p_vendor_quote_result_id is null
        or artifact_row.vendor_quote_result_id =
          p_vendor_quote_result_id
      )
      and request_row.request_mode = 'manual'
      and request_row.id = v_request_id
      and quote_run.id = v_quote_run_id
      and request_row.job_id = v_job_id
  );
end;
$$;

revoke all on function
  public.current_user_can_access_manual_quote_artifact(
    uuid,
    text,
    text,
    boolean,
    boolean
  )
  from public, anon, authenticated, service_role;
grant execute on function
  public.current_user_can_access_manual_quote_artifact(
    uuid,
    text,
    text,
    boolean,
    boolean
  )
  to authenticated;

create or replace function
  public.current_user_can_delete_unregistered_manual_quote_upload(
    p_storage_bucket text,
    p_storage_path text,
    p_owner_id text,
    p_created_at timestamptz
  )
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  v_request_id uuid;
  v_quote_run_id uuid;
  v_job_id uuid;
  v_actor_user_id uuid;
begin
  v_actor_user_id := auth.uid();

  if v_actor_user_id is null
    or not public.current_user_has_commercial_capability('billing_admin')
    or not public.current_user_has_aal2()
    or p_storage_bucket is distinct from 'quote-artifacts'
    or p_owner_id is distinct from v_actor_user_id::text
    or p_created_at is null
    or p_created_at > pg_catalog.now()
    or p_created_at < pg_catalog.now() - interval '1 hour'
    or split_part(coalesce(p_storage_path, ''), '/', 1)
      <> 'manual-completions'
    or nullif(split_part(coalesce(p_storage_path, ''), '/', 5), '') is null
    or split_part(coalesce(p_storage_path, ''), '/', 5) in ('.', '..')
    or nullif(split_part(coalesce(p_storage_path, ''), '/', 6), '') is not null
  then
    return false;
  end if;

  begin
    v_request_id := split_part(p_storage_path, '/', 2)::uuid;
    v_quote_run_id := split_part(p_storage_path, '/', 3)::uuid;
    v_job_id := split_part(p_storage_path, '/', 4)::uuid;
  exception
    when others then
      return false;
  end;

  return
    exists (
      select 1
      from public.quote_requests request_row
      join public.quote_runs quote_run
        on quote_run.id = v_quote_run_id
       and quote_run.quote_request_id = request_row.id
       and quote_run.job_id = request_row.job_id
       and quote_run.organization_id = request_row.organization_id
      join public.jobs job_row
        on job_row.id = request_row.job_id
       and job_row.organization_id = request_row.organization_id
      where request_row.id = v_request_id
        and request_row.job_id = v_job_id
        and request_row.request_mode = 'manual'
    )
    and not exists (
      select 1
      from public.vendor_quote_artifacts artifact_row
      where artifact_row.storage_bucket = p_storage_bucket
        and artifact_row.storage_path = p_storage_path
    );
end;
$$;

revoke all on function
  public.current_user_can_delete_unregistered_manual_quote_upload(
    text,
    text,
    text,
    timestamptz
  )
  from public, anon, authenticated, service_role;
grant execute on function
  public.current_user_can_delete_unregistered_manual_quote_upload(
    text,
    text,
    text,
    timestamptz
  )
  to authenticated;

drop policy if exists "vendor_quote_artifacts_select_billing_admin"
  on public.vendor_quote_artifacts;
create policy "vendor_quote_artifacts_select_billing_admin"
on public.vendor_quote_artifacts
for select
to authenticated
using (
  public.current_user_can_access_manual_quote_artifact(
    vendor_quote_result_id,
    storage_bucket,
    storage_path,
    true,
    false
  )
);

drop policy if exists "quote_artifacts_storage_insert_billing_admin"
  on storage.objects;
create policy "quote_artifacts_storage_insert_billing_admin"
on storage.objects
for insert
to authenticated
with check (
  public.current_user_can_access_manual_quote_artifact(
    null,
    bucket_id,
    name,
    false,
    true
  )
);

drop policy if exists "quote_artifacts_storage_read_billing_admin"
  on storage.objects;
create policy "quote_artifacts_storage_read_billing_admin"
on storage.objects
for select
to authenticated
using (
  public.current_user_can_access_manual_quote_artifact(
    null,
    bucket_id,
    name,
    true,
    false
  )
);

drop policy if exists "quote_artifacts_storage_delete_billing_admin"
  on storage.objects;
drop policy if exists
  "quote_artifacts_storage_delete_billing_admin_unregistered"
  on storage.objects;
create policy
  "quote_artifacts_storage_delete_billing_admin_unregistered"
on storage.objects
for delete
to authenticated
using (
  public.current_user_can_delete_unregistered_manual_quote_upload(
    bucket_id,
    name,
    owner_id,
    created_at
  )
);
