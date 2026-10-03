/** Run only against an operator-provisioned, exclusively owned synthetic fixture.
 * No registry request, container creation, migration, credential lookup or reset. */
import assert from 'node:assert/strict';
import { runPsqlConcurrency } from './ovd591-psql-concurrency.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
export const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.095';
// Runs only inside the admitted fixture; no credential value enters host argv or SQL text.
export const FIXTURE_PASSWORD_SESSION = [
  'set -eu',
  'test -n "${POSTGRES_PASSWORD:-}" || { echo "fixture password missing" >&2; exit 2; }',
  'ovd591_password_b64=$(printf %s "$POSTGRES_PASSWORD" | base64 | tr -d "\\n")',
  'test -n "$ovd591_password_b64"',
  'export PGOPTIONS="${PGOPTIONS:?} -covd591.fixture_password_b64=$ovd591_password_b64"',
  'unset ovd591_password_b64',
  'exec "$@"',
].join('\n');
export function acceptTap(output) {
  const lines = output.split(/\r?\n/).map(line => line.trim());
  assert(!lines.some(line => /^(not ok\b|Bail out!)/i.test(line)), 'TAP failure or bailout');
  const plans = lines.filter(line => /^1\.\./.test(line));
  assert.equal(plans.length, 1, 'exactly one TAP plan required');
  assert(/^1\.\.[1-9]\d*$/.test(plans[0]), 'positive unskipped plan required');
  const count = Number(plans[0].slice(3));
  const results = lines.filter(line => /^ok\b/.test(line));
  assert.equal(results.length, count, 'complete assertion accounting required');
  results.forEach((line, i) => {
    assert(new RegExp(`^ok ${i + 1}(?:$|\\s)`).test(line), 'ordered assertion numbers required');
    assert(!/#\s*(SKIP|TODO)\b/i.test(line), 'skipped or TODO assertion');
  });
  return count;
}
export function acceptContainer(info, source) {
  assert.match(info.Name, /^\/ovd591-[a-z0-9-]+$/);
  assert.equal(info.Config.Image, IMAGE);
  assert.equal(info.Config.Labels?.['ovd591.owner'], 'ovd591-disposable');
  assert.equal(info.Config.Labels?.['ovd591.source'], source);
  assert.equal(info.State.Running, true);
  assert(info.HostConfig.NanoCpus > 0 && info.HostConfig.NanoCpus <= 2_000_000_000, 'bounded CPU');
  assert(info.HostConfig.Memory > 0 && info.HostConfig.Memory <= 3 * 1024 ** 3, 'bounded memory');
  assert(info.HostConfig.PidsLimit > 0 && info.HostConfig.PidsLimit <= 256, 'bounded PIDs');
  assert.equal(info.HostConfig.Privileged, false);
  assert(!['host', 'container'].some(mode => info.HostConfig.NetworkMode.startsWith(mode)));
  assert.equal(Object.keys(info.HostConfig.PortBindings ?? {}).length, 0);
  assert.equal((info.Mounts ?? []).filter(m => m.Type === 'bind' || m.Type === 'volume').length, 0);
}
export async function runQualification(container, destination, provisioningPath, transport = 'dblink') {
  assert(['dblink', 'psql'].includes(transport), 'explicit known concurrency transport required');
  assert.match(container ?? '', /^ovd591-[a-z0-9-]+$/);
  assert(destination, 'exclusive output directory required');
  assert(provisioningPath, 'provisioning receipt required');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const run = (command, args, input) => execFileSync(command, args, {
    cwd: root, encoding: 'utf8', input, timeout: 120_000, maxBuffer: 8_000_000,
  });
  const git = args => run('git', args).trim();
  assert.equal(git(['status', '--porcelain']), '', 'clean committed source required');
  const source = git(['rev-parse', 'HEAD']);
  const info = JSON.parse(run('docker', ['inspect', container]))[0];
  acceptContainer(info, source);
  for (const network of Object.values(info.NetworkSettings.Networks)) {
    const value = JSON.parse(run('docker', ['network', 'inspect', network.NetworkID]))[0];
    assert.equal(value.Internal, true, 'only internal fixture networks');
  }
  const out = resolve(destination);
  mkdirSync(out, { mode: 0o700 });
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  const manifest = Object.fromEntries(git(['ls-files', 'supabase/migrations', 'supabase/tests/capability_observation_ledger.sql', 'supabase/tests/capability_observation_rpcs.sql', 'supabase/tests/capability_runtime_persistence.sql', 'supabase/tests/capability_runtime_persistence_concurrency.sql', 'scripts/ovd591-sql-qualification.mjs', 'scripts/ovd591-psql-concurrency.mjs', 'supabase/tests/capability_runtime_persistence_psql.phases.json']).split('\n').map(path => [path, sha(readFileSync(resolve(root, path)))]));
  const provisioningBytes = readFileSync(resolve(provisioningPath));
  const provisioning = JSON.parse(provisioningBytes);
  assert.equal(provisioning.source, source);
  assert.equal(provisioning.containerId, info.Id);
  assert.equal(provisioning.imageId, info.Image);
  assert.equal(provisioning.migrationVerdict, 'passed');
  assert.equal(provisioning.catalogVerdict, 'passed');
  assert(Array.isArray(provisioning.appliedInputs) && provisioning.appliedInputs.length > 0);
  for (const input of provisioning.appliedInputs) assert.equal(manifest[input.path], input.sha256, 'applied input hash differs');
  for (const required of [
    'supabase/migrations/20260911031500_add_capability_observation_ledger.sql',
    'supabase/migrations/20260927065514_ovd513_capability_record_resolver_rpcs.sql',
    'supabase/migrations/20261002090339_add_atomic_capability_window_attention_persistence.sql',
  ]) assert(provisioning.appliedInputs.some(input => input.path === required), `missing required migration: ${required}`);
  assert(typeof provisioning.baselineSelection === 'string' && provisioning.baselineSelection.length > 0);
  for (const kind of ['migration', 'catalog']) {
    const evidence = provisioning.evidence?.[kind];
    assert(evidence && typeof evidence.path === 'string' && /^[a-f0-9]{64}$/.test(evidence.sha256), `${kind} raw evidence required`);
    const bytes = readFileSync(resolve(evidence.path));
    assert(bytes.length > 0);
    assert.equal(sha(bytes), evidence.sha256, `${kind} evidence hash`);
    writeFileSync(resolve(out, `${kind}-provisioning-evidence.log`), bytes);
  }
  const psqlOptions = '-csearch_path=public,extensions,pg_catalog -ctimezone=UTC -cstatement_timeout=20000';
  const receipt = { source, transport, psqlOptions, provisioningSha256: sha(provisioningBytes), provisioning, startedAt: new Date().toISOString(), containerId: info.Id,
    imageId: info.Image, platform: process.platform, node: process.version, inputs: manifest,
    status: 'running', cases: [] };
  const save = () => writeFileSync(resolve(out, 'result.json'), JSON.stringify(receipt, null, 2) + '\n');
  save();
  try {
    for (const name of ['capability_observation_ledger', 'capability_observation_rpcs', 'capability_runtime_persistence', 'capability_runtime_persistence_concurrency']) {
      if (name === 'capability_runtime_persistence_concurrency' && transport === 'psql') {
        const output = await runPsqlConcurrency({ root, container, psqlOptions, out });
        const assertions = acceptTap(output);
        assert.equal(assertions, 28, 'all original concurrency assertions required');
        receipt.cases.push({ name, transport: 'persistent-psql-unix-socket-v1', assertions, outputSha256: sha(output) });
        save(); continue;
      }
      const sql = readFileSync(resolve(root, `supabase/tests/${name}.sql`));
      const command = name === 'capability_runtime_persistence_concurrency'
        ? ['sh', '-c', FIXTURE_PASSWORD_SESSION, 'ovd591-psql', 'psql'] : ['psql'];
      const args = ['exec', '-i', '-e', `PGOPTIONS=${psqlOptions}`, container, ...command, '-U', 'postgres', '-d', 'postgres', '-X', '-Atq', '-v', 'ON_ERROR_STOP=1'];
      const child = spawnSync('docker', args, { cwd: root, encoding: 'utf8', input: sql,
        timeout: 120_000, maxBuffer: 8_000_000 });
      const output = child.stdout ?? '';
      writeFileSync(resolve(out, `${name}.stdout`), output);
      writeFileSync(resolve(out, `${name}.stderr`), child.stderr ?? '');
      assert(!child.error && child.status === 0, `SQL process failed: ${child.error?.message ?? child.status}`);
      receipt.cases.push({ name, assertions: acceptTap(output), outputSha256: sha(output) });
      save();
    }
    assert.equal(git(['rev-parse', 'HEAD']), source);
    assert.equal(git(['status', '--porcelain']), '');
    receipt.status = 'passed';
  } catch (error) { receipt.status = 'failed'; receipt.error = error.message; throw error; }
  finally { receipt.finishedAt = new Date().toISOString(); save(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    assert([5, 6].includes(process.argv.length));
    if (process.argv.length === 6) assert.equal(process.argv[5], '--concurrency=psql');
    await runQualification(process.argv[2], process.argv[3], process.argv[4], process.argv.length === 6 ? 'psql' : 'dblink');
  }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
