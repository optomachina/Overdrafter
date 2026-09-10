/**
 * Exercise the engineering inbox against an explicitly named disposable local
 * Supabase container. SQL fixtures roll back; concurrency fixtures are retained
 * and identified in the report. Never accepts a remote connection string.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const exec = promisify(execFile);
const container = process.argv[2];
if (!container || !/^supabase_db_ovd496-[a-z0-9-]+$/.test(container)) {
  throw new Error('Pass the explicit disposable local OVD-496 Supabase container name. No remote database connections are supported.');
}
const psqlArgs = ['exec', '-i', container, 'psql', '-U', 'postgres', '-Atq', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose'];
/** Execute generated test SQL inside the named local fixture container only. */
async function sql(statement) {
  return (await exec('docker', [...psqlArgs, '-c', statement], { maxBuffer: 2_000_000 })).stdout.trim();
}
/** Capture pgTAP failures as failures even when psql itself exits successfully. */
async function runAccessSuite() {
  const source = await readFile(new URL('../supabase/tests/engineering_inbox.sql', import.meta.url), 'utf8');
  const output = await sql(source);
  assert.doesNotMatch(output, /not ok|Looks like you failed|planned \d+ tests but ran/i);
  assert.match(output, /^1\.\.34$/m);
  assert.equal(output.split('\n').filter((line) => /^ok \d+\b/.test(line)).length, 34);
  return output;
}
/** Inputs here are test-owned UUIDs/constants, never external user payloads. */
function quote(value) { return `'${String(value).replaceAll("'", "''")}'`; }

await runAccessSuite();
const actor = randomUUID(), organization = randomUUID(), project = randomUUID();
const snapshot = randomUUID(), conversation = randomUUID(), key = randomUUID();
const context = JSON.stringify({ schema: 'overdrafter.prepared-assembly.v2', snapshotId: snapshot,
  scope: { organizationId: organization, projectId: project }, testOnly: 'Not native verification evidence' });
await sql(`
  begin;
  insert into auth.users(id,aud,role,email,email_confirmed_at)
    values (${quote(actor)},'authenticated','authenticated',${quote(`ovd496-${actor}@example.test`)},now());
  insert into public.organizations(id,name,slug) values (${quote(organization)},'OVD-496 concurrency fixture',${quote(`ovd496-${organization}`)});
  insert into public.organization_memberships(organization_id,user_id,role) values (${quote(organization)},${quote(actor)},'client');
  insert into public.projects(id,organization_id,owner_user_id,name) values (${quote(project)},${quote(organization)},${quote(actor)},'OVD-496 concurrency');
  insert into public.project_memberships(project_id,user_id,role) values (${quote(project)},${quote(actor)},'owner');
  insert into engineering_private.engineering_operators(organization_id,user_id,enabled) values (${quote(organization)},${quote(actor)},true);
  insert into public.engineering_snapshots(id,organization_id,project_id,context_text) values (${quote(snapshot)},${quote(organization)},${quote(project)},${quote(context)});
  commit;
`);
/** Independent sessions contend on the same conversation and retain a short transaction lock. */
async function send(revision, idempotencyKey, body, applicationName = 'ovd496-send') {
  const result = await sql(`begin;
    set local application_name = ${quote(applicationName)};
    set local role authenticated;
    set local request.jwt.claim.sub = ${quote(actor)};
    select public.api_submit_engineering_message(${quote(organization)},${quote(project)},${quote(conversation)},
      ${quote(snapshot)},${revision},${quote(idempotencyKey)},${quote(body)});
    select pg_sleep(0.15);
    commit;`);
  const line = result.split('\n').find((entry) => entry.startsWith('{'));
  assert.ok(line, 'Expected the intake receipt');
  return JSON.parse(line);
}
const duplicates = await Promise.all(Array.from({ length: 5 }, () => send(0, key, 'Make depth 8 mm')));
for (const receipt of duplicates) assert.deepEqual(receipt, duplicates[0]);
assert.equal(duplicates[0].revision, 1);
const conflicts = await Promise.allSettled([send(1, randomUUID(), 'Make depth 9 mm'), send(1, randomUUID(), 'Make depth 7 mm')]);
assert.equal(conflicts.filter((result) => result.status === 'fulfilled').length, 1);
const rejection = conflicts.find((result) => result.status === 'rejected');
assert.match(rejection.reason.stderr, /40001/);
const state = JSON.parse(await sql(`select jsonb_build_object(
  'revision',(select revision from public.engineering_conversations where id=${quote(conversation)}),
  'messages',(select count(*) from public.engineering_messages where conversation_id=${quote(conversation)}),
  'requests',(select count(*) from public.engineering_requests where conversation_id=${quote(conversation)}),
  'actorsMatch',(select bool_and(author_user_id=${quote(actor)}) from public.engineering_messages where conversation_id=${quote(conversation)})
);`));
assert.deepEqual(state, { revision: 2, messages: 2, requests: 2, actorsMatch: true });
// Exercise permission revocation while an admitted call is waiting on the queue lock.
const blockerName = `ovd496-blocker-${randomUUID()}`, waiterName = `ovd496-waiter-${randomUUID()}`;
const blocker = sql(`begin; set local application_name = ${quote(blockerName)};
  select pg_advisory_xact_lock(hashtextextended('engineering:' || ${quote(conversation)},0));
  select pg_sleep(5); commit;`);
/** Wait for an observable database barrier instead of assuming process timing. */
async function waitFor(query) {
  for (let attempt = 0; attempt < 25; attempt++) {
    if (await sql(query) === 't') return;
    await delay(100);
  }
  throw new Error('Expected concurrency barrier was not observed.');
}
await waitFor(`select exists(select 1 from pg_locks l join pg_stat_activity a using(pid)
  where a.application_name=${quote(blockerName)} and l.locktype='advisory' and l.granted)`);
const waiter = send(2,randomUUID(),'Make depth 10 mm',waiterName).then(
  (value) => ({ status: 'fulfilled', value }), (error) => ({ status: 'rejected', error }));
await waitFor(`select exists(select 1 from pg_stat_activity where application_name=${quote(waiterName)} and wait_event='advisory')`);
await sql(`update engineering_private.engineering_operators set enabled=false where organization_id=${quote(organization)} and user_id=${quote(actor)}`);
await blocker;
const revoked = await waiter;
assert.equal(revoked.status,'rejected');
assert.match(revoked.error.stderr,/42501/);
assert.equal(await sql(`select revision from public.engineering_conversations where id=${quote(conversation)}`),'2');
const report = { outcome: 'passed', accessAssertions: 34, concurrentDuplicateSends: 5,
  conflictingSends: 2, conflictWinners: 1, revokedWaitingSend: 'denied', finalState: state,
  localContainer: container, retainedFixture: { actor, organization, project, snapshot, conversation } };
if (process.argv[3]) await writeFile(process.argv[3], JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
