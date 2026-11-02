-- OVD-994 synthetic qualification. No external/provider operations; transaction rolls back.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(18);

-- Drill the exact rollback inside a savepoint, leaving the applied schema intact.
savepoint rollback_drill;
\ir fixtures/ovd994_rollback.inc
select ok(to_regprocedure('public.api_clear_client_part_requested_by_date(uuid)') is null, 'rollback drops narrow RPC');
select is((select md5(prosrc) from pg_proc where oid = 'public.api_update_client_part_request(uuid,text[],text,text,text,text,text,text,text,text,numeric,text,text,integer,integer[],date,jsonb,jsonb,jsonb,jsonb)'::regprocedure),
  '93b90366752f07ea233030e895873e73', 'rollback restores previous prosrc exactly');
rollback to savepoint rollback_drill;

insert into auth.users (id, aud, role, email, email_confirmed_at, raw_app_meta_data) values
 ('99400000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'ovd994-editor@example.test', now(), '{"provider":"email"}'),
 ('99400000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'ovd994-outsider@example.test', now(), '{"provider":"email"}');
insert into public.organizations (id,name,slug) values
 ('99400000-0000-4000-8000-000000000003','OVD994 synthetic','ovd994');
insert into public.organization_memberships (organization_id,user_id,role) values
 ('99400000-0000-4000-8000-000000000003','99400000-0000-4000-8000-000000000001','client');
insert into public.jobs (id,organization_id,created_by,title,status,requested_by_date) values
 ('99400000-0000-4000-8000-000000000004','99400000-0000-4000-8000-000000000003','99400000-0000-4000-8000-000000000001','OVD994 synthetic','ready_to_quote','2026-12-01');
insert into public.parts (id,job_id,organization_id,name,normalized_key) values
 ('99400000-0000-4000-8000-000000000005','99400000-0000-4000-8000-000000000004','99400000-0000-4000-8000-000000000003','OVD994 part','ovd994');
insert into public.drawing_extractions (part_id,organization_id,extractor_version,extraction) values
 ('99400000-0000-4000-8000-000000000005','99400000-0000-4000-8000-000000000003','synthetic-ovd994','{"threads":["M6x1"],"material":{"normalized":"6061"}}');
insert into public.approved_part_requirements (part_id,organization_id,approved_by,material,quantity,requested_by_date,spec_snapshot,approved_at) values
 ('99400000-0000-4000-8000-000000000005','99400000-0000-4000-8000-000000000003','99400000-0000-4000-8000-000000000001','6061',1,'2026-12-01',
 '{"requestedByDate":"2026-12-01","threads":null,"notes":"Keep me","other":{"nested":true}}','2026-10-01');
create temp table before_clear as select to_jsonb(r) as row from public.approved_part_requirements r where part_id = '99400000-0000-4000-8000-000000000005';
select set_config('request.jwt.claims','{"sub":"99400000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}',true);
set local role authenticated;
select lives_ok($$select public.api_clear_client_part_requested_by_date('99400000-0000-4000-8000-000000000004')$$, 'editor clears Need by');
reset role;
select is((select requested_by_date from public.jobs where id = '99400000-0000-4000-8000-000000000004'), null::date, 'job date cleared');
select is((select requested_by_date from public.approved_part_requirements where part_id = '99400000-0000-4000-8000-000000000005'), null::date, 'requirement date cleared');
select is((select spec_snapshot from public.approved_part_requirements where part_id = '99400000-0000-4000-8000-000000000005'),
 (select jsonb_set(row -> 'spec_snapshot','{requestedByDate}','null') from before_clear), 'only snapshot date changes, no Threads added');
select is((select to_jsonb(r) - array['requested_by_date','spec_snapshot','updated_at'] from public.approved_part_requirements r where part_id = '99400000-0000-4000-8000-000000000005'),
 (select row - array['requested_by_date','spec_snapshot','updated_at'] from before_clear), 'approval and every other requirement value unchanged');
select is((select array_agg(event_type order by event_type) from public.audit_events where job_id = '99400000-0000-4000-8000-000000000004'),
 array['client.part_requested_by_date_cleared']::text[], 'dedicated date-clear audit only, no full-save audit');
create temp table after_clear as select to_jsonb(r) as row from public.approved_part_requirements r where part_id = '99400000-0000-4000-8000-000000000005';
create temp table audit_count as select count(*) as n from public.audit_events where job_id = '99400000-0000-4000-8000-000000000004';
set local role authenticated;
select public.api_clear_client_part_requested_by_date('99400000-0000-4000-8000-000000000004');
reset role;
select is((select to_jsonb(r) from public.approved_part_requirements r where part_id = '99400000-0000-4000-8000-000000000005'), (select row from after_clear), 'already null is a row-level no-op');
select is((select count(*) from public.audit_events where job_id = '99400000-0000-4000-8000-000000000004'), (select n from audit_count), 'no duplicate audit on no-op');
select set_config('request.jwt.claims','{"sub":"99400000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal1"}',true);
set local role authenticated;
select throws_ok($$select public.api_clear_client_part_requested_by_date('99400000-0000-4000-8000-000000000004')$$,
 'P0001', 'You do not have permission to edit job 99400000-0000-4000-8000-000000000004.', 'non-editor refused');
reset role;
select set_config('request.jwt.claims','{"sub":"99400000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}',true);
set local role authenticated;
select public.api_update_client_part_request(p_job_id => '99400000-0000-4000-8000-000000000004',p_material => '6061',p_clear_threads => false);
reset role;
select is((select spec_snapshot ->> 'threads' from public.approved_part_requirements where part_id = '99400000-0000-4000-8000-000000000005'), 'M6x1', 'false retains extracted Threads fallback');
set local role authenticated;
select public.api_update_client_part_request(p_job_id => '99400000-0000-4000-8000-000000000004',p_material => '6061',p_clear_threads => true);
reset role;
select is((select spec_snapshot ->> 'threads' from public.approved_part_requirements where part_id = '99400000-0000-4000-8000-000000000005'), '', 'true clears Threads despite drawing callouts');
select is((select spec_snapshot #>> '{projectPartProperties,defaults,threads}' from public.approved_part_requirements where part_id = '99400000-0000-4000-8000-000000000005'), 'M6x1', 'clearing preserves extracted default for reset');
set local role authenticated;
select public.api_update_client_part_request(p_job_id => '99400000-0000-4000-8000-000000000004',p_material => '6061',p_threads => '');
reset role;
select is((select spec_snapshot ->> 'threads' from public.approved_part_requirements where part_id = '99400000-0000-4000-8000-000000000005'), '', 'later save preserves explicit empty override');
set local role authenticated;
select public.api_reset_client_part_property_overrides('99400000-0000-4000-8000-000000000004', array['finish']);
reset role;
select is((select spec_snapshot ->> 'threads' from public.approved_part_requirements where part_id = '99400000-0000-4000-8000-000000000005'), '', 'resetting another property preserves empty Threads');
select ok(not has_function_privilege('anon','public.api_clear_client_part_requested_by_date(uuid)','execute'), 'anon cannot clear Need by');
select ok(not has_function_privilege('anon','public.api_update_client_part_request(uuid,text[],text,text,text,text,text,text,text,text,numeric,text,text,integer,integer[],date,jsonb,jsonb,jsonb,jsonb,boolean)','execute'), 'anon cannot update Threads');
select * from finish();
rollback;
