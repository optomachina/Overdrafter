-- DRAFT, NOT EXECUTED. Same suite at baseline126 and candidate131.
-- Synthetic old scope constructed from the complete hash-verified live receipt:
-- f723dbd7fab38d24944bae70f989c31cabaab450a122d5fc6512ba8cdfafef5a.
-- No archived code is executed and no historical JSON instance is claimed.
begin;
set local search_path = public, extensions;
set local timezone = 'UTC';
select no_plan();
create function pg_temp.old_scope_id(p_suffix integer) returns uuid language sql immutable as $$
  select ('ec420003-1300-4000-8000-' || lpad(p_suffix::text,12,'0'))::uuid;
$$;
grant execute on function pg_temp.old_scope_id(integer) to authenticated, service_role;
-- Deliberately reproduces the OLD exact key set. No destination,
-- confirmationRevision or activeDeadline is added. The specification is the
-- unchanged approved snapshot, including old requested-by-date keys.
create function pg_temp.archived_worker_scope(p_part_id uuid) returns jsonb language sql as $$
  select jsonb_build_object('schema','quote-lane-scope.v1','vendor','xometry','quantity',1,
    'part',jsonb_build_object('id',part.id,
      'cad',jsonb_build_object('fileId',file.id,'sha256',file.trusted_content_sha256,'name',file.original_name,'mimeType',file.mime_type,'sizeBytes',file.size_bytes),
      'drawing',null),
    'requirements',jsonb_build_object('id',requirement.id,'capturedAt',requirement.updated_at,
      'description',requirement.description,'partNumber',requirement.part_number,'revision',requirement.revision,
      'material',requirement.material,'finish',requirement.finish,'tightestToleranceInch',requirement.tightest_tolerance_inch,
      'requestedDeliveryDate',requirement.requested_by_date,'specification',requirement.spec_snapshot))
  from public.parts part join public.job_files file on file.id=part.cad_file_id
  join public.approved_part_requirements requirement on requirement.part_id=part.id where part.id=p_part_id;
$$;
grant execute on function pg_temp.archived_worker_scope(uuid) to service_role;
create temporary table archived_scope_context(name text primary key,body jsonb) on commit drop;
grant select,insert,update on pg_temp.archived_scope_context to authenticated,service_role;
insert into auth.users(id,aud,role,email,email_confirmed_at)
values(pg_temp.old_scope_id(1),'authenticated','authenticated','old-scope-contract@example.test',now());
insert into public.organizations(id,name,slug,shipping_same_as_billing,shipping_street,shipping_city,shipping_state,shipping_zip,shipping_country)
values(pg_temp.old_scope_id(2),'Old scope synthetic contract','old-scope-ec420003',false,'123 Fixture Ave','Tucson','AZ','85701','US');
insert into public.organization_memberships(organization_id,user_id,role)
values(pg_temp.old_scope_id(2),pg_temp.old_scope_id(1),'client');
insert into private.sourcing_destination_history(organization_id,state,address)
values(pg_temp.old_scope_id(2),'confirmed',private.effective_sourcing_address(pg_temp.old_scope_id(2)));
insert into private.organization_entitlement_grants(organization_id,grant_type,starts_at,review_at,grant_reason,granted_by_user_id)
values(pg_temp.old_scope_id(2),'complimentary',now()-interval '1 day',now()+interval '30 days','Synthetic old worker compatibility',pg_temp.old_scope_id(1));
update private.commercial_rollout_controls set enabled=true,revision=revision+1,change_reason='Synthetic old worker compatibility'
where capability='automatic_quote_collection';
insert into private.founding_beta_enrollment_events(organization_id,actor_user_id,action,reason,policy_revision,terms_path,privacy_path,idempotency_key)
values(pg_temp.old_scope_id(2),pg_temp.old_scope_id(1),'grant','Synthetic old worker compatibility','founding-beta-2026-08-15','/legal/beta-terms','/legal/privacy','old-scope-ec420003');
insert into private.founding_beta_notice_acceptances(organization_id,user_id,policy_revision,terms_path,privacy_path)
values(pg_temp.old_scope_id(2),pg_temp.old_scope_id(1),'founding-beta-2026-08-15','/legal/beta-terms','/legal/privacy');
insert into public.org_vendor_configs(organization_id,vendor,enabled_for_client_quote_requests)
values(pg_temp.old_scope_id(2),'xometry',true);
insert into public.jobs(id,organization_id,created_by,title,status,requested_service_kinds,primary_service_kind)
select pg_temp.old_scope_id(n),pg_temp.old_scope_id(2),pg_temp.old_scope_id(1),'Synthetic old scope job '||n,'ready_to_quote',array['manufacturing_quote'],'manufacturing_quote'
from unnest(array[10,11]) n;
insert into public.organization_file_blobs(id,organization_id,content_sha256,trusted_content_sha256,storage_bucket,storage_path,size_bytes,mime_type)
values(pg_temp.old_scope_id(19),pg_temp.old_scope_id(2),repeat('a',64),repeat('a',64),'job-files','old-scope/part.step',100,'application/step');
insert into public.job_files(id,job_id,organization_id,uploaded_by,blob_id,content_sha256,trusted_content_sha256,storage_bucket,storage_path,original_name,normalized_name,file_kind,mime_type,size_bytes)
select pg_temp.old_scope_id(n+10),pg_temp.old_scope_id(n),pg_temp.old_scope_id(2),pg_temp.old_scope_id(1),pg_temp.old_scope_id(19),repeat('a',64),repeat('a',64),
  'job-files','old-scope/part.step','part.step','part','cad','application/step',100 from unnest(array[10,11]) n;
