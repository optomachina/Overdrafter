/** Existing GitHub CI only. Owns one disposable database/network; never accepts a target URL. */
import assert from 'node:assert/strict';
import { pullFixtureImage } from './ovd591-image-pull.mjs';
import { SOCKET_CLIENT_ENV } from './ovd591-libpq-environment.mjs';
import { readinessArguments, retainReadinessDiagnostics } from './ovd591-readiness.mjs';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { IMAGE, acceptContainer } from './ovd591-sql-qualification.mjs';
import { RETENTION_MIGRATION, RETENTION_BASELINE, RETENTION_CATALOG_SQL,
  admitRetentionCatalog, admitRetentionQualification } from './ovd591-retention-profile.mjs';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const MIGRATIONS = Object.freeze([
  'supabase/migrations/20260911031500_add_capability_observation_ledger.sql',
  'supabase/migrations/20260927065514_ovd513_capability_record_resolver_rpcs.sql',
  'supabase/migrations/20261002090339_add_atomic_capability_window_attention_persistence.sql',
]);
export const BASELINE = 'capability-only-v1: unchanged canonical ledger, resolver and OVD-591 runtime migrations; '
  + 'source-bound original vendor enum and private-schema prerequisites; pinned-image existing roles. '
  + 'Not full-head, auth/storage application, retention, hosted/PostgREST or production-upgrade acceptance.';
const OWNER = 'ovd591-disposable';
const DATA = '/var/lib/postgresql/data';
const TMPFS = { [DATA]: 'rw,nosuid,size=1536m', '/tmp': 'rw,nosuid,size=256m' };
const PGOPTIONS = '-csearch_path=public,extensions,pg_catalog -ctimezone=UTC -cstatement_timeout=20000';
const LIMIT = 8_000_000;
const sha = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const lines = value => value.trim() ? value.trim().split(/\r?\n/).sort() : [];
const checkId = value => assert.match(value, /^[a-f0-9]{64}$/, 'exact Docker ID required');
const admitProfile = profile => assert(['capability', 'retention', 'free-quote'].includes(profile), 'unknown closed fixture profile');

/** Hash only persisted sanitized bytes. Raw command output remains separate for admission/parsing. */
export function evidenceStore(out, secret = '') {
  const text = (name, value) => {
    const raw = Buffer.isBuffer(value) ? value.toString('utf8') : value;
    const bytes = Buffer.from(secret ? raw.replaceAll(secret, '[redacted-fixture-secret]') : raw);
    const path = join(out, name);
    writeFileSync(path, bytes, { mode: 0o600 });
    return { path, sha256: sha(bytes) };
  };
  return { text, save: (name, value) => text(name, json(value)) };
}

// These exact prerequisite statements are checked against maintained source BEFORE Docker access.
export function baselineInputs(root) {
  const prerequisites = [
    ['supabase/migrations/20260303101500_curated_cnc_quote_platform.sql',
      "create type public.vendor_name as enum ('xometry', 'fictiv', 'protolabs', 'sendcutsend');"],
    ['supabase/migrations/20260303123000_add_admin_membership_management.sql',
      'create schema if not exists private;'],
    ['supabase/migrations/20260303123000_add_admin_membership_management.sql',
      'revoke all on schema private from public, anon, authenticated;'],
    ['supabase/migrations/20260731015213_secure_commercial_admin_operations.sql',
      'grant usage on schema private to service_role;'],
  ].map(([path, statement]) => {
    const bytes = readFileSync(join(root, path));
    assert.equal(bytes.toString().split(statement).length, 2, 'prerequisite statement drift');
    return { path, sourceSha256: sha(bytes), statement, statementSha256: sha(statement) };
  });
  return {
    prerequisites,
    bootstrap: 'begin;\n' + prerequisites.map(input => input.statement).join('\n') + '\ncommit;\n',
    migrations: MIGRATIONS.map(path => { const bytes = readFileSync(join(root, path)); return { path, sha256: sha(bytes), bytes }; }),
  };
}

