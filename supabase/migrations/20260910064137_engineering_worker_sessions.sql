-- OVD-498: identity and owner-granted eligibility only, not native task claims.
-- Default-off: no operators, invitations, credentials or sessions are seeded.
create table public.engineering_workers (
  id uuid primary key,
  organization_id uuid not null,
  project_id uuid not null,
  owner_user_id uuid not null references auth.users(id),
  installation_id uuid,
  current_boot_id uuid,
  current_session_id uuid,
  revision bigint not null default 1 check (revision between 1 and 9007199254740991),
  revoked_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  unique (id, organization_id, project_id, owner_user_id),
  unique (id, installation_id),
  foreign key (project_id, organization_id) references public.projects(id, organization_id),
  check (installation_id is not null or (current_boot_id is null and current_session_id is null)),
  check (current_session_id is null or current_boot_id is not null)
);
-- A revoked installation retains history; replacing it requires a new pairing.
create unique index engineering_one_active_installation on public.engineering_workers(installation_id) where revoked_at is null;
create unique index engineering_one_worker_per_org on public.engineering_workers(organization_id) where revoked_at is null;

create table engineering_private.worker_pairings (
  worker_id uuid primary key references public.engineering_workers(id),
  code_sha256 text not null unique check (code_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  check (expires_at = created_at + interval '10 minutes'),
  check (consumed_at is null or (consumed_at >= created_at and consumed_at < expires_at))
);
create table engineering_private.worker_credentials (
  worker_id uuid primary key references public.engineering_workers(id),
  credential_sha256 text not null unique check (credential_sha256 ~ '^[0-9a-f]{64}$'),
  paired_at timestamptz not null
);
create table public.engineering_worker_sessions (
  id uuid primary key default gen_random_uuid(),
  worker_id uuid not null,
  organization_id uuid not null,
  project_id uuid not null,
  owner_user_id uuid not null,
  installation_id uuid not null,
  boot_id uuid not null,
  enabled_at timestamptz not null,
  expires_at timestamptz not null,
  paused_at timestamptz,
  unique (id, worker_id, boot_id),
  foreign key (worker_id, organization_id, project_id, owner_user_id)
    references public.engineering_workers(id, organization_id, project_id, owner_user_id),
  foreign key (worker_id, installation_id) references public.engineering_workers(id, installation_id),
  check (expires_at = enabled_at + interval '8 hours'),
  check (paused_at is null or paused_at >= enabled_at)
);
alter table public.engineering_workers add constraint engineering_current_session_scope
  foreign key (current_session_id, id, current_boot_id) references public.engineering_worker_sessions(id, worker_id, boot_id);
create index engineering_worker_sessions_scope on public.engineering_worker_sessions(worker_id, enabled_at);

create table public.engineering_worker_events (
  id uuid primary key default gen_random_uuid(),
  worker_id uuid not null,
  organization_id uuid not null,
  project_id uuid not null,
  owner_user_id uuid not null,
  actor_user_id uuid,
  kind text not null check (kind in ('pairing_created','paired','boot_registered','enabled','paused','revoked')),
  idempotency_key uuid not null,
  expected_revision bigint not null check (expected_revision between 0 and 9007199254740990),
  receipt_revision bigint not null check (receipt_revision = expected_revision + 1),
  arguments_sha256 text not null check (arguments_sha256 ~ '^[0-9a-f]{64}$'),
  receipt jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (worker_id, idempotency_key),
  unique (worker_id, receipt_revision),
  foreign key (worker_id, organization_id, project_id, owner_user_id)
    references public.engineering_workers(id, organization_id, project_id, owner_user_id),
  check ((kind in ('paired','boot_registered') and actor_user_id is null)
    or (kind in ('pairing_created','enabled','paused','revoked') and actor_user_id is not null and actor_user_id = owner_user_id))
);
create unique index engineering_worker_boot_once on public.engineering_worker_events(worker_id, (receipt->>'bootId'))
  where kind = 'boot_registered';

-- Only designated transition functions can mutate these records. Even the
-- server role receives no direct writes or access to stored secret hashes.
alter table engineering_private.worker_pairings enable row level security;
alter table engineering_private.worker_credentials enable row level security;
revoke all on engineering_private.worker_pairings, engineering_private.worker_credentials from public, anon, authenticated, service_role;
alter table public.engineering_workers enable row level security;
alter table public.engineering_worker_sessions enable row level security;
alter table public.engineering_worker_events enable row level security;
revoke all on public.engineering_workers, public.engineering_worker_sessions, public.engineering_worker_events from public, anon, authenticated, service_role;
grant select on public.engineering_workers, public.engineering_worker_sessions, public.engineering_worker_events to authenticated, service_role;
create policy engineering_workers_owner_read on public.engineering_workers for select to authenticated
  using (owner_user_id = (select auth.uid()) and engineering_private.engineering_access(organization_id, project_id));
create policy engineering_worker_sessions_owner_read on public.engineering_worker_sessions for select to authenticated
  using (owner_user_id = (select auth.uid()) and engineering_private.engineering_access(organization_id, project_id));
create policy engineering_worker_events_owner_read on public.engineering_worker_events for select to authenticated
  using (owner_user_id = (select auth.uid()) and engineering_private.engineering_access(organization_id, project_id));
create trigger engineering_worker_events_immutable before update or delete on public.engineering_worker_events
  for each row execute function engineering_private.reject_engineering_history_mutation();
create trigger engineering_worker_credentials_immutable before update or delete on engineering_private.worker_credentials
  for each row execute function engineering_private.reject_engineering_history_mutation();

create function engineering_private.preserve_worker_identity()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '55000', message = 'Worker history cannot be deleted.';
  end if;
  if tg_table_name = 'engineering_workers' then
    if (to_jsonb(new) - array['installation_id','current_boot_id','current_session_id','revision','revoked_at']) is distinct from
       (to_jsonb(old) - array['installation_id','current_boot_id','current_session_id','revision','revoked_at'])
       or (old.installation_id is not null and new.installation_id is distinct from old.installation_id)
       or (old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at)
       or new.revision <> old.revision + 1 then
      raise exception using errcode = '55000', message = 'Worker identity is immutable and revisions must advance once.';
    end if;
  elsif tg_table_name = 'engineering_worker_sessions' then
    if (to_jsonb(new) - 'paused_at') is distinct from (to_jsonb(old) - 'paused_at')
       or old.paused_at is not null or new.paused_at is null then
      raise exception using errcode = '55000', message = 'Session grants are immutable; pause is one-way.';
    end if;
  elsif (to_jsonb(new) - 'consumed_at') is distinct from (to_jsonb(old) - 'consumed_at')
       or old.consumed_at is not null or new.consumed_at is null then
    raise exception using errcode = '55000', message = 'Pairing identity is immutable; consumption is one-way.';
  end if;
  return new;
end;
$$;
revoke all on function engineering_private.preserve_worker_identity() from public, anon, authenticated, service_role;
create trigger engineering_worker_identity before update or delete on public.engineering_workers
  for each row execute function engineering_private.preserve_worker_identity();
create trigger engineering_worker_session_identity before update or delete on public.engineering_worker_sessions
  for each row execute function engineering_private.preserve_worker_identity();
create trigger engineering_worker_pairing_identity before update or delete on engineering_private.worker_pairings
  for each row execute function engineering_private.preserve_worker_identity();

-- Serialize transitions per worker and recheck access AFTER any lock wait.
-- Only private definer callers can use this helper; identity comes from storage.
create function engineering_private.lock_engineering_worker(p_worker_id uuid, p_owner boolean, p_credential_sha256 text default null)
returns public.engineering_workers language plpgsql security definer set search_path = '' as $$
declare v_worker public.engineering_workers%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended('engineering-worker:' || p_worker_id::text, 0));
  select * into v_worker from public.engineering_workers where id = p_worker_id for update;
  if v_worker.id is null or not engineering_private.engineering_actor_access(v_worker.owner_user_id,v_worker.organization_id,v_worker.project_id)
     or (p_owner and auth.uid() is distinct from v_worker.owner_user_id) then
    raise exception using errcode = '42501', message = 'Worker access denied.';
  end if;
  if not p_owner and (v_worker.revoked_at is not null or p_credential_sha256 is null or not exists (
    select 1 from engineering_private.worker_credentials where worker_id = p_worker_id and credential_sha256 = p_credential_sha256
  )) then
    raise exception using errcode = '42501', message = 'Worker access denied.';
  end if;
  return v_worker;
