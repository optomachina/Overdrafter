-- U4 only: real save/reset/approve RPCs, worker-order attempt evidence and rollup.
-- Ownership/default scenarios are adapted from draft #874 (copied, not cherry-picked).
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(95);

insert into auth.users (id, aud, role, email, email_confirmed_at, raw_app_meta_data)
values ('97940000-0000-4000-8000-000000000001', 'authenticated', 'authenticated',
  'u4-client@example.test', now(), '{"provider":"email"}'),
  ('97940000-0000-4000-8000-000000000003', 'authenticated', 'authenticated',
  'u4-staff@example.test', now(), '{"provider":"email"}');
insert into public.organizations (id, name, slug)
values ('97940000-0000-4000-8000-000000000002', 'U4 synthetic org', 'ovd979-u4');
insert into public.organization_memberships (organization_id, user_id, role)
values ('97940000-0000-4000-8000-000000000002', '97940000-0000-4000-8000-000000000001', 'client'),
  ('97940000-0000-4000-8000-000000000002', '97940000-0000-4000-8000-000000000003', 'internal_admin');

create function pg_temp.u4_case() returns table(job_id uuid, part_id uuid, task_id uuid)
language plpgsql as $$
declare
  j uuid := gen_random_uuid(); p uuid := gen_random_uuid();
  f uuid := gen_random_uuid(); q uuid := gen_random_uuid();
  org constant uuid := '97940000-0000-4000-8000-000000000002';
  owner_id constant uuid := '97940000-0000-4000-8000-000000000001';
begin
  insert into public.jobs (id, organization_id, created_by, title, status)
  values (j, org, owner_id, 'U4 synthetic job', 'extracting');
  insert into public.job_files (id, job_id, organization_id, uploaded_by, storage_bucket,
    storage_path, original_name, normalized_name, file_kind)
  values (f, j, org, owner_id, 'job-files', 'synthetic/u4/' || f, 'part.pdf', 'part', 'drawing');
  insert into public.parts (id, job_id, organization_id, name, normalized_key, drawing_file_id)
  values (p, j, org, 'U4 part', 'part', f);
  insert into public.work_queue (id, organization_id, job_id, part_id, task_type, payload)
  values (q, org, j, p, 'extract_part', jsonb_build_object('drawingFileId', f));
  return query select j, p, q;
end;
$$;
create function pg_temp.u4_store(p_part uuid, p_attempt uuid, p_extra jsonb default '{}'::jsonb,
  p_at timestamptz default now() + interval '1 minute')
returns void language sql as $$
  -- Insert stamps a controlled time; UPDATE uses the real touch trigger instead.
  delete from public.drawing_extractions where part_id = p_part;
  insert into public.drawing_extractions (part_id, organization_id, source_attempt_id,
    extractor_version, extraction, updated_at)
  values (p_part, '97940000-0000-4000-8000-000000000002', p_attempt, 'worker-pdf-u4',
    '{"description":"DRAWING DESC","partNumber":"DRAWING-PN","revision":"D","quoteFinish":"DRAWING FINISH","material":{"normalized":"Aluminum 6061-T6"}}'::jsonb || p_extra,
    p_at);
$$;
create temp table u4_main as select * from pg_temp.u4_case();
grant select on u4_main to authenticated, service_role;
select set_config('request.jwt.claims', '{"sub":"97940000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}', true);
set local role authenticated;
select public.api_update_client_part_request(p_job_id => (select job_id from u4_main),
  p_description => 'USER DESC', p_part_number => 'USER-PN', p_revision => 'C',
  p_material => 'Unknown material', p_finish => 'USER FINISH');
reset role;
select ok((select spec_snapshot #> '{projectPartProperties,overrides}' ?& array['description','partNumber','revision','finish']
  from public.approved_part_requirements where part_id = (select part_id from u4_main)), 'real client save owns all four corrected fields while queued');
update public.work_queue set status = 'running', locked_at = now(), locked_by = 'u4-worker', attempt_id = gen_random_uuid()
where id = (select task_id from u4_main);
select pg_temp.u4_store((select part_id from u4_main), (select attempt_id from public.work_queue where id = (select task_id from u4_main)));
set local role service_role;
select is(public.api_auto_approve_job_requirements((select job_id from u4_main)), 1, 'worker approves before settling its own task');
reset role;
select is((select array[description,part_number,revision,finish,spec_snapshot->>'quoteDescription',spec_snapshot->>'quoteFinish']
  from public.approved_part_requirements where part_id = (select part_id from u4_main)),
  array['USER DESC','USER-PN','C','USER FINISH','USER DESC','USER FINISH'], 'AC1 corrections and quote values survive completion');
