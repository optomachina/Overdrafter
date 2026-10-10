/** Offline regression for runner context availability; does not launch CI/SQL. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

for (const [file, stem] of [['ovd591-qualification.yml', 'ovd591'],
  ['ovd591-retention-qualification.yml', 'ovd591-retention']]) {
  test(`${file} initializes the same evidence path after runner allocation`, t => {
    const source = readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), 'utf8');
    const [jobConfig, steps] = source.split('    steps:\n');
    assert(steps, 'workflow must define steps');
    assert(!jobConfig.includes('runner.'), 'runner context is unavailable in job env');
    const command = steps.match(/^      - name: Set runner-local evidence path\n        shell: bash\n        run: (.+)\n/)?.[1];
    assert(command, 'initialization must precede all consumers and actions');
    const out = mkdtempSync(join(tmpdir(), 'ovd591-context-'));
    t.after(() => rmSync(out, { recursive: true, force: true }));
    const envFile = join(out, 'job-env');
    const runnerTemp = join(out, 'runner temp');
    const result = spawnSync('bash', ['-euo', 'pipefail', '-c', command], {
      env: { PATH: process.env.PATH, RUNNER_TEMP: runnerTemp, GITHUB_ENV: envFile,
        GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '4' }, encoding: 'utf8', timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(envFile, 'utf8'), `OVD591_EVIDENCE=${runnerTemp}/${stem}-123-4-evidence\n`);
    assert.match(steps, /path: \$\{\{ env\.OVD591_EVIDENCE \}\}/);
    assert.match(steps, /cleanup "\$OVD591_EVIDENCE"/);
  });
}
