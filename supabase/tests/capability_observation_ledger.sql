begin;

create extension if not exists pgtap with schema extensions;

select plan(41);

select has_table(
  'private',
  'capability_observations',
  'the capability observation ledger is private'
);

select has_sequence(
  'private',
  'capability_observations_id_seq',
  'the ledger identity sequence is private'
);

select has_function(
  'private',
  'record_capability_observation',
  array[
    'public.vendor_name', 'text', 'text', 'text', 'text', 'text', 'text',
    'text[]', 'text[]', 'boolean', 'timestamp with time zone',
    'timestamp with time zone', 'text', 'text', 'text', 'text', 'text', 'bigint'
  ],
  'the owner-only append primitive has the reviewed signature'
);

select has_trigger(
  'private',
  'capability_observations',
  'prepare_capability_observation_insert',
  'the ledger overwrites caller-supplied insert time'
);

select has_trigger(
  'private',
  'capability_observations',
  'reject_capability_observation_row_mutation',
  'the ledger rejects row mutation'
);

select has_trigger(
  'private',
  'capability_observations',
  'reject_capability_observation_truncate',
  'the ledger rejects truncation'
);

select has_index(
  'private',
  'capability_observations',
  'capability_observations_current_scope_idx',
  'the current-scope lookup index exists'
);

select is(
  (
    select pg_catalog.count(*)::integer
    from pg_catalog.pg_constraint constraint_row
    join pg_catalog.pg_class relation on relation.oid = constraint_row.conrelid
    join pg_catalog.pg_namespace namespace_row on namespace_row.oid = relation.relnamespace
    where namespace_row.nspname = 'private'
      and relation.relname = 'capability_observations'
      and constraint_row.conname in (
        'capability_observations_idempotency_key_unique',
        'capability_observations_scope_revision_unique'
      )
      and constraint_row.contype = 'u'
  ),
  2,
  'idempotency and scoped revision uniqueness are database constraints'
);

select is(
  (
    select pg_catalog.count(*)::integer
    from pg_catalog.pg_policy policy_row
    join pg_catalog.pg_class relation on relation.oid = policy_row.polrelid
    join pg_catalog.pg_namespace namespace_row on namespace_row.oid = relation.relnamespace
    where namespace_row.nspname = 'private'
      and relation.relname = 'capability_observations'
  ),
  0,
  'the private ledger has no RLS policy that could leak rows'
);

select ok(
  (
    select relation.relrowsecurity and relation.relforcerowsecurity
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace_row on namespace_row.oid = relation.relnamespace
    where namespace_row.nspname = 'private'
      and relation.relname = 'capability_observations'
  ),
  'the ledger enables and forces RLS'
);

select ok(
  (
    select owner_role.rolname = 'postgres'
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace_row on namespace_row.oid = relation.relnamespace
    join pg_catalog.pg_roles owner_role on owner_role.oid = relation.relowner
    where namespace_row.nspname = 'private'
      and relation.relname = 'capability_observations'
  ),
  'the ledger has fixed postgres ownership'
);

select is(
  (
    select pg_catalog.count(*)::integer
    from information_schema.columns column_row
    where column_row.table_schema = 'private'
      and column_row.table_name = 'capability_observations'
      and column_row.column_name in (
        'credential', 'password', 'secret', 'api_key', 'account_id',
        'customer_id', 'organization_id', 'user_id', 'filename', 'url',
        'email', 'hash', 'fingerprint', 'cookie', 'session_state',
        'browser_state', 'raw_payload', 'raw_response'
      )
  ),
  0,
  'the ledger has no raw identity, session, customer, file, or payload columns'
);

select private.record_capability_observation(
  'xometry',
  ' Provider_Upload ',
  ' Quote_Home ',
  ' Account_Quote_Modal ',
  ' Xometry-Account-Quote-Modal.v1 ',
  ' Provider-Upload-Capability.v1 ',
  ' Fresh ',
  array['.STP', 'step', '.step'],
  array['MODEL/STEP', 'application/step', 'model/step'],
  false,
  timestamptz '2026-09-11 02:00:00+00',
  timestamptz '2026-09-12 04:00:00+00',
  ' Worker ',
  ' Provider_Surface ',
  ' Worker.v1 ',
  'issue:OVD-512',
  ' OVD-512:Observation-1 ',
  1
) as first_observation_id \gset

select is(
  (select pg_catalog.count(*)::integer from private.capability_observations),
  1,
  'the append primitive records one observation'
);

