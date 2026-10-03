import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { acceptTap, acceptContainer, IMAGE, FIXTURE_PASSWORD_SESSION } from './ovd591-sql-qualification.mjs';
test('fixture-only password delivery preserves arbitrary bytes without shell evaluation or argv injection', () => {
  const password = 'synthetic space \' " \\ $HOME $(exit 99)\n\t+/=unicode-é';
  const child = spawnSync('sh', ['-c', FIXTURE_PASSWORD_SESSION, 'fixture-test', process.execPath,
    '-e', 'process.stdout.write(process.env.PGOPTIONS)'], {
    encoding: 'utf8', env: { PATH: process.env.PATH, PGOPTIONS: '-ctimezone=UTC', POSTGRES_PASSWORD: password },
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, '');
  assert.equal(child.stdout, `-ctimezone=UTC -covd591.fixture_password_b64=${Buffer.from(password).toString('base64')}`);
  assert(!FIXTURE_PASSWORD_SESSION.includes(password));
});
test('missing fixture password stops before executing the supplied command', () => {
  const child = spawnSync('sh', ['-c', FIXTURE_PASSWORD_SESSION, 'fixture-test', 'echo', 'must not execute'], {
    encoding: 'utf8', env: { PATH: process.env.PATH, PGOPTIONS: '-ctimezone=UTC' },
  });
  assert.equal(child.status, 2);
  assert.equal(child.stdout, '');
  assert.equal(child.stderr, 'fixture password missing\n');
});
test('SQL output requires complete unskipped passing TAP, not process exit alone', () => {
  assert.equal(acceptTap('1..2\nok 1 - a\nok 2 - b\n'), 2);
  for (const output of ['', '1..0 # SKIP unavailable', '1..2\nok 1', '1..1\nnot ok 1',
    '1..1\nok 1 # TODO', '1..1\nok 1 # SKIP', '1..1\nok 2', '1..1\nok 1\nBail out!',
    '1..1\nok 1\n1..1']) assert.throws(() => acceptTap(output));
});
test('fixture targeting rejects foreign source, exposed, mounted, stopped or privileged container', () => {
  const info = {Name:'/ovd591-test',Config:{Image:IMAGE,Labels:{'ovd591.owner':'ovd591-disposable','ovd591.source':'abc'}},
    State:{Running:true},HostConfig:{NanoCpus:2_000_000_000,Memory:3*1024**3,PidsLimit:256,Privileged:false,NetworkMode:'ovd591-test',PortBindings:{}},Mounts:[]};
  acceptContainer(info,'abc');
  const bad = [v=>v.Config.Labels['ovd591.source']='other',v=>v.Config.Labels['ovd591.owner']='other',
    v=>v.Config.Image='postgres:latest',v=>v.Name='/production',v=>v.State.Running=false,
    v=>v.HostConfig.Memory=0,v=>v.HostConfig.NanoCpus=0,v=>v.HostConfig.PidsLimit=-1,v=>v.HostConfig.Privileged=true,v=>v.HostConfig.NetworkMode='host',
    v=>v.HostConfig.PortBindings={'5432/tcp':[]},v=>v.Mounts=[{Type:'bind'}]];
  for(const mutate of bad){const v=structuredClone(info);mutate(v);assert.throws(()=>acceptContainer(v,'abc'));}
});

// Source-only filesystem fixtures. None of these admission tests invokes Docker or SQL.
import { chmodSync, cpSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { baselineInputs } from './ovd591-ci-fixture.mjs';
import { RETENTION_BASELINE } from './ovd591-retention-profile.mjs';
import { admitQualificationPaths, admitSourceInputs, sha256 } from './ovd591-qualification-paths.mjs';

function pathFixture(t) {
  const base = mkdtempSync(join(realpathSync(tmpdir()), 'ovd591-paths-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'source'), runnerTemp = join(base, 'runner'), fixture = join(runnerTemp, 'fixture');
  for (const path of [root, runnerTemp, fixture]) mkdirSync(path, { mode: 0o700 });
  const provisioningPath = join(fixture, 'provisioning.json'), destination = join(fixture, 'qualification');
  const evidence = {};
  for (const kind of ['migration', 'catalog']) {
    const bytes = Buffer.from(`${kind}: synthetic raw bytes\n`), path = join(fixture, `${kind}.log`);
    writeFileSync(path, bytes, { mode: 0o600 }); evidence[kind] = { path, sha256: sha256(bytes) };
  }
  const provisioning = { evidence };
  const save = () => writeFileSync(provisioningPath, JSON.stringify(provisioning), { mode: 0o600 });
  save();
  return { base, root, runnerTemp, fixture, provisioningPath, destination, provisioning, save,
    options: { root, runnerTemp, provisioningPath, destination } };
}

test('qualifier admits owned CI paths and retains receipt-relative provenance and exact evidence bytes', t => {
  const f = pathFixture(t);
  // CI absolute paths and standalone receipt-relative paths obey the same boundary.
  f.provisioning.evidence.catalog.path = 'catalog.log'; f.save();
  const admitted = admitQualificationPaths(f.options);
  const output = admitted.createOutput();
  output.write('migration-provisioning-evidence.log', admitted.evidence.migration.bytes);
  output.write('result.json', 'first'); output.write('result.json', 'second');
  output.write('capability_observation_ledger.stdout', '1..1\nok 1\n');
  output.write('capability_observation_ledger.stderr', '');
  assert.equal(lstatSync(f.destination).mode & 0o777, 0o700);
  assert.equal(lstatSync(join(f.destination, 'result.json')).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(f.destination, 'result.json'), 'utf8'), 'second');
  assert.deepEqual(readFileSync(join(f.destination, 'migration-provisioning-evidence.log')), admitted.evidence.migration.bytes);
  assert.equal(admitted.provenance.evidence.catalog.relativePath, 'catalog.log');
  assert.equal(admitted.provenance.evidence.catalog.path, join(f.fixture, 'catalog.log'));
  assert.equal(admitted.provenance.uid, process.getuid());
  assert.equal(admitted.provenance.outputIdentity.ino, lstatSync(f.destination).ino);
});

for (const [name, mutate] of [
  ['missing runner root', f => { f.options.runnerTemp = join(f.base, 'absent'); }],
  ['relative runner root', f => { f.options.runnerTemp = 'runner'; }],
  ['group-writable runner root', f => chmodSync(f.runnerTemp, 0o770)],
  ['nonprivate fixture directory', f => chmodSync(f.fixture, 0o755)],
  ['evidence root inside checkout', f => { f.options.root = f.base; }],
  ['output outside fixture', f => { f.options.destination = join(f.base, 'foreign-output'); }],
  ['receipt outside runner boundary', f => { f.options.provisioningPath = join(f.base, 'foreign.json'); }],
  ['existing output directory', f => mkdirSync(f.destination)],
  ['dangling output symlink', f => symlinkSync(join(f.base, 'absent'), f.destination)],
  ['symlink runner root', f => { const path = join(f.base, 'runner-link'); symlinkSync(f.runnerTemp, path); f.options.runnerTemp = path; }],
  ['symlink receipt', f => { const path = join(f.fixture, 'linked.json'); symlinkSync(f.provisioningPath, path); f.options.provisioningPath = path; }],
  ['hardlinked receipt', f => linkSync(f.provisioningPath, join(f.fixture, 'copy.json'))],
  ['nonregular receipt', f => { rmSync(f.provisioningPath); mkdirSync(f.provisioningPath); }],
  ['writable receipt', f => chmodSync(f.provisioningPath, 0o666)],
  ['empty evidence', f => writeFileSync(join(f.fixture, 'catalog.log'), '')],
  ['evidence hash drift', f => writeFileSync(join(f.fixture, 'catalog.log'), 'changed')],
  ['foreign evidence', f => { const path = join(f.base, 'foreign.log'); writeFileSync(path, 'foreign'); f.provisioning.evidence.catalog = { path, sha256: sha256('foreign') }; f.save(); }],
  ['sibling prefix collision', f => { const path = join(f.runnerTemp, 'fixture-other'); mkdirSync(path, { mode: 0o700 }); writeFileSync(join(path, 'catalog.log'), 'foreign'); f.provisioning.evidence.catalog = { path: join(path, 'catalog.log'), sha256: sha256('foreign') }; f.save(); }],
  ['relative evidence escape', f => { f.provisioning.evidence.catalog.path = '../catalog.log'; f.save(); }],
  ['noncanonical evidence', f => { f.provisioning.evidence.catalog.path = './catalog.log'; f.save(); }],
  ['symlink evidence leaf', f => { renameSync(join(f.fixture, 'catalog.log'), join(f.fixture, 'real.log')); symlinkSync('real.log', join(f.fixture, 'catalog.log')); }],
  ['hardlinked evidence', f => linkSync(join(f.fixture, 'catalog.log'), join(f.fixture, 'copy.log'))],
  ['symlink evidence ancestor', f => { symlinkSync(f.fixture, join(f.fixture, 'alias')); f.provisioning.evidence.catalog.path = 'alias/catalog.log'; f.save(); }],
]) {
  test(`qualification path admission rejects ${name} without creating output`, t => {
    const f = pathFixture(t); mutate(f);
    assert.throws(() => admitQualificationPaths(f.options));
    if (!name.includes('output')) assert.equal(existsSync(f.destination), false);
  });
}

test('filesystem admission rejects paths belonging to another UID', t => {
  const f = pathFixture(t), uid = process.getuid();
  t.mock.method(process, 'getuid', () => uid + 1);
  assert.throws(() => admitQualificationPaths(f.options), /owner/);
});

test('unsafe ancestor above the runner boundary is rejected', t => {
  const f = pathFixture(t); chmodSync(f.base, 0o777);
  assert.throws(() => admitQualificationPaths(f.options), /ancestor/);
});

test('every ancestor between runner boundary and private fixture must remain owner-only writable', t => {
  const f = pathFixture(t), branch = join(f.runnerTemp, 'branch');
  mkdirSync(branch, { mode: 0o700 }); renameSync(f.fixture, join(branch, 'fixture')); chmodSync(branch, 0o777);
  const fixture = join(branch, 'fixture');
  assert.throws(() => admitQualificationPaths({ ...f.options, destination: join(fixture, 'qualification'),
    provisioningPath: join(fixture, 'provisioning.json') }), /permissions/);
});

test('retained inputs and private output identity are rechecked before writes', t => {
  const f = pathFixture(t), admitted = admitQualificationPaths(f.options), output = admitted.createOutput();
  output.write('result.json', 'first');
  writeFileSync(join(f.fixture, 'catalog.log'), 'drift');
  assert.throws(() => output.write('result.json', 'unsafe'), /drift/);
  assert.equal(readFileSync(join(f.destination, 'result.json'), 'utf8'), 'first');
});

test('output symlink replacement never truncates a foreign file', t => {
  const f = pathFixture(t), output = admitQualificationPaths(f.options).createOutput();
  const target = join(f.base, 'untouched'); writeFileSync(target, 'sentinel');
  output.write('result.json', 'first'); rmSync(join(f.destination, 'result.json'));
  symlinkSync(target, join(f.destination, 'result.json'));
  assert.throws(() => output.write('result.json', 'unsafe'));
  assert.equal(readFileSync(target, 'utf8'), 'sentinel');
});

test('source admission binds exact committed bytes and detects later input drift', t => {
  const f = pathFixture(t), path = 'fixture.sql', bytes = Buffer.from('select 1;\n');
  writeFileSync(join(f.root, path), bytes);
  const source = admitSourceInputs({ root: f.root, paths: [path], committedBytes: () => bytes });
  assert.equal(source.inputs[path], sha256(bytes)); assert.deepEqual(source.read(path), bytes); source.check();
  writeFileSync(join(f.root, path), 'select 2;\n');
  assert.throws(() => source.check(), /drift/);
  assert.throws(() => admitSourceInputs({ root: f.root, paths: [path], committedBytes: () => bytes }), /committed input/);
});

test('source admission rejects foreign paths, symlink inputs, hardlinks and missing tracked bytes', t => {
  const f = pathFixture(t), bytes = Buffer.from('select 1;\n'), path = join(f.root, 'fixture.sql');
  writeFileSync(path, bytes);
  for (const input of ['../foreign.sql', path, './fixture.sql']) {
    assert.throws(() => admitSourceInputs({ root: f.root, paths: [input], committedBytes: () => bytes }));
  }
  symlinkSync(path, join(f.root, 'alias.sql'));
  assert.throws(() => admitSourceInputs({ root: f.root, paths: ['alias.sql'], committedBytes: () => bytes }));
  linkSync(path, join(f.root, 'hardlink.sql'));
  assert.throws(() => admitSourceInputs({ root: f.root, paths: ['fixture.sql'], committedBytes: () => bytes }));
  assert.throws(() => admitSourceInputs({ root: f.root, paths: ['missing.sql'], committedBytes: () => bytes }));
});

test('both real CLI entrypoints reject foreign output before any git or Docker subprocess', t => {
  const f = pathFixture(t);
  const tripwire = `import cp from 'node:child_process'; import { syncBuiltinESMExports } from 'node:module';
    for (const key of ['execFileSync','spawnSync','spawn']) cp[key] = () => { console.error('FORBIDDEN_SUBPROCESS'); throw new Error('subprocess tripwire'); };
    syncBuiltinESMExports();`;
  for (const script of ['ovd591-sql-qualification.mjs', 'ovd591-retention-qualification.mjs']) {
    const child = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(tripwire)}`,
      fileURLToPath(new URL(script, import.meta.url)), 'ovd591-synthetic', join(f.base, 'foreign'),
      f.provisioningPath, '--concurrency=psql'], {
      encoding: 'utf8', timeout: 5000, env: { RUNNER_TEMP: f.runnerTemp, PATH: '' },
    });
    assert.equal(child.status, 1); assert(!child.stderr.includes('FORBIDDEN_SUBPROCESS'), child.stderr);
    assert.equal(existsSync(join(f.base, 'foreign')), false);
  }
});


test('both standalone CLIs admit the actual committed source and reject hidden input drift before Docker', t => {
  const f = pathFixture(t), repository = fileURLToPath(new URL('..', import.meta.url));
  // Local Git plus owned copied source only. Docker is an inert throwing tripwire.
  for (const path of ['scripts', 'supabase/migrations', 'supabase/tests']) {
    cpSync(join(repository, path), join(f.root, path), { recursive: true });
  }
  const env = { PATH: process.env.PATH, RUNNER_TEMP: f.runnerTemp,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  const git = args => execFileSync('git', args, { cwd: f.root, env, encoding: 'utf8', timeout: 10_000 });
  git(['init', '--quiet']); git(['add', '.']);
  git(['-c', 'user.name=Synthetic fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'source-only fixture']);
  const source = git(['rev-parse', 'HEAD']).trim();
  const migrations = [
    'supabase/migrations/20260911031500_add_capability_observation_ledger.sql',
    'supabase/migrations/20260927065514_ovd513_capability_record_resolver_rpcs.sql',
    'supabase/migrations/20261002090339_add_atomic_capability_window_attention_persistence.sql',
  ];
  const tripwire = `import cp from 'node:child_process'; import { syncBuiltinESMExports } from 'node:module';
    const realGit = cp.execFileSync;
    cp.execFileSync = (command, args, options) => {
      if (command === 'git') return realGit(command, args, options);
      if (command === 'docker' && args[0] === 'inspect') { console.error('ADMITTED_DOCKER_BOUNDARY'); throw new Error('inert Docker boundary'); }
      throw new Error('unexpected subprocess');
    };
    cp.spawn = cp.spawnSync = () => { throw new Error('SQL execution forbidden'); };
    syncBuiltinESMExports();`;
  const invoke = script => spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(tripwire)}`,
    join(f.root, 'scripts', script), 'ovd591-synthetic', f.destination, f.provisioningPath, '--concurrency=psql'],
    { env, encoding: 'utf8', timeout: 20_000 });
  for (const script of ['ovd591-sql-qualification.mjs', 'ovd591-retention-qualification.mjs']) {
    const retention = script.includes('retention');
    const paths = [...migrations, ...(retention ? ['supabase/migrations/20261002133713_add_capability_preparation_retention.sql'] : [])];
    Object.assign(f.provisioning, { source, migrationVerdict: 'passed', catalogVerdict: 'passed',
      baselineSelection: retention ? RETENTION_BASELINE : 'synthetic source-only baseline',
      appliedInputs: paths.map(path => ({ path, sha256: sha256(readFileSync(join(f.root, path))) })),
      prerequisites: baselineInputs(f.root).prerequisites }); f.save();
    const positive = invoke(script);
    assert.equal(positive.status, 1); assert.match(positive.stderr, /ADMITTED_DOCKER_BOUNDARY/);
    assert.equal(existsSync(f.destination), false, 'no output exists before actual fixture admission');
    // Normal git status can omit an assume-unchanged input; committed-byte admission cannot.
    const driftPaths = [migrations[0], ...(retention ? [
      'scripts/ovd591-readiness.mjs', 'scripts/ovd591-libpq-environment.mjs', 'scripts/free-quote-ci-profile.mjs',
      'scripts/free-quote-platform-sources.mjs', 'scripts/free-quote-psql-races.mjs',
      'supabase/migrations/20260303101500_curated_cnc_quote_platform.sql',
      'supabase/tests/capability_runtime_persistence_concurrency.sql',
    ] : ['scripts/ovd591-qualification-paths.mjs'])];
    for (const driftPath of driftPaths) {
      const original = readFileSync(join(f.root, driftPath));
      git(['update-index', '--assume-unchanged', driftPath]);
      writeFileSync(join(f.root, driftPath), Buffer.concat([original, Buffer.from(driftPath.endsWith('.mjs') ? '\n// synthetic drift\n' : '\n-- synthetic drift\n')]));
      assert.equal(git(['status', '--porcelain']).trim(), '');
      const negative = invoke(script);
      assert.equal(negative.status, 1); assert(!negative.stderr.includes('ADMITTED_DOCKER_BOUNDARY'), negative.stderr);
      assert.equal(existsSync(f.destination), false);
      writeFileSync(join(f.root, driftPath), original); git(['update-index', '--no-assume-unchanged', driftPath]);
    }
  }
});
