/** Concurrent finalization proof in database clones inside the owned fixture. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { redactFixtureTranscript } from "./first-loop-local-sql.mjs";
const q = (value) => `'${String(value).replaceAll("'", "''")}'`;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function session({ dockerExecutable, container, password, role = "postgres" }, database, sql, timeout = 20_000) {
  const child = spawn(dockerExecutable, ["exec", "-i", "-e", `PGPASSWORD=${password}`, container,
    "psql", "-U", role, "-d", database, "-X", "-Atq", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose"],
  { stdio: ["pipe", "pipe", "pipe"], timeout });
  const startedAt = Date.now();
  let stdout = "", stderr = "", overflow = false;
  const append = (kind, chunk) => {
    if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + Buffer.byteLength(chunk) > 8 * 1024 * 1024) {
      overflow = true; child.kill("SIGKILL"); return;
    }
    if (kind === "out") stdout += chunk; else stderr += chunk;
  };
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => append("out", chunk));
  child.stderr.on("data", (chunk) => append("err", chunk));
  child.stdin.end(sql);
  return new Promise((resolve, reject) => {
    child.on("error", () => reject(new Error("ovd561_session_spawn_failed")));
    child.on("close", (code, signal) => resolve({ code: overflow ? null : code,
      stdout: redactFixtureTranscript(stdout.trim(), password), stderr: redactFixtureTranscript(stderr, password),
      outputOverflow: overflow, signal, timedOut: Boolean(signal) && Date.now() - startedAt >= timeout }));
  });
}
async function barrier(psql, database, name, event) {
  for (let i = 0; i < 60; i++) {
    if (psql(`select exists(select 1 from pg_stat_activity where datname=${q(database)}
      and application_name=${q(name)} and wait_event=${q(event)});`) === "t") return;
    await pause(50);
  }
  throw new Error(`ovd561_barrier_missing:${name}:${event}`);
}
/** Each scenario owns a fresh database cloned from the same stopped-attempt seed.
 * The containing disposable runner owns all databases and deletes its container. */