select ok(
  (
    select capability = 'provider_upload'
      and route = 'quote_home'
      and surface = 'account_quote_modal'
      and surface_revision = 'xometry-account-quote-modal.v1'
      and contract_version = 'provider-upload-capability.v1'
      and observation_state = 'fresh'
      and observed_extensions = array['step', 'stp']::text[]
      and observed_mime_types = array['application/step', 'model/step']::text[]
      and accept_attribute_present is false
      and actor_kind = 'worker'
      and source_kind = 'provider_surface'
      and source_version = 'worker.v1'
      and evidence_reference = 'issue:OVD-512'
      and idempotency_key = 'ovd-512:observation-1'
      and observation_revision = 1
    from private.capability_observations
    where id = :first_observation_id
  ),
  'the append primitive stores the canonical bounded payload'
);

select ok(
  (
    select inserted_at between pg_catalog.statement_timestamp() - interval '5 seconds'
      and pg_catalog.statement_timestamp() + interval '5 seconds'
    from private.capability_observations
    where id = :first_observation_id
  ),
  'insert time is generated by the database'
);

select is(
  private.record_capability_observation(
    'xometry', 'provider_upload', 'quote_home', 'account_quote_modal',
    'xometry-account-quote-modal.v1', 'provider-upload-capability.v1', 'fresh',
    array['step', '.STP'], array['application/step', 'MODEL/STEP'], false,
    timestamptz '2026-09-11 02:00:00+00',
    timestamptz '2026-09-12 04:00:00+00',
    'worker', 'provider_surface', 'worker.v1', 'issue:OVD-512',
    'ovd-512:observation-1', 1
  ),
  :first_observation_id::bigint,
  'an exact normalized key, revision, and payload replay is a no-op'
);

select is(
  (select pg_catalog.count(*)::integer from private.capability_observations),
  1,
  'exact replay does not append a duplicate row'
);

select throws_ok(
  $$select private.record_capability_observation(
    'xometry', 'provider_upload', 'quote_home', 'account_quote_modal',
    'xometry-account-quote-modal.v1', 'provider-upload-capability.v1', 'fresh',
    array['step'], array['model/step'], true,
    timestamptz '2026-09-11 02:00:00+00',
    timestamptz '2026-09-12 04:00:00+00',
    'worker', 'provider_surface', 'worker.v1', 'issue:OVD-512',
    'ovd-512:observation-1', 1
  )$$,
  '23505',
  'Capability observation replay conflict.',
  'same key and revision with a changed payload rejects deterministically'
);

select throws_ok(
  $$select private.record_capability_observation(
    'xometry', 'provider_upload', 'quote_home', 'account_quote_modal',
    'xometry-account-quote-modal.v1', 'provider-upload-capability.v1', 'fresh',
    array['step', 'stp'], array['application/step', 'model/step'], false,
    timestamptz '2026-09-11 02:00:00+00',
    timestamptz '2026-09-12 04:00:00+00',
    'worker', 'provider_surface', 'worker.v1', 'issue:OVD-512',
    'ovd-512:other-key', 1
  )$$,
  '23505',
  'Capability observation replay conflict.',
  'a scoped observation revision cannot be reused under another key'
);

select throws_ok(
  $$select private.record_capability_observation(
    'xometry', 'provider_upload', 'quote_home', 'account_quote_modal',
    'xometry-account-quote-modal.v1', 'provider-upload-capability.v1', 'fresh',
    array['step', 'stp'], array['application/step', 'model/step'], false,
    timestamptz '2026-09-11 02:00:00+00',
    timestamptz '2026-09-12 04:00:00+00',
    'worker', 'provider_surface', 'worker.v1', 'issue:OVD-512',
    'ovd-512:observation-1', 2
  )$$,
  '23505',
  'Capability observation replay conflict.',
  'an idempotency key cannot be reused for another revision'
);

select throws_ok(
  $$update private.capability_observations set source_version = 'worker.v2'$$,
  'P0001',
  'Capability observations are append-only.',
  'ledger rows cannot be updated'
);

select throws_ok(
  $$delete from private.capability_observations$$,
  'P0001',
  'Capability observations are append-only.',
  'ledger rows cannot be deleted'
);

select throws_ok(
  $$truncate table private.capability_observations$$,
  'P0001',
  'Capability observations are append-only.',
  'the indefinitely retained ledger cannot be truncated'
);

select throws_ok(
  $$select private.record_capability_observation(
    'xometry', 'provider_upload', 'quote_home', 'account_quote_modal',
    'xometry-account-quote-modal.v1', 'provider-upload-capability.v1', 'fresh',
    array['step'], array['model/step'], true,
    pg_catalog.statement_timestamp() + interval '6 minutes',
    pg_catalog.statement_timestamp() + interval '7 minutes',
    'worker', 'provider_surface', 'worker.v1', 'issue:OVD-512',
    'ovd-512:future-skew', 2
  )$$,
  '23514',
  null,
  'observations more than five minutes in the future are rejected'
);

