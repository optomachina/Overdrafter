-- OVD-496: private, default-off engineering intake. No native dispatch or AI calls.
-- Activation is separate: this migration inserts no operators or snapshots.
-- Rollback: disable operator entries / revoke intake EXECUTE, retain history.

create schema engineering_private;
revoke all on schema engineering_private from public, anon, authenticated, service_role;
grant usage on schema engineering_private to authenticated, service_role;

create table engineering_private.engineering_operators (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  enabled boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);
alter table engineering_private.engineering_operators enable row level security;
revoke all on engineering_private.engineering_operators from public, anon, authenticated, service_role;
grant select, insert, update on engineering_private.engineering_operators to service_role;

-- A composite target is necessary to enforce tenant consistency in foreign keys.
create unique index engineering_projects_scope_key on public.projects(id, organization_id);

create table public.engineering_snapshots (
  id uuid primary key,
  organization_id uuid not null,
  project_id uuid not null,
  context_text text not null check (octet_length(context_text) between 1 and 65536),
  context_sha256 text generated always as
    (encode(extensions.digest(context_text, 'sha256'), 'hex')) stored,
  created_at timestamptz not null default now(),
  unique (id, organization_id, project_id),
  foreign key (project_id, organization_id) references public.projects(id, organization_id) on delete restrict,
  constraint engineering_snapshot_wire_identity check ((
    context_text::jsonb->>'schema' = 'overdrafter.prepared-assembly.v2'
    and context_text::jsonb->>'snapshotId' = id::text
    and context_text::jsonb#>>'{scope,organizationId}' = organization_id::text
    and context_text::jsonb#>>'{scope,projectId}' = project_id::text
  ) is true)
);
comment on table public.engineering_snapshots is
  'Immutable exact context bytes. Insertion is server-only; the coordinator must validate the complete v2 contract and provenance before admitting execution. This table alone does not attest native verification.';

create table public.engineering_conversations (
  id uuid primary key,
  organization_id uuid not null,
  project_id uuid not null,
  owner_user_id uuid not null references auth.users(id) on delete restrict,
  baseline_snapshot_id uuid not null,
  head_snapshot_id uuid not null,
  revision bigint not null default 0 check (revision between 0 and 9007199254740991),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id, project_id, owner_user_id),
  foreign key (baseline_snapshot_id, organization_id, project_id)
    references public.engineering_snapshots(id, organization_id, project_id) on delete restrict,
  foreign key (head_snapshot_id, organization_id, project_id)
    references public.engineering_snapshots(id, organization_id, project_id) on delete restrict
);

create table public.engineering_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null,
  organization_id uuid not null,
  project_id uuid not null,
  owner_user_id uuid not null,
  author_user_id uuid references auth.users(id) on delete restrict,
  role text not null check (role in ('user', 'assistant', 'system')),
  sequence bigint not null check (sequence between 1 and 9007199254740991),
  body text not null check (char_length(body) between 1 and 4000 and octet_length(body) <= 8000 and body ~ '[^[:space:]]'),
  created_at timestamptz not null default now(),
  unique (conversation_id, sequence),
  unique (id, conversation_id, organization_id, project_id, owner_user_id),
  foreign key (conversation_id, organization_id, project_id, owner_user_id)
    references public.engineering_conversations(id, organization_id, project_id, owner_user_id) on delete restrict,
  constraint engineering_message_author check ((
    (role = 'user' and author_user_id = owner_user_id)
    or (role <> 'user' and author_user_id is null)
  ) is true)
);

