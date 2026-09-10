begin;
create extension if not exists pgtap with schema extensions;
select plan(34);
create function pg_temp.e(n integer) returns uuid language sql immutable as $$
  select ('49600000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid;
$$;
insert into auth.users(id,aud,role,email,email_confirmed_at) values
  (pg_temp.e(1),'authenticated','authenticated','engineering-a@example.test',now()),
  (pg_temp.e(2),'authenticated','authenticated','engineering-b@example.test',now()),
  (pg_temp.e(3),'authenticated','authenticated','engineering-c@example.test',now());
insert into public.organizations(id,name,slug) values
  (pg_temp.e(4),'Engineering A','engineering-inbox-a'),(pg_temp.e(5),'Engineering B','engineering-inbox-b');
insert into public.organization_memberships(organization_id,user_id,role) values
  (pg_temp.e(4),pg_temp.e(1),'client'),(pg_temp.e(4),pg_temp.e(3),'client'),(pg_temp.e(5),pg_temp.e(2),'client');
insert into public.projects(id,organization_id,owner_user_id,name) values
  (pg_temp.e(7),pg_temp.e(4),pg_temp.e(1),'Engineering fixture A'),
  (pg_temp.e(8),pg_temp.e(5),pg_temp.e(2),'Engineering fixture B'),
  (pg_temp.e(9),pg_temp.e(4),pg_temp.e(3),'Unshared project');
insert into public.project_memberships(project_id,user_id,role) values
  (pg_temp.e(7),pg_temp.e(1),'owner'),(pg_temp.e(7),pg_temp.e(3),'editor'),
  (pg_temp.e(8),pg_temp.e(2),'owner'),(pg_temp.e(9),pg_temp.e(3),'owner');
-- Storage identity fixtures only, not complete v2 native verification evidence.
insert into public.engineering_snapshots(id,organization_id,project_id,context_text)
select pg_temp.e(n),pg_temp.e(o),pg_temp.e(p),jsonb_build_object(
  'schema','overdrafter.prepared-assembly.v2','snapshotId',pg_temp.e(n),
  'scope',jsonb_build_object('organizationId',pg_temp.e(o),'projectId',pg_temp.e(p)),
  'testOnly','No native verification asserted')::text
from (values (20,4,7),(21,5,8),(22,4,9),(23,4,7)) as f(n,o,p);
create function pg_temp.send(c integer,s integer,r bigint,k integer,b text default 'Make depth 8 mm',o integer default 4,p integer default 7)
returns jsonb language sql security invoker as $$
  select public.api_submit_engineering_message(pg_temp.e(o),pg_temp.e(p),pg_temp.e(c),pg_temp.e(s),r,pg_temp.e(k),b);
$$;

set local role authenticated;
select set_config('request.jwt.claim.sub',pg_temp.e(1)::text,true);
select throws_ok($$select pg_temp.send(30,20,0,40)$$,'42501','Engineering access is unavailable.','empty allowlist blocks intake');
select is((select count(*) from public.engineering_snapshots),0::bigint,'empty allowlist hides contexts');
select throws_ok($$insert into engineering_private.engineering_operators values (pg_temp.e(4),pg_temp.e(1),true,now())$$,'42501',null,'client cannot enable itself');
reset role;
insert into engineering_private.engineering_operators(organization_id,user_id,enabled) values
  (pg_temp.e(4),pg_temp.e(1),true),(pg_temp.e(4),pg_temp.e(3),true),(pg_temp.e(5),pg_temp.e(2),true);
set local role authenticated;
select is((select count(*) from public.engineering_snapshots),2::bigint,'owner sees only accessible project snapshots');
select lives_ok($$select pg_temp.send(30,20,0,40)$$,'first send atomically creates conversation and request');
select is((select count(*) from public.engineering_messages),1::bigint,'one message recorded');
select is((select count(*) from public.engineering_requests where interpretation_state='queued'),1::bigint,'interpretation is durable and pending');
select is(pg_temp.send(30,20,0,40),pg_temp.send(30,20,0,40),'duplicate delivery preserves exact receipt');
select is((select revision from public.engineering_conversations where id=pg_temp.e(30)),1::bigint,'duplicate does not advance revision');
select throws_ok($$select pg_temp.send(30,20,0,40,'Make depth 9 mm')$$,'PT409','Idempotency key already identifies a different message.','changed replay rejected');
select throws_ok($$select pg_temp.send(30,20,0,41)$$,'PT409','Engineering context changed; refresh before sending.','stale revision rejected');
select throws_ok($$select pg_temp.send(30,23,1,41)$$,'PT409','Engineering context changed; refresh before sending.','wrong current snapshot rejected');
select throws_ok($$select pg_temp.send(31,21,0,41)$$,'42501','Engineering context is unavailable.','cross-tenant snapshot rejected');
select throws_ok($$select pg_temp.send(32,22,0,41,'Change',4,9)$$,'42501','Engineering access is unavailable.','unshared project blocked');
select throws_ok($$select pg_temp.send(30,20,1,41,E' \t\n')$$,'22023','Invalid engineering message.','whitespace rejected');
select throws_ok($$select pg_temp.send(30,20,1,41,repeat('x',4001))$$,'22023','Invalid engineering message.','oversize input rejected');
select throws_ok($$update public.engineering_messages set body='changed'$$,'42501',null,'client cannot rewrite history');
select throws_ok($$insert into public.engineering_snapshots(id,organization_id,project_id,context_text) values(pg_temp.e(99),pg_temp.e(4),pg_temp.e(7),'{}')$$,'42501',null,'client cannot forge context');
select throws_ok($$update public.engineering_requests set interpretation_state='interpreted'$$,'42501',null,'client cannot finalize interpretation');
select set_config('request.jwt.claim.sub',pg_temp.e(3)::text,true);
select is((select count(*) from public.engineering_conversations),0::bigint,'same-project peer cannot read private conversation');
select throws_ok($$select pg_temp.send(30,20,1,41)$$,'42501','Engineering access is unavailable.','peer cannot append to owner conversation');
select set_config('request.jwt.claim.sub',pg_temp.e(2)::text,true);
select is((select count(*) from public.engineering_messages),0::bigint,'other tenant cannot read messages');
select throws_ok($$select pg_temp.send(30,20,1,41)$$,'42501','Engineering access is unavailable.','other tenant cannot send into project');
reset role;
update engineering_private.engineering_operators set enabled=false where user_id=pg_temp.e(1);
set local role authenticated;
select set_config('request.jwt.claim.sub',pg_temp.e(1)::text,true);
select is((select count(*) from public.engineering_messages),0::bigint,'revocation immediately hides history');
select throws_ok($$select pg_temp.send(30,20,0,40)$$,'42501','Engineering access is unavailable.','revocation also denies idempotent replay');
reset role;
update engineering_private.engineering_operators set enabled=true where user_id=pg_temp.e(1);
delete from public.organization_memberships where organization_id=pg_temp.e(4) and user_id=pg_temp.e(1);
set local role authenticated;
select is((select count(*) from public.engineering_requests),0::bigint,'membership removal denies existing-token reads');
select throws_ok($$select pg_temp.send(30,20,1,41)$$,'42501','Engineering access is unavailable.','membership removal denies sends');
reset role;
select throws_ok($$update public.engineering_messages set body='server rewrite' where conversation_id=pg_temp.e(30)$$,'55000','Engineering history is immutable.','history trigger also blocks privileged rewrite');
select throws_ok($$update public.engineering_snapshots set context_text='{}' where id=pg_temp.e(20)$$,'55000','Engineering history is immutable.','context immutable before constraints');
select throws_ok($$update public.engineering_requests set input_snapshot_id=pg_temp.e(23) where conversation_id=pg_temp.e(30)$$,'55000','Engineering request identity is immutable.','request baseline cannot be rewritten');
select throws_ok($$insert into public.engineering_snapshots(id,organization_id,project_id,context_text) values(pg_temp.e(98),pg_temp.e(5),pg_temp.e(7),jsonb_build_object('schema','overdrafter.prepared-assembly.v2','snapshotId',pg_temp.e(98),'scope',jsonb_build_object('organizationId',pg_temp.e(5),'projectId',pg_temp.e(7)))::text)$$,'23503',null,'FK blocks cross-organization project reference');
select is((select context_sha256 from public.engineering_snapshots where id=pg_temp.e(20)),
  (select encode(extensions.digest(context_text,'sha256'),'hex') from public.engineering_snapshots where id=pg_temp.e(20)), 'stored digest identifies exact context text');
set local role anon;
select throws_ok($$select pg_temp.send(30,20,0,40)$$,'42501',null,'anonymous cannot call intake');
select throws_ok($$select * from public.engineering_messages$$,'42501',null,'anonymous cannot read messages');
reset role;
select * from finish();
rollback;
