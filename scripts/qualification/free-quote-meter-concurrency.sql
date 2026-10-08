-- Explicit, disposable database required: fixtures commit across sessions.
-- Never execute against a production/shared database. The release harness must
-- destroy its exclusively owned fixture database afterward; immutable receipts
-- intentionally have no deletion bypass. No trigger/security disabling here.
do $$ begin
 if current_database() !~ '^free_meter_fixture_[a-z0-9]+$' then
   raise exception 'Requires exclusively owned free_meter_fixture_<nonce> database';
 end if;
 if exists(select 1 from private.quote_access_admissions) or exists(select 1 from private.free_quote_policies) then
   raise exception 'Requires fresh empty meter fixture database';
 end if;
end $$;
create extension if not exists dblink with schema extensions;
select no_plan();
begin;
\set meter_fixture_limit 1
\ir ../../supabase/tests/fixtures/free_quote_meter_setup.inc
create function free_meter_fixture.try_request() returns jsonb language plpgsql as $$
begin return jsonb_build_object('requestId',free_meter_fixture.new_request());
exception when others then return jsonb_build_object('error',sqlerrm,'sqlstate',sqlstate); end $$;
create function free_meter_fixture.confirm_context() returns jsonb language plpgsql as $$
declare v_context free_meter_fixture.context%rowtype; v_scope jsonb;
begin
 select * into v_context from free_meter_fixture.context;
 perform free_meter_fixture.set_identity(v_context.user_id);
 v_scope:=public.api_get_xometry_beta_dispatch_scope(v_context.job_id,'inch');
 return public.api_request_xometry_beta_dispatch(v_context.job_id,'inch',v_scope->>'scopeFingerprint',
 'founding-beta-2026-08-15',v_context.approval_reference,true,true,true);
end $$;
create function free_meter_fixture.cancel(p_request uuid) returns jsonb language plpgsql as $$
begin
 perform free_meter_fixture.set_identity((select user_id from free_meter_fixture.context));
 return public.api_cancel_quote_request(p_request);
end $$;
create function free_meter_fixture.complete(p_request uuid) returns jsonb language plpgsql as $$
begin
 perform public.reconcile_vendor_quote_offers(free_meter_fixture.result_id(p_request),free_meter_fixture.result_payload(),free_meter_fixture.offers(p_request));
 return jsonb_build_object('completed',true);
exception when others then return jsonb_build_object('error',sqlerrm,'sqlstate',sqlstate); end $$;
commit;
select extensions.dblink_connect('meter_a','dbname='||current_database());
select extensions.dblink_connect('meter_b','dbname='||current_database());
create temporary table race_results(name text primary key,response jsonb);

-- Same approval races at the sole held slot: second response must acknowledge
-- the identical request, not test capacity for a second job.
select extensions.dblink_exec('meter_a','begin');
insert into race_results select 'same-a',response from extensions.dblink('meter_a',
 'select free_meter_fixture.confirm_context()') as row(response jsonb);
select extensions.dblink_send_query('meter_b','select free_meter_fixture.confirm_context()');
select pg_sleep(0.05);
select is(extensions.dblink_is_busy('meter_b'),1,'same approval waits for first commit');
select extensions.dblink_exec('meter_a','commit');
insert into race_results select 'same-b',response from extensions.dblink_get_result('meter_b') as row(response jsonb);
select is((select response->>'accepted' from race_results where name='same-a'),'true','first confirmed request accepted');
select is((select response->>'deduplicated' from race_results where name='same-b'),'true','concurrent same approval replays despite full slot');
select is((select response->>'quoteRequestId' from race_results where name='same-b'),
 (select response->>'quoteRequestId' from race_results where name='same-a'),'same race returns identical request');
select is((select count(*)::integer from private.quote_access_admissions),1,'same race creates one hold');
select * from extensions.dblink_get_result('meter_b') as row(response jsonb);
select free_meter_fixture.cancel((select (response->>'quoteRequestId')::uuid from race_results where name='same-a'));

-- A has reserved the sole slot but has not committed. B must wait, then deny;
-- its new job/request/task/permit creation is rolled back with the denied call.
select extensions.dblink_exec('meter_a','begin');
insert into race_results select 'first',response from extensions.dblink('meter_a',
 'select free_meter_fixture.try_request()') as row(response jsonb);
