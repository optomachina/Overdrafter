create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
set search_path = public, extensions;
select plan(13);

-- These exact synthetic rows must not survive a committed concurrency test.
create or replace function pg_temp.ovd570_cleanup_race_fixture()
returns void language plpgsql set search_path = pg_catalog as $$
begin
  delete from public.approved_part_requirements where part_id='88000000-0000-4000-8000-000000000005';
  delete from public.parts where id='88000000-0000-4000-8000-000000000005';
  delete from public.part_versions where organization_id='88000000-0000-4000-8000-000000000003';
  delete from public.canonical_parts where organization_id='88000000-0000-4000-8000-000000000003';
  delete from public.jobs where id='88000000-0000-4000-8000-000000000004';
  delete from public.organizations where id='88000000-0000-4000-8000-000000000003';
  delete from auth.users where id in ('88000000-0000-4000-8000-000000000001','88000000-0000-4000-8000-000000000002');
end;
$$;
select pg_temp.ovd570_cleanup_race_fixture();

insert into auth.users (id, aud, role, email, email_confirmed_at) values
  ('88000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'sourcing-race-editor@example.test', now()),
  ('88000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'sourcing-race-owner@example.test', now());
insert into public.organizations (id, name, slug, shipping_same_as_billing,
  shipping_street, shipping_city, shipping_state, shipping_zip, shipping_country)
values ('88000000-0000-4000-8000-000000000003', 'Sourcing race', 'sourcing-race',
  false, '123 Test Ave', 'Tucson', 'AZ', '85701', 'US');
insert into public.organization_memberships (organization_id, user_id, role)
values ('88000000-0000-4000-8000-000000000003', '88000000-0000-4000-8000-000000000001', 'internal_admin');
insert into public.jobs (id, organization_id, created_by, title)
values ('88000000-0000-4000-8000-000000000004', '88000000-0000-4000-8000-000000000003',
  '88000000-0000-4000-8000-000000000002', 'Sourcing race');
insert into public.parts (id, job_id, organization_id, name, normalized_key)
values ('88000000-0000-4000-8000-000000000005', '88000000-0000-4000-8000-000000000004',
  '88000000-0000-4000-8000-000000000003', 'Race part', 'race-part');
insert into public.approved_part_requirements (part_id, organization_id, approved_by, material, revision, requested_by_date)
values ('88000000-0000-4000-8000-000000000005', '88000000-0000-4000-8000-000000000003',
  '88000000-0000-4000-8000-000000000002', '6061-T6', 'A', current_date + 10);

create or replace function public.ovd570_race_attempt(p_kind text) returns text language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    '{"sub":"88000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}', true);
  if p_kind = 'address' then
    perform public.api_confirm_sourcing_destination('88000000-0000-4000-8000-000000000003',
      '{"street":"123 Test Ave","city":"Tucson","region":"AZ","postalCode":"85701","country":"US"}'::jsonb);
  else
    perform public.api_confirm_part_deadline('88000000-0000-4000-8000-000000000005', 'A', current_date + 10);
  end if;
  return 'confirmed';
exception when others then return sqlerrm;
end;
$$;

create function pg_temp.ovd570_wait_for_lock() returns boolean language plpgsql as $$
begin
  for attempt in 1..150 loop
    perform pg_stat_clear_snapshot();
    if exists (select 1 from pg_stat_activity where application_name = 'ovd570-race' and wait_event_type = 'Lock') then
      return true;
    end if;
    perform pg_sleep(0.02);
  end loop;
  return false;
end;
$$;
select extensions.dblink_connect('ovd570-race', coalesce(
  nullif(current_setting('ovd.test_conninfo', true), ''),
  'host=host.docker.internal port=54322 dbname=postgres user=postgres password=postgres' -- NOSONAR: ephemeral local Supabase fallback; override with ovd.test_conninfo elsewhere
) || ' application_name=ovd570-race');
select extensions.dblink_exec('ovd570-race', 'set statement_timeout = ''10s''');

begin;
select id from public.organizations where id = '88000000-0000-4000-8000-000000000003' for update;
select extensions.dblink_send_query('ovd570-race', $$select public.ovd570_race_attempt('address')$$);
select ok(pg_temp.ovd570_wait_for_lock(), 'destination confirmation actually waits on the organization row');
delete from public.organization_memberships where organization_id = '88000000-0000-4000-8000-000000000003';
commit;
select is((select result from extensions.dblink_get_result('ovd570-race') as response(result text)),
  'sourcing_destination_access_denied', 'admin revocation while waiting prevents destination confirmation');
select * from extensions.dblink_get_result('ovd570-race') as response(result text);
select is((select count(*) from private.sourcing_destination_history
  where organization_id = '88000000-0000-4000-8000-000000000003' and state = 'confirmed'),
  0::bigint, 'revoked destination request appends no confirmation');

insert into public.organization_memberships (organization_id, user_id, role)
values ('88000000-0000-4000-8000-000000000003', '88000000-0000-4000-8000-000000000001', 'internal_admin');
begin;
select id from public.approved_part_requirements where part_id = '88000000-0000-4000-8000-000000000005' for update;
select extensions.dblink_send_query('ovd570-race', $$select public.ovd570_race_attempt('deadline')$$);
select ok(pg_temp.ovd570_wait_for_lock(), 'deadline confirmation actually waits on the requirement row');
delete from public.organization_memberships where organization_id = '88000000-0000-4000-8000-000000000003';
commit;
select is((select result from extensions.dblink_get_result('ovd570-race') as response(result text)),
  'part_deadline_access_denied', 'editor revocation while waiting prevents deadline confirmation');
select * from extensions.dblink_get_result('ovd570-race') as response(result text);
select is((select count(*) from private.part_deadline_history
  where part_id = '88000000-0000-4000-8000-000000000005' and state = 'confirmed'),
  0::bigint, 'revoked deadline request appends no confirmation');

insert into public.organization_memberships (organization_id, user_id, role)
values ('88000000-0000-4000-8000-000000000003', '88000000-0000-4000-8000-000000000001', 'internal_admin');
begin;
select id from public.organizations where id = '88000000-0000-4000-8000-000000000003' for update;
select extensions.dblink_send_query('ovd570-race', $$select public.ovd570_race_attempt('address')$$);
select ok(pg_temp.ovd570_wait_for_lock(), 'address edit race waits before comparison');
update public.organizations set shipping_street='Changed while waiting'
where id='88000000-0000-4000-8000-000000000003';
commit;
select is((select result from extensions.dblink_get_result('ovd570-race') as response(result text)),
  'sourcing_destination_changed', 'address edited during lock wait cannot be confirmed using stale input');
select * from extensions.dblink_get_result('ovd570-race') as response(result text);

begin;
select id from public.approved_part_requirements where part_id='88000000-0000-4000-8000-000000000005' for update;
select extensions.dblink_send_query('ovd570-race', $$select public.ovd570_race_attempt('deadline')$$);
select ok(pg_temp.ovd570_wait_for_lock(), 'revision race waits before comparison');
update public.approved_part_requirements set revision='B' where part_id='88000000-0000-4000-8000-000000000005';
commit;
select is((select result from extensions.dblink_get_result('ovd570-race') as response(result text)),
  'part_deadline_changed', 'revision changed during lock wait cannot inherit confirmation');
select * from extensions.dblink_get_result('ovd570-race') as response(result text);

update public.organizations set shipping_street='123 Test Ave' where id='88000000-0000-4000-8000-000000000003';
begin;
select id from public.organizations where id='88000000-0000-4000-8000-000000000003' for update;
select extensions.dblink_send_query('ovd570-race', $$select public.ovd570_race_attempt('address')$$);
select ok(pg_temp.ovd570_wait_for_lock(), 'verified-auth revocation race waits on the row');
update auth.users set email_confirmed_at=null where id='88000000-0000-4000-8000-000000000001';
commit;
select matches((select result from extensions.dblink_get_result('ovd570-race') as response(result text)),
  '^Verify your email', 'verified-auth revocation during lock wait blocks confirmation');
select * from extensions.dblink_get_result('ovd570-race') as response(result text);
select is((select count(*) from private.sourcing_destination_history
  where organization_id='88000000-0000-4000-8000-000000000003' and state='confirmed'),
  0::bigint, 'all rejected races leave no confirmed destination history');
select extensions.dblink_disconnect('ovd570-race');
drop function public.ovd570_race_attempt(text);
select pg_temp.ovd570_cleanup_race_fixture();
select * from finish();