select is((select spec_snapshot #> '{projectPartProperties,defaults}' from public.approved_part_requirements where part_id = (select part_id from u4_main))
  -> 'description', '"DRAWING DESC"'::jsonb, 'owned field default follows extraction for immediate reset');
select is((select material from public.approved_part_requirements where part_id = (select part_id from u4_main)), 'Unknown material', 'explicit material override keeps Unknown material');
select is((select status::text from public.jobs where id = (select job_id from u4_main)), 'ready_to_quote', 'matching running attempt counts as finishing without a reason flag');
select is((select status::text from public.work_queue where id = (select task_id from u4_main)), 'running', 'auto approval does not settle the worker task');

set local role authenticated;
select public.api_reset_client_part_property_overrides((select job_id from u4_main), array['description']);
reset role;
select is((select array[description,part_number,revision,finish] from public.approved_part_requirements where part_id = (select part_id from u4_main)),
  array['DRAWING DESC','USER-PN','C','USER FINISH'], 'reset returns only selected field to latest drawing without another extraction');
select ok(not (select spec_snapshot #> '{projectPartProperties,overrides}' ? 'description' from public.approved_part_requirements where part_id = (select part_id from u4_main)), 'reset removes override ownership');
select pg_temp.u4_store((select part_id from u4_main), (select attempt_id from public.work_queue where id = (select task_id from u4_main)), '{"description":"NEXT DRAWING"}');
select public.api_auto_approve_job_requirements((select job_id from u4_main));
select is((select description from public.approved_part_requirements where part_id = (select part_id from u4_main)), 'NEXT DRAWING', 'reset field refreshes automatically on re-extraction');
select is((select part_number from public.approved_part_requirements where part_id = (select part_id from u4_main)), 'USER-PN', 'unreset correction survives repeated auto approval');

-- Identity matrix: a future timestamp is deliberately insufficient evidence.
create function pg_temp.u4_attempt_cases() returns setof text language plpgsql as $$
declare c record; r record; o record; a uuid := gen_random_uuid(); b uuid := gen_random_uuid(); n integer;
begin
  for c in select * from (values
    ('queued', true, true, false, false, 'queued task keeping a matching attempt_id (SQL-path requeue)'),
    ('queued', false, true, false, false, 'requeue cleared attempt'),
    ('running', true, true, true, false, 'reclaim changed attempt'),
    ('running', false, true, false, false, 'null legacy queue attempt'),
    ('running', true, false, false, false, 'null legacy extraction attempt'),
    ('running', false, false, false, false, 'both legacy identities null'),
    ('running', true, true, false, true, 'matching attempt belongs to another part'),
    ('running', true, true, false, false, 'matching current running attempt')
  ) as cases(state, queue_id, stored_id, changed, other_part, label)
  loop
    select * into r from pg_temp.u4_case();
    update public.work_queue set status = c.state::public.queue_task_status,
      attempt_id = case when c.queue_id then a end,
      locked_at = case when c.label = 'matching current running attempt' then now() + interval '2 minutes' else now() - interval '1 hour' end
      where id = r.task_id;
    perform pg_temp.u4_store(r.part_id, case when c.stored_id then case when c.changed then b else a end end);
    if c.other_part then
      -- A part with no active extract task of its own (U5 allows one per part).
      select * into o from pg_temp.u4_case();
      delete from public.work_queue where id = o.task_id;
      update public.work_queue set part_id = o.part_id where id = r.task_id;
    end if;
    n := public.api_auto_approve_job_requirements(r.job_id);
    return next is((select status::text from public.jobs where id = r.job_id),
      case when c.label = 'matching current running attempt' then 'ready_to_quote' else 'extracting' end, c.label || ': rollup');
    if not c.other_part then
      return next is(n, case when c.label = 'matching current running attempt' then 1 else 0 end, c.label || ': stale row cannot create requirements');
      return next is((select status::text from public.drawing_extractions where part_id = r.part_id),
        case when c.label = 'matching current running attempt' then 'approved' else 'needs_review' end, c.label || ': extraction status');
    end if;
  end loop;
end;
$$;
select * from pg_temp.u4_attempt_cases();

-- A matching running attempt whose part has a newer drawing requested is still pending.
create temp table u4_successor as select * from pg_temp.u4_case();
update public.work_queue set status = 'running', attempt_id = '97940000-0000-4000-8000-0000000000aa',
  locked_at = now() - interval '1 minute',
  payload = payload || jsonb_build_object('pendingDrawingFileId', gen_random_uuid())
  where id = (select task_id from u4_successor);
select pg_temp.u4_store((select part_id from u4_successor), '97940000-0000-4000-8000-0000000000aa');
select is(public.api_auto_approve_job_requirements((select job_id from u4_successor)), 0,
  'requested successor drawing: matching attempt cannot create requirements');
select is((select status::text from public.jobs where id = (select job_id from u4_successor)), 'extracting',
  'requested successor drawing: rollup stays extracting');
select is((select status::text from public.drawing_extractions where part_id = (select part_id from u4_successor)), 'needs_review',
  'requested successor drawing: extraction status untouched');

-- Staff approval writes drawing_extractions.status and bumps updated_at via trigger.
create temp table u4_staff as select * from pg_temp.u4_case();
grant select on u4_staff to authenticated;
update public.work_queue set status = 'running', attempt_id = gen_random_uuid(), locked_at = now() - interval '1 minute'
where id = (select task_id from u4_staff);
select pg_temp.u4_store((select part_id from u4_staff), gen_random_uuid());
select set_config('request.jwt.claims', '{"sub":"97940000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal1"}', true);
set local role authenticated;
select public.api_approve_job_requirements((select job_id from u4_staff), jsonb_build_array(jsonb_build_object(
  'partId', (select part_id from u4_staff), 'description', 'STAFF DESC', 'material', 'Steel', 'quantity', 1)));
reset role;
select ok((select e.updated_at > q.locked_at from public.drawing_extractions e join public.work_queue q on q.part_id = e.part_id
  where q.id = (select task_id from u4_staff)), 'staff approval really bumped extraction timestamp after claim');
select public.api_auto_approve_job_requirements((select job_id from u4_staff));
select is((select status::text from public.jobs where id = (select job_id from u4_staff)), 'extracting', 'staff approval timestamp bump does not count as finishing');
select is((select description from public.approved_part_requirements where part_id = (select part_id from u4_staff)), 'STAFF DESC', 'legacy staff provenance protects correction');

-- Placeholder/default behavior and preservation of unrelated provenance keys.
create temp table u4_material as select * from pg_temp.u4_case();
update public.work_queue set status = 'completed' where id = (select task_id from u4_material);
insert into public.approved_part_requirements (part_id, organization_id, approved_by, material, spec_snapshot)
select part_id, '97940000-0000-4000-8000-000000000002', '97940000-0000-4000-8000-000000000001', 'Unknown material',
  '{"fieldSources":{"material":"auto","custom":"user"},"fieldOverrides":{"custom":true},"projectPartProperties":{"defaults":{"material":"Unknown material"}}}'
from u4_material;
select pg_temp.u4_store((select part_id from u4_material), null);
select public.api_auto_approve_job_requirements((select job_id from u4_material));
select is((select material from public.approved_part_requirements where part_id = (select part_id from u4_material)), 'Aluminum 6061-T6', 'auto Unknown material replaced by drawing material');
select is((select spec_snapshot #>> '{projectPartProperties,defaults,material}' from public.approved_part_requirements where part_id = (select part_id from u4_material)), 'Aluminum 6061-T6', 'replaced material updates editor default');
select is((select spec_snapshot #>> '{fieldSources,custom}' from public.approved_part_requirements where part_id = (select part_id from u4_material)), 'user', 'unrelated source keys survive');
select is((select spec_snapshot #> '{fieldOverrides,custom}' from public.approved_part_requirements where part_id = (select part_id from u4_material)), 'true'::jsonb, 'unrelated override keys survive');
update public.approved_part_requirements set material = 'Unknown material',
  spec_snapshot = jsonb_set(spec_snapshot, '{fieldSources,material}', '"user"')
where part_id = (select part_id from u4_material);
select public.api_auto_approve_job_requirements((select job_id from u4_material));
select public.api_auto_approve_job_requirements((select job_id from u4_material));
select is((select material from public.approved_part_requirements where part_id = (select part_id from u4_material)), 'Unknown material', 'legacy material ownership survives repeated auto approval');

-- Defaults for all auto-managed fields track the new drawing; saving them is a no-op.
create temp table u4_defaults as select * from pg_temp.u4_case();
update public.work_queue set status = 'completed' where id = (select task_id from u4_defaults);
insert into public.approved_part_requirements (part_id, organization_id, approved_by, material, description, part_number, revision, finish, spec_snapshot)
select part_id, '97940000-0000-4000-8000-000000000002', '97940000-0000-4000-8000-000000000001', 'Steel', 'OLD', 'OLD', 'OLD', 'OLD',
  '{"projectPartProperties":{"defaults":{"description":"OLD","partNumber":"OLD","revision":"OLD","finish":"OLD","material":"Steel"},"overrides":{}}}'
from u4_defaults;
select pg_temp.u4_store((select part_id from u4_defaults), null);
select public.api_auto_approve_job_requirements((select job_id from u4_defaults));
select is((select array[description,part_number,revision,finish] from public.approved_part_requirements where part_id = (select part_id from u4_defaults)),
  array['DRAWING DESC','DRAWING-PN','D','DRAWING FINISH'], 'unowned fields refresh from newer extraction');
select is((select spec_snapshot #> '{projectPartProperties,defaults}' from public.approved_part_requirements where part_id = (select part_id from u4_defaults)),
  '{"description":"DRAWING DESC","partNumber":"DRAWING-PN","revision":"D","finish":"DRAWING FINISH","material":"Steel"}'::jsonb, 'all refreshed defaults move with columns');
grant select on u4_defaults to authenticated;
select set_config('request.jwt.claims', '{"sub":"97940000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}', true);
set local role authenticated;
select public.api_update_client_part_request(p_job_id => (select job_id from u4_defaults),
  p_description => 'DRAWING DESC', p_part_number => 'DRAWING-PN', p_revision => 'D',
  p_material => 'Steel', p_finish => 'DRAWING FINISH');
reset role;
select is((select spec_snapshot #> '{projectPartProperties,overrides}' from public.approved_part_requirements where part_id = (select part_id from u4_defaults)),
  '{}'::jsonb, 'saving refreshed display values creates no spurious overrides');

-- Legacy source-only ownership is kept, including its defaults.
update public.approved_part_requirements set spec_snapshot = spec_snapshot ||
  '{"fieldSources":{"description":"user","partNumber":"user","revision":"user","finish":"user"}}'::jsonb
where part_id = (select part_id from u4_defaults);
select pg_temp.u4_store((select part_id from u4_defaults), null, '{"description":"NEWER","partNumber":"NEWER","revision":"NEWER","quoteFinish":"NEWER"}');
select public.api_auto_approve_job_requirements((select job_id from u4_defaults));
select is((select array[description,part_number,revision,finish] from public.approved_part_requirements where part_id = (select part_id from u4_defaults)),
  array['DRAWING DESC','DRAWING-PN','D','DRAWING FINISH'], 'legacy source-only ownership protects all four fields');
select is((select spec_snapshot #>> '{projectPartProperties,defaults,description}' from public.approved_part_requirements where part_id = (select part_id from u4_defaults)),
  'DRAWING DESC', 'legacy-only owned default does not move');

-- Review flags, missing extraction values and older results cannot move an owned default.
create function pg_temp.u4_default_guards() returns setof text language plpgsql as $$
declare c text; r record;
begin
  foreach c in array array['review','missing','older'] loop
    select * into r from pg_temp.u4_case();
    update public.work_queue set status = 'completed' where id = r.task_id;
    insert into public.approved_part_requirements (part_id, organization_id, approved_by, material, description, spec_snapshot)
    values (r.part_id, '97940000-0000-4000-8000-000000000002', '97940000-0000-4000-8000-000000000001', 'Steel', 'USER',
      '{"projectPartProperties":{"defaults":{"description":"OLD"},"overrides":{"description":"USER"}}}');
    perform pg_temp.u4_store(r.part_id, null, case when c = 'review' then '{"extractedDescriptionRaw":{"reviewNeeded":true}}'::jsonb
      when c = 'missing' then '{"description":null}'::jsonb else '{}'::jsonb end);
    if c = 'older' then
      -- Touch trigger updates extraction to now(); requirement is now() as well.
      update public.drawing_extractions set status = 'needs_review' where part_id = r.part_id;
    end if;
    perform public.api_auto_approve_job_requirements(r.job_id);
    return next is((select description from public.approved_part_requirements where part_id = r.part_id), 'USER', c || ': correction survives');
    return next is((select spec_snapshot #>> '{projectPartProperties,defaults,description}' from public.approved_part_requirements where part_id = r.part_id), 'OLD', c || ': default stays');
  end loop;
end;
$$;
select * from pg_temp.u4_default_guards();

-- A stored result does not exempt any additional queued task, even on the same part.
-- Once U5's index allows one active task per part, the extra task goes on a second part.
do $$
declare v_part uuid := (select part_id from u4_main);
begin
  if to_regclass('public.work_queue_one_active_extract_per_part') is not null then
    insert into public.parts (id, job_id, organization_id, name, normalized_key)
    select gen_random_uuid(), job_id, '97940000-0000-4000-8000-000000000002', 'U4 extra part', 'u4-extra'
    from u4_main returning id into v_part;
  end if;
  insert into public.work_queue (organization_id, job_id, part_id, task_type)
  select '97940000-0000-4000-8000-000000000002', job_id, v_part, 'extract_part' from u4_main;
end;
$$;
select public.api_auto_approve_job_requirements((select job_id from u4_main));
select is((select status::text from public.jobs where id = (select job_id from u4_main)), 'extracting', 'matching result cannot exempt a second queued task');

-- An extraction older than the requirement it would refresh is not newer evidence,
-- even from the matching running attempt (worker write lands after an approval).
create temp table u4_older as select * from pg_temp.u4_case();
update public.work_queue set status = 'running', attempt_id = '97940000-0000-4000-8000-0000000000bb', locked_at = now()
where id = (select task_id from u4_older);
select pg_temp.u4_store((select part_id from u4_older), '97940000-0000-4000-8000-0000000000bb');
select is(public.api_auto_approve_job_requirements((select job_id from u4_older)), 1, 'older-write case: first approval creates the requirement');
select pg_temp.u4_store((select part_id from u4_older), '97940000-0000-4000-8000-0000000000bb', '{"description":"OLDER WRITE"}', now() - interval '1 minute');
select public.api_auto_approve_job_requirements((select job_id from u4_older));
select is((select description from public.approved_part_requirements where part_id = (select part_id from u4_older)), 'DRAWING DESC',
  'extraction stamped before the requirement does not refresh it');

-- Trusted reuse runs inside the target's running extract_part attempt, and the worker
-- auto-approves before settling it (worker/src/index.ts). The copy carries that attempt.
insert into public.organization_file_blobs (id, organization_id, content_sha256, trusted_content_sha256,
  storage_bucket, storage_path, size_bytes, mime_type)
values ('97940000-0000-4000-8000-000000000103', '97940000-0000-4000-8000-000000000002', repeat('7', 64), repeat('7', 64),
    'job-files', 'synthetic/u4/reuse.step', 100, 'application/step'),
  ('97940000-0000-4000-8000-000000000104', '97940000-0000-4000-8000-000000000002', repeat('8', 64), repeat('8', 64),
    'job-files', 'synthetic/u4/reuse.pdf', 100, 'application/pdf');
insert into public.jobs (id, organization_id, created_by, title, status)
values ('97940000-0000-4000-8000-000000000101', '97940000-0000-4000-8000-000000000002', '97940000-0000-4000-8000-000000000001', 'U4 reuse source', 'ready_to_quote'),
  ('97940000-0000-4000-8000-000000000102', '97940000-0000-4000-8000-000000000002', '97940000-0000-4000-8000-000000000001', 'U4 reuse target', 'extracting');
insert into public.job_files (id, job_id, organization_id, uploaded_by, blob_id, content_sha256, trusted_content_sha256,
  storage_bucket, storage_path, original_name, normalized_name, file_kind, size_bytes)
select file.id, file.job_id, '97940000-0000-4000-8000-000000000002', '97940000-0000-4000-8000-000000000001', file.blob_id,
  repeat(file.seed, 64), repeat(file.seed, 64), 'job-files', 'synthetic/u4/reuse/' || file.id, file.name, 'reuse',
  file.kind::public.job_file_kind, 100
from (values
  ('97940000-0000-4000-8000-000000000105'::uuid, '97940000-0000-4000-8000-000000000101'::uuid, '97940000-0000-4000-8000-000000000103'::uuid, '7', 'reuse.step', 'cad'),
  ('97940000-0000-4000-8000-000000000106', '97940000-0000-4000-8000-000000000101', '97940000-0000-4000-8000-000000000104', '8', 'reuse.pdf', 'drawing'),
  ('97940000-0000-4000-8000-000000000107', '97940000-0000-4000-8000-000000000102', '97940000-0000-4000-8000-000000000103', '7', 'reuse.step', 'cad'),
  ('97940000-0000-4000-8000-000000000108', '97940000-0000-4000-8000-000000000102', '97940000-0000-4000-8000-000000000104', '8', 'reuse.pdf', 'drawing')
) as file(id, job_id, blob_id, seed, name, kind);
insert into public.parts (id, job_id, organization_id, name, normalized_key, cad_file_id, drawing_file_id)
values ('97940000-0000-4000-8000-000000000109', '97940000-0000-4000-8000-000000000101', '97940000-0000-4000-8000-000000000002',
    'U4 reuse source', 'reuse', '97940000-0000-4000-8000-000000000105', '97940000-0000-4000-8000-000000000106'),
  ('97940000-0000-4000-8000-000000000110', '97940000-0000-4000-8000-000000000102', '97940000-0000-4000-8000-000000000002',
    'U4 reuse target', 'reuse', '97940000-0000-4000-8000-000000000107', '97940000-0000-4000-8000-000000000108');
select pg_temp.u4_store('97940000-0000-4000-8000-000000000109', null);
insert into public.work_queue (id, organization_id, job_id, part_id, task_type, status, attempt_id, locked_at, locked_by, payload)
values ('97940000-0000-4000-8000-000000000111', '97940000-0000-4000-8000-000000000002', '97940000-0000-4000-8000-000000000102',
  '97940000-0000-4000-8000-000000000110', 'extract_part', 'running', '97940000-0000-4000-8000-000000000112', now(), 'u4-worker',
  jsonb_build_object('drawingFileId', '97940000-0000-4000-8000-000000000108'));
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select is(public.api_reuse_trusted_part_version_artifacts('97940000-0000-4000-8000-000000000110', '97940000-0000-4000-8000-000000000109',
  (select part_version_id from public.parts where id = '97940000-0000-4000-8000-000000000109')) ->> 'artifactsReady', 'true',
  'reuse: target copies the source artifacts');
select is((select source_attempt_id from public.drawing_extractions where part_id = '97940000-0000-4000-8000-000000000110'),
  '97940000-0000-4000-8000-000000000112'::uuid, 'reuse: copied extraction carries the running attempt');
select is(public.api_auto_approve_job_requirements('97940000-0000-4000-8000-000000000102'), 1, 'reuse: worker approval counts the reused result');
reset role;
select set_config('request.jwt.claim.role', '', true);
select is((select status::text from public.jobs where id = '97940000-0000-4000-8000-000000000102'), 'ready_to_quote',
  'reuse: clean reused upload rolls up to ready_to_quote');

-- All actual enum values, each through pending, failed and successful rollup.
-- This schema has TEN total statuses, SIX outside the four pre-quote statuses.
create function pg_temp.u4_status_cases() returns setof text language plpgsql as $$
declare s public.job_status; mode text; r record; expected text;
begin
  foreach s in array enum_range(null::public.job_status) loop
    foreach mode in array array['pending','failed','success'] loop
      select * into r from pg_temp.u4_case();
      update public.jobs set status = s where id = r.job_id;
      update public.work_queue set status = case when mode = 'pending' then 'queued'::public.queue_task_status
        when mode = 'failed' then 'failed'::public.queue_task_status else 'completed'::public.queue_task_status end where id = r.task_id;
      if mode = 'success' then perform pg_temp.u4_store(r.part_id, null); end if;
      perform public.api_auto_approve_job_requirements(r.job_id);
      expected := case when s::text not in ('uploaded','extracting','needs_spec_review','ready_to_quote') then s::text
        when mode = 'pending' then 'extracting' when mode = 'failed' then 'needs_spec_review' else 'ready_to_quote' end;
      return next is((select status::text from public.jobs where id = r.job_id), expected, s::text || ' with ' || mode || ' work');
    end loop;
  end loop;
end;
$$;
select * from pg_temp.u4_status_cases();
select ok(not has_function_privilege('anon', 'public.api_auto_approve_job_requirements(uuid)', 'EXECUTE'), 'anon cannot auto approve');
select ok(not has_function_privilege('authenticated', 'public.api_auto_approve_job_requirements(uuid)', 'EXECUTE'), 'client cannot auto approve');
select ok(has_function_privilege('service_role', 'public.api_auto_approve_job_requirements(uuid)', 'EXECUTE'), 'service role retains execution');
select * from finish();
rollback;
