-- Uses successful synthetic stopped attempt from the existing ownership fixture.
insert into engineering_private.native_receipt_key values(true,extensions.gen_random_bytes(32));
insert into storage.buckets(id,name,public) values('ovd561-synthetic','ovd561-synthetic',false);
insert into storage.objects(bucket_id,name,version)
select 'ovd561-synthetic',role,'original' from unnest(array['assembly','target','companion','result','identity','preservation','native']) role;
select engineering_private.register_native_result_object(a.organization_id,a.project_id,a.task_id,a.id,
 a.fence,a.input_snapshot_id,a.output_snapshot_id,obj.name,obj.bucket_id,obj.name,obj.id,obj.version,obj.updated_at,100,pg_temp.h(30))
from public.engineering_execution_attempts a cross join storage.objects obj
where a.id=pg_temp.other_attempt() and obj.bucket_id='ovd561-synthetic';
-- Create an accepted successor through real intake/interpretation APIs.
set local role authenticated;
select set_config('request.jwt.claim.sub',pg_temp.n(1)::text,true);
select public.api_submit_engineering_message(pg_temp.n(4),pg_temp.n(7),pg_temp.n(31),pg_temp.n(20),1,pg_temp.n(990),'Depth 9 mm');
reset role;
select public.api_resolve_engineering_request(r.id,1,pg_temp.n(991),'prepared_change',9,'Next synthetic change',
 jsonb_build_object('model','fixture','promptVersion','v1','schemaVersion','overdrafter.prepared-interpretation.v1',
 'policyVersion','prepared-depth-v1','inputSha256',encode(extensions.digest(m.body,'sha256'),'hex'),'contextSha256',s.context_sha256))
from public.engineering_requests r join public.engineering_messages m on m.id=r.message_id
join public.engineering_snapshots s on s.id=r.input_snapshot_id where r.conversation_id=pg_temp.n(31) and r.receipt_revision=2;
create function pg_temp.candidate() returns text language sql as $body$
 select (s.context_text::jsonb || jsonb_build_object('snapshotId',a.output_snapshot_id,'sequence',a.job_text::jsonb->'sequence',
 'depthMm',a.job_text::jsonb->'depthMm','producer',jsonb_build_object('attemptId',a.id,'fence',a.fence,
 'inputSnapshotId',a.input_snapshot_id,'inputContextSha256',s.context_sha256,'requestSha256',a.job_sha256,
 'resultSha256',pg_temp.h(30))))::text
 from public.engineering_execution_attempts a join public.engineering_snapshots s on s.id=a.input_snapshot_id
 where a.id=pg_temp.other_attempt();
$body$;
create temporary table ovd561_request(payload text,context text,signature text,replay_key uuid);
insert into ovd561_request(payload,context,replay_key)
select jsonb_build_object('schema','overdrafter.native-verification-receipt.v2','taskId',a.task_id,
 'attemptId',a.id,'fence',a.fence,'organizationId',a.organization_id,'projectId',a.project_id,
 'inputSnapshotId',a.input_snapshot_id,'candidateSnapshotId',a.output_snapshot_id,
 'contextSha256',s.context_sha256,'candidateContextSha256',encode(extensions.digest(pg_temp.candidate(),'sha256'),'hex'),
 'jobSha256',a.job_sha256,'resultSha256',pg_temp.h(30),'policy','prepared-native-reports-v2','issuedAt',clock_timestamp(),
 'objects',(select jsonb_agg(jsonb_build_object('role',r.artifact_role,'id',r.storage_object_id,'bytes',r.byte_length,'sha256',r.sha256) order by r.artifact_role)
 from engineering_private.native_verifier_registered_objects r where r.attempt_id=a.id))::text,pg_temp.candidate(),pg_temp.n(992)
from public.engineering_execution_attempts a join public.engineering_snapshots s on s.id=a.input_snapshot_id where a.id=pg_temp.other_attempt();
update ovd561_request set signature=encode(extensions.hmac(convert_to(payload,'UTF8'),
 (select key_bytes from engineering_private.native_receipt_key),'sha256'),'hex');
create function pg_temp.finish(patch jsonb default '{}'::jsonb, bad_context boolean default false,
 bad_signature boolean default false, new_key boolean default false) returns jsonb language plpgsql as $body$
