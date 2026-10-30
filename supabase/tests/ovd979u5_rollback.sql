-- Local disposable database only. psql resolves these paths from this file.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;
SELECT plan(13);
CREATE TEMP TABLE u5_catalog AS
SELECT oid, prosrc, proacl, proconfig FROM pg_catalog.pg_proc
WHERE oid IN ('public.api_request_extraction(uuid)'::regprocedure,
  'public.api_claim_next_task(text)'::regprocedure,
  'public.api_auto_approve_job_requirements(uuid)'::regprocedure);
CREATE TEMP TABLE u5_objects AS
SELECT pg_get_indexdef('public.work_queue_one_active_extract_per_part'::regclass) AS index_def,
  (SELECT pg_get_triggerdef(oid) FROM pg_catalog.pg_trigger
   WHERE tgrelid = 'public.work_queue'::regclass AND tgname = 'merge_pending_drawing_extraction') AS trigger_def,
  (SELECT md5(coalesce(string_agg(row_to_json(q)::text, '' ORDER BY id), '')) FROM public.work_queue q) AS data_hash;
\ir ../../docs/migration-drafts/ovd-979u5.rollback.sql
SELECT is((SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = 'public.api_request_extraction(uuid)'::regprocedure),
  '7b2804b18559df073dcd4651e80b3ce6', 'rollback restores exact U4-era request body');
SELECT is((SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = 'public.api_claim_next_task(text)'::regprocedure),
  '0dcaaf41268ad9c84f4433b8b437e42b', 'rollback restores exact U3/U4 claim body');
SELECT ok(to_regclass('public.work_queue_one_active_extract_per_part') IS NULL, 'rollback drops unique index');
SELECT ok(to_regprocedure('private.merge_pending_drawing_extraction()') IS NULL, 'rollback drops settlement helper');
SELECT ok(NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid = 'public.work_queue'::regclass
  AND tgname = 'merge_pending_drawing_extraction'), 'rollback drops trigger');
SELECT ok((SELECT proconfig = ARRAY['search_path=public'] FROM pg_catalog.pg_proc
  WHERE oid = 'public.api_request_extraction(uuid)'::regprocedure), 'rollback restores original request search path');
SELECT ok((SELECT p.proacl = c.proacl FROM pg_catalog.pg_proc p JOIN u5_catalog c USING (oid)
  WHERE oid = 'public.api_request_extraction(uuid)'::regprocedure), 'request ACL restored');
SELECT ok((SELECT p.proacl = c.proacl AND p.proconfig = c.proconfig FROM pg_catalog.pg_proc p JOIN u5_catalog c USING (oid)
  WHERE oid = 'public.api_claim_next_task(text)'::regprocedure), 'claim ACL and search path restored');
\ir ../../docs/migration-drafts/ovd-979u5.rollback.sql
SELECT is((SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = 'public.api_request_extraction(uuid)'::regprocedure),
  '7b2804b18559df073dcd4651e80b3ce6', 'repeat rollback is a no-op');
\ir ../../docs/migration-drafts/ovd-979u5.sql
SELECT ok((SELECT bool_and(p.prosrc = c.prosrc AND p.proacl = c.proacl AND p.proconfig = c.proconfig)
  FROM pg_catalog.pg_proc p JOIN u5_catalog c USING (oid)), 'reapply restores U5 without changing U4 auto approval');
\ir ../../docs/migration-drafts/ovd-979u5.sql
SELECT ok((SELECT bool_and(p.prosrc = c.prosrc AND p.proacl = c.proacl AND p.proconfig = c.proconfig)
  FROM pg_catalog.pg_proc p JOIN u5_catalog c USING (oid)), 'repeated forward preserves functions and ACLs');
SELECT ok((SELECT pg_get_indexdef('public.work_queue_one_active_extract_per_part'::regclass) = index_def
  AND (SELECT pg_get_triggerdef(oid) FROM pg_catalog.pg_trigger WHERE tgrelid = 'public.work_queue'::regclass
    AND tgname = 'merge_pending_drawing_extraction') = trigger_def FROM u5_objects), 'repeat forward preserves index and trigger definitions');
SELECT is((SELECT md5(coalesce(string_agg(row_to_json(q)::text, '' ORDER BY id), '')) FROM public.work_queue q),
  (SELECT data_hash FROM u5_objects), 'apply/rollback/reapply never rewrite existing task data');
SELECT * FROM finish();
ROLLBACK;
