// @vitest-environment node
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'vitest';
import { scanFunctionEvents, prosrcMd5 } from './check-migration-function-collisions.mjs';
import { resolveDraftFamilies } from './ephemeral-db-apply.mjs';

const read = (path) => readFileSync(path, 'utf8');
const dir = 'docs/migration-drafts';
const forward = read(`${dir}/ovd-723-contract.sql`);
const rollback = read(`${dir}/ovd-723-contract.rollback.sql`);
const latest = new Map();
for (const file of readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql')).sort()) {
  for (const event of scanFunctionEvents(read(`supabase/migrations/${file}`))) {
    if (event.action === 'define') latest.set(event.signature, { ...event, file });
  }
}
const cores = {
  api_prepare_job_file_upload: 'job_file_prepare_core',
  api_finalize_job_file_upload: 'job_file_finalize_core',
  api_authorize_provider_worker_dispatch: 'provider_worker_dispatch_core',
  api_authorize_xometry_beta_worker_dispatch: 'xometry_beta_worker_dispatch_core',
  api_request_manual_quote: 'manual_quote_request_core',
};
const replacements = scanFunctionEvents(forward).filter((event) => latest.has(event.signature));
assert.equal(replacements.length, 7);
for (const event of replacements) {
  const prior = latest.get(event.signature);
  const signature = event.signature.replaceAll('job_file_kind', 'public.job_file_kind');
  const publicName = signature.split('(')[0];
  const core = cores[publicName.split('.')[1]];
  test(`${signature}: guards pin the newest migration body (${prior.file})`, () => {
    const pin = `('${signature}', '${prosrcMd5(prior.body)}')`;
    assert.ok(forward.includes(pin));
    assert.equal(JSON.parse(/v_baseline constant jsonb := '([^']+)'::jsonb/.exec(rollback)[1])[signature], prosrcMd5(prior.body));
    assert.ok(rollback.includes(`('${signature}', '${prosrcMd5(event.body)}')`));
  });
  if (core) {
    test(`${signature}: copies and restores only the definition header, retaining public identity and ACL`, () => {
      assert.ok(forward.includes(`pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('${signature}'))`));
      assert.ok(forward.includes(`'FUNCTION ${publicName}(', 'FUNCTION private.${core}('`));
      assert.ok(rollback.includes(`'FUNCTION private.${core}(', 'FUNCTION ${publicName}('`));
      assert.ok(rollback.includes(`('private.${core}${signature.slice(signature.indexOf('('))}', '${prosrcMd5(prior.body)}')`));
      assert.doesNotMatch(rollback, new RegExp(`drop function ${publicName.replace('.', '\\.')}\\(`, 'i'));
    });
  } else {
    test(`${signature}: restored delegate body is byte-identical`, () => {
      const restored = scanFunctionEvents(rollback.slice(rollback.indexOf('-- C.2:')))
        .find((entry) => entry.signature === event.signature);
      assert.equal(restored.body, prior.body);
    });
  }
}

test('rollback replay requires all baseline bodies and no remaining contract cores or helper', () => {
  const replay = rollback.slice(0, rollback.indexOf('    return;'));
  assert.match(replay, /md5\(p.prosrc\) is distinct from expected.body_md5/);
  for (const core of Object.values(cores)) assert.ok(replay.includes(`p.proname = '${core}'`));
  assert.ok(replay.includes("to_regprocedure('private.export_control_manual_quote_denial(uuid)') is null"));
  assert.match(rollback, /do \$rollback\$[\s\S]*end;\n\$rollback\$;/);
});

test('family 723 selects only the contract after retired expand drafts are excluded', () => {
  const drafts = readdirSync(dir).filter((file) => /^ovd-72[23].*\.sql$/.test(file) && !file.endsWith('.rollback.sql'))
    .map((file) => ({ path: `${dir}/${file}`, text: read(`${dir}/${file}`) }));
  const pending = 'supabase/tests/pending';
  const tests = readdirSync(pending).filter((file) => /^ovd723.*\.pending$/.test(file))
    .map((file) => ({ path: `${pending}/${file}`, text: read(`${pending}/${file}`) }));
  const plan = resolveDraftFamilies({ touched: [`${dir}/ovd-723-contract.sql`], drafts, tests });
  assert.deepEqual(plan.families.find((family) => family.id === '723').drafts, [`${dir}/ovd-723-contract.sql`]);
});

 test('rollback shares one complete baseline between replay and post-restore guards', () => {
  const baseline = JSON.parse(/v_baseline constant jsonb := '([^']+)'::jsonb/.exec(rollback)[1]);
  assert.equal(Object.keys(baseline).length, 7);
  assert.equal((rollback.match(/pg_catalog\.jsonb_each_text\(v_baseline\)/g) ?? []).length, 2);
  assert.match(rollback, /select key as signature, value as body_md5 from pg_catalog\.jsonb_each_text\(v_baseline\)/);
  assert.match(rollback, /if v_md5 is distinct from v_expected.body_md5 then/);
});