insert into public.parts(id,job_id,organization_id,name,normalized_key,cad_file_id,quantity)
select pg_temp.old_scope_id(n+20),pg_temp.old_scope_id(n),pg_temp.old_scope_id(2),'Synthetic old scope part','old-scope',pg_temp.old_scope_id(n+10),1 from unnest(array[10,11]) n;
insert into public.approved_part_requirements(id,part_id,organization_id,approved_by,description,part_number,revision,material,finish,tightest_tolerance_inch,
  quantity,quote_quantities,requested_by_date,applicable_vendors,spec_snapshot)
select pg_temp.old_scope_id(n+30),pg_temp.old_scope_id(n+20),pg_temp.old_scope_id(2),pg_temp.old_scope_id(1),null,null,null,'6061-T6 Aluminum','As machined',0.0050,
  1,array[1],null,array['xometry']::public.vendor_name[],
  '{"process":"CNC milling","tightestToleranceInch":0.0050,"requestedByDate":null,"shipping":{"requestedByDateOverride":null}}'::jsonb from unnest(array[10,11]) n;

-- Authenticated setup creates genuine current server lane/task/permit/access
-- records. It is a positive CONTROL, never substituted for the old caller scope.
select set_config('request.jwt.claim.sub',pg_temp.old_scope_id(1)::text,true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',jsonb_build_object('sub',pg_temp.old_scope_id(1),'role','authenticated','aal','aal1')::text,true);
set local role authenticated;
select lives_ok($$select public.api_request_xometry_beta_dispatch(
  pg_temp.old_scope_id(10),'inch',public.api_get_xometry_beta_dispatch_scope(pg_temp.old_scope_id(10),'inch')->>'scopeFingerprint',
  'founding-beta-2026-08-15',pg_temp.old_scope_id(3),true,true,true)$$,'current server setup creates a genuine synthetic permit without provider execution');
reset role;
insert into pg_temp.archived_scope_context
select 'binding',jsonb_build_object('taskId',permit.work_queue_task_id,'resultId',permit.vendor_quote_result_id,'laneId',permit.quote_request_lane_id,
  'permitId',permit.id,'serverScope',lane.scope_snapshot,'oldScope',pg_temp.archived_worker_scope(pg_temp.old_scope_id(30)))
from private.xometry_beta_dispatch_permits permit join public.quote_request_lanes lane on lane.id=permit.quote_request_lane_id
where permit.organization_id=pg_temp.old_scope_id(2) and permit.job_id=pg_temp.old_scope_id(10);
select is((select count(*)::integer from pg_temp.archived_scope_context where name='binding'),1,'exactly one real permit binding was created');

-- A second unreserved lane distinguishes accepted old JSON structure from the
-- current immutable server-created scope mismatch; no provider task is sent.
insert into public.quote_requests(id,organization_id,job_id,requested_by,status,requested_vendors)
values(pg_temp.old_scope_id(60),pg_temp.old_scope_id(2),pg_temp.old_scope_id(11),pg_temp.old_scope_id(1),'queued',array['xometry']::public.vendor_name[]);
insert into public.quote_runs(id,job_id,organization_id,initiated_by,quote_request_id)
values(pg_temp.old_scope_id(61),pg_temp.old_scope_id(11),pg_temp.old_scope_id(2),pg_temp.old_scope_id(1),pg_temp.old_scope_id(60));
insert into public.vendor_quote_results(id,quote_run_id,part_id,organization_id,vendor,requested_quantity,status)
values(pg_temp.old_scope_id(62),pg_temp.old_scope_id(61),pg_temp.old_scope_id(31),pg_temp.old_scope_id(2),'xometry',1,'queued');

select set_config('request.jwt.claim.sub','',true);
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);
set local role service_role;
select is(current_user::text,'service_role','old-scope calls use actual service role');
select is(auth.uid(),null::uuid,'old-scope worker has no user subject');
update public.work_queue set status='running',locked_at=now(),locked_by='old-scope-worker'
where id=(select (body->>'taskId')::uuid from pg_temp.archived_scope_context where name='binding');
update public.vendor_quote_results set status='running'
where id=(select (body->>'resultId')::uuid from pg_temp.archived_scope_context where name='binding');
select lives_ok($$select public.api_register_quote_request_lane(p_vendor_quote_result_id=>pg_temp.old_scope_id(62),p_scope_snapshot=>pg_temp.archived_worker_scope(pg_temp.old_scope_id(31)))$$,
  'old receipt-shaped scope successfully registers an unreserved synthetic lane');
