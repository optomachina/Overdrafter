-- =====================================================================
-- NEEDS BLAINE MIGRATION WINDOW - not applied
-- =====================================================================
-- OVD-978: restore the client part metadata projection that OVD-670 broke.
--
-- This is a DRAFT. It must not be copied into supabase/migrations/ or applied
-- to any database outside a Blaine-approved migration window. When approved,
-- it ships as ONE migration (next timestamp from `npm run migration:new`), and
-- in the same change:
--   * supabase/tests/pending/ovd978_client_part_metadata_projection.sql.pending
--     is renamed to supabase/tests/ovd978_client_part_metadata_projection.sql;
--   * docs/migration-drafts/ovd-978-no-drawing-test.patch is applied to
--     supabase/tests/client_part_metadata_no_drawing_lifecycle.sql (that test
--     reads the nested `clientExtraction` shape this draft removes).
-- Rollback: docs/migration-drafts/ovd-978.rollback.sql.
-- Notes and evidence: docs/migration-drafts/ovd-978-notes.md.
--
-- Requires: 20261011170000_fix_no_drawing_lifecycle.sql,
-- 20261015074957_ovd736_revoke_anon_definer_execute.sql and
-- 20261031052436_ovd746_client_rpc_auth_gate.sql (applied). OVD-746 moved this
-- body to private.api_list_client_part_metadata(uuid[]) behind a public
-- wrapper that refuses unverified callers, so this draft replaces the private
-- body and leaves the wrapper alone.
--
-- Transaction: no begin/commit of its own. The migration runner wraps it in
-- one transaction. By hand:
--   psql --single-transaction -v ON_ERROR_STOP=1 -f <file>
--
-- Why: 20261011170000 (OVD-670, PR #640) rewrote public.api_list_client_part_metadata.
-- Its one intended change was lifecycle 'succeeded' (not 'uploaded') for a part
-- with no drawing. It also (a) nested every extraction key under
-- `clientExtraction`, while normalizeClientPartMetadata (src/features/quotes/utils.ts)
-- reads them at the top level, so every part shows lifecycle "uploaded" /
-- "Waiting for drawing metadata" and the workspace keeps polling; (b) read
-- `missingFields` and `warnings` from the extraction payload, which the worker
-- (buildStoredExtractionPayload, worker/src/extraction/sharedResult.ts) never
-- writes: warnings live in drawing_extractions.warnings, which the client may
-- count but must never read (see "Data boundary" below); (c) dropped the
-- extraction fallbacks for description, part number, revision, material,
-- finish, threads and tolerance, the projectPartProperties block and the
-- property overrides, the requirement timestamps in updatedAt (which became
-- "-infinity" for a part with no extraction or task), and the quote quantity
-- normalisation.
--
-- This body is the 20260402120000 definition byte for byte, with these
-- changes:
--   1. the first lifecycle branch returns 'succeeded' for a part with no
--      drawing (OVD-670's intended fix) instead of 'uploaded';
--   2. and 3. the last material and finish fallbacks read the payload key
--      only when it is a JSON string. The worker always writes `material` and
--      `finish` as objects, so when their raw and normalized values are null
--      (every CAD-only extraction, and drawings with no material callout)
--      `->> 'material'` returned the whole object as text and the client
--      showed `{"raw": null, ...}` as the material (and never listed material
--      or finish as missing). Found by the OVD-978 harness with the real
--      worker payload; present in 20260402 since April;
--   4. the warning text no longer leaves the database (below). `warnings` is
--      always `[]`, and `warningCount` counts only the warnings that mean a
--      field needs review.
--
-- Data boundary: drawing_extractions is internal-only under RLS
-- (drawing_extractions_internal_only); this SECURITY DEFINER function is the
-- one path from it to a client. The worker writes raw operator diagnostics
-- into drawing_extractions.warnings: the provider SDK error message for a
-- failed model call, and the spend guard's reason for a refused one (per-run
-- ceiling figures, the operator kill switch, ledger database errors). The
-- 20260402 body returned that column to every member of the organisation. This
-- body does not return any warning text. The client UI reads only
-- `warningCount` (ClientExtractionStatusNotice, countPartExtractionWarnings);
-- it never renders the strings. The count skips the two operator diagnostics,
-- which the worker writes under the 'Model fallback ' prefix
-- (worker/src/extraction/hybridExtraction.ts): they say a model call did not
-- run, not that a field needs review, and counting them made a part with
-- nothing to review read "partial". Every other warning still counts, so a
-- warning the worker adds later is counted rather than silently dropped. A
-- warning column that is not a JSON array counts as zero instead of failing
-- the whole call.
--
-- Security: same signature, return type, language, volatility, SECURITY
-- DEFINER and `set search_path = public` as the definition it replaces.
-- CREATE OR REPLACE keeps the owner and the ACL. The REVOKE at the end
-- restates the OVD-746 end state for the private body (no grant to PUBLIC,
-- anon, authenticated or service_role; only the public wrapper calls it); it
-- is a no-op where OVD-746 is applied and never widens anything. The access
-- check (public.user_can_access_job) is unchanged.

create or replace function private.api_list_client_part_metadata(
  p_job_ids uuid[]
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with requested_jobs as (
    select distinct job.id, job.organization_id, job.status
    from public.jobs job
    where job.id = any(coalesce(p_job_ids, '{}'::uuid[]))
      and public.user_can_access_job(job.id)
  ),
  latest_extract_tasks as (
    select distinct on (queue.part_id)
      queue.part_id,
      queue.status,
      queue.last_error,
      queue.payload,
      queue.created_at,
      queue.updated_at
    from public.work_queue queue
    join requested_jobs job on job.id = queue.job_id
    where queue.task_type = 'extract_part'
      and queue.part_id is not null
    order by queue.part_id, queue.created_at desc, queue.id desc
  ),
  part_projection as (
    select
      part.id as part_id,
      part.job_id,
      part.organization_id,
      part.quantity as part_quantity,
      (part.cad_file_id is not null) as has_cad_file,
      (part.drawing_file_id is not null) as has_drawing_file,
      requirement.id as requirement_id,
      requirement.description as requirement_description,
      requirement.part_number as requirement_part_number,
      requirement.revision as requirement_revision,
      requirement.created_at as requirement_created_at,
      requirement.updated_at as requirement_updated_at,
      requirement.material as requirement_material,
      requirement.finish as requirement_finish,
      requirement.tightest_tolerance_inch as requirement_tightest_tolerance_inch,
      requirement.quantity as requirement_quantity,
      requirement.quote_quantities as requirement_quote_quantities,
      requirement.requested_by_date as requirement_requested_by_date,
      nullif(trim(coalesce(requirement.spec_snapshot ->> 'process', '')), '') as requirement_process,
      nullif(trim(coalesce(requirement.spec_snapshot ->> 'notes', '')), '') as requirement_notes,
      nullif(trim(coalesce(requirement.spec_snapshot ->> 'quoteDescription', '')), '') as requirement_quote_description,
      nullif(trim(coalesce(requirement.spec_snapshot ->> 'quoteFinish', '')), '') as requirement_quote_finish,
      nullif(trim(coalesce(requirement.spec_snapshot ->> 'threads', '')), '') as requirement_threads,
      coalesce(requirement.spec_snapshot -> 'projectPartProperties', '{}'::jsonb) as project_property_state,
      coalesce(requirement.spec_snapshot #> '{projectPartProperties,defaults}', '{}'::jsonb) as project_property_defaults,
      coalesce(requirement.spec_snapshot #> '{projectPartProperties,overrides}', '{}'::jsonb) as project_property_overrides,
      nullif(trim(coalesce(requirement.spec_snapshot #>> '{projectPartProperties,createdAt}', '')), '') as project_property_created_at,
      nullif(trim(coalesce(requirement.spec_snapshot #>> '{projectPartProperties,updatedAt}', '')), '') as project_property_updated_at,
      extraction.id as extraction_id,
      extraction.extraction,
      extraction.updated_at as extraction_updated_at,
      latest_task.status as latest_task_status,
      latest_task.last_error as latest_task_error,
      latest_task.payload as latest_task_payload,
      latest_task.updated_at as latest_task_updated_at,
      -- Count only. drawing_extractions.warnings holds raw operator text and is
      -- internal-only, so it is never selected into the projection.
      (
        select count(*)::integer
        from jsonb_array_elements_text(
          case
            when jsonb_typeof(extraction.warnings) = 'array' then extraction.warnings
            else '[]'::jsonb
          end
        ) as warning_entries(value)
        where coalesce(warning_entries.value, '') not like 'Model fallback %'
      ) as warning_count,
      array_to_string(
        array(
          select trimmed_thread
          from (
            select nullif(trim(value), '') as trimmed_thread
            from jsonb_array_elements_text(coalesce(extraction.extraction -> 'threads', '[]'::jsonb)) as thread_values(value)
          ) trimmed_threads
          where trimmed_thread is not null
        ),
        ', '
      ) as extracted_threads,
      coalesce(
        nullif(trim(coalesce(requirement.spec_snapshot #>> '{projectPartProperties,overrides,description}', '')), ''),
        nullif(trim(coalesce(requirement.spec_snapshot ->> 'quoteDescription', '')), ''),
        nullif(trim(coalesce(requirement.description, '')), ''),
        nullif(trim(coalesce(extraction.extraction ->> 'quoteDescription', '')), ''),
        nullif(trim(coalesce(extraction.extraction ->> 'description', extraction.extraction ->> 'desc', '')), ''),
        null
      ) as resolved_description,
      coalesce(
        nullif(trim(coalesce(requirement.spec_snapshot #>> '{projectPartProperties,overrides,partNumber}', '')), ''),
        nullif(trim(coalesce(requirement.part_number, '')), ''),
        nullif(trim(coalesce(requirement.spec_snapshot ->> 'partNumber', '')), ''),
        nullif(trim(coalesce(extraction.extraction ->> 'partNumber', extraction.extraction ->> 'pn', '')), ''),
        null
      ) as resolved_part_number,
      coalesce(
        nullif(trim(coalesce(requirement.revision, '')), ''),
        nullif(trim(coalesce(requirement.spec_snapshot ->> 'revision', '')), ''),
        nullif(trim(coalesce(extraction.extraction ->> 'revision', extraction.extraction ->> 'rev', '')), ''),
        null
      ) as resolved_revision,
      coalesce(
        nullif(trim(coalesce(requirement.spec_snapshot #>> '{projectPartProperties,overrides,material}', '')), ''),
        nullif(trim(coalesce(requirement.material, '')), ''),
        nullif(trim(coalesce(
          extraction.extraction #>> '{material,normalized}',
          extraction.extraction #>> '{material,raw}',
          extraction.extraction #>> '{material,raw_text}',
          case when jsonb_typeof(extraction.extraction -> 'material') = 'string' then extraction.extraction ->> 'material' end,
          ''
        )), ''),
        ''
      ) as resolved_material,
      coalesce(
        nullif(trim(coalesce(requirement.spec_snapshot #>> '{projectPartProperties,overrides,finish}', '')), ''),
        nullif(trim(coalesce(requirement.spec_snapshot ->> 'quoteFinish', '')), ''),
        nullif(trim(coalesce(requirement.finish, '')), ''),
        nullif(trim(coalesce(
          extraction.extraction ->> 'quoteFinish',
          extraction.extraction #>> '{finish,normalized}',
          extraction.extraction #>> '{finish,raw}',
          extraction.extraction #>> '{finish,raw_text}',
          case when jsonb_typeof(extraction.extraction -> 'finish') = 'string' then extraction.extraction ->> 'finish' end,
          ''
        )), ''),
        null
      ) as resolved_finish,
      coalesce(
        nullif(trim(coalesce(requirement.spec_snapshot #>> '{projectPartProperties,overrides,threads}', '')), ''),
        nullif(trim(coalesce(requirement.spec_snapshot ->> 'threads', '')), ''),
        array_to_string(
          array(
            select trimmed_thread
            from (
              select nullif(trim(value), '') as trimmed_thread
              from jsonb_array_elements_text(coalesce(extraction.extraction -> 'threads', '[]'::jsonb)) as thread_values(value)
            ) trimmed_threads
            where trimmed_thread is not null
          ),
          ', '
        ),
        null
      ) as resolved_threads,
      coalesce(
        nullif(requirement.spec_snapshot #>> '{projectPartProperties,overrides,tightestToleranceInch}', '')::numeric,
        requirement.tightest_tolerance_inch,
        nullif(extraction.extraction #>> '{tolerances,valueInch}', '')::numeric
      ) as resolved_tightest_tolerance_inch,
      coalesce(
        nullif(trim(coalesce(requirement.spec_snapshot ->> 'process', '')), ''),
        null
      ) as resolved_process,
      coalesce(
        nullif(trim(coalesce(requirement.spec_snapshot ->> 'notes', '')), ''),
        null
      ) as resolved_notes,
      coalesce(
        requirement.quantity,
        part.quantity,
        1
      ) as resolved_quantity,
      public.normalize_positive_integer_array(
        coalesce(requirement.quote_quantities, '{}'::integer[]),
        coalesce(requirement.quantity, part.quantity, 1)
      ) as resolved_quote_quantities,
      requirement.requested_by_date as resolved_requested_by_date,
      coalesce(nullif(extraction.extraction ->> 'pageCount', '')::integer, 0) as page_count,
      array_remove(
        array[
          case when coalesce(nullif(extraction.extraction #>> '{extractedDescriptionRaw,reviewNeeded}', '')::boolean, false) then 'description' end,
          case when coalesce(nullif(extraction.extraction #>> '{extractedPartNumberRaw,reviewNeeded}', '')::boolean, false) then 'partNumber' end,
          case when coalesce(nullif(extraction.extraction #>> '{extractedRevisionRaw,reviewNeeded}', '')::boolean, false) then 'revision' end,
          case when coalesce(nullif(extraction.extraction #>> '{material,reviewNeeded}', '')::boolean, false) then 'material' end,
          case when coalesce(nullif(extraction.extraction #>> '{extractedFinishRaw,reviewNeeded}', '')::boolean, false) then 'finish' end
        ],
        null
      ) as review_fields
    from public.parts part
    join requested_jobs job on job.id = part.job_id
    left join public.approved_part_requirements requirement on requirement.part_id = part.id
    left join public.drawing_extractions extraction on extraction.part_id = part.id
    left join latest_extract_tasks latest_task on latest_task.part_id = part.id
  ),
  projection_with_missing as (
    select
      projection.*,
      array_remove(
        array[
          case when projection.resolved_description is null then 'description' end,
          case when projection.resolved_part_number is null then 'partNumber' end,
          case when projection.resolved_revision is null then 'revision' end,
          case when nullif(trim(coalesce(projection.resolved_material, '')), '') is null then 'material' end,
          case when projection.resolved_finish is null then 'finish' end,
          case when projection.resolved_tightest_tolerance_inch is null then 'tightestToleranceInch' end
        ],
        null
      ) as missing_fields
    from part_projection projection
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'partId', projection.part_id,
        'jobId', projection.job_id,
        'organizationId', projection.organization_id,
        'hasCadFile', projection.has_cad_file,
        'hasDrawingFile', projection.has_drawing_file,
        'description', projection.resolved_description,
        'partNumber', projection.resolved_part_number,
        'revision', projection.resolved_revision,
        'quoteDescription', projection.requirement_quote_description,
        'material', nullif(trim(coalesce(projection.resolved_material, '')), ''),
        'finish', projection.resolved_finish,
        'quoteFinish', projection.requirement_quote_finish,
        'threads', projection.resolved_threads,
        'tightestToleranceInch', projection.resolved_tightest_tolerance_inch,
        'process', projection.resolved_process,
        'notes', projection.resolved_notes,
        'quantity', greatest(coalesce(projection.resolved_quantity, 1), 1),
        'quoteQuantities', projection.resolved_quote_quantities,
        'requestedByDate', projection.resolved_requested_by_date,
        'projectPartProperties',
          case
            when projection.project_property_created_at is null
              and projection.project_property_updated_at is null
              and projection.project_property_defaults = '{}'::jsonb
              and projection.project_property_overrides = '{}'::jsonb
              then null
            else jsonb_build_object(
              'defaults', projection.project_property_defaults,
              'overrides', projection.project_property_overrides,
              'createdAt', projection.project_property_created_at,
              'updatedAt', projection.project_property_updated_at
            )
          end,
        'pageCount', projection.page_count,
        'warningCount', projection.warning_count,
        -- Always empty: warning text is internal-only, the client reads warningCount.
        'warnings', '[]'::jsonb,
        'missingFields', to_jsonb(coalesce(projection.missing_fields, array[]::text[])),
        'reviewFields', to_jsonb(coalesce(projection.review_fields, array[]::text[])),
        'lastFailureCode', nullif(trim(coalesce(projection.latest_task_payload ->> 'failureCode', '')), ''),
        'lastFailureMessage', nullif(trim(coalesce(projection.latest_task_error, projection.latest_task_payload ->> 'failureMessage', '')), ''),
        'extractedAt', projection.extraction_updated_at,
        'failedAt',
          case
            when projection.latest_task_status = 'failed' then projection.latest_task_updated_at
            else null
          end,
        'updatedAt',
          nullif(
            greatest(
              coalesce(projection.requirement_updated_at, '-infinity'::timestamptz),
              coalesce(projection.extraction_updated_at, '-infinity'::timestamptz),
              coalesce(projection.latest_task_updated_at, '-infinity'::timestamptz),
              coalesce(projection.requirement_created_at, '-infinity'::timestamptz)
            ),
            '-infinity'::timestamptz
          ),
        'lifecycle',
          case
            when not projection.has_drawing_file then 'succeeded'
            when projection.latest_task_status = 'queued' then 'queued'
            when projection.latest_task_status = 'running' then 'extracting'
            when projection.latest_task_status = 'failed'
              and (
                projection.extraction_updated_at is null
                or projection.latest_task_updated_at >= projection.extraction_updated_at
              ) then 'failed'
            when projection.extraction_id is null and projection.has_drawing_file then 'extracting'
            when coalesce(array_length(projection.missing_fields, 1), 0) > 0
              or coalesce(array_length(projection.review_fields, 1), 0) > 0
              or projection.warning_count > 0 then 'partial'
            else 'succeeded'
          end
      )
      order by projection.job_id, projection.part_id
    ),
    '[]'::jsonb
  )
  from projection_with_missing projection;
$$;

revoke all on function private.api_list_client_part_metadata(uuid[]) from public, anon, authenticated, service_role;
