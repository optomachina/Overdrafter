-- =====================================================================
-- NEEDS BLAINE MIGRATION WINDOW - not applied
-- =====================================================================
-- OVD-987 (slice P3): let a customer request any single quantity in the
-- controlled Xometry beta, behind a server switch that defaults OFF.
--
-- Decision (Blaine, 2026-10-19): the customer chooses the quantity; there is
-- no product cap. With the switch ON the beta admits exactly one quote
-- quantity, a positive integer (public.normalize_positive_integer_array
-- already drops non-positive values; integer is the only range). Several
-- quantities stay denied with xometry_beta_single_quantity_required. With the
-- switch OFF (the seed) the changed functions behave as before: the quantity
-- must be exactly [1], error xometry_beta_quantity_one_required.
--
-- Staging first (docs/runbooks/staging.md). Production apply needs Blaine's
-- approval card. Turning the switch on in production is a separate Blaine
-- approval, after the separately authorized quantity-10 live run.
--
-- Rollback: docs/migration-drafts/ovd-987.rollback.sql. It is guarded: it
-- refuses while the switch is on or while a Xometry permit above quantity 1
-- is still in flight (turn the switch off and drain first).
-- Notes, body diff and read-only hosted checks:
-- docs/migration-drafts/ovd-987-notes.md.
--
-- Transaction: this file has no begin/commit of its own. Apply it as one
-- transaction. By hand:
--   psql --single-transaction -v ON_ERROR_STOP=1 -f <file>
-- The Supabase CLI (db push, migration up) also applies the whole file as one
-- transaction: it sends the file as one pipeline, so SET LOCAL warns but holds
-- to the end, the table locks below are kept to the end, and a failure leaves
-- nothing. Only plain psql -f without --single-transaction (the CI fixtures)
-- gives each statement its own transaction: no lock timeout, and the locks
-- below are released at once; the file still applies there, and every
-- statement can be re-run.
-- No enum value, no CONCURRENTLY, no extension. The two capability CHECKs are
-- replaced, which takes ACCESS EXCLUSIVE on the two small rollout-control
-- tables.
-- Locks: right after the precondition and before any change, one DO block
-- takes both tables, the events and then the controls, all or nothing and
-- without waiting: LOCK TABLE ... NOWAIT in an exception block, so a failed
-- attempt gives back what it took, sleeps 50 ms holding nothing and tries
-- again, for up to 5 s, then refuses with 55P03 and nothing changes. No
-- waiting order is safe here: the audited setter reads the events (its
-- idempotency lookup) before it locks a control row, and the read API reads
-- the controls and then the events, so controls-first deadlocked with a
-- setter call and events-first with a read-API call (both reproduced). This
-- transaction never waits for a rollout table, and once it holds both it
-- waits for nothing a request, worker preflight, setter or reader can hold,
-- so it cannot be part of a deadlock; those calls wait for it instead. The
-- rollback takes its locks the same way. The writer-by-writer proof is in the
-- notes file.
--
-- What changes:
--   1. private.commercial_rollout_controls and private.commercial_rollout_control_events
--      accept the capability controlled_beta_user_quantity. The control is
--      seeded OFF at revision 0, the way the four existing controls were.
--   2. public.api_set_commercial_rollout_control (service_role only,
--      revisioned, audited) accepts it. That setter is the way to flip it.
--   3. private.xometry_beta_user_quantity_enabled(): STABLE, SECURITY INVOKER
--      (its callers are SECURITY DEFINER), executable by no API role. It reads
--      the control through private.commercial_rollout_enabled, so a missing
--      row reads as off.
--   4. Six functions are restated from their latest definitions with only the
--      quantity predicates changed (body diff in the notes file):
--        S1 private.resolve_xometry_beta_dispatch_scope_with_access (20261010230000)
--        S3 public.api_request_xometry_beta_dispatch (20261004100000)
--        S4 public.api_authorize_xometry_beta_worker_dispatch (20261002182910)
--        S5 private.record_quote_access_admission (20261002182714)
--        S6 private.finalize_free_quote_job (20261002182714)
--        S7 public.api_reconcile_terminal_free_quote_tasks (20261003011148)
--      S1 and S3 read the switch without a lock, so the request keeps the
--      OVD-598/OVD-628 heavyweight-wait invariant. S4 re-checks it at
--      dispatch: while the switch is off a lane above 1 is refused with
--      dispatch_quantity_not_admitted before browser launch. Only for such a
--      lane S4 first takes the shared advisory lock
--      commercial-rollout:controlled_beta_user_quantity, whose only exclusive
--      holder is the setter, so an audited disable waits for an in-flight
--      authorization and later ones see it. Quantity-1 lanes take no new lock.
--      S4 also binds the quantity the worker browses with: the result's
--      requested_quantity, and the task payload's requestedQuantity when the
--      payload has that key, must equal the lane's quantity, else
--      dispatch_lane_identity_mismatch. Rows the server writes always agree,
--      so with the switch off this tightening changes the answer only for a
--      task or result row edited after enqueue.
--      S5 to S7 (the free-beta meter) never read the switch. They bind the
--      lane quantity to the lane's own scope snapshot and the result quantity
--      to the lane, so a permit issued at N still settles (consumed or
--      released) after the switch is turned off. The snapshot quantity is
--      compared as text: equal for every snapshot the server builds, and a
--      malformed snapshot fails closed instead of raising inside the deferred
--      settlement trigger.
--      Unchanged: S2 (exactly one candidate), the scope snapshot and its
--      fingerprint (quantity is already inside it), quote_lane_candidates, the
--      permit tables, the generic provider path, and every other gate and its
--      order (quantity is still checked before tolerance, need-by, special
--      requirements and destination; kill switch and export control are
--      quantity-agnostic).
--   Security attributes, search_path, owner, revokes and grants of every
--   restated function are unchanged and restated.
--
-- Operating the switch (details in the notes file):
--   * Change one rollout capability per transaction. S4 takes the shared
--     lock of automatic_quote_collection and then, for a lane above 1, this
--     switch's; a transaction that sets this switch and then
--     automatic_quote_collection can deadlock with it. If both must change
--     together, change automatic_quote_collection first.
--   * Turning the switch off stops a lane above 1 at its next preflight; a
--     lane that already passed S4 still launches.
--   * After a turn-off, replaying a committed quantity-N request raises
--     xometry_beta_quantity_one_required instead of returning deduplicated
--     (S3 runs the resolver before its replay return).
--   * Rolling back and re-applying re-seeds the control at revision 0, so a
--     (capability, revision) pair can repeat in the immutable audit log.
--
-- Precondition: the block below refuses unless each replaced function is the
-- definition this file was reviewed against, or already this file's, so a
-- later wrapper (the OVD-723 contract) or the OVD-762 fan out copy is never
-- silently overwritten. If it refuses, rebase this file.
-- =====================================================================

set local lock_timeout = '5s';

do $ovd987_precondition$
declare
  v_expected record;
  v_md5 text;
begin
  for v_expected in
    select * from (values
      ('public.api_set_commercial_rollout_control(text,boolean,text,text,bigint,text)', 'eb741ed4f0be63d3189486959cdccdac', '2a2b6b6980abb0dd113b64b3dcd57041'),
      ('private.resolve_xometry_beta_dispatch_scope_with_access(uuid,text,uuid)', '0d4abcf48f054aced6dd3d531a1114bb', '916594293cfc4e66053acf4c7414b2ba'),
      ('public.api_request_xometry_beta_dispatch(uuid,text,text,text,uuid,boolean,boolean,boolean)', 'b633e6921485eefc211ab238bab10e43', '28c932e1ccf964302ffed42d9ce4bc0b'),
      ('public.api_authorize_xometry_beta_worker_dispatch(uuid,uuid,jsonb,text,timestamptz)', 'eb659d92aa927555f4c4fe93591fa9d1', '0fef772880a4122f72475a9905b7ed19'),
      ('private.record_quote_access_admission(uuid,uuid,text,uuid)', '92b05edef3ec774fdb704e21efdc392d', '7c5f710bccffddd8562974ae489e803c'),
      ('private.finalize_free_quote_job(uuid)', '66021f1fc65ee7fa7d5c24666c858512', 'b76415a18a9bb15659ec388cc4da2880'),
      ('public.api_reconcile_terminal_free_quote_tasks(uuid,integer)', '30208617d8ea6ec756e268d1b31ad4c9', 'edcca1ef0dd3cf45a7ff9c202696f185')
    ) as expected(signature, previous_md5, applied_md5)
  loop
    select pg_catalog.md5(p.prosrc) into v_md5
    from pg_catalog.pg_proc p
    where p.oid = pg_catalog.to_regprocedure(v_expected.signature);
    if v_md5 is null or v_md5 not in (v_expected.previous_md5, v_expected.applied_md5) then
      raise exception 'OVD-987 refused: % is not the definition this migration was reviewed against (md5 %)',
        v_expected.signature, coalesce(v_md5, 'missing')
        using errcode = 'P0001';
    end if;
  end loop;
