-- OVD-576: source-only stop trust. No role membership, actor, qualification,
-- credential or endpoint is provisioned. A complete OVD-575 observer envelope
-- is evidence of process exit, not qualification for a prepared native job.
-- Rollback: revoke the executor grant first. Keep immutable qualification and
-- stop history; retiring this entrypoint needs a separate forward migration.
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname='ovd576_stop_validator') then
    create role ovd576_stop_validator nologin noinherit;
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname='ovd576_stop_validator'
      and (rolcanlogin or rolinherit or rolsuper or rolcreatedb or rolcreaterole
        or rolreplication or rolbypassrls))
    or pg_catalog.pg_has_role('service_role','ovd576_stop_validator','member')
    or pg_catalog.pg_has_role('anon','ovd576_stop_validator','member')
    or pg_catalog.pg_has_role('authenticated','ovd576_stop_validator','member') then
    raise exception 'OVD-576 stop validator role has unsafe attributes or membership';
  end if;
end;
$$;
grant usage on schema engineering_private to ovd576_stop_validator;

-- Written only by the database owner after an independent, exact prepared-job
-- qualification. OVD-575's profile.native_qualification and stop_admission
-- deliberately remain false. A fixture row proves the contract, not a live
-- qualification or a route by which an observer certifies itself.
alter table engineering_private.native_observer_evidence
  add constraint native_observer_stop_qualification_identity
  unique (id,attempt_id,profile_id,runtime_admission_id,boot_id,fence);
create table engineering_private.native_stop_qualifications (
  evidence_id uuid primary key references engineering_private.native_observer_evidence(id),
  attempt_id uuid not null unique,
  profile_id uuid not null,
  runtime_admission_id uuid not null,
  boot_id uuid not null,
  fence bigint not null check (fence between 1 and 9007199254740991),
  job_sha256 text not null check (job_sha256 ~ '^[0-9a-f]{64}$'),
  context_sha256 text not null check (context_sha256 ~ '^[0-9a-f]{64}$'),
  manifest_sha256 text not null check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  journal_sha256 text not null check (journal_sha256 ~ '^[0-9a-f]{64}$'),
  qualification_sha256 text not null check (qualification_sha256 ~ '^[0-9a-f]{64}$'),
  scope text not null check (scope='prepared_native_exact_attempt_v1'),
  qualified_by uuid not null references auth.users(id),
  qualified_at timestamptz not null default clock_timestamp(),
  foreign key (evidence_id,attempt_id,profile_id,runtime_admission_id,boot_id,fence)
    references engineering_private.native_observer_evidence
      (id,attempt_id,profile_id,runtime_admission_id,boot_id,fence)
);
alter table engineering_private.native_stop_qualifications enable row level security;
revoke all on engineering_private.native_stop_qualifications
  from public,anon,authenticated,service_role,ovd576_stop_validator;
create trigger native_stop_qualification_immutable before update or delete
  on engineering_private.native_stop_qualifications for each row
  execute function engineering_private.reject_engineering_history_mutation();

create table engineering_private.native_stop_validator_actors (
  executor_role name primary key check (executor_role='ovd576_stop_validator'),
  admitted_by uuid not null references auth.users(id),
  enabled boolean not null default false
);
alter table engineering_private.native_stop_validator_actors enable row level security;
revoke all on engineering_private.native_stop_validator_actors
  from public,anon,authenticated,service_role,ovd576_stop_validator;

