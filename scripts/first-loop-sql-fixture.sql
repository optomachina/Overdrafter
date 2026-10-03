-- The maintained ownership fixture supplied the real authenticated request,
-- owner enablement, admissions and claim helper. No authority predicate stub.
set local role service_role;
select is(pg_temp.claim()->>'outcome','claimed','first-loop real claim succeeds');
reset role;
create temporary table first_loop_packet(manifest bytea,journal bytea,evidence uuid);
create function pg_temp.first_loop_evidence() returns uuid language sql security definer as $$
 select evidence from pg_temp.first_loop_packet;
$$;
do $rebase$
declare a public.engineering_execution_attempts%rowtype;
 m jsonb:=@@MANIFEST@@; j jsonb:=@@JOURNAL@@;
 binding jsonb; binding_hash text; prior text; rec jsonb; records jsonb:='[]';
 stamp text; ticks text; process jsonb; processes jsonb:='[]'; terminals jsonb:='[]';
 journal_bytes bytea;
begin
 select * into strict a from public.engineering_execution_attempts where id=pg_temp.attempt();
 -- Millisecond precision is checked against the microsecond claim.
 -- All synthetic observations share this timestamp; no physical process claim.
 stamp:=to_char(date_trunc('milliseconds',clock_timestamp()) at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
 if stamp::timestamptz<a.claimed_at then raise exception 'fixture_clock_precision_retry_required'; end if;
 ticks:=(extract(epoch from stamp::timestamptz)*10000000+621355968000000000)::numeric(20,0)::text;
 binding:=jsonb_build_object('attemptId',a.id,'bootId',a.boot_id,'fence',a.fence,
  'installationId',a.installation_id,'jobId',a.job_text::jsonb->>'jobId','jobSha256',a.job_sha256,
  'organizationId',a.organization_id,'projectId',a.project_id,'runtimeAdmissionId',a.runtime_admission_id,
  'taskId',a.task_id,'workerId',a.worker_id);
 binding_hash:=encode(extensions.digest(engineering_private.native_observer_canonical_json(binding),'sha256'),'hex');
 prior:=binding_hash;
 for rec in select value from jsonb_array_elements(j->'records') loop
  rec:=(rec-'sha256')||jsonb_build_object('at',stamp,'bindingSha256',binding_hash,'previousSha256',prior);
  if rec->'data' ? 'creationTicks' then rec:=jsonb_set(rec,'{data,creationTicks}',to_jsonb(ticks)); end if;
  prior:=encode(extensions.digest(engineering_private.native_observer_canonical_json(rec),'sha256'),'hex');
  records:=records||jsonb_build_array(rec||jsonb_build_object('sha256',prior));
 end loop;
 j:=j||jsonb_build_object('binding',binding,'records',records,'headSha256',prior);
 journal_bytes:=convert_to(engineering_private.native_observer_canonical_json(j),'UTF8');
 for process in select value from jsonb_array_elements(m->'observedProcesses') loop
  process:=jsonb_set(process,'{identity,creationTicks}',to_jsonb(ticks))||jsonb_build_object('observedAt',stamp,'exitedAt',stamp);
  processes:=processes||jsonb_build_array(process);
 end loop;
 for process in select value from jsonb_array_elements(m->'terminalProcesses') loop
  terminals:=terminals||jsonb_build_array(process||jsonb_build_object('creationTicks',ticks));
 end loop;
 m:=m||jsonb_build_object('binding',binding,'contextSha256',a.job_text::jsonb->>'contextSha256',
  'deadline',to_char(a.deadline_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'startedAt',stamp,'observedAt',stamp,'observerRunId',pg_temp.n(92),
  'journalHeadSha256',prior,'journalSha256',encode(extensions.digest(journal_bytes,'sha256'),'hex'),
  'observedProcesses',processes,'terminalProcesses',terminals,
  'root',jsonb_set(m->'root','{identity,creationTicks}',to_jsonb(ticks))||jsonb_build_object('observedAt',stamp,'exitedAt',stamp));
 insert into pg_temp.first_loop_packet values(convert_to(engineering_private.native_observer_canonical_json(m),'UTF8'),journal_bytes,null);
end;
$rebase$;
insert into engineering_private.native_observer_profiles(id,runtime_admission_id,observer_schema,observer_version,boundary,
 profile_version,observer_source_sha256,qualification_sha256,native_qualification,stop_admission,admitted_by)
values(pg_temp.n(90),pg_temp.n(60),'overdrafter.native-stop-observer.v1','windows-job-observer/1',
 'trusted-user-direct-createprocess-job-v1','observer-ingest-v1',pg_temp.h(90),pg_temp.h(91),false,false,pg_temp.n(1));
insert into engineering_private.native_observer_validator_actors(executor_role,admitted_by,enabled)
 values('ovd575_observer_validator',pg_temp.n(1),true);
-- postgres is the disposable database owner; no grants/memberships are added.
-- Existing restricted-role SET capability is an operator prerequisite.
select set_config('first_loop.manifest',encode(manifest,'hex'),true),
 set_config('first_loop.journal',encode(journal,'hex'),true) from pg_temp.first_loop_packet;
set local role ovd575_observer_validator;
select set_config('first_loop.evidence',engineering_private.store_native_observer_evidence(pg_temp.n(90),
 decode(current_setting('first_loop.manifest'),'hex'),decode(current_setting('first_loop.journal'),'hex'))::text,true);
reset role;
update pg_temp.first_loop_packet set evidence=current_setting('first_loop.evidence')::uuid;
select ok(pg_temp.first_loop_evidence() is not null,'real observer ingest retained canonical journal');
insert into engineering_private.native_stop_validator_actors(executor_role,admitted_by,enabled)
 values('ovd576_stop_validator',pg_temp.n(1),true);
-- Independent SYNTHETIC owner decision, not a native qualification claim.
insert into engineering_private.native_stop_qualifications(evidence_id,attempt_id,profile_id,runtime_admission_id,boot_id,fence,
 job_sha256,context_sha256,manifest_sha256,journal_sha256,qualification_sha256,scope,qualified_by)
select id,attempt_id,profile_id,runtime_admission_id,boot_id,fence,job_sha256,context_sha256,manifest_sha256,journal_sha256,
 pg_temp.h(93),'prepared_native_exact_attempt_v1',pg_temp.n(1)
from engineering_private.native_observer_evidence where id=pg_temp.first_loop_evidence();
-- Freeze arguments under owner before restricted role; no new table visibility.
select set_config('first_loop.synthetic_credential',pg_temp.h(9),true);
select set_config('first_loop.stop_args',jsonb_build_object('task',task_id,'attempt',id,'fence',fence,'revision',revision)::text,true)
from public.engineering_execution_attempts where id=pg_temp.attempt();
set local role ovd576_stop_validator;
select set_config('first_loop.stop_receipt',engineering_private.admit_qualified_native_stop(
 pg_temp.n(50),current_setting('first_loop.synthetic_credential'),pg_temp.n(52),(current_setting('first_loop.stop_args')::jsonb->>'task')::uuid,
 (current_setting('first_loop.stop_args')::jsonb->>'attempt')::uuid,
 (current_setting('first_loop.stop_args')::jsonb->>'fence')::bigint,pg_temp.first_loop_evidence(),
 (current_setting('first_loop.stop_args')::jsonb->>'revision')::bigint,pg_temp.n(220))::text,true);
reset role;
select is(current_setting('first_loop.stop_receipt')::jsonb->>'outcome','process_stopped','real qualified stop succeeds');
select ok((select phase='awaiting_result' and result_eligible and stop_admission_id is not null
 from public.engineering_execution_attempts where id=pg_temp.attempt()),'stop preserves exact result authority');
@@POSTSTOP@@
-- Metadata only: there are no stored bytes and no storage-service requests.
insert into storage.buckets(id,name,public) values('first-loop-synthetic','first-loop-synthetic',false);
insert into storage.objects(bucket_id,name,version)
select 'first-loop-synthetic',role,'synthetic-v1' from unnest(array['assembly','target','companion','result','identity','preservation','native']) role;
select ok(engineering_private.register_native_result_object(a.organization_id,a.project_id,a.task_id,a.id,a.fence,
 a.input_snapshot_id,a.output_snapshot_id,obj.name,obj.bucket_id,obj.name,obj.id,obj.version,obj.updated_at,100,pg_temp.h(30)),
 'real registry accepts synthetic metadata: '||obj.name)
from public.engineering_execution_attempts a cross join storage.objects obj
where a.id=pg_temp.attempt() and obj.bucket_id='first-loop-synthetic';
select is((select count(*) from engineering_private.native_verifier_registered_objects where attempt_id=pg_temp.attempt()),7::bigint,
 'all seven actual registry rows retained');
select jsonb_build_object('syntheticOnly',true,'taskId',pg_temp.task(),'attemptId',pg_temp.attempt(),
 'evidenceId',pg_temp.first_loop_evidence(),'stopReceipt',current_setting('first_loop.stop_receipt')::jsonb) as first_loop_fixture_ids;
@@READER@@
