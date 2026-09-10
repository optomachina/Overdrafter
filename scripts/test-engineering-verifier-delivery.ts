/** Local connected verifier test. Native admissions and JWT verification are
 * simulated; PostgreSQL authorization/finalization and streamed file bytes are real. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { once } from "node:events";
import path from "node:path";
import { createNativeVerifier } from "../server/engineering/native-verifier-client";
import { storedNativeFixture } from "../server/engineering/native-result-fixture";
import { verifyStoredNativeCandidate } from "../server/engineering/native-result-bytes";
import { q, sql, call, stoppedFixture, rejected } from "./lib/native-result-db-fixtures.mjs";

const source = "a".repeat(64);
type Prepared = ReturnType<typeof storedNativeFixture>;
/** A fresh private principal exists only in this explicit local fixture DB. */
async function prepared(expired = false) {
  const f = await stoppedFixture(false, storedNativeFixture);
  f.principal = randomUUID();
  await sql(`insert into engineering_private.native_verifier_principals(id,organization_id,project_id,source_sha256,policy_version,validator_version,admitted_by,admitted_at,expires_at)
    values(${q(f.principal)},${q(f.org)},${q(f.project)},${q(source)},'prepared-native-reports-v1','local-fixture',${q(f.actor)},
      clock_timestamp()-interval '2 minutes',clock_timestamp()+interval '${expired ? "-1 minute" : "10 minutes"}');
    insert into storage.buckets(id,name,public) values('engineering-native-results','engineering-native-results',false) on conflict do nothing;`);
  f.storage = new Map<string, string>();
  const root = path.resolve("output/validation/verifier-files", f.attempt);
  await mkdir(root, { recursive: true });
  for (const object of (f.prepared as Prepared).objects) {
    const name = `${f.org}/${f.project}/${f.attempt}/${object.id}`, destination = path.join(root, object.id);
    await writeFile(destination, (f.prepared as Prepared).bytes[object.role]);
    f.storage.set(name, destination);
    await sql(`insert into storage.objects(bucket_id,name) values('engineering-native-results',${q(name)})`);
  }
  return f;
}
function asVerifier(f, expression: string) { return call({ ...f, actor: f.principal }, expression, undefined, "engineering_native_verifier"); }

const f = await prepared(), key = randomUUID();
const load = () => asVerifier(f, `public.api_load_native_verification(${q(f.manifest)},${q(key)})`);
for (const role of ["anon", "authenticated", "service_role"]) {
  await rejected(call({ ...f, actor: f.principal }, `public.api_load_native_verification(${q(f.manifest)},${q(key)})`, undefined, role), "42501");
  await rejected(call({ ...f, actor: f.principal }, `public.api_complete_native_verification(${q(randomUUID())},'{}')`, undefined, role), "42501");
}
await rejected(asVerifier({ ...f, principal: randomUUID() }, `public.api_load_native_verification(${q(f.manifest)},${q(key)})`), "42501");
const delivery = await load(); assert.equal(delivery.status, "ready"); assert.deepEqual(await load(), delivery);
assert.equal(delivery.admission.process.nativePid, 42);
assert.equal(delivery.admission.jobText, f.claim.jobText);

// Even a broad PUBLIC policy cannot expand the verifier's restrictive policy.
await sql(`create policy ovd505_fixture_public_${randomUUID().replaceAll("-", "")} on storage.objects for select to public using(true)`);
const extra = `${f.org}/${f.project}/${f.attempt}/${randomUUID()}`;
await sql(`insert into storage.objects(bucket_id,name) values('engineering-native-results',${q(extra)})`);
const visible = await asVerifier(f, `jsonb_build_object('count',(select count(*) from storage.objects))`);
assert.equal(visible.count, 7);
await rejected(sql(`begin;set local role engineering_native_verifier;set local request.jwt.claim.sub=${q(f.principal)};
  insert into engineering_private.native_verification_receipts default values;rollback;`), "42501");
