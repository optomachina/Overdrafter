-- OVD-560 source-only continuation of the staged OVD-558 authority layer.
-- Apply only in an exclusively owned disposable replay after OVD-558. No bucket,
-- credential, upload, verifier JWT, or production authority is created here.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $preflight$
begin
  if current_user <> 'postgres'
    or to_regclass('engineering_private.native_verifier_registered_objects') is null
    or to_regprocedure('engineering_private.native_verifier_can_read_object(text,text)') is null
    or (select count(*) from engineering_private.native_verifier_registered_objects) <> 0 then
    raise exception 'ovd560_requires_empty_ovd558_registry_owned_by_postgres';
  end if;
end $preflight$;

alter table engineering_private.native_verifier_registered_objects
  add column organization_id uuid not null,
  add column project_id uuid not null,
  add column task_id uuid not null,
  add column attempt_id uuid not null,
  add column fence bigint not null check (fence between 1 and 9007199254740991),
  add column input_snapshot_id uuid not null,
  add column candidate_snapshot_id uuid not null,
  add column artifact_role text not null check (artifact_role in
    ('assembly','target','companion','result','identity','preservation','native')),
  add column storage_object_id uuid not null,
  add column storage_version text not null check (octet_length(storage_version) between 1 and 100),
  add column storage_updated_at timestamptz not null,
  add column byte_length bigint not null check (byte_length > 0 and byte_length <= 16000000),
  add column sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  add column registered_at timestamptz not null default clock_timestamp(),
  add constraint native_result_bucket_name_bound check
    (octet_length(bucket_id) between 1 and 100 and octet_length(object_name) between 1 and 512),
  add constraint native_result_role_size_bound check
    (byte_length <= case
      when artifact_role = 'result' then 256000 when artifact_role = 'identity' then 64000
      when artifact_role = 'preservation' then 128000 when artifact_role = 'native' then 4000000
      else 16000000 end),
  add constraint native_result_attempt_scope foreign key (attempt_id, organization_id, project_id)
    references public.engineering_execution_attempts(id, organization_id, project_id),
  add constraint native_result_attempt_task foreign key (attempt_id, task_id)
    references public.engineering_execution_attempts(id, task_id),
  add constraint native_result_source_scope foreign key (input_snapshot_id, organization_id, project_id)
    references public.engineering_snapshots(id, organization_id, project_id),
  add constraint native_result_storage_identity foreign key (storage_object_id)
    references storage.objects(id),
  add constraint native_result_candidate_differs check (candidate_snapshot_id <> input_snapshot_id),
  add constraint native_result_attempt_role unique (attempt_id, artifact_role),
  add constraint native_result_storage_unique unique (storage_object_id);

-- No direct runtime role may mutate this table. The owner-only registration
-- function takes a row lock and compares every immutable identity on replay.
create function engineering_private.native_result_registration_immutable()
returns trigger language plpgsql security invoker set search_path = '' as $body$
begin
  raise exception 'ovd560_registration_immutable' using errcode = '23514';
end $body$;
create trigger native_result_registration_immutable
  before update or delete on engineering_private.native_verifier_registered_objects
  for each row execute function engineering_private.native_result_registration_immutable();

create function engineering_private.register_native_result_object(
  p_organization_id uuid, p_project_id uuid, p_task_id uuid, p_attempt_id uuid,
  p_fence bigint, p_input_snapshot_id uuid, p_candidate_snapshot_id uuid,
  p_role text, p_bucket_id text, p_object_name text, p_storage_object_id uuid,
  p_storage_version text, p_storage_updated_at timestamptz, p_byte_length bigint, p_sha256 text)
returns boolean language plpgsql security invoker set search_path = '' as $body$
declare
  attempt public.engineering_execution_attempts%rowtype;
  existing engineering_private.native_verifier_registered_objects%rowtype;
  object_row storage.objects%rowtype;
