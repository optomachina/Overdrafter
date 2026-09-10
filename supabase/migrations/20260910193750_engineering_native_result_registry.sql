-- OVD-505: private immutable result registration and finalization. No bucket,
-- credentials, runtime admissions or verifier-writer grants are provisioned.
create table engineering_private.native_result_objects (
  id uuid primary key check (id <> '00000000-0000-0000-0000-000000000000'),
  attempt_id uuid not null,
  organization_id uuid not null,
  project_id uuid not null,
  role text not null check (role in ('assembly','target','companion','result','identity','preservation','native')),
  bytes bigint not null,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  bucket_id text not null default 'engineering-native-results' check (bucket_id='engineering-native-results'),
  object_key text generated always as
    (organization_id::text||'/'||project_id::text||'/'||attempt_id::text||'/'||id::text) stored,
  registered_at timestamptz not null default clock_timestamp(),
  check (bytes between 1 and case role when 'result' then 256000 when 'identity' then 64000
    when 'preservation' then 128000 when 'native' then 4000000 else 16000000 end),
  unique (bucket_id,object_key),
  unique (id,attempt_id,organization_id,project_id),
  foreign key (attempt_id,organization_id,project_id)
    references public.engineering_execution_attempts(id,organization_id,project_id)
);
comment on table engineering_private.native_result_objects is
  'Write-once registry of exact attempt objects. Registration is not verification. No worker-selected URLs or Windows paths. Failed evidence is retained; new objects use new IDs.';

create table engineering_private.native_result_manifests (
  id uuid primary key,
  attempt_id uuid not null,
  organization_id uuid not null,
  project_id uuid not null,
  objects jsonb not null check (jsonb_typeof(objects)='object' and octet_length(objects::text)<=1024),
  manifest_sha256 text generated always as (encode(extensions.digest(objects::text,'sha256'),'hex')) stored,
  sealed_at timestamptz not null default clock_timestamp(),
  unique (id,attempt_id,organization_id,project_id),
  foreign key (attempt_id,organization_id,project_id)
    references public.engineering_execution_attempts(id,organization_id,project_id)
);
create function engineering_private.check_native_result_manifest()
returns trigger language plpgsql set search_path='' as $$
declare entry record; obj engineering_private.native_result_objects%rowtype;
begin
  if (select array_agg(key order by key) from jsonb_object_keys(new.objects) key)
    is distinct from array['assembly','companion','identity','native','preservation','result','target'] then
    raise exception using errcode='23514',message='Complete native result object set required.';
  end if;
  for entry in select key,value from jsonb_each_text(new.objects) loop
    select * into obj from engineering_private.native_result_objects where id=entry.value::uuid;
    if obj.id is null or obj.role<>entry.key or obj.attempt_id<>new.attempt_id
      or obj.organization_id<>new.organization_id or obj.project_id<>new.project_id
      or new.objects->entry.key <> to_jsonb(obj.id::text) then
      raise exception using errcode='23514',message='Native result manifest scope differs.';
    end if;
  end loop;
  return new;
end;
$$;
revoke all on function engineering_private.check_native_result_manifest() from public,anon,authenticated,service_role;
create trigger native_result_manifest_scope before insert on engineering_private.native_result_manifests
  for each row execute function engineering_private.check_native_result_manifest();

create table engineering_private.native_verification_receipts (
  id uuid primary key,
  attempt_id uuid not null,
  organization_id uuid not null,
  project_id uuid not null,
  manifest_id uuid not null,
  stop_admission_id uuid not null,
  job_sha256 text not null check (job_sha256 ~ '^[0-9a-f]{64}$'),
  context_text text not null check (octet_length(context_text) between 1 and 65536),
  context_sha256 text generated always as (encode(extensions.digest(context_text,'sha256'),'hex')) stored,
  policy_version text not null check (policy_version='prepared-native-reports-v1'),
  validator_version text not null check (char_length(validator_version) between 1 and 100),
  verified_at timestamptz not null default clock_timestamp(),
  unique (id,attempt_id,organization_id,project_id),
  foreign key (manifest_id,attempt_id,organization_id,project_id)
    references engineering_private.native_result_manifests(id,attempt_id,organization_id,project_id),
  foreign key (stop_admission_id,attempt_id) references engineering_private.native_stop_admissions(id,attempt_id)
);
comment on table engineering_private.native_verification_receipts is
  'Only the separately trusted stored-byte verifier may write these receipts. API roles have no insert or writer function. Receipt insertion alone cannot finalize a candidate.';