end;
$ovd987_precondition$;

-- Take both rollout tables up front, all or nothing and without waiting (see
-- "Locks" in the header). The ALTER TABLEs below need exactly these modes.
do $ovd987_locks$
declare
  v_deadline timestamptz := pg_catalog.clock_timestamp() + interval '5 seconds';
begin
  loop
    begin
      lock table private.commercial_rollout_control_events,
        private.commercial_rollout_controls
        in access exclusive mode nowait;
      exit;
    exception
      when lock_not_available then
        if pg_catalog.clock_timestamp() >= v_deadline then
          raise exception 'OVD-987 refused: the rollout-control tables stayed in use for 5 s; nothing changed, re-run it'
            using errcode = '55P03';
        end if;
    end;
    perform pg_catalog.pg_sleep(0.05);
  end loop;
end;
$ovd987_locks$;

-- 1. Capability: CHECK lists and the default-off seed.
alter table private.commercial_rollout_controls
  drop constraint if exists commercial_rollout_controls_capability_check;
alter table private.commercial_rollout_controls
  add constraint commercial_rollout_controls_capability_check check (
    capability in (
      'commercial_admin_mutations',
      'automatic_quote_collection',
      'promotion_codes',
      'order_administration',
      'controlled_beta_user_quantity'
    )
  );

alter table private.commercial_rollout_control_events
  drop constraint if exists commercial_rollout_control_events_capability_check;
alter table private.commercial_rollout_control_events
  add constraint commercial_rollout_control_events_capability_check check (
    capability in (
      'commercial_admin_mutations',
      'automatic_quote_collection',
      'promotion_codes',
      'order_administration',
      'controlled_beta_user_quantity'
    )
  );

insert into private.commercial_rollout_controls (
  capability,
  enabled,
  revision,
  change_reason
)
values (
  'controlled_beta_user_quantity',
  false,
  0,
  'Default-off controlled beta user quantity (OVD-987)'
)
on conflict (capability) do nothing;

-- 2. The audited setter accepts the new capability (one list entry added).
create or replace function public.api_set_commercial_rollout_control(
  p_capability text,
  p_enabled boolean,
  p_change_reason text,
  p_operator text,
  p_expected_revision bigint,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_control private.commercial_rollout_controls%rowtype;
  v_existing_event private.commercial_rollout_control_events%rowtype;
  v_event private.commercial_rollout_control_events%rowtype;
  v_actor_user_id uuid := auth.uid();
  v_actor_role text := coalesce(auth.role(), current_user);
  v_reason text := pg_catalog.btrim(p_change_reason);
  v_operator text := pg_catalog.btrim(p_operator);
  v_idempotency_key text := pg_catalog.btrim(p_idempotency_key);
begin
  if p_capability is null or p_capability not in (
    'commercial_admin_mutations',
    'automatic_quote_collection',
    'promotion_codes',
    'order_administration',
    'controlled_beta_user_quantity'
  ) then
    raise exception 'Unknown commercial rollout capability.';
  end if;

  if p_enabled is null then
    raise exception 'Commercial rollout state is required.';
  end if;

  if v_reason is null or pg_catalog.length(v_reason) not between 3 and 500 then
    raise exception 'A change reason between 3 and 500 characters is required.';
  end if;

  if v_operator is null or pg_catalog.length(v_operator) not between 3 and 200 then
    raise exception 'An operator identity between 3 and 200 characters is required.';
  end if;

  if p_expected_revision is null or p_expected_revision < 0 then
    raise exception 'A non-negative expected revision is required.';
  end if;

  if v_idempotency_key is null
     or pg_catalog.length(v_idempotency_key) not between 8 and 200 then
    raise exception 'An idempotency key between 8 and 200 characters is required.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('commercial-rollout:' || p_capability, 0)
  );

  select event.*
  into v_existing_event
  from private.commercial_rollout_control_events event
  where event.idempotency_key = v_idempotency_key;

  if v_existing_event.id is not null then
    if v_existing_event.capability is distinct from p_capability
       or v_existing_event.enabled is distinct from p_enabled
       or v_existing_event.change_reason is distinct from v_reason
       or v_existing_event.changed_by_actor is distinct from v_operator
       or v_existing_event.previous_revision is distinct from p_expected_revision
    then
      raise exception 'Idempotency key has already been used for a different rollout-control action.';
    end if;

    return pg_catalog.jsonb_build_object(
      'eventId', v_existing_event.id,
      'capability', v_existing_event.capability,
      'enabled', v_existing_event.enabled,
      'changed', v_existing_event.changed,
      'revision', v_existing_event.revision,
      'changeReason', v_existing_event.change_reason,
      'operator', v_existing_event.changed_by_actor,
      'idempotencyKey', v_existing_event.idempotency_key,
      'replayed', true
    );
  end if;

  select control.*
  into strict v_control
  from private.commercial_rollout_controls control
  where control.capability = p_capability
  for update;

  if p_expected_revision <> v_control.revision then
    raise exception 'Commercial rollout control changed; refresh and retry.';
  end if;

  insert into private.commercial_rollout_control_events (
    capability,
    idempotency_key,
    previous_enabled,
    enabled,
    changed,
    previous_revision,
    revision,
    change_reason,
    changed_by_user_id,
    changed_by_actor,
    changed_by_role
  )
  values (
    v_control.capability,
    v_idempotency_key,
    v_control.enabled,
    p_enabled,
    v_control.enabled <> p_enabled,
    v_control.revision,
    case
      when v_control.enabled <> p_enabled then v_control.revision + 1
      else v_control.revision
    end,
    v_reason,
    v_actor_user_id,
    v_operator,
    v_actor_role
  )
  returning * into v_event;

  if v_event.changed then
    update private.commercial_rollout_controls
    set
      enabled = v_event.enabled,
      revision = v_event.revision,
      change_reason = v_event.change_reason,
      updated_at = v_event.changed_at,
      updated_by_user_id = v_event.changed_by_user_id,
      updated_by_actor = v_event.changed_by_actor
    where capability = v_event.capability;
  end if;

  return pg_catalog.jsonb_build_object(
    'eventId', v_event.id,
    'capability', v_event.capability,
    'enabled', v_event.enabled,
    'changed', v_event.changed,
    'revision', v_event.revision,
    'changeReason', v_event.change_reason,
    'operator', v_event.changed_by_actor,
    'idempotencyKey', v_event.idempotency_key,
    'replayed', false
  );
end;
$$;

revoke all on function public.api_set_commercial_rollout_control(
  text,
  boolean,
  text,
  text,
  bigint,
  text
)
from public, anon, authenticated, service_role;

grant execute on function public.api_set_commercial_rollout_control(
  text,
  boolean,
  text,
  text,
  bigint,
  text
)
to service_role;

-- 3. The switch helper.
create or replace function private.xometry_beta_user_quantity_enabled()
returns boolean
language sql
stable
set search_path = pg_catalog
as $$
  select private.commercial_rollout_enabled('controlled_beta_user_quantity');
$$;

revoke all on function private.xometry_beta_user_quantity_enabled()
  from public, anon, authenticated, service_role;

