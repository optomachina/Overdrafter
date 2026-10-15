-- DRAFT, NOT EXECUTED. Source-derived probes; incomplete old-worker gate.
-- All application calls and matrix DML below execute as the native service_role.
-- Only auth/organization setup and pg_temp fixture storage are owned by postgres.
-- Faithful old-scope behavior is isolated in old_scope.sql; publication remains incompatible.
begin;
set local search_path = public, extensions;
set local timezone = 'UTC';
select no_plan();
create function pg_temp.worker_fixture_id(p_suffix integer) returns uuid
language sql immutable as $$
  select ('ec420003-1100-4000-8000-' || lpad(p_suffix::text, 12, '0'))::uuid;
$$;
grant execute on function pg_temp.worker_fixture_id(integer) to service_role;
create temporary table worker_probe_results (name text primary key, body jsonb) on commit drop;
grant select, insert, update on pg_temp.worker_probe_results to service_role;

-- Refuse to claim any unrelated work. This suite is for a clean disposable
-- schema replay; it must never be pointed at a production database.
do $$ begin
  if exists (select 1 from public.work_queue where status='queued' and available_at<=now()) then
    raise exception 'Worker compatibility fixture requires an empty ready queue';
  end if;
  if exists (select 1 from public.spend_ledger) then
    raise exception 'Worker compatibility fixture requires an empty spend ledger';
  end if;
end $$;
insert into auth.users (id,aud,role,email,email_confirmed_at,raw_app_meta_data)
values (pg_temp.worker_fixture_id(1),'authenticated','authenticated','worker-contract@example.test',now(),'{"provider":"email"}');
insert into public.organizations (id,name,slug)
values (pg_temp.worker_fixture_id(2),'Worker compatibility synthetic fixture','worker-contract-ec420003');

select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
select is(current_user::text, 'service_role', 'synthetic operations use the native service role');
select is(auth.role(), 'service_role', 'trusted RPCs see the worker role claim');
select is(auth.uid(), null::uuid, 'worker identity has no impersonated user subject');

insert into public.jobs (id,organization_id,created_by,title,status,requested_service_kinds)
values (pg_temp.worker_fixture_id(10),pg_temp.worker_fixture_id(2),pg_temp.worker_fixture_id(1),
  'Synthetic worker compatibility','uploaded',array['manufacturing_quote']);
insert into public.parts (id,job_id,organization_id,name,normalized_key,quantity)
values (pg_temp.worker_fixture_id(20),pg_temp.worker_fixture_id(10),pg_temp.worker_fixture_id(2),'Synthetic source','synthetic-source',1);
insert into public.approved_part_requirements
(part_id,organization_id,approved_by,description,part_number,revision,material,finish,tightest_tolerance_inch,quantity,quote_quantities,requested_by_date,applicable_vendors,spec_snapshot)
values (pg_temp.worker_fixture_id(20),pg_temp.worker_fixture_id(2),pg_temp.worker_fixture_id(1),
  'Synthetic part','WCF-1','A','6061-T6 Aluminum','As machined',0.0050,2,array[2],null,array['xometry']::public.vendor_name[],
  '{"process":"CNC milling","notes":"synthetic","shipping":{},"certifications":{},"sourcing":{},"release":{}}');
select is((select count(*)::integer from public.approved_part_requirements where part_id=pg_temp.worker_fixture_id(20)), 1,
  'requirements query has exactly one row');
select is(public.api_auto_approve_job_requirements(p_job_id=>pg_temp.worker_fixture_id(10)),1,
  'named auto-approval returns a positive integer scalar');
select is((select status::text from public.jobs where id=pg_temp.worker_fixture_id(10)), 'ready_to_quote', 'auto-approval updates job status');
select is((select quantity from public.parts where id=pg_temp.worker_fixture_id(20)),2,'auto-approval applies requirement quantity');
select throws_ok($$select public.api_auto_approve_job_requirements(p_job_id=>pg_temp.worker_fixture_id(999))$$,
  'P0001', null, 'missing auto-approval job propagates an error');
select throws_ok($$select public.api_auto_approve_job_requirements(p_job_id=>null)$$,
  'P0001', null, 'explicit null job does not invoke a default or return successful approval');

