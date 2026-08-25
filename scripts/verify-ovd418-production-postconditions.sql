-- OVD-418 hosted production post-release verification.
--
-- Read-only by construction. This script inspects the exact migration ledger,
-- PostgreSQL catalogs, reviewed provider configuration metadata, and aggregate
-- rollout/work/offer counts. It does not project customer row identity or
-- content and does not invoke application or reconciliation functions.

begin read only;
set local ovd418.audit_phase = 'postcondition';
\ir verify-ovd418-production-quiescence.sql

do $ovd418_postconditions$
declare
  v_count bigint;
  v_fingerprint text;
  v_head text;
  v_statement_hash text;
  v_suffix_versions text[];
  v_suffix_statement_hashes text[];
  v_definition text;
  v_oid oid;
  v_provider_resolver_oid oid;
  v_offer_reconciler_oid oid;
  v_expected record;
begin
  -- Exact final ledger and production-derived baseline.
  select
    pg_catalog.count(*),
    pg_catalog.max(version::text),
    pg_catalog.md5(
      pg_catalog.string_agg(
        version::text || ':' || pg_catalog.md5(pg_catalog.to_json(statements)::text),
        E'\n'
        order by version::text
      )
    )
  into v_count, v_head, v_fingerprint
  from supabase_migrations.schema_migrations;

  if v_count <> 104
     or v_head <> '20260822213330'
     or v_fingerprint <> '28b8ae8752e5beb8e91505a2becfde86' then
    raise exception
      'OVD-418 final ledger mismatch: expected 104 migrations through 20260822213330 with fingerprint 28b8ae8752e5beb8e91505a2becfde86, found % through % with fingerprint %',
      v_count,
      coalesce(v_head, '<none>'),
      coalesce(v_fingerprint, '<none>');
  end if;

  select
    pg_catalog.count(*),
    pg_catalog.md5(
      pg_catalog.string_agg(
        version::text || ':' || pg_catalog.md5(pg_catalog.to_json(statements)::text),
        E'\n'
        order by version::text
      )
    )
  into v_count, v_fingerprint
  from supabase_migrations.schema_migrations
  where version::text <= '20260817054500'; -- NOSONAR: the frozen production baseline is intentionally repeated in independently auditable checks.

  if v_count <> 100 or v_fingerprint <> 'cbfe91f6f12e00e514b12a22f9fd65fc' then
    raise exception
      'OVD-418 production baseline drifted: expected 100 rows with fingerprint cbfe91f6f12e00e514b12a22f9fd65fc, found % rows with fingerprint %',
      v_count,
      coalesce(v_fingerprint, '<none>');
  end if;

  -- Production continuity is anchored independently of the derived 100- and
  -- 104-row fingerprints. This catches a locally reproducible suffix attached
  -- to the wrong historical statement payload.
  select
    pg_catalog.count(*),
    pg_catalog.max(version::text),
    pg_catalog.md5(
      pg_catalog.string_agg(
        version::text || ':' || pg_catalog.md5(pg_catalog.to_json(statements)::text),
        E'\n'
        order by version::text
      )
    )
  into v_count, v_head, v_fingerprint
  from supabase_migrations.schema_migrations
  where version::text <= '20260816015500'; -- NOSONAR: the frozen OVD-373 boundary is intentionally repeated across independent continuity checks.

  if v_count <> 99
     or v_head <> '20260816015500'
     or v_fingerprint <> '003aabeb74c993bd942f5d59b29855ac' then
    raise exception
      'OVD-418 OVD-373 prefix continuity drifted: expected 99 migrations through 20260816015500 with fingerprint 003aabeb74c993bd942f5d59b29855ac, found % through % with fingerprint %',
      v_count,
      coalesce(v_head, '<none>'),
      coalesce(v_fingerprint, '<none>');
  end if;

  select
    pg_catalog.count(*),
    pg_catalog.max(version::text),
    pg_catalog.md5(
      pg_catalog.string_agg(
        version::text || ':' || pg_catalog.md5(pg_catalog.to_json(statements)::text),
        E'\n'
        order by version::text
      )
    )
  into v_count, v_head, v_fingerprint
  from supabase_migrations.schema_migrations
  where version::text <= '20260816015500'
    and not (version::text = any (array[
      '20260330144838', '20260331000000', '20260331000001', '20260331010000',
      '20260402100000', '20260402120000', '20260403103000', '20260405103000',
      '20260406000000', '20260408120000', '20260408193000', '20260409000000',
      '20260514120000', '20260514120100', '20260725090000', '20260728190000',
      '20260731015300', '20260731015400', '20260815090000', '20260815093000',
      '20260815100000', '20260815184740', '20260816011204', '20260816015000',
      '20260816015500'
    ]));

  if v_count <> 74
     or v_head <> '20260813005020'
     or v_fingerprint <> '7aeeca99fe188de2b537f14dd9c068fa' then
    raise exception
      'OVD-418 original production subset continuity drifted: expected 74 migrations through 20260813005020 with fingerprint 7aeeca99fe188de2b537f14dd9c068fa, found % through % with fingerprint %',
      v_count,
      coalesce(v_head, '<none>'),
      coalesce(v_fingerprint, '<none>');
  end if;

  select
    pg_catalog.count(*),
    pg_catalog.max(pg_catalog.md5(pg_catalog.to_json(statements)::text))
  into v_count, v_statement_hash
  from supabase_migrations.schema_migrations
  where version::text = '20260817054500';

  if v_count <> 1
     or v_statement_hash <> '6529bf2c47a30ea1fe72a710cb279246' then
    raise exception
      'OVD-418 row-100 continuity drifted: expected migration 20260817054500 with statement hash 6529bf2c47a30ea1fe72a710cb279246, found % rows with statement hash %',
      v_count,
      coalesce(v_statement_hash, '<none>');
  end if;

  select
    pg_catalog.array_agg(version::text order by version::text),
    pg_catalog.array_agg(
      pg_catalog.md5(pg_catalog.to_json(statements)::text)
      order by version::text
    )
  into v_suffix_versions, v_suffix_statement_hashes
  from supabase_migrations.schema_migrations
  where version::text > '20260817054500';

  if v_suffix_versions is distinct from array[
       '20260817133902',
       '20260821223849',
       '20260821223851',
       '20260822213330'
     ]::text[]
     or v_suffix_statement_hashes is distinct from array[
       'a677a4b306432cd85c225d98636c94ff',
       '81623dd84a77346330a2d19bf7ebaef7',
       '0672fc05ac550161f3d8e38456733dd2',
       '0106d03b4a0f9df99d670294d7c3d405'
     ]::text[] then
    raise exception
      'OVD-418 reviewed migration suffix or per-row statement hashes drifted: versions %, statement hashes %',
      coalesce(v_suffix_versions::text, '<none>'),
      coalesce(v_suffix_statement_hashes::text, '<none>');
  end if;

  -- OVD-379: the private admission registry remains forced-RLS, policy-free,
  -- and unavailable directly to API roles.
  for v_expected in
    select *
    from (values
      ('private.quote_provider_admission_policies'::text),
      ('private.quote_provider_admission_policy_history'::text)
    ) as expected_tables(signature)
  loop
    select relation.oid
    into v_oid
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace_row
      on namespace_row.oid = relation.relnamespace
    where namespace_row.nspname || '.' || relation.relname = v_expected.signature
      and relation.relkind in ('r', 'p')
      and relation.relrowsecurity
      and relation.relforcerowsecurity;

    if v_oid is null then
      raise exception
        'OVD-418 required forced-RLS provider registry table is missing: %',
        v_expected.signature;
    end if;

    select pg_catalog.count(*) into v_count
    from pg_catalog.pg_policy
    where polrelid = v_oid;
    if v_count <> 0 then
      raise exception
        'OVD-418 provider registry table % unexpectedly has % policies',
        v_expected.signature,
        v_count;
    end if;

    if pg_catalog.has_table_privilege('anon', v_oid, 'select,insert,update,delete')
       or pg_catalog.has_table_privilege('authenticated', v_oid, 'select,insert,update,delete')
       or pg_catalog.has_table_privilege('service_role', v_oid, 'select,insert,update,delete') then
      raise exception
        'OVD-418 provider registry table % is directly available to an API role',
        v_expected.signature;
    end if;
  end loop;

  select pg_catalog.count(*)
  into v_count
  from pg_catalog.pg_trigger trigger_row
  join pg_catalog.pg_class relation on relation.oid = trigger_row.tgrelid
  join pg_catalog.pg_namespace namespace_row on namespace_row.oid = relation.relnamespace
  where not trigger_row.tgisinternal
    and (
      (namespace_row.nspname = 'private'
        and relation.relname = 'quote_provider_admission_policies'
        and trigger_row.tgname in (
          'guard_quote_provider_admission_policy_mutation',
          'capture_quote_provider_admission_policy_history'
        ))
      or
      (namespace_row.nspname = 'private'
        and relation.relname = 'quote_provider_admission_policy_history'
        and trigger_row.tgname = 'reject_quote_provider_admission_history_mutation')
    );
  if v_count <> 3 then
    raise exception
      'OVD-418 expected exactly three provider registry mutation/history triggers, found %',
      v_count;
  end if;

  for v_expected in
    select *
    from (values
      (
        'private.quote_provider_admission_policies'::text,
        'guard_quote_provider_admission_policy_mutation'::text,
        'private.guard_quote_provider_admission_policy_mutation()'::text,
        'before'::text,
        'update'::text,
        'delete'::text
      ),
      (
        'private.quote_provider_admission_policies',
        'capture_quote_provider_admission_policy_history',
        'private.capture_quote_provider_admission_policy_history()',
        'after',
        'insert',
        'update'
      ),
      (
        'private.quote_provider_admission_policy_history',
        'reject_quote_provider_admission_history_mutation',
        'private.reject_quote_provider_admission_history_mutation()',
        'before',
        'update',
        'delete'
      )
    ) as expected_triggers(
      relation_signature,
      trigger_name,
      function_signature,
      timing_fragment,
      event_fragment_one,
      event_fragment_two
    )
  loop
    select pg_catalog.pg_get_triggerdef(trigger_row.oid)
    into v_definition
    from pg_catalog.pg_trigger trigger_row
    where trigger_row.tgrelid = pg_catalog.to_regclass(v_expected.relation_signature)
      and trigger_row.tgname = v_expected.trigger_name
      and trigger_row.tgfoid = pg_catalog.to_regprocedure(v_expected.function_signature)
      and not trigger_row.tgisinternal;

    if v_definition is null
       or pg_catalog.strpos(pg_catalog.lower(v_definition), v_expected.timing_fragment) = 0
       or pg_catalog.strpos(pg_catalog.lower(v_definition), v_expected.event_fragment_one) = 0
       or pg_catalog.strpos(pg_catalog.lower(v_definition), v_expected.event_fragment_two) = 0 then
      raise exception 'OVD-418 provider registry trigger drift: %', v_expected.trigger_name;
    end if;
  end loop;

  v_oid := pg_catalog.to_regprocedure(
    'private.resolve_quote_provider_admission_policy(text)'
  );
  if v_oid is null then
    raise exception 'OVD-418 private provider admission resolver is missing';
  end if;

  select pg_catalog.pg_get_functiondef(procedure_row.oid)
  into v_definition
  from pg_catalog.pg_proc procedure_row
  where procedure_row.oid = v_oid
    and procedure_row.prosecdef
    and pg_catalog.pg_get_userbyid(procedure_row.proowner) = 'postgres'
    and coalesce(procedure_row.proconfig, array[]::text[])
      @> array['search_path=pg_catalog']::text[];

  if v_definition is null
     or pg_catalog.strpos(pg_catalog.lower(v_definition), 'provider_unknown') = 0
     or pg_catalog.strpos(pg_catalog.lower(v_definition), 'generic_dispatch_enabled') = 0
     or pg_catalog.strpos(pg_catalog.lower(v_definition), 'controlled_beta_only') = 0 then
    raise exception 'OVD-418 provider admission resolver definition/security drifted';
  end if;
  v_provider_resolver_oid := v_oid;

  select pg_catalog.count(*) into v_count
  from pg_catalog.pg_enum enum_row
  join pg_catalog.pg_type type_row on type_row.oid = enum_row.enumtypid
  join pg_catalog.pg_namespace namespace_row on namespace_row.oid = type_row.typnamespace
  where namespace_row.nspname = 'public'
    and type_row.typname = 'vendor_name';
  if v_count <> 17 then
    raise exception 'OVD-418 expected 17 vendor enum values, found %', v_count;
  end if;

  select pg_catalog.count(*) into v_count
  from private.quote_provider_admission_policies;
  if v_count <> 17 then
    raise exception 'OVD-418 expected 17 provider admission seed rows, found %', v_count;
  end if;

  select pg_catalog.count(*) into v_count
  from (
    select enum_row.enumlabel
    from pg_catalog.pg_enum enum_row
    join pg_catalog.pg_type type_row on type_row.oid = enum_row.enumtypid
    join pg_catalog.pg_namespace namespace_row on namespace_row.oid = type_row.typnamespace
    where namespace_row.nspname = 'public'
      and type_row.typname = 'vendor_name'
    except
    select policy_row.provider::text
    from private.quote_provider_admission_policies policy_row
  ) as missing_policy;
  if v_count <> 0 then
    raise exception 'OVD-418 provider admission registry is missing % vendor policies', v_count;
  end if;

  select pg_catalog.count(*) into v_count
  from private.quote_provider_admission_policies
  where provider = 'xometry'::public.vendor_name
    and admission_state = 'controlled_beta_only'
    and not generic_dispatch_enabled
    and policy_revision = 'xometry-controlled-beta-2026-08-17.v1'
    and evidence_reference = 'OVD-373'
    and permission_basis = 'existing_controlled_beta_path'
    and supported_processes = array['cnc_milling']::public.process_types[]
    and accepted_file_extensions = array['step', 'stp']::text[]
    and session_owner = 'overdrafter_managed'
    and reviewed_at = timestamptz '2026-08-17 00:00:00+00'
    and change_reason = 'initial_seed';
  if v_count <> 1 then
    raise exception 'OVD-418 exact Xometry controlled-beta admission seed drifted';
  end if;

  select pg_catalog.count(*) into v_count
  from private.quote_provider_admission_policies
  where provider <> 'xometry'::public.vendor_name
    and admission_state = 'disabled'
    and not generic_dispatch_enabled;
  if v_count <> 16 then
    raise exception 'OVD-418 expected 16 disabled non-Xometry admission seeds, found %', v_count;
  end if;

  select pg_catalog.count(*) into v_count
  from private.quote_provider_admission_policies
  where generic_dispatch_enabled;
  if v_count <> 0 then
    raise exception 'OVD-418 provider registry unexpectedly enables % automatic vendors', v_count;
  end if;

  select pg_catalog.count(*) into v_count
  from private.quote_provider_admission_policy_history
  where change_kind = 'insert';
  if v_count <> 17 then
    raise exception 'OVD-418 expected 17 provider admission seed history rows, found %', v_count;
  end if;

  -- OVD-199: eMachineShop is a conservative manual-only source.
  select pg_catalog.count(*) into v_count
  from pg_catalog.pg_enum enum_row
  join pg_catalog.pg_type type_row on type_row.oid = enum_row.enumtypid
  join pg_catalog.pg_namespace namespace_row on namespace_row.oid = type_row.typnamespace
  where namespace_row.nspname = 'public'
    and type_row.typname = 'vendor_name'
    and enum_row.enumlabel = 'emachineshop';
  if v_count <> 1 then
    raise exception 'OVD-418 eMachineShop vendor enum value is missing';
  end if;

  select pg_catalog.count(*) into v_count
  from public.vendor_capability_profiles capability_row
  where capability_row.vendor_name = 'emachineshop'::public.vendor_name
    and capability_row.process_types = array['cnc_milling', 'cnc_turning']::public.process_types[]
    and capability_row.materials = array['aluminum']::text[]
    and capability_row.tolerance_min_mm is null
    and capability_row.tolerance_max_mm is null
    and capability_row.max_part_size_mm is null
    and capability_row.min_quantity = 1
    and capability_row.max_quantity is null
    and capability_row.geographic_region is null
    and capability_row.certifications = array[]::text[]
    and capability_row.quality_score is null
    and capability_row.lead_time_reliability is null
    and capability_row.cost_competitiveness is null
    and not capability_row.domestic_us
    and capability_row.updated_at = timestamptz '2026-08-21 00:00:00+00';
  if v_count <> 1 then
    raise exception 'OVD-418 eMachineShop conservative capability seed drifted';
  end if;

  select pg_catalog.count(*) into v_count
  from private.quote_provider_admission_policies policy_row
  where policy_row.provider = 'emachineshop'::public.vendor_name
    and policy_row.admission_state = 'disabled'
    and not policy_row.generic_dispatch_enabled
    and policy_row.policy_revision = 'emachineshop-manual-2026-08-21.v1'
    and policy_row.evidence_reference = 'OVD-199'
    and policy_row.permission_basis is null
    and policy_row.supported_processes = array[]::public.process_types[]
    and policy_row.accepted_file_extensions = array[]::text[]
    and policy_row.session_owner is null
    and policy_row.reviewed_at = timestamptz '2026-08-21 00:00:00+00'
    and policy_row.change_reason = 'initial_seed';
  if v_count <> 1 then
    raise exception 'OVD-418 eMachineShop manual-only admission seed drifted';
  end if;

  select pg_catalog.count(*) into v_count
  from pg_catalog.pg_attrdef default_row
  join pg_catalog.pg_attribute attribute_row
    on attribute_row.attrelid = default_row.adrelid
   and attribute_row.attnum = default_row.adnum
  where default_row.adrelid = 'public.quote_requests'::pg_catalog.regclass
    and attribute_row.attname = 'requested_vendors'
    and not attribute_row.attisdropped;
  if v_count <> 0 then
    raise exception 'OVD-418 quote_requests.requested_vendors unexpectedly retains a column default';
  end if;

  select pg_catalog.count(*)
  into v_count
  from pg_catalog.pg_trigger trigger_row
  where not trigger_row.tgisinternal
    and (
      (trigger_row.tgrelid = 'public.audit_events'::pg_catalog.regclass
        and trigger_row.tgname = 'align_manual_quote_request_audit_vendors'
        and trigger_row.tgfoid = pg_catalog.to_regprocedure(
          'private.align_manual_quote_request_audit_vendors()'
        ))
      or
      (trigger_row.tgrelid = 'public.quote_requests'::pg_catalog.regclass
        and trigger_row.tgname = 'default_manual_quote_request_vendors'
        and trigger_row.tgfoid = pg_catalog.to_regprocedure(
          'private.default_manual_quote_request_vendors()'
        ))
      or
      (trigger_row.tgrelid = 'public.vendor_quote_results'::pg_catalog.regclass
        and trigger_row.tgname = 'enforce_manual_quote_result_vendor'
        and trigger_row.tgfoid = pg_catalog.to_regprocedure(
          'private.enforce_manual_quote_result_vendor()'
        ))
    );
  if v_count <> 3 then
    raise exception 'OVD-418 expected all three manual-vendor consistency triggers, found %', v_count;
  end if;

  for v_expected in
    select *
    from (values
      (
        'private.default_manual_quote_request_vendors()'::text,
        'array[''emachineshop'']::public.vendor_name[]'::text,
        'array[''xometry'']::public.vendor_name[]'::text
      ),
      (
        'private.enforce_manual_quote_result_vendor()',
        'manual quote vendor does not match the requested vendor',
        'public.quote_requests'
      ),
      (
        'private.align_manual_quote_request_audit_vendors()',
        'job.manual_quote_requested',
        'requestedvendors'
      ),
      (
        'private.build_quote_request_submission_result(uuid,boolean,boolean,boolean,uuid,uuid,uuid,text,text,text,public.vendor_name[],public.quote_request_mode)',
        'array[''emachineshop'']::public.vendor_name[]',
        'p_quote_mode = ''manual''::public.quote_request_mode'
      )
    ) as expected_functions(signature, required_fragment_one, required_fragment_two)
  loop
    v_oid := pg_catalog.to_regprocedure(v_expected.signature);
    if v_oid is null then
      raise exception 'OVD-418 required manual-vendor function is missing: %', v_expected.signature;
    end if;

    select pg_catalog.pg_get_functiondef(procedure_row.oid)
    into v_definition
    from pg_catalog.pg_proc procedure_row
    where procedure_row.oid = v_oid
      and not procedure_row.prosecdef
      and pg_catalog.pg_get_userbyid(procedure_row.proowner) = 'postgres'
      and coalesce(procedure_row.proconfig, array[]::text[])
        @> array['search_path=pg_catalog']::text[];

    if v_definition is null
       or pg_catalog.strpos(
         pg_catalog.lower(v_definition),
         pg_catalog.lower(v_expected.required_fragment_one)
       ) = 0
       or pg_catalog.strpos(
         pg_catalog.lower(v_definition),
         pg_catalog.lower(v_expected.required_fragment_two)
       ) = 0 then
      raise exception 'OVD-418 manual-vendor function contract drift: %', v_expected.signature;
    end if;
  end loop;

  for v_expected in
    select *
    from (values
      ('public.get_enabled_client_quote_vendors(uuid)'::text),
      ('public.get_enabled_client_quote_vendors(uuid,uuid,uuid)'::text)
    ) as automatic_vendor_functions(signature)
  loop
    v_oid := pg_catalog.to_regprocedure(v_expected.signature);
    if v_oid is null then
      raise exception 'OVD-418 automatic-vendor resolver is missing: %', v_expected.signature;
    end if;
    select pg_catalog.pg_get_functiondef(v_oid) into v_definition;
    if pg_catalog.strpos(pg_catalog.lower(v_definition), 'emachineshop') <> 0 then
      raise exception
        'OVD-418 eMachineShop leaked into automatic-vendor resolver definition: %',
        v_expected.signature;
    end if;
  end loop;

  -- OVD-408: evidence-backed geographic origin is explicit, constrained, and
  -- propagated verbatim by the service-only reconciliation function.
  select pg_catalog.count(*) into v_count
  from pg_catalog.pg_attribute attribute_row
  where attribute_row.attrelid = 'public.vendor_quote_offers'::pg_catalog.regclass
    and attribute_row.attname = 'geographic_origin'
    and not attribute_row.attisdropped
    and attribute_row.attnotnull;
  if v_count <> 1 then
    raise exception 'OVD-418 required geographic_origin column is missing or nullable';
  end if;

  select pg_catalog.count(*) into v_count
  from pg_catalog.pg_attrdef default_row
  join pg_catalog.pg_attribute attribute_row
    on attribute_row.attrelid = default_row.adrelid
   and attribute_row.attnum = default_row.adnum
  where default_row.adrelid = 'public.vendor_quote_offers'::pg_catalog.regclass
    and attribute_row.attname = 'geographic_origin'
    and not attribute_row.attisdropped
    and pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid)
      = '''unknown''::text';
  if v_count <> 1 then
    raise exception 'OVD-418 geographic_origin default drifted from unknown';
  end if;

  select pg_catalog.count(*) into v_count
  from pg_catalog.pg_constraint constraint_row
  where constraint_row.conrelid = 'public.vendor_quote_offers'::pg_catalog.regclass
    and constraint_row.conname = 'vendor_quote_offers_geographic_origin_check'
    and pg_catalog.pg_get_constraintdef(constraint_row.oid)
      = 'CHECK ((geographic_origin = ANY (ARRAY[''domestic''::text, ''foreign''::text, ''unknown''::text])))';
  if v_count <> 1 then
    raise exception 'OVD-418 geographic_origin check constraint drifted';
  end if;

  select pg_catalog.count(*) into v_count
  from pg_catalog.pg_attribute attribute_row
  where attribute_row.attrelid = 'public.vendor_quote_offers'::pg_catalog.regclass
    and attribute_row.attname = 'geographic_origin'
    and not attribute_row.attisdropped
    and pg_catalog.col_description(attribute_row.attrelid, attribute_row.attnum)
      = 'Evidence-backed manufacturing origin. Unknown is required when provider provenance is absent or ambiguous; legacy sourcing text is never used to infer this value.';
  if v_count <> 1 then
    raise exception 'OVD-418 geographic_origin evidence-boundary comment drifted';
  end if;

  select pg_catalog.count(*) into v_count
  from public.vendor_quote_offers
  where geographic_origin is null;
  if v_count <> 0 then
    raise exception 'OVD-418 geographic_origin backfill left % null offers', v_count;
  end if;

  v_oid := pg_catalog.to_regprocedure(
    'public.reconcile_vendor_quote_offers(uuid,jsonb,jsonb)'
  );
  if v_oid is null then
    raise exception 'OVD-418 vendor quote offer reconciliation function is missing';
  end if;

  select pg_catalog.pg_get_functiondef(procedure_row.oid)
  into v_definition
  from pg_catalog.pg_proc procedure_row
  where procedure_row.oid = v_oid
    and procedure_row.prosecdef
    and pg_catalog.pg_get_userbyid(procedure_row.proowner) = 'postgres'
    and coalesce(procedure_row.proconfig, array[]::text[])
      @> array['search_path=pg_catalog']::text[];

  if v_definition is null
     or pg_catalog.strpos(pg_catalog.lower(v_definition), 'offer.geographic_origin') = 0
     or pg_catalog.strpos(pg_catalog.lower(v_definition), 'coalesce(offer.geographic_origin') <> 0
     or pg_catalog.strpos(
       pg_catalog.regexp_replace(pg_catalog.lower(v_definition), '\s+', '', 'g'),
       'geographic_origin=excluded.sourcing'
     ) <> 0 then
    raise exception 'OVD-418 vendor quote offer reconciliation definition/security drifted';
  end if;

  v_offer_reconciler_oid := v_oid;

  for v_expected in
    select *
    from (values
      (v_provider_resolver_oid, 'provider admission resolver'::text),
      (v_offer_reconciler_oid, 'vendor quote offer reconciliation'::text)
    ) as expected_functions(function_oid, function_label)
  loop
    select pg_catalog.count(*)
    into v_count
    from pg_catalog.pg_proc procedure_row
    cross join lateral pg_catalog.aclexplode(
      coalesce(
        procedure_row.proacl,
        pg_catalog.acldefault('f', procedure_row.proowner)
      )
    ) acl_row
    where procedure_row.oid = v_expected.function_oid
      and acl_row.grantee = 0
      and acl_row.privilege_type = 'EXECUTE';

    if v_count <> 0
       or not pg_catalog.has_function_privilege(
         'service_role',
         v_expected.function_oid,
         'execute'
       )
       or pg_catalog.has_function_privilege(
         'anon',
         v_expected.function_oid,
         'execute'
       )
       or pg_catalog.has_function_privilege(
         'authenticated',
         v_expected.function_oid,
         'execute'
       ) then
      raise exception 'OVD-418 % ACL drifted', v_expected.function_label;
    end if;
  end loop;
end;
$ovd418_postconditions$;

select pg_catalog.jsonb_build_object(
  'rollout_control_count',
    (select pg_catalog.count(*) from private.commercial_rollout_controls),
  'enabled_rollout_control_count',
    (select pg_catalog.count(*) from private.commercial_rollout_controls where enabled),
  'active_work_queue_count',
    (select pg_catalog.count(*) from public.work_queue where status::text = any (array['queued', 'running']::text[])),
  'active_quote_request_count',
    (select pg_catalog.count(*) from public.quote_requests where status::text = any (array['queued', 'requesting']::text[])),
  'active_quote_run_count',
    (select pg_catalog.count(*) from public.quote_runs where status::text = any (array['queued', 'running']::text[])),
  'active_vendor_quote_result_count',
    (select pg_catalog.count(*) from public.vendor_quote_results where status::text = any (array['queued', 'running']::text[])),
  'total_vendor_quote_offers',
    (select pg_catalog.count(*) from public.vendor_quote_offers),
  'unknown_geographic_origin_offer_count',
    (select pg_catalog.count(*) from public.vendor_quote_offers where geographic_origin = 'unknown')
) as ovd418_production_postconditions;

commit;
