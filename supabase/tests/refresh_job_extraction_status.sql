-- OVD-1097 B1-B11/B13. Transactional synthetic fixtures; no provider calls.
-- B3 uses sequential refreshes to verify serialization's observable no-op contract.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(32);

insert into auth.users (id, aud, role, email, email_confirmed_at, raw_app_meta_data)
values ('00000000-0000-4000-8000-000000109711', 'authenticated', 'authenticated',
        'ovd1097@example.test', now(), '{"provider":"email"}'::jsonb);
insert into public.organizations (id, name, slug)
values ('00000000-0000-4000-8000-000000109701', 'OVD-1097 test', 'ovd1097-test');
insert into public.organization_memberships (organization_id, user_id, role)
values ('00000000-0000-4000-8000-000000109701', '00000000-0000-4000-8000-000000109711', 'client');

create temporary table refresh_cases on commit drop as
select n, md5('ovd1097-job-' || n)::uuid as job_id
from generate_series(1, 10) n;
create temporary table refresh_parts on commit drop as
select cases.n, cases.job_id, idx,
       md5('ovd1097-part-' || cases.n || '-' || idx)::uuid as part_id,
       md5('ovd1097-file-' || cases.n || '-' || idx)::uuid as file_id
from refresh_cases cases cross join generate_series(1, 2) idx
where cases.n <> 1 or idx = 1;

insert into public.jobs (id, organization_id, created_by, title, status)
select job_id, '00000000-0000-4000-8000-000000109701',
       '00000000-0000-4000-8000-000000109711', 'OVD1097 case ' || n, 'extracting'
from refresh_cases;
insert into public.job_files (id, job_id, organization_id, uploaded_by, storage_bucket,
                             storage_path, original_name, normalized_name, file_kind)
select file_id, job_id, '00000000-0000-4000-8000-000000109701',
       '00000000-0000-4000-8000-000000109711', 'job-files', 'ovd1097/' || file_id,
       'part-' || idx, 'part-' || idx,
       (case when idx = 1 and n <> 1 then 'cad' else 'drawing' end)::public.job_file_kind
from refresh_parts where n <> 5;
insert into public.parts (id, job_id, organization_id, name, normalized_key, cad_file_id, drawing_file_id)
select part_id, job_id, '00000000-0000-4000-8000-000000109701', 'part ' || idx, 'part-' || idx,
       case when idx = 1 and n not in (1, 5) then file_id end,
       case when (idx = 2 or n = 1) and n <> 5 then file_id end
from refresh_parts;
insert into public.work_queue (id, organization_id, job_id, part_id, task_type, status, created_at)
select md5('ovd1097-task-' || n || '-' || idx)::uuid,
       '00000000-0000-4000-8000-000000109701', job_id, part_id, 'extract_part',
       (case when n in (2, 8) and idx = 2 then 'queued'
             when n = 9 and idx = 2 then 'failed' else 'completed' end)::public.queue_task_status,
       '2026-10-25T00:00:00Z'::timestamptz
from refresh_parts where n <> 5;
insert into public.approved_part_requirements
  (part_id, organization_id, approved_by, material, finish, quantity, quote_quantities)
select part_id, '00000000-0000-4000-8000-000000109701',
       '00000000-0000-4000-8000-000000109711', 'Aluminum 6061-T6', 'As Machined', 1, array[1]
from refresh_parts where n in (4, 7, 9) or (n = 10 and idx = 1);
insert into public.drawing_extractions (part_id, organization_id, extractor_version, extraction, status)
select part_id, '00000000-0000-4000-8000-000000109701', 'ovd1097-fixture',
       '{"warnings":[],"missingFields":[],"reviewFields":["description"]}'::jsonb, 'needs_review'
from refresh_parts where n = 1;
create temporary table approvals_before on commit drop as
select coalesce(jsonb_agg(to_jsonb(requirement) order by requirement.id), '[]'::jsonb) as snapshot
from public.approved_part_requirements requirement;

-- B1: one completed, held part leaves extraction and emits only transition/count data.
select is(public.api_refresh_job_extraction_status(job_id), 'needs_spec_review', 'B1: held part needs review')
from refresh_cases where n = 1;
select is((select count(*) from public.audit_events where job_id = (select job_id from refresh_cases where n = 1)
           and event_type = 'job.extraction_status_refreshed'), 1::bigint, 'B1: one audit event');