end;
$$;
revoke all on function engineering_private.lock_engineering_worker(uuid,boolean,text) from public, anon, authenticated, service_role;

-- Secrets contribute only to an opaque argument digest, never public receipts.
-- Exact replay returns historical receipts; callers must still check authority.
create function engineering_private.worker_replay(
  p_worker public.engineering_workers, p_revision bigint, p_key uuid, p_kind text, p_arguments jsonb
) returns jsonb language plpgsql set search_path = '' as $$
declare v_event public.engineering_worker_events%rowtype;
begin
  if p_key is null or p_revision is null or p_revision not between 0 and 9007199254740990 then
    raise exception using errcode = '22023', message = 'Invalid worker transition.';
  end if;
  select * into v_event from public.engineering_worker_events where worker_id = p_worker.id and idempotency_key = p_key;
  if v_event.id is not null then
    if v_event.kind <> p_kind or v_event.expected_revision <> p_revision
       or v_event.arguments_sha256 <> encode(extensions.digest(p_arguments::text,'sha256'),'hex') then
      raise exception using errcode = 'PT409', message = 'Worker idempotency key conflicts with a prior request.';
    end if;
    return v_event.receipt;
  end if;
  if p_worker.revision <> p_revision then
    raise exception using errcode = 'PT409', message = 'Worker revision changed.';
  end if;
  return null;
