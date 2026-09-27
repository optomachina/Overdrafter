begin;

create extension if not exists pgtap with schema extensions;
select plan(33);

select has_function('public', 'api_record_capability_observation', -- NOSONAR: exact SQL contract and synthetic fixture literals repeat across independent assertions
  array['public.vendor_name','text','text','text','text','text','text',
    'text[]','text[]','boolean','timestamp with time zone',
    'timestamp with time zone','text','text','text','text','text','bigint'],
  'record RPC exposes only the reviewed signature');
select has_function('public', 'api_resolve_current_capability_observation', -- NOSONAR: exact SQL contract and synthetic fixture literals repeat across independent assertions
  array['public.vendor_name','text','text','text','text'],
  'resolver RPC exposes only the reviewed signature');

select ok((select count(*) = 2 and bool_and(p.prosecdef
    and p.proconfig @> array['search_path=pg_catalog']::text[]
    and owner.rolname = 'postgres')
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  join pg_catalog.pg_roles owner on owner.oid = p.proowner
  where n.nspname = 'public'
    and p.proname in ('api_record_capability_observation',
      'api_resolve_current_capability_observation')),
  'both RPCs are postgres-owned security definers with fixed search paths');

select ok((select count(*) = 2 and bool_and(
    not pg_catalog.has_function_privilege('anon', p.oid, 'execute') -- NOSONAR: exact SQL contract and synthetic fixture literals repeat across independent assertions
    and not pg_catalog.has_function_privilege('authenticated', p.oid, 'execute')
    and pg_catalog.has_function_privilege('service_role', p.oid, 'execute')) -- NOSONAR: exact SQL contract and synthetic fixture literals repeat across independent assertions
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('api_record_capability_observation',
      'api_resolve_current_capability_observation')),
  'only service_role can execute the two new RPCs');

select ok(not pg_catalog.has_table_privilege('service_role',
    'private.capability_observations', 'select,insert,update,delete')
  and not pg_catalog.has_sequence_privilege('service_role',
    'private.capability_observations_id_seq', 'usage,select,update')
  and not pg_catalog.has_function_privilege('service_role',
    'private.record_capability_observation(public.vendor_name,text,text,text,text,text,text,text[],text[],boolean,timestamp with time zone,timestamp with time zone,text,text,text,text,text,bigint)',
    'execute'),
  'service_role has no direct ledger, sequence, or owner-only primitive access');

set local role anon;
select throws_ok($$select public.api_resolve_current_capability_observation(
  'xometry', 'provider_upload', 'quote_home', 'account_quote_modal', 'v1')$$, -- NOSONAR: exact SQL contract and synthetic fixture literals repeat across independent assertions
  '42501', null, 'anon execution of resolver is rejected'); -- NOSONAR: exact SQL contract and synthetic fixture literals repeat across independent assertions
select throws_ok($$select public.api_record_capability_observation(
  'xometry', 'provider_upload', 'quote_home', 'account_quote_modal', 'v1',
  'provider-upload-capability.v1', 'fresh', array['step'], array['application/step'], true, -- NOSONAR: exact SQL contract and synthetic fixture literals repeat across independent assertions
  pg_catalog.transaction_timestamp(), pg_catalog.transaction_timestamp() + interval '1 hour', -- NOSONAR: exact SQL contract and synthetic fixture literals repeat across independent assertions
  'worker', 'provider_surface', 'worker.v1', 'issue:OVD-513', 'ovd-513:anon', 1)$$, -- NOSONAR: exact SQL contract and synthetic fixture literals repeat across independent assertions
  '42501', null, 'anon execution of record is rejected');
reset role;

set local role authenticated;
select throws_ok($$select public.api_resolve_current_capability_observation(
  'xometry', 'provider_upload', 'quote_home', 'account_quote_modal', 'v1')$$,
  '42501', null, 'authenticated execution of resolver is rejected');
