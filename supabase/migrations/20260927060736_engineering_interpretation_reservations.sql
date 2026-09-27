-- OVD-518: default-off interpretation reservation. No scheduler is installed.
-- The fixed 20-cent reservation is consumed even on failure; no paid adapter is
-- configured by this migration. The 4,000-cent monthly ceiling is conservative.
create table public.engineering_interpretation_reservations (
  request_id uuid primary key,
  conversation_id uuid not null,
  organization_id uuid not null,
  project_id uuid not null,
  owner_user_id uuid not null,
  expected_queue_revision bigint not null check (expected_queue_revision between 0 and 9007199254740990),
  idempotency_key uuid not null,
  budget_month date not null,
  reserved_cents integer not null default 20 check (reserved_cents = 20),
  state text not null default 'reserved' check (state in ('reserved','completed','failed')),
  failure_code text check (failure_code in ('timed_out','adapter_error','invalid_output','conflict')),
  failure_request_code text check (failure_request_code in ('timed_out','adapter_error','invalid_output','conflict')),
  final_arguments jsonb,
  receipt jsonb,
  reserved_at timestamptz not null default clock_timestamp(),
  deadline_at timestamptz not null default (clock_timestamp() + interval '20 seconds'),
  updated_at timestamptz not null default now(),
  unique (conversation_id,idempotency_key),
  foreign key (request_id,conversation_id,organization_id,project_id,owner_user_id)
    references public.engineering_requests(id,conversation_id,organization_id,project_id,owner_user_id),
  check ((state = 'reserved' and failure_code is null and failure_request_code is null and final_arguments is null and receipt is null)
    or (state = 'completed' and failure_code is null and failure_request_code is null and final_arguments is not null and receipt is not null)
    or (state = 'failed' and failure_code is not null and receipt is null))
);
create index engineering_interpretation_budget_month on public.engineering_interpretation_reservations(budget_month);
alter table public.engineering_interpretation_reservations enable row level security;
revoke all on public.engineering_interpretation_reservations from public,anon,authenticated,service_role;
grant select on public.engineering_interpretation_reservations to authenticated,service_role;
create policy engineering_interpretation_reservations_read
  on public.engineering_interpretation_reservations for select to authenticated
  using (owner_user_id = (select auth.uid())
    and engineering_private.engineering_access(organization_id,project_id));