-- Queue write/read behavior mirrors matrix-listed columns and the inspected
-- archived worker receipt, whose exact hash is recorded in source-contract.json.
insert into public.work_queue (id,organization_id,job_id,part_id,quote_run_id,package_id,task_type,status,payload,attempts,available_at)
values (pg_temp.worker_fixture_id(40),pg_temp.worker_fixture_id(2),pg_temp.worker_fixture_id(10),pg_temp.worker_fixture_id(20),
  null,null,'generate_cad_preview','queued','{"jobId":"ec420003-1100-4000-8000-000000000010","fixture":true}',0,now()-interval '1 minute');
insert into pg_temp.worker_probe_results
select 'claim', to_jsonb(task) from public.api_claim_next_task(p_worker_name=>'worker-compatibility') task;
select is((select count(*)::integer from pg_temp.worker_probe_results where name='claim'),1,'claim yields exactly one record');
select ok((select body ?& array['id','organization_id','job_id','part_id','quote_run_id','package_id','task_type','status','payload','attempts','available_at','locked_at','locked_by','last_error','created_at','updated_at']
  from pg_temp.worker_probe_results where name='claim'),'claim keeps the complete inspected queue record fields');
select is((select body->>'id' from pg_temp.worker_probe_results where name='claim'),pg_temp.worker_fixture_id(40)::text,'claim returns the synthetic task');
select is((select body->'attempts' from pg_temp.worker_probe_results where name='claim'),'1'::jsonb,'attempts serializes as a JSON number');
select is((select body->>'status' from pg_temp.worker_probe_results where name='claim'),'running','claim changes status to running');
select is((select body->>'locked_by' from pg_temp.worker_probe_results where name='claim'),'worker-compatibility','claim binds the worker lock');
select is((select count(*)::integer from public.api_claim_next_task(p_worker_name=>'worker-compatibility')),0,'empty queue yields zero rows for maybeSingle');
select is((select count(*)::integer from public.api_claim_next_task(p_worker_name=>null)),0,'explicit null worker name resolves the single overload and has no empty-queue side effect');
update public.work_queue set status='completed',payload=payload||'{"completed":true}',locked_at=null,locked_by=null,last_error=null
where id=pg_temp.worker_fixture_id(40) and status<>'cancelled';
select is((select status::text from public.work_queue where id=pg_temp.worker_fixture_id(40)),'completed','conditional completion DML succeeds');
update public.work_queue set status='failed',payload=payload||'{"failed":true}',locked_at=null,locked_by=null,last_error='synthetic failure'
where id=pg_temp.worker_fixture_id(40) and status<>'cancelled';
select is((select last_error from public.work_queue where id=pg_temp.worker_fixture_id(40)),'synthetic failure','conditional failure DML succeeds');
update public.work_queue set status='queued',available_at=now()+interval '1 hour',locked_at=null,locked_by=null,last_error='synthetic retry',payload=payload||'{"retry":true}'
where id=pg_temp.worker_fixture_id(40);
select is((select count(*)::integer from public.api_claim_next_task(p_worker_name=>'worker-compatibility')),0,'future retry is unavailable to claim');
update public.work_queue set status='running',locked_at=now()-interval '20 minutes',locked_by='stale-worker' where id=pg_temp.worker_fixture_id(40);
with reaped as (update public.work_queue set status='failed',locked_at=null,locked_by=null,last_error='worker_crash_recovery'
  where id=pg_temp.worker_fixture_id(40) and status='running' and locked_at<now()-interval '10 minutes' returning id)
select is(count(*)::integer,1,'stale reaping DML returns one recovered task') from reaped;
update public.work_queue set status='cancelled' where id=pg_temp.worker_fixture_id(40);
with changed as (update public.work_queue set status='completed' where id=pg_temp.worker_fixture_id(40) and status<>'cancelled' returning id)
select is(count(*)::integer,0,'completion leaves cancelled task untouched') from changed;
with changed as (update public.work_queue set status='failed' where id=pg_temp.worker_fixture_id(40) and status<>'cancelled' returning id)
select is(count(*)::integer,0,'failure leaves cancelled task untouched') from changed;
select ok((select payload @> '{"fixture":true,"completed":true,"failed":true,"retry":true}' from public.work_queue where id=pg_temp.worker_fixture_id(40)),
  'queue JSON payload survives the lifecycle writes');