create function engineering_private.admit_qualified_native_stop(
  p_worker uuid,p_credential text,p_boot uuid,p_task uuid,p_attempt uuid,
  p_evidence uuid,p_revision bigint,p_key uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor uuid; v_task public.engineering_tasks%rowtype;
  v_attempt public.engineering_execution_attempts%rowtype;
  v_worker public.engineering_workers%rowtype;
  v_evidence engineering_private.native_observer_evidence%rowtype;
  v_qualification engineering_private.native_stop_qualifications%rowtype;
  v_stop engineering_private.native_stop_admissions%rowtype;
  v_now timestamptz; v_failure text; v_receipt jsonb;
begin
  -- SET ROLE is unavailable without explicit membership. This role has no
  -- service/API membership, login, table DML or owner-recovery entrypoint.
  if current_setting('role') <> 'ovd576_stop_validator' then
    raise exception using errcode='42501',message='Stop validator executor required.';
  end if;
  -- Reuse the established slot -> worker -> conversation -> task -> attempt
  -- order. The existing transition re-enters these same transaction locks.
  v_task := engineering_private.lock_native_task(p_worker,p_credential,p_task,false);
  select * into v_attempt from public.engineering_execution_attempts
    where id=p_attempt for update;
  -- Read mutable attribution only after the potentially blocking native locks.
  -- Hold it through insertion and transition so a concurrent disable cannot
  -- invalidate the actor between authorization and its recorded effect.
  select admitted_by into v_actor from engineering_private.native_stop_validator_actors
    where executor_role='ovd576_stop_validator' and enabled for share;
  if v_actor is null then
    raise exception using errcode='42501',message='Stop validator attribution unavailable.';
  end if;
  if v_attempt.id is null or v_attempt.task_id<>v_task.id
    or v_attempt.worker_id<>p_worker or v_attempt.boot_id is distinct from p_boot then
    raise exception using errcode='42501',message='Native attempt access denied.';
  end if;
  select * into v_worker from public.engineering_workers where id=p_worker;
  if v_worker.current_boot_id is distinct from p_boot
    or v_worker.revoked_at is not null then
    raise exception using errcode='42501',message='Current worker authority required.';
  end if;
  -- A revocation INSERT takes an FK key-share lock on its admission. Holding
  -- stronger locks here serializes that insertion with this trust decision.
  perform 1 from engineering_private.native_runtime_admissions
    where id=v_attempt.runtime_admission_id for update;
  if not found then
    raise exception using errcode='PT409',message='Native runtime admission missing.';
  end if;
  perform 1 from engineering_private.native_input_admissions
    where id=v_attempt.input_admission_id for update;
  if not found then
    raise exception using errcode='PT409',message='Native input admission missing.';
  end if;
  select * into v_evidence from engineering_private.native_observer_evidence
    where id=p_evidence;
  select * into v_qualification from engineering_private.native_stop_qualifications
    where evidence_id=p_evidence;
  if v_evidence.id is null or v_qualification.evidence_id is null
    or v_evidence.attempt_id<>v_attempt.id
    or v_qualification.qualified_by<>v_actor
    or v_qualification.attempt_id<>v_attempt.id
    or v_qualification.profile_id<>v_evidence.profile_id
    or v_qualification.runtime_admission_id<>v_attempt.runtime_admission_id
    or v_qualification.boot_id<>v_attempt.boot_id
    or v_qualification.fence<>v_attempt.fence
    or v_qualification.job_sha256<>v_attempt.job_sha256
    or v_qualification.context_sha256<>(v_attempt.job_text::jsonb->>'contextSha256')
    or v_qualification.manifest_sha256<>v_evidence.manifest_sha256
    or v_qualification.journal_sha256<>v_evidence.journal_sha256
    or v_evidence.task_id<>v_task.id
    or v_evidence.organization_id<>v_attempt.organization_id
    or v_evidence.project_id<>v_attempt.project_id
    or v_evidence.worker_id<>v_attempt.worker_id
    or v_evidence.installation_id<>v_attempt.installation_id
    or v_evidence.boot_id<>v_attempt.boot_id
    or v_evidence.session_id<>v_attempt.session_id
    or v_evidence.runtime_admission_id<>v_attempt.runtime_admission_id
    or v_evidence.fence<>v_attempt.fence
    or v_evidence.job_id::text is distinct from (v_attempt.job_text::jsonb->>'jobId')
    or v_evidence.job_sha256<>v_attempt.job_sha256
    or v_evidence.context_sha256<>(v_attempt.job_text::jsonb->>'contextSha256')
    or v_evidence.verdict<>'complete_in_job_envelope'
    or v_evidence.observer_schema<>'overdrafter.native-stop-observer.v1'
    or v_evidence.boundary<>'trusted-user-direct-createprocess-job-v1'
    or v_evidence.observed_at< v_attempt.claimed_at
    or v_evidence.observed_at>=v_attempt.deadline_at
    or exists (select 1 from engineering_private.native_admission_revocations
      where runtime_admission_id=v_attempt.runtime_admission_id
        or input_admission_id=v_attempt.input_admission_id) then
    raise exception using errcode='PT409',message='Exact qualified stop evidence required.';
  end if;
  v_now := clock_timestamp();
  if v_evidence.observed_at>v_now then
    raise exception using errcode='PT409',message='Future stop evidence denied.';
  end if;
  -- A historical replay must retain the original admission and idempotency
  -- identity. It cannot create a second admission or release another slot.
  select * into v_stop from engineering_private.native_stop_admissions
    where id=p_evidence;
  if v_stop.id is not null then
    if v_stop.attempt_id<>v_attempt.id or v_stop.evidence_sha256<>v_evidence.manifest_sha256
      or v_stop.journal_sha256<>v_evidence.journal_sha256
      or v_stop.admitted_by<>v_actor
      or v_attempt.stop_admission_id is distinct from v_stop.id then
      raise exception using errcode='PT409',message='Stop replay identity differs.';
    end if;
    return engineering_private.record_native_stop(
      p_worker,p_credential,p_boot,p_task,p_attempt,p_evidence,p_revision,p_key,false);
  end if;
  if v_attempt.revision<>p_revision or v_attempt.stopped_at is not null
    or not exists (select 1 from engineering_private.native_slots
      where organization_id=v_attempt.organization_id and active_attempt_id=v_attempt.id) then
    raise exception using errcode='PT409',message='Native attempt or slot is stale.';
  end if;
  v_failure := convert_from(v_evidence.manifest_bytes,'UTF8')::jsonb->>'failureCode';
  if (v_evidence.execution_outcome='native_exit_succeeded' and v_failure is not null)
    or (v_evidence.execution_outcome='native_failed'
      and (v_failure is null or v_failure not in ('native_startup_timeout','input_invalid','runtime_mismatch',
        'native_operation_failed','artifact_invalid','deadline_exceeded',
        'authority_lost','process_uncertain','unclassified'))) then
    raise exception using errcode='PT409',message='Unsupported native failure evidence.';
  end if;
  insert into engineering_private.native_stop_admissions (
    id,attempt_id,organization_id,project_id,worker_id,installation_id,
    boot_id,session_id,runtime_admission_id,fence,job_sha256,context_sha256,
    journal_sha256,evidence_sha256,verdict,authority,terminal_processes,
    execution_outcome,failure_code,failure_policy_version,validator_version,
    stopped_at,observed_at,admitted_by
  ) values (
    v_evidence.id,v_attempt.id,v_attempt.organization_id,v_attempt.project_id,
    v_attempt.worker_id,v_attempt.installation_id,v_attempt.boot_id,
    v_attempt.session_id,v_attempt.runtime_admission_id,v_attempt.fence,
    v_attempt.job_sha256,v_evidence.context_sha256,v_evidence.journal_sha256,
    v_evidence.manifest_sha256,'all_owned_processes_exited',
    'qualified_worker_validator',v_evidence.terminal_processes,
    v_evidence.execution_outcome,v_failure,'prepared-native-failure-v1',
    'ovd576-stop-validator/1',v_evidence.observed_at,v_evidence.observed_at,v_actor
  );
  -- An exception in the established transition aborts this insertion too.
  v_receipt := engineering_private.record_native_stop(
    p_worker,p_credential,p_boot,p_task,p_attempt,p_evidence,p_revision,p_key,false);
  return v_receipt;
end;
$$;
revoke all on function engineering_private.admit_qualified_native_stop(
  uuid,text,uuid,uuid,uuid,uuid,bigint,uuid)
  from public,anon,authenticated,service_role;
grant execute on function engineering_private.admit_qualified_native_stop(
  uuid,text,uuid,uuid,uuid,uuid,bigint,uuid)
  to ovd576_stop_validator;
