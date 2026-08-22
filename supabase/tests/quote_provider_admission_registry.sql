begin;

create extension if not exists pgtap with schema extensions;

select plan(57);

select has_table(
  'private', -- NOSONAR: canonical private-schema assertion fixture
  'quote_provider_admission_policies', -- NOSONAR: canonical current-policy relation under test
  'the provider admission current-policy registry is private'
);

select has_table(
  'private',
  'quote_provider_admission_policy_history', -- NOSONAR: canonical append-only history relation under test
  'the provider admission review history is private'
);

select is(
  (
    select count(*)::integer
    from pg_catalog.pg_enum enum_row
    join pg_catalog.pg_type type_row on type_row.oid = enum_row.enumtypid
    join pg_catalog.pg_namespace namespace_row on namespace_row.oid = type_row.typnamespace
    where namespace_row.nspname = 'public' -- NOSONAR: canonical application-schema catalog fixture
      and type_row.typname = 'vendor_name'
  ),
  17,
  'the current vendor enum contains the expected 17 providers'
);

select is(
  (select count(*)::integer from private.quote_provider_admission_policies),
  17,
  'the registry seeds exactly one current policy per provider'
);

select is(
  (
    select count(*)::integer
    from (
      select enum_row.enumlabel
      from pg_catalog.pg_enum enum_row
      join pg_catalog.pg_type type_row on type_row.oid = enum_row.enumtypid
      join pg_catalog.pg_namespace namespace_row on namespace_row.oid = type_row.typnamespace
      where namespace_row.nspname = 'public'
        and type_row.typname = 'vendor_name'
      except
      select policy.provider::text
      from private.quote_provider_admission_policies policy
    ) missing_provider
  ),
  0,
  'every current vendor enum value has an admission policy'
);

select ok(
  (
    select admission_state = 'controlled_beta_only' -- NOSONAR: explicit controlled-beta policy assertion
      and not generic_dispatch_enabled
    from private.quote_provider_admission_policies
    where provider = 'xometry' -- NOSONAR: deterministic controlled-beta provider fixture
  ),
  'Xometry is controlled-beta-only and not admitted to generic dispatch'
);

select is(
  (
    select count(*)::integer
    from private.quote_provider_admission_policies
    where provider <> 'xometry'
      and admission_state = 'disabled'
      and not generic_dispatch_enabled
  ),
  16,
  'all non-Xometry providers seed disabled and not generically dispatchable'
);

select is(
  (
    select count(*)::integer
    from private.quote_provider_admission_policies
    where generic_dispatch_enabled
  ),
  0,
  'the migration admits no provider to generic dispatch'
);

select is(
  (
    select count(*)::integer
    from private.quote_provider_admission_policy_history
    where change_kind = 'insert'
  ),
  17,
  'every seeded policy has an append-only baseline history event'
);

select ok(
  (
    select admission_state = 'controlled_beta_only'
      and not generic_dispatch_enabled
      and policy_revision = 'xometry-controlled-beta-2026-08-17.v1'
      and evidence_reference = 'OVD-373'
      and permission_basis = 'existing_controlled_beta_path'
      and supported_processes = array['cnc_milling']::public.process_types[] -- NOSONAR: deterministic provider-process fixture
      and accepted_file_extensions = array['step', 'stp']::text[]
      and session_owner = 'overdrafter_managed' -- NOSONAR: explicit bounded session-ownership assertion
      and reviewed_at = timestamptz '2026-08-17 00:00:00+00'
      and change_kind = 'insert'
      and change_reason = 'initial_seed'
    from private.quote_provider_admission_policy_history
    where provider = 'xometry'
      and policy_revision = 'xometry-controlled-beta-2026-08-17.v1'
  ),
  'the baseline history captures the exact Xometry controlled-beta policy snapshot'
);

select ok(
  (
    select not policy_present
      and not provider_admitted
      and not generically_dispatchable
      and reason_code = 'provider_unknown' -- NOSONAR: stable fail-closed resolver reason
    from private.resolve_quote_provider_admission_policy('unknown-provider')
  ),
  'an unknown provider resolves closed instead of raising an enum error'
);