-- Reserve never starts real model/provider work. Ledger entries are rolled back.
insert into pg_temp.worker_probe_results values ('reserve-null-org', public.api_reserve_spend(
  p_organization_id=>null,p_category=>'llm_extraction',p_estimated_usd=>0.001,
  p_context=>'{"jobId":null,"partId":null,"quoteRunId":null,"taskId":null,"provider":null,"modelName":null}'::jsonb));
select is((select jsonb_typeof(body) from pg_temp.worker_probe_results where name='reserve-null-org'),'object','reserve returns an object');
select is((select body->'allowed' from pg_temp.worker_probe_results where name='reserve-null-org'),'true'::jsonb,'null organization reserve is strictly allowed');
select ok((select (body->>'reservationId')::uuid is not null from pg_temp.worker_probe_results where name='reserve-null-org'),'reservation identifier is a nonempty UUID string');
select is((select amount_usd from public.spend_ledger where id=(select (body->>'reservationId')::uuid from pg_temp.worker_probe_results where name='reserve-null-org')),
  0.001::numeric,'reservation preserves the numeric estimate');
select is((select metadata from public.spend_ledger where id=(select (body->>'reservationId')::uuid from pg_temp.worker_probe_results where name='reserve-null-org')),
  '{"jobId":null,"partId":null,"quoteRunId":null,"taskId":null,"provider":null,"modelName":null}'::jsonb,'explicit nullable context keys survive');
insert into pg_temp.worker_probe_results values ('reserve-org', public.api_reserve_spend(
  p_organization_id=>pg_temp.worker_fixture_id(2),p_category=>'vendor_automation',p_estimated_usd=>0.002,
  p_context=>jsonb_build_object('jobId',pg_temp.worker_fixture_id(10),'partId',pg_temp.worker_fixture_id(20),
    'quoteRunId',null,'taskId',pg_temp.worker_fixture_id(40),'provider','xometry','modelName',null)));
select is((select body->'allowed' from pg_temp.worker_probe_results where name='reserve-org'),'true'::jsonb,'vendor automation category succeeds');
insert into public.spend_caps (organization_id,daily_ceiling_usd,per_run_ceiling_usd,kill_switch)
values (pg_temp.worker_fixture_id(2),50,0.5,true);
insert into pg_temp.worker_probe_results values ('reserve-denied', public.api_reserve_spend(
  p_organization_id=>pg_temp.worker_fixture_id(2),p_category=>'vendor_automation',p_estimated_usd=>0.002,p_context=>'{}'));
select is((select body->'allowed' from pg_temp.worker_probe_results where name='reserve-denied'),'false'::jsonb,'kill switch denial is a strict boolean');
select is((select body->>'reasonCode' from pg_temp.worker_probe_results where name='reserve-denied'),'kill_switch','denial preserves a machine-readable reason');
select ok((select length(body->>'reason')>0 and body->'reservationId'='null'::jsonb from pg_temp.worker_probe_results where name='reserve-denied'),'denial has human reason and no reservation');
select throws_ok($$select public.api_reserve_spend(p_organization_id=>null,p_category=>'unsupported',p_estimated_usd=>0.001,p_context=>'{}')$$,
  'P0001', 'Unsupported spend category: unsupported', 'unsupported category raises instead of approving');
select throws_ok($$select public.api_reserve_spend(p_organization_id=>null,p_category=>'llm_extraction',p_estimated_usd=>0.001,p_context=>'{"jobId":"not-a-uuid"}')$$,
  '22P02', null, 'malformed context propagates SQL failure and remains fail-closed');
select is((select count(*)::integer from public.spend_ledger),2,'denial and failed reservation do not insert ledger rows');
insert into pg_temp.worker_probe_results values ('settle', public.api_settle_spend(
  p_reservation_id=>(select (body->>'reservationId')::uuid from pg_temp.worker_probe_results where name='reserve-null-org'),
  p_actual_usd=>0,p_metadata=>'{}'));
select is((select body->'settled' from pg_temp.worker_probe_results where name='settle'),'true'::jsonb,'normalized zero settlement succeeds');
select is((select amount_usd from public.spend_ledger where id=(select (body->>'reservationId')::uuid from pg_temp.worker_probe_results where name='reserve-null-org')),
  0::numeric,'settlement releases the estimate');