-- All reservation and finalization writes use the existing request owner and
-- conversation lock. Neither model data nor a caller-selected role is authority.
create function engineering_private.reserve_prepared_interpretation(
  p_request_id uuid,p_expected_queue_revision bigint,p_idempotency_key uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_request public.engineering_requests%rowtype;
  v_conversation public.engineering_conversations%rowtype;
  v_queue public.engineering_change_queues%rowtype;
  v_reservation public.engineering_interpretation_reservations%rowtype;
  v_snapshot public.engineering_snapshots%rowtype;
  v_body text;
  v_month date;
  v_prior jsonb;
begin
  if p_request_id is null or p_idempotency_key is null
    or p_expected_queue_revision is null or p_expected_queue_revision not between 0 and 9007199254740990 then
    raise exception using errcode='22023',message='Invalid interpretation identity.';
  end if;
  select * into v_request from public.engineering_requests where id=p_request_id;
  if v_request.id is null then
    raise exception using errcode='42501',message='Engineering request is unavailable.';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('engineering:' || v_request.conversation_id::text,0));
  select * into v_conversation from public.engineering_conversations where id=v_request.conversation_id for update;
  select * into v_request from public.engineering_requests where id=p_request_id for update;
  if not engineering_private.engineering_actor_access(v_request.owner_user_id,v_request.organization_id,v_request.project_id) then
    raise exception using errcode='42501',message='Engineering access is unavailable.';
  end if;
  select * into v_reservation from public.engineering_interpretation_reservations where request_id=p_request_id for update;
  if v_reservation.request_id is not null then
    if v_reservation.expected_queue_revision <> p_expected_queue_revision
      or v_reservation.idempotency_key <> p_idempotency_key then
      raise exception using errcode='PT409',message='Interpretation replay changed.';
    end if;
    if v_reservation.state='reserved' and clock_timestamp()>=v_reservation.deadline_at then
      update public.engineering_interpretation_reservations
        set state='failed',failure_code='timed_out',updated_at=clock_timestamp() where request_id=p_request_id;
      update public.engineering_requests set interpretation_state='failed',updated_at=now() where id=p_request_id;
      return jsonb_build_object('state','failed','invoke',false,'failureCode','timed_out');
    end if;
    return jsonb_build_object('state',v_reservation.state,'invoke',false,
      'receipt',v_reservation.receipt,'failureCode',v_reservation.failure_code);
  end if;
  select * into v_queue from public.engineering_change_queues where conversation_id=v_request.conversation_id for update;
  if coalesce(v_queue.revision,0) <> p_expected_queue_revision
    or v_request.interpretation_state <> 'queued'
    or exists(select 1 from public.engineering_interpretations where request_id=p_request_id)
    or exists(select 1 from public.engineering_requests r where r.conversation_id=v_request.conversation_id
      and r.receipt_revision<v_request.receipt_revision
      and not exists(select 1 from public.engineering_interpretations i where i.request_id=r.id)) then
    raise exception using errcode='PT409',message='Engineering interpretation order changed.';
  end if;
  select * into strict v_snapshot from public.engineering_snapshots where id=v_request.input_snapshot_id;
  if v_conversation.head_snapshot_id<>v_request.input_snapshot_id then
    raise exception using errcode='PT409',message='Requested engineering context is stale.';
  end if;
  -- One serialization point for all requests in the UTC budget month.
  v_month:=date_trunc('month',clock_timestamp() at time zone 'UTC')::date;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('engineering-model-budget:' || v_month::text,0));
  if (select coalesce(sum(reserved_cents),0) from public.engineering_interpretation_reservations
      where budget_month=v_month) + 20 > 4000 then
    raise exception using errcode='PT429',message='Engineering interpretation budget exhausted.';
  end if;
  select body into strict v_body from public.engineering_messages where id=v_request.message_id;
  select i.provenance->'clarification' into v_prior
    from public.engineering_requests r
    join public.engineering_interpretations i on i.request_id=r.id
    where r.conversation_id=v_request.conversation_id
      and r.receipt_revision=v_request.receipt_revision-1 and i.outcome='needs_context'
    order by r.receipt_revision desc limit 1;
  insert into public.engineering_interpretation_reservations
    (request_id,conversation_id,organization_id,project_id,owner_user_id,expected_queue_revision,idempotency_key,budget_month)
    values(p_request_id,v_request.conversation_id,v_request.organization_id,v_request.project_id,
      v_request.owner_user_id,p_expected_queue_revision,p_idempotency_key,v_month);
  update public.engineering_requests set interpretation_state='running',updated_at=now() where id=p_request_id;
  return jsonb_build_object('state','reserved','invoke',true,'requestId',p_request_id,
    'text',v_body,'contextText',v_snapshot.context_text,'inputSnapshotId',v_snapshot.id,
    'contextSha256',v_snapshot.context_sha256,'inputSha256',
    encode(extensions.digest(v_body,'sha256'),'hex'),
    'organizationId',v_request.organization_id,'projectId',v_request.project_id,
    'priorClarification',v_prior);
end;
$$;
revoke all on function engineering_private.reserve_prepared_interpretation(uuid,bigint,uuid)
  from public,anon,authenticated,service_role;
grant execute on function engineering_private.reserve_prepared_interpretation(uuid,bigint,uuid) to service_role;
create function public.api_reserve_prepared_interpretation(
  p_request_id uuid,p_expected_queue_revision bigint,p_idempotency_key uuid
) returns jsonb language sql security invoker set search_path='' as $$
  select engineering_private.reserve_prepared_interpretation(p_request_id,p_expected_queue_revision,p_idempotency_key);
