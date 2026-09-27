-- Source-only. Apply after OVD-560 in an exclusively owned disposable fixture.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
do $preflight$
begin
  if current_user <> 'postgres'
    or to_regprocedure('engineering_private.register_native_result_object(uuid,uuid,uuid,uuid,bigint,uuid,uuid,text,text,text,uuid,text,timestamptz,bigint,text)') is null
    or to_regclass('engineering_private.native_finalizations') is not null then
    raise exception 'ovd561_preflight_failed';
  end if;
end $preflight$;

create table engineering_private.native_receipt_key (
  singleton boolean primary key default true check (singleton),
  key_bytes bytea not null check (octet_length(key_bytes) >= 32)
);
create table engineering_private.native_finalizations (
  attempt_id uuid primary key references public.engineering_execution_attempts(id),
  task_id uuid not null unique references public.engineering_tasks(id),
  idempotency_key uuid not null,
  payload_text text not null,
  signature text not null,
  candidate_context_text text not null,
  snapshot_id uuid not null unique references public.engineering_snapshots(id),
  input_admission_id uuid not null unique references engineering_private.native_input_admissions(id),
  receipt jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  unique(task_id,idempotency_key)
);
alter table engineering_private.native_receipt_key enable row level security;
alter table engineering_private.native_finalizations enable row level security;
revoke all on engineering_private.native_receipt_key, engineering_private.native_finalizations
  from public,anon,authenticated,service_role,engineering_native_verifier;
create trigger native_finalizations_immutable before update or delete
  on engineering_private.native_finalizations for each row
  execute function engineering_private.reject_engineering_history_mutation();

-- Owner-only, invoker security: possession of a signed receipt grants no SQL access.
create function engineering_private.finalize_native_result(
  p_payload_text text, p_signature text, p_candidate_context_text text, p_key uuid)
returns jsonb language plpgsql security invoker set search_path = '' as $body$
declare
  denied constant text := '42501';
  conflict constant text := 'PT409';
  p jsonb; ctx jsonb; secret bytea; v_now timestamptz; issued timestamptz;
  a public.engineering_execution_attempts%rowtype;
  t public.engineering_tasks%rowtype;
  w public.engineering_workers%rowtype;
  x public.engineering_task_execution%rowtype;
  c public.engineering_conversations%rowtype;
  d public.engineering_decisions%rowtype;
  s public.engineering_snapshots%rowtype;
  prior engineering_private.native_finalizations%rowtype;
  input_admission engineering_private.native_input_admissions%rowtype;
  registered engineering_private.native_verifier_registered_objects%rowtype;
  item jsonb; admission_id uuid := gen_random_uuid(); successor uuid; answer jsonb;
