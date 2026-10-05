-- Failed native attempt terminal proof: synthetic disposable SQL; not native, Windows or production evidence.
-- Runs after the OVD-561 and OVD-563 proofs in the same rolled-back transaction.
-- Entry state: task(1,31) finalized, task(2,31) queued behind the verified
-- candidate head, slot free. Keys and IDs n(1000)..n(1009) belong to this proof.
reset role;
create function pg_temp.ovd520_successor_admission() returns uuid language sql security definer set search_path = '' as $body$
  select input_admission_id from engineering_private.native_finalizations where attempt_id=pg_temp.other_attempt();
$body$;
-- The execution row is created lazily by the first claim, so an unclaimed task is at revision 0.
create function pg_temp.ovd520_revision(p_task uuid) returns bigint language sql security definer set search_path = '' as $body$
  select coalesce((select revision from public.engineering_task_execution where task_id=p_task),0);
$body$;
-- Hex SHA-256 of a text value, shared by the provenance and receipt hashes below.
create function pg_temp.ovd520_sha256_hex(p_text text) returns text language sql immutable set search_path = '' as $body$
  select encode(extensions.digest(p_text,'sha256'),'hex');
$body$;
create function pg_temp.ovd520_attempt(p_task uuid) returns uuid language sql security definer set search_path = '' as $body$
  select current_attempt_id from public.engineering_task_execution where task_id=p_task;
$body$;
-- Accept a third change before anything fails: resolution refuses once a
-- conversation holds a failed task.
set local role authenticated;
select pg_temp.set_review_jwt(pg_temp.n(1));
select public.api_submit_engineering_message(pg_temp.n(4),pg_temp.n(7),pg_temp.n(31),c.head_snapshot_id,c.revision,
  pg_temp.n(1001),'Depth 6 mm') from public.engineering_conversations c where c.id=pg_temp.n(31);
reset role;
-- The expected revision is the change queue's revision, not the receipt revision.
select public.api_resolve_engineering_request(r.id,q.revision,pg_temp.n(1002),'prepared_change',6,'Third synthetic change',
  jsonb_build_object('model','fixture','promptVersion','v1','schemaVersion','overdrafter.prepared-interpretation.v1',
  'policyVersion','prepared-depth-v1','inputSha256',pg_temp.ovd520_sha256_hex(m.body),'contextSha256',s.context_sha256))
from public.engineering_requests r join public.engineering_messages m on m.id=r.message_id
join public.engineering_snapshots s on s.id=r.input_snapshot_id
join public.engineering_change_queues q on q.conversation_id=r.conversation_id
where r.conversation_id=pg_temp.n(31) and r.receipt_revision=3;
-- Builds a correctly signed v2 receipt for the failed attempt with every
-- identity field exact, so only the finalization state guards can deny it.
create function pg_temp.ovd520_finalize_failed() returns jsonb language plpgsql as $body$
declare a public.engineering_execution_attempts%rowtype; ctx text; body text; sig text; input_sha text;
begin
  select * into a from public.engineering_execution_attempts where id=pg_temp.ovd520_attempt(pg_temp.task(2,31));
  select context_sha256 into input_sha from public.engineering_snapshots where id=a.input_snapshot_id;
  select (s.context_text::jsonb || jsonb_build_object('snapshotId',a.output_snapshot_id,'sequence',a.job_text::jsonb->'sequence',
    'depthMm',a.job_text::jsonb->'depthMm','producer',jsonb_build_object('attemptId',a.id,'fence',a.fence,
    'inputSnapshotId',a.input_snapshot_id,'inputContextSha256',input_sha,'requestSha256',a.job_sha256,
    'resultSha256',pg_temp.h(30))))::text into ctx
  from public.engineering_snapshots s where s.id=a.input_snapshot_id;
  body := jsonb_build_object('schema','overdrafter.native-verification-receipt.v2','taskId',a.task_id,
    'attemptId',a.id,'fence',a.fence,'organizationId',a.organization_id,'projectId',a.project_id,
    'inputSnapshotId',a.input_snapshot_id,'candidateSnapshotId',a.output_snapshot_id,'contextSha256',input_sha,
    'candidateContextSha256',pg_temp.ovd520_sha256_hex(ctx),'jobSha256',a.job_sha256,
    'resultSha256',pg_temp.h(30),'policy','prepared-native-reports-v2','issuedAt',clock_timestamp(),
    'objects','[]'::jsonb)::text;
  sig := encode(extensions.hmac(convert_to(body,'UTF8'),
    (select key_bytes from engineering_private.native_receipt_key),'sha256'),'hex');
  return engineering_private.finalize_native_result(body,sig,ctx,pg_temp.n(1005));