export function admitEnvironment(env) {
  assert.equal(env.GITHUB_ACTIONS, 'true', 'fixture execution is restricted to existing GitHub CI');
  assert.equal(env.RUNNER_OS, 'Linux');
  assert.match(env.GITHUB_RUN_ID ?? '', /^[1-9]\d{0,19}$/);
  assert.match(env.GITHUB_RUN_ATTEMPT ?? '', /^[1-9]\d{0,5}$/);
  assert.match(env.GITHUB_SHA ?? '', /^[a-f0-9]{40}$/);
  assert(isAbsolute(env.RUNNER_TEMP ?? ''), 'absolute existing runner temp required');
  return `ovd591-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`;
}

export function admitImage(info) {
  assert.match(info.Id, /^sha256:[a-f0-9]{64}$/);
  assert.equal(info.Os, 'linux');
  assert.equal(info.Architecture, 'amd64');
  assert.deepEqual((info.Config.Env ?? []).filter(value => value.startsWith('PGDATA=')), [`PGDATA=${DATA}`]);
  assert((info.Config.Entrypoint ?? []).length > 0, 'image initialization entrypoint required');
  assert(Object.keys(info.Config.Volumes ?? {}).every(path => path === DATA), 'unreviewed image volume path');
  return { id: info.Id, os: info.Os, architecture: info.Architecture,
    volumes: Object.keys(info.Config.Volumes ?? {}), dataDirectory: DATA,
    entrypointSha256: sha(json(info.Config.Entrypoint)), commandSha256: sha(json(info.Config.Cmd)) };
}

export const PREFLIGHT_SQL = `select jsonb_build_object(
 'database',current_database(),'sessionUser',session_user,'currentUser',current_user,
 'serverAddress',inet_server_addr(),'clientAddress',inet_client_addr(),
 'version',current_setting('server_version_num'),
 'extensionsSchema',to_regnamespace('extensions') is not null,
 'pgtapAvailable',exists(select 1 from pg_available_extensions where name='pgtap'),
 'emptyBaseline',to_regtype('public.vendor_name') is null and to_regnamespace('private') is null,
 'roles',(select jsonb_agg(jsonb_build_object('name',rolname,'super',rolsuper,'bypass',rolbypassrls,'createRole',rolcreaterole) order by rolname)
 from pg_roles where rolname in ('postgres','anon','authenticated','service_role')))::text;`;

export function admitPreflight(value) {
  assert.equal(value.database, 'postgres');
  assert.equal(value.sessionUser, 'postgres');
  assert.equal(value.currentUser, 'postgres');
  assert.equal(value.serverAddress, null); assert.equal(value.clientAddress, null);
  assert.equal(value.version, '170006');
  for (const key of ['extensionsSchema', 'pgtapAvailable', 'emptyBaseline']) assert.equal(value[key], true, key);
  assert.deepEqual(value.roles.map(row => row.name), ['anon', 'authenticated', 'postgres', 'service_role']);
  for (const role of value.roles) {
    assert.equal(role.super, false, 'no substituted superuser role');
    if (['anon', 'authenticated'].includes(role.name)) { assert.equal(role.bypass, false); assert.equal(role.createRole, false); }
    if (role.name === 'service_role') assert.equal(role.bypass, true);
  }
}

export const TABLES = Object.freeze(['capability_observations', 'capability_runtime_revisions', 'capability_runtime_windows',
  'capability_attention_state', 'capability_attention_outbox', 'capability_attention_evaluations'].sort());
