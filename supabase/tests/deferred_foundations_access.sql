begin;

create extension if not exists pgtap with schema extensions;

select plan(39);

-- Final compatibility behavior for the retired direct debug enqueue path.
select ok(
  pg_catalog.to_regprocedure(
    'public.api_enqueue_debug_vendor_quote(uuid,uuid,public.vendor_name,integer)'
  ) is not null,
  'the final debug enqueue compatibility RPC exists'
);

select ok(
  has_function_privilege(
    'authenticated',
    'public.api_enqueue_debug_vendor_quote(uuid,uuid,public.vendor_name,integer)',
    'execute'
  )
  and not has_function_privilege(
    'anon',
    'public.api_enqueue_debug_vendor_quote(uuid,uuid,public.vendor_name,integer)',
    'execute'
  )
  and not has_function_privilege(
    'service_role',
    'public.api_enqueue_debug_vendor_quote(uuid,uuid,public.vendor_name,integer)',
    'execute'
  ),
  'only authenticated callers can invoke the guarded debug compatibility RPC'
);

select ok(
  not exists (
    select 1
    from pg_catalog.pg_proc procedure_row
    cross join lateral pg_catalog.aclexplode(
      coalesce(
        procedure_row.proacl,
        pg_catalog.acldefault('f', procedure_row.proowner)
      )
    ) acl_row
    where procedure_row.oid =
      'public.api_enqueue_debug_vendor_quote(uuid,uuid,public.vendor_name,integer)'::regprocedure
      and acl_row.grantee = 0
      and acl_row.privilege_type = 'EXECUTE'
  ),
  'PUBLIC has no execute privilege on the debug compatibility RPC'
);

select ok(
  position(
    'insert into public.work_queue' in lower(
      (
        select procedure_row.prosrc
        from pg_catalog.pg_proc procedure_row
        where procedure_row.oid =
          'public.api_enqueue_debug_vendor_quote(uuid,uuid,public.vendor_name,integer)'::regprocedure
      )
    )
  ) = 0
  and position(
    'dispatch_confirmation_required' in (
      select procedure_row.prosrc
      from pg_catalog.pg_proc procedure_row
      where procedure_row.oid =
        'public.api_enqueue_debug_vendor_quote(uuid,uuid,public.vendor_name,integer)'::regprocedure
    )
  ) > 0,
  'the debug compatibility RPC is a no-enqueue confirmation gate'
);

-- Vendor routing scores remain internal-user data behind RLS.
select ok(
  (
    select relation.relrowsecurity
    from pg_class relation
    where relation.oid = 'public.vendor_routing_scores'::regclass
  ),
  'vendor routing scores enable RLS'
);

select is(
  (
    select count(*)::integer
    from pg_policy policy_row
    where policy_row.polrelid = 'public.vendor_routing_scores'::regclass
      and (
        select role_row.oid
        from pg_roles role_row
        where role_row.rolname = 'authenticated'
      ) = any(policy_row.polroles)
      and pg_get_expr(
        policy_row.polqual,
        policy_row.polrelid
      ) like '%is_internal_user(organization_id)%'
  ),
  2,
  'both routing-score policies are scoped to authenticated internal users'
);

select ok(
  has_table_privilege(
    'authenticated',
    'public.vendor_routing_scores',
    'select'
  ),
  'authenticated users have the table privilege required for RLS-filtered score reads'
);

select is(
  (
    select count(*)::integer
    from pg_policy policy_row
    where policy_row.polrelid = 'public.vendor_routing_scores'::regclass
      and (
        select role_row.oid
        from pg_roles role_row
        where role_row.rolname = 'anon'
      ) = any(policy_row.polroles)
  ),
  0,
  'vendor routing scores expose no anonymous RLS policy'
);

-- Extraction alerts are internal-user data, and evaluation is server-only.
select ok(
  (
    select relation.relrowsecurity
    from pg_class relation
    where relation.oid = 'public.extraction_quality_alerts'::regclass
  ),
  'extraction quality alerts enable RLS'
);

select is(
  (
    select count(*)::integer
    from pg_policy policy_row
    where policy_row.polrelid = 'public.extraction_quality_alerts'::regclass
      and (
        select role_row.oid
        from pg_roles role_row
        where role_row.rolname = 'authenticated'
      ) = any(policy_row.polroles)
      and pg_get_expr(
        policy_row.polqual,
        policy_row.polrelid
      ) like '%is_internal_user(organization_id)%'
  ),
  2,
  'both extraction-alert policies are scoped to authenticated internal users'
);

select ok(
  has_table_privilege(
    'authenticated',
    'public.extraction_quality_alerts',
    'select'
  ),
  'authenticated users have the table privilege required for RLS-filtered alert reads'
);