select is((select payload from public.audit_events where job_id = (select job_id from refresh_cases where n = 1)
           and event_type = 'job.extraction_status_refreshed'),
          '{"fromStatus":"extracting","toStatus":"needs_spec_review","pendingExtractTasks":0,"failedExtractTasks":0,"fileBearingParts":1,"unapprovedParts":1}'::jsonb,
          'B1: audit payload contains statuses and counts only');

-- B2: either queued or running wins over unapproved parts.
select is(public.api_refresh_job_extraction_status(job_id), 'extracting', 'B2: queued part keeps extracting')
from refresh_cases where n = 2;
update public.work_queue set status = 'running' where job_id = (select job_id from refresh_cases where n = 2) and status = 'queued';
select is(public.api_refresh_job_extraction_status(job_id), 'extracting', 'B2: running part keeps extracting')
from refresh_cases where n = 2;
select is((select count(*) from public.audit_events where job_id = (select job_id from refresh_cases where n = 2)
           and event_type = 'job.extraction_status_refreshed'), 0::bigint, 'B2: no transition audit');

-- B3: both committed completions, followed by two serialized calls.
select is(public.api_refresh_job_extraction_status(job_id), 'needs_spec_review', 'B3: both parts finished')
from refresh_cases where n = 3;
select is(public.api_refresh_job_extraction_status(job_id), 'needs_spec_review', 'B3: second call is a no-op')
from refresh_cases where n = 3;
select is((select count(*) from public.audit_events where job_id = (select job_id from refresh_cases where n = 3)
           and event_type = 'job.extraction_status_refreshed'), 1::bigint, 'B3: no duplicate audit');

-- B4: CAD-only and drawing-only parts both count; fileless parts do not block.
insert into public.parts (job_id, organization_id, name, normalized_key)
select job_id, '00000000-0000-4000-8000-000000109701', 'fileless', 'fileless'
from refresh_cases where n = 4;
select is(public.api_refresh_job_extraction_status(job_id), 'ready_to_quote', 'B4: all file-bearing parts approved')
from refresh_cases where n = 4;
select is((select status::text from public.jobs where id = (select job_id from refresh_cases where n = 4)),
          'ready_to_quote', 'B4: ready status is persisted');

-- B5: neither fileless-only nor empty jobs are vacuously ready.
select is(public.api_refresh_job_extraction_status(job_id), 'extracting', 'B5: fileless parts do not make job ready')
from refresh_cases where n = 5;
delete from public.parts where job_id = (select job_id from refresh_cases where n = 5);
select is(public.api_refresh_job_extraction_status(job_id), 'extracting', 'B5: empty job stays extracting')
from refresh_cases where n = 5;
select is((select count(*) from public.audit_events where job_id = (select job_id from refresh_cases where n = 5)
           and event_type = 'job.extraction_status_refreshed'), 0::bigint, 'B5: no audit for unchanged job');

-- B6: human approval owns subsequent transitions.
update public.jobs set status = 'needs_spec_review' where id = (select job_id from refresh_cases where n = 6);
select is(public.api_refresh_job_extraction_status(job_id), 'needs_spec_review', 'B6: needs_spec_review unchanged')
from refresh_cases where n = 6;
update public.jobs set status = 'ready_to_quote' where id = (select job_id from refresh_cases where n = 6);
select is(public.api_refresh_job_extraction_status(job_id), 'ready_to_quote', 'B6: ready_to_quote unchanged')
from refresh_cases where n = 6;
update public.jobs set status = 'quoting' where id = (select job_id from refresh_cases where n = 6);
select is(public.api_refresh_job_extraction_status(job_id), 'quoting', 'B6: quoting unchanged')
from refresh_cases where n = 6;
select is((select count(*) from public.audit_events where job_id = (select job_id from refresh_cases where n = 6)
           and event_type = 'job.extraction_status_refreshed'), 0::bigint, 'B6: no audit outside extracting');

