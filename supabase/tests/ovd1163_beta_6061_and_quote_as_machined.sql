-- OVD-1163: the controlled Xometry beta Material and Finish checks.
--   6061 written without a temper ("6061", "6061 Alloy", "Al 6061",
--   "6061 aluminum", "Aluminum 6061") passes as 6061-T6, as do T651, T6511
--   and T6/T651; any other stated temper and any other material is refused;
--   a drawing finish is refused until the customer chooses "Quote as machined"
--   for that exact finish, which never changes the finish column;
--   public.api_set_client_part_quote_as_machined is edit-access only.
-- Rollback drill: the restored OVD-1007 body refuses "6061 Alloy" and the
-- chosen as-machined finish again, and the new RPC is gone.
-- Synthetic rows only; the whole file rolls back.
begin;
select plan(59);

\set meter_fixture_limit 20
\ir fixtures/free_quote_meter_setup.inc

create schema ovd1163_fixture;

-- The scope check's answer for the fixture part with this material and finish.
create function ovd1163_fixture.scope_check(p_material text, p_finish text)
returns text
language plpgsql
as $$
declare
  v_scope jsonb;
begin
  -- Outside the handler, so a refusal keeps the material and finish it was given.
  update public.approved_part_requirements set material = p_material, finish = p_finish
  where part_id = (select part_id from free_meter_fixture.context);
  perform free_meter_fixture.set_identity((select user_id from free_meter_fixture.context));
  begin
    v_scope := public.api_get_xometry_beta_dispatch_scope((select job_id from free_meter_fixture.context), 'inch');
  exception when others then
    return sqlerrm;
  end;
  return case when v_scope ->> 'scopeFingerprint' is null then 'no scope' else 'ok' end;
end;
$$;

create function ovd1163_fixture.requirement()
returns public.approved_part_requirements
language sql
as $$
  select requirement.* from public.approved_part_requirements requirement
  where requirement.part_id = (select part_id from free_meter_fixture.context)
$$;

-- Calls the RPC as an authenticated user, returning its answer or the error.
create function ovd1163_fixture.choose(p_user uuid, p_quote_as_machined boolean)
returns text
language plpgsql
as $$
declare
  v_job uuid := (select job_id from free_meter_fixture.context);
  v_result jsonb;
begin
  perform free_meter_fixture.set_identity(p_user);
  set local role authenticated;
  v_result := public.api_set_client_part_quote_as_machined(v_job, p_quote_as_machined);
  reset role;
  return v_result ->> 'quoteAsMachined';
exception when others then
  reset role;
  return sqlerrm;
end;
$$;

