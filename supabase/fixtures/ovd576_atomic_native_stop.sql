-- Appended to the committed OVD-501 synthetic claim fixture by the OVD-576
-- disposable replay lane. The outer transaction rolls back all rows.
select is((select count(*) from engineering_private.native_stop_qualifications),0::bigint,
  'migration seeds no prepared/native qualification');
select is((select count(*) from engineering_private.native_stop_validator_actors),0::bigint,
  'migration seeds no stop actor');
select is((select rolcanlogin::text||','||rolinherit::text from pg_roles
  where rolname='ovd576_stop_validator'),'false,false','stop executor is NOLOGIN NOINHERIT');
select ok(not pg_has_role('service_role','ovd576_stop_validator','member'),
  'service role cannot select stop executor');
select ok(not pg_has_role('anon','ovd576_stop_validator','member')
  and not pg_has_role('authenticated','ovd576_stop_validator','member'),
  'API principals cannot select stop executor');
select ok(not has_function_privilege('service_role',
  'engineering_private.admit_qualified_native_stop(uuid,text,uuid,uuid,uuid,uuid,bigint,uuid)','EXECUTE'),
  'service role has no atomic stop function grant');
select ok(not has_function_privilege('anon',
  'engineering_private.admit_qualified_native_stop(uuid,text,uuid,uuid,uuid,uuid,bigint,uuid)','EXECUTE')
  and not has_function_privilege('authenticated',
  'engineering_private.admit_qualified_native_stop(uuid,text,uuid,uuid,uuid,uuid,bigint,uuid)','EXECUTE'),
  'anon and authenticated have no atomic stop function grant');
select ok(not has_function_privilege('ovd576_stop_validator',
  'public.api_reconcile_native_stop(uuid,uuid,uuid,uuid,uuid,bigint,uuid)','EXECUTE'),
  'stop executor has no owner recovery gateway');
select ok(not has_table_privilege('ovd576_stop_validator',
  'engineering_private.native_stop_admissions','INSERT'),
  'stop executor cannot directly insert admissions');
select ok(not has_table_privilege('ovd576_stop_validator',
  'engineering_private.native_stop_qualifications','INSERT'),
  'stop executor cannot forge qualification');
select ok((select relrowsecurity from pg_class
  where oid='engineering_private.native_stop_qualifications'::regclass),
  'qualification table uses RLS');

-- A second synthetic tenant gives the access test a real foreign task.
insert into public.engineering_snapshots(id,organization_id,project_id,context_text)
select pg_temp.n(21),pg_temp.n(5),pg_temp.n(8),
  jsonb_set(jsonb_set(jsonb_set(jsonb_set(context_text::jsonb,
    '{scope,organizationId}',to_jsonb(pg_temp.n(5))),
    '{scope,projectId}',to_jsonb(pg_temp.n(8))),
    '{snapshotId}',to_jsonb(pg_temp.n(21))),
    '{seedSnapshotId}',to_jsonb(pg_temp.n(21)))::text
  from public.engineering_snapshots where id=pg_temp.n(20);
set local role authenticated;
select set_config('request.jwt.claim.sub',pg_temp.n(2)::text,true);
select public.api_submit_engineering_message(pg_temp.n(5),pg_temp.n(8),
  pg_temp.n(33),pg_temp.n(21),0,pg_temp.n(103),'Depth 8 mm');
reset role;
select public.api_resolve_engineering_request(r.id,0,pg_temp.n(104),
  'prepared_change',8,'Foreign tenant fixture',
  jsonb_build_object('model','fixture','promptVersion','v1',
    'schemaVersion','overdrafter.prepared-interpretation.v1',
    'policyVersion','prepared-depth-v1',
    'inputSha256',encode(extensions.digest(m.body,'sha256'),'hex'),
    'contextSha256',s.context_sha256))
  from public.engineering_requests r
  join public.engineering_messages m on m.id=r.message_id
  join public.engineering_snapshots s on s.id=r.input_snapshot_id
  where r.conversation_id=pg_temp.n(33);
select ok(pg_temp.task(1,33) is not null,'foreign tenant task exists');

