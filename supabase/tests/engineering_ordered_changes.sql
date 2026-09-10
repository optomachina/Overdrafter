begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
create function pg_temp.q(n integer) returns uuid language sql immutable as $$
  select ('49700000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid;
$$;
insert into auth.users(id,aud,role,email,email_confirmed_at) values
  (pg_temp.q(1),'authenticated','authenticated','queue-a@example.test',now()),
  (pg_temp.q(2),'authenticated','authenticated','queue-b@example.test',now()),
  (pg_temp.q(3),'authenticated','authenticated','queue-peer@example.test',now());
insert into public.organizations(id,name,slug) values
  (pg_temp.q(4),'Queue A','engineering-queue-a'),(pg_temp.q(5),'Queue B','engineering-queue-b');
insert into public.organization_memberships(organization_id,user_id,role) values
  (pg_temp.q(4),pg_temp.q(1),'client'),(pg_temp.q(4),pg_temp.q(3),'client'),(pg_temp.q(5),pg_temp.q(2),'internal_admin');
insert into public.projects(id,organization_id,owner_user_id,name) values
  (pg_temp.q(7),pg_temp.q(4),pg_temp.q(1),'Queue fixture A'),(pg_temp.q(8),pg_temp.q(5),pg_temp.q(2),'Queue fixture B');
insert into public.project_memberships(project_id,user_id,role) values
  (pg_temp.q(7),pg_temp.q(1),'owner'),(pg_temp.q(7),pg_temp.q(3),'editor');
insert into engineering_private.engineering_operators(organization_id,user_id,enabled) values
  (pg_temp.q(4),pg_temp.q(1),true),(pg_temp.q(4),pg_temp.q(3),true),(pg_temp.q(5),pg_temp.q(2),true);
-- Contract fixtures, not complete native v2 verification evidence.
insert into public.engineering_snapshots(id,organization_id,project_id,context_text)
select pg_temp.q(n),pg_temp.q(4),pg_temp.q(7),jsonb_build_object(
  'schema','overdrafter.prepared-assembly.v2','snapshotId',pg_temp.q(n),
  'scope',jsonb_build_object('organizationId',pg_temp.q(4),'projectId',pg_temp.q(7)),
  'packageId','ovd-native04-assembly','configuration','Default','testOnly',true)::text from (values(20),(21)) f(n);
create function pg_temp.request_id(n integer,c integer default 30) returns uuid language sql security invoker as $$
  select id from public.engineering_requests where conversation_id=pg_temp.q(c) and receipt_revision=n;
$$;
create function pg_temp.resolve_change(n integer,r bigint,k integer,depth numeric default 8,outcome text default 'prepared_change',c integer default 30,provenance_patch jsonb default '{}'::jsonb)
returns jsonb language sql security invoker as $$
  select public.api_resolve_engineering_request(pg_temp.request_id(n,c),r,pg_temp.q(k),outcome,depth,'Fixture response',
    jsonb_build_object('model','test-only','promptVersion','v1','schemaVersion','overdrafter.prepared-interpretation.v1',
      'policyVersion','prepared-depth-v1','inputSha256',encode(extensions.digest(m.body,'sha256'),'hex'),
      'contextSha256',s.context_sha256) || provenance_patch)
  from public.engineering_requests x join public.engineering_messages m on m.id=x.message_id
  join public.engineering_snapshots s on s.id=x.input_snapshot_id where x.id=pg_temp.request_id(n,c);
$$;
create function pg_temp.decision(n integer,c integer default 30) returns uuid language sql security invoker as $$
  select id from public.engineering_decisions where conversation_id=pg_temp.q(c) and sequence=n;
$$;
create function pg_temp.cancel_suffix(ns integer[],r bigint,k integer,reason text default 'Changed my mind')
returns jsonb language sql security invoker as $$
  select public.api_cancel_engineering_suffix(pg_temp.q(30),r,pg_temp.q(k),
    array(select pg_temp.decision(n) from unnest(ns) n),reason);
$$;
set local role authenticated;
select set_config('request.jwt.claim.sub',pg_temp.q(1)::text,true);
do $$ begin
  for n in 1..7 loop
    perform public.api_submit_engineering_message(pg_temp.q(4),pg_temp.q(7),pg_temp.q(30),pg_temp.q(20),n-1,pg_temp.q(100+n),'Make depth 8 mm');
  end loop;
end $$;
select throws_ok($$select pg_temp.resolve_change(1,0,201)$$,'42501',null,'client cannot admit model interpretation');
select throws_ok($$insert into public.engineering_tasks(decision_id) values(pg_temp.q(99))$$,'42501',null,'client cannot forge tasks');
set local role anon;
select throws_ok($$select public.api_resolve_engineering_request(pg_temp.q(1),0,pg_temp.q(2),'prepared_change',8,'x','{}')$$,'42501',null,'anonymous cannot resolve requests');
reset role;
set local role service_role;
select throws_ok($$update public.engineering_tasks set execution_state='succeeded',verification_state='passed'$$,'42501',null,'service cannot fabricate native success');
select throws_ok($$select pg_temp.resolve_change(2,0,202)$$,'PT409','An earlier engineering request must be resolved first.','out of order interpretation blocked');
reset role;
update public.engineering_requests set interpretation_state='canceled' where id=pg_temp.request_id(1);
set local role service_role;
select throws_ok($$select pg_temp.resolve_change(2,0,202)$$,'PT409','An earlier engineering request must be resolved first.','status-only cancellation cannot hide an unresolved earlier request');
reset role;
update public.engineering_requests set interpretation_state='queued' where id=pg_temp.request_id(1);
set local role service_role;
select throws_ok($$select pg_temp.resolve_change(1,0,201,5.9)$$,'22023','Invalid prepared interpretation.','below range rejected');
select throws_ok($$select pg_temp.resolve_change(1,0,201,10.1)$$,'22023','Invalid prepared interpretation.','above range rejected');
select throws_ok($$select pg_temp.resolve_change(1,0,201,'NaN')$$,'22023','Invalid prepared interpretation.','NaN rejected');
select throws_ok($$select public.api_resolve_engineering_request(pg_temp.request_id(1),0,pg_temp.q(201),'prepared_change',8,'x','{}')$$,
  '22023','Invalid prepared interpretation.','missing provenance rejected');
select throws_ok($$select pg_temp.resolve_change(1,0,201,8,'prepared_change',30,'{"inputSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}')$$,
  'PT409','Interpretation provenance does not match the request.','wrong input hash cannot be attributed to this request');
select throws_ok($$select pg_temp.resolve_change(1,0,201,8,'prepared_change',30,'{"contextSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}')$$,
  'PT409','Interpretation provenance does not match the request.','wrong context hash rejected');
select throws_ok($$select pg_temp.resolve_change(1,0,201,8,'prepared_change',30,'{"model":null}')$$,
  '22023','Invalid prepared interpretation.','null model provenance rejected');
select throws_ok($$select pg_temp.resolve_change(1,0,201,8,'prepared_change',30,'{"policyVersion":"arbitrary-cad"}')$$,
  '22023','Invalid prepared interpretation.','unsupported policy rejected');
select lives_ok($$select pg_temp.resolve_change(1,0,201)$$,'first supported interpretation admitted');
select is(pg_temp.resolve_change(1,0,201),pg_temp.resolve_change(1,0,201),'exact replay returns same receipt');
select throws_ok($$select pg_temp.resolve_change(1,0,201,9)$$,'PT409','Engineering idempotency key has another payload.','changed replay rejected');
select throws_ok($$select pg_temp.resolve_change(1,1,299)$$,'PT409','Engineering request is already resolved or unavailable.','request cannot be accepted twice using another key');
select is((select predecessor_decision_id from public.engineering_decisions where id=pg_temp.decision(1)),null::uuid,'root has no invented predecessor');
select is((select execution_state from public.engineering_tasks where decision_id=pg_temp.decision(1)),'blocked','no automatic execution from admission');
select is((select requested_context_sha256 from public.engineering_decisions where id=pg_temp.decision(1)),
  (select context_sha256 from public.engineering_snapshots where id=pg_temp.q(20)),'exact requested context digest retained');
select throws_ok($$select pg_temp.resolve_change(2,0,202)$$,'PT409','Engineering queue changed; refresh before resolving.','stale queue revision blocked');
select lives_ok($$select pg_temp.resolve_change(2,1,202,9)$$,'successor can be accepted before geometry exists');
select is((select predecessor_decision_id from public.engineering_decisions where id=pg_temp.decision(2)),pg_temp.decision(1),'successor binds accepted predecessor');
select lives_ok($$select pg_temp.resolve_change(3,2,203); select pg_temp.resolve_change(4,3,204); select pg_temp.resolve_change(5,4,205)$$,'five requests admitted in order');
select is((select count(*) from public.engineering_tasks where conversation_id=pg_temp.q(30)),5::bigint,'five outstanding changes persisted');
select throws_ok($$select pg_temp.resolve_change(6,5,206)$$,'PT409','Five engineering changes are already outstanding.','sixth admission refused');
select is((select count(*) from public.engineering_tasks where conversation_id=pg_temp.q(30) and verification_state='unverified' and adoption_state='unadopted'),5::bigint,'acceptance never implies verification or adoption');
select is(pg_temp.resolve_change(1,0,201)->>'revision','1','historical receipt survives subsequent admissions');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub',pg_temp.q(3)::text,true);
select is((select count(*) from public.engineering_decisions),0::bigint,'same project peer cannot read private decisions');
select throws_ok($$select public.api_cancel_engineering_suffix(pg_temp.q(30),5,pg_temp.q(301),array[pg_temp.q(999)],'x')$$,
  '42501','Engineering conversation is unavailable.','peer cannot cancel owner changes');
select set_config('request.jwt.claim.sub',pg_temp.q(2)::text,true);
select is((select count(*) from public.engineering_interpretations),0::bigint,'other organization cannot read interpretations');
select throws_ok($$select public.api_cancel_engineering_suffix(pg_temp.q(30),5,pg_temp.q(301),array[pg_temp.q(999)],'x')$$,
  '42501','Engineering conversation is unavailable.','cross organization cancellation refused');
select set_config('request.jwt.claim.sub',pg_temp.q(1)::text,true);
select throws_ok($$select pg_temp.cancel_suffix(array[4],5,301)$$,'PT409','Cancellation must name the exact current suffix in order.','cannot silently omit dependent suffix');
select throws_ok($$select pg_temp.cancel_suffix(array[5,4],5,301)$$,'PT409','Cancellation must name the exact current suffix in order.','suffix order matters');
select throws_ok($$select pg_temp.cancel_suffix(array[4,5],4,301)$$,'PT409','Engineering queue changed; refresh before canceling.','stale cancellation rejected');
select lives_ok($$select pg_temp.cancel_suffix(array[4,5],5,301)$$,'owner can cancel exact unscheduled suffix');
select is(pg_temp.cancel_suffix(array[4,5],5,301),pg_temp.cancel_suffix(array[4,5],5,301),'cancellation replay preserves receipt');
select throws_ok($$select pg_temp.cancel_suffix(array[4,5],5,301,'Different reason')$$,'PT409','Engineering idempotency key has another payload.','cancellation payload cannot change on replay');
select is((select count(*) from public.engineering_tasks where conversation_id=pg_temp.q(30) and execution_state='canceled'),2::bigint,'only selected suffix canceled');
select is((select count(*) from public.engineering_decisions where conversation_id=pg_temp.q(30)),5::bigint,'accepted history retained after cancellation');
set local role service_role;
select lives_ok($$select pg_temp.resolve_change(6,6,206,7)$$,'explicit cancellation frees queue capacity');
select is((select predecessor_decision_id from public.engineering_decisions where id=pg_temp.decision(6)),pg_temp.decision(3),'new acceptance follows retained tail after explicit cancellation');
reset role;
-- Synthetic coordinator states exercise denial, not native execution proof.
update public.engineering_tasks set execution_state='failed' where decision_id=pg_temp.decision(3);
set local role service_role;
select throws_ok($$select pg_temp.resolve_change(7,7,207)$$,'PT409','Resolve the failed engineering chain before accepting another change.','failure blocks new continuation despite free capacity');
set local role authenticated;
select throws_ok($$select pg_temp.cancel_suffix(array[3,6],7,302)$$,'PT409','Native execution requires coordinator recovery before cancellation.','failed native work needs safe recovery contract');
reset role;
update public.engineering_tasks set execution_state='blocked' where decision_id=pg_temp.decision(3);
update public.engineering_tasks set execution_state='running' where decision_id=pg_temp.decision(6);
set local role authenticated;
select throws_ok($$select pg_temp.cancel_suffix(array[3,6],7,302)$$,'PT409','Native execution requires coordinator recovery before cancellation.','cancellation cannot claim a running process stopped');
reset role;
update public.engineering_tasks set execution_state='blocked' where decision_id=pg_temp.decision(6);
set local role authenticated;
select lives_ok($$select pg_temp.cancel_suffix(array[3,6],7,302)$$,'noncontiguous historical sequence still has exact active suffix');
set local role service_role;
select lives_ok($$select pg_temp.resolve_change(7,8,207)$$,'new decision after second explicit cancellation admitted');
select is((select predecessor_decision_id from public.engineering_decisions where id=pg_temp.decision(7)),pg_temp.decision(2),'surviving predecessor remains exact');
reset role;
select throws_ok($$update public.engineering_decisions set predecessor_decision_id=null where id=pg_temp.decision(7)$$,'55000','Engineering history is immutable.','privileged caller cannot silently rebase accepted decision');
select throws_ok($$delete from public.engineering_events where conversation_id=pg_temp.q(30)$$,'55000','Engineering history is immutable.','audit receipts cannot be deleted');
select throws_ok($$update public.engineering_tasks set decision_id=pg_temp.q(999) where decision_id=pg_temp.decision(7)$$,'55000','Engineering task identity is immutable.','task cannot change accepted intent');
update engineering_private.engineering_operators set enabled=false where user_id=pg_temp.q(1);
set local role service_role;
select throws_ok($$select pg_temp.resolve_change(1,0,201)$$,'42501','Engineering access is unavailable.','server replay rechecks current owner allowlist');
set local role authenticated;
select is((select count(*) from public.engineering_events),0::bigint,'revocation hides existing audit history');
select throws_ok($$select pg_temp.cancel_suffix(array[4,5],5,301)$$,'42501','Engineering conversation is unavailable.','revocation prevents cancellation replay');
reset role;
update engineering_private.engineering_operators set enabled=true where user_id=pg_temp.q(1);
set local role authenticated;
do $$ begin
  for n in 1..3 loop
    perform public.api_submit_engineering_message(pg_temp.q(4),pg_temp.q(7),pg_temp.q(31),pg_temp.q(20),n-1,pg_temp.q(400+n),'Fixture request');
  end loop;
end $$;
reset role;
update public.engineering_conversations set head_snapshot_id=pg_temp.q(21) where id=pg_temp.q(31);
set local role service_role;
select throws_ok($$select pg_temp.resolve_change(1,0,501,8,'prepared_change',31)$$,'PT409','Requested engineering context is stale.','changed head does not silently retarget interpretation');
reset role;
update public.engineering_conversations set head_snapshot_id=pg_temp.q(20) where id=pg_temp.q(31);
select throws_ok($$insert into public.engineering_interpretations(request_id,conversation_id,organization_id,project_id,owner_user_id,outcome,response,provenance)
 values(pg_temp.request_id(1,31),pg_temp.q(31),pg_temp.q(5),pg_temp.q(8),pg_temp.q(1),'no_change','x','{}')$$,
 '23503',null,'composite request reference enforces organization consistency');
set local role service_role;
select lives_ok($$select pg_temp.resolve_change(1,0,501,null,'no_change',31); select pg_temp.resolve_change(2,1,502,null,'needs_context',31); select pg_temp.resolve_change(3,2,503,10,'prepared_change',31)$$,
  'non-actionable and clarification responses finalize independently of later accepted changes');
select is((select count(*) from public.engineering_tasks where conversation_id=pg_temp.q(31)),1::bigint,'clarification creates no native task');
select is((select interpretation_state from public.engineering_requests where id=pg_temp.request_id(2,31)),'needs_context','clarification remains explicit');
reset role;
delete from public.project_memberships where project_id=pg_temp.q(7) and user_id=pg_temp.q(1);
set local role service_role;
select throws_ok($$select pg_temp.resolve_change(1,0,501,null,'no_change',31)$$,'42501','Engineering access is unavailable.','current project permission required for server replay');
reset role;
select * from finish();
rollback;