select throws_ok($$select public.api_record_capability_observation(
  'xometry', 'provider_upload', 'quote_home', 'account_quote_modal', 'v1',
  'provider-upload-capability.v1', 'fresh', array['step'], array['application/step'], true,
  pg_catalog.transaction_timestamp(), pg_catalog.transaction_timestamp() + interval '1 hour',
  'worker', 'provider_surface', 'worker.v1', 'issue:OVD-513', 'ovd-513:auth', 1)$$,
  '42501', null, 'authenticated execution of record is rejected');
reset role;

set local role service_role;

select is((select freshness from public.api_resolve_current_capability_observation(
  'xometry', 'provider_upload', 'quote_home', 'account_quote_modal', 'missing')), -- NOSONAR: exact SQL contract and synthetic fixture literals repeat across independent assertions
  'missing', 'missing scope fails closed');
select is((select freshness from public.api_resolve_current_capability_observation(
  'xometry', 'provider_upload', 'bad/route', 'account_quote_modal', 'v1')),
  'invalid_scope', 'malformed scope fails closed');
select ok((select route is null and observation_revision is null
  from public.api_resolve_current_capability_observation(
    'xometry', 'provider_upload', 'bad/route', 'account_quote_modal', 'v1')),
  'malformed scope is never echoed into output');

select is(public.api_record_capability_observation(
  'xometry', ' PROVIDER_UPLOAD ', ' QUOTE_HOME ', ' ACCOUNT_QUOTE_MODAL ', ' V1 ',
  ' PROVIDER-UPLOAD-CAPABILITY.V1 ', ' FRESH ', array['.STEP', 'stp'],
  array['APPLICATION/STEP'], true,
  pg_catalog.transaction_timestamp() - interval '1 minute', -- NOSONAR: exact SQL contract and synthetic fixture literals repeat across independent assertions
  pg_catalog.transaction_timestamp() + interval '1 hour',
  ' WORKER ', ' PROVIDER_SURFACE ', ' WORKER.V1 ', 'issue:OVD-513',
  ' OVD-513:MAIN ', 11),
  11::bigint, 'record returns exact scoped revision, never private row id');

select is((select observation_state from public.api_resolve_current_capability_observation(
  'xometry', 'provider_upload', 'quote_home', 'account_quote_modal', 'v1')),
  'fresh', 'current matching observation is selected');
select is((select observation_revision from public.api_resolve_current_capability_observation(
  'xometry', 'provider_upload', 'quote_home', 'account_quote_modal', 'v1')),
  11::bigint, 'resolver exposes exact bindable revision');
select is((select observed_extensions from public.api_resolve_current_capability_observation(
  'xometry', 'provider_upload', 'quote_home', 'account_quote_modal', 'v1')),
  array['step','stp']::text[], 'resolver exposes normalized bounded formats');
select is((select freshness from public.api_resolve_current_capability_observation(
  'xometry', 'provider_upload', 'wrong_route', 'account_quote_modal', 'v1')),
  'missing', 'scope mismatch cannot read another scope');

select is(public.api_record_capability_observation(
  'xometry', 'provider_upload', 'quote_home', 'account_quote_modal', 'v1',
  'provider-upload-capability.v1', 'fresh', array['stp', 'step'],
  array['application/step'], true,
  pg_catalog.transaction_timestamp() - interval '1 minute',
  pg_catalog.transaction_timestamp() + interval '1 hour',
  'worker', 'provider_surface', 'worker.v1', 'issue:OVD-513',
  'ovd-513:main', 11), 11::bigint, -- NOSONAR: exact SQL contract and synthetic fixture literals repeat across independent assertions
  'canonical replay is a no-op through service RPC');

select throws_ok($$select public.api_record_capability_observation(
  'xometry', 'provider_upload', 'quote_home', 'account_quote_modal', 'v1',
  'provider-upload-capability.v1', 'fresh', array['stp', 'step'],
  array['application/step'], false,
  pg_catalog.transaction_timestamp() - interval '1 minute',
  pg_catalog.transaction_timestamp() + interval '1 hour',
  'worker', 'provider_surface', 'worker.v1', 'issue:OVD-513',
  'ovd-513:main', 11)$$, '23505',
  'Capability observation replay conflict.',
  'same key and revision with changed canonical payload rejects generically');

