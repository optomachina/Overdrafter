-- SOURCE ONLY; not an active migration. Dependencies: native ownership,
-- private-artifact-forward.sql, OVD560 registry and OVD561 finalizations.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
create function engineering_private.prepare_native_artifact_inputs(
  p_input uuid, p_actor uuid, p_seed_manifest_text text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  a public.engineering_execution_attempts%rowtype;
  admission engineering_private.native_input_admissions%rowtype;
  snap public.engineering_snapshots%rowtype;
  receipt engineering_private.native_finalizations%rowtype;
  registered engineering_private.native_verifier_registered_objects%rowtype;
  obj storage.objects%rowtype;
  existing engineering_private.native_artifact_inputs%rowtype;
  manifest jsonb; item jsonb; file jsonb; role_name text; n integer;
  object_id uuid; object_version text; object_updated timestamptz;
  roles constant text[] := array['assembly','target','companion','result','identity','preservation','native'];
begin
  if current_user <> 'postgres' then
    raise exception 'native_mapping_owner_required' using errcode='42501';
  end if;
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'native_mapping_read_committed_required' using errcode='25001';
  end if;
  lock table engineering_private.native_admission_revocations,
    engineering_private.engineering_operators, public.organization_memberships,
    public.project_memberships, public.projects in share mode;
  select * into admission from engineering_private.native_input_admissions where id=p_input for update;
  select * into snap from public.engineering_snapshots where id=admission.snapshot_id;
  if admission.id is null or snap.context_sha256 is distinct from admission.context_sha256
    or not engineering_private.engineering_actor_access(p_actor,admission.organization_id,admission.project_id)
    or exists(select 1 from engineering_private.native_admission_revocations r where r.input_admission_id=admission.id)
    or jsonb_array_length(snap.context_text::jsonb->'files') is distinct from 3 then
    raise exception 'native_mapping_authority_mismatch' using errcode='42501';
  end if;
  if admission.kind='qualified_seed' then
    if p_seed_manifest_text is null or octet_length(p_seed_manifest_text)>16384
      or encode(extensions.digest(p_seed_manifest_text,'sha256'),'hex') is distinct from admission.storage_manifest_sha256 then
      raise exception 'native_mapping_seed_manifest_mismatch' using errcode='42501';
    end if;
    manifest := p_seed_manifest_text::jsonb;
    if jsonb_typeof(manifest) is distinct from 'array' or jsonb_array_length(manifest)<>3 then
      raise exception 'native_mapping_seed_manifest_shape' using errcode='22023';
    end if;
  else
    if p_seed_manifest_text is not null then raise exception 'native_mapping_seed_manifest_forbidden' using errcode='22023'; end if;
    select * into receipt from engineering_private.native_finalizations where attempt_id=admission.producer_attempt_id;
    manifest := receipt.payload_text::jsonb->'objects';
    if receipt.input_admission_id is distinct from admission.id or receipt.snapshot_id is distinct from admission.snapshot_id
      or receipt.candidate_context_text is distinct from snap.context_text
      or encode(extensions.digest(manifest::text,'sha256'),'hex') is distinct from admission.storage_manifest_sha256
      or jsonb_array_length(manifest) is distinct from 7 then
      raise exception 'native_mapping_producer_mismatch' using errcode='42501';
    end if;
  end if;
  for n in 0..2 loop
    role_name := roles[n+1];
    file := snap.context_text::jsonb->'files'->n;
    if admission.kind='qualified_seed' then
      item := manifest->n;
      if item->>'role' is distinct from role_name or item->>'path' is distinct from file->>'path'
        or item->'bytes' is distinct from file->'bytes' or item->>'sha256' is distinct from file->>'sha256' then
        raise exception 'native_mapping_file_mismatch' using errcode='42501';
      end if;
      object_id := (item->>'storageObjectId')::uuid;
      object_version := item->>'storageVersion'; object_updated := (item->>'storageUpdatedAt')::timestamptz;
    else
      select * into registered from engineering_private.native_verifier_registered_objects
        where attempt_id=admission.producer_attempt_id and artifact_role=role_name;
      select value into item from jsonb_array_elements(manifest) where value->>'role'=role_name;
      if registered.storage_object_id::text is distinct from item->>'id'
        or registered.candidate_snapshot_id is distinct from admission.snapshot_id
        or registered.organization_id is distinct from admission.organization_id
        or registered.project_id is distinct from admission.project_id
        or registered.byte_length::text is distinct from file->>'bytes'
        or registered.sha256 is distinct from file->>'sha256'
        or item->'bytes' is distinct from file->'bytes' or item->>'sha256' is distinct from file->>'sha256' then
        raise exception 'native_mapping_registry_mismatch' using errcode='42501';
      end if;
      object_id := registered.storage_object_id;
      object_version := registered.storage_version; object_updated := registered.storage_updated_at;
    end if;
    select o.* into obj from storage.objects o join storage.buckets b on b.id=o.bucket_id and not b.public
      where o.id=object_id and o.version=object_version and o.updated_at=object_updated for share of o,b;
    if obj.id is null or (admission.kind='verified_candidate' and
      (obj.bucket_id is distinct from registered.bucket_id or obj.name is distinct from registered.object_name)) then
      raise exception 'native_mapping_generation_mismatch' using errcode='42501';
    end if;
    select * into existing from engineering_private.native_artifact_inputs where input_admission_id=admission.id and ordinal=n;
    if existing.id is not null then
      if existing.storage_object_id is distinct from object_id or existing.storage_version is distinct from object_version
        or existing.storage_updated_at is distinct from object_updated or existing.sha256 is distinct from file->>'sha256'
        or existing.byte_length::text is distinct from file->>'bytes' then
        raise exception 'native_mapping_replay_mismatch' using errcode='23505';
      end if;
    else
      insert into engineering_private.native_artifact_inputs(id,input_admission_id,ordinal,storage_object_id,
        storage_version,storage_updated_at,byte_length,sha256)
      values(gen_random_uuid(),admission.id,n,object_id,object_version,object_updated,(file->>'bytes')::integer,file->>'sha256');
    end if;
  end loop;
  return jsonb_build_object('inputAdmissionId',admission.id,
    'inputs',(select jsonb_agg(jsonb_build_object('id',id,'ordinal',ordinal) order by ordinal)
      from engineering_private.native_artifact_inputs where input_admission_id=admission.id));
end;
$$;
revoke all on function engineering_private.prepare_native_artifact_inputs(uuid,uuid,text)
  from public,anon,authenticated,service_role;

create function engineering_private.prepare_native_artifact_outputs(
  p_attempt uuid, p_output_bucket text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  a public.engineering_execution_attempts%rowtype;
  v_task_id uuid; role_name text;
  roles constant text[] := array['assembly','target','companion','result','identity','preservation','native'];
begin
  if current_user <> 'postgres' then
    raise exception 'native_mapping_owner_required' using errcode='42501';
  end if;
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'native_mapping_read_committed_required' using errcode='25001';
  end if;
  lock table engineering_private.native_admission_revocations,
    engineering_private.engineering_operators, public.organization_memberships,
    public.project_memberships, public.projects in share mode;
  select attempt.task_id into v_task_id from public.engineering_execution_attempts attempt where attempt.id=p_attempt;
  perform 1 from public.engineering_tasks t where t.id=v_task_id and t.verification_state in ('unverified','checking') for share;
  if not found then raise exception 'native_mapping_task_ineligible' using errcode='42501'; end if;
  perform 1 from public.engineering_task_execution x where x.task_id=v_task_id and x.current_attempt_id=p_attempt for share;
  if not found then raise exception 'native_mapping_stale_attempt' using errcode='42501'; end if;
  select * into a from public.engineering_execution_attempts where id=p_attempt for update;
  if a.id is null or a.phase <> 'awaiting_result' or not a.result_eligible
    or a.stop_admission_id is null or a.stopped_at is null
    or not engineering_private.engineering_actor_access(a.owner_user_id,a.organization_id,a.project_id)
    or exists(select 1 from engineering_private.native_admission_revocations r
      where r.input_admission_id=a.input_admission_id or r.runtime_admission_id=a.runtime_admission_id)
    or not exists(select 1 from public.engineering_snapshots snap
      join engineering_private.native_input_admissions i on i.snapshot_id=snap.id
      where i.id=a.input_admission_id and i.context_sha256=snap.context_sha256
        and (a.job_text::jsonb->'inputFiles')=(snap.context_text::jsonb->'files')) then
    raise exception 'native_mapping_authority_mismatch' using errcode='42501';
  end if;
  perform 1 from storage.buckets where id=p_output_bucket and not public for share;
  if not found then raise exception 'native_mapping_private_bucket_required' using errcode='42501'; end if;
  foreach role_name in array roles loop
    if exists(select 1 from engineering_private.native_artifact_outputs where attempt_id=a.id and role=role_name and bucket_id<>p_output_bucket) then
      raise exception 'native_mapping_output_replay_mismatch' using errcode='23505';
    end if;
    insert into engineering_private.native_artifact_outputs(attempt_id,role,bucket_id)
      values(a.id,role_name,p_output_bucket) on conflict(attempt_id,role) do nothing;
  end loop;
  return jsonb_build_object('attemptId',a.id,'outputRoles',7);
end;
$$;
revoke all on function engineering_private.prepare_native_artifact_outputs(uuid,text)
  from public,anon,authenticated,service_role;
create function engineering_private.write_native_artifact_mappings(
  p_attempt uuid, p_seed_manifest_text text, p_output_bucket text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare a public.engineering_execution_attempts%rowtype; outputs jsonb; inputs jsonb;
begin
  -- Preserve convenience without making preclaim callers require an attempt.
  outputs := engineering_private.prepare_native_artifact_outputs(p_attempt,p_output_bucket);
  select * into a from public.engineering_execution_attempts where id=p_attempt;
  inputs := engineering_private.prepare_native_artifact_inputs(a.input_admission_id,a.owner_user_id,p_seed_manifest_text);
  return inputs || outputs;
end;
$$;
revoke all on function engineering_private.write_native_artifact_mappings(uuid,text,text)
  from public,anon,authenticated,service_role;
commit;