create function engineering_private.check_native_verification_receipt()
returns trigger language plpgsql set search_path='' as $$
declare a public.engineering_execution_attempts%rowtype; ctx jsonb; job jsonb;
  m engineering_private.native_result_manifests%rowtype; expected_files jsonb; expected_checks jsonb;
begin
  select * into a from public.engineering_execution_attempts where id=new.attempt_id;
  ctx := new.context_text::jsonb; job := a.job_text::jsonb;
  select * into m from engineering_private.native_result_manifests where id=new.manifest_id;
  select jsonb_agg(jsonb_build_object('path',p.path,'bytes',o.bytes,'sha256',o.sha256) order by p.position)
    into expected_files from (values ('assembly','synthetic-assembly.SLDASM',1),
      ('target','parts/baseline-5mm.SLDPRT',2),('companion','parts/candidate-8mm.SLDPRT',3)) p(role,path,position)
    join engineering_private.native_result_objects o on o.id=(m.objects->>p.role)::uuid;
  select jsonb_agg(jsonb_build_object('id',p.check_id,'verdict','pass','evidenceSha256',o.sha256) order by p.position)
    into expected_checks from (values ('input_identity','identity',1),('native_integrity','native',2),('dimension','native',3),
      ('assembly_references','native',4),('component_placements','native',5),('save_reopen','native',6),('source_preservation','preservation',7)) p(check_id,role,position)
    join engineering_private.native_result_objects o on o.id=(m.objects->>p.role)::uuid;
  if (a.id is not null and new.job_sha256=a.job_sha256 and new.stop_admission_id=a.stop_admission_id
    and ctx->>'schema'='overdrafter.prepared-assembly.v2' and ctx->>'snapshotId'=a.output_snapshot_id::text
    and ctx->'scope'=job->'scope' and ctx->'sequence'=job->'sequence' and ctx->'seedSnapshotId'=job->'seedSnapshotId'
    and ctx->'depthMm'=job->'depthMm' and ctx->>'configuration'='Default'
    and ctx#>>'{producer,attemptId}'=a.id::text and ctx#>>'{producer,jobId}'=job->>'jobId'
    and ctx#>>'{producer,inputSnapshotId}'=a.input_snapshot_id::text and ctx#>'{producer,fence}'=job->'fence'
    and ctx#>>'{producer,inputContextSha256}'=job->>'contextSha256' and ctx#>>'{producer,requestSha256}'=a.job_sha256
    and ctx#>>'{producer,resultSha256}'=(select sha256 from engineering_private.native_result_objects where id=(m.objects->>'result')::uuid)
    and ctx->'files'=expected_files and ctx->'checks'=expected_checks) is not true then
    raise exception using errcode='23514',message='Verified native context identity differs.';
  end if;
  return new;
end;
$$;
revoke all on function engineering_private.check_native_verification_receipt() from public,anon,authenticated,service_role;
create trigger native_verification_receipt_scope before insert on engineering_private.native_verification_receipts
  for each row execute function engineering_private.check_native_verification_receipt();

create table engineering_private.native_result_finalizations (
  attempt_id uuid primary key,
  organization_id uuid not null,
  project_id uuid not null,
  verification_receipt_id uuid not null unique,
  output_snapshot_id uuid not null unique,
  input_admission_id uuid not null unique references engineering_private.native_input_admissions(id),
  finalized_at timestamptz not null default clock_timestamp(),
  foreign key (verification_receipt_id,attempt_id,organization_id,project_id)
    references engineering_private.native_verification_receipts(id,attempt_id,organization_id,project_id),
  foreign key (output_snapshot_id,organization_id,project_id)
    references public.engineering_snapshots(id,organization_id,project_id)
);
do $$ declare n text; begin
  foreach n in array array['native_result_objects','native_result_manifests','native_verification_receipts','native_result_finalizations'] loop
    execute format('alter table engineering_private.%I enable row level security',n);
    execute format('revoke all on engineering_private.%I from public,anon,authenticated,service_role',n);
    execute format('create trigger native_result_immutable before update or delete on engineering_private.%I for each row execute function engineering_private.reject_engineering_history_mutation()',n);
  end loop;