select is(public.api_settle_spend(p_reservation_id=>null,p_actual_usd=>0,p_metadata=>'{}')->>'reasonCode',
  'unknown_or_already_settled','null/unknown settlement keeps documented benign result');
select is(public.api_settle_spend(p_reservation_id=>(select (body->>'reservationId')::uuid from pg_temp.worker_probe_results where name='reserve-null-org'),
  p_actual_usd=>0,p_metadata=>'{}')->>'reasonCode','unknown_or_already_settled','repeat settlement keeps documented result');

-- Staged file metadata only: there is no storage object or downloaded file.
insert into public.job_files (id,job_id,organization_id,uploaded_by,storage_path,original_name,normalized_name,file_kind,size_bytes,content_sha256)
values (pg_temp.worker_fixture_id(30),pg_temp.worker_fixture_id(10),pg_temp.worker_fixture_id(2),pg_temp.worker_fixture_id(1),
  'worker-contract/source.step','source.step','source','cad',100,repeat('a',64));
update public.parts set cad_file_id=pg_temp.worker_fixture_id(30) where id=pg_temp.worker_fixture_id(20);
select is(public.api_resolve_trusted_part_intake(p_part_id=>pg_temp.worker_fixture_id(20))->>'result','pending_verification','untrusted staged file cannot be reused');
select lives_ok($$select public.api_register_trusted_file_hash(p_job_file_id=>pg_temp.worker_fixture_id(30),p_content_sha256=>repeat('a',64))$$,
  'valid lowercase 64-hex trusted hash registers through named arguments');
select is((select trusted_content_sha256 from public.job_files where id=pg_temp.worker_fixture_id(30)),repeat('a',64),'trusted hash write persists');
select throws_ok($$select public.api_register_trusted_file_hash(p_job_file_id=>pg_temp.worker_fixture_id(30),p_content_sha256=>'bad')$$,
  'P0001','A valid SHA-256 hash is required.','invalid hash blocks trust');
select throws_ok($$select public.api_register_trusted_file_hash(p_job_file_id=>pg_temp.worker_fixture_id(30),p_content_sha256=>repeat('b',64))$$,
  'P0001','Trusted file hash conflicts with previously verified content.','conflicting trusted content cannot be overwritten');
select throws_ok($$select public.api_register_trusted_file_hash(p_job_file_id=>null,p_content_sha256=>repeat('a',64))$$,
  'P0001',null,'missing file blocks trust');
select throws_ok($$select public.api_register_trusted_file_hash(p_job_file_id=>pg_temp.worker_fixture_id(30),p_content_sha256=>null)$$,
  'P0001','A valid SHA-256 hash is required.','explicit null hash does not gain a default');
select throws_ok($$select public.api_resolve_trusted_part_intake(p_part_id=>null)$$,
  'P0001',null,'runtime explicit null part propagates error');
insert into public.job_files (id,job_id,organization_id,uploaded_by,storage_path,original_name,normalized_name,file_kind,size_bytes,content_sha256)
values (pg_temp.worker_fixture_id(31),pg_temp.worker_fixture_id(10),pg_temp.worker_fixture_id(2),pg_temp.worker_fixture_id(1),
  'worker-contract/target.step','target.step','target','cad',100,repeat('a',64));
select public.api_register_trusted_file_hash(p_job_file_id=>pg_temp.worker_fixture_id(31),p_content_sha256=>repeat('a',64));
insert into public.parts (id,job_id,organization_id,name,normalized_key,cad_file_id)
values (pg_temp.worker_fixture_id(21),pg_temp.worker_fixture_id(10),pg_temp.worker_fixture_id(2),'Synthetic target','synthetic-target',pg_temp.worker_fixture_id(31));
insert into pg_temp.worker_probe_results values ('intake',public.api_resolve_trusted_part_intake(p_part_id=>pg_temp.worker_fixture_id(21)));
select is((select jsonb_typeof(body) from pg_temp.worker_probe_results where name='intake'),'object','intake is a JSON object');
select is((select body->>'result' from pg_temp.worker_probe_results where name='intake'),'existing_version','verified exact duplicate resolves existing version');
select is((select body->>'sourcePartId' from pg_temp.worker_probe_results where name='intake'),pg_temp.worker_fixture_id(20)::text,'existing version has nonempty exact source identity');
select ok((select (body->>'partVersionId')::uuid is not null from pg_temp.worker_probe_results where name='intake'),'existing version has nonempty UUID version identity');
insert into pg_temp.worker_probe_results values ('reuse-unavailable',public.api_reuse_trusted_part_version_artifacts(
  p_target_part_id=>pg_temp.worker_fixture_id(21),p_source_part_id=>pg_temp.worker_fixture_id(20),
  p_part_version_id=>(select (body->>'partVersionId')::uuid from pg_temp.worker_probe_results where name='intake')));
