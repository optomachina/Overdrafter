-- Definite evidence rejection is immutable history. It does not turn a network
-- timeout into a failed engineering check or authorize another native attempt.
create table engineering_private.native_verification_failures (
  id uuid primary key default gen_random_uuid(),
  verification_run_id uuid not null unique,
  attempt_id uuid not null unique,
  organization_id uuid not null,
  project_id uuid not null,
  failure jsonb not null,
  failure_sha256 text generated always as (encode(extensions.digest(failure::text,'sha256'),'hex')) stored,
  receipt jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  foreign key (verification_run_id,attempt_id,organization_id,project_id)
    references engineering_private.native_verification_runs(id,attempt_id,organization_id,project_id),
  check ((jsonb_typeof(failure)='object'
    and failure-array['schema','code','reason','objectId','observedBytes','observedSha256']='{}'::jsonb
    and failure ?& array['schema','code','reason','objectId','observedBytes','observedSha256']
    and failure->>'schema'='overdrafter.native-verification-failure.v1'
    and failure->>'code' in ('artifact_size_mismatch','artifact_digest_mismatch','native_evidence_rejected')
    and failure->>'reason' ~ '^[A-Za-z0-9 _.-]{1,160}$') is true)
);
alter table engineering_private.native_verification_failures add constraint native_verification_failure_reason_string
  check (jsonb_typeof(failure->'reason')='string');
alter table engineering_private.native_verification_failures enable row level security;
revoke all on engineering_private.native_verification_failures from public,anon,authenticated,service_role,engineering_native_verifier;
create trigger native_verification_failure_immutable before update or delete on engineering_private.native_verification_failures
  for each row execute function engineering_private.reject_engineering_history_mutation();
alter table engineering_private.native_attempt_events drop constraint native_attempt_events_kind_check;
alter table engineering_private.native_attempt_events add constraint native_attempt_events_kind_check
  check (kind in ('claimed','heartbeat','expired','stopped','failed','retry_requested','suffix_canceled','finalized','verification_failed'));

