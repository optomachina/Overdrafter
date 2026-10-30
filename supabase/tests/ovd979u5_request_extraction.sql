-- U5: synthetic local SQL acceptance, including observed two-session races.
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS dblink WITH SCHEMA extensions;
SET search_path = public, extensions;
SET statement_timeout = '30s';
BEGIN;
-- Collision is an error; cleanup below owns only this schema and these IDs.
CREATE SCHEMA ovd979u5_test;
INSERT INTO auth.users (id, aud, role, email, email_confirmed_at, raw_app_meta_data)
VALUES ('97950000-0000-4000-8000-000000000001', 'authenticated', 'authenticated',
  'ovd979u5@example.test', now(), '{"provider":"email"}');
INSERT INTO public.organizations (id, name, slug)
VALUES ('97950000-0000-4000-8000-000000000002', 'U5 synthetic', 'ovd979u5-test');
INSERT INTO public.organization_memberships (organization_id, user_id, role)
VALUES ('97950000-0000-4000-8000-000000000002', '97950000-0000-4000-8000-000000000001', 'client');
CREATE FUNCTION ovd979u5_test.make_case(p_extracted boolean DEFAULT false)
RETURNS TABLE(job_id uuid, part_id uuid) LANGUAGE plpgsql AS $$
DECLARE j uuid := gen_random_uuid(); p uuid := gen_random_uuid(); f uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.jobs (id, organization_id, created_by, title, status)
  VALUES (j, '97950000-0000-4000-8000-000000000002', '97950000-0000-4000-8000-000000000001', 'U5 test', 'uploaded');
  INSERT INTO public.job_files (id, job_id, organization_id, uploaded_by, storage_bucket,
    storage_path, original_name, normalized_name, file_kind)
  VALUES (f, j, '97950000-0000-4000-8000-000000000002', '97950000-0000-4000-8000-000000000001',
    'job-files', 'synthetic/u5/' || f, 'part.step', 'part', 'cad');
  INSERT INTO public.parts (id, job_id, organization_id, name, normalized_key, cad_file_id)
  VALUES (p, j, '97950000-0000-4000-8000-000000000002', 'part', 'part', f);
  IF p_extracted THEN
    INSERT INTO public.drawing_extractions (part_id, organization_id, extractor_version, extraction)
    VALUES (p, '97950000-0000-4000-8000-000000000002', 'worker-sim-v1', '{"description":"CAD desc","material":{"normalized":"Aluminum"}}');
  END IF;
  RETURN QUERY SELECT j, p;