insert into auth.users (id, aud, role, email, email_confirmed_at)
values ('11630000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'ovd1163-outsider@example.test', now());

-- ---------------------------------------------------------------- A. the definitions
select is((select pg_catalog.md5(prosrc) from pg_catalog.pg_proc
  where oid = 'private.resolve_xometry_beta_dispatch_scope_with_access(uuid,text,uuid)'::regprocedure),
  '4fd2484f5bfe9b524f5916b7e99ec88e', 'the resolver is the OVD-1163 body');
select is((select pg_catalog.md5(prosrc) from pg_catalog.pg_proc
  where oid = 'public.api_set_client_part_quote_as_machined(uuid,boolean)'::regprocedure),
  '3da7b3c9b4ab9db0d84abd38136182a1', 'the quote-as-machined RPC is the reviewed body');
select ok((select prosecdef from pg_catalog.pg_proc where oid = 'public.api_set_client_part_quote_as_machined(uuid,boolean)'::regprocedure),
  'the RPC is SECURITY DEFINER');
select is((select proconfig from pg_catalog.pg_proc where oid = 'public.api_set_client_part_quote_as_machined(uuid,boolean)'::regprocedure),
  array['search_path=pg_catalog'], 'the RPC pins search_path');
select ok(has_function_privilege('authenticated', 'public.api_set_client_part_quote_as_machined(uuid,boolean)', 'execute'),
  'authenticated can call the RPC');
select ok(not has_function_privilege('anon', 'public.api_set_client_part_quote_as_machined(uuid,boolean)', 'execute'),
  'anon cannot call the RPC');
select ok(not has_function_privilege('service_role', 'public.api_set_client_part_quote_as_machined(uuid,boolean)', 'execute'),
  'service_role cannot call the RPC');
select ok(not has_function_privilege('authenticated', 'private.resolve_xometry_beta_dispatch_scope_with_access(uuid,text,uuid)', 'execute'),
  'the resolver stays owner-only');
select is((select proconfig from pg_catalog.pg_proc where oid = 'private.resolve_xometry_beta_dispatch_scope_with_access(uuid,text,uuid)'::regprocedure),
  array['search_path=pg_catalog'], 'the resolver keeps its search_path');

-- ---------------------------------------------------------------- B. Material
select is(ovd1163_fixture.scope_check(material, 'As machined'), 'ok', format('Material %L is quoted as 6061-T6', material))
from (values ('6061'), ('6061 Alloy'), ('Al 6061'), ('6061 aluminum'), ('Aluminum 6061'), ('  aluminium 6061 '),
  ('AL-6061'), ('6061-T6'), ('6061-T6 Aluminum'), ('Aluminum 6061-T6'), ('Aluminum Alloy 6061-T6'), ('6061-T651'),
  ('Aluminum 6061-T6511'), ('6061-T6/T651')) as accepted(material);

select is(ovd1163_fixture.scope_check(material, 'As machined'), 'xometry_beta_6061_t6_required', format('Material %L is refused', material))
from (values ('6061-O'), ('6061 O'), ('6061-T4'), ('Aluminum 6061-T4'), ('6061-T451'), ('6061-F'), ('6061-T62'),
  ('7075-T6'), ('Aluminum'), ('16061'), ('60610'), ('6061 steel')) as refused(material);

-- ---------------------------------------------------------------- C. Finish
\set drawing_finish '''ANODIZE, BLACK, MIL-A-8625F, TYPE II CLASS 2'''
select is(ovd1163_fixture.scope_check('6061 Alloy', ''), 'ok', 'a blank finish is quoted as machined');
select is(ovd1163_fixture.scope_check('6061 Alloy', :drawing_finish), 'xometry_beta_as_machined_required',
  'a drawing finish is refused before any choice');

select is(ovd1163_fixture.choose('11630000-0000-4000-8000-000000000001', true),
  format('You do not have permission to edit job %s.', (select job_id from free_meter_fixture.context)),
  'a user without edit access cannot choose');
select ok((ovd1163_fixture.requirement()).spec_snapshot -> 'quoteAsMachined' is null, 'the refused call wrote nothing');

select is(ovd1163_fixture.choose((select user_id from free_meter_fixture.context), true), 'true', 'the editor chooses Quote as machined');
select is((ovd1163_fixture.requirement()).finish, :drawing_finish, 'the drawing finish is unchanged');
select is((ovd1163_fixture.requirement()).spec_snapshot #>> '{quoteAsMachined,finish}', :drawing_finish,
  'the choice names the finish it overrides');
select is((ovd1163_fixture.requirement()).spec_snapshot ->> 'process', 'CNC milling', 'the rest of the snapshot is kept');
select is((select count(*)::integer from public.audit_events
  where job_id = (select job_id from free_meter_fixture.context) and event_type = 'client.part_quote_as_machined_set'),
  1, 'the choice is audited once');
select is(ovd1163_fixture.choose((select user_id from free_meter_fixture.context), true), 'true', 'choosing again is a no-op');
select is((select count(*)::integer from public.audit_events
  where job_id = (select job_id from free_meter_fixture.context) and event_type = 'client.part_quote_as_machined_set'),
  1, 'a no-op is not audited');

select is(ovd1163_fixture.scope_check('6061 Alloy', :drawing_finish), 'ok', 'the chosen finish is quoted as machined');
select is((select (public.api_get_xometry_beta_dispatch_scope((select job_id from free_meter_fixture.context), 'inch'))
    #>> '{scope,requirements,finish}'), :drawing_finish, 'the scope still carries the drawing finish');
select is((select (public.api_get_xometry_beta_dispatch_scope((select job_id from free_meter_fixture.context), 'inch'))
    #>> '{scope,requirements,specification,quoteAsMachined,finish}'), :drawing_finish,
  'the scope (and so its fingerprint) carries the choice');
select is(ovd1163_fixture.scope_check('6061 Alloy', 'anodize black mil-a-8625f type ii class 2'), 'ok',
  'the finish matches case- and punctuation-insensitively');
select is(ovd1163_fixture.scope_check('6061 Alloy', 'Bead blast'), 'xometry_beta_as_machined_required',
  'editing the finish withdraws the choice');
select is(ovd1163_fixture.scope_check('6061-O', :drawing_finish), 'xometry_beta_6061_t6_required',
  'the choice does not change the Material check');

select is(ovd1163_fixture.choose((select user_id from free_meter_fixture.context), false), 'false', 'the editor withdraws the choice');
select ok((ovd1163_fixture.requirement()).spec_snapshot -> 'quoteAsMachined' is null, 'withdrawing removes the choice');
select is(ovd1163_fixture.scope_check('6061 Alloy', :drawing_finish), 'xometry_beta_as_machined_required',
  'the drawing finish is refused again');

select is(ovd1163_fixture.scope_check('6061 Alloy', 'As machined'), 'ok', 'reset to as machined');
select is(ovd1163_fixture.choose((select user_id from free_meter_fixture.context), true), 'false',
  'an as-machined part needs no choice');
select ok((ovd1163_fixture.requirement()).spec_snapshot -> 'quoteAsMachined' is null, 'and none is stored');

-- ---------------------------------------------------------------- D. rollback drill
update public.approved_part_requirements set finish = :drawing_finish
where part_id = (select part_id from free_meter_fixture.context);
select is(ovd1163_fixture.choose((select user_id from free_meter_fixture.context), true), 'true', 'choice stored before the rollback');
savepoint rollback_drill;
\ir fixtures/ovd1163_rollback.inc
select is((select pg_catalog.md5(prosrc) from pg_catalog.pg_proc
  where oid = 'private.resolve_xometry_beta_dispatch_scope_with_access(uuid,text,uuid)'::regprocedure),
  '1d482bb5747127128e041549291eae6e', 'the rollback restores the OVD-1007 resolver byte for byte');
select ok(to_regprocedure('public.api_set_client_part_quote_as_machined(uuid,boolean)') is null, 'the rollback drops the RPC');
select is(ovd1163_fixture.scope_check('6061 Alloy', 'As machined'), 'xometry_beta_6061_t6_required',
  'after the rollback 6061 without a temper is refused again');
select is(ovd1163_fixture.scope_check('6061-T6 Aluminum', :drawing_finish), 'xometry_beta_as_machined_required',
  'after the rollback the chosen finish is refused again');
rollback to savepoint rollback_drill;

select * from finish();
rollback;
