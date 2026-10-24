-- =====================================================================
-- OVD-979 (part a, finding 3f): public.api_auto_approve_job_requirements(uuid)
-- respects overrides saved through the client property editor, and (fix round
-- 7) public.load_editable_project_part_context(uuid) serializes the client save
-- and reset with it.
--
-- This file and docs/migration-drafts/ovd-979-a.sql are byte-identical copies
-- of one reviewed definition (apply a, then b). It is not applied to
-- production: that is a protected action that needs a Blaine-approved migration
-- window. Rollback: docs/migration-drafts/ovd-979-a.rollback.sql. Notes:
-- docs/migration-drafts/ovd-979-notes.md.
--
-- Problem: since 20260402120000 / 20260408120000, api_update_client_part_request
-- records user corrections in spec_snapshot.projectPartProperties.overrides and
-- no longer writes spec_snapshot.fieldSources = 'user'. This function (latest
-- definition 20260317013000) decides ownership only from fieldSources, so an
-- extraction that finishes after the user saved (extraction updated_at newer
-- than the requirement) overwrites description, part number, revision and
-- finish (and quoteDescription / quoteFinish) with extracted values.
--
-- Changes (revision 1), and nothing else:
--   1. Ownership (option (b) of the issue):
--        user_owned(field) := fieldSources[field] <> 'auto'
--                             OR projectPartProperties.overrides ? field
--      and each "refresh from newer extraction" branch tests
--        refresh(field) := not user_owned and extraction newer and no review.
--   2. When a field is refreshed, projectPartProperties.defaults[field] gets
--      the refreshed value (only when a defaults object exists), so reset
--      resolves to it and a later save records no spurious override (R1).
--   3. A requirement material equal to the 'Unknown material' placeholder is
--      replaced by the extracted material when the extraction has one and
--      material is not user-owned (no overrides.material key,
--      fieldSources.material absent or 'auto'); the default follows (R2).
--   4. For a part that has an extract_part task with reason 'drawing_attached'
--      (queued by ovd-979-b.sql, any status), tolerance is never filled from
--      the extraction; it keeps the requirement value (R3, OVD-976).
--   5. The job status rollup only updates jobs in uploaded, extracting,
--      needs_spec_review or ready_to_quote; quoting and later are kept (R4).
--   6. Review r2, M1: when a newer extraction completes, the editor default of
--      a field the user owns through an override (description, partNumber,
--      revision, finish) moves to the extracted value. The column is not
--      touched, so the correction survives, and a later reset returns the field
--      to the drawing value without waiting for another extraction. A field
--      owned only through the legacy fieldSources has no override to reset and
--      keeps its default; an extraction with no value, a field flagged for
--      review and an extraction not newer than the requirement change nothing.
--   7. Review r2: the fieldSources and fieldOverrides objects written back keep
--      keys other than the four rebuilt ones (a fieldSources.material = 'user'
--      is what keeps the 'Unknown material' placeholder from being replaced on
--      every later run).
--   8. Review r3 (Codex 1), rollup: the worker runs this function while its own
--      extract_part task is still 'running' and marks the task completed only
--      afterwards (both paths in worker/src/index.ts), so that task kept the
--      job 'extracting' for good. A running drawing_attached task whose part
--      already holds a stored extraction that is not CAD-only (extractor_version
--      not like 'worker-sim-%') is finishing and no longer counts as pending.
--      A queued task, a running task of a never-extracted part (its status flow
--      is unchanged from main) and a running attach task that has not stored
--      its extraction yet still count.
--   9. Review r3 (Codex 2), rollup: a failed extract_part task no longer counts
--      once a later extract_part task of the same part (by created_at) is
--      queued, running or completed. api_request_extraction retries a failure by
--      inserting a new task and keeping the failed row as the record, which
--      otherwise pinned the job to needs_spec_review after the retry succeeded.
--      A failure with no later task, and a failure followed only by failed or
--      cancelled tasks, still counts.
--  10. Fix round 7 (Codex, high): a user save or reset that committed after this
--      function had read the requirement was overwritten by its upsert (values
--      and override keys). The function now locks the job row first
--      (SELECT ... FOR NO KEY UPDATE), before it reads anything it writes back,
--      and public.load_editable_project_part_context(uuid), which
--      api_update_client_part_request and api_reset_client_part_property_overrides
--      call before they read anything, takes the same lock (redefined below,
--      otherwise verbatim from 20260402120000). See LOCK ORDER below.
--  11. Fix round 7 (Codex, medium): the item 8 exemption needs completion
--      evidence of the CURRENT claim: the part's stored extraction must have
--      been written after the task was claimed (stored.updated_at >
--      queue.locked_at). A retry starts with the row its failed attempt stored,
--      which is older than the retry's claim, so the retry is pending until it
--      stores its own result (the worker's upsert stamps updated_at through the
--      touch trigger; the trusted reuse stamps a kept row, migration b). The
--      set of such tasks is read before the function changes any row, because
--      its own status updates below are stamped by the same trigger. This
--      replaces the inline predicate of item 8 (and with it the null-safe
--      'reason' comparison, which a filter no longer needs).
--  12. Fix round 7, so that item 11 holds: this function no longer changes the
--      status of an extraction row that is older than the claim of a running
--      drawing_attached task of its part (the touch trigger would stamp it and
--      fake the evidence of item 11). The running claim replaces the row and its
--      own auto-approval run sets the status.
-- LOCK ORDER (fix round 7). Every path that writes the approved requirement of a
-- part takes the row locks of one job in this order, and takes the first one
-- before it reads anything it writes back:
--   1. public.jobs row of the job (FOR NO KEY UPDATE; an UPDATE of the row takes
--      the same lock mode, and neither blocks the FOR KEY SHARE of a foreign-key
--      check, so inserts that reference the job are not serialized);
--   2. public.parts rows of the job;
--   3. public.approved_part_requirements rows;
--   4. public.drawing_extractions rows;
--   5. public.work_queue rows.
-- Paths: this function (1, then 2 to 4 per part; it only reads work_queue);
-- api_update_client_part_request and api_reset_client_part_property_overrides
-- (1 in load_editable_project_part_context, then their writes, all under 1);
-- api_request_extraction (migration b: its advisory lock, then 1, then 2 through
-- api_reconcile_job_parts, then 5); the worker's task settlement and the trigger
-- that releases a deferred drawing extraction (migration b: 5 only). The
-- triggers on these tables (touch_*_updated_at, the part deadline history and
-- the canonical version assignment) only write the row being changed or private
-- history rows, so they add no edge. While a path holds 1, the order of its later
-- row locks cannot deadlock with another path that takes 1 first.
-- Not changed: api_approve_job_requirements (internal approval) does not take 1
-- (requirements, parts, extractions, then the job). It already took its locks in
-- a different order than this function did on main; it is a staff action and
-- out of scope here (see the notes).
-- Body otherwise verbatim from 20260317013000 (generated and diffed by
-- gen-draft-a.mjs in the OVD-979 harness). Not changed: quantities, vendors,
-- audit event, return value, and the values written for the four legacy
-- fieldSources / fieldOverrides keys (still the legacy provenance, so a reset
-- that removes an override key is not made sticky).
-- Security: SECURITY DEFINER kept; set search_path = pg_catalog, public
-- (Blaine decision, 2026-10-18: the previous "public" fails the security-definer
-- lint; every relation in the body is schema-qualified, so behavior is the
-- same); CREATE OR REPLACE keeps owner and ACL; the OVD-535 revoke/grant is restated
-- verbatim (EXECUTE for service_role only). No grant is widened.
-- load_editable_project_part_context (fix round 7) keeps SECURITY DEFINER and
-- its access checks, which still run first (require_verified_auth(), then
-- user_can_edit_job()); search_path becomes pg_catalog, public for the same
-- lint, and its OVD-736 revoke/grant (service_role only) is restated verbatim.
-- =====================================================================