END;
$$;
CREATE FUNCTION ovd979u5_test.attach(j uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE f uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.job_files (id, job_id, organization_id, uploaded_by, storage_bucket,
    storage_path, original_name, normalized_name, file_kind)
  VALUES (f, j, '97950000-0000-4000-8000-000000000002', '97950000-0000-4000-8000-000000000001',
    'job-files', 'synthetic/u5/' || f, 'part.pdf', 'part', 'drawing');
  RETURN f;
END;
$$;
CREATE FUNCTION ovd979u5_test.request(j uuid) RETURNS integer LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', '{"sub":"97950000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}', true);
  RETURN public.api_request_extraction(j);
END;
$$;
-- dblink sessions log in as a fixture role whose password is generated here and
-- never written down. ovd.test_conninfo still picks the host, port and database.
SELECT set_config('ovd979u5.password', encode(extensions.gen_random_bytes(24), 'hex'), false);
DO $$
BEGIN
  EXECUTE format('CREATE ROLE ovd979u5_tap LOGIN PASSWORD %L IN ROLE authenticated, service_role',
    current_setting('ovd979u5.password'));
END;
$$;
GRANT USAGE ON SCHEMA ovd979u5_test TO authenticated, service_role;
COMMIT;
SELECT no_plan();

CREATE TEMP TABLE u5_attach AS SELECT *, ovd979u5_test.attach(job_id) AS drawing_id FROM ovd979u5_test.make_case(true);
SELECT is(ovd979u5_test.request((SELECT job_id FROM u5_attach)), 1, 'AC2: attach drawing to extracted CAD-only part queues one task');
SELECT is(ovd979u5_test.request((SELECT job_id FROM u5_attach)), 0, 'AC2: repeated request creates nothing');
SELECT is((SELECT count(*)::integer FROM public.work_queue WHERE part_id = (SELECT part_id FROM u5_attach)), 1, 'AC2: exactly one task');
SELECT is((SELECT payload->>'drawingFileId' FROM public.work_queue WHERE part_id = (SELECT part_id FROM u5_attach)), (SELECT drawing_id::text FROM u5_attach), 'attachment payload identifies drawing');
SELECT throws_ok(format('insert into public.work_queue (organization_id, job_id, part_id, task_type, payload) values (%L,%L,%L,''extract_part'',''{}'')',
  '97950000-0000-4000-8000-000000000002', (SELECT job_id FROM u5_attach), (SELECT part_id FROM u5_attach)),
  '23505', NULL, 'unique guard also rejects a duplicate with missing drawing identity');
SELECT throws_ok(format('insert into public.work_queue (organization_id, job_id, part_id, task_type, payload) values (%L,%L,%L,''extract_part'',''{"drawingFileId":"another"}'')',
  '97950000-0000-4000-8000-000000000002', (SELECT job_id FROM u5_attach), (SELECT part_id FROM u5_attach)),
  '23505', NULL, 'unique guard is per part, including different drawings');
UPDATE public.work_queue SET status = 'completed' WHERE part_id = (SELECT part_id FROM u5_attach);
SELECT is(ovd979u5_test.request((SELECT job_id FROM u5_attach)), 0, 'completed drawing identity prevents a second task even with stale CAD extraction');

CREATE TEMP TABLE u5_cad AS SELECT * FROM ovd979u5_test.make_case(true);
SELECT is(ovd979u5_test.request((SELECT job_id FROM u5_cad)), 0, 'extracted CAD-only part without drawing is not requeued');
SELECT is((SELECT count(*)::integer FROM public.work_queue WHERE part_id = (SELECT part_id FROM u5_cad)), 0, 'CAD-only part remains without active work');
CREATE TEMP TABLE u5_initial AS SELECT *, ovd979u5_test.attach(job_id) AS drawing_id FROM ovd979u5_test.make_case();
SELECT is(ovd979u5_test.request((SELECT job_id FROM u5_initial)), 1, 'initial drawing extraction enqueues');
SELECT is(ovd979u5_test.request((SELECT job_id FROM u5_initial)), 0, 'double request during initial extraction deduplicates');
SELECT is((SELECT payload->>'drawingFileId' FROM public.work_queue WHERE part_id = (SELECT part_id FROM u5_initial)), (SELECT drawing_id::text FROM u5_initial), 'initial payload also always identifies drawing');
UPDATE public.work_queue SET status = 'completed' WHERE part_id = (SELECT part_id FROM u5_initial);

-- Deterministic claim/request race: claim holds L5 while request reconciles at
-- L2 and waits on that queued tuple, then sees the committed running version.
CREATE TEMP TABLE u5_race AS SELECT * FROM ovd979u5_test.make_case(true);
SELECT set_config('request.jwt.claims', '{"sub":"97950000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}', false);
SELECT public.api_update_client_part_request(p_job_id => (SELECT job_id FROM u5_race), p_description => 'USER correction');
INSERT INTO public.work_queue (organization_id, job_id, part_id, task_type, payload)
SELECT '97950000-0000-4000-8000-000000000002', job_id, part_id, 'extract_part', jsonb_build_object('drawingFileId', NULL) FROM u5_race;
CREATE TEMP TABLE u5_sessions (a integer, b integer, claim public.work_queue);
CREATE FUNCTION pg_temp.u5_connect() RETURNS void LANGUAGE plpgsql AS $$
DECLARE conn text := coalesce(nullif(current_setting('ovd.test_conninfo', true), ''),
    'host=host.docker.internal port=54322 dbname=postgres')
  || format(' user=ovd979u5_tap password=%s', current_setting('ovd979u5.password'));
BEGIN
  PERFORM extensions.dblink_connect('u5_a', conn);
  PERFORM extensions.dblink_connect('u5_b', conn);
  -- Like the worker; the request helper sets the client's JWT claims itself.
  PERFORM extensions.dblink_exec('u5_a', 'set role service_role');
  PERFORM extensions.dblink_exec('u5_b', 'set role service_role');
  INSERT INTO u5_sessions (a, b) SELECT a.pid, b.pid
  FROM extensions.dblink('u5_a', 'select pg_backend_pid()') AS a(pid integer)
  CROSS JOIN extensions.dblink('u5_b', 'select pg_backend_pid()') AS b(pid integer);
END;
$$;
SELECT pg_temp.u5_connect();
SELECT dblink_exec('u5_a', 'begin; set local lock_timeout = ''5s''; set local statement_timeout = ''10s''');
UPDATE u5_sessions SET claim = (SELECT task::public.work_queue FROM dblink('u5_a', 'select task::text from public.api_claim_next_task(''u5-worker'') task') AS r(task text))
WHERE a IS NOT NULL;
ALTER TABLE u5_race ADD COLUMN drawing_id uuid;
UPDATE u5_race SET drawing_id = ovd979u5_test.attach(job_id) WHERE job_id IS NOT NULL;
SELECT dblink_exec('u5_b', 'begin; set local lock_timeout = ''5s''; set local statement_timeout = ''10s''');
SELECT dblink_send_query('u5_b', format('select ovd979u5_test.request(%L)', (SELECT job_id FROM u5_race)));
CREATE FUNCTION pg_temp.u5_wait() RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE waited boolean;
BEGIN
  FOR i IN 1..100 LOOP
    SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_locks WHERE pid = s.b AND NOT granted
      AND s.a = ANY(pg_catalog.pg_blocking_pids(s.b))) INTO waited FROM u5_sessions s;
    EXIT WHEN waited OR extensions.dblink_is_busy('u5_b') = 0;
    PERFORM pg_sleep(0.01);
  END LOOP;
  RETURN waited;
END;
$$;
SELECT ok(pg_temp.u5_wait(), 'request observed waiting on the concurrently claimed queued task');
SELECT dblink_exec('u5_a', 'commit');
SELECT is((SELECT n FROM dblink_get_result('u5_b') AS r(n integer)), 0, 'request merges the claimed task rather than adding another');
SELECT * FROM dblink_get_result('u5_b') AS r(n integer);
SELECT dblink_exec('u5_b', 'commit');
SELECT is((SELECT count(*)::integer FROM public.work_queue WHERE part_id = (SELECT part_id FROM u5_race)), 1, 'race retains exactly one task row');
SELECT is((SELECT payload->>'pendingDrawingFileId' FROM public.work_queue WHERE part_id = (SELECT part_id FROM u5_race)), (SELECT drawing_id::text FROM u5_race), 'raced claim records drawing successor');
SELECT ok((SELECT available_at > now() + interval '55 minutes' FROM public.work_queue WHERE part_id = (SELECT part_id FROM u5_race)), 'deferred backstop remains one hour');
SELECT is((SELECT attempt_id FROM public.work_queue WHERE part_id = (SELECT part_id FROM u5_race)), (SELECT (claim).attempt_id FROM u5_sessions),
  'request keeps the running attempt_id, so worker settlement still matches');
-- The drawing is replaced again while the old attempt still runs.
ALTER TABLE u5_race ADD COLUMN replaced_id uuid;
UPDATE u5_race SET replaced_id = ovd979u5_test.attach(job_id) WHERE job_id IS NOT NULL;
SELECT is(ovd979u5_test.request((SELECT job_id FROM u5_race)), 0, 'drawing replaced mid-task: request adds no row');
SELECT is((SELECT payload->>'pendingDrawingFileId' FROM public.work_queue WHERE part_id = (SELECT part_id FROM u5_race)), (SELECT replaced_id::text FROM u5_race),
  'drawing replaced mid-task: the newest drawing is pending, not the stale one');
UPDATE u5_race SET drawing_id = replaced_id WHERE replaced_id IS NOT NULL;
UPDATE public.drawing_extractions SET source_attempt_id = (SELECT (claim).attempt_id FROM u5_sessions)
WHERE part_id = (SELECT part_id FROM u5_race);
SELECT public.api_auto_approve_job_requirements((SELECT job_id FROM u5_race));
SELECT is((SELECT status::text FROM public.jobs WHERE id = (SELECT job_id FROM u5_race)), 'extracting', 'superseded CAD attempt cannot count as finishing the pending drawing');
UPDATE public.work_queue SET payload = (SELECT (claim).payload FROM u5_sessions)
WHERE part_id = (SELECT part_id FROM u5_race);
SELECT is((SELECT payload->>'pendingDrawingFileId' FROM public.work_queue WHERE part_id = (SELECT part_id FROM u5_race)), (SELECT drawing_id::text FROM u5_race), 'stale running payload update preserves the pending drawing');
-- Settle with the worker's own predicates (worker/src/queue.ts: id, running,
-- attempts, locked_by) and its stale claim payload.
WITH settled AS (
  UPDATE public.work_queue SET status = 'completed', payload = (SELECT (claim).payload FROM u5_sessions)
  WHERE id = (SELECT (claim).id FROM u5_sessions) AND status = 'running'
    AND attempts = (SELECT (claim).attempts FROM u5_sessions) AND locked_by = (SELECT (claim).locked_by FROM u5_sessions)
  RETURNING id)