select is((select response->>'error' from race_results where name='first'),null::text,'first concurrent admission acquired slot');
select extensions.dblink_send_query('meter_b','select free_meter_fixture.try_request()');
select pg_sleep(0.05);
select is(extensions.dblink_is_busy('meter_b'),1,'second admission waits behind subject lock');
select extensions.dblink_exec('meter_a','commit');
insert into race_results select 'second',response from extensions.dblink_get_result('meter_b') as row(response jsonb);
select is((select response->>'error' from race_results where name='second'),'free_allowance_unavailable','last slot permits exactly one new request');
select is((select count(*)::integer from private.quote_access_admissions),2,'only same-approval receipt plus distinct winner; none from denied race');
select is((select count(*)::integer from private.xometry_beta_dispatch_permits where organization_id=(select organization_id from free_meter_fixture.context)),2,'denied admission has no orphan permit');
select is((select count(*)::integer from public.work_queue where task_type='run_vendor_quote' and organization_id=(select organization_id from free_meter_fixture.context)),2,'denied admission has no orphan provider task');
-- Drain the async query completion before reusing the connection.
select * from extensions.dblink_get_result('meter_b') as row(response jsonb);

-- Cancellation wins while late canonical writer owns its result and waits for
-- request. BEFORE fence must prevent the old reducer overwriting canceled.
select extensions.dblink_exec('meter_a','begin');
insert into race_results select 'cancel-first',response from extensions.dblink('meter_a',
 format('select free_meter_fixture.cancel(%L::uuid)',(select response->>'requestId' from race_results where name='first'))) as row(response jsonb);
select extensions.dblink_send_query('meter_b',format('select free_meter_fixture.complete(%L::uuid)',
 (select response->>'requestId' from race_results where name='first')));
select pg_sleep(0.05);
select is(extensions.dblink_is_busy('meter_b'),1,'late finalizer waits for cancellation');
select extensions.dblink_exec('meter_a','commit');
insert into race_results select 'late-finalize',response from extensions.dblink_get_result('meter_b') as row(response jsonb);
select is((select response->>'error' from race_results where name='late-finalize'),'free_quote_terminal_fenced','late canonical response is fenced');
select is((select status::text from public.quote_requests where id=(select (response->>'requestId')::uuid from race_results where name='first')),'canceled','concurrent reducer cannot overwrite cancel');
select is((select state from private.quote_access_admissions where quote_request_id=(select (response->>'requestId')::uuid from race_results where name='first')),'released','cancellation consumes no quota');
select * from extensions.dblink_get_result('meter_b') as row(response jsonb);

-- Released slot is reusable. Canonical completion wins the opposite race;
-- customer cancellation must then observe already_received, never refund it.
insert into race_results select 'third',response from extensions.dblink('meter_a',
 'select free_meter_fixture.try_request()') as row(response jsonb);
select extensions.dblink_exec('meter_a','begin');
insert into race_results select 'complete-first',response from extensions.dblink('meter_a',
 format('select free_meter_fixture.complete(%L::uuid)',(select response->>'requestId' from race_results where name='third'))) as row(response jsonb);
select is((select response->>'completed' from race_results where name='complete-first'),'true','canonical completion succeeds');
select extensions.dblink_send_query('meter_b',format('select free_meter_fixture.cancel(%L::uuid)',
 (select response->>'requestId' from race_results where name='third')));
select pg_sleep(0.05);
select is(extensions.dblink_is_busy('meter_b'),1,'cancel waits for completing request');
select extensions.dblink_exec('meter_a','commit');
insert into race_results select 'late-cancel',response from extensions.dblink_get_result('meter_b') as row(response jsonb);
select is((select response->>'reasonCode' from race_results where name='late-cancel'),'already_received','completed request cannot be canceled/refunded');
select is((select count(*)::integer from private.quote_access_admissions where state='consumed'),1,'one completion retained');
select * from extensions.dblink_get_result('meter_b') as row(response jsonb);
select extensions.dblink_disconnect('meter_a');
select extensions.dblink_disconnect('meter_b');
select * from finish();
-- Release harness must discard the named isolated DB after collecting TAP.