begin;

create or replace function public.api_auto_approve_job_requirements(p_job_id uuid)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_job public.jobs%rowtype;
  v_part public.parts%rowtype;
  v_requirement public.approved_part_requirements%rowtype;
  v_extraction public.drawing_extractions%rowtype;
  v_requested_service_kinds text[];
  v_primary_service_kind text;
  v_requires_material boolean;
  v_material text;
  v_finish text;
  v_tightest_tolerance_inch numeric;
  v_quantity integer;
  v_quote_quantities integer[];
  v_requested_by_date date;
  v_applicable_vendors public.vendor_name[] := array[]::public.vendor_name[];
  v_spec_snapshot jsonb;
  v_process text;
  v_notes text;
  v_description text;
  v_part_number text;
  v_revision text;
  v_quote_description text;
  v_quote_finish text;
  v_description_source text;
  v_part_number_source text;
  v_revision_source text;
  v_finish_source text;
  -- OVD-979: ownership. A field is user-owned when its legacy provenance
  -- (spec_snapshot.fieldSources, written by the internal approval RPC and the
  -- March client RPC) is not 'auto', OR when the client property editor stored
  -- an override for it (spec_snapshot.projectPartProperties.overrides has the
  -- key; written by api_update_client_part_request, removed by
  -- api_reset_client_part_property_overrides).
  v_property_overrides jsonb := '{}'::jsonb;
  v_description_user_owned boolean := false;
  v_part_number_user_owned boolean := false;
  v_revision_user_owned boolean := false;
  v_finish_user_owned boolean := false;
  -- OVD-979: a field is refreshed from the extraction when it is not
  -- user-owned, the extraction is newer and the field needs no review.
  v_description_refresh boolean := false;
  v_part_number_refresh boolean := false;
  v_revision_refresh boolean := false;
  v_finish_refresh boolean := false;
  -- OVD-979 (review r2, M1): what the extraction itself says for each editor
  -- field (null when it says nothing). Used to move the editor default of a
  -- field the user owns; a refreshed field keeps its own expressions below.
  v_extracted_description text;
  v_extracted_part_number text;
  v_extracted_revision text;
  v_extracted_finish text;
  -- OVD-979: the 'Unknown material' placeholder is replaced by an extracted
  -- material unless the user owns material.
  v_material_placeholder_replaced boolean := false;
  -- OVD-979: the part has (ever had) an extract_part task queued by a drawing
  -- attach (api_request_extraction, reason 'drawing_attached').
  v_drawing_attached boolean := false;
  -- OVD-979 (fix round 7): the part's extraction row is older than the claim of
  -- a running drawing_attached task of the part, which will replace it.
  v_extraction_before_claim boolean := false;
  -- OVD-979 (fix round 7): running drawing_attached tasks that stored their
  -- result during their current claim (header item 11).
  v_finishing_attach_tasks uuid[] := '{}'::uuid[];
  v_property_defaults jsonb;
  v_description_review_needed boolean := false;
  v_part_number_review_needed boolean := false;
  v_revision_review_needed boolean := false;
  v_finish_review_needed boolean := false;
  v_has_review_blocker boolean := false;
  v_extraction_newer boolean := false;
  v_count integer := 0;
  v_timestamp timestamptz := timezone('utc', now());
  v_pending_extract_tasks integer := 0;
  v_failed_extract_tasks integer := 0;
  v_unapproved_parts integer := 0;
