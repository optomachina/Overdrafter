import { assertEquals } from "@std/assert";
import { NATIVE_SEED_FILES, nativeDigest } from "../../../src/lib/engineering-cumulative.ts";
import { createEngineeringInterpretationHandler } from "./index.ts";

const key = "synthetic-service-role-key-with-at-least-32-characters";
const requestId = "44444444-4444-4444-8444-444444444444";
const idempotencyKey = "55555555-5555-4555-8555-555555555555";
const organizationId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const snapshotId = "33333333-3333-4333-8333-333333333333";
const text = "Set the depth to 8 mm";
const contextText = JSON.stringify({
  schema: "overdrafter.prepared-assembly.v2", packageId: "ovd-native04-assembly",
  scope: { organizationId, projectId }, snapshotId, seedSnapshotId: snapshotId,
  sequence: 0, producer: null, createdAt: "2026-09-10T00:00:00.000Z",
  configuration: "Default", assemblyPath: "synthetic-assembly.SLDASM",
  files: NATIVE_SEED_FILES, depthMm: 5, checks: [],
});
const payload = {
  schema: "overdrafter.prepared-dispatch.v1", requestId, idempotencyKey, expectedQueueRevision: 0,
};
function request(body: unknown = payload, bearer = key) {
  return new Request("https://example.test/functions/v1/engineering-interpretation", {
    method: "POST", headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
function runtime(enabled = true) {
  const calls: string[] = [];
  const handler = createEngineeringInterpretationHandler({
    enabled: () => enabled, serviceKey: () => key,
    adapter: async () => ({
      schema: "overdrafter.prepared-interpretation.v1", outcome: "prepared_change", depthMm: 8,
    }),
    rpc: async (name) => {
      calls.push(name);
      if (name === "api_reserve_prepared_interpretation") {
        return { data: {
          state: "reserved", invoke: true, text, contextText, inputSnapshotId: snapshotId,
          contextSha256: await nativeDigest(contextText), inputSha256: await nativeDigest(text),
          organizationId, projectId, priorClarification: null,
        }, error: null };
      }
      return { data: { requestId, outcome: "prepared_change" }, error: null };
    },
  });
  return { handler, calls };
}
Deno.test("default-off handler touches neither body nor database", async () => {
  const { handler, calls } = runtime(false);
  const response = await handler(request());
  assertEquals(response.status, 503);
  assertEquals(calls, []);
});
Deno.test("service identity is required before a reservation", async () => {
  const { handler, calls } = runtime();
  assertEquals((await handler(request(payload, "incorrect-service-key-with-at-least-32-characters"))).status, 401);
  assertEquals(calls, []);
});
Deno.test("accepted request reserves, validates and finishes without exposing input", async () => {
  const { handler, calls } = runtime();
  const response = await handler(request());
  assertEquals(response.status, 200);
  const body = await response.text();
  assertEquals(body.includes(text), false);
  assertEquals(body.includes(contextText), false);
  assertEquals(calls, ["api_reserve_prepared_interpretation", "api_finish_prepared_interpretation"]);
});
Deno.test("extra client fields never reach a database call", async () => {
  const { handler, calls } = runtime();
  assertEquals((await handler(request({ ...payload, command: "run code" }))).status, 400);
  assertEquals(calls, []);
});
Deno.test("stalled authenticated body ends before any reservation", async () => {
  const { handler, calls } = runtime();
  const body = new ReadableStream<Uint8Array>({ start() {} });
  const stalled = new Request("https://example.test/functions/v1/engineering-interpretation", {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body,
  });
  const response = await handler(stalled);
  assertEquals(response.status, 504);
  assertEquals((await response.json()).state, "timed_out");
  assertEquals(calls, []);
});
