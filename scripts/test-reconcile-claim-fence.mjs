/** Local only: owned disposable DB, main migrations already applied.
 * The operator-provisioned lane requires a network-isolated container.
 * Usage: node scripts/test-reconcile-claim-fence.mjs ovd976-round1 ./private-evidence
 * CI: node scripts/test-reconcile-claim-fence.mjs --ci-local ./private-evidence
 * CI runs only the concurrency suite on the freshly reset local Supabase stack.
 * On SQL failure discard this owned container; fixtures commit and disable triggers.
 * Never run these fixtures on a shared stack. No URL or remote-target input.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { accessSync, chmodSync, constants, cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { assertAllowedTarget } from './supabase-target-guard.mjs';
import { acceptTap } from './ovd591-sql-qualification.mjs';

const [target, output] = process.argv.slice(2);
assert.equal(process.argv.length, 4, 'exactly a local target and private evidence directory required');
const ciLocal = target === '--ci-local';
let container = target;
if (ciLocal) {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'local Supabase mode is CI-only');
  const project = readFileSync('supabase/config.toml', 'utf8').match(/^project_id = "([a-z0-9_-]+)"$/m)?.[1];
  assert(project, 'local Supabase project ID required');
  container = `supabase_db_${project}`;
} else {
  assert.match(container ?? '', /^ovd976-[a-z0-9-]+$/);
}
assert(output, 'evidence output directory required');
assertAllowedTarget('ephemeral');
const docker = '/usr/bin/docker';
const tar = '/usr/bin/tar';
for (const binary of [docker, tar]) accessSync(binary, constants.X_OK);
const info = JSON.parse(execFileSync(docker, ['--host', 'unix:///var/run/docker.sock', 'inspect', container], { encoding: 'utf8' }))[0];
assert.equal(info.Name, `/${container}`);
if (ciLocal) {
  // The existing test job owns this freshly reset CLI stack, including its
  // private Docker network and data volumes. Only the fixed local socket is used.
  assert.equal(info.Config.Labels?.['com.supabase.cli.project'], container.slice('supabase_db_'.length));
  assert(!['host', 'container'].some(mode => info.HostConfig.NetworkMode.startsWith(mode)));
} else {
  assert.equal(info.Config.Labels?.['ovd976.owner'], 'round1');
  assert.equal(info.HostConfig.NetworkMode, 'none');
  assert.equal(info.Mounts.filter(m => ['bind', 'volume'].includes(m.Type)).length, 0);
  assert.equal(Object.keys(info.HostConfig.PortBindings ?? {}).length, 0);
}
assert.equal(info.HostConfig.Privileged, false);
assert.equal(info.State.Running, true);
const out = resolve(output);
mkdirSync(out, { recursive: true, mode: 0o700 });
assert(lstatSync(out).isDirectory() && !lstatSync(out).isSymbolicLink(), 'private evidence directory required');
assert.equal(lstatSync(out).uid, process.getuid(), 'evidence parent must belong to this user');
assert.equal(lstatSync(out).mode & 0o022, 0, 'shared writable evidence parent refused');
chmodSync(out, 0o700);
assert.equal(lstatSync(out).mode & 0o777, 0o700, 'evidence parent must be private');
const stage = mkdtempSync(join(out, 'ovd976-sql-'));
assert.equal(lstatSync(stage).mode & 0o777, 0o700, 'SQL staging must be private');
for (const directory of ['migrations', 'rollbacks', 'tests']) {
  cpSync(join('supabase', directory), join(stage, directory), { recursive: true });
}
const sqlRoot = `/var/lib/postgresql/${basename(stage)}`;
execFileSync(docker, ['--host', 'unix:///var/run/docker.sock', 'exec', container, 'mkdir', '-m', '700', sqlRoot]);
assert.equal(execFileSync(docker, ['--host', 'unix:///var/run/docker.sock', 'exec', container, 'stat', '-c', '%a', sqlRoot], { encoding: 'utf8' }).trim(), '700');
const archive = execFileSync(tar, ['-cf', '-', '-C', stage, 'migrations', 'rollbacks', 'tests'], { maxBuffer: 32_000_000 });
execFileSync(docker, ['--host', 'unix:///var/run/docker.sock', 'exec', '-i', container, 'tar', '-xf', '-', '-C', sqlRoot], { input: archive });
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
const catalog = JSON.parse(execFileSync(docker, ['--host', 'unix:///var/run/docker.sock', 'exec', '-i', container, 'psql', '-X', '-h', '/var/run/postgresql',
  '-p', '5432', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At'], { input: catalogSql, encoding: 'utf8' }));
writeFileSync(`${out}/dependencies-main.json`, JSON.stringify(catalog, null, 2));
for (const [kind, rows] of Object.entries(catalog)) for (const row of rows) {
  assert(row.exists, `missing main prerequisite (${kind}): ${JSON.stringify(row)}`);
}
console.log(`main-only dependencies: PASS (${catalog.columns.length} columns, ${catalog.types.length} types)`);
// The concurrency controller uses the image's socket-only local superuser so
// dblink can connect to local postgres without any credential or password.
const results = [];
const suites = ciLocal ? ['reconcile_claim_fence_concurrency']
  : ['reconcile_claim_fence_rollback', 'reconcile_claim_fence', 'reconcile_claim_fence_concurrency'];
for (const suite of suites) {
  const path = suite.endsWith('_rollback') ? 'rollbacks/tests/reconcile_claim_fence.sql' : `tests/${suite}.sql`;
  const sql = `${ciLocal ? 'create extension if not exists pgtap with schema extensions;\n' : ''}set search_path=public,extensions,pg_catalog;
set statement_timeout='30s';
set ovd.test_local_fixture='reconcile_claim_fence';
set ovd.test_conninfo='host=/var/run/postgresql port=5432 dbname=postgres user=postgres';
\\i ${sqlRoot}/${path}\n`;
  // The CI database owns its synthetic bootstrap password. Keep it inside the
  // container and use it only for the superuser's socket authentication.
  const client = ciLocal ? ['sh', '-eu', '-c', 'export PGPASSWORD="$POSTGRES_PASSWORD"; exec "$@"', 'ovd976-psql', 'psql'] : ['psql'];
  const r = spawnSync(docker, ['--host', 'unix:///var/run/docker.sock', 'exec', '-i', container, ...client, '-X', '-h', '/var/run/postgresql',
    '-p', '5432', '-U', suite.endsWith('_concurrency') ? 'supabase_admin' : 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At'],
  { input: sql, encoding: 'utf8', timeout: 120_000, maxBuffer: 8_000_000 });
  writeFileSync(`${out}/${suite}.log`, r.stdout + r.stderr);
  assert.equal(r.status, 0, `${suite} SQL failed; see saved log; discard owned fixture on failure`);
  const assertions = acceptTap(r.stdout);
  results.push({ suite, assertions });
  console.log(`${suite}: PASS (${assertions} assertions)`);
}
writeFileSync(`${out}/sql-results.json`, JSON.stringify({ containerId: info.Id, timestamp: new Date().toISOString(), results }, null, 2));
