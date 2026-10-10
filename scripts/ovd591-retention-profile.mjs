/** Closed retention additions to the existing exclusively owned capability fixture. */
import assert from 'node:assert/strict';
import { ASSERTIONS, GROUPS } from './ovd591-retention-concurrency.mjs';
export const RETENTION_MIGRATION = 'supabase/migrations/20261002133713_add_capability_preparation_retention.sql';
export const RETENTION_TABLES = ['capability_claim_preparations', 'capability_completion_preparations', 'capability_attention_preparations'];
export const RETENTION_RPCS = ['api_prepare_capability_claim(jsonb)', 'api_prepare_capability_completion(jsonb)',
  'api_prepare_capability_attention(jsonb)', 'api_read_prepared_capability_claim(text)',
  'api_read_prepared_capability_completion(text)', 'api_read_prepared_capability_attention(text)',
  'api_list_prepared_capability_claims(text,text,integer)', 'api_list_prepared_capability_attention(text,text,integer)'];
export const RETENTION_BASELINE = 'capability-retention-v1: unchanged capability dependency closure plus the exact preparation retention migration; '
  + 'rollback-only legacy/runtime suites, unchanged standalone preparation fixture, separate nine-category retention concurrency proof. '
  + 'Not full-head auth/storage, old six-race fixture, provider, PostgREST or production-upgrade acceptance.';
export const RETENTION_SUITES = ['capability_observation_ledger', 'capability_observation_rpcs', 'capability_runtime_persistence',
  'capability_preparation_persistence', 'capability_preparation_concurrency'];
export const RETENTION_CATALOG_SQL = `select jsonb_build_object(
 'tables',(select jsonb_agg(jsonb_build_object('name',c.relname,'owner',r.rolname,'rls',c.relrowsecurity,'forced',c.relforcerowsecurity,
 'policies',(select count(*) from pg_policy where polrelid=c.oid),
 'denied',not exists(select 1 from unnest(array['anon','authenticated','service_role']) role_name
 where has_table_privilege(role_name,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))) order by c.relname)
 from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_roles r on r.oid=c.relowner
 where n.nspname='private' and c.relkind='r' and c.relname=any(array[${RETENTION_TABLES.map(value => `'${value}'`).join(',')}])),
 'rpcs',(select jsonb_agg(jsonb_build_object('signature',signature,'exists',p.oid is not null,'owner',r.rolname,
 'definer',p.prosecdef,'fixedSearchPath',p.proconfig @> array['search_path=pg_catalog']::text[],
 'serviceOnly',has_function_privilege('service_role',p.oid,'EXECUTE')
 and not has_function_privilege('anon',p.oid,'EXECUTE') and not has_function_privilege('authenticated',p.oid,'EXECUTE')) order by signature)
 from unnest(array[${RETENTION_RPCS.map(value => `'${value}'`).join(',')}]) signature
 left join pg_proc p on p.oid=to_regprocedure('public.'||signature) left join pg_roles r on r.oid=p.proowner),
 'rpcCount',(select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname=any(array[${RETENTION_RPCS.map(value => `'${value.split('(')[0]}'`).join(',')}])),
 'sequence',(select jsonb_build_object('cache',s.seqcache,'cycle',s.seqcycle,'owner',r.rolname,
 'denied',not exists(select 1 from unnest(array['anon','authenticated','service_role']) role_name
 where has_sequence_privilege(role_name,c.oid,'USAGE,SELECT,UPDATE')))
 from pg_sequence s join pg_class c on c.oid=s.seqrelid join pg_roles r on r.oid=c.relowner
 where s.seqrelid='private.capability_preparation_cursor_seq'::regclass),
 'privateHelpersDenied',not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace,
 unnest(array['anon','authenticated','service_role']) role_name where n.nspname='private' and has_function_privilege(role_name,p.oid,'EXECUTE')),
 'emptyTables',(${RETENTION_TABLES.map(table => `(select count(*) from private.${table})`).join('+')})=0)::text;`;

export function admitRetentionCatalog(value) {
  assert.deepEqual(value.tables.map(row => row.name), [...RETENTION_TABLES].sort());
  for (const row of value.tables) {
    assert.equal(row.owner, 'postgres'); assert.equal(row.rls, true); assert.equal(row.forced, true);
    assert.equal(row.policies, 0); assert.equal(row.denied, true);
  }
  assert.deepEqual(value.rpcs.map(row => row.signature), [...RETENTION_RPCS].sort()); assert.equal(value.rpcCount, 8);
  for (const row of value.rpcs) for (const [key, expected] of Object.entries({ exists: true, owner: 'postgres', definer: true,
    fixedSearchPath: true, serviceOnly: true })) assert.equal(row[key], expected);
  assert.deepEqual(value.sequence, { cache: 1, cycle: false, owner: 'postgres', denied: true });
  assert.equal(value.privateHelpersDenied, true);
  assert.equal(value.emptyTables, true);
}

export function admitRetentionQualification(value, source, containerId) {
  assert.equal(value.status, 'passed'); assert.equal(value.source, source);
  assert.equal(value.containerId, containerId); assert.equal(value.transport, 'psql');
  assert.equal(value.profile, 'retention');
  assert.deepEqual(value.cases.map(item => item.name), RETENTION_SUITES);
  for (const item of value.cases) assert(Number.isSafeInteger(item.assertions) && item.assertions > 0);
  const concurrency = value.cases.at(-1);
  assert.equal(concurrency.assertions, ASSERTIONS); assert.equal(concurrency.subcases, 11);
  assert.deepEqual(concurrency.groups, GROUPS);
  assert.equal(concurrency.transport, 'persistent-psql-unix-socket-v1');
}
