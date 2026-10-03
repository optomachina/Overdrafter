/** Same-head CI follows the required independent-psql replacement before this lane. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const LEGACY = 'capability_runtime_persistence_concurrency.sql';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function inventory(root, relative = '') {
  return readdirSync(join(root, relative)).sort().flatMap(name => {
    const path = join(relative, name), stat = lstatSync(join(root, path));
    assert(!stat.isSymbolicLink(), 'test source symlinks are not admitted');
    if (stat.isDirectory()) return inventory(root, path);
    assert(stat.isFile(), 'only regular source files are admitted');
    return [path];
  });
}
export function stagePolicyTests(source, target) {
  const paths = inventory(source);
  assert(paths.includes(LEGACY), 'reviewed legacy source missing');
  const original = readFileSync(join(source, LEGACY), 'utf8');
  const phases = JSON.parse(readFileSync(join(source, 'capability_runtime_persistence_psql.phases.json')));
  assert.equal(phases.schema, 'ovd591.psql-phases.v1');
  assert.equal(phases.originalSha256, sha(original));
  assert.equal(phases.races.length, 6);
  const retained = phases.setup + phases.races.map(r => r.observe + r.release + r.after).join('') + phases.finish;
  const assertions = text => text.match(/^select (?:is|ok|throws_ok)\([\s\S]*?;\n/gm);
  assert.equal(assertions(original)?.length, 28);
  assert.deepEqual(assertions(retained), assertions(original), 'replacement assertion bytes changed');
  assert(!retained.includes('extensions.dblink'), 'replacement must use independent sessions');
  mkdirSync(target, { mode: 0o700 });
  const files = {};
  for (const path of paths.filter(path => path !== LEGACY)) {
    mkdirSync(dirname(join(target, path)), { recursive: true });
    copyFileSync(join(source, path), join(target, path));
    files[path] = sha(readFileSync(join(source, path)));
    assert.equal(sha(readFileSync(join(target, path))), files[path]);
  }
  assert.deepEqual(inventory(target), paths.filter(path => path !== LEGACY));
  return { routedToRequiredPsqlJob: LEGACY, phaseSourceSha256: phases.originalSha256,
    selectedSql: Object.keys(files).filter(path => /\.(?:sql|pg)$/.test(path)), files };
}
export function admitPgProve(stdout, expectedFiles) {
  const text = stdout.replace(/\u001b\[[0-9;]*m/g, '');
  const summaries = [...text.matchAll(/^Files=(\d+), Tests=(\d+),.*$/gm)];
  const results = [...text.matchAll(/^Result:\s*(\S+)\s*$/gm)];
  assert.equal(summaries.length, 1, 'one complete pg_prove file/test summary required');
  assert.equal(results.length, 1, 'one complete pg_prove result required');
  assert.equal(Number(summaries[0][1]), expectedFiles, 'staged SQL inventory was not fully executed');
  assert(Number(summaries[0][2]) > 0, 'positive assertion count required');
  assert.equal(results[0][1], 'PASS', 'pg_prove must pass');
  assert(!/NOTESTS|No (?:sub)?tests run|^not ok\b|#\s*(?:SKIP|TODO)\b|\bskipped:/im.test(text), 'empty/skipped/failing evidence rejected');
  return { files: expectedFiles, assertions: Number(summaries[0][2]), result: 'PASS' };
}
export function admitCi(env) {
  assert.equal(env.GITHUB_ACTIONS, 'true');
  assert.equal(env.OVD591_PSQL_QUALIFIED, 'success', 'same-head prerequisite must pass');
  assert(isAbsolute(env.RUNNER_TEMP ?? ''), 'owned runner temporary root required');
}
function main() {
  admitCi(process.env);
  assert.equal(process.argv.length, 2, 'no external database or path arguments accepted');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const owned = mkdtempSync(join(realpathSync(process.env.RUNNER_TEMP), 'ovd-policy-tests-'));
  const identity = lstatSync(owned);
  try {
    const target = join(owned, 'tests');
    const receipt = stagePolicyTests(join(root, 'supabase/tests'), target);
    console.log(JSON.stringify(receipt, null, 2));
    // CLI 2.78.1 maps --debug to verbose pg_prove, exposing TAP skip/TODO directives.
    const result = spawnSync('supabase', ['test', 'db', '--local', '--debug', target], {
      cwd: root, encoding: 'utf8', maxBuffer: 64_000_000, timeout: 19 * 60_000,
    });
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    assert(!result.error && result.status === 0, 'Supabase test process failed');
    console.log(JSON.stringify(admitPgProve(result.stdout, receipt.selectedSql.length)));
  } finally {
    const current = lstatSync(owned);
    assert(!current.isSymbolicLink() && current.ino === identity.ino && current.dev === identity.dev,
      'owned staging directory identity changed; cleanup refused');
    rmSync(owned, { recursive: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