select ok(
  (
    select not policy_present
      and not provider_admitted
      and not generically_dispatchable
      and reason_code = 'provider_unknown'
    from private.resolve_quote_provider_admission_policy(null)
  )
  and (
    select not policy_present
      and not provider_admitted
      and not generically_dispatchable
      and reason_code = 'provider_unknown'
    from private.resolve_quote_provider_admission_policy('   ')
  ),
  'missing provider inputs resolve closed'
);

select ok(
  (
    select policy_present
      and not provider_admitted
      and not generically_dispatchable
      and reason_code = 'provider_disabled'
    from private.resolve_quote_provider_admission_policy('fictiv')
  ),
  'a seeded disabled provider resolves closed'
);

select ok(
  (
    select policy_present
      and provider_admitted
      and not generically_dispatchable
      and reason_code = 'controlled_beta_only'
    from private.resolve_quote_provider_admission_policy('xometry')
  ),
  'the resolver preserves Xometry controlled-beta admission without enabling generic dispatch'
);

select throws_ok(
  $$
    update private.quote_provider_admission_policies
    set admission_state = 'controlled_beta_only',
        policy_revision = 'ovd379-incomplete-controlled-beta',
        change_reason = 'policy_updated' -- NOSONAR: explicit append-only revision reason fixture
    where provider = 'fictiv'
  $$,
  '23514', -- NOSONAR: stable check-constraint SQLSTATE assertion
  null,
  'controlled-beta admission cannot omit reviewed evidence, capabilities, or session ownership'
);

insert into auth.users (
  id,
  aud,
  role,
  email,
  email_confirmed_at,
  raw_app_meta_data
) values (
  '00000000-0000-4000-8000-000000003791', -- NOSONAR: deterministic reviewer fixture identifier
  'authenticated', -- NOSONAR: deterministic authenticated-role fixture
  'authenticated',
  'ovd379-reviewer@example.test',
  pg_catalog.timezone('utc', pg_catalog.now()),
  '{"provider":"email"}'::jsonb
);

select throws_ok(
  $$
    update private.quote_provider_admission_policies
    set evidence_reference = 'credential:customer@example.test',
        policy_revision = 'ovd379-invalid-evidence-reference',
        change_reason = 'policy_updated'
    where provider = 'quickparts' -- NOSONAR: deterministic provider policy fixture
  $$,
  '23514',
  null,
  'evidence references are restricted to opaque Linear issue identifiers'
);

select throws_ok(
  $$
    update private.quote_provider_admission_policies
    set permission_basis = 'Customer account 123 with saved browser session',
        policy_revision = 'ovd379-invalid-permission-basis',
        change_reason = 'policy_updated'
    where provider = 'quickparts'
  $$,
  '23514',
  null,
  'permission basis is restricted to a non-sensitive vocabulary'
);

select throws_ok(
  $$
    update private.quote_provider_admission_policies
    set policy_revision = 'ovd379-invalid-change-reason',
        change_reason = 'Raw provider response copied here'
    where provider = 'quickparts'
  $$,
  '23514',
  null,
  'change reasons are restricted to a non-sensitive vocabulary'
);

select throws_ok(
  $$
    update private.quote_provider_admission_policies
    set policy_revision = ' ovd379-invalid-padded-revision ',
        change_reason = 'policy_updated'
    where provider = 'quickparts'
  $$,
  '23514',
  null,
  'policy revisions must be normalized safe identifiers'
);

select throws_ok(
  $$
    update private.quote_provider_admission_policies
    set generic_dispatch_enabled = true,
        policy_revision = 'ovd379-invalid-generic-state'
    where provider = 'quickparts'
  $$,
  '23514',
  null,
  'generic dispatch cannot be enabled for a disabled provider'
);

select throws_ok(
  $$
    update private.quote_provider_admission_policies
    set admission_state = 'approved', -- NOSONAR: explicit approved-state negative fixture
        generic_dispatch_enabled = true,
        policy_revision = 'ovd379-invalid-controlled-beta-basis',
        evidence_reference = 'OVD-379', -- NOSONAR: opaque issue evidence fixture intentionally reused
        permission_basis = 'existing_controlled_beta_path',
        supported_processes = array['cnc_milling']::public.process_types[],
        accepted_file_extensions = array['step'],
        session_owner = 'overdrafter_managed',
        reviewed_by = '00000000-0000-4000-8000-000000003791',
        reviewed_at = pg_catalog.now(),
        expires_at = pg_catalog.now() + interval '30 days', -- NOSONAR: deterministic bounded approval-expiry fixture
        change_reason = 'approval_recorded' -- NOSONAR: explicit append-only approval event fixture
    where provider = 'quickparts'
  $$,
  '23514',
  null,
  'the specialized Xometry controlled-beta basis cannot authorize generic provider dispatch'
);