end; $$;

alter table public.engineering_execution_attempts drop constraint engineering_execution_attempts_phase_check;
alter table public.engineering_execution_attempts add constraint engineering_execution_attempts_phase_check
  check (phase in ('claimed','running','awaiting_result','failed','recovery_required','finalized'));
alter table engineering_private.native_attempt_events drop constraint native_attempt_events_kind_check;
alter table engineering_private.native_attempt_events add constraint native_attempt_events_kind_check
  check (kind in ('claimed','heartbeat','expired','stopped','failed','retry_requested','suffix_canceled','finalized'));

-- The service can consume an already admitted verification receipt, never mint
-- one. Preserve coordinator lock order; do not hold locks while reading storage.
create function engineering_private.finalize_native_result(
  p_worker uuid,p_credential text,p_boot uuid,p_task uuid,p_attempt uuid,p_receipt uuid,p_revision bigint,p_key uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare t public.engineering_tasks%rowtype; a public.engineering_execution_attempts%rowtype;
  w public.engineering_workers%rowtype; x public.engineering_task_execution%rowtype;
  v engineering_private.native_verification_receipts%rowtype; m engineering_private.native_result_manifests%rowtype;
  i engineering_private.native_input_admissions%rowtype; c public.engineering_conversations%rowtype;
  d public.engineering_decisions%rowtype; result jsonb; args jsonb; input_id uuid; at_time timestamptz;
begin
  t := engineering_private.lock_native_task(p_worker,p_credential,p_task);
  select * into a from public.engineering_execution_attempts where id=p_attempt for update;
  if a.id is null or a.task_id<>t.id or a.worker_id<>p_worker or a.boot_id is distinct from p_boot then
    raise exception using errcode='42501',message='Native result access denied.';
  end if;
  args := jsonb_build_object('workerId',p_worker,'bootId',p_boot,'attemptId',p_attempt,'verificationReceiptId',p_receipt);
  result := engineering_private.native_replay(t.id,p_key,p_revision,'finalized',args);
  if result is not null then return result; end if;
  select * into w from public.engineering_workers where id=p_worker;
  select * into x from public.engineering_task_execution where task_id=t.id;
  select * into c from public.engineering_conversations where id=t.conversation_id;
  select * into d from public.engineering_decisions where id=t.decision_id;
  select * into v from engineering_private.native_verification_receipts where id=p_receipt;
  select * into m from engineering_private.native_result_manifests where id=v.manifest_id;
  select * into i from engineering_private.native_input_admissions where id=a.input_admission_id;
  -- Revocation rows have foreign keys to these immutable admissions. FOR UPDATE
  -- conflicts with their FK key-share locks, ordering revocation commit against
  -- this finalization even when revocation starts after the eligibility check.
  perform 1 from engineering_private.native_runtime_admissions where id=a.runtime_admission_id for update;
  perform 1 from engineering_private.native_input_admissions where id=a.input_admission_id for update;
  -- Keep the currently required access facts stable until commit as well. These
  -- reads follow the coordinator locks; access is checked again after any wait.
  perform 1 from engineering_private.engineering_operators
    where organization_id=t.organization_id and user_id=t.owner_user_id for share;
  perform 1 from public.organization_memberships
    where organization_id=t.organization_id and user_id=t.owner_user_id for share;
  perform 1 from public.projects where id=t.project_id for share;
  perform 1 from public.project_memberships
    where project_id=t.project_id and user_id=t.owner_user_id for share;
  at_time := clock_timestamp();
  if not engineering_private.engineering_actor_access(t.owner_user_id,t.organization_id,t.project_id)
    or w.revoked_at is not null or w.current_boot_id is distinct from p_boot then
    raise exception using errcode='42501',message='Native result access denied.';
  end if;
  if a.revision is distinct from p_revision or x.current_attempt_id is distinct from a.id
    or not a.result_eligible or a.phase<>'awaiting_result' or a.stopped_at is null
    or t.execution_state<>'running' or t.verification_state not in ('unverified','checking')
    or c.head_snapshot_id<>a.input_snapshot_id
    or exists(select 1 from engineering_private.native_admission_revocations
      where runtime_admission_id=a.runtime_admission_id or input_admission_id=a.input_admission_id) then
    raise exception using errcode='PT409',message='Native result is no longer eligible.';
  end if;
  if v.id is null or v.attempt_id<>a.id or v.stop_admission_id<>a.stop_admission_id
    or v.job_sha256<>a.job_sha256 or v.verified_at<a.stopped_at or v.verified_at>at_time
    or not exists(select 1 from engineering_private.native_stop_admissions s where s.id=a.stop_admission_id
      and s.execution_outcome='native_exit_succeeded' and s.verdict='all_owned_processes_exited') then
    raise exception using errcode='PT409',message='Current verified native evidence required.';
  end if;
  if d.predecessor_decision_id is not null and not exists (
    select 1 from public.engineering_tasks p join engineering_private.native_result_finalizations f on f.attempt_id=i.producer_attempt_id
    join public.engineering_execution_attempts pa on pa.id=f.attempt_id and pa.task_id=p.id
    where p.decision_id=d.predecessor_decision_id and p.execution_state='succeeded' and p.verification_state='passed'
      and f.output_snapshot_id=a.input_snapshot_id) then
    raise exception using errcode='PT409',message='Verified predecessor changed.';
  end if;
  input_id := gen_random_uuid();
  insert into public.engineering_snapshots(id,organization_id,project_id,context_text)
    values(a.output_snapshot_id,t.organization_id,t.project_id,v.context_text);
  insert into engineering_private.native_input_admissions(id,snapshot_id,organization_id,project_id,kind,producer_attempt_id,
    context_sha256,storage_manifest_sha256,evidence_sha256,requirements_sha256,check_policy_version,validator_version)
    values(input_id,a.output_snapshot_id,t.organization_id,t.project_id,'verified_candidate',a.id,v.context_sha256,m.manifest_sha256,
      encode(extensions.digest(v.id::text||v.context_sha256||m.manifest_sha256||v.job_sha256||v.policy_version,'sha256'),'hex'),
      i.requirements_sha256,i.check_policy_version,v.validator_version);
  insert into engineering_private.native_result_finalizations(attempt_id,organization_id,project_id,verification_receipt_id,output_snapshot_id,input_admission_id)
    values(a.id,t.organization_id,t.project_id,v.id,a.output_snapshot_id,input_id);
  update public.engineering_execution_attempts set revision=revision+1,phase='finalized',result_eligible=false where id=a.id returning * into a;
  update public.engineering_task_execution set revision=revision+1 where task_id=t.id returning * into x;
  update public.engineering_tasks set execution_state='succeeded',verification_state='passed',updated_at=at_time where id=t.id;
  update public.engineering_conversations set head_snapshot_id=a.output_snapshot_id,revision=revision+1,updated_at=at_time where id=c.id;
  result := jsonb_build_object('outcome','finalized','attemptId',a.id,'revision',a.revision,'taskRevision',x.revision,
    'snapshotId',a.output_snapshot_id,'contextSha256',v.context_sha256,'inputAdmissionId',input_id,'verification','passed','adoption','unadopted');
  insert into engineering_private.native_attempt_events(task_id,attempt_id,kind,idempotency_key,expected_revision,arguments,receipt)
    values(t.id,a.id,'finalized',p_key,p_revision,args,result);
  return result;
end;
$$;
revoke all on function engineering_private.finalize_native_result(uuid,text,uuid,uuid,uuid,uuid,bigint,uuid) from public,anon,authenticated,service_role;
grant execute on function engineering_private.finalize_native_result(uuid,text,uuid,uuid,uuid,uuid,bigint,uuid) to service_role;
create function public.api_finalize_native_result(p_worker uuid,p_credential text,p_boot uuid,p_task uuid,p_attempt uuid,p_receipt uuid,p_revision bigint,p_key uuid)
returns jsonb language sql security invoker set search_path='' as $$
  select engineering_private.finalize_native_result(p_worker,p_credential,p_boot,p_task,p_attempt,p_receipt,p_revision,p_key);
$$;
revoke all on function public.api_finalize_native_result(uuid,text,uuid,uuid,uuid,uuid,bigint,uuid) from public,anon,authenticated,service_role;
grant execute on function public.api_finalize_native_result(uuid,text,uuid,uuid,uuid,uuid,bigint,uuid) to service_role;
