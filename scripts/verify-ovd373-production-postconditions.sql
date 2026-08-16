-- OVD-373 hosted production post-push verification.
--
-- Read-only by construction: this script inspects the migration ledger,
-- PostgreSQL catalogs, aggregate founding-beta evidence counts, and the
-- commercial rollout control registry. It does not read customer content,
-- files, jobs, quotes, or provider rows and does not invoke application
-- functions.

begin read only;

do $ovd373$
declare
  v_count bigint;
  v_enabled_count bigint;
  v_expected_count bigint;
  v_head text;
  v_fingerprint text;
  v_oid oid;
  v_definition text;
  v_expected record;
begin
  select count(*), max(version::text)
  into v_count, v_head
  from supabase_migrations.schema_migrations;

  if v_count <> 99 or v_head <> '20260816015500' then
    raise exception
      'OVD-373 ledger mismatch: expected 99 migrations through 20260816015500, found % through %',
      v_count,
      coalesce(v_head, '<none>');
  end if;

  select
    count(*),
    pg_catalog.md5(
      pg_catalog.string_agg(
        version::text || ':' || pg_catalog.md5(pg_catalog.to_json(statements)::text),
        E'\n'
        order by version::text
      )
    )
  into v_count, v_fingerprint
  from supabase_migrations.schema_migrations
  where not (version::text = any (array[
    '20260330144838', '20260331000000', '20260331000001', '20260331010000',
    '20260402100000', '20260402120000', '20260403103000', '20260405103000',
    '20260406000000', '20260408120000', '20260408193000', '20260409000000',
    '20260514120000', '20260514120100', '20260725090000', '20260728190000',
    '20260731015300', '20260731015400', '20260815090000', '20260815093000',
    '20260815100000', '20260815184740', '20260816011204', '20260816015000',
    '20260816015500'
  ]));

  if v_count <> 74 or v_fingerprint <> '7aeeca99fe188de2b537f14dd9c068fa' then
    raise exception
      'OVD-373 original ledger drift: expected 74-entry fingerprint %, found % entries with fingerprint %',
      '7aeeca99fe188de2b537f14dd9c068fa',
      v_count,
      coalesce(v_fingerprint, '<none>');
  end if;

  with expected(version) as (
    values
      ('20260330144838'), ('20260331000000'), ('20260331000001'), ('20260331010000'),
      ('20260402100000'), ('20260402120000'), ('20260403103000'), ('20260405103000'),
      ('20260406000000'), ('20260408120000'), ('20260408193000'), ('20260409000000'),
      ('20260514120000'), ('20260514120100'), ('20260725090000'), ('20260728190000'),
      ('20260731015300'), ('20260731015400'), ('20260815090000'), ('20260815093000'),
      ('20260815100000'), ('20260815184740'), ('20260816011204'), ('20260816015000'),
      ('20260816015500')
  ), actual(version) as (
    select version::text
    from supabase_migrations.schema_migrations
    where version::text = any (array[
      '20260330144838', '20260331000000', '20260331000001', '20260331010000',
      '20260402100000', '20260402120000', '20260403103000', '20260405103000',
      '20260406000000', '20260408120000', '20260408193000', '20260409000000',
      '20260514120000', '20260514120100', '20260725090000', '20260728190000',
      '20260731015300', '20260731015400', '20260815090000', '20260815093000',
      '20260815100000', '20260815184740', '20260816011204', '20260816015000',
      '20260816015500'
    ]))
  )
  select count(*)
  into v_count
  from (
    (select * from expected except select * from actual)
    union all
    (select * from actual except select * from expected)
  ) as ledger_drift;

  if v_count <> 0 then
    raise exception 'OVD-373 expected migration version set drifted (% differences)', v_count;
  end if;

  -- Private evidence tables remain forced-RLS, policy-free, and unavailable to
  -- every API role.
  for v_expected in
    select *
    from (values
      ('private.founding_beta_enrollment_events'::text),
      ('private.founding_beta_notice_acceptances'::text),
      ('private.xometry_beta_dispatch_permits'::text)
    ) as expected_tables(signature)
  loop
    select c.oid
    into v_oid
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname || '.' || c.relname = v_expected.signature
      and c.relkind in ('r', 'p')
      and c.relrowsecurity
      and c.relforcerowsecurity;

    if v_oid is null then
      raise exception 'OVD-373 missing forced-RLS private table: %', v_expected.signature;
    end if;

    select count(*) into v_count
    from pg_catalog.pg_policy
    where polrelid = v_oid;

    if v_count <> 0 then
      raise exception 'OVD-373 private table % unexpectedly has % policies', v_expected.signature, v_count;
    end if;

    if has_table_privilege('anon', v_oid, 'select')
       or has_table_privilege('anon', v_oid, 'insert')
       or has_table_privilege('anon', v_oid, 'update')
       or has_table_privilege('anon', v_oid, 'delete')
       or has_table_privilege('authenticated', v_oid, 'select')
       or has_table_privilege('authenticated', v_oid, 'insert')
       or has_table_privilege('authenticated', v_oid, 'update')
       or has_table_privilege('authenticated', v_oid, 'delete')
       or has_table_privilege('service_role', v_oid, 'select')
       or has_table_privilege('service_role', v_oid, 'insert')
       or has_table_privilege('service_role', v_oid, 'update')
       or has_table_privilege('service_role', v_oid, 'delete') then
      raise exception 'OVD-373 private table % is directly available to an API role', v_expected.signature;
    end if;
  end loop;

  select count(*)
  into v_count
  from pg_catalog.pg_trigger t
  join pg_catalog.pg_class c on c.oid = t.tgrelid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where not t.tgisinternal
    and n.nspname = 'private'
    and c.relname in (
      'founding_beta_enrollment_events',
      'founding_beta_notice_acceptances',
      'xometry_beta_dispatch_permits'
    )
    and pg_catalog.pg_get_triggerdef(t.oid) ilike '%before update or delete%'
    and pg_catalog.pg_get_triggerdef(t.oid) ilike '%reject_founding_beta_evidence_mutation%';

  if v_count <> 3 then
    raise exception 'OVD-373 expected three append-only founding-beta evidence triggers, found %', v_count;
  end if;

  select
    (select count(*) from private.founding_beta_enrollment_events)
    + (select count(*) from private.founding_beta_notice_acceptances)
    + (select count(*) from private.xometry_beta_dispatch_permits)
  into v_count;

  if v_count <> 0 then
    raise exception
      'OVD-373 founding-beta default-off check failed: found % evidence rows',
      v_count;
  end if;

  for v_expected in
    select *
    from (values
      ('private.founding_beta_enrollment_events_id_seq'::text),
      ('private.founding_beta_notice_acceptances_id_seq'::text)
    ) as expected_sequences(signature)
  loop
    v_oid := pg_catalog.to_regclass(v_expected.signature);
    if v_oid is null
       or has_sequence_privilege('anon', v_oid, 'usage')
       or has_sequence_privilege('anon', v_oid, 'select')
       or has_sequence_privilege('anon', v_oid, 'update')
       or has_sequence_privilege('authenticated', v_oid, 'usage')
       or has_sequence_privilege('authenticated', v_oid, 'select')
       or has_sequence_privilege('authenticated', v_oid, 'update')
       or has_sequence_privilege('service_role', v_oid, 'usage')
       or has_sequence_privilege('service_role', v_oid, 'select')
       or has_sequence_privilege('service_role', v_oid, 'update') then
      raise exception 'OVD-373 founding-beta evidence sequence is missing or exposed: %', v_expected.signature;
    end if;
  end loop;

  -- Function contracts are inspected, never executed. expected_service may be
  -- null where the contract intentionally does not constrain service_role.
  for v_expected in
    select *
    from (values
      ('private.reject_founding_beta_evidence_mutation()', false, false, false, 'search_path=pg_catalog', 'append-only', 'raise exception'),
      ('private.current_founding_beta_notice()', false, false, false, 'search_path=pg_catalog', 'founding-beta-2026-08-15', '/legal/beta-terms'),
      ('private.resolve_founding_beta_access_state(uuid,uuid)', false, false, true, 'search_path=pg_catalog', 'not_enrolled', 'current_founding_beta_notice'),
      ('public.current_user_has_current_founding_beta_access(uuid)', true, null::boolean, true, 'search_path=pg_catalog', 'resolve_founding_beta_access_state', 'eligible'),
      ('public.api_get_founding_beta_access_state(uuid)', true, null::boolean, true, 'search_path=pg_catalog', 'resolve_founding_beta_access_state', 'organization_id'),
      ('public.api_accept_founding_beta_notice(uuid,text)', true, null::boolean, true, 'search_path=pg_catalog', 'founding_beta_notice_acceptances', 'current_founding_beta_notice'),
      ('public.api_admin_set_founding_beta_enrollment(uuid,boolean,text,text)', true, null::boolean, true, 'search_path=pg_catalog', 'is_platform_admin', 'current_user_has_aal2'),
      ('public.api_admin_get_founding_beta_enrollment(uuid)', true, null::boolean, true, 'search_path=pg_catalog', 'is_platform_admin', 'current_founding_beta_notice'),
      ('public.api_create_job(uuid,text,text,text,text[],text[],text,text,integer[],date)', true, null::boolean, true, 'search_path=public', 'current_user_has_current_founding_beta_access', 'require_verified_auth'),
      ('private.require_current_founding_beta_file_access(uuid,text)', false, null::boolean, true, 'search_path=private, public, pg_catalog', 'resolve_founding_beta_access_state', 'founding_beta_'),
      ('public.api_prepare_job_file_upload(uuid,text,public.job_file_kind,text,bigint,text)', true, null::boolean, true, 'search_path=public', 'require_current_founding_beta_file_access', 'job-files'),
      ('public.api_finalize_job_file_upload(uuid,text,text,text,public.job_file_kind,text,bigint,text)', true, null::boolean, true, 'search_path=public', 'require_current_founding_beta_file_access', 'storage.objects'),
      ('public.api_attach_job_file(uuid,text,text,text,public.job_file_kind,text,bigint)', true, null::boolean, true, 'search_path=public', 'require_current_founding_beta_file_access', 'legacy_file_attach_unavailable'),
      ('private.resolve_xometry_beta_dispatch_scope(uuid,text)', false, false, true, 'search_path=pg_catalog', 'current_founding_beta_notice', 'resolve_founding_beta_access_state'),
      ('public.api_get_xometry_beta_dispatch_scope(uuid,text)', true, false, true, 'search_path=pg_catalog', 'resolve_xometry_beta_dispatch_scope', 'select'),
      ('public.api_request_xometry_beta_dispatch(uuid,text,text,text,uuid,boolean,boolean,boolean)', true, false, true, 'search_path=pg_catalog', 'xometry_beta_dispatch_permits', 'scope_fingerprint'),
      ('public.api_authorize_xometry_beta_worker_dispatch(uuid,uuid,jsonb,text,timestamptz)', false, true, true, 'search_path=pg_catalog', 'resolve_organization_entitlements_at', 'automatic_quote_rollout_enabled_with_lock'),
      ('public.api_admin_list_manual_quote_requests(text,integer)', true, false, true, 'search_path=pg_catalog', 'current_user_has_commercial_capability', 'billing_admin'),
      ('public.api_admin_complete_manual_quote_request(uuid,uuid,uuid,uuid,public.vendor_name,text,text,public.vendor_status,text,text,text,jsonb,jsonb)', true, false, true, 'search_path=pg_catalog', 'require_commercial_admin_capability', 'billing_admin'),
      ('public.evaluate_extraction_quality_alerts(date)', false, true, true, 'search_path=pg_catalog', 'extraction_quality_alerts', 'model_fallback_rate')
    ) as expected_functions(
      signature,
      expected_authenticated,
      expected_service,
      expected_security_definer,
      expected_config,
      required_fragment_one,
      required_fragment_two
    )
  loop
    v_oid := pg_catalog.to_regprocedure(v_expected.signature);

    if v_oid is null then
      raise exception 'OVD-373 required function is missing: %', v_expected.signature;
    end if;

    select pg_catalog.pg_get_functiondef(p.oid)
    into v_definition
    from pg_catalog.pg_proc p
    where p.oid = v_oid
      and p.prosecdef = v_expected.expected_security_definer
      and pg_catalog.pg_get_userbyid(p.proowner) = 'postgres'
      and coalesce(p.proconfig, array[]::text[]) @> array[v_expected.expected_config];

    if v_definition is null then
      raise exception 'OVD-373 function security/config drift: %', v_expected.signature;
    end if;

    if has_function_privilege('anon', v_oid, 'execute')
       or has_function_privilege('authenticated', v_oid, 'execute') <> v_expected.expected_authenticated
       or (
         v_expected.expected_service is not null
         and has_function_privilege('service_role', v_oid, 'execute') <> v_expected.expected_service
       ) then
      raise exception 'OVD-373 function ACL drift: %', v_expected.signature;
    end if;

    if position(lower(v_expected.required_fragment_one) in lower(v_definition)) = 0
       or position(lower(v_expected.required_fragment_two) in lower(v_definition)) = 0 then
      raise exception 'OVD-373 function body contract drift: %', v_expected.signature;
    end if;
  end loop;

  -- Legacy create overloads must remain absent; otherwise callers could evade
  -- the canonical beta-gated create path.
  for v_expected in
    select *
    from (values
      ('public.api_create_job(uuid,text,text,text)'::text),
      ('public.api_create_job(uuid,text,text,text,text[])'::text),
      ('public.api_create_job(uuid,text,text,text,text[],integer[],date)'::text),
      ('public.api_create_client_draft(text,text,uuid,text[])'::text),
      ('public.api_create_client_draft(text,text,uuid,text[],integer[],date)'::text)
    ) as forbidden_functions(signature)
  loop
    if pg_catalog.to_regprocedure(v_expected.signature) is not null then
      raise exception 'OVD-373 forbidden legacy create overload remains: %', v_expected.signature;
    end if;
  end loop;

  v_oid := pg_catalog.to_regprocedure(
    'public.api_create_client_draft(text,text,uuid,text[],text[],text,text,integer[],date)'
  );
  if v_oid is null
     or has_function_privilege('anon', v_oid, 'execute')
     or not has_function_privilege('authenticated', v_oid, 'execute') then
    raise exception 'OVD-373 canonical client draft API is missing or has unsafe ACLs';
  end if;

  select pg_catalog.pg_get_functiondef(v_oid) into v_definition;
  if position('api_create_job' in lower(v_definition)) = 0 then
    raise exception 'OVD-373 canonical client draft API no longer delegates to the gated create path';
  end if;

  -- Creation, upload, and storage policies must all retain the beta boundary.
  select count(*) into v_count
  from pg_catalog.pg_policies
  where schemaname = 'public'
    and tablename = 'jobs'
    and policyname = 'jobs_insert_members'
    and cmd = 'INSERT'
    and with_check ilike '%user_can_access_org%'
    and with_check ilike '%current_user_has_current_founding_beta_access%';
  if v_count <> 1 then
    raise exception 'OVD-373 jobs_insert_members beta boundary is missing';
  end if;

  if has_table_privilege('authenticated', 'public.job_files', 'insert') then
    raise exception 'OVD-373 authenticated regained direct job_files insert';
  end if;

  select count(*) into v_count
  from pg_catalog.pg_policies
  where schemaname = 'public'
    and tablename = 'job_files'
    and policyname = 'job_files_insert_members';
  if v_count <> 0 then
    raise exception 'OVD-373 legacy job_files insert policy remains';
  end if;

  select count(*) into v_count
  from pg_catalog.pg_policies
  where schemaname = 'storage'
    and tablename = 'objects'
    and policyname = 'job_files_storage_insert'
    and cmd = 'INSERT'
    and roles::text[] = array['authenticated']::text[]
    and with_check ilike '%bucket_id%job-files%'
    and with_check ilike '%current_user_has_current_founding_beta_access%';
  if v_count <> 1 then
    raise exception 'OVD-373 job-files storage insert boundary drifted';
  end if;

  select count(*) into v_count
  from pg_catalog.pg_policies
  where schemaname = 'storage'
    and tablename = 'objects'
    and policyname = 'quote_artifacts_storage_read_drawing_previews'
    and cmd = 'SELECT'
    and roles::text[] = array['authenticated']::text[]
    and qual ilike '%bucket_id%quote-artifacts%'
    and qual ilike '%storage_path%objects.name%'
    and qual ilike '%storage_bucket%objects.bucket_id%'
    and qual ilike '%user_can_access_job%';
  if v_count <> 1 then
    raise exception 'OVD-373 drawing-preview storage bucket binding drifted';
  end if;

  -- Compatibility request paths remain explicit no-dispatch gates.
  for v_expected in
    select *
    from (values
      ('public.api_request_quote_scoped(uuid,public.vendor_name[])'::text),
      ('public.api_request_quote(uuid,boolean)'::text),
      ('public.api_request_quotes(uuid[],boolean)'::text)
    ) as compatibility_functions(signature)
  loop
    v_oid := pg_catalog.to_regprocedure(v_expected.signature);
    if v_oid is null then
      raise exception 'OVD-373 quote request compatibility gate is missing: %', v_expected.signature;
    end if;
    select pg_catalog.pg_get_functiondef(p.oid)
    into v_definition
    from pg_catalog.pg_proc p
    where p.oid = v_oid
      and p.prosecdef
      and coalesce(p.proconfig, array[]::text[]) @> array['search_path=pg_catalog']::text[];
    if v_definition is null
       or not has_function_privilege('authenticated', v_oid, 'execute')
       or has_function_privilege('anon', v_oid, 'execute')
       or has_function_privilege('service_role', v_oid, 'execute')
       or position('xometry_beta_confirmation_required' in lower(v_definition)) = 0 then
      raise exception 'OVD-373 quote request compatibility gate drifted: %', v_expected.signature;
    end if;
  end loop;

  v_oid := pg_catalog.to_regprocedure(
    'public.api_enqueue_debug_vendor_quote(uuid,uuid,public.vendor_name,integer)'
  );
  if v_oid is null then
    raise exception 'OVD-373 debug enqueue compatibility gate is missing';
  end if;
  select pg_catalog.pg_get_functiondef(p.oid)
  into v_definition
  from pg_catalog.pg_proc p
  where p.oid = v_oid
    and p.prosecdef
    and coalesce(p.proconfig, array[]::text[]) @> array['search_path=pg_catalog']::text[];
  if v_definition is null
     or not has_function_privilege('authenticated', v_oid, 'execute')
     or has_function_privilege('anon', v_oid, 'execute')
     or has_function_privilege('service_role', v_oid, 'execute')
     or position('dispatch_confirmation_required' in lower(v_definition)) = 0 then
    raise exception 'OVD-373 debug enqueue compatibility gate can no longer be proven inert';
  end if;

  v_oid := pg_catalog.to_regprocedure(
    'public.api_authorize_xometry_beta_worker_dispatch(uuid,uuid,jsonb,text,timestamptz)'
  );
  select pg_catalog.pg_get_functiondef(v_oid) into v_definition;
  if position('private.current_founding_beta_notice' in lower(v_definition)) = 0
     or position('private.resolve_founding_beta_access_state' in lower(v_definition)) = 0
     or position('public.org_vendor_configs' in lower(v_definition)) = 0
     or position('get_enabled_client_quote_vendors' in lower(v_definition)) = 0
     or position('quote_scope_fingerprint' in lower(v_definition)) = 0 then
    raise exception 'OVD-373 worker dispatch preflight lost a current authorization boundary';
  end if;

  -- Final reconciliation repairs must remain present after the deferred
  -- history is replayed. These checks inspect source text only.
  v_oid := pg_catalog.to_regprocedure('private.request_automatic_quote_impl(uuid,boolean)');
  if v_oid is null then
    raise exception 'OVD-373 automatic quote implementation is missing';
  end if;
  select pg_catalog.pg_get_functiondef(v_oid) into v_definition;
  if position('v_service_request_line_item_id uuid;' in v_definition) = 0
     or position('returning id into v_service_request_line_item_id;' in v_definition) = 0
     or position('''serviceRequestLineItemId'', v_service_request_line_item_id' in v_definition) = 0 then
    raise exception 'OVD-373 automatic quote service-request lineage repair drifted';
  end if;

  v_oid := pg_catalog.to_regprocedure('public.api_list_client_quote_workspace(uuid[])');
  if v_oid is null then
    raise exception 'OVD-373 client quote workspace API is missing';
  end if;
  select pg_catalog.pg_get_functiondef(v_oid) into v_definition;
  if position('manufacturing_quote_line_items as (' in v_definition) = 0
     or position('- ''request_status''' in v_definition) = 0
     or position('- ''request_service_request_line_item_id''' in v_definition) = 0
     or position('- ''canonical_service_request_line_item_id''' in v_definition) = 0
     or position('else to_jsonb(offer)' in lower(v_definition)) > 0 then
    raise exception 'OVD-373 client quote workspace helper-column repair drifted';
  end if;

  -- Deferred foundations remain access-controlled and non-activating. Only
  -- their catalogs are inspected; seed/customer rows are intentionally not.
  select c.oid
  into v_oid
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = 'vendor_routing_scores'
    and c.relkind in ('r', 'p')
    and c.relrowsecurity;
  if v_oid is null
     or not has_table_privilege('authenticated', v_oid, 'select')
     or has_table_privilege('anon', v_oid, 'select') then
    raise exception 'OVD-373 vendor routing score access contract drifted';
  end if;

  select count(*) into v_count
  from pg_catalog.pg_policy p
  where p.polrelid = v_oid
    and (select r.oid from pg_catalog.pg_roles r where r.rolname = 'authenticated') = any(p.polroles)
    and pg_catalog.pg_get_expr(p.polqual, p.polrelid) like '%is_internal_user(organization_id)%';
  if v_count <> 2 then
    raise exception 'OVD-373 vendor routing scores lost their two internal-user policies';
  end if;

  select count(*) into v_count
  from pg_catalog.pg_policy
  where polrelid = v_oid;
  if v_count <> 2 then
    raise exception 'OVD-373 vendor routing scores expose an unexpected RLS policy';
  end if;

  select count(*) into v_count
  from pg_catalog.pg_enum e
  join pg_catalog.pg_type t on t.oid = e.enumtypid
  join pg_catalog.pg_namespace n on n.oid = t.typnamespace
  where n.nspname = 'public'
    and t.typname = 'vendor_name'
    and e.enumlabel = any (array[
      'oshcut', 'fabworks', 'ponoko', 'quickparts',
      'rapiddirect', 'geomiq', 'weerg', 'protolabsnetwork'
    ]);
  if v_count <> 8 then
    raise exception 'OVD-373 hidden live-quote candidate enum foundation drifted';
  end if;

  v_oid := pg_catalog.to_regprocedure('public.get_enabled_client_quote_vendors(uuid)');
  if v_oid is null then
    raise exception 'OVD-373 client vendor fallback function is missing';
  end if;
  select pg_catalog.pg_get_functiondef(v_oid) into v_definition;
  if position('array[''xometry'', ''fictiv'', ''protolabs'']' in lower(v_definition)) = 0
     or position('''oshcut''' in lower(v_definition)) > 0
     or position('''protolabsnetwork''' in lower(v_definition)) > 0 then
    raise exception 'OVD-373 hidden live-quote candidates became active in the fallback';
  end if;

  select c.oid
  into v_oid
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = 'payments'
    and c.relkind in ('r', 'p')
    and c.relrowsecurity;
  if v_oid is null
     or not has_table_privilege('service_role', v_oid, 'select')
     or not has_table_privilege('service_role', v_oid, 'insert')
     or not has_table_privilege('service_role', v_oid, 'update')
     or not has_table_privilege('service_role', v_oid, 'delete')
     or has_table_privilege('anon', v_oid, 'select')
     or has_table_privilege('authenticated', v_oid, 'select') then
    raise exception 'OVD-373 payments service-only table contract drifted';
  end if;

  select count(*) into v_count
  from pg_catalog.pg_policy p
  where p.polrelid = v_oid
    and p.polcmd = '*'
    and (select r.oid from pg_catalog.pg_roles r where r.rolname = 'service_role') = any(p.polroles)
    and pg_catalog.pg_get_expr(p.polqual, p.polrelid) = 'true'
    and pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) = 'true';
  if v_count <> 1 then
    raise exception 'OVD-373 payments service-role RLS policy drifted';
  end if;

  select count(*) into v_count
  from pg_catalog.pg_policy
  where polrelid = v_oid;
  if v_count <> 1 then
    raise exception 'OVD-373 payments expose a non-service RLS policy';
  end if;

  select count(*) into v_count
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname::text = any (array[
      'supplier_companies', 'supplier_sources', 'supplier_source_records',
      'supplier_company_aliases', 'supplier_facilities', 'supplier_capabilities',
      'supplier_certifications', 'supplier_facility_capability_claims',
      'supplier_facility_certification_claims', 'supplier_verification_events'
    ])
    and c.relrowsecurity
    and not has_table_privilege('anon', c.oid, 'select')
    and has_table_privilege('authenticated', c.oid, 'select')
    and has_table_privilege('authenticated', c.oid, 'insert')
    and has_table_privilege('authenticated', c.oid, 'update')
    and has_table_privilege('authenticated', c.oid, 'delete');
  if v_count <> 10 then
    raise exception 'OVD-373 supplier directory RLS/ACL foundation drifted';
  end if;

  select count(*) into v_count
  from pg_catalog.pg_policy p
  join pg_catalog.pg_class c on c.oid = p.polrelid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname like 'supplier_%'
    and (
      0::oid = any(p.polroles)
      or (select r.oid from pg_catalog.pg_roles r where r.rolname = 'anon') = any(p.polroles)
    );
  if v_count <> 0 then
    raise exception 'OVD-373 supplier directory exposes an anonymous or PUBLIC policy';
  end if;

  select count(*) into v_count
  from pg_catalog.pg_constraint constraint_row
  join pg_catalog.pg_class source_relation on source_relation.oid = constraint_row.conrelid
  join pg_catalog.pg_class target_relation on target_relation.oid = constraint_row.confrelid
  join pg_catalog.pg_namespace target_namespace on target_namespace.oid = target_relation.relnamespace
  where constraint_row.contype = 'f'
    and source_relation.relname::text = any (array[
      'quote_runs', 'vendor_quote_results', 'org_vendor_configs', 'work_queue'
    ])
    and target_namespace.nspname = 'public'
    and target_relation.relname like 'supplier_%';
  if v_count <> 0 then
    raise exception 'OVD-373 supplier directory became bound to quote execution';
  end if;

  select count(*) into v_count
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'private'
    and c.relname::text = any (array[
      'mobile_auth_transactions',
      'mobile_auth_rate_limit_counters',
      'mobile_auth_audit_events'
    ])
    and c.relrowsecurity
    and c.relforcerowsecurity
    and not has_table_privilege('anon', c.oid, 'select')
    and not has_table_privilege('authenticated', c.oid, 'select')
    and not has_table_privilege('service_role', c.oid, 'select');
  if v_count <> 3 then
    raise exception 'OVD-373 mobile-auth private table isolation drifted';
  end if;

  select count(*) into v_count
  from pg_catalog.pg_policy p
  join pg_catalog.pg_class c on c.oid = p.polrelid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'private'
    and c.relname like 'mobile_auth_%';
  if v_count <> 0 then
    raise exception 'OVD-373 mobile-auth private tables unexpectedly have RLS policies';
  end if;

  select count(*) into v_count
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname like 'api_mobile_auth_%'
    and p.prosecdef
    and coalesce(p.proconfig, array[]::text[]) @> array['search_path=""']::text[]
    and has_function_privilege('service_role', p.oid, 'execute')
    and not has_function_privilege('anon', p.oid, 'execute')
    and not has_function_privilege('authenticated', p.oid, 'execute');
  if v_count <> 10 then
    raise exception 'OVD-373 mobile-auth service-only RPC contract drifted';
  end if;

  -- Deferred extraction-quality foundation: authenticated may inspect alerts,
  -- but only service_role may execute the evaluator.
  select count(*) into v_count
  from pg_catalog.pg_policies
  where schemaname = 'public'
    and tablename = 'extraction_quality_alerts'
    and policyname = 'extraction_quality_alerts_internal_select'
    and cmd = 'SELECT'
    and roles::text[] = array['authenticated']::text[];
  if v_count <> 1 then
    raise exception 'OVD-373 extraction-quality alert RLS policy drifted';
  end if;

  select c.oid
  into v_oid
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = 'extraction_quality_alerts'
    and c.relkind in ('r', 'p')
    and c.relrowsecurity;
  if v_oid is null then
    raise exception 'OVD-373 extraction-quality alerts table is missing RLS';
  end if;

  select count(*) into v_count
  from pg_catalog.pg_policy
  where polrelid = v_oid;
  if v_count <> 1 then
    raise exception 'OVD-373 extraction-quality alerts expose an unexpected RLS policy';
  end if;

  if not has_table_privilege('authenticated', v_oid, 'select')
     or has_table_privilege('anon', v_oid, 'select')
     or has_table_privilege('authenticated', v_oid, 'insert')
     or has_table_privilege('authenticated', v_oid, 'update')
     or has_table_privilege('authenticated', v_oid, 'delete') then
    raise exception 'OVD-373 extraction-quality alert authenticated grants drifted';
  end if;

  -- The registry is the only non-catalog application relation read here.
  -- Every commercial capability must remain explicitly disabled after push.
  select
    count(*),
    count(*) filter (where enabled),
    count(*) filter (where capability = any (array[
      'automatic_quote_collection',
      'commercial_admin_mutations',
      'order_administration',
      'promotion_codes'
    ]))
  into v_count, v_enabled_count, v_expected_count
  from private.commercial_rollout_controls;

  if v_count <> 4 or v_expected_count <> 4 or v_enabled_count <> 0 then
    raise exception
      'OVD-373 commercial controls are not fail-closed: % total, % recognized, % enabled',
      v_count,
      v_expected_count,
      v_enabled_count;
  end if;
end;
$ovd373$;

select 'OVD-373 production postconditions passed.' as result;

commit;