select throws_ok(
  $$select private.record_capability_observation(
    'xometry', 'provider_upload', 'quote_home', 'account_quote_modal',
    'xometry-account-quote-modal.v1', 'provider-upload-capability.v1', 'fresh',
    array['step'], array['model/step'], true,
    pg_catalog.statement_timestamp(),
    pg_catalog.statement_timestamp() + interval '26 hours 1 second',
    'worker', 'provider_surface', 'worker.v1', 'issue:OVD-512',
    'ovd-512:ttl-too-long', 2
  )$$,
  '23514',
  null,
  'observation TTL cannot exceed 26 hours'
);

select throws_ok(
  $$select private.record_capability_observation(
    'xometry', 'provider_upload', 'quote_home', 'account_quote_modal',
    'xometry-account-quote-modal.v1', 'provider-upload-capability.v1', 'missing',
    array[]::text[], array[]::text[], null,
    pg_catalog.statement_timestamp(),
    pg_catalog.statement_timestamp() + interval '1 hour',
    'worker', 'provider_surface', 'worker.v1', 'issue:OVD-512',
    'ovd-512:derived-state', 2
  )$$,
  '23514',
  null,
  'derived missing and stale states cannot be persisted'
);

select throws_ok(
  $$select private.record_capability_observation(
    'xometry', 'provider_upload', 'quote_home', 'account_quote_modal',
    'xometry-account-quote-modal.v1', 'provider-upload-capability.v1', 'provider_error',
    array['step'], array[]::text[], null,
    pg_catalog.statement_timestamp(),
    pg_catalog.statement_timestamp() + interval '1 hour',
    'worker', 'provider_surface', 'worker.v1', 'issue:OVD-512',
    'ovd-512:non-fresh-formats', 2
  )$$,
  '23514',
  null,
  'non-fresh observations cannot carry format facts'
);

select throws_ok(
  $$select private.record_capability_observation(
    'xometry', 'provider_upload', 'quote_home', 'account_quote_modal',
    'xometry-account-quote-modal.v2', 'provider-upload-capability.v2', 'fresh',
    array['step'], array['model/step'], true,
    pg_catalog.statement_timestamp(),
    pg_catalog.statement_timestamp() + interval '1 hour',
    'worker', 'provider_surface', 'worker.v1', 'issue:OVD-512',
    'ovd-512:contract-version', 2
  )$$,
  '23514',
  null,
  'only the bounded v1 observation contract can be stored'
);

select throws_ok(
  $$select private.record_capability_observation(
    'xometry', 'provider_upload', 'quote_home', 'account_quote_modal',
    'xometry-account-quote-modal.v2', 'provider-upload-capability.v1', 'fresh',
    array['step'], array['model/step'], true,
    pg_catalog.statement_timestamp(),
    pg_catalog.statement_timestamp() + interval '1 hour',
    'worker', 'provider_surface', 'worker.v1', 'https://provider.example/raw',
    'ovd-512:unsafe-evidence', 2
  )$$,
  '23514',
  null,
  'evidence references cannot store URLs or raw provider material'
);

select lives_ok(
  $$select private.record_capability_observation(
    'xometry', 'provider_upload', 'quote_home', 'account_quote_modal',
    'xometry-account-quote-modal.v2', 'provider-upload-capability.v1', 'provider_error',
    array[]::text[], array[]::text[], null,
    pg_catalog.statement_timestamp(),
    pg_catalog.statement_timestamp() + interval '26 hours',
    'scheduled_canary', 'scheduled_canary', 'canary.v1', 'issue:OVD-512',
    'ovd-512:observation-2', 2
  )$$,
  'the 26-hour boundary and a bounded non-fresh provenance payload are accepted'
);

select is(
  (
    select pg_catalog.count(*)::integer
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace_row on namespace_row.oid = relation.relnamespace
    where namespace_row.nspname = 'private'
      and relation.relname = 'capability_observations'
      and not pg_catalog.has_table_privilege('anon', relation.oid, 'select,insert,update,delete,truncate')
      and not pg_catalog.has_table_privilege('authenticated', relation.oid, 'select,insert,update,delete,truncate')
      and not pg_catalog.has_table_privilege('service_role', relation.oid, 'select,insert,update,delete,truncate')
  ),
  1,
  'application roles have no direct ledger privilege'
);

select ok(
  not pg_catalog.has_sequence_privilege(
    'anon',
    'private.capability_observations_id_seq',
    'select,usage,update'
  )
  and not pg_catalog.has_sequence_privilege(
    'authenticated',
    'private.capability_observations_id_seq',
    'select,usage,update'
  )
  and not pg_catalog.has_sequence_privilege(
    'service_role',
    'private.capability_observations_id_seq',
    'select,usage,update'
  ),
  'application roles have no direct identity-sequence privilege'
);

