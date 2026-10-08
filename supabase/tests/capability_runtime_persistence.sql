-- OVD-591: exclusively owned synthetic database only. Every change rolls back.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_catalog;
set local statement_timeout = '20s';
set local timezone = 'UTC';
select no_plan();
create function pg_temp.claim(n integer, resource integer default null) returns jsonb language sql as $$
 select jsonb_build_object('windowKey','canary:'||lpad(n::text,64,'0'),'resourceKey',lpad(coalesce(resource,n)::text,64,'0'),
 'configDigest',repeat('a',64),'requestKey',('00000000-0000-4000-8000-'||lpad(n::text,12,'0')),
 'provider','xometry','route','quote_home','surface','account_quote_modal','surfaceRevision','ovd591.v1',
 'windowStart',to_char(transaction_timestamp()-interval '1 minute'-make_interval(secs=>n),'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'windowEnd',to_char(transaction_timestamp()+interval '10 minutes','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'leaseSeconds',300)
$$;
create function pg_temp.candidate(n integer) returns jsonb language sql as $$
 select jsonb_build_object('provider','xometry','route','quote_home','surface','account_quote_modal','revision','ovd591.v1',
 'state','fresh','extensions',jsonb_build_array('step'),'mimeTypes',jsonb_build_array('application/step'),
 'acceptAttributePresent',true,'observedAt',to_char(transaction_timestamp()-interval '1 second','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'expiresAt',to_char(transaction_timestamp()+interval '59 minutes','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'actorKind','scheduled_canary','sourceKind','scheduled_canary','sourceVersion','worker.v1',
 'evidenceReference','issue:OVD-591','idempotencyKey','canary:'||lpad(n::text,64,'0'))
$$;
create temporary table fixture(k text primary key,v jsonb);
insert into fixture values ('claim',pg_temp.claim(1));
insert into fixture select 'receipt',public.api_claim_capability_window(v) from fixture where k='claim';
insert into fixture select 'completion',jsonb_build_object('windowKey',v->>'windowKey','requestKey',pg_temp.claim(1)->>'requestKey',
 'fence',v->>'fence','resourceReleased',true,'completionKey','10000000-0000-4000-8000-000000000001','candidate',pg_temp.candidate(1)) from fixture where k='receipt';
select is((select v->>'status' from fixture where k='receipt'),'claimed','first owner receives one probe grant');
select is(public.api_claim_capability_window(pg_temp.claim(1))->>'status','replay','lost claim reply cannot grant another probe');
select isnt(public.api_claim_capability_window(pg_temp.claim(2,1))->>'status','claimed','same provider/session excluded across windows');
select isnt(public.api_get_capability_window('canary:'||lpad('1',64,'0'),'00000000-0000-4000-8000-000000000001')->>'status','claimed','status recovery does not authorize a probe');
select is((select count(*)::integer from private.capability_runtime_windows),1,'replay/status/busy do not allocate windows');
select throws_ok($$select public.api_claim_capability_window(pg_temp.claim(1)||jsonb_build_object('configDigest',repeat('b',64)))$$,
 null,null,'changed identity conflicts');
select throws_ok($$select public.api_complete_capability_window((select v from fixture where k='completion')||jsonb_build_object('fence','ffffffff-ffff-4fff-8fff-ffffffffffff'))$$,
 null,null,'foreign fence cannot complete');
-- Inject after canonical append, before terminal window update. Exception must roll back both.
create temporary sequence ovd591_window_marker;
create function pg_temp.fail_window() returns trigger language plpgsql as $$begin if new.receipt is not null then perform nextval('pg_temp.ovd591_window_marker');raise exception 'ovd591 rollback injection';end if;return new;end$$;
create trigger ovd591_fail_window before update on private.capability_runtime_windows for each row execute function pg_temp.fail_window();
select throws_ok($$select public.api_complete_capability_window((select v from fixture where k='completion'))$$,
 'P0001',null,'failure after append propagates');
select ok((select is_called from pg_temp.ovd591_window_marker),'terminal update injection actually ran after append');
select is((select count(*)::integer from private.capability_observations where idempotency_key='canary:'||lpad('1',64,'0')),0,'append rolled back with window failure');
drop trigger ovd591_fail_window on private.capability_runtime_windows;
insert into fixture select 'completed',public.api_complete_capability_window(v) from fixture where k='completion';
select is((select v->>'status' from fixture where k='completed'),'completed','valid completion records observation');
select is(public.api_complete_capability_window((select v from fixture where k='completion')),
 (select v from fixture where k='completed'),'lost completion reply returns identical terminal receipt');
select throws_ok($$select public.api_complete_capability_window(jsonb_set((select v from fixture where k='completion'),'{candidate,acceptAttributePresent}','false'))$$,
 null,null,'altered completion replay conflicts');
select is((select count(*)::integer from private.capability_observations where idempotency_key='canary:'||lpad('1',64,'0')),1,'one canonical observation after replay');
select throws_ok($$select public.api_claim_capability_window(pg_temp.claim(1)||jsonb_build_object('windowKey','canary:'||repeat('f',64),'requestKey','00000000-0000-4000-8000-000000000099'))$$,null,null,'different hash cannot reprobe completed canonical window');
select is(public.api_claim_capability_window(pg_temp.claim(2,1))->>'status','claimed','confirmed completion frees session resource');
select is((select count(*)::integer from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='private' and c.relkind='r' and c.relname in ('capability_runtime_windows','capability_runtime_revisions','capability_attention_state','capability_attention_outbox','capability_attention_evaluations')),5,'all five private relations exist');
select is((select count(*)::integer from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname in ('api_claim_capability_window','api_get_capability_window','api_complete_capability_window','api_read_capability_attention','api_commit_capability_attention','api_list_due_capability_attention')),6,'all six service RPCs exist without unreviewed overloads');
select ok((select bool_and(relrowsecurity and relforcerowsecurity) from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='private' and c.relname in ('capability_runtime_windows','capability_runtime_revisions','capability_attention_state','capability_attention_outbox','capability_attention_evaluations')),
 'all persistence tables force RLS');
select ok(not has_table_privilege(role_name,'private.'||table_name,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'),role_name||' denied direct '||table_name)
 from unnest(array['anon','authenticated','service_role']) role_name cross join unnest(array['capability_runtime_windows','capability_runtime_revisions','capability_attention_state','capability_attention_outbox','capability_attention_evaluations']) table_name;
select ok(not has_function_privilege(role_name,p.oid,'EXECUTE'),role_name||' denied '||p.proname)
 from pg_proc p join pg_namespace n on n.oid=p.pronamespace cross join unnest(array['anon','authenticated']) role_name
 where n.nspname='public' and p.proname in ('api_claim_capability_window','api_get_capability_window','api_complete_capability_window','api_read_capability_attention','api_commit_capability_attention','api_list_due_capability_attention');
select ok(has_function_privilege('service_role',p.oid,'EXECUTE') and p.prosecdef and p.proconfig @> array['search_path=pg_catalog'],p.proname||' service only fixed search path')
 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in
 ('api_claim_capability_window','api_get_capability_window','api_complete_capability_window','api_read_capability_attention','api_commit_capability_attention','api_list_due_capability_attention');
set local role anon;
select throws_ok($$select public.api_claim_capability_window('{}')$$,'42501',null,'anon actual claim denied');
reset role;
set local role authenticated;
select throws_ok($$select public.api_commit_capability_attention('{}')$$,'42501',null,'authenticated actual commit denied');
reset role;

-- Retain real sanitized evidence and separate CAS version from generation.
create function pg_temp.attention() returns jsonb language sql as $body$
select jsonb_build_object('expectedVersion',0,'evaluationKey','20000000-0000-4000-8000-000000000001',
 'cursor',jsonb_build_object('scopeKey','4b95a08275a38b4a5b0a9bc0d0da7decc5f31dc978cdfd34a2e3cbd6217b89b0','fingerprint','663d25b837eefc1a1d4ed194496fe5a05060dc0bf06d76d17a3eaf87afc6c642','generation',0,
 'lastObservationRevision',r.v->'observationRevision','lastObservedAt',c.v->'candidate'->'observedAt',
 'lastEvidenceHash',encode(extensions.digest(convert_to('[{"classification":"matches_policy","allowed":["step"],"added":[],"removed":[]},'||
 ((extract(epoch from (c.v->'candidate'->>'observedAt')::timestamptz)*1000)::bigint)::text||','||
 ((extract(epoch from (c.v->'candidate'->>'expiresAt')::timestamptz)*1000)::bigint)::text||','||(r.v->>'observationRevision')||']','UTF8'),'sha256'),'hex'),
 'evaluatedAt',to_char(transaction_timestamp(),'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
 'item',jsonb_build_object('key','capability:4b95a08275a38b4a5b0a9bc0d0da7decc5f31dc978cdfd34a2e3cbd6217b89b0','category','provider_upload_capability','metadata','{"provider":"xometry","route":"quote_home","surface":"account_quote_modal","surfaceRevision":"ovd591.v1","policyRevision":"policy.v1","adapterRevision":null,"workerBuild":null}'::jsonb,
 'severity','healthy','reasonCode','matches_policy','summary','Upload capability matches the reviewed policy.','freshness','current',
 'observedAt',c.v->'candidate'->'observedAt','expiresAt',c.v->'candidate'->'expiresAt',
 'checkedAt',to_char(transaction_timestamp(),'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'formatCounts',jsonb_build_object('allowed',1,'added',0,'removed',0),'occurrenceCount',null,'firstSeenAt',null,'lastChangedAt',null,'action',null),
 'intent',null,'evidence',jsonb_build_object('decision',jsonb_build_object('contractVersion','provider-upload-capability.v1','classification','matches_policy',
 'allowedExtensions',jsonb_build_array('step'),'reportedAddedExtensions','[]'::jsonb,'reportedRemovedExtensions','[]'::jsonb,
 'evidenceRefs','[]'::jsonb,'normalizedObservedMimeTypes','[]'::jsonb),
 'observedAt',c.v->'candidate'->'observedAt','expiresAt',c.v->'candidate'->'expiresAt','observationRevision',r.v->'observationRevision'))
from fixture r cross join fixture c where r.k='receipt' and c.k='completion'
$body$;
insert into fixture values ('attention',pg_temp.attention());
select throws_ok(format('select public.api_commit_capability_attention(%L::jsonb)',jsonb_set(pg_temp.attention(),array[field],'null')),null,null,'JSON null rejected: '||field)
 from unnest(array['expectedVersion','evaluationKey','cursor','item','intent','evidence']) field where field not in ('intent','evidence');
select throws_ok(format('select public.api_commit_capability_attention(%L::jsonb)',jsonb_set(pg_temp.attention(),array['cursor',field],'null')),null,null,'required cursor JSON null rejected: '||field)
 from unnest(array['generation','fingerprint','scopeKey']) field;
select throws_ok(format('select public.api_commit_capability_attention(%L::jsonb)',pg_temp.attention()-field),null,null,'missing required attention key rejected: '||field)
 from unnest(array['expectedVersion','evaluationKey','cursor','item','intent','evidence']) field;
select throws_ok($$select public.api_commit_capability_attention(jsonb_set(pg_temp.attention(),'{evidence,expiresAt}',to_jsonb('2099-01-01T00:00:00.000Z'::text)))$$,null,null,'retained evidence expiry must match canonical ledger');
select throws_ok($$select public.api_commit_capability_attention(jsonb_set(pg_temp.attention(),'{item,expiresAt}',to_jsonb('2099-01-01T00:00:00.000Z'::text)))$$,null,null,'item expiry cannot forge due time');
select throws_ok(format('select public.api_commit_capability_attention(%L::jsonb)',jsonb_set(pg_temp.attention(),path,'null')),null,null,'nested null rejected: '||path::text)
 from (values (array['evidence','decision','classification']), (array['item','formatCounts','allowed'])) cases(path);
select throws_ok($$select public.api_commit_capability_attention(jsonb_set(pg_temp.attention(),'{evidence,decision,allowedExtensions}','[null]'))$$,null,null,'null format token rejected');
insert into fixture values ('attention-receipt',public.api_commit_capability_attention(pg_temp.attention()));
select is((select v->>'status' from fixture where k='attention-receipt'),'committed','valid evidence persists');
select is(public.api_commit_capability_attention(pg_temp.attention()),(select v from fixture where k='attention-receipt'),'lost attention reply replays exact receipt');
select is(public.api_read_capability_attention('4b95a08275a38b4a5b0a9bc0d0da7decc5f31dc978cdfd34a2e3cbd6217b89b0')->'evidence',pg_temp.attention()->'evidence','read retains only exact sanitized evidence');
select throws_ok($$select public.api_commit_capability_attention(jsonb_set(pg_temp.attention()||jsonb_build_object('expectedVersion',1,'evaluationKey','20000000-0000-4000-8000-000000000099'),'{evidence,decision,allowedExtensions}','["stp"]'))$$,null,null,'same revision cannot replace decision while retaining old evidence hash');
insert into fixture values ('advance',jsonb_set(pg_temp.attention()||jsonb_build_object('expectedVersion',1,'evaluationKey','20000000-0000-4000-8000-000000000002'),'{cursor,evaluatedAt}',to_jsonb(to_char(clock_timestamp(),'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))));
update fixture set v=jsonb_set(v,'{item,checkedAt}',v->'cursor'->'evaluatedAt') where k='advance';
select is(public.api_commit_capability_attention((select v from fixture where k='advance'))->>'version','2','same generation advances independent CAS version');
select is(public.api_read_capability_attention('4b95a08275a38b4a5b0a9bc0d0da7decc5f31dc978cdfd34a2e3cbd6217b89b0')#>>'{cursor,generation}','0','generation remains unchanged on same semantic state');
select is(public.api_commit_capability_attention((select v from fixture where k='advance')||jsonb_build_object('evaluationKey','20000000-0000-4000-8000-000000000003'))->>'status','conflict','stale expected version cannot overwrite watermark');
-- Failure after cursor update must roll back the independent CAS version.
create temporary sequence ovd591_evaluation_marker;
create function pg_temp.fail_evaluation() returns trigger language plpgsql as $$begin perform nextval('pg_temp.ovd591_evaluation_marker');raise exception 'ovd591 evaluation rollback';end$$;
create trigger ovd591_fail_evaluation before insert on private.capability_attention_evaluations for each row execute function pg_temp.fail_evaluation();
select throws_ok($$select public.api_commit_capability_attention((select v from fixture where k='advance')||jsonb_build_object('expectedVersion',2,'evaluationKey','20000000-0000-4000-8000-000000000005'))$$,'P0001',null,'failure after cursor update rolls back transaction');
select ok((select is_called from pg_temp.ovd591_evaluation_marker),'evaluation injection actually reached after cursor update');
select is(public.api_read_capability_attention('4b95a08275a38b4a5b0a9bc0d0da7decc5f31dc978cdfd34a2e3cbd6217b89b0')->>'version','2','failed evaluation preserves previous version');
select is((select count(*)::integer from private.capability_attention_evaluations where evaluation_key='20000000-0000-4000-8000-000000000005'),0,'failed evaluation leaves no replay receipt');
drop trigger ovd591_fail_evaluation on private.capability_attention_evaluations;


insert into fixture values ('missing-attention','{"expectedVersion":0,"evaluationKey":"30000000-0000-4000-8000-000000000001","cursor":{"scopeKey":"d4920b2c2300e075735d67492ad9119aa83a54d2f3350a9507587119f5ae2ced","fingerprint":"84da2c2f371a63bc65a237f26d892ae00cfa6fd68268fc8096287f1e6bc56fc2","generation":1,"lastObservationRevision":null,"lastObservedAt":null,"lastEvidenceHash":null,"evaluatedAt":"2000-01-01T00:00:00.000Z"},"item":{"key":"capability:d4920b2c2300e075735d67492ad9119aa83a54d2f3350a9507587119f5ae2ced","category":"provider_upload_capability","metadata":{"provider":"xometry","route":"quote_home","surface":"account_quote_modal","surfaceRevision":"ovd591.empty","policyRevision":"policy.v1","adapterRevision":null,"workerBuild":null},"severity":"unknown","reasonCode":"observation_missing","summary":"Upload capability evidence is missing or invalid.","freshness":"unknown","observedAt":null,"expiresAt":null,"checkedAt":"2000-01-01T00:00:00.000Z","formatCounts":null,"occurrenceCount":null,"firstSeenAt":null,"lastChangedAt":null,"action":null},"intent":{"key":"26ec215833731d24e9fd1510c6871cc28384dfadb73a78471afecf737a1fc4ef","itemKey":"capability:d4920b2c2300e075735d67492ad9119aa83a54d2f3350a9507587119f5ae2ced","generation":1,"kind":"attention","reasonCode":"observation_missing"},"evidence":null}'::jsonb);
select throws_ok(format('select public.api_commit_capability_attention(%L::jsonb)',jsonb_set((select v from fixture where k='missing-attention'),array['intent',field],'null')),null,null,'null intent field rejected: '||field)
 from unnest(array['reasonCode','itemKey']) field;
select throws_ok($$select public.api_commit_capability_attention(jsonb_set(jsonb_set(jsonb_set(jsonb_set(
 (select v from fixture where k='missing-attention'),'{cursor,generation}','0'),'{intent}','null'),'{item,severity}','"healthy"'),
 '{item,reasonCode}','"matches_policy"'))$$,null,null,'missing canonical evidence can never persist a healthy projection');
create temporary sequence ovd591_outbox_marker;
create function pg_temp.fail_outbox() returns trigger language plpgsql as $$begin perform nextval('pg_temp.ovd591_outbox_marker');raise exception 'ovd591 outbox rollback';end$$;
create trigger ovd591_fail_outbox before insert on private.capability_attention_outbox for each row execute function pg_temp.fail_outbox();
select throws_ok($$select public.api_commit_capability_attention((select v from fixture where k='missing-attention'))$$,'P0001',null,'outbox insertion failure is visible');
select ok((select is_called from pg_temp.ovd591_outbox_marker),'outbox injection actually reached after cursor write');
select is(public.api_read_capability_attention('d4920b2c2300e075735d67492ad9119aa83a54d2f3350a9507587119f5ae2ced'),null::jsonb,'outbox failure rolls back initial cursor and item');
select is((select count(*)::integer from private.capability_attention_outbox where intent_key='26ec215833731d24e9fd1510c6871cc28384dfadb73a78471afecf737a1fc4ef'),0,'failed outbox intent absent');
drop trigger ovd591_fail_outbox on private.capability_attention_outbox;
select is(public.api_commit_capability_attention((select v from fixture where k='missing-attention'))->>'status','committed','missing evidence attention commits with intent');
select is(public.api_commit_capability_attention((select v from fixture where k='missing-attention'))->>'status','committed','missing evidence replay commits same receipt');
select is((select count(*)::integer from private.capability_attention_outbox where intent_key='26ec215833731d24e9fd1510c6871cc28384dfadb73a78471afecf737a1fc4ef'),1,'replay emits one durable intent');
select ok(not has_function_privilege(role_name,p.oid,'EXECUTE'),role_name||' denied private helper '||p.proname)
 from pg_proc p join pg_namespace n on n.oid=p.pronamespace cross join unnest(array['anon','authenticated','service_role']) role_name
 where n.nspname='private' and p.proname like 'capability_runtime_%';


-- Due/stale/recovery/recurrence are persistence invariants, without a new probe.
create function pg_temp.transition_observation(revision bigint) returns void language plpgsql as $$
begin
 perform public.api_record_capability_observation('xometry','provider_upload','quote_home','account_quote_modal','ovd591.transitions',
 'provider-upload-capability.v1','fresh',array['step'],array['application/step'],true,
 date_trunc('milliseconds',clock_timestamp())-interval '1 second',date_trunc('milliseconds',clock_timestamp())+interval '2 seconds',
 'worker','provider_surface','worker.v1','issue:OVD-591','ovd591:transitions:'||revision,revision);
end$$;
create function pg_temp.transition_payload(expected bigint,generation bigint,stale boolean,intent_kind text,evaluation text) returns jsonb
language plpgsql as $$
declare o private.capability_observations; at_text text; observed_text text; expiry_text text; fingerprint text; reason text; intent jsonb; evidence jsonb;
begin
 select * into strict o from private.capability_observations where surface_revision='ovd591.transitions' order by observation_revision desc limit 1;
 at_text:=to_char(clock_timestamp(),'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
 observed_text:=to_char(o.observed_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
 expiry_text:=to_char(o.expires_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
 fingerprint:=case when stale then 'dc0ea0f7d111e11bc53b4634cc0975bdfdc32975112761e3fc06e78f4f24507c' else '663d25b837eefc1a1d4ed194496fe5a05060dc0bf06d76d17a3eaf87afc6c642' end;
 reason:=case when stale then 'observation_stale' else 'matches_policy' end;
 evidence:=jsonb_build_object('decision',jsonb_build_object('contractVersion','provider-upload-capability.v1','classification','matches_policy',
 'allowedExtensions',jsonb_build_array('step'),'reportedAddedExtensions','[]'::jsonb,'reportedRemovedExtensions','[]'::jsonb,'evidenceRefs','[]'::jsonb,'normalizedObservedMimeTypes','[]'::jsonb),
 'observedAt',observed_text,'expiresAt',expiry_text,'observationRevision',o.observation_revision);
 intent:=case when intent_kind is null then 'null'::jsonb else jsonb_build_object(
 'key',encode(extensions.digest(convert_to('["9a4b51eab3deab65f63c6f47a78d3ca782a66f9ed9a5d275581029f52874b726",'||generation||',"'||fingerprint||'"]','UTF8'),'sha256'),'hex'),
 'itemKey','capability:9a4b51eab3deab65f63c6f47a78d3ca782a66f9ed9a5d275581029f52874b726','generation',generation,'kind',intent_kind,'reasonCode',reason) end;
 return jsonb_build_object('expectedVersion',expected,'evaluationKey',evaluation,'cursor',jsonb_build_object(
 'scopeKey','9a4b51eab3deab65f63c6f47a78d3ca782a66f9ed9a5d275581029f52874b726','fingerprint',fingerprint,'generation',generation,'lastObservationRevision',o.observation_revision,
 'lastObservedAt',observed_text,'lastEvidenceHash',encode(extensions.digest(convert_to(
 '[{"classification":"matches_policy","allowed":["step"],"added":[],"removed":[]},'||(extract(epoch from o.observed_at)*1000)::bigint||','||(extract(epoch from o.expires_at)*1000)::bigint||','||o.observation_revision||']','UTF8'),'sha256'),'hex'),
 'evaluatedAt',at_text),
 'item',jsonb_build_object('key','capability:9a4b51eab3deab65f63c6f47a78d3ca782a66f9ed9a5d275581029f52874b726','category','provider_upload_capability','metadata','{"provider":"xometry","route":"quote_home","surface":"account_quote_modal","surfaceRevision":"ovd591.transitions","policyRevision":"policy.v1","adapterRevision":null,"workerBuild":null}'::jsonb,
 'severity',case when stale then 'unknown' else 'healthy' end,'reasonCode',reason,
 'summary',case when stale then 'Upload capability evidence is stale.' else 'Upload capability matches the reviewed policy.' end,
 'freshness',case when stale then 'stale' else 'current' end,'observedAt',observed_text,'expiresAt',expiry_text,'checkedAt',at_text,
 'formatCounts',case when stale then 'null'::jsonb else jsonb_build_object('allowed',1,'added',0,'removed',0) end,
 'occurrenceCount',null,'firstSeenAt',null,'lastChangedAt',null,'action',null),'intent',intent,'evidence',evidence);
end$$;
select pg_temp.transition_observation(1);
insert into fixture values ('transition-fresh',pg_temp.transition_payload(0,0,false,null,'40000000-0000-4000-8000-000000000001'));
select is(public.api_commit_capability_attention((select v from fixture where k='transition-fresh'))->>'status','committed','initial current canonical evidence retained');
select pg_sleep(2.2);
select is((select count(*)::integer from jsonb_array_elements(public.api_list_due_capability_attention(100)) row where row#>>'{cursor,scopeKey}'='9a4b51eab3deab65f63c6f47a78d3ca782a66f9ed9a5d275581029f52874b726'),1,'canonical expiry puts current state in due list');
insert into fixture values ('transition-stale',pg_temp.transition_payload(1,1,true,'attention','40000000-0000-4000-8000-000000000002'));
select is((select v->'evidence' from fixture where k='transition-stale'),(select v->'evidence' from fixture where k='transition-fresh'),'stale evaluation uses exact retained evidence and revision');
select is(public.api_commit_capability_attention((select v from fixture where k='transition-stale'))->>'status','committed','stale transition without observation commits');
select is((select count(*)::integer from private.capability_observations where surface_revision='ovd591.transitions'),1,'stale transition appended no observation');
select is(public.api_commit_capability_attention(pg_temp.transition_payload(2,1,true,null,'40000000-0000-4000-8000-000000000003'))->>'status','committed','repeat stale evaluation advances watermark only');
select is((select count(*)::integer from private.capability_attention_outbox where scope_key='9a4b51eab3deab65f63c6f47a78d3ca782a66f9ed9a5d275581029f52874b726'),1,'repeat stale evaluation emits no duplicate');
select is((select count(*)::integer from jsonb_array_elements(public.api_list_due_capability_attention(100)) row where row#>>'{cursor,scopeKey}'='9a4b51eab3deab65f63c6f47a78d3ca782a66f9ed9a5d275581029f52874b726'),0,'settled stale item does not monopolize due list');
select pg_temp.transition_observation(2);
select is(public.api_commit_capability_attention(pg_temp.transition_payload(3,2,false,'recovery','40000000-0000-4000-8000-000000000004'))->>'status','committed','new canonical observation emits one recovery');
select pg_sleep(2.2);
insert into fixture values ('transition-recurrence',pg_temp.transition_payload(4,3,true,'attention','40000000-0000-4000-8000-000000000005'));
-- Failure at evaluation insertion follows both cursor update AND outbox append.
create trigger ovd591_fail_evaluation before insert on private.capability_attention_evaluations for each row execute function pg_temp.fail_evaluation();
select throws_ok($$select public.api_commit_capability_attention((select v from fixture where k='transition-recurrence'))$$,'P0001',null,'failure after outbox insert rolls back whole transition');
select is((select last_value from pg_temp.ovd591_evaluation_marker),2::bigint,'post-outbox suffix injection actually reached');
select is(public.api_read_capability_attention('9a4b51eab3deab65f63c6f47a78d3ca782a66f9ed9a5d275581029f52874b726')->>'version','4','post-outbox failure restores cursor version');
select is((select count(*)::integer from private.capability_attention_outbox where scope_key='9a4b51eab3deab65f63c6f47a78d3ca782a66f9ed9a5d275581029f52874b726'),2,'post-outbox failure removes newly appended intent');
select is((select count(*)::integer from private.capability_attention_evaluations where evaluation_key='40000000-0000-4000-8000-000000000005'),0,'post-outbox failure leaves no evaluation receipt');
drop trigger ovd591_fail_evaluation on private.capability_attention_evaluations;
select is(public.api_commit_capability_attention((select v from fixture where k='transition-recurrence'))->>'status','committed','subsequent stale recurrence commits after rollback');
select is(public.api_commit_capability_attention((select v from fixture where k='transition-recurrence'))->>'status','committed','recurrence lost reply replays');
select is((select count(distinct intent_key)::integer from private.capability_attention_outbox where scope_key='9a4b51eab3deab65f63c6f47a78d3ca782a66f9ed9a5d275581029f52874b726'),3,'stale recovery recurrence have distinct durable intents');
select is(public.api_read_capability_attention('9a4b51eab3deab65f63c6f47a78d3ca782a66f9ed9a5d275581029f52874b726')#>>'{cursor,generation}','3','recurrence advances generation once');
select is((select count(*)::integer from private.capability_observations where surface_revision='ovd591.transitions'),2,'two stale transitions never invent observations');

set local role service_role;
select is(public.api_get_capability_window('canary:'||lpad('1',64,'0'),'00000000-0000-4000-8000-000000000001')->>'status','completed','service role executes status recovery');
select throws_ok($$select * from private.capability_runtime_windows$$,'42501',null,'service role direct table read denied at execution boundary');
reset role;
select * from finish();
rollback;