select is(
  (
    select count(*)::integer
    from pg_policy policy_row
    where policy_row.polrelid = 'public.extraction_quality_alerts'::regclass
      and (
        select role_row.oid
        from pg_roles role_row
        where role_row.rolname = 'anon'
      ) = any(policy_row.polroles)
  ),
  0,
  'extraction quality alerts expose no anonymous RLS policy'
);

select ok(
  (
    select procedure_row.prosecdef
    from pg_proc procedure_row
    where procedure_row.oid =
      'public.evaluate_extraction_quality_alerts(date)'::regprocedure
  ),
  'extraction quality evaluation is a security-definer operation'
);

select ok(
  not exists (
    select 1
    from pg_catalog.pg_proc procedure_row
    cross join lateral pg_catalog.aclexplode(
      coalesce(
        procedure_row.proacl,
        pg_catalog.acldefault('f', procedure_row.proowner)
      )
    ) acl_row
    where procedure_row.oid =
      'public.evaluate_extraction_quality_alerts(date)'::regprocedure
      and acl_row.grantee = 0
      and acl_row.privilege_type = 'EXECUTE'
  ),
  'PUBLIC cannot execute extraction quality evaluation'
);

select ok(
  not has_function_privilege(
    'anon',
    'public.evaluate_extraction_quality_alerts(date)',
    'execute'
  )
  and not has_function_privilege(
    'authenticated',
    'public.evaluate_extraction_quality_alerts(date)',
    'execute'
  ),
  'client roles cannot execute extraction quality evaluation'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.evaluate_extraction_quality_alerts(date)',
    'execute'
  ),
  'service_role can execute extraction quality evaluation'
);

-- Payment lifecycle state is service-only behind RLS.
select ok(
  (
    select relation.relrowsecurity
    from pg_class relation
    where relation.oid = 'public.payments'::regclass
  ),
  'payments enable RLS'
);

select is(
  (
    select count(*)::integer
    from pg_policy policy_row
    where policy_row.polrelid = 'public.payments'::regclass
      and policy_row.polcmd = '*'
      and (
        select role_row.oid
        from pg_roles role_row
        where role_row.rolname = 'service_role'
      ) = any(policy_row.polroles)
      and pg_get_expr(policy_row.polqual, policy_row.polrelid) = 'true'
      and pg_get_expr(policy_row.polwithcheck, policy_row.polrelid) = 'true'
  ),
  1,
  'payments have one full-access service-role policy'
);

select is(
  (
    select count(*)::integer
    from pg_policy policy_row
    where policy_row.polrelid = 'public.payments'::regclass
      and (
        (
          select role_row.oid
          from pg_roles role_row
          where role_row.rolname = 'anon'
        ) = any(policy_row.polroles)
        or (
          select role_row.oid
          from pg_roles role_row
          where role_row.rolname = 'authenticated'
        ) = any(policy_row.polroles)
        or 0::oid = any(policy_row.polroles)
      )
  ),
  0,
  'payments expose no client or PUBLIC RLS policy'
);

select ok(
  has_table_privilege('service_role', 'public.payments', 'select')
  and has_table_privilege('service_role', 'public.payments', 'insert')
  and has_table_privilege('service_role', 'public.payments', 'update')
  and has_table_privilege('service_role', 'public.payments', 'delete'),
  'service_role has the table privileges needed to manage payments'
);

-- Hidden live-quote candidates are seeded but not in the fallback vendor set.
select is(
  (
    select count(*)::integer
    from pg_enum enum_row
    join pg_type type_row on type_row.oid = enum_row.enumtypid
    join pg_namespace namespace_row on namespace_row.oid = type_row.typnamespace
    where namespace_row.nspname = 'public'
      and type_row.typname = 'vendor_name'
      and enum_row.enumlabel = any(array[
        'oshcut',
        'fabworks',
        'ponoko',
        'quickparts',
        'rapiddirect',
        'geomiq',
        'weerg',
        'protolabsnetwork'
      ])
  ),
  8,
  'all hidden live-quote candidate enum values exist'
);

select is(
  (
    select count(*)::integer
    from public.vendor_capability_profiles profile
    where profile.vendor_name::text = any(array[
      'oshcut',
      'fabworks',
      'ponoko',
      'quickparts',
      'rapiddirect',
      'geomiq',
      'weerg',
      'protolabsnetwork'
    ])
  ),
  8,
  'all hidden live-quote candidates have capability profiles'
);

select is(
  public.get_enabled_client_quote_vendors(
    '00000000-0000-4000-8000-000000037200'::uuid
  ),
  array['xometry', 'fictiv', 'protolabs']::public.vendor_name[],
  'hidden candidates are not activated in the no-config fallback'
);