select is((select body->'artifactsReady' from pg_temp.worker_probe_results where name='reuse-unavailable'),'false'::jsonb,'unavailable source returns boolean false');
select is((select body->'extractTargetIndependently' from pg_temp.worker_probe_results where name='reuse-unavailable'),'true'::jsonb,'unavailable source requests independent extraction with boolean true');
insert into public.work_queue(id,organization_id,job_id,part_id,task_type,status,payload)
values(pg_temp.worker_fixture_id(41),pg_temp.worker_fixture_id(2),pg_temp.worker_fixture_id(10),pg_temp.worker_fixture_id(20),'extract_part','running','{}');
insert into pg_temp.worker_probe_results values ('reuse-pending',public.api_reuse_trusted_part_version_artifacts(
  p_target_part_id=>pg_temp.worker_fixture_id(21),p_source_part_id=>pg_temp.worker_fixture_id(20),
  p_part_version_id=>(select (body->>'partVersionId')::uuid from pg_temp.worker_probe_results where name='intake')));
select is((select body->'artifactsReady' from pg_temp.worker_probe_results where name='reuse-pending'),'false'::jsonb,'running source extraction returns boolean false readiness');
select is((select body->'extractTargetIndependently' from pg_temp.worker_probe_results where name='reuse-pending'),'false'::jsonb,'running source extraction suppresses duplicate work with boolean false');
update public.work_queue set status='completed' where id=pg_temp.worker_fixture_id(41);
insert into public.drawing_extractions(part_id,organization_id,extraction,status)
values(pg_temp.worker_fixture_id(20),pg_temp.worker_fixture_id(2),'{"fixture":true}','approved');
insert into pg_temp.worker_probe_results values ('reuse-ready',public.api_reuse_trusted_part_version_artifacts(
  p_target_part_id=>pg_temp.worker_fixture_id(21),p_source_part_id=>pg_temp.worker_fixture_id(20),
  p_part_version_id=>(select (body->>'partVersionId')::uuid from pg_temp.worker_probe_results where name='intake')));
select is((select body->'artifactsReady' from pg_temp.worker_probe_results where name='reuse-ready'),'true'::jsonb,'ready reuse uses strict JSON boolean true');
select ok((select body->'extractTargetIndependently' is null from pg_temp.worker_probe_results where name='reuse-ready'),'success omits independent-extraction flag as documented by the SQL source');
select is((select count(*)::integer from public.drawing_extractions where part_id=pg_temp.worker_fixture_id(21)),1,'successful reuse materializes the target extraction');
select throws_ok($$select public.api_reuse_trusted_part_version_artifacts(p_target_part_id=>null,p_source_part_id=>null,p_part_version_id=>null)$$,
  'P0001','The trusted part reuse lineage is invalid.','null reuse lineage fails closed');

-- Existing result row is mandatory before lane registration or authorization.
insert into public.quote_requests(id,organization_id,job_id,requested_by,status,requested_vendors)
values(pg_temp.worker_fixture_id(50),pg_temp.worker_fixture_id(2),pg_temp.worker_fixture_id(10),pg_temp.worker_fixture_id(1),'queued',array['xometry']::public.vendor_name[]);
insert into public.quote_runs(id,job_id,organization_id,initiated_by,status,quote_request_id)
values(pg_temp.worker_fixture_id(51),pg_temp.worker_fixture_id(10),pg_temp.worker_fixture_id(2),pg_temp.worker_fixture_id(1),'queued',pg_temp.worker_fixture_id(50));
select throws_ok($$insert into public.quote_runs(id,job_id,organization_id,initiated_by,quote_request_id)
  values(pg_temp.worker_fixture_id(52),pg_temp.worker_fixture_id(10),pg_temp.worker_fixture_id(2),pg_temp.worker_fixture_id(1),pg_temp.worker_fixture_id(50))$$,
  '23505',null,'duplicate quote run for one request violates at-most-one cardinality');
