import { beforeEach, describe, expect, it, vi } from "vitest";
import { prepareEngineeringMessage, submitEngineeringMessage } from "./engineering-inbox-client";

const { rpc, abortSignal } = vi.hoisted(() => ({ rpc: vi.fn(), abortSignal: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc } }));

const message = {
  organizationId: "10000000-0000-4000-8000-000000000001",
  projectId: "10000000-0000-4000-8000-000000000002",
  conversationId: "10000000-0000-4000-8000-000000000003",
  inputSnapshotId: "10000000-0000-4000-8000-000000000004",
  idempotencyKey: "10000000-0000-4000-8000-000000000005",
  expectedRevision: 4,
  body: "  Set depth to 8 mm.\n",
};
const receipt = {
  conversationId: message.conversationId,
  inputSnapshotId: message.inputSnapshotId,
  messageId: "10000000-0000-4000-8000-000000000006",
  requestId: "10000000-0000-4000-8000-000000000007",
  revision: 5,
};

beforeEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
  rpc.mockReturnValue({ abortSignal });
  abortSignal.mockResolvedValue({ data: receipt, error: null });
});

describe("durable engineering inbox client", () => {
  it("copies and freezes the exact Send identity without rewriting text", () => {
    const input = { ...message };
    const prepared = prepareEngineeringMessage(input);
    input.body = "changed";
    expect(prepared).toEqual(message);
    expect(Object.isFrozen(prepared)).toBe(true);
  });

  it("uses the existing session client and only the authenticated intake RPC", async () => {
    expect(await submitEngineeringMessage(message)).toEqual({ status: "recorded", receipt });
    expect(rpc).toHaveBeenCalledExactlyOnceWith("api_submit_engineering_message", {
      p_organization_id: message.organizationId,
      p_project_id: message.projectId,
      p_conversation_id: message.conversationId,
      p_input_snapshot_id: message.inputSnapshotId,
      p_expected_revision: message.expectedRevision,
      p_idempotency_key: message.idempotencyKey,
      p_body: message.body,
    });
    expect(abortSignal.mock.calls[0][0]).toBeInstanceOf(AbortSignal);
  });

  it("reuses every input after a lost response and accepts the original receipt", async () => {
    abortSignal.mockRejectedValueOnce(new Error("private transport detail"));
    const prepared = prepareEngineeringMessage(message);
    expect(await submitEngineeringMessage(prepared)).toEqual({ status: "delivery_unknown", submission: prepared });
    expect(await submitEngineeringMessage(prepared)).toEqual({ status: "recorded", receipt });
    expect(rpc.mock.calls[0]).toEqual(rpc.mock.calls[1]);
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["PT409", "conflict"],
    ["42501", "access_unavailable"],
    ["22023", "invalid_request"],
    ["40001", "delivery_unknown"],
    ["PGRST301", "delivery_unknown"],
    ["unexpected", "delivery_unknown"],
  ])("maps %s without leaking server details or claiming a prior write was undone", async (code, status) => {
    abortSignal.mockResolvedValue({ data: null, error: { code, message: "private details", hint: "secret" } });
    expect(await submitEngineeringMessage(message)).toEqual({ status, submission: message });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it.each([
    null,
    [],
    { ...receipt, conversationId: message.projectId },
    { ...receipt, inputSnapshotId: message.projectId },
    { ...receipt, revision: 6 },
    { ...receipt, revision: "5" },
    { ...receipt, messageId: "bad" },
    { ...receipt, requestId: null },
    { ...receipt, executed: true },
  ])("keeps malformed or mismatched receipts indeterminate: %j", async (data) => {
    abortSignal.mockResolvedValue({ data, error: null });
    expect(await submitEngineeringMessage(message)).toEqual({ status: "delivery_unknown", submission: message });
  });

  it.each([
    { body: " \n\t" },
    { body: "x".repeat(4001) },
    { body: "界".repeat(2667) },
    { body: "\u0000" },
    { body: "\ud800" },
    { expectedRevision: -1 },
    { expectedRevision: 1.5 },
    { expectedRevision: Number.MAX_SAFE_INTEGER },
    { idempotencyKey: "00000000-0000-0000-0000-000000000000" },
    { conversationId: "bad" },
  ])("rejects invalid input before sending: %j", async (change) => {
    expect(await submitEngineeringMessage({ ...message, ...change })).toEqual({ status: "invalid_request" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("counts Unicode code points and UTF-8 bytes without truncating the message", async () => {
    const body = "😀".repeat(2000);
    await submitEngineeringMessage({ ...message, body });
    expect(rpc.mock.calls[0][1].p_body).toBe(body);
  });

  it("does not expose an earlier receipt as the latest conversation state", async () => {
    // Replay returns its original revision even if the conversation later advanced.
    const result = await submitEngineeringMessage(message);
    expect(result).toEqual({ status: "recorded", receipt });
    expect(result).not.toHaveProperty("headSnapshotId");
    expect(result).not.toHaveProperty("executionState");
  });

  it("retains the submitted text when the caller edits its draft during delivery", async () => {
    const input = { ...message };
    let reject: (reason: Error) => void;
    abortSignal.mockReturnValue(new Promise((_, rejectPromise) => { reject = rejectPromise; }));
    const pending = submitEngineeringMessage(input);
    input.body = "Change the next draft";
    input.idempotencyKey = message.projectId;
    reject(new Error("lost response"));
    const result = await pending;
    expect(result).toEqual({ status: "delivery_unknown", submission: message });
    if (result.status === "delivery_unknown") expect(Object.isFrozen(result.submission)).toBe(true);
  });

  it("cleans up the deadline when the transport throws before returning a request", async () => {
    vi.useFakeTimers();
    rpc.mockImplementationOnce(() => { throw new Error("transport unavailable"); });
    expect(await submitEngineeringMessage(message)).toEqual({ status: "delivery_unknown", submission: message });
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("bounds a hung transport, aborts it, and retains the original request for explicit retry", async () => {
    vi.useFakeTimers();
    let complete: (value: unknown) => void;
    abortSignal.mockReturnValue(new Promise((resolve) => { complete = resolve; }));
    const pending = submitEngineeringMessage(message);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toEqual({ status: "delivery_unknown", submission: message });
    expect(abortSignal.mock.calls[0][0].aborted).toBe(true);
    complete({ data: receipt, error: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(rpc).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