export const RPCS = Object.freeze([
  'api_record_capability_observation(public.vendor_name,text,text,text,text,text,text,text[],text[],boolean,timestamp with time zone,timestamp with time zone,text,text,text,text,text,bigint)',
  'api_resolve_current_capability_observation(public.vendor_name,text,text,text,text)',
  'api_claim_capability_window(jsonb)', 'api_complete_capability_window(jsonb)', 'api_commit_capability_attention(jsonb)',
  'api_get_capability_window(text,uuid)', 'api_read_capability_attention(text)', 'api_list_due_capability_attention(integer)',
]);
export const CATALOG_SQL = `select jsonb_build_object(
 'tables',(select jsonb_agg(jsonb_build_object('name',c.relname,'owner',r.rolname,'rls',c.relrowsecurity,'forced',c.relforcerowsecurity,
 'policies',(select count(*) from pg_policy where polrelid=c.oid),
 'denied',not exists(select 1 from unnest(array['anon','authenticated','service_role']) role_name
 where has_table_privilege(role_name,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))) order by c.relname)
 from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_roles r on r.oid=c.relowner
 where n.nspname='private' and c.relkind='r'),
 'rpcs',(select jsonb_agg(jsonb_build_object('signature',signature,'exists',p.oid is not null,'owner',r.rolname,
 'definer',p.prosecdef,'fixedSearchPath',p.proconfig @> array['search_path=pg_catalog']::text[],
 'serviceOnly',has_function_privilege('service_role',p.oid,'EXECUTE')
 and not has_function_privilege('anon',p.oid,'EXECUTE') and not has_function_privilege('authenticated',p.oid,'EXECUTE')) order by signature)
 from unnest(array[${RPCS.map(value => `'${value}'`).join(',')}]) signature
 left join pg_proc p on p.oid=to_regprocedure('public.'||signature) left join pg_roles r on r.oid=p.proowner),
 'rpcCount',(select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname=any(array[${RPCS.map(value => `'${value.split('(')[0]}'`).join(',')}])),
 'privateHelpersDenied',not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace,
 unnest(array['anon','authenticated','service_role']) role_name where n.nspname='private' and has_function_privilege(role_name,p.oid,'EXECUTE')),
 'emptyTables',(${TABLES.map(table => `(select count(*) from private.${table})`).join('+')})=0)::text;`;

export function admitCatalog(value) {
  assert.deepEqual(value.tables.map(row => row.name), TABLES);
  for (const row of value.tables) {
    assert.equal(row.owner, 'postgres'); assert.equal(row.rls, true); assert.equal(row.forced, true);
    assert.equal(row.policies, 0); assert.equal(row.denied, true);
  }
  assert.deepEqual(value.rpcs.map(row => row.signature), [...RPCS].sort());
  assert.equal(value.rpcCount, RPCS.length);
  for (const row of value.rpcs) {
    assert.equal(row.exists, true); assert.equal(row.owner, 'postgres');
    assert.equal(row.definer, true); assert.equal(row.fixedSearchPath, true); assert.equal(row.serviceOnly, true);
  }
  assert.equal(value.privateHelpersDenied, true); assert.equal(value.emptyTables, true);
}

/** Bounded subprocess; captures output without echoing argv, environment or raw exceptions. */
export function execute(command, args, { input, cwd, timeout = 30_000, signal } = {}) {
  return new Promise(resolveResult => {
    if (signal?.aborted) return resolveResult({ status: null, stdout: '', stderr: '', failure: 'aborted' });
    const group = process.platform !== 'win32';
    const child = spawn(command, args, { cwd, detached: group, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', size = 0, failure = null;
    const stop = reason => {
      failure ??= reason;
      try { if (group && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); }
      catch { /* Already exited; the close receipt still decides completion. */ }
    };
    const timer = setTimeout(() => stop('timeout'), timeout);
    const abort = () => stop('aborted');
    signal?.addEventListener('abort', abort, { once: true });
    const capture = channel => data => {
      size += Buffer.byteLength(data);
      if (size > LIMIT) return stop('output_limit');
      if (channel === 'stdout') stdout += data.toString(); else stderr += data.toString();
    };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', capture('stdout')); child.stderr.on('data', capture('stderr'));
    child.on('error', () => { failure = 'spawn_failed'; });
    child.stdin.on('error', () => { /* Exit status/acknowledgment remains authoritative. */ });
    child.on('close', status => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      resolveResult({ status, stdout, stderr, failure });
    });
    child.stdin.end(input);
  });
}

export function createArguments(state, envPath) {
  return ['create', '--name', state.containerName, '--network', state.profile === 'free-quote' ? 'none' : state.networkId,
    ...(state.profile === 'free-quote' ? ['--dns', '127.0.0.1'] : []),
    '--label', `ovd591.owner=${OWNER}`, '--label', `ovd591.source=${state.source}`, '--label', `ovd591.fixture=${state.token}`,
    '--cpus', '2', '--memory', '3g', '--pids-limit', '256', '--security-opt', 'no-new-privileges',
    ...Object.entries(TMPFS).flatMap(([path, options]) => ['--tmpfs', `${path}:${options}`]),
    '--env-file', envPath, IMAGE];
}
const inventoryCommands = { containers: ['container', 'ls', '-aq', '--no-trunc'],
  networks: ['network', 'ls', '-q', '--no-trunc'], volumes: ['volume', 'ls', '-q'] };

function makeCommands({ root, out, exec, signal, deadline, secret = '' }) {
  let sequence = 0, total = 0;
  const evidence = evidenceStore(out, secret);
  return async (command, args, options = {}) => {
    const remaining = deadline - Date.now();
    assert(remaining > 0, 'fixture deadline exceeded');
    const result = await exec(command, args, { cwd: root, input: options.input,
      timeout: Math.min(options.timeout ?? 30_000, remaining), signal: options.cleanup ? undefined : signal });
    // Inspection may include the owned container's generated secret. Never retain its raw JSON.
    if (!options.private) {
      total += Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);
      assert(total <= 64_000_000, 'fixture evidence limit exceeded');
      const name = `${String(++sequence).padStart(3, '0')}-${options.label ?? command}`;
      evidence.text(`${name}.stdout`, result.stdout);
      evidence.text(`${name}.stderr`, result.stderr);
      evidence.save(`${name}.json`, { status: result.status, failure: result.failure ?? null });
    }
    if (!options.allowFailure) assert(!result.failure && result.status === 0, `${options.label ?? command} command failed`);
    return result;
  };
}

async function inventory(call, cleanup = false) {
  const result = {};
  for (const [kind, args] of Object.entries(inventoryCommands)) {
    result[kind] = lines((await call('docker', args, { label: `inventory-${kind}`, cleanup })).stdout);
  }
  return result;
}
function validateOwned(info, state, kind) {
  checkId(info.Id);
  const labels = kind === 'container' ? info.Config.Labels : info.Labels;
  assert.equal(labels?.['ovd591.owner'], OWNER); assert.equal(labels?.['ovd591.source'], state.source);
  assert.equal(labels?.['ovd591.fixture'], state.token);
  assert.equal(info.Name, (kind === 'container' ? '/' : '') + state[`${kind}Name`]);
  if (state[`${kind}Id`]) assert.equal(info.Id, state[`${kind}Id`]);
  assert(!state.before[kind === 'container' ? 'containers' : 'networks'].includes(info.Id), 'preexisting resource');
}

function removeSecret(state, out) {
  if (!state.secretFile) return;
  const path = join(dirname(out), `${state.containerName}.env`);
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.ino === state.secretFile.ino && stat.dev === state.secretFile.dev,
    'fixture secret file identity changed');
  rmSync(path);
}