insert into public.vendor_quote_results(id,quote_run_id,part_id,organization_id,vendor,requested_quantity,status,notes,raw_payload)
values(pg_temp.worker_fixture_id(60),pg_temp.worker_fixture_id(51),pg_temp.worker_fixture_id(20),pg_temp.worker_fixture_id(2),
  'xometry',2,'running','["synthetic note"]','{"fixture":true}');
select is((select count(*)::integer from public.vendor_quote_results where quote_run_id=pg_temp.worker_fixture_id(51)
  and part_id=pg_temp.worker_fixture_id(20) and vendor='xometry' and requested_quantity=2),1,'worker result filters identify exactly one existing row');
select is((select jsonb_typeof(notes) from public.vendor_quote_results where id=pg_temp.worker_fixture_id(60)),'array','result notes remain a JSON array');
select is((select status::text from public.quote_requests where id=pg_temp.worker_fixture_id(50)),'requesting','service result write executes nested request-status trigger successfully');
update public.vendor_quote_results set status='instant_quote_received',unit_price_usd=50,total_price_usd=100,
  lead_time_business_days=7,quote_url='https://example.test/synthetic-quote',dfm_issues='[]',notes='["synthetic received"]',raw_payload='{"fixture":true}'
where id=pg_temp.worker_fixture_id(60);
select is((select status::text from public.quote_requests where id=pg_temp.worker_fixture_id(50)),'received','result completion triggers received request status');
update public.quote_runs set status='completed' where id=pg_temp.worker_fixture_id(51);
select is((select status::text from public.quote_runs where id=pg_temp.worker_fixture_id(51)),'completed','service-role run status update succeeds');
update public.jobs set status='internal_review' where id=pg_temp.worker_fixture_id(10) and organization_id=pg_temp.worker_fixture_id(2);
select is((select status::text from public.jobs where id=pg_temp.worker_fixture_id(10)),'internal_review','organization-filtered job update succeeds');

-- All archived receipt-listed offer columns are explicitly written below.
-- Additional original schema columns are harmless synthetic fixture values.
insert into public.vendor_quote_offers(id,vendor_quote_result_id,organization_id,offer_key,supplier,lane_label,
  sourcing,tier,quote_ref,quote_date,unit_price_usd,total_price_usd,lead_time_business_days,ship_receive_by,due_date,
  process,material,finish,tightest_tolerance,tolerance_source,thread_callouts,thread_match_notes,notes,sort_rank,raw_payload,
  quoted_at,valid_until,validity_duration_days,validity_source,validity_terms)
values(pg_temp.worker_fixture_id(61),pg_temp.worker_fixture_id(60),pg_temp.worker_fixture_id(2),'xometry-2','Synthetic supplier','Synthetic lane',
  'automated','Instant','SYNTHETIC-1',date '2030-01-01',50,100,7,null,null,
  'CNC milling','6061-T6 Aluminum','As machined','0.005 in','synthetic',null,null,'Synthetic offer',0,'{"requestedQuantity":2,"requirementCapturedAt":null}',
  null,null,null,null,null);
select is((select geographic_origin from public.vendor_quote_offers where id=pg_temp.worker_fixture_id(61)),'unknown','omitted new nonnullable origin uses its safe default');
select is((select provenance_status from public.vendor_quote_offers where id=pg_temp.worker_fixture_id(61)),'unverified','omitted new nonnullable provenance uses its safe default');
select is((select valid_until from public.vendor_quote_offers where id=pg_temp.worker_fixture_id(61)),null::timestamptz,'legacy null validity remains insertable');
insert into public.vendor_quote_offers(vendor_quote_result_id,organization_id,offer_key,supplier,lane_label,total_price_usd,raw_payload)
values(pg_temp.worker_fixture_id(60),pg_temp.worker_fixture_id(2),'xometry-2','Synthetic supplier','Updated synthetic lane',100,'{"upsert":true,"requestedQuantity":2,"requirementCapturedAt":null}')
on conflict(vendor_quote_result_id,offer_key) do update set lane_label=excluded.lane_label,raw_payload=excluded.raw_payload;
select is((select count(*)::integer from public.vendor_quote_offers where vendor_quote_result_id=pg_temp.worker_fixture_id(60) and offer_key='xometry-2'),1,
  'worker unique conflict target performs a real upsert');