SELECT is((SELECT count(*)::integer FROM settled), 1, 'worker settlement predicates still match the merged row');
SELECT is((SELECT status::text FROM public.work_queue WHERE part_id = (SELECT part_id FROM u5_race)), 'queued', 'claim raced with request: successor is queued on settlement');
SELECT ok((SELECT available_at <= now() AND attempt_id IS NULL AND locked_at IS NULL AND locked_by IS NULL
  FROM public.work_queue WHERE part_id = (SELECT part_id FROM u5_race)), 'successor is immediately claimable with old claim cleared');
CREATE TEMP TABLE u5_successor AS SELECT * FROM public.api_claim_next_task('u5-worker');
SELECT is((SELECT payload->>'drawingFileId' FROM u5_successor), (SELECT drawing_id::text FROM u5_race), 'claim receives merged drawing without waiting an hour');
SELECT isnt((SELECT attempt_id FROM u5_successor), (SELECT (claim).attempt_id FROM u5_sessions), 'successor gets a fresh attempt identity');
UPDATE public.drawing_extractions SET extractor_version = 'worker-pdf-v3', source_attempt_id = (SELECT attempt_id FROM u5_successor),
  extraction = '{"description":"Drawing desc","material":{"normalized":"Aluminum"}}' WHERE part_id = (SELECT part_id FROM u5_race);