export async function cleanupFixture({ root, out, state, exec = execute, secret = '' }) {
  const attempt = `cleanup-${randomUUID()}`;
  const evidence = join(out, attempt); mkdirSync(evidence, { mode: 0o700 });
  const call = makeCommands({ root, out: evidence, exec, deadline: Date.now() + 120_000, secret });
  const receipt = { status: 'running', evidence: attempt, resources: {}, before: state.before, after: null };
  try {
    removeSecret(state, out);
    // Sequential stopped image-extraction containers share this fixture owner.
    // Reconcile any interrupted extraction before removing its database.
    for (const child of state.platformSources ?? []) {
      assert.equal(state.profile, 'free-quote');
      const kind = child.containerName === `${state.containerName}-auth` ? 'auth' : 'storage';
      assert.equal(child.containerName, `${state.containerName}-${kind}`);
      assert.equal(child.out, join(out, `${kind}-extraction`));
      assert.equal(child.source, state.source); assert.equal(child.token, state.token);
      assert.equal(child.profile, 'free-quote-platform'); assert.equal(child.networkAttempted, false);
      if (!child.cleaned) {
        await cleanupFixture({ root, out: child.out, state: child, exec, secret });
        child.cleaned = true;
        evidenceStore(out, secret).save('owned-state.json', state);
      }
    }
    for (const kind of ['container', 'network']) {
      if (!state[`${kind}Attempted`]) { receipt.resources[kind] = 'not_created'; continue; }
      const listing = await inventory(call, true);
      const id = state[`${kind}Id`];
      const list = listing[kind === 'container' ? 'containers' : 'networks'];
      // Resolve a lost creation acknowledgment only by our unique name and all three labels.
      if (id && !list.includes(id)) { receipt.resources[kind] = 'observed_absent'; continue; }
      const args = kind === 'container' ? ['inspect', state.containerName] : ['network', 'inspect', state.networkName];
      const inspected = await call('docker', args, { cleanup: true, private: true, allowFailure: true });
      if (inspected.status !== 0 || inspected.failure) {
        assert(id, 'creation acknowledgment uncertain; absence not proven');
        throw new Error('owned resource inspection failed');
      }
      const info = JSON.parse(inspected.stdout)[0]; validateOwned(info, state, kind);
      if (kind === 'network') assert.equal(Object.keys(info.Containers ?? {}).length, 0, 'network has attached resource');
      await call('docker', kind === 'container' ? ['rm', '--force', info.Id] : ['network', 'rm', info.Id],
        { cleanup: true, label: `remove-${kind}` });
      const after = await inventory(call, true);
      assert(!after[kind === 'container' ? 'containers' : 'networks'].includes(info.Id), 'owned resource remains');
      receipt.resources[kind] = 'removed_and_observed_absent';
    }
    receipt.after = await inventory(call, true);
    assert.deepEqual(receipt.after, state.before, 'unrelated Docker inventory changed');
    receipt.status = 'passed';
  } catch {
    // Malformed inspect JSON can mention an environment-value fragment. Never echo it.
    receipt.status = 'failed'; receipt.failure = 'owned_cleanup_or_inventory_unconfirmed';
  }
  evidenceStore(evidence, secret).save('result.json', receipt); evidenceStore(out, secret).save('cleanup.json', receipt);
  assert.equal(receipt.status, 'passed', 'owned cleanup/inventory unconfirmed');
  return receipt;
}