-- 4. S1: resolver (latest 20261010230000). Changed: the quantity check.
create or replace function private.resolve_xometry_beta_dispatch_scope_with_access(
  p_job_id uuid,
  p_declared_model_units text,
  p_existing_permit_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_job public.jobs%rowtype;
  v_requirement public.approved_part_requirements%rowtype;
  v_part public.parts%rowtype;
  v_cad public.job_files%rowtype;
  v_drawing public.job_files%rowtype;
  v_notice jsonb;
  v_beta_state jsonb;
  v_denial jsonb;
  v_effective_vendors public.vendor_name[];
  v_candidate record;
  v_special jsonb;
  v_process text;
  v_material text;
  v_finish text;
begin
  perform public.require_verified_auth();

  select job_row.* into v_job
  from public.jobs job_row
  where job_row.id = p_job_id;

  if v_job.id is null then
    raise exception 'Job % not found.', p_job_id;
  end if;
  if not public.user_can_edit_job(v_job.id) then
    raise exception 'You do not have permission to request quotes for job %.', p_job_id;
  end if;
  if p_declared_model_units not in ('inch', 'millimeter') then
    raise exception 'Declared model units must be inch or millimeter.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended(
      'founding-beta:' || v_job.organization_id::text,
      0
    )
  );

  v_notice := private.current_founding_beta_notice();
  v_beta_state := private.resolve_founding_beta_access_state(
    v_job.organization_id,
    auth.uid()
  );
  if v_beta_state ->> 'state' <> 'eligible' then
    raise exception 'Founding Beta access and current notice acceptance are required.';
  end if;

  v_denial := private.resolve_quote_access_for_permit(p_job_id, auth.uid(), p_existing_permit_id);
  if v_denial ->> 'state' is distinct from 'eligible' then
    raise exception '%', coalesce(v_denial ->> 'reasonCode', 'automatic_quote_unavailable'); -- NOSONAR: stable denial contract shared with the existing quote boundary
  end if;

  if not exists (
    select 1 from public.org_vendor_configs config
    where config.organization_id = v_job.organization_id
  ) then
    raise exception 'xometry_beta_explicit_vendor_config_required';
  end if;

  v_effective_vendors := public.get_enabled_client_quote_vendors(
    v_job.organization_id,
    v_job.project_id,
    v_job.id
  );
  if v_effective_vendors is distinct from array['xometry']::public.vendor_name[] then
    raise exception 'xometry_beta_exact_provider_set_required';
  end if;

  if (select count(*) from public.parts part where part.job_id = p_job_id) <> 1 then
    raise exception 'xometry_beta_exactly_one_part_required';
  end if;

  select part.* into v_part
  from public.parts part
  where part.job_id = p_job_id;
  if v_part.organization_id <> v_job.organization_id then
    raise exception 'xometry_beta_part_organization_mismatch';
  end if;

  select requirement.* into v_requirement
  from public.approved_part_requirements requirement
  where requirement.part_id = v_part.id;
  if v_requirement.id is null then
    raise exception 'xometry_beta_approved_requirements_required';
  end if;
  if v_requirement.organization_id <> v_job.organization_id then
    raise exception 'xometry_beta_requirement_organization_mismatch';
  end if;

  select file_row.* into v_cad
  from public.job_files file_row
  where file_row.id = v_part.cad_file_id;
  if v_cad.id is null
    or v_cad.job_id <> v_job.id
    or v_cad.organization_id <> v_job.organization_id
    or v_cad.file_kind <> 'cad'
    or lower(v_cad.original_name) !~ '\.(step|stp)$'
    or v_cad.trusted_content_sha256 is null
    or v_cad.trusted_content_sha256 !~ '^[a-f0-9]{64}$' then
    raise exception 'xometry_beta_trusted_step_required';
  end if;

  if v_part.drawing_file_id is not null then
    select file_row.* into v_drawing
    from public.job_files file_row
    where file_row.id = v_part.drawing_file_id;
    if v_drawing.id is null
      or v_drawing.job_id <> v_job.id
      or v_drawing.organization_id <> v_job.organization_id
      or v_drawing.file_kind <> 'drawing'
      or lower(v_drawing.original_name) !~ '\.pdf$'
      or v_drawing.trusted_content_sha256 is null
      or v_drawing.trusted_content_sha256 !~ '^[a-f0-9]{64}$' then
      raise exception 'xometry_beta_compatible_drawing_required';
    end if;
  end if;

  if public.normalize_requested_service_kinds(
    v_job.requested_service_kinds,
    v_job.primary_service_kind
  ) is distinct from array['manufacturing_quote']::text[] then
    raise exception 'xometry_beta_manufacturing_quote_only';
  end if;
  if public.normalize_positive_integer_array(
    v_requirement.quote_quantities,
    v_requirement.quantity
  ) is distinct from array[1]::integer[]
    and not private.xometry_beta_user_quantity_enabled() then
    raise exception 'xometry_beta_quantity_one_required';
  end if;
  -- OVD-987: while controlled_beta_user_quantity is on, one positive
  -- quantity of any size is admitted; several quantities (or none) are not.
  if pg_catalog.cardinality(public.normalize_positive_integer_array(
    v_requirement.quote_quantities,
    v_requirement.quantity
  )) <> 1 then
    raise exception 'xometry_beta_single_quantity_required';
  end if;
  if v_requirement.applicable_vendors is null
    or coalesce(
      'xometry'::public.vendor_name = any(v_requirement.applicable_vendors),
      false
    ) is not true then
    raise exception 'xometry_beta_xometry_applicability_required';
  end if;

  v_process := pg_catalog.regexp_replace(
    pg_catalog.lower(pg_catalog.btrim(coalesce(v_requirement.spec_snapshot ->> 'process', ''))),
    '[^a-z0-9]', '', 'g' -- NOSONAR: identical normalization is required for process, material, and finish
  );
  v_material := pg_catalog.regexp_replace(
    pg_catalog.lower(pg_catalog.btrim(v_requirement.material)),
    '[^a-z0-9]', '', 'g'
  );
  v_finish := pg_catalog.regexp_replace(
    pg_catalog.lower(pg_catalog.btrim(coalesce(v_requirement.finish, ''))),
    '[^a-z0-9]', '', 'g'
  );
  if v_process not in ('cncmilling', 'cncmachining', 'milling') then
    raise exception 'xometry_beta_cnc_milling_required';
  end if;
  if v_material not in ('6061t6', '6061t6aluminum', 'aluminum6061t6') then
    raise exception 'xometry_beta_6061_t6_required';
  end if;
  if v_finish not in ('', 'asmachined') then
    raise exception 'xometry_beta_as_machined_required';
  end if;
  if v_requirement.tightest_tolerance_inch is null
    or v_requirement.tightest_tolerance_inch < 0.005 then
    raise exception 'xometry_beta_standard_tolerance_required';
  end if;
  if v_requirement.requested_by_date is not null then
    raise exception 'xometry_beta_special_delivery_date_not_supported';
  end if;

  v_special := coalesce(v_requirement.spec_snapshot, '{}'::jsonb);
  if nullif(pg_catalog.btrim(coalesce(v_special ->> 'threads', '')), '') is not null
    or nullif(pg_catalog.btrim(coalesce(v_special ->> 'notes', '')), '') is not null
    or nullif(pg_catalog.btrim(coalesce(v_special ->> 'serviceNotes', '')), '') is not null
    or nullif(pg_catalog.btrim(coalesce(v_special #>> '{shipping,packagingNotes}', '')), '') is not null
    or nullif(pg_catalog.btrim(coalesce(v_special #>> '{shipping,shippingNotes}', '')), '') is not null
    or jsonb_array_length(coalesce(v_special #> '{certifications,requiredCertifications}', '[]'::jsonb)) > 0
    or coalesce((v_special #>> '{certifications,materialCertificationRequired}')::boolean, false)
    or coalesce((v_special #>> '{certifications,certificateOfConformanceRequired}')::boolean, false)
    or coalesce(v_special #>> '{certifications,inspectionLevel}', 'standard') not in ('', 'standard')
    or nullif(pg_catalog.btrim(coalesce(v_special #>> '{certifications,notes}', '')), '') is not null
    or jsonb_array_length(coalesce(v_special #> '{sourcing,preferredSuppliers}', '[]'::jsonb)) > 0
    or coalesce(v_special #>> '{sourcing,regionPreferenceOverride}', 'best_value') not in ('', 'best_value')
    or coalesce(v_special #>> '{sourcing,materialProvisioning}', 'supplier_to_source') not in ('', 'supplier_to_source')
    or nullif(pg_catalog.btrim(coalesce(v_special #>> '{sourcing,notes}', '')), '') is not null
    or coalesce(v_special #>> '{release,releaseStatus}', 'approved') in ('hold', 'blocked')
    or nullif(pg_catalog.btrim(coalesce(v_special #>> '{release,notes}', '')), '') is not null then
    raise exception 'xometry_beta_special_requirements_not_supported';
  end if;

  -- OVD-682: name the missing confirmed destination instead of letting the
  -- shared candidate path silently drop the Xometry lane.
  if private.current_confirmed_sourcing_address(v_job.organization_id) is null then
    raise exception 'xometry_beta_confirmed_sourcing_address_required';
  end if;

  select candidate.* into v_candidate
  from private.quote_lane_candidates(
    p_job_id,
    array['xometry']::public.vendor_name[]
  ) candidate;
  if not found then
    raise exception 'xometry_beta_exact_scope_required';
  end if;
  if (select count(*) from private.quote_lane_candidates(
    p_job_id,
    array['xometry']::public.vendor_name[]
  )) <> 1 then
    raise exception 'xometry_beta_exact_scope_required';
  end if;

  return pg_catalog.jsonb_build_object(
    'organizationId', v_job.organization_id, -- NOSONAR: stable public response key
    'jobId', v_job.id,
    'partId', v_candidate.part_id, -- NOSONAR: stable public response key
    'provider', v_candidate.vendor,
    'requestedQuantity', v_candidate.requested_quantity,
    'scopeVersion', v_candidate.scope_version,
    'scopeFingerprint', v_candidate.scope_fingerprint, -- NOSONAR: stable permit and preview contract key
    'scope', v_candidate.scope_snapshot,
    'declaredModelUnits', p_declared_model_units,
    'policyRevision', v_notice ->> 'policyRevision', -- NOSONAR: stable notice contract key
    'envelopeRevision', 'xometry-controlled-beta-envelope.v1'
  );
end;
$$;

revoke all on function private.resolve_xometry_beta_dispatch_scope_with_access(uuid, text, uuid)
  from public, anon, authenticated, service_role;
-- Owner-only: callers are SECURITY DEFINER; no API role gets EXECUTE.
grant execute on function private.resolve_xometry_beta_dispatch_scope_with_access(uuid, text, uuid) to postgres;

-- S3: legacy request (latest 20261004100000). Changed: the created-lane quantity.
create or replace function public.api_request_xometry_beta_dispatch(
  p_job_id uuid,
  p_declared_model_units text,
  p_expected_scope_fingerprint text,
  p_policy_revision text,
  p_approval_reference uuid,
  p_authority_to_share boolean,
  p_non_export_controlled boolean,
  p_quote_only boolean
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_scope jsonb;
  v_capacity jsonb;
  v_access jsonb;
  v_organization_id uuid;
  v_result jsonb;
  v_existing private.xometry_beta_dispatch_permits%rowtype;
  v_lane public.quote_request_lanes%rowtype;
  v_task public.work_queue%rowtype;
  v_result_row public.vendor_quote_results%rowtype;
  v_permit_id uuid := gen_random_uuid();
begin
  perform public.require_verified_auth();
  v_capacity := private.lock_free_quote_capacity(p_job_id);
  select organization_id into strict v_organization_id from public.jobs where id=p_job_id;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('quote-lane-submit:' || p_job_id::text, 0)
  );

  if p_authority_to_share is not true
    or p_non_export_controlled is not true
    or p_quote_only is not true then
    raise exception 'All Xometry beta dispatch affirmations are required.';
  end if;
  if p_approval_reference is null then
    raise exception 'A dispatch approval reference is required.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'xometry-beta-approval:'
        || v_organization_id::text
        || ':'
        || p_approval_reference::text,
      0
    )
  );

  select permit.* into v_existing
  from private.xometry_beta_dispatch_permits permit
  where permit.organization_id = v_organization_id
    and permit.approval_reference = p_approval_reference;
  if v_existing.id is not null and (
    v_existing.actor_user_id <> auth.uid() or v_existing.job_id <> p_job_id
    or v_existing.scope_fingerprint is distinct from p_expected_scope_fingerprint
    or v_existing.declared_model_units is distinct from p_declared_model_units
    or v_existing.notice_revision is distinct from p_policy_revision
  ) then raise exception 'xometry_beta_approval_reference_reused'; end if;
  if v_existing.id is null then
    perform private.lock_xometry_beta_dispatch_scope_rows(p_job_id);
  end if;
  v_scope := private.resolve_xometry_beta_dispatch_scope_with_access(
    p_job_id,
    p_declared_model_units,
    v_existing.id
  );
  if p_expected_scope_fingerprint is null
    or p_expected_scope_fingerprint <> v_scope ->> 'scopeFingerprint' then
    raise exception 'xometry_beta_scope_changed';
  end if;
  if p_policy_revision is null
    or p_policy_revision <> v_scope ->> 'policyRevision' then
    raise exception 'xometry_beta_notice_changed';
  end if;

  if v_existing.id is not null then
    if v_existing.actor_user_id <> auth.uid()
      or v_existing.job_id <> p_job_id
      or v_existing.scope_fingerprint <> p_expected_scope_fingerprint
      or v_existing.declared_model_units <> p_declared_model_units
      or v_existing.notice_revision <> p_policy_revision then
      raise exception 'xometry_beta_approval_reference_reused';
    end if;
    return pg_catalog.jsonb_build_object(
      'accepted', true, -- NOSONAR: stable dispatch response key
      'created', false, -- NOSONAR: stable dispatch response key
      'deduplicated', true,
      'permitId', v_existing.id,
      'quoteRequestId', v_existing.quote_request_id, -- NOSONAR: stable dispatch response key
      'quoteRunId', v_existing.quote_run_id,
      'scopeFingerprint', v_existing.scope_fingerprint,
      'status', 'queued'
    );
  end if;

  v_access := private.resolve_quote_access(p_job_id,auth.uid());
  if v_access ->> 'state' is distinct from 'eligible' then
    raise exception '%', coalesce(v_access ->> 'reasonCode','free_policy_unavailable');
  end if;
  if v_access ->> 'source' = 'free_beta' and v_capacity ->> 'bucketId' is null then
    raise exception 'free_policy_unavailable';
  end if;

  v_result := private.request_scoped_automatic_quote_impl(
    p_job_id,
    array['xometry']::public.vendor_name[]
  );
  if coalesce((v_result ->> 'accepted')::boolean, false) is not true
    or coalesce((v_result ->> 'created')::boolean, false) is not true then
    raise exception 'xometry_beta_new_lane_required';
  end if;

  select lane.* into strict v_lane
  from public.quote_request_lanes lane
  where lane.quote_request_id = (v_result ->> 'quoteRequestId')::uuid;
  if v_lane.vendor <> 'xometry'
    or v_lane.scope_fingerprint <> p_expected_scope_fingerprint
    or v_lane.part_id <> (v_scope ->> 'partId')::uuid
    -- OVD-987: the scope quantity while the switch is on, else 1.
    or v_lane.requested_quantity is distinct from (case
      when private.xometry_beta_user_quantity_enabled()
        then (v_scope ->> 'requestedQuantity')::integer
      else 1
    end) then
    raise exception 'xometry_beta_created_lane_mismatch';
  end if;

  select result_row.* into strict v_result_row
  from public.vendor_quote_results result_row
  where result_row.id = v_lane.vendor_quote_result_id;

  select task.* into strict v_task
  from public.work_queue task
  where task.quote_run_id = v_lane.quote_run_id
    and task.part_id = v_lane.part_id
    and task.task_type = 'run_vendor_quote'
    and task.payload ->> 'vendor' = 'xometry';

  insert into private.xometry_beta_dispatch_permits (
    id, organization_id, job_id, part_id, quote_request_id, quote_run_id,
    vendor_quote_result_id, quote_request_lane_id, work_queue_task_id,
    actor_user_id, notice_revision, approval_reference, provider,
    scope_version, scope_fingerprint, declared_model_units,
    authority_to_share, non_export_controlled, quote_only
  ) values (
    v_permit_id, (v_scope ->> 'organizationId')::uuid, p_job_id,
    (v_scope ->> 'partId')::uuid, v_lane.quote_request_id, v_lane.quote_run_id,
    v_result_row.id, v_lane.id, v_task.id, auth.uid(), p_policy_revision,
    p_approval_reference, 'xometry', v_lane.scope_version,
    v_lane.scope_fingerprint, p_declared_model_units,
    p_authority_to_share, p_non_export_controlled, p_quote_only
  );

  perform private.record_quote_access_admission(
    v_lane.quote_request_id, p_approval_reference, v_access ->> 'source',
    case when v_access ->> 'source' = 'free_beta' then (v_capacity ->> 'bucketId')::uuid else null end
  );

  update public.work_queue
  set payload = payload || pg_catalog.jsonb_build_object(
    'xometryBetaDispatchPermitId', v_permit_id,
    'xometryBetaEnvelopeRevision', 'xometry-controlled-beta-envelope.v1',
    'quoteLaneScopeFingerprint', v_lane.scope_fingerprint
  )
  where id = v_task.id;

  return v_result || pg_catalog.jsonb_build_object(
    'permitId', v_permit_id,
    'scopeFingerprint', v_lane.scope_fingerprint,
    'declaredModelUnits', p_declared_model_units,
    'envelopeRevision', 'xometry-controlled-beta-envelope.v1'
  );
end;
$$;

revoke all on function public.api_request_xometry_beta_dispatch(
  uuid, text, text, text, uuid, boolean, boolean, boolean
) from public, anon, authenticated, service_role;
grant execute on function public.api_request_xometry_beta_dispatch(
  uuid, text, text, text, uuid, boolean, boolean, boolean
) to authenticated;

-- S4: worker preflight (latest 20261002182910). Changed: lane quantity
-- identity, the switch re-check, and the current-candidate quantity.
create or replace function public.api_authorize_xometry_beta_worker_dispatch(
  p_work_queue_task_id uuid,
  p_vendor_quote_result_id uuid,
  p_scope_snapshot jsonb,
  p_expected_worker_name text,
  p_expected_claimed_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_provider constant public.vendor_name := 'xometry';
  v_envelope_revision constant text := 'xometry-controlled-beta-envelope.v1';
  v_authorized_key constant text := 'authorized';
  v_reason_key constant text := 'reasonCode';
  v_task public.work_queue%rowtype;
  v_result public.vendor_quote_results%rowtype;
  v_lane public.quote_request_lanes%rowtype;
  v_permit private.xometry_beta_dispatch_permits%rowtype;
  v_job public.jobs%rowtype;
  v_request_status text;
  v_notice jsonb;
  v_beta_state jsonb;
  v_entitlements jsonb;
  v_admission jsonb;
  v_effective_vendors public.vendor_name[];
  v_current_candidate record;
  v_current_candidate_count integer;
  v_task_permit_id_text text;
begin
  if p_work_queue_task_id is null
    or p_vendor_quote_result_id is null
    or p_scope_snapshot is null
    or nullif(pg_catalog.btrim(p_expected_worker_name), '') is null
    or p_expected_claimed_at is null
    or pg_catalog.jsonb_typeof(p_scope_snapshot) <> 'object'
    or p_scope_snapshot ->> 'schema' <> 'quote-lane-scope.v1'
    or p_scope_snapshot ->> 'vendor' <> v_provider::text then
    return pg_catalog.jsonb_build_object(
      v_authorized_key, false,
      v_reason_key, 'dispatch_preflight_invalid_input'
    );
  end if;

  select task_row.* into v_task
  from public.work_queue task_row
  where task_row.id = p_work_queue_task_id
  for update;

  if v_task.id is null
    or v_task.task_type <> 'run_vendor_quote'
    or v_task.status <> 'running'
    or v_task.locked_at is null
    or v_task.locked_by is distinct from p_expected_worker_name
    or v_task.locked_at is distinct from p_expected_claimed_at then
    return pg_catalog.jsonb_build_object(
      v_authorized_key, false,
      v_reason_key, 'dispatch_task_not_running'
    );
  end if;

  if v_task.payload ->> 'vendor' is distinct from v_provider::text
    or v_task.payload ->> 'vendorQuoteResultId' is distinct from p_vendor_quote_result_id::text
    or v_task.payload ->> 'quoteRunId' is distinct from v_task.quote_run_id::text
    or v_task.payload ->> 'partId' is distinct from v_task.part_id::text then
    return pg_catalog.jsonb_build_object(
      v_authorized_key, false,
      v_reason_key, 'dispatch_task_identity_mismatch'
    );
  end if;

  v_task_permit_id_text := v_task.payload ->> 'xometryBetaDispatchPermitId';
  if v_task_permit_id_text is null
    or v_task_permit_id_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or v_task.payload ->> 'xometryBetaEnvelopeRevision' is distinct from v_envelope_revision
    or v_task.payload ->> 'quoteLaneScopeFingerprint' is null then
    return pg_catalog.jsonb_build_object(
      v_authorized_key, false,
      v_reason_key, 'dispatch_permit_binding_missing'
    );
  end if;

  select permit_row.* into v_permit
  from private.xometry_beta_dispatch_permits permit_row
  where permit_row.id = v_task_permit_id_text::uuid;

  select result_row.* into v_result
  from public.vendor_quote_results result_row
  where result_row.id = p_vendor_quote_result_id;

  if v_permit.id is null
    or v_result.id is null
    or v_result.status <> 'running'
    or v_permit.provider <> v_provider
    or v_permit.envelope_revision <> v_envelope_revision
    or v_permit.authority_to_share is not true
    or v_permit.non_export_controlled is not true
    or v_permit.quote_only is not true
    or v_permit.work_queue_task_id <> v_task.id
    or v_permit.vendor_quote_result_id <> v_result.id
    or v_permit.organization_id <> v_task.organization_id
    or v_permit.organization_id <> v_result.organization_id
    or v_permit.job_id <> v_task.job_id
    or v_permit.part_id <> v_task.part_id
    or v_permit.part_id <> v_result.part_id
    or v_permit.quote_run_id <> v_task.quote_run_id
    or v_permit.quote_run_id <> v_result.quote_run_id then
    return pg_catalog.jsonb_build_object(
      v_authorized_key, false,
      v_reason_key, 'dispatch_permit_identity_mismatch'
    );
  end if;

  select lane_row.* into v_lane
  from public.quote_request_lanes lane_row
  where lane_row.id = v_permit.quote_request_lane_id;

  if v_lane.id is null
    or v_lane.organization_id <> v_permit.organization_id
    or v_lane.quote_request_id <> v_permit.quote_request_id
    or v_lane.quote_run_id <> v_permit.quote_run_id
    or v_lane.vendor_quote_result_id <> v_permit.vendor_quote_result_id
    or v_lane.part_id <> v_permit.part_id
    or v_lane.vendor <> v_provider
    -- OVD-987: the lane quantity must be the one its own scope snapshot states,
    -- and the result and the task payload the worker reads must name it too.
    or v_lane.requested_quantity::text is distinct from (v_lane.scope_snapshot ->> 'quantity')
    or v_result.requested_quantity is distinct from v_lane.requested_quantity
    or (v_task.payload ? 'requestedQuantity'
      and v_task.payload ->> 'requestedQuantity' is distinct from v_lane.requested_quantity::text)
    or v_lane.scope_version <> v_permit.scope_version
    or v_lane.scope_fingerprint <> v_permit.scope_fingerprint
    or v_task.payload ->> 'quoteLaneScopeFingerprint' is distinct from v_permit.scope_fingerprint then
    return pg_catalog.jsonb_build_object(
      v_authorized_key, false,
      v_reason_key, 'dispatch_lane_identity_mismatch'
    );
  end if;

  select job_row.* into v_job
  from public.jobs job_row
  where job_row.id = v_permit.job_id;

  select request_row.status::text into v_request_status
  from public.quote_requests request_row
  where request_row.id = v_permit.quote_request_id;

  if v_job.id is null
    or v_job.organization_id <> v_permit.organization_id
    or v_request_status is null
    or v_request_status not in ('queued', 'requesting') then
    return pg_catalog.jsonb_build_object(
      v_authorized_key, false,
      v_reason_key, 'dispatch_request_inactive'
    );
  end if;

  perform pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended(
      'founding-beta:' || v_permit.organization_id::text,
      0
    )
  );

  v_notice := private.current_founding_beta_notice();
  v_beta_state := private.resolve_founding_beta_access_state(
    v_permit.organization_id,
    v_permit.actor_user_id
  );
  if v_beta_state ->> 'state' <> 'eligible'
    or v_notice ->> 'policyRevision' is distinct from v_permit.notice_revision then
    return pg_catalog.jsonb_build_object(
      v_authorized_key, false,
      v_reason_key, 'dispatch_beta_authorization_revoked'
    );
  end if;

  v_admission := private.validate_quote_access_admission(v_permit.quote_request_id,v_permit.id);
  if v_admission ->> 'source' = 'free_beta' then
    if v_admission -> 'valid' is distinct from 'true'::jsonb
      or v_admission ->> 'state' is distinct from 'reserved' then
      return pg_catalog.jsonb_build_object(v_authorized_key,false,v_reason_key,'dispatch_automatic_access_revoked');
    end if;
  elsif (v_admission -> 'valid' = 'true'::jsonb
      and v_admission ->> 'source' = 'commercial_entitlement'
      and v_admission ->> 'state' = 'unmetered')
    or v_admission ->> 'reasonCode' = 'legacy_unrecorded' then
  v_entitlements := private.resolve_organization_entitlements_at(
    v_permit.organization_id,
    pg_catalog.now()
  );
  if coalesce(
    v_entitlements -> 'automaticQuoteCollection' = 'true'::jsonb,
    false
  ) is not true then
    return pg_catalog.jsonb_build_object(
      v_authorized_key, false,
      v_reason_key, 'dispatch_automatic_access_revoked'
    );
  end if;

  else
    return pg_catalog.jsonb_build_object(v_authorized_key,false,v_reason_key,'dispatch_automatic_access_revoked');
  end if;

  if not private.automatic_quote_rollout_enabled_with_lock() then
    return pg_catalog.jsonb_build_object(
      v_authorized_key, false,
      v_reason_key, 'dispatch_rollout_disabled'
    );
  end if;

  -- OVD-987: a lane above quantity 1 dispatches only while the
  -- controlled_beta_user_quantity switch is on. The shared lock makes an
  -- audited disable wait for this check, like the rollout check above.
  if v_lane.requested_quantity <> 1 then
    perform pg_catalog.pg_advisory_xact_lock_shared(
      pg_catalog.hashtextextended('commercial-rollout:controlled_beta_user_quantity', 0)
    );
    if not private.xometry_beta_user_quantity_enabled() then
      return pg_catalog.jsonb_build_object(
        v_authorized_key, false,
        v_reason_key, 'dispatch_quantity_not_admitted'
      );
    end if;
  end if;

  if not exists (
    select 1
    from public.org_vendor_configs config_row
    where config_row.organization_id = v_permit.organization_id
  ) then
    return pg_catalog.jsonb_build_object(
      v_authorized_key, false,
      v_reason_key, 'dispatch_provider_configuration_changed'
    );
  end if;

  v_effective_vendors := public.get_enabled_client_quote_vendors(
    v_permit.organization_id,
    v_job.project_id,
    v_job.id
  );
  if v_effective_vendors <> array[v_provider]::public.vendor_name[] then
    return pg_catalog.jsonb_build_object(
      v_authorized_key, false,
      v_reason_key, 'dispatch_provider_configuration_changed'
    );
  end if;

  if p_scope_snapshot is distinct from v_lane.scope_snapshot then
    return pg_catalog.jsonb_build_object(
      v_authorized_key, false,
      v_reason_key, 'dispatch_staged_scope_changed'
    );
  end if;

  select candidate.* into v_current_candidate
  from private.quote_lane_candidates(
    v_permit.job_id,
    array[v_provider]::public.vendor_name[]
  ) candidate
  where candidate.organization_id = v_permit.organization_id
    and candidate.part_id = v_permit.part_id
    and candidate.vendor = v_provider
    and candidate.requested_quantity = v_lane.requested_quantity; -- OVD-987

  select count(*)::integer into v_current_candidate_count
  from private.quote_lane_candidates(
    v_permit.job_id,
    array[v_provider]::public.vendor_name[]
  ) candidate;

  if v_current_candidate_count <> 1
    or v_current_candidate.scope_fingerprint is null
    or v_current_candidate.scope_version <> v_permit.scope_version
    or v_current_candidate.scope_fingerprint <> v_permit.scope_fingerprint
    or v_current_candidate.scope_snapshot is distinct from p_scope_snapshot then
    return pg_catalog.jsonb_build_object(
      v_authorized_key, false,
      v_reason_key, 'dispatch_current_scope_changed'
    );
  end if;

  return pg_catalog.jsonb_build_object(
    v_authorized_key, true,
    v_reason_key, null,
    'permitId', v_permit.id,
    'provider', v_provider,
    'scopeFingerprint', v_permit.scope_fingerprint,
    'envelopeRevision', v_envelope_revision,
    'nonExportControlled', true
  );
end;
$$;

revoke all on function public.api_authorize_xometry_beta_worker_dispatch(
  uuid, uuid, jsonb, text, timestamptz
) from public, anon, authenticated, service_role;
grant execute on function public.api_authorize_xometry_beta_worker_dispatch(
  uuid, uuid, jsonb, text, timestamptz
) to service_role;

-- S5: free-beta admission (latest 20261002182714). Changed: lane quantity identity.
create or replace function private.record_quote_access_admission(
  p_quote_request_id uuid, p_approval_reference uuid, p_admission_source text, p_bucket_id uuid
)
returns uuid language plpgsql volatile security definer set search_path = pg_catalog as $$
declare
  v_permit private.xometry_beta_dispatch_permits%rowtype;
  v_existing private.quote_access_admissions%rowtype;
  v_policy jsonb;
  v_access jsonb;
  v_limit integer;
  v_occupied bigint;
  v_id uuid;
begin
  select * into strict v_permit from private.xometry_beta_dispatch_permits
    where quote_request_id = p_quote_request_id and approval_reference = p_approval_reference;
  if v_permit.actor_user_id is distinct from auth.uid() then raise exception 'quote_access_identity_mismatch'; end if;
  select * into v_existing from private.quote_access_admissions where quote_request_id = p_quote_request_id;
  if v_existing.id is not null then
    if v_existing.permit_id <> v_permit.id or v_existing.approval_reference <> p_approval_reference
      or v_existing.admission_source is distinct from p_admission_source
      or v_existing.bucket_id is distinct from p_bucket_id then raise exception 'quote_access_identity_mismatch'; end if;
    return v_existing.id;
  end if;
  if current_setting('transaction_isolation') <> 'read committed' then raise exception 'free_quote_isolation_unsupported'; end if;
  -- This recheck must not acquire locks below an already held job lock.
  -- The two-key advisory locks must already be held by the admitted wrapper.
  if not exists (select 1 from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()
      and granted and mode in ('ShareLock','ExclusiveLock')
      and classid = ((hashtextextended('free-quote-config', 0) >> 32) & 4294967295)::oid
      and objid = (hashtextextended('free-quote-config', 0) & 4294967295)::oid and objsubid = 1) then
    raise exception 'free_quote_admission_lock_required';
  end if;
  if not exists (select 1 from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()
      and granted and mode = 'ExclusiveLock'
      and classid = ((hashtextextended('free-quote-subject:organization:' || v_permit.organization_id::text, 0) >> 32) & 4294967295)::oid
      and objid = (hashtextextended('free-quote-subject:organization:' || v_permit.organization_id::text, 0) & 4294967295)::oid and objsubid = 1)
    or not exists (select 1 from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()
      and granted and mode = 'ExclusiveLock'
      and classid = ((hashtextextended('free-quote-subject:user:' || v_permit.actor_user_id::text, 0) >> 32) & 4294967295)::oid
      and objid = (hashtextextended('free-quote-subject:user:' || v_permit.actor_user_id::text, 0) & 4294967295)::oid and objsubid = 1) then
    raise exception 'free_quote_admission_lock_required';
  end if;
  if not exists (
    select 1 from public.quote_requests request_row
    join public.quote_runs run on run.id = v_permit.quote_run_id and run.quote_request_id = request_row.id
    join public.quote_request_lanes lane on lane.id = v_permit.quote_request_lane_id
    join public.vendor_quote_results result on result.id = v_permit.vendor_quote_result_id
    where request_row.id = p_quote_request_id and request_row.organization_id = v_permit.organization_id
      and request_row.job_id = v_permit.job_id and request_row.requested_by = v_permit.actor_user_id
      and request_row.status = 'queued' and result.status = 'queued'
      and run.organization_id = v_permit.organization_id and run.job_id = v_permit.job_id
      and lane.organization_id = v_permit.organization_id and lane.quote_request_id = request_row.id
      and lane.quote_run_id = run.id and lane.vendor_quote_result_id = result.id
      and lane.scope_version = v_permit.scope_version and lane.scope_fingerprint = v_permit.scope_fingerprint
      and lane.part_id = v_permit.part_id and lane.vendor = v_permit.provider and lane.requested_quantity::text = (lane.scope_snapshot ->> 'quantity') -- OVD-987
      and result.quote_run_id = run.id and result.organization_id = v_permit.organization_id
      and result.part_id = lane.part_id and result.vendor = lane.vendor and result.requested_quantity = lane.requested_quantity
  ) or (select count(*) from public.quote_request_lanes where quote_request_id = p_quote_request_id) <> 1 then
    raise exception 'quote_access_identity_mismatch';
  end if;
  v_access := private.resolve_quote_access(v_permit.job_id, v_permit.actor_user_id);
  if v_access ->> 'state' is distinct from 'eligible' or v_access ->> 'source' is distinct from p_admission_source then
    raise exception 'quote_access_changed';
  end if;
  if p_admission_source = 'free_beta' then
    v_policy := private.resolve_free_quote_policy(v_permit.job_id, v_permit.actor_user_id);
    if (v_policy ->> 'configured')::boolean is not true or (v_policy ->> 'bucketId')::uuid is distinct from p_bucket_id
      or not exists (select 1 from private.free_quote_buckets where id = p_bucket_id
        and policy_id = (v_policy ->> 'policyId')::uuid and subject_kind = v_policy ->> 'subjectKind'
        and subject_id = (v_policy ->> 'subjectId')::uuid) then raise exception 'free_policy_unavailable'; end if;
    v_limit := (v_policy ->> 'completedLimit')::integer;
    select count(*) into v_occupied from private.quote_access_admissions
      where bucket_id = p_bucket_id and state in ('reserved', 'consumed');
    if v_occupied >= v_limit then raise exception 'free_allowance_unavailable'; end if;
  elsif p_admission_source <> 'commercial_entitlement' or p_bucket_id is not null then
    raise exception 'quote_access_source_invalid';
  end if;
  insert into private.quote_access_admissions(organization_id, actor_user_id, job_id, quote_request_id,
    quote_run_id, permit_id, approval_reference, scope_version, scope_fingerprint, notice_revision,
    admission_source, bucket_id, policy_revision, state)
  values (v_permit.organization_id, v_permit.actor_user_id, v_permit.job_id, p_quote_request_id,
    v_permit.quote_run_id, v_permit.id, p_approval_reference, v_permit.scope_version, v_permit.scope_fingerprint,
    v_permit.notice_revision, p_admission_source, p_bucket_id, v_policy ->> 'policyRevision',
    case when p_admission_source = 'free_beta' then 'reserved' else 'unmetered' end)
  returning id into v_id;
  return v_id;
end;
$$;

-- S6: free-beta settlement (latest 20261002182714). Changed: lane quantity identity.
create or replace function private.finalize_free_quote_job(p_quote_request_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = pg_catalog as $$
declare
  v_request public.quote_requests%rowtype;
  v_row private.quote_access_admissions%rowtype;
  v_permit private.xometry_beta_dispatch_permits%rowtype;
  v_lane public.quote_request_lanes%rowtype;
  v_result public.vendor_quote_results%rowtype;
  v_offer public.vendor_quote_offers%rowtype;
  v_at timestamptz;
  v_reason text;
begin
  select * into v_request from public.quote_requests where id = p_quote_request_id for update;
  select * into v_row from private.quote_access_admissions where quote_request_id = p_quote_request_id for update;
  if v_row.id is null or v_row.state <> 'reserved' then
    return jsonb_build_object('state', v_row.state, 'reasonCode', 'unchanged', 'changed', false);
  end if;
  if v_request.id is null or v_request.organization_id <> v_row.organization_id
    or v_request.job_id <> v_row.job_id or v_request.requested_by <> v_row.actor_user_id then
    return jsonb_build_object('state', 'reserved', 'reasonCode', 'identity_indeterminate', 'changed', false);
  end if;
  if v_request.status = 'canceled' then return private.release_cancelled_free_quote_job(p_quote_request_id); end if;
  select * into v_permit from private.xometry_beta_dispatch_permits where id = v_row.permit_id;
  select * into v_lane from public.quote_request_lanes where id = v_permit.quote_request_lane_id;
  select * into v_result from public.vendor_quote_results where id = v_permit.vendor_quote_result_id;
  if v_permit.id is null or v_lane.id is null or v_result.id is null
    or v_permit.quote_request_id <> v_row.quote_request_id or v_permit.quote_run_id <> v_row.quote_run_id
    or v_permit.organization_id <> v_row.organization_id or v_permit.actor_user_id <> v_row.actor_user_id
    or v_permit.job_id <> v_row.job_id or v_permit.approval_reference <> v_row.approval_reference
    or v_permit.notice_revision <> v_row.notice_revision or v_permit.scope_version <> v_row.scope_version
    or v_permit.scope_fingerprint <> v_row.scope_fingerprint
    or v_lane.organization_id <> v_row.organization_id or v_lane.quote_request_id <> v_row.quote_request_id
    or v_lane.quote_run_id <> v_row.quote_run_id or v_lane.vendor_quote_result_id <> v_result.id
    or v_lane.scope_version <> v_row.scope_version or v_lane.scope_fingerprint <> v_row.scope_fingerprint
    or v_lane.part_id <> v_permit.part_id or v_lane.vendor <> v_permit.provider
    or v_lane.requested_quantity::text is distinct from (v_lane.scope_snapshot ->> 'quantity') -- OVD-987
    or v_result.quote_run_id <> v_row.quote_run_id or v_result.organization_id <> v_row.organization_id
    or v_result.part_id <> v_lane.part_id or v_result.vendor <> v_lane.vendor
    or v_result.requested_quantity <> v_lane.requested_quantity
    or (select count(*) from public.quote_request_lanes where quote_request_id = v_row.quote_request_id) <> 1
    or not exists (select 1 from public.quote_runs where id = v_row.quote_run_id
      and quote_request_id = v_row.quote_request_id and organization_id = v_row.organization_id and job_id = v_row.job_id) then
    return jsonb_build_object('state', 'reserved', 'reasonCode', 'identity_indeterminate', 'changed', false);
  end if;
  if v_result.status in ('queued', 'running') then
    return jsonb_build_object('state', 'reserved', 'reasonCode', 'in_flight', 'changed', false);
  end if;
  -- A worker task may still be 'running' while cleaning up a committed terminal
  -- result. The result status (queued/running vs terminal), not cleanup, is authority.
  if v_result.status not in ('failed', 'manual_review_pending', 'manual_vendor_followup',
    'instant_quote_received', 'official_quote_received') then
    return jsonb_build_object('state', 'reserved', 'reasonCode', 'outcome_indeterminate', 'changed', false);
  end if;
  v_at := clock_timestamp();
  if v_result.status in ('instant_quote_received', 'official_quote_received') then
    select offer.* into v_offer from public.vendor_quote_offers offer
    where offer.vendor_quote_result_id = v_result.id and offer.organization_id = v_row.organization_id
      and offer.provenance_status in ('trusted_adapter', 'manual_verified') and offer.invalidated_at is null
      and (offer.unit_price_usd is not null or offer.total_price_usd is not null)
      and (offer.unit_price_usd is null or (offer.unit_price_usd::text not in ('NaN','Infinity','-Infinity') and offer.unit_price_usd >= 0))
      and (offer.total_price_usd is null or (offer.total_price_usd::text not in ('NaN','Infinity','-Infinity') and offer.total_price_usd >= 0))
      and offer.quoted_at is not null and isfinite(offer.quoted_at) and offer.quoted_at <= v_at
      and offer.valid_until is not null and isfinite(offer.valid_until)
      and offer.valid_until >= offer.quoted_at and offer.valid_until >= v_at
      and exists (select 1 from private.quote_lane_candidates(v_row.job_id, array['xometry']::public.vendor_name[]) candidate
        where candidate.organization_id = v_row.organization_id and candidate.part_id = v_lane.part_id
          and candidate.vendor = v_lane.vendor and candidate.requested_quantity = v_lane.requested_quantity
          and candidate.scope_version = v_row.scope_version and candidate.scope_fingerprint = v_row.scope_fingerprint)
    order by offer.valid_until desc, offer.id limit 1;
  end if;
  if v_offer.id is not null then
    update private.quote_access_admissions set state = 'consumed', terminal_at = v_at, outcome_reason = 'usable_quote',
      qualifying_offer_id = v_offer.id,
      qualifying_evidence = jsonb_build_object('schema', 'free-quote-completion.v1', 'offerId', v_offer.id,
        'resultId', v_result.id, 'scopeFingerprint', v_row.scope_fingerprint, 'observedAt', v_at,
        'quotedAt', v_offer.quoted_at, 'validUntil', v_offer.valid_until, 'provenance', v_offer.provenance_status,
        'unitPriceUsd', v_offer.unit_price_usd, 'totalPriceUsd', v_offer.total_price_usd, 'outcome', 'complete')
    where id = v_row.id;
    return jsonb_build_object('state', 'consumed', 'reasonCode', 'usable_quote', 'changed', true);
  end if;
  v_reason := case when v_result.status in ('failed','manual_review_pending','manual_vendor_followup') then 'failed' else 'no_usable_offer' end;
  update private.quote_access_admissions set state = 'released', terminal_at = v_at, outcome_reason = v_reason where id = v_row.id;
  return jsonb_build_object('state', 'released', 'reasonCode', v_reason, 'changed', true);
end;
$$;

revoke all on function private.record_quote_access_admission(uuid,uuid,text,uuid),
  private.finalize_free_quote_job(uuid)
  from public, anon, authenticated, service_role;
-- Owner-only: callers are SECURITY DEFINER; no API role gets EXECUTE.
grant execute on function private.record_quote_access_admission(uuid,uuid,text,uuid) to postgres;
grant execute on function private.finalize_free_quote_job(uuid) to postgres;

-- S7: terminal-task reconciliation (latest 20261003011148). Changed: result
-- and lane quantity identity.
create or replace function public.api_reconcile_terminal_free_quote_tasks(
  p_after_admission_id uuid default null,
  p_limit integer default 100
) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog as $$
declare
  v_candidate record;
  v_receipt private.quote_access_admissions%rowtype;
  v_permit private.xometry_beta_dispatch_permits%rowtype;
  v_result public.vendor_quote_results%rowtype;
  v_request public.quote_requests%rowtype;
  v_task public.work_queue%rowtype;
  v_lane public.quote_request_lanes%rowtype;
  v_settlement jsonb;
  v_scanned integer := 0;
  v_reconciled integer := 0;
  v_indeterminate integer := 0;
  v_deferred integer := 0;
  v_last uuid;
begin
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'free_quote_reconciliation_limit_invalid';
  end if;
  if current_setting('transaction_isolation') is distinct from 'read committed' then
    raise exception 'free_quote_reconciliation_requires_read_committed';
  end if;
  for v_candidate in
    select admission.id, admission.permit_id, admission.quote_request_id
    from private.quote_access_admissions admission
    where admission.admission_source = 'free_beta' and admission.state = 'reserved'
      and (p_after_admission_id is null or admission.id > p_after_admission_id)
    order by admission.id limit p_limit
  loop
    v_scanned := v_scanned + 1;
    v_last := v_candidate.id;
    select * into v_permit from private.xometry_beta_dispatch_permits where id = v_candidate.permit_id;
    if v_permit.id is null then
      v_indeterminate := v_indeterminate + 1; continue;
    end if;
    -- Each statement gets a fresh READ COMMITTED snapshot. SKIP LOCKED avoids
    -- waiting behind active canonical writers or cancellation, including when
    -- this bounded batch already holds earlier candidates' locks.
    select * into v_result from public.vendor_quote_results
      where id = v_permit.vendor_quote_result_id for update skip locked;
    if v_result.id is null then
      if exists (select 1 from public.vendor_quote_results where id = v_permit.vendor_quote_result_id) then
        v_deferred := v_deferred + 1;
      else v_indeterminate := v_indeterminate + 1; end if;
      continue;
    end if;
    select * into v_request from public.quote_requests
      where id = v_candidate.quote_request_id for update skip locked;
    if v_request.id is null then
      if exists (select 1 from public.quote_requests where id = v_candidate.quote_request_id) then
        v_deferred := v_deferred + 1;
      else v_indeterminate := v_indeterminate + 1; end if;
      continue;
    end if;
    select * into v_task from public.work_queue
      where id = v_permit.work_queue_task_id for update skip locked;
    if v_task.id is null then
      if exists (select 1 from public.work_queue where id = v_permit.work_queue_task_id) then
        v_deferred := v_deferred + 1;
      else v_indeterminate := v_indeterminate + 1; end if;
      continue;
    end if;
    select * into v_receipt from private.quote_access_admissions where id = v_candidate.id;
    if v_receipt.state is distinct from 'reserved' then continue; end if;
    select * into v_lane from public.quote_request_lanes where id = v_permit.quote_request_lane_id;
    -- Resolve IDs from the immutable permit. Never trust work_queue payload IDs.
    if v_lane.id is null
      or v_receipt.admission_source is distinct from 'free_beta'
      or v_receipt.permit_id is distinct from v_permit.id
      or v_receipt.quote_request_id is distinct from v_request.id or v_permit.quote_request_id is distinct from v_request.id
      or v_receipt.quote_run_id is distinct from v_permit.quote_run_id or v_receipt.job_id is distinct from v_permit.job_id
      or v_receipt.organization_id is distinct from v_permit.organization_id or v_receipt.actor_user_id is distinct from v_permit.actor_user_id
      or v_receipt.approval_reference is distinct from v_permit.approval_reference
      or v_receipt.notice_revision is distinct from v_permit.notice_revision
      or v_receipt.scope_version is distinct from v_permit.scope_version or v_receipt.scope_fingerprint is distinct from v_permit.scope_fingerprint
      or v_request.organization_id is distinct from v_receipt.organization_id or v_request.job_id is distinct from v_receipt.job_id
      or v_request.requested_by is distinct from v_receipt.actor_user_id
      or v_result.organization_id is distinct from v_receipt.organization_id or v_result.quote_run_id is distinct from v_receipt.quote_run_id
      or v_result.part_id is distinct from v_permit.part_id or v_result.vendor is distinct from v_permit.provider
      or v_result.requested_quantity is distinct from v_lane.requested_quantity -- OVD-987
      or v_task.task_type is distinct from 'run_vendor_quote' or v_task.organization_id is distinct from v_receipt.organization_id
      or v_task.job_id is distinct from v_receipt.job_id or v_task.part_id is distinct from v_permit.part_id
      or v_task.quote_run_id is distinct from v_receipt.quote_run_id
      or v_lane.organization_id is distinct from v_receipt.organization_id or v_lane.quote_request_id is distinct from v_request.id
      or v_lane.quote_run_id is distinct from v_receipt.quote_run_id or v_lane.vendor_quote_result_id is distinct from v_result.id
      or v_lane.part_id is distinct from v_permit.part_id or v_lane.vendor is distinct from v_permit.provider
      or v_lane.requested_quantity::text is distinct from (v_lane.scope_snapshot ->> 'quantity') -- OVD-987
      or v_lane.scope_version is distinct from v_receipt.scope_version or v_lane.scope_fingerprint is distinct from v_receipt.scope_fingerprint
      or (select count(*) from public.quote_request_lanes where quote_request_id = v_request.id) is distinct from 1
      or not exists (select 1 from public.quote_runs where id = v_receipt.quote_run_id
        and quote_request_id = v_request.id and job_id = v_receipt.job_id and organization_id = v_receipt.organization_id)
      or not exists (select 1 from public.jobs where id = v_receipt.job_id and organization_id = v_receipt.organization_id)
    then
      v_indeterminate := v_indeterminate + 1; continue;
    end if;
    -- A re-claimed/retried task has a new active state or lease. It is not a
    -- terminal failure, even if an earlier scan observed one. Never touch it.
    if v_task.status not in ('failed','cancelled') or v_task.locked_at is not null or v_task.locked_by is not null then
      v_deferred := v_deferred + 1; continue;
    end if;
    if v_request.status = 'canceled' then
      v_settlement := private.release_cancelled_free_quote_job(v_request.id);
    elsif v_result.status in ('queued','running') then
      if v_request.status not in ('queued','requesting') then
        v_indeterminate := v_indeterminate + 1; continue;
      end if;
      update public.vendor_quote_results set status = 'failed' where id = v_result.id;
      -- Existing result fence/reducer and finalizer remain authoritative.
      -- Explicit settlement also covers initially deferred constraint timing.
      v_settlement := private.finalize_free_quote_job(v_request.id);
    else
      -- Preserve canonical success and consume only an existing usable offer;
      -- never replace it with a failure because queue cleanup failed afterward.
      v_settlement := private.finalize_free_quote_job(v_request.id);
    end if;
    if v_settlement ->> 'state' in ('released','consumed') then
      v_reconciled := v_reconciled + 1;
    else
      v_indeterminate := v_indeterminate + 1;
    end if;
  end loop;
  return jsonb_build_object('scanned',v_scanned,'reconciled',v_reconciled,
    'indeterminate',v_indeterminate,'deferred',v_deferred,
    'nextCursor',case when v_scanned = p_limit then v_last else null end);
end;
$$;
revoke all on function public.api_reconcile_terminal_free_quote_tasks(uuid,integer)
  from public, anon, authenticated;
grant execute on function public.api_reconcile_terminal_free_quote_tasks(uuid,integer) to service_role;
