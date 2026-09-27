/** Concurrent OVD-518 reservation proof inside an exclusively owned fixture. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

const q = (value) => `'${String(value).replaceAll("'", "''")}'`;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function session(dockerExecutable, container, password, source) {
  const child = spawn(dockerExecutable, [
    "exec", "-i", "-e", `PGPASSWORD=${password}`, container,
    "psql", "-U", "postgres", "-d", "postgres", "-X", "-Atq",
    "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose",
  ], { stdio: ["pipe", "pipe", "pipe"], timeout: 15_000 });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(source);
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.slice(-1200) }));
  });
}
async function waitFor(psql, name, event) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const present = psql(`select exists(select 1 from pg_stat_activity
      where application_name=${q(name)} and wait_event=${q(event)});`);
    if (present === "t") return;
    await pause(50);
  }
  throw new Error(`ovd518_race_barrier_missing:${event}`);
}
export async function runInterpretationRaceProof({ dockerExecutable, container, password, psql }) {
  const actor = randomUUID(), organization = randomUUID(), project = randomUUID();
  const snapshot = randomUUID(), conversation = randomUUID(), key = randomUUID();
  const context = JSON.stringify({
    schema: "overdrafter.prepared-assembly.v2", snapshotId: snapshot,
    scope: { organizationId: organization, projectId: project },
    packageId: "ovd-native04-assembly", configuration: "Default",
  });
  psql(`begin;
    insert into auth.users(id,aud,role,email,email_confirmed_at)
      values(${q(actor)},'authenticated','authenticated',${q(`ovd518-${actor}@example.test`)},now());
    insert into public.organizations(id,name,slug)
      values(${q(organization)},'OVD-518 race fixture',${q(`ovd518-${organization}`)});
    insert into public.organization_memberships(organization_id,user_id,role)
      values(${q(organization)},${q(actor)},'internal_admin');
    insert into public.projects(id,organization_id,owner_user_id,name)
      values(${q(project)},${q(organization)},${q(actor)},'OVD-518 race fixture');
    insert into public.project_memberships(project_id,user_id,role)
      values(${q(project)},${q(actor)},'owner');
    insert into engineering_private.engineering_operators(organization_id,user_id,enabled)
      values(${q(organization)},${q(actor)},true);
    insert into public.engineering_snapshots(id,organization_id,project_id,context_text)
      values(${q(snapshot)},${q(organization)},${q(project)},${q(context)});
    commit;`);
  psql(`begin; set local role authenticated; set local request.jwt.claim.sub=${q(actor)};
    select public.api_submit_engineering_message(${q(organization)},${q(project)},
      ${q(conversation)},${q(snapshot)},0,${q(randomUUID())},'Set the depth to 8 mm');
    commit;`);
  const request = psql(`select id from public.engineering_requests where conversation_id=${q(conversation)};`);
  const firstName = `ovd518-first-${randomUUID()}`, secondName = `ovd518-second-${randomUUID()}`;
  const reserve = `select public.api_reserve_prepared_interpretation(${q(request)},0,${q(key)});`;
  const first = session(dockerExecutable,container,password,
    `begin; set local role service_role; set local application_name=${q(firstName)};
      ${reserve} select pg_sleep(2); commit;`);
  await waitFor(psql,firstName,"PgSleep");
  const second = session(dockerExecutable,container,password,
    `begin; set local role service_role; set local application_name=${q(secondName)};
      ${reserve} commit;`);
  await waitFor(psql,secondName,"advisory");
  const results = await Promise.all([first,second]);
  assert.ok(results.every((entry) => entry.code === 0), "Concurrent reservation SQL failed.");
  const receipts = results.map((entry) => {
    const line = entry.stdout.split("\n").find((value) => value.startsWith("{"));
    assert.ok(line, "A reservation receipt is missing.");
    return JSON.parse(line);
  });
  assert.deepEqual(receipts.map((entry) => entry.invoke).sort(), [false,true],
    "Exactly one concurrent delivery may invoke the adapter.");
  assert.equal(psql(`select count(*) from public.engineering_interpretation_reservations
    where request_id=${q(request)};`),"1");
  assert.equal(psql(`select sum(reserved_cents) from public.engineering_interpretation_reservations
    where request_id=${q(request)};`),"20");
  psql(`update public.engineering_interpretation_reservations
    set deadline_at=clock_timestamp()+interval '2 seconds' where request_id=${q(request)};`);
  const lockName = `ovd518-lock-${randomUUID()}`, finishName = `ovd518-finish-${randomUUID()}`;
  const blocker = session(dockerExecutable,container,password,
    `begin; set local application_name=${q(lockName)};
      select pg_advisory_xact_lock(hashtextextended(${q(`engineering:${conversation}`)},0));
      select pg_sleep(3); commit;`);
  await waitFor(psql,lockName,"PgSleep");
  const finish = session(dockerExecutable,container,password,
    `begin; set local role service_role; set local application_name=${q(finishName)};
      select public.api_finish_prepared_interpretation(${q(request)},0,${q(key)},
        'prepared_change',8,'Recorded prepared depth request.',null); commit;`);
  await waitFor(psql,finishName,"advisory");
  assert.equal(psql(`select (a.xact_start<r.deadline_at)::text from pg_stat_activity a
    cross join public.engineering_interpretation_reservations r
    where a.application_name=${q(finishName)} and r.request_id=${q(request)};`),"true",
  "Finalization must begin before expiry to prove the lock-wait case.");
  const [blockerResult, finishResult] = await Promise.all([blocker,finish]);
  assert.equal(blockerResult.code,0,"The deadline blocker failed.");
  assert.notEqual(finishResult.code,0,"An expired finalization was accepted after the lock wait.");
  assert.match(finishResult.stderr,/PT409/);
  assert.equal(psql(`select count(*) from public.engineering_interpretations where request_id=${q(request)};`),"0");
  assert.equal(psql(`select count(*) from public.engineering_tasks where conversation_id=${q(conversation)};`),"0");
  const timeout = JSON.parse(psql(`begin; set local role service_role;
    select public.api_reserve_prepared_interpretation(${q(request)},0,${q(key)}); commit;`)
    .split("\n").find((line) => line.startsWith("{")));
  assert.equal(timeout.failureCode,"timed_out");
  return { status: "passed", sameRequestConcurrentDeliveries: 2, adapterInvocationsAdmitted: 1,
    reservations: 1, reservedCents: 20, verifiedAdvisoryWait: true,
    rejectedFinishAcrossDeadline: true, timeoutAfterReplay: true };
}