end $body$;
select 'ovd520-proof-start';
set local role service_role;
select is((public.api_claim_native_task(pg_temp.n(50),pg_temp.h(9),pg_temp.n(52),pg_temp.task(2,31),pg_temp.n(60),
  pg_temp.ovd520_successor_admission(),pg_temp.ovd520_revision(pg_temp.task(2,31)),pg_temp.n(1003)))->>'outcome',
  'claimed','verified successor claims its exact candidate admission');
reset role;
select pg_temp.stop_fixture(1000,pg_temp.ovd520_attempt(pg_temp.task(2,31)),false,'native_operation_failed');
set local role service_role;
select is(public.api_record_native_stop(pg_temp.n(50),pg_temp.h(9),pg_temp.n(52),pg_temp.task(2,31),
  pg_temp.ovd520_attempt(pg_temp.task(2,31)),pg_temp.n(1000),0,pg_temp.n(1004))->>'phase',
  'failed','confirmed native operation failure ends the successor attempt');
reset role;
select throws_ok($$select engineering_private.register_native_result_object(a.organization_id,a.project_id,a.task_id,a.id,
  a.fence,a.input_snapshot_id,a.output_snapshot_id,'result',o.bucket_id,o.name,o.id,o.version,o.updated_at,100,pg_temp.h(31))
  from public.engineering_execution_attempts a cross join storage.objects o
  where a.id=pg_temp.ovd520_attempt(pg_temp.task(2,31)) and o.bucket_id='ovd561-synthetic' and o.name='result'$$,
  '42501','ovd560_stale_or_foreign_attempt','failed attempt cannot register result objects');
select throws_ok($$select pg_temp.ovd520_finalize_failed()$$,
  '42501','ovd561_stale_or_foreign_receipt','failed attempt cannot finalize');
select is((select count(*) from engineering_private.native_finalizations),1::bigint,'failure adds no finalization');
select is((select head_snapshot_id from public.engineering_conversations where id=pg_temp.n(31)),pg_temp.step_review_snapshot(),
  'failure never advances the candidate head');
-- The next three checks are state regression guards: task(3,31) stays blocked,
-- has one predecessor attempt and is refused for any non-succeeded predecessor,
-- so they do not by themselves discriminate the failure path.
select is((select execution_state from public.engineering_tasks where id=pg_temp.task(3,31)),'blocked',
  'failed predecessor keeps the third change blocked');
select is((select count(*) from public.engineering_execution_attempts where task_id=pg_temp.task(2,31)),1::bigint,
  'failure creates exactly one successor attempt');
set local role service_role;
select is((public.api_claim_native_task(pg_temp.n(50),pg_temp.h(9),pg_temp.n(52),pg_temp.task(3,31),pg_temp.n(60),
  pg_temp.ovd520_successor_admission(),pg_temp.ovd520_revision(pg_temp.task(3,31)),pg_temp.n(1006)))->>'reason',
  'verified_predecessor_required','third change cannot claim behind a failed predecessor');
-- Regression guard on the same not_verified branch the OVD-563 proof covers
-- for a queued successor; here the successor has failed instead.
set local role authenticated;
select pg_temp.set_review_jwt(pg_temp.n(1));
select is((public.api_read_native_step_review(pg_temp.n(31),pg_temp.task(2,31),pg_temp.step_review_snapshot()))->>'reason',
  'not_verified','failed change exposes no geometry');
reset role;
