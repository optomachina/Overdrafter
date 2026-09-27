-- Injected after the successful synthetic stop in engineering_native_ownership.sql.
-- The caller rolls back the whole transaction; Storage rows are metadata-only.
insert into storage.buckets(id,name,public)
values('ovd560-synthetic','ovd560-synthetic',false);
insert into storage.objects(bucket_id,name,version)
values('ovd560-synthetic','fixture/registered-result.json','ovd560-original');

create function pg_temp.register_result(
  p_organization_id uuid default pg_temp.n(4), p_fence bigint default 2,
  p_sha256 text default null)
returns boolean language sql as $body$
  select engineering_private.register_native_result_object(
    p_organization_id,pg_temp.n(7),pg_temp.task(1,31),pg_temp.other_attempt(),
    p_fence,pg_temp.n(20),a.output_snapshot_id,'result',
    obj.bucket_id,obj.name,obj.id,obj.version,obj.updated_at,100,
    coalesce(p_sha256,pg_temp.h(30)))
  from public.engineering_execution_attempts a
    cross join storage.objects obj
  where a.id=pg_temp.other_attempt()
    and obj.bucket_id='ovd560-synthetic' and obj.name='fixture/registered-result.json';
$body$;

select is(pg_temp.register_result(),true,'registered exact successful attempt and private object');
select is(pg_temp.register_result(),false,'identical retry is idempotent');
select throws_ok($$select pg_temp.register_result(pg_temp.n(5))$$,'42501',null,
  'cross-tenant registration rejects');
select throws_ok($$select pg_temp.register_result(pg_temp.n(4),1)$$,'42501',null,
  'stale fence registration rejects');
select throws_ok($$select pg_temp.register_result(pg_temp.n(4),2,pg_temp.h(31))$$,'23505',null,
  'mismatched digest replay rejects');
select throws_ok($$delete from engineering_private.native_verifier_registered_objects
  where attempt_id=pg_temp.other_attempt()$$,'23514',null,'registration cannot be deleted');
select throws_ok($$update engineering_private.native_verifier_registered_objects
  set sha256=pg_temp.h(31) where attempt_id=pg_temp.other_attempt()$$,'23514',null,
  'registration cannot be rewritten');

-- Disposable helper grants let this SQL fixture construct JWT claims. They do
-- not change any application schema or the verifier's seven-call allowlist.
grant execute on function pg_temp.n(integer), pg_temp.task(integer,integer),
  pg_temp.other_attempt() to engineering_native_verifier;
set local role engineering_native_verifier;
select set_config('request.jwt.claim.role','engineering_native_verifier',true);
select set_config('request.jwt.claims',jsonb_build_object(
  'organization_id',pg_temp.n(4),'project_id',pg_temp.n(7),
  'task_id',pg_temp.task(1,31),'attempt_id',pg_temp.other_attempt(),'fence',2)::text,true);
select set_config('ovd560.registered_count',
  (select count(*) from storage.objects where bucket_id='ovd560-synthetic')::text,true);
select set_config('request.jwt.claims',jsonb_build_object(
  'organization_id',pg_temp.n(5),'project_id',pg_temp.n(7),
  'task_id',pg_temp.task(1,31),'attempt_id',pg_temp.other_attempt(),'fence',2)::text,true);
select set_config('ovd560.foreign_count',
  (select count(*) from storage.objects where bucket_id='ovd560-synthetic')::text,true);
reset role;
select is(current_setting('ovd560.registered_count'),'1','verifier sees exact registered Storage row');
select is(current_setting('ovd560.foreign_count'),'0','foreign tenant verifier cannot read registered object');
select ok(not has_function_privilege('engineering_native_verifier',
  'engineering_private.register_native_result_object(uuid,uuid,uuid,uuid,bigint,uuid,uuid,text,text,text,uuid,text,timestamptz,bigint,text)',
  'EXECUTE'),'verifier cannot invoke registration helper');

update storage.objects set version='ovd560-substituted'
  where bucket_id='ovd560-synthetic';
set local role engineering_native_verifier;
select set_config('request.jwt.claims',jsonb_build_object(
  'organization_id',pg_temp.n(4),'project_id',pg_temp.n(7),
  'task_id',pg_temp.task(1,31),'attempt_id',pg_temp.other_attempt(),'fence',2)::text,true);
select set_config('ovd560.substituted_count',
  (select count(*) from storage.objects where bucket_id='ovd560-synthetic')::text,true);
reset role;
select is(current_setting('ovd560.substituted_count'),'0',
  'Storage metadata substitution closes verifier read');