export async function runFinalizationRaceProof(options) {
  const { psql, fixturePrefix, proof } = options;
  const schema = "ovd561_fixture";
  const setup = fixturePrefix.replace(/begin;[\s\S]*?end \$ovd560_temp\$;/,
    `begin; create schema ${schema}; grant usage on schema ${schema} to anon,authenticated,service_role;
      alter default privileges for role postgres in schema ${schema} grant execute on functions to anon,authenticated,service_role;`);
  const seed = `${setup}\n${proof.split("select 'ovd561-proof-start';")[0]}\ncommit;`
    .replaceAll("pg_temp.", `${schema}.`).replace("create temporary table ovd561_request", "create table public.ovd561_request");
  // The fixture image starts background clients in postgres. Clone only while
  // its exclusively owned source database is closed to those local clients.
  const cloned = await session({ ...options, role: "supabase_admin" },"template1",`alter database postgres allow_connections false;
    select pg_terminate_backend(pid) from pg_stat_activity where datname='postgres';
    create database ovd561_seed owner postgres template postgres; alter database postgres allow_connections true;`);
  if (cloned.code !== 0) {
    await session({ ...options, role: "supabase_admin" },"template1","alter database postgres allow_connections true;");
    throw new Error(`ovd561_seed_clone_failed:${cloned.stderr}`);
  }
  const ownership = await session(options,"ovd561_seed",`select json_build_object(
    'databaseOwner',(select pg_get_userbyid(datdba) from pg_database where datname=current_database()),
    'publicSchemaOwner',(select pg_get_userbyid(nspowner) from pg_namespace where nspname='public'),
    'postgresCanCreate',has_schema_privilege('postgres','public','CREATE'),
    'postgresCanCreateSchema',has_database_privilege('postgres',current_database(),'CREATE'));`);
  assert.equal(ownership.code,0,ownership.stderr);
  const ownerEvidence = JSON.parse(ownership.stdout);
  assert.equal(ownerEvidence.databaseOwner,"postgres");
  assert.equal(ownerEvidence.postgresCanCreate,true);
  assert.equal(ownerEvidence.postgresCanCreateSchema,true);
  options.recordOwnership(ownerEvidence);
  if (options.suffix?.length) {
    const applied = await session(options,"ovd561_seed",options.suffix.map((entry) => entry.sql).join("\n"));
    assert.equal(applied.code,0,applied.stderr);
    const allowlist = await session(options,"ovd561_seed",`select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname in ('public','engineering_private','storage')
        and has_schema_privilege('engineering_native_verifier',n.oid,'USAGE')
        and has_function_privilege('engineering_native_verifier',p.oid,'EXECUTE');`);
    assert.equal(allowlist.code,0,allowlist.stderr); assert.equal(allowlist.stdout,"7");
    const currentBehavior = await session(options,"ovd561_seed",`${fixturePrefix}\n${proof}\nrollback;`);
    assert.equal(currentBehavior.code,0,currentBehavior.stderr);
    assert.ok(!/not ok/.test(currentBehavior.stdout),"Current-source finalization behavior failed.");
    assert.equal(currentBehavior.stdout.split("ovd561-proof-start")[1]?.match(/^ok\b/gm)?.length,24);
  }
  if (options.firstLoopProof) {
    const { runFirstLoopProof } = await import("./first-loop-local-sql.mjs");
    const firstLoop = await runFirstLoopProof({ proof: options.firstLoopProof,
      session: (sql, timeout) => session(options, "ovd561_seed", sql, timeout),
      deadline: options.deadline, record: options.recordFirstLoop });
    options.recordFirstLoop({ status: "passed", ...firstLoop });
  }
  const seeded = await session(options,"ovd561_seed",seed);
  assert.equal(seeded.code,0,seeded.stderr);
  assert.ok(!/not ok/.test(seeded.stdout),"Ownership fixture assertions failed in race seed.");
  const run = (sql) => session(options,"ovd561_case",sql);
  const finish = `select ${schema}.finish();`;
  const scalar = async (sql) => {
    const result = await run(sql); assert.equal(result.code,0,result.stderr); return result.stdout;
  };
  const verdicts = [];
  async function scenario(name, body) {
    psql("create database ovd561_case template ovd561_seed;");
    try { await body(); verdicts.push({ name, status: "passed" }); }
    finally { psql("drop database ovd561_case with (force);"); }
  }
  await scenario("concurrent_exact_replay", async () => {
    const first = run(`begin; set application_name='ovd561-first'; ${finish} select pg_sleep(1.5); commit;`);
    await barrier(psql,"ovd561_case","ovd561-first","PgSleep");
    const second = run(`begin; set application_name='ovd561-second'; ${finish} commit;`);
    await barrier(psql,"ovd561_case","ovd561-second","advisory");
    const results = await Promise.all([first,second]);
    for (const result of results) assert.equal(result.code,0,result.stderr);
    const receipt = (result) => JSON.parse(result.stdout.split("\n").find((line) => line.startsWith("{")));
    assert.deepEqual(receipt(results[0]),receipt(results[1]));
    assert.equal(await scalar("select count(*) from engineering_private.native_finalizations;"),"1");
    const denied = await run(`select ${schema}.finish('{}',false,false,true);`);
    assert.notEqual(denied.code,0); assert.match(denied.stderr,/ovd561_conflicting_replay/);
  });
  const cases = [
    ["access_revocation", `update engineering_private.engineering_operators set enabled=false;`],
    ["admission_revocation", `insert into engineering_private.native_admission_revocations(runtime_admission_id,revoked_by,reason)
      values(${schema}.n(60),${schema}.n(1),'synthetic race');`],
    ["worker_revocation", `update public.engineering_workers set revoked_at=clock_timestamp(),revision=revision+1 where id=${schema}.n(50);`],
    ["cancellation", `update public.engineering_tasks set execution_state='canceled' where id=${schema}.task(1,31);`],
    ["current_attempt_fence", `update public.engineering_task_execution set current_attempt_id=null,revision=revision+1 where task_id=${schema}.task(1,31);`],
    ["storage_substitution", `update storage.objects set version='substituted' where bucket_id='ovd561-synthetic';`],
  ];
  for (const [name, mutation] of cases) {
    await scenario(`lockwait_${name}`, async () => {
      const blocker = run(`begin; set application_name='ovd561-blocker';
        select pg_advisory_xact_lock(hashtextextended('engineering-native:'||${schema}.n(4)::text,0));
        ${mutation} select pg_sleep(1.5); commit;`);
      await barrier(psql,"ovd561_case","ovd561-blocker","PgSleep");
      const finalizer = run(`begin; set application_name='ovd561-finalizer'; ${finish} commit;`);
      await barrier(psql,"ovd561_case","ovd561-finalizer","advisory");
      const [blocked, result] = await Promise.all([blocker,finalizer]);
      assert.equal(blocked.code,0,blocked.stderr);
      assert.notEqual(result.code,0); assert.match(result.stderr,/ovd561_(stale_or_foreign_receipt|registry_mismatch)/);
      assert.equal(await scalar("select count(*) from engineering_private.native_finalizations;"),"0");
      assert.equal(await scalar(`select execution_state from public.engineering_tasks where id=${schema}.task(2,31);`),"blocked");
    });
  }
  await scenario("lockwait_receipt_expiry", async () => {
    // Move only the synthetic clock origin; real attempt identities remain immutable.
    await scalar(`alter table public.engineering_execution_attempts disable trigger native_identity;
      update public.engineering_execution_attempts set claimed_at=now()-interval '6 minutes',
        deadline_at=now()+interval '4 minutes',lease_expires_at=now()+interval '1 minute'
        where id=${schema}.other_attempt();
      alter table public.engineering_execution_attempts enable trigger native_identity;
      update public.ovd561_request set payload=(payload::jsonb||jsonb_build_object('issuedAt',clock_timestamp()-interval '299 seconds'))::text;`);
    const blocker = run(`begin; set application_name='ovd561-blocker';
      select pg_advisory_xact_lock(hashtextextended('engineering-native:'||${schema}.n(4)::text,0)); select pg_sleep(2); commit;`);
    await barrier(psql,"ovd561_case","ovd561-blocker","PgSleep");
    const finalizer = run(`begin; set application_name='ovd561-finalizer'; ${finish} commit;`);
    await barrier(psql,"ovd561_case","ovd561-finalizer","advisory");
    const results = await Promise.all([blocker,finalizer]);
    assert.equal(results[0].code,0,results[0].stderr);
    assert.notEqual(results[1].code,0); assert.match(results[1].stderr,/ovd561_stale_or_foreign_receipt/);
  });
  await scenario("newer_occupancy_preserved", async () => {
    await scalar(`begin; set local role authenticated;
      select set_config('request.jwt.claim.sub',${schema}.n(1)::text,true);
      select public.api_submit_engineering_message(${schema}.n(4),${schema}.n(7),${schema}.n(32),${schema}.n(20),0,${schema}.n(995),'Depth 8 mm');
      reset role;
      select public.api_resolve_engineering_request(r.id,0,${schema}.n(996),'prepared_change',8,'Independent synthetic change',
        jsonb_build_object('model','fixture','promptVersion','v1','schemaVersion','overdrafter.prepared-interpretation.v1',
          'policyVersion','prepared-depth-v1','inputSha256',encode(extensions.digest(m.body,'sha256'),'hex'),'contextSha256',s.context_sha256))
        from public.engineering_requests r join public.engineering_messages m on m.id=r.message_id
          join public.engineering_snapshots s on s.id=r.input_snapshot_id where r.conversation_id=${schema}.n(32);
      set local role service_role; select ${schema}.claim(1,32,997); commit;`);
    const before = await scalar(`select active_attempt_id::text||':'||fence::text from engineering_private.native_slots where organization_id=${schema}.n(4);`);
    assert.match(before,/:3$/,"A real newer attempt must own fence 3.");
    await scalar(finish);
    assert.equal(await scalar(`select active_attempt_id::text||':'||fence::text from engineering_private.native_slots where organization_id=${schema}.n(4);`),before);
  });
  await scenario("lockwait_deadline", async () => {
    await scalar(`alter table public.engineering_execution_attempts disable trigger native_identity;
      update public.engineering_execution_attempts set claimed_at=now()-interval '599 seconds',
        deadline_at=now()+interval '1 second',lease_expires_at=now()+interval '1 second'
        where id=${schema}.other_attempt();
      alter table public.engineering_execution_attempts enable trigger native_identity;`);
    const blocker = run(`begin; set application_name='ovd561-blocker';
      select 1 from storage.objects where bucket_id='ovd561-synthetic' for update;
      select pg_sleep(2); commit;`);
    await barrier(psql,"ovd561_case","ovd561-blocker","PgSleep");
    const finalizer = run(`begin; set application_name='ovd561-finalizer'; ${finish} commit;`);
    await barrier(psql,"ovd561_case","ovd561-finalizer","transactionid");
    const results = await Promise.all([blocker,finalizer]);
    assert.equal(results[0].code,0,results[0].stderr);
    assert.notEqual(results[1].code,0); assert.match(results[1].stderr,/ovd561_stale_or_foreign_receipt/);
    assert.equal(await scalar("select count(*) from engineering_private.native_finalizations;"),"0");
  });
  await scenario("repeatable_read_rejected", async () => {
    const result = await run(`begin isolation level repeatable read; ${finish} commit;`);
    assert.notEqual(result.code,0); assert.match(result.stderr,/ovd561_read_committed_required/);
  });
  await scenario("rollback_waits_for_completion", async () => {
    const first = run(`begin; set application_name='ovd561-first'; ${finish} select pg_sleep(1.5); commit;`);
    await barrier(psql,"ovd561_case","ovd561-first","PgSleep");
    const reverse = run(`set application_name='ovd561-reverse'; ${options.reverse}`);
    await barrier(psql,"ovd561_case","ovd561-reverse","relation");
    const results = await Promise.all([first,reverse]);
    assert.equal(results[0].code,0,results[0].stderr);
    assert.notEqual(results[1].code,0); assert.match(results[1].stderr,/ovd561_reverse_requires_empty_history/);
    assert.equal(await scalar("select count(*) from engineering_private.native_finalizations;"),"1");
  });
  psql("drop database ovd561_seed with (force);");
  return verdicts;
}
