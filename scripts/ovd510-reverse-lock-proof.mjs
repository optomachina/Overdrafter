/** OVD-737: live session proof that the staged OVD-558 reverse locks first and
 * refuses any isolation other than READ COMMITTED. Runs inside the owned fixture
 * after the forward is applied; every scenario leaves the catalog unchanged. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const registry = "engineering_private.native_verifier_registered_objects";
const lockMarker = "end $ovd558_reverse_lock$;\n";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function session({ dockerExecutable, container, password }, name, sql) {
  const child = spawn(dockerExecutable, ["exec", "-i", "-e", `PGPASSWORD=${password}`, container,
    "psql", "-U", "supabase_admin", "-d", "postgres", "-X", "-Atq",
    "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose"],
  { stdio: ["pipe", "pipe", "pipe"], timeout: 240_000 });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(`set application_name = '${name}';\n${sql}`);
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.slice(-4000) }));
  });
}

async function barrier(psql, name, event) {
  for (let i = 0; i < 200; i++) {
    if (psql(`select exists(select 1 from pg_stat_activity where datname = 'postgres'
      and application_name = '${name}' and wait_event = '${event}');`) === "t") return;
    await pause(50);
  }
  throw new Error(`ovd737_barrier_missing:${name}:${event}`);
}

export async function runOvd558ReverseLockProof(options) {
  const { psql, catalog, expectedCatalog, reverseSql } = options;
  assert.equal(reverseSql.split(lockMarker).length, 2, "ovd737_lock_marker_drift");
  assert.ok(reverseSql.endsWith("\ncommit;\n"), "ovd737_commit_marker_drift");
  const unchanged = (label) => assert.equal(catalog(), expectedCatalog, `ovd737_catalog_drift:${label}`);
  const rows = () => Number(psql(`select count(*) from ${registry};`, 30_000, "supabase_admin"));
  const results = {};

  // 1. Anything but READ COMMITTED is refused before the lock or any read.
  for (const level of ["repeatable read", "serializable"]) {
    const run = await session(options, "ovd737_isolation",
      `set session characteristics as transaction isolation level ${level};\n${reverseSql}`);
    assert.notEqual(run.code, 0, `ovd737_isolation_not_refused:${level}`);
    assert.match(run.stderr, /ERROR:\s+0A000: ovd558_reverse_read_committed_required/,
      `ovd737_isolation_wrong_error:${level}`);
    unchanged(level);
    results[level.replace(" ", "_")] = "refused_0A000";
  }

  // 2. A registry writer that commits while the reverse waits for the lock is
  // seen by the emptiness check; its row is retained and the reverse refuses.
  const writer = session(options, "ovd737_writer", `begin;
insert into ${registry} values ('ovd737', 'committed-during-wait');
select pg_sleep(4);
commit;`);
  await barrier(psql, "ovd737_writer", "PgSleep");
  const blocked = session(options, "ovd737_reverse", reverseSql);
  await barrier(psql, "ovd737_reverse", "relation");
  const committed = await writer;
  assert.equal(committed.code, 0, committed.stderr);
  const refused = await blocked;
  assert.notEqual(refused.code, 0, "ovd737_reverse_ignored_committed_writer");
  assert.match(refused.stderr, /ovd558_reverse_runner_or_registry_mismatch/, refused.stderr);
  assert.equal(rows(), 1, "ovd737_committed_row_not_retained");
  psql(`delete from ${registry} where bucket_id = 'ovd737';`, 30_000, "supabase_admin");
  unchanged("writer_committed_first");
  results.writerCommittedDuringWait = "reverse_refused_row_retained";

  // 3. A writer that arrives after the lock waits for the reverse to finish.
  // The reverse is held after its lock and rolled back by an injected failure.
  const held = reverseSql.replace(lockMarker, `${lockMarker}select pg_sleep(4);\n`)
    .replace(/\ncommit;\n$/, "\ndo $ovd737_injected$ begin raise exception 'ovd737_injected_rollback'; end $ovd737_injected$;\ncommit;\n");
  const holder = session(options, "ovd737_holder", held);
  await barrier(psql, "ovd737_holder", "PgSleep");
  const waiter = session(options, "ovd737_waiter",
    `insert into ${registry} values ('ovd737', 'waited-for-lock');`);
  await barrier(psql, "ovd737_waiter", "relation");
  const timedOut = await session(options, "ovd737_timeout",
    `set lock_timeout = '500ms';\ninsert into ${registry} values ('ovd737', 'timed-out');`);
  assert.match(timedOut.stderr, /ERROR:\s+55P03:/, "ovd737_writer_not_blocked");
  const rolledBack = await holder;
  assert.match(rolledBack.stderr, /ovd737_injected_rollback/, rolledBack.stderr);
  const waited = await waiter;
  assert.equal(waited.code, 0, waited.stderr);
  assert.equal(rows(), 1, "ovd737_waiting_writer_row_missing");
  psql(`delete from ${registry} where bucket_id = 'ovd737';`, 30_000, "supabase_admin");
  unchanged("writer_waits_for_lock");
  results.writerAfterLock = "waited_then_committed_after_rollback";
  results.lockTimeoutWriter = "55P03";
  return results;
}