begin
  -- OVD-979 (fix round 7): lock 1 of the LOCK ORDER in the header, taken before
  -- any requirement is read. A user save or reset in flight finishes first and
  -- this function then reads what it committed; a save or reset that starts
  -- later waits until this function commits.
  select *
  into v_job
  from public.jobs
  where id = p_job_id
  for no key update;

  if v_job.id is null then
    raise exception 'Job % not found.', p_job_id;
  end if;

  v_requested_service_kinds := public.normalize_requested_service_kinds(
    v_job.requested_service_kinds,
    v_job.primary_service_kind
  );
  v_primary_service_kind := public.normalize_primary_service_kind(
    v_job.requested_service_kinds,
    v_job.primary_service_kind
  );
  v_requires_material := 'manufacturing_quote' = any(v_requested_service_kinds);

  -- OVD-979 (fix round 7, header item 11): read before the loop below, whose
  -- status updates stamp drawing_extractions.updated_at, so the evidence is the
  -- time the worker (or the trusted reuse) wrote the row and never this run's
  -- own write.
  select coalesce(array_agg(queue.id), '{}'::uuid[])
  into v_finishing_attach_tasks
  from public.work_queue queue
  where queue.job_id = p_job_id
    and queue.task_type = 'extract_part'
    and queue.status = 'running'
    and queue.payload ->> 'reason' = 'drawing_attached'
    and exists (
      select 1
      from public.drawing_extractions stored
      where stored.part_id = queue.part_id
        and stored.extractor_version not like 'worker-sim-%'
        and stored.updated_at > queue.locked_at
    );

  for v_part in
    select *
    from public.parts
    where job_id = p_job_id
    order by created_at asc
  loop
    select *
    into v_requirement
    from public.approved_part_requirements
    where part_id = v_part.id;

    select *
    into v_extraction
    from public.drawing_extractions
    where part_id = v_part.id;

    if v_requirement.id is null and v_extraction.id is null then
      continue;
    end if;

    v_description_review_needed := coalesce(nullif(v_extraction.extraction #>> '{extractedDescriptionRaw,reviewNeeded}', '')::boolean, false);
    v_part_number_review_needed := coalesce(nullif(v_extraction.extraction #>> '{extractedPartNumberRaw,reviewNeeded}', '')::boolean, false);
    v_revision_review_needed := coalesce(nullif(v_extraction.extraction #>> '{extractedRevisionRaw,reviewNeeded}', '')::boolean, false);
    v_finish_review_needed := coalesce(nullif(v_extraction.extraction #>> '{extractedFinishRaw,reviewNeeded}', '')::boolean, false);
    v_has_review_blocker := v_description_review_needed or v_part_number_review_needed or v_revision_review_needed or v_finish_review_needed;
    v_extraction_newer := v_extraction.id is not null and (
      v_requirement.id is null
      or v_requirement.updated_at is null
      or v_extraction.updated_at > v_requirement.updated_at
    );

    v_description_source := coalesce(
      nullif(trim(coalesce(v_requirement.spec_snapshot #>> '{fieldSources,description}', '')), ''),
      'auto'
    );
    v_part_number_source := coalesce(
      nullif(trim(coalesce(v_requirement.spec_snapshot #>> '{fieldSources,partNumber}', '')), ''),
      'auto'
    );
    v_revision_source := coalesce(
      nullif(trim(coalesce(v_requirement.spec_snapshot #>> '{fieldSources,revision}', '')), ''),
      'auto'
    );
    v_finish_source := coalesce(
      nullif(trim(coalesce(v_requirement.spec_snapshot #>> '{fieldSources,finish}', '')), ''),
      'auto'
    );
    -- OVD-979: assigned on every iteration (a part with no requirement row
    -- leaves v_requirement all null, so this is '{}').
    v_property_overrides := case
      when jsonb_typeof(v_requirement.spec_snapshot #> '{projectPartProperties,overrides}') = 'object'
        then v_requirement.spec_snapshot #> '{projectPartProperties,overrides}'
      else '{}'::jsonb
    end;
    v_description_user_owned := v_description_source <> 'auto' or v_property_overrides ? 'description';
    v_part_number_user_owned := v_part_number_source <> 'auto' or v_property_overrides ? 'partNumber';
    v_revision_user_owned := v_revision_source <> 'auto' or v_property_overrides ? 'revision';
    v_finish_user_owned := v_finish_source <> 'auto' or v_property_overrides ? 'finish';
    v_description_refresh := not v_description_user_owned and v_extraction_newer and not v_description_review_needed;
    v_part_number_refresh := not v_part_number_user_owned and v_extraction_newer and not v_part_number_review_needed;
    v_revision_refresh := not v_revision_user_owned and v_extraction_newer and not v_revision_review_needed;
    v_finish_refresh := not v_finish_user_owned and v_extraction_newer and not v_finish_review_needed;
    v_material_placeholder_replaced := trim(coalesce(v_requirement.material, '')) = 'Unknown material'
      and not (v_property_overrides ? 'material')
      and coalesce(nullif(trim(coalesce(v_requirement.spec_snapshot #>> '{fieldSources,material}', '')), ''), 'auto') = 'auto'
      and nullif(trim(coalesce(
        v_extraction.extraction #>> '{material,normalized}',
        v_extraction.extraction #>> '{material,raw}',
        v_extraction.extraction #>> '{material,raw_text}',
        ''
      )), '') is not null;
    v_extracted_description := coalesce(
      nullif(trim(coalesce(v_extraction.extraction ->> 'quoteDescription', '')), ''),
      nullif(trim(coalesce(v_extraction.extraction ->> 'description', v_extraction.extraction ->> 'desc', '')), '')
    );
    v_extracted_part_number := nullif(trim(coalesce(v_extraction.extraction ->> 'partNumber', v_extraction.extraction ->> 'pn', '')), '');
    v_extracted_revision := nullif(trim(coalesce(v_extraction.extraction ->> 'revision', v_extraction.extraction ->> 'rev', '')), '');
    v_extracted_finish := coalesce(
      nullif(trim(coalesce(v_extraction.extraction ->> 'quoteFinish', '')), ''),
      nullif(trim(coalesce(
        v_extraction.extraction #>> '{finish,normalized}',
        v_extraction.extraction #>> '{finish,raw}',
        v_extraction.extraction #>> '{finish,raw_text}',
        ''
      )), '')
    );
    v_drawing_attached := exists (
      select 1
      from public.work_queue queue
      where queue.job_id = p_job_id
        and queue.part_id = v_part.id
        and queue.task_type = 'extract_part'
        and queue.payload ->> 'reason' = 'drawing_attached'
    );
    v_extraction_before_claim := v_extraction.id is not null and exists (
      select 1
      from public.work_queue claim
      where claim.job_id = p_job_id
        and claim.part_id = v_part.id
        and claim.task_type = 'extract_part'
        and claim.status = 'running'
        and claim.payload ->> 'reason' = 'drawing_attached'
        and claim.locked_at >= v_extraction.updated_at
    );

    v_description := case
      when v_description_refresh then
        coalesce(
          nullif(trim(coalesce(v_extraction.extraction ->> 'quoteDescription', '')), ''),
          nullif(trim(coalesce(v_extraction.extraction ->> 'description', v_extraction.extraction ->> 'desc', '')), ''),
          nullif(trim(coalesce(v_requirement.description, '')), ''),
          null
        )
      else
        coalesce(
          nullif(trim(coalesce(v_requirement.description, '')), ''),
          nullif(trim(coalesce(v_requirement.spec_snapshot ->> 'quoteDescription', '')), ''),
          nullif(trim(coalesce(v_extraction.extraction ->> 'quoteDescription', '')), ''),
          nullif(trim(coalesce(v_extraction.extraction ->> 'description', v_extraction.extraction ->> 'desc', '')), ''),
          null
        )
    end;
    v_part_number := case
      when v_part_number_refresh then
        coalesce(
          nullif(trim(coalesce(v_extraction.extraction ->> 'partNumber', v_extraction.extraction ->> 'pn', '')), ''),
          nullif(trim(coalesce(v_requirement.part_number, '')), ''),
          null
        )
      else
        coalesce(
          nullif(trim(coalesce(v_requirement.part_number, '')), ''),
          nullif(trim(coalesce(v_extraction.extraction ->> 'partNumber', v_extraction.extraction ->> 'pn', '')), ''),
          null
        )
    end;
    v_revision := case
      when v_revision_refresh then
        coalesce(
          nullif(trim(coalesce(v_extraction.extraction ->> 'revision', v_extraction.extraction ->> 'rev', '')), ''),
          nullif(trim(coalesce(v_requirement.revision, '')), ''),
          null
        )
      else
        coalesce(
          nullif(trim(coalesce(v_requirement.revision, '')), ''),
          nullif(trim(coalesce(v_extraction.extraction ->> 'revision', v_extraction.extraction ->> 'rev', '')), ''),
          null
        )
    end;
    v_material := coalesce(
      -- OVD-979: 'Unknown material' written by an earlier auto-approval is
      -- replaced by an extracted material unless the user owns material.
      case when v_material_placeholder_replaced then null
        else nullif(trim(coalesce(v_requirement.material, '')), '') end,
      nullif(trim(coalesce(
        v_extraction.extraction #>> '{material,normalized}',
        v_extraction.extraction #>> '{material,raw}',
        v_extraction.extraction #>> '{material,raw_text}',
        ''
      )), ''),
      case when v_requires_material then 'Unknown material' else '' end
    );
    v_finish := case
      when v_finish_refresh then
        coalesce(
          nullif(trim(coalesce(v_extraction.extraction ->> 'quoteFinish', '')), ''),
          nullif(trim(coalesce(
            v_extraction.extraction #>> '{finish,normalized}',
            v_extraction.extraction #>> '{finish,raw}',
            v_extraction.extraction #>> '{finish,raw_text}',
            ''
          )), ''),
          nullif(trim(coalesce(v_requirement.finish, '')), ''),
          null
        )
      else
        coalesce(
          nullif(trim(coalesce(v_requirement.finish, '')), ''),
          nullif(trim(coalesce(v_requirement.spec_snapshot ->> 'quoteFinish', '')), ''),
          nullif(trim(coalesce(v_extraction.extraction ->> 'quoteFinish', '')), ''),
          nullif(trim(coalesce(
            v_extraction.extraction #>> '{finish,normalized}',
            v_extraction.extraction #>> '{finish,raw}',
            v_extraction.extraction #>> '{finish,raw_text}',
            ''
          )), ''),
          null
        )
    end;
    v_quote_description := case
      when v_description_refresh then
        coalesce(
          nullif(trim(coalesce(v_extraction.extraction ->> 'quoteDescription', '')), ''),
          nullif(trim(coalesce(v_extraction.extraction ->> 'description', v_extraction.extraction ->> 'desc', '')), ''),
          nullif(trim(coalesce(v_requirement.spec_snapshot ->> 'quoteDescription', '')), ''),
          v_description
        )
      else
        coalesce(
          nullif(trim(coalesce(v_requirement.spec_snapshot ->> 'quoteDescription', '')), ''),
          v_description
        )
    end;
    v_quote_finish := case
      when v_finish_refresh then
        coalesce(
          nullif(trim(coalesce(v_extraction.extraction ->> 'quoteFinish', '')), ''),
          nullif(trim(coalesce(
            v_extraction.extraction #>> '{finish,normalized}',
            v_extraction.extraction #>> '{finish,raw}',
            v_extraction.extraction #>> '{finish,raw_text}',
            ''
          )), ''),
          nullif(trim(coalesce(v_requirement.spec_snapshot ->> 'quoteFinish', '')), ''),
          v_finish
        )
      else
        coalesce(
          nullif(trim(coalesce(v_requirement.spec_snapshot ->> 'quoteFinish', '')), ''),
          v_finish
        )
    end;
    -- OVD-979: after a drawing attach, tolerance keeps the requirement value
    -- (null for a CAD-only part) and is left for the user to confirm. Until
    -- OVD-976 ships, a millimetre drawing is read as inches (OVD-683 gate).
    v_tightest_tolerance_inch := case
      when v_drawing_attached then v_requirement.tightest_tolerance_inch
      else coalesce(
        v_requirement.tightest_tolerance_inch,
        nullif(v_extraction.extraction #>> '{tolerances,valueInch}', '')::numeric
      )
    end;
    v_quantity := greatest(
      coalesce(v_requirement.quantity, v_part.quantity, v_job.requested_quote_quantities[1], 1),
      1
    );
    v_quote_quantities := public.normalize_positive_integer_array(
      coalesce(v_requirement.quote_quantities, v_job.requested_quote_quantities, '{}'::integer[]),
      v_quantity
    );
    v_quantity := coalesce(v_quote_quantities[1], v_quantity, 1);
    v_requested_by_date := coalesce(v_requirement.requested_by_date, v_job.requested_by_date);
    v_process := nullif(trim(coalesce(v_requirement.spec_snapshot ->> 'process', '')), '');
    v_notes := nullif(trim(coalesce(v_requirement.spec_snapshot ->> 'notes', '')), '');

    if coalesce(array_length(v_requirement.applicable_vendors, 1), 0) > 0 then
      v_applicable_vendors := v_requirement.applicable_vendors;
    else
      v_applicable_vendors := array['xometry', 'fictiv', 'protolabs']::public.vendor_name[];

      if coalesce(v_tightest_tolerance_inch, 0.005) >= 0.005 then
        v_applicable_vendors := array_append(v_applicable_vendors, 'sendcutsend'::public.vendor_name);
      end if;
    end if;

    update public.parts
    set
      quantity = v_quantity,
      updated_at = v_timestamp
    where id = v_part.id;

    if v_requirement.id is null and v_has_review_blocker then
      -- OVD-979 (fix round 7): a row older than a running attach claim is left
      -- untouched (header item 12), here and below.
      if v_extraction.id is not null and not v_extraction_before_claim then
        update public.drawing_extractions
        set status = 'needs_review'
        where part_id = v_part.id;
      end if;

      continue;
    end if;

    v_spec_snapshot := coalesce(v_requirement.spec_snapshot, '{}'::jsonb)
      || jsonb_build_object(
        'requestedServiceKinds', v_requested_service_kinds,
        'primaryServiceKind', v_primary_service_kind,
        'serviceNotes', nullif(trim(coalesce(v_job.service_notes, '')), ''),
        'description', v_description,
        'partNumber', v_part_number,
        'revision', v_revision,
        'material', nullif(v_material, ''),
        'finish', v_finish,
        'quoteDescription', coalesce(v_quote_description, v_description),
        'quoteFinish', coalesce(v_quote_finish, v_finish),
        -- OVD-979 (review r2): keys other than these four (for example
        -- fieldSources.material) are kept; each run used to drop them.
        'fieldSources', case
          when jsonb_typeof(v_requirement.spec_snapshot -> 'fieldSources') = 'object'
            then v_requirement.spec_snapshot -> 'fieldSources'
          else '{}'::jsonb
        end || jsonb_build_object(
          'description', v_description_source,
          'partNumber', v_part_number_source,
          'revision', v_revision_source,
          'finish', v_finish_source
        ),
        'fieldOverrides', case
          when jsonb_typeof(v_requirement.spec_snapshot -> 'fieldOverrides') = 'object'
            then v_requirement.spec_snapshot -> 'fieldOverrides'
          else '{}'::jsonb
        end || jsonb_build_object(
          'description', v_description_source <> 'auto',
          'partNumber', v_part_number_source <> 'auto',
          'revision', v_revision_source <> 'auto',
          'finish', v_finish_source <> 'auto'
        ),
        'tightestToleranceInch', v_tightest_tolerance_inch,
        'quantity', v_quantity,
        'quoteQuantities', v_quote_quantities,
        'requestedByDate', v_requested_by_date,
        'process', v_process,
        'notes', v_notes,
        'shipping', coalesce(v_requirement.spec_snapshot -> 'shipping', '{}'::jsonb),
        'certifications', coalesce(v_requirement.spec_snapshot -> 'certifications', '{}'::jsonb),
        'sourcing', coalesce(v_requirement.spec_snapshot -> 'sourcing', '{}'::jsonb),
        'release', coalesce(v_requirement.spec_snapshot -> 'release', '{}'::jsonb)
      );

    -- OVD-979: a field refreshed from the extraction (or a replaced material
    -- placeholder) also becomes the editor's default for that field, so a
    -- reset resolves to the refreshed value and a later save that resends the
    -- displayed values records no override. Only an existing defaults object
    -- is changed; a missing one is seeded later from the refreshed columns.
    -- Review r2, M1: a field the user owns through an override is not
    -- refreshed, but its default follows a newer extraction that has a value
    -- for it (and is not flagged for review). The column keeps the user's
    -- value; a reset then returns the field to the drawing value at once
    -- instead of to the default seeded at the first save. A legacy-only owner
    -- (fieldSources without an override key) is left alone: reset cannot clear
    -- it, and a changed default would show up in the next reset of any field.
    if jsonb_typeof(v_spec_snapshot #> '{projectPartProperties,defaults}') = 'object' then
      v_property_defaults := v_spec_snapshot #> '{projectPartProperties,defaults}';
      if v_description_refresh then
        v_property_defaults := v_property_defaults || jsonb_build_object('description', coalesce(v_quote_description, v_description));
      elsif v_property_overrides ? 'description' and v_extraction_newer
        and not v_description_review_needed and v_extracted_description is not null then
        v_property_defaults := v_property_defaults || jsonb_build_object('description', v_extracted_description);
      end if;
      if v_part_number_refresh then
        v_property_defaults := v_property_defaults || jsonb_build_object('partNumber', v_part_number);
      elsif v_property_overrides ? 'partNumber' and v_extraction_newer
        and not v_part_number_review_needed and v_extracted_part_number is not null then
        v_property_defaults := v_property_defaults || jsonb_build_object('partNumber', v_extracted_part_number);
      end if;
      if v_revision_refresh then
        v_property_defaults := v_property_defaults || jsonb_build_object('revision', v_revision);
      elsif v_property_overrides ? 'revision' and v_extraction_newer
        and not v_revision_review_needed and v_extracted_revision is not null then
        v_property_defaults := v_property_defaults || jsonb_build_object('revision', v_extracted_revision);
      end if;
      if v_finish_refresh then
        v_property_defaults := v_property_defaults || jsonb_build_object('finish', coalesce(v_quote_finish, v_finish));
      elsif v_property_overrides ? 'finish' and v_extraction_newer
        and not v_finish_review_needed and v_extracted_finish is not null then
        v_property_defaults := v_property_defaults || jsonb_build_object('finish', v_extracted_finish);
      end if;
      if v_material_placeholder_replaced then
        v_property_defaults := v_property_defaults || jsonb_build_object('material', coalesce(v_material, ''));
      end if;
      v_spec_snapshot := jsonb_set(v_spec_snapshot, '{projectPartProperties,defaults}', v_property_defaults);
    end if;

    insert into public.approved_part_requirements (
      part_id,
      organization_id,
      approved_by,
      description,
      part_number,
      revision,
      material,
      finish,
      tightest_tolerance_inch,
      quantity,
      quote_quantities,
      requested_by_date,
      applicable_vendors,
      spec_snapshot,
      approved_at,
      updated_at
    )
    values (
      v_part.id,
      v_job.organization_id,
      coalesce(v_requirement.approved_by, v_job.created_by),
      v_description,
      v_part_number,
      v_revision,
      coalesce(v_material, ''),
      v_finish,
      v_tightest_tolerance_inch,
      v_quantity,
      v_quote_quantities,
      v_requested_by_date,
      v_applicable_vendors,
      v_spec_snapshot,
      v_timestamp,
      v_timestamp
    )
    on conflict (part_id) do update
      set approved_by = excluded.approved_by,
          description = excluded.description,
          part_number = excluded.part_number,
          revision = excluded.revision,
          material = excluded.material,
          finish = excluded.finish,
          tightest_tolerance_inch = excluded.tightest_tolerance_inch,
          quantity = excluded.quantity,
          quote_quantities = excluded.quote_quantities,
          requested_by_date = excluded.requested_by_date,
          applicable_vendors = excluded.applicable_vendors,
          spec_snapshot = excluded.spec_snapshot,
          approved_at = excluded.approved_at,
          updated_at = excluded.updated_at;

    if v_extraction.id is not null and not v_extraction_before_claim then
      update public.drawing_extractions
      set status = 'approved'
      where part_id = v_part.id;
    end if;

    v_count := v_count + 1;
  end loop;

  -- OVD-979 (review r3): the worker calls this function before it marks its own
  -- task completed, so a running drawing_attached task whose extraction is
  -- already stored (written by the worker, or copied by the trusted reuse) is
  -- finishing, not pending. Anything else queued or running still is.
  -- Fix round 7: the stored row must have been written after this claim began
  -- (header item 11; the set is read before the loop), so a retry that still
  -- holds its failed attempt's row is pending until it stores its own.
  select count(*)::integer
  into v_pending_extract_tasks
  from public.work_queue queue
  where queue.job_id = p_job_id
    and queue.task_type = 'extract_part'
    and queue.status in ('queued', 'running')
    and not (queue.id = any(v_finishing_attach_tasks));

  -- OVD-979 (review r3): a failure that a later task of the same part replaced
  -- (api_request_extraction queues a new task and keeps the failed row) is
  -- history, not a current failure.
  select count(*)::integer
  into v_failed_extract_tasks
  from public.work_queue queue
  where queue.job_id = p_job_id
    and queue.task_type = 'extract_part'
    and queue.status = 'failed'
    and not exists (
      select 1
      from public.work_queue later
      where later.job_id = p_job_id
        and later.part_id = queue.part_id
        and later.task_type = 'extract_part'
        and later.status in ('queued', 'running', 'completed')
        and later.created_at > queue.created_at
    );

  select count(*)::integer
  into v_unapproved_parts
  from public.parts part
  left join public.approved_part_requirements requirement on requirement.part_id = part.id
  where part.job_id = p_job_id
    and (part.cad_file_id is not null or part.drawing_file_id is not null)
    and requirement.id is null;

  -- OVD-979: only jobs that have not started quoting change status here
  -- (job_status order: uploaded, extracting, needs_spec_review, ready_to_quote,
  -- then quoting and later). A job in quoting or later keeps its status.
  if v_pending_extract_tasks > 0 then
    update public.jobs
    set status = 'extracting'
    where id = p_job_id
      and status in ('uploaded', 'extracting', 'needs_spec_review', 'ready_to_quote');
  elsif v_failed_extract_tasks > 0 or v_unapproved_parts > 0 then
    update public.jobs
    set status = 'needs_spec_review'
    where id = p_job_id
      and status in ('uploaded', 'extracting', 'needs_spec_review', 'ready_to_quote');
  elsif v_count > 0 then
    update public.jobs
    set status = 'ready_to_quote'
    where id = p_job_id
      and status in ('uploaded', 'extracting', 'needs_spec_review', 'ready_to_quote');
  end if;

  perform public.log_audit_event(
    v_job.organization_id,
    'job.requirements_auto_approved',
    jsonb_build_object(
      'jobId', p_job_id,
      'approvedParts', v_count,
      'approvedBy', v_job.created_by,
      'pendingExtractTasks', v_pending_extract_tasks,
      'failedExtractTasks', v_failed_extract_tasks,
      'unapprovedParts', v_unapproved_parts
    ),
    p_job_id,
    null
  );

  return v_count;
end;
$$;

-- Restated exactly as 20260924001152_ovd535_restrict_worker_rpcs.sql left it.
revoke execute on function public.api_auto_approve_job_requirements(uuid) from public;
revoke execute on function public.api_auto_approve_job_requirements(uuid) from anon, authenticated;
grant execute on function public.api_auto_approve_job_requirements(uuid) to service_role;

-- OVD-979 (fix round 7, header item 10): verbatim from
-- 20260402120000_persist_project_part_property_overrides.sql except three marked
-- changes. The save and reset RPCs call this before they read anything, so it
-- takes lock 1 of the LOCK ORDER (the job row) after the access checks and
-- re-reads the job under it; the part, requirement and extraction reads that
-- follow then see what a concurrent auto-approval committed. A row lock is not
-- allowed in a STABLE function, so the function is now VOLATILE (its callers are
-- VOLATILE RPCs that write). search_path becomes pg_catalog, public (the
-- security-definer lint; every name in the body is schema-qualified).
create or replace function public.load_editable_project_part_context(
  p_job_id uuid
)
returns table (
  job public.jobs,
  part public.parts,
  requirement public.approved_part_requirements,
  extraction public.drawing_extractions
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_job public.jobs%rowtype;
  v_part public.parts%rowtype;
  v_requirement public.approved_part_requirements%rowtype;
  v_extraction public.drawing_extractions%rowtype;
begin
  perform public.require_verified_auth();

  select *
  into v_job
  from public.jobs
  where id = p_job_id;

  if v_job.id is null then
    raise exception 'Job % not found.', p_job_id;
  end if;

  if not public.user_can_edit_job(v_job.id) then
    raise exception 'You do not have permission to edit job %.', p_job_id;
  end if;

  -- OVD-979 (fix round 7): lock 1 of the LOCK ORDER, held until the caller
  -- commits, so a save or reset never interleaves with
  -- api_auto_approve_job_requirements for the same job.
  select *
  into v_job
  from public.jobs
  where id = p_job_id
  for no key update;

  select *
  into v_part
  from public.parts
  where job_id = v_job.id
  order by created_at asc, id asc
  limit 1;

  if v_part.id is null then
    raise exception 'Job % has no part revisions yet.', p_job_id;
  end if;

  select *
  into v_requirement
  from public.approved_part_requirements
  where part_id = v_part.id;

  select *
  into v_extraction
  from public.drawing_extractions
  where part_id = v_part.id;

  return query
  select
    v_job,
    v_part,
    v_requirement,
    v_extraction;
end;
$$;

-- Restated exactly as 20261016013742_ovd736_revoke_anon_definer_execute.sql left it.
revoke execute on function public.load_editable_project_part_context(uuid) from public, anon, authenticated;
grant execute on function public.load_editable_project_part_context(uuid) to service_role;

commit;