-- Supplier directory tables remain RLS-controlled and detached from quoting.
select is(
  (
    select count(*)::integer
    from pg_class relation
    join pg_namespace namespace_row on namespace_row.oid = relation.relnamespace
    where namespace_row.nspname = 'public'
      and relation.relname in (
        'supplier_companies',
        'supplier_sources',
        'supplier_source_records',
        'supplier_company_aliases',
        'supplier_facilities',
        'supplier_capabilities',
        'supplier_certifications',
        'supplier_facility_capability_claims',
        'supplier_facility_certification_claims',
        'supplier_verification_events'
      )
      and relation.relrowsecurity
  ),
  10,
  'all supplier directory tables enable RLS'
);

select is(
  (
    select count(*)::integer
    from pg_policy policy_row
    join pg_class relation on relation.oid = policy_row.polrelid
    join pg_namespace namespace_row on namespace_row.oid = relation.relnamespace
    where namespace_row.nspname = 'public'
      and relation.relname like 'supplier_%'
      and (
        select role_row.oid
        from pg_roles role_row
        where role_row.rolname = 'authenticated'
      ) = any(policy_row.polroles)
  ),
  12,
  'supplier directory policies are assigned to authenticated callers'
);

select is(
  (
    select count(*)::integer
    from pg_policy policy_row
    join pg_class relation on relation.oid = policy_row.polrelid
    join pg_namespace namespace_row on namespace_row.oid = relation.relnamespace
    where namespace_row.nspname = 'public'
      and relation.relname like 'supplier_%'
      and (
        (
          select role_row.oid
          from pg_roles role_row
          where role_row.rolname = 'anon'
        ) = any(policy_row.polroles)
        or 0::oid = any(policy_row.polroles)
      )
  ),
  0,
  'supplier directory exposes no anonymous or PUBLIC policy'
);

select is(
  (
    select count(*)::integer
    from pg_class relation
    join pg_namespace namespace_row on namespace_row.oid = relation.relnamespace
    where namespace_row.nspname = 'public'
      and relation.relname in (
        'supplier_companies',
        'supplier_sources',
        'supplier_source_records',
        'supplier_company_aliases',
        'supplier_facilities',
        'supplier_capabilities',
        'supplier_certifications',
        'supplier_facility_capability_claims',
        'supplier_facility_certification_claims',
        'supplier_verification_events'
      )
      and has_table_privilege('authenticated', relation.oid, 'select')
      and has_table_privilege('authenticated', relation.oid, 'insert')
      and has_table_privilege('authenticated', relation.oid, 'update')
      and has_table_privilege('authenticated', relation.oid, 'delete')
  ),
  10,
  'authenticated callers have supplier table privileges mediated by RLS'
);

select is(
  (
    select count(*)::integer
    from pg_policy policy_row
    where policy_row.polname in (
      'supplier_capabilities_authenticated_select',
      'supplier_certifications_authenticated_select'
    )
      and policy_row.polcmd = 'r'
  ),
  2,
  'ordinary authenticated supplier access is limited to active vocabularies'
);

select is(
  (
    select count(*)::integer
    from pg_constraint constraint_row
    join pg_class source_relation on source_relation.oid = constraint_row.conrelid
    join pg_class target_relation on target_relation.oid = constraint_row.confrelid
    join pg_namespace target_namespace on target_namespace.oid = target_relation.relnamespace
    where constraint_row.contype = 'f'
      and source_relation.relname in (
        'quote_runs',
        'vendor_quote_results',
        'org_vendor_configs',
        'work_queue'
      )
      and target_namespace.nspname = 'public'
      and target_relation.relname like 'supplier_%'
  ),
  0,
  'supplier directory records do not activate or bind the quote execution model'
);

-- Mobile auth persistence is private, forced-RLS, and server-RPC-only.
select is(
  (
    select count(*)::integer
    from pg_class relation
    join pg_namespace namespace_row on namespace_row.oid = relation.relnamespace
    where namespace_row.nspname = 'private'
      and relation.relname in (
        'mobile_auth_transactions',
        'mobile_auth_rate_limit_counters',
        'mobile_auth_audit_events'
      )
      and relation.relrowsecurity
      and relation.relforcerowsecurity
  ),
  3,
  'all mobile-auth tables enable and force RLS'
);

select is(
  (
    select count(*)::integer
    from pg_policy policy_row
    join pg_class relation on relation.oid = policy_row.polrelid
    join pg_namespace namespace_row on namespace_row.oid = relation.relnamespace
    where namespace_row.nspname = 'private'
      and relation.relname like 'mobile_auth_%'
  ),
  0,
  'private mobile-auth tables have no RLS policies'
);