-- Fixture owner supplies an OVD-575-shaped immutable observation. This bypasses
-- OVD-575 ingestion only to isolate the OVD-576 trust transition; the OVD-575
-- fixture separately proves byte/journal validation. It is not native proof.
-- OVD576_RACE_SEED_BEGIN
insert into engineering_private.native_observer_profiles (
  id,runtime_admission_id,observer_schema,observer_version,boundary,
  profile_version,observer_source_sha256,qualification_sha256,
  native_qualification,stop_admission,admitted_by
) values (
  pg_temp.n(90),pg_temp.n(60),'overdrafter.native-stop-observer.v1',
  'windows-job-observer/1','trusted-user-direct-createprocess-job-v1',
  'observer-ingest-v1',pg_temp.h(90),pg_temp.h(91),false,false,pg_temp.n(1)
);
insert into engineering_private.native_observer_evidence (
  id,profile_id,runtime_admission_id,observer_run_id,attempt_id,task_id,
  organization_id,project_id,worker_id,installation_id,boot_id,session_id,
  fence,job_id,job_sha256,context_sha256,manifest_bytes,manifest_sha256,
  journal_bytes,journal_sha256,journal_head_sha256,observer_schema,
  observer_version,boundary,profile_version,verdict,terminal_processes,
  execution_outcome,observed_at,validator_version,admitted_by
) select pg_temp.n(91),pg_temp.n(90),a.runtime_admission_id,pg_temp.n(92),
  a.id,a.task_id,a.organization_id,a.project_id,a.worker_id,a.installation_id,
  a.boot_id,a.session_id,a.fence,(a.job_text::jsonb->>'jobId')::uuid,
  a.job_sha256,a.job_text::jsonb->>'contextSha256',
  convert_to('{"failureCode":null}','UTF8'),
  encode(extensions.digest(convert_to('{"failureCode":null}','UTF8'),'sha256'),'hex'),
  convert_to('{}','UTF8'),
  encode(extensions.digest(convert_to('{}','UTF8'),'sha256'),'hex'),
  pg_temp.h(92),'overdrafter.native-stop-observer.v1','windows-job-observer/1',
  'trusted-user-direct-createprocess-job-v1','observer-ingest-v1',
  'complete_in_job_envelope','[{"fixtureOnly":true}]'::jsonb,
  'native_exit_succeeded',clock_timestamp(),'observer-registry-validator/1',pg_temp.n(1)
  from public.engineering_execution_attempts a where a.id=pg_temp.attempt();
insert into engineering_private.native_stop_validator_actors
  (executor_role,admitted_by,enabled)
  values('ovd576_stop_validator',pg_temp.n(1),true);
-- OVD576_RACE_SEED_END
-- An owner-forged second evidence row demonstrates why evidence ID and the
-- attempt tuple must be one composite reference, not independent FKs.
savepoint ovd576_cross_evidence;
insert into public.engineering_execution_attempts (
  id,task_id,conversation_id,organization_id,project_id,owner_user_id,
  worker_id,installation_id,boot_id,session_id,runtime_admission_id,
  input_admission_id,input_snapshot_id,output_snapshot_id,fence,job_text,
  claimed_at,deadline_at,lease_expires_at
) select pg_temp.n(95),pg_temp.task(1,31),pg_temp.n(31),organization_id,
  project_id,owner_user_id,worker_id,installation_id,boot_id,session_id,
  runtime_admission_id,input_admission_id,input_snapshot_id,output_snapshot_id,
  999,job_text,claimed_at,deadline_at,lease_expires_at
  from public.engineering_execution_attempts where id=pg_temp.attempt();
insert into engineering_private.native_observer_evidence (
  id,profile_id,runtime_admission_id,observer_run_id,attempt_id,task_id,
  organization_id,project_id,worker_id,installation_id,boot_id,session_id,
  fence,job_id,job_sha256,context_sha256,manifest_bytes,manifest_sha256,
  journal_bytes,journal_sha256,journal_head_sha256,observer_schema,
  observer_version,boundary,profile_version,verdict,terminal_processes,
  execution_outcome,observed_at,validator_version,admitted_by
) select pg_temp.n(96),profile_id,runtime_admission_id,pg_temp.n(97),
  pg_temp.n(95),pg_temp.task(1,31),organization_id,project_id,worker_id,
  installation_id,boot_id,session_id,999,job_id,job_sha256,context_sha256,
  manifest_bytes,manifest_sha256,journal_bytes,journal_sha256,
  journal_head_sha256,observer_schema,observer_version,boundary,
  profile_version,verdict,terminal_processes,execution_outcome,
  observed_at,validator_version,admitted_by
  from engineering_private.native_observer_evidence where id=pg_temp.n(91);