select is((select scope_snapshot from public.quote_request_lanes where vendor_quote_result_id=pg_temp.old_scope_id(62)),
  pg_temp.archived_worker_scope(pg_temp.old_scope_id(31)),'registration stores old requestedDeliveryDate/specification without modernizing them');
select ok((select (body->'oldScope') - array['schema','vendor','quantity','part','requirements']::text[]='{}'::jsonb
  and not (body->'oldScope' ? 'destination') from pg_temp.archived_scope_context where name='binding'),'synthetic old scope preserves the archived top-level key set without destination');
select ok((select body#>'{oldScope,requirements,specification}' ? 'requestedByDate'
  and body#>'{oldScope,requirements,specification,shipping}' ? 'requestedByDateOverride'
  and body#>'{oldScope,requirements}' ? 'requestedDeliveryDate' from pg_temp.archived_scope_context where name='binding'),
  'old requestedDeliveryDate and old specification keys are retained');
select ok((select body->'oldScope' is distinct from body->'serverScope' from pg_temp.archived_scope_context where name='binding'),
  'archived and current scopes are demonstrably different');
select lives_ok($$select public.api_register_quote_request_lane(
  p_vendor_quote_result_id=>(select (body->>'resultId')::uuid from pg_temp.archived_scope_context where name='binding'),
  p_scope_snapshot=>(select body->'serverScope' from pg_temp.archived_scope_context where name='binding'))$$,
  'current control scope is idempotently accepted by the existing immutable lane');
select throws_ok($$select public.api_register_quote_request_lane(
  p_vendor_quote_result_id=>(select (body->>'resultId')::uuid from pg_temp.archived_scope_context where name='binding'),
  p_scope_snapshot=>(select body->'oldScope' from pg_temp.archived_scope_context where name='binding'))$$,
  'P0001','Quote lane was already registered with a different immutable scope.','pre-existing old-worker incompatibility: old scope cannot replace current reserved lane');

insert into pg_temp.archived_scope_context(name,body)
select 'current-decision', public.api_authorize_xometry_beta_worker_dispatch(
  p_work_queue_task_id=>(binding.body->>'taskId')::uuid,p_vendor_quote_result_id=>(binding.body->>'resultId')::uuid,
  p_scope_snapshot=>binding.body->'serverScope',p_expected_worker_name=>'old-scope-worker',
  p_expected_claimed_at=>task.locked_at)
from pg_temp.archived_scope_context binding join public.work_queue task on task.id=(binding.body->>'taskId')::uuid where binding.name='binding';
select is((select body->'authorized' from pg_temp.archived_scope_context where name='current-decision'),'true'::jsonb,'current control has strict authorized true under native service role');
select ok((select (body->>'permitId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' from pg_temp.archived_scope_context where name='current-decision'),'current control returns UUID permitId');
select is((select body->>'provider' from pg_temp.archived_scope_context where name='current-decision'),'xometry','current control provider is exact xometry');
select ok((select (body->>'scopeFingerprint') ~ '^[0-9a-f]{64}$' from pg_temp.archived_scope_context where name='current-decision'),'current control fingerprint is lowercase 64-hex');
select is((select body->>'envelopeRevision' from pg_temp.archived_scope_context where name='current-decision'),'xometry-controlled-beta-envelope.v1','current control envelope matches caller');
select is((select body->'nonExportControlled' from pg_temp.archived_scope_context where name='current-decision'),'true'::jsonb,'current control nonExportControlled is strict boolean true');
insert into pg_temp.archived_scope_context(name,body)
select 'old-decision', public.api_authorize_xometry_beta_worker_dispatch(
  p_work_queue_task_id=>(binding.body->>'taskId')::uuid,p_vendor_quote_result_id=>(binding.body->>'resultId')::uuid,
  p_scope_snapshot=>binding.body->'oldScope',p_expected_worker_name=>'old-scope-worker',
  p_expected_claimed_at=>task.locked_at)
from pg_temp.archived_scope_context binding join public.work_queue task on task.id=(binding.body->>'taskId')::uuid where binding.name='binding';
select is((select body->'authorized' from pg_temp.archived_scope_context where name='old-decision'),'false'::jsonb,'old scope fails closed despite otherwise valid task, permit and access');
select is((select body->>'reasonCode' from pg_temp.archived_scope_context where name='old-decision'),'dispatch_staged_scope_changed','pre-existing old-worker incompatibility is specifically staged-scope mismatch');
select is((select scope_snapshot from public.quote_request_lanes where id=(select (body->>'laneId')::uuid from pg_temp.archived_scope_context where name='binding')),
  (select body->'serverScope' from pg_temp.archived_scope_context where name='binding'),'old rejection leaves immutable server scope unchanged');
select diag(jsonb_build_object('classification','expected-preexisting-incompatibility-runtime-pending',
  'callerRole',current_user,'subject',auth.uid(),'receiptSha256','f723dbd7fab38d24944bae70f989c31cabaab450a122d5fc6512ba8cdfafef5a',
  'syntheticScopeAndDecisions',(select jsonb_object_agg(name,body) from pg_temp.archived_scope_context))::text);
select diag('A passing expected rejection confirms incompatibility. Current-scope control success is NOT archived-worker compatibility and never permits provider execution.');
reset role;
select * from finish();
rollback;