select throws_ok($$select public.api_record_capability_observation(
  'xometry', 'provider_upload', 'quote_home', 'account_quote_modal', 'v1',
  'provider-upload-capability.v1', 'fresh', array['step'],
  array['application/step'], true,
  pg_catalog.transaction_timestamp() - interval '1 minute',
  pg_catalog.transaction_timestamp() + interval '1 hour',
  'worker', 'provider_surface', 'worker.v1', 'private@example.com',
  'ovd-513:bad-evidence', 12)$$, '22023',
  'Capability observation rejected.',
  'invalid private evidence is rejected without returning its value');

reset role;
select ok((select count(*) = 1 from private.capability_observations
  where idempotency_key = 'ovd-513:main'),
  'replay and conflict append no second row');
set local role service_role;

select public.api_record_capability_observation(
  'xometry', 'provider_upload', 'quote_home', 'account_quote_modal', 'stale', -- NOSONAR: exact SQL contract and synthetic fixture literals repeat across independent assertions
  'provider-upload-capability.v1', 'fresh', array['step'],
  array['application/step'], true,
  pg_catalog.transaction_timestamp() - interval '3 hours',
  pg_catalog.transaction_timestamp() - interval '2 hours', -- NOSONAR: exact SQL contract and synthetic fixture literals repeat across independent assertions
  'worker', 'provider_surface', 'worker.v1', 'issue:OVD-513',
  'ovd-513:stale', 21);
select ok((select observation_state = 'stale' and freshness = 'stale'
    and observation_revision is null and pg_catalog.cardinality(observed_extensions) = 0
  from public.api_resolve_current_capability_observation(
    'xometry', 'provider_upload', 'quote_home', 'account_quote_modal', 'stale')),
  'expired observation has no bindable revision or formats');

select public.api_record_capability_observation(
  'xometry', 'provider_upload', 'quote_home', 'account_quote_modal', 'tied',
  'provider-upload-capability.v1', 'fresh', array['step'],
  array['application/step'], true,
  pg_catalog.transaction_timestamp() - interval '1 hour',
  pg_catalog.transaction_timestamp() - interval '1 minute',
  'worker', 'provider_surface', 'worker.v1', 'issue:OVD-513',
  'ovd-513:tied-a', 31);
select public.api_record_capability_observation(
  'xometry', 'provider_upload', 'quote_home', 'account_quote_modal', 'tied',
  'provider-upload-capability.v1', 'fresh', array['step'],
  array['application/step'], true,
  pg_catalog.transaction_timestamp() - interval '1 hour',
  pg_catalog.transaction_timestamp() + interval '1 hour',
  'worker', 'provider_surface', 'worker.v1', 'issue:OVD-513',
  'ovd-513:tied-b', 32);
select ok((select observation_state = 'ambiguous' and freshness = 'ambiguous' -- NOSONAR: exact SQL contract and synthetic fixture literals repeat across independent assertions
    and observation_revision is null and pg_catalog.cardinality(observed_extensions) = 0
  from public.api_resolve_current_capability_observation(
    'xometry', 'provider_upload', 'quote_home', 'account_quote_modal', 'tied')),
  'tied-newest expiry disagreement is ambiguous before stale classification');

select public.api_record_capability_observation(
  'xometry', 'provider_upload', 'quote_home', 'account_quote_modal', 'tie-state', -- NOSONAR: exact SQL contract and synthetic fixture literals repeat across independent assertions
  'provider-upload-capability.v1', 'fresh', array['step'],
  array['application/step'], true,
  pg_catalog.transaction_timestamp() - interval '1 minute',
  pg_catalog.transaction_timestamp() + interval '1 hour',
  'worker', 'provider_surface', 'worker.v1', 'issue:OVD-513',
  'ovd-513:state-a', 51);