$$;
revoke all on function public.api_reserve_prepared_interpretation(uuid,bigint,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.api_reserve_prepared_interpretation(uuid,bigint,uuid) to service_role;

create function engineering_private.finish_prepared_interpretation(
  p_request_id uuid,p_expected_queue_revision bigint,p_idempotency_key uuid,
  p_outcome text,p_depth_mm numeric,p_response text,p_clarification jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_request public.engineering_requests%rowtype;
  v_reservation public.engineering_interpretation_reservations%rowtype;
  v_snapshot public.engineering_snapshots%rowtype;
  v_body text;
  v_arguments jsonb;
  v_provenance jsonb;
  v_receipt jsonb;
begin
  select * into v_request from public.engineering_requests where id=p_request_id;
  if v_request.id is null then raise exception using errcode='42501',message='Engineering request is unavailable.'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('engineering:' || v_request.conversation_id::text,0));
  select * into v_request from public.engineering_requests where id=p_request_id for update;
  if not engineering_private.engineering_actor_access(v_request.owner_user_id,v_request.organization_id,v_request.project_id) then
    raise exception using errcode='42501',message='Engineering access is unavailable.';
  end if;
  select * into v_reservation from public.engineering_interpretation_reservations where request_id=p_request_id for update;
  if v_reservation.request_id is null or v_reservation.expected_queue_revision<>p_expected_queue_revision
    or v_reservation.idempotency_key<>p_idempotency_key then
    raise exception using errcode='PT409',message='Interpretation reservation changed.';
  end if;
  if p_outcome is null or p_outcome not in ('prepared_change','needs_context','no_change')
    or (p_outcome='prepared_change' and (p_depth_mm is null or p_depth_mm not between 6 and 10 or p_clarification is not null))
    or (p_outcome<>'prepared_change' and p_depth_mm is not null)
    or (p_outcome='needs_context' and (
      p_clarification is null or jsonb_typeof(p_clarification)<>'object'
      or p_clarification->>'reason' not in ('unit','depth')
      or p_clarification->>'contextSha256' is null
      or p_clarification <> jsonb_build_object('reason',p_clarification->>'reason',
        'contextSha256',p_clarification->>'contextSha256','depthMm',p_clarification->'depthMm')))
    or (p_outcome='no_change' and p_clarification is not null)
    or p_response is null or char_length(p_response) not between 1 and 4000
    or octet_length(p_response)>8000 or p_response !~ '[^[:space:]]' then
    raise exception using errcode='22023',message='Invalid prepared interpretation result.';
  end if;
  if p_outcome='needs_context' then
    if p_clarification->>'reason'='unit' then
      if jsonb_typeof(p_clarification->'depthMm')<>'number' then
        raise exception using errcode='22023',message='Invalid clarification depth.';
      end if;
      if (p_clarification->>'depthMm')::numeric not between 6 and 10 then
        raise exception using errcode='22023',message='Invalid clarification depth.';
      end if;
    elsif p_clarification->'depthMm' <> 'null'::jsonb then
      raise exception using errcode='22023',message='Invalid clarification depth.';
    end if;
  end if;
  select * into strict v_snapshot from public.engineering_snapshots where id=v_request.input_snapshot_id;
  if p_clarification is not null and p_clarification->>'contextSha256'<>v_snapshot.context_sha256 then
    raise exception using errcode='PT409',message='Clarification context changed.';
  end if;
  v_arguments:=jsonb_build_object('outcome',p_outcome,'depthMm',p_depth_mm,
    'response',p_response,'clarification',p_clarification);
  if v_reservation.state='completed' then
    if v_reservation.final_arguments<>v_arguments then
      raise exception using errcode='PT409',message='Interpretation replay changed.';
    end if;
    return v_reservation.receipt;
  end if;
  if v_reservation.state<>'reserved' or clock_timestamp()>=v_reservation.deadline_at then
    raise exception using errcode='PT409',message='Interpretation reservation is no longer active.';
  end if;
  select body into strict v_body from public.engineering_messages where id=v_request.message_id;
  v_provenance:=jsonb_build_object('model','injected-bounded-adapter','promptVersion','prepared-depth-v1',
    'schemaVersion','overdrafter.prepared-interpretation.v1','policyVersion','prepared-depth-v1',
    'inputSha256',encode(extensions.digest(v_body,'sha256'),'hex'),
    'contextSha256',v_snapshot.context_sha256,'clarification',p_clarification);
  v_receipt:=engineering_private.resolve_engineering_request(p_request_id,p_expected_queue_revision,
    p_idempotency_key,p_outcome,p_depth_mm,p_response,v_provenance);
  update public.engineering_interpretation_reservations
    set state='completed',final_arguments=v_arguments,receipt=v_receipt,updated_at=now()
    where request_id=p_request_id;
  return v_receipt;
end;
$$;
revoke all on function engineering_private.finish_prepared_interpretation(uuid,bigint,uuid,text,numeric,text,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function engineering_private.finish_prepared_interpretation(uuid,bigint,uuid,text,numeric,text,jsonb) to service_role;
create function public.api_finish_prepared_interpretation(
  p_request_id uuid,p_expected_queue_revision bigint,p_idempotency_key uuid,
  p_outcome text,p_depth_mm numeric,p_response text,p_clarification jsonb
) returns jsonb language sql security invoker set search_path='' as $$
  select engineering_private.finish_prepared_interpretation(p_request_id,p_expected_queue_revision,p_idempotency_key,
    p_outcome,p_depth_mm,p_response,p_clarification);
$$;
revoke all on function public.api_finish_prepared_interpretation(uuid,bigint,uuid,text,numeric,text,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.api_finish_prepared_interpretation(uuid,bigint,uuid,text,numeric,text,jsonb) to service_role;

create function engineering_private.fail_prepared_interpretation(
  p_request_id uuid,p_expected_queue_revision bigint,p_idempotency_key uuid,p_failure_code text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_request public.engineering_requests%rowtype;
  v_reservation public.engineering_interpretation_reservations%rowtype;
  v_code text;
begin
  if p_failure_code is null or p_failure_code not in ('timed_out','adapter_error','invalid_output','conflict') then
    raise exception using errcode='22023',message='Invalid interpretation failure.';
  end if;
  select * into v_request from public.engineering_requests where id=p_request_id;
  if v_request.id is null then raise exception using errcode='42501',message='Engineering request is unavailable.'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('engineering:' || v_request.conversation_id::text,0));
  select * into v_request from public.engineering_requests where id=p_request_id for update;
  if not engineering_private.engineering_actor_access(v_request.owner_user_id,v_request.organization_id,v_request.project_id) then
    raise exception using errcode='42501',message='Engineering access is unavailable.';
  end if;
  select * into v_reservation from public.engineering_interpretation_reservations where request_id=p_request_id for update;
  if v_reservation.request_id is null or v_reservation.expected_queue_revision<>p_expected_queue_revision
    or v_reservation.idempotency_key<>p_idempotency_key or v_reservation.state='completed' then
    raise exception using errcode='PT409',message='Interpretation reservation changed.';
  end if;
  if v_reservation.state='failed' then
    if v_reservation.failure_request_code is distinct from p_failure_code then
      raise exception using errcode='PT409',message='Interpretation failure replay changed.';
    end if;
    v_code:=v_reservation.failure_code;
  else
    v_code:=case when clock_timestamp()>=v_reservation.deadline_at then 'timed_out' else p_failure_code end;
    update public.engineering_interpretation_reservations
      set state='failed',failure_code=v_code,failure_request_code=p_failure_code,
        updated_at=clock_timestamp() where request_id=p_request_id;
    update public.engineering_requests set interpretation_state='failed',updated_at=now() where id=p_request_id;
  end if;
  return jsonb_build_object('requestId',p_request_id,'state','failed','failureCode',v_code);
end;
$$;
revoke all on function engineering_private.fail_prepared_interpretation(uuid,bigint,uuid,text)
  from public,anon,authenticated,service_role;
grant execute on function engineering_private.fail_prepared_interpretation(uuid,bigint,uuid,text) to service_role;
create function public.api_fail_prepared_interpretation(
  p_request_id uuid,p_expected_queue_revision bigint,p_idempotency_key uuid,p_failure_code text
) returns jsonb language sql security invoker set search_path='' as $$
  select engineering_private.fail_prepared_interpretation(p_request_id,p_expected_queue_revision,p_idempotency_key,p_failure_code);
$$;
revoke all on function public.api_fail_prepared_interpretation(uuid,bigint,uuid,text)
  from public,anon,authenticated,service_role;
grant execute on function public.api_fail_prepared_interpretation(uuid,bigint,uuid,text) to service_role;
