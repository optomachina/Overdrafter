// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEngineeringInterpretationHandler } from "../supabase/functions/engineering-interpretation/index.ts";
import { NATIVE_SEED_FILES, nativeDigest } from "../src/lib/engineering-cumulative.ts";

// Source acceptance only: real HTTP handler -> dispatcher -> v2 classifier.
// RPC persistence and model output are synthetic. There is no connected storage,
// Windows runner, native result, v1 workbench, or CAD qualification in this path.
const id = (n) => `70200000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const serviceKey = "synthetic-replay-service-key-not-a-real-credential";
const identity = { requestId: id(4), expectedQueueRevision: 0, idempotencyKey: id(5) };
const schema = "overdrafter.prepared-dispatch.v1";
const contextText = JSON.stringify({
  schema: "overdrafter.prepared-assembly.v2", packageId: "ovd-native04-assembly",
  scope: { organizationId: id(1), projectId: id(2) }, snapshotId: id(3), seedSnapshotId: id(3),
  sequence: 0, producer: null, createdAt: "2026-10-02T00:00:00.000Z", configuration: "Default",
  assemblyPath: "synthetic-assembly.SLDASM", files: NATIVE_SEED_FILES, depthMm: 5, checks: [],
});
const request = (body = identity, bearer = serviceKey) => new Request(
  "https://synthetic.invalid/functions/v1/engineering-interpretation", {
    method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify({ schema, ...body }),
  },
);
let network;
beforeEach(() => {
  network = vi.fn(() => { throw new Error("This replay forbids outbound network requests."); });
  vi.stubGlobal("fetch", network);
});
afterEach(() => {
  expect(network).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function fixture({ text = "Set the depth to 7 mm", outcome = "prepared_change", depthMm = 7,
  priorClarification = null, corruptReservation = {}, loseFinishReply = false } = {}) {
  const reserved = {
    state: "reserved", invoke: true, text, contextText, inputSnapshotId: id(3),
    organizationId: id(1), projectId: id(2), contextSha256: await nativeDigest(contextText),
    inputSha256: await nativeDigest(text), priorClarification, ...corruptReservation,
  };
  let state = "new", receipt = null, failureCode = null;
  const committed = [];
  const adapter = vi.fn(async () => ({ schema: "overdrafter.prepared-interpretation.v1", outcome, depthMm }));
  // Deliberately narrow DB double: it models reservation/receipt replay only,
  // not SQL locks, permissions, atomicity, budgets, or actual task execution.
  const rpc = vi.fn(async (name, args, signal) => {
    expect(signal.aborted).toBe(false);
    if (args.p_request_id !== identity.requestId || args.p_expected_queue_revision !== identity.expectedQueueRevision
      || args.p_idempotency_key !== identity.idempotencyKey) return { data: null, error: { code: "PT409" } };
    if (name === "api_reserve_prepared_interpretation") {
      if (state !== "new") return { data: { state, invoke: false, receipt, failureCode }, error: null };
      state = "reserved";
      return { data: structuredClone(reserved), error: null };
    }
    if (name === "api_fail_prepared_interpretation") {
      state = "failed"; failureCode = args.p_failure_code;
      return { data: { requestId: identity.requestId, state, failureCode }, error: null };
    }
    expect(name).toBe("api_finish_prepared_interpretation");
    expect(state).toBe("reserved");
    committed.push(structuredClone(args));
    state = "completed";
    // Same receipt fields as resolve_engineering_request; IDs are all fixtures.
    receipt = { conversationId: id(6), requestId: identity.requestId, interpretationId: id(7),
      outcome: args.p_outcome, decisionId: args.p_outcome === "prepared_change" ? id(8) : null,
      taskId: args.p_outcome === "prepared_change" ? id(9) : null, predecessorDecisionId: null,
      revision: identity.expectedQueueRevision + 1 };
    if (loseFinishReply) throw new Error("synthetic reply loss after the in-memory commit");
    return { data: structuredClone(receipt), error: null };
  });
  const handler = createEngineeringInterpretationHandler({ enabled: () => true, serviceKey: () => serviceKey, rpc, adapter });
  return { handler, rpc, adapter, committed, reserved, persistedReceipt: () => structuredClone(receipt) };
}

describe("synthetic Jarvis HTTP interpretation acceptance replay", () => {
  it("recovers one committed intent after a lost reply using the exact request identity", async () => {
    const f = await fixture({ loseFinishReply: true });
    const first = await f.handler(request());
    expect(first.status).toBe(503);
    expect(await first.json()).toEqual({ schema, state: "unknown" });
    expect(f.committed).toHaveLength(1);
    const replay = await f.handler(request());
    expect(replay.status).toBe(200);
    expect(replay.headers.get("cache-control")).toBe("no-store");
    const body = await replay.text();
    expect(JSON.parse(body)).toEqual({ schema, state: "completed", receipt: f.persistedReceipt() });
    expect(f.persistedReceipt()).toMatchObject({ requestId: identity.requestId, revision: 1, outcome: "prepared_change" });
    expect(body).not.toContain(contextText);
    expect(body).not.toContain(f.reserved.text);
    expect(body).not.toContain(serviceKey);
    expect(f.adapter).toHaveBeenCalledTimes(1);
    expect(f.adapter).toHaveBeenCalledWith({ text: f.reserved.text, contextText,
      contextSha256: f.reserved.contextSha256, priorClarification: null, signal: expect.any(AbortSignal) });
    expect(f.committed).toEqual([{ p_request_id: identity.requestId, p_expected_queue_revision: 0,
      p_idempotency_key: identity.idempotencyKey, p_outcome: "prepared_change", p_depth_mm: 7,
      p_response: "I recorded the request to set the prepared part depth to 7 mm. Native work has not started.", p_clarification: null }]);
    expect(f.rpc.mock.calls.map(([name]) => name)).toEqual([
      "api_reserve_prepared_interpretation", "api_finish_prepared_interpretation", "api_reserve_prepared_interpretation",
    ]);
    expect(f.rpc.mock.calls[0][1]).toEqual(f.rpc.mock.calls[2][1]);
    const changedKey = await f.handler(request({ ...identity, idempotencyKey: id(99) }));
    expect(changedKey.status).toBe(409);
    expect(f.adapter).toHaveBeenCalledTimes(1);
    expect(f.committed).toHaveLength(1);
  });

  it("carries a snapshot-bound units clarification through the actual classifier", async () => {
    const question = await fixture({ text: "Set the depth to 7", outcome: "needs_context", depthMm: null });
    expect((await question.handler(request())).status).toBe(200);
    const prior = question.committed[0].p_clarification;
    expect(prior).toEqual({ reason: "unit", contextSha256: await nativeDigest(contextText), depthMm: 7 });
    expect(question.persistedReceipt()).toMatchObject({ outcome: "needs_context", taskId: null, decisionId: null });
    // A separate fixture injects the next reservation's DB-provided prior; this
    // is not a claim that a real conversation queue was advanced in PostgreSQL.
    const answer = await fixture({ text: "mm", priorClarification: prior });
    expect((await answer.handler(request())).status).toBe(200);
    expect(answer.committed[0]).toMatchObject({ p_outcome: "prepared_change", p_depth_mm: 7, p_clarification: null });
    expect(answer.adapter).toHaveBeenCalledWith(expect.objectContaining({ priorClarification: prior }));
  });

  it.each([
    { inputSha256: "0".repeat(64) }, { contextSha256: "0".repeat(64) },
    { inputSnapshotId: id(90) }, { organizationId: id(91) },
  ])("rejects corrupt stored identity before any model or completion effect: %j", async (corruptReservation) => {
    const f = await fixture({ corruptReservation });
    const response = await f.handler(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ schema, state: "failed", failureCode: "invalid_output" });
    expect(f.adapter).not.toHaveBeenCalled();
    expect(f.committed).toEqual([]);
    expect(f.rpc.mock.calls.map(([name]) => name)).toEqual(["api_reserve_prepared_interpretation", "api_fail_prepared_interpretation"]);
  });

  it("records and replays rejected executable model output without creating intent", async () => {
    const f = await fixture();
    f.adapter.mockResolvedValue({ schema: "overdrafter.prepared-interpretation.v1", outcome: "prepared_change",
      depthMm: 7, code: "forbidden native invocation" });
    for (let delivery = 0; delivery < 2; delivery++) {
      const response = await f.handler(request());
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ schema, state: "failed", failureCode: "invalid_output" });
    }
    expect(f.adapter).toHaveBeenCalledTimes(1);
    expect(f.committed).toEqual([]);
    expect(f.rpc.mock.calls.filter(([name]) => name === "api_fail_prepared_interpretation")).toHaveLength(1);
  });

  it("preserves elapsed deadline rejection through HTTP and subsequent exact replay", async () => {
    const f = await fixture(); let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    f.adapter.mockImplementation(async () => {
      now = 15_000;
      return { schema: "overdrafter.prepared-interpretation.v1", outcome: "prepared_change", depthMm: 7 };
    });
    for (let delivery = 0; delivery < 2; delivery++) {
      const response = await f.handler(request());
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ schema, state: "failed", failureCode: "timed_out" });
    }
    expect(f.adapter).toHaveBeenCalledTimes(1);
    expect(f.committed).toEqual([]);
    expect(f.rpc.mock.calls.filter(([name]) => name === "api_fail_prepared_interpretation")).toHaveLength(1);
  });

  it.each(["bearer", "extra command", "unsafe revision", "browser origin"])("denies %s before any RPC/model effect", async (invalid) => {
    const f = await fixture();
    const req = invalid === "bearer" ? request(identity, "incorrect-synthetic-bearer")
      : invalid === "extra command" ? request({ ...identity, command: "run CAD" })
      : invalid === "unsafe revision" ? request({ ...identity, expectedQueueRevision: Number.MAX_SAFE_INTEGER }) : request();
    if (invalid === "browser origin") req.headers.set("origin", "https://synthetic-browser.invalid");
    const response = await f.handler(req);
    expect(response.status).toBe({ bearer: 401, "extra command": 400, "unsafe revision": 409, "browser origin": 403 }[invalid]);
    expect(f.rpc).not.toHaveBeenCalled();
    expect(f.adapter).not.toHaveBeenCalled();
    expect(f.committed).toEqual([]);
  });
});