select throws_ok(
  $$
    update private.quote_provider_admission_policies
    set admission_state = 'approved',
        generic_dispatch_enabled = true,
        policy_revision = 'ovd379-invalid-account-basis',
        evidence_reference = 'OVD-379',
        permission_basis = 'customer_managed_account',
        supported_processes = array['cnc_milling']::public.process_types[],
        accepted_file_extensions = array['step'],
        session_owner = 'customer_managed',
        reviewed_by = '00000000-0000-4000-8000-000000003791',
        reviewed_at = pg_catalog.now(),
        expires_at = pg_catalog.now() + interval '30 days',
        change_reason = 'approval_recorded'
    where provider = 'quickparts'
  $$,
  '23514',
  null,
  'account ownership alone cannot authorize generic provider dispatch'
);

select throws_ok(
  $$
    update private.quote_provider_admission_policies
    set accepted_file_extensions = array['.step'],
        policy_revision = 'ovd379-invalid-extension'
    where provider = 'quickparts'
  $$,
  '23514',
  null,
  'file extensions must use the bounded normalized allowlist format'
);

select throws_ok(
  $$
    update private.quote_provider_admission_policies
    set session_owner = 'shared_browser_profile',
        policy_revision = 'ovd379-invalid-session-owner'
    where provider = 'quickparts'
  $$,
  '23514',
  null,
  'session ownership is restricted to the explicit safe vocabulary'
);

select throws_ok(
  $$
    update private.quote_provider_admission_policies
    set reviewed_at = pg_catalog.now(),
        expires_at = pg_catalog.now(),
        policy_revision = 'ovd379-invalid-expiry'
    where provider = 'quickparts'
  $$,
  '23514',
  null,
  'policy expiry must be later than its review time'
);

select throws_ok(
  $$
    update private.quote_provider_admission_policies
    set provider = 'rapiddirect',
        policy_revision = 'ovd379-rekey-provider'
    where provider = 'quickparts'
  $$,
  'P0001', -- NOSONAR: stable policy-trigger SQLSTATE assertion
  'Provider admission policy identity is immutable.',
  'a policy revision cannot rekey its provider identity'
);

select throws_ok(
  $$
    update private.quote_provider_admission_policies
    set admission_state = 'approved',
        generic_dispatch_enabled = true,
        policy_revision = 'ovd379-missing-evidence',
        evidence_reference = null,
        permission_basis = 'written_provider_authorization', -- NOSONAR: explicit approved permission-basis fixture
        supported_processes = array['cnc_milling']::public.process_types[],
        accepted_file_extensions = array['step'],
        session_owner = 'overdrafter_managed',
        reviewed_by = '00000000-0000-4000-8000-000000003791',
        reviewed_at = pg_catalog.now(),
        expires_at = pg_catalog.now() + interval '30 days',
        change_reason = 'approval_recorded'
    where provider = 'quickparts'
  $$,
  '23514',
  null,
  'approved admission cannot omit evidence'
);

select throws_ok(
  $$
    update private.quote_provider_admission_policies
    set admission_state = 'approved',
        generic_dispatch_enabled = true,
        policy_revision = 'ovd379-missing-permission',
        evidence_reference = 'OVD-379',
        permission_basis = null,
        supported_processes = array['cnc_milling']::public.process_types[],
        accepted_file_extensions = array['step'],
        session_owner = 'overdrafter_managed',
        reviewed_by = '00000000-0000-4000-8000-000000003791',
        reviewed_at = pg_catalog.now(),
        expires_at = pg_catalog.now() + interval '30 days',
        change_reason = 'approval_recorded'
    where provider = 'quickparts'
  $$,
  '23514',
  null,
  'approved admission cannot omit its permission basis'
);

