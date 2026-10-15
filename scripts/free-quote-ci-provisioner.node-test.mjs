/** Pure provisioning/cleanup contract tests. No Docker resources are created. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createArguments, cleanupFixture } from './ovd591-ci-fixture.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const source = 'a'.repeat(40), db = 'b'.repeat(64), extractor = 'c'.repeat(64), token = 'unit-owner-token';

test('free profile uses network none, fixed DNS and existing bounded disposable database create arguments', () => {
  const args = createArguments({ profile: 'free-quote', containerName: 'ovd591-free-quote-unit', source, token }, '/inert/generated.env');
  assert.equal(args[args.indexOf('--network') + 1], 'none'); assert.equal(args[args.indexOf('--dns') + 1], '127.0.0.1');
  assert(!args.includes('--publish') && !args.includes('--volume') && !args.includes('--privileged'));
  assert(args.includes('--tmpfs') && args.includes('--env-file'));
  assert(!args.join(' ').includes('POSTGRES_PASSWORD='));
});
function simulation(t, foreign = false) {
  const out = mkdtempSync(join(tmpdir(), 'free-cleanup-')); t.after(() => rmSync(out, { recursive: true, force: true }));
  mkdirSync(join(out, 'auth-extraction'));
  const state = { profile: 'free-quote', source, token, before: { containers: [], networks: [], volumes: [] },
    containerName: 'ovd591-free-quote-unit', containerId: db, containerAttempted: true, networkAttempted: false };
  state.platformSources = [{ profile: 'free-quote-platform', source, token, out: join(out, 'auth-extraction'),
    before: { containers: [db], networks: [], volumes: [] }, containerName: state.containerName + '-auth', containerId: extractor,
    containerAttempted: true, networkAttempted: false, cleaned: false }];
  const live = new Set([db, extractor]), calls = [];
  const exec = async (command, args) => {
    calls.push([command, ...args]); assert.equal(command, 'docker'); let stdout = '';
    if (args[0] === 'container') stdout = [...live].sort().join('\n');
    else if (['network', 'volume'].includes(args[0])) { assert.equal(args[1], 'ls'); }
    else if (args[0] === 'inspect') {
      const isChild = args[1].endsWith('-auth'), current = isChild ? state.platformSources[0] : state;
      stdout = JSON.stringify([{ Id: current.containerId, Name: '/' + current.containerName, Config: { Labels: {
        'ovd591.owner': isChild && foreign ? 'not-owned' : 'ovd591-disposable', 'ovd591.source': source, 'ovd591.fixture': token } } }]);
    } else if (args[0] === 'rm') { assert(live.has(args.at(-1))); live.delete(args.at(-1)); }
    else assert.fail('unexpected cleanup command');
    return { status: 0, stdout, stderr: '', failure: null };
  };
  return { out, state, live, calls, run: () => cleanupFixture({ root, out, state, exec }) };
}
test('interrupted extraction is owner-checked and removed before the database, then repeated cleanup proves absence', async t => {
  const s = simulation(t); await s.run(); assert.equal(s.live.size, 0);
  assert.deepEqual(s.calls.filter(call => call[1] === 'rm').map(call => call.at(-1)), [extractor, db]);
  assert.equal(s.state.platformSources[0].cleaned, true); await s.run();
  assert.equal(s.calls.filter(call => call[1] === 'rm').length, 2);
});
test('foreign extraction ownership aborts cleanup without deleting either object', async t => {
  const s = simulation(t, true); await assert.rejects(s.run());
  assert.equal(s.live.size, 2); assert(!s.calls.some(call => call[1] === 'rm'));
});
test('tampered nested cleanup path or identity fails before Docker action', async t => {
  const s = simulation(t); s.state.platformSources[0].out = join(s.out, 'foreign');
  await assert.rejects(s.run()); assert.equal(s.calls.length, 0);
});
test('reusable workflow is mandatory in aggregate CI and contains no secrets or provider/runtime override', () => {
  const workflow = readFileSync(join(root, '.github/workflows/free-quote-sql-qualification.yml'), 'utf8');
  const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
  assert.match(workflow, /workflow_call:/); assert(!workflow.includes('${{ runner.temp }}'));
  assert.match(workflow, /FREE_QUOTE_EVIDENCE=\$RUNNER_TEMP/); assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /run-free-quote/); assert.match(workflow, /if: always\(\)/); assert.match(workflow, /cleanup "\$FREE_QUOTE_EVIDENCE"/);
  assert(!/secrets\.|SUPABASE_URL|DATABASE_URL|workflow_dispatch|continue-on-error/.test(workflow));
  assert.match(ci, /uses: \.\/\.github\/workflows\/free-quote-sql-qualification\.yml/);
  assert.match(ci, /- free-quote-sql-qualification/); assert.match(ci, /FREE_QUOTE_SQL_RESULT: \$\{\{ needs\.free-quote-sql-qualification\.result \}\}/);
  assert.match(ci, /\[ "\$FREE_QUOTE_SQL_RESULT" != "success" \]/);
});
