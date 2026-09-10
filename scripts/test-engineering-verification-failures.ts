/** Real PostgreSQL rejection/recovery with retained native bytes. Native
 * admission, JWT validation and HTTP transport are explicitly simulated. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createNativeVerifier } from "../server/engineering/native-verifier-client";
import { storedNativeFixture } from "../server/engineering/native-result-fixture";
import { verifyStoredNativeCandidate } from "../server/engineering/native-result-bytes";
import { q, sql, call, stoppedFixture, rejected, barrier, waitFor } from "./lib/native-result-db-fixtures.mjs";

const source = "a".repeat(64);
const nativeFailure = { schema: "overdrafter.native-verification-failure.v1", code: "native_evidence_rejected",
  reason: "Native evidence validation failed", objectId: null, observedBytes: null, observedSha256: null };
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function alterReport(p: ReturnType<typeof storedNativeFixture>) {
  const native = JSON.parse(new TextDecoder().decode(p.bytes.native));
  native.final_reopen_geometry_0.depthM = .02;
  p.bytes.native = new TextEncoder().encode(JSON.stringify(native));
  const digest = hash(p.bytes.native);
  for (let index = 1; index <= 5; index++) p.data.result.checks[index].evidenceSha256 = digest;
  p.bytes.result = new TextEncoder().encode(JSON.stringify(p.data.result));
  for (const role of ["native", "result"] as const) {
    const index = p.objects.findIndex(o => o.role === role);
    p.objects[index] = { ...p.objects[index], bytes: p.bytes[role].length, sha256: hash(p.bytes[role]) };
  }
}
function verifierCall(f, expression: string) { return call({ ...f, actor: f.principal }, expression, undefined, "engineering_native_verifier"); }
async function setup(reportFailure = false) {
  const f = await stoppedFixture(false, input => {
    const p = storedNativeFixture(input);
    if (reportFailure) { alterReport(p); }
    return p;
  });
  f.principal = randomUUID(); f.key = randomUUID(); f.reads = 0;
  await sql(`insert into engineering_private.native_verifier_principals(id,organization_id,project_id,source_sha256,policy_version,validator_version,admitted_by,expires_at)
    values(${q(f.principal)},${q(f.org)},${q(f.project)},${q(source)},'prepared-native-reports-v1','failure-fixture',${q(f.actor)},clock_timestamp()+interval '10 minutes')`);
  f.token = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ role: "engineering_native_verifier", sub: f.principal })).toString("base64url")}.fixture-signature`;
  const transport: typeof fetch = async (url, init) => {
    assert.ok(typeof url === "string");
    const requested = new URL(url); assert.equal(requested.origin, "https://verifier.example.test");
    if (requested.pathname.startsWith("/storage/v1/")) {
      const object = f.prepared.objects.find(o => requested.pathname.endsWith(`/${o.id}`)); assert.ok(object);
      f.reads++; return new Response(f.prepared.bytes[object.role]);
    }
    assert.ok(typeof init?.body === "string");
    const body = JSON.parse(init.body);
    if (requested.pathname.endsWith("api_load_native_verification")) return Response.json(await verifierCall(f, `public.api_load_native_verification(${q(body.p_manifest)},${q(body.p_key)})`));
    if (requested.pathname.endsWith("api_complete_native_verification")) return Response.json(await verifierCall(f, `public.api_complete_native_verification(${q(body.p_run)},${q(body.p_context_text)})`));
    assert.ok(requested.pathname.endsWith("api_reject_native_verification"));
    return Response.json(await verifierCall(f, `public.api_reject_native_verification(${q(body.p_run)},${q(JSON.stringify(body.p_failure))})`));
  };
  f.client = createNativeVerifier({ enabled: true, projectUrl: "https://verifier.example.test", apiKey: "fixture", verifierToken: f.token, sourceSha256: source }, transport);
  return f;
}
const load = f => verifierCall(f, `public.api_load_native_verification(${q(f.manifest)},${q(f.key)})`);
const fail = (f, run, failure = nativeFailure) => verifierCall(f, `public.api_reject_native_verification(${q(run)},${q(JSON.stringify(failure))})`);
const count = f => sql(`select count(*) from engineering_private.native_verification_failures where attempt_id=${q(f.attempt)}`);
async function queueSuccessor(f) {
  await sql(`begin;set local request.jwt.claim.sub=${q(f.actor)};
    select public.api_submit_engineering_message(${q(f.org)},${q(f.project)},${q(f.conversation)},${q(f.snapshot)},
      (select revision from public.engineering_conversations where id=${q(f.conversation)}),${q(randomUUID())},'Depth 9 mm');
    select public.api_resolve_engineering_request(r.id,1,gen_random_uuid(),'prepared_change',9,'Second change',
      jsonb_build_object('model','fixture','promptVersion','v1','schemaVersion','overdrafter.prepared-interpretation.v1','policyVersion','prepared-depth-v1',
        'inputSha256',encode(extensions.digest(m.body,'sha256'),'hex'),'contextSha256',s.context_sha256))
      from public.engineering_requests r join public.engineering_messages m on m.id=r.message_id
      join public.engineering_snapshots s on s.id=r.input_snapshot_id
      where r.conversation_id=${q(f.conversation)} and r.interpretation_state='queued';commit;`);
  return sql(`select t.id from public.engineering_tasks t join public.engineering_decisions d on d.id=t.decision_id
    where t.conversation_id=${q(f.conversation)} and d.sequence=2`);
}

const f = await setup(); f.prepared.bytes.target[10] ^= 1;
const successor = await queueSuccessor(f);
const delivery = await load(f);
for (const role of ["anon", "authenticated", "service_role"]) {
  await rejected(call({ ...f, actor: f.principal }, `public.api_reject_native_verification(${q(delivery.runId)},${q(JSON.stringify(nativeFailure))})`, undefined, role), "42501");
}
const result = await f.client.verify(f.manifest, f.key);
assert.equal(result.outcome, "verification_failed"); assert.equal(result.failure.code, "artifact_digest_mismatch");
assert.equal(result.failure.objectId, f.objects.target.id); assert.equal(result.failure.observedSha256, hash(f.prepared.bytes.target));
assert.equal(await count(f), "1"); assert.equal(await sql(`select head_snapshot_id from public.engineering_conversations where id=${q(f.conversation)}`), f.snapshot);
assert.equal(await sql(`select count(*) from engineering_private.native_verification_receipts where attempt_id=${q(f.attempt)}`), "0");
assert.equal(await sql(`select verification_state from public.engineering_tasks where id=${q(f.task)}`), "failed");
assert.equal(await sql(`select execution_outcome from engineering_private.native_stop_admissions where id=${q(f.stop)}`), "native_exit_succeeded");
const blocked = await call(f, `public.api_claim_native_task(${q(f.worker)},${q(f.credential)},${q(f.boot)},${q(successor)},${q(f.runtime)},${q(f.input)},0,${q(randomUUID())})`);
assert.equal(blocked.reason, "verified_predecessor_required");
const reads = f.reads; assert.deepEqual(await f.client.verify(f.manifest, f.key), result); assert.equal(f.reads, reads);
await rejected(fail(f, delivery.runId, { ...result.failure, reason: "Changed reason" }), "PT409");
assert.deepEqual(await call(f, `public.api_get_native_verification_failure(${q(f.attempt)})`, undefined, "authenticated"), result);
await rejected(call({ ...f, actor: randomUUID() }, `public.api_get_native_verification_failure(${q(f.attempt)})`, undefined, "authenticated"), "42501");
for (const role of ["anon", "authenticated", "service_role", "engineering_native_verifier"]) {
  await rejected(sql(`begin;set local role ${role};select * from engineering_private.native_verification_failures;rollback;`), "42501");
}
await rejected(sql(`update engineering_private.native_verification_failures set failure='{}' where attempt_id=${q(f.attempt)}`), "55000");
const revision = await sql(`select revision from public.engineering_task_execution where task_id=${q(f.task)}`);
await rejected(call(f, `public.api_request_native_retry(${q(f.worker)},${q(f.credential)},${q(f.boot)},${q(f.task)},${q(f.attempt)},${revision},${q(randomUUID())})`), "PT409");
const retry = await call(f, `public.api_retry_native_task(${q(f.worker)},${q(f.boot)},${q(f.task)},${q(f.attempt)},${revision},${q(randomUUID())},'Explicit owner retry after reviewing corrupt artifact')`, undefined, "authenticated");
assert.equal(retry.mode, "owner");
const next = await call(f, `public.api_claim_native_task(${q(f.worker)},${q(f.credential)},${q(f.boot)},${q(f.task)},${q(f.runtime)},${q(f.input)},${retry.taskRevision},${q(randomUUID())})`);
assert.equal(next.outcome, "claimed"); assert.notEqual(next.attemptId, f.attempt);
assert.equal(await sql(`select verification_state from public.engineering_tasks where id=${q(f.task)}`), "unverified");
assert.equal(await count(f), "1"); assert.deepEqual(await f.client.verify(f.manifest, f.key), result);
assert.equal(await sql(`select previous_attempt_id from public.engineering_execution_attempts where id=${q(next.attemptId)}`), f.attempt);

const report = await setup(true); await queueSuccessor(report);
const reportResult = await report.client.verify(report.manifest, report.key);
assert.equal(report.reads, 7); assert.equal(reportResult.failure.code, "native_evidence_rejected");
assert.match(reportResult.failure.reason, /extrusion depth/);
const decision = await sql(`select decision_id from public.engineering_tasks where id=${q(report.task)}`);
const queueRevision = await sql(`select revision from public.engineering_change_queues where conversation_id=${q(report.conversation)}`);
await rejected(call(report, `public.api_cancel_engineering_suffix(${q(report.conversation)},${queueRevision},${q(randomUUID())},array[${q(decision)}]::uuid[],'Incomplete suffix')`, undefined, "authenticated"), "PT409");
const suffix = await sql(`select array_agg(id order by sequence) from public.engineering_decisions where conversation_id=${q(report.conversation)}`);
await call(report, `public.api_cancel_engineering_suffix(${q(report.conversation)},${queueRevision},${q(randomUUID())},${q(suffix)}::uuid[],'Cancel rejected change and its suffix')`, undefined, "authenticated");
assert.equal(await sql(`select execution_state from public.engineering_tasks where id=${q(report.task)}`), "canceled");
assert.equal(await count(report), "1");
await call(report, `public.api_control_worker_session(${q(report.worker)},2,${q(randomUUID())},'revoked',null)`, undefined, "authenticated");
assert.deepEqual(await report.client.verify(report.manifest, report.key), reportResult);

for (const kind of ["revoked", "runtime", "canceled", "revision"]) {
  const denied = await setup(), d = await load(denied);
  if (kind === "revoked") await sql(`update engineering_private.native_verifier_principals set revoked_at=clock_timestamp() where id=${q(denied.principal)}`);
  else if (kind === "runtime") await sql(`insert into engineering_private.native_admission_revocations(runtime_admission_id,revoked_by,reason) values(${q(denied.runtime)},${q(denied.actor)},'failure fixture')`);
  else if (kind === "canceled") await sql(`update public.engineering_tasks set execution_state='canceled' where id=${q(denied.task)}`);
  else await sql(`update public.engineering_execution_attempts set revision=revision+1 where id=${q(denied.attempt)}`);
  await rejected(fail(denied, d.runId), kind === "revoked" ? "42501" : "PT409"); assert.equal(await count(denied), "0");
}
const rollback = await setup(), r = await load(rollback);
await rejected(sql(`begin;set local role engineering_native_verifier;set local request.jwt.claim.sub=${q(rollback.principal)};
  select public.api_reject_native_verification(${q(r.runId)},${q(JSON.stringify(nativeFailure))});select 1/0;commit;`), "22012");
assert.equal(await count(rollback), "0"); assert.equal(await sql(`select phase from public.engineering_execution_attempts where id=${q(rollback.attempt)}`), "awaiting_result");
await rejected(fail(rollback, r.runId, { ...nativeFailure, objectId: f.objects.native.id }), "22023");
await rejected(fail(rollback, r.runId, { ...nativeFailure, extra: true }), "23514");
const duplicate = await setup(), duplicateDelivery = await load(duplicate);
await barrier(duplicate, async release => {
  const names = Array.from({ length: 5 }, () => `ovd505-reject-${randomUUID()}`);
  const pending = names.map(name => call({ ...duplicate, actor: duplicate.principal },
    `public.api_reject_native_verification(${q(duplicateDelivery.runId)},${q(JSON.stringify(nativeFailure))})`, name, "engineering_native_verifier")
    .then(value => ({ value }), error => ({ error })));
  await waitFor(`select count(*)=5 from pg_stat_activity where application_name=any(array[${names.map(q).join(",")}]) and wait_event='advisory'`);
  release(); const results = await Promise.all(pending);
  assert.equal(results.filter(r => r.value?.outcome === "verification_failed").length, 5, "concurrent identical rejections must all replay");
  results.forEach(r => assert.deepEqual(r.value, results[0].value));
});
assert.equal(await count(duplicate), "1");
const verified = await verifyStoredNativeCandidate(rollback.prepared.admission, rollback.prepared.reader);
const outcomes = await Promise.allSettled([
  verifierCall(rollback, `public.api_complete_native_verification(${q(r.runId)},${q(JSON.stringify(verified.context))})`),
  fail(rollback, r.runId),
]);
assert.equal(outcomes.filter(o => o.status === "fulfilled").length, 1);
assert.equal(await sql(`select (select count(*) from engineering_private.native_result_finalizations where attempt_id=${q(rollback.attempt)})+
  (select count(*) from engineering_private.native_verification_failures where attempt_id=${q(rollback.attempt)})`), "1");
console.log(JSON.stringify({ outcome: "passed", actualStoredBytesChecked: true, actualPostgresTransactions: true,
  nativeJwtAndTransportSimulated: true, immutableRejections: true, noSnapshotOnFailure: true,
  ownerRetryPreservesFailure: true, automaticRetryDenied: true, cancellationAndHistory: true,
  successorBlocked: true, staleRejectionDenied: true, completionRejectionRace: true, productionChanged: false }, null, 2));
