-- Staged source only. Apply AFTER OVD561, never an active migration or grant.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
do $preflight$
begin
  if current_user <> 'postgres'
    or to_regprocedure('engineering_private.finalize_native_result(text,text,text,uuid)') is null
    or to_regprocedure('engineering_private.reject_engineering_history_mutation()') is null
    or to_regclass('engineering_private.native_pending_finalizations') is not null then
    raise exception 'ovd561_pending_preflight_failed';
  end if;
end $preflight$;

-- One immutable intent per attempt. Different attempts of the same task retain
-- their own history; finalization's existing one-task completion rule still wins.
create table engineering_private.native_pending_finalizations (
  attempt_id uuid primary key references public.engineering_execution_attempts(id),
  task_id uuid not null references public.engineering_tasks(id),
  idempotency_key uuid not null,
  payload_text text not null check (octet_length(payload_text) between 1 and 16384),
  signature text not null check (signature ~ '^[0-9a-f]{64}$'),
  candidate_context_text text not null check (octet_length(candidate_context_text) between 1 and 65536),
  created_at timestamptz not null default clock_timestamp(),
  unique(task_id, idempotency_key)
);
alter table engineering_private.native_pending_finalizations enable row level security;
revoke all on engineering_private.native_pending_finalizations
  from public, anon, authenticated, service_role, engineering_native_verifier;
create trigger native_pending_finalizations_immutable before update or delete
  on engineering_private.native_pending_finalizations for each row
  execute function engineering_private.reject_engineering_history_mutation();

create function engineering_private.load_native_pending_finalization(p_task uuid, p_attempt uuid)
returns jsonb language plpgsql security invoker set search_path = '' as $body$
declare
  stored engineering_private.native_pending_finalizations%rowtype;
begin
  if current_user <> 'postgres' then
    raise exception 'ovd561_pending_owner_required' using errcode = '42501';
  end if;
  if p_task is null or p_attempt is null then
    raise exception 'ovd561_pending_invalid_identity' using errcode = '22023';
  end if;
  select * into stored from engineering_private.native_pending_finalizations
    where task_id = p_task and attempt_id = p_attempt;
  if not found then return null; end if;
  return jsonb_build_object('p_payload_text', stored.payload_text, 'p_signature', stored.signature,
    'p_candidate_context_text', stored.candidate_context_text, 'p_key', stored.idempotency_key::text);
end $body$;
revoke all on function engineering_private.load_native_pending_finalization(uuid,uuid)
  from public, anon, authenticated, service_role, engineering_native_verifier;

create function engineering_private.persist_native_pending_finalization(
  p_task uuid, p_attempt uuid, p_payload_text text, p_signature text,
  p_candidate_context_text text, p_key uuid)
returns jsonb language plpgsql security invoker set search_path = '' as $body$
declare
  payload jsonb;
  stored engineering_private.native_pending_finalizations%rowtype;
begin
  if current_user <> 'postgres' then
    raise exception 'ovd561_pending_owner_required' using errcode = '42501';
  end if;
  -- ON CONFLICT may wait for another writer. The following statement needs a
  -- fresh snapshot to return its committed winner, never a missing/stale row.
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'ovd561_pending_read_committed_required' using errcode = '42501';
  end if;
  if p_task is null or p_attempt is null or p_key is null or p_payload_text is null
    or octet_length(p_payload_text) not between 1 and 16384 or p_signature is null
    or p_signature !~ '^[0-9a-f]{64}$' or p_candidate_context_text is null
    or octet_length(p_candidate_context_text) not between 1 and 65536 then
    raise exception 'ovd561_pending_invalid_request' using errcode = '22023';
  end if;
  payload := p_payload_text::jsonb;
  if payload->>'schema' is distinct from 'overdrafter.native-verification-receipt.v2'
    or payload->>'taskId' is distinct from p_task::text
    or payload->>'attemptId' is distinct from p_attempt::text
    or payload->>'candidateContextSha256' is distinct from
      encode(extensions.digest(convert_to(p_candidate_context_text, 'UTF8'), 'sha256'), 'hex')
    or not exists (select 1 from public.engineering_execution_attempts where id = p_attempt and task_id = p_task) then
    raise exception 'ovd561_pending_binding_mismatch' using errcode = '42501';
  end if;
  -- This is transport intent, not verification authority. Signed content is
  -- checked by the existing finalizer and OVD561 SQL, including replay. Preserve
  -- the exact strings; never serialize jsonb back into either stored text field.
  insert into engineering_private.native_pending_finalizations
    (attempt_id, task_id, idempotency_key, payload_text, signature, candidate_context_text)
    values (p_attempt, p_task, p_key, p_payload_text, p_signature, p_candidate_context_text)
    on conflict (attempt_id) do nothing;
  select * into stored from engineering_private.native_pending_finalizations where attempt_id = p_attempt;
  if not found or stored.task_id is distinct from p_task then
    raise exception 'ovd561_pending_winner_unavailable' using errcode = 'PT409';
  end if;
  return jsonb_build_object('p_payload_text', stored.payload_text, 'p_signature', stored.signature,
    'p_candidate_context_text', stored.candidate_context_text, 'p_key', stored.idempotency_key::text);
end $body$;
revoke all on function engineering_private.persist_native_pending_finalization(uuid,uuid,text,text,text,uuid)
  from public, anon, authenticated, service_role, engineering_native_verifier;
commit;
