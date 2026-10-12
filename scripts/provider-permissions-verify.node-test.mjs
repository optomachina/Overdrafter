/** Offline contract: npm run verify runs the provider permissions lint right after provider:check. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const scripts = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts;

test('verify runs provider:permissions exactly once, immediately after provider:check', () => {
  const steps = scripts.verify.split(' && ').map(step => step.trim());
  const check = steps.indexOf('npm run provider:check');
  assert.notEqual(check, -1);
  assert.equal(steps[check + 1], 'npm run provider:permissions');
  assert.equal(steps.filter(step => step === 'npm run provider:permissions').length, 1);
  assert.equal(scripts['provider:permissions'], 'node scripts/provider-permissions-check.mjs');
});

test('the vitest-based permissions test is not wired into a node --test lane', () => {
  for (const [name, command] of Object.entries(scripts)) {
    if (command.includes('node --test')) {
      assert.doesNotMatch(command, /provider-permissions-check\.test\.mjs/, name);
    }
  }
});

test('the unit lane runs the real CLI through scripts/provider-permissions-check.test.mjs', () => {
  const lane = readFileSync(new URL('./provider-permissions-check.test.mjs', import.meta.url), 'utf8');
  assert.match(lane, /provider-permissions-check\.mjs/);
  assert.match(lane, /real CLI/);
});
