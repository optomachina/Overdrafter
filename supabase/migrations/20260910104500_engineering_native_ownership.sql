-- OVD-501: native ownership, separate from artifact verification and publication.
-- Default-off: no admissions or credentials are inserted. Private admission
-- writers and Windows stop qualification must exist before runtime activation.

create unique index engineering_task_scope_key on public.engineering_tasks
  (id, conversation_id, organization_id, project_id, owner_user_id);

create table engineering_private.native_runtime_admissions (
  id uuid primary key,
  worker_id uuid not null,
  installation_id uuid not null,
  organization_id uuid not null,
  project_id uuid not null,
  owner_user_id uuid not null,
  job_schema text not null check (job_schema = 'overdrafter.prepared-dimension-job.v2'),
  source_manifest_sha256 text not null check (source_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  environment_sha256 text not null check (environment_sha256 ~ '^[0-9a-f]{64}$'),
  native_sha256 text not null check (native_sha256 ~ '^[0-9a-f]{64}$'),
  interop_sha256 text not null check (interop_sha256 ~ '^[0-9a-f]{64}$'),
  compiler_sha256 text not null check (compiler_sha256 ~ '^[0-9a-f]{64}$'),
  evidence_sha256 text not null check (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  policy_version text not null check (policy_version = 'prepared-native-ownership-v1'),
  validator_version text not null check (char_length(validator_version) between 1 and 100),
  admitted_by uuid not null references auth.users(id),
  admitted_at timestamptz not null default clock_timestamp(),
  unique (id, worker_id, installation_id, organization_id, project_id, owner_user_id),
  foreign key (worker_id, installation_id) references public.engineering_workers(id, installation_id),
  foreign key (worker_id, organization_id, project_id, owner_user_id)
    references public.engineering_workers(id, organization_id, project_id, owner_user_id)
);

create table engineering_private.native_input_admissions (
  id uuid primary key,
  snapshot_id uuid not null,
  organization_id uuid not null,
  project_id uuid not null,
  kind text not null check (kind in ('qualified_seed','verified_candidate')),
  producer_attempt_id uuid,
  context_sha256 text not null check (context_sha256 ~ '^[0-9a-f]{64}$'),
  storage_manifest_sha256 text not null check (storage_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  evidence_sha256 text not null check (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  requirements_sha256 text not null check (requirements_sha256 ~ '^[0-9a-f]{64}$'),
  check_policy_version text not null check (check_policy_version = 'prepared-native-checks-v2'),
  validator_version text not null check (char_length(validator_version) between 1 and 100),
  admitted_at timestamptz not null default clock_timestamp(),
  check ((kind = 'qualified_seed' and producer_attempt_id is null)
    or (kind = 'verified_candidate' and producer_attempt_id is not null)),
  unique (id, snapshot_id, organization_id, project_id),
  foreign key (snapshot_id, organization_id, project_id)
    references public.engineering_snapshots(id, organization_id, project_id)
);

-- Revocations are separate immutable history; qualification records never mutate.
create table engineering_private.native_admission_revocations (
  id uuid primary key default gen_random_uuid(),
  runtime_admission_id uuid unique references engineering_private.native_runtime_admissions(id),
  input_admission_id uuid unique references engineering_private.native_input_admissions(id),
  revoked_by uuid not null references auth.users(id),
  reason text not null check (char_length(reason) between 1 and 2000 and reason ~ '[^[:space:]]'),
  revoked_at timestamptz not null default clock_timestamp(),
  check (num_nonnulls(runtime_admission_id,input_admission_id) = 1)
);

create table public.engineering_execution_attempts (
  id uuid primary key,
  task_id uuid not null,
  previous_attempt_id uuid,
  conversation_id uuid not null,
  organization_id uuid not null,
  project_id uuid not null,
  owner_user_id uuid not null,
  worker_id uuid not null,
  installation_id uuid not null,
  boot_id uuid not null,
  session_id uuid not null,
  runtime_admission_id uuid not null,
  input_admission_id uuid not null,
  input_snapshot_id uuid not null,
  output_snapshot_id uuid not null,
  fence bigint not null check (fence between 1 and 9007199254740991),
  job_text text not null check (octet_length(job_text) between 1 and 65536),
  job_sha256 text generated always as (encode(extensions.digest(job_text,'sha256'),'hex')) stored,
  claimed_at timestamptz not null,
  deadline_at timestamptz not null,
  lease_expires_at timestamptz not null,
  revision bigint not null default 0 check (revision between 0 and 9007199254740991),
  phase text not null default 'claimed' check (phase in ('claimed','running','awaiting_result','failed','recovery_required')),
  result_eligible boolean not null default true,
  failure_code text check (failure_code in ('native_startup_timeout','input_invalid','runtime_mismatch',
    'native_operation_failed','artifact_invalid','deadline_exceeded','authority_lost','process_uncertain','unclassified')),
  failure_policy_version text check (failure_policy_version = 'prepared-native-failure-v1'),
  stopped_at timestamptz,
  check (deadline_at = claimed_at + interval '10 minutes'),
  check (lease_expires_at > claimed_at and lease_expires_at <= deadline_at),
  check (output_snapshot_id <> input_snapshot_id),
  check ((failure_code is null) = (failure_policy_version is null)),
  check (phase not in ('failed','recovery_required') or not result_eligible),
  unique (id, task_id),
  foreign key (previous_attempt_id, task_id) references public.engineering_execution_attempts(id, task_id),
  unique (id, organization_id),
  unique (id, organization_id, project_id),
  unique (organization_id, fence),
  foreign key (task_id, conversation_id, organization_id, project_id, owner_user_id)
    references public.engineering_tasks(id, conversation_id, organization_id, project_id, owner_user_id),
  foreign key (runtime_admission_id, worker_id, installation_id, organization_id, project_id, owner_user_id)
    references engineering_private.native_runtime_admissions(id, worker_id, installation_id, organization_id, project_id, owner_user_id),
  foreign key (input_admission_id, input_snapshot_id, organization_id, project_id)
    references engineering_private.native_input_admissions(id, snapshot_id, organization_id, project_id),
  foreign key (session_id, worker_id, boot_id) references public.engineering_worker_sessions(id, worker_id, boot_id)
);
alter table engineering_private.native_input_admissions add constraint native_input_producer_scope
  foreign key (producer_attempt_id, organization_id, project_id)
  references public.engineering_execution_attempts(id, organization_id, project_id);

create table engineering_private.native_slots (
  organization_id uuid primary key references public.organizations(id),
  fence bigint not null default 0 check (fence between 0 and 9007199254740991),
  active_attempt_id uuid,
  foreign key (active_attempt_id, organization_id) references public.engineering_execution_attempts(id, organization_id)
);
create table public.engineering_task_execution (
  task_id uuid primary key,
  conversation_id uuid not null,
  organization_id uuid not null,
  project_id uuid not null,
  owner_user_id uuid not null,
  revision bigint not null default 0 check (revision between 0 and 9007199254740991),
  current_attempt_id uuid,
  automatic_retries integer not null default 0 check (automatic_retries between 0 and 1),
  retry_mode text check (retry_mode in ('owner','automatic')),
  retry_boot_id uuid,
  retry_session_id uuid,
  check (num_nonnulls(retry_mode,retry_boot_id,retry_session_id) in (0,3)),
  check (retry_mode is null or current_attempt_id is not null),
  foreign key (current_attempt_id, task_id) references public.engineering_execution_attempts(id, task_id),
  foreign key (task_id, conversation_id, organization_id, project_id, owner_user_id)
    references public.engineering_tasks(id, conversation_id, organization_id, project_id, owner_user_id)
);
create table engineering_private.native_attempt_events (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.engineering_tasks(id),
  attempt_id uuid not null,
  kind text not null check (kind in ('claimed','heartbeat','expired','stopped','failed','retry_requested','suffix_canceled')),
  idempotency_key uuid not null,
  expected_revision bigint not null check (expected_revision between 0 and 9007199254740990),
  arguments jsonb not null check (octet_length(arguments::text) <= 8192),
  receipt jsonb not null check (octet_length(receipt::text) <= 200000),
  actor_user_id uuid references auth.users(id),
  created_at timestamptz not null default clock_timestamp(),
  unique (task_id, idempotency_key),
  foreign key (attempt_id, task_id) references public.engineering_execution_attempts(id, task_id)
);

create function engineering_private.preserve_native_execution_identity()
returns trigger language plpgsql set search_path = '' as $$
declare v_mutable text[];
begin
  if tg_op = 'DELETE' then raise exception using errcode='55000',message='Native execution history cannot be deleted.'; end if;
  if tg_table_name = 'engineering_execution_attempts' then
    v_mutable := array['job_sha256','lease_expires_at','revision','phase','result_eligible','failure_code','failure_policy_version','stopped_at','stop_admission_id'];
    if new.revision <> old.revision + 1 or (not old.result_eligible and new.result_eligible)
      or (old.stopped_at is not null and (new.stopped_at is distinct from old.stopped_at or new.stop_admission_id is distinct from old.stop_admission_id)) then
      raise exception using errcode='55000',message='Invalid native attempt transition.';
    end if;
  elsif tg_table_name = 'engineering_task_execution' then
    v_mutable := array['revision','current_attempt_id','automatic_retries','retry_mode','retry_boot_id','retry_session_id'];
    if new.revision <> old.revision + 1 or new.automatic_retries < old.automatic_retries then
      raise exception using errcode='55000',message='Invalid native task transition.';
    end if;
  else
    v_mutable := array['fence','active_attempt_id'];
    if new.fence < old.fence or new.fence > old.fence + 1 then
      raise exception using errcode='55000',message='Native fencing tokens cannot move backward or skip.';
    end if;
  end if;
  if (to_jsonb(new)-v_mutable) is distinct from (to_jsonb(old)-v_mutable) then
    raise exception using errcode='55000',message='Native execution identity is immutable.';
  end if;
  return new;
end;
$$;
revoke all on function engineering_private.preserve_native_execution_identity() from public,anon,authenticated,service_role;

do $$
declare n text;
begin
  foreach n in array array['native_runtime_admissions','native_input_admissions','native_admission_revocations','native_attempt_events'] loop
    execute format('alter table engineering_private.%I enable row level security',n);
    execute format('revoke all on engineering_private.%I from public,anon,authenticated,service_role',n);
    execute format('create trigger native_history_immutable before update or delete on engineering_private.%I for each row execute function engineering_private.reject_engineering_history_mutation()',n);
  end loop;
end;
$$;
alter table engineering_private.native_slots enable row level security;
revoke all on engineering_private.native_slots from public,anon,authenticated,service_role;
create trigger native_slot_identity before update or delete on engineering_private.native_slots
  for each row execute function engineering_private.preserve_native_execution_identity();
do $$
declare n text;
begin
  foreach n in array array['engineering_execution_attempts','engineering_task_execution'] loop
    execute format('alter table public.%I enable row level security',n);
    execute format('revoke all on public.%I from public,anon,authenticated,service_role',n);
    execute format('grant select on public.%I to authenticated',n);
    execute format('create policy native_owner_read on public.%I for select to authenticated using (owner_user_id=(select auth.uid()) and engineering_private.engineering_access(organization_id,project_id))',n);
    execute format('create trigger native_identity before update or delete on public.%I for each row execute function engineering_private.preserve_native_execution_identity()',n);
  end loop;
end;
$$;

-- All worker paths acquire native organization slot -> worker advisory/row ->
-- existing conversation advisory/row -> task/state/attempt. No native effects.
create function engineering_private.lock_native_task(p_worker uuid,p_credential text,p_task uuid,p_owner boolean default false)
returns public.engineering_tasks language plpgsql security definer set search_path = '' as $$
declare w public.engineering_workers%rowtype; t public.engineering_tasks%rowtype;
begin
  select * into w from public.engineering_workers where id=p_worker;
  if w.id is null then raise exception using errcode='42501',message='Native task access denied.'; end if;
  perform pg_advisory_xact_lock(hashtextextended('engineering-native:'||w.organization_id::text,0));
  insert into engineering_private.native_slots(organization_id) values(w.organization_id) on conflict do nothing;
  perform 1 from engineering_private.native_slots where organization_id=w.organization_id for update;
  w := engineering_private.lock_engineering_worker(p_worker,p_owner,p_credential);
  select * into t from public.engineering_tasks where id=p_task;
  if t.id is null or t.organization_id<>w.organization_id or t.project_id<>w.project_id or t.owner_user_id<>w.owner_user_id then
    raise exception using errcode='42501',message='Native task access denied.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('engineering:'||t.conversation_id::text,0));
  perform 1 from public.engineering_conversations where id=t.conversation_id for update;
  select * into t from public.engineering_tasks where id=p_task for update;
  if not engineering_private.engineering_actor_access(t.owner_user_id,t.organization_id,t.project_id) then
    raise exception using errcode='42501',message='Native task access denied.';
  end if;
  insert into public.engineering_task_execution(task_id,conversation_id,organization_id,project_id,owner_user_id)
    values(t.id,t.conversation_id,t.organization_id,t.project_id,t.owner_user_id) on conflict do nothing;
  perform 1 from public.engineering_task_execution where task_id=t.id for update;
  return t;
end;
$$;
revoke all on function engineering_private.lock_native_task(uuid,text,uuid,boolean) from public,anon,authenticated,service_role;

-- A replay is historical. Call fresh eligibility/heartbeat before native effects.
create function engineering_private.native_replay(p_task uuid,p_key uuid,p_revision bigint,p_kind text,p_args jsonb)
returns jsonb language plpgsql set search_path = '' as $$
declare e engineering_private.native_attempt_events%rowtype;
begin
  if p_key is null or p_revision is null or p_revision not between 0 and 9007199254740990 then
    raise exception using errcode='22023',message='Invalid native transition.';
  end if;
  select * into e from engineering_private.native_attempt_events where task_id=p_task and idempotency_key=p_key;
  if e.id is null then return null; end if;
  if e.kind<>p_kind or e.expected_revision<>p_revision or e.arguments is distinct from p_args then
    raise exception using errcode='PT409',message='Native idempotency key conflicts.';
  end if;
  return e.receipt;
end;
$$;
revoke all on function engineering_private.native_replay(uuid,uuid,bigint,text,jsonb) from public,anon,authenticated,service_role;

create function engineering_private.claim_native_task(
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
    if x.retry_mode is null or t.execution_state<>'failed' or t.verification_state<>'unverified'
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
  update public.engineering_tasks set execution_state='running',updated_at=v_now where id=t.id;
  receipt := jsonb_build_object('outcome','claimed','taskId',t.id,'taskRevision',x.revision+1,'attemptId',a.id,'attemptRevision',a.revision,
    'workerId',w.id,'installationId',w.installation_id,'bootId',p_boot,'sessionId',s.id,'runtimeAdmissionId',r.id,'inputAdmissionId',i.id,
    'fence',a.fence,'jobText',a.job_text,'jobSha256',a.job_sha256,'contextText',snap.context_text,'contextSha256',snap.context_sha256,
    'claimedAt',v_now,'deadlineAt',a.deadline_at,'leaseExpiresAt',a.lease_expires_at);
  insert into engineering_private.native_attempt_events(task_id,attempt_id,kind,idempotency_key,expected_revision,arguments,receipt)
    values(t.id,a.id,'claimed',p_key,p_revision,v_args,receipt);
  return receipt;
end;
$$;
revoke all on function engineering_private.claim_native_task(uuid,text,uuid,uuid,uuid,uuid,bigint,uuid) from public,anon,authenticated,service_role;
grant execute on function engineering_private.claim_native_task(uuid,text,uuid,uuid,uuid,uuid,bigint,uuid) to service_role;
create function public.api_claim_native_task(p_worker uuid,p_credential text,p_boot uuid,p_task uuid,p_runtime uuid,p_input uuid,p_revision bigint,p_key uuid)
returns jsonb language sql security invoker set search_path = '' as $$
  select engineering_private.claim_native_task(p_worker,p_credential,p_boot,p_task,p_runtime,p_input,p_revision,p_key);
$$;
revoke all on function public.api_claim_native_task(uuid,text,uuid,uuid,uuid,uuid,bigint,uuid) from public,anon,authenticated,service_role;
grant execute on function public.api_claim_native_task(uuid,text,uuid,uuid,uuid,uuid,bigint,uuid) to service_role;

-- Called only under the canonical slot/worker/conversation/task locks. Pausing
-- or replacing an eight-hour session does not cancel its already-active attempt.
create function engineering_private.native_attempt_reason(a public.engineering_execution_attempts,w public.engineering_workers,p_now timestamptz)
returns text language plpgsql set search_path = '' as $$
begin
  if a.stopped_at is not null then return 'process_stopped'; end if;
  if a.phase='recovery_required' then return 'recovery_required'; end if;
  if not a.result_eligible or a.phase not in ('claimed','running') or not exists (
    select 1 from engineering_private.native_slots ns join public.engineering_task_execution tx on tx.task_id=a.task_id
      join public.engineering_tasks t on t.id=tx.task_id
    where ns.organization_id=a.organization_id and ns.active_attempt_id=a.id and tx.current_attempt_id=a.id
      and t.execution_state='running' and t.verification_state='unverified') then return 'attempt_not_current'; end if;
  if p_now>=a.deadline_at then return 'deadline_exceeded'; end if;
  if p_now>=a.lease_expires_at then return 'lease_expired'; end if;
  if w.revoked_at is not null then return 'worker_revoked'; end if;
  if w.current_boot_id is distinct from a.boot_id then return 'boot_changed'; end if;
  if exists(select 1 from engineering_private.native_admission_revocations
    where runtime_admission_id=a.runtime_admission_id or input_admission_id=a.input_admission_id) then return 'admission_revoked'; end if;
  return 'eligible';
end;
$$;
revoke all on function engineering_private.native_attempt_reason(public.engineering_execution_attempts,public.engineering_workers,timestamptz) from public,anon,authenticated,service_role;

create function engineering_private.heartbeat_native_attempt(
  p_worker uuid,p_credential text,p_boot uuid,p_task uuid,p_attempt uuid,p_fence bigint,p_revision bigint,p_key uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare t public.engineering_tasks%rowtype; w public.engineering_workers%rowtype;
  a public.engineering_execution_attempts%rowtype; args jsonb; receipt jsonb; v_now timestamptz; reason text;
begin
  t := engineering_private.lock_native_task(p_worker,p_credential,p_task);
  select * into a from public.engineering_execution_attempts where id=p_attempt for update;
  if a.id is null or a.task_id<>t.id or a.worker_id<>p_worker or a.boot_id is distinct from p_boot
    or a.fence is distinct from p_fence then
    raise exception using errcode='42501',message='Native attempt access denied.';
  end if;
  args := jsonb_build_object('workerId',p_worker,'bootId',p_boot,'attemptId',p_attempt,'fence',p_fence);
  receipt := engineering_private.native_replay(t.id,p_key,p_revision,'heartbeat',args);
  if receipt is not null then return receipt; end if;
  if a.revision<>p_revision then raise exception using errcode='PT409',message='Native attempt revision changed.'; end if;
  select * into w from public.engineering_workers where id=p_worker;
  v_now := clock_timestamp();
  if not engineering_private.engineering_actor_access(t.owner_user_id,t.organization_id,t.project_id) then
    raise exception using errcode='42501',message='Native task access denied.';
  end if;
  reason := engineering_private.native_attempt_reason(a,w,v_now);
  if reason in ('process_stopped','attempt_not_current','recovery_required') then
    raise exception using errcode='PT409',message='Native attempt cannot renew.';
  end if;
  if reason='eligible' then
    update public.engineering_execution_attempts set revision=revision+1,
      lease_expires_at=least(v_now+interval '60 seconds',deadline_at) where id=a.id returning * into a;
    receipt := jsonb_build_object('outcome','renewed','attemptId',a.id,'fence',a.fence,'revision',a.revision,
      'leaseExpiresAt',a.lease_expires_at,'deadlineAt',a.deadline_at);
  else
    update public.engineering_execution_attempts set revision=revision+1,phase='recovery_required',result_eligible=false,
      failure_code=case when reason='deadline_exceeded' then 'deadline_exceeded' else 'authority_lost' end,
      failure_policy_version='prepared-native-failure-v1' where id=a.id returning * into a;
    update public.engineering_tasks set execution_state='failed',updated_at=v_now where id=t.id;
    receipt := jsonb_build_object('outcome','recovery_required','reason',reason,'attemptId',a.id,'fence',a.fence,'revision',a.revision);
  end if;
  insert into engineering_private.native_attempt_events(task_id,attempt_id,kind,idempotency_key,expected_revision,arguments,receipt)
    values(t.id,a.id,'heartbeat',p_key,p_revision,args,receipt);
  return receipt;
end;
$$;
revoke all on function engineering_private.heartbeat_native_attempt(uuid,text,uuid,uuid,uuid,bigint,bigint,uuid) from public,anon,authenticated,service_role;
grant execute on function engineering_private.heartbeat_native_attempt(uuid,text,uuid,uuid,uuid,bigint,bigint,uuid) to service_role;
create function public.api_heartbeat_native_attempt(p_worker uuid,p_credential text,p_boot uuid,p_task uuid,p_attempt uuid,p_fence bigint,p_revision bigint,p_key uuid)
returns jsonb language sql security invoker set search_path = '' as $$
  select engineering_private.heartbeat_native_attempt(p_worker,p_credential,p_boot,p_task,p_attempt,p_fence,p_revision,p_key);
$$;
revoke all on function public.api_heartbeat_native_attempt(uuid,text,uuid,uuid,uuid,bigint,bigint,uuid) from public,anon,authenticated,service_role;
grant execute on function public.api_heartbeat_native_attempt(uuid,text,uuid,uuid,uuid,bigint,bigint,uuid) to service_role;

-- Current authority is read independently from historical idempotency receipts.
-- Time/boot/admission changes are reported as ineligible even before a heartbeat
-- persists the recovery transition; occupancy is never cleared by this read.
create function engineering_private.native_attempt_eligibility(p_worker uuid,p_credential text,p_boot uuid,p_task uuid,p_attempt uuid,p_fence bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare t public.engineering_tasks%rowtype; w public.engineering_workers%rowtype;
  a public.engineering_execution_attempts%rowtype; reason text;
begin
  t := engineering_private.lock_native_task(p_worker,p_credential,p_task);
  select * into a from public.engineering_execution_attempts where id=p_attempt for share;
  if a.id is null or a.task_id<>t.id or a.worker_id<>p_worker or a.boot_id is distinct from p_boot or a.fence is distinct from p_fence then
    raise exception using errcode='42501',message='Native attempt access denied.';
  end if;
  select * into w from public.engineering_workers where id=p_worker;
  if not engineering_private.engineering_actor_access(t.owner_user_id,t.organization_id,t.project_id) then
    raise exception using errcode='42501',message='Native task access denied.';
  end if;
  reason := engineering_private.native_attempt_reason(a,w,clock_timestamp());
  return jsonb_build_object('attemptId',a.id,'fence',a.fence,'eligible',reason='eligible','reason',reason,
    'revision',a.revision,'leaseExpiresAt',a.lease_expires_at,'deadlineAt',a.deadline_at);
end;
$$;
revoke all on function engineering_private.native_attempt_eligibility(uuid,text,uuid,uuid,uuid,bigint) from public,anon,authenticated,service_role;
grant execute on function engineering_private.native_attempt_eligibility(uuid,text,uuid,uuid,uuid,bigint) to service_role;
create function public.api_native_attempt_eligibility(p_worker uuid,p_credential text,p_boot uuid,p_task uuid,p_attempt uuid,p_fence bigint)
returns jsonb language sql security invoker set search_path = '' as $$
  select engineering_private.native_attempt_eligibility(p_worker,p_credential,p_boot,p_task,p_attempt,p_fence);
$$;
revoke all on function public.api_native_attempt_eligibility(uuid,text,uuid,uuid,uuid,bigint) from public,anon,authenticated,service_role;
grant execute on function public.api_native_attempt_eligibility(uuid,text,uuid,uuid,uuid,bigint) to service_role;

-- Only a qualified validator may write these records. This slice deliberately
-- grants no insertion path to API roles; arbitrary shutdown booleans are not an
-- admission. The validator must account for every launch/process in the journal.
create table engineering_private.native_stop_admissions (
  id uuid primary key,
  attempt_id uuid not null,
  organization_id uuid not null,
  project_id uuid not null,
  worker_id uuid not null,
  installation_id uuid not null,
  boot_id uuid not null,
  session_id uuid not null,
  runtime_admission_id uuid not null,
  fence bigint not null check (fence between 1 and 9007199254740991),
  job_sha256 text not null check (job_sha256 ~ '^[0-9a-f]{64}$'),
  context_sha256 text not null check (context_sha256 ~ '^[0-9a-f]{64}$'),
  journal_sha256 text not null check (journal_sha256 ~ '^[0-9a-f]{64}$'),
  evidence_sha256 text not null check (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  verdict text not null check (verdict in ('all_owned_processes_exited','no_launch_proven_by_recovery')),
  authority text not null check (authority in ('qualified_worker_validator','authorized_recovery_validator')),
  terminal_processes jsonb not null check (jsonb_typeof(terminal_processes)='array' and jsonb_array_length(terminal_processes)<=128 and octet_length(terminal_processes::text)<=65536),
  execution_outcome text not null check (execution_outcome in ('native_exit_succeeded','native_failed','not_executed')),
  failure_code text check (failure_code in ('native_startup_timeout','input_invalid','runtime_mismatch','native_operation_failed',
    'artifact_invalid','deadline_exceeded','authority_lost','process_uncertain','unclassified')),
  failure_policy_version text not null check (failure_policy_version='prepared-native-failure-v1'),
  validator_version text not null check (char_length(validator_version) between 1 and 100),
  stopped_at timestamptz not null,
  observed_at timestamptz not null,
  admitted_at timestamptz not null default clock_timestamp(),
  admitted_by uuid not null references auth.users(id),
  check (stopped_at<=observed_at and observed_at<=admitted_at),
  check ((execution_outcome='native_exit_succeeded' and failure_code is null)
    or (execution_outcome<>'native_exit_succeeded' and failure_code is not null)),
  check ((verdict='all_owned_processes_exited' and jsonb_array_length(terminal_processes)>0 and execution_outcome<>'not_executed')
    or (verdict='no_launch_proven_by_recovery' and authority='authorized_recovery_validator' and execution_outcome='not_executed' and jsonb_array_length(terminal_processes)=0)),
  unique (id,attempt_id),
  foreign key (attempt_id,organization_id,project_id) references public.engineering_execution_attempts(id,organization_id,project_id)
);
alter table engineering_private.native_stop_admissions enable row level security;
revoke all on engineering_private.native_stop_admissions from public,anon,authenticated,service_role;
create trigger native_stop_immutable before update or delete on engineering_private.native_stop_admissions
  for each row execute function engineering_private.reject_engineering_history_mutation();
alter table public.engineering_execution_attempts add column stop_admission_id uuid;
alter table public.engineering_execution_attempts add constraint native_attempt_stop_identity
  foreign key (stop_admission_id,id) references engineering_private.native_stop_admissions(id,attempt_id);
alter table public.engineering_execution_attempts add constraint native_attempt_stop_pair
  check ((stopped_at is null)=(stop_admission_id is null));

create function engineering_private.record_native_stop(
  p_worker uuid,p_credential text,p_boot uuid,p_task uuid,p_attempt uuid,p_stop uuid,p_revision bigint,p_key uuid,p_owner boolean
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare t public.engineering_tasks%rowtype; w public.engineering_workers%rowtype;
  a public.engineering_execution_attempts%rowtype; stop engineering_private.native_stop_admissions%rowtype;
  x public.engineering_task_execution%rowtype; args jsonb; receipt jsonb; reason text; v_now timestamptz; keep_result boolean; code text;
begin
  t := engineering_private.lock_native_task(p_worker,p_credential,p_task,p_owner);
  select * into a from public.engineering_execution_attempts where id=p_attempt for update;
  if a.id is null or a.task_id<>t.id or a.worker_id<>p_worker or a.boot_id is distinct from p_boot then
    raise exception using errcode='42501',message='Native attempt access denied.';
  end if;
  select * into w from public.engineering_workers where id=p_worker;
  if not p_owner and w.current_boot_id is distinct from p_boot then
    raise exception using errcode='42501',message='Old boot stop evidence requires authorized recovery.';
  end if;
  args := jsonb_build_object('workerId',p_worker,'bootId',p_boot,'attemptId',p_attempt,'stopAdmissionId',p_stop,'ownerRecovery',p_owner);
  receipt := engineering_private.native_replay(t.id,p_key,p_revision,'stopped',args);
  if receipt is not null then return receipt; end if;
  select * into x from public.engineering_task_execution where task_id=t.id;
  if a.revision<>p_revision or a.stopped_at is not null or x.current_attempt_id is distinct from a.id
    or not exists(select 1 from engineering_private.native_slots where organization_id=t.organization_id and active_attempt_id=a.id) then
    raise exception using errcode='PT409',message='Native stop cannot change this attempt or slot.';
  end if;
  select * into stop from engineering_private.native_stop_admissions where id=p_stop for share;
  v_now := clock_timestamp();
  if not engineering_private.engineering_actor_access(t.owner_user_id,t.organization_id,t.project_id) then
    raise exception using errcode='42501',message='Native task access denied.';
  end if;
  if stop.id is null or stop.attempt_id<>a.id or stop.worker_id<>a.worker_id or stop.installation_id<>a.installation_id
    or stop.boot_id<>a.boot_id or stop.session_id<>a.session_id or stop.runtime_admission_id<>a.runtime_admission_id
    or stop.fence<>a.fence or stop.job_sha256<>a.job_sha256 or stop.context_sha256<>(a.job_text::jsonb->>'contextSha256')
    or stop.stopped_at<a.claimed_at or stop.observed_at>v_now
    or (stop.authority='authorized_recovery_validator' and not p_owner) then
    raise exception using errcode='PT409',message='Exact admitted stop evidence is required.';
  end if;
  reason := engineering_private.native_attempt_reason(a,w,v_now);
  keep_result := reason='eligible' and stop.execution_outcome='native_exit_succeeded';
  if keep_result then code := null;
  elsif a.failure_code is not null then code := a.failure_code;
  elsif reason='deadline_exceeded' then code := 'deadline_exceeded';
  elsif reason<>'eligible' then code := 'authority_lost';
  else code := stop.failure_code; end if;
  update public.engineering_execution_attempts set revision=revision+1,stopped_at=stop.stopped_at,stop_admission_id=stop.id,
    phase=case when keep_result then 'awaiting_result' else 'failed' end,result_eligible=keep_result,failure_code=code,
    failure_policy_version=case when code is null then null else 'prepared-native-failure-v1' end where id=a.id returning * into a;
  update engineering_private.native_slots set active_attempt_id=null where organization_id=t.organization_id;
  update public.engineering_task_execution set revision=revision+1 where task_id=t.id returning * into x;
  if not keep_result then update public.engineering_tasks set execution_state='failed',updated_at=v_now where id=t.id; end if;
  receipt := jsonb_build_object('outcome','process_stopped','attemptId',a.id,'revision',a.revision,'taskRevision',x.revision,
    'resultEligible',keep_result,'phase',a.phase,'failureCode',code,'verification','unverified');
  insert into engineering_private.native_attempt_events(task_id,attempt_id,kind,idempotency_key,expected_revision,arguments,receipt,actor_user_id)
    values(t.id,a.id,'stopped',p_key,p_revision,args,receipt,case when p_owner then auth.uid() else null end);
  return receipt;
end;
$$;
revoke all on function engineering_private.record_native_stop(uuid,text,uuid,uuid,uuid,uuid,bigint,uuid,boolean) from public,anon,authenticated,service_role;
-- Distinct trusted wrappers prevent a worker from selecting owner-recovery mode.
create function engineering_private.worker_record_native_stop(p_worker uuid,p_credential text,p_boot uuid,p_task uuid,p_attempt uuid,p_stop uuid,p_revision bigint,p_key uuid)
returns jsonb language sql security definer set search_path = '' as $$
  select engineering_private.record_native_stop(p_worker,p_credential,p_boot,p_task,p_attempt,p_stop,p_revision,p_key,false);
$$;
revoke all on function engineering_private.worker_record_native_stop(uuid,text,uuid,uuid,uuid,uuid,bigint,uuid) from public,anon,authenticated,service_role;
grant execute on function engineering_private.worker_record_native_stop(uuid,text,uuid,uuid,uuid,uuid,bigint,uuid) to service_role;
create function public.api_record_native_stop(p_worker uuid,p_credential text,p_boot uuid,p_task uuid,p_attempt uuid,p_stop uuid,p_revision bigint,p_key uuid)
returns jsonb language sql security invoker set search_path = '' as $$
  select engineering_private.worker_record_native_stop(p_worker,p_credential,p_boot,p_task,p_attempt,p_stop,p_revision,p_key);
$$;
revoke all on function public.api_record_native_stop(uuid,text,uuid,uuid,uuid,uuid,bigint,uuid) from public,anon,authenticated,service_role;
grant execute on function public.api_record_native_stop(uuid,text,uuid,uuid,uuid,uuid,bigint,uuid) to service_role;
create function engineering_private.owner_record_native_stop(p_worker uuid,p_boot uuid,p_task uuid,p_attempt uuid,p_stop uuid,p_revision bigint,p_key uuid)
returns jsonb language sql security definer set search_path = '' as $$
  select engineering_private.record_native_stop(p_worker,null,p_boot,p_task,p_attempt,p_stop,p_revision,p_key,true);
$$;
revoke all on function engineering_private.owner_record_native_stop(uuid,uuid,uuid,uuid,uuid,bigint,uuid) from public,anon,authenticated,service_role;
grant execute on function engineering_private.owner_record_native_stop(uuid,uuid,uuid,uuid,uuid,bigint,uuid) to authenticated;
create function public.api_reconcile_native_stop(p_worker uuid,p_boot uuid,p_task uuid,p_attempt uuid,p_stop uuid,p_revision bigint,p_key uuid)
returns jsonb language sql security invoker set search_path = '' as $$
  select engineering_private.owner_record_native_stop(p_worker,p_boot,p_task,p_attempt,p_stop,p_revision,p_key);
$$;
revoke all on function public.api_reconcile_native_stop(uuid,uuid,uuid,uuid,uuid,bigint,uuid) from public,anon,authenticated,service_role;
grant execute on function public.api_reconcile_native_stop(uuid,uuid,uuid,uuid,uuid,bigint,uuid) to authenticated;

-- Retry intent is durable but never launches a process. Claim consumes it only
-- in the same enabled boot/session, with unchanged input/runtime admissions.
create function engineering_private.request_native_retry(
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
    or t.verification_state<>'unverified' or a.phase<>'failed' or a.result_eligible or a.stop_admission_id is null
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
revoke all on function engineering_private.request_native_retry(uuid,text,uuid,uuid,uuid,bigint,uuid,boolean,text) from public,anon,authenticated,service_role;

create function engineering_private.worker_request_native_retry(p_worker uuid,p_credential text,p_boot uuid,p_task uuid,p_attempt uuid,p_revision bigint,p_key uuid)
returns jsonb language sql security definer set search_path = '' as $$
  select engineering_private.request_native_retry(p_worker,p_credential,p_boot,p_task,p_attempt,p_revision,p_key,false,'classified_transient_retry');
$$;
revoke all on function engineering_private.worker_request_native_retry(uuid,text,uuid,uuid,uuid,bigint,uuid) from public,anon,authenticated,service_role;
grant execute on function engineering_private.worker_request_native_retry(uuid,text,uuid,uuid,uuid,bigint,uuid) to service_role;
create function public.api_request_native_retry(p_worker uuid,p_credential text,p_boot uuid,p_task uuid,p_attempt uuid,p_revision bigint,p_key uuid)
returns jsonb language sql security invoker set search_path = '' as $$
  select engineering_private.worker_request_native_retry(p_worker,p_credential,p_boot,p_task,p_attempt,p_revision,p_key);
$$;
revoke all on function public.api_request_native_retry(uuid,text,uuid,uuid,uuid,bigint,uuid) from public,anon,authenticated,service_role;
grant execute on function public.api_request_native_retry(uuid,text,uuid,uuid,uuid,bigint,uuid) to service_role;

create function engineering_private.owner_request_native_retry(p_worker uuid,p_boot uuid,p_task uuid,p_attempt uuid,p_revision bigint,p_key uuid,p_reason text)
returns jsonb language sql security definer set search_path = '' as $$
  select engineering_private.request_native_retry(p_worker,null,p_boot,p_task,p_attempt,p_revision,p_key,true,p_reason);
$$;
revoke all on function engineering_private.owner_request_native_retry(uuid,uuid,uuid,uuid,bigint,uuid,text) from public,anon,authenticated,service_role;
grant execute on function engineering_private.owner_request_native_retry(uuid,uuid,uuid,uuid,bigint,uuid,text) to authenticated;
create function public.api_retry_native_task(p_worker uuid,p_boot uuid,p_task uuid,p_attempt uuid,p_revision bigint,p_key uuid,p_reason text)
returns jsonb language sql security invoker set search_path = '' as $$
  select engineering_private.owner_request_native_retry(p_worker,p_boot,p_task,p_attempt,p_revision,p_key,p_reason);
$$;
revoke all on function public.api_retry_native_task(uuid,uuid,uuid,uuid,bigint,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.api_retry_native_task(uuid,uuid,uuid,uuid,bigint,uuid,text) to authenticated;

-- Preserve exact suffix and owner checks while admitting confirmed failed-stop recovery.
create or replace function engineering_private.cancel_engineering_suffix(
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
  if exists(select 1 from public.engineering_tasks t where t.decision_id = any(v_suffix)
    and not (
      (t.execution_state in ('blocked','queued') and t.verification_state='unverified')
      or (t.execution_state='failed' and t.verification_state in ('unverified','failed','stale') and exists(
        select 1 from public.engineering_task_execution x join public.engineering_execution_attempts a on a.id=x.current_attempt_id
        where x.task_id=t.id and a.phase='failed' and not a.result_eligible and a.stop_admission_id is not null
          and not exists(select 1 from engineering_private.native_slots where active_attempt_id=a.id))))) then
    raise exception using errcode = 'PT409', message = 'Native execution requires coordinator recovery before cancellation.';
  end if;
  -- Every native transition takes the same conversation lock before changing
  -- these rows. Do not acquire the earlier native/worker locks here.
  update public.engineering_task_execution set revision=revision+1,retry_mode=null,retry_boot_id=null,retry_session_id=null
    where task_id in (select id from public.engineering_tasks where decision_id=any(v_suffix)) and retry_mode is not null;
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