select throws_ok(
  $$
    update private.quote_provider_admission_policies
    set admission_state = 'approved',
        generic_dispatch_enabled = true,
        policy_revision = 'ovd379-missing-process',
        evidence_reference = 'OVD-379',
        permission_basis = 'written_provider_authorization',
        supported_processes = array[]::public.process_types[],
        accepted_file_extensions = array['step'],
        session_owner = 'overdrafter_managed',
        reviewed_by = '00000000-0000-4000-8000-000000003791',
        reviewed_at = pg_catalog.now(),
        expires_at = pg_catalog.now() + interval '30 days'
    where provider = 'quickparts'
  $$,
  '23514',
  null,
  'approved admission requires at least one supported process'
);

select throws_ok(
  $$
    update private.quote_provider_admission_policies
    set admission_state = 'approved',
        generic_dispatch_enabled = true,
        policy_revision = 'ovd379-missing-format',
        evidence_reference = 'OVD-379',
        permission_basis = 'written_provider_authorization',
        supported_processes = array['cnc_milling']::public.process_types[],
        accepted_file_extensions = array[]::text[],
        session_owner = 'overdrafter_managed',
        reviewed_by = '00000000-0000-4000-8000-000000003791',
        reviewed_at = pg_catalog.now(),
        expires_at = pg_catalog.now() + interval '30 days'
    where provider = 'quickparts'
  $$,
  '23514',
  null,
  'approved admission requires at least one accepted file extension'
);

select throws_ok(
  $$
    update private.quote_provider_admission_policies
    set admission_state = 'approved',
        generic_dispatch_enabled = true,
        policy_revision = 'ovd379-missing-session-owner',
        evidence_reference = 'OVD-379',
        permission_basis = 'written_provider_authorization',
        supported_processes = array['cnc_milling']::public.process_types[],
        accepted_file_extensions = array['step'],
        session_owner = null,
        reviewed_by = '00000000-0000-4000-8000-000000003791',
        reviewed_at = pg_catalog.now(),
        expires_at = pg_catalog.now() + interval '30 days'
    where provider = 'quickparts'
  $$,
  '23514',
  null,
  'approved admission cannot omit session ownership'
);

select throws_ok(
  $$
    update private.quote_provider_admission_policies
    set admission_state = 'approved',
        generic_dispatch_enabled = true,
        policy_revision = 'ovd379-missing-reviewer',
        evidence_reference = 'OVD-379',
        permission_basis = 'written_provider_authorization',
        supported_processes = array['cnc_milling']::public.process_types[],
        accepted_file_extensions = array['step'],
        session_owner = 'overdrafter_managed',
        reviewed_by = null,
        reviewed_at = pg_catalog.now(),
        expires_at = pg_catalog.now() + interval '30 days'
    where provider = 'quickparts'
  $$,
  '23514',
  null,
  'approved admission cannot omit the review actor'
);

select throws_ok(
  $$
    update private.quote_provider_admission_policies
    set admission_state = 'approved',
        generic_dispatch_enabled = true,
        policy_revision = 'ovd379-missing-reviewed-at',
        evidence_reference = 'OVD-379',
        permission_basis = 'written_provider_authorization',
        supported_processes = array['cnc_milling']::public.process_types[],
        accepted_file_extensions = array['step'],
        session_owner = 'overdrafter_managed',
        reviewed_by = '00000000-0000-4000-8000-000000003791',
        reviewed_at = null,
        expires_at = pg_catalog.now() + interval '30 days'
    where provider = 'quickparts'
  $$,
  '23514',
  null,
  'approved admission cannot omit the review time'
);

select lives_ok(
  $$
    update private.quote_provider_admission_policies
    set admission_state = 'approved',
        generic_dispatch_enabled = true,
        policy_revision = 'ovd379-approved-v1', -- NOSONAR: deterministic policy revision fixture
        evidence_reference = 'OVD-379',
        permission_basis = 'written_provider_authorization',
        supported_processes = array['cnc_milling']::public.process_types[],
        accepted_file_extensions = array['step', 'stp'],
        session_owner = 'overdrafter_managed',
        reviewed_by = '00000000-0000-4000-8000-000000003791',
        reviewed_at = pg_catalog.now(),
        expires_at = pg_catalog.now() + interval '30 days',
        change_reason = 'approval_recorded'
    where provider = 'quickparts'
  $$,
  'a complete approved policy can be recorded'
);