select ok(
  not pg_catalog.has_function_privilege(
    'anon',
    'private.record_capability_observation(public.vendor_name,text,text,text,text,text,text,text[],text[],boolean,timestamp with time zone,timestamp with time zone,text,text,text,text,text,bigint)',
    'execute'
  )
  and not pg_catalog.has_function_privilege(
    'authenticated',
    'private.record_capability_observation(public.vendor_name,text,text,text,text,text,text,text[],text[],boolean,timestamp with time zone,timestamp with time zone,text,text,text,text,text,bigint)',
    'execute'
  )
  and not pg_catalog.has_function_privilege(
    'service_role',
    'private.record_capability_observation(public.vendor_name,text,text,text,text,text,text,text[],text[],boolean,timestamp with time zone,timestamp with time zone,text,text,text,text,text,bigint)',
    'execute'
  ),
  'no application role can execute the owner-only append primitive'
);

select ok(
  (
    select not procedure_row.prosecdef
      and procedure_row.proconfig @> array['search_path=pg_catalog']::text[]
      and owner_role.rolname = 'postgres'
    from pg_catalog.pg_proc procedure_row
    join pg_catalog.pg_namespace namespace_row on namespace_row.oid = procedure_row.pronamespace
    join pg_catalog.pg_roles owner_role on owner_role.oid = procedure_row.proowner
    where namespace_row.nspname = 'private'
      and procedure_row.proname = 'record_capability_observation'
  ),
  'the private append primitive is owner-bound, security-invoker, and has a fixed search path'
);

select is(
  (
    select pg_catalog.count(*)::integer
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace_row on namespace_row.oid = relation.relnamespace
    where namespace_row.nspname in ('public', 'api')
      and relation.relname like '%capability_observation%'
  ),
  0,
  'the migration creates no public or API relation'
);

select is(
  (
    select pg_catalog.count(*)::integer
    from pg_catalog.pg_proc procedure_row
    join pg_catalog.pg_namespace namespace_row on namespace_row.oid = procedure_row.pronamespace
    where namespace_row.nspname in ('public', 'api')
      and procedure_row.proname like '%capability_observation%'
  ),
  0,
  'the migration creates no public or PostgREST RPC'
);

set local role authenticated;

select throws_ok(
  $$select * from private.capability_observations$$,
  '42501',
  null,
  'authenticated clients cannot read the private ledger'
);

select throws_ok(
  $$select private.record_capability_observation(
    'xometry', 'provider_upload', 'quote_home', 'account_quote_modal',
    'xometry-account-quote-modal.v3', 'provider-upload-capability.v1', 'provider_error',
    array[]::text[], array[]::text[], null,
    pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp() + interval '1 hour',
    'worker', 'provider_surface', 'worker.v1', 'issue:OVD-512',
    'ovd-512:unauthorized-client', 3
  )$$,
  '42501',
  null,
  'authenticated clients cannot call the private append primitive'
);

reset role;
set local role service_role;

select throws_ok(
  $$select * from private.capability_observations$$,
  '42501',
  null,
  'service_role cannot read the ledger directly'
);

select throws_ok(
  $$insert into private.capability_observations (
    provider, capability, route, surface, surface_revision, contract_version,
    observation_state, observed_at, expires_at, actor_kind, source_kind,
    source_version, evidence_reference, idempotency_key, observation_revision
  ) values (
    'xometry', 'provider_upload', 'quote_home', 'account_quote_modal',
    'xometry-account-quote-modal.v3', 'provider-upload-capability.v1',
    'provider_error', pg_catalog.statement_timestamp(),
    pg_catalog.statement_timestamp() + interval '1 hour', 'worker',
    'provider_surface', 'worker.v1', 'issue:OVD-512',
    'ovd-512:unauthorized-service', 3
  )$$,
  '42501',
  null,
  'service_role cannot insert into the ledger directly'
);

select throws_ok(
  $$select private.record_capability_observation(
    'xometry', 'provider_upload', 'quote_home', 'account_quote_modal',
    'xometry-account-quote-modal.v3', 'provider-upload-capability.v1', 'provider_error',
    array[]::text[], array[]::text[], null,
    pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp() + interval '1 hour',
    'worker', 'provider_surface', 'worker.v1', 'issue:OVD-512',
    'ovd-512:unauthorized-service', 3
  )$$,
  '42501',
  null,
  'service_role cannot call the private append primitive directly'
);

reset role;

select * from finish();
rollback;
