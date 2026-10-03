/** Executes only inside the same admitted fixture; never provisions, changes auth or runs the six-race suite. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { acceptContainer, acceptTap } from './ovd591-sql-qualification.mjs';
import { MIGRATIONS, baselineInputs } from './ovd591-ci-fixture.mjs';
import { RETENTION_MIGRATION, RETENTION_BASELINE, RETENTION_SUITES } from './ovd591-retention-profile.mjs';
import { ASSERTIONS, GROUPS, runRetentionConcurrency } from './ovd591-retention-concurrency.mjs';

export async function runRetentionQualification(container, destination, provisioningPath) {
  assert.match(container ?? '', /^ovd591-[a-z0-9-]+$/); assert(destination); assert(provisioningPath);
  const root = fileURLToPath(new URL('..', import.meta.url));
  const run = (command, args) => execFileSync(command, args, { cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 8_000_000 });
  const git = args => run('git', args).trim();
  assert.equal(git(['status', '--porcelain']), '');
  const source = git(['rev-parse', 'HEAD']);
  const info = JSON.parse(run('docker', ['inspect', container]))[0]; acceptContainer(info, source);
  const networks = Object.values(info.NetworkSettings.Networks); assert.equal(networks.length, 1);
  const network = JSON.parse(run('docker', ['network', 'inspect', networks[0].NetworkID]))[0];
  assert.equal(network.Internal, true);
  assert.equal(network.Labels?.['ovd591.owner'], 'ovd591-disposable'); assert.equal(network.Labels?.['ovd591.source'], source);
  assert.equal(network.Labels?.['ovd591.fixture'], info.Config.Labels?.['ovd591.fixture']);
  const out = resolve(destination); mkdirSync(out, { mode: 0o700 });
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  const paths = [...MIGRATIONS, RETENTION_MIGRATION, ...RETENTION_SUITES.slice(0, -1).map(name => `supabase/tests/${name}.sql`),
    'scripts/ovd591-ci-fixture.mjs', 'scripts/ovd591-sql-qualification.mjs', 'scripts/ovd591-psql-concurrency.mjs',
    'scripts/ovd591-retention-profile.mjs', 'scripts/ovd591-retention-qualification.mjs', 'scripts/ovd591-retention-concurrency.mjs',
    'supabase/tests/capability_preparation_concurrency.phases.json'];
  const inputs = Object.fromEntries(paths.map(path => [path, sha(readFileSync(resolve(root, path)))]));
  const provisioningBytes = readFileSync(resolve(provisioningPath)), provisioning = JSON.parse(provisioningBytes);
  assert.equal(provisioning.source, source); assert.equal(provisioning.containerId, info.Id); assert.equal(provisioning.imageId, info.Image);
  assert.equal(provisioning.baselineSelection, RETENTION_BASELINE);
  assert.equal(provisioning.migrationVerdict, 'passed'); assert.equal(provisioning.catalogVerdict, 'passed');
  assert.deepEqual(provisioning.appliedInputs, [...MIGRATIONS, RETENTION_MIGRATION].map(path => ({ path, sha256: inputs[path] })));
  assert.deepEqual(provisioning.prerequisites, baselineInputs(root).prerequisites);
  for (const kind of ['migration', 'catalog']) {
    const entry = provisioning.evidence?.[kind]; assert(entry && /^[a-f0-9]{64}$/.test(entry.sha256));
    const bytes = readFileSync(resolve(entry.path)); assert(bytes.length > 0); assert.equal(sha(bytes), entry.sha256);
    writeFileSync(resolve(out, `${kind}-provisioning-evidence.log`), bytes);
  }
  const psqlOptions = '-csearch_path=public,extensions,pg_catalog -ctimezone=UTC -cstatement_timeout=20000';
  const receipt = { source, transport: 'psql', profile: 'retention', psqlOptions, inputs, provisioning,
    provisioningSha256: sha(provisioningBytes), containerId: info.Id, imageId: info.Image,
    startedAt: new Date().toISOString(), status: 'running', cases: [] };
  const save = () => writeFileSync(resolve(out, 'result.json'), JSON.stringify(receipt, null, 2) + '\n'); save();
  try {
    for (const name of RETENTION_SUITES.slice(0, -1)) {
      const sql = readFileSync(resolve(root, `supabase/tests/${name}.sql`));
      const child = spawnSync('docker', ['exec', '-i', '-e', `PGOPTIONS=${psqlOptions}`, container,
        'psql', '-U', 'postgres', '-d', 'postgres', '-w', '-X', '-Atq', '-v', 'ON_ERROR_STOP=1'],
      { cwd: root, encoding: 'utf8', input: sql, timeout: 120_000, maxBuffer: 8_000_000 });
      writeFileSync(resolve(out, `${name}.stdout`), child.stdout ?? ''); writeFileSync(resolve(out, `${name}.stderr`), child.stderr ?? '');
      assert(!child.error && child.status === 0, 'retention prerequisite SQL process failed');
      receipt.cases.push({ name, assertions: acceptTap(child.stdout), outputSha256: sha(child.stdout) }); save();
    }
    const output = await runRetentionConcurrency({ root, container, psqlOptions, out });
    const assertions = acceptTap(output); assert.equal(assertions, ASSERTIONS);
    receipt.cases.push({ name: RETENTION_SUITES.at(-1), assertions, groups: GROUPS, subcases: 11,
      transport: 'persistent-psql-unix-socket-v1', outputSha256: sha(output) });
    assert.equal(git(['rev-parse', 'HEAD']), source); assert.equal(git(['status', '--porcelain']), '');
    receipt.status = 'passed';
  } catch { receipt.status = 'failed'; throw new Error('retention qualification failed; preserve raw fixture evidence'); }
  finally { receipt.finishedAt = new Date().toISOString(); save(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    assert.equal(process.argv.length, 6); assert.equal(process.argv[5], '--concurrency=psql');
    await runRetentionQualification(process.argv[2], process.argv[3], process.argv[4]);
  } catch { console.error('Retention qualification failed; inspect retained synthetic receipts.'); process.exitCode = 1; }
}