await rejected(sql(`begin;set local role engineering_native_verifier;set local request.jwt.claim.sub=${q(f.principal)};
  update storage.objects set name='replaced';rollback;`), "42501");

const token = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ role: "engineering_native_verifier", sub: f.principal })).toString("base64url")}.fixture-signature`;
const requests: string[] = [];
const server = createServer((request, response) => {
  void (async () => {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    const prefix = "/storage/v1/object/engineering-native-results/";
    assert.ok(request.url?.startsWith(prefix));
    const name = request.url!.slice(prefix.length);
    const allowed = await asVerifier(f, `jsonb_build_object('allowed',exists(select 1 from storage.objects where bucket_id='engineering-native-results' and name=${q(name)}))`);
    if (!allowed.allowed) { response.writeHead(403); response.end(); return; }
    const file = f.storage.get(name); assert.ok(file);
    const bytes = await readFile(file); requests.push(name);
    response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": bytes.length });
    for (let offset = 0; offset < bytes.length; offset += 8192) response.write(bytes.subarray(offset, offset + 8192));
    response.end();
  })().catch(() => { response.writeHead(500); response.end(); });
});
server.listen(0, "127.0.0.1"); await once(server, "listening");
const address = server.address(); assert.ok(address && typeof address === "object");
let completions = 0;
/** Real database calls plus local HTTP file delivery; no external requests. */
const transport: typeof fetch = async (url, init) => {
  assert.ok(typeof url === "string");
    const requested = new URL(url); assert.equal(requested.origin, "https://verifier.example.test");
  assert.equal(init?.redirect, "error");
  if (requested.pathname.startsWith("/storage/v1/")) {
    return fetch(`http://127.0.0.1:${address.port}${requested.pathname}`, init);
  }
  assert.ok(typeof init?.body === "string");
    const body = JSON.parse(init.body);
  if (requested.pathname.endsWith("api_load_native_verification")) {
    return Response.json(await asVerifier(f, `public.api_load_native_verification(${q(body.p_manifest)},${q(body.p_key)})`));
  }
  assert.ok(requested.pathname.endsWith("api_complete_native_verification")); completions++;
  return Response.json(await asVerifier(f, `public.api_complete_native_verification(${q(body.p_run)},${q(body.p_context_text)})`));
};
try {
  const client = createNativeVerifier({ enabled: true, projectUrl: "https://verifier.example.test", apiKey: "fixture", verifierToken: token, sourceSha256: source }, transport);
  const result = await client.verify(f.manifest, key);
  assert.equal(result.outcome, "finalized"); assert.equal(requests.length, 7); assert.equal(completions, 1);
  assert.equal(await sql(`select count(*) from engineering_private.native_verification_receipts where verification_run_id=${q(delivery.runId)}`), "1");
  assert.equal(await sql(`select head_snapshot_id from public.engineering_conversations where id=${q(f.conversation)}`), result.snapshotId);
  assert.deepEqual(await client.verify(f.manifest, key), result);
  assert.equal(requests.length, 7); assert.equal(completions, 1);
  await rejected(asVerifier(f, `public.api_complete_native_verification(${q(delivery.runId)},'{}')`), "PT409");
  assert.equal((await asVerifier(f, `jsonb_build_object('count',(select count(*) from storage.objects))`)).count, 0);
  await call(f, `public.api_control_worker_session(${q(f.worker)},2,${q(randomUUID())},'revoked',null)`, undefined, "authenticated");
  assert.deepEqual(await client.verify(f.manifest, key), result, "worker revocation must not hide committed history");
  assert.equal(requests.length, 7); assert.equal(completions, 1);
} finally { server.close(); server.closeAllConnections(); await once(server, "close"); }

