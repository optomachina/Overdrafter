-- OVD-497: ordered accepted intent only. No claims, native success or activation.
-- Rollback disables API execution and preserves all history.
create unique index engineering_request_scope_key on public.engineering_requests
  (id, conversation_id, organization_id, project_id, owner_user_id);

create table public.engineering_change_queues (
  conversation_id uuid primary key,
  organization_id uuid not null,
  project_id uuid not null,
  owner_user_id uuid not null,
  revision bigint not null default 0 check (revision between 0 and 9007199254740991),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (conversation_id, organization_id, project_id, owner_user_id)
    references public.engineering_conversations(id, organization_id, project_id, owner_user_id)
);

create table public.engineering_interpretations (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  conversation_id uuid not null,
  organization_id uuid not null,
  project_id uuid not null,
  owner_user_id uuid not null,
  outcome text not null check (outcome in ('prepared_change', 'needs_context', 'no_change')),
  response text not null check (char_length(response) between 1 and 4000 and response ~ '[^[:space:]]'),
  provenance jsonb not null check (jsonb_typeof(provenance) = 'object' and octet_length(provenance::text) <= 8192),
  created_at timestamptz not null default now(),
  unique (id, conversation_id, organization_id, project_id, owner_user_id),
  foreign key (request_id, conversation_id, organization_id, project_id, owner_user_id)
    references public.engineering_requests(id, conversation_id, organization_id, project_id, owner_user_id)
);

create table public.engineering_decisions (
  id uuid primary key default gen_random_uuid(),
  interpretation_id uuid not null unique,
  conversation_id uuid not null,
  organization_id uuid not null,
  project_id uuid not null,
  owner_user_id uuid not null,
  sequence bigint not null check (sequence between 1 and 9007199254740991),
  predecessor_decision_id uuid,
  requested_snapshot_id uuid not null,
  requested_context_sha256 text not null check (requested_context_sha256 ~ '^[0-9a-f]{64}$'),
  operation jsonb not null,
  disposition text not null default 'accepted_for_evaluation' check (disposition = 'accepted_for_evaluation'),
  created_at timestamptz not null default now(),
  unique (conversation_id, sequence),
  unique (id, conversation_id, organization_id, project_id, owner_user_id),
  foreign key (interpretation_id, conversation_id, organization_id, project_id, owner_user_id)
    references public.engineering_interpretations(id, conversation_id, organization_id, project_id, owner_user_id),
  foreign key (predecessor_decision_id, conversation_id, organization_id, project_id, owner_user_id)
    references public.engineering_decisions(id, conversation_id, organization_id, project_id, owner_user_id),
  foreign key (requested_snapshot_id, organization_id, project_id)
    references public.engineering_snapshots(id, organization_id, project_id),
  check (predecessor_decision_id is distinct from id),
  constraint engineering_prepared_depth_operation check ((
    jsonb_typeof(operation->'depthMm') = 'number'
    and (operation->>'depthMm')::numeric between 6 and 10
    and operation = jsonb_build_object('kind','set_dimension','packageId','ovd-native04-assembly',
      'dimensionId','baseline-depth','configuration','Default','unit','mm','depthMm',operation->'depthMm')
  ) is true)
);

