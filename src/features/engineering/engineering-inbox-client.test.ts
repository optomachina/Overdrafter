import { describe, expect, it, vi } from "vitest";
import { createEngineeringInboxSubmission } from "./engineering-inbox-client";

const { callRpcMock } = vi.hoisted(() => ({ callRpcMock: vi.fn() }));

vi.mock("@/features/quotes/api/shared/rpc", () => ({ callRpc: callRpcMock }));

const input = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  conversationId: "33333333-3333-4333-8333-333333333333",
  inputSnapshotId: "44444444-4444-4444-8444-444444444444",
  expectedRevision: 4,
  idempotencyKey: "55555555-5555-4555-8555-555555555555",
  body: "Make the cylinder depth 9 mm.",
} as const;

const receipt = {
  conversationId: input.conversationId,
  messageId: "66666666-6666-4666-8666-666666666666",
  requestId: "77777777-7777-4777-8777-777777777777",
  revision: 5,
  inputSnapshotId: input.inputSnapshotId,
};

describe("engineering inbox client", () => {
  it("submits the exact authenticated RPC request and validates its receipt", async () => {
    callRpcMock.mockResolvedValue({ data: receipt, error: null, status: 200 });
    const submission = createEngineeringInboxSubmission(input);

    await expect(submission.submit()).resolves.toEqual({ status: "submitted", receipt });
    expect(callRpcMock).toHaveBeenCalledWith(
      "api_submit_engineering_message",
      {
        p_organization_id: input.organizationId,
        p_project_id: input.projectId,
        p_conversation_id: input.conversationId,
        p_input_snapshot_id: input.inputSnapshotId,
        p_expected_revision: input.expectedRevision,
        p_idempotency_key: input.idempotencyKey,
        p_body: input.body,
      },
    );

    await submission.submit();
    expect(callRpcMock).toHaveBeenCalledTimes(1);
  });

  it("reuses the same frozen request identity for an explicit serialization retry", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: null, error: { code: "40001", message: "serialization failure" }, status: 500 })
      .mockResolvedValueOnce({ data: receipt, error: null, status: 200 });
    const submission = createEngineeringInboxSubmission(input, rpc);

    await expect(submission.submit()).resolves.toEqual({
      status: "retryable",
      code: "40001",
      message: "serialization failure",
    });
    expect(rpc).toHaveBeenCalledTimes(1);

    await expect(submission.submit()).resolves.toEqual({ status: "submitted", receipt });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[1][0]).toBe(rpc.mock.calls[0][0]);
    expect(Object.isFrozen(rpc.mock.calls[0][0])).toBe(true);
  });

  it("distinguishes revision or idempotency conflicts and makes them terminal", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: { code: "PT409", message: "Engineering context changed; refresh before sending." },
      status: 409,
    });
    const submission = createEngineeringInboxSubmission(input, rpc);

    await expect(submission.submit()).resolves.toEqual({
      status: "conflict",
      code: "PT409",
      message: "Engineering context changed; refresh before sending.",
    });
    await submission.submit();
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("fails closed on uncertain transport without automatically retrying or changing identity", async () => {
    const rpc = vi.fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce({ data: receipt, error: null, status: 200 });
    const submission = createEngineeringInboxSubmission(input, rpc);

    await expect(submission.submit()).resolves.toEqual({
      status: "uncertain_delivery",
      reason: "transport",
      message: "Engineering intake delivery is uncertain; retry only with this same request identity.",
    });
    expect(rpc).toHaveBeenCalledTimes(1);

    await expect(submission.submit()).resolves.toEqual({ status: "submitted", receipt });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[1][0]).toBe(rpc.mock.calls[0][0]);
  });

  it("fails closed when a success receipt does not match the submitted identity", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { ...receipt, revision: receipt.revision + 1 },
      error: null,
      status: 200,
    });

    await expect(createEngineeringInboxSubmission(input, rpc).submit()).resolves.toEqual({
      status: "uncertain_delivery",
      reason: "unrecognized_response",
      message: "Engineering intake returned an invalid receipt; reconcile before changing the request.",
    });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("shares one in-flight attempt across duplicate submit calls", async () => {
    let resolveRpc: ((value: { data: typeof receipt; error: null; status: number }) => void) | undefined;
    const rpc = vi.fn(() => new Promise<{ data: typeof receipt; error: null; status: number }>((resolve) => {
      resolveRpc = resolve;
    }));
    const submission = createEngineeringInboxSubmission(input, rpc);

    const first = submission.submit();
    const duplicate = submission.submit();
    expect(duplicate).toBe(first);
    expect(rpc).toHaveBeenCalledTimes(1);

    resolveRpc?.({ data: receipt, error: null, status: 200 });
    await expect(first).resolves.toEqual({ status: "submitted", receipt });
    await expect(duplicate).resolves.toEqual({ status: "submitted", receipt });
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
