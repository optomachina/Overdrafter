-- OVD-979: re-extraction provenance and drawing-attach extraction.
--
-- Targets these migrations, applied in this order:
--   supabase/migrations/20261020002126_ovd979_auto_approve_keep_user_corrections.sql
--     (ownership in api_auto_approve_job_requirements), then
--   supabase/migrations/20261020002127_ovd979_request_extraction_drawing_attached.sql
--     (api_request_extraction queues one extraction when a drawing is attached
--     to a CAD-only extracted part; api_reuse_trusted_part_version_artifacts
--     lets an identical package replace that CAD-only extraction).
-- Both files are byte copies of the reviewed drafts docs/migration-drafts/
-- ovd-979-a.sql and ovd-979-b.sql (rollbacks: ovd-979-a.rollback.sql and
-- ovd-979-b.rollback.sql, notes: ovd-979-notes.md). This test was promoted from
-- supabase/tests/pending/ovd979_reextraction_provenance.sql.pending, so the
-- policy-test runner and the ephemeral-db stage run it against the migrations.
-- Observed through revision 6 on a local Supabase Postgres 17.11 holding the 153
-- migrations of main (real schema, triggers and access helpers): with both
-- rollbacks applied 39 of 98 assertions passed (A2, A4, B1, B1b, B3, B5, B8, B9,
-- D0-D5, Q1-Q3, F1, F2, F2b, F3, F4b, H1, V2, M1, M2, RU0, RU2, RU3, W1, W2, W3,
-- W5, Z1, Z2, Z2b, Z3, PP0, PP1, PP2, PP2b, PP3, PP4, PP5b, PC1, CS0, CS1, CS4,
-- CS5, CS7, CS8, RF0, RF1, RF2, RF3, RF3b, RF5, RF7 and G1 failed:
-- corrections overwritten, 0 tasks queued on attach, stale editor defaults,
-- placeholder material, tolerance filled, quoted jobs moved to ready_to_quote,
-- reuse keeping the CAD-only row or an unfinished one); with the two migrations
-- applied 98 of 98 passed. Fix round 7 (113 assertions) was run on a scratch
-- PostgreSQL 17 with a minimal Supabase stand-in and the 159 earlier migrations:
-- 113 of 113 with the fix round 7 bytes; on the revision 6 bytes RU5b, DF1,
-- DF2, DF4, DF6, DF7, DF8, RV1, RV2 and G7 fail and G8 errors (the trigger
-- function does not exist), so the run stops at 112 of 113.
-- Sections D, E and Q cover
-- review r0 R1-R4;
-- B5b, B8, B9, D-1 and the F, R, H, N jobs close the review r1 mutation gaps;
-- A3b, B8, M, V, H1 (repeated auto-approval) and RU0-RU6 close review r2 (the
-- reset after a save-while-pending, and the two Codex mediums: fieldSources
-- provenance dropped on rewrite, trusted reuse keeping the CAD-only row).
-- Review r3 (the two Codex mediums of fix round 2): the worker helper now runs in
-- the worker's real order (see ovd979_worker_completes), and W1-W6, RU3b, F2-F4b
-- and Z1-Z4 cover the job status after a drawing extraction and after a retry
-- through api_request_extraction. On the revision 2 bytes of
-- 20261020002126, B5b, F4, RU3b, W3, Z3 and Z4 fail (the job stays 'extracting'
-- after the worker's run; the failure a retry replaced pins needs_spec_review).
-- Review r6 (the Codex medium of fix round 4): PP0-PP6, PV1 and PC1 cover an
-- attach task that failed or was cancelled after the worker had stored its
-- extraction (ovd979_worker_completes with p_approve false). On the revision 3
-- bytes of 20261020002127, PP1, PP2, PP2b, PP4, PP5, PP5b and PC1 fail (the part
-- is not queued again, so its approval and previews never finish); PP6 and PV1
-- guard the other direction (a completed task, or a failure that names another
-- drawing, queues nothing).
-- Review r10 (the Codex medium of fix round 5): CS0-CS8 cover the trusted reuse
-- of a source placement that still holds the CAD-only extraction because its
-- own attach task failed before it stored anything (ovd979_reuse_step runs the
-- worker's resolve-then-reuse step). On the revision 4 bytes of
-- 20261020002127, CS1, CS2, CS4 and CS5 fail (the CAD-only row was copied onto a
-- part that has a drawing and the reuse reported success); CS0, CS3, CS3b and
-- CS6-CS8 pass there and guard the other directions (a package with no drawing
-- is still reused, a source with a drawing extraction is still reused, and a
-- source whose retry is queued is waited for).
-- Review r11 (the Codex medium of fix round 6): RF0-RF7 cover the trusted reuse
-- of a source whose attach task stored its drawing extraction and then failed (or
-- was cancelled) before the previews and the approval were done, and of a source
-- with no extract_part task on record. The reuse trusts a source row only when
-- the task that produced it completed (the source needs a completed extract_part
-- task that no failed or cancelled task created at or after it follows). On the
-- revision 5 bytes of 20261020002127, RF1, RF2, RF5 and RF7 fail (the row was
-- copied and the reuse reported success); RF0, RF3, RF3b, RF4 and RF6 pass there
-- and guard the other directions (a source retried to completion is reused, a
-- source whose retry is queued is waited for). Because the reuse now needs a
-- completed task on record, the fixtures that insert a reuse source row directly
-- (RU1 and RU6, CS6) also insert the completed task that produced it.
-- Fix round 7 (the Codex mediums on revision 6): DF1-DF8 cover a drawing
-- attached while the part's extract_part task runs (api_request_extraction
-- defers one drawing task behind it, the settlement trigger releases it on
-- completion or failure; nothing is deferred behind a task for the current
-- drawing); RT0 and RV1-RV3 cover a retried attach task that still holds its
-- failed attempt's extraction while another part's run auto-approves (pending
-- until it stores its own result during its claim; that run leaves the old row
-- untouched); RU5b covers the reuse stamping a kept row during the claim; G7 and
-- G8 the attributes of the redefined context loader and the new trigger. RU3b's
-- claim is now dated a minute before the reuse, as it is in production. The
-- two-session races (a save or reset during auto-approval, a settlement during
-- a request, the same retry with real clocks) are in
-- ovd979_auto_approve_concurrency.sql.
--
-- The whole test is one transaction, so now() is constant. The worker's
-- extraction writes are simulated as postgres with explicit updated_at values
-- later than now(), which is what makes an extraction "newer" than the
-- requirement in api_auto_approve_job_requirements. For the same reason the
-- tasks of a retried part are aged (ovd979_age_tasks) before each retry, as the
-- minutes between a failure and its retry age them in production.
begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(113);

insert into auth.users (id, aud, role, email, email_confirmed_at, raw_app_meta_data)
values (
  '00000000-0000-4000-8000-000000979011', 'authenticated', 'authenticated',
  'ovd979-owner@example.test', timezone('utc', now()), '{"provider":"email"}'::jsonb
); -- NOSONAR: deterministic fixture identity

insert into public.organizations (id, name, slug)
values ('00000000-0000-4000-8000-000000979001', 'OVD 979 org', 'ovd979-org'); -- NOSONAR: deterministic fixture identifier

insert into public.organization_memberships (organization_id, user_id, role)
values ('00000000-0000-4000-8000-000000979001', '00000000-0000-4000-8000-000000979011', 'client');

-- Job A (3f): CAD + drawing uploaded together, extraction pending.
-- Job B (1b-b): CAD only first, drawing attached later.
-- Job C: a non-worker extraction row ('v1' default) with a drawing (no re-queue).
-- Job D (R1-R3): CAD-only, the user saves without changing anything, then a
--   drawing is attached.
-- Job E (R2): CAD-only, the user explicitly stored 'Unknown material'.
-- Jobs P, S, X (R4): CAD-only, then published / client_selected / closed,
--   then a drawing is attached.
insert into public.jobs (id, organization_id, created_by, title, status)
values
  ('00000000-0000-4000-8000-0000009791a0', '00000000-0000-4000-8000-000000979001', '00000000-0000-4000-8000-000000979011', 'OVD 979 A', 'uploaded'),
  ('00000000-0000-4000-8000-0000009791b0', '00000000-0000-4000-8000-000000979001', '00000000-0000-4000-8000-000000979011', 'OVD 979 B', 'uploaded'),
  ('00000000-0000-4000-8000-0000009791c0', '00000000-0000-4000-8000-000000979001', '00000000-0000-4000-8000-000000979011', 'OVD 979 C', 'uploaded'),
  ('00000000-0000-4000-8000-0000009791d0', '00000000-0000-4000-8000-000000979001', '00000000-0000-4000-8000-000000979011', 'OVD 979 D', 'uploaded'),
  ('00000000-0000-4000-8000-0000009791e0', '00000000-0000-4000-8000-000000979001', '00000000-0000-4000-8000-000000979011', 'OVD 979 E', 'uploaded'),
  ('00000000-0000-4000-8000-0000009792a0', '00000000-0000-4000-8000-000000979001', '00000000-0000-4000-8000-000000979011', 'OVD 979 P', 'uploaded'),
  ('00000000-0000-4000-8000-0000009792b0', '00000000-0000-4000-8000-000000979001', '00000000-0000-4000-8000-000000979011', 'OVD 979 S', 'uploaded'),
  ('00000000-0000-4000-8000-0000009792c0', '00000000-0000-4000-8000-000000979001', '00000000-0000-4000-8000-000000979011', 'OVD 979 X', 'uploaded');

insert into public.job_files (
  id, job_id, organization_id, uploaded_by, storage_bucket, storage_path,
  original_name, normalized_name, file_kind
)
select file.id, file.job_id, '00000000-0000-4000-8000-000000979001', '00000000-0000-4000-8000-000000979011',
  'job-files', 'org/ovd979/' || file.id::text, file.original_name, 'ovd979-bracket', file.kind::public.job_file_kind
from (values
  ('00000000-0000-4000-8000-0000009791a1'::uuid, '00000000-0000-4000-8000-0000009791a0'::uuid, 'bracket.step', 'cad'),
  ('00000000-0000-4000-8000-0000009791a2'::uuid, '00000000-0000-4000-8000-0000009791a0'::uuid, 'bracket.pdf', 'drawing'),
  ('00000000-0000-4000-8000-0000009791b1'::uuid, '00000000-0000-4000-8000-0000009791b0'::uuid, 'bracket.step', 'cad'),
  ('00000000-0000-4000-8000-0000009791c1'::uuid, '00000000-0000-4000-8000-0000009791c0'::uuid, 'bracket.step', 'cad'),
  ('00000000-0000-4000-8000-0000009791c2'::uuid, '00000000-0000-4000-8000-0000009791c0'::uuid, 'bracket.pdf', 'drawing'),
  ('00000000-0000-4000-8000-0000009791d1'::uuid, '00000000-0000-4000-8000-0000009791d0'::uuid, 'bracket.step', 'cad'),
  ('00000000-0000-4000-8000-0000009791e1'::uuid, '00000000-0000-4000-8000-0000009791e0'::uuid, 'bracket.step', 'cad'),
  ('00000000-0000-4000-8000-0000009792a1'::uuid, '00000000-0000-4000-8000-0000009792a0'::uuid, 'bracket.step', 'cad'),
  ('00000000-0000-4000-8000-0000009792b1'::uuid, '00000000-0000-4000-8000-0000009792b0'::uuid, 'bracket.step', 'cad'),
  ('00000000-0000-4000-8000-0000009792c1'::uuid, '00000000-0000-4000-8000-0000009792c0'::uuid, 'bracket.step', 'cad')
) as file(id, job_id, original_name, kind);

insert into public.parts (id, job_id, organization_id, name, normalized_key, cad_file_id, drawing_file_id)
values
  ('00000000-0000-4000-8000-0000009791a3', '00000000-0000-4000-8000-0000009791a0', '00000000-0000-4000-8000-000000979001',
    'ovd979-bracket', 'ovd979-bracket', '00000000-0000-4000-8000-0000009791a1', '00000000-0000-4000-8000-0000009791a2'),
  ('00000000-0000-4000-8000-0000009791b3', '00000000-0000-4000-8000-0000009791b0', '00000000-0000-4000-8000-000000979001',
    'ovd979-bracket', 'ovd979-bracket', '00000000-0000-4000-8000-0000009791b1', null),
  ('00000000-0000-4000-8000-0000009791c3', '00000000-0000-4000-8000-0000009791c0', '00000000-0000-4000-8000-000000979001',
    'ovd979-bracket', 'ovd979-bracket', '00000000-0000-4000-8000-0000009791c1', '00000000-0000-4000-8000-0000009791c2'),
  ('00000000-0000-4000-8000-0000009791d3', '00000000-0000-4000-8000-0000009791d0', '00000000-0000-4000-8000-000000979001',
    'ovd979-bracket', 'ovd979-bracket', '00000000-0000-4000-8000-0000009791d1', null),
  ('00000000-0000-4000-8000-0000009791e3', '00000000-0000-4000-8000-0000009791e0', '00000000-0000-4000-8000-000000979001',
    'ovd979-bracket', 'ovd979-bracket', '00000000-0000-4000-8000-0000009791e1', null),
  ('00000000-0000-4000-8000-0000009792a3', '00000000-0000-4000-8000-0000009792a0', '00000000-0000-4000-8000-000000979001',
    'ovd979-bracket', 'ovd979-bracket', '00000000-0000-4000-8000-0000009792a1', null),
  ('00000000-0000-4000-8000-0000009792b3', '00000000-0000-4000-8000-0000009792b0', '00000000-0000-4000-8000-000000979001',
    'ovd979-bracket', 'ovd979-bracket', '00000000-0000-4000-8000-0000009792b1', null),
  ('00000000-0000-4000-8000-0000009792c3', '00000000-0000-4000-8000-0000009792c0', '00000000-0000-4000-8000-000000979001',
    'ovd979-bracket', 'ovd979-bracket', '00000000-0000-4000-8000-0000009792c1', null);

insert into public.drawing_extractions (part_id, organization_id, extraction)
values ('00000000-0000-4000-8000-0000009791c3', '00000000-0000-4000-8000-000000979001', '{"source":"pre-OVD-979"}'::jsonb);

create function pg_temp.ovd979_as_owner() returns void language sql as $$
  select set_config('request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-000000979011","role":"authenticated","aal":"aal1"}', true);
$$;

-- Simulated worker run, in the order handleExtractTask uses (worker/src/index.ts,
-- both the extraction and the trusted-reuse path): the task is claimed
-- ('running', as api_claim_next_task leaves it), the extraction row is replaced
-- with an explicit, later updated_at (the touch trigger would otherwise stamp
-- the constant now()), auto-approval runs while the task is STILL running, and
-- only then is the task marked completed (markTaskCompleted). p_complete false
-- stops before that last step so a test can read the state in between. An
-- earlier version of this helper completed the task first, which hid that
-- auto-approval counted the task it was called from.
-- A CAD-only run (extractor_version 'worker-sim-%') reads no drawing, so it
-- carries no material and no tolerance; a drawing run carries both (the
-- tolerance is 0.1 in, the value a millimetre drawing gives before OVD-976).
-- p_extra is merged into the extraction and p_drop keys are removed from it (a
-- review flag, a missing field); a negative p_minutes makes the extraction
-- older than the requirement. p_approve false stops after the extraction is
-- stored and before auto-approval (with p_complete false the task is left
-- 'running'): the worker writes the extraction row first and persists the
-- previews and calls auto-approval afterwards, so a failure at either step
-- ends there (review r6).
create function pg_temp.ovd979_worker_completes(
  p_job uuid, p_part uuid, p_version text, p_tag text, p_minutes integer,
  p_extra jsonb default '{}'::jsonb, p_drop text[] default '{}'::text[],
  p_complete boolean default true, p_approve boolean default true
)
returns void language plpgsql as $$
begin
  update public.work_queue
  set status = 'running', locked_at = timezone('utc', now()), locked_by = 'ovd979-test', attempts = attempts + 1
  where part_id = p_part and task_type = 'extract_part' and status = 'queued';
  delete from public.drawing_extractions where part_id = p_part;
  insert into public.drawing_extractions (part_id, organization_id, extractor_version, extraction, status, created_at, updated_at)
  values (p_part, '00000000-0000-4000-8000-000000979001', p_version,
    (jsonb_build_object(
      'description', 'EXTRACTED DESC ' || p_tag, 'quoteDescription', 'EXTRACTED DESC ' || p_tag,
      'partNumber', 'EX-PN-' || p_tag, 'revision', 'R' || p_tag,
      'quoteFinish', 'EXTRACTED FINISH ' || p_tag)
    || case when p_version like 'worker-sim-%' then '{}'::jsonb else jsonb_build_object(
      'material', jsonb_build_object('normalized', 'Aluminum 6061-T6'),
      'tolerances', jsonb_build_object('valueInch', 0.1)) end
    || p_extra) - p_drop,
    -- Same clock expression as the touch trigger and the RPCs
    -- (timezone('utc', now())), so the comparison holds in any session TimeZone.
    'needs_review',
    timezone('utc', now()) + make_interval(mins => p_minutes),
    timezone('utc', now()) + make_interval(mins => p_minutes));
  if p_approve then
    perform public.api_auto_approve_job_requirements(p_job);
  end if;
  if p_complete then
    update public.work_queue set status = 'completed', locked_at = null, locked_by = null
    where part_id = p_part and task_type = 'extract_part' and status = 'running';
  end if;
end;
$$;

-- The worker's failure path (markTaskFailed): the claimed task ends 'failed'.
create function pg_temp.ovd979_worker_fails(p_part uuid) returns void language sql as $$
  update public.work_queue
  set status = 'failed', last_error = 'ovd979 simulated extraction failure', locked_at = null, locked_by = null
  where part_id = p_part and task_type = 'extract_part' and status in ('queued', 'running');
$$;

-- One test transaction has one clock, so every task row it inserts shares one
-- created_at. In production a retry is queued minutes after the failure it
-- retries; this ages the part's existing tasks the same way before a retry.
create function pg_temp.ovd979_age_tasks(p_part uuid) returns void language sql as $$
  update public.work_queue set created_at = created_at - interval '10 minutes'
  where part_id = p_part and task_type = 'extract_part';
$$;

-- The statuses of a part's drawing_attached extraction tasks, oldest first.
create function pg_temp.ovd979_attach_statuses(p_part uuid) returns text[] language sql as $$
  select coalesce(array_agg(status::text order by created_at), '{}'::text[])
  from public.work_queue
  where part_id = p_part and task_type = 'extract_part' and payload ->> 'reason' = 'drawing_attached';
$$;

-- ---------------------------------------------------------------- part a (3f)
set local role authenticated;
select pg_temp.ovd979_as_owner();

select is(
  public.api_request_extraction('00000000-0000-4000-8000-0000009791a0'), 1,
  'A1 the new part queues one extraction'
);

-- The user saves corrections while that extraction is still queued.
select public.api_update_client_part_request(
  p_job_id => '00000000-0000-4000-8000-0000009791a0',
  p_description => 'USER DESC', p_part_number => 'USER-PN', p_revision => 'C',
  p_material => 'Aluminum 6061-T6', p_finish => 'USER FINISH'
);

reset role;
select pg_temp.ovd979_worker_completes(
  '00000000-0000-4000-8000-0000009791a0', '00000000-0000-4000-8000-0000009791a3', 'worker-pdf-v3', '1', 1
);

select is(
  (select array[description, part_number, revision, finish,
      spec_snapshot ->> 'quoteDescription', spec_snapshot ->> 'quoteFinish']
   from public.approved_part_requirements where part_id = '00000000-0000-4000-8000-0000009791a3'),
  array['USER DESC', 'USER-PN', 'C', 'USER FINISH', 'USER DESC', 'USER FINISH'],
  'A2 a correction saved while extraction was pending survives extraction completion'
);

select is(
  (select tightest_tolerance_inch from public.approved_part_requirements
   where part_id = '00000000-0000-4000-8000-0000009791a3'),
  0.1::numeric,
  'A5 a drawing uploaded with the part still fills a null tolerance (R3 applies only to an attach)'
);

-- Scope of the review r3 roll-up change: only a drawing_attached task is
-- treated as finishing once its extraction is stored. The first extraction of a
-- part keeps the status flow of main, even with a drawing extraction stored: its
-- own running task is still pending when the worker calls auto-approval, so the
-- job stays 'extracting'.
select is(
  (select status::text from public.jobs where id = '00000000-0000-4000-8000-0000009791a0'),
  'extracting',
  'W6 the first extraction of a part is not treated as finishing: its job keeps the status flow of main'
);

-- Reset-to-auto for description only (behavior of the reset RPC is unchanged).
set local role authenticated;
select pg_temp.ovd979_as_owner();
select public.api_reset_client_part_property_overrides('00000000-0000-4000-8000-0000009791a0', array['description']);
reset role;

select ok(
  not ((select spec_snapshot #> '{projectPartProperties,overrides}' from public.approved_part_requirements
        where part_id = '00000000-0000-4000-8000-0000009791a3') ? 'description')
  and ((select spec_snapshot #> '{projectPartProperties,overrides}' from public.approved_part_requirements
        where part_id = '00000000-0000-4000-8000-0000009791a3') ?& array['partNumber', 'revision', 'finish']),
  'A3 reset removes only the description override'
);

-- No further extraction runs between the reset and this check: the save came
-- while extraction 1 was pending, extraction 1 then completed, and the reset
-- field must return to what that extraction read from the drawing.
select is(
  (select array[description, part_number, revision, finish]
   from public.approved_part_requirements where part_id = '00000000-0000-4000-8000-0000009791a3'),
  array['EXTRACTED DESC 1', 'USER-PN', 'C', 'USER FINISH'],
  'A3b (M1) a reset after a save-while-pending returns the field to the extracted value with no further extraction'
);

-- A second, newer extraction on top of the reset (the sequence A4 asserts).
select pg_temp.ovd979_worker_completes(
  '00000000-0000-4000-8000-0000009791a0', '00000000-0000-4000-8000-0000009791a3', 'worker-pdf-v3', '2', 2
);

select is(
  (select array[description, part_number, revision, finish]
   from public.approved_part_requirements where part_id = '00000000-0000-4000-8000-0000009791a3'),
  array['EXTRACTED DESC 2', 'USER-PN', 'C', 'USER FINISH'],
  'A4 the reset field is auto again (refreshed by a newer extraction); owned fields are kept'
);

-- ---------------------------------------------------------------- part b (1b-b)
set local role authenticated;
select pg_temp.ovd979_as_owner();
select is(
  public.api_request_extraction('00000000-0000-4000-8000-0000009791b0'), 1,
  'B0 the CAD-only part queues one extraction'
);
reset role;

select pg_temp.ovd979_worker_completes(
  '00000000-0000-4000-8000-0000009791b0', '00000000-0000-4000-8000-0000009791b3', 'worker-sim-v1', 'cad', 1
);

-- The user corrects only the finish, then attaches a drawing.
set local role authenticated;
select pg_temp.ovd979_as_owner();
select public.api_update_client_part_request(
  p_job_id => '00000000-0000-4000-8000-0000009791b0',
  p_description => 'EXTRACTED DESC cad', p_part_number => 'EX-PN-cad', p_revision => 'Rcad',
  p_material => 'Aluminum 6061-T6', p_finish => 'USER FINISH'
);
reset role;

-- The job has been rolled up to ready_to_quote when the drawing arrives (the
-- worker's own CAD-only run leaves a job 'extracting', as on main, so the
-- ready state is set here, as an earlier roll-up or an internal approval does).
update public.jobs set status = 'ready_to_quote' where id = '00000000-0000-4000-8000-0000009791b0';

insert into public.job_files (
  id, job_id, organization_id, uploaded_by, storage_bucket, storage_path,
  original_name, normalized_name, file_kind
) values (
  '00000000-0000-4000-8000-0000009791b2', '00000000-0000-4000-8000-0000009791b0', '00000000-0000-4000-8000-000000979001',
  '00000000-0000-4000-8000-000000979011', 'job-files', 'org/ovd979/attached.pdf', 'bracket.pdf', 'ovd979-bracket', 'drawing'
);

set local role authenticated;
select pg_temp.ovd979_as_owner();
select is(
  public.api_request_extraction('00000000-0000-4000-8000-0000009791b0'), 1,
  'B1 attaching a drawing to a CAD-only extracted part queues one extraction'
);
select is(
  public.api_request_extraction('00000000-0000-4000-8000-0000009791b0'), 0,
  'B2 a retry does not queue a duplicate'
);
reset role;

select is(
  (select status::text from public.jobs where id = '00000000-0000-4000-8000-0000009791b0'),
  'extracting',
  'B1b an attach on a job that has not started quoting (ready_to_quote) still sets extracting'
);

select is(
  (select count(*)::integer from public.work_queue
   where part_id = '00000000-0000-4000-8000-0000009791b3' and task_type = 'extract_part'
     and status = 'queued' and payload ->> 'reason' = 'drawing_attached'
     and payload ->> 'drawingFileId' = '00000000-0000-4000-8000-0000009791b2'),
  1,
  'B3 exactly one queued drawing_attached task, naming the attached drawing'
);

select is(
  (select drawing_file_id from public.parts where id = '00000000-0000-4000-8000-0000009791b3'),
  '00000000-0000-4000-8000-0000009791b2'::uuid,
  'B4 reconcile attached the drawing to the existing part'
);

select pg_temp.ovd979_worker_completes(
  '00000000-0000-4000-8000-0000009791b0', '00000000-0000-4000-8000-0000009791b3', 'worker-pdf-v3', 'dwg', 3
);

select is(
  (select array[description, part_number, revision, finish]
   from public.approved_part_requirements where part_id = '00000000-0000-4000-8000-0000009791b3'),
  array['EXTRACTED DESC dwg', 'EX-PN-dwg', 'Rdwg', 'USER FINISH'],
  'B5 the drawing extraction fills auto fields and keeps the user-owned finish'
);

select is(
  (select status::text from public.jobs where id = '00000000-0000-4000-8000-0000009791b0'),
  'ready_to_quote',
  'B5b a pre-quote job is rolled up to ready_to_quote after the drawing extraction'
);

set local role authenticated;
select pg_temp.ovd979_as_owner();
select is(
  public.api_request_extraction('00000000-0000-4000-8000-0000009791b0'), 0,
  'B6 nothing more is queued once the drawing was extracted'
);
select is(
  public.api_request_extraction('00000000-0000-4000-8000-0000009791c0'), 0,
  'B7 an extraction row not written by the CAD-only worker path is never re-queued'
);
reset role;

-- B's finish is user-owned (an override): the newer extraction moves its editor
-- default to the drawing value so a reset has something to return to, but it
-- never touches the user's column value. The unrelated save that follows resends
-- the displayed values and must keep the override.
select is(
  (select array[spec_snapshot #>> '{projectPartProperties,defaults,finish}', finish]
   from public.approved_part_requirements where part_id = '00000000-0000-4000-8000-0000009791b3'),
  array['EXTRACTED FINISH dwg', 'USER FINISH'],
  'B8 (M1) the default of a user-owned field follows the newer extraction; the user''s value is kept'
);

set local role authenticated;
select pg_temp.ovd979_as_owner();
select public.api_update_client_part_request(
  p_job_id => '00000000-0000-4000-8000-0000009791b0',
  p_description => 'EXTRACTED DESC dwg', p_part_number => 'EX-PN-dwg', p_revision => 'Rdwg',
  p_material => 'Aluminum 6061-T6', p_finish => 'USER FINISH', p_quantity => 5
);
reset role;

select is(
  (select coalesce(array_agg(key order by key), '{}'::text[])
   from public.approved_part_requirements r,
     jsonb_object_keys(r.spec_snapshot #> '{projectPartProperties,overrides}') key
   where r.part_id = '00000000-0000-4000-8000-0000009791b3'),
  array['finish', 'material'],
  'B9 (R1) an unrelated save keeps the user-owned overrides'
);

-- ---------------------------------------------------------------- review r0: R1, R2, R3 (job D, job E)
-- D: CAD-only extraction, then a save that changes nothing (this seeds the
-- CAD-only editor defaults), then a drawing is attached and extracted.
set local role authenticated;
select pg_temp.ovd979_as_owner();
select public.api_request_extraction(job_id)
from unnest(array['00000000-0000-4000-8000-0000009791d0', '00000000-0000-4000-8000-0000009791e0']::uuid[]) job_id;
reset role;
select pg_temp.ovd979_worker_completes(
  '00000000-0000-4000-8000-0000009791d0', '00000000-0000-4000-8000-0000009791d3', 'worker-sim-v1', 'cad', 1
);
select pg_temp.ovd979_worker_completes(
  '00000000-0000-4000-8000-0000009791e0', '00000000-0000-4000-8000-0000009791e3', 'worker-sim-v1', 'cad', 1
);

set local role authenticated;
select pg_temp.ovd979_as_owner();
-- Each re-queue is a paid model run: a CAD-only part with no drawing must
-- never be queued again.
select is(
  public.api_request_extraction('00000000-0000-4000-8000-0000009791d0'), 0,
  'D-1 a CAD-only extracted part with no drawing queues nothing'
);
select public.api_update_client_part_request(
  p_job_id => '00000000-0000-4000-8000-0000009791d0',
  p_description => 'EXTRACTED DESC cad', p_part_number => 'EX-PN-cad', p_revision => 'Rcad',
  p_material => 'Unknown material', p_finish => 'EXTRACTED FINISH cad'
);
reset role;

-- E: the user explicitly stores 'Unknown material' (the editor default was
-- another material, so the save records a material override).
update public.approved_part_requirements set material = 'Steel 1018'
where part_id = '00000000-0000-4000-8000-0000009791e3';
set local role authenticated;
select pg_temp.ovd979_as_owner();
select public.api_update_client_part_request(
  p_job_id => '00000000-0000-4000-8000-0000009791e0',
  p_description => 'EXTRACTED DESC cad', p_part_number => 'EX-PN-cad', p_revision => 'Rcad',
  p_material => 'Unknown material', p_finish => 'EXTRACTED FINISH cad'
);
reset role;

insert into public.job_files (
  id, job_id, organization_id, uploaded_by, storage_bucket, storage_path,
  original_name, normalized_name, file_kind
)
select file.id, file.job_id, '00000000-0000-4000-8000-000000979001', '00000000-0000-4000-8000-000000979011',
  'job-files', 'org/ovd979/' || file.id::text, 'bracket.pdf', 'ovd979-bracket', 'drawing'::public.job_file_kind
from (values
  ('00000000-0000-4000-8000-0000009791d2'::uuid, '00000000-0000-4000-8000-0000009791d0'::uuid),
  ('00000000-0000-4000-8000-0000009791e2'::uuid, '00000000-0000-4000-8000-0000009791e0'::uuid)
) as file(id, job_id);

set local role authenticated;
select pg_temp.ovd979_as_owner();
select is(
  (select array_agg(public.api_request_extraction(job_id) order by job_id)
   from unnest(array['00000000-0000-4000-8000-0000009791d0', '00000000-0000-4000-8000-0000009791e0']::uuid[]) job_id),
  array[1, 1],
  'D0 attaching a drawing queues one extraction for each of D and E'
);
reset role;

select pg_temp.ovd979_worker_completes(
  '00000000-0000-4000-8000-0000009791d0', '00000000-0000-4000-8000-0000009791d3', 'worker-pdf-v3', 'dwg', 3
);
select pg_temp.ovd979_worker_completes(
  '00000000-0000-4000-8000-0000009791e0', '00000000-0000-4000-8000-0000009791e3', 'worker-pdf-v3', 'dwg', 3
);

select is(
  (select array[material, spec_snapshot #>> '{projectPartProperties,defaults,material}']
   from public.approved_part_requirements where part_id = '00000000-0000-4000-8000-0000009791d3'),
  array['Aluminum 6061-T6', 'Aluminum 6061-T6'],
  'D1 (R2) the drawing material replaces the Unknown material placeholder, and the editor default follows'
);

select is(
  (select tightest_tolerance_inch from public.approved_part_requirements
   where part_id = '00000000-0000-4000-8000-0000009791d3'),
  null::numeric,
  'D2 (R3) a drawing-attach extraction does not fill the null tolerance (left for the user to confirm)'
);

select is(
  (select array[description, spec_snapshot #>> '{projectPartProperties,defaults,description}',
      spec_snapshot #>> '{projectPartProperties,defaults,partNumber}',
      spec_snapshot #>> '{projectPartProperties,defaults,revision}',
      spec_snapshot #>> '{projectPartProperties,defaults,finish}']
   from public.approved_part_requirements where part_id = '00000000-0000-4000-8000-0000009791d3'),
  array['EXTRACTED DESC dwg', 'EXTRACTED DESC dwg', 'EX-PN-dwg', 'Rdwg', 'EXTRACTED FINISH dwg'],
  'D3 (R1) refreshed fields also refresh the editor defaults'
);

-- An unrelated save (quantity only) that resends the displayed values.
set local role authenticated;
select pg_temp.ovd979_as_owner();
select public.api_update_client_part_request(
  p_job_id => '00000000-0000-4000-8000-0000009791d0',
  p_description => 'EXTRACTED DESC dwg', p_part_number => 'EX-PN-dwg', p_revision => 'Rdwg',
  p_material => 'Aluminum 6061-T6', p_finish => 'EXTRACTED FINISH dwg', p_quantity => 5
);
reset role;

select is(
  (select coalesce(array_agg(key order by key), '{}'::text[])
   from public.approved_part_requirements r,
     jsonb_object_keys(r.spec_snapshot #> '{projectPartProperties,overrides}') key
   where r.part_id = '00000000-0000-4000-8000-0000009791d3'),
  '{}'::text[],
  'D4 (R1) an unrelated save after the refresh records no override keys'
);

set local role authenticated;
select pg_temp.ovd979_as_owner();
select public.api_reset_client_part_property_overrides('00000000-0000-4000-8000-0000009791d0', array['description']);
reset role;

select is(
  (select description from public.approved_part_requirements where part_id = '00000000-0000-4000-8000-0000009791d3'),
  'EXTRACTED DESC dwg',
  'D5 (R1) reset after the attach resolves to the drawing value, not the CAD-only default'
);

select is(
  (select array[material, spec_snapshot #>> '{projectPartProperties,overrides,material}']
   from public.approved_part_requirements where part_id = '00000000-0000-4000-8000-0000009791e3'),
  array['Unknown material', 'Unknown material'],
  'E1 (R2) an Unknown material value the user stored as an override is kept'
);

-- ---------------------------------------------------------------- review r0: R4 (jobs P, S, X)
create temp table ovd979_quoted (job_id uuid primary key, part_id uuid, queued integer, status_after_request text);
grant all on ovd979_quoted to authenticated;
insert into ovd979_quoted (job_id, part_id) values
  ('00000000-0000-4000-8000-0000009792a0', '00000000-0000-4000-8000-0000009792a3'),
  ('00000000-0000-4000-8000-0000009792b0', '00000000-0000-4000-8000-0000009792b3'),
  ('00000000-0000-4000-8000-0000009792c0', '00000000-0000-4000-8000-0000009792c3');

set local role authenticated;
select pg_temp.ovd979_as_owner();
select public.api_request_extraction(job_id) from ovd979_quoted;
reset role;
select pg_temp.ovd979_worker_completes(job_id, part_id, 'worker-sim-v1', 'cad', 1) from ovd979_quoted;

update public.jobs set status = 'published' where id = '00000000-0000-4000-8000-0000009792a0';
update public.jobs set status = 'client_selected' where id = '00000000-0000-4000-8000-0000009792b0';
update public.jobs set status = 'closed' where id = '00000000-0000-4000-8000-0000009792c0';

insert into public.job_files (
  id, job_id, organization_id, uploaded_by, storage_bucket, storage_path,
  original_name, normalized_name, file_kind
)
select file.id, file.job_id, '00000000-0000-4000-8000-000000979001', '00000000-0000-4000-8000-000000979011',
  'job-files', 'org/ovd979/' || file.id::text, 'bracket.pdf', 'ovd979-bracket', 'drawing'::public.job_file_kind
from (values
  ('00000000-0000-4000-8000-0000009792a2'::uuid, '00000000-0000-4000-8000-0000009792a0'::uuid),
  ('00000000-0000-4000-8000-0000009792b2'::uuid, '00000000-0000-4000-8000-0000009792b0'::uuid),
  ('00000000-0000-4000-8000-0000009792c2'::uuid, '00000000-0000-4000-8000-0000009792c0'::uuid)
) as file(id, job_id);

set local role authenticated;
select pg_temp.ovd979_as_owner();
update ovd979_quoted set queued = public.api_request_extraction(job_id);
reset role;
update ovd979_quoted quoted set status_after_request = job.status::text
from public.jobs job where job.id = quoted.job_id;
select pg_temp.ovd979_worker_completes(job_id, part_id, 'worker-pdf-v3', 'dwg', 3) from ovd979_quoted;

-- Each row: tasks queued by the attach, job status after the request, job
-- status after the extraction completed, and the refreshed requirement
-- description (the requirement is refreshed; registered quote lanes keep
-- their immutable scope, OVD-345).
select is(
  (select array[quoted.queued::text, quoted.status_after_request, job.status::text, requirement.description]
   from ovd979_quoted quoted
   join public.jobs job on job.id = quoted.job_id
   join public.approved_part_requirements requirement on requirement.part_id = quoted.part_id
   where quoted.job_id = '00000000-0000-4000-8000-0000009792a0'),
  array['1', 'published', 'published', 'EXTRACTED DESC dwg'],
  'Q1 (R4) attach on a published job queues the extraction and keeps the job published'
);
select is(
  (select array[quoted.queued::text, quoted.status_after_request, job.status::text, requirement.description]
   from ovd979_quoted quoted
   join public.jobs job on job.id = quoted.job_id
   join public.approved_part_requirements requirement on requirement.part_id = quoted.part_id
   where quoted.job_id = '00000000-0000-4000-8000-0000009792b0'),
  array['1', 'client_selected', 'client_selected', 'EXTRACTED DESC dwg'],
  'Q2 (R4) attach on a client_selected job keeps the job client_selected'
);
select is(
  (select array[quoted.queued::text, quoted.status_after_request, job.status::text, requirement.description]
   from ovd979_quoted quoted
   join public.jobs job on job.id = quoted.job_id
   join public.approved_part_requirements requirement on requirement.part_id = quoted.part_id
   where quoted.job_id = '00000000-0000-4000-8000-0000009792c0'),
  array['1', 'closed', 'closed', 'EXTRACTED DESC dwg'],
  'Q3 (R4) attach on a closed job keeps the job closed'
);

-- ---------------------------------------------------------------- review r1 nits (jobs F, R, H, N)
-- F: a failed drawing_attached task, then a worker retry.
-- R: a drawing_attached task completed without replacing the CAD-only row
--    (trusted-reuse path).
-- H: legacy fieldSources.material = 'user' over the placeholder.
-- N: a never-extracted part on a published job.
insert into public.jobs (id, organization_id, created_by, title, status)
values
  ('00000000-0000-4000-8000-0000009793a0', '00000000-0000-4000-8000-000000979001', '00000000-0000-4000-8000-000000979011', 'OVD 979 F', 'uploaded'),
  ('00000000-0000-4000-8000-0000009793b0', '00000000-0000-4000-8000-000000979001', '00000000-0000-4000-8000-000000979011', 'OVD 979 R', 'uploaded'),
  ('00000000-0000-4000-8000-0000009793d0', '00000000-0000-4000-8000-000000979001', '00000000-0000-4000-8000-000000979011', 'OVD 979 H', 'uploaded'),
  ('00000000-0000-4000-8000-0000009793c0', '00000000-0000-4000-8000-000000979001', '00000000-0000-4000-8000-000000979011', 'OVD 979 N', 'published');

insert into public.job_files (
  id, job_id, organization_id, uploaded_by, storage_bucket, storage_path,
  original_name, normalized_name, file_kind
)
select file.id, file.job_id, '00000000-0000-4000-8000-000000979001', '00000000-0000-4000-8000-000000979011',
  'job-files', 'org/ovd979/' || file.id::text, 'bracket.step', 'ovd979-bracket', 'cad'::public.job_file_kind
from (values
  ('00000000-0000-4000-8000-0000009793a1'::uuid, '00000000-0000-4000-8000-0000009793a0'::uuid),
  ('00000000-0000-4000-8000-0000009793b1'::uuid, '00000000-0000-4000-8000-0000009793b0'::uuid),
  ('00000000-0000-4000-8000-0000009793d1'::uuid, '00000000-0000-4000-8000-0000009793d0'::uuid),
  ('00000000-0000-4000-8000-0000009793c1'::uuid, '00000000-0000-4000-8000-0000009793c0'::uuid)
) as file(id, job_id);

insert into public.parts (id, job_id, organization_id, name, normalized_key, cad_file_id, drawing_file_id)
select file.part_id, file.job_id, '00000000-0000-4000-8000-000000979001',
  'ovd979-bracket', 'ovd979-bracket', file.cad_id, null
from (values
  ('00000000-0000-4000-8000-0000009793a3'::uuid, '00000000-0000-4000-8000-0000009793a0'::uuid, '00000000-0000-4000-8000-0000009793a1'::uuid),
  ('00000000-0000-4000-8000-0000009793b3'::uuid, '00000000-0000-4000-8000-0000009793b0'::uuid, '00000000-0000-4000-8000-0000009793b1'::uuid),
  ('00000000-0000-4000-8000-0000009793d3'::uuid, '00000000-0000-4000-8000-0000009793d0'::uuid, '00000000-0000-4000-8000-0000009793d1'::uuid),
  ('00000000-0000-4000-8000-0000009793c3'::uuid, '00000000-0000-4000-8000-0000009793c0'::uuid, '00000000-0000-4000-8000-0000009793c1'::uuid)
) as file(part_id, job_id, cad_id);

set local role authenticated;
select pg_temp.ovd979_as_owner();
select public.api_request_extraction('00000000-0000-4000-8000-0000009793c0');
select public.api_request_extraction(job_id)
from unnest(array['00000000-0000-4000-8000-0000009793a0', '00000000-0000-4000-8000-0000009793b0',
                  '00000000-0000-4000-8000-0000009793d0']::uuid[]) job_id;
reset role;

select is(
  (select array[
     (select count(*) from public.work_queue
      where part_id = '00000000-0000-4000-8000-0000009793c3' and task_type = 'extract_part')::text,
     (select status::text from public.jobs where id = '00000000-0000-4000-8000-0000009793c0')]),
  array['1', 'extracting'],
  'N1 (R4) a never-extracted part on a published job still sets extracting, as on main'
);

select pg_temp.ovd979_worker_completes(job_id, part_id, 'worker-sim-v1', 'cad', 1)
from (values
  ('00000000-0000-4000-8000-0000009793a0'::uuid, '00000000-0000-4000-8000-0000009793a3'::uuid),
  ('00000000-0000-4000-8000-0000009793b0'::uuid, '00000000-0000-4000-8000-0000009793b3'::uuid),
  ('00000000-0000-4000-8000-0000009793d0'::uuid, '00000000-0000-4000-8000-0000009793d3'::uuid)
) as v(job_id, part_id);

-- H: legacy provenance marks material as user-owned (written after the
-- CAD-only auto-approval, which rewrites fieldSources with four keys).
update public.approved_part_requirements
set spec_snapshot = jsonb_set(
  jsonb_set(spec_snapshot, '{fieldSources,material}', '"user"'::jsonb),
  '{fieldOverrides,material}', 'true'::jsonb, true)
where part_id = '00000000-0000-4000-8000-0000009793d3';

insert into public.job_files (
  id, job_id, organization_id, uploaded_by, storage_bucket, storage_path,
  original_name, normalized_name, file_kind
)
select file.id, file.job_id, '00000000-0000-4000-8000-000000979001', '00000000-0000-4000-8000-000000979011',
  'job-files', 'org/ovd979/' || file.id::text, 'bracket.pdf', 'ovd979-bracket', 'drawing'::public.job_file_kind
from (values
  ('00000000-0000-4000-8000-0000009793a2'::uuid, '00000000-0000-4000-8000-0000009793a0'::uuid),
  ('00000000-0000-4000-8000-0000009793b2'::uuid, '00000000-0000-4000-8000-0000009793b0'::uuid),
  ('00000000-0000-4000-8000-0000009793d2'::uuid, '00000000-0000-4000-8000-0000009793d0'::uuid)
) as file(id, job_id);

set local role authenticated;
select pg_temp.ovd979_as_owner();
select public.api_request_extraction(job_id)
from unnest(array['00000000-0000-4000-8000-0000009793a0', '00000000-0000-4000-8000-0000009793b0',
                  '00000000-0000-4000-8000-0000009793d0']::uuid[]) job_id;
reset role;

-- F: the drawing task fails (the worker claims it and marks it failed); the next
-- auto-approval run (any part of the job) rolls the job up. The user then
-- retries through api_request_extraction, which queues a NEW task and keeps the
-- failed row as the record (it does not requeue the failed row), and the retry
-- succeeds.
select pg_temp.ovd979_worker_fails('00000000-0000-4000-8000-0000009793a3');
select public.api_auto_approve_job_requirements('00000000-0000-4000-8000-0000009793a0');
select is(
  (select status::text from public.jobs where id = '00000000-0000-4000-8000-0000009793a0'),
  'needs_spec_review',
  'F1 (R4) a failed drawing task rolls a pre-quote job up to needs_spec_review'
);

select pg_temp.ovd979_age_tasks('00000000-0000-4000-8000-0000009793a3');
set local role authenticated;
select pg_temp.ovd979_as_owner();
select is(
  public.api_request_extraction('00000000-0000-4000-8000-0000009793a0'), 1,
  'F2 retrying a failed drawing task through api_request_extraction queues a new task'
);
reset role;
select is(
  pg_temp.ovd979_attach_statuses('00000000-0000-4000-8000-0000009793a3'),
  array['failed', 'queued'],
  'F2b the failed task is kept next to the retry, not requeued'
);

select public.api_auto_approve_job_requirements('00000000-0000-4000-8000-0000009793a0');
select is(
  (select status::text from public.jobs where id = '00000000-0000-4000-8000-0000009793a0'),
  'extracting',
  'F3 (Codex 2) while the retry is queued the job is extracting: the failure it replaces no longer counts, the retry does'
);

select pg_temp.ovd979_worker_completes(
  '00000000-0000-4000-8000-0000009793a0', '00000000-0000-4000-8000-0000009793a3', 'worker-pdf-v3', 'dwg', 3
);
select is(
  (select status::text from public.jobs where id = '00000000-0000-4000-8000-0000009793a0'),
  'ready_to_quote',
  'F4 (R4, Codex 2) a successful retry rolls the job up to ready_to_quote although the failed task is kept'
);
select is(
  pg_temp.ovd979_attach_statuses('00000000-0000-4000-8000-0000009793a3'),
  array['failed', 'completed'],
  'F4b the failed task is still on record after the retry succeeded'
);

-- R: the task completes but the extraction row stays CAD-only.
update public.work_queue set status = 'completed'
where part_id = '00000000-0000-4000-8000-0000009793b3' and task_type = 'extract_part' and status = 'queued';
set local role authenticated;
select pg_temp.ovd979_as_owner();
select is(
  public.api_request_extraction('00000000-0000-4000-8000-0000009793b0'), 0,
  'R1 a completed drawing task for the current drawing is not queued again, even if the row stays CAD-only'
);
reset role;

select pg_temp.ovd979_worker_completes(
  '00000000-0000-4000-8000-0000009793d0', '00000000-0000-4000-8000-0000009793d3', 'worker-pdf-v3', 'dwg', 3
);
-- A second auto-approval of the same job (another part's extraction completing
-- calls it again) must keep both the value and the provenance that protects it:
-- the first run rewrites fieldSources and fieldOverrides, and it used to drop
-- their material keys.
select public.api_auto_approve_job_requirements('00000000-0000-4000-8000-0000009793d0');
select is(
  (select array[material, spec_snapshot #>> '{fieldSources,material}', spec_snapshot #>> '{fieldOverrides,material}']
   from public.approved_part_requirements where part_id = '00000000-0000-4000-8000-0000009793d3'),
  array['Unknown material', 'user', 'true'],
  'H1 (R2) a placeholder material owned through legacy fieldSources.material is kept by repeated auto-approvals, with its provenance'
);

-- ---------------------------------------------------------------- review r2: M1 (jobs M, V)
-- M: a correction saved while extraction is pending, the extraction completes,
--    and every field is then reset with no further extraction running (the
--    sequence the acceptance criterion states).
-- V: the guards of the editor-default sync. A stale extraction, a field flagged
--    for review, an extraction with no value for the field, and a field owned
--    only through legacy fieldSources (no override key) must not move a default.
insert into public.jobs (id, organization_id, created_by, title, status)
values
  ('00000000-0000-4000-8000-0000009794a0', '00000000-0000-4000-8000-000000979001', '00000000-0000-4000-8000-000000979011', 'OVD 979 M', 'uploaded'),
  ('00000000-0000-4000-8000-0000009794b0', '00000000-0000-4000-8000-000000979001', '00000000-0000-4000-8000-000000979011', 'OVD 979 V', 'uploaded');

insert into public.job_files (
  id, job_id, organization_id, uploaded_by, storage_bucket, storage_path,
  original_name, normalized_name, file_kind
)
select file.id, file.job_id, '00000000-0000-4000-8000-000000979001', '00000000-0000-4000-8000-000000979011',
  'job-files', 'org/ovd979/' || file.id::text, 'bracket.step', 'ovd979-bracket', 'cad'::public.job_file_kind
from (values
  ('00000000-0000-4000-8000-0000009794a1'::uuid, '00000000-0000-4000-8000-0000009794a0'::uuid),
  ('00000000-0000-4000-8000-0000009794b1'::uuid, '00000000-0000-4000-8000-0000009794b0'::uuid)
) as file(id, job_id);

insert into public.parts (id, job_id, organization_id, name, normalized_key, cad_file_id, drawing_file_id)
values
  ('00000000-0000-4000-8000-0000009794a3', '00000000-0000-4000-8000-0000009794a0', '00000000-0000-4000-8000-000000979001',
    'ovd979-bracket', 'ovd979-bracket', '00000000-0000-4000-8000-0000009794a1', null),
  ('00000000-0000-4000-8000-0000009794b3', '00000000-0000-4000-8000-0000009794b0', '00000000-0000-4000-8000-000000979001',
    'ovd979-bracket', 'ovd979-bracket', '00000000-0000-4000-8000-0000009794b1', null);

set local role authenticated;
select pg_temp.ovd979_as_owner();
select public.api_request_extraction(job_id)
from unnest(array['00000000-0000-4000-8000-0000009794a0', '00000000-0000-4000-8000-0000009794b0']::uuid[]) job_id;
-- Both users save while their extraction is queued.
select public.api_update_client_part_request(
  p_job_id => '00000000-0000-4000-8000-0000009794a0',
  p_description => 'USER DESC', p_part_number => 'USER-PN', p_revision => 'C',
  p_material => 'Aluminum 6061-T6', p_finish => 'USER FINISH'
);
-- V: description, part number and finish become overrides; revision does not.
select public.api_update_client_part_request(
  p_job_id => '00000000-0000-4000-8000-0000009794b0',
  p_description => 'USER DESC', p_part_number => 'USER-PN',
  p_material => 'Aluminum 6061-T6', p_finish => 'USER FINISH'
);
reset role;

-- V: revision is owned through the legacy provenance alone (internal approval
-- or the March client RPC), with no override key.
update public.approved_part_requirements
set revision = 'LEGACY REV',
    spec_snapshot = spec_snapshot || jsonb_build_object('fieldSources', jsonb_build_object('revision', 'user'))
where part_id = '00000000-0000-4000-8000-0000009794b3';

-- V: an extraction older than the requirement is not applied to any default.
select pg_temp.ovd979_worker_completes(
  '00000000-0000-4000-8000-0000009794b0', '00000000-0000-4000-8000-0000009794b3', 'worker-pdf-v3', 'old', -1
);
select is(
  (select array[
      coalesce(spec_snapshot #>> '{projectPartProperties,defaults,description}', 'none'),
      coalesce(spec_snapshot #>> '{projectPartProperties,defaults,partNumber}', 'none'),
      coalesce(spec_snapshot #>> '{projectPartProperties,defaults,revision}', 'none'),
      coalesce(spec_snapshot #>> '{projectPartProperties,defaults,finish}', 'none')]
   from public.approved_part_requirements where part_id = '00000000-0000-4000-8000-0000009794b3'),
  array['none', 'none', 'none', 'none'],
  'V1 (M1) an extraction older than the requirement does not move the editor default of a user-owned field'
);

-- V: a newer extraction with a value for every field moves the defaults of the
-- override-owned fields (description, part number, finish) and not the
-- revision, which only the legacy provenance owns.
select pg_temp.ovd979_worker_completes(
  '00000000-0000-4000-8000-0000009794b0', '00000000-0000-4000-8000-0000009794b3', 'worker-pdf-v3', 'v1', 1
);
-- V: a still newer extraction has no part number, flags the finish for review
-- and reads a different description and revision.
select pg_temp.ovd979_worker_completes(
  '00000000-0000-4000-8000-0000009794b0', '00000000-0000-4000-8000-0000009794b3', 'worker-pdf-v3', 'v2', 2,
  '{"extractedFinishRaw": {"reviewNeeded": true}}'::jsonb, array['partNumber']
);
select is(
  (select array[
      coalesce(spec_snapshot #>> '{projectPartProperties,defaults,description}', 'none'),
      coalesce(spec_snapshot #>> '{projectPartProperties,defaults,partNumber}', 'none'),
      coalesce(spec_snapshot #>> '{projectPartProperties,defaults,revision}', 'none'),
      coalesce(spec_snapshot #>> '{projectPartProperties,defaults,finish}', 'none'),
      description, part_number, revision, finish]
   from public.approved_part_requirements where part_id = '00000000-0000-4000-8000-0000009794b3'),
  array['EXTRACTED DESC v2', 'EX-PN-v1', 'none', 'EXTRACTED FINISH v1',
        'USER DESC', 'USER-PN', 'LEGACY REV', 'USER FINISH'],
  'V2 (M1) an override-owned default follows only a newer extraction with a trusted value: a missing value, a review flag and a legacy-only owner leave it; every column keeps the user''s value'
);

-- M: the extraction completes after the save.
select pg_temp.ovd979_worker_completes(
  '00000000-0000-4000-8000-0000009794a0', '00000000-0000-4000-8000-0000009794a3', 'worker-pdf-v3', 'm', 1
);
select is(
  (select array[description, part_number, revision, finish,
      spec_snapshot #>> '{projectPartProperties,defaults,description}',
      spec_snapshot #>> '{projectPartProperties,defaults,partNumber}',
      spec_snapshot #>> '{projectPartProperties,defaults,revision}',
      spec_snapshot #>> '{projectPartProperties,defaults,finish}']
   from public.approved_part_requirements where part_id = '00000000-0000-4000-8000-0000009794a3'),
  array['USER DESC', 'USER-PN', 'C', 'USER FINISH',
        'EXTRACTED DESC m', 'EX-PN-m', 'Rm', 'EXTRACTED FINISH m'],
  'M1 (M1) the correction survives the extraction and the editor defaults now hold the drawing values'
);

-- M: reset all four fields. No extraction runs after this point.
set local role authenticated;
select pg_temp.ovd979_as_owner();
select public.api_reset_client_part_property_overrides(
  '00000000-0000-4000-8000-0000009794a0', array['description', 'partNumber', 'revision', 'finish']
);
reset role;
select is(
  (select array[description, part_number, revision, finish,
      spec_snapshot ->> 'quoteDescription', spec_snapshot ->> 'quoteFinish']
   from public.approved_part_requirements where part_id = '00000000-0000-4000-8000-0000009794a3'),
  array['EXTRACTED DESC m', 'EX-PN-m', 'Rm', 'EXTRACTED FINISH m',
        'EXTRACTED DESC m', 'EXTRACTED FINISH m'],
  'M2 (M1) reset returns each field to the drawing value when no extraction runs after it'
);

-- ---------------------------------------------------------------- review r2: trusted reuse (jobs U, T, T2, U2, T5)
-- U: the source placement, a trusted CAD + drawing package already extracted
--    from its drawing. T: the same CAD extracted CAD-only first, then the same
--    drawing attached, so its package now equals U's and the worker reuses U's
--    extraction instead of extracting T. T2: a placement of the same package
--    that already holds its own drawing extraction. U2 and T5: a trusted
--    CAD-only package (no drawing anywhere) whose source row is not CAD-only.
insert into public.jobs (id, organization_id, created_by, title, status)
values
  ('00000000-0000-4000-8000-0000009795a0', '00000000-0000-4000-8000-000000979001', '00000000-0000-4000-8000-000000979011', 'OVD 979 U', 'uploaded'),
  ('00000000-0000-4000-8000-0000009795b0', '00000000-0000-4000-8000-000000979001', '00000000-0000-4000-8000-000000979011', 'OVD 979 T', 'uploaded'),
  ('00000000-0000-4000-8000-0000009795c0', '00000000-0000-4000-8000-000000979001', '00000000-0000-4000-8000-000000979011', 'OVD 979 T2', 'uploaded'),
  ('00000000-0000-4000-8000-0000009795d0', '00000000-0000-4000-8000-000000979001', '00000000-0000-4000-8000-000000979011', 'OVD 979 U2', 'uploaded'),
  ('00000000-0000-4000-8000-0000009795e0', '00000000-0000-4000-8000-000000979001', '00000000-0000-4000-8000-000000979011', 'OVD 979 T5', 'uploaded');

create function pg_temp.ovd979_add_trusted_file(p_id uuid, p_job uuid, p_kind text, p_seed text default null)
returns void language sql as $$
  insert into public.job_files (
    id, job_id, organization_id, uploaded_by, storage_bucket, storage_path,
    original_name, normalized_name, file_kind, content_sha256, trusted_content_sha256
  ) values (
    p_id, p_job, '00000000-0000-4000-8000-000000979001', '00000000-0000-4000-8000-000000979011',
    'job-files', 'org/ovd979/' || p_id::text,
    case p_kind when 'cad' then 'bracket.step' else 'bracket.pdf' end, 'ovd979-bracket', p_kind::public.job_file_kind,
    repeat(coalesce(p_seed, case p_kind when 'cad' then '7' else '8' end), 64),
    repeat(coalesce(p_seed, case p_kind when 'cad' then '7' else '8' end), 64)
  );
$$;

select pg_temp.ovd979_add_trusted_file('00000000-0000-4000-8000-0000009795a1', '00000000-0000-4000-8000-0000009795a0', 'cad');
select pg_temp.ovd979_add_trusted_file('00000000-0000-4000-8000-0000009795a2', '00000000-0000-4000-8000-0000009795a0', 'drawing');
select pg_temp.ovd979_add_trusted_file('00000000-0000-4000-8000-0000009795b1', '00000000-0000-4000-8000-0000009795b0', 'cad');
select pg_temp.ovd979_add_trusted_file('00000000-0000-4000-8000-0000009795c1', '00000000-0000-4000-8000-0000009795c0', 'cad');
select pg_temp.ovd979_add_trusted_file('00000000-0000-4000-8000-0000009795c2', '00000000-0000-4000-8000-0000009795c0', 'drawing');
select pg_temp.ovd979_add_trusted_file('00000000-0000-4000-8000-0000009795d1', '00000000-0000-4000-8000-0000009795d0', 'cad', '6');
select pg_temp.ovd979_add_trusted_file('00000000-0000-4000-8000-0000009795e1', '00000000-0000-4000-8000-0000009795e0', 'cad', '6');

insert into public.parts (id, job_id, organization_id, name, normalized_key, cad_file_id, drawing_file_id)
values
  ('00000000-0000-4000-8000-0000009795d3', '00000000-0000-4000-8000-0000009795d0', '00000000-0000-4000-8000-000000979001',
    'ovd979-bracket', 'ovd979-bracket', '00000000-0000-4000-8000-0000009795d1', null),
  ('00000000-0000-4000-8000-0000009795e3', '00000000-0000-4000-8000-0000009795e0', '00000000-0000-4000-8000-000000979001',
    'ovd979-bracket', 'ovd979-bracket', '00000000-0000-4000-8000-0000009795e1', null),
  ('00000000-0000-4000-8000-0000009795a3', '00000000-0000-4000-8000-0000009795a0', '00000000-0000-4000-8000-000000979001',
    'ovd979-bracket', 'ovd979-bracket', '00000000-0000-4000-8000-0000009795a1', '00000000-0000-4000-8000-0000009795a2'),
  ('00000000-0000-4000-8000-0000009795b3', '00000000-0000-4000-8000-0000009795b0', '00000000-0000-4000-8000-000000979001',
    'ovd979-bracket', 'ovd979-bracket', '00000000-0000-4000-8000-0000009795b1', null),
  ('00000000-0000-4000-8000-0000009795c3', '00000000-0000-4000-8000-0000009795c0', '00000000-0000-4000-8000-000000979001',
    'ovd979-bracket', 'ovd979-bracket', '00000000-0000-4000-8000-0000009795c1', '00000000-0000-4000-8000-0000009795c2');

insert into public.drawing_extractions (part_id, organization_id, extractor_version, extraction, status)
values
  ('00000000-0000-4000-8000-0000009795a3', '00000000-0000-4000-8000-000000979001', 'worker-pdf-v3',
    jsonb_build_object(
      'description', 'REUSED DESC', 'quoteDescription', 'REUSED DESC', 'partNumber', 'RE-PN', 'revision', 'Rre',
      'quoteFinish', 'REUSED FINISH', 'material', jsonb_build_object('normalized', 'Aluminum 6061-T6')),
    'approved'),
  ('00000000-0000-4000-8000-0000009795c3', '00000000-0000-4000-8000-000000979001', 'worker-pdf-v3',
    '{"marker": "own"}'::jsonb, 'approved'),
  ('00000000-0000-4000-8000-0000009795d3', '00000000-0000-4000-8000-000000979001', 'worker-pdf-v3',
    '{"marker": "source"}'::jsonb, 'approved'),
  ('00000000-0000-4000-8000-0000009795e3', '00000000-0000-4000-8000-000000979001', 'worker-sim-v1',
    '{"marker": "cad-only"}'::jsonb, 'approved');

-- The two reuse sources were extracted by worker tasks that completed (every
-- extraction row is written under an extract_part task; the reuse trusts a
-- source row only when that task completed, review r11).
insert into public.work_queue (organization_id, job_id, part_id, task_type, status, payload)
values
  ('00000000-0000-4000-8000-000000979001', '00000000-0000-4000-8000-0000009795a0', '00000000-0000-4000-8000-0000009795a3',
    'extract_part', 'completed', '{}'::jsonb),
  ('00000000-0000-4000-8000-000000979001', '00000000-0000-4000-8000-0000009795d0', '00000000-0000-4000-8000-0000009795d3',
    'extract_part', 'completed', '{}'::jsonb);

-- T: extracted CAD-only first (the worker writes worker-sim-v1 when no drawing
-- is staged), then the drawing is attached.
set local role authenticated;
select pg_temp.ovd979_as_owner();
select public.api_request_extraction('00000000-0000-4000-8000-0000009795b0');
reset role;
select pg_temp.ovd979_worker_completes(
  '00000000-0000-4000-8000-0000009795b0', '00000000-0000-4000-8000-0000009795b3', 'worker-sim-v1', 'cad', 1
);
select pg_temp.ovd979_add_trusted_file('00000000-0000-4000-8000-0000009795b2', '00000000-0000-4000-8000-0000009795b0', 'drawing');

set local role authenticated;
select pg_temp.ovd979_as_owner();
select is(
  public.api_request_extraction('00000000-0000-4000-8000-0000009795b0'), 1,
  'RU0 attaching a drawing to a CAD-only extracted part queues one extraction'
);
reset role;

-- The worker's reuse path, as handleExtractTask runs it: claim the task, resolve
-- the intake, reuse the source version's artifacts, auto-approve while the task
-- is still running, then mark it completed. The claim is a transaction of its
-- own that commits before the reuse runs; with the one clock of this test it is
-- dated a minute earlier, so the row the reuse writes during the claim is newer
-- than the claim, as in production (fix round 7: per-claim completion evidence).
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
update public.work_queue
set status = 'running', locked_at = timezone('utc', now()) - interval '1 minute', locked_by = 'ovd979-test', attempts = attempts + 1
where part_id = '00000000-0000-4000-8000-0000009795b3' and task_type = 'extract_part' and status = 'queued';
select is(
  (select array[
      public.api_resolve_trusted_part_intake('00000000-0000-4000-8000-0000009795b3') ->> 'result',
      public.api_reuse_trusted_part_version_artifacts(
        '00000000-0000-4000-8000-0000009795b3', '00000000-0000-4000-8000-0000009795a3',
        (select part_version_id from public.parts where id = '00000000-0000-4000-8000-0000009795b3')
      ) ->> 'artifactsReady']),
  array['existing_version', 'true'],
  'RU1 the attached package matches an existing version, so the worker reuses its artifacts'
);
-- Fix round 7: the row RU5's target keeps was stored before this claim (an
-- earlier, failed attempt); with the one clock of this test it is aged
-- explicitly, so RU5b can see the reuse stamp it during the claim.
alter table public.drawing_extractions disable trigger touch_drawing_extractions_updated_at;
update public.drawing_extractions set updated_at = timezone('utc', now()) - interval '1 hour'
where part_id = '00000000-0000-4000-8000-0000009795c3';
alter table public.drawing_extractions enable trigger touch_drawing_extractions_updated_at;
select public.api_reuse_trusted_part_version_artifacts(
  '00000000-0000-4000-8000-0000009795c3', '00000000-0000-4000-8000-0000009795a3',
  (select part_version_id from public.parts where id = '00000000-0000-4000-8000-0000009795c3')
);
select public.api_reuse_trusted_part_version_artifacts(
  '00000000-0000-4000-8000-0000009795e3', '00000000-0000-4000-8000-0000009795d3',
  (select part_version_id from public.parts where id = '00000000-0000-4000-8000-0000009795e3')
);

select is(
  (select array[extractor_version, extraction ->> 'description']
   from public.drawing_extractions where part_id = '00000000-0000-4000-8000-0000009795b3'),
  array['worker-pdf-v3', 'REUSED DESC'],
  'RU2 reuse replaces the CAD-only extraction of the part the drawing was attached to'
);

-- The test transaction has one clock. In production the requirement was written
-- minutes before the reuse, so age it to let the reused extraction count as newer.
alter table public.approved_part_requirements disable trigger touch_approved_part_requirements_updated_at;
update public.approved_part_requirements
set updated_at = timezone('utc', now()) - interval '1 hour'
where part_id = '00000000-0000-4000-8000-0000009795b3';
alter table public.approved_part_requirements enable trigger touch_approved_part_requirements_updated_at;
select public.api_auto_approve_job_requirements('00000000-0000-4000-8000-0000009795b0');

select is(
  (select array[description, part_number, revision]
   from public.approved_part_requirements where part_id = '00000000-0000-4000-8000-0000009795b3'),
  array['REUSED DESC', 'RE-PN', 'Rre'],
  'RU3 auto-approval after the reuse fills the auto fields from the drawing extraction'
);

-- The reuse path calls auto-approval before the task is completed, like the
-- extraction path (Codex 1): the job is rolled up while the task still runs.
select is(
  (select status::text from public.jobs where id = '00000000-0000-4000-8000-0000009795b0'),
  'ready_to_quote',
  'RU3b (Codex 1) the job is rolled up to ready_to_quote by the auto-approval that runs before the reuse task is completed'
);
update public.work_queue
set status = 'completed', locked_at = null, locked_by = null,
    payload = payload || jsonb_build_object(
      'reusedCanonicalPartVersion', true, 'sourcePartId', '00000000-0000-4000-8000-0000009795a3')
where part_id = '00000000-0000-4000-8000-0000009795b3' and task_type = 'extract_part' and status = 'running';

set local role authenticated;
select pg_temp.ovd979_as_owner();
select is(
  public.api_request_extraction('00000000-0000-4000-8000-0000009795b0'), 0,
  'RU4 nothing is queued again once the reused extraction is in place'
);
reset role;

select is(
  (select array[extractor_version, extraction ->> 'marker']
   from public.drawing_extractions where part_id = '00000000-0000-4000-8000-0000009795c3'),
  array['worker-pdf-v3', 'own'],
  'RU5 reuse keeps an extraction the part already holds when it is not a CAD-only row'
);
select ok(
  (select updated_at = timezone('utc', now())
   from public.drawing_extractions where part_id = '00000000-0000-4000-8000-0000009795c3'),
  'RU5b (fix round 7) and stamps the kept row, so the auto-approval of the same claim sees a result written during the claim'
);

select is(
  (select array[extractor_version, extraction ->> 'marker']
   from public.drawing_extractions where part_id = '00000000-0000-4000-8000-0000009795e3'),
  array['worker-sim-v1', 'cad-only'],
  'RU6 reuse leaves the CAD-only extraction of a part that has no drawing alone'
);

-- ---------------------------------------------------------------- review r3: Codex 1 (job W) and Codex 2 (job Z)
-- W: a part extracted CAD-only on a job that is ready_to_quote, then a drawing
--    is attached. The roll-up is read at each step of the worker's run, in the
--    worker's order: queued, running with the extraction still CAD-only, running
--    with the drawing extraction stored (auto-approval is called here), and
--    completed.
-- Z: the same setup, then the drawing task fails and the user retries through
--    api_request_extraction three times: the retry is cancelled, fails again,
--    and succeeds. The job has a second part whose own extraction completes
--    after the first failure: another part's later task must not hide it.
insert into public.jobs (id, organization_id, created_by, title, status)
values
  ('00000000-0000-4000-8000-0000009796a0', '00000000-0000-4000-8000-000000979001', '00000000-0000-4000-8000-000000979011', 'OVD 979 W', 'uploaded'),
  ('00000000-0000-4000-8000-0000009797a0', '00000000-0000-4000-8000-000000979001', '00000000-0000-4000-8000-000000979011', 'OVD 979 Z', 'uploaded');

insert into public.job_files (
  id, job_id, organization_id, uploaded_by, storage_bucket, storage_path,
  original_name, normalized_name, file_kind
)
select file.id, file.job_id, '00000000-0000-4000-8000-000000979001', '00000000-0000-4000-8000-000000979011',
  'job-files', 'org/ovd979/' || file.id::text, 'bracket.step', 'ovd979-bracket', 'cad'::public.job_file_kind
from (values
  ('00000000-0000-4000-8000-0000009796a1'::uuid, '00000000-0000-4000-8000-0000009796a0'::uuid),
  ('00000000-0000-4000-8000-0000009797a1'::uuid, '00000000-0000-4000-8000-0000009797a0'::uuid)
) as file(id, job_id);
-- Z's second part: its own CAD file, never given a drawing.
insert into public.job_files (
  id, job_id, organization_id, uploaded_by, storage_bucket, storage_path,
  original_name, normalized_name, file_kind
) values (
  '00000000-0000-4000-8000-0000009797b1', '00000000-0000-4000-8000-0000009797a0', '00000000-0000-4000-8000-000000979001',
  '00000000-0000-4000-8000-000000979011', 'job-files', 'org/ovd979/second.step', 'second.step', 'ovd979-second', 'cad'
);

insert into public.parts (id, job_id, organization_id, name, normalized_key, cad_file_id, drawing_file_id)
values
  ('00000000-0000-4000-8000-0000009796a3', '00000000-0000-4000-8000-0000009796a0', '00000000-0000-4000-8000-000000979001',
    'ovd979-bracket', 'ovd979-bracket', '00000000-0000-4000-8000-0000009796a1', null),
  ('00000000-0000-4000-8000-0000009797a3', '00000000-0000-4000-8000-0000009797a0', '00000000-0000-4000-8000-000000979001',
    'ovd979-bracket', 'ovd979-bracket', '00000000-0000-4000-8000-0000009797a1', null),
  ('00000000-0000-4000-8000-0000009797b3', '00000000-0000-4000-8000-0000009797a0', '00000000-0000-4000-8000-000000979001',
    'ovd979-second', 'ovd979-second', '00000000-0000-4000-8000-0000009797b1', null);

set local role authenticated;
select pg_temp.ovd979_as_owner();
select public.api_request_extraction(job_id)
from unnest(array['00000000-0000-4000-8000-0000009796a0', '00000000-0000-4000-8000-0000009797a0']::uuid[]) job_id;
reset role;
select pg_temp.ovd979_worker_completes(
  '00000000-0000-4000-8000-0000009796a0', '00000000-0000-4000-8000-0000009796a3', 'worker-sim-v1', 'cad', 1
);
select pg_temp.ovd979_worker_completes(
  '00000000-0000-4000-8000-0000009797a0', '00000000-0000-4000-8000-0000009797a3', 'worker-sim-v1', 'cad', 1
);
select pg_temp.ovd979_worker_completes(
  '00000000-0000-4000-8000-0000009797a0', '00000000-0000-4000-8000-0000009797b3', 'worker-sim-v1', 'cad2', 1
);
-- Ready to quote when the drawing arrives (see job B).
update public.jobs set status = 'ready_to_quote'
where id in ('00000000-0000-4000-8000-0000009796a0', '00000000-0000-4000-8000-0000009797a0');

insert into public.job_files (
  id, job_id, organization_id, uploaded_by, storage_bucket, storage_path,
  original_name, normalized_name, file_kind
)
select file.id, file.job_id, '00000000-0000-4000-8000-000000979001', '00000000-0000-4000-8000-000000979011',
  'job-files', 'org/ovd979/' || file.id::text, 'bracket.pdf', 'ovd979-bracket', 'drawing'::public.job_file_kind
from (values
  ('00000000-0000-4000-8000-0000009796a2'::uuid, '00000000-0000-4000-8000-0000009796a0'::uuid),
  ('00000000-0000-4000-8000-0000009797a2'::uuid, '00000000-0000-4000-8000-0000009797a0'::uuid)
) as file(id, job_id);

set local role authenticated;
select pg_temp.ovd979_as_owner();
select public.api_request_extraction(job_id)
from unnest(array['00000000-0000-4000-8000-0000009796a0', '00000000-0000-4000-8000-0000009797a0']::uuid[]) job_id;
reset role;

-- W: the drawing task is queued.
select public.api_auto_approve_job_requirements('00000000-0000-4000-8000-0000009796a0');
select is(
  (select status::text from public.jobs where id = '00000000-0000-4000-8000-0000009796a0'),
  'extracting',
  'W1 a queued drawing task still counts as pending'
);

-- The worker claims it. Its extraction is still the CAD-only row, and another
-- part's run (or the same job's) calls auto-approval in the meantime.
update public.work_queue
set status = 'running', locked_at = timezone('utc', now()), locked_by = 'ovd979-test', attempts = attempts + 1
where part_id = '00000000-0000-4000-8000-0000009796a3' and task_type = 'extract_part' and status = 'queued';
select public.api_auto_approve_job_requirements('00000000-0000-4000-8000-0000009796a0');
select is(
  (select status::text from public.jobs where id = '00000000-0000-4000-8000-0000009796a0'),
  'extracting',
  'W2 a running drawing task whose extraction is still the CAD-only row still counts as pending'
);

-- The worker stores the drawing extraction and calls auto-approval; the task is
-- not completed yet.
select pg_temp.ovd979_worker_completes(
  '00000000-0000-4000-8000-0000009796a0', '00000000-0000-4000-8000-0000009796a3', 'worker-pdf-v3', 'dwg', 3,
  '{}'::jsonb, '{}'::text[], false
);
select is(
  array[(select status::text from public.jobs where id = '00000000-0000-4000-8000-0000009796a0'),
        (select status::text from public.work_queue
         where part_id = '00000000-0000-4000-8000-0000009796a3' and payload ->> 'reason' = 'drawing_attached')],
  array['ready_to_quote', 'running'],
  'W3 (Codex 1) the drawing task the worker is finishing no longer keeps the job extracting'
);

update public.work_queue set status = 'completed', locked_at = null, locked_by = null
where part_id = '00000000-0000-4000-8000-0000009796a3' and task_type = 'extract_part' and status = 'running';
select public.api_auto_approve_job_requirements('00000000-0000-4000-8000-0000009796a0');
select is(
  (select status::text from public.jobs where id = '00000000-0000-4000-8000-0000009796a0'),
  'ready_to_quote',
  'W4 the job is still ready_to_quote after the task is completed and a later auto-approval ran'
);

-- The worker crashes after storing the extraction and the task is requeued: it
-- is queued again, so the job is extracting until it runs.
update public.work_queue set status = 'queued'
where part_id = '00000000-0000-4000-8000-0000009796a3' and task_type = 'extract_part' and payload ->> 'reason' = 'drawing_attached';
select public.api_auto_approve_job_requirements('00000000-0000-4000-8000-0000009796a0');
select is(
  (select status::text from public.jobs where id = '00000000-0000-4000-8000-0000009796a0'),
  'extracting',
  'W5 a queued drawing task counts as pending even though its extraction is already stored'
);

-- Z: the drawing task fails.
select pg_temp.ovd979_worker_fails('00000000-0000-4000-8000-0000009797a3');
select pg_temp.ovd979_age_tasks('00000000-0000-4000-8000-0000009797a3');
-- Retry 1 is queued, then cancelled: a cancelled task does not hide the failure.
set local role authenticated;
select pg_temp.ovd979_as_owner();
select public.api_request_extraction('00000000-0000-4000-8000-0000009797a0');
reset role;
update public.work_queue set status = 'cancelled'
where part_id = '00000000-0000-4000-8000-0000009797a3' and task_type = 'extract_part' and status = 'queued';
select public.api_auto_approve_job_requirements('00000000-0000-4000-8000-0000009797a0');
select is(
  (select status::text from public.jobs where id = '00000000-0000-4000-8000-0000009797a0'),
  'needs_spec_review',
  'Z1 (Codex 2) a failure followed only by a cancelled retry, and by another part''s later task, still counts'
);

-- Retry 2 fails too: a failed retry does not hide the failure either.
select pg_temp.ovd979_age_tasks('00000000-0000-4000-8000-0000009797a3');
set local role authenticated;
select pg_temp.ovd979_as_owner();
select public.api_request_extraction('00000000-0000-4000-8000-0000009797a0');
reset role;
select pg_temp.ovd979_worker_fails('00000000-0000-4000-8000-0000009797a3');
select public.api_auto_approve_job_requirements('00000000-0000-4000-8000-0000009797a0');
select is(
  (select status::text from public.jobs where id = '00000000-0000-4000-8000-0000009797a0'),
  'needs_spec_review',
  'Z2 (Codex 2) a failed retry leaves the job in needs_spec_review'
);
select is(
  (select max((payload ->> 'failedExtractTasks')::integer) from public.audit_events
   where job_id = '00000000-0000-4000-8000-0000009797a0' and event_type = 'job.requirements_auto_approved'),
  2,
  'Z2b both failed tasks are counted: a failure replaced only by another failure is not hidden'
);

-- Retry 3 succeeds, under the worker's order: one later success replaces every
-- earlier failure, and all four tasks stay on record.
select pg_temp.ovd979_age_tasks('00000000-0000-4000-8000-0000009797a3');
set local role authenticated;
select pg_temp.ovd979_as_owner();
select public.api_request_extraction('00000000-0000-4000-8000-0000009797a0');
reset role;
select pg_temp.ovd979_worker_completes(
  '00000000-0000-4000-8000-0000009797a0', '00000000-0000-4000-8000-0000009797a3', 'worker-pdf-v3', 'dwg', 3
);
select is(
  array[(select status::text from public.jobs where id = '00000000-0000-4000-8000-0000009797a0')]
    || pg_temp.ovd979_attach_statuses('00000000-0000-4000-8000-0000009797a3'),
  array['ready_to_quote', 'failed', 'cancelled', 'failed', 'completed'],
  'Z3 (Codex 2) a successful retry rolls the job up to ready_to_quote although the earlier failures are kept'
);
-- Another part's extraction runs auto-approval later, with the retry completed.
select public.api_auto_approve_job_requirements('00000000-0000-4000-8000-0000009797a0');
select is(
  (select status::text from public.jobs where id = '00000000-0000-4000-8000-0000009797a0'),
  'ready_to_quote',
  'Z4 (Codex 2) a later auto-approval run keeps ready_to_quote: the completed retry still replaces the failures'
);

-- ---------------------------------------------------------------- review r6 (Codex): a failure after the extraction was stored
-- The worker writes the drawing extraction row (extractor_version
-- 'worker-pdf-v3', no longer CAD-only) BEFORE it persists the drawing previews and
-- before it calls auto-approval (worker/src/index.ts, handleExtractTask), and an
-- error at either step ends the task 'failed' (markTaskFailed merges the payload,
-- so reason and drawingFileId stay on the row). The CAD-only test alone then
-- never matched the part again: api_request_extraction returned 0 and the
-- approval and previews never finished.
-- PP: a drawing is attached to a CAD-only part on a ready_to_quote job; the
--     first run stores its extraction and fails before auto-approval; the retry
--     is claimed, stores the extraction and is cancelled; the second retry
--     succeeds in the worker's order.
-- PV: the failed attach task names a drawing that is not the part's current
--     drawing.
-- PC: the attach task stores its extraction and is cancelled; none failed.
insert into public.jobs (id, organization_id, created_by, title, status)
values
  ('00000000-0000-4000-8000-0000009798a0', '00000000-0000-4000-8000-000000979001', '00000000-0000-4000-8000-000000979011', 'OVD 979 PP', 'uploaded'),
  ('00000000-0000-4000-8000-0000009799a0', '00000000-0000-4000-8000-000000979001', '00000000-0000-4000-8000-000000979011', 'OVD 979 PV', 'uploaded'),
  ('00000000-0000-4000-8000-000000979aa0', '00000000-0000-4000-8000-000000979001', '00000000-0000-4000-8000-000000979011', 'OVD 979 PC', 'uploaded');

insert into public.job_files (
  id, job_id, organization_id, uploaded_by, storage_bucket, storage_path,
  original_name, normalized_name, file_kind
)
select file.id, file.job_id, '00000000-0000-4000-8000-000000979001', '00000000-0000-4000-8000-000000979011',
  'job-files', 'org/ovd979/' || file.id::text, 'bracket.step', 'ovd979-bracket', 'cad'::public.job_file_kind
from (values
  ('00000000-0000-4000-8000-0000009798a1'::uuid, '00000000-0000-4000-8000-0000009798a0'::uuid),
  ('00000000-0000-4000-8000-0000009799a1'::uuid, '00000000-0000-4000-8000-0000009799a0'::uuid),
  ('00000000-0000-4000-8000-000000979aa1'::uuid, '00000000-0000-4000-8000-000000979aa0'::uuid)
) as file(id, job_id);

insert into public.parts (id, job_id, organization_id, name, normalized_key, cad_file_id, drawing_file_id)
values
  ('00000000-0000-4000-8000-0000009798a3', '00000000-0000-4000-8000-0000009798a0', '00000000-0000-4000-8000-000000979001',
    'ovd979-bracket', 'ovd979-bracket', '00000000-0000-4000-8000-0000009798a1', null),
  ('00000000-0000-4000-8000-0000009799a3', '00000000-0000-4000-8000-0000009799a0', '00000000-0000-4000-8000-000000979001',
    'ovd979-bracket', 'ovd979-bracket', '00000000-0000-4000-8000-0000009799a1', null),
  ('00000000-0000-4000-8000-000000979aa3', '00000000-0000-4000-8000-000000979aa0', '00000000-0000-4000-8000-000000979001',
    'ovd979-bracket', 'ovd979-bracket', '00000000-0000-4000-8000-000000979aa1', null);

set local role authenticated;
select pg_temp.ovd979_as_owner();
select public.api_request_extraction(job_id)
from unnest(array['00000000-0000-4000-8000-0000009798a0', '00000000-0000-4000-8000-0000009799a0',
                  '00000000-0000-4000-8000-000000979aa0']::uuid[]) job_id;
reset role;
select pg_temp.ovd979_worker_completes(job_id, part_id, 'worker-sim-v1', 'cad', 1)
from (values
  ('00000000-0000-4000-8000-0000009798a0'::uuid, '00000000-0000-4000-8000-0000009798a3'::uuid),
  ('00000000-0000-4000-8000-0000009799a0'::uuid, '00000000-0000-4000-8000-0000009799a3'::uuid),
  ('00000000-0000-4000-8000-000000979aa0'::uuid, '00000000-0000-4000-8000-000000979aa3'::uuid)
) as v(job_id, part_id);
-- Ready to quote when the drawing arrives (see job B).
update public.jobs set status = 'ready_to_quote'
where id in ('00000000-0000-4000-8000-0000009798a0', '00000000-0000-4000-8000-0000009799a0',
             '00000000-0000-4000-8000-000000979aa0');

insert into public.job_files (
  id, job_id, organization_id, uploaded_by, storage_bucket, storage_path,
  original_name, normalized_name, file_kind
)
select file.id, file.job_id, '00000000-0000-4000-8000-000000979001', '00000000-0000-4000-8000-000000979011',
  'job-files', 'org/ovd979/' || file.id::text, 'bracket.pdf', 'ovd979-bracket', 'drawing'::public.job_file_kind
from (values
  ('00000000-0000-4000-8000-0000009798a2'::uuid, '00000000-0000-4000-8000-0000009798a0'::uuid),
  ('00000000-0000-4000-8000-0000009799a2'::uuid, '00000000-0000-4000-8000-0000009799a0'::uuid),
  ('00000000-0000-4000-8000-000000979aa2'::uuid, '00000000-0000-4000-8000-000000979aa0'::uuid)
) as file(id, job_id);

set local role authenticated;
select pg_temp.ovd979_as_owner();
select public.api_request_extraction(job_id)
from unnest(array['00000000-0000-4000-8000-0000009798a0', '00000000-0000-4000-8000-0000009799a0',
                  '00000000-0000-4000-8000-000000979aa0']::uuid[]) job_id;
reset role;

-- First run: the worker claims the attach task and stores the drawing extraction,
-- then the preview upload fails before auto-approval, and the task is marked failed.
select pg_temp.ovd979_worker_completes(
  '00000000-0000-4000-8000-0000009798a0', '00000000-0000-4000-8000-0000009798a3', 'worker-pdf-v3', 'dwg1', 3,
  '{}'::jsonb, '{}'::text[], false, false
);
select pg_temp.ovd979_worker_fails('00000000-0000-4000-8000-0000009798a3');
select is(
  array[
    (select extractor_version from public.drawing_extractions where part_id = '00000000-0000-4000-8000-0000009798a3'),
    (select description from public.approved_part_requirements where part_id = '00000000-0000-4000-8000-0000009798a3'),
    (select status::text from public.jobs where id = '00000000-0000-4000-8000-0000009798a0')
  ] || pg_temp.ovd979_attach_statuses('00000000-0000-4000-8000-0000009798a3'),
  array['worker-pdf-v3', 'EXTRACTED DESC cad', 'extracting', 'failed'],
  'PP0 the failed attach task left a stored drawing extraction, the CAD-only requirement and a job still extracting'
);

-- A retry is queued for the failed task although its extraction is no longer CAD-only.
select pg_temp.ovd979_age_tasks('00000000-0000-4000-8000-0000009798a3');
set local role authenticated;
select pg_temp.ovd979_as_owner();
select is(
  public.api_request_extraction('00000000-0000-4000-8000-0000009798a0'), 1,
  'PP1 (Codex) a drawing attach that failed after storing its extraction is queued again'
);
select is(
  public.api_request_extraction('00000000-0000-4000-8000-0000009798a0'), 0,
  'PP1b a second call does not queue a duplicate while the retry is queued'
);
reset role;
select is(
  pg_temp.ovd979_attach_statuses('00000000-0000-4000-8000-0000009798a3'),
  array['failed', 'queued'],
  'PP2 the failed task is kept next to the retry'
);
select is(
  (select count(*)::integer from public.work_queue
   where part_id = '00000000-0000-4000-8000-0000009798a3' and task_type = 'extract_part'
     and status = 'queued' and payload ->> 'reason' = 'drawing_attached'
     and payload ->> 'drawingFileId' = '00000000-0000-4000-8000-0000009798a2'),
  1,
  'PP2b the retry names the attached drawing, so one success ends the retries'
);
select is(
  (select status::text from public.jobs where id = '00000000-0000-4000-8000-0000009798a0'),
  'extracting',
  'PP3 the job is extracting while the retry is queued'
);

-- The retry is claimed and stores the extraction again, then is cancelled
-- (settled elsewhere before the worker completes it): it is retried as well.
select pg_temp.ovd979_worker_completes(
  '00000000-0000-4000-8000-0000009798a0', '00000000-0000-4000-8000-0000009798a3', 'worker-pdf-v3', 'dwg2', 4,
  '{}'::jsonb, '{}'::text[], false, false
);
update public.work_queue set status = 'cancelled', locked_at = null, locked_by = null
where part_id = '00000000-0000-4000-8000-0000009798a3' and task_type = 'extract_part' and status = 'running';
select pg_temp.ovd979_age_tasks('00000000-0000-4000-8000-0000009798a3');
set local role authenticated;
select pg_temp.ovd979_as_owner();
select is(
  public.api_request_extraction('00000000-0000-4000-8000-0000009798a0'), 1,
  'PP4 a cancelled attach retry that had stored its extraction is queued again'
);
reset role;

-- The second retry succeeds in the worker's order: the extraction is stored, the
-- approval finishes while the task is running, then the task is completed.
select pg_temp.ovd979_worker_completes(
  '00000000-0000-4000-8000-0000009798a0', '00000000-0000-4000-8000-0000009798a3', 'worker-pdf-v3', 'dwg3', 5
);
select is(
  array[
    (select description from public.approved_part_requirements where part_id = '00000000-0000-4000-8000-0000009798a3'),
    (select status::text from public.jobs where id = '00000000-0000-4000-8000-0000009798a0')
  ],
  array['EXTRACTED DESC dwg3', 'ready_to_quote'],
  'PP5 the retry finishes the approval from the drawing and rolls the job up to ready_to_quote'
);
select is(
  pg_temp.ovd979_attach_statuses('00000000-0000-4000-8000-0000009798a3'),
  array['failed', 'cancelled', 'completed'],
  'PP5b the failed and cancelled tasks stay on record next to the completed one'
);

-- A part whose attach task succeeded is never queued again, whatever failed before it.
set local role authenticated;
select pg_temp.ovd979_as_owner();
select is(
  public.api_request_extraction('00000000-0000-4000-8000-0000009798a0'), 0,
  'PP6 once the attach task for the drawing completed, earlier failed and cancelled tasks queue nothing'
);

-- PV: a failure that names a drawing other than the part's current one does not count.
reset role;
select pg_temp.ovd979_worker_completes(
  '00000000-0000-4000-8000-0000009799a0', '00000000-0000-4000-8000-0000009799a3', 'worker-pdf-v3', 'dwg1', 3,
  '{}'::jsonb, '{}'::text[], false, false
);
select pg_temp.ovd979_worker_fails('00000000-0000-4000-8000-0000009799a3');
update public.work_queue
set payload = jsonb_set(payload, '{drawingFileId}', to_jsonb('00000000-0000-4000-8000-0000009799ff'::text))
where part_id = '00000000-0000-4000-8000-0000009799a3' and task_type = 'extract_part' and status = 'failed';
select pg_temp.ovd979_age_tasks('00000000-0000-4000-8000-0000009799a3');
set local role authenticated;
select pg_temp.ovd979_as_owner();
select is(
  public.api_request_extraction('00000000-0000-4000-8000-0000009799a0'), 0,
  'PV1 a failed attach task for another drawing does not queue the part again'
);
reset role;

-- PC: the worker stored the extraction and the task was cancelled; no task failed.
select pg_temp.ovd979_worker_completes(
  '00000000-0000-4000-8000-000000979aa0', '00000000-0000-4000-8000-000000979aa3', 'worker-pdf-v3', 'dwg1', 3,
  '{}'::jsonb, '{}'::text[], false, false
);
update public.work_queue set status = 'cancelled', locked_at = null, locked_by = null
where part_id = '00000000-0000-4000-8000-000000979aa3' and task_type = 'extract_part' and status = 'running';
select pg_temp.ovd979_age_tasks('00000000-0000-4000-8000-000000979aa3');
set local role authenticated;
select pg_temp.ovd979_as_owner();
select is(
  public.api_request_extraction('00000000-0000-4000-8000-000000979aa0'), 1,
  'PC1 an attach task that was cancelled after storing its extraction, with no failure on record, is queued again'
);
reset role;

-- ---------------------------------------------------------------- review r10 (Codex): reuse of a CAD-only source
-- The worker assigns the canonical version before it extracts
-- (api_resolve_trusted_part_intake, then runDrawingExtractionForTask), so a
-- source placement whose attach task failed before it stored anything owns a
-- complete version and still holds the CAD-only extraction it got before its
-- drawing existed. Another placement of the same package resolves to that
-- version, and the reuse copied the CAD-only row over the target's own CAD-only
-- row: the target's attach task completed with no drawing data and, with the
-- completed-task guard, was never extracted from its drawing.
-- K: the source placement (CAD, then the drawing attached; the attach task is
--    claimed, resolves its version and fails before it stores anything).
-- L: the same package, extracted CAD-only first, then the drawing attached.
-- M: the same package uploaded with its drawing, no extraction row yet.
-- Q: the same package that already stores its own drawing extraction (a retry
--    after a failure that came after the extraction was stored).
-- N, O: a CAD-only package (no drawing anywhere) whose source row is CAD-only.
insert into public.jobs (id, organization_id, created_by, title, status)
values
  ('00000000-0000-4000-8000-000000979ba0', '00000000-0000-4000-8000-000000979001', '00000000-0000-4000-8000-000000979011', 'OVD 979 K', 'uploaded'),
  ('00000000-0000-4000-8000-000000979bb0', '00000000-0000-4000-8000-000000979001', '00000000-0000-4000-8000-000000979011', 'OVD 979 L', 'uploaded'),
  ('00000000-0000-4000-8000-000000979bc0', '00000000-0000-4000-8000-000000979001', '00000000-0000-4000-8000-000000979011', 'OVD 979 M', 'uploaded'),
  ('00000000-0000-4000-8000-000000979bd0', '00000000-0000-4000-8000-000000979001', '00000000-0000-4000-8000-000000979011', 'OVD 979 Q', 'uploaded'),
  ('00000000-0000-4000-8000-000000979be0', '00000000-0000-4000-8000-000000979001', '00000000-0000-4000-8000-000000979011', 'OVD 979 N', 'uploaded'),
  ('00000000-0000-4000-8000-000000979bf0', '00000000-0000-4000-8000-000000979001', '00000000-0000-4000-8000-000000979011', 'OVD 979 O', 'uploaded');

create temp table ovd979_steps (name text primary key, body jsonb);

-- The worker's reuse step (handleExtractTask): resolve the intake, then reuse
-- the artifacts of the source version it names.
create function pg_temp.ovd979_reuse_step(p_part uuid) returns jsonb language plpgsql as $$
declare
  v_intake jsonb;
begin
  v_intake := public.api_resolve_trusted_part_intake(p_part);
  return jsonb_build_object(
    'result', v_intake ->> 'result',
    'source', v_intake ->> 'sourcePartId',
    'reuse', public.api_reuse_trusted_part_version_artifacts(
      p_part, (v_intake ->> 'sourcePartId')::uuid, (v_intake ->> 'partVersionId')::uuid)
  );
end;
$$;

select pg_temp.ovd979_add_trusted_file('00000000-0000-4000-8000-000000979ba1', '00000000-0000-4000-8000-000000979ba0', 'cad', '4');
select pg_temp.ovd979_add_trusted_file('00000000-0000-4000-8000-000000979bb1', '00000000-0000-4000-8000-000000979bb0', 'cad', '4');
select pg_temp.ovd979_add_trusted_file('00000000-0000-4000-8000-000000979be1', '00000000-0000-4000-8000-000000979be0', 'cad', '2');
select pg_temp.ovd979_add_trusted_file('00000000-0000-4000-8000-000000979bf1', '00000000-0000-4000-8000-000000979bf0', 'cad', '2');

insert into public.parts (id, job_id, organization_id, name, normalized_key, cad_file_id, drawing_file_id)
values
  ('00000000-0000-4000-8000-000000979ba3', '00000000-0000-4000-8000-000000979ba0', '00000000-0000-4000-8000-000000979001',
    'ovd979-bracket', 'ovd979-bracket', '00000000-0000-4000-8000-000000979ba1', null),
  ('00000000-0000-4000-8000-000000979bb3', '00000000-0000-4000-8000-000000979bb0', '00000000-0000-4000-8000-000000979001',
    'ovd979-bracket', 'ovd979-bracket', '00000000-0000-4000-8000-000000979bb1', null),
  ('00000000-0000-4000-8000-000000979be3', '00000000-0000-4000-8000-000000979be0', '00000000-0000-4000-8000-000000979001',
    'ovd979-bracket', 'ovd979-bracket', '00000000-0000-4000-8000-000000979be1', null),
  ('00000000-0000-4000-8000-000000979bf3', '00000000-0000-4000-8000-000000979bf0', '00000000-0000-4000-8000-000000979001',
    'ovd979-bracket', 'ovd979-bracket', '00000000-0000-4000-8000-000000979bf1', null);

insert into public.drawing_extractions (part_id, organization_id, extractor_version, extraction, status)
values ('00000000-0000-4000-8000-000000979be3', '00000000-0000-4000-8000-000000979001', 'worker-sim-v1',
  '{"marker": "cad-package-source"}'::jsonb, 'approved');
-- N's CAD-only row was written by a task that completed (review r11).
insert into public.work_queue (organization_id, job_id, part_id, task_type, status, payload)
values ('00000000-0000-4000-8000-000000979001', '00000000-0000-4000-8000-000000979be0', '00000000-0000-4000-8000-000000979be3',
  'extract_part', 'completed', '{}'::jsonb);

-- K and L are extracted CAD-only first (the worker writes worker-sim-v1 when no
-- drawing is staged).
set local role authenticated;
select pg_temp.ovd979_as_owner();
select public.api_request_extraction('00000000-0000-4000-8000-000000979ba0');
select public.api_request_extraction('00000000-0000-4000-8000-000000979bb0');
reset role;
select pg_temp.ovd979_worker_completes(
  '00000000-0000-4000-8000-000000979ba0', '00000000-0000-4000-8000-000000979ba3', 'worker-sim-v1', 'cad', 1,
  '{"marker": "source-cad-only"}'::jsonb
);
select pg_temp.ovd979_worker_completes(
  '00000000-0000-4000-8000-000000979bb0', '00000000-0000-4000-8000-000000979bb3', 'worker-sim-v1', 'cad', 1,
  '{"marker": "target-cad-only"}'::jsonb
);

-- The drawing is attached to K first (so K owns the version of the full
-- package), then to L.
select pg_temp.ovd979_add_trusted_file('00000000-0000-4000-8000-000000979ba2', '00000000-0000-4000-8000-000000979ba0', 'drawing', '3');
select pg_temp.ovd979_add_trusted_file('00000000-0000-4000-8000-000000979bb2', '00000000-0000-4000-8000-000000979bb0', 'drawing', '3');
set local role authenticated;
select pg_temp.ovd979_as_owner();
select public.api_request_extraction('00000000-0000-4000-8000-000000979ba0');
select public.api_request_extraction('00000000-0000-4000-8000-000000979bb0');
reset role;

-- K's attach task: claimed, resolves its canonical version, fails before the
-- worker has stored the drawing extraction.
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
update public.work_queue
set status = 'running', locked_at = timezone('utc', now()), locked_by = 'ovd979-test', attempts = attempts + 1
where part_id = '00000000-0000-4000-8000-000000979ba3' and task_type = 'extract_part' and status = 'queued';
select public.api_resolve_trusted_part_intake('00000000-0000-4000-8000-000000979ba3');
select pg_temp.ovd979_worker_fails('00000000-0000-4000-8000-000000979ba3');

select is(
  array[
    (select extractor_version from public.drawing_extractions where part_id = '00000000-0000-4000-8000-000000979ba3'),
    (select version_state::text from public.part_versions
     where id = (select part_version_id from public.parts where id = '00000000-0000-4000-8000-000000979ba3')),
    (select (source_part_id = '00000000-0000-4000-8000-000000979ba3')::text from public.part_versions
     where id = (select part_version_id from public.parts where id = '00000000-0000-4000-8000-000000979ba3'))
  ] || pg_temp.ovd979_attach_statuses('00000000-0000-4000-8000-000000979ba3'),
  array['worker-sim-v1', 'complete', 'true', 'failed'],
  'CS0 the source''s attach task failed after its package took the canonical version: it still holds the CAD-only extraction'
);

-- L's attach task: claimed, and the worker asks for the existing version's artifacts.
update public.work_queue
set status = 'running', locked_at = timezone('utc', now()), locked_by = 'ovd979-test', attempts = attempts + 1
where part_id = '00000000-0000-4000-8000-000000979bb3' and task_type = 'extract_part' and status = 'queued';
insert into ovd979_steps values ('L', pg_temp.ovd979_reuse_step('00000000-0000-4000-8000-000000979bb3'));
select is(
  (select array[body ->> 'result', body ->> 'source', body #>> '{reuse,artifactsReady}', body #>> '{reuse,extractTargetIndependently}']
   from ovd979_steps where name = 'L'),
  array['existing_version', '00000000-0000-4000-8000-000000979ba3', 'false', 'true'],
  'CS1 (Codex) a CAD-only source row is not reused for a part that has a drawing: the worker extracts the target itself'
);
select is(
  (select array[extractor_version, extraction ->> 'marker']
   from public.drawing_extractions where part_id = '00000000-0000-4000-8000-000000979bb3'),
  array['worker-sim-v1', 'target-cad-only'],
  'CS2 the target keeps its own row: another CAD-only extraction does not replace it'
);

-- The worker then extracts the target from its drawing, in the worker's order.
select pg_temp.ovd979_worker_completes(
  '00000000-0000-4000-8000-000000979bb0', '00000000-0000-4000-8000-000000979bb3', 'worker-pdf-v3', 'own', 5,
  '{"marker": "own-drawing"}'::jsonb
);
select is(
  array[
    (select extractor_version from public.drawing_extractions where part_id = '00000000-0000-4000-8000-000000979bb3'),
    (select description from public.approved_part_requirements where part_id = '00000000-0000-4000-8000-000000979bb3'),
    (select status::text from public.jobs where id = '00000000-0000-4000-8000-000000979bb0')
  ],
  array['worker-pdf-v3', 'EXTRACTED DESC own', 'ready_to_quote'],
  'CS3 the target''s own extraction from its drawing finishes the approval and rolls the job up'
);
set local role authenticated;
select pg_temp.ovd979_as_owner();
select is(
  public.api_request_extraction('00000000-0000-4000-8000-000000979bb0'), 0,
  'CS3b the attach is done: nothing is queued again for the target'
);
reset role;

-- M: the same package uploaded with its drawing; Q: the same package with its
-- own drawing extraction already stored. Both are added now, so K still owns
-- the version.
select pg_temp.ovd979_add_trusted_file('00000000-0000-4000-8000-000000979bc1', '00000000-0000-4000-8000-000000979bc0', 'cad', '4');
select pg_temp.ovd979_add_trusted_file('00000000-0000-4000-8000-000000979bc2', '00000000-0000-4000-8000-000000979bc0', 'drawing', '3');
select pg_temp.ovd979_add_trusted_file('00000000-0000-4000-8000-000000979bd1', '00000000-0000-4000-8000-000000979bd0', 'cad', '4');
select pg_temp.ovd979_add_trusted_file('00000000-0000-4000-8000-000000979bd2', '00000000-0000-4000-8000-000000979bd0', 'drawing', '3');
insert into public.parts (id, job_id, organization_id, name, normalized_key, cad_file_id, drawing_file_id)
values
  ('00000000-0000-4000-8000-000000979bc3', '00000000-0000-4000-8000-000000979bc0', '00000000-0000-4000-8000-000000979001',
    'ovd979-bracket', 'ovd979-bracket', '00000000-0000-4000-8000-000000979bc1', '00000000-0000-4000-8000-000000979bc2'),
  ('00000000-0000-4000-8000-000000979bd3', '00000000-0000-4000-8000-000000979bd0', '00000000-0000-4000-8000-000000979001',
    'ovd979-bracket', 'ovd979-bracket', '00000000-0000-4000-8000-000000979bd1', '00000000-0000-4000-8000-000000979bd2');
insert into public.drawing_extractions (part_id, organization_id, extractor_version, extraction, status)
values ('00000000-0000-4000-8000-000000979bd3', '00000000-0000-4000-8000-000000979001', 'worker-pdf-v3',
  '{"marker": "own-drawing-row"}'::jsonb, 'approved');

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into ovd979_steps values
  ('M', pg_temp.ovd979_reuse_step('00000000-0000-4000-8000-000000979bc3')),
  ('Q', pg_temp.ovd979_reuse_step('00000000-0000-4000-8000-000000979bd3')),
  ('O', pg_temp.ovd979_reuse_step('00000000-0000-4000-8000-000000979bf3'));

select is(
  (select array[body ->> 'result', body #>> '{reuse,artifactsReady}', body #>> '{reuse,extractTargetIndependently}',
      (select count(*)::text from public.drawing_extractions where part_id = '00000000-0000-4000-8000-000000979bc3')]
   from ovd979_steps where name = 'M'),
  array['existing_version', 'false', 'true', '0'],
  'CS4 a part with a drawing and no extraction does not take a CAD-only source row either: nothing is copied'
);
select is(
  (select array[body #>> '{reuse,artifactsReady}', body #>> '{reuse,extractTargetIndependently}',
      (select extractor_version || '/' || (extraction ->> 'marker') from public.drawing_extractions
       where part_id = '00000000-0000-4000-8000-000000979bd3')]
   from ovd979_steps where name = 'Q'),
  array['false', 'true', 'worker-pdf-v3/own-drawing-row'],
  'CS5 a part that stored its own drawing extraction is extracted again rather than completed from a CAD-only source'
);
select is(
  (select array[body ->> 'result', body ->> 'source', body #>> '{reuse,artifactsReady}',
      (select extractor_version || '/' || (extraction ->> 'marker') from public.drawing_extractions
       where part_id = '00000000-0000-4000-8000-000000979bf3')]
   from ovd979_steps where name = 'O'),
  array['existing_version', '00000000-0000-4000-8000-000000979be3', 'true', 'worker-sim-v1/cad-package-source'],
  'CS6 a package with no drawing still reuses its CAD-only source row'
);

-- K is extracted again (its failed attach task is retried and now succeeds): the
-- same package is then reused from a drawing extraction. While the retry is
-- queued the source is still pending, and the target waits for it rather than
-- extracting the drawing a second time.
select pg_temp.ovd979_age_tasks('00000000-0000-4000-8000-000000979ba3');
set local role authenticated;
select pg_temp.ovd979_as_owner();
select public.api_request_extraction('00000000-0000-4000-8000-000000979ba0');
reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into ovd979_steps values ('Mp', pg_temp.ovd979_reuse_step('00000000-0000-4000-8000-000000979bc3'));
select is(
  (select array[body #>> '{reuse,result}', body #>> '{reuse,artifactsReady}', body #>> '{reuse,extractTargetIndependently}']
   from ovd979_steps where name = 'Mp'),
  array['existing_version_pending', 'false', 'false'],
  'CS7 while the source''s retry is queued the target waits for it: a pending source is not a CAD-only source'
);
select pg_temp.ovd979_worker_completes(
  '00000000-0000-4000-8000-000000979ba0', '00000000-0000-4000-8000-000000979ba3', 'worker-pdf-v3', 'src', 6,
  '{"marker": "drawing-source"}'::jsonb
);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into ovd979_steps values ('M2', pg_temp.ovd979_reuse_step('00000000-0000-4000-8000-000000979bc3'));
select is(
  (select array[body ->> 'result', body #>> '{reuse,artifactsReady}',
      (select extractor_version || '/' || (extraction ->> 'marker') from public.drawing_extractions
       where part_id = '00000000-0000-4000-8000-000000979bc3')]
   from ovd979_steps where name = 'M2'),
  array['existing_version', 'true', 'worker-pdf-v3/drawing-source'],
  'CS8 once the source holds a drawing extraction, the same package reuses it'
);

-- ---------------------------------------------------------------- review r11 (Codex): reuse of a source whose task failed after it stored its extraction
-- The worker stores the drawing_extractions row first and persists the previews,
-- auto-approves and completes the task afterwards, so a source whose task fails
-- in between holds a drawing-derived row (not CAD-only) and maybe some preview
-- rows, with nothing queued or running. The reuse copied that row, the target's
-- attach task completed and the completed-task guard of api_request_extraction
-- kept the target from ever being repaired.
-- F: the source (CAD extracted first by a task that completed, then the drawing
--    attached; the attach task stores its extraction and one of its previews and fails).
-- G1: the same package uploaded with its drawing while F's task has failed;
-- G2: the same while F's task is cancelled instead; G3: the same while F's retry
--    is queued; G4: the same once F's retry completed.
-- H: another package whose source row has no extract_part task on record; I: its target.
insert into public.jobs (id, organization_id, created_by, title, status)
values
  ('00000000-0000-4000-8000-000000979ca0', '00000000-0000-4000-8000-000000979001', '00000000-0000-4000-8000-000000979011', 'OVD 979 F', 'uploaded'),
  ('00000000-0000-4000-8000-000000979cb0', '00000000-0000-4000-8000-000000979001', '00000000-0000-4000-8000-000000979011', 'OVD 979 G1', 'uploaded'),
  ('00000000-0000-4000-8000-000000979cc0', '00000000-0000-4000-8000-000000979001', '00000000-0000-4000-8000-000000979011', 'OVD 979 G2', 'uploaded'),
  ('00000000-0000-4000-8000-000000979cd0', '00000000-0000-4000-8000-000000979001', '00000000-0000-4000-8000-000000979011', 'OVD 979 G3', 'uploaded'),
  ('00000000-0000-4000-8000-000000979ce0', '00000000-0000-4000-8000-000000979001', '00000000-0000-4000-8000-000000979011', 'OVD 979 G4', 'uploaded'),
  ('00000000-0000-4000-8000-000000979cf0', '00000000-0000-4000-8000-000000979001', '00000000-0000-4000-8000-000000979011', 'OVD 979 H', 'uploaded'),
  ('00000000-0000-4000-8000-000000979c90', '00000000-0000-4000-8000-000000979001', '00000000-0000-4000-8000-000000979011', 'OVD 979 I', 'uploaded');

select pg_temp.ovd979_add_trusted_file('00000000-0000-4000-8000-000000979ca1', '00000000-0000-4000-8000-000000979ca0', 'cad', '5');
insert into public.parts (id, job_id, organization_id, name, normalized_key, cad_file_id, drawing_file_id)
values ('00000000-0000-4000-8000-000000979ca3', '00000000-0000-4000-8000-000000979ca0', '00000000-0000-4000-8000-000000979001',
  'ovd979-bracket', 'ovd979-bracket', '00000000-0000-4000-8000-000000979ca1', null);

-- F is extracted CAD-only first, by a task that completes.
set local role authenticated;
select pg_temp.ovd979_as_owner();
select public.api_request_extraction('00000000-0000-4000-8000-000000979ca0');
reset role;
select pg_temp.ovd979_worker_completes(
  '00000000-0000-4000-8000-000000979ca0', '00000000-0000-4000-8000-000000979ca3', 'worker-sim-v1', 'cad', 1,
  '{"marker": "f-cad-only"}'::jsonb
);

-- The drawing is attached; the attach task stores the drawing extraction and
-- one preview row, then fails (persistDrawingPreviewAssets, auto-approval).
select pg_temp.ovd979_add_trusted_file('00000000-0000-4000-8000-000000979ca2', '00000000-0000-4000-8000-000000979ca0', 'drawing', '1');
select pg_temp.ovd979_age_tasks('00000000-0000-4000-8000-000000979ca3');
set local role authenticated;
select pg_temp.ovd979_as_owner();
select public.api_request_extraction('00000000-0000-4000-8000-000000979ca0');
reset role;
select pg_temp.ovd979_worker_completes(
  '00000000-0000-4000-8000-000000979ca0', '00000000-0000-4000-8000-000000979ca3', 'worker-pdf-v3', 'src', 6,
  '{"marker": "f-stored-then-failed"}'::jsonb, '{}'::text[], false, false
);
insert into public.drawing_preview_assets (part_id, organization_id, page_number, kind, storage_path)
values ('00000000-0000-4000-8000-000000979ca3', '00000000-0000-4000-8000-000000979001', 1, 'page', 'org/ovd979/f-page-1.png');
select pg_temp.ovd979_worker_fails('00000000-0000-4000-8000-000000979ca3');

select is(
  array[
    (select extractor_version from public.drawing_extractions where part_id = '00000000-0000-4000-8000-000000979ca3'),
    (select count(*)::text from public.drawing_preview_assets where part_id = '00000000-0000-4000-8000-000000979ca3'),
    (select (source_part_id = '00000000-0000-4000-8000-000000979ca3')::text from public.part_versions
     where id = (select part_version_id from public.parts where id = '00000000-0000-4000-8000-000000979ca3'))
  ] || (select array_agg(status::text order by created_at, status::text) from public.work_queue
        where part_id = '00000000-0000-4000-8000-000000979ca3' and task_type = 'extract_part'),
  array['worker-pdf-v3', '1', 'true', 'completed', 'failed'],
  'RF0 the source''s attach task failed after it stored its drawing extraction: a drawing-derived row, one preview, an earlier completed task and a failed latest one'
);

-- G1 to G4: the same package, uploaded together with its drawing.
select pg_temp.ovd979_add_trusted_file('00000000-0000-4000-8000-000000979cb1', '00000000-0000-4000-8000-000000979cb0', 'cad', '5');
select pg_temp.ovd979_add_trusted_file('00000000-0000-4000-8000-000000979cb2', '00000000-0000-4000-8000-000000979cb0', 'drawing', '1');
select pg_temp.ovd979_add_trusted_file('00000000-0000-4000-8000-000000979cc1', '00000000-0000-4000-8000-000000979cc0', 'cad', '5');
select pg_temp.ovd979_add_trusted_file('00000000-0000-4000-8000-000000979cc2', '00000000-0000-4000-8000-000000979cc0', 'drawing', '1');
select pg_temp.ovd979_add_trusted_file('00000000-0000-4000-8000-000000979cd1', '00000000-0000-4000-8000-000000979cd0', 'cad', '5');
select pg_temp.ovd979_add_trusted_file('00000000-0000-4000-8000-000000979cd2', '00000000-0000-4000-8000-000000979cd0', 'drawing', '1');
select pg_temp.ovd979_add_trusted_file('00000000-0000-4000-8000-000000979ce1', '00000000-0000-4000-8000-000000979ce0', 'cad', '5');
select pg_temp.ovd979_add_trusted_file('00000000-0000-4000-8000-000000979ce2', '00000000-0000-4000-8000-000000979ce0', 'drawing', '1');
insert into public.parts (id, job_id, organization_id, name, normalized_key, cad_file_id, drawing_file_id)
values
  ('00000000-0000-4000-8000-000000979cb3', '00000000-0000-4000-8000-000000979cb0', '00000000-0000-4000-8000-000000979001',
    'ovd979-bracket', 'ovd979-bracket', '00000000-0000-4000-8000-000000979cb1', '00000000-0000-4000-8000-000000979cb2'),
  ('00000000-0000-4000-8000-000000979cc3', '00000000-0000-4000-8000-000000979cc0', '00000000-0000-4000-8000-000000979001',
    'ovd979-bracket', 'ovd979-bracket', '00000000-0000-4000-8000-000000979cc1', '00000000-0000-4000-8000-000000979cc2'),
  ('00000000-0000-4000-8000-000000979cd3', '00000000-0000-4000-8000-000000979cd0', '00000000-0000-4000-8000-000000979001',
    'ovd979-bracket', 'ovd979-bracket', '00000000-0000-4000-8000-000000979cd1', '00000000-0000-4000-8000-000000979cd2'),
  ('00000000-0000-4000-8000-000000979ce3', '00000000-0000-4000-8000-000000979ce0', '00000000-0000-4000-8000-000000979001',
    'ovd979-bracket', 'ovd979-bracket', '00000000-0000-4000-8000-000000979ce1', '00000000-0000-4000-8000-000000979ce2');

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into ovd979_steps values ('G1', pg_temp.ovd979_reuse_step('00000000-0000-4000-8000-000000979cb3'));
select is(
  (select array[body ->> 'result', body ->> 'source', body #>> '{reuse,artifactsReady}', body #>> '{reuse,extractTargetIndependently}',
      (select count(*)::text from public.drawing_extractions where part_id = '00000000-0000-4000-8000-000000979cb3'),
      (select count(*)::text from public.drawing_preview_assets where part_id = '00000000-0000-4000-8000-000000979cb3')]
   from ovd979_steps where name = 'G1'),
  array['existing_version', '00000000-0000-4000-8000-000000979ca3', 'false', 'true', '0', '0'],
  'RF1 (Codex) a source whose attach task failed after it stored its extraction is not reused: nothing is copied and the worker extracts the target itself'
);

-- The same, when the source's task was cancelled (by hand) instead of failed.
update public.work_queue set status = 'cancelled'
where part_id = '00000000-0000-4000-8000-000000979ca3' and task_type = 'extract_part' and status = 'failed';
insert into ovd979_steps values ('G2', pg_temp.ovd979_reuse_step('00000000-0000-4000-8000-000000979cc3'));
select is(
  (select array[body #>> '{reuse,artifactsReady}', body #>> '{reuse,extractTargetIndependently}',
      (select count(*)::text from public.drawing_extractions where part_id = '00000000-0000-4000-8000-000000979cc3')]
   from ovd979_steps where name = 'G2'),
  array['false', 'true', '0'],
  'RF2 a source whose task was cancelled after it stored its extraction is not reused either'
);

-- F's attach is retried through api_request_extraction (the revision 4 path):
-- while the retry is queued the target waits for it.
select pg_temp.ovd979_age_tasks('00000000-0000-4000-8000-000000979ca3');
set local role authenticated;
select pg_temp.ovd979_as_owner();
select is(
  public.api_request_extraction('00000000-0000-4000-8000-000000979ca0'), 1,
  'RF3 the cancelled attach task of the source is queued again'
);
reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into ovd979_steps values ('G3', pg_temp.ovd979_reuse_step('00000000-0000-4000-8000-000000979cd3'));
select is(
  (select array[body #>> '{reuse,result}', body #>> '{reuse,artifactsReady}', body #>> '{reuse,extractTargetIndependently}']
   from ovd979_steps where name = 'G3'),
  array['existing_version_pending', 'false', 'false'],
  'RF3b while the source''s retry is queued the target waits for it'
);

-- The retry completes (in the worker's order): the failure it replaced is
-- history, and the same package is reused from the source again.
select pg_temp.ovd979_worker_completes(
  '00000000-0000-4000-8000-000000979ca0', '00000000-0000-4000-8000-000000979ca3', 'worker-pdf-v3', 'src', 8,
  '{"marker": "f-retried"}'::jsonb
);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into ovd979_steps values ('G4', pg_temp.ovd979_reuse_step('00000000-0000-4000-8000-000000979ce3'));
select is(
  (select array[body #>> '{reuse,artifactsReady}',
      (select extractor_version || '/' || (extraction ->> 'marker') from public.drawing_extractions
       where part_id = '00000000-0000-4000-8000-000000979ce3')]
   from ovd979_steps where name = 'G4'),
  array['true', 'worker-pdf-v3/f-retried'],
  'RF4 once the source''s retry completed, the same package reuses its extraction again'
);

-- H: a source row that no extract_part task on record produced. I: its target.
select pg_temp.ovd979_add_trusted_file('00000000-0000-4000-8000-000000979cf1', '00000000-0000-4000-8000-000000979cf0', 'cad', 'e');
select pg_temp.ovd979_add_trusted_file('00000000-0000-4000-8000-000000979cf2', '00000000-0000-4000-8000-000000979cf0', 'drawing', 'd');
insert into public.parts (id, job_id, organization_id, name, normalized_key, cad_file_id, drawing_file_id)
values ('00000000-0000-4000-8000-000000979cf3', '00000000-0000-4000-8000-000000979cf0', '00000000-0000-4000-8000-000000979001',
  'ovd979-bracket', 'ovd979-bracket', '00000000-0000-4000-8000-000000979cf1', '00000000-0000-4000-8000-000000979cf2');
insert into public.drawing_extractions (part_id, organization_id, extractor_version, extraction, status)
values ('00000000-0000-4000-8000-000000979cf3', '00000000-0000-4000-8000-000000979001', 'worker-pdf-v3',
  '{"marker": "no-task-source"}'::jsonb, 'approved');
select pg_temp.ovd979_add_trusted_file('00000000-0000-4000-8000-000000979c91', '00000000-0000-4000-8000-000000979c90', 'cad', 'e');
select pg_temp.ovd979_add_trusted_file('00000000-0000-4000-8000-000000979c92', '00000000-0000-4000-8000-000000979c90', 'drawing', 'd');
insert into public.parts (id, job_id, organization_id, name, normalized_key, cad_file_id, drawing_file_id)
values ('00000000-0000-4000-8000-000000979c93', '00000000-0000-4000-8000-000000979c90', '00000000-0000-4000-8000-000000979001',
  'ovd979-bracket', 'ovd979-bracket', '00000000-0000-4000-8000-000000979c91', '00000000-0000-4000-8000-000000979c92');

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into ovd979_steps values ('I1', pg_temp.ovd979_reuse_step('00000000-0000-4000-8000-000000979c93'));
select is(
  (select array[body ->> 'result', body ->> 'source', body #>> '{reuse,artifactsReady}', body #>> '{reuse,extractTargetIndependently}',
      (select count(*)::text from public.drawing_extractions where part_id = '00000000-0000-4000-8000-000000979c93')]
   from ovd979_steps where name = 'I1'),
  array['existing_version', '00000000-0000-4000-8000-000000979cf3', 'false', 'true', '0'],
  'RF5 a source extraction that no extract_part task on record produced is not trusted'
);

insert into public.work_queue (organization_id, job_id, part_id, task_type, status, payload)
values ('00000000-0000-4000-8000-000000979001', '00000000-0000-4000-8000-000000979cf0', '00000000-0000-4000-8000-000000979cf3',
  'extract_part', 'completed', '{}'::jsonb);
insert into ovd979_steps values ('I2', pg_temp.ovd979_reuse_step('00000000-0000-4000-8000-000000979c93'));
select is(
  (select array[body #>> '{reuse,artifactsReady}',
      (select extractor_version || '/' || (extraction ->> 'marker') from public.drawing_extractions
       where part_id = '00000000-0000-4000-8000-000000979c93')]
   from ovd979_steps where name = 'I2'),
  array['true', 'worker-pdf-v3/no-task-source'],
  'RF6 the same source is reused once a completed extract_part task is on record'
);

-- A failure recorded at the same instant as the completion (one test
-- transaction has one clock) is not ordered before it, so it counts against the
-- source, the same way a tie keeps a failed task in the roll-up of part a.
insert into public.work_queue (organization_id, job_id, part_id, task_type, status, payload)
values ('00000000-0000-4000-8000-000000979001', '00000000-0000-4000-8000-000000979cf0', '00000000-0000-4000-8000-000000979cf3',
  'extract_part', 'failed', '{}'::jsonb);
insert into ovd979_steps values ('I3', pg_temp.ovd979_reuse_step('00000000-0000-4000-8000-000000979c93'));
select is(
  (select array[body #>> '{reuse,artifactsReady}', body #>> '{reuse,extractTargetIndependently}']
   from ovd979_steps where name = 'I3'),
  array['false', 'true'],
  'RF7 a failed task created at the same instant as the completed one counts against the source'
);

-- ---------------------------------------------------------------- fix round 7 (Codex): deferred drawing task, per-claim evidence
-- DF: the drawing is attached while the part's CAD-only extraction is running
--     (it has stored its worker-sim row and is not completed yet). The request
--     defers one drawing task behind it, and the task's completion releases it.
-- DH: the same, and the CAD-only task fails instead: the failure releases it
--     too; while the released task runs, a request defers nothing more.
-- RT: two parts with attached drawings. RT1's attach task stores its drawing
--     extraction and fails, and is retried; while the retry still holds that
--     old row, RT2's run calls auto-approval. The races of these sequences with
--     real clocks and two sessions are in ovd979_auto_approve_concurrency.sql.
insert into public.jobs (id, organization_id, created_by, title, status)
values
  ('00000000-0000-4000-8000-000000979f10', '00000000-0000-4000-8000-000000979001', '00000000-0000-4000-8000-000000979011', 'OVD 979 DF', 'uploaded'),
  ('00000000-0000-4000-8000-000000979f20', '00000000-0000-4000-8000-000000979001', '00000000-0000-4000-8000-000000979011', 'OVD 979 DH', 'uploaded'),
  ('00000000-0000-4000-8000-000000979fa0', '00000000-0000-4000-8000-000000979001', '00000000-0000-4000-8000-000000979011', 'OVD 979 RT', 'uploaded');

insert into public.job_files (
  id, job_id, organization_id, uploaded_by, storage_bucket, storage_path,
  original_name, normalized_name, file_kind
)
select file.id, file.job_id, '00000000-0000-4000-8000-000000979001', '00000000-0000-4000-8000-000000979011',
  'job-files', 'org/ovd979/' || file.id::text, file.original_name, file.normalized_name, 'cad'::public.job_file_kind
from (values
  ('00000000-0000-4000-8000-000000979f11'::uuid, '00000000-0000-4000-8000-000000979f10'::uuid, 'bracket.step', 'ovd979-bracket'),
  ('00000000-0000-4000-8000-000000979f21'::uuid, '00000000-0000-4000-8000-000000979f20'::uuid, 'bracket.step', 'ovd979-bracket'),
  ('00000000-0000-4000-8000-000000979fa1'::uuid, '00000000-0000-4000-8000-000000979fa0'::uuid, 'rt1.step', 'ovd979-rt1'),
  ('00000000-0000-4000-8000-000000979fb1'::uuid, '00000000-0000-4000-8000-000000979fa0'::uuid, 'rt2.step', 'ovd979-rt2')
) as file(id, job_id, original_name, normalized_name);

insert into public.parts (id, job_id, organization_id, name, normalized_key, cad_file_id, drawing_file_id)
values
  ('00000000-0000-4000-8000-000000979f13', '00000000-0000-4000-8000-000000979f10', '00000000-0000-4000-8000-000000979001',
    'ovd979-bracket', 'ovd979-bracket', '00000000-0000-4000-8000-000000979f11', null),
  ('00000000-0000-4000-8000-000000979f23', '00000000-0000-4000-8000-000000979f20', '00000000-0000-4000-8000-000000979001',
    'ovd979-bracket', 'ovd979-bracket', '00000000-0000-4000-8000-000000979f21', null),
  ('00000000-0000-4000-8000-000000979fa3', '00000000-0000-4000-8000-000000979fa0', '00000000-0000-4000-8000-000000979001',
    'ovd979-rt1', 'ovd979-rt1', '00000000-0000-4000-8000-000000979fa1', null),
  ('00000000-0000-4000-8000-000000979fb3', '00000000-0000-4000-8000-000000979fa0', '00000000-0000-4000-8000-000000979001',
    'ovd979-rt2', 'ovd979-rt2', '00000000-0000-4000-8000-000000979fb1', null);

set local role authenticated;
select pg_temp.ovd979_as_owner();
select public.api_request_extraction(job_id)
from unnest(array['00000000-0000-4000-8000-000000979f10', '00000000-0000-4000-8000-000000979f20',
  '00000000-0000-4000-8000-000000979fa0']::uuid[]) job_id;
reset role;

-- DF and DH: the CAD-only task is claimed and stores its row; it is not done.
select pg_temp.ovd979_worker_completes(
  '00000000-0000-4000-8000-000000979f10', '00000000-0000-4000-8000-000000979f13', 'worker-sim-v1', 'cad', 1,
  '{}'::jsonb, '{}'::text[], false, false
);
select pg_temp.ovd979_worker_completes(
  '00000000-0000-4000-8000-000000979f20', '00000000-0000-4000-8000-000000979f23', 'worker-sim-v1', 'cad', 1,
  '{}'::jsonb, '{}'::text[], false, false
);
-- RT: both parts complete their CAD-only extraction.
select pg_temp.ovd979_worker_completes(
  '00000000-0000-4000-8000-000000979fa0', '00000000-0000-4000-8000-000000979fa3', 'worker-sim-v1', 'cad1', 1
);
select pg_temp.ovd979_worker_completes(
  '00000000-0000-4000-8000-000000979fa0', '00000000-0000-4000-8000-000000979fb3', 'worker-sim-v1', 'cad2', 1
);
update public.jobs set status = 'ready_to_quote' where id = '00000000-0000-4000-8000-000000979fa0';

-- The drawings are uploaded; api_request_extraction reconciles them onto the parts.
insert into public.job_files (
  id, job_id, organization_id, uploaded_by, storage_bucket, storage_path,
  original_name, normalized_name, file_kind
)
select file.id, file.job_id, '00000000-0000-4000-8000-000000979001', '00000000-0000-4000-8000-000000979011',
  'job-files', 'org/ovd979/' || file.id::text, file.original_name, file.normalized_name, 'drawing'::public.job_file_kind
from (values
  ('00000000-0000-4000-8000-000000979f12'::uuid, '00000000-0000-4000-8000-000000979f10'::uuid, 'bracket.pdf', 'ovd979-bracket'),
  ('00000000-0000-4000-8000-000000979f22'::uuid, '00000000-0000-4000-8000-000000979f20'::uuid, 'bracket.pdf', 'ovd979-bracket'),
  ('00000000-0000-4000-8000-000000979fa2'::uuid, '00000000-0000-4000-8000-000000979fa0'::uuid, 'rt1.pdf', 'ovd979-rt1'),
  ('00000000-0000-4000-8000-000000979fb2'::uuid, '00000000-0000-4000-8000-000000979fa0'::uuid, 'rt2.pdf', 'ovd979-rt2')
) as file(id, job_id, original_name, normalized_name);

set local role authenticated;
select pg_temp.ovd979_as_owner();
select is(
  array[public.api_request_extraction('00000000-0000-4000-8000-000000979f10'),
        public.api_request_extraction('00000000-0000-4000-8000-000000979f20')],
  array[1, 1],
  'DF1 a drawing attached while the CAD-only extraction runs queues one task for it'
);
reset role;
select ok(
  (select count(*) = 1
     and bool_and(deferred.status = 'queued'
       and deferred.available_at > timezone('utc', now())
       and deferred.payload ->> 'reason' = 'drawing_attached'
       and deferred.payload ->> 'drawingFileId' = '00000000-0000-4000-8000-000000979f12'
       and deferred.payload ->> 'awaitingTaskId' = running.id::text)
   from public.work_queue deferred
   join public.work_queue running
     on running.part_id = deferred.part_id and running.status = 'running'
   where deferred.part_id = '00000000-0000-4000-8000-000000979f13' and deferred.status = 'queued'),
  'DF2 the task is deferred: it names the running task and is not claimable (available_at is ahead)'
);
set local role authenticated;
select pg_temp.ovd979_as_owner();
select is(
  public.api_request_extraction('00000000-0000-4000-8000-000000979f10'), 0,
  'DF3 a second request while the deferred task waits queues nothing'
);
reset role;

-- The CAD-only task completes (markTaskCompleted).
update public.work_queue set status = 'completed', locked_at = null, locked_by = null
where part_id = '00000000-0000-4000-8000-000000979f13' and task_type = 'extract_part' and status = 'running';
select ok(
  (select bool_and(status = 'queued' and available_at <= timezone('utc', now()))
   from public.work_queue
   where part_id = '00000000-0000-4000-8000-000000979f13' and payload ->> 'reason' = 'drawing_attached'),
  'DF4 its completion releases the deferred drawing task'
);

-- The worker runs it like any drawing task.
select pg_temp.ovd979_worker_completes(
  '00000000-0000-4000-8000-000000979f10', '00000000-0000-4000-8000-000000979f13', 'worker-pdf-v3', 'df', 3
);
set local role authenticated;
select pg_temp.ovd979_as_owner();
create temporary table ovd979_df5_requested on commit drop as
select public.api_request_extraction('00000000-0000-4000-8000-000000979f10') as queued;
reset role;
select is(
  array[(select description from public.approved_part_requirements where part_id = '00000000-0000-4000-8000-000000979f13'),
        (select status::text from public.jobs where id = '00000000-0000-4000-8000-000000979f10'),
        (select queued::text from ovd979_df5_requested)],
  array['EXTRACTED DESC df', 'ready_to_quote', '0'],
  'DF5 the drawing is extracted and approved, and nothing is queued again for it'
);

-- DH: the CAD-only task fails instead (markTaskFailed acts on the claimed task
-- only, so pg_temp.ovd979_worker_fails, which also fails queued tasks, is not
-- used here).
update public.work_queue
set status = 'failed', last_error = 'ovd979 simulated extraction failure', locked_at = null, locked_by = null
where part_id = '00000000-0000-4000-8000-000000979f23' and task_type = 'extract_part' and status = 'running';
select ok(
  (select bool_and(status = 'queued' and available_at <= timezone('utc', now()))
   from public.work_queue
   where part_id = '00000000-0000-4000-8000-000000979f23' and payload ->> 'reason' = 'drawing_attached'),
  'DF6 a failed settlement releases the deferred drawing task as well'
);
-- The released task is claimed: it reads the current drawing, so a request
-- while it runs defers nothing.
update public.work_queue
set status = 'running', locked_at = timezone('utc', now()), locked_by = 'ovd979-test', attempts = attempts + 1
where part_id = '00000000-0000-4000-8000-000000979f23' and task_type = 'extract_part' and status = 'queued';
set local role authenticated;
select pg_temp.ovd979_as_owner();
select is(
  public.api_request_extraction('00000000-0000-4000-8000-000000979f20'), 0,
  'DF7 nothing is deferred behind a running task for the current drawing'
);
select is(
  public.api_request_extraction('00000000-0000-4000-8000-000000979fa0'), 2,
  'RT0 one request queues the drawing tasks of both RT parts'
);
reset role;

-- DJ: the first extraction of a CAD-only part is claimed and has stored nothing
-- yet when the drawing is attached: the drawing task is deferred too, with the
-- drawing_attached payload (the running task may never read the drawing).
insert into public.jobs (id, organization_id, created_by, title, status)
values ('00000000-0000-4000-8000-000000979f30', '00000000-0000-4000-8000-000000979001', '00000000-0000-4000-8000-000000979011', 'OVD 979 DJ', 'uploaded');
insert into public.job_files (
  id, job_id, organization_id, uploaded_by, storage_bucket, storage_path,
  original_name, normalized_name, file_kind
) values (
  '00000000-0000-4000-8000-000000979f31', '00000000-0000-4000-8000-000000979f30', '00000000-0000-4000-8000-000000979001',
  '00000000-0000-4000-8000-000000979011', 'job-files', 'org/ovd979/dj.step', 'bracket.step', 'ovd979-bracket', 'cad'
);
insert into public.parts (id, job_id, organization_id, name, normalized_key, cad_file_id, drawing_file_id)
values ('00000000-0000-4000-8000-000000979f33', '00000000-0000-4000-8000-000000979f30', '00000000-0000-4000-8000-000000979001',
  'ovd979-bracket', 'ovd979-bracket', '00000000-0000-4000-8000-000000979f31', null);
set local role authenticated;
select pg_temp.ovd979_as_owner();
select public.api_request_extraction('00000000-0000-4000-8000-000000979f30');
reset role;
update public.work_queue
set status = 'running', locked_at = timezone('utc', now()), locked_by = 'ovd979-test', attempts = attempts + 1
where part_id = '00000000-0000-4000-8000-000000979f33' and task_type = 'extract_part' and status = 'queued';
insert into public.job_files (
  id, job_id, organization_id, uploaded_by, storage_bucket, storage_path,
  original_name, normalized_name, file_kind
) values (
  '00000000-0000-4000-8000-000000979f32', '00000000-0000-4000-8000-000000979f30', '00000000-0000-4000-8000-000000979001',
  '00000000-0000-4000-8000-000000979011', 'job-files', 'org/ovd979/dj.pdf', 'bracket.pdf', 'ovd979-bracket', 'drawing'
);
set local role authenticated;
select pg_temp.ovd979_as_owner();
create temporary table ovd979_df8_requested on commit drop as
select public.api_request_extraction('00000000-0000-4000-8000-000000979f30') as queued;
reset role;
select ok(
  (select queued = 1 from ovd979_df8_requested)
  and (select count(*) = 1
         and bool_and(deferred.available_at > timezone('utc', now())
           and deferred.payload ->> 'reason' = 'drawing_attached'
           and deferred.payload ->> 'drawingFileId' = '00000000-0000-4000-8000-000000979f32'
           and deferred.payload ->> 'awaitingTaskId' is not null)
       from public.work_queue deferred
       where deferred.part_id = '00000000-0000-4000-8000-000000979f33' and deferred.status = 'queued'),
  'DF8 a drawing attached while a first extraction runs, before it stored anything, is deferred as a drawing task'
);

-- RT1's attach task stores its drawing extraction and fails before it is done.
select pg_temp.ovd979_worker_completes(
  '00000000-0000-4000-8000-000000979fa0', '00000000-0000-4000-8000-000000979fa3', 'worker-pdf-v3', 'rt1-try1', 2,
  '{}'::jsonb, '{}'::text[], false, false
);
select pg_temp.ovd979_worker_fails('00000000-0000-4000-8000-000000979fa3');
select pg_temp.ovd979_age_tasks('00000000-0000-4000-8000-000000979fa3');
set local role authenticated;
select pg_temp.ovd979_as_owner();
select public.api_request_extraction('00000000-0000-4000-8000-000000979fa0');
reset role;
-- The retry is claimed after its failed attempt stored the row. This test has
-- one clock, so the claim is dated explicitly, at the same instant as that row
-- (now + 2 minutes): a tie is not evidence that the claim wrote the row.
update public.work_queue
set status = 'running', locked_at = timezone('utc', now()) + interval '2 minutes', locked_by = 'ovd979-test', attempts = attempts + 1
where part_id = '00000000-0000-4000-8000-000000979fa3' and task_type = 'extract_part' and status = 'queued';

-- RT2's run reaches its auto-approval while the retry still holds the old row.
select pg_temp.ovd979_worker_completes(
  '00000000-0000-4000-8000-000000979fa0', '00000000-0000-4000-8000-000000979fb3', 'worker-pdf-v3', 'rt2', 3,
  '{}'::jsonb, '{}'::text[], false
);
select is(
  (select status::text from public.jobs where id = '00000000-0000-4000-8000-000000979fa0'),
  'extracting',
  'RV1 (Codex) a retry that holds its failed attempt''s extraction is not finishing: another part''s run keeps the job extracting'
);
select is(
  (select array[status::text, (updated_at = timezone('utc', now()) + interval '2 minutes')::text]
   from public.drawing_extractions where part_id = '00000000-0000-4000-8000-000000979fa3'),
  array['needs_review', 'true'],
  'RV2 that run leaves the retry''s old row untouched (status and updated_at)'
);
update public.work_queue set status = 'completed', locked_at = null, locked_by = null
where part_id = '00000000-0000-4000-8000-000000979fb3' and task_type = 'extract_part' and status = 'running';

-- The retry stores its own extraction during its claim and auto-approves.
delete from public.drawing_extractions where part_id = '00000000-0000-4000-8000-000000979fa3';
insert into public.drawing_extractions (part_id, organization_id, extractor_version, extraction, status, created_at, updated_at)
values ('00000000-0000-4000-8000-000000979fa3', '00000000-0000-4000-8000-000000979001', 'worker-pdf-v3',
  '{"description":"EXTRACTED DESC rt1-try2","quoteDescription":"EXTRACTED DESC rt1-try2"}'::jsonb, 'needs_review',
  timezone('utc', now()) + interval '10 minutes', timezone('utc', now()) + interval '10 minutes');
select public.api_auto_approve_job_requirements('00000000-0000-4000-8000-000000979fa0');
select is(
  array[(select status::text from public.jobs where id = '00000000-0000-4000-8000-000000979fa0'),
        (select description from public.approved_part_requirements where part_id = '00000000-0000-4000-8000-000000979fa3')],
  array['ready_to_quote', 'EXTRACTED DESC rt1-try2'],
  'RV3 once the retry has stored its own result during its claim it is finishing, and the job is ready to quote'
);

-- ---------------------------------------------------------------- attributes and grants
select ok(
  (select bool_and(p.prosecdef and p.proconfig = array['search_path=pg_catalog, public'])
   from pg_proc p
   where p.oid in ('public.api_auto_approve_job_requirements(uuid)'::regprocedure,
                   'public.api_request_extraction(uuid)'::regprocedure)),
  'G1 both functions stay SECURITY DEFINER with search_path=pg_catalog, public'
);
select ok(
  has_function_privilege('service_role', 'public.api_auto_approve_job_requirements(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.api_auto_approve_job_requirements(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.api_auto_approve_job_requirements(uuid)', 'execute'),
  'G2 auto-approve stays service_role only (OVD-535)'
);
select ok(
  has_function_privilege('authenticated', 'public.api_request_extraction(uuid)', 'execute')
  and has_function_privilege('service_role', 'public.api_request_extraction(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.api_request_extraction(uuid)', 'execute'),
  'G3 request_extraction stays authenticated + service_role, not anon (OVD-736)'
);
select ok(
  not exists (
    select 1 from pg_proc p, aclexplode(p.proacl) acl
    where p.oid = 'public.api_request_extraction(uuid)'::regprocedure and acl.grantee = 0
  ),
  'G4 request_extraction has no PUBLIC grant'
);
select ok(
  not exists (
    select 1 from pg_proc p, aclexplode(p.proacl) acl
    where p.oid = 'public.api_auto_approve_job_requirements(uuid)'::regprocedure and acl.grantee = 0
  ),
  'G5 auto-approve has no PUBLIC grant'
);
select ok(
  (select p.prosecdef and p.proconfig = array['search_path=pg_catalog']
   from pg_proc p where p.oid = 'public.api_reuse_trusted_part_version_artifacts(uuid, uuid, uuid)'::regprocedure)
  and has_function_privilege('service_role', 'public.api_reuse_trusted_part_version_artifacts(uuid, uuid, uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.api_reuse_trusted_part_version_artifacts(uuid, uuid, uuid)', 'execute')
  and not has_function_privilege('anon', 'public.api_reuse_trusted_part_version_artifacts(uuid, uuid, uuid)', 'execute')
  and not exists (
    select 1 from pg_proc p, aclexplode(p.proacl) acl
    where p.oid = 'public.api_reuse_trusted_part_version_artifacts(uuid, uuid, uuid)'::regprocedure and acl.grantee = 0
  ),
  'G6 trusted reuse stays SECURITY DEFINER with search_path=pg_catalog and service_role only'
);
select ok(
  (select p.prosecdef and p.provolatile = 'v' and p.proconfig = array['search_path=pg_catalog, public']
   from pg_proc p where p.oid = 'public.load_editable_project_part_context(uuid)'::regprocedure)
  and has_function_privilege('service_role', 'public.load_editable_project_part_context(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.load_editable_project_part_context(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.load_editable_project_part_context(uuid)', 'execute'),
  'G7 (fix round 7) the save/reset context loader is SECURITY DEFINER, VOLATILE (it locks the job row), search_path=pg_catalog, public, service_role only'
);
select ok(
  (select p.prosecdef and p.proconfig = array['search_path=pg_catalog']
   from pg_proc p where p.oid = 'private.release_deferred_drawing_extractions()'::regprocedure)
  and not has_function_privilege('authenticated', 'private.release_deferred_drawing_extractions()', 'execute')
  and not has_function_privilege('anon', 'private.release_deferred_drawing_extractions()', 'execute')
  and exists (
    select 1 from pg_trigger t
    where t.tgrelid = 'public.work_queue'::regclass
      and t.tgname = 'release_deferred_drawing_extractions'
      and t.tgfoid = 'private.release_deferred_drawing_extractions()'::regprocedure
      and not t.tgisinternal and t.tgenabled = 'O'
  ),
  'G8 (fix round 7) the settlement trigger is installed; its function is SECURITY DEFINER, search_path=pg_catalog, not executable by anon or authenticated'
);

select * from finish();
rollback;