select ok(
  (
    select policy_present
      and provider_admitted
      and generically_dispatchable
      and reason_code = 'provider_approved'
    from private.resolve_quote_provider_admission_policy(' quickparts ')
  ),
  'a complete unexpired approved policy resolves admitted and generically dispatchable'
);

select is(
  (
    select count(*)::integer
    from private.quote_provider_admission_policy_history
    where provider = 'quickparts'
  ),
  2,
  'a successful policy revision appends one audit-history row'
);

select ok(
  (
    select admission_state = 'approved'
      and generic_dispatch_enabled
      and evidence_reference = 'OVD-379'
      and permission_basis = 'written_provider_authorization'
      and supported_processes = array['cnc_milling']::public.process_types[]
      and accepted_file_extensions = array['step', 'stp']::text[]
      and session_owner = 'overdrafter_managed'
      and reviewed_by = '00000000-0000-4000-8000-000000003791'
      and reviewed_at is not null
      and expires_at > reviewed_at
      and change_kind = 'update'
      and change_reason = 'approval_recorded'
    from private.quote_provider_admission_policy_history
    where provider = 'quickparts'
      and policy_revision = 'ovd379-approved-v1'
  ),
  'approval history captures the exact complete policy snapshot'
);

select throws_ok(
  $$
    update private.quote_provider_admission_policies
    set permission_basis = 'provider_terms_allow_automation'
    where provider = 'quickparts'
  $$,
  'P0001',
  'Provider admission policy updates require a new revision.',
  'a policy cannot be rewritten without a new policy revision'
);

select lives_ok(
  $$
    update private.quote_provider_admission_policies
    set policy_revision = 'ovd379-approved-expired-v2',
        reviewed_at = pg_catalog.now() - interval '2 days',
        expires_at = pg_catalog.now() - interval '1 day',
        change_reason = 'policy_expired' -- NOSONAR: explicit append-only expiry event fixture
    where provider = 'quickparts'
  $$,
  'an explicit new revision can expire an approved policy'
);

select ok(
  (
    select policy_present
      and not provider_admitted
      and not generically_dispatchable
      and reason_code = 'policy_expired'
    from private.resolve_quote_provider_admission_policy('quickparts')
  ),
  'an expired approved policy fails closed'
);

select is(
  (
    select count(*)::integer
    from private.quote_provider_admission_policy_history
    where provider = 'quickparts'
  ),
  3,
  'the expiration revision appends rather than rewrites audit history'
);

select ok(
  (
    select admission_state = 'approved'
      and generic_dispatch_enabled
      and evidence_reference = 'OVD-379'
      and permission_basis = 'written_provider_authorization'
      and change_kind = 'update'
      and change_reason = 'policy_expired'
      and expires_at <= pg_catalog.now()
    from private.quote_provider_admission_policy_history
    where provider = 'quickparts'
      and policy_revision = 'ovd379-approved-expired-v2'
  ),
  'expiry history captures the exact terminal policy snapshot'
);

select throws_ok(
  $$
    update private.quote_provider_admission_policies
    set policy_revision = 'ovd379-approved-v1',
        change_reason = 'correction'
    where provider = 'quickparts'
  $$,
  '23505',
  null,
  'a provider cannot reuse any prior policy revision identifier'
);

select throws_ok(
  $$
    update private.quote_provider_admission_policy_history
    set policy_revision = 'forged'
    where provider = 'quickparts'
  $$,
  'P0001',
  'Provider admission policy history is append-only.',
  'provider admission history cannot be updated'
);

select throws_ok(
  $$
    delete from private.quote_provider_admission_policy_history
    where provider = 'quickparts'
  $$,
  'P0001',
  'Provider admission policy history is append-only.',
  'provider admission history cannot be deleted'
);

select throws_ok(
  $$
    delete from private.quote_provider_admission_policies
    where provider = 'quickparts'
  $$,
  'P0001',
  'Provider admission policies cannot be deleted.',
  'provider admission policies cannot be deleted'
);

select is(
  (
    select count(*)::integer
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace_row on namespace_row.oid = relation.relnamespace
    where namespace_row.nspname = 'private'
      and relation.relname in (
        'quote_provider_admission_policies',
        'quote_provider_admission_policy_history'
      )
      and relation.relrowsecurity
      and relation.relforcerowsecurity
  ),
  2,
  'both admission tables enable and force RLS'
);