select throws_ok($$insert into engineering_private.native_stop_qualifications (
  evidence_id,attempt_id,profile_id,runtime_admission_id,boot_id,fence,
  job_sha256,context_sha256,manifest_sha256,journal_sha256,
  qualification_sha256,scope,qualified_by
) select pg_temp.n(91),e.attempt_id,e.profile_id,e.runtime_admission_id,
  e.boot_id,e.fence,e.job_sha256,e.context_sha256,e.manifest_sha256,
  e.journal_sha256,pg_temp.h(93),'prepared_native_exact_attempt_v1',pg_temp.n(1)
  from engineering_private.native_observer_evidence e where e.id=pg_temp.n(96)$$,
  '23503',null,'evidence A cannot borrow evidence B attempt tuple');
rollback to savepoint ovd576_cross_evidence;
grant ovd576_stop_validator to postgres with set true;
-- Only the disposable fixture grants pgTAP visibility to this executor.
grant usage on schema extensions to ovd576_stop_validator;
create function pg_temp.admit(r bigint,k integer,e integer default 91,
  b integer default 52,t uuid default pg_temp.task())
returns jsonb language sql security invoker as $$
  select engineering_private.admit_qualified_native_stop(
    pg_temp.n(50),pg_temp.h(9),pg_temp.n(b),t,pg_temp.attempt(),pg_temp.n(e),r,pg_temp.n(k));
$$;
create function pg_temp.other_attempt() returns uuid language sql security definer as $$
  select current_attempt_id from public.engineering_task_execution
  where task_id=pg_temp.task(1,31);
$$;
set local role ovd576_stop_validator;
select throws_ok($$select pg_temp.admit(1,220)$$,'PT409',null,
  'observer completion alone is unqualified and cannot release occupancy');
select throws_ok($$insert into engineering_private.native_stop_admissions(id) values(gen_random_uuid())$$,
  '42501',null,'validator cannot directly forge stop history');
reset role;
select is((select active_attempt_id from engineering_private.native_slots
  where organization_id=pg_temp.n(4)),pg_temp.attempt(),
  'unqualified evidence leaves exact slot occupied');

-- A matching qualification must be a separate, immutable owner decision.
savepoint ovd576_bad_qualification;
insert into engineering_private.native_stop_qualifications (
  evidence_id,attempt_id,profile_id,runtime_admission_id,boot_id,fence,
  job_sha256,context_sha256,manifest_sha256,journal_sha256,
  qualification_sha256,scope,qualified_by
) select e.id,e.attempt_id,e.profile_id,e.runtime_admission_id,e.boot_id,e.fence,
  pg_temp.h(99),e.context_sha256,e.manifest_sha256,e.journal_sha256,
  pg_temp.h(93),'prepared_native_exact_attempt_v1',pg_temp.n(1)
  from engineering_private.native_observer_evidence e where e.id=pg_temp.n(91);
set local role ovd576_stop_validator;
select throws_ok($$select pg_temp.admit(1,220)$$,'PT409',null,
  'poisoned qualification cannot promote observation');
rollback to savepoint ovd576_bad_qualification;
-- OVD576_RACE_QUAL_BEGIN
insert into engineering_private.native_stop_qualifications (
  evidence_id,attempt_id,profile_id,runtime_admission_id,boot_id,fence,
  job_sha256,context_sha256,manifest_sha256,journal_sha256,
  qualification_sha256,scope,qualified_by
) select e.id,e.attempt_id,e.profile_id,e.runtime_admission_id,e.boot_id,e.fence,
  e.job_sha256,e.context_sha256,e.manifest_sha256,e.journal_sha256,
  pg_temp.h(93),'prepared_native_exact_attempt_v1',pg_temp.n(1)
  from engineering_private.native_observer_evidence e where e.id=pg_temp.n(91);
-- OVD576_RACE_QUAL_END
select throws_ok($$update engineering_private.native_stop_qualifications
  set qualification_sha256=pg_temp.h(94) where evidence_id=pg_temp.n(91)$$,
  '55000',null,'qualification history is immutable');
set local role ovd576_stop_validator;
select throws_ok($$select pg_temp.admit(1,220,92)$$,'PT409',null,
  'substituted evidence ID denied');
