-- OVD-591 immutable preparation fixture. SOURCE ONLY until separately authorized.
-- Run after all migrations in an exclusively owned disposable database.
-- Transaction rolls back all rows, functions and triggers; sequence gaps are allowed.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_catalog;
set local statement_timeout = '20s';
set local timezone = 'UTC';
select no_plan();
-- Other rollback-free concurrency fixtures may retain canonical history.
-- Preparation must preserve every existing row, not assume a globally empty DB.
create temporary table observations_before_preparation as
 select coalesce(jsonb_agg(to_jsonb(o) order by o.id),'[]'::jsonb) as rows
 from private.capability_observations o;
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
insert into fixture select 'claim-entry',jsonb_build_object('request',v,
 'completionKey','10000000-0000-4000-8000-000000000001') from fixture where k='claim';
create temporary sequence preparation_early_marker;
create function pg_temp.fail_early_preparation() returns trigger language plpgsql as $$begin perform nextval('pg_temp.preparation_early_marker');raise exception 'preparation fixture early rollback';end$$;
grant select on fixture to service_role;
create trigger preparation_early_failure after insert on private.capability_claim_preparations for each row execute function pg_temp.fail_early_preparation();
select throws_ok($$select public.api_prepare_capability_claim((select v from fixture where k='claim-entry'))$$,'P0001','Capability claim preparation rejected.','claim post-insert rollback');
select is((select count(*)::integer from private.capability_claim_preparations),0,'claim failed insert leaves no row');
select is((select last_value from pg_temp.preparation_early_marker),1::bigint,'claim failure reached insert');
drop trigger preparation_early_failure on private.capability_claim_preparations;
set local role service_role;
select is(public.api_prepare_capability_claim((select v from fixture where k='claim-entry'))->>'state','created','service prepares claim');
select is(public.api_prepare_capability_claim((select v from fixture where k='claim-entry'))->>'state','existing','exact claim replay');
select is(public.api_prepare_capability_claim((select v from fixture where k='claim-entry'))->'retained',(select v from fixture where k='claim-entry'),'ack retains exact claim payload');
select is(public.api_read_prepared_capability_claim(pg_temp.claim(1)->>'requestKey'),(select v from fixture where k='claim-entry'),'read exact claim');
select is(public.api_list_prepared_capability_claims(pg_temp.claim(1)->>'windowKey',null,1)#>'{entries,0,input}',(select v from fixture where k='claim-entry'),'window discovery returns original claim');
reset role;
select is((select count(*)::integer from private.capability_runtime_windows),0,'preparation creates no canonical lease');
select throws_ok($$select public.api_prepare_capability_claim(jsonb_set((select v from fixture where k='claim-entry'),'{request,configDigest}',to_jsonb(repeat('b',64))))$$,'23505','Capability claim preparation rejected.','same request changed payload rejected');
select is(public.api_prepare_capability_claim(jsonb_set(jsonb_set((select v from fixture where k='claim-entry'),'{request,requestKey}','"00000000-0000-4000-8000-000000000099"'),'{completionKey}','"10000000-0000-4000-8000-000000000099"'))->>'state','created','same window allows distinct request and completion identities');
select is(public.api_list_prepared_capability_claims(pg_temp.claim(1)->>'windowKey',null,1)->>'hasMore','true','claim discovery reports lookahead');
select is(public.api_list_prepared_capability_claims(pg_temp.claim(1)->>'windowKey',null,1)->>'nextCursor',public.api_list_prepared_capability_claims(pg_temp.claim(1)->>'windowKey',null,1)#>>'{entries,0,cursor}','claim next cursor uses delivered row');
select is(jsonb_array_length(public.api_list_prepared_capability_claims(pg_temp.claim(1)->>'windowKey',public.api_list_prepared_capability_claims(pg_temp.claim(1)->>'windowKey',null,1)->>'nextCursor',1)->'entries'),1,'claim second page contains second request');
select throws_ok($$select public.api_prepare_capability_claim(jsonb_build_object('request',pg_temp.claim(2),'completionKey','10000000-0000-4000-8000-000000000001'))$$,'23505','Capability claim preparation rejected.','completion identity cannot be reserved twice');
insert into fixture select 'receipt',public.api_claim_capability_window(v) from fixture where k='claim';
insert into fixture select 'completion',jsonb_build_object('windowKey',v->>'windowKey','requestKey',pg_temp.claim(1)->>'requestKey',
 'fence',v->>'fence','resourceReleased',true,'completionKey','10000000-0000-4000-8000-000000000001','candidate',pg_temp.candidate(1)) from fixture where k='receipt';
insert into fixture select 'completion-entry',v from fixture where k='completion';
select throws_ok($$select public.api_prepare_capability_completion(jsonb_set((select v from fixture where k='completion-entry'),'{fence}','"ffffffff-ffff-4fff-8fff-ffffffffffff"'))$$,'22023','Capability completion preparation rejected.','completion preparation checks actual fence');
select throws_ok($$select public.api_prepare_capability_completion(jsonb_set((select v from fixture where k='completion-entry'),'{requestKey}','"00000000-0000-4000-8000-000000000099"'))$$,'22023','Capability completion preparation rejected.','completion preparation checks retained owner');
select throws_ok($$select public.api_prepare_capability_completion(jsonb_set((select v from fixture where k='completion-entry'),'{candidate,surface}','"other_surface"'))$$,'22023','Capability completion preparation rejected.','candidate scope must bind retained claim');
create trigger preparation_early_failure after insert on private.capability_completion_preparations for each row execute function pg_temp.fail_early_preparation();
select throws_ok($$select public.api_prepare_capability_completion((select v from fixture where k='completion-entry'))$$,'P0001','Capability completion preparation rejected.','completion post-insert rollback');
select is((select count(*)::integer from private.capability_completion_preparations),0,'completion failed insert leaves no row');
select is((select last_value from pg_temp.preparation_early_marker),2::bigint,'completion failure reached insert');
drop trigger preparation_early_failure on private.capability_completion_preparations;
set local role service_role;
select is(public.api_prepare_capability_completion((select v from fixture where k='completion-entry'))->>'state','created','service prepares exact completion');
select is(public.api_prepare_capability_completion((select v from fixture where k='completion-entry'))->>'state','existing','completion exact replay');
select is(public.api_prepare_capability_completion((select v from fixture where k='completion-entry'))->'retained',(select v from fixture where k='completion-entry'),'ack retains exact completion payload');
select is(public.api_read_prepared_capability_completion('10000000-0000-4000-8000-000000000001'),(select v from fixture where k='completion-entry'),'read exact completion');
reset role;
select is((select coalesce(jsonb_agg(to_jsonb(o) order by o.id),'[]'::jsonb) from private.capability_observations o),
 (select rows from observations_before_preparation),'preparing completion never appends or changes existing observations');
select throws_ok($$select public.api_prepare_capability_completion(jsonb_set((select v from fixture where k='completion-entry'),'{candidate,acceptAttributePresent}','false'))$$,'23505','Capability completion preparation rejected.','changed completion rejected');
select is(public.api_complete_capability_window((select v from fixture where k='completion'))->>'status','completed','only canonical completion appends');
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
insert into fixture select 'attention-entry',v from fixture where k='attention';
set local role service_role;
select is(public.api_prepare_capability_attention((select v from fixture where k='attention-entry'))->>'state','created','service prepares attention');
select is(public.api_prepare_capability_attention((select v from fixture where k='attention-entry'))->>'state','existing','attention exact replay');
select is(public.api_prepare_capability_attention((select v from fixture where k='attention-entry'))->'retained',(select v from fixture where k='attention-entry'),'ack retains exact attention payload');
select is(public.api_read_prepared_capability_attention('20000000-0000-4000-8000-000000000001'),(select v from fixture where k='attention-entry'),'read original attention');
reset role;
select is((select count(*)::integer from private.capability_attention_state),0,'attention preparation never advances CAS');
select is((select count(*)::integer from private.capability_attention_outbox),0,'attention preparation emits no outbox');
select throws_ok($$select public.api_prepare_capability_attention(jsonb_set((select v from fixture where k='attention-entry'),'{expectedVersion}','1'))$$,'23505','Capability attention preparation rejected.','changed evaluation payload rejected');
select throws_ok($$select public.api_prepare_capability_attention(jsonb_set(jsonb_set(jsonb_set((select v from fixture where k='attention-entry'),'{evaluationKey}','"20000000-0000-4000-8000-000000000099"'),'{cursor,scopeKey}',to_jsonb(repeat('f',64))),'{item,key}',to_jsonb('capability:'||repeat('f',64))))$$,'22023','Capability attention preparation rejected.','matching cursor and item keys still must match metadata-derived scope');
select is(public.api_commit_capability_attention((select v from fixture where k='attention'))->>'status','committed','canonical CAS remains sole authority');
select is(public.api_prepare_capability_attention((select v from fixture where k='attention-entry'))->>'state','existing','retained replay survives CAS advance');
-- Change only canonical lease deadline to prove preparation replay does not revalidate time.
update private.capability_runtime_windows set deadline=clock_timestamp()-interval '1 second';
select is(public.api_prepare_capability_claim((select v from fixture where k='claim-entry'))->>'state','existing','claim replay survives canonical expiry');
select is(public.api_prepare_capability_completion((select v from fixture where k='completion-entry'))->>'state','existing','completion replay survives canonical expiry');
-- New evaluation identities at one scope/version must coexist; no version-key pinning.
select is(public.api_prepare_capability_attention(jsonb_set((select v from fixture where k='attention-entry'),'{evaluationKey}',to_jsonb(('20000000-0000-4000-8000-'||lpad(n::text,12,'0')))))->>'state','created','independent evaluation '||n)
 from generate_series(2,12) n;
insert into fixture values ('page',public.api_list_prepared_capability_attention(pg_temp.attention()#>>'{cursor,scopeKey}',null,100));
select is(jsonb_array_length((select v->'entries' from fixture where k='page')),12,'bounded page contains all same-scope identities');
select ok((select bool_and((entry->>'cursor')::bigint > coalesce(previous,0)) from
 (select entry,lag((entry->>'cursor')::bigint) over(order by ord) previous from fixture,
 jsonb_array_elements(v->'entries') with ordinality e(entry,ord) where k='page') q),'cursor order is numeric, including crossing decimal width');
select is((select v->>'hasMore' from fixture where k='page'),'false','terminal attention page has no lookahead');
select is(public.api_list_prepared_capability_attention(pg_temp.attention()#>>'{cursor,scopeKey}',null,1)->>'hasMore','true','attention bounded page reports lookahead');
select is(public.api_list_prepared_capability_attention(pg_temp.attention()#>>'{cursor,scopeKey}',null,1)->>'nextCursor',public.api_list_prepared_capability_attention(pg_temp.attention()#>>'{cursor,scopeKey}',null,1)#>>'{entries,0,cursor}','attention next cursor uses delivered not lookahead row');
select is((select v->>'nextCursor' from fixture where k='page'),(select v#>>'{entries,11,cursor}' from fixture where k='page'),'next cursor is last returned row');
select is(public.api_list_prepared_capability_attention(pg_temp.attention()#>>'{cursor,scopeKey}',(select v->>'nextCursor' from fixture where k='page'),100),' {"entries":[],"nextCursor":null,"hasMore":false}'::jsonb,'exhausted page is empty');
select is(public.api_list_prepared_capability_attention(repeat('f',64),null,100),' {"entries":[],"nextCursor":null,"hasMore":false}'::jsonb,'scope discovery cannot cross scopes');
select throws_ok(format('select public.api_list_prepared_capability_attention(%L,%L,1)',pg_temp.attention()#>>'{cursor,scopeKey}',bad),'22023','Capability attention preparation listing rejected.','reject malformed cursor '||bad)
 from unnest(array['0','01','-1','1.0','9223372036854775808']) bad;
select throws_ok(format('select public.api_list_prepared_capability_attention(%L,null,%s)',pg_temp.attention()#>>'{cursor,scopeKey}',n),'22023','Capability attention preparation listing rejected.','reject limit '||n) from unnest(array[0,101]) n;
-- Inject an AFTER INSERT error: no partial immutable row may survive.
create temporary sequence preparation_failure_marker;
create function pg_temp.fail_preparation() returns trigger language plpgsql as $$begin perform nextval('pg_temp.preparation_failure_marker');raise exception 'preparation fixture rollback';end$$;
create trigger preparation_failure after insert on private.capability_attention_preparations for each row execute function pg_temp.fail_preparation();
select throws_ok($$select public.api_prepare_capability_attention(jsonb_set((select v from fixture where k='attention-entry'),'{evaluationKey}','"20000000-0000-4000-8000-000000000099"'))$$,'P0001','Capability attention preparation rejected.','post-insert failure propagates');
select ok((select is_called from pg_temp.preparation_failure_marker),'injection actually reached');
select is(public.api_read_prepared_capability_attention('20000000-0000-4000-8000-000000000099'),null::jsonb,'failed insertion rolls back retained row');
drop trigger preparation_failure on private.capability_attention_preparations;
select is((select count(*)::integer from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private' and c.relname=any(array['capability_claim_preparations','capability_completion_preparations','capability_attention_preparations']) and c.relrowsecurity and c.relforcerowsecurity),3,'three private forced RLS tables');
select ok(not has_table_privilege(r,'private.'||t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'),r||' no direct table rights '||t) from unnest(array['anon','authenticated','service_role']) r cross join unnest(array['capability_claim_preparations','capability_completion_preparations','capability_attention_preparations']) t;
select ok(not has_sequence_privilege(r,'private.capability_preparation_cursor_seq','USAGE,SELECT,UPDATE'),r||' cannot reserve cursor') from unnest(array['anon','authenticated','service_role']) r;
select ok(not has_function_privilege(r,p.oid,'EXECUTE'),r||' no private preparation helper '||p.proname) from pg_proc p join pg_namespace n on n.oid=p.pronamespace cross join unnest(array['anon','authenticated','service_role']) r where n.nspname='private' and p.proname like 'capability_preparation_%';
select ok(seqcache=1 and not seqcycle,'cursor sequence CACHE 1 NO CYCLE') from pg_sequence where seqrelid='private.capability_preparation_cursor_seq'::regclass;
select is((select count(*)::integer from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=any(array['api_prepare_capability_claim','api_read_prepared_capability_claim','api_list_prepared_capability_claims','api_prepare_capability_completion','api_read_prepared_capability_completion','api_prepare_capability_attention','api_read_prepared_capability_attention','api_list_prepared_capability_attention'])),8,'eight public RPCs without overloads');
select ok(has_function_privilege('service_role',p.oid,'EXECUTE') and p.prosecdef and p.proconfig @> array['search_path=pg_catalog'],'service fixed path '||p.proname) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=any(array['api_prepare_capability_claim','api_read_prepared_capability_claim','api_list_prepared_capability_claims','api_prepare_capability_completion','api_read_prepared_capability_completion','api_prepare_capability_attention','api_read_prepared_capability_attention','api_list_prepared_capability_attention']);
select ok(not has_function_privilege(r,p.oid,'EXECUTE'),r||' denied '||p.proname) from pg_proc p join pg_namespace n on n.oid=p.pronamespace cross join unnest(array['anon','authenticated']) r where n.nspname='public' and p.proname=any(array['api_prepare_capability_claim','api_read_prepared_capability_claim','api_list_prepared_capability_claims','api_prepare_capability_completion','api_read_prepared_capability_completion','api_prepare_capability_attention','api_read_prepared_capability_attention','api_list_prepared_capability_attention']);
set local role service_role;
select throws_ok($$select * from private.capability_claim_preparations$$,'42501',null,'actual direct service read denied');
select throws_ok($$select nextval('private.capability_preparation_cursor_seq')$$,'42501',null,'actual service cursor allocation denied');
reset role;
set local role anon;
select throws_ok($$select public.api_prepare_capability_claim('{}')$$,'42501',null,'actual anonymous RPC denied');
reset role;
set local role authenticated;
select throws_ok($$select public.api_list_prepared_capability_attention(repeat('a',64),null,1)$$,'42501',null,'actual authenticated discovery denied');
reset role;
select is(public.api_read_prepared_capability_claim('ffffffff-ffff-4fff-8fff-ffffffffffff'),null::jsonb,'absent claim returns null');
select is(public.api_read_prepared_capability_completion('ffffffff-ffff-4fff-8fff-ffffffffffff'),null::jsonb,'absent completion returns null');
select is(public.api_read_prepared_capability_attention('ffffffff-ffff-4fff-8fff-ffffffffffff'),null::jsonb,'absent evaluation returns null');

-- RSR-2: malformed calls run as the authorized service, so denial cannot mask validation.
create temporary table rejected_preparation(operation text, label text, payload jsonb);
insert into rejected_preparation
select operation,label,payload from unnest(array['claim','completion','attention']) operation
cross join (values ('SQL NULL',null::jsonb),('JSON null','null'::jsonb),('array','[]'::jsonb),
 ('boolean','true'::jsonb),('number','1'::jsonb),('string','"private-diagnostic"'::jsonb),('missing keys','{}'::jsonb)) cases(label,payload);
insert into rejected_preparation
select operation,'oversized diagnostic',v||jsonb_build_object('diagnostic',repeat('private-value',1500))
from (values ('claim','claim-entry'),('completion','completion-entry'),('attention','attention-entry')) kinds(operation,k)
join fixture using(k);
insert into rejected_preparation
select operation,'required null '||field,jsonb_set(v,array[field],'null')
from (values ('claim','claim-entry',array['request','completionKey']),
 ('completion','completion-entry',array['windowKey','requestKey','fence','completionKey','resourceReleased','candidate']),
 ('attention','attention-entry',array['expectedVersion','evaluationKey','cursor','item'])) kinds(operation,k,fields)
join fixture using(k) cross join lateral unnest(fields) field;
insert into rejected_preparation
select 'claim','lease type/range '||bad::text,jsonb_set((select v from fixture where k='claim-entry'),'{request,leaseSeconds}',bad)
from unnest(array['"2"'::jsonb,'true','null','[]','{}','1.5','0','301','9007199254740992']) bad;
insert into rejected_preparation
select 'attention','version type/range '||bad::text,jsonb_set((select v from fixture where k='attention-entry'),'{expectedVersion}',bad)
from unnest(array['"0"'::jsonb,'true','null','[]','{}','0.5','-1','9007199254740991']) bad;
insert into rejected_preparation
select 'completion','release wrong type '||bad::text,jsonb_set((select v from fixture where k='completion-entry'),'{resourceReleased}',bad)
from unnest(array['"true"'::jsonb,'1','null','[]','{}','false']) bad;
insert into rejected_preparation
select 'completion','extensions wrong type '||bad::text,jsonb_set((select v from fixture where k='completion-entry'),'{candidate,extensions}',bad)
from unnest(array['"step"'::jsonb,'null','{}','[1]','[null]']) bad;
insert into rejected_preparation
select 'claim','invalid datetime '||bad,jsonb_set((select v from fixture where k='claim-entry'),'{request,windowStart}',to_jsonb(bad))
from unnest(array['infinity','2026-02-30T12:00:00.000Z','2026-10-02T12:00:00+03:00','private://diagnostic']) bad;
insert into rejected_preparation
select operation,'unexpected diagnostic key',v||jsonb_build_object('diagnostic','private-value')
from (values ('claim','claim-entry'),('completion','completion-entry'),('attention','attention-entry')) kinds(operation,k) join fixture using(k);
insert into rejected_preparation values ('completion','oversized array',jsonb_set((select v from fixture where k='completion-entry'),'{candidate,extensions}',(select jsonb_agg('step'::text) from generate_series(1,101))));
create temporary table preparation_counts as select
 (select count(*) from private.capability_claim_preparations) claims,
 (select count(*) from private.capability_completion_preparations) completions,
 (select count(*) from private.capability_attention_preparations) attention,
 (select count(*) from private.capability_runtime_windows) windows,
 (select count(*) from private.capability_observations) observations,
 (select jsonb_agg(to_jsonb(t)) from private.capability_attention_state t) attention_state,
 (select count(*) from private.capability_attention_outbox) outbox;
grant select on rejected_preparation to service_role;
set local role service_role;
select throws_ok(format('select public.api_prepare_capability_%I(%L::jsonb)',operation,payload),
 '22023','Capability '||operation||' preparation rejected.',operation||' rejects '||label) from rejected_preparation;
select throws_ok(format('select public.api_read_prepared_capability_%I(%L::text)',operation,bad),
 '22023','Capability '||operation||' preparation read rejected.',operation||' read rejects '||coalesce(bad,'SQL NULL'))
from unnest(array['claim','completion','attention']) operation cross join unnest(array[null::text,'','1','NULL','ffffffff-ffff-4fff-8fff-fffffffffffz']) bad;
select throws_ok(format('select public.api_list_prepared_capability_claims(%L::text,%L::text,%L::integer)',window_key,after_cursor,page_limit),
 '22023','Capability claim preparation listing rejected.','claim page rejects '||label)
from (values ('null window',null::text,null::text,1),('null limit','canary:'||repeat('a',64),null,null),
 ('zero cursor','canary:'||repeat('a',64),'0',1),('leading zero','canary:'||repeat('a',64),'01',1),
 ('overflow','canary:'||repeat('a',64),'9223372036854775808',1),('fraction','canary:'||repeat('a',64),'1.5',1),
 ('limit overflow','canary:'||repeat('a',64),null,101)) cases(label,window_key,after_cursor,page_limit);
select throws_ok(format('select public.api_list_prepared_capability_attention(%L::text,%L::text,%L::integer)',scope_key,after_cursor,page_limit),
 '22023','Capability attention preparation listing rejected.','attention page rejects '||label)
from (values ('null scope',null::text,null::text,1),('null limit',repeat('a',64),null,null),
 ('zero cursor',repeat('a',64),'0',1),('leading zero',repeat('a',64),'01',1),
 ('overflow',repeat('a',64),'9223372036854775808',1),('fraction',repeat('a',64),'1.5',1),
 ('limit overflow',repeat('a',64),null,101)) cases(label,scope_key,after_cursor,page_limit);
-- Reordered object construction is semantically identical JSONB; retained values remain exact.
select is(public.api_prepare_capability_claim(jsonb_build_object('completionKey',(select v->'completionKey' from fixture where k='claim-entry'),
 'request',(select v->'request' from fixture where k='claim-entry')))->>'state','existing','object key reorder replays');
select throws_ok($$select public.api_prepare_capability_claim(jsonb_set((select v from fixture where k='claim-entry'),'{request,windowKey}',to_jsonb('canary:'||repeat('e',64))))$$,
 '23505','Capability claim preparation rejected.','request identity cannot be reused across windows');
select throws_ok($$select public.api_prepare_capability_claim(jsonb_set((select v from fixture where k='claim-entry'),'{request,windowStart}',to_jsonb(replace(pg_temp.claim(1)->>'windowStart','Z','+00:00'))))$$,
 '23505','Capability claim preparation rejected.','equivalent instant with different spelling is a changed payload');
select throws_ok($$select public.api_prepare_capability_completion(jsonb_set((select v from fixture where k='completion-entry'),'{candidate,extensions}','["step","stp"]'))$$,
 '23505','Capability completion preparation rejected.','changed valid array conflicts');
select throws_ok($$select public.api_prepare_capability_attention(jsonb_set((select v from fixture where k='attention-entry'),'{expectedVersion}','1'))$$,
 '23505','Capability attention preparation rejected.','changed typed version conflicts');
reset role;
select ok((select claims=(select count(*) from private.capability_claim_preparations)
 and completions=(select count(*) from private.capability_completion_preparations)
 and attention=(select count(*) from private.capability_attention_preparations)
 and windows=(select count(*) from private.capability_runtime_windows)
 and observations=(select count(*) from private.capability_observations)
 and attention_state is not distinct from (select jsonb_agg(to_jsonb(t)) from private.capability_attention_state t)
 and outbox=(select count(*) from private.capability_attention_outbox) from preparation_counts),'rejections and replay leave retained and canonical authority state unchanged');

-- RSR-1: strictly disposable owner setup, transactional RESTART (never setval).
-- No grant changes. The outer fixture ROLLBACK removes all rows and rolls back RESTART.
-- Keep TAP assertions in the outer transaction so their bookkeeping survives until finish().
-- These SQL statements are qualification source only, not permission to execute them.
alter sequence private.capability_preparation_cursor_seq restart with 9007199254740992;
select is(public.api_prepare_capability_claim(jsonb_set(jsonb_set((select v from fixture where k='claim-entry'),
 '{request,requestKey}',to_jsonb('40000000-0000-4000-8000-'||lpad(n::text,12,'0'))),
 '{completionKey}',to_jsonb('50000000-0000-4000-8000-'||lpad(n::text,12,'0'))))->>'state','created','large claim entry '||n)
 from generate_series(1,101) n;
select is(public.api_prepare_capability_attention(jsonb_set((select v from fixture where k='attention-entry'),
 '{evaluationKey}',to_jsonb('60000000-0000-4000-8000-'||lpad(n::text,12,'0'))))->>'state','created','large attention entry '||n)
 from generate_series(1,101) n;
create temporary table large_page(kind text primary key, first_page jsonb, second_page jsonb);
insert into large_page values
 ('claim',public.api_list_prepared_capability_claims(pg_temp.claim(1)->>'windowKey','9007199254740991',100),null),
 ('attention',public.api_list_prepared_capability_attention(pg_temp.attention()#>>'{cursor,scopeKey}','9007199254740991',100),null);
update large_page set second_page=case kind when 'claim' then public.api_list_prepared_capability_claims(pg_temp.claim(1)->>'windowKey',first_page->>'nextCursor',100)
 else public.api_list_prepared_capability_attention(pg_temp.attention()#>>'{cursor,scopeKey}',first_page->>'nextCursor',100) end;
select is(jsonb_array_length(first_page->'entries'),100,kind||' delivers full 100-row page') from large_page;
select is(first_page->>'hasMore','true',kind||' reports 101st row lookahead') from large_page;
select is(first_page->>'nextCursor',first_page#>>'{entries,99,cursor}',kind||' next cursor is delivered row 100') from large_page;
select is(jsonb_array_length(second_page->'entries'),1,kind||' delivers final row') from large_page;
select is(second_page->>'hasMore','false',kind||' terminal page has no lookahead') from large_page;
select is(second_page->>'nextCursor',second_page#>>'{entries,0,cursor}',kind||' terminal cursor remains delivered row') from large_page;
select is((second_page#>>'{entries,0,cursor}')::bigint,(first_page->>'nextCursor')::bigint+1,kind||' adjacent large continuation preserves exact integer') from large_page;
select is(first_page#>>'{entries,0,cursor}',case kind when 'claim' then '9007199254740992' else '9007199254741093' end,kind||' starts at exact large string') from large_page;
select ok((select bool_and(jsonb_typeof(e->'cursor')='string' and (e->>'cursor')::bigint=case kind when 'claim' then 9007199254740991::bigint else 9007199254741092::bigint end+ord)
 from jsonb_array_elements(first_page->'entries') with ordinality vals(e,ord)),kind||' every high cursor is lossless numeric-order JSON string') from large_page;
select ok((select bool_and(case kind when 'claim' then e#>>'{input,request,windowKey}'=pg_temp.claim(1)->>'windowKey'
 else e#>>'{input,cursor,scopeKey}'=pg_temp.attention()#>>'{cursor,scopeKey}' end)
 from jsonb_array_elements(first_page->'entries') e),kind||' full page stays in exact discovery scope') from large_page;
select is(case kind when 'claim' then public.api_list_prepared_capability_claims(pg_temp.claim(1)->>'windowKey',second_page->>'nextCursor',100)
 else public.api_list_prepared_capability_attention(pg_temp.attention()#>>'{cursor,scopeKey}',second_page->>'nextCursor',100) end,
 '{"entries":[],"nextCursor":null,"hasMore":false}'::jsonb,kind||' exhausts without duplicate delivery') from large_page;
select is(public.api_list_prepared_capability_claims('canary:'||repeat('f',64),'9007199254740991',100),'{"entries":[],"nextCursor":null,"hasMore":false}'::jsonb,'large claim discovery isolates other window');
select is(public.api_list_prepared_capability_attention(repeat('f',64),'9007199254740991',100),'{"entries":[],"nextCursor":null,"hasMore":false}'::jsonb,'large attention discovery isolates other scope');
select ok((select count(*)=103 from private.capability_claim_preparations),'only original and 101 large-page claim identities retained');
select * from finish();
rollback;
