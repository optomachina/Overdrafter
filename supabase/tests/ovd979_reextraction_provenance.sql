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
-- Observed on a local Supabase Postgres 17.11 holding the 153 migrations of main
-- (real schema, triggers and access helpers): with both rollbacks applied 33 of
-- 79 assertions pass (A2, A4, B1, B1b, B3, B5, B8, B9, D0-D5, Q1-Q3, F1, F2, F2b,
-- F3, F4b, H1, V2, M1, M2, RU0, RU2, RU3, W1, W2, W3, W5, Z1, Z2, Z2b, Z3, PP0, PP1,
-- PP2, PP2b, PP3, PP4, PP5b, PC1 and G1 fail: corrections overwritten, 0 tasks
-- queued on attach, stale editor defaults, placeholder material, tolerance
-- filled, quoted jobs moved to ready_to_quote, reuse keeping the CAD-only row);
-- with the two migrations applied 79 of 79 pass. Sections D, E and Q cover
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
select plan(79);

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
-- is still running, then mark it completed.
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
update public.work_queue
set status = 'running', locked_at = timezone('utc', now()), locked_by = 'ovd979-test', attempts = attempts + 1
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

select * from finish();
rollback;