select throws_ok($$select pg_temp.admit(1,220,91,53)$$,'42501',null,
  'foreign boot denied');
select throws_ok($$select pg_temp.admit(1,220,91,52,pg_temp.task(1,33))$$,'42501',null,
  'cross-tenant task denied before evidence admission');
reset role;
savepoint ovd576_revocation;
insert into engineering_private.native_admission_revocations
  (runtime_admission_id,revoked_by,reason)
  values(pg_temp.n(60),pg_temp.n(1),'Synthetic revocation');
set local role ovd576_stop_validator;
select throws_ok($$select pg_temp.admit(1,220)$$,'PT409',null,
  'revoked runtime cannot admit observed stop');
rollback to savepoint ovd576_revocation;
savepoint ovd576_worker_revocation;
update public.engineering_workers set revoked_at=clock_timestamp(),revision=revision+1
  where id=pg_temp.n(50);
set local role ovd576_stop_validator;
select throws_ok($$select pg_temp.admit(1,220)$$,'42501',null,
  'revoked worker cannot invoke ordinary stop path');
rollback to savepoint ovd576_worker_revocation;

-- Observation preceded a subsequent loss of result authority. Physical stop
-- may release occupancy while result eligibility remains false.
update public.engineering_execution_attempts
  set revision=revision+1,phase='recovery_required',result_eligible=false,
    failure_code='authority_lost',failure_policy_version='prepared-native-failure-v1'
  where id=pg_temp.attempt();
set local role ovd576_stop_validator;
select throws_ok($$select pg_temp.admit(1,220)$$,'PT409',null,
  'stale revision cannot create admission');
select throws_ok($$select pg_temp.admit(2,200)$$,'PT409',null,
  'existing claim idempotency key rejects transition after inserted admission');
reset role;
select is((select count(*) from engineering_private.native_stop_admissions
  where id=pg_temp.n(91)),0::bigint,'failed transition rolled back stop admission');
select is((select active_attempt_id from engineering_private.native_slots
  where organization_id=pg_temp.n(4)),pg_temp.attempt(),
  'failed transition did not release occupancy');
set local role ovd576_stop_validator;
select is(pg_temp.admit(2,220)->>'outcome','process_stopped',
  'qualified exact evidence atomically stops its attempt');
select is(pg_temp.admit(2,220)->>'outcome','process_stopped',
  'lost reply replays immutable receipt after occupancy is released');
select throws_ok($$select pg_temp.admit(2,221)$$,'PT409',null,
  'changed replay key cannot consume historical stop');
reset role;
select is((select count(*) from engineering_private.native_stop_admissions
  where id=pg_temp.n(91)),1::bigint,'duplicate calls create exactly one admission');
select is((select count(*) from engineering_private.native_attempt_events
  where task_id=pg_temp.task() and kind='stopped'),1::bigint,
  'duplicate calls create exactly one stop transition');
select is((select active_attempt_id from engineering_private.native_slots
  where organization_id=pg_temp.n(4)),null::uuid,'only the exact slot is released');
select ok((select not result_eligible from public.engineering_execution_attempts
  where id=pg_temp.attempt()),'stop does not grant result eligibility');
select is((select verification_state from public.engineering_tasks
  where id=pg_temp.task()),'unverified','stop does not verify CAD output');
set local role service_role;
select is(pg_temp.claim(1,31,230)->>'outcome','claimed',
  'new independent task claims a higher fence after physical release');
reset role;
set local role ovd576_stop_validator;
select throws_ok($$select engineering_private.admit_qualified_native_stop(
  pg_temp.n(50),pg_temp.h(9),pg_temp.n(52),pg_temp.task(1,31),
  pg_temp.other_attempt(),pg_temp.n(91),0,pg_temp.n(231))$$,
  'PT409',null,'old evidence and fence cannot stop a newer attempt');
select is(pg_temp.admit(2,220)->>'outcome','process_stopped',
  'old exact replay returns history while a newer attempt occupies the slot');
reset role;
select is((select active_attempt_id from engineering_private.native_slots
  where organization_id=pg_temp.n(4)),
  (select current_attempt_id from public.engineering_task_execution
   where task_id=pg_temp.task(1,31)),
  'old replay cannot release the newer attempt');
select * from finish();
rollback;