end;
$$;
revoke all on function engineering_private.worker_replay(public.engineering_workers,bigint,uuid,text,jsonb) from public, anon, authenticated, service_role;
create function engineering_private.record_worker_event(
  p_worker public.engineering_workers, p_revision bigint, p_key uuid, p_kind text, p_arguments jsonb, p_receipt jsonb
) returns jsonb language plpgsql set search_path = '' as $$
begin
  insert into public.engineering_worker_events(worker_id,organization_id,project_id,owner_user_id,actor_user_id,kind,
    idempotency_key,expected_revision,receipt_revision,arguments_sha256,receipt)
  values(p_worker.id,p_worker.organization_id,p_worker.project_id,p_worker.owner_user_id,
    case when p_kind in ('paired','boot_registered') then null else auth.uid() end,p_kind,
    p_key,p_revision,p_revision+1,encode(extensions.digest(p_arguments::text,'sha256'),'hex'),p_receipt);
  return p_receipt;
end;
$$;
revoke all on function engineering_private.record_worker_event(public.engineering_workers,bigint,uuid,text,jsonb,jsonb) from public, anon, authenticated, service_role;

create function engineering_private.create_worker_pairing(
  p_worker_id uuid, p_org uuid, p_project uuid, p_expected_revision bigint, p_key uuid, p_code_sha256 text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_worker public.engineering_workers%rowtype; v_args jsonb; v_receipt jsonb; v_now timestamptz;
begin
  if p_worker_id is null or p_org is null or p_project is null or p_code_sha256 is null
     or p_code_sha256 !~ '^[0-9a-f]{64}$' or p_expected_revision is distinct from 0 or p_key is null then
    raise exception using errcode = '22023', message = 'Invalid worker pairing invitation.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('engineering-worker:' || p_worker_id::text,0));
  perform pg_advisory_xact_lock(hashtextextended('engineering-worker-org:' || p_org::text,0));
  if not engineering_private.engineering_actor_access(auth.uid(),p_org,p_project) then
    raise exception using errcode = '42501', message = 'Worker access denied.';
  end if;
  v_args := jsonb_build_object('organizationId',p_org,'projectId',p_project,'codeSha256',p_code_sha256);
  select * into v_worker from public.engineering_workers where id = p_worker_id for update;
  if v_worker.id is not null then
    if v_worker.owner_user_id <> auth.uid() or v_worker.organization_id <> p_org or v_worker.project_id <> p_project then
      raise exception using errcode = '42501', message = 'Worker access denied.';
    end if;
    v_receipt := engineering_private.worker_replay(v_worker,0,p_key,'pairing_created',v_args);
    return v_receipt;
  end if;
  if exists (select 1 from public.engineering_workers where organization_id = p_org and revoked_at is null) then
    raise exception using errcode = 'PT409', message = 'Revoke the existing worker before creating another pairing.';
  end if;
  v_now := clock_timestamp();
  insert into public.engineering_workers(id,organization_id,project_id,owner_user_id,created_at)
    values(p_worker_id,p_org,p_project,auth.uid(),v_now) returning * into v_worker;
  insert into engineering_private.worker_pairings(worker_id,code_sha256,created_at,expires_at)
    values(p_worker_id,p_code_sha256,v_now,v_now + interval '10 minutes');
  v_receipt := jsonb_build_object('workerId',p_worker_id,'revision',1,'expiresAt',v_now + interval '10 minutes');
  return engineering_private.record_worker_event(v_worker,0,p_key,'pairing_created',v_args,v_receipt);
end;
$$;

create function engineering_private.consume_worker_pairing(
  p_worker_id uuid, p_expected_revision bigint, p_key uuid, p_code_sha256 text, p_installation_id uuid, p_credential_sha256 text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_worker public.engineering_workers%rowtype; v_pair engineering_private.worker_pairings%rowtype;
  v_args jsonb; v_receipt jsonb; v_now timestamptz;
begin
  if p_worker_id is null or p_installation_id is null or p_code_sha256 is null or p_credential_sha256 is null
     or p_code_sha256 !~ '^[0-9a-f]{64}$' or p_credential_sha256 !~ '^[0-9a-f]{64}$' or p_code_sha256 = p_credential_sha256 then
    raise exception using errcode = '22023', message = 'Invalid worker pairing.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('engineering-worker:' || p_worker_id::text,0));
  select * into v_worker from public.engineering_workers where id = p_worker_id for update;
  select * into v_pair from engineering_private.worker_pairings where worker_id = p_worker_id;
  if v_worker.id is null or v_worker.revoked_at is not null or v_pair.code_sha256 is distinct from p_code_sha256
     or not engineering_private.engineering_actor_access(v_worker.owner_user_id,v_worker.organization_id,v_worker.project_id) then
    raise exception using errcode = '42501', message = 'Worker access denied.';
  end if;
  v_args := jsonb_build_object('codeSha256',p_code_sha256,'installationId',p_installation_id,'credentialSha256',p_credential_sha256);
  v_receipt := engineering_private.worker_replay(v_worker,p_expected_revision,p_key,'paired',v_args);
  if v_receipt is not null then return v_receipt; end if;
  v_now := clock_timestamp();
  if v_pair.consumed_at is not null or v_worker.installation_id is not null or v_now >= v_pair.expires_at then
    raise exception using errcode = 'PT409', message = 'Pairing invitation was consumed or expired.';
  end if;
  insert into engineering_private.worker_credentials(worker_id,credential_sha256,paired_at) values(p_worker_id,p_credential_sha256,v_now);
  update engineering_private.worker_pairings set consumed_at = v_now where worker_id = p_worker_id;
  update public.engineering_workers set installation_id = p_installation_id,revision = revision + 1 where id = p_worker_id;
  v_receipt := jsonb_build_object('workerId',p_worker_id,'installationId',p_installation_id,'revision',p_expected_revision+1,'pairedAt',v_now);
  return engineering_private.record_worker_event(v_worker,p_expected_revision,p_key,'paired',v_args,v_receipt);
end;
$$;

create function engineering_private.register_worker_boot(
  p_worker_id uuid, p_expected_revision bigint, p_key uuid, p_credential_sha256 text, p_boot_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_worker public.engineering_workers%rowtype; v_args jsonb; v_receipt jsonb;
begin
  if p_boot_id is null then raise exception using errcode = '22023', message = 'A fresh boot identity is required.'; end if;
  v_worker := engineering_private.lock_engineering_worker(p_worker_id,false,p_credential_sha256);
  v_args := jsonb_build_object('bootId',p_boot_id,'credentialSha256',p_credential_sha256);
  v_receipt := engineering_private.worker_replay(v_worker,p_expected_revision,p_key,'boot_registered',v_args);
  if v_receipt is not null then return v_receipt; end if;
  if exists (select 1 from public.engineering_worker_events where worker_id = p_worker_id and kind = 'boot_registered' and receipt->>'bootId' = p_boot_id::text) then
    raise exception using errcode = 'PT409', message = 'Boot identity has already been used.';
  end if;
  update public.engineering_workers set current_boot_id = p_boot_id,current_session_id = null,revision = revision + 1 where id = p_worker_id;
  v_receipt := jsonb_build_object('workerId',p_worker_id,'bootId',p_boot_id,'revision',p_expected_revision+1,'enabled',false);
  return engineering_private.record_worker_event(v_worker,p_expected_revision,p_key,'boot_registered',v_args,v_receipt);
end;
$$;

-- Owner controls are deliberately a different API from worker authentication.
create function engineering_private.control_worker_session(
  p_worker_id uuid, p_expected_revision bigint, p_key uuid, p_action text, p_boot_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_worker public.engineering_workers%rowtype; v_args jsonb; v_receipt jsonb;
  v_now timestamptz; v_session public.engineering_worker_sessions%rowtype;
begin
  if p_action is null or p_action not in ('enabled','paused','revoked')
     or (p_action in ('enabled','paused') and p_boot_id is null) or (p_action = 'revoked' and p_boot_id is not null) then
    raise exception using errcode = '22023', message = 'Invalid owner session action.';
  end if;
  v_worker := engineering_private.lock_engineering_worker(p_worker_id,true);
  v_args := jsonb_build_object('action',p_action,'bootId',p_boot_id);
  v_receipt := engineering_private.worker_replay(v_worker,p_expected_revision,p_key,p_action,v_args);
  if v_receipt is not null then return v_receipt; end if;
  if v_worker.revoked_at is not null then raise exception using errcode = 'PT409', message = 'Worker has been revoked.'; end if;
  v_now := clock_timestamp();
  if p_action = 'revoked' then
    update public.engineering_workers set revoked_at = v_now,revision = revision + 1 where id = p_worker_id;
    v_receipt := jsonb_build_object('workerId',p_worker_id,'revision',p_expected_revision+1,'revokedAt',v_now);
  else
    if v_worker.installation_id is null or v_worker.current_boot_id is distinct from p_boot_id then
      raise exception using errcode = 'PT409', message = 'Owner action must bind the current paired boot.';
    end if;
    select * into v_session from public.engineering_worker_sessions where id = v_worker.current_session_id;
    if p_action = 'enabled' then
      if v_session.id is not null and v_session.paused_at is null and v_now < v_session.expires_at then
        raise exception using errcode = 'PT409', message = 'The current session is already enabled.';
      end if;
      insert into public.engineering_worker_sessions(worker_id,organization_id,project_id,owner_user_id,installation_id,boot_id,enabled_at,expires_at)
        values(p_worker_id,v_worker.organization_id,v_worker.project_id,v_worker.owner_user_id,v_worker.installation_id,p_boot_id,v_now,v_now+interval '8 hours')
        returning * into v_session;
      update public.engineering_workers set current_session_id = v_session.id,revision = revision + 1 where id = p_worker_id;
    else
      if v_session.id is null or v_session.paused_at is not null then
        raise exception using errcode = 'PT409', message = 'No unpaused session exists for this boot.';
      end if;
      update public.engineering_worker_sessions set paused_at = v_now where id = v_session.id returning * into v_session;
      update public.engineering_workers set revision = revision + 1 where id = p_worker_id;
    end if;
    v_receipt := jsonb_build_object('workerId',p_worker_id,'bootId',p_boot_id,'sessionId',v_session.id,'revision',p_expected_revision+1,
      'enabledAt',v_session.enabled_at,'expiresAt',v_session.expires_at,'pausedAt',v_session.paused_at);
  end if;
  return engineering_private.record_worker_event(v_worker,p_expected_revision,p_key,p_action,v_args,v_receipt);
end;
$$;

-- This is only a fresh authentication/session predicate. A future claim must
-- call it in the claim transaction AND enforce qualified runtime, task inputs,
-- active-attempt exclusivity, fences and confirmed process exit before retries.
create function engineering_private.worker_session_eligibility(p_worker_id uuid,p_credential_sha256 text,p_boot_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_worker public.engineering_workers%rowtype; v_session public.engineering_worker_sessions%rowtype; v_reason text;
begin
  v_worker := engineering_private.lock_engineering_worker(p_worker_id,false,p_credential_sha256);
  select * into v_session from public.engineering_worker_sessions where id = v_worker.current_session_id;
  if p_boot_id is null or v_worker.current_boot_id is distinct from p_boot_id then v_reason := 'boot_mismatch';
  elsif v_session.id is null then v_reason := 'owner_enablement_required';
  elsif v_session.paused_at is not null then v_reason := 'paused';
  elsif clock_timestamp() >= v_session.expires_at then v_reason := 'expired';
  else v_reason := 'enabled'; end if;
  return jsonb_build_object('workerId',p_worker_id,'installationId',v_worker.installation_id,'bootId',v_worker.current_boot_id,
    'sessionId',v_worker.current_session_id,'revision',v_worker.revision,'sessionEligible',v_reason = 'enabled',
    'reason',v_reason,'expiresAt',v_session.expires_at);
end;
$$;

revoke all on function engineering_private.create_worker_pairing(uuid,uuid,uuid,bigint,uuid,text) from public, anon, authenticated, service_role;
grant execute on function engineering_private.create_worker_pairing(uuid,uuid,uuid,bigint,uuid,text) to authenticated;
create function public.api_create_worker_pairing(p_worker_id uuid, p_org uuid, p_project uuid, p_expected_revision bigint, p_key uuid, p_code_sha256 text)
returns jsonb language sql security invoker set search_path = '' as $$
  select engineering_private.create_worker_pairing(p_worker_id,p_org,p_project,p_expected_revision,p_key,p_code_sha256);
$$;
revoke all on function public.api_create_worker_pairing(uuid,uuid,uuid,bigint,uuid,text) from public, anon, authenticated, service_role;
grant execute on function public.api_create_worker_pairing(uuid,uuid,uuid,bigint,uuid,text) to authenticated;

revoke all on function engineering_private.consume_worker_pairing(uuid,bigint,uuid,text,uuid,text) from public, anon, authenticated, service_role;
grant execute on function engineering_private.consume_worker_pairing(uuid,bigint,uuid,text,uuid,text) to service_role;
create function public.api_consume_worker_pairing(p_worker_id uuid, p_expected_revision bigint, p_key uuid, p_code_sha256 text, p_installation_id uuid, p_credential_sha256 text)
returns jsonb language sql security invoker set search_path = '' as $$
  select engineering_private.consume_worker_pairing(p_worker_id,p_expected_revision,p_key,p_code_sha256,p_installation_id,p_credential_sha256);
$$;
revoke all on function public.api_consume_worker_pairing(uuid,bigint,uuid,text,uuid,text) from public, anon, authenticated, service_role;
grant execute on function public.api_consume_worker_pairing(uuid,bigint,uuid,text,uuid,text) to service_role;

revoke all on function engineering_private.register_worker_boot(uuid,bigint,uuid,text,uuid) from public, anon, authenticated, service_role;
grant execute on function engineering_private.register_worker_boot(uuid,bigint,uuid,text,uuid) to service_role;
create function public.api_register_worker_boot(p_worker_id uuid, p_expected_revision bigint, p_key uuid, p_credential_sha256 text, p_boot_id uuid)
returns jsonb language sql security invoker set search_path = '' as $$
  select engineering_private.register_worker_boot(p_worker_id,p_expected_revision,p_key,p_credential_sha256,p_boot_id);
$$;
revoke all on function public.api_register_worker_boot(uuid,bigint,uuid,text,uuid) from public, anon, authenticated, service_role;
grant execute on function public.api_register_worker_boot(uuid,bigint,uuid,text,uuid) to service_role;

revoke all on function engineering_private.control_worker_session(uuid,bigint,uuid,text,uuid) from public, anon, authenticated, service_role;
grant execute on function engineering_private.control_worker_session(uuid,bigint,uuid,text,uuid) to authenticated;
create function public.api_control_worker_session(p_worker_id uuid, p_expected_revision bigint, p_key uuid, p_action text, p_boot_id uuid)
returns jsonb language sql security invoker set search_path = '' as $$
  select engineering_private.control_worker_session(p_worker_id,p_expected_revision,p_key,p_action,p_boot_id);
$$;
revoke all on function public.api_control_worker_session(uuid,bigint,uuid,text,uuid) from public, anon, authenticated, service_role;
grant execute on function public.api_control_worker_session(uuid,bigint,uuid,text,uuid) to authenticated;

revoke all on function engineering_private.worker_session_eligibility(uuid,text,uuid) from public, anon, authenticated, service_role;
grant execute on function engineering_private.worker_session_eligibility(uuid,text,uuid) to service_role;
create function public.api_worker_session_eligibility(p_worker_id uuid, p_credential_sha256 text, p_boot_id uuid)
returns jsonb language sql security invoker set search_path = '' as $$
  select engineering_private.worker_session_eligibility(p_worker_id,p_credential_sha256,p_boot_id);
$$;
revoke all on function public.api_worker_session_eligibility(uuid,text,uuid) from public, anon, authenticated, service_role;
grant execute on function public.api_worker_session_eligibility(uuid,text,uuid) to service_role;
