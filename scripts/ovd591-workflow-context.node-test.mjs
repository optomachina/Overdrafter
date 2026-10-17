/** Offline regression for runner context availability; does not launch CI/SQL. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

for (const [file, command, evidence] of [
  ['ovd591-qualification.yml', 'run', 'OVD591_EVIDENCE'],
  ['ovd591-retention-qualification.yml', 'run-retention', 'OVD591_EVIDENCE'],
  ['free-quote-sql-qualification.yml', 'run-free-quote', 'FREE_QUOTE_EVIDENCE'],
]) {
  test(`${file} requires a passed fixture receipt and retained evidence`, () => {
    const source = readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), 'utf8');
    const step = source.split(/\n      - name: /).find(block => block.includes(`ovd591-ci-fixture.mjs ${command} "`));
    assert(step);
    assert.match(step, /set -euo pipefail/);
    assert(step.includes(`node scripts/ovd591-ci-fixture.mjs ${command} "$${evidence}"`));
    assert(step.includes(`test -s "$${evidence}/fixture-result.json"`));
    assert(step.includes(`jq -e '.status == "passed"' "$${evidence}/fixture-result.json"`));
    assert.match(step, /echo "::error::[^\n]+\n\s+exit 1/);
    const upload = source.split(/\n      - name: /).find(block => block.includes('actions/upload-artifact@v4'));
    assert.match(upload, /if-no-files-found: error/);
  });
}

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