select is(
  (
    select count(*)::integer
    from pg_class relation
    join pg_namespace namespace_row on namespace_row.oid = relation.relnamespace
    where namespace_row.nspname = 'private'
      and relation.relname in (
        'mobile_auth_transactions',
        'mobile_auth_rate_limit_counters',
        'mobile_auth_audit_events'
      )
      and not has_table_privilege('anon', relation.oid, 'select')
      and not has_table_privilege('authenticated', relation.oid, 'select')
      and not has_table_privilege('service_role', relation.oid, 'select')
  ),
  3,
  'application roles have no direct read privilege on mobile-auth tables'
);

select is(
  (
    select count(*)::integer
    from pg_proc procedure_row
    join pg_namespace namespace_row on namespace_row.oid = procedure_row.pronamespace
    where namespace_row.nspname = 'public'
      and procedure_row.proname like 'api_mobile_auth_%'
      and has_function_privilege('service_role', procedure_row.oid, 'execute')
      and not has_function_privilege('anon', procedure_row.oid, 'execute')
      and not has_function_privilege('authenticated', procedure_row.oid, 'execute')
  ),
  10,
  'all mobile-auth RPCs are executable only by service_role'
);

select is(
  (
    select count(*)::integer
    from pg_proc procedure_row
    join pg_namespace namespace_row on namespace_row.oid = procedure_row.pronamespace
    where namespace_row.nspname = 'public'
      and procedure_row.proname like 'api_mobile_auth_%'
      and procedure_row.prosecdef
      and procedure_row.proconfig @> array['search_path=""']::text[]
  ),
  10,
  'all mobile-auth RPCs are hardened security-definer functions'
);

-- Manual quote administration is capability-gated behind authenticated RPCs.
select is(
  (
    select count(*)::integer
    from pg_proc procedure_row
    join pg_namespace namespace_row on namespace_row.oid = procedure_row.pronamespace
    where namespace_row.nspname = 'public'
      and procedure_row.oid in (
        'public.api_admin_list_manual_quote_requests(text,integer)'::regprocedure,
        'public.api_admin_complete_manual_quote_request(uuid,uuid,uuid,uuid,public.vendor_name,text,text,public.vendor_status,text,text,text,jsonb,jsonb)'::regprocedure
      )
  ),
  2,
  'both manual quote admin RPCs exist'
);

select is(
  (
    select count(*)::integer
    from pg_proc procedure_row
    where procedure_row.oid in (
        'public.api_admin_list_manual_quote_requests(text,integer)'::regprocedure,
        'public.api_admin_complete_manual_quote_request(uuid,uuid,uuid,uuid,public.vendor_name,text,text,public.vendor_status,text,text,text,jsonb,jsonb)'::regprocedure
      )
      and has_function_privilege('authenticated', procedure_row.oid, 'execute')
      and not has_function_privilege('anon', procedure_row.oid, 'execute')
      and not has_function_privilege('service_role', procedure_row.oid, 'execute')
  ),
  2,
  'manual quote admin RPC execution is limited to authenticated callers'
);

select is(
  (
    select count(*)::integer
    from pg_proc procedure_row
    where procedure_row.oid in (
        'public.api_admin_list_manual_quote_requests(text,integer)'::regprocedure,
        'public.api_admin_complete_manual_quote_request(uuid,uuid,uuid,uuid,public.vendor_name,text,text,public.vendor_status,text,text,text,jsonb,jsonb)'::regprocedure
      )
      and procedure_row.prosecdef
      and procedure_row.proconfig @> array['search_path=pg_catalog']::text[]
  ),
  2,
  'manual quote admin RPCs are hardened security-definer functions'
);

select is(
  (
    select count(*)::integer
    from pg_policy policy_row
    where policy_row.polname in (
      'vendor_quote_artifacts_select_billing_admin',
      'quote_artifacts_storage_insert_billing_admin',
      'quote_artifacts_storage_read_billing_admin',
      'quote_artifacts_storage_delete_billing_admin_unregistered'
    )
      and (
        select role_row.oid
        from pg_roles role_row
        where role_row.rolname = 'authenticated'
      ) = any(policy_row.polroles)
  ),
  4,
  'manual quote admin artifact policies are assigned to authenticated callers'
);

set local role authenticated;
select set_config('request.jwt.claims', '{}'::text, true);
select set_config('request.jwt.claim.sub', ''::text, true);

select throws_ok(
  $$
    select public.api_admin_list_manual_quote_requests(null, 25)
  $$,
  'P0001',
  'You must be signed in to view manual quote requests.',
  'the manual quote admin inbox rejects an unsigned authenticated-role call'
);

reset role;

select * from finish();

rollback;
