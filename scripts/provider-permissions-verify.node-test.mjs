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

test('CI runs provider:permissions directly as its own step', () => {
  const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(ci, /^        run: npm run provider:permissions\s*$/m);
});