for (const kind of ["revoked", "expired", "foreign", "missing_binding"]) {
  let denied = await prepared(kind === "expired");
  if (kind === "revoked") await sql(`update engineering_private.native_verifier_principals set revoked_at=clock_timestamp() where id=${q(denied.principal)}`);
  else if (kind === "foreign") denied = { ...denied, principal: f.principal };
  else if (kind === "missing_binding") {
    const missing = await stoppedFixture();
    denied.principal = randomUUID();
    await sql(`insert into engineering_private.native_verifier_principals(id,organization_id,project_id,source_sha256,policy_version,validator_version,admitted_by,expires_at)
      values(${q(denied.principal)},${q(missing.org)},${q(missing.project)},${q(source)},'prepared-native-reports-v1','local-fixture',${q(missing.actor)},clock_timestamp()+interval '10 minutes')`);
    denied = { ...missing, principal: denied.principal };
  }
  await rejected(asVerifier(denied, `public.api_load_native_verification(${q(denied.manifest)},${q(randomUUID())})`), kind === "missing_binding" ? "PT409" : "42501");
}

// Authority must still hold after the bytes were checked. None of these
// failures may leave a trusted receipt behind or advance the conversation.
for (const kind of ["revoked", "runtime", "canceled", "expired_run", "changed_revision"]) {
  const denied = await prepared(), retryKey = randomUUID();
  let runId: string;
  if (kind === "expired_run") {
    runId = randomUUID();
    // Backdate only a newly inserted immutable fixture, never alter a real run.
    await sql(`insert into engineering_private.native_verification_runs(id,principal_id,idempotency_key,manifest_id,attempt_id,organization_id,project_id,attempt_revision,created_at,expires_at)
      select ${q(runId)},${q(denied.principal)},${q(retryKey)},${q(denied.manifest)},${q(denied.attempt)},${q(denied.org)},${q(denied.project)},1,t,t+interval '60 seconds'
      from (select clock_timestamp()-interval '2 minutes' as t) timing`);
    await rejected(asVerifier(denied, `public.api_load_native_verification(${q(denied.manifest)},${q(retryKey)})`), "PT409");
  } else {
    runId = (await asVerifier(denied, `public.api_load_native_verification(${q(denied.manifest)},${q(retryKey)})`)).runId;
  }
  const bytes = denied.prepared as Prepared;
  const verified = await verifyStoredNativeCandidate(bytes.admission, bytes.reader);
  if (kind === "revoked") await sql(`update engineering_private.native_verifier_principals set revoked_at=clock_timestamp() where id=${q(denied.principal)}`);
  else if (kind === "runtime") await sql(`insert into engineering_private.native_admission_revocations(runtime_admission_id,revoked_by,reason)
    values(${q(denied.runtime)},${q(denied.actor)},'verification delivery fixture revocation')`);
  else if (kind === "canceled") await sql(`update public.engineering_tasks set execution_state='canceled' where id=${q(denied.task)}`);
  else if (kind === "changed_revision") await sql(`update public.engineering_execution_attempts set revision=revision+1 where id=${q(denied.attempt)}`);
  await rejected(asVerifier(denied, `public.api_complete_native_verification(${q(runId)},${q(JSON.stringify(verified.context))})`), kind === "revoked" ? "42501" : "PT409");
  assert.equal(await sql(`select count(*) from engineering_private.native_verification_receipts where verification_run_id=${q(runId)}`), "0", kind);
  assert.equal(await sql(`select head_snapshot_id from public.engineering_conversations where id=${q(denied.conversation)}`), denied.snapshot, kind);
  if (["revoked", "runtime", "expired_run"].includes(kind)) {
    assert.equal((await asVerifier(denied, `jsonb_build_object('count',(select count(*) from storage.objects))`)).count, 0, kind);
  }
}
console.log(JSON.stringify({ outcome: "passed", simulatedNativeAdmission: true, simulatedJwtVerification: true,
  actualPostgresAuthorization: true, actualNativeFileBytesOverLocalHttp: true, restrictiveStoragePolicy: true,
  workersCannotVerify: true, checkedContextCommittedAtomically: true, completedDeliveryRecovered: true,
  expiredAndRevokedAuthorityDenied: true, staleCompletionLeavesNoReceipt: true, productionChanged: false }, null, 2));