select public.api_record_capability_observation(
  'xometry', 'provider_upload', 'quote_home', 'account_quote_modal', 'tie-state',
  'provider-upload-capability.v1', 'provider_error', array[]::text[], -- NOSONAR: exact SQL contract and synthetic fixture literals repeat across independent assertions
  array[]::text[], null,
  pg_catalog.transaction_timestamp() - interval '1 minute',
  pg_catalog.transaction_timestamp() + interval '1 hour',
  'worker', 'provider_surface', 'worker.v1', 'issue:OVD-513',
  'ovd-513:state-b', 52);
select ok((select observation_state = 'ambiguous' and observation_revision is null
  from public.api_resolve_current_capability_observation(
    'xometry', 'provider_upload', 'quote_home', 'account_quote_modal', 'tie-state')),
  'tied-newest state disagreement is ambiguous');

select public.api_record_capability_observation(
  'xometry', 'provider_upload', 'quote_home', 'account_quote_modal', 'tie-same', -- NOSONAR: exact SQL contract and synthetic fixture literals repeat across independent assertions
  'provider-upload-capability.v1', 'fresh', array['step'],
  array['application/step'], true,
  pg_catalog.transaction_timestamp() - interval '1 minute',
  pg_catalog.transaction_timestamp() + interval '1 hour',
  'worker', 'provider_surface', 'worker.v1', 'issue:OVD-513',
  'ovd-513:same-a', 61);
select public.api_record_capability_observation(
  'xometry', 'provider_upload', 'quote_home', 'account_quote_modal', 'tie-same',
  'provider-upload-capability.v1', 'fresh', array['step'],
  array['application/step'], true,
  pg_catalog.transaction_timestamp() - interval '1 minute',
  pg_catalog.transaction_timestamp() + interval '1 hour',
  'worker', 'provider_surface', 'worker.v1', 'issue:OVD-513',
  'ovd-513:same-b', 62);
select is((select observation_revision from public.api_resolve_current_capability_observation(
  'xometry', 'provider_upload', 'quote_home', 'account_quote_modal', 'tie-same')),
  62::bigint, 'identical tied-newest payloads select a deterministic exact revision');

select public.api_record_capability_observation(
  'xometry', 'provider_upload', 'quote_home', 'account_quote_modal', 'future',
  'provider-upload-capability.v1', 'fresh', array['step'],
  array['application/step'], true,
  pg_catalog.transaction_timestamp() + interval '1 minute',
  pg_catalog.transaction_timestamp() + interval '2 hours',
  'worker', 'provider_surface', 'worker.v1', 'issue:OVD-513',
  'ovd-513:future', 71);
select ok((select freshness = 'malformed' and observation_revision is null
  from public.api_resolve_current_capability_observation(
    'xometry', 'provider_upload', 'quote_home', 'account_quote_modal', 'future')),
  'within-skew future observation grants no current revision');

select public.api_record_capability_observation(
  'xometry', 'provider_upload', 'quote_home', 'account_quote_modal', 'newest', -- NOSONAR: exact SQL contract and synthetic fixture literals repeat across independent assertions
  'provider-upload-capability.v1', 'fresh', array['step'],
  array['application/step'], true,
  pg_catalog.transaction_timestamp() - interval '2 hours',
  pg_catalog.transaction_timestamp() + interval '1 hour',
  'worker', 'provider_surface', 'worker.v1', 'issue:OVD-513',
  'ovd-513:newest-a', 41);
select public.api_record_capability_observation(
  'xometry', 'provider_upload', 'quote_home', 'account_quote_modal', 'newest',
  'provider-upload-capability.v1', 'provider_error', array[]::text[],
  array[]::text[], null,
  pg_catalog.transaction_timestamp() - interval '1 hour',
  pg_catalog.transaction_timestamp() + interval '1 hour',
  'worker', 'provider_surface', 'worker.v1', 'issue:OVD-513',
  'ovd-513:newest-b', 42);
