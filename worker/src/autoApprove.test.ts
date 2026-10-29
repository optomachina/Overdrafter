// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { autoApproveJobRequirements } from "./autoApprove.js";

type Client = Parameters<typeof autoApproveJobRequirements>[0];

function clientReturning(result: { data: unknown; error: unknown }) {
  const rpc = vi.fn().mockResolvedValue(result);
  return { rpc, client: { rpc } as unknown as Client };
}

describe("autoApproveJobRequirements", () => {
  it("calls the auto-approval RPC and returns the approved part count", async () => {
    const { rpc, client } = clientReturning({ data: 2, error: null });

    await expect(autoApproveJobRequirements(client, "job-123")).resolves.toEqual({
      approvedCount: 2,
      reviewHold: false,
    });

    expect(rpc).toHaveBeenCalledWith("api_auto_approve_job_requirements", {
      p_job_id: "job-123",
    });
  });

  // OVD-1067: 0 means the RPC approved nothing and left fields for review (for example
  // title-block fields while DRAWING_EXTRACTION_TITLE_BLOCK_APPROVAL is off).
  it("reports a review hold when the RPC approves no parts", async () => {
    const { client } = clientReturning({ data: 0, error: null });

    await expect(autoApproveJobRequirements(client, "job-123")).resolves.toEqual({
      approvedCount: 0,
      reviewHold: true,
    });
  });

  it("accepts a numeric string count from PostgREST", async () => {
    const { client } = clientReturning({ data: "3", error: null });

    await expect(autoApproveJobRequirements(client, "job-123")).resolves.toEqual({
      approvedCount: 3,
      reviewHold: false,
    });
  });

  it("throws the RPC error", async () => {
    const rpcError = { message: "permission denied", code: "42501" };
    const { client } = clientReturning({ data: null, error: rpcError });

    await expect(autoApproveJobRequirements(client, "job-123")).rejects.toBe(rpcError);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["NaN", Number.NaN],
    ["a negative count", -1],
    ["a fractional count", 1.5],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a non-numeric string", "abc"],
    ["an empty string", ""],
    ["an object", { approved: 1 }],
    ["a boolean", true],
  ])("fails closed on %s instead of treating it as a review hold", async (_label, data) => {
    const { client } = clientReturning({ data, error: null });

    await expect(autoApproveJobRequirements(client, "job-123")).rejects.toThrow(
      "Auto-approval returned an invalid approved requirement count for job job-123.",
    );
  });
});
