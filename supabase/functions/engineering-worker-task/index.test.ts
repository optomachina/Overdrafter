import { assertEquals, assertNotEquals } from "@std/assert";
import { createWorkerTaskHandler, TASK_SCHEMA, type TaskRuntime } from "./index.ts";

const u = (n: number) => `56200000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const token = `odw_${"a".repeat(64)}`;
const task = u(1), worker = u(2), boot = u(3), runtimeId = u(4), inputId = u(5), attempt = u(6), key = u(7);
const base = { schema: TASK_SCHEMA, workerId: worker, bootId: boot, taskId: task };
const claim = { ...base, action: "claim", runtimeAdmissionId: runtimeId, inputAdmissionId: inputId, revision: 0, idempotencyKey: key };
const eligibility = { ...base, action: "eligibility", attemptId: attempt, fence: 1 };
const heartbeat = { ...base, action: "heartbeat", attemptId: attempt, fence: 1, revision: 0, idempotencyKey: key };
function request(value: unknown): Request {
  return new Request("https://example.invalid/functions/v1/engineering-worker-task", { method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(value) });
}
function setup(data: unknown, error: { code?: string } | null = null) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const rpc: TaskRuntime["rpc"] = (name, args) => { calls.push({ name, args }); return Promise.resolve({ data, error }); };
  return { handler: createWorkerTaskHandler({ enabled: () => true, rpc }), calls };
}
const at = "2026-09-27T09:00:00.000+00:00";
const lease = "2026-09-27T09:01:00.000+00:00";
const deadline = "2026-09-27T09:10:00.000+00:00";
async function digest(text: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))),
    (byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function claimed() {
  const contextText = JSON.stringify({ snapshotId: u(8) });
  const contextSha256 = await digest(contextText);
  const jobText = JSON.stringify({ schema: "overdrafter.prepared-dimension-job.v2", attemptId: attempt,
    fence: 1, contextSha256, inputSnapshotId: u(8), outputSnapshotId: u(9) });
  return { outcome: "claimed", taskId: task, taskRevision: 1, attemptId: attempt, attemptRevision: 0,
    workerId: worker, installationId: u(10), bootId: boot, sessionId: u(11), runtimeAdmissionId: runtimeId,
    inputAdmissionId: inputId, fence: 1, jobText, jobSha256: await digest(jobText), contextText,
    contextSha256, claimedAt: at, deadlineAt: deadline, leaseExpiresAt: lease };
}
Deno.test("disabled task route does not inspect credentials or call SQL", async () => {
  let called = false;
  const handler = createWorkerTaskHandler({ enabled: () => false, rpc: () => { called = true; throw Error("unexpected"); } });
  assertEquals((await handler(request(claim))).status, 503); assertEquals(called, false);
});
Deno.test("exact claim uses hashed worker token and validates immutable job", async () => {
  const receipt = await claimed(); const { handler, calls } = setup(receipt);
  const response = await handler(request(claim));
  assertEquals(response.status, 200);
  assertEquals((await response.json()).receipt, receipt);
  assertEquals(calls[0].name, "api_claim_native_task");
  assertEquals(calls[0].args.p_task, task); assertEquals(calls[0].args.p_key, key);
  assertNotEquals(calls[0].args.p_credential, token);
});
Deno.test("SQL ineligible occupancy is finite and does not expose a job", async () => {
  const { handler } = setup({ outcome: "ineligible", reason: "native_slot_occupied" });
  const response = await handler(request(claim));
  assertEquals(response.status, 200);
  assertEquals((await response.json()).receipt, { outcome: "ineligible", reason: "native_slot_occupied" });
});
Deno.test("fresh eligibility and bounded heartbeat keep exact attempt and fence", async () => {
  const current = setup({ attemptId: attempt, fence: 1, eligible: true, reason: "eligible", revision: 0,
    leaseExpiresAt: lease, deadlineAt: deadline });
  assertEquals((await current.handler(request(eligibility))).status, 200);
  assertEquals(current.calls[0].name, "api_native_attempt_eligibility");
  const renew = setup({ outcome: "renewed", attemptId: attempt, fence: 1, revision: 1, leaseExpiresAt: lease,
    deadlineAt: deadline });
  assertEquals((await renew.handler(request(heartbeat))).status, 200);
  assertEquals(renew.calls[0].name, "api_heartbeat_native_attempt");
  assertEquals(renew.calls[0].args.p_fence, 1);
  const stale = setup(null, { code: "PT409" });
  assertEquals((await stale.handler(request(heartbeat))).status, 409);
});
Deno.test("recovery outcome is visible and cannot grant another launch", async () => {
  const { handler } = setup({ outcome: "recovery_required", reason: "lease_expired", attemptId: attempt, fence: 1,
    revision: 1 });
  assertEquals((await handler(request(heartbeat))).status, 200);
});
Deno.test("forged identity, extra fields, bad bytes and malformed receipts fail closed", async () => {
  const receipt = await claimed();
  for (const invalid of [{ ...claim, rpc: "api_register_worker_boot" }, { ...claim, workerId: u(99) + "x" },
    { ...claim, fence: 99 }, { ...heartbeat, fence: 0 }]) {
    const { handler, calls } = setup(receipt);
    assertEquals((await handler(request(invalid))).status, 400); assertEquals(calls.length, 0);
  }
  for (const invalid of [{ ...receipt, attemptId: u(99) }, { ...receipt, jobSha256: "0".repeat(64) },
    { ...receipt, fence: 2 }, { ...receipt, secret: token }]) {
    const { handler } = setup(invalid);
    assertEquals((await handler(request(claim))).status, 502);
  }
});
Deno.test("a lost response is unknown with identical-request replay only", async () => {
  const handler = createWorkerTaskHandler({ enabled: () => true, rpc: () => Promise.reject(Error("lost")) });
  const response = await handler(request(claim));
  assertEquals(response.status, 503);
  assertEquals(await response.json(), { schema: TASK_SCHEMA, error: "upstream_unavailable", outcome: "unknown",
    retrySameRequest: true });
});