SELECT public.api_auto_approve_job_requirements((SELECT job_id FROM u5_race));
SELECT is((SELECT description FROM public.approved_part_requirements WHERE part_id = (SELECT part_id FROM u5_race)), 'USER correction', 'AC2 drawing extraction preserves client correction');
UPDATE public.work_queue SET status = 'completed' WHERE part_id = (SELECT part_id FROM u5_race);
SELECT is(ovd979u5_test.request((SELECT job_id FROM u5_race)), 0, 'completed successor is not requeued');

-- Reverse race: request holds the queued tuple; SKIP LOCKED claim cannot steal it.
CREATE TEMP TABLE u5_reverse AS SELECT * FROM ovd979u5_test.make_case();
SELECT ovd979u5_test.request((SELECT job_id FROM u5_reverse));
SELECT is((SELECT payload->'drawingFileId' FROM public.work_queue WHERE part_id = (SELECT part_id FROM u5_reverse)), 'null'::jsonb, 'initial CAD task carries explicit null drawingFileId');
ALTER TABLE u5_reverse ADD COLUMN drawing_id uuid;
UPDATE u5_reverse SET drawing_id = ovd979u5_test.attach(job_id) WHERE job_id IS NOT NULL;
SELECT dblink_exec('u5_b', 'begin; set local lock_timeout = ''5s''');
SELECT * FROM dblink('u5_b', format('select ovd979u5_test.request(%L)', (SELECT job_id FROM u5_reverse))) AS r(n integer);
SELECT is((SELECT n FROM dblink('u5_a', 'select count(*)::integer from public.api_claim_next_task(''u5-worker'')') AS r(n integer)), 0, 'claim skips the queued row locked by in-flight request');
SELECT dblink_exec('u5_b', 'commit');
SELECT is((SELECT payload->>'drawingFileId' FROM public.api_claim_next_task('u5-worker')), (SELECT drawing_id::text FROM u5_reverse), 'queued row receives drawing and can be claimed after request commit');
UPDATE public.work_queue SET status = 'completed' WHERE part_id = (SELECT part_id FROM u5_reverse);

