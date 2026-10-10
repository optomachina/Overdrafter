/** Offline source contracts only. These checks do not execute or qualify SQL. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const generator = 'scripts/generate-free-quote-fixtures.mjs';
const wrapper = 'supabase/tests/free_quote_terminal_lifecycle.sql';
const body = 'scripts/qualification/free-quote-terminal-lifecycle.sql';
const include = 'supabase/tests/fixtures/free_quote_meter_setup.inc';
const expanded = 'supabase/fixtures/free-quote-qualification/free-quote-terminal-lifecycle.expanded.sql';
const read = path => readFileSync(join(root, path), 'utf8');
const run = (cwd, args = ['--check']) => spawnSync(process.execPath, [join(cwd, generator), ...args], {
  cwd, encoding: 'utf8', timeout: 10_000,
});
function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'free-quote-generator-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  for (const path of [generator, body, include, wrapper,
    'supabase/tests/free_quote_job_meter.sql', 'supabase/tests/free_confirmed_quote_access.sql',
    'supabase/fixtures/free-quote-qualification']) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    cpSync(join(root, path), join(cwd, path), { recursive: true });
  }
  return cwd;
}

test('discovered lifecycle test is the exact standalone reviewed expansion', () => {
  assert.equal(read(wrapper), read(expanded));
  assert(!/^\s*\\ir\b/m.test(read(wrapper)), 'no host-relative include survives discovery');
  assert.match(read(wrapper), /select \* from finish\(\);\s*rollback;/i);
});

test('committed expanded fixtures match canonical sources, without SQL execution', () => {
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Three source-only SQL fixtures verified; no SQL executed/);
});

for (const [name, path] of [['lifecycle source', body], ['shared include', include], ['expanded artifact', expanded], ['discovery artifact', wrapper]]) {
  test(`generator check rejects drift in ${name}`, t => {
    const cwd = fixture(t);
    writeFileSync(join(cwd, path), readFileSync(join(cwd, path), 'utf8') + '\n-- deliberate source-only drift\n');
    const result = run(cwd);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Generated fixture drift/);
  });
}

test('generated stdin artifact contains exact reviewed lifecycle body and no unresolved includes', () => {
  const artifact = read(expanded);
  assert(!/^\s*\\ir\b/m.test(artifact));
  const withoutInclude = read(body).replace(/^\s*\\ir\s+[^\n]+$/gm, '');
  const pieces = withoutInclude.split('\n\n').filter(Boolean);
  // The generator expands only the include; all surrounding SQL stays unchanged.
  for (const piece of pieces) assert(artifact.includes(piece), 'canonical lifecycle SQL changed during expansion');
});

test('free policy changes are confined to the synthetic meter revision', () => {
  const source = read('supabase/tests/free_quote_job_meter.sql');
  const updates = source.match(/update private\.free_quote_policies set [^;]+/g);
  assert.equal(updates?.length, 5);
  for (const update of updates) assert.match(update, /where revision='synthetic-meter-only'/);
});
