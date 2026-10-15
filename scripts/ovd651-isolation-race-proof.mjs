#!/usr/bin/env node
// OVD-651 two-session isolation race proof for staged result SQL.
// Disposable local PostgreSQL only: the target must be a Unix socket or
// localhost, and the script creates and drops its own database. Narrow stub
// tables stand in for the canonical schema, so this proves the lock and
// snapshot ordering of the staged files, not full migration qualification.
//
// Usage: PGHOST=/path/to/socket PGPORT=55432 PGUSER=postgres \
//   node scripts/ovd651-isolation-race-proof.mjs [--source-rev <git rev>]
// With --source-rev the staged files are read from that revision, so a
// pre-fix revision is expected to reproduce the unsafe outcomes.
// Binaries are absolute paths (default /usr/bin), never a PATH lookup;
// override with absolute OVD651_PSQL and OVD651_GIT.
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { randomBytes } from "node:crypto";

const binary = (name, fallback) => {
  const value = process.env[name] ?? fallback;
  if (!isAbsolute(value)) throw new Error(`ovd651_race_requires_absolute_binary:${name}`);
  return value;
};
const psqlBin = binary("OVD651_PSQL", "/usr/bin/psql");
const gitBin = binary("OVD651_GIT", "/usr/bin/git");

// libpq would let PGHOSTADDR or a service file silently pick another server,
// so both are refused and host and port are passed explicitly.
if (process.env.PGHOSTADDR || process.env.PGSERVICE || process.env.PGSERVICEFILE) {
  throw new Error("ovd651_race_refuses_pghostaddr_or_pgservice");
}
const host = process.env.PGHOST ?? "";
const port = process.env.PGPORT ?? "5432";
// A comma makes libpq treat the value as a host list ("/x,remote.host"), so
// the local check must see exactly one host.
if (host.includes(",") || !(host.startsWith("/") || host === "localhost" || host === "127.0.0.1")
  || !/^\d+$/.test(port)) {
  throw new Error("ovd651_race_requires_local_disposable_postgres");
}
const revIndex = process.argv.indexOf("--source-rev");
const sourceRev = revIndex > 0 ? process.argv[revIndex + 1] : null;
const source = (path) => sourceRev
  ? execFileSync(gitBin, ["show", `${sourceRev}:${path}`], { encoding: "utf8" })
  : readFileSync(path, "utf8");

const database = `ovd651_race_${randomBytes(4).toString("hex")}`;
const psqlArgs = (db) => ["-h", host, "-p", port, "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-d", db];
const admin = (sql, db = "postgres") =>
  execFileSync(psqlBin, [...psqlArgs(db), "-c", sql], { encoding: "utf8" }).trim();
const run = (sql) => execFileSync(psqlBin, psqlArgs(database), { input: sql, encoding: "utf8" }).trim();