select is((select lane_label from public.vendor_quote_offers where id=pg_temp.worker_fixture_id(61)),'Updated synthetic lane','offer conflict update preserves row identity');
update public.vendor_quote_offers set quoted_at='2030-01-01T00:00:00Z',valid_until=null,raw_payload='{"validUntil":"2030-01-02","requestedQuantity":2,"requirementCapturedAt":null}',provenance_status='trusted_adapter'
where id=pg_temp.worker_fixture_id(61);
select is((select valid_until from public.vendor_quote_offers where id=pg_temp.worker_fixture_id(61)),
  '2030-01-02T23:59:59.999999Z'::timestamptz,'date-only validity remains inclusive through UTC end of day');
select is((select validity_source from public.vendor_quote_offers where id=pg_temp.worker_fixture_id(61)),'vendor_date','date-only validity retains vendor-date provenance');
update public.vendor_quote_offers set geographic_origin='domestic',sourcing='automated',tier='Official',provenance_status='trusted_adapter' where id=pg_temp.worker_fixture_id(61);
select is((select sourcing || ':' || tier from public.vendor_quote_offers where id=pg_temp.worker_fixture_id(61)),'automated:Official','archived automated Official lane is accepted');
update public.vendor_quote_offers set geographic_origin='foreign',sourcing='automated',tier='Instant',provenance_status='manual_verified' where id=pg_temp.worker_fixture_id(61);
select is((select sourcing || ':' || tier from public.vendor_quote_offers where id=pg_temp.worker_fixture_id(61)),'automated:Instant','archived automated Instant lane is accepted');
select is((select raw_payload->'requestedQuantity' from public.vendor_quote_offers where id=pg_temp.worker_fixture_id(61)),'2'::jsonb,'archived requestedQuantity is a JSON number');
select is((select raw_payload->'requirementCapturedAt' from public.vendor_quote_offers where id=pg_temp.worker_fixture_id(61)),'null'::jsonb,'archived requirementCapturedAt accepts explicit null');
update public.vendor_quote_offers set geographic_origin='unknown',sourcing=null,tier=null,provenance_status='imported' where id=pg_temp.worker_fixture_id(61);
select is((select provenance_status from public.vendor_quote_offers where id=pg_temp.worker_fixture_id(61)),'imported','all documented provenance/origin values are writable without inferring origin');
select throws_ok($$update public.vendor_quote_offers set geographic_origin=null where id=pg_temp.worker_fixture_id(61)$$,
  '23502',null,'explicit null is not the nonnullable origin default');
select throws_ok($$update public.vendor_quote_offers set provenance_status='invented' where id=pg_temp.worker_fixture_id(61)$$,
  '23514',null,'unsupported provenance is rejected');
select throws_ok($$update public.vendor_quote_offers set geographic_origin='invented' where id=pg_temp.worker_fixture_id(61)$$,
  '23514',null,'unsupported geographic origin is rejected');
select is((select count(*)::integer from public.vendor_quote_offers where geographic_origin is null or provenance_status is null),0,
  'replayed schema has no nulls in the newly required origin/provenance columns');
-- This post-migration assertion is not a pre-migration seeded backfill test.

insert into public.audit_events(organization_id,actor_user_id,job_id,package_id,event_type,payload)
values(pg_temp.worker_fixture_id(2),null,pg_temp.worker_fixture_id(10),null,'worker.compatibility.synthetic','{"fixture":true,"result":"recorded"}');
select is((select count(*)::integer from public.audit_events where organization_id=pg_temp.worker_fixture_id(2)
  and event_type='worker.compatibility.synthetic' and actor_user_id is null and package_id is null and payload @> '{"fixture":true}'),1,
  'service-role audit insert accepts null actor/package and JSON payload');

select throws_ok($$select public.api_register_quote_request_lane(p_vendor_quote_result_id=>pg_temp.worker_fixture_id(999),p_scope_snapshot=>null)$$,
  'P0001','Vendor quote result was not found.','registration requires an existing result row');