begin
  if current_user <> 'postgres' then
    raise exception 'ovd560_registration_owner_required' using errcode = '42501';
  end if;
  select * into attempt from public.engineering_execution_attempts
    where id = p_attempt_id for update;
  if attempt.id is null or attempt.task_id is distinct from p_task_id
    or attempt.organization_id is distinct from p_organization_id
    or attempt.project_id is distinct from p_project_id
    or attempt.fence is distinct from p_fence
    or attempt.input_snapshot_id is distinct from p_input_snapshot_id
    or attempt.output_snapshot_id is distinct from p_candidate_snapshot_id
    or attempt.phase <> 'awaiting_result' or not attempt.result_eligible
    or attempt.stop_admission_id is null
    or not exists (select 1 from public.engineering_task_execution tx
      join public.engineering_tasks task on task.id = tx.task_id
      where tx.task_id = p_task_id and tx.current_attempt_id = p_attempt_id
        and task.organization_id = p_organization_id and task.project_id = p_project_id
        and task.verification_state in ('unverified','checking')) then
    raise exception 'ovd560_stale_or_foreign_attempt' using errcode = '42501';
  end if;
  if p_role not in ('assembly','target','companion','result','identity','preservation','native')
    or p_byte_length is null or p_byte_length < 1
    or p_byte_length > (case p_role
      when 'result' then 256000 when 'identity' then 64000
      when 'preservation' then 128000 when 'native' then 4000000 else 16000000 end)
    or p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'ovd560_invalid_artifact_identity' using errcode = '22023';
  end if;
  select obj.* into object_row from storage.objects obj
    join storage.buckets bucket on bucket.id = obj.bucket_id
    where obj.id = p_storage_object_id and obj.bucket_id = p_bucket_id
      and obj.name = p_object_name and not bucket.public
    for share of obj;
  if object_row.id is null or object_row.version is distinct from p_storage_version
    or object_row.updated_at is distinct from p_storage_updated_at then
    raise exception 'ovd560_storage_object_substituted' using errcode = '42501';
  end if;
  select * into existing from engineering_private.native_verifier_registered_objects
    where attempt_id = p_attempt_id and artifact_role = p_role;
  if existing.attempt_id is not null then
    if existing.organization_id = p_organization_id and existing.project_id = p_project_id
      and existing.task_id = p_task_id and existing.fence = p_fence
      and existing.input_snapshot_id = p_input_snapshot_id
      and existing.candidate_snapshot_id = p_candidate_snapshot_id
      and existing.bucket_id = p_bucket_id and existing.object_name = p_object_name
      and existing.storage_object_id = p_storage_object_id
      and existing.storage_version = p_storage_version
      and existing.storage_updated_at = p_storage_updated_at
      and existing.byte_length = p_byte_length and existing.sha256 = p_sha256 then
      return false;
    end if;
    raise exception 'ovd560_mismatched_registration_replay' using errcode = '23505';
  end if;
  insert into engineering_private.native_verifier_registered_objects
    (bucket_id, object_name, organization_id, project_id, task_id, attempt_id, fence,
     input_snapshot_id, candidate_snapshot_id, artifact_role, storage_object_id, storage_version,
     storage_updated_at, byte_length, sha256)
  values (p_bucket_id, p_object_name, p_organization_id, p_project_id, p_task_id,
    p_attempt_id, p_fence, p_input_snapshot_id, p_candidate_snapshot_id,
    p_role, p_storage_object_id, p_storage_version, p_storage_updated_at, p_byte_length, p_sha256);
  return true;
end $body$;

-- Keep the exact OVD-558 signature. A task-scoped verifier JWT can read only
-- the named, unchanged Storage row while that attempt remains result-eligible.
create or replace function engineering_private.native_verifier_can_read_object(p_bucket text,p_name text)
returns boolean language plpgsql security definer set search_path = '' as $body$
declare claims jsonb;
begin
  if current_setting('request.jwt.claim.role', true) is distinct from 'engineering_native_verifier' then
    return false;
  end if;
  claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  return exists (
    select 1 from engineering_private.native_verifier_registered_objects r
      join storage.objects obj on obj.id = r.storage_object_id
      join public.engineering_execution_attempts attempt on attempt.id = r.attempt_id
      join public.engineering_task_execution tx on tx.task_id = r.task_id
    where r.bucket_id = p_bucket and r.object_name = p_name
      and obj.bucket_id = r.bucket_id and obj.name = r.object_name
      and obj.version = r.storage_version
      and obj.updated_at = r.storage_updated_at
      and attempt.result_eligible and attempt.phase = 'awaiting_result'
      and attempt.stop_admission_id is not null
      and attempt.fence = r.fence and attempt.input_snapshot_id = r.input_snapshot_id
      and attempt.output_snapshot_id = r.candidate_snapshot_id
      and tx.current_attempt_id = r.attempt_id
      and claims->>'organization_id' = r.organization_id::text
      and claims->>'project_id' = r.project_id::text
      and claims->>'task_id' = r.task_id::text
      and claims->>'attempt_id' = r.attempt_id::text
      and claims->>'fence' = r.fence::text);
exception when invalid_text_representation then
  return false;
end $body$;

revoke execute on function engineering_private.native_result_registration_immutable(),
  engineering_private.register_native_result_object(uuid,uuid,uuid,uuid,bigint,uuid,uuid,text,text,text,uuid,text,timestamptz,bigint,text)
  from public, anon, authenticated, service_role, engineering_native_verifier;

do $postflight$
declare callable_count integer;
begin
  select count(*) into callable_count from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public','engineering_private','storage')
      and has_schema_privilege('engineering_native_verifier', n.oid, 'USAGE')
      and has_function_privilege('engineering_native_verifier', p.oid, 'EXECUTE');
  if callable_count <> 7 then raise exception 'ovd560_verifier_allowlist_drift:%', callable_count; end if;
  if exists (select 1 from (values ('anon'),('authenticated'),('service_role'),('engineering_native_verifier')) role_name(name)
    where has_table_privilege(role_name.name,
      'engineering_private.native_verifier_registered_objects', 'SELECT, INSERT, UPDATE, DELETE')) then
    raise exception 'ovd560_registry_direct_grant_drift';
  end if;
end $postflight$;
commit;