select is((select observation_state from public.api_resolve_current_capability_observation(
  'xometry', 'provider_upload', 'quote_home', 'account_quote_modal', 'newest')),
  'provider_error', 'newest negative observation takes precedence over older fresh');

select public.api_record_capability_observation(
  'xometry', 'provider_upload', 'quote_home', 'account_quote_modal', 'ambiguous',
  'provider-upload-capability.v1', 'ambiguous', array[]::text[],
  array[]::text[], null,
  pg_catalog.transaction_timestamp() - interval '1 minute',
  pg_catalog.transaction_timestamp() + interval '1 hour',
  'worker', 'provider_surface', 'worker.v1', 'issue:OVD-513',
  'ovd-513:ambiguous', 91);
select ok((select observation_state = 'ambiguous' and freshness = 'ambiguous'
    and observation_revision is null and pg_catalog.cardinality(observed_extensions) = 0
  from public.api_resolve_current_capability_observation(
    'xometry', 'provider_upload', 'quote_home', 'account_quote_modal', 'ambiguous')),
  'persisted ambiguous evidence cannot yield a bindable revision');

select is((select pg_catalog.string_agg(key, ',' order by key)
  from public.api_resolve_current_capability_observation(
    'xometry', 'provider_upload', 'quote_home', 'account_quote_modal', 'v1') r,
    pg_catalog.jsonb_object_keys(pg_catalog.to_jsonb(r)) key),
  'accept_attribute_present,capability,contract_version,expires_at,freshness,observation_revision,observation_state,observed_at,observed_extensions,observed_mime_types,provider,route,surface,surface_revision',
  'resolver has only the reviewed primitive output columns');

select ok((select not (pg_catalog.to_jsonb(r) ? 'evidence_reference')
    and not (pg_catalog.to_jsonb(r) ? 'idempotency_key')
    and not (pg_catalog.to_jsonb(r) ? 'actor_kind')
    and not (pg_catalog.to_jsonb(r) ? 'source_kind')
    and not (pg_catalog.to_jsonb(r) ? 'id')
  from public.api_resolve_current_capability_observation(
    'xometry', 'provider_upload', 'quote_home', 'account_quote_modal', 'v1') r),
  'resolver excludes private evidence, provenance, key, and row id');

reset role;

-- Prove the operational rollback is revoke-only: the wrappers become inert
-- while their already-recorded private history remains unchanged. The outer
-- test transaction restores grants and discards these synthetic rows.
create temporary table ovd513_rollback_count as
  select pg_catalog.count(*)::bigint as retained
  from private.capability_observations;
revoke execute on function public.api_record_capability_observation(
  public.vendor_name, text, text, text, text, text, text, text[], text[],
  boolean, timestamptz, timestamptz, text, text, text, text, text, bigint
) from service_role;
revoke execute on function public.api_resolve_current_capability_observation(
  public.vendor_name, text, text, text, text
) from service_role;

set local role service_role;
select throws_ok($$select public.api_resolve_current_capability_observation(
  'xometry', 'provider_upload', 'quote_home', 'account_quote_modal', 'v1')$$,
  '42501', null, 'revoke-only rollback disables resolver execution');
select throws_ok($$select public.api_record_capability_observation(
  'xometry', 'provider_upload', 'quote_home', 'account_quote_modal', 'v1',
  'provider-upload-capability.v1', 'fresh', array['step'], array['application/step'], true,
  pg_catalog.transaction_timestamp(), pg_catalog.transaction_timestamp() + interval '1 hour',
  'worker', 'provider_surface', 'worker.v1', 'issue:OVD-513', 'ovd-513:rollback', 81)$$,
  '42501', null, 'revoke-only rollback disables record execution');
reset role;

select is((select pg_catalog.count(*)::bigint from private.capability_observations),
  (select retained from ovd513_rollback_count),
  'revoke-only rollback preserves every retained observation');

select * from finish();
rollback;