function admitOutput(root, out, env, fresh) {
  const temp = realpathSync(env.RUNNER_TEMP);
  assert(isAbsolute(out) && resolve(out) === out);
  assert(realpathSync(dirname(out)).startsWith(temp + sep) || realpathSync(dirname(out)) === temp);
  const source = realpathSync(root);
  assert(!out.startsWith(source + sep), 'evidence must stay outside checkout');
  if (fresh) mkdirSync(out, { mode: 0o700 });
  const stat = lstatSync(out); assert(stat.isDirectory() && !stat.isSymbolicLink());
  chmodSync(out, 0o700);
}

export async function runCiFixture({ root = ROOT, out, env = process.env, signal, profile = 'capability' }, { exec = execute } = {}) {
  admitProfile(profile);
  const prefix = admitEnvironment(env) + (profile === 'capability' ? '' : `-${profile}`); admitOutput(root, out, env, true);
  const free = profile === 'free-quote' ? await import('./free-quote-ci-profile.mjs') : null;
  const inputs = free ? free.loadFreeQuoteInputs(root) : baselineInputs(root);
  const retentionBytes = profile === 'retention' ? readFileSync(join(root, RETENTION_MIGRATION)) : null;
  const baseline = free ? free.FREE_BASELINE : profile === 'retention' ? RETENTION_BASELINE : BASELINE;
  const secret = randomBytes(32).toString('hex');
  const evidence = evidenceStore(out, secret);
  const deadline = Date.now() + 25 * 60_000;
  const call = makeCommands({ root, out, exec, signal, deadline, secret });
  const state = { schemaVersion: 1, profile, token: randomUUID(), source: null, before: null, containerId: null, networkId: null,
    containerAttempted: false, networkAttempted: false };
  state.containerName = `${prefix}-${state.token.slice(0, 8)}`; state.networkName = `${state.containerName}-net`;
  const envPath = join(out, '../', `${state.containerName}.env`);
  const result = { status: 'running', stage: 'source', profile, baselineSelection: baseline, startedAt: new Date().toISOString() };
  const persist = () => { evidence.save('owned-state.json', state); evidence.save('fixture-result.json', result); };
  try {
    state.source = (await call('git', ['rev-parse', 'HEAD'])).stdout.trim();
    assert.equal(state.source, env.GITHUB_SHA, 'checkout differs from workflow SHA');
    assert.equal((await call('git', ['status', '--porcelain'])).stdout.trim(), '', 'clean committed source required');
    state.before = await inventory(call); persist();
    result.stage = 'image';
    await pullFixtureImage({ call, image: IMAGE, label: 'image-pull', signal, deadline,
      save: receipt => evidence.save('image-pull-attempts.json', receipt) });
    const imageInfo = JSON.parse((await call('docker', ['image', 'inspect', IMAGE], { private: true })).stdout)[0];
    result.image = admitImage(imageInfo); persist();
    // Check names are absent before recording an attempted creation. Never adopt an existing resource.
    for (const kind of ['container', 'network']) {
      const names = lines((await call('docker', kind === 'container'
        ? ['container', 'ls', '-a', '--format', '{{.Names}}'] : ['network', 'ls', '--format', '{{.Name}}'])).stdout);
      assert(!names.includes(state[`${kind}Name`]), 'fixture name collision');
    }
    if (!free) {
    result.stage = 'network'; state.networkAttempted = true; persist();
    state.networkId = (await call('docker', ['network', 'create', '--driver', 'bridge', '--internal',
      '--label', `ovd591.owner=${OWNER}`, '--label', `ovd591.source=${state.source}`, '--label', `ovd591.fixture=${state.token}`,
      state.networkName], { label: 'network-create' })).stdout.trim();
    checkId(state.networkId); persist();
    const network = JSON.parse((await call('docker', ['network', 'inspect', state.networkId], { private: true })).stdout)[0];
    validateOwned(network, state, 'network'); assert.equal(network.Internal, true);
    assert.equal(Object.keys(network.Containers ?? {}).length, 0);
    }
    result.stage = 'container';
    writeFileSync(envPath, `POSTGRES_PASSWORD=${secret}\n`, { mode: 0o600, flag: 'wx' });
    const secretStat = lstatSync(envPath); state.secretFile = { ino: secretStat.ino, dev: secretStat.dev };
    state.containerAttempted = true; persist();
    state.containerId = (await call('docker', createArguments(state, envPath), { label: 'container-create' })).stdout.trim();
    checkId(state.containerId); persist(); removeSecret(state, out);
    await call('docker', ['start', state.containerId], { label: 'container-start' });
    const info = JSON.parse((await call('docker', ['inspect', state.containerId], { private: true })).stdout)[0];
    validateOwned(info, state, 'container'); acceptContainer(info, state.source);
    assert.equal(info.Image, result.image.id); assert.deepEqual(info.HostConfig.Tmpfs, TMPFS);
    if (free) {
      assert.equal(info.HostConfig.NetworkMode, 'none'); assert.deepEqual(info.HostConfig.Dns, ['127.0.0.1']);
      assert.equal((info.HostConfig.CapAdd ?? []).length, 0); assert.equal((info.HostConfig.Devices ?? []).length, 0);
      for (const key of ['PidMode', 'IpcMode', 'UTSMode', 'UsernsMode']) assert.notEqual(info.HostConfig[key], 'host');
    } else assert.deepEqual(Object.values(info.NetworkSettings.Networks).map(value => value.NetworkID), [state.networkId]);
    assert.equal(info.HostConfig.RestartPolicy?.Name, 'no');
    evidence.save('resource-admission.json', { containerId: info.Id, imageId: info.Image, networkId: state.networkId,
      tmpfs: info.HostConfig.Tmpfs, cpus: info.HostConfig.NanoCpus, memory: info.HostConfig.Memory,
      pids: info.HostConfig.PidsLimit, mounts: info.Mounts, ports: info.HostConfig.PortBindings });
    result.stage = 'readiness'; persist();
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      // Require the final PID1 postmaster, actual packaged executable, data path
      // and Unix socket. Nix's wrapper makes the process comm name unreliable.
      const check = await call('docker', readinessArguments(state.containerId),
      { label: 'readiness', timeout: 3000, allowFailure: true });
      if (!check.failure && check.status === 0 && check.stdout.trim() === 'final-postmaster-ready') { ready = true; break; }
      if (signal?.aborted) throw new Error('fixture cancelled');
      await delay(500);
    }
    if (!ready) await retainReadinessDiagnostics(call, state.containerId);
    assert(ready, 'final postmaster/data path readiness failed');
    const psql = async (sql, label, role = 'postgres') => {
      assert(['postgres', 'supabase_admin'].includes(role));
      return call('docker', ['exec', '-i', '-e', `PGOPTIONS=${PGOPTIONS}`, state.containerId,
      ...(free ? SOCKET_CLIENT_ENV : []), 'psql', '-U', role, '-d', 'postgres', '-w', '-X', '-Atq', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose'],
    { input: sql, label, timeout: 60_000 });
    };
    const preflight = await psql(PREFLIGHT_SQL, 'platform-preflight'); admitPreflight(JSON.parse(preflight.stdout));
    if (free) {
      result.stage = 'full-platform-extraction'; persist();
      evidence.save('free-quote-source-inputs.json', inputs.manifest);
      const { extractPlatformSources } = await import('./free-quote-platform-sources.mjs');
      const platformSources = await extractPlatformSources({ root, out, state, inputs, call, signal, deadline,
        inventory: () => inventory(call), cleanup: options => cleanupFixture({ ...options, exec, secret }), persist, evidence });
      result.stage = 'full-free-qualification'; persist();
      result.qualification = await free.qualifyFreeQuote({ root, out, container: state.containerName, source: state.source,
        inputs, platformSources, psql, evidence, signal });
      const finalInputs = free.loadFreeQuoteInputs(root);
      assert.equal(finalInputs.sourceManifestSha256, inputs.sourceManifestSha256, 'source manifest changed during qualification');
    } else {
    evidence.save('bootstrap-inputs.json', inputs.prerequisites);
    result.stage = 'migrations'; persist();
    const migrationLog = [];
    const bootstrap = await psql(inputs.bootstrap, 'bootstrap');
    migrationLog.push(`bootstrap ${sha(inputs.bootstrap)}\n${bootstrap.stdout}\n${bootstrap.stderr}`);
    const appliedInputs = [];
    for (const entry of inputs.migrations) {
      const run = await psql(entry.bytes, `migration-${entry.path.split('/').at(-1).slice(0, 14)}`);
      migrationLog.push(`${entry.path} ${entry.sha256}\n${run.stdout}\n${run.stderr}`);
      appliedInputs.push({ path: entry.path, sha256: entry.sha256 });
      evidence.save('applied-inputs.json', appliedInputs);
    }
    let migrationEvidence = evidence.text('migration.log', migrationLog.join('\n'));
    result.stage = 'catalog'; persist();
    const catalog = await psql(CATALOG_SQL, 'catalog'); admitCatalog(JSON.parse(catalog.stdout));
    const catalogLog = [catalog.stdout + catalog.stderr];
    if (profile === 'retention') {
      // The default closed catalog still expects exactly six private tables. Admit
      // that unchanged dependency closure before adding the three retention tables.
      result.stage = 'retention-migration'; persist();
      const run = await psql(retentionBytes, 'retention-migration');
      const sha256 = sha(retentionBytes);
      migrationLog.push(`${RETENTION_MIGRATION} ${sha256}\n${run.stdout}\n${run.stderr}`);
      migrationEvidence = evidence.text('migration.log', migrationLog.join('\n'));
      appliedInputs.push({ path: RETENTION_MIGRATION, sha256 });
      evidence.save('applied-inputs.json', appliedInputs);
      result.stage = 'retention-catalog'; persist();
      const retained = await psql(RETENTION_CATALOG_SQL, 'retention-catalog'); admitRetentionCatalog(JSON.parse(retained.stdout));
      catalogLog.push(retained.stdout + retained.stderr);
    }
    const catalogEvidence = evidence.text('catalog.log', catalogLog.join('\n'));
    const provisioning = { source: state.source, containerId: state.containerId, imageId: result.image.id,
      migrationVerdict: 'passed', catalogVerdict: 'passed', baselineSelection: baseline, appliedInputs,
      prerequisites: inputs.prerequisites, evidence: { migration: migrationEvidence, catalog: catalogEvidence } };
    evidence.save('provisioning.json', provisioning);
    result.stage = 'qualification'; persist();
    const qualifier = profile === 'retention' ? 'scripts/ovd591-retention-qualification.mjs' : 'scripts/ovd591-sql-qualification.mjs';
    await call(process.execPath, [qualifier, state.containerName,
      join(out, 'qualification'), join(out, 'provisioning.json'), '--concurrency=psql'], { label: 'qualification', timeout: 600_000 });
    const qualified = JSON.parse(readFileSync(join(out, 'qualification/result.json')));
    if (profile === 'retention') admitRetentionQualification(qualified, state.source, state.containerId);
    else {
      assert.equal(qualified.status, 'passed'); assert.equal(qualified.source, state.source);
      assert.equal(qualified.containerId, state.containerId); assert.equal(qualified.transport, 'psql');
      assert.deepEqual(qualified.cases.map(value => value.name), ['capability_observation_ledger', 'capability_observation_rpcs',
        'capability_runtime_persistence', 'capability_runtime_persistence_concurrency']);
      assert.equal(qualified.cases.at(-1).assertions, 28);
      assert.equal(qualified.cases.at(-1).transport, 'persistent-psql-unix-socket-v1');
    }
    }
    result.stage = 'backend-cleanup'; persist();
    const backends = await psql("select coalesce(jsonb_agg(pid order by pid),'[]'::jsonb) from pg_stat_activity where datname=current_database() and backend_type='client backend' and pid<>pg_backend_pid();", 'remaining-backends');
    assert.deepEqual(JSON.parse(backends.stdout), [], 'qualification left live client backends');
    assert.equal((await call('git', ['rev-parse', 'HEAD'])).stdout.trim(), state.source);
    assert.equal((await call('git', ['status', '--porcelain'])).stdout.trim(), '');
    result.status = 'passed';
  } catch (error) {
    result.status = 'failed'; result.failure = error instanceof SyntaxError ? 'invalid_structured_receipt'
      : String(error.message).replaceAll(secret, '[redacted-fixture-secret]').slice(0, 300);
  }
  finally {
    // Only this invocation's generated secret file; never part of uploaded evidence.
    try { removeSecret(state, out); } catch { result.status = 'failed'; result.secretCleanupFailed = true; }
    if (state.before) {
      try { await cleanupFixture({ root, out, state, exec, secret }); } catch { result.status = 'failed'; result.cleanupFailed = true; }
    }
    result.finishedAt = new Date().toISOString(); persist();
  }
  assert.equal(result.status, 'passed', `fixture failed at ${result.stage}`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const abort = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => abort.abort());
  try {
    const [mode, out] = process.argv.slice(2); assert.equal(process.argv.length, 4);
    admitEnvironment(process.env);
    if (mode === 'run' || mode === 'run-retention' || mode === 'run-free-quote') await runCiFixture({ out, signal: abort.signal,
      profile: mode === 'run-free-quote' ? 'free-quote' : mode === 'run-retention' ? 'retention' : 'capability' });
    else {
      assert.equal(mode, 'cleanup'); admitOutput(ROOT, out, process.env, false);
      const state = JSON.parse(readFileSync(join(out, 'owned-state.json')));
      assert.equal(state.source, process.env.GITHUB_SHA); assert.match(state.token, /^[a-f0-9-]{36}$/);
      const profile = state.profile ?? 'capability'; admitProfile(profile);
      assert.equal(state.containerName, `${admitEnvironment(process.env)}${profile === 'capability' ? '' : `-${profile}`}-${state.token.slice(0, 8)}`);
      assert.equal(state.networkName, `${state.containerName}-net`);
      if (state.before) await cleanupFixture({ root: ROOT, out, state });
    }
  } catch { console.error('OVD-591 CI fixture failed; inspect retained synthetic receipts.'); process.exitCode = 1; }
}