-- Concurrent initial requests serialize at L0 and cannot create duplicate work.
CREATE TEMP TABLE u5_double AS SELECT * FROM ovd979u5_test.make_case();
SELECT dblink_exec('u5_a', 'begin; set local lock_timeout = ''5s''');
SELECT is((SELECT n FROM dblink('u5_a', format('select ovd979u5_test.request(%L)', (SELECT job_id FROM u5_double))) AS r(n integer)), 1, 'first concurrent initial request enqueues');
SELECT dblink_exec('u5_b', 'begin; set local lock_timeout = ''5s''');
SELECT dblink_send_query('u5_b', format('select ovd979u5_test.request(%L)', (SELECT job_id FROM u5_double)));
SELECT ok(pg_temp.u5_wait(), 'second concurrent request observed waiting behind first');
SELECT dblink_exec('u5_a', 'commit');
SELECT is((SELECT n FROM dblink_get_result('u5_b') AS r(n integer)), 0, 'second concurrent initial request deduplicates after wait');
SELECT * FROM dblink_get_result('u5_b') AS r(n integer);
SELECT dblink_exec('u5_b', 'commit');
SELECT is((SELECT count(*)::integer FROM public.work_queue WHERE part_id = (SELECT part_id FROM u5_double)), 1, 'double initial request has one task');
UPDATE public.work_queue SET status = 'completed' WHERE part_id = (SELECT part_id FROM u5_double);

-- Claim-side release is independent of a request and the one-hour timer.
INSERT INTO public.work_queue (organization_id, job_id, part_id, task_type, payload, available_at)
SELECT '97950000-0000-4000-8000-000000000002', job_id, part_id, 'extract_part',
  jsonb_build_object('awaitingTaskId', (SELECT id FROM public.work_queue WHERE part_id = u5_double.part_id)), now() + interval '1 hour'
FROM u5_double;
SELECT is((SELECT count(*)::integer FROM public.api_claim_next_task('u5-worker')), 1, 'claim releases terminal-dependency task immediately despite one-hour availability');
SELECT ok((SELECT NOT payload ? 'awaitingTaskId' FROM public.work_queue WHERE part_id = (SELECT part_id FROM u5_double) AND status = 'running'), 'released claim removes stale dependency');
UPDATE public.work_queue SET status = 'completed' WHERE part_id = (SELECT part_id FROM u5_double) AND status = 'running';
-- Every worker settlement path releases the merged successor, including retry.
CREATE FUNCTION pg_temp.u5_settlements() RETURNS SETOF text LANGUAGE plpgsql AS $$
DECLARE state public.queue_task_status; r record; old_claim public.work_queue; new_claim public.work_queue; f uuid;
BEGIN
  FOREACH state IN ARRAY ARRAY['completed','failed','cancelled','queued']::public.queue_task_status[] LOOP
    SELECT * INTO r FROM ovd979u5_test.make_case(true);
    INSERT INTO public.work_queue (organization_id, job_id, part_id, task_type, payload)
    VALUES ('97950000-0000-4000-8000-000000000002', r.job_id, r.part_id, 'extract_part', '{}');
    SELECT * INTO old_claim FROM public.api_claim_next_task('u5-worker');
    f := ovd979u5_test.attach(r.job_id);
    PERFORM ovd979u5_test.request(r.job_id);
    UPDATE public.work_queue SET status = state, payload = old_claim.payload,
      available_at = now() + interval '1 hour', last_error = 'old attempt'
    WHERE id = old_claim.id;
    RETURN NEXT ok((SELECT status = 'queued' AND available_at <= now() AND attempt_id IS NULL
      AND locked_by IS NULL AND last_error IS NULL FROM public.work_queue WHERE id = old_claim.id),
      state::text || ': releases successor immediately and clears old claim/error');
    SELECT * INTO new_claim FROM public.api_claim_next_task('u5-worker');
    RETURN NEXT is(new_claim.payload->>'drawingFileId', f::text, state::text || ': successor claim has drawing identity');
    UPDATE public.work_queue SET status = 'completed' WHERE id = new_claim.id;
  END LOOP;
