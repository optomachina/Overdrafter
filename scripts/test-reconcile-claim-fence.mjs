/** Local only: owned, network-isolated disposable DB, main migrations already applied.
 * Usage: node scripts/test-reconcile-claim-fence.mjs ovd976-round1 /tmp/976-evidence
 * On SQL failure discard this owned container; fixtures commit and disable triggers.
 * Never run these fixtures on a shared stack. No URL or remote-target input.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertAllowedTarget } from './supabase-target-guard.mjs';
import { acceptTap } from './ovd591-sql-qualification.mjs';

const [container, output] = process.argv.slice(2);
assert.match(container ?? '', /^ovd976-[a-z0-9-]+$/);
assert(output, 'evidence output directory required');
assertAllowedTarget('ephemeral');
const info = JSON.parse(execFileSync('docker', ['--host', 'unix:///var/run/docker.sock', 'inspect', container], { encoding: 'utf8' }))[0];
assert.equal(info.Config.Labels?.['ovd976.owner'], 'round1');
assert.equal(info.HostConfig.NetworkMode, 'none');
assert.equal(info.HostConfig.Privileged, false);
assert.equal(info.State.Running, true);
assert.equal(info.Mounts.filter(m => ['bind', 'volume'].includes(m.Type)).length, 0);
assert.equal(Object.keys(info.HostConfig.PortBindings ?? {}).length, 0);
const out = resolve(output);
mkdirSync(out, { recursive: true });
execFileSync('docker', ['--host', 'unix:///var/run/docker.sock', 'exec', container, 'mkdir', '-p', '/tmp/ovd976-sql']);
const archive = execFileSync('tar', ['-cf', '-', '-C', 'supabase', 'migrations', 'rollbacks', 'tests'], { maxBuffer: 32_000_000 });
execFileSync('docker', ['--host', 'unix:///var/run/docker.sock', 'exec', '-i', container, 'tar', '-xf', '-', '-C', '/tmp/ovd976-sql'], { input: archive });
// Catalog proof is collected BEFORE candidate apply, so the PR cannot supply
// its own missing prerequisites. Every expected column/type/function must exist.
const dependencies = JSON.parse(readFileSync('supabase/tests/fixtures/reconcile_claim_fence_dependencies.json', 'utf8'));
const literal = value => "'" + value.replaceAll("'", "''") + "'";
const values = Object.entries(dependencies.relations).flatMap(([table, columns]) =>
  columns.map(column => `(${literal(table)},${literal(column)})`)).join(',');
const list = array => array.map(literal).join(',');
const catalogSql = `select jsonb_build_object(
 'columns',(select jsonb_agg(jsonb_build_object('relation',r,'column',c,'exists',a.attnum is not null,
   'type',pg_catalog.format_type(a.atttypid,a.atttypmod)) order by r,c)
   from (values ${values}) wanted(r,c) left join pg_catalog.pg_attribute a
   on a.attrelid=pg_catalog.to_regclass(r) and a.attname=c and a.attnum>0 and not a.attisdropped),
 'functions',(select jsonb_agg(jsonb_build_object('signature',s,'exists',pg_catalog.to_regprocedure(s) is not null))
   from unnest(array[${list(dependencies.functions)}]) s),
 'types',(select jsonb_agg(jsonb_build_object('name',s,'exists',t.oid is not null,'kind',t.typtype,
   'enumLabels',(select jsonb_agg(enumlabel order by enumsortorder) from pg_catalog.pg_enum where enumtypid=t.oid)))
   from unnest(array[${list([...dependencies.types, ...Object.keys(dependencies.relations)])}]) s
   left join pg_catalog.pg_type t on t.oid=pg_catalog.to_regtype(s)),
 'builtins',(select jsonb_agg(jsonb_build_object('name',s,'exists',exists(select 1 from pg_catalog.pg_proc
   where pronamespace='pg_catalog'::regnamespace and proname=s))) from unnest(array[${list(dependencies.builtins)}]) s),
 'roles',(select jsonb_agg(jsonb_build_object('name',s,'exists',exists(select 1 from pg_catalog.pg_roles where rolname=s)))
   from unnest(array[${list(dependencies.roles)}]) s)
);`;
writeFileSync(`${out}/dependencies.sql`, catalogSql);
const catalog = JSON.parse(execFileSync('docker', ['--host', 'unix:///var/run/docker.sock', 'exec', '-i', container, 'psql', '-X', '-h', '/var/run/postgresql',
  '-p', '5432', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At'], { input: catalogSql, encoding: 'utf8' }));
writeFileSync(`${out}/dependencies-main.json`, JSON.stringify(catalog, null, 2));
for (const [kind, rows] of Object.entries(catalog)) for (const row of rows) {
  assert(row.exists, `missing main prerequisite (${kind}): ${JSON.stringify(row)}`);
}
console.log(`main-only dependencies: PASS (${catalog.columns.length} columns, ${catalog.types.length} types)`);
// The concurrency controller uses the image's socket-only local superuser so
// dblink can connect to local postgres without any credential or password.
const results = [];
for (const suite of ['reconcile_claim_fence_rollback', 'reconcile_claim_fence', 'reconcile_claim_fence_concurrency']) {
  const path = suite.endsWith('_rollback') ? 'rollbacks/tests/reconcile_claim_fence.sql' : `tests/${suite}.sql`;
  const sql = `set search_path=public,extensions,pg_catalog;
set statement_timeout='30s';
set ovd.test_local_fixture='reconcile_claim_fence';
set ovd.test_conninfo='host=/var/run/postgresql port=5432 dbname=postgres user=postgres';
\\i /tmp/ovd976-sql/${path}\n`;
  const r = spawnSync('docker', ['--host', 'unix:///var/run/docker.sock', 'exec', '-i', container, 'psql', '-X', '-h', '/var/run/postgresql',
    '-p', '5432', '-U', suite.endsWith('_concurrency') ? 'supabase_admin' : 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At'],
  { input: sql, encoding: 'utf8', timeout: 120_000, maxBuffer: 8_000_000 });
  writeFileSync(`${out}/${suite}.log`, r.stdout + r.stderr);
  assert.equal(r.status, 0, `${suite} SQL failed; see saved log; discard owned fixture on failure`);
  const assertions = acceptTap(r.stdout);
  results.push({ suite, assertions });
  console.log(`${suite}: PASS (${assertions} assertions)`);
}
writeFileSync(`${out}/sql-results.json`, JSON.stringify({ containerId: info.Id, timestamp: new Date().toISOString(), results }, null, 2));
