-- Run after OVD-561's proof in the same disposable transaction: it supplies
-- one finalized task, owner, current candidate and exact source snapshot.
select 'ovd563-proof-start';
select ok(not has_table_privilege('authenticated','engineering_private.native_step_reviews','SELECT'),
  'authenticated cannot read private STEP table');
select ok(not has_table_privilege('service_role','engineering_private.native_step_reviews','INSERT, UPDATE, SELECT'),
  'service role cannot write or read private STEP table');
select ok(not has_function_privilege('service_role',
  'engineering_private.associate_native_step_review(uuid,uuid,uuid,text,text,uuid,text,text,text,bytea)','EXECUTE'),
  'service role cannot associate STEP bytes');
select ok(has_function_privilege('authenticated','public.api_read_native_step_review(uuid,uuid,uuid)','EXECUTE'),
  'authenticated actor can call review RPC');
select ok(not has_function_privilege('anon','public.api_read_native_step_review(uuid,uuid,uuid)','EXECUTE'),
  'anonymous actor cannot call review RPC');

create function pg_temp.step_review_bytes() returns bytea language sql as $body$
  select convert_to(E'ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;','UTF8');
$body$;
create function pg_temp.step_review_snapshot() returns uuid language sql security definer set search_path = '' as $body$
  select snapshot_id from engineering_private.native_finalizations where attempt_id=pg_temp.other_attempt();
$body$;
create function pg_temp.step_review_store(p_bytes bytea default null, p_digest text default null,
  p_snapshot uuid default null) returns boolean language sql as $body$
  select engineering_private.associate_native_step_review(f.task_id,
    (f.payload_text::jsonb->>'inputSnapshotId')::uuid,
    coalesce(p_snapshot,f.snapshot_id),f.payload_text::jsonb->>'candidateContextSha256',
    f.payload_text::jsonb->>'resultSha256',pg_temp.n(994),repeat('a',40),repeat('b',64),
    coalesce(p_digest,encode(extensions.digest(coalesce(p_bytes,pg_temp.step_review_bytes()),'sha256'),'hex')),
    coalesce(p_bytes,pg_temp.step_review_bytes()))
  from engineering_private.native_finalizations f where f.attempt_id=pg_temp.other_attempt();
$body$;
set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub',pg_temp.n(1)::text,true);
select is((public.api_read_native_step_review(pg_temp.n(31),pg_temp.task(1,31),
  pg_temp.step_review_snapshot()))->>'status',
  'unavailable','missing STEP is unavailable for the verified candidate');
select is((public.api_read_native_step_review(pg_temp.n(31),pg_temp.task(2,31),
  pg_temp.step_review_snapshot()))->>'reason',
  'not_verified','unverified successor has no current geometry');
select throws_ok($$select public.api_read_native_step_review(pg_temp.n(31),pg_temp.task(1,31),pg_temp.n(20))$$,
  'PT409',null,'stale candidate snapshot rejected');
select set_config('request.jwt.claim.sub',pg_temp.n(2)::text,true);
select throws_ok($$select public.api_read_native_step_review(pg_temp.n(31),pg_temp.task(1,31),
  pg_temp.step_review_snapshot())$$,
  '42501',null,'foreign actor cannot retrieve STEP');
reset role;
select throws_ok($$select pg_temp.step_review_store(pg_temp.step_review_bytes(),repeat('0',64))$$,
  '22023',null,'substituted bytes or digest denied before association');
select throws_ok($$select pg_temp.step_review_store(null,null,pg_temp.n(20))$$,
  '42501',null,'foreign candidate snapshot cannot be associated');
select is(pg_temp.step_review_store(),true,'verified exact STEP association stored once');
select is(pg_temp.step_review_store(),false,'identical association replay is inert');
select throws_ok($$select pg_temp.step_review_store(pg_temp.step_review_bytes()||decode('01','hex'))$$,
  '23505',null,'conflicting STEP replay denied');
select throws_ok($$update engineering_private.native_step_reviews set step_sha256=repeat('0',64)$$,
  '55000',null,'associated review history is immutable');
set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub',pg_temp.n(1)::text,true);
select is((public.api_read_native_step_review(pg_temp.n(31),pg_temp.task(1,31),
  pg_temp.step_review_snapshot()))->>'status',
  'ready','authenticated owner retrieves current verified STEP');
select is((public.api_read_native_step_review(pg_temp.n(31),pg_temp.task(1,31),
  pg_temp.step_review_snapshot()))->>'stepSha256',
  encode(extensions.digest(pg_temp.step_review_bytes(),'sha256'),'hex'),'read digest binds exact bytes');
select set_config('request.jwt.claim.role','',true);
select set_config('request.jwt.claim.sub','',true);
select set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',pg_temp.n(1))::text,true);
select is((public.api_read_native_step_review(pg_temp.n(31),pg_temp.task(1,31),
  pg_temp.step_review_snapshot()))->>'status','ready','JSON-only JWT claims authorize current owner');
reset role;
alter table engineering_private.native_step_reviews disable trigger native_step_reviews_immutable;
update engineering_private.native_step_reviews set result_sha256=repeat('e',64);
alter table engineering_private.native_step_reviews enable trigger native_step_reviews_immutable;
set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub',pg_temp.n(1)::text,true);
select throws_ok($$select public.api_read_native_step_review(pg_temp.n(31),pg_temp.task(1,31),
  pg_temp.step_review_snapshot())$$,
  '42501',null,'substituted finalized-result binding rejected at read');
reset role;
alter table engineering_private.native_step_reviews disable trigger native_step_reviews_immutable;
update engineering_private.native_step_reviews r set result_sha256=f.payload_text::jsonb->>'resultSha256'
  from engineering_private.native_finalizations f where f.task_id=r.task_id;
update engineering_private.native_step_reviews set step_bytes=step_bytes||decode('01','hex');
alter table engineering_private.native_step_reviews enable trigger native_step_reviews_immutable;
set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub',pg_temp.n(1)::text,true);
select throws_ok($$select public.api_read_native_step_review(pg_temp.n(31),pg_temp.task(1,31),
  pg_temp.step_review_snapshot())$$,
  '42501',null,'substituted stored STEP bytes rejected at read');