select throws_ok($$select public.api_register_quote_request_lane(p_vendor_quote_result_id=>pg_temp.worker_fixture_id(60),p_scope_snapshot=>null)$$,
  'P0001','Quote scope does not match the vendor result lane.','explicit null scope rejects an existing result lane');
select throws_ok($$select public.api_register_quote_request_lane(p_vendor_quote_result_id=>pg_temp.worker_fixture_id(60),p_scope_snapshot=>'[]')$$,
  'P0001','Quote scope does not match the vendor result lane.','non-object scope rejects an existing result lane');
insert into pg_temp.worker_probe_results values('dispatch-null',public.api_authorize_xometry_beta_worker_dispatch(
  p_work_queue_task_id=>null,p_vendor_quote_result_id=>null,p_scope_snapshot=>null,p_expected_worker_name=>null,p_expected_claimed_at=>null));
select is((select body->'authorized' from pg_temp.worker_probe_results where name='dispatch-null'),'false'::jsonb,'explicit-null dispatch fails closed with boolean false');
select is((select body->>'reasonCode' from pg_temp.worker_probe_results where name='dispatch-null'),'dispatch_preflight_invalid_input','explicit-null dispatch returns the documented denial code');
select throws_ok($$select public.api_authorize_xometry_beta_worker_dispatch(p_work_queue_task_id=>pg_temp.worker_fixture_id(40),
  p_vendor_quote_result_id=>pg_temp.worker_fixture_id(60),p_scope_snapshot=>'{}',p_expected_worker_name=>'worker-compatibility',p_expected_claimed_at=>'')$$,
  '22007',null,'old caller empty-string claimed-at fallback fails timestamp input conversion before dispatch');
select is((select count(*)::integer from public.quote_request_lanes where vendor_quote_result_id=pg_temp.worker_fixture_id(60)),0,
  'rejected registration creates no lane');
select diag('Old scope uses the hash-verified archived construction contract with synthetic values in old_scope.sql; there is no historical literal JSON instance.');

-- Preserve the real worker identity. Do not attach a synthetic internal-user
-- subject to make publication pass. The unchanged publisher rejects this caller
-- before its readiness, selection/source-link, or task-completion code is reached.
insert into public.work_queue(id,organization_id,job_id,quote_run_id,task_type,status,payload,locked_at,locked_by)
values(pg_temp.worker_fixture_id(42),pg_temp.worker_fixture_id(2),pg_temp.worker_fixture_id(10),pg_temp.worker_fixture_id(51),
  'publish_package','running','{"clientSummary":null}',now(),'worker-compatibility');
select throws_ok($$select public.api_publish_quote_package(p_job_id=>pg_temp.worker_fixture_id(10),p_quote_run_id=>pg_temp.worker_fixture_id(51),p_client_summary=>null,p_force=>false)$$,
  'P0001','You must be signed in to perform this action.','pre-existing incompatibility: real service-role publication has no user subject');
select throws_ok($$select public.api_publish_quote_package(p_job_id=>pg_temp.worker_fixture_id(10),p_quote_run_id=>pg_temp.worker_fixture_id(51),p_client_summary=>'Synthetic caller summary',p_force=>false)$$,
  'P0001','You must be signed in to perform this action.','caller-supplied summary does not bypass the publication identity gate');
select is((select status::text from public.work_queue where id=pg_temp.worker_fixture_id(42)),'running','publication RPC error does not complete the task');
select is((select count(*)::integer from public.published_quote_packages where quote_run_id=pg_temp.worker_fixture_id(51)),0,'failed worker publication creates no package');
select diag('INCOMPATIBLE UNTIL RESOLVED: a passing expected-error assertion records the baseline publication blocker; it is NOT a successful old-worker publication qualification.');
select diag('BOUNDARY: publication source-link dependency requires separately identified authenticated control probes; real service-role caller cannot reach it.');
select diag(jsonb_build_object('callerRole',current_user,'authRole',auth.role(),'subject',auth.uid(),'syntheticResultInventory',
  (select jsonb_object_agg(name,body) from pg_temp.worker_probe_results))::text);
reset role;
select * from finish();
rollback;