-- B7/F1: older failures and queued rows cannot override newer completions.
-- idx=1 tests created_at descending even when the old id is greater.
-- idx=2 tests id descending when created_at ties.
update public.work_queue set id = 'ffffffff-ffff-4fff-8fff-fffffffffff1'
where part_id = (select part_id from refresh_parts where n = 7 and idx = 2);
insert into public.work_queue (id, organization_id, job_id, part_id, task_type, status, created_at)
select case when idx = 1 then 'ffffffff-ffff-4fff-8fff-fffffffffff2'::uuid
            else '00000000-0000-4000-8000-000000109799'::uuid end,
       '00000000-0000-4000-8000-000000109701', job_id, part_id, 'extract_part', 'failed',
       case when idx = 1 then '2026-10-24T00:00:00Z'::timestamptz else '2026-10-25T00:00:00Z'::timestamptz end
from refresh_parts where n = 7;
insert into public.work_queue (organization_id, job_id, part_id, task_type, status, created_at)
select '00000000-0000-4000-8000-000000109701', job_id, part_id, 'extract_part', 'queued', '2026-10-23T00:00:00Z'
from refresh_parts where n = 7;
-- Also ignore a newer task of a different type, and null-part extraction tasks.
insert into public.work_queue (organization_id, job_id, part_id, task_type, status, created_at)
select '00000000-0000-4000-8000-000000109701', job_id, part_id, 'generate_cad_preview', 'queued', '2026-10-26T00:00:00Z'
from refresh_parts where n = 7;
insert into public.work_queue (organization_id, job_id, task_type, status)
select '00000000-0000-4000-8000-000000109701', job_id, 'extract_part', 'queued'
from refresh_cases where n = 7;
select is(public.api_refresh_job_extraction_status(job_id), 'ready_to_quote', 'B7: only latest extraction per part counts')
from refresh_cases where n = 7;
select is((select payload ->> 'failedExtractTasks' from public.audit_events
           where job_id = (select job_id from refresh_cases where n = 7) and event_type = 'job.extraction_status_refreshed'),
          '0', 'B7: historical failures excluded from counts');

-- B8: retry changes the same task row back to queued.
update public.work_queue set status = 'running' where part_id = (select part_id from refresh_parts where n = 8 and idx = 2);
update public.work_queue set status = 'queued', attempts = 2 where part_id = (select part_id from refresh_parts where n = 8 and idx = 2);
select is(public.api_refresh_job_extraction_status(job_id), 'extracting', 'B8: requeued retry remains pending')
from refresh_cases where n = 8;
select is((select count(*) from public.audit_events where job_id = (select job_id from refresh_cases where n = 8)
           and event_type = 'job.extraction_status_refreshed'), 0::bigint, 'B8: no audit for retry');

-- B9: the final outright failure parks even an otherwise approved job for review.
select is(public.api_refresh_job_extraction_status(job_id), 'needs_spec_review', 'B9: final task failed outright')
from refresh_cases where n = 9;
select is((select payload ->> 'failedExtractTasks' from public.audit_events
           where job_id = (select job_id from refresh_cases where n = 9) and event_type = 'job.extraction_status_refreshed'),
          '1', 'B9: latest failure counted');

select is(public.api_refresh_job_extraction_status(job_id), 'needs_spec_review', 'B10: approved and held parts need review')
from refresh_cases where n = 10;
select is((select coalesce(jsonb_agg(to_jsonb(requirement) order by requirement.id), '[]'::jsonb)
           from public.approved_part_requirements requirement),
          (select snapshot from approvals_before), 'B10: no approval inserted, changed or deleted');

select ok(not has_function_privilege('anon', 'public.api_refresh_job_extraction_status(uuid)', 'EXECUTE'), 'B11: anon denied');
select ok(not has_function_privilege('authenticated', 'public.api_refresh_job_extraction_status(uuid)', 'EXECUTE'), 'B11: authenticated denied');
select ok(has_function_privilege('service_role', 'public.api_refresh_job_extraction_status(uuid)', 'EXECUTE'), 'B11: service_role allowed');
select ok((select prosecdef from pg_catalog.pg_proc where oid = 'public.api_refresh_job_extraction_status(uuid)'::regprocedure), 'B11: SECURITY DEFINER');
select ok((select proconfig @> array['search_path=pg_catalog'] from pg_catalog.pg_proc
           where oid = 'public.api_refresh_job_extraction_status(uuid)'::regprocedure), 'B11: pinned search_path');
select throws_ok($$select public.api_refresh_job_extraction_status('00000000-0000-4000-8000-000000109700')$$,
                 'P0001', 'Job not found', 'B13: unknown job raises');

select * from finish();
rollback;
