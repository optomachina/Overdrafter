/** Real PostgreSQL deadline barriers with simulated native admissions. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { storedNativeFixture } from "../server/engineering/native-result-fixture";
import { verifyStoredNativeCandidate } from "../server/engineering/native-result-bytes";
import { q, sql, call, stoppedFixture, waitFor } from "./lib/native-result-db-fixtures.mjs";

const exec = promisify(execFile);
const args = ["exec", "-i", process.argv[2], "psql", "-U", "postgres", "-d", "ovd505_native_results", "-Atq", "-v", "ON_ERROR_STOP=1"];
for (const action of ["complete", "reject"]) {
for (const kind of ["run", "principal"]) {
  const f = await stoppedFixture(false, storedNativeFixture);
  const verified = await verifyStoredNativeCandidate(f.prepared.admission, f.prepared.reader);
  const principal = randomUUID(), run = randomUUID(), name = `ovd505-deadline-${randomUUID()}`;
  // Both records are immutable; construct fresh near-expiry fixtures. The
  // expiry itself is observed against the database clock, not a fixed sleep.
  await sql(`begin;
    insert into engineering_private.native_verifier_principals(id,organization_id,project_id,source_sha256,policy_version,validator_version,admitted_by,admitted_at,expires_at)
      values(${q(principal)},${q(f.org)},${q(f.project)},repeat('a',64),'prepared-native-reports-v1','deadline-fixture',${q(f.actor)},
        clock_timestamp(),clock_timestamp()+interval '${kind === "principal" ? "3 seconds" : "10 minutes"}');
    insert into engineering_private.native_verification_runs(id,principal_id,idempotency_key,manifest_id,attempt_id,organization_id,project_id,attempt_revision,created_at,expires_at)
      select ${q(run)},${q(principal)},gen_random_uuid(),${q(f.manifest)},${q(f.attempt)},${q(f.org)},${q(f.project)},1,t,t+interval '60 seconds'
      from (select clock_timestamp()-interval '${kind === "run" ? "57 seconds" : "0 seconds"}' as t) timing;
    commit;`);
  let lock = `select id from engineering_private.native_runtime_admissions where id=${q(f.runtime)} for update`;
  if (action === "reject") {
    const fn = `ovd505_reject_${randomUUID().replaceAll("-", "")}`, lockKey = `rejection:${f.org}`;
    await sql(`create function engineering_private.${fn}() returns trigger language plpgsql set search_path='' as $$ begin
      perform pg_advisory_xact_lock(hashtextextended(${q(lockKey)},0));return new;end;$$;
      create trigger ${fn} before insert on engineering_private.native_verification_failures for each row
        when(new.organization_id=${q(f.org)}::uuid) execute function engineering_private.${fn}()`);
    lock = `select pg_advisory_xact_lock(hashtextextended(${q(lockKey)},0))`;
  }
  const guard = exec("docker", args, { timeout: 20_000 });
  const guarded = guard.then(() => ({ ok: true }), error => ({ ok: false, error }));
  const guardName = `${name}-guard`;
  guard.child.stdin!.write(`begin;set local idle_in_transaction_session_timeout='15s';set local application_name=${q(guardName)};
    ${lock};\n`);
  let completion;
  try {
    await waitFor(`select exists(select 1 from pg_stat_activity where application_name=${q(guardName)} and state='idle in transaction')`);
    let expression = `public.api_complete_native_verification(${q(run)},${q(JSON.stringify(verified.context))})`;
    if (action === "reject") expression = `public.api_reject_native_verification(${q(run)},${q(JSON.stringify({
      schema: "overdrafter.native-verification-failure.v1", code: "native_evidence_rejected", reason: "Native evidence validation failed",
      objectId: null, observedBytes: null, observedSha256: null,
    }))}::jsonb)`;
    completion = call({ ...f, actor: principal }, expression, name, "engineering_native_verifier")
      .then(value => ({ value }), error => ({ error }));
    await waitFor(`select exists(select 1 from pg_stat_activity where application_name=${q(name)} and wait_event=${q(action === "reject" ? "advisory" : "transactionid")})`);
    const table = kind === "run" ? "native_verification_runs" : "native_verifier_principals";
    await waitFor(`select expires_at<=clock_timestamp() from engineering_private.${table} where id=${q(kind === "run" ? run : principal)}`);
  } finally {
    guard.child.stdin!.end("commit;\n");
    assert.equal((await guarded).ok, true);
  }
  const outcome = await completion;
  assert.match(outcome?.error?.stderr ?? "", /PT409|42501/, `${action}/${kind} expiry after the lock wait must prevent commit`);
  assert.equal(await sql(`select count(*) from engineering_private.native_verification_receipts where verification_run_id=${q(run)}`), "0");
  assert.equal(await sql(`select head_snapshot_id from public.engineering_conversations where id=${q(f.conversation)}`), f.snapshot);
  assert.equal(await sql(`select count(*) from engineering_private.native_verification_failures where attempt_id=${q(f.attempt)}`), "0");
}
}
console.log(JSON.stringify({ outcome: "passed", postWaitRunAndPrincipalExpiry: true, postCheckRejectionExpiry: true, simulatedNativeAdmissions: true, productionChanged: false }));