select is(
  (
    select count(*)::integer
    from pg_catalog.pg_policy policy_row
    join pg_catalog.pg_class relation on relation.oid = policy_row.polrelid
    join pg_catalog.pg_namespace namespace_row on namespace_row.oid = relation.relnamespace
    where namespace_row.nspname = 'private'
      and relation.relname in (
        'quote_provider_admission_policies',
        'quote_provider_admission_policy_history'
      )
  ),
  0,
  'private provider-admission tables have no RLS policies'
);

select is(
  (
    select count(*)::integer
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace_row on namespace_row.oid = relation.relnamespace
    where namespace_row.nspname = 'private'
      and relation.relname in (
        'quote_provider_admission_policies',
        'quote_provider_admission_policy_history'
      )
      and not pg_catalog.has_table_privilege('anon', relation.oid, 'select,insert,update,delete') -- NOSONAR: explicit direct-access denial matrix
      and not pg_catalog.has_table_privilege('authenticated', relation.oid, 'select,insert,update,delete')
      and not pg_catalog.has_table_privilege('service_role', relation.oid, 'select,insert,update,delete')
  ),
  2,
  'application roles have no direct admission-table privileges'
);

select ok(
  pg_catalog.has_function_privilege(
    'service_role',
    'private.resolve_quote_provider_admission_policy(text)', -- NOSONAR: canonical private resolver signature assertion
    'execute' -- NOSONAR: explicit resolver privilege assertion
  )
  and not pg_catalog.has_function_privilege(
    'anon',
    'private.resolve_quote_provider_admission_policy(text)',
    'execute'
  )
  and not pg_catalog.has_function_privilege(
    'authenticated',
    'private.resolve_quote_provider_admission_policy(text)',
    'execute'
  ),
  'only service_role can execute the private admission resolver'
);

select ok(
  (
    select procedure_row.prosecdef
      and procedure_row.proconfig @> array['search_path=pg_catalog']::text[]
    from pg_catalog.pg_proc procedure_row
    join pg_catalog.pg_namespace namespace_row on namespace_row.oid = procedure_row.pronamespace
    where namespace_row.nspname = 'private'
      and procedure_row.proname = 'resolve_quote_provider_admission_policy'
      and pg_catalog.pg_get_function_identity_arguments(procedure_row.oid) = 'p_provider text'
  ),
  'the private resolver is a hardened security-definer function'
);

select is(
  (
    select count(*)::integer
    from pg_catalog.pg_proc procedure_row
    join pg_catalog.pg_namespace namespace_row on namespace_row.oid = procedure_row.pronamespace
    where namespace_row.nspname = 'public'
      and procedure_row.proname like '%quote_provider_admission%'
  ),
  0,
  'provider admission creates no public function or RPC'
);

select is(
  (
    select count(*)::integer
    from information_schema.columns column_row
    where column_row.table_schema = 'private'
      and column_row.table_name in (
        'quote_provider_admission_policies',
        'quote_provider_admission_policy_history'
      )
      and column_row.column_name in (
        'credential',
        'password',
        'secret',
        'api_key',
        'account_id',
        'session_state',
        'cookie',
        'customer_file',
        'file_path',
        'raw_response',
        'raw_payload'
      )
  ),
  0,
  'admission metadata has no credential, account, session, file, or raw-response columns'
);

set local role authenticated;

select throws_ok(
  $$select * from private.quote_provider_admission_policies$$,
  '42501', -- NOSONAR: stable insufficient-privilege SQLSTATE assertion
  null,
  'authenticated callers cannot read the private registry directly'
);

select throws_ok(
  $$select * from private.resolve_quote_provider_admission_policy('xometry')$$,
  '42501',
  null,
  'authenticated callers cannot invoke the private resolver'
);

reset role;
set local role service_role;

select throws_ok(
  $$select * from private.quote_provider_admission_policies$$,
  '42501',
  null,
  'service_role cannot bypass the resolver with direct table access'
);

select lives_ok(
  $$select * from private.resolve_quote_provider_admission_policy('xometry')$$,
  'service_role can resolve admission without direct table access'
);

reset role;

select * from finish();

rollback;