create function engineering_private.reject_native_verification(p_run uuid,p_failure jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare p engineering_private.native_verifier_principals%rowtype; r engineering_private.native_verification_runs%rowtype;
  a public.engineering_execution_attempts%rowtype; t public.engineering_tasks%rowtype;
  f engineering_private.native_verification_failures%rowtype; o engineering_private.native_result_objects%rowtype;
  m engineering_private.native_result_manifests%rowtype; at_time timestamptz; failure_id uuid:=gen_random_uuid(); result jsonb; code text;
begin
  p := engineering_private.require_native_verifier();
  select * into r from engineering_private.native_verification_runs where id=p_run;
  if r.id is null or r.principal_id<>p.id or r.organization_id<>p.organization_id or r.project_id<>p.project_id then
    raise exception using errcode='42501',message='Native verification is unavailable.';
  end if;
  select * into a from public.engineering_execution_attempts where id=r.attempt_id;
  if not engineering_private.engineering_actor_access(a.owner_user_id,a.organization_id,a.project_id) then
    raise exception using errcode='42501',message='Native verification is unavailable.';
  end if;
  select * into f from engineering_private.native_verification_failures where verification_run_id=r.id;
  if f.id is not null then
    if f.failure is distinct from p_failure then raise exception using errcode='PT409',message='Verification delivery content differs.'; end if;
    return f.receipt;
  end if;
  a := engineering_private.lock_verifier_attempt(r.manifest_id);
  -- A concurrent identical delivery may have committed while this call waited.
  select * into f from engineering_private.native_verification_failures where verification_run_id=r.id;
  if f.id is not null then
    if f.failure is distinct from p_failure then raise exception using errcode='PT409',message='Verification delivery content differs.'; end if;
    if p.expires_at<=clock_timestamp() then raise exception using errcode='42501',message='Native verification is unavailable.'; end if;
    return f.receipt;
  end if;
  select * into t from public.engineering_tasks where id=a.task_id;
  select * into m from engineering_private.native_result_manifests where id=r.manifest_id;
  perform 1 from engineering_private.native_runtime_admissions where id=a.runtime_admission_id for update;
  perform 1 from engineering_private.native_input_admissions where id=a.input_admission_id for update;
  perform 1 from engineering_private.engineering_operators where organization_id=a.organization_id and user_id=a.owner_user_id for share;
  perform 1 from public.organization_memberships where organization_id=a.organization_id and user_id=a.owner_user_id for share;
  perform 1 from public.projects where id=a.project_id for share;
  perform 1 from public.project_memberships where project_id=a.project_id and user_id=a.owner_user_id for share;
  at_time:=clock_timestamp();
  if p.expires_at<=at_time or not engineering_private.engineering_actor_access(a.owner_user_id,a.organization_id,a.project_id) then
    raise exception using errcode='42501',message='Native verification is unavailable.';
  end if;
  if r.expires_at<=at_time or a.revision<>r.attempt_revision or a.phase<>'awaiting_result' or not a.result_eligible
    or t.execution_state<>'running' or t.verification_state not in ('unverified','checking')
    or not exists(select 1 from public.engineering_task_execution x where x.task_id=a.task_id and x.current_attempt_id=a.id)
    or not exists(select 1 from public.engineering_conversations c where c.id=a.conversation_id and c.head_snapshot_id=a.input_snapshot_id)
    or exists(select 1 from engineering_private.native_slots where active_attempt_id=a.id)
    or exists(select 1 from engineering_private.native_admission_revocations where runtime_admission_id=a.runtime_admission_id or input_admission_id=a.input_admission_id)
    or not exists(select 1 from engineering_private.native_stop_admissions s where s.id=a.stop_admission_id
      and s.execution_outcome='native_exit_succeeded' and s.verdict='all_owned_processes_exited' and s.report_binding is not null) then
    raise exception using errcode='PT409',message='Native result is no longer eligible.';
  end if;
  code:=p_failure->>'code';
  if code='native_evidence_rejected' then
    if (p_failure->'objectId'='null'::jsonb and p_failure->'observedBytes'='null'::jsonb and p_failure->'observedSha256'='null'::jsonb) is not true then
      raise exception using errcode='22023',message='Invalid native evidence rejection.';
    end if;
  elsif code in ('artifact_size_mismatch','artifact_digest_mismatch') then
    select * into o from engineering_private.native_result_objects where id=(p_failure->>'objectId')::uuid;
    if o.id is null or m.objects->>o.role is distinct from o.id::text
      or (jsonb_typeof(p_failure->'observedBytes')='number'
        and (p_failure->>'observedBytes')::numeric between 0 and 9007199254740991
        and trunc((p_failure->>'observedBytes')::numeric)=(p_failure->>'observedBytes')::numeric) is not true then
      raise exception using errcode='22023',message='Invalid artifact rejection identity.';
    end if;
    if code='artifact_size_mismatch' and ((p_failure->>'observedBytes')::numeric=o.bytes or p_failure->'observedSha256' is distinct from 'null'::jsonb) then
      raise exception using errcode='22023',message='Artifact size mismatch evidence required.';
    end if;
    if code='artifact_digest_mismatch' and ((p_failure->>'observedBytes')::numeric<>o.bytes
      or (jsonb_typeof(p_failure->'observedSha256')='string' and p_failure->>'observedSha256' ~ '^[0-9a-f]{64}$' and p_failure->>'observedSha256'<>o.sha256) is not true) then
      raise exception using errcode='22023',message='Artifact digest mismatch evidence required.';
    end if;
  else raise exception using errcode='22023',message='Unsupported verification rejection.';
  end if;
  result:=jsonb_build_object('outcome','verification_failed','failureId',failure_id,'attemptId',a.id,
    'manifestId',m.id,'manifestSha256',m.manifest_sha256,'jobSha256',a.job_sha256,'failure',p_failure,
    'verification','failed','adoption','unadopted');
  insert into engineering_private.native_verification_failures(id,verification_run_id,attempt_id,organization_id,project_id,failure,receipt)
    values(failure_id,r.id,a.id,a.organization_id,a.project_id,p_failure,result);
  update public.engineering_execution_attempts set revision=revision+1,phase='failed',result_eligible=false,
    failure_code=case when code='native_evidence_rejected' then 'native_operation_failed' else 'artifact_invalid' end,
    failure_policy_version='prepared-native-failure-v1' where id=a.id;
  update public.engineering_tasks set execution_state='failed',verification_state='failed',updated_at=at_time where id=t.id;
  update public.engineering_task_execution set revision=revision+1,retry_mode=null,retry_boot_id=null,retry_session_id=null where task_id=t.id;
  insert into engineering_private.native_attempt_events(task_id,attempt_id,kind,idempotency_key,expected_revision,arguments,receipt)
    values(t.id,a.id,'verification_failed',r.id,r.attempt_revision,jsonb_build_object('runId',r.id,'failure',p_failure),result);
  -- Recheck after all writes so any intervening trigger/FK lock wait cannot
  -- publish an expired rejection; the transaction rolls back as one unit.
  if p.expires_at<=clock_timestamp() then raise exception using errcode='42501',message='Native verification is unavailable.'; end if;
  if r.expires_at<=clock_timestamp() then raise exception using errcode='PT409',message='Verification delivery changed or expired.'; end if;
  return result;
end; $$;
revoke all on function engineering_private.reject_native_verification(uuid,jsonb) from public,anon,authenticated,service_role,engineering_native_verifier;
grant execute on function engineering_private.reject_native_verification(uuid,jsonb) to engineering_native_verifier;
create function public.api_reject_native_verification(p_run uuid,p_failure jsonb)
returns jsonb language sql security invoker set search_path='' as $$ select engineering_private.reject_native_verification(p_run,p_failure); $$;
revoke all on function public.api_reject_native_verification(uuid,jsonb) from public,anon,authenticated,service_role,engineering_native_verifier;
grant execute on function public.api_reject_native_verification(uuid,jsonb) to engineering_native_verifier;

-- The owner can inspect exact failure history without gaining verifier rights.
create function engineering_private.get_native_verification_failure(p_attempt uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.engineering_execution_attempts%rowtype;
begin
  select * into a from public.engineering_execution_attempts where id=p_attempt;
  if a.id is null or a.owner_user_id is distinct from auth.uid()
    or not engineering_private.engineering_actor_access(auth.uid(),a.organization_id,a.project_id) then
    raise exception using errcode='42501',message='Native verification is unavailable.';
  end if;
  return (select receipt from engineering_private.native_verification_failures where attempt_id=a.id);
end; $$;
revoke all on function engineering_private.get_native_verification_failure(uuid) from public,anon,authenticated,service_role,engineering_native_verifier;
grant execute on function engineering_private.get_native_verification_failure(uuid) to authenticated;
create function public.api_get_native_verification_failure(p_attempt uuid)
returns jsonb language sql security invoker set search_path='' as $$ select engineering_private.get_native_verification_failure(p_attempt); $$;
revoke all on function public.api_get_native_verification_failure(uuid) from public,anon,authenticated,service_role,engineering_native_verifier;
grant execute on function public.api_get_native_verification_failure(uuid) to authenticated;

-- Preserve rejected delivery history and admit only explicit owner retry.
create or replace function engineering_private.load_native_verification(p_manifest uuid,p_key uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare p engineering_private.native_verifier_principals%rowtype; a public.engineering_execution_attempts%rowtype;
  m engineering_private.native_result_manifests%rowtype; s engineering_private.native_stop_admissions%rowtype;
  r engineering_private.native_verification_runs%rowtype; context_text text; job jsonb; objects jsonb; at_time timestamptz;
begin
  p := engineering_private.require_native_verifier();
  select * into m from engineering_private.native_result_manifests where id=p_manifest;
  if m.id is null or m.organization_id<>p.organization_id or m.project_id<>p.project_id then
    raise exception using errcode='42501',message='Native verification is unavailable.';
  end if;
  select * into a from public.engineering_execution_attempts where id=m.attempt_id;
  if not engineering_private.engineering_actor_access(a.owner_user_id,a.organization_id,a.project_id) then
    raise exception using errcode='42501',message='Native verification is unavailable.';
  end if;
  at_time := clock_timestamp();
  if p_key is null then raise exception using errcode='22023',message='Verification delivery identity required.'; end if;
  if p.expires_at<=at_time then raise exception using errcode='42501',message='Native verification is unavailable.'; end if;
  select * into r from engineering_private.native_verification_runs where principal_id=p.id and idempotency_key=p_key;
  if r.id is not null and r.manifest_id<>m.id then
    raise exception using errcode='PT409',message='Verification delivery changed or expired.';
  end if;
  if r.id is not null and exists(select 1 from engineering_private.native_verification_failures where verification_run_id=r.id) then
    return jsonb_build_object('schema','overdrafter.native-verification-delivery.v1','status','rejected',
      'runId',r.id,'manifestId',m.id,'sourceSha256',p.source_sha256,'policy',p.policy_version,
      'result',(select receipt from engineering_private.native_verification_failures where verification_run_id=r.id));
  end if;
  -- Recover an already committed delivery after a lost completion response.
  -- This is a historical receipt, never fresh native execution authority.
  if r.id is not null and exists(select 1 from engineering_private.native_verification_receipts v
    join engineering_private.native_result_finalizations f on f.verification_receipt_id=v.id where v.verification_run_id=r.id) then
    return jsonb_build_object('schema','overdrafter.native-verification-delivery.v1','status','completed',
      'runId',r.id,'manifestId',m.id,'sourceSha256',p.source_sha256,'policy',p.policy_version,
      'result',(select receipt from engineering_private.native_attempt_events where task_id=a.task_id and idempotency_key=r.id and kind='finalized'));
  end if;
  -- Only fresh verification needs current worker authority. Historical reads
  -- above retain current verifier/project authorization after worker revocation.
  a := engineering_private.lock_verifier_attempt(p_manifest);
  select * into s from engineering_private.native_stop_admissions where id=a.stop_admission_id;
  at_time := clock_timestamp();
  if p.expires_at<=at_time or a.phase<>'awaiting_result' or not a.result_eligible or s.report_binding is null
    or s.execution_outcome<>'native_exit_succeeded' or s.verdict<>'all_owned_processes_exited'
    or not exists(select 1 from public.engineering_task_execution x where x.task_id=a.task_id and x.current_attempt_id=a.id)
    or exists(select 1 from engineering_private.native_admission_revocations where runtime_admission_id=a.runtime_admission_id or input_admission_id=a.input_admission_id)
    or s.report_binding->>'nativeReportSha256' is distinct from (select sha256 from engineering_private.native_result_objects where id=(m.objects->>'native')::uuid) then
    raise exception using errcode='PT409',message='Admitted native result evidence required.';
  end if;
  if r.id is null then
    insert into engineering_private.native_verification_runs(principal_id,idempotency_key,manifest_id,attempt_id,organization_id,project_id,attempt_revision,created_at,expires_at)
      values(p.id,p_key,m.id,a.id,a.organization_id,a.project_id,a.revision,at_time,at_time+interval '60 seconds') returning * into r;
  elsif r.manifest_id<>m.id or r.attempt_revision<>a.revision or r.expires_at<=at_time then
    raise exception using errcode='PT409',message='Verification delivery changed or expired.';
  end if;
  select snap.context_text into context_text from public.engineering_snapshots snap where id=a.input_snapshot_id;
  job := a.job_text::jsonb;
  select jsonb_agg(jsonb_build_object('id',o.id,'scope',job->'scope','attemptId',o.attempt_id,'role',o.role,'bytes',o.bytes,'sha256',o.sha256) order by o.role)
    into objects from jsonb_each_text(m.objects) e join engineering_private.native_result_objects o on o.id=e.value::uuid;
  return jsonb_build_object('schema','overdrafter.native-verification-delivery.v1','status','ready','runId',r.id,'manifestId',m.id,
    'expiresAt',r.expires_at,'sourceSha256',p.source_sha256,'policy',p.policy_version,
    'admission',jsonb_build_object('contextText',context_text,'jobText',a.job_text,
      'active',jsonb_build_object('scope',job->'scope','jobId',job->'jobId','attemptId',a.id,'fence',a.fence,
        'inputSnapshotId',a.input_snapshot_id,'contextSha256',job->'contextSha256','outputSnapshotId',a.output_snapshot_id),
      'process',s.report_binding-array['schema','nativeReportSha256'],'objects',objects));
end; $$;

create or replace function engineering_private.request_native_retry(
  p_worker uuid,p_credential text,p_boot uuid,p_task uuid,p_attempt uuid,p_revision bigint,p_key uuid,p_owner boolean,p_reason text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare t public.engineering_tasks%rowtype; w public.engineering_workers%rowtype;
  s public.engineering_worker_sessions%rowtype; a public.engineering_execution_attempts%rowtype;
  x public.engineering_task_execution%rowtype; args jsonb; receipt jsonb; v_now timestamptz; mode text;
begin
  t := engineering_private.lock_native_task(p_worker,p_credential,p_task,p_owner);
  if p_reason is null or char_length(p_reason) not between 1 and 2000 or p_reason !~ '[^[:space:]]' then
    raise exception using errcode='22023',message='A bounded retry reason is required.';
  end if;
  mode := case when p_owner then 'owner' else 'automatic' end;
  args := jsonb_build_object('workerId',p_worker,'bootId',p_boot,'attemptId',p_attempt,'mode',mode,'reason',p_reason);
  receipt := engineering_private.native_replay(t.id,p_key,p_revision,'retry_requested',args);
  if receipt is not null then return receipt; end if;
  select * into x from public.engineering_task_execution where task_id=t.id;
  select * into a from public.engineering_execution_attempts where id=p_attempt for update;
  if a.id is null or a.task_id<>t.id or a.worker_id<>p_worker then
    raise exception using errcode='42501',message='Native attempt access denied.';
  end if;
  if x.revision<>p_revision or x.current_attempt_id is distinct from a.id or t.execution_state<>'failed'
    or (t.verification_state<>'unverified' and not (p_owner and t.verification_state='failed'
      and exists(select 1 from engineering_private.native_verification_failures vf where vf.attempt_id=a.id))) or a.phase<>'failed' or a.result_eligible or a.stop_admission_id is null
    or exists(select 1 from engineering_private.native_slots where active_attempt_id=a.id) then
    raise exception using errcode='PT409',message='Retry requires the current failed task and admitted process stop.';
  end if;
  select * into w from public.engineering_workers where id=p_worker;
  select * into s from public.engineering_worker_sessions where id=w.current_session_id;
  perform 1 from engineering_private.native_runtime_admissions where id=a.runtime_admission_id for share;
  perform 1 from engineering_private.native_input_admissions where id=a.input_admission_id for share;
  v_now := clock_timestamp();
  if not engineering_private.engineering_actor_access(t.owner_user_id,t.organization_id,t.project_id) then
    raise exception using errcode='42501',message='Native task access denied.';
  end if;
  if w.revoked_at is not null or p_boot is null or w.current_boot_id is distinct from p_boot or s.id is null
    or s.boot_id<>p_boot or s.paused_at is not null or v_now>=s.expires_at then
    return jsonb_build_object('outcome','ineligible','reason','owner_enablement_required');
  end if;
  if exists(select 1 from engineering_private.native_admission_revocations
    where runtime_admission_id=a.runtime_admission_id or input_admission_id=a.input_admission_id) then
    return jsonb_build_object('outcome','ineligible','reason','qualified_inputs_required');
  end if;
  if not p_owner and (x.automatic_retries>=1 or a.failure_code is distinct from 'native_startup_timeout'
    or a.failure_policy_version is distinct from 'prepared-native-failure-v1'
    or not exists(select 1 from engineering_private.native_stop_admissions stop where stop.id=a.stop_admission_id
      and stop.failure_code='native_startup_timeout' and stop.failure_policy_version='prepared-native-failure-v1')) then
    return jsonb_build_object('outcome','ineligible','reason','automatic_retry_not_permitted');
  end if;
  update public.engineering_task_execution set revision=revision+1,retry_mode=mode,retry_boot_id=p_boot,retry_session_id=s.id
    where task_id=t.id returning * into x;
  receipt := jsonb_build_object('outcome','retry_requested','taskId',t.id,'attemptId',a.id,'taskRevision',x.revision,
    'mode',mode,'bootId',p_boot,'sessionId',s.id,'automaticRetries',x.automatic_retries);
  insert into engineering_private.native_attempt_events(task_id,attempt_id,kind,idempotency_key,expected_revision,arguments,receipt,actor_user_id)
    values(t.id,a.id,'retry_requested',p_key,p_revision,args,receipt,case when p_owner then auth.uid() else null end);
  return receipt;
end;
$$;

create or replace function engineering_private.claim_native_task(
  p_worker uuid,p_credential text,p_boot uuid,p_task uuid,p_runtime uuid,p_input uuid,p_revision bigint,p_key uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  t public.engineering_tasks%rowtype; w public.engineering_workers%rowtype;
  s public.engineering_worker_sessions%rowtype; x public.engineering_task_execution%rowtype;
  d public.engineering_decisions%rowtype; predecessor public.engineering_tasks%rowtype;
  r engineering_private.native_runtime_admissions%rowtype; i engineering_private.native_input_admissions%rowtype;
  snap public.engineering_snapshots%rowtype; slot engineering_private.native_slots%rowtype;
  a public.engineering_execution_attempts%rowtype; previous public.engineering_execution_attempts%rowtype;
  v_args jsonb; receipt jsonb; ctx jsonb; job jsonb; v_now timestamptz;
  attempt_id uuid := gen_random_uuid(); output_id uuid := gen_random_uuid();
begin
  t := engineering_private.lock_native_task(p_worker,p_credential,p_task);
  v_args := jsonb_build_object('workerId',p_worker,'bootId',p_boot,'runtimeAdmissionId',p_runtime,'inputAdmissionId',p_input);
  receipt := engineering_private.native_replay(t.id,p_key,p_revision,'claimed',v_args);
  if receipt is not null then return receipt; end if;
  select * into w from public.engineering_workers where id=p_worker;
  select * into s from public.engineering_worker_sessions where id=w.current_session_id;
  select * into x from public.engineering_task_execution where task_id=t.id;
  select * into slot from engineering_private.native_slots where organization_id=t.organization_id;
  select * into r from engineering_private.native_runtime_admissions where id=p_runtime for share;
  select * into i from engineering_private.native_input_admissions where id=p_input for share;
  -- This wall-clock check occurs after every potentially blocking lock above.
  v_now := clock_timestamp();
  if not engineering_private.engineering_actor_access(t.owner_user_id,t.organization_id,t.project_id) then
    raise exception using errcode='42501',message='Native task access denied.';
  end if;
  if x.revision<>p_revision then raise exception using errcode='PT409',message='Native task revision changed.'; end if;
  if p_boot is null or w.current_boot_id is distinct from p_boot or s.id is null or s.boot_id<>p_boot
    or s.paused_at is not null or v_now>=s.expires_at then
    return jsonb_build_object('outcome','ineligible','reason','owner_enablement_required');
  end if;
  if slot.active_attempt_id is not null then return jsonb_build_object('outcome','ineligible','reason','native_slot_occupied'); end if;
  if r.id is null or r.worker_id<>w.id or r.installation_id<>w.installation_id or
    i.id is null or i.organization_id<>t.organization_id or i.project_id<>t.project_id or
    exists(select 1 from engineering_private.native_admission_revocations where runtime_admission_id=r.id or input_admission_id=i.id) then
    return jsonb_build_object('outcome','ineligible','reason','qualified_inputs_required');
  end if;
  if x.current_attempt_id is null then
    if t.execution_state not in ('blocked','queued') or t.verification_state<>'unverified' then
      raise exception using errcode='PT409',message='Task is not eligible for a first native attempt.';
    end if;
  else
    select * into previous from public.engineering_execution_attempts where id=x.current_attempt_id;
    if x.retry_mode is null or t.execution_state<>'failed' or (t.verification_state<>'unverified'
      and not (x.retry_mode='owner' and t.verification_state='failed'
        and exists(select 1 from engineering_private.native_verification_failures vf where vf.attempt_id=previous.id)))
      or previous.phase<>'failed' or previous.result_eligible or previous.stop_admission_id is null
      or previous.input_admission_id<>i.id or previous.runtime_admission_id<>r.id then
      raise exception using errcode='PT409',message='Exact stopped attempt and retry authorization are required.';
    end if;
    if x.retry_boot_id<>p_boot or x.retry_session_id<>s.id then
      return jsonb_build_object('outcome','ineligible','reason','fresh_retry_authorization_required');
    end if;
    if x.retry_mode='automatic' and (x.automatic_retries>=1 or previous.failure_code<>'native_startup_timeout') then
      raise exception using errcode='PT409',message='Automatic native retry is not eligible.';
    end if;
  end if;
  select * into d from public.engineering_decisions where id=t.decision_id;
  if exists(select 1 from public.engineering_tasks earlier join public.engineering_decisions ed on ed.id=earlier.decision_id
    where earlier.conversation_id=t.conversation_id and ed.sequence<d.sequence
    and earlier.execution_state<>'canceled' and (earlier.execution_state<>'succeeded' or earlier.verification_state<>'passed')) then
    return jsonb_build_object('outcome','ineligible','reason','verified_predecessor_required');
  end if;
  select * into snap from public.engineering_snapshots where id=i.snapshot_id;
  if snap.context_sha256<>i.context_sha256 then raise exception using errcode='PT409',message='Input admission identity differs.'; end if;
  ctx := snap.context_text::jsonb;
  if d.predecessor_decision_id is null then
    if i.kind<>'qualified_seed' or i.snapshot_id<>d.requested_snapshot_id or ctx->>'sequence'<>'0'
      or ctx->>'depthMm'<>'5' or ctx->>'seedSnapshotId'<>i.snapshot_id::text then
      return jsonb_build_object('outcome','ineligible','reason','qualified_seed_required');
    end if;
  else
    select * into predecessor from public.engineering_tasks where decision_id=d.predecessor_decision_id;
    if predecessor.id is null or predecessor.execution_state<>'succeeded' or predecessor.verification_state<>'passed'
      or i.kind<>'verified_candidate' or not exists (
        select 1 from public.engineering_task_execution px join public.engineering_execution_attempts pa on pa.id=px.current_attempt_id
        where px.task_id=predecessor.id and pa.id=i.producer_attempt_id and pa.output_snapshot_id=i.snapshot_id
          and ctx#>>'{producer,attemptId}'=pa.id::text) then
      return jsonb_build_object('outcome','ineligible','reason','verified_predecessor_required');
    end if;
  end if;
  if (ctx->>'sequence')::bigint not between 0 and 9007199254740990 or slot.fence>=9007199254740991 then
    raise exception using errcode='PT409',message='Native sequence or fence exhausted.';
  end if;
  job := jsonb_build_object('schema',r.job_schema,'scope',ctx->'scope','jobId',gen_random_uuid(),'attemptId',attempt_id,
    'fence',slot.fence+1,'inputSnapshotId',snap.id,'outputSnapshotId',output_id,'seedSnapshotId',ctx->'seedSnapshotId',
    'sequence',(ctx->>'sequence')::bigint+1,'contextSha256',snap.context_sha256,'inputFiles',ctx->'files',
    'expectedDepthMm',ctx->'depthMm','dimensionId','baseline-depth','depthMm',d.operation->'depthMm','configuration','Default',
    'createdAt',to_char(v_now at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'requiredChecks',jsonb_build_array('input_identity','native_integrity','dimension','assembly_references','component_placements','save_reopen','source_preservation'));
  insert into public.engineering_execution_attempts(id,task_id,previous_attempt_id,conversation_id,organization_id,project_id,owner_user_id,
    worker_id,installation_id,boot_id,session_id,runtime_admission_id,input_admission_id,input_snapshot_id,output_snapshot_id,
    fence,job_text,claimed_at,deadline_at,lease_expires_at)
    values(attempt_id,t.id,previous.id,t.conversation_id,t.organization_id,t.project_id,t.owner_user_id,w.id,w.installation_id,p_boot,s.id,r.id,i.id,
      snap.id,output_id,slot.fence+1,job::text,v_now,v_now+interval '10 minutes',v_now+interval '60 seconds') returning * into a;
  update engineering_private.native_slots set active_attempt_id=a.id,fence=a.fence where organization_id=t.organization_id;
  update public.engineering_task_execution set revision=revision+1,current_attempt_id=a.id,
    automatic_retries=automatic_retries+case when retry_mode='automatic' then 1 else 0 end,
    retry_mode=null,retry_boot_id=null,retry_session_id=null where task_id=t.id;
  update public.engineering_tasks set execution_state='running',verification_state='unverified',updated_at=v_now where id=t.id;
  receipt := jsonb_build_object('outcome','claimed','taskId',t.id,'taskRevision',x.revision+1,'attemptId',a.id,'attemptRevision',a.revision,
    'workerId',w.id,'installationId',w.installation_id,'bootId',p_boot,'sessionId',s.id,'runtimeAdmissionId',r.id,'inputAdmissionId',i.id,
    'fence',a.fence,'jobText',a.job_text,'jobSha256',a.job_sha256,'contextText',snap.context_text,'contextSha256',snap.context_sha256,
    'claimedAt',v_now,'deadlineAt',a.deadline_at,'leaseExpiresAt',a.lease_expires_at);
  insert into engineering_private.native_attempt_events(task_id,attempt_id,kind,idempotency_key,expected_revision,arguments,receipt)
    values(t.id,a.id,'claimed',p_key,p_revision,v_args,receipt);
  return receipt;
end;
$$;