begin
  if current_user <> 'postgres' then raise exception 'ovd561_owner_required' using errcode=denied; end if;
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'ovd561_read_committed_required' using errcode=denied;
  end if;
  if p_key is null or p_payload_text is null or octet_length(p_payload_text) not between 1 and 16384
    or p_candidate_context_text is null or octet_length(p_candidate_context_text) not between 1 and 65536
    or p_signature is null or p_signature !~ '^[0-9a-f]{64}$' then
    raise exception 'ovd561_invalid_request' using errcode=denied;
  end if;
  select key_bytes into secret from engineering_private.native_receipt_key where singleton for share;
  if secret is null or extensions.hmac(convert_to(p_payload_text,'UTF8'),secret,'sha256') <> decode(p_signature,'hex') then
    raise exception 'ovd561_invalid_signature' using errcode=denied;
  end if;
  p := p_payload_text::jsonb; ctx := p_candidate_context_text::jsonb;
  if p->>'schema' is distinct from 'overdrafter.native-verification-receipt.v2'
    or p->>'policy' is distinct from 'prepared-native-reports-v2'
    or p->>'candidateContextSha256' is distinct from encode(extensions.digest(p_candidate_context_text,'sha256'),'hex')
    or jsonb_typeof(p->'objects') is distinct from 'array' then
    raise exception 'ovd561_incompatible_receipt' using errcode=denied;
  end if;
  select * into a from public.engineering_execution_attempts where id=(p->>'attemptId')::uuid;
  if a.id is null then raise exception 'ovd561_unknown_attempt' using errcode=denied; end if;
  perform pg_advisory_xact_lock(hashtextextended('engineering-native:'||a.organization_id::text,0));
  perform 1 from engineering_private.native_slots where organization_id=a.organization_id for update;
  perform pg_advisory_xact_lock(hashtextextended('engineering-worker:'||a.worker_id::text,0));
  perform 1 from public.engineering_workers where id=a.worker_id for update;
  perform pg_advisory_xact_lock(hashtextextended('engineering:'||a.conversation_id::text,0));
  select * into c from public.engineering_conversations where id=a.conversation_id for update;
  select * into t from public.engineering_tasks where id=a.task_id for update;
  select * into x from public.engineering_task_execution where task_id=a.task_id for update;
  select * into a from public.engineering_execution_attempts where id=a.id for update;
  select * into prior from engineering_private.native_finalizations where task_id=t.id;
  if prior.task_id is not null then
    if prior.attempt_id=a.id and prior.idempotency_key=p_key and prior.payload_text=p_payload_text
      and prior.signature=p_signature and prior.candidate_context_text=p_candidate_context_text then return prior.receipt; end if;
    raise exception 'ovd561_conflicting_replay' using errcode=conflict;
  end if;
  -- Block revocation/access writers through commit; refresh reads after all waits.
  lock table engineering_private.native_admission_revocations,
    engineering_private.engineering_operators, public.organization_memberships,
    public.project_memberships, public.projects in share mode;
  select * into s from public.engineering_snapshots where id=a.input_snapshot_id;
  select * into input_admission from engineering_private.native_input_admissions where id=a.input_admission_id;
  select * into d from public.engineering_decisions where id=t.decision_id;
  for registered in select * from engineering_private.native_verifier_registered_objects
    where attempt_id=a.id order by artifact_role loop
    perform 1 from storage.objects where id=registered.storage_object_id for share;
    perform 1 from storage.buckets where id=registered.bucket_id for share;
  end loop;
  -- Acquire every row that later mutations may wait on before the fresh check.
  perform 1 from public.engineering_tasks nt join public.engineering_decisions nd on nd.id=nt.decision_id
    where nd.predecessor_decision_id=d.id order by nt.id for update of nt;
  select * into w from public.engineering_workers where id=a.worker_id;
  v_now := clock_timestamp(); issued := (p->>'issuedAt')::timestamptz;
  if issued is null or issued>a.deadline_at or issued<a.claimed_at or issued>v_now
    or v_now>=issued+interval '5 minutes' or v_now>=a.deadline_at
    or not engineering_private.engineering_actor_access(t.owner_user_id,t.organization_id,t.project_id)
    or w.revoked_at is not null or w.current_boot_id is distinct from a.boot_id
    or exists(select 1 from engineering_private.native_admission_revocations
      where runtime_admission_id=a.runtime_admission_id or input_admission_id=a.input_admission_id)
    or a.phase<>'awaiting_result' or not a.result_eligible or a.stop_admission_id is null
    or x.current_attempt_id is distinct from a.id or t.execution_state<>'running'
    or t.verification_state not in ('unverified','checking')
    or c.head_snapshot_id is distinct from a.input_snapshot_id
    or p->>'taskId' is distinct from t.id::text or p->>'fence' is distinct from a.fence::text
    or p->>'organizationId' is distinct from a.organization_id::text
    or p->>'projectId' is distinct from a.project_id::text
    or p->>'inputSnapshotId' is distinct from a.input_snapshot_id::text
    or p->>'candidateSnapshotId' is distinct from a.output_snapshot_id::text
    or p->>'contextSha256' is distinct from s.context_sha256
    or p->>'jobSha256' is distinct from a.job_sha256
    or input_admission.context_sha256 is distinct from s.context_sha256 then
    raise exception 'ovd561_stale_or_foreign_receipt' using errcode=denied;
  end if;
  if exists(select 1 from public.engineering_tasks earlier join public.engineering_decisions ed on ed.id=earlier.decision_id
    where earlier.conversation_id=t.conversation_id and ed.sequence<d.sequence
      and earlier.execution_state<>'canceled' and (earlier.execution_state<>'succeeded' or earlier.verification_state<>'passed')) then
    raise exception 'ovd561_predecessor_unverified' using errcode=conflict;
  end if;
  if ctx->>'snapshotId' is distinct from a.output_snapshot_id::text
    or ctx#>>'{producer,attemptId}' is distinct from a.id::text
    or ctx#>>'{producer,fence}' is distinct from a.fence::text
    or ctx#>>'{producer,inputSnapshotId}' is distinct from a.input_snapshot_id::text
    or ctx#>>'{producer,inputContextSha256}' is distinct from s.context_sha256
    or ctx#>>'{producer,requestSha256}' is distinct from a.job_sha256
    or ctx#>>'{producer,resultSha256}' is distinct from p->>'resultSha256'
    or ctx->'sequence' is distinct from a.job_text::jsonb->'sequence'
    or ctx->'depthMm' is distinct from d.operation->'depthMm' then
    raise exception 'ovd561_candidate_lineage_mismatch' using errcode=denied;
  end if;
  if jsonb_array_length(p->'objects')<>7
    or (select count(distinct o->>'role') from jsonb_array_elements(p->'objects') o)<>7
    or (select count(*) from engineering_private.native_verifier_registered_objects where attempt_id=a.id)<>7 then
    raise exception 'ovd561_registry_mismatch' using errcode=denied;
  end if;
  for item in select value from jsonb_array_elements(p->'objects') loop
    select r.* into registered from engineering_private.native_verifier_registered_objects r
      join storage.objects obj on obj.id=r.storage_object_id
      join storage.buckets b on b.id=r.bucket_id and not b.public
      where r.attempt_id=a.id and r.artifact_role=item->>'role'
        and r.storage_object_id::text=item->>'id' and r.byte_length::text=item->>'bytes'
        and r.sha256=item->>'sha256' and r.task_id=t.id and r.fence=a.fence
        and r.organization_id=a.organization_id and r.project_id=a.project_id
        and r.input_snapshot_id=a.input_snapshot_id and r.candidate_snapshot_id=a.output_snapshot_id
        and obj.bucket_id=r.bucket_id and obj.name=r.object_name
        and obj.version=r.storage_version and obj.updated_at=r.storage_updated_at;
    if registered.attempt_id is null
      or (item->>'role'='result' and item->>'sha256' is distinct from p->>'resultSha256') then
      raise exception 'ovd561_registry_mismatch' using errcode=denied;
    end if;
  end loop;
  insert into public.engineering_snapshots(id,organization_id,project_id,context_text)
    values(a.output_snapshot_id,a.organization_id,a.project_id,p_candidate_context_text);
  insert into engineering_private.native_input_admissions(id,snapshot_id,organization_id,project_id,kind,
    producer_attempt_id,context_sha256,storage_manifest_sha256,evidence_sha256,requirements_sha256,
    check_policy_version,validator_version)
    values(admission_id,a.output_snapshot_id,a.organization_id,a.project_id,'verified_candidate',a.id,
      p->>'candidateContextSha256',encode(extensions.digest((p->'objects')::text,'sha256'),'hex'),
      encode(extensions.digest(p_payload_text,'sha256'),'hex'),input_admission.requirements_sha256,
      'prepared-native-checks-v2','ovd561-receipt-v2');
  update public.engineering_tasks set execution_state='succeeded',verification_state='passed',updated_at=v_now where id=t.id;
  update public.engineering_execution_attempts set result_eligible=false,revision=revision+1 where id=a.id;
  update public.engineering_task_execution set revision=revision+1 where task_id=t.id;
  update public.engineering_conversations set head_snapshot_id=a.output_snapshot_id,updated_at=v_now where id=c.id;
  update public.engineering_tasks nt set execution_state='queued',updated_at=v_now
    from public.engineering_decisions nd where nt.decision_id=nd.id and nd.predecessor_decision_id=d.id
      and nt.execution_state='blocked' and nt.verification_state='unverified' returning nt.id into successor;
  answer := jsonb_build_object('outcome','finalized','taskId',t.id,'attemptId',a.id,'fence',a.fence,
    'snapshotId',a.output_snapshot_id,'inputAdmissionId',admission_id,'successorTaskId',successor);
  insert into engineering_private.native_finalizations(attempt_id,task_id,idempotency_key,payload_text,
    signature,candidate_context_text,snapshot_id,input_admission_id,receipt)
    values(a.id,t.id,p_key,p_payload_text,p_signature,p_candidate_context_text,a.output_snapshot_id,admission_id,answer);
  return answer;
end $body$;
revoke all on function engineering_private.finalize_native_result(text,text,text,uuid)
  from public,anon,authenticated,service_role,engineering_native_verifier;
commit;