declare r record; body text; sig text;
begin
 select * into r from ovd561_request;
 body := r.payload;
 if patch<>'{}'::jsonb then body := (body::jsonb||patch)::text; end if;
 sig := encode(extensions.hmac(convert_to(body,'UTF8'),(select key_bytes from engineering_private.native_receipt_key),'sha256'),'hex');
 if bad_signature then sig:=repeat('0',64); end if;
 return engineering_private.finalize_native_result(body,sig,
 case when bad_context then r.context||' ' else r.context end,
 case when new_key then pg_temp.n(993) else r.replay_key end);
end $body$;
select 'ovd561-proof-start';
select throws_ok($$select pg_temp.finish('{}',false,true)$$,'42501',null,'forged signature denied');
select throws_ok($$select pg_temp.finish('{}',true)$$,'42501',null,'changed candidate bytes denied');
select throws_ok($$select pg_temp.finish('{"schema":"overdrafter.native-verification-receipt.v1"}')$$,'42501',null,'old receipt version denied');
select throws_ok($$select pg_temp.finish('{"candidateContextSha256":null}')$$,'42501',null,'missing digest denied');
select throws_ok($$select pg_temp.finish('{"fence":1}')$$,'42501',null,'stale fence denied');
select throws_ok($$select pg_temp.finish(jsonb_build_object('taskId',pg_temp.task()))$$,'42501',null,'foreign task denied');
select throws_ok($$select pg_temp.finish('{"objects":[]}')$$,'42501',null,'incomplete registry denied');
select is((select count(*) from engineering_private.native_finalizations),0::bigint,'denials create no completion');
-- Throw on the final write, after snapshot/admission/task/successor mutations.
create function pg_temp.fail_finalization() returns trigger language plpgsql as $body$
begin raise exception 'injected final write failure' using errcode='P0001'; end $body$;
create trigger ovd561_inject_failure before insert on engineering_private.native_finalizations
for each row execute function pg_temp.fail_finalization();
select throws_ok($$select pg_temp.finish()$$,'P0001','injected final write failure','late failure rolls back transaction');
select ok(not exists(select 1 from public.engineering_snapshots where id=(select output_snapshot_id from public.engineering_execution_attempts where id=pg_temp.other_attempt())),'no partial snapshot');
select ok(not exists(select 1 from engineering_private.native_input_admissions where producer_attempt_id=pg_temp.other_attempt()),'no partial successor admission');
select is((select execution_state from public.engineering_tasks where id=pg_temp.task(1,31)),'running','no partial task completion');
select is((select execution_state from public.engineering_tasks where id=pg_temp.task(2,31)),'blocked','no early successor release');
drop trigger ovd561_inject_failure on engineering_private.native_finalizations;
select is(pg_temp.finish()->>'outcome','finalized','valid signed result finalizes');
select is(pg_temp.finish(),pg_temp.finish(),'exact replay returns original receipt');
select throws_ok($$select pg_temp.finish('{}',false,false,true)$$,'PT409',null,'changed idempotency key conflicts');
select is((select count(*) from engineering_private.native_finalizations),1::bigint,'one completion after replay');
select is((select execution_state from public.engineering_tasks where id=pg_temp.task(2,31)),'queued','only verified completion releases successor');
select is((select context_text from public.engineering_snapshots where id=(select output_snapshot_id from public.engineering_execution_attempts where id=pg_temp.other_attempt())),(select context from ovd561_request),'snapshot preserves exact verified context bytes');
select ok((select not result_eligible from public.engineering_execution_attempts where id=pg_temp.other_attempt()),'completed attempt cannot register more results');
select ok(not has_function_privilege('service_role','engineering_private.finalize_native_result(text,text,text,uuid)','EXECUTE'),'service role cannot finalize');
select ok(not has_function_privilege('engineering_native_verifier','engineering_private.finalize_native_result(text,text,text,uuid)','EXECUTE'),'verifier cannot finalize');
select ok(not has_table_privilege('engineering_native_verifier','engineering_private.native_receipt_key','SELECT'),'verifier cannot read signing key');
select ok(not has_table_privilege('service_role','engineering_private.native_receipt_key','INSERT, UPDATE, SELECT'),'gateway cannot provision or read key');