create table public.engineering_requests (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null,
  message_id uuid not null unique,
  organization_id uuid not null,
  project_id uuid not null,
  owner_user_id uuid not null,
  input_snapshot_id uuid not null,
  idempotency_key uuid not null,
  expected_revision bigint not null check (expected_revision between 0 and 9007199254740990),
  receipt_revision bigint not null check (receipt_revision = expected_revision + 1),
  interpretation_state text not null default 'queued'
    check (interpretation_state in ('queued', 'running', 'needs_context', 'interpreted', 'failed', 'canceled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (conversation_id, idempotency_key),
  foreign key (message_id, conversation_id, organization_id, project_id, owner_user_id)
    references public.engineering_messages(id, conversation_id, organization_id, project_id, owner_user_id) on delete restrict,
  foreign key (input_snapshot_id, organization_id, project_id)
    references public.engineering_snapshots(id, organization_id, project_id) on delete restrict
);
create index engineering_conversations_owner_updated on public.engineering_conversations(owner_user_id, updated_at desc);
create index engineering_snapshots_project on public.engineering_snapshots(organization_id, project_id);
create index engineering_requests_pending on public.engineering_requests(created_at, id) where interpretation_state = 'queued';

-- Private, fixed-search-path authorization; callers cannot read/modify the gate.
create function engineering_private.engineering_access(p_organization_id uuid, p_project_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null
    and exists (select 1 from engineering_private.engineering_operators o
      join public.organization_memberships m using (organization_id, user_id)
      where o.organization_id = p_organization_id and o.user_id = auth.uid() and o.enabled)
    and exists (select 1 from public.projects p where p.id = p_project_id and p.organization_id = p_organization_id)
    and public.user_can_access_project(p_project_id);
$$;
revoke all on function engineering_private.engineering_access(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function engineering_private.engineering_access(uuid, uuid) to authenticated;

alter table public.engineering_snapshots enable row level security;
alter table public.engineering_conversations enable row level security;
alter table public.engineering_messages enable row level security;
alter table public.engineering_requests enable row level security;
revoke all on public.engineering_snapshots, public.engineering_conversations,
  public.engineering_messages, public.engineering_requests from public, anon, authenticated, service_role;
grant select on public.engineering_snapshots, public.engineering_conversations,
  public.engineering_messages, public.engineering_requests to authenticated;
grant select, insert on public.engineering_snapshots, public.engineering_messages to service_role;
grant select, insert, update on public.engineering_conversations to service_role;
grant select on public.engineering_requests to service_role;
grant update (interpretation_state, updated_at) on public.engineering_requests to service_role;

create policy engineering_snapshots_read on public.engineering_snapshots for select to authenticated
  using (engineering_private.engineering_access(organization_id, project_id));
create policy engineering_conversations_read on public.engineering_conversations for select to authenticated
  using (owner_user_id = (select auth.uid()) and engineering_private.engineering_access(organization_id, project_id));
create policy engineering_messages_read on public.engineering_messages for select to authenticated
  using (owner_user_id = (select auth.uid()) and engineering_private.engineering_access(organization_id, project_id));
create policy engineering_requests_read on public.engineering_requests for select to authenticated
  using (owner_user_id = (select auth.uid()) and engineering_private.engineering_access(organization_id, project_id));

create function engineering_private.reject_engineering_history_mutation()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception using errcode = '55000', message = 'Engineering history is immutable.';
end;
$$;
revoke all on function engineering_private.reject_engineering_history_mutation() from public, anon, authenticated, service_role;
create trigger engineering_snapshots_immutable before update or delete on public.engineering_snapshots
  for each row execute function engineering_private.reject_engineering_history_mutation();
create trigger engineering_messages_immutable before update or delete on public.engineering_messages
  for each row execute function engineering_private.reject_engineering_history_mutation();

create function engineering_private.preserve_engineering_intake_identity()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '55000', message = 'Engineering intake history cannot be deleted.';
  end if;
  if tg_table_name = 'engineering_conversations' then
    if (to_jsonb(new) - array['revision','head_snapshot_id','updated_at'])
      is distinct from (to_jsonb(old) - array['revision','head_snapshot_id','updated_at']) then
      raise exception using errcode = '55000', message = 'Engineering conversation identity is immutable.';
    end if;
  elsif (to_jsonb(new) - array['interpretation_state','updated_at'])
    is distinct from (to_jsonb(old) - array['interpretation_state','updated_at']) then
    raise exception using errcode = '55000', message = 'Engineering request identity is immutable.';
  end if;
  return new;
end;
$$;
revoke all on function engineering_private.preserve_engineering_intake_identity() from public, anon, authenticated, service_role;
create trigger engineering_conversation_identity before update or delete on public.engineering_conversations
  for each row execute function engineering_private.preserve_engineering_intake_identity();
create trigger engineering_request_identity before update or delete on public.engineering_requests
  for each row execute function engineering_private.preserve_engineering_intake_identity();

-- Atomicity needs privileged insertion; the public wrapper stays SECURITY INVOKER.
-- Every path (including replay) rechecks current membership, gate and ownership.
create function engineering_private.submit_engineering_message(
  p_organization_id uuid, p_project_id uuid, p_conversation_id uuid,
  p_input_snapshot_id uuid, p_expected_revision bigint, p_idempotency_key uuid, p_body text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := auth.uid();
  v_conversation public.engineering_conversations%rowtype;
  v_existing public.engineering_requests%rowtype;
  v_message public.engineering_messages%rowtype;
  v_request public.engineering_requests%rowtype;
begin
  if not engineering_private.engineering_access(p_organization_id, p_project_id) then
    raise exception using errcode = '42501', message = 'Engineering access is unavailable.';
  end if;
  if p_conversation_id is null or p_input_snapshot_id is null or p_idempotency_key is null
    or p_expected_revision is null or p_expected_revision < 0 or p_expected_revision >= 9007199254740991
    or p_body is null or char_length(p_body) not between 1 and 4000 or octet_length(p_body) > 8000
    or p_body !~ '[^[:space:]]' then
    raise exception using errcode = '22023', message = 'Invalid engineering message.';
  end if;
  -- Serializes even initial creation, where no conversation row yet exists.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('engineering:' || p_conversation_id::text, 0));
  select * into v_conversation from public.engineering_conversations where id = p_conversation_id for update;
  -- Access may have been revoked while this call waited for another transaction.
  if not engineering_private.engineering_access(p_organization_id, p_project_id) then
    raise exception using errcode = '42501', message = 'Engineering access is unavailable.';
  end if;
  if v_conversation.id is not null then
    if v_conversation.organization_id <> p_organization_id or v_conversation.project_id <> p_project_id
      or v_conversation.owner_user_id <> v_actor then
      raise exception using errcode = '42501', message = 'Engineering access is unavailable.';
    end if;
    select * into v_existing from public.engineering_requests
      where conversation_id = p_conversation_id and idempotency_key = p_idempotency_key;
    if found then
      select * into strict v_message from public.engineering_messages where id = v_existing.message_id;
      if v_existing.expected_revision <> p_expected_revision or v_existing.input_snapshot_id <> p_input_snapshot_id
        or v_message.body <> p_body then
        raise exception using errcode = 'PT409', message = 'Idempotency key already identifies a different message.';
      end if;
      return jsonb_build_object('conversationId', p_conversation_id, 'messageId', v_existing.message_id,
        'requestId', v_existing.id, 'revision', v_existing.receipt_revision, 'inputSnapshotId', v_existing.input_snapshot_id);
    end if;
    if v_conversation.revision <> p_expected_revision or v_conversation.head_snapshot_id <> p_input_snapshot_id then
      raise exception using errcode = 'PT409', message = 'Engineering context changed; refresh before sending.';
    end if;
  else
    if p_expected_revision <> 0 then
      raise exception using errcode = 'PT409', message = 'New conversations require revision zero.';
    end if;
    if not exists (select 1 from public.engineering_snapshots where id = p_input_snapshot_id
      and organization_id = p_organization_id and project_id = p_project_id) then
      raise exception using errcode = '42501', message = 'Engineering context is unavailable.';
    end if;
    insert into public.engineering_conversations(id, organization_id, project_id, owner_user_id, baseline_snapshot_id, head_snapshot_id)
      values (p_conversation_id, p_organization_id, p_project_id, v_actor, p_input_snapshot_id, p_input_snapshot_id);
  end if;
  insert into public.engineering_messages(conversation_id, organization_id, project_id, owner_user_id,
    author_user_id, role, sequence, body)
    values (p_conversation_id, p_organization_id, p_project_id, v_actor, v_actor, 'user', p_expected_revision + 1, p_body)
    returning * into v_message;
  insert into public.engineering_requests(conversation_id, message_id, organization_id, project_id, owner_user_id,
    input_snapshot_id, idempotency_key, expected_revision, receipt_revision)
    values (p_conversation_id, v_message.id, p_organization_id, p_project_id, v_actor,
      p_input_snapshot_id, p_idempotency_key, p_expected_revision, p_expected_revision + 1)
    returning * into v_request;
  update public.engineering_conversations set revision = p_expected_revision + 1, updated_at = now()
    where id = p_conversation_id;
  return jsonb_build_object('conversationId', p_conversation_id, 'messageId', v_message.id,
    'requestId', v_request.id, 'revision', v_request.receipt_revision, 'inputSnapshotId', v_request.input_snapshot_id);
end;
$$;
revoke all on function engineering_private.submit_engineering_message(uuid,uuid,uuid,uuid,bigint,uuid,text) from public, anon, authenticated, service_role;
grant execute on function engineering_private.submit_engineering_message(uuid,uuid,uuid,uuid,bigint,uuid,text) to authenticated;

create function public.api_submit_engineering_message(
  p_organization_id uuid, p_project_id uuid, p_conversation_id uuid,
  p_input_snapshot_id uuid, p_expected_revision bigint, p_idempotency_key uuid, p_body text
) returns jsonb language sql security invoker set search_path = '' as $$
  select engineering_private.submit_engineering_message(p_organization_id, p_project_id, p_conversation_id,
    p_input_snapshot_id, p_expected_revision, p_idempotency_key, p_body);
$$;
revoke all on function public.api_submit_engineering_message(uuid,uuid,uuid,uuid,bigint,uuid,text) from public, anon, authenticated, service_role;
grant execute on function public.api_submit_engineering_message(uuid,uuid,uuid,uuid,bigint,uuid,text) to authenticated;
comment on function public.api_submit_engineering_message(uuid,uuid,uuid,uuid,bigint,uuid,text) is
  'Durably record user input and pending interpretation atomically. Does not accept a CAD decision, execute work or grant release authority. Replays preserve original receipt identity; stale/changed payloads return PT409 (HTTP 409).';
