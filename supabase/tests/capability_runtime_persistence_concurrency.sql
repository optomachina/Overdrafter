-- OVD-591 actual overlapping sessions; solely a disposable synthetic fixture.
-- Persistent helper objects are necessary for dblink sessions and removed at end.
create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
set search_path = public, extensions, pg_catalog;
set statement_timeout = '20s';
set timezone = 'UTC';
select no_plan();
create table private.ovd591_fixture_inputs(k text primary key,v jsonb);
insert into private.ovd591_fixture_inputs values ('claim',jsonb_build_object(
 'windowKey','canary:'||repeat('c',64),'resourceKey',repeat('d',64),'configDigest',repeat('a',64),
 'requestKey','00000000-0000-4000-8000-000000000091','provider','xometry','route','quote_home',
 'surface','account_quote_modal','surfaceRevision','ovd591.race',
 'windowStart',to_char(clock_timestamp()-interval '1 minute','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'windowEnd',to_char(clock_timestamp()+interval '10 minutes','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'leaseSeconds',300));
create function private.ovd591_fixture_call(operation text) returns jsonb language plpgsql set search_path=pg_catalog as $$
declare result jsonb;
begin
 if operation='allocate' then
   select public.api_claim_capability_window(v) into result from private.ovd591_fixture_inputs where k='next-claim';
 elsif operation='legacy-high' then
   perform public.api_record_capability_observation('xometry','provider_upload','quote_home','account_quote_modal','ovd591.race',
    'provider-upload-capability.v1','fresh',array['step'],array['application/step'],true,
    clock_timestamp()-interval '1 second',clock_timestamp()+interval '59 minutes',
    'worker','provider_surface','worker.v1','issue:OVD-591','ovd591:race:high',100);
   result := '{"status":"recorded","revision":100}'::jsonb;
 elsif operation='claim' then
   select public.api_claim_capability_window(v) into result from private.ovd591_fixture_inputs where k='claim';
 elsif operation='expire' then
   select public.api_complete_capability_window(v) into result from private.ovd591_fixture_inputs where k='expired-completion';
 elsif operation='complete' then
   select public.api_complete_capability_window(v) into result from private.ovd591_fixture_inputs where k='completion';
 elsif operation='legacy' then
   perform public.api_record_capability_observation('xometry','provider_upload','quote_home','account_quote_modal','ovd591.race',
    'provider-upload-capability.v1','fresh',array['step'],array['application/step'],true,
    clock_timestamp()-interval '1 second',clock_timestamp()+interval '59 minutes',
    'worker','provider_surface','worker.v1','issue:OVD-591','ovd591:race:legacy',
    (select (v->>'observationRevision')::bigint from private.ovd591_fixture_inputs where k='receipt'));
   result := '{"status":"legacy_recorded"}'::jsonb;
 elsif operation='attention-a' or operation='attention-b' then
   select public.api_commit_capability_attention(v) into result from private.ovd591_fixture_inputs where k=operation;
 else raise exception 'unexpected test operation';
 end if;
 return jsonb_build_object('result',result,'sqlstate',null);
exception when others then return jsonb_build_object('result',null,'sqlstate',sqlstate);
end$$;
revoke all on function private.ovd591_fixture_call(text) from public,anon,authenticated,service_role;
create function pg_temp.await_overlap(expected integer default 2) returns jsonb language plpgsql set search_path=pg_catalog as $$
declare receipt jsonb;
begin
 for attempt in 1..150 loop
  perform pg_stat_clear_snapshot();
  select jsonb_agg(jsonb_build_object('pid',pid,'blockers',pg_blocking_pids(pid),'waitEvent',wait_event,'observedAt',clock_timestamp()))
   into receipt from pg_stat_activity where application_name='ovd591-race' and wait_event_type='Lock'
   and pg_backend_pid()=any(pg_blocking_pids(pid));
  if jsonb_array_length(receipt)=expected then return receipt;end if;
  perform pg_sleep(0.02);
 end loop;
 return '[]'::jsonb;
end$$;
-- Use only the existing disposable password delivered by the admitted runner.
-- libpq keyword values require backslash escaping, not SQL literal quoting.
create function pg_temp.ovd591_conninfo_value(value text) returns text language sql immutable strict set search_path=pg_catalog as $$
 select chr(39)||replace(replace(value,chr(92),chr(92)||chr(92)),chr(39),chr(92)||chr(39))||chr(39)
$$;
create function pg_temp.ovd591_connection() returns text language sql set search_path=pg_catalog as $$
 select format('hostaddr=127.0.0.1 port=%s dbname=%s user=postgres password=%s application_name=ovd591-race connect_timeout=5',
  current_setting('port'),pg_temp.ovd591_conninfo_value(current_database()),
  pg_temp.ovd591_conninfo_value(convert_from(decode(current_setting('ovd591.fixture_password_b64'),'base64'),'UTF8')))
$$;
select extensions.dblink_connect('ovd591-a',pg_temp.ovd591_connection());
select extensions.dblink_connect('ovd591-b',pg_temp.ovd591_connection());
create temporary table race_results(name text,result jsonb);
create temporary table overlaps(name text,receipt jsonb);
begin;
select pg_advisory_xact_lock(591,1);
select extensions.dblink_send_query('ovd591-a',$$select private.ovd591_fixture_call('claim')$$);
select extensions.dblink_send_query('ovd591-b',$$select private.ovd591_fixture_call('claim')$$);
insert into overlaps values ('claim',pg_temp.await_overlap());
select is((select jsonb_array_length(receipt) from overlaps where name='claim'),2,'two claimants actually overlap behind coordinator lock');
commit;
insert into race_results select 'claim',v from extensions.dblink_get_result('ovd591-a') as response(v jsonb);
insert into race_results select 'claim',v from extensions.dblink_get_result('ovd591-b') as response(v jsonb);
select * from extensions.dblink_get_result('ovd591-a') as response(v jsonb);
select * from extensions.dblink_get_result('ovd591-b') as response(v jsonb);
select is((select count(*)::integer from race_results where name='claim' and result#>>'{result,status}'='claimed'),1,'one claimant alone receives probe grant');
select is((select count(*)::integer from race_results where name='claim' and result#>>'{result,status}'='replay'),1,'concurrent duplicate never receives probe grant');
insert into private.ovd591_fixture_inputs select 'receipt',result->'result' from race_results where result#>>'{result,status}'='claimed';
insert into private.ovd591_fixture_inputs select 'completion',jsonb_build_object('windowKey',v->>'windowKey',
 'requestKey','00000000-0000-4000-8000-000000000091','fence',v->>'fence','resourceReleased',true,'completionKey','10000000-0000-4000-8000-000000000091',
 'candidate',jsonb_build_object('provider','xometry','route','quote_home','surface','account_quote_modal','revision','ovd591.race',
 'state','fresh','extensions',jsonb_build_array('step'),'mimeTypes',jsonb_build_array('application/step'),
 'acceptAttributePresent',true,'observedAt',to_char(clock_timestamp()-interval '1 second','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'expiresAt',to_char(clock_timestamp()+interval '59 minutes','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'actorKind','scheduled_canary','sourceKind','scheduled_canary','sourceVersion','worker.v1','evidenceReference','issue:OVD-591','idempotencyKey','canary:'||repeat('c',64)))
 from private.ovd591_fixture_inputs where k='receipt';
begin;
select pg_advisory_xact_lock(591,1);
select extensions.dblink_send_query('ovd591-a',$$select private.ovd591_fixture_call('complete')$$);
select extensions.dblink_send_query('ovd591-b',$$select private.ovd591_fixture_call('legacy')$$);
insert into overlaps values ('reserved-revision',pg_temp.await_overlap());
select is((select jsonb_array_length(receipt) from overlaps where name='reserved-revision'),2,'completion and legacy writer actually overlap');
commit;
insert into race_results select 'complete',v from extensions.dblink_get_result('ovd591-a') as response(v jsonb);
insert into race_results select 'legacy',v from extensions.dblink_get_result('ovd591-b') as response(v jsonb);
select * from extensions.dblink_get_result('ovd591-a') as response(v jsonb);
select * from extensions.dblink_get_result('ovd591-b') as response(v jsonb);
select is((select result#>>'{result,status}' from race_results where name='complete'),'completed','reservation owner completes');
select ok((select result->>'sqlstate' is not null from race_results where name='legacy'),'legacy writer cannot steal reserved revision');
select is((select count(*)::integer from private.capability_observations where surface_revision='ovd591.race'),1,'one unique reserved observation survives race');

insert into private.ovd591_fixture_inputs values ('attention-initial','{"expectedVersion":0,"evaluationKey":"30000000-0000-4000-8000-000000000001","cursor":{"scopeKey":"10fa2890348c0d2c741fc1bdb5a219fafaef217686c4fb8740f62eb0bf876514","fingerprint":"84da2c2f371a63bc65a237f26d892ae00cfa6fd68268fc8096287f1e6bc56fc2","generation":1,"lastObservationRevision":null,"lastObservedAt":null,"lastEvidenceHash":null,"evaluatedAt":"2000-01-01T00:00:00.000Z"},"item":{"key":"capability:10fa2890348c0d2c741fc1bdb5a219fafaef217686c4fb8740f62eb0bf876514","category":"provider_upload_capability","metadata":{"provider":"xometry","route":"quote_home","surface":"account_quote_modal","surfaceRevision":"ovd591.race-empty","policyRevision":"policy.v1","adapterRevision":null,"workerBuild":null},"severity":"unknown","reasonCode":"observation_missing","summary":"Upload capability evidence is missing or invalid.","freshness":"unknown","observedAt":null,"expiresAt":null,"checkedAt":"2000-01-01T00:00:00.000Z","formatCounts":null,"occurrenceCount":null,"firstSeenAt":null,"lastChangedAt":null,"action":null},"intent":{"key":"3ce93f98bdb1ce7d5b07dc740cbf6cc3623c1bd965dee2ceaf37cae097dc7dd7","itemKey":"capability:10fa2890348c0d2c741fc1bdb5a219fafaef217686c4fb8740f62eb0bf876514","generation":1,"kind":"attention","reasonCode":"observation_missing"},"evidence":null}'::jsonb);
select public.api_commit_capability_attention(v) from private.ovd591_fixture_inputs where k='attention-initial';
insert into private.ovd591_fixture_inputs select 'attention-a',jsonb_set(jsonb_set(v||jsonb_build_object('expectedVersion',1,'evaluationKey','30000000-0000-4000-8000-000000000002','intent',null),'{cursor,evaluatedAt}','"2000-01-01T00:00:01.000Z"'),'{item,checkedAt}','"2000-01-01T00:00:01.000Z"') from private.ovd591_fixture_inputs where k='attention-initial';
insert into private.ovd591_fixture_inputs select 'attention-b',v||jsonb_build_object('evaluationKey','30000000-0000-4000-8000-000000000003') from private.ovd591_fixture_inputs where k='attention-a';
begin;
select pg_advisory_xact_lock(591,1);
select extensions.dblink_send_query('ovd591-a',$$select private.ovd591_fixture_call('attention-a')$$);
select extensions.dblink_send_query('ovd591-b',$$select private.ovd591_fixture_call('attention-b')$$);
insert into overlaps values ('same-generation-cas',pg_temp.await_overlap());
select is((select jsonb_array_length(receipt) from overlaps where name='same-generation-cas'),2,'same generation evaluators actually overlap');
commit;
insert into race_results select 'cas',v from extensions.dblink_get_result('ovd591-a') as response(v jsonb);
insert into race_results select 'cas',v from extensions.dblink_get_result('ovd591-b') as response(v jsonb);
select * from extensions.dblink_get_result('ovd591-a') as response(v jsonb);
select * from extensions.dblink_get_result('ovd591-b') as response(v jsonb);
select is((select count(*)::integer from race_results where name='cas' and result#>>'{result,status}'='committed'),1,'one CAS winner');
select is((select count(*)::integer from race_results where name='cas' and result#>>'{result,status}'='conflict'),1,'one CAS loser');
select is(public.api_read_capability_attention('10fa2890348c0d2c741fc1bdb5a219fafaef217686c4fb8740f62eb0bf876514')->>'version','2','CAS version advances once');
select is(public.api_read_capability_attention('10fa2890348c0d2c741fc1bdb5a219fafaef217686c4fb8740f62eb0bf876514')#>>'{cursor,generation}','1','CAS independent of unchanged generation');


insert into private.ovd591_fixture_inputs select 'expired-claim',v||jsonb_build_object('windowKey','canary:'||repeat('e',64),'resourceKey',repeat('f',64),
 'requestKey','00000000-0000-4000-8000-000000000092','surfaceRevision','ovd591.expired','leaseSeconds',2) from private.ovd591_fixture_inputs where k='claim';
insert into private.ovd591_fixture_inputs select 'expired-receipt',public.api_claim_capability_window(v) from private.ovd591_fixture_inputs where k='expired-claim';
insert into private.ovd591_fixture_inputs select 'expired-completion',jsonb_set(jsonb_set(c.v||jsonb_build_object('windowKey',r.v->>'windowKey','fence',r.v->>'fence',
 'requestKey','00000000-0000-4000-8000-000000000092','completionKey','10000000-0000-4000-8000-000000000092'),'{candidate,revision}','"ovd591.expired"'),'{candidate,idempotencyKey}',r.v->'windowKey')
 from private.ovd591_fixture_inputs c cross join private.ovd591_fixture_inputs r where c.k='completion' and r.k='expired-receipt';
begin;
select pg_advisory_xact_lock(591,1);
select extensions.dblink_send_query('ovd591-a',$$select private.ovd591_fixture_call('expire')$$);
insert into overlaps values ('expiry-after-lock',pg_temp.await_overlap(1));
select is((select jsonb_array_length(receipt) from overlaps where name='expiry-after-lock'),1,'completion actually waits before its lease expires');
select ok((select (o.receipt->0->>'observedAt')::timestamptz<(i.v->>'deadline')::timestamptz from overlaps o cross join private.ovd591_fixture_inputs i where o.name='expiry-after-lock' and i.k='expired-receipt'),'completion began its observed lock wait before lease expiry');
select pg_sleep(2.2);
commit;
insert into race_results select 'expired',v from extensions.dblink_get_result('ovd591-a') as response(v jsonb);
select * from extensions.dblink_get_result('ovd591-a') as response(v jsonb);
select ok((select result->>'sqlstate' is not null from race_results where name='expired'),'expiry is rechecked after actual lock wait');
select is((select count(*)::integer from private.capability_observations where surface_revision='ovd591.expired'),0,'expired completion writes no observation');
select is((select public.api_claim_capability_window(v)->>'status' from private.ovd591_fixture_inputs where k='expired-claim'),'expired','expired duplicate never authorizes reprobe');
select is((select public.api_claim_capability_window(v||jsonb_build_object('windowKey','canary:'||repeat('b',64),'surfaceRevision','ovd591.expired-other'))->>'status' from private.ovd591_fixture_inputs where k='expired-claim'),'busy','expired ambiguous owner still excludes shared session');


-- An admissible legacy writer and a distinct window both use shared allocation.
insert into private.ovd591_fixture_inputs select 'next-claim',v||jsonb_build_object('windowKey','canary:'||repeat('a',64),'resourceKey',repeat('a',64),
 'requestKey','00000000-0000-4000-8000-000000000093','windowStart',to_char(clock_timestamp()-interval '2 minutes','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) from private.ovd591_fixture_inputs where k='claim';
begin;
select pg_advisory_xact_lock(591,1);
select extensions.dblink_send_query('ovd591-a',$$select private.ovd591_fixture_call('allocate')$$);
select extensions.dblink_send_query('ovd591-b',$$select private.ovd591_fixture_call('legacy-high')$$);
insert into overlaps values ('legacy-and-reservation',pg_temp.await_overlap());
select is((select jsonb_array_length(receipt) from overlaps where name='legacy-and-reservation'),2,'admissible legacy and distinct reservation actually overlap');
commit;
insert into race_results select 'allocate',v from extensions.dblink_get_result('ovd591-a') as response(v jsonb);
insert into race_results select 'legacy-high',v from extensions.dblink_get_result('ovd591-b') as response(v jsonb);
select * from extensions.dblink_get_result('ovd591-a') as response(v jsonb);
select * from extensions.dblink_get_result('ovd591-b') as response(v jsonb);
select is((select result#>>'{result,status}' from race_results where name='allocate'),'claimed','distinct window reserves once');
select is((select result#>>'{result,status}' from race_results where name='legacy-high'),'recorded','admissible legacy revision survives');
select ok((select (result#>>'{result,observationRevision}')::bigint in (2,101) from race_results where name='allocate'),'reservation respects ordered high water on either lock order');
select is((select observation_revision from public.api_resolve_current_capability_observation('xometry','provider_upload','quote_home','account_quote_modal','ovd591.race')),100::bigint,'resolver sees latest legacy observation');
-- The next reservation must exceed both writers, including any uncompleted reservation.
insert into private.ovd591_fixture_inputs select 'after-race',public.api_claim_capability_window(v||jsonb_build_object('windowKey','canary:'||repeat('9',64),
 'resourceKey',repeat('9',64),'requestKey','00000000-0000-4000-8000-000000000094',
 'windowStart',to_char(clock_timestamp()-interval '3 minutes','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))) from private.ovd591_fixture_inputs where k='next-claim';
select ok((select (v->>'observationRevision')::bigint>100 and (v->>'observationRevision')::bigint>(select (result#>>'{result,observationRevision}')::bigint from race_results where name='allocate') from private.ovd591_fixture_inputs where k='after-race'),'next allocator exceeds both committed and reserved revisions');
-- Late completion cannot displace a newer observed ledger head, regardless of reserved number.
select throws_ok(format('select public.api_complete_capability_window(%L::jsonb)',
 jsonb_set(jsonb_set(c.v||jsonb_build_object('windowKey',r.v->>'windowKey','fence',r.v->>'fence','requestKey','00000000-0000-4000-8000-000000000094',
 'completionKey','10000000-0000-4000-8000-000000000094'),'{candidate,idempotencyKey}',r.v->'windowKey'),
 '{candidate,observedAt}',to_jsonb(to_char(clock_timestamp()-interval '10 seconds','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))),null,null,'late completion cannot replace newer observed evidence')
 from private.ovd591_fixture_inputs c cross join private.ovd591_fixture_inputs r where c.k='completion' and r.k='after-race';
-- Delayed attention began from missing evidence; a real append wins before its lock release.
update private.ovd591_fixture_inputs set v=v||jsonb_build_object('expectedVersion',2,'evaluationKey','30000000-0000-4000-8000-000000000004') where k='attention-a';
begin;
select pg_advisory_xact_lock(591,1);
select extensions.dblink_send_query('ovd591-a',$$select private.ovd591_fixture_call('attention-a')$$);
insert into overlaps values ('ledger-before-delayed-attention',pg_temp.await_overlap(1));
select is((select jsonb_array_length(receipt) from overlaps where name='ledger-before-delayed-attention'),1,'delayed evaluator actually waits while new observation commits');
select public.api_record_capability_observation('xometry','provider_upload','quote_home','account_quote_modal','ovd591.race-empty',
 'provider-upload-capability.v1','fresh',array['step'],array['application/step'],true,clock_timestamp()-interval '1 second',clock_timestamp()+interval '59 minutes',
 'worker','provider_surface','worker.v1','issue:OVD-591','ovd591:race:stale-evaluator',1);
commit;
insert into race_results select 'stale-evaluator',v from extensions.dblink_get_result('ovd591-a') as response(v jsonb);
select * from extensions.dblink_get_result('ovd591-a') as response(v jsonb);
select ok((select result->>'sqlstate' is not null from race_results where name='stale-evaluator'),'new ledger head rejects delayed attention with unchanged cursor version');
select is((select version from private.capability_attention_state where item#>>'{metadata,surfaceRevision}'='ovd591.race-empty'),2::bigint,'stale evaluator preserves cursor version');

-- Raw causal receipts must be retained along with TAP, not reduced to counts.
select '# overlap '||name||' '||receipt::text from overlaps order by name;
select '# result '||name||' '||result::text from race_results order by name;
select extensions.dblink_disconnect('ovd591-a');
select extensions.dblink_disconnect('ovd591-b');
drop function private.ovd591_fixture_call(text);
drop table private.ovd591_fixture_inputs;
select * from finish();
-- Retained synthetic ledger/window records are destroyed only with the fixture.