END;
$$;
SELECT * FROM pg_temp.u5_settlements();
CREATE TEMP TABLE u5_late_attach AS SELECT *, ovd979u5_test.attach(job_id) AS drawing_id FROM ovd979u5_test.make_case(true);
UPDATE public.jobs SET status = 'quoting' WHERE id = (SELECT job_id FROM u5_late_attach);
SELECT is(ovd979u5_test.request((SELECT job_id FROM u5_late_attach)), 1, 'drawing attachment can queue after quoting starts');
SELECT is((SELECT status::text FROM public.jobs WHERE id = (SELECT job_id FROM u5_late_attach)), 'quoting', 'drawing-only request preserves later job status');
UPDATE public.work_queue SET status = 'completed' WHERE part_id = (SELECT part_id FROM u5_late_attach);
CREATE TEMP TABLE u5_late_new AS SELECT * FROM ovd979u5_test.make_case();
UPDATE public.jobs SET status = 'quoting' WHERE id = (SELECT job_id FROM u5_late_new);
SELECT is(ovd979u5_test.request((SELECT job_id FROM u5_late_new)), 1, 'never-extracted new part still queues');
SELECT is((SELECT status::text FROM public.jobs WHERE id = (SELECT job_id FROM u5_late_new)), 'extracting', 'new part retains the original request status behavior');
UPDATE public.work_queue SET status = 'completed' WHERE part_id = (SELECT part_id FROM u5_late_new);
SELECT ok(NOT has_function_privilege('anon', 'public.api_request_extraction(uuid)', 'execute'), 'anon request denied');
SELECT ok(NOT has_function_privilege('authenticated', 'public.api_claim_next_task(text)', 'execute'), 'client claim denied');
SELECT ok(has_function_privilege('authenticated', 'public.api_request_extraction(uuid)', 'execute'), 'client request grant retained');
SELECT ok(NOT has_function_privilege('authenticated', 'private.merge_pending_drawing_extraction()', 'execute'), 'trigger helper is service-only');
SELECT ok(NOT (SELECT prosecdef FROM pg_catalog.pg_proc WHERE oid = 'private.merge_pending_drawing_extraction()'::regprocedure), 'trigger helper is not SECURITY DEFINER');
SELECT dblink_disconnect('u5_a');
SELECT dblink_disconnect('u5_b');
BEGIN;
DELETE FROM public.work_queue WHERE organization_id = '97950000-0000-4000-8000-000000000002';
DELETE FROM public.parts WHERE organization_id = '97950000-0000-4000-8000-000000000002';
DELETE FROM public.jobs WHERE organization_id = '97950000-0000-4000-8000-000000000002';
DELETE FROM public.audit_events WHERE organization_id = '97950000-0000-4000-8000-000000000002';
DELETE FROM public.organizations WHERE id = '97950000-0000-4000-8000-000000000002';
DELETE FROM auth.users WHERE id = '97950000-0000-4000-8000-000000000001';
DROP SCHEMA ovd979u5_test CASCADE;
DROP ROLE ovd979u5_tap;
COMMIT;
SELECT ok(NOT EXISTS(SELECT 1 FROM public.organizations WHERE id = '97950000-0000-4000-8000-000000000002'), 'owned fixture removed');
SELECT * FROM finish();
