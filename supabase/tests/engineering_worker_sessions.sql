begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
create function pg_temp.w(n integer) returns uuid language sql immutable as $$
 select ('49800000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid;
$$;
create function pg_temp.h(n integer) returns text language sql immutable as $$
 select encode(extensions.digest('synthetic-ovd498-' || n::text,'sha256'),'hex');
$$;
insert into auth.users(id,aud,role,email,email_confirmed_at) values
 (pg_temp.w(1),'authenticated','authenticated','worker-owner@example.test',now()),
 (pg_temp.w(2),'authenticated','authenticated','worker-other@example.test',now()),
 (pg_temp.w(3),'authenticated','authenticated','worker-peer@example.test',now());
insert into public.organizations(id,name,slug) values
 (pg_temp.w(4),'Workers A','ovd498-a'),(pg_temp.w(5),'Workers B','ovd498-b');
insert into public.organization_memberships(organization_id,user_id,role) values
 (pg_temp.w(4),pg_temp.w(1),'client'),(pg_temp.w(4),pg_temp.w(3),'client'),(pg_temp.w(5),pg_temp.w(2),'internal_admin');
insert into public.projects(id,organization_id,owner_user_id,name) values
 (pg_temp.w(7),pg_temp.w(4),pg_temp.w(1),'Worker A'),(pg_temp.w(8),pg_temp.w(5),pg_temp.w(2),'Worker B');
insert into public.project_memberships(project_id,user_id,role) values
 (pg_temp.w(7),pg_temp.w(1),'owner'),(pg_temp.w(7),pg_temp.w(3),'editor');
insert into engineering_private.engineering_operators(organization_id,user_id,enabled) values
 (pg_temp.w(4),pg_temp.w(1),false),(pg_temp.w(4),pg_temp.w(3),true),(pg_temp.w(5),pg_temp.w(2),true);
create function pg_temp.invite(k integer default 100,code integer default 1) returns jsonb language sql security invoker as $$
 select public.api_create_worker_pairing(pg_temp.w(20),pg_temp.w(4),pg_temp.w(7),0,pg_temp.w(k),pg_temp.h(code));
$$;
create function pg_temp.pair(k integer default 101,install integer default 30,credential integer default 2,code integer default 1,r bigint default 1)
returns jsonb language sql security invoker as $$
 select public.api_consume_worker_pairing(pg_temp.w(20),r,pg_temp.w(k),pg_temp.h(code),pg_temp.w(install),pg_temp.h(credential));
$$;
create function pg_temp.boot(r bigint,k integer,b integer default 40,credential integer default 2) returns jsonb language sql security invoker as $$
 select public.api_register_worker_boot(pg_temp.w(20),r,pg_temp.w(k),pg_temp.h(credential),pg_temp.w(b));
$$;
create function pg_temp.control(r bigint,k integer,action text,b integer default 40) returns jsonb language sql security invoker as $$
 select public.api_control_worker_session(pg_temp.w(20),r,pg_temp.w(k),action,pg_temp.w(b));
$$;
create function pg_temp.eligible(b integer default 40,credential integer default 2) returns jsonb language sql security invoker as $$
 select public.api_worker_session_eligibility(pg_temp.w(20),pg_temp.h(credential),pg_temp.w(b));
$$;
set local role authenticated;
select set_config('request.jwt.claim.sub',pg_temp.w(1)::text,true);
select throws_ok($$select pg_temp.invite()$$,'42501','Worker access denied.','default-off owner cannot pair');
reset role;
update engineering_private.engineering_operators set enabled=true where user_id=pg_temp.w(1);
set local role authenticated;
select throws_ok($$select public.api_create_worker_pairing(pg_temp.w(20),pg_temp.w(4),pg_temp.w(8),0,pg_temp.w(100),pg_temp.h(1))$$,'42501',null,'cross-organization project refused');
select throws_ok($$select public.api_create_worker_pairing(pg_temp.w(20),pg_temp.w(4),pg_temp.w(7),0,pg_temp.w(100),'short')$$,'22023',null,'noncanonical code hash refused');
select lives_ok($$select pg_temp.invite()$$,'allowed owner creates invitation');
select is((pg_temp.invite()->>'revision')::int,1,'invitation replay preserves receipt');
select throws_ok($$select pg_temp.invite(100,5)$$,'PT409',null,'invitation replay payload conflict');
select throws_ok($$select pg_temp.invite(102)$$,'PT409',null,'same worker cannot create second invitation');
select throws_ok($$select public.api_create_worker_pairing(pg_temp.w(21),pg_temp.w(4),pg_temp.w(7),0,pg_temp.w(102),pg_temp.h(3))$$,'PT409',null,'one worker per organization');
select throws_ok($$select * from engineering_private.worker_pairings$$,'42501',null,'pairing hashes are private');
select throws_ok($$select * from engineering_private.worker_credentials$$,'42501',null,'credential hashes are private');
select throws_ok($$update public.engineering_workers set revision=2$$,'42501',null,'client cannot mutate worker state');
select throws_ok($$select pg_temp.pair()$$,'42501',null,'client cannot call pairing gateway API');
select throws_ok($$select pg_temp.control(1,103,'enabled')$$,'PT409',null,'unpaired worker cannot be enabled');
select is((select count(*) from public.engineering_workers),1::bigint,'owner sees worker metadata');
select set_config('request.jwt.claim.sub',pg_temp.w(3)::text,true);
select is((select count(*) from public.engineering_workers),0::bigint,'allowed project peer cannot see owner worker');
select throws_ok($$select pg_temp.control(1,103,'revoked',null)$$,'42501',null,'project peer cannot revoke worker');
select set_config('request.jwt.claim.sub',pg_temp.w(2)::text,true);
select is((select count(*) from public.engineering_workers),0::bigint,'other tenant cannot see metadata');
select throws_ok($$select pg_temp.invite()$$,'42501',null,'other tenant cannot replay invite');
set local role anon;
select throws_ok($$select * from public.engineering_workers$$,'42501',null,'anonymous has no metadata grant');
select throws_ok($$select pg_temp.pair()$$,'42501',null,'anonymous cannot consume pairing');
reset role;
select is((select expires_at-created_at from engineering_private.worker_pairings where worker_id=pg_temp.w(20)),interval '10 minutes','fixed ten-minute invitation');
set local role service_role;
select throws_ok($$select * from public.engineering_workers$$,'42501',null,'service cannot directly read worker metadata');
select throws_ok($$select * from public.engineering_worker_sessions$$,'42501',null,'service cannot directly read worker grants');
select throws_ok($$select * from public.engineering_worker_events$$,'42501',null,'service cannot directly read worker history');
select throws_ok($$select * from engineering_private.worker_credentials$$,'42501',null,'gateway cannot read stored credentials directly');
select throws_ok($$select pg_temp.control(1,103,'enabled')$$,'42501',null,'worker gateway cannot enable itself');
select throws_ok($$select pg_temp.pair(101,30,1)$$,'22023',null,'pairing code cannot be reused as credential');
select throws_ok($$select pg_temp.pair(101,30,2,9)$$,'42501',null,'wrong pairing code refused');
select lives_ok($$select pg_temp.pair()$$,'service consumes exact pairing');
select is((pg_temp.pair()->>'revision')::int,2,'identical pairing replay succeeds');
select throws_ok($$select pg_temp.pair(101,31)$$,'PT409',null,'conflicting installation cannot reuse receipt');
select throws_ok($$select pg_temp.pair(102)$$,'PT409',null,'different key cannot consume twice');
select throws_ok($$select pg_temp.pair(102,30,2,1,2)$$,'PT409',null,'consumed invitation cannot be used at current revision');
select throws_ok($$select pg_temp.boot(2,102,40,9)$$,'42501',null,'wrong credential cannot register boot');
select lives_ok($$select pg_temp.boot(2,102)$$,'paired worker registers boot');
select is(pg_temp.eligible()->>'reason','owner_enablement_required','fresh boot is not enabled');
select is((pg_temp.boot(2,102)->>'revision')::int,3,'boot replay stable');
select throws_ok($$select pg_temp.boot(3,103)$$,'PT409',null,'boot identity cannot be reused with new key');
select throws_ok($$update public.engineering_workers set revoked_at=clock_timestamp()$$,'42501',null,'service cannot directly mutate worker');
set local role authenticated;
select set_config('request.jwt.claim.sub',pg_temp.w(1)::text,true);
select throws_ok($$select pg_temp.control(2,103,'enabled')$$,'PT409',null,'stale owner revision refused');
select throws_ok($$select pg_temp.control(3,103,'enabled',41)$$,'PT409',null,'enable must bind exact current boot');
select lives_ok($$select pg_temp.control(3,103,'enabled')$$,'owner explicitly enables current boot');
select is((select expires_at-enabled_at from public.engineering_worker_sessions where worker_id=pg_temp.w(20)),interval '8 hours','enabled session has fixed eight-hour deadline');
select throws_ok($$select pg_temp.control(4,104,'enabled')$$,'PT409',null,'active session cannot silently extend');
set local role service_role;
select is(pg_temp.eligible()->>'sessionEligible','true','current enabled session eligible');
select is(pg_temp.eligible(41)->>'sessionEligible','false','wrong boot ineligible');
set local role authenticated;
select lives_ok($$select pg_temp.control(4,104,'paused')$$,'owner pauses session');
select is((pg_temp.control(4,104,'paused')->>'revision')::int,5,'pause replay stable');
set local role service_role;
select is(pg_temp.eligible()->>'reason','paused','paused session ineligible');
set local role authenticated;
select lives_ok($$select pg_temp.control(5,105,'enabled')$$,'explicit re-enable creates new grant');
select is((select count(*) from public.engineering_worker_sessions where worker_id=pg_temp.w(20)),2::bigint,'prior paused grant preserved');
select is((pg_temp.control(3,103,'enabled')->>'revision')::int,4,'old enable receipt remains historical');
select is((select revision from public.engineering_workers where id=pg_temp.w(20)),6::bigint,'enable replay did not alter current revision');
set local role service_role;
select lives_ok($$select pg_temp.boot(6,106,41)$$,'restart registers different boot');
select is(pg_temp.eligible(41)->>'reason','owner_enablement_required','restart cannot inherit session');
select is(pg_temp.eligible()->>'reason','boot_mismatch','old process loses eligibility');
select is((pg_temp.boot(2,102)->>'revision')::int,3,'old boot replay returns original receipt');
select is((pg_temp.eligible(41)->>'bootId')::uuid,pg_temp.w(41),'old replay does not roll back current boot');
set local role authenticated;
select throws_ok($$select pg_temp.control(7,107,'enabled')$$,'PT409',null,'old boot cannot be newly enabled');
select lives_ok($$select pg_temp.control(7,107,'enabled',41)$$,'owner enables restarted boot');
reset role;
select throws_ok($$update public.engineering_workers set owner_user_id=pg_temp.w(2),revision=revision+1 where id=pg_temp.w(20)$$,'55000',null,'worker identity remains immutable');
select throws_ok($$update public.engineering_worker_sessions set expires_at=expires_at+interval '1 hour' where worker_id=pg_temp.w(20)$$,'55000',null,'grant cannot be extended in place');
select throws_ok($$delete from public.engineering_worker_events where worker_id=pg_temp.w(20)$$,'55000',null,'event history cannot be deleted');
select throws_ok($$update engineering_private.worker_credentials set credential_sha256=pg_temp.h(9) where worker_id=pg_temp.w(20)$$,'55000',null,'credential identity cannot be silently replaced');
select throws_ok($$update engineering_private.worker_pairings set consumed_at=null where worker_id=pg_temp.w(20)$$,'55000',null,'consumed pairing cannot be reset');
update engineering_private.engineering_operators set enabled=false where user_id=pg_temp.w(1);
set local role service_role;
select throws_ok($$select pg_temp.eligible(41)$$,'42501',null,'current access revocation denies eligibility');
select throws_ok($$select pg_temp.pair()$$,'42501',null,'current access revocation denies pairing replay');
set local role authenticated;
select is((select count(*) from public.engineering_worker_events),0::bigint,'revoked access hides history');
select throws_ok($$select pg_temp.control(7,107,'enabled',41)$$,'42501',null,'revoked access denies owner replay');
reset role;
update engineering_private.engineering_operators set enabled=true where user_id=pg_temp.w(1);
set local role authenticated;
select lives_ok($$select pg_temp.control(8,108,'revoked',null)$$,'owner revokes worker credential authority');
select is((pg_temp.control(8,108,'revoked',null)->>'revision')::int,9,'revocation replay works');
select throws_ok($$select pg_temp.control(9,109,'enabled',41)$$,'PT409',null,'revoked worker cannot be enabled');
select ok(not exists(select 1 from public.engineering_worker_events where receipt::text like '%'||pg_temp.h(1)||'%' or receipt::text like '%'||pg_temp.h(2)||'%'),'public receipts disclose no secret hashes');
set local role service_role;
select throws_ok($$select pg_temp.eligible(41)$$,'42501',null,'revoked credential loses eligibility');
select throws_ok($$select pg_temp.boot(6,106,41)$$,'42501',null,'revoked credential cannot replay boot');
select throws_ok($$select pg_temp.pair()$$,'42501',null,'revoked worker cannot replay pairing');
reset role;
-- Database-owner clock fixtures: these simulate boundaries, not elapsed runtime.
insert into public.engineering_workers(id,organization_id,project_id,owner_user_id,installation_id,current_boot_id)
 values(pg_temp.w(21),pg_temp.w(4),pg_temp.w(7),pg_temp.w(1),pg_temp.w(31),pg_temp.w(42));
insert into engineering_private.worker_credentials(worker_id,credential_sha256,paired_at)
 values(pg_temp.w(21),pg_temp.h(4),clock_timestamp()-interval '1 day');
insert into public.engineering_worker_sessions(id,worker_id,organization_id,project_id,owner_user_id,installation_id,boot_id,enabled_at,expires_at)
 values(pg_temp.w(50),pg_temp.w(21),pg_temp.w(4),pg_temp.w(7),pg_temp.w(1),pg_temp.w(31),pg_temp.w(42),now()-interval '9 hours',now()-interval '1 hour');
update public.engineering_workers set current_session_id=pg_temp.w(50),revision=revision+1 where id=pg_temp.w(21);
set local role service_role;
select is(public.api_worker_session_eligibility(pg_temp.w(21),pg_temp.h(4),pg_temp.w(42))->>'reason','expired','expired fixed grant denies eligibility');
select throws_ok($$select public.api_register_worker_boot(pg_temp.w(21),2,pg_temp.w(111),pg_temp.h(4),null)$$,'22023',null,'null boot refused');
set local role authenticated;
select throws_ok($$select public.api_control_worker_session(pg_temp.w(21),2,null,'enabled',pg_temp.w(42))$$,'22023',null,'missing idempotency key refused');
select lives_ok($$select public.api_control_worker_session(pg_temp.w(21),2,pg_temp.w(111),'enabled',pg_temp.w(42))$$,'expired grant requires explicit owner renewal');
reset role;
insert into public.engineering_workers(id,organization_id,project_id,owner_user_id)
 values(pg_temp.w(22),pg_temp.w(5),pg_temp.w(8),pg_temp.w(2));
insert into engineering_private.worker_pairings(worker_id,code_sha256,created_at,expires_at)
 values(pg_temp.w(22),pg_temp.h(5),now()-interval '11 minutes',now()-interval '1 minute');
set local role service_role;
select throws_ok($$select public.api_consume_worker_pairing(pg_temp.w(22),1,pg_temp.w(112),pg_temp.h(5),pg_temp.w(32),pg_temp.h(6))$$,'PT409',null,'expired unconsumed code refused');
reset role;
select is((select count(*) from engineering_private.worker_credentials where worker_id=pg_temp.w(22)),0::bigint,'expired pairing created no credential');
select throws_ok($$insert into public.engineering_worker_sessions(worker_id,organization_id,project_id,owner_user_id,installation_id,boot_id,enabled_at,expires_at) values(pg_temp.w(21),pg_temp.w(5),pg_temp.w(8),pg_temp.w(2),pg_temp.w(31),pg_temp.w(42),now(),now()+interval '8 hours')$$,'23503',null,'session scope foreign key prevents cross-tenant link');
select ok(not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('api_create_worker_pairing','api_consume_worker_pairing','api_register_worker_boot','api_control_worker_session','api_worker_session_eligibility') and p.prosecdef),'public entrypoints are invokers');
select * from finish();
rollback;