create table public.engineering_tasks (
  id uuid primary key default gen_random_uuid(),
  decision_id uuid not null unique,
  conversation_id uuid not null,
  organization_id uuid not null,
  project_id uuid not null,
  owner_user_id uuid not null,
  execution_state text not null default 'blocked' check (execution_state in ('blocked','queued','running','succeeded','failed','canceled')),
  verification_state text not null default 'unverified' check (verification_state in ('unverified','checking','passed','failed','stale')),
  adoption_state text not null default 'unadopted' check (adoption_state = 'unadopted'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (decision_id, conversation_id, organization_id, project_id, owner_user_id)
    references public.engineering_decisions(id, conversation_id, organization_id, project_id, owner_user_id),
  check (verification_state <> 'passed' or execution_state = 'succeeded')
);
comment on table public.engineering_tasks is
  'Accepted task admission, initially blocked pending the coordinator. No execution input, claim or success API exists yet. Requested context belongs to the decision; realized inputs must be frozen from verified predecessor evidence by the future coordinator.';

create table public.engineering_events (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null,
  organization_id uuid not null,
  project_id uuid not null,
  owner_user_id uuid not null,
  actor_user_id uuid references auth.users(id),
  kind text not null check (kind in ('interpretation_recorded','suffix_canceled')),
  idempotency_key uuid not null,
  expected_revision bigint not null check (expected_revision between 0 and 9007199254740990),
  receipt_revision bigint not null check (receipt_revision = expected_revision + 1),
  arguments jsonb not null,
  receipt jsonb not null,
  created_at timestamptz not null default now(),
  unique (conversation_id, idempotency_key),
  unique (conversation_id, receipt_revision),
  foreign key (conversation_id, organization_id, project_id, owner_user_id)
    references public.engineering_conversations(id, organization_id, project_id, owner_user_id),
  check ((kind = 'interpretation_recorded' and actor_user_id is null)
    or (kind = 'suffix_canceled' and actor_user_id is not null and actor_user_id = owner_user_id))
);

-- Keep queue admission and conversation reads scoped as immutable history grows.
create index engineering_tasks_conversation_state on public.engineering_tasks(conversation_id,execution_state,verification_state);
create index engineering_interpretations_conversation_created on public.engineering_interpretations(conversation_id,created_at,id);

-- Derive the actor from a persisted request, never from model text or an actor argument.
-- This private helper is not callable by API roles; definer entrypoints use it.
create function engineering_private.engineering_actor_access(p_actor uuid, p_org uuid, p_project uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_actor is not null and exists (
    select 1 from engineering_private.engineering_operators o
    join public.organization_memberships m using (organization_id,user_id)
    join public.projects p on p.organization_id = o.organization_id and p.id = p_project
    where o.organization_id = p_org and o.user_id = p_actor and o.enabled
    and (m.role in ('internal_estimator','internal_admin') or exists (
      select 1 from public.project_memberships pm where pm.project_id = p_project and pm.user_id = p_actor))
  );
$$;
revoke all on function engineering_private.engineering_actor_access(uuid,uuid,uuid) from public, anon, authenticated, service_role;

-- Future coordinator transitions must retain immutable decision/task identity.
create function engineering_private.preserve_engineering_queue_identity()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '55000', message = 'Engineering queue history cannot be deleted.';
  end if;
  if tg_table_name = 'engineering_tasks' then
    if (to_jsonb(new) - array['execution_state','verification_state','updated_at']) is distinct from
       (to_jsonb(old) - array['execution_state','verification_state','updated_at']) then
      raise exception using errcode = '55000', message = 'Engineering task identity is immutable.';
    end if;
  elsif (to_jsonb(new) - array['revision','updated_at']) is distinct from
        (to_jsonb(old) - array['revision','updated_at']) then
    raise exception using errcode = '55000', message = 'Engineering queue identity is immutable.';
  end if;
  return new;
end;
$$;
revoke all on function engineering_private.preserve_engineering_queue_identity() from public, anon, authenticated, service_role;

alter table public.engineering_change_queues enable row level security;
revoke all on public.engineering_change_queues from public, anon, authenticated, service_role;
grant select on public.engineering_change_queues to authenticated, service_role;
create policy engineering_change_queues_read on public.engineering_change_queues for select to authenticated
  using (owner_user_id = (select auth.uid()) and engineering_private.engineering_access(organization_id,project_id));
create trigger engineering_change_queues_immutable before update or delete on public.engineering_change_queues
  for each row execute function engineering_private.preserve_engineering_queue_identity();

alter table public.engineering_interpretations enable row level security;
revoke all on public.engineering_interpretations from public, anon, authenticated, service_role;
grant select on public.engineering_interpretations to authenticated, service_role;
create policy engineering_interpretations_read on public.engineering_interpretations for select to authenticated
  using (owner_user_id = (select auth.uid()) and engineering_private.engineering_access(organization_id,project_id));
create trigger engineering_interpretations_immutable before update or delete on public.engineering_interpretations
  for each row execute function engineering_private.reject_engineering_history_mutation();

alter table public.engineering_decisions enable row level security;
revoke all on public.engineering_decisions from public, anon, authenticated, service_role;
grant select on public.engineering_decisions to authenticated, service_role;
create policy engineering_decisions_read on public.engineering_decisions for select to authenticated
  using (owner_user_id = (select auth.uid()) and engineering_private.engineering_access(organization_id,project_id));
create trigger engineering_decisions_immutable before update or delete on public.engineering_decisions
  for each row execute function engineering_private.reject_engineering_history_mutation();

alter table public.engineering_tasks enable row level security;
revoke all on public.engineering_tasks from public, anon, authenticated, service_role;
grant select on public.engineering_tasks to authenticated, service_role;
create policy engineering_tasks_read on public.engineering_tasks for select to authenticated
  using (owner_user_id = (select auth.uid()) and engineering_private.engineering_access(organization_id,project_id));
create trigger engineering_tasks_immutable before update or delete on public.engineering_tasks
  for each row execute function engineering_private.preserve_engineering_queue_identity();

alter table public.engineering_events enable row level security;
revoke all on public.engineering_events from public, anon, authenticated, service_role;
grant select on public.engineering_events to authenticated, service_role;
create policy engineering_events_read on public.engineering_events for select to authenticated
  using (owner_user_id = (select auth.uid()) and engineering_private.engineering_access(organization_id,project_id));
create trigger engineering_events_immutable before update or delete on public.engineering_events
  for each row execute function engineering_private.reject_engineering_history_mutation();

create function engineering_private.resolve_engineering_request(
  p_request_id uuid, p_expected_revision bigint, p_idempotency_key uuid,
  p_outcome text, p_depth_mm numeric, p_response text, p_provenance jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_request public.engineering_requests%rowtype;
  v_conversation public.engineering_conversations%rowtype;
  v_queue public.engineering_change_queues%rowtype;
  v_event public.engineering_events%rowtype;
  v_snapshot public.engineering_snapshots%rowtype;
  v_predecessor uuid;
  v_sequence bigint;
  v_interpretation uuid;
  v_decision uuid;
  v_task uuid;
  v_arguments jsonb;
  v_receipt jsonb;
begin
  if p_request_id is null or p_idempotency_key is null or p_expected_revision is null
    or p_expected_revision not between 0 and 9007199254740990
    or p_outcome is null or p_outcome not in ('prepared_change','needs_context','no_change')
    or p_response is null or char_length(p_response) not between 1 and 4000 or p_response !~ '[^[:space:]]'
    or p_provenance is null or jsonb_typeof(p_provenance) <> 'object' or octet_length(p_provenance::text) > 8192
    or not (p_provenance ?& array['model','promptVersion','schemaVersion','policyVersion','inputSha256','contextSha256'])
    or jsonb_typeof(p_provenance->'model') is distinct from 'string'
    or jsonb_typeof(p_provenance->'promptVersion') is distinct from 'string'
    or coalesce(p_provenance->>'model','') !~ '[^[:space:]]' or coalesce(p_provenance->>'promptVersion','') !~ '[^[:space:]]'
    or p_provenance->>'schemaVersion' is distinct from 'overdrafter.prepared-interpretation.v1'
    or p_provenance->>'policyVersion' is distinct from 'prepared-depth-v1'
    or coalesce(p_provenance->>'inputSha256','') !~ '^[0-9a-f]{64}$'
    or (p_outcome = 'prepared_change' and (p_depth_mm is null or p_depth_mm not between 6 and 10))
    or (p_outcome <> 'prepared_change' and p_depth_mm is not null) then
    raise exception using errcode = '22023', message = 'Invalid prepared interpretation.';
  end if;
  select * into v_request from public.engineering_requests where id = p_request_id;
  if v_request.id is null then
    raise exception using errcode = '42501', message = 'Engineering request is unavailable.';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('engineering:' || v_request.conversation_id::text,0));
  select * into v_conversation from public.engineering_conversations where id = v_request.conversation_id for update;
  select * into v_request from public.engineering_requests where id = p_request_id for update;
  if not engineering_private.engineering_actor_access(v_request.owner_user_id,v_request.organization_id,v_request.project_id) then
    raise exception using errcode = '42501', message = 'Engineering access is unavailable.';
  end if;
  v_arguments := jsonb_build_object('requestId',p_request_id,'outcome',p_outcome,'depthMm',p_depth_mm,
    'response',p_response,'provenance',p_provenance);
  select * into v_event from public.engineering_events
    where conversation_id = v_request.conversation_id and idempotency_key = p_idempotency_key;
  if v_event.id is not null then
    if v_event.kind <> 'interpretation_recorded' or v_event.expected_revision <> p_expected_revision
      or v_event.arguments <> v_arguments then
      raise exception using errcode = 'PT409', message = 'Engineering idempotency key has another payload.';
    end if;
    return v_event.receipt;
  end if;
  insert into public.engineering_change_queues(conversation_id,organization_id,project_id,owner_user_id)
    values(v_request.conversation_id,v_request.organization_id,v_request.project_id,v_request.owner_user_id)
    on conflict (conversation_id) do nothing;
  select * into strict v_queue from public.engineering_change_queues where conversation_id = v_request.conversation_id for update;
  if v_queue.revision <> p_expected_revision then
    raise exception using errcode = 'PT409', message = 'Engineering queue changed; refresh before resolving.';
  end if;
  if exists(select 1 from public.engineering_interpretations where request_id = p_request_id)
    or v_request.interpretation_state not in ('queued','running') then
    raise exception using errcode = 'PT409', message = 'Engineering request is already resolved or unavailable.';
  end if;
  if exists(select 1 from public.engineering_requests r where r.conversation_id = v_request.conversation_id
    and r.receipt_revision < v_request.receipt_revision
    and not exists(select 1 from public.engineering_interpretations i where i.request_id = r.id)) then
    raise exception using errcode = 'PT409', message = 'An earlier engineering request must be resolved first.';
  end if;
  select * into strict v_snapshot from public.engineering_snapshots where id = v_request.input_snapshot_id;
  if p_provenance->>'contextSha256' is distinct from v_snapshot.context_sha256
    or p_provenance->>'inputSha256' is distinct from (select encode(extensions.digest(body,'sha256'),'hex')
      from public.engineering_messages where id = v_request.message_id) then
    raise exception using errcode = 'PT409', message = 'Interpretation provenance does not match the request.';
  end if;
  if p_outcome = 'prepared_change' then
    if v_conversation.head_snapshot_id <> v_request.input_snapshot_id then
      raise exception using errcode = 'PT409', message = 'Requested engineering context is stale.';
    end if;
    if (v_snapshot.context_text::jsonb->>'packageId') is distinct from 'ovd-native04-assembly'
      or (v_snapshot.context_text::jsonb->>'configuration') is distinct from 'Default' then
      raise exception using errcode = '22023', message = 'Unsupported prepared assembly context.';
    end if;
    if (select count(*) from public.engineering_tasks where conversation_id = v_request.conversation_id
      and execution_state <> 'canceled' and not (execution_state = 'succeeded' and verification_state = 'passed')) >= 5 then
      raise exception using errcode = 'PT409', message = 'Five engineering changes are already outstanding.';
    end if;
    if exists(select 1 from public.engineering_tasks where conversation_id = v_request.conversation_id
      and execution_state <> 'canceled' and (execution_state = 'failed' or verification_state in ('failed','stale'))) then
      raise exception using errcode = 'PT409', message = 'Resolve the failed engineering chain before accepting another change.';
    end if;
    select d.id into v_predecessor from public.engineering_decisions d
      join public.engineering_tasks t on t.decision_id = d.id
      where d.conversation_id = v_request.conversation_id and t.execution_state <> 'canceled'
      order by d.sequence desc limit 1;
    select coalesce(max(sequence),0)+1 into v_sequence from public.engineering_decisions where conversation_id = v_request.conversation_id;
  end if;
  insert into public.engineering_interpretations(request_id,conversation_id,organization_id,project_id,owner_user_id,outcome,response,provenance)
    values(p_request_id,v_request.conversation_id,v_request.organization_id,v_request.project_id,v_request.owner_user_id,p_outcome,p_response,p_provenance)
    returning id into v_interpretation;
  if p_outcome = 'prepared_change' then
    insert into public.engineering_decisions(interpretation_id,conversation_id,organization_id,project_id,owner_user_id,sequence,
      predecessor_decision_id,requested_snapshot_id,requested_context_sha256,operation)
      values(v_interpretation,v_request.conversation_id,v_request.organization_id,v_request.project_id,v_request.owner_user_id,v_sequence,
        v_predecessor,v_snapshot.id,v_snapshot.context_sha256,jsonb_build_object('kind','set_dimension','packageId','ovd-native04-assembly',
          'dimensionId','baseline-depth','configuration','Default','unit','mm','depthMm',p_depth_mm)) returning id into v_decision;
    insert into public.engineering_tasks(decision_id,conversation_id,organization_id,project_id,owner_user_id)
      values(v_decision,v_request.conversation_id,v_request.organization_id,v_request.project_id,v_request.owner_user_id) returning id into v_task;
  end if;
  update public.engineering_requests set interpretation_state = case when p_outcome = 'needs_context' then 'needs_context' else 'interpreted' end,
    updated_at = now() where id = p_request_id;
  update public.engineering_change_queues set revision = revision + 1, updated_at = now() where conversation_id = v_request.conversation_id;
  v_receipt := jsonb_build_object('conversationId',v_request.conversation_id,'requestId',p_request_id,
    'interpretationId',v_interpretation,'outcome',p_outcome,'decisionId',v_decision,'taskId',v_task,
    'predecessorDecisionId',v_predecessor,'revision',p_expected_revision+1);
  insert into public.engineering_events(conversation_id,organization_id,project_id,owner_user_id,kind,idempotency_key,
    expected_revision,receipt_revision,arguments,receipt)
    values(v_request.conversation_id,v_request.organization_id,v_request.project_id,v_request.owner_user_id,'interpretation_recorded',p_idempotency_key,
      p_expected_revision,p_expected_revision+1,v_arguments,v_receipt);
  return v_receipt;
end;
$$;
revoke all on function engineering_private.resolve_engineering_request(uuid,bigint,uuid,text,numeric,text,jsonb) from public, anon, authenticated, service_role;
grant execute on function engineering_private.resolve_engineering_request(uuid,bigint,uuid,text,numeric,text,jsonb) to service_role;
create function public.api_resolve_engineering_request(
  p_request_id uuid, p_expected_revision bigint, p_idempotency_key uuid,
  p_outcome text, p_depth_mm numeric, p_response text, p_provenance jsonb
) returns jsonb language sql security invoker set search_path = '' as $$
  select engineering_private.resolve_engineering_request(p_request_id,p_expected_revision,p_idempotency_key,
    p_outcome,p_depth_mm,p_response,p_provenance);
$$;
revoke all on function public.api_resolve_engineering_request(uuid,bigint,uuid,text,numeric,text,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.api_resolve_engineering_request(uuid,bigint,uuid,text,numeric,text,jsonb) to service_role;

create function engineering_private.cancel_engineering_suffix(
  p_conversation_id uuid, p_expected_revision bigint, p_idempotency_key uuid,
  p_decision_ids uuid[], p_reason text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_conversation public.engineering_conversations%rowtype;
  v_queue public.engineering_change_queues%rowtype;
  v_event public.engineering_events%rowtype;
  v_first_sequence bigint;
  v_suffix uuid[];
  v_arguments jsonb;
  v_receipt jsonb;
begin
  if auth.uid() is null or p_conversation_id is null then
    raise exception using errcode = '42501', message = 'Engineering conversation is unavailable.';
  end if;
  if p_expected_revision is null or p_expected_revision not between 0 and 9007199254740990
    or p_idempotency_key is null or p_decision_ids is null or cardinality(p_decision_ids) not between 1 and 5
    or p_reason is null or char_length(p_reason) not between 1 and 2000 or p_reason !~ '[^[:space:]]' then
    raise exception using errcode = '22023', message = 'Invalid engineering cancellation.';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('engineering:' || p_conversation_id::text,0));
  select * into v_conversation from public.engineering_conversations where id = p_conversation_id for update;
  if v_conversation.id is null or v_conversation.owner_user_id <> auth.uid()
    or not engineering_private.engineering_access(v_conversation.organization_id,v_conversation.project_id) then
    raise exception using errcode = '42501', message = 'Engineering conversation is unavailable.';
  end if;
  v_arguments := jsonb_build_object('decisionIds',p_decision_ids,'reason',p_reason);
  select * into v_event from public.engineering_events where conversation_id = p_conversation_id and idempotency_key = p_idempotency_key;
  if v_event.id is not null then
    if v_event.kind <> 'suffix_canceled' or v_event.expected_revision <> p_expected_revision or v_event.arguments <> v_arguments then
      raise exception using errcode = 'PT409', message = 'Engineering idempotency key has another payload.';
    end if;
    return v_event.receipt;
  end if;
  select * into v_queue from public.engineering_change_queues where conversation_id = p_conversation_id for update;
  if v_queue.conversation_id is null or v_queue.revision <> p_expected_revision then
    raise exception using errcode = 'PT409', message = 'Engineering queue changed; refresh before canceling.';
  end if;
  select sequence into v_first_sequence from public.engineering_decisions
    where id = p_decision_ids[1] and conversation_id = p_conversation_id;
  select array_agg(d.id order by d.sequence) into v_suffix from public.engineering_decisions d
    join public.engineering_tasks t on t.decision_id = d.id
    where d.conversation_id = p_conversation_id and d.sequence >= v_first_sequence and t.execution_state <> 'canceled';
  if v_suffix is null or v_suffix is distinct from p_decision_ids then
    raise exception using errcode = 'PT409', message = 'Cancellation must name the exact current suffix in order.';
  end if;
  if exists(select 1 from public.engineering_tasks where decision_id = any(v_suffix)
    and (execution_state not in ('blocked','queued') or verification_state <> 'unverified')) then
    raise exception using errcode = 'PT409', message = 'Native execution requires coordinator recovery before cancellation.';
  end if;
  update public.engineering_tasks set execution_state = 'canceled',updated_at = now() where decision_id = any(v_suffix);
  update public.engineering_change_queues set revision = revision + 1,updated_at = now() where conversation_id = p_conversation_id;
  v_receipt := jsonb_build_object('conversationId',p_conversation_id,'canceledDecisionIds',v_suffix,
    'revision',p_expected_revision+1,'actorUserId',auth.uid());
  insert into public.engineering_events(conversation_id,organization_id,project_id,owner_user_id,actor_user_id,kind,idempotency_key,
    expected_revision,receipt_revision,arguments,receipt)
    values(p_conversation_id,v_conversation.organization_id,v_conversation.project_id,v_conversation.owner_user_id,auth.uid(),
      'suffix_canceled',p_idempotency_key,p_expected_revision,p_expected_revision+1,v_arguments,v_receipt);
  return v_receipt;
end;
$$;
revoke all on function engineering_private.cancel_engineering_suffix(uuid,bigint,uuid,uuid[],text) from public, anon, authenticated, service_role;
grant execute on function engineering_private.cancel_engineering_suffix(uuid,bigint,uuid,uuid[],text) to authenticated;
create function public.api_cancel_engineering_suffix(
  p_conversation_id uuid, p_expected_revision bigint, p_idempotency_key uuid, p_decision_ids uuid[], p_reason text
) returns jsonb language sql security invoker set search_path = '' as $$
  select engineering_private.cancel_engineering_suffix(p_conversation_id,p_expected_revision,p_idempotency_key,p_decision_ids,p_reason);
$$;
revoke all on function public.api_cancel_engineering_suffix(uuid,bigint,uuid,uuid[],text) from public, anon, authenticated, service_role;
grant execute on function public.api_cancel_engineering_suffix(uuid,bigint,uuid,uuid[],text) to authenticated;