// An interactive session: SQL is written incrementally and \echo markers
// synchronize with the harness. ON_ERROR_STOP ends the process on error.
function session(name, env = {}) {
  const child = spawn(psqlBin, psqlArgs(database), { env: { ...process.env, ...env } });
  let out = ""; let err = ""; let marker = 0;
  child.stdout.on("data", (chunk) => { out += chunk; });
  child.stderr.on("data", (chunk) => { err += chunk; });
  const exited = new Promise((resolve) => child.on("close", (code) => resolve(code)));
  return {
    name, exited,
    get ended() { return child.exitCode !== null; },
    get stderr() { return err; },
    send(sql) { child.stdin.write(`${sql}\n`); },
    async step(sql, timeoutMs = 10_000) {
      const tag = `${name}_mark_${++marker}`;
      child.stdin.write(`${sql}\n\\echo ${tag}\n`);
      const started = Date.now();
      while (!out.includes(tag)) {
        if (child.exitCode !== null) throw new Error(`${name}_exited:${err.trim()}`);
        if (Date.now() - started > timeoutMs) throw new Error(`${name}_step_timeout:${sql}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
    async finish() { child.stdin.end(); return { code: await exited, stderr: err }; },
  };
}

// Wait until the waiter is blocked on a heavyweight lock, or has already
// ended (a guard that refuses before locking never waits).
async function waitBlocked(waiter, timeoutMs = 10_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (waiter.ended) return;
    const blocked = run(`select count(*) from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock';`);
    if (blocked !== "0") return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("ovd651_expected_lock_wait_not_observed");
}

// Roles are cluster wide; missing ones are created once and removed at exit.
const baseFixture = `
create schema engineering_private;
grant usage on schema engineering_private to engineering_native_verifier;
alter default privileges in schema engineering_private revoke execute on functions from public;
alter default privileges in schema public revoke execute on functions from public;
`;

// OVD-560 shape after forward: the dropped columns hold the result binding,
// and storage_object_id keeps its foreign key to storage.objects, so the drop
// needs the storage.objects lock as on the real schema.
const storageObject = "00000000-0000-4000-8000-0000000000f1";
const attemptId = "00000000-0000-4000-8000-0000000000a1";
const snapshotId = "00000000-0000-4000-8000-0000000000c1";
// The attempt and snapshot parents carry the registry's foreign keys, as on the
// real schema, so dropping the registry columns locks them too.
const registryFixture = `
create table public.engineering_execution_attempts (id uuid primary key);
create table public.engineering_snapshots (id uuid primary key);
insert into public.engineering_execution_attempts values ('${attemptId}');
insert into public.engineering_snapshots values ('${snapshotId}');
create schema storage;
create table storage.objects (id uuid primary key, bucket_id text, name text);
insert into storage.objects values ('${storageObject}', 'result-bucket', 'task/attempt/result.json');
create table engineering_private.native_verifier_registered_objects (
  bucket_id text not null, object_name text not null,
  organization_id uuid, project_id uuid, task_id uuid,
  attempt_id uuid references public.engineering_execution_attempts(id), fence bigint,
  input_snapshot_id uuid references public.engineering_snapshots(id), candidate_snapshot_id uuid, artifact_role text,
  storage_object_id uuid references storage.objects(id), storage_version text, storage_updated_at timestamptz,
  byte_length bigint, sha256 text, registered_at timestamptz,
  constraint native_result_bucket_name_bound check (octet_length(bucket_id) > 0));
create function engineering_private.register_native_result_object(uuid,uuid,uuid,uuid,bigint,uuid,uuid,text,text,text,uuid,text,timestamptz,bigint,text)
  returns void language sql as 'select';
create function engineering_private.native_result_registration_immutable() returns trigger
  language plpgsql as 'begin raise exception ''immutable''; end';
create trigger native_result_registration_immutable before update or delete
  on engineering_private.native_verifier_registered_objects
  for each row execute function engineering_private.native_result_registration_immutable();
create function engineering_private.native_verifier_can_read_object(text,text) returns boolean
  language sql as 'select false';
grant execute on function engineering_private.native_verifier_can_read_object(text,text) to engineering_native_verifier;
do $grants$ begin
  for i in 1..6 loop
    execute format('create function engineering_private.verifier_stub_%s() returns void language sql as ''select''', i);
    execute format('grant execute on function engineering_private.verifier_stub_%s() to engineering_native_verifier', i);
  end loop;
end $grants$;
`;
const registryRow = `insert into engineering_private.native_verifier_registered_objects values
  ('result-bucket','task/attempt/result.json',gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),
   '${attemptId}',1,'${snapshotId}',gen_random_uuid(),'result',
   '${storageObject}','v1',now(),10,repeat('a',64),now());`;
const registryState = () => run(`select count(*)||':'||coalesce((select count(*) from pg_attribute
  where attrelid='engineering_private.native_verifier_registered_objects'::regclass
  and attname='attempt_id' and not attisdropped),0)
  from engineering_private.native_verifier_registered_objects;`);

const stepFixture = `
create table engineering_private.native_step_reviews (id uuid primary key, step_bytes bytea not null);
create function engineering_private.step_review_owner() returns boolean language sql as $$select current_user='postgres'$$;
create function engineering_private.assert_empty_native_step_reviews() returns void language plpgsql
  security invoker set search_path = '' as $body$
begin
  if not engineering_private.step_review_owner()
    or exists(select 1 from engineering_private.native_step_reviews) then
    raise exception 'ovd563_review_history_present';
  end if;
end $body$;
create function public.api_read_native_step_review(uuid,uuid,uuid) returns void language sql as 'select';
create function engineering_private.associate_native_step_review(uuid,uuid,uuid,text,text,uuid,text,text,text,bytea)
  returns boolean language sql as 'select true';
create function engineering_private.sha256_hex(bytea) returns text language sql as 'select null::text';
create function engineering_private.valid_sha256(text) returns boolean language sql as 'select true';
`;
const stepState = () => run(`select coalesce(to_regclass('engineering_private.native_step_reviews')::text,'dropped')
  || ':' || case when to_regclass('engineering_private.native_step_reviews') is null then '0'
  else (xpath('/row/c/text()', query_to_xml('select count(*) as c from engineering_private.native_step_reviews', false, true, '')))[1]::text end;`);

// Narrow stand-ins for every relation and helper the admission writer reads.
const readerFixture = `
create function engineering_private.register_native_result_object(uuid,uuid,uuid,uuid,bigint,uuid,uuid,text,text,text,uuid,text,timestamptz,bigint,text)
  returns void language sql as 'select';
create function engineering_private.finalize_native_result(text,text,text,uuid) returns jsonb language sql as 'select null::jsonb';
create function engineering_private.reject_engineering_history_mutation() returns trigger
  language plpgsql as $$begin raise exception 'history immutable' using errcode='55000'; end$$;
create table public.organization_memberships (user_id uuid, organization_id uuid);
create table public.project_memberships (user_id uuid, project_id uuid);
create table public.projects (id uuid);
create table engineering_private.engineering_operators (user_id uuid);
create table engineering_private.native_admission_revocations (runtime_admission_id uuid, input_admission_id uuid);
create table public.engineering_workers (id uuid primary key, revoked_at timestamptz, current_boot_id uuid);
create table public.engineering_execution_attempts (
  id uuid primary key, task_id uuid, worker_id uuid, boot_id uuid, stop_admission_id uuid, phase text,
  result_eligible boolean, deadline_at timestamptz, owner_user_id uuid, organization_id uuid, project_id uuid,
  runtime_admission_id uuid, input_admission_id uuid, job_sha256 text, job_text text);
create table public.engineering_task_execution (task_id uuid, current_attempt_id uuid);
create table engineering_private.native_stop_admissions (id uuid, attempt_id uuid, authority text,
  execution_outcome text, evidence_sha256 text, journal_sha256 text);
create table engineering_private.native_observer_evidence (id uuid primary key, attempt_id uuid,
  manifest_sha256 text, journal_sha256 text, execution_outcome text, journal_bytes bytea);
create table engineering_private.native_stop_qualifications (evidence_id uuid primary key, attempt_id uuid,
  scope text, job_sha256 text, context_sha256 text, manifest_sha256 text, journal_sha256 text);
create function engineering_private.engineering_actor_access(p_user uuid, p_org uuid, p_project uuid)
  returns boolean language sql stable as $$
  select exists(select 1 from public.organization_memberships where user_id=p_user and organization_id=p_org)$$;
create function engineering_private.native_observer_has_keys(p jsonb, k text[]) returns boolean
  language sql immutable as $$select jsonb_typeof(p)='object' and
  (select array_agg(x order by x) from jsonb_object_keys(p) x) = (select array_agg(y order by y) from unnest(k) y)$$;
create function engineering_private.native_observer_valid_windows_path(p text, allow_root boolean) returns boolean
  language sql immutable as $$select p ~ '^[A-Z]:\\\\'$$;
insert into public.engineering_workers values ('00000000-0000-4000-8000-000000000b01', null, '00000000-0000-4000-8000-000000000b02');
insert into public.organization_memberships values ('00000000-0000-4000-8000-000000000c01','00000000-0000-4000-8000-000000000c02');
insert into public.engineering_execution_attempts values ('00000000-0000-4000-8000-000000000a01','00000000-0000-4000-8000-000000000a00',
  '00000000-0000-4000-8000-000000000b01','00000000-0000-4000-8000-000000000b02','00000000-0000-4000-8000-000000000d01',
  'awaiting_result',true,now()+interval '1 day','00000000-0000-4000-8000-000000000c01','00000000-0000-4000-8000-000000000c02',
  '00000000-0000-4000-8000-000000000c03','00000000-0000-4000-8000-000000000e01','00000000-0000-4000-8000-000000000e02',
  repeat('1',64),'{"contextSha256":"${"2".repeat(64)}"}');
insert into public.engineering_task_execution values ('00000000-0000-4000-8000-000000000a00','00000000-0000-4000-8000-000000000a01');
insert into engineering_private.native_stop_admissions values ('00000000-0000-4000-8000-000000000d01','00000000-0000-4000-8000-000000000a01',
  'qualified_worker_validator','native_exit_succeeded',repeat('3',64),repeat('4',64));
insert into engineering_private.native_observer_evidence values ('00000000-0000-4000-8000-000000000f01','00000000-0000-4000-8000-000000000a01',
  repeat('3',64),repeat('4',64),'native_exit_succeeded',convert_to('{"records":[
   {"kind":"launch_intent","data":{"launchId":"n","role":"native"}},
   {"kind":"process_started","data":{"launchId":"n","pid":101,"creationTicks":"9001"}},
   {"kind":"launch_intent","data":{"launchId":"o","role":"operation"}},
   {"kind":"process_started","data":{"launchId":"o","pid":102,"creationTicks":"9002"}}]}','UTF8'));
insert into engineering_private.native_stop_qualifications values ('00000000-0000-4000-8000-000000000f01','00000000-0000-4000-8000-000000000a01',
  'prepared_native_exact_attempt_v1',repeat('1',64),repeat('2',64),repeat('3',64),repeat('4',64));
`;
const admitCall = `select engineering_private.admit_native_result_read_binding(
  '00000000-0000-4000-8000-000000000a00','00000000-0000-4000-8000-000000000a01','00000000-0000-4000-8000-000000000f01',
  '{"input":{"path":"C:\\\\in","volumeSerial":"00000000000000a1","fileId":"000000000000000000000000000000b1"},
    "candidate":{"path":"C:\\\\out","volumeSerial":"00000000000000a1","fileId":"000000000000000000000000000000b2"}}'::jsonb,
  repeat('a',64));`;
const bindingCount = () => run("select count(*) from engineering_private.native_result_read_bindings;");

const results = [];
const createdRoles = ["engineering_native_verifier", "anon", "authenticated", "service_role"]
  .filter((role) => admin(`select count(*) from pg_roles where rolname = '${role}';`) === "0");
for (const role of createdRoles) admin(`create role ${role} nologin;`);
process.on("exit", () => { for (const role of createdRoles) admin(`drop role if exists ${role};`); });
async function scenario(name, fixture, body) {
  admin(`create database ${database};`);
  try {
    run(baseFixture + fixture);
    const outcome = await body();
    results.push({ name, ...outcome });
  } finally {
    admin(`drop database ${database} with (force);`);
  }
}

const reverse560 = source("docs/release/ovd-560-result-registry-reverse.sql");
const reverse563 = source("docs/release/ovd-563-step-review-reverse.sql");
const reader = source("docs/release/native-result-reader-forward.sql");
const repeatable = { PGOPTIONS: "-c default_transaction_isolation=repeatable\\ read" };
const stripTransaction = (sql) => sql.replace(/^begin;$/m, "").replace(/^commit;$/m, "");

// Finding 1: a registration commits while the reverse is in flight.
await scenario("560_reverse_concurrent_registration", registryFixture, async () => {
  const writer = session("writer");
  await writer.step(`begin; ${registryRow}`);
  const reverser = session("reverser");
  reverser.send(reverse560);
  await waitBlocked(reverser);
  await writer.step("commit;");
  const { code, stderr } = await reverser.finish();
  await writer.finish();
  const [rows, bindingColumn] = registryState().split(":");
  return { reverseExit: code, refusal: stderr.match(/ovd560_[a-z_]+/)?.[0] ?? null,
    rows: Number(rows), bindingRetained: bindingColumn === "1",
    safe: code !== 0 && bindingColumn === "1" && rows === "1" };
});
await scenario("560_reverse_repeatable_read_refused", registryFixture, async () => {
  const reverser = session("reverser", repeatable);
  reverser.send(reverse560);
  const { code, stderr } = await reverser.finish();
  const [, bindingColumn] = registryState().split(":");
  return { reverseExit: code, refusal: stderr.match(/ovd560_[a-z_]+/)?.[0] ?? null,
    safe: code !== 0 && /read_committed/.test(stderr) && bindingColumn === "1" };
});

await scenario("560_reverse_empty_positive_control", registryFixture, async () => {
  const reverser = session("reverser");
  reverser.send(reverse560);
  const { code } = await reverser.finish();
  const [, bindingColumn] = registryState().split(":");
  return { reverseExit: code, safe: code === 0 && bindingColumn === "0" };
});

// A registration locks its attempt FOR UPDATE, then holds storage.objects FOR
// SHARE, and only then reads the registry, as register_native_result_object
// does. The reverse must take the attempt (and snapshot) parents, then
// storage.objects, then the registry. The pre OVD-743 storage first order
// deadlocks once the column drop asks for the attempt parent; the registry
// first order (cf3a9738) deadlocks on storage.objects.
const attemptsFirstLock = "lock table public.engineering_execution_attempts, public.engineering_snapshots,\n  storage.objects, engineering_private.native_verifier_registered_objects\n  in access exclusive mode;";
const storageFirstLock = "lock table storage.objects, engineering_private.native_verifier_registered_objects\n  in access exclusive mode;";
const registryFirstLock = "lock table engineering_private.native_verifier_registered_objects in access exclusive mode;";
if (!sourceRev && reverse560.split(attemptsFirstLock).length !== 2) throw new Error("ovd651_attempts_first_lock_drift");
const registration = `select id from storage.objects where id = '${storageObject}' for share;
  select count(*) from engineering_private.native_verifier_registered_objects
  where attempt_id = '${attemptId}'; ${registryRow} commit;`;
async function registrationRace(reverseSql) {
  const writer = session("writer");
  await writer.step(`begin; select id from public.engineering_execution_attempts where id = '${attemptId}' for update;`);
  const reverser = session("reverser");
  reverser.send(reverseSql);
  await waitBlocked(reverser);
  writer.send(registration);
  const [written, reversed] = await Promise.all([writer.finish(), reverser.finish()]);
  const [rows, bindingColumn] = registryState().split(":");
  const deadlock = /deadlock detected/.test(written.stderr + reversed.stderr);
  // A committed registration is lost if the reverse still dropped its binding.
  const lostCommittedRow = written.code === 0 && (rows !== "1" || bindingColumn !== "1");
  return { writerExit: written.code, reverseExit: reversed.code, deadlock, lostCommittedRow,
    refusal: reversed.stderr.match(/ovd560_[a-z_]+/)?.[0] ?? null,
    rows: Number(rows), bindingRetained: bindingColumn === "1" };
}
// Controls: the registry first order (cf3a9738) and the storage first order
// (before OVD-743) must reproduce the hazard, or this harness could not tell
// the orders apart.
if (!sourceRev) {
  await scenario("560_reverse_registry_first_registration_control", registryFixture, async () => {
    const outcome = await registrationRace(reverse560.replace(attemptsFirstLock, registryFirstLock));
    return { ...outcome, reproduced: outcome.deadlock || outcome.lostCommittedRow,
      safe: outcome.deadlock || outcome.lostCommittedRow };
  });
  await scenario("560_reverse_storage_first_registration_control", registryFixture, async () => {
    const outcome = await registrationRace(reverse560.replace(attemptsFirstLock, storageFirstLock));
    return { ...outcome, reproduced: outcome.deadlock || outcome.lostCommittedRow,
      safe: outcome.deadlock || outcome.lostCommittedRow };
  });
}
// A registration that slipped past "stop the worker" and then sits idle with
// its attempt locked: the reverse times out on its five second lock_timeout
// (55P03) and changes nothing; the registry and its binding stay.
await scenario("560_reverse_lock_timeout_with_idle_registration", registryFixture, async () => {
  const writer = session("writer");
  await writer.step(`begin; select id from public.engineering_execution_attempts where id = '${attemptId}' for update;`);
  const reverser = session("reverser");
  reverser.send(reverse560);
  const reversed = await reverser.finish();
  await writer.step("rollback;");
  await writer.finish();
  const [, bindingColumn] = registryState().split(":");
  return { reverseExit: reversed.code, lockTimeout: /55P03|lock timeout/.test(reversed.stderr),
    safe: reversed.code !== 0 && /lock timeout/.test(reversed.stderr) && bindingColumn === "1" };
});
await scenario("560_reverse_attempts_first_concurrent_registration", registryFixture, async () => {
  const outcome = await registrationRace(reverse560);
  return { ...outcome, safe: !outcome.deadlock && !outcome.lostCommittedRow && outcome.writerExit === 0
    && outcome.reverseExit !== 0 && outcome.refusal === "ovd560_reverse_requires_empty_exact_registry"
    && outcome.rows === 1 && outcome.bindingRetained };
});

// Finding 2: a snapshot taken before the reverse lock misses committed evidence.
await scenario("563_reverse_stale_repeatable_read_snapshot", stepFixture, async () => {
  const reverser = session("reverser");
  await reverser.step("begin isolation level repeatable read; select count(*) from engineering_private.native_step_reviews;");
  run("insert into engineering_private.native_step_reviews values (gen_random_uuid(), '\\x01');");
  reverser.send(stripTransaction(reverse563));
  reverser.send("commit;");
  const { code, stderr } = await reverser.finish();
  const [table, rows] = stepState().split(":");
  return { reverseExit: code, refusal: stderr.match(/ovd563_[a-z_]+/)?.[0] ?? null,
    table, rows: Number(rows), safe: code !== 0 && table !== "dropped" && rows === "1" };
});
await scenario("563_reverse_concurrent_writer_read_committed", stepFixture, async () => {
  const writer = session("writer");
  await writer.step("begin; insert into engineering_private.native_step_reviews values (gen_random_uuid(), '\\x01');");
  const reverser = session("reverser");
  reverser.send(reverse563);
  await waitBlocked(reverser);
  await writer.step("commit;");
  const { code, stderr } = await reverser.finish();
  await writer.finish();
  const [table, rows] = stepState().split(":");
  return { reverseExit: code, refusal: stderr.match(/ovd563_[a-z_]+/)?.[0] ?? null,
    table, rows: Number(rows), safe: code !== 0 && table !== "dropped" && rows === "1" };
});

await scenario("563_reverse_empty_positive_control", stepFixture, async () => {
  const reverser = session("reverser");
  reverser.send(reverse563);
  const { code } = await reverser.finish();
  const [table] = stepState().split(":");
  return { reverseExit: code, safe: code === 0 && table === "dropped" };
});

// Finding 3: revocation or membership removal commits while admission waits.
for (const [label, change] of [
  ["revocation", "insert into engineering_private.native_admission_revocations values (null, '00000000-0000-4000-8000-000000000e02');"],
  ["membership_removal", "delete from public.organization_memberships;"],
]) {
  for (const [isolation, env] of [["repeatable_read", repeatable], ["read_committed", {}]]) {
    await scenario(`reader_admission_${label}_${isolation}`, readerFixture, async () => {
      run(reader);
      const writer = session("writer");
      await writer.step(`begin; ${change}`);
      const admitter = session("admitter", env);
      admitter.send(`begin; ${admitCall} commit;`);
      await waitBlocked(admitter);
      await writer.step("commit;");
      const { code, stderr } = await admitter.finish();
      await writer.finish();
      const bindings = Number(bindingCount());
      return { admitExit: code, refusal: stderr.match(/native_result_binding_[a-z_]+/)?.[0] ?? null,
        bindings, safe: code !== 0 && bindings === 0 };
    });
  }
}
// Forward preflight: a second application and a missing prerequisite refuse.
await scenario("reader_forward_preflight", readerFixture, async () => {
  run(reader);
  const refusals = [];
  for (const prepare of ["", "drop table engineering_private.native_result_read_bindings cascade; drop function engineering_private.finalize_native_result(text,text,text,uuid);"]) {
    if (prepare) run(prepare);
    const applier = session("applier");
    applier.send(reader);
    const { code, stderr } = await applier.finish();
    refusals.push(code !== 0 && /native_result_binding_preflight_failed/.test(stderr));
  }
  return { refusals, safe: refusals.every(Boolean) };
});
// Positive control: with nothing revoked, READ COMMITTED admission succeeds once.
await scenario("reader_admission_positive_control", readerFixture, async () => {
  run(reader);
  const first = run(admitCall);
  const replay = run(admitCall);
  return { process: first, replayMatches: first === replay, bindings: Number(bindingCount()),
    safe: first === replay && bindingCount() === "1" };
});

const report = { sourceRevision: sourceRev ?? "working-tree", server: admin("show server_version;"), results };
console.log(JSON.stringify(report, null, 2));
if (!sourceRev && results.some((result) => !result.safe)) process.exitCode = 1;
